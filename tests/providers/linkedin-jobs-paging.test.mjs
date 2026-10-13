// tests/providers/linkedin-jobs-paging.test.mjs
//
// Paging and block handling of scripts/parsers/linkedin-jobs.mjs. No network:
// collectJobs() takes an injectable fetchPage, and the CLI / local-parser paths
// run the real script in a child whose global fetch is replaced by a --import
// preload that replays a scripted plan.
//
// The facts being modelled (live check 2026-10-13): the guest endpoint returns
// 10 cards per request and `start` is a result offset, so start=0,10,20,... walks
// the results with no gap and no overlap. The old code stepped start by 25 and
// never saw results 11-25.
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { pass, fail, rmSync, ROOT, NODE } from '../helpers.mjs';

console.log('\nParser — linkedin-jobs paging and partial results');

const mod = await import(pathToFileURL(join(ROOT, 'scripts/parsers/linkedin-jobs.mjs')).href);
const { collectJobs, countSearchCards, formatPartialWarning } = mod;

const check = (cond, msg, detail = '') => (cond ? pass(msg) : fail(`${msg}${detail ? ` — ${detail}` : ''}`));
const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── synthetic guest-search markup ───────────────────────────────────────────
const card = (id, date = '') =>
  `<li><div class="base-card base-search-card" data-entity-urn="urn:li:jobPosting:${id}">`
  + `<h3 class="base-search-card__title">Security Researcher ${id}</h3>`
  + '<h4 class="base-search-card__subtitle"><a>Acme</a></h4>'
  + '<span class="job-search-card__location">Remote</span>'
  + `${date ? `<time datetime="${date}"></time>` : ''}</div></li>`;
const fragment = (ids, date) => `<ul class="jobs-search__results-list">${ids.map((id) => card(id, date)).join('')}</ul>`;
const idsOf = (jobs) => jobs.map((j) => Number(j.url.split('/').pop()));
const BASE = { pages: 5, throttleMs: 0, sinceDays: 7, location: 'United States' };

/**
 * A fake guest endpoint over fixed result lists, keyword → ids. `start` is a
 * result offset, exactly like the real one; `pageSize` models how many cards a
 * request returns. `render(id)` may be overridden to emit odd markup.
 */
function endpoint(results, { pageSize = 10, render = card, ignoreStart = false } = {}) {
  const calls = [];
  const fetchPage = async (keyword, { start }) => {
    calls.push({ keyword, start });
    const list = results[keyword] || [];
    const slice = list.slice(ignoreStart ? 0 : start, (ignoreStart ? 0 : start) + pageSize);
    return slice.length ? `<ul>${slice.map((id) => render(id)).join('')}</ul>` : '';
  };
  return { calls, fetchPage };
}
const starts = (calls, keyword) => calls.filter((c) => c.keyword === keyword).map((c) => c.start);
const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });

// 1. countSearchCards counts cards the parser may not be able to read
{
  check(countSearchCards('') === 0 && countSearchCards(undefined) === 0, 'countSearchCards: empty / non-string → 0');
  check(countSearchCards(fragment([1, 2, 3])) === 3, 'countSearchCards: counts every <li> card');
  check(countSearchCards('<li>no urn</li><li>x</li>') === 2, 'countSearchCards: counts cards without a job urn too');
}

// 2. offsets are the real page size: 0,10,20,... — no gap, no overlap
{
  const ep = endpoint({ kw: range(1, 101) });
  const { jobs, partial } = await collectJobs(['kw'], { ...BASE, fetchPage: ep.fetchPage });
  check(sameList(starts(ep.calls, 'kw'), [0, 10, 20, 30, 40]), 'default depth: 5 requests at start=0,10,20,30,40', JSON.stringify(starts(ep.calls, 'kw')));
  check(sameList(idsOf(jobs), range(1, 51)), 'the top 50 results come back contiguous (1-50, no skipped 11-25, no duplicates)', JSON.stringify(idsOf(jobs)));
  check(partial === null, 'a complete run reports no partial');
  check(jobs.every((j) => j.source === 'linkedin' && /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+$/.test(j.url)), 'job rows keep their shape');
}

// 3. --pages is "max requests per keyword"
{
  const ep = endpoint({ kw: range(1, 101) });
  const { jobs } = await collectJobs(['kw'], { ...BASE, pages: 2, fetchPage: ep.fetchPage });
  check(sameList(starts(ep.calls, 'kw'), [0, 10]) && jobs.length === 20, 'pages=2 → two requests, results 1-20', JSON.stringify(starts(ep.calls, 'kw')));
}

// 4. early stop: empty page
{
  const ep = endpoint({ kw: range(1, 21) });
  const { jobs } = await collectJobs(['kw'], { ...BASE, fetchPage: ep.fetchPage });
  check(sameList(starts(ep.calls, 'kw'), [0, 10, 20]) && jobs.length === 20, 'results end on a page boundary → the empty page stops paging', JSON.stringify(starts(ep.calls, 'kw')));
}

// 5. early stop: short page (end of results) costs no extra request
{
  const ep = endpoint({ kw: range(1, 26) });
  const { jobs } = await collectJobs(['kw'], { ...BASE, fetchPage: ep.fetchPage });
  check(sameList(starts(ep.calls, 'kw'), [0, 10, 20]) && jobs.length === 25, 'a 5-card page ends the keyword without a 4th request', JSON.stringify(starts(ep.calls, 'kw')));
  const ep2 = endpoint({ kw: range(1, 5) });
  await collectJobs(['kw'], { ...BASE, fetchPage: ep2.fetchPage });
  check(sameList(starts(ep2.calls, 'kw'), [0]), 'fewer than 10 results → exactly one request');
}

// 6. early stop: a page of only already-seen ids (the endpoint repeating itself)
{
  const ep = endpoint({ kw: range(1, 11) }, { ignoreStart: true });
  const { jobs } = await collectJobs(['kw'], { ...BASE, fetchPage: ep.fetchPage });
  check(sameList(starts(ep.calls, 'kw'), [0, 10]) && jobs.length === 10, 'a repeated page stops the keyword, no duplicates kept', JSON.stringify(starts(ep.calls, 'kw')));
}

// 7. the all-seen stop is per keyword: another keyword's ids must not end paging
{
  const kw2 = [...range(1, 11), ...range(101, 121)]; // page 1 is entirely kw1's ids
  const ep = endpoint({ kw1: range(1, 31), kw2 });
  const { jobs } = await collectJobs(['kw1', 'kw2'], { ...BASE, fetchPage: ep.fetchPage });
  const ids = idsOf(jobs);
  check(starts(ep.calls, 'kw2').slice(0, 3).join() === '0,10,20', 'kw2 keeps paging past a first page that kw1 already produced', JSON.stringify(starts(ep.calls, 'kw2')));
  check(new Set(ids).size === ids.length && ids.length === 50, 'ids are deduped across keywords (30 + 20 new)', `${ids.length} jobs`);
}

// 8. dedupe across pages when consecutive pages overlap
{
  const overlapping = async (keyword, { start }) => fragment(range(Math.max(0, start - 2) + 1, Math.max(0, start - 2) + 11));
  const calls = [];
  const { jobs } = await collectJobs(['kw'], { ...BASE, pages: 3, fetchPage: (k, o) => { calls.push(o.start); return overlapping(k, o); } });
  const ids = idsOf(jobs);
  check(new Set(ids).size === ids.length && ids.length === 28, 'overlapping pages never produce a duplicate job (1-10, 9-18, 19-28 → 28)', `${ids.length} jobs`);
}

// 9. a card the parser cannot read neither ends paging nor leaves a gap
{
  const broken = (id) => (id === 5 ? '<li>unreadable card</li>' : card(id));
  const ep = endpoint({ kw: range(1, 31) }, { render: broken });
  const { jobs } = await collectJobs(['kw'], { ...BASE, fetchPage: ep.fetchPage });
  check(sameList(starts(ep.calls, 'kw'), [0, 9, 19, 29]), 'offset advances by cards actually parsed (9), so nothing is skipped', JSON.stringify(starts(ep.calls, 'kw')));
  check(sameList(idsOf(jobs), range(1, 31).filter((id) => id !== 5)), 'every readable result is collected exactly once');
}

// 10. if LinkedIn serves bigger pages again, offsets follow the cards, not a constant
{
  const ep = endpoint({ kw: range(1, 61) }, { pageSize: 25 });
  const { jobs } = await collectJobs(['kw'], { ...BASE, fetchPage: ep.fetchPage });
  check(sameList(starts(ep.calls, 'kw'), [0, 25, 50, 60]) && sameList(idsOf(jobs), range(1, 61)), '25-card pages: offsets 0,25,50,60, all 60 results, no gap', JSON.stringify(starts(ep.calls, 'kw')));
}

// 11. recency filter drops stale cards from the output but does not end paging
{
  const render = (id) => card(id, id <= 10 ? '2000-01-01' : '');
  const ep = endpoint({ kw: range(1, 31) }, { render });
  const { jobs } = await collectJobs(['kw'], { ...BASE, fetchPage: ep.fetchPage });
  check(sameList(idsOf(jobs), range(11, 31)) && starts(ep.calls, 'kw').length === 4, 'stale page filtered out, paging continues', JSON.stringify(idsOf(jobs)));
}

// 12. throttle: one delay between consecutive requests, none before the first
{
  const events = [];
  const ep = endpoint({ a: range(1, 21), b: range(1, 21) });
  const fetchPage = async (k, o) => { events.push('fetch'); return ep.fetchPage(k, o); };
  await collectJobs(['a', 'b'], { ...BASE, pages: 2, throttleMs: 123, fetchPage, sleep: async (ms) => events.push(`sleep:${ms}`) });
  check(events.join() === 'fetch,sleep:123,fetch,sleep:123,fetch,sleep:123,fetch', 'throttle runs between every pair of requests (also across keywords), never before the first', events.join());

  const t0 = Date.now();
  const ep3 = endpoint({ kw: range(1, 100) });
  await collectJobs(['kw'], { ...BASE, pages: 3, throttleMs: 30, fetchPage: ep3.fetchPage });
  const elapsed = Date.now() - t0;
  check(elapsed >= 55, 'real timer: 3 requests at throttleMs=30 take at least 2 delays', `${elapsed}ms`);
}

// 13. partial result: a block after jobs were collected keeps them and stops
{
  const calls = [];
  const fetchPage = async (keyword, { start }) => {
    calls.push(`${keyword}@${start}`);
    if (keyword === 'kw2' && start === 10) throw fatal('linkedin-jobs: HTTP 429 for "kw2" (start=10) — rate-limited or blocked');
    const list = keyword === 'kw1' ? range(1, 31) : range(101, 141);
    const slice = list.slice(start, start + 10);
    return slice.length ? fragment(slice) : '';
  };
  const { jobs, partial } = await collectJobs(['kw1', 'kw2', 'kw3'], { ...BASE, fetchPage });
  check(jobs.length === 40, 'kw1 (30) and the page of kw2 fetched before the 429 (10) are kept', `${jobs.length} jobs`);
  check(partial && partial.keyword === 'kw2' && partial.start === 10 && partial.keywordIndex === 1, 'partial names the keyword and the offset', JSON.stringify(partial && { k: partial.keyword, s: partial.start }));
  check(calls[calls.length - 1] === 'kw2@10' && !calls.some((c) => c.startsWith('kw3')), 'no request is made after the block (kw3 never searched)', calls.join());
  const warn = formatPartialWarning(partial, jobs.length);
  check(/PARTIAL RESULT/.test(warn) && warn.includes('"kw2"') && warn.includes('start=10') && warn.includes('429') && warn.includes('40 job(s)') && warn.includes('1 later keyword(s)'),
    'warning names status, keyword, offset, kept count and skipped keywords', warn);
}

// 14. partial result also covers 403 / 999 / network failures
for (const msg of ['HTTP 403 for "kw" (start=10)', 'HTTP 999 for "kw" (start=10)', 'request failed for "kw" (start=10): fetch failed']) {
  const ep = endpoint({ kw: range(1, 100) });
  const fetchPage = async (k, o) => { if (o.start === 10) throw fatal(`linkedin-jobs: ${msg}`); return ep.fetchPage(k, o); };
  const { jobs, partial } = await collectJobs(['kw'], { ...BASE, fetchPage });
  check(jobs.length === 10 && partial && partial.start === 10, `partial result after: ${msg}`);
}

// 15. nothing collected yet → still fatal; a non-fatal error always propagates
{
  let err = null;
  try {
    await collectJobs(['kw'], { ...BASE, fetchPage: async () => { throw fatal('linkedin-jobs: HTTP 429 for "kw" (start=0)'); } });
  } catch (e) { err = e; }
  check(err && err.fatal === true, 'a block on the very first request still throws a fatal error');

  err = null;
  const stale = async (k, { start }) => (start === 0 ? fragment(range(1, 11), '2000-01-01') : (() => { throw fatal('linkedin-jobs: HTTP 429'); })());
  try { await collectJobs(['kw'], { ...BASE, fetchPage: stale }); } catch (e) { err = e; }
  check(err && err.fatal === true, 'a block after requests that yielded zero jobs is still fatal (exit 2, not a silent empty success)');

  err = null;
  const ep = endpoint({ kw: range(1, 100) });
  try {
    await collectJobs(['kw'], { ...BASE, fetchPage: async (k, o) => { if (o.start === 10) throw new TypeError('boom'); return ep.fetchPage(k, o); } });
  } catch (e) { err = e; }
  check(err instanceof TypeError, 'a non-fatal error is not mistaken for a block, even after jobs were collected');
}

// 16. --dump filenames carry the real start offset
{
  const dir = mkdtempSync(join(tmpdir(), 'li-dump-'));
  try {
    const ep = endpoint({ 'red team': range(1, 26) });
    await collectJobs(['red team'], { ...BASE, dump: dir, fetchPage: ep.fetchPage });
    const files = readdirSync(dir).sort();
    check(sameList(files, ['red_team-0.html', 'red_team-10.html', 'red_team-20.html']), 'dump files are <keyword>-<start offset>.html', files.join());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the real script in a child process, global fetch replaced by a preload ──
const work = mkdtempSync(join(tmpdir(), 'li-paging-'));
const stubPath = join(work, 'fetch-stub.mjs');
writeFileSync(stubPath, `
import { appendFileSync } from 'node:fs';
const plan = JSON.parse(process.env.LI_STUB_PLAN || '[]');
const log = process.env.LI_STUB_LOG;
let i = 0;
const card = (id) => '<li><div data-entity-urn="urn:li:jobPosting:' + id + '">'
  + '<h3 class="base-search-card__title">Security Researcher ' + id + '</h3>'
  + '<h4 class="base-search-card__subtitle"><a>Acme</a></h4>'
  + '<span class="job-search-card__location">Remote</span></div></li>';
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  appendFileSync(log, u.searchParams.get('keywords') + '\\t' + u.searchParams.get('start') + '\\n');
  const step = plan[i++] || { ids: [] };
  if (step.network) throw new TypeError('fetch failed');
  const status = step.status || 200;
  const body = (step.ids || []).length ? '<ul>' + step.ids.map(card).join('') + '</ul>' : '';
  return { status, ok: status >= 200 && status < 300, text: async () => body };
};
`);

let runNo = 0;
function runCli(plan, args) {
  const log = join(work, `requests-${++runNo}.log`);
  writeFileSync(log, '');
  const res = spawnSync(NODE, ['--import', pathToFileURL(stubPath).href, 'scripts/parsers/linkedin-jobs.mjs', '--throttle-ms', '1', ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, LI_STUB_PLAN: JSON.stringify(plan), LI_STUB_LOG: log },
  });
  const requests = readFileSync(log, 'utf-8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  return { ...res, requests };
}
const fullPages = (n, from = 1) => Array.from({ length: n }, (_, p) => ({ ids: range(from + p * 10, from + p * 10 + 10) }));

try {
  // 17. CLI default depth
  {
    const r = runCli(fullPages(8), ['security researcher']);
    const jobs = r.status === 0 ? JSON.parse(r.stdout) : [];
    check(r.status === 0 && sameList(r.requests.map((q) => q[1]), ['0', '10', '20', '30', '40']), 'CLI default: 5 requests at start=0..40 (top ~50)', `exit ${r.status} ${JSON.stringify(r.requests)}`);
    check(jobs.length === 50 && r.stderr === '', 'CLI default: 50 jobs on stdout, stderr quiet', `${jobs.length} jobs, stderr=${JSON.stringify(r.stderr)}`);
  }

  // 18. CLI --pages
  {
    const r = runCli(fullPages(8), ['--pages', '2', 'security researcher']);
    check(r.status === 0 && sameList(r.requests.map((q) => q[1]), ['0', '10']) && JSON.parse(r.stdout).length === 20, 'CLI --pages 2 → start=0,10 and 20 jobs');
  }

  // 19. first request blocked → exit 2, no stdout, reason names keyword + offset
  for (const step of [{ status: 429 }, { status: 403 }, { status: 999 }, { network: true }]) {
    const r = runCli([step], ['red team', 'product security']);
    check(r.status === 2 && r.stdout === '' && r.stderr.includes('"red team"') && r.stderr.includes('start=0') && !r.stderr.includes('PARTIAL'),
      `first request ${step.network ? 'network failure' : step.status} → exit 2, empty stdout, reason on stderr`, `exit ${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
    check(r.requests.length === 1, '… and no further request after the block');
  }

  // 20. blocked after jobs were collected → exit 0, jobs on stdout, warning on stderr
  for (const step of [{ status: 429 }, { status: 403 }, { status: 999 }, { network: true }]) {
    const r = runCli([...fullPages(2), step, ...fullPages(3)], ['--pages', '4', 'kw one', 'kw two']);
    let jobs = null;
    try { jobs = JSON.parse(r.stdout); } catch { /* reported below */ }
    const label = step.network ? 'network failure' : step.status;
    check(r.status === 0 && Array.isArray(jobs) && jobs.length === 20, `block (${label}) at start=20 → exit 0 with the 20 jobs already collected`, `exit ${r.status} stdout=${r.stdout.slice(0, 80)}`);
    check(/PARTIAL RESULT/.test(r.stderr) && r.stderr.includes('"kw one"') && r.stderr.includes('start=20') && r.stderr.includes('1 later keyword(s)'),
      `block (${label}) → stderr says PARTIAL RESULT with keyword and offset`, r.stderr);
    check(r.requests.length === 3 && !r.requests.some((q) => q[0] === 'kw two'), `block (${label}) → requesting stops (3 requests, 2nd keyword never queried)`, JSON.stringify(r.requests));
  }

  // 21. --help describes the new depth
  {
    const r = spawnSync(NODE, ['scripts/parsers/linkedin-jobs.mjs', '--help'], { cwd: ROOT, encoding: 'utf-8', timeout: 30000 });
    check(r.status === 0 && /max guest requests per keyword/.test(r.stdout) && /default 5/.test(r.stdout) && !/default 2/.test(r.stdout), '--help documents --pages as max requests per keyword, default 5');
  }

  // 22. through providers/local-parser: a partial result is visible, not a silent success
  {
    const lp = (await import(pathToFileURL(join(ROOT, 'providers/local-parser.mjs')).href)).default;
    const entry = (...kw) => ({
      name: 'LinkedIn — paging test',
      parser: { command: 'node', script: 'scripts/parsers/linkedin-jobs.mjs', args: ['--throttle-ms', '1', '--pages', '3', ...kw], timeout_ms: 30000 },
    });
    const savedEnv = { NODE_OPTIONS: process.env.NODE_OPTIONS, PLAN: process.env.LI_STUB_PLAN, LOG: process.env.LI_STUB_LOG };
    const savedError = console.error;
    const seen = [];
    console.error = (...a) => seen.push(a.join(' '));
    try {
      process.env.NODE_OPTIONS = `--import=${pathToFileURL(stubPath).href}`;
      process.env.LI_STUB_LOG = join(work, 'lp.log');
      writeFileSync(process.env.LI_STUB_LOG, '');

      process.env.LI_STUB_PLAN = JSON.stringify([...fullPages(2), { status: 429 }]);
      const partialJobs = await lp.fetch(entry('kw one', 'kw two'));
      check(partialJobs.length === 20, 'local-parser returns the jobs collected before the block');
      check(seen.length === 1 && seen[0].includes('LinkedIn — paging test') && seen[0].includes('PARTIAL RESULT') && seen[0].includes('start=20'),
        'local-parser prints the parser warning into the scan output', JSON.stringify(seen));

      seen.length = 0;
      process.env.LI_STUB_PLAN = JSON.stringify([{ ids: range(1, 6) }]);
      const okJobs = await lp.fetch(entry('kw one'));
      check(okJobs.length === 5 && seen.length === 0, 'a clean run stays quiet');

      let rejected = null;
      process.env.LI_STUB_PLAN = JSON.stringify([{ status: 429 }]);
      try { await lp.fetch(entry('kw one')); } catch (e) { rejected = e; }
      check(rejected && /HTTP 429/.test(rejected.message), 'a first-request block still rejects, so scan.mjs records the error');
    } finally {
      console.error = savedError;
      for (const [k, v] of Object.entries({ NODE_OPTIONS: savedEnv.NODE_OPTIONS, LI_STUB_PLAN: savedEnv.PLAN, LI_STUB_LOG: savedEnv.LOG })) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
