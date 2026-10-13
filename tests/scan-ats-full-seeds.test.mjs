// tests/scan-ats-full-seeds.test.mjs — `scan-ats-full.mjs --seeds yc,a16z`, the
// reverse discovery that was decorative.
//
// Facts from the 2026-10-08 weekly run this was written against: the a16z
// parser returned 0 from a real 3.7 MB page; every YC company was probed on
// Greenhouse only (2.9% reachable; the AI-security targets are all on Ashby); the
// YC walk silently stopped at 37-47% of the portfolio in 3 of 9 runs; ~6.1k dead
// slugs were re-probed at concurrency 20 against one host every week; and every
// failure, 404 or 429 alike, was one "Unreachable boards" number.
//
// Part 1 drives runSeedScan() with stub providers. Part 2 runs the whole CLI in a
// child process against a stubbed `fetch` (the YC API and all three ATS APIs are
// served from a route table), so the summary, --json, --dry-run and the cache
// files are checked as the operator sees them — with no network.

import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, rmSync, NODE, ROOT } from './helpers.mjs';

console.log('\nscan-ats-full --seeds — multi-ATS probing, filters kept, honest summary');

const href = (rel) => pathToFileURL(join(ROOT, rel)).href;
const full = await import(href('scan-ats-full.mjs'));
const scan = await import(href('scan.mjs'));
const vc = await import(href('seeds/vc-portfolios.mjs'));
const probe = await import(href('seeds/seed-probe.mjs'));
const greenhouse = (await import(href('providers/greenhouse.mjs'))).default;
const ashby = (await import(href('providers/ashby.mjs'))).default;
const lever = (await import(href('providers/lever.mjs'))).default;
const { runSeedScan, formatSeedDone, createKeyedLimiter, parseArgs } = full;
const { createSeedRunState, newSeedStats, unreachableTotal } = probe;

const DAY = 86_400_000;
const httpErr = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── stubs ────────────────────────────────────────────────────────────

/** Real detect(), scripted fetch(): see tests/seed-probe.test.mjs. */
function providersFor(boards, log = [], hooks = {}) {
  const last = (u) => new URL(u).pathname.split('/').filter(Boolean)[0];
  const mk = (real, vendor) => ({
    ...real,
    async fetch(entry) {
      const slug = last(entry.careers_url);
      log.push(`${vendor}/${slug}`);
      await hooks.onFetch?.(vendor, slug);
      const v = boards[`${vendor}/${slug}`];
      if (typeof v === 'function') return v();
      if (Array.isArray(v)) return v;
      if (v === 'net') throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      throw httpErr(typeof v === 'number' ? v : 404);
    },
  });
  return { greenhouse: mk(greenhouse, 'greenhouse'), ashby: mk(ashby, 'ashby'), lever: mk(lever, 'lever') };
}

const posting = (title, over = {}) => ({
  title,
  url: `https://jobs.example.test/${encodeURIComponent(title)}-${Math.abs(hashCode(title + JSON.stringify(over)))}`,
  company: 'x',
  location: 'Remote',
  postedAt: Date.now() - DAY,
  ...over,
});
function hashCode(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

const titleFilterConfig = { positive: ['security engineer'], negative: ['intern'] };
function baseOpts(over = {}) {
  return {
    sinceDays: 10, limit: Infinity, shuffle: false, includeUndated: false,
    titleFilter: scan.buildTitleFilter(titleFilterConfig),
    locationFilter: scan.buildLocationFilter({ block: ['Antarctica'] }),
    contentFilter: scan.buildContentFilter({ positive: ['security'] }),
    titleFilterConfig,
    blacklist: new Map(), includeBlacklisted: false, json: false, verbose: false, levelGate: null,
    ...over,
  };
}

const YC = vc.SEED_SOURCES.yc;
const realFetch = YC.fetch;
const realWarn = console.error;
function withPortfolio(companies) {
  YC.fetch = async () => companies;
}
function quiet() {
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  return lines;
}

const co = (slug, extra = {}) => ({ name: `Co ${slug}`, slug, url: '', source: 'yc', ...extra });
const tmp = mkdtempSync(join(tmpdir(), 'career-ops-seeds-'));

let counter = 0;
async function runSeeds(companies, boards, { opts = {}, seen = new Set(), state, log = [], hooks = {}, concurrency } = {}) {
  withPortfolio(companies);
  const stderr = quiet();
  try {
    const st = state ?? createSeedRunState({
      deadPath: join(tmp, `d${++counter}`, 'dead.tsv'),
      livePath: join(tmp, `d${counter}`, 'live.tsv'),
      persist: false,
      withKeySlot: createKeyedLimiter(6),
      sleep: async () => {},
    });
    const result = await runSeedScan('yc', baseOpts(opts), {}, seen, 'YC', { providers: providersFor(boards, log, hooks), state: st, concurrency });
    return { result, stderr, log, seen, state: st };
  } finally {
    console.error = realWarn;
    YC.fetch = realFetch;
  }
}

try {
  // ── filters on the seed path are unchanged ──────────────────────────
  {
    const seen = new Set([scan.normalizeUrlForDedup('https://jobs.example.test/already-seen')]);
    const boards = {
      'ashby/acme': [
        posting('Security Engineer'),                                  // kept
        posting('Senior Security Engineer', { location: 'Antarctica' }), // location_filter
        posting('Security Engineer Intern'),                           // title negative
        posting('Pastry Chef'),                                        // title positive
        posting('Security Engineer, Old', { postedAt: Date.now() - 30 * DAY }), // older than --since
        posting('Security Engineer, Undated', { postedAt: undefined }),   // no date
        posting('Security Engineer, Seen', { url: 'https://jobs.example.test/already-seen' }), // already known
        posting('Security Engineer, No Content', { description: 'We sell pastries' }), // content_filter
        { title: 'Security Engineer, No Url', url: '' },                  // unusable
      ],
    };
    // content_filter wants "security" in the body: give the kept posting some.
    boards['ashby/acme'][0].description = 'security work';
    const { result } = await runSeeds([co('acme')], boards, { seen });
    const titles = result.offers.map((o) => o.title);
    if (eq(titles, ['Security Engineer'])) pass('seed postings still go through the date, title, location, content and dedup filters (one of nine survives)');
    else fail(`seed filters kept ${JSON.stringify(titles)}`);
    const kept = result.offers[0];
    if (kept && kept.source === 'yc-seed' && kept.dateStatus === 'dated' && result.stats.matches === 1) pass('a kept posting is tagged yc-seed and dated');
    else fail(`kept posting: ${JSON.stringify(kept)}`);

    // --include-undated keeps the undated one (marked), nothing else changes.
    const boards2 = { 'ashby/acme': [posting('Security Engineer', { description: 'security' }), posting('Security Engineer, Undated', { postedAt: undefined, description: 'security' })] };
    const u = await runSeeds([co('acme')], boards2, { opts: { includeUndated: true } });
    const undated = u.result.offers.find((o) => /Undated/.test(o.title));
    if (u.result.offers.length === 2 && undated?.dateStatus === 'unknown') pass('--include-undated keeps an undated seed posting, marked "unknown"');
    else fail(`include-undated: ${JSON.stringify(u.result.offers.map((o) => [o.title, o.dateStatus]))}`);

    // The same posting reached through two companies is one offer.
    const shared = posting('Security Engineer', { description: 'security', url: 'https://jobs.example.test/shared-posting' });
    const d = await runSeeds([co('one'), co('two')], { 'ashby/one': [shared], 'ashby/two': [{ ...shared }] }, { concurrency: 1 });
    if (d.result.offers.length === 1) pass('a posting two boards both list is kept once (shared dedup set)');
    else fail(`cross-board dedup: ${d.result.offers.length}`);
  }

  // level gate: sync drop, async drop, async keep (with the dedup re-check)
  {
    const mkGate = () => ({
      filter: {},
      admit: (job) => {
        if (/Staff/.test(job.title)) return false;
        if (/Async Drop/.test(job.title)) return Promise.resolve(false);
        if (/Async Keep/.test(job.title)) return Promise.resolve(true);
        return true;
      },
    });
    const boards = { 'ashby/acme': [
      posting('Staff Security Engineer', { description: 'security' }),
      posting('Security Engineer Async Drop', { description: 'security' }),
      posting('Security Engineer Async Keep', { description: 'security' }),
      posting('Security Engineer', { description: 'security' }),
    ] };
    const { result } = await runSeeds([co('acme')], boards, { opts: { levelGate: mkGate() } });
    const titles = result.offers.map((o) => o.title).sort();
    if (eq(titles, ['Security Engineer', 'Security Engineer Async Keep'])) pass('the level gate still runs on seed postings (sync drop, async drop and async keep)');
    else fail(`level gate: ${JSON.stringify(titles)}`);
  }

  // ── what is probed, and in what order ───────────────────────────────
  {
    const companies = [
      co('plain-one'),
      co('hiring-one', { hiring: true }),
      co('plain-two'),
      co('inactive-hiring', { hiring: true, status: 'Inactive' }),
    ];
    const { log, result } = await runSeeds(companies, {}, { opts: { limit: 2 }, concurrency: 1 });
    const probed = [...new Set(log.map((l) => l.split('/')[1]))];
    if (eq(probed, ['hiring-one', 'plain-one']) && result.total === 2) pass('--limit 2 keeps the hiring company and the first plain one, probed hiring first (a priority, never a filter)');
    else fail(`limit/priority: probed ${JSON.stringify(probed)}, total ${result.total}`);

    const all = await runSeeds(companies, {}, { concurrency: 1 });
    const order = [...new Set(all.log.map((l) => l.split('/')[1]))];
    if (eq(order, ['hiring-one', 'plain-one', 'plain-two', 'inactive-hiring']) && all.result.total === 4) pass('with no limit every company is probed (inactive and acquired included), hiring ones first');
    else fail(`order: ${JSON.stringify(order)}`);

    const sh = await runSeeds(Array.from({ length: 30 }, (_, i) => co(`s${i}`)), {}, { opts: { limit: 7, shuffle: true } });
    if (sh.result.total === 7 && new Set(sh.log.map((l) => l.split('/')[1])).size === 7) pass('--limit with --shuffle probes a random sample of exactly that many companies');
    else fail(`shuffle limit: total ${sh.result.total}`);
  }

  // ── failure shapes: always an object, always a summary ──────────────
  {
    withPortfolio([]);
    YC.fetch = async () => { throw new Error('vc-portfolios: YC API fetch failed — HTTP 503'); };
    const stderr = quiet();
    let res;
    try {
      res = await runSeedScan('yc', baseOpts(), {}, new Set(), 'YC', { providers: providersFor({}), state: createSeedRunState({ deadPath: join(tmp, 'x', 'd'), livePath: join(tmp, 'x', 'l'), persist: false, withKeySlot: createKeyedLimiter(6) }) });
    } finally { console.error = realWarn; YC.fetch = realFetch; }
    if (res && Array.isArray(res.offers) && res.offers.length === 0 && res.errors === 0 && res.total === 0
      && res.stats.fetchFailed === true && /HTTP 503/.test(res.stats.failure) && res.stats.warnings.length === 1 && stderr.some((l) => /yc: could not fetch portfolio/.test(l))) {
      pass('a failed portfolio fetch returns the same { offers, errors, total, stats } object (it used to return a bare []), with the failure recorded and warned');
    } else {
      fail(`fetch failure result: ${JSON.stringify(res)}`);
    }
    if (/FAILED.*HTTP 503/.test(formatSeedDone(res.stats))) pass('the summary line for a failed fetch says FAILED and why');
    else fail(`formatSeedDone on failure: ${formatSeedDone(res.stats)}`);

    const zero = await runSeeds([], {});
    if (zero.result.total === 0 && zero.result.stats.warnings.some((w) => /0 companies/.test(w)) && zero.stderr.some((l) => /0 companies/.test(l))) pass('a portfolio of 0 companies warns instead of reporting a clean empty scan');
    else fail(`zero companies: ${JSON.stringify(zero.result.stats.warnings)}`);

    // Warnings and truncation from the fetcher itself are carried through.
    withPortfolio([]);
    YC.fetch = async ({ onWarn, diag }) => { onWarn('YC walk ended early: 92 of 253 pages'); diag.truncated = true; return [co('a')]; };
    const err2 = quiet();
    let res2;
    try {
      res2 = await runSeedScan('yc', baseOpts(), {}, new Set(), 'YC', { providers: providersFor({}), state: createSeedRunState({ deadPath: join(tmp, 'y', 'd'), livePath: join(tmp, 'y', 'l'), persist: false, withKeySlot: createKeyedLimiter(6) }) });
    } finally { console.error = realWarn; YC.fetch = realFetch; }
    if (res2.stats.truncated === true && res2.stats.warnings[0] === 'YC walk ended early: 92 of 253 pages' && err2.some((l) => /yc: YC walk ended early/.test(l))) {
      pass('a fetcher\'s own degraded-run warning and truncation flag reach the seed stats and stderr');
    } else {
      fail(`fetcher warning: ${JSON.stringify(res2.stats)}`);
    }
  }

  // ── breakdown counters ──────────────────────────────────────────────
  {
    const boards = {
      'ashby/live': [posting('Security Engineer', { description: 'security' })],
      'ashby/slow': 'net', 'greenhouse/slow': 'net', 'lever/slow': 502,
      'ashby/limited': 429,
    };
    const { result, stderr } = await runSeeds([co('live'), co('dead'), co('slow'), co('limited')], boards, { concurrency: 1 });
    const s = result.stats;
    const u = s.unreachable;
    if (s.companies === 4 && s.live === 1 && s.dead === 1 && s.unknown === 2 && s.liveEmpty === 0 && s.byVendor.ashby === 1
      && u['404'] === 5 && u['429'] === 1 && u.network === 2 && u['5xx'] === 1 && u['403'] === 0 && u.other === 0) {
      pass('per-class counters: 404 x5, 429 x1, timeout x2, 5xx x1; one live, one dead, two unknown');
    } else {
      fail(`counters: ${JSON.stringify({ companies: s.companies, live: s.live, dead: s.dead, unknown: s.unknown, u })}`);
    }
    if (result.errors === unreachableTotal(u) && result.errors === 9 && result.total === 4) pass('the caller\'s "unreachable" figure is the sum of the classes, and total is the companies probed');
    else fail(`errors ${result.errors} total ${result.total}`);
    if (s.probes === 10 && s.requests === 0) pass('probes are counted per candidate board asked about (10), requests come from the context wrapper (0 for stub providers)');
    else fail(`probes ${s.probes} requests ${s.requests}`);
    const text = formatSeedDone(s);
    if (/4 companies: 1 live \(ashby 1\), 1 dead, 2 unknown/.test(text) && /unreachable 9: 404 5 \| 403 0 \| 429 1 \| 5xx 1 \| timeout\/network 2 \| other 0/.test(text)) {
      pass('the run-log line carries the live/dead/unknown split and the class breakdown');
    } else {
      fail(`formatSeedDone: ${text}`);
    }
    if (stderr.some((l) => /1 probes were throttled \(429\)/.test(l)) && stderr.some((l) => /2 companies have no known board and at least one candidate failed/.test(l))) {
      pass('a throttled run and unknown companies each produce their own warning');
    } else {
      fail(`warnings: ${JSON.stringify(stderr)}`);
    }
  }

  // ── per-host request discipline, end to end through runSeedScan ─────
  {
    const per = {};
    const peak = {};
    const hooks = {
      async onFetch(vendor) {
        per[vendor] = (per[vendor] ?? 0) + 1;
        peak[vendor] = Math.max(peak[vendor] ?? 0, per[vendor]);
        await new Promise((r) => setTimeout(r, 4));
        per[vendor]--;
      },
    };
    withPortfolio(Array.from({ length: 60 }, (_, i) => co(`zz-cap-${i}`)));
    quiet();
    try {
      // No state passed: the default one is built, with SINGLE_HOST_CONCURRENCY per host.
      await runSeedScan('yc', baseOpts(), {}, new Set(), 'YC', { providers: providersFor({}, [], hooks) });
    } finally { console.error = realWarn; YC.fetch = realFetch; }
    if (Math.max(...Object.values(peak)) === 6 && Object.values(peak).every((p) => p <= 6)) {
      pass('the default seed scan holds each API host to 6 requests in flight (SINGLE_HOST_CONCURRENCY), not the 20 workers it used to throw at one host');
    } else {
      fail(`per-host peaks ${JSON.stringify(peak)}`);
    }
  }

  // ── a host that keeps refusing is abandoned, loudly ─────────────────
  {
    const boards = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`lever/zz-ref-${i}`, 429]));
    const state = createSeedRunState({
      deadPath: join(tmp, 'abandon', 'd'), livePath: join(tmp, 'abandon', 'l'), persist: true,
      withKeySlot: createKeyedLimiter(2), sleep: async () => {}, blockLimit: 4,
    });
    const { result, stderr } = await runSeeds(Array.from({ length: 20 }, (_, i) => co(`zz-ref-${i}`)), boards, { state, concurrency: 1 });
    const s = result.stats;
    if (s.abandonedHosts.join() === 'api.lever.co' && s.unreachable['429'] === 4 && s.skippedAbandoned === 16 && s.unknown === 20) {
      pass('after 4 straight 429s the host is abandoned: 16 later probes are skipped, all 20 companies stay "unknown"');
    } else {
      fail(`abandon: ${JSON.stringify({ hosts: s.abandonedHosts, u: s.unreachable, skipped: s.skippedAbandoned, unknown: s.unknown })}`);
    }
    if (stderr.some((l) => /api\.lever\.co kept refusing.*abandoned.*16 probes skipped, not remembered as dead; rerun later/.test(l))) pass('the abandonment is a loud warning with the number of skipped probes');
    else fail(`abandon warning: ${JSON.stringify(stderr)}`);
    const dead = [...state.cache.dead.keys()].filter((k) => k.startsWith('lever'));
    if (dead.length === 0) pass('boards that were refused (not 404) are not written to the dead-board memory');
    else fail(`dead rows for refused boards: ${dead.join(',')}`);
  }

  // ── the memory, through runSeedScan ─────────────────────────────────
  {
    const dir = join(tmp, 'memory');
    const boards = { 'ashby/zz-mem-live': [posting('Security Engineer', { description: 'security' })] };
    const companies = [co('zz-mem-live'), co('zz-mem-dead')];
    const mkState = (persist) => createSeedRunState({ deadPath: join(dir, 'data', 'seed-dead-boards.tsv'), livePath: join(dir, 'data', 'seed-live-boards.tsv'), persist, withKeySlot: createKeyedLimiter(6), sleep: async () => {} });

    const dry = await runSeeds(companies, boards, { state: mkState(false) });
    if (!existsSync(join(dir, 'data')) && dry.result.stats.probes > 0) pass('a dry-run state (persist:false) leaves no cache files behind');
    else fail('a dry run wrote the cache');

    const first = await runSeeds(companies, boards, { state: mkState(true) });
    if (existsSync(join(dir, 'data', 'seed-dead-boards.tsv')) && existsSync(join(dir, 'data', 'seed-live-boards.tsv'))
      && readFileSync(join(dir, 'data', 'seed-dead-boards.tsv'), 'utf8').includes('greenhouse\tzz-mem-dead\t1')) pass('a real run persists what it learned when the scan finishes');
    else fail('a real run did not persist the cache');

    const log2 = [];
    const second = await runSeeds(companies, boards, { state: mkState(true), log: log2 });
    if (eq(log2, ['ashby/zz-mem-live']) && second.result.stats.cachedSkips === 3 && second.result.stats.live === 1) {
      pass('the next run asks only about the live board: 1 request instead of 6, three remembered 404s skipped');
    } else {
      fail(`second run: ${log2.join(',')} skips ${second.result.stats.cachedSkips}`);
    }
    void first;
  }

  // ── flag parsing ────────────────────────────────────────────────────
  {
    const a = parseArgs(['node', 'scan-ats-full.mjs', '--seeds', 'yc,a16z', '--refresh-seed-cache']);
    const b = parseArgs(['node', 'scan-ats-full.mjs', '--seeds', 'yc']);
    if (a.refreshSeedCache === true && b.refreshSeedCache === false && eq(a.seeds, ['yc', 'a16z']) && eq(a.ats, [])) pass('--refresh-seed-cache parses, defaults off, and --seeds alone still scans no ATS directory');
    else fail(`parseArgs: ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }
} finally {
  console.error = realWarn;
  YC.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
}

// ── Part 2: the whole CLI, against a stubbed fetch ───────────────────

const nowIso = new Date().toISOString();
const ashbyBody = (slug, titles) => ({
  jobs: titles.map((t, i) => ({
    id: `${slug}-${i}`, title: t, jobUrl: `https://jobs.ashbyhq.com/${slug}/${slug}-${i}`, publishedAt: nowIso,
    location: 'Remote', isRemote: true, descriptionPlain: 'security engineering work',
  })),
});
const greenhouseBody = (slug, titles) => ({
  jobs: titles.map((t, i) => ({
    id: i + 1, title: t, absolute_url: `https://job-boards.greenhouse.io/${slug}/jobs/${i + 1}`, first_published: nowIso,
    location: { name: 'Remote' }, content: 'security engineering work',
  })),
});
const leverBody = (slug, titles) => titles.map((t, i) => ({
  id: `${slug}-${i}`, text: t, hostedUrl: `https://jobs.lever.co/${slug}/${slug}-${i}`, createdAt: Date.now(),
  categories: { location: 'Remote' }, descriptionPlain: 'security engineering work',
}));

const ycCompany = (slug, name = slug) => ({ id: 1, name, slug, website: '', batch: 'W20', status: 'Active', badges: [] });
const ycPage = (page, totalPages, companies) => ({ companies, page, totalPages });

/** Route table: first entry whose `match` is in the URL wins; anything else is a 404. */
function routesForPortfolio({ page2 = 'ok', throttleLever = false } = {}) {
  const r = [];
  const add = (match, status, body, headers = {}) => r.push({ match, status, body, headers });
  add('api.ycombinator.com/v0.1/companies?page=1&', 200, ycPage(1, 2, [
    ycCompany('e2e-acme', 'E2E Acme'), ycCompany('e2e-foo', 'E2E Foo'), ycCompany('e2e-bar', 'E2E Bar'),
    ycCompany('e2e-blocked', 'Blocked Co'), ycCompany('e2e-dead1'), ycCompany('e2e-dead2'), ycCompany('e2e-dead3'),
  ]));
  if (page2 === 'ok') add('api.ycombinator.com/v0.1/companies?page=2&', 200, ycPage(2, 2, [ycCompany('e2e-dead4')]));
  else add('api.ycombinator.com/v0.1/companies?page=2&', 404, { error: 'gone' });
  add('api.ashbyhq.com/posting-api/job-board/e2e-acme?', 200, ashbyBody('e2e-acme', ['Security Engineer', 'Pastry Chef']));
  add('api.ashbyhq.com/posting-api/job-board/e2e-blocked?', 200, ashbyBody('e2e-blocked', ['Security Engineer']));
  add('boards-api.greenhouse.io/v1/boards/e2e-foo/', 200, greenhouseBody('e2e-foo', ['Security Engineer']));
  add('api.lever.co/v0/postings/e2e-bar', 200, leverBody('e2e-bar', ['Security Engineer']));
  if (throttleLever) add('api.lever.co/', 429, { error: 'slow down' }, { 'retry-after': '0' });
  return r;
}

// A CommonJS preload (-r) rather than a wrapper that imports the scanner: the scanner then
// runs as the real entry point, and the stub is in place before its first request.
const STUB = `
const { readFileSync, appendFileSync } = require('node:fs');
const routes = JSON.parse(readFileSync(process.env.STUB_ROUTES, 'utf8'));
globalThis.fetch = async (url) => {
  const u = String(url);
  appendFileSync(process.env.STUB_LOG, u + '\\n');
  const hit = routes.find((r) => u.includes(r.match));
  const status = hit ? hit.status : 404;
  const body = hit ? hit.body : { error: 'not found' };
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(hit ? hit.headers : {}) } });
};
`;

function sandbox(routes, { blacklist = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-seeds-e2e-'));
  writeFileSync(join(dir, 'portals.yml'), 'title_filter:\n  positive:\n    - security engineer\n  negative:\n    - intern\n', 'utf8');
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n## Pendientes\n', 'utf8');
  if (blacklist) writeFileSync(join(dir, 'data', 'blacklist.md'), '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Blocked Co | 2026-01-01 | company | e2e |\n', 'utf8');
  writeFileSync(join(dir, 'stub-fetch.cjs'), STUB, 'utf8');
  writeFileSync(join(dir, 'routes.json'), JSON.stringify(routes), 'utf8');
  writeFileSync(join(dir, 'requests.log'), '', 'utf8');
  return dir;
}

function cli(dir, args, { routes } = {}) {
  if (routes) writeFileSync(join(dir, 'routes.json'), JSON.stringify(routes), 'utf8');
  writeFileSync(join(dir, 'requests.log'), '', 'utf8');
  const r = spawnSync(NODE, ['-r', join(dir, 'stub-fetch.cjs'), join(ROOT, 'scan-ats-full.mjs'), ...args], {
    cwd: dir, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_DATA_DIR: '', CAREER_OPS_DNS_LOOKUPS_PER_MIN: '0', STUB_ROUTES: join(dir, 'routes.json'), STUB_LOG: join(dir, 'requests.log') },
  });
  const requests = readFileSync(join(dir, 'requests.log'), 'utf8').split('\n').filter(Boolean);
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', requests };
}
const count = (reqs, needle) => reqs.filter((u) => u.includes(needle)).length;
const fileIn = (dir, rel) => join(dir, ...rel.split('/'));

{
  const throttled = routesForPortfolio({ throttleLever: true });
  // 24 companies, none with a board anywhere but Lever's refusal: only the host's behaviour is under test.
  throttled[0] = { match: 'api.ycombinator.com/v0.1/companies?page=1&', status: 200, body: ycPage(1, 1, Array.from({ length: 24 }, (_, i) => ycCompany(`e2e-thr${i}`))), headers: {} };
  const dir = sandbox(routesForPortfolio({ page2: '404' }));
  const dir2 = sandbox(throttled);
  const dir3 = sandbox(routesForPortfolio());
  try {
    // ── a real run ────────────────────────────────────────────────────
    const r1 = cli(dir, ['--seeds', 'yc', '--since', '10']);
    const out = r1.stdout;
    if (r1.code === 0) pass('the CLI run exits 0');
    else fail(`CLI exit ${r1.code}\n${r1.stderr.slice(-600)}`);

    const pipeline = readFileSync(fileIn(dir, 'data/pipeline.md'), 'utf8');
    if (/E2E Acme/.test(pipeline) && /E2E Foo/.test(pipeline) && /E2E Bar/.test(pipeline) && !/Pastry Chef/.test(pipeline) && !/Blocked Co/.test(pipeline)) {
      pass('postings found on Ashby, Greenhouse and Lever all reach the pipeline; the non-matching title and the blacklisted company do not');
    } else {
      fail(`pipeline:\n${pipeline}`);
    }
    if (/Blacklisted:\s+1 skipped/.test(out)) pass('the blacklist still applies to seed offers and is reported');
    else fail(`blacklist line missing:\n${out.slice(-900)}`);

    // 6 companies, 3 live: unreachable = 3 dead x3 vendors + blocked...: compute from the stub
    // acme: ashby live -> 0 failures. foo: ashby 404, gh live -> 1. bar: ashby 404, gh 404, lever live -> 2.
    // blocked: ashby live -> 0. dead1..3: 3 each = 9. (page 2 is gone, so e2e-dead4 is never listed.) Total 12.
    if (/Unreachable boards: 12\b/.test(out) && /seed boards:\s+404 12 \| 403 0 \| 429 0 \| 5xx 0 \| timeout\/network 0 \| other 0/.test(out)) {
      pass('the summary block splits "Unreachable boards" by cause: 404 x12, everything else 0');
    } else {
      fail(`unreachable breakdown:\n${out.slice(out.indexOf('Reverse ATS Scan') - 60)}`);
    }
    if (/Seed yc:\s+7 companies \| 4 live \(ashby 2 \/ greenhouse 1 \/ lever 1\), 0 empty, 3 dead, 0 unknown \| 16 probes, 0 remembered-dead skipped/.test(out)) {
      pass('the Seed yc line reports companies, live per vendor, dead, unknown and probes');
    } else {
      fail(`Seed yc line:\n${out.slice(out.indexOf('Seed yc') - 10, out.indexOf('Seed yc') + 300)}`);
    }
    if (/⚠️\s+Seed yc: YC walk skipped 1 page: 2 \(HTTP 404\)/.test(out) && /YC walk skipped 1 page: 2 \(HTTP 404\)/.test(r1.stderr)) {
      pass('the truncated YC walk is a warning in the log AND repeated inside the scan-summary block');
    } else {
      fail(`YC warning:\n${out.slice(-700)}\n--stderr--\n${r1.stderr.slice(-400)}`);
    }
    const marker = out.indexOf('::career-ops:scan-summary::');
    if (marker >= 0 && out.indexOf('seed boards:') > marker && out.indexOf('Seed yc:') > marker && out.indexOf('Seed yc: YC walk') > marker) pass('the seed lines sit below the ::career-ops:scan-summary:: marker, where stage 2 reads');
    else fail('seed lines are outside the summary block');

    const deadFile = readFileSync(fileIn(dir, 'data/seed-dead-boards.tsv'), 'utf8');
    const liveFile = readFileSync(fileIn(dir, 'data/seed-live-boards.tsv'), 'utf8');
    if (/ashby\te2e-dead1\t1\t/.test(deadFile) && /lever\te2e-dead3\t1\t/.test(deadFile) && /yc\te2e-bar\tlever\te2e-bar\t/.test(liveFile) && /yc\te2e-acme\tashby\te2e-acme\t/.test(liveFile)) {
      pass('the 404s and the vendor each live company resolved to are written to data/seed-dead-boards.tsv and data/seed-live-boards.tsv');
    } else {
      fail(`cache files:\n${deadFile}\n${liveFile}`);
    }
    // (Greenhouse's own provider also asks a live board for /offices when its locations are bare work models, so board
    // probes are counted by the /jobs endpoint.)
    const ghJobs = (reqs) => reqs.filter((u) => u.includes('boards-api.greenhouse.io') && u.includes('/jobs')).length;
    if (count(r1.requests, 'api.ashbyhq.com') === 7 && ghJobs(r1.requests) === 5 && count(r1.requests, 'api.lever.co') === 4) {
      pass('first run request count: Ashby asked for all 7 companies, Greenhouse for the 5 not found there, Lever for the 4 not found on either');
    } else {
      fail(`first run requests: ashby ${count(r1.requests, 'api.ashbyhq.com')} gh ${ghJobs(r1.requests)} lever ${count(r1.requests, 'api.lever.co')}`);
    }

    // ── the second run is cheap ───────────────────────────────────────
    const r2 = cli(dir, ['--seeds', 'yc', '--since', '10']);
    const deadReq = r2.requests.filter((u) => /e2e-dead\d/.test(u)).length;
    const liveReq = r2.requests.filter((u) => /e2e-(acme|foo|bar|blocked)/.test(u) && !u.includes('/offices')).length;
    if (r2.code === 0 && deadReq === 0 && liveReq === 4 && /Nothing new/.test(r2.stdout) && /remembered-dead skipped/.test(r2.stdout)) {
      pass('second run: the 3 dead companies cost 0 requests (their 404s are remembered), each live board 1, and nothing is added twice');
    } else {
      fail(`second run: exit ${r2.code}, dead requests ${deadReq}, live requests ${liveReq}\n${r2.stdout.slice(-500)}`);
    }

    // ── --refresh-seed-cache bypasses it ──────────────────────────────
    const r3 = cli(dir, ['--seeds', 'yc', '--since', '10', '--refresh-seed-cache']);
    const refreshedDead = r3.requests.filter((u) => /e2e-dead\d/.test(u)).length;
    if (r3.code === 0 && refreshedDead === 9 && /seed cache refresh/.test(r3.stdout)) pass('--refresh-seed-cache re-asks every candidate (9 requests for the 3 dead companies) and says so in the banner');
    else fail(`refresh run: exit ${r3.code}, dead requests ${refreshedDead}`);

    // ── --json carries the same breakdown ─────────────────────────────
    const r4 = cli(dir, ['--seeds', 'yc', '--since', '10', '--json']);
    let json = null;
    try { json = JSON.parse(r4.stdout); } catch { /* reported below */ }
    const sy = json?.seeds?.yc;
    if (sy && sy.companies === 7 && sy.live === 4 && sy.dead === 3 && sy.unreachable && sy.unreachable['404'] === 0 && Array.isArray(sy.warnings) && sy.warnings.length === 1
      && sy.cachedSkips === 9 && sy.byVendor.ashby === 2 && json.unreachableBoards === 0) {
      pass('--json carries seeds.yc with the live/dead split, per-class unreachable counts, cached skips and warnings; stdout is still one JSON object');
    } else {
      fail(`--json: ${r4.stdout.slice(0, 500)}`);
    }

    // ── --dry-run writes nothing ──────────────────────────────────────
    const before = readdirSync(fileIn(dir3, 'data')).sort();
    const pipelineBefore = readFileSync(fileIn(dir3, 'data/pipeline.md'), 'utf8');
    const d = cli(dir3, ['--seeds', 'yc,yc', '--since', '10', '--dry-run']);
    const after = readdirSync(fileIn(dir3, 'data')).sort();
    if (d.code === 0 && eq(before, after) && readFileSync(fileIn(dir3, 'data/pipeline.md'), 'utf8') === pipelineBefore
      && !existsSync(fileIn(dir3, 'data/seed-dead-boards.tsv')) && !existsSync(fileIn(dir3, 'data/seed-live-boards.tsv')) && !existsSync(fileIn(dir3, 'data/scan-history.tsv'))
      && /DRY RUN/.test(d.stdout) && /dry run/.test(d.stdout) && /4 live/.test(d.stdout)) {
      pass('--dry-run probes and reports exactly like a real run but writes nothing: no cache files, no pipeline, no scan history');
    } else {
      fail(`dry run: exit ${d.code}, files ${before.join(',')} -> ${after.join(',')}\n${d.stdout.slice(-400)}`);
    }

    // ── a whole portfolio that cannot be fetched ──────────────────────
    const broken = routesForPortfolio();
    broken[0] = { match: 'api.ycombinator.com/v0.1/companies?page=1&', status: 404, body: { error: 'gone' }, headers: {} };
    const dirBroken = sandbox(broken);
    try {
      const b = cli(dirBroken, ['--seeds', 'yc,a16z', '--since', '10']);
      // a16z answers 404 from the stub too: both fail, both still get a summary line.
      if (b.code === 0 && /✗ FAILED — no portfolio to probe \(vc-portfolios: YC API fetch failed — HTTP 404/.test(b.stdout + b.stderr)
        && /Seed yc:\s+FAILED — vc-portfolios: YC API fetch failed/.test(b.stdout) && /Seed a16z:\s+FAILED/.test(b.stdout)) {
        pass('a portfolio that cannot be fetched still prints a done line and a summary line per seed (it used to print nothing), exit 0');
      } else {
        fail(`broken portfolio: exit ${b.code}\n${b.stdout.slice(-700)}`);
      }
      const bj = cli(dirBroken, ['--seeds', 'yc', '--json']);
      let parsed = null;
      try { parsed = JSON.parse(bj.stdout); } catch { /* below */ }
      if (parsed?.seeds?.yc?.fetchFailed === true && /HTTP 404/.test(parsed.seeds.yc.failure)) pass('--json reports seeds.yc.fetchFailed with the reason');
      else fail(`broken --json: ${bj.stdout.slice(0, 300)}`);
    } finally {
      rmSync(dirBroken, { recursive: true, force: true });
    }

    // ── a host that refuses everything is abandoned, and the run still ends cleanly ──
    const t = cli(dir2, ['--seeds', 'yc', '--since', '10']);
    if (t.code === 0 && /⛔ api\.lever\.co answered 429 10 times in a row/.test(t.stderr + t.stdout) && /api\.lever\.co kept refusing \(429\/403\) and was abandoned/.test(t.stdout)
      && /seed boards:\s+404 \d+ \| 403 0 \| 429 1[0-5] \|/.test(t.stdout)) {
      pass('a host answering 429 to everything is abandoned after 10 in a row: a loud line when it happens, a warning in the summary block, exit 0');
    } else {
      fail(`throttled host: exit ${t.code}\n${t.stdout.slice(-900)}\n--stderr--\n${t.stderr.slice(-500)}`);
    }
    const leverReqs = count(t.requests, 'api.lever.co');
    if (leverReqs <= 14 && !existsSync(fileIn(dir2, 'data/seed-dead-boards.tsv')) === false && !/lever\te2e-thr/.test(readFileSync(fileIn(dir2, 'data/seed-dead-boards.tsv'), 'utf8'))) {
      pass(`Lever saw ${leverReqs} requests instead of 24, and the refused boards were not recorded as dead`);
    } else {
      fail(`throttled host: ${leverReqs} lever requests`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
    rmSync(dir3, { recursive: true, force: true });
  }
}
