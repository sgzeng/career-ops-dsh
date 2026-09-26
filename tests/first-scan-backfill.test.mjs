// tests/first-scan-backfill.test.mjs — lib/first-scan-backfill.mjs and its scan.mjs hook.
//
// `scan.mjs --since 14` only sees a company's last 14 days, so on the FIRST scan
// of a newly tracked company every still-open older posting was filtered and never
// seen again (NVIDIA JR2021886, posted 2026-08-11, first scanned 2026-09-03). The
// fix gives each company one pass with a max_posting_age_days window, recorded in
// data/scan-backfill.tsv. Unit checks cover config, key, planner, state I/O and
// the NVIDIA date math. The e2e checks run the real scan.mjs over a local fixture
// parser in a sandbox (CAREER_OPS_ROOT), without network access.
import { pass, fail, ROOT, NODE, captureConsoleErrors } from './helpers.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  resolveBackfillConfig, backfillKey, makeBackfillPlanner, loadBackfillState, appendBackfillState,
  formatBackfillSummary, BACKFILL_HEADER, isTruncatedFetch, resolveBackfillPath, MAX_TRUNCATED_ATTEMPTS,
} from '../lib/first-scan-backfill.mjs';
import { resolveEffectiveAfter, buildPostedDateFilter, resolveEarlyStopMs, collectSeenUrls } from '../scan.mjs';
import workday from '../providers/workday.mjs';
import * as yaml from 'js-yaml';

console.log('\nscan.mjs — first-coverage backfill');

const DAY = 86_400_000;

// 1. Config: default on with max_posting_age_days, opt-outs, cap, no-window.
{
  const c = (raw, max, o) => resolveBackfillConfig(raw, max, o);
  const ok = c(undefined, 45).enabled && c(undefined, 45).windowDays === 45
    && c({ window_days: 30 }, 45).windowDays === 30
    && c({ window_days: 90 }, 45).windowDays === 45 // capped by the age filter
    && c({ window_days: 30 }, undefined).windowDays === 30
    && !c(false, 45).enabled && !c({ enabled: false }, 45).enabled
    && c(undefined, 45, { cliOff: true }).off === '--no-backfill'
    && !c(undefined, undefined).enabled && /no window/.test(c(undefined, undefined).off);
  ok ? pass('config: on by default with max_posting_age_days, capped by it, off via config/--no-backfill/no window')
    : fail('resolveBackfillConfig returned an unexpected shape');
}

// 1b. Config fails CLOSED: js-yaml reads `off`/`no` as strings and an empty key
//     as null; every value validate-portals rejects must turn the backfill off.
{
  const on = (y) => resolveBackfillConfig(yaml.load(y)?.first_scan_backfill, 45).enabled;
  const offs = ['first_scan_backfill: off', 'first_scan_backfill: no', 'first_scan_backfill: "false"',
    'first_scan_backfill:', 'first_scan_backfill: [1]', 'first_scan_backfill: 0',
    'first_scan_backfill:\n  enabled: off', 'first_scan_backfill:\n  enabled: no',
    'first_scan_backfill:\n  window_days: 0', 'first_scan_backfill:\n  window_days: -3',
    'first_scan_backfill:\n  window_days: 30.5', 'first_scan_backfill:\n  window_days: "45"'];
  const stillOn = offs.filter(on);
  const ons = ['x: 1', 'first_scan_backfill: true', 'first_scan_backfill:\n  enabled: true', 'first_scan_backfill:\n  window_days: 30'];
  const wronglyOff = ons.filter((y) => !on(y));
  const reason = resolveBackfillConfig(yaml.load('first_scan_backfill:\n  enabled: off').first_scan_backfill, 45).off;
  (stillOn.length === 0 && wronglyOff.length === 0 && /enabled: "off" is not a boolean/.test(reason))
    ? pass('config fails closed: off/no/null/0/bad window_days all disable it; absent/true/valid block enable it')
    : fail(`fail-closed config: still on=${JSON.stringify(stillOn)} wrongly off=${JSON.stringify(wronglyOff)} reason=${reason}`);
}

// 2. Key: URL identity survives rename/case/trailing slash; falls back api → parser → name.
{
  const nv = { name: 'NVIDIA (Product Security / AI Red Team)', careers_url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite' };
  const renamed = { name: 'NVIDIA', careers_url: 'https://NVIDIA.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/' };
  const ok = backfillKey(nv) === 'url:nvidia.wd5.myworkdayjobs.com/nvidiaexternalcareersite'
    && backfillKey(renamed) === backfillKey(nv)
    && backfillKey({ name: 'X', api: 'https://api.ashbyhq.com/posting-api/job-board/x' }) === 'url:api.ashbyhq.com/posting-api/job-board/x'
    && backfillKey({ name: 'G', parser: { command: 'node', script: 'scripts/parsers/g.mjs', args: ['--since-days', '14'] } })
      === 'parser:node scripts/parsers/g.mjs --since-days 14'
    && backfillKey({ name: '  Some   Co ' }) === 'name:some co';
  ok ? pass('key: normalized careers_url (rename-proof), then api, parser command line, name')
    : fail(`backfillKey: ${backfillKey(nv)} / ${backfillKey(renamed)}`);
}

// 2b. Keys survive the TSV round trip: a parser arg with a trailing space, a tab
//     or a YAML `|` newline must still match its own row after write + reload.
{
  const dir = mkdtempSync(join(tmpdir(), 'backfill-key-'));
  try {
    const f = join(dir, 'scan-backfill.tsv');
    const entries = [
      { name: 'P1', parser: { command: 'node', script: 'p.mjs', args: ['--q', 'security engineer '] } },
      { name: 'P2', parser: { command: 'node', script: 'p.mjs', args: ['a\tb'] } },
      { name: 'P3', parser: { command: 'node', script: 'p.mjs', args: ['line one\nline two\n'] } },
      { name: 'P4', careers_url: 'not a url\twith tab ' },
    ];
    appendBackfillState(f, entries.map((e) => ({ key: backfillKey(e), company: e.name, windowDays: 45 })));
    const plan = makeBackfillPlanner({ cfg: resolveBackfillConfig(undefined, 45), sinceDays: 14, explicitBounds: false, state: loadBackfillState(f) });
    const replanned = entries.filter((e) => plan(e, 'local-parser', false) !== null && e.first_scan_backfill !== undefined);
    const again = entries.map((e) => ({ ...e, first_scan_backfill: true })).filter((e) => plan(e, 'local-parser', false) !== null);
    (replanned.length === 0 && again.length === 0 && !/\s{2}|\t|\n|\s$/.test(entries.map(backfillKey).join('|')))
      ? pass('key: whitespace squashed in the key itself, so a recorded parser entry is not re-backfilled every run')
      : fail(`key round trip: re-planned ${JSON.stringify(again.map((e) => backfillKey(e)))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. Planner: who gets widened, who is only recorded, who is left alone.
{
  const cfg = resolveBackfillConfig(undefined, 45);
  const nv = { name: 'NVIDIA', careers_url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite' };
  const done = { name: 'Old', careers_url: 'https://jobs.ashbyhq.com/old' };
  const parserEntry = { name: 'Google feed', parser: { command: 'node', script: 's.mjs' } };
  const state = new Map([[backfillKey(done), [{ windowDays: 45, maxPages: null, status: 'complete' }]]]);
  const plan = makeBackfillPlanner({ cfg, sinceDays: 14, explicitBounds: false, state });
  const a = plan(nv, 'workday', false);
  const ok = a && a.widen === true && a.key === backfillKey(nv)
    && plan(done, 'ashby', false) === null                       // already covered
    && plan(parserEntry, 'local-parser', false) === null         // parser owns its window
    && plan({ ...parserEntry, first_scan_backfill: true }, 'local-parser', false)?.widen === true
    && plan({ ...nv, first_scan_backfill: false }, 'workday', false) === null
    && plan({ ...nv, first_scan_backfill: 'no' }, 'workday', false) === null  // YAML `no` is a string: still an opt-out
    && plan({ ...nv, first_scan_backfill: null }, 'workday', false) === null
    && plan({ name: 'Board', careers_url: 'https://b.example' }, 'remoteok', true) === null
    && makeBackfillPlanner({ cfg, sinceDays: 14, explicitBounds: true, state })(nv, 'workday', false) === null
    && makeBackfillPlanner({ cfg, sinceDays: null, explicitBounds: false, state })(nv, 'workday', false)?.widen === false
    && makeBackfillPlanner({ cfg, sinceDays: 60, explicitBounds: false, state })(nv, 'workday', false)?.widen === false
    && makeBackfillPlanner({ cfg: resolveBackfillConfig(undefined, 45, { cliOff: true }), sinceDays: 14, explicitBounds: false, state })(nv, 'workday', false) === null;
  ok ? pass('planner: unrecorded ATS company widened; recorded/boards/parsers/opt-outs/explicit bounds untouched; wide runs only record')
    : fail(`planner: ${JSON.stringify(a)}`);
}

// 3b. Coverage rules: truncated rows retry up to MAX_TRUNCATED_ATTEMPTS; a row
//     taken with a smaller window or max_pages than today's does not cover.
{
  const cfg = resolveBackfillConfig(undefined, 45);
  const e = { name: 'Netflix', careers_url: 'https://netflix.eightfold.ai/careers' };
  const k = backfillKey(e);
  const planWith = (rows, entry = e, c = cfg) => makeBackfillPlanner({ cfg: c, sinceDays: 14, explicitBounds: false, state: new Map([[k, rows]]) })(entry, 'eightfold', false);
  const row = (o) => ({ windowDays: 45, maxPages: null, status: 'complete', ...o });
  const trunc = row({ status: 'truncated' });
  const ok = planWith([trunc])?.widen === true
    && planWith(Array(MAX_TRUNCATED_ATTEMPTS - 1).fill(trunc)) !== null
    && planWith(Array(MAX_TRUNCATED_ATTEMPTS).fill(trunc)) === null      // clamped board: give up, not daily re-crawl
    && planWith([trunc, row()]) === null
    && planWith([row({ windowDays: 30 })]) !== null                       // window raised 30 → 45
    && planWith([row({ windowDays: 30 })], e, resolveBackfillConfig({ window_days: 30 }, 45)) === null
    && planWith([row()], { ...e, max_pages: 50 })?.maxPages === 50        // max_pages raised: re-run
    && planWith([row({ maxPages: 1 })], { ...e, max_pages: 50 }) !== null
    && planWith([row({ maxPages: 50 })], { ...e, max_pages: 50 }) === null
    && planWith([row({ maxPages: 50 })], { ...e, max_pages: 10 }) === null
    && planWith([row({ windowDays: null })]) === null;                     // legacy 4-column row
  ok ? pass(`coverage: truncated crawls retried (covered after ${MAX_TRUNCATED_ATTEMPTS}), a smaller recorded window/max_pages re-runs the pass`)
    : fail('coverage rules returned an unexpected plan');
}

// 3c. Truncation detection reads the providers' array tags. Reproduces the review
//     case offline: a Workday tenant whose page 2 fails through every retry.
{
  const entry = { name: 'BigCo', careers_url: 'https://bigco.wd5.myworkdayjobs.com/External' };
  const page0 = { total: 200, jobPostings: Array.from({ length: 20 }, (_, i) => ({
    title: `Role ${i}`, externalPath: `/job/X/role-${i}`, postedOn: 'Posted 30+ Days Ago' })) };
  let calls = 0;
  const ctx = {
    transport: 'http', sleep: async () => {}, includeUndated: true, sinceMs: Date.now() - 45 * DAY,
    fetchText: async () => { throw new Error('no fetchText'); },
    fetchJson: async () => { calls++; if (calls === 1) return page0; const err = new Error('HTTP 429'); err.status = 429; throw err; },
  };
  const { result: jobs } = await captureConsoleErrors(() => workday.fetch(entry, ctx));
  const icims = Object.assign([{}], { icimsTruncated: true });
  (jobs.length === 20 && isTruncatedFetch(jobs) && isTruncatedFetch(icims) && !isTruncatedFetch([{}]) && !isTruncatedFetch(null))
    ? pass('truncation: a Workday crawl cut short by 429s (and an iCIMS page cap) is detected, so it is not recorded as covered')
    : fail(`truncation: len=${jobs.length} tag=${jobs.workdayTruncated}`);
}

// 3d. Lanes: the state follows the dedup history unless set explicitly.
{
  const d = '/r/data/scan-backfill.tsv';
  const ok = resolveBackfillPath({ explicit: '', historyOverride: false, historyPath: '/r/data/scan-history.tsv', defaultPath: d }) === d
    && resolveBackfillPath({ explicit: '/x.tsv', historyOverride: true, historyPath: '/r/h.tsv', defaultPath: d }) === '/x.tsv'
    && resolveBackfillPath({ explicit: undefined, historyOverride: true, historyPath: '/r/data/scan-history.bridge.tsv', defaultPath: d }) === '/r/data/scan-backfill.bridge.tsv'
    && resolveBackfillPath({ explicit: undefined, historyOverride: true, historyPath: '/lane/b/history.tsv', defaultPath: d }) === '/lane/b/history.backfill.tsv';
  ok ? pass('lanes: CAREER_OPS_SCAN_HISTORY override derives its own backfill file; explicit CAREER_OPS_SCAN_BACKFILL wins')
    : fail('resolveBackfillPath returned an unexpected path');
}

// 3e. collectSeenUrls exposes the recheck-released rows the widened pass keeps seen.
{
  const today = '2026-09-30';
  const hist = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\nhttps://x.example/old\t2026-08-20\tp\tt\tc\tadded\nhttps://x.example/new\t2026-09-25\tp\tt\tc\tadded\n';
  const pipe = '# Pipeline\n\n## Processed\n- [x] #-- | https://x.example/old | skipped (triage FAIL)\n';
  const r = collectSeenUrls({ scanHistoryText: hist, pipelineText: pipe }, { recheckAfterDays: 30, today });
  (r.released?.size === 1 && [...r.released][0].includes('x.example/old') && r.recheckEligible === 1 && !r.seen.has([...r.released][0]))
    ? pass('dedup: collectSeenUrls returns the released set (recheckEligible unchanged)')
    : fail(`collectSeenUrls released=${JSON.stringify([...(r.released || [])])}`);
}

// 4. The NVIDIA miss, with a fixed clock: JR2021886 (startDate 2026-08-11) on the
//    first scan (2026-09-03). --since 14 drops it; the 45-day pass keeps it, and
//    the early-stop floor moves back with the filter.
{
  const now = Date.parse('2026-09-03T19:30:00Z');
  const posted = Date.parse('2026-08-11T00:00:00Z');
  const normal = buildPostedDateFilter(resolveEffectiveAfter(null, 14, now), null);
  const bfAfter = resolveEffectiveAfter(null, 45, now);
  const wide = buildPostedDateFilter(bfAfter, null);
  const floor = resolveEarlyStopMs(bfAfter, 45, now);
  (!normal(posted) && wide(posted) && floor <= posted && floor >= now - 45 * DAY - DAY)
    ? pass('NVIDIA JR2021886 (23 days old at first scan): dropped by --since 14, kept by the 45-day first pass')
    : fail(`date math: normal=${normal(posted)} wide=${wide(posted)} floor=${new Date(floor).toISOString()}`);
}

// 5. State file: header, append, trailing-newline repair, tab-safe, reload.
{
  const dir = mkdtempSync(join(tmpdir(), 'backfill-state-'));
  try {
    const f = join(dir, 'data', 'scan-backfill.tsv');
    appendBackfillState(f, [{ key: 'url:a', company: 'A\tCo', windowDays: 45 }, { key: 'url:a', company: 'dup', windowDays: 45 }],
      new Date('2026-09-24T00:00:00Z'));
    writeFileSync(f, readFileSync(f, 'utf-8').trimEnd(), 'utf-8'); // simulate a hand edit without final newline
    appendBackfillState(f, [{ key: 'url:b', company: 'B', windowDays: 30 }]);
    appendBackfillState(f, [{ key: 'url:c', company: 'C', windowDays: 45, maxPages: 110, truncated: true }]);
    const text = readFileSync(f, 'utf-8');
    const m = loadBackfillState(f);
    writeFileSync(join(dir, 'legacy.tsv'), 'key\tcompany\tbackfilled_at\twindow_days\nurl:l\tL\t2026-09-24T00:00:00.000Z\t45\n');
    const legacy = loadBackfillState(join(dir, 'legacy.tsv')).get('url:l')?.[0];
    (text.startsWith(BACKFILL_HEADER) && m.size === 3 && m.get('url:a').length === 1 && m.get('url:a')[0].company === 'A Co'
      && m.get('url:a')[0].backfilledAt === '2026-09-24T00:00:00.000Z' && m.get('url:b')[0].windowDays === 30
      && m.get('url:b')[0].status === 'complete' && m.get('url:c')[0].status === 'truncated' && m.get('url:c')[0].maxPages === 110
      && legacy?.status === 'complete' && legacy.maxPages === null
      && loadBackfillState(join(dir, 'missing.tsv')).size === 0)
      ? pass('state file: header once, one row per key, survives a missing final newline, reloads by key')
      : fail(`state file: ${JSON.stringify(text)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 6. Summary line wording.
{
  const cfg = resolveBackfillConfig(undefined, 45);
  const s = (o) => formatBackfillSummary({ cfg, explicitBounds: false, widened: [], recordOnly: [], failed: [], dryRun: false, ...o });
  const ok = /Backfill: +3 companies scanned with a 45-day window \(first coverage\)$/.test(s({ widened: ['a', 'b', 'c'] }))
    && /1 not recorded .*: c/.test(s({ widened: ['a', 'c'], failed: ['c'] }))
    && /\(dry run, not recorded\)$/.test(s({ widened: ['a'], dryRun: true }))
    && /none pending/.test(s({}))
    && /off \(--no-backfill\)/.test(formatBackfillSummary({ cfg: resolveBackfillConfig(undefined, 45, { cliOff: true }) }))
    && /skipped this run/.test(s({ explicitBounds: true }))
    && /1 crawl\(s\) truncated, retried next run .*: NVIDIA/.test(s({ widened: ['NVIDIA'], truncated: ['NVIDIA'] }));
  ok ? pass('summary: one line per run (count + window, failures, dry run, off, skipped)')
    : fail(`summary: ${s({ widened: ['a', 'b', 'c'] })}`);
}

// 7. validate-portals knows the keys (run as a CLI: importing it runs main()).
{
  const dir = mkdtempSync(join(tmpdir(), 'backfill-validate-'));
  try {
    const run = (yml) => {
      const file = join(dir, 'portals.yml');
      writeFileSync(file, yml);
      try {
        return execFileSync(NODE, [join(ROOT, 'validate-portals.mjs'), '--file', file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { return `${e.stdout}${e.stderr}`; }
    };
    const ok = run('first_scan_backfill:\n  enabled: true\n  window_days: 45\ntracked_companies:\n  - name: A\n    careers_url: https://jobs.ashbyhq.com/a\n    first_scan_backfill: false\n');
    const bad = run('first_scan_backfill:\n  window_days: -3\ntracked_companies:\n  - name: A\n    careers_url: https://jobs.ashbyhq.com/a\n    first_scan_backfill: "yes"\n');
    const okTrue = run('first_scan_backfill: true\ntracked_companies:\n  - name: A\n    careers_url: https://jobs.ashbyhq.com/a\n');
    (/0 errors, 0 warnings/.test(ok) && /0 errors, 0 warnings/.test(okTrue) && /first_scan_backfill\.window_days/.test(bad) && /tracked_companies.*first_scan_backfill/.test(bad))
      ? pass('validate-portals accepts first_scan_backfill (top level + per entry) and rejects bad values')
      : fail(`validate-portals: ok=${ok} bad=${bad}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 8. END-TO-END: real scan.mjs over the fixture parser (no network).
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'scan-backfill-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`);
  writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n');
  return dir;
}
function portals(dir, { name = 'Backfill Co', entryExtra = '    first_scan_backfill: true\n', top = '' } = {}) {
  writeFileSync(join(dir, 'portals.yml'), `title_filter:
  positive:
    - "Security Engineer"
max_posting_age_days: 45
${top}tracked_companies:
  - name: ${name}
    parser:
      command: node
      script: tests/fixtures/backfill-board.mjs
${entryExtra}`);
}
function scan(dir, args, fixture = '', extraEnv = {}) {
  const env = { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: join(dir, 'portals.yml'), BACKFILL_FIXTURE: fixture };
  for (const k of ['CAREER_OPS_SCAN_BACKFILL', 'CAREER_OPS_SCAN_HISTORY', 'CAREER_OPS_PIPELINE', 'CAREER_OPS_DATA_DIR']) delete env[k];
  Object.assign(env, extraEnv);
  return execFileSync(NODE, [join(ROOT, 'scan.mjs'), ...args], {
    cwd: dir, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const added = (dir, file = 'pipeline.md') => {
  const p = join(dir, 'data', file);
  return existsSync(p)
    ? readFileSync(p, 'utf-8').split('\n').filter(l => l.startsWith('- [ ] ')).map(l => l.split(' | ')[2]).sort()
    : [];
};
const statePath = (dir) => join(dir, 'data', 'scan-backfill.tsv');
const lastRun = (dir) => {
  const lines = readFileSync(join(dir, 'data', 'scan-runs.tsv'), 'utf-8').trim().split('\n');
  const head = lines[0].split('\t');
  const row = lines.at(-1).split('\t');
  return Object.fromEntries(head.map((h, i) => [h, row[i]]));
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 8a. dry run → preview widened, nothing written; real run → 45-day pass + row;
//     next run (entry renamed, new 25-day posting) → back to --since 14.
{
  const dir = sandbox();
  try {
    portals(dir);
    const dry = scan(dir, ['--since', '14', '--dry-run']);
    (/Backfill: +1 company scanned with a 45-day window \(first coverage\) \(dry run, not recorded\)/.test(dry)
      && /Security Engineer d40/.test(dry) && !existsSync(statePath(dir)) && same(added(dir), []))
      ? pass('e2e --dry-run previews the 45-day first pass and writes no state')
      : fail(`dry run: state=${existsSync(statePath(dir))} out=${dry.split('\n').filter(l => /Backfill|\+ /.test(l)).join(' | ')}`);

    const first = scan(dir, ['--since', '14']);
    const rows = loadBackfillState(statePath(dir));
    const row = rows.get('parser:node tests/fixtures/backfill-board.mjs')?.[0];
    const run1 = lastRun(dir);
    (same(added(dir), ['Security Engineer d2', 'Security Engineer d20', 'Security Engineer d40'])
      && row && row.company === 'Backfill Co' && row.windowDays === 45 && row.status === 'complete' && rows.size === 1
      && run1.filtered_posted_date === '0' && run1.filtered_posting_age === '1'
      && /Backfill: +1 company scanned with a 45-day window \(first coverage\)$/m.test(first))
      ? pass('e2e first run: postings 15-45 days old reach the pipeline, >45 still age-filtered, company recorded')
      : fail(`first run: added=${JSON.stringify(added(dir))} rows=${JSON.stringify([...rows])} run=${JSON.stringify(run1)}`);

    portals(dir, { name: 'Backfill Co (renamed)' });
    const second = scan(dir, ['--since', '14'], 'second');
    const run2 = lastRun(dir);
    (same(added(dir), ['Security Engineer d1', 'Security Engineer d2', 'Security Engineer d20', 'Security Engineer d40'])
      && run2.filtered_posted_date === '3' // d20, d25, d40 fall outside --since 14 again
      && /none pending/.test(second) && loadBackfillState(statePath(dir)).size === 1)
      ? pass('e2e second run (entry renamed): --since 14 applies again, no re-backfill, nothing re-added')
      : fail(`second run: added=${JSON.stringify(added(dir))} run=${JSON.stringify(run2)} out=${second.split('\n').filter(l => /Backfill/.test(l)).join('')}`);
  } catch (err) {
    fail(`e2e backfill scan failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 8b. A failed or empty fetch writes no row (retried next run).
{
  const dir = sandbox();
  try {
    portals(dir);
    const failOut = scan(dir, ['--since', '14'], 'fail');
    const emptyOut = scan(dir, ['--since', '14'], 'empty');
    (!existsSync(statePath(dir)) && /1 not recorded/.test(failOut) && /1 not recorded/.test(emptyOut))
      ? pass('e2e provider failure / empty board: no state row, so the next run backfills again')
      : fail(`failure: state=${existsSync(statePath(dir))} fail=${/not recorded/.test(failOut)} empty=${/not recorded/.test(emptyOut)}`);
  } catch (err) {
    fail(`e2e backfill failure scan failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 8c. Runs that must NOT widen: --no-backfill, explicit --posted-after, config
//     off, and a local parser that did not opt in.
{
  const cases = [
    ['--no-backfill', {}, ['--since', '14', '--no-backfill'], /off \(--no-backfill\)/],
    ['--posted-after', {}, ['--since', '14', '--posted-after', new Date(Date.now() - 50 * DAY).toISOString().slice(0, 10)], /skipped this run/],
    ['first_scan_backfill.enabled: false', { top: 'first_scan_backfill:\n  enabled: false\n' }, ['--since', '14'], /off \(portals\.yml/],
    ['a local parser without first_scan_backfill: true', { entryExtra: '' }, ['--since', '14'], /none pending/],
  ];
  for (const [label, opts, args, want] of cases) {
    const dir = sandbox();
    try {
      portals(dir, opts);
      const out = scan(dir, args);
      (same(added(dir), ['Security Engineer d2']) && !existsSync(statePath(dir)) && want.test(out))
        ? pass(`e2e ${label}: plain --since 14 window, no state written`)
        : fail(`${label}: added=${JSON.stringify(added(dir))} state=${existsSync(statePath(dir))} out=${out.split('\n').filter(l => /Backfill/.test(l)).join('')}`);
    } catch (err) {
      fail(`e2e ${label} failed: ${err.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// 8d. Widened pass keeps recheck-released rows seen. d40 was first seen 35 days
//     ago and triaged away (`- [x]` under ## Processed); recheck_after_days: 30
//     releases it. The 45-day pass must not hand it back to stage 2.
{
  const dir = sandbox();
  try {
    portals(dir, { top: 'scan_history:\n  recheck_after_days: 30\n' });
    const old = new Date(Date.now() - 35 * DAY).toISOString().slice(0, 10);
    writeFileSync(join(dir, 'data', 'scan-history.tsv'),
      `url\tfirst_seen\tportal\ttitle\tcompany\tstatus\nhttps://jobs.example.com/backfill/d40\t${old}\tlocal-parser\tSecurity Engineer d40\tBackfill Co\tadded\n`);
    writeFileSync(join(dir, 'data', 'pipeline.md'),
      '# Pipeline\n\n## Pending\n\n## Processed\n- [x] #-- | https://jobs.example.com/backfill/d40 | skipped (triage FAIL)\n');
    const out = scan(dir, ['--since', '14']);
    (same(added(dir), ['Security Engineer d2', 'Security Engineer d20']) && /Backfill: +1 company scanned/.test(out))
      ? pass('e2e widened pass: a triaged, recheck-released posting is not re-added (d2, d20 still are)')
      : fail(`released rows: added=${JSON.stringify(added(dir))}`);
  } catch (err) {
    fail(`e2e released-row scan failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 8e. Lanes: two lanes with their own history/pipeline each get their own first
//     pass (the second lane used to print "none pending" and lose d20/d40).
{
  const dir = sandbox();
  try {
    portals(dir);
    const lane = (n) => ({ CAREER_OPS_PIPELINE: join(dir, 'data', `pipeline.${n}.md`), CAREER_OPS_SCAN_HISTORY: join(dir, 'data', `scan-history.${n}.tsv`) });
    scan(dir, ['--since', '14'], '', lane('a'));
    const outB = scan(dir, ['--since', '14'], '', lane('b'));
    const want = ['Security Engineer d2', 'Security Engineer d20', 'Security Engineer d40'];
    (same(added(dir, 'pipeline.a.md'), want) && same(added(dir, 'pipeline.b.md'), want)
      && existsSync(join(dir, 'data', 'scan-backfill.a.tsv')) && existsSync(join(dir, 'data', 'scan-backfill.b.tsv'))
      && !existsSync(statePath(dir)) && /Backfill: +1 company scanned/.test(outB))
      ? pass('e2e lanes: CAREER_OPS_SCAN_HISTORY lanes keep separate backfill state, both get the 45-day pass')
      : fail(`lanes: a=${JSON.stringify(added(dir, 'pipeline.a.md'))} b=${JSON.stringify(added(dir, 'pipeline.b.md'))}`);
  } catch (err) {
    fail(`e2e lanes scan failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 8f. An unreadable state file (here: a directory) turns the backfill off for the
//     run instead of aborting stage 1.
{
  const dir = sandbox();
  try {
    portals(dir);
    mkdirSync(statePath(dir));
    const out = scan(dir, ['--since', '14']);
    (same(added(dir), ['Security Engineer d2']) && /Backfill: +off \(state file unreadable: /.test(out))
      ? pass('e2e unreadable state file: scan completes with the plain --since window, Backfill line says why')
      : fail(`unreadable state: added=${JSON.stringify(added(dir))} out=${out.split('\n').filter(l => /Backfill/.test(l)).join('')}`);
  } catch (err) {
    fail(`e2e unreadable state scan failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 8g. A parser entry whose args carry a trailing space is recorded once and not
//     re-backfilled on the next run.
{
  const dir = sandbox();
  try {
    portals(dir, { entryExtra: '      args:\n        - "security engineer "\n    first_scan_backfill: true\n' });
    scan(dir, ['--since', '14']);
    const second = scan(dir, ['--since', '14']);
    (/none pending/.test(second) && loadBackfillState(statePath(dir)).size === 1)
      ? pass('e2e parser key with trailing whitespace: recorded once, next run is "none pending"')
      : fail(`trailing-space key: ${second.split('\n').filter(l => /Backfill/.test(l)).join('')} rows=${JSON.stringify([...loadBackfillState(statePath(dir)).keys()])}`);
  } catch (err) {
    fail(`e2e trailing-space key scan failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
