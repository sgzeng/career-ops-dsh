// tests/providers/google-careers-parser.test.mjs
//
// Covers scripts/parsers/google-careers.mjs (Google Careers feed.xml parser
// wired into scan.mjs via providers/local-parser.mjs) and confirms
// local-parser.detect() accepts the portals.yml entry shape.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, run, lastRunFailure, rmSync, ROOT, NODE } from '../helpers.mjs';

console.log('\nParser — google-careers');

const mod = await import(pathToFileURL(join(ROOT, 'scripts/parsers/google-careers.mjs')).href);
const { parseFeed, filterJobs } = mod;
const FIXTURE = join(ROOT, 'tests/fixtures/google-careers-feed.xml');
const xml = readFileSync(FIXTURE, 'utf-8');
const SCRIPT = 'scripts/parsers/google-careers.mjs';
const TOPIC = 'fuzz|vulnerab|cyber|exploit|secure code';

// 1. parseFeed — pure parse of every <job>, no filtering
{
  const jobs = parseFeed(xml);
  if (jobs.length === 5) pass('parses all 5 fixture jobs');
  else fail(`expected 5 jobs, got ${jobs.length}`);

  const canonical = jobs.every((j) => /^https:\/\/www\.google\.com\/about\/careers\/applications\/jobs\/results\/\d+$/.test(j.url));
  if (canonical) pass('every url is the canonical id-only results/<jobid> form');
  else fail(`non-canonical url: ${JSON.stringify(jobs.map((j) => j.url))}`);

  const sc = jobs.find((j) => j.jobId === '74431926638650054');
  if (sc && sc.company === 'Google DeepMind') pass('employer DeepMind → company "Google DeepMind"');
  else fail(`company mapping: ${JSON.stringify(sc && sc.company)}`);
  if (sc && sc.location === 'Mountain View, CA, USA; San Francisco, CA, USA') pass('locations joined as "City, ST, Country; ..."');
  else fail(`location: ${JSON.stringify(sc && sc.location)}`);
  if (sc && sc.postedAt === '2026-09-23T06:38:32.724Z') pass('postedAt taken from <published>');
  else fail(`postedAt: ${JSON.stringify(sc && sc.postedAt)}`);
  if (sc && sc.description.includes('vulnerability research') && !/[<>]/.test(sc.description)) {
    pass('escaped-HTML description decoded to plain text');
  } else {
    fail(`description: ${JSON.stringify(sc && sc.description)}`);
  }
  if (sc && sc.description.includes('Skills & custom agent loops')) pass('double-escaped entity (&amp;amp;) decoded');
  else fail(`entity decode: ${JSON.stringify(sc && sc.description)}`);

  const cy = jobs.find((j) => j.jobId === '111111111111111111');
  if (cy && cy.title === 'Research Engineer, Cyber & Fuzzing, DeepMind') pass('CDATA title unwrapped and decoded');
  else fail(`CDATA title: ${JSON.stringify(cy && cy.title)}`);
  if (cy && cy.location === 'Remote; New York, NY, USA') pass('remote job location prefixed "Remote; "');
  else fail(`remote location: ${JSON.stringify(cy && cy.location)}`);

  if (parseFeed('').length === 0 && parseFeed('<jobs><job><title>x</title></job></jobs>').length === 0) {
    pass('empty input and job without jobid → []');
  } else {
    fail('robustness: expected [] for empty / id-less input');
  }
}

// 2. filterJobs — deterministic recency, employer and topic logic
{
  const jobs = parseFeed(xml);
  const now = Date.parse('2026-09-24T00:00:00Z');
  const recent = filterJobs(jobs, { sinceDays: 14, now, regex: TOPIC });
  const ids = recent.map((j) => j.jobId);
  if (JSON.stringify(ids) === JSON.stringify(['74431926638650054', '111111111111111111'])) {
    pass('14d window: keeps the 2 topical DeepMind jobs, newest first');
  } else {
    fail(`14d window kept ${JSON.stringify(ids)}`);
  }
  if (!ids.includes('222222222222222222')) pass('off-topic job (Maps) dropped by topic regex');
  else fail('off-topic job kept');

  const year = filterJobs(jobs, { sinceDays: 365, now, regex: TOPIC }).map((j) => j.jobId);
  if (year.includes('333333333333333333')) pass('365d window: old YouTube security job kept');
  else fail(`365d window: ${JSON.stringify(year)}`);
  if (!year.includes('444444444444444444')) pass('employer outside the allow-list (Waymo) dropped');
  else fail('Waymo job kept despite employer filter');

  const noTopic = filterJobs(jobs, { sinceDays: 365, now }).map((j) => j.jobId);
  if (noTopic.includes('222222222222222222') && !noTopic.includes('444444444444444444')) pass('no --regex (default): topic filter off, employer filter still on');
  else fail(`default topic filter: ${JSON.stringify(noTopic)}`);

  const onlyDm = filterJobs(jobs, { sinceDays: 365, now, regex: TOPIC, employers: ['DeepMind'] }).map((j) => j.jobId);
  if (onlyDm.length === 2) pass('--employers DeepMind narrows to DeepMind only');
  else fail(`employers=DeepMind kept ${JSON.stringify(onlyDm)}`);
}

// 3. CLI --fixture emits the local-parser JSON contract
{
  const stdout = run(NODE, [SCRIPT, '--fixture', FIXTURE, '--since-days', '100000', '--regex', TOPIC]);
  let payload = null;
  try { payload = JSON.parse(stdout); } catch { /* reported below */ }
  if (Array.isArray(payload) && payload.length === 3) pass('CLI --fixture prints a 3-element JSON array');
  else fail(`CLI --fixture output: ${String(stdout).slice(0, 200)}`);
  if (payload && payload.every((j) => j.title && j.url && j.company && j.source === 'google-careers')) {
    pass('CLI rows carry title/url/company/source');
  } else {
    fail(`CLI rows malformed: ${String(stdout).slice(0, 200)}`);
  }
}

// 4. CLI fails loudly (exit 1, no JSON) on a truncated or too-small feed
{
  const dir = mkdtempSync(join(tmpdir(), 'gc-feed-'));
  try {
    const truncated = join(dir, 'truncated.xml');
    writeFileSync(truncated, xml.slice(0, xml.lastIndexOf('</jobs>')));
    const out = run(NODE, [SCRIPT, '--fixture', truncated]);
    if (out === null && lastRunFailure()?.status === 1) pass('truncated feed (no </jobs>) → exit 1');
    else fail(`truncated feed: stdout=${JSON.stringify(out)} status=${lastRunFailure()?.status}`);

    const small = run(NODE, [SCRIPT, '--fixture', FIXTURE, '--min-jobs', '99']);
    if (small === null && lastRunFailure()?.status === 1) pass('fewer jobs than --min-jobs → exit 1');
    else fail(`min-jobs guard: stdout=${JSON.stringify(small)} status=${lastRunFailure()?.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 5. local-parser.detect() accepts the portals.yml entry shape
{
  const lp = (await import(pathToFileURL(join(ROOT, 'providers/local-parser.mjs')).href)).default;
  const entry = {
    name: 'Google DeepMind / Google / YouTube — careers feed',
    parser: { command: 'node', script: SCRIPT, args: ['--since-days', '14'] },
  };
  const hit = lp.detect(entry);
  if (hit && hit.url === 'local-parser') pass('local-parser.detect() resolves the Google feed entry (no careers_url)');
  else fail(`local-parser.detect() returned ${JSON.stringify(hit)}`);
}
