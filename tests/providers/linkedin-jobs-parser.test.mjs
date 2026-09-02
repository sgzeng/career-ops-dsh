// tests/providers/linkedin-jobs-parser.test.mjs
//
// Covers scripts/parsers/linkedin-jobs.mjs (the LinkedIn guest-search parser
// wired into scan.mjs via providers/local-parser.mjs) and confirms
// local-parser.detect() accepts the portals.yml entry shape.
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, run, ROOT, NODE } from '../helpers.mjs';

console.log('\nParser — linkedin-jobs');

const mod = await import(pathToFileURL(join(ROOT, 'scripts/parsers/linkedin-jobs.mjs')).href);
const { parseLinkedInSearchPage, withinWindow } = mod;
const FIXTURE = join(ROOT, 'tests/fixtures/linkedin-guest-search.html');
const html = readFileSync(FIXTURE, 'utf-8');

// 1. parseLinkedInSearchPage — pure parse of all cards, no recency filter
{
  const jobs = parseLinkedInSearchPage(html);
  if (jobs.length === 3) pass('parses all 3 fixture cards');
  else fail(`expected 3 jobs, got ${jobs.length}: ${JSON.stringify(jobs.map((j) => j.id))}`);

  const canonical = jobs.every((j) => /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+$/.test(j.url));
  if (canonical) pass('every url is canonical /jobs/view/<id> (no slug, no query)');
  else fail(`non-canonical url: ${JSON.stringify(jobs.map((j) => j.url))}`);

  const amp = jobs.find((j) => j.company.includes('Booz Allen'));
  if (amp && amp.company === 'Booz Allen & Hamilton') pass('HTML entities decoded in company name');
  else fail(`entity decode failed: ${JSON.stringify(amp && amp.company)}`);

  const first = jobs[0];
  if (first.title === 'Principal Security Researcher (Xpanse)') pass('title extracted and whitespace-collapsed');
  else fail(`title: ${JSON.stringify(first.title)}`);
  if (first.location === 'Santa Clara, CA') pass('location extracted');
  else fail(`location: ${JSON.stringify(first.location)}`);
  if (first.postedAt === '2026-08-27') pass('postedAt (listdate) extracted');
  else fail(`postedAt: ${JSON.stringify(first.postedAt)}`);
}

// 2. parseLinkedInSearchPage — robustness
{
  if (parseLinkedInSearchPage('').length === 0) pass('empty string → []');
  else fail('empty string did not return []');
  if (parseLinkedInSearchPage('<li>no urn here</li>').length === 0) pass('card without job urn skipped');
  else fail('card without urn was not skipped');
}

// 3. withinWindow — deterministic recency logic (fixed reference date)
{
  const now = Date.parse('2026-09-01T00:00:00Z');
  if (withinWindow('2026-08-31', 7, now) === true) pass('withinWindow: 1-day-old kept for 7d window');
  else fail('withinWindow rejected a fresh posting');
  if (withinWindow('2026-07-01', 7, now) === false) pass('withinWindow: 62-day-old dropped for 7d window');
  else fail('withinWindow kept a stale posting');
  if (withinWindow('', 7, now) === true) pass('withinWindow: undated posting kept');
  else fail('withinWindow dropped an undated posting');
}

// 4. CLI --fixture path emits valid JSON on stdout (wide window keeps all 3)
{
  const stdout = run(NODE, [
    'scripts/parsers/linkedin-jobs.mjs',
    '--fixture', FIXTURE,
    '--since-days', '100000',
  ]);
  if (stdout === null) {
    fail('CLI --fixture run crashed');
  } else {
    let payload;
    try { payload = JSON.parse(stdout); } catch { payload = null; }
    if (Array.isArray(payload) && payload.length === 3) pass('CLI --fixture prints a 3-element JSON array');
    else fail(`CLI --fixture output: ${stdout.slice(0, 200)}`);
    if (payload && payload.every((j) => j.title && j.url && j.source === 'linkedin')) {
      pass('CLI output rows carry title/url/source');
    } else {
      fail(`CLI output rows malformed: ${JSON.stringify(payload)}`);
    }
  }
}

// 5. CLI --fixture with a tight window drops the stale fixture card
{
  const stdout = run(NODE, [
    'scripts/parsers/linkedin-jobs.mjs',
    '--fixture', FIXTURE,
    '--since-days', '7',
  ]);
  // The 2026-07-01 fixture card is always stale relative to real "now"; the two
  // 2026-08 cards may or may not be, so assert only that the stale one is gone
  // and the count never exceeds 2.
  if (stdout !== null) {
    const payload = JSON.parse(stdout);
    const hasStale = payload.some((j) => j.url.endsWith('/4421192327'));
    if (!hasStale && payload.length <= 2) pass('CLI recency filter drops the July card');
    else fail(`recency filter kept stale card or too many: ${JSON.stringify(payload.map((j) => j.url))}`);
  } else {
    fail('CLI tight-window run crashed');
  }
}

// 6. local-parser.detect() accepts the portals.yml entry shape
{
  const lp = (await import(pathToFileURL(join(ROOT, 'providers/local-parser.mjs')).href)).default;
  const entry = {
    name: 'LinkedIn — security research search',
    parser: {
      command: 'node',
      script: 'scripts/parsers/linkedin-jobs.mjs',
      args: ['--since-days', '7', '--pages', '2', 'vulnerability researcher'],
    },
  };
  const hit = lp.detect(entry);
  if (hit && hit.url === 'local-parser') pass('local-parser.detect() resolves the LinkedIn entry (no careers_url)');
  else fail(`local-parser.detect() returned ${JSON.stringify(hit)}`);
}
