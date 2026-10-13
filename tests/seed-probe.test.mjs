// tests/seed-probe.test.mjs — finding a portfolio company's board, and what the
// scan remembers about it between runs (seeds/seed-probe.mjs).
//
// All stubbed: providers are the real detect() with a scripted fetch(), the
// clock and sleep are fakes, and the cache lives in a temp directory.

import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, rmSync, ROOT } from './helpers.mjs';

console.log('\nseed probe — first board wins, 404s are remembered, hosts are paced');

const href = (rel) => pathToFileURL(join(ROOT, rel)).href;
const probe = await import(href('seeds/seed-probe.mjs'));
const { createKeyedLimiter } = await import(href('scan-ats-full.mjs'));
const { recordBoardResult } = await import(href('dead-boards.mjs'));
const greenhouse = (await import(href('providers/greenhouse.mjs'))).default;
const ashby = (await import(href('providers/ashby.mjs'))).default;
const lever = (await import(href('providers/lever.mjs'))).default;
const {
  classifyProbeError, createHostGate, createSeedRunState, deadRecheckDays, emptyUnreachable, formatUnreachable,
  hash01, loadLiveBoards, newSeedStats, observeCtx, probeSeedCompany, resolveSeedGapMs, saveSeedState,
  shouldProbeBoard, unreachableTotal, SEED_DEAD_TTL_DAYS, SEED_HOST_GAP_MS,
} = probe;

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-13T12:00:00Z');
const noSleep = async () => {};
const httpErr = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
const job = (n) => ({ title: `Role ${n}`, url: `https://example.test/${n}`, company: 'x' });

/**
 * Real detect(), scripted fetch(): `boards` maps "vendor/slug" to an array of
 * jobs, an HTTP status, 'net' (a timeout) or a function. Anything unlisted is 404.
 * Every fetch is appended to `log` as "vendor/slug".
 */
function providersFor(boards, log = []) {
  const mk = (real, vendor, slugOf) => ({
    ...real,
    async fetch(entry) {
      const slug = slugOf(entry.careers_url);
      log.push(`${vendor}/${slug}`);
      const v = boards[`${vendor}/${slug}`];
      if (typeof v === 'function') return v(entry);
      if (Array.isArray(v)) return v;
      if (v === 'net') throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      throw httpErr(typeof v === 'number' ? v : 404);
    },
  });
  const last = (u) => new URL(u).pathname.split('/').filter(Boolean)[0];
  return {
    greenhouse: mk(greenhouse, 'greenhouse', last),
    ashby: mk(ashby, 'ashby', last),
    lever: mk(lever, 'lever', last),
  };
}

function makeState(dir, over = {}) {
  let clock = over.clock ?? T0;
  const state = createSeedRunState({
    deadPath: join(dir, 'data', 'seed-dead-boards.tsv'),
    livePath: join(dir, 'data', 'seed-live-boards.tsv'),
    withKeySlot: createKeyedLimiter(6),
    sleep: noSleep,
    now: () => clock,
    ...over.state,
  });
  state.advance = (ms) => { clock += ms; };
  state.clock = () => clock;
  return state;
}

const company = (slug, extra = {}) => ({ name: slug.toUpperCase(), slug, url: '', source: 'yc', ...extra });

async function probeOne(co, boards, { state, vendors, log = [], stats = newSeedStats('yc') } = {}) {
  const providers = providersFor(boards, log);
  const result = await probeSeedCompany(co, { seedId: 'yc', providers, ctx: {}, state, stats, vendors });
  return { result, stats, log };
}

const dir = mkdtempSync(join(tmpdir(), 'career-ops-seed-probe-'));
try {
  // ── classification ──────────────────────────────────────────────────
  {
    const cases = [
      [httpErr(404), '404'], [httpErr(403), '403'], [httpErr(429), '429'], [httpErr(500), '5xx'], [httpErr(503), '5xx'], [httpErr(599), '5xx'],
      [httpErr(400), 'other'], [httpErr(401), 'other'], [httpErr(410), 'other'], [httpErr(301), 'other'],
      [Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), 'network'],
      [Object.assign(new Error('x'), { name: 'TimeoutError' }), 'network'],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'network'],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), 'network'],
      [Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }), 'network'],
      [new Error('greenhouse: request timed out after 10s'), 'network'],
      [Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }), 'other'],
      [new SyntaxError('Unexpected token < in JSON at position 0'), 'other'],
      [new Error('ashby: untrusted hostname "evil"'), 'other'],
      [null, 'other'], [undefined, 'other'], ['a string', 'other'],
    ];
    const bad = cases.filter(([err, want]) => classifyProbeError(err) !== want).map(([err, want]) => `${err?.message ?? err} -> ${classifyProbeError(err)} (want ${want})`);
    if (bad.length === 0) pass('classifyProbeError separates 404 / 403 / 429 / 5xx / timeout+network / other');
    else fail(`classification: ${JSON.stringify(bad)}`);

    const u = emptyUnreachable();
    u['404'] = 5812; u['5xx'] = 1; u.network = 2;
    if (formatUnreachable(u) === '404 5,812 | 403 0 | 429 0 | 5xx 1 | timeout/network 2 | other 0' && unreachableTotal(u) === 5815) {
      pass('formatUnreachable prints every class (zeros included) in a fixed order, and unreachableTotal sums them');
    } else {
      fail(`formatUnreachable: ${formatUnreachable(u)} / ${unreachableTotal(u)}`);
    }
  }

  // ── multi-vendor probing ────────────────────────────────────────────
  {
    // The brief's case: Greenhouse says 404, Ashby has the board.
    const state = makeState(dir);
    const { result, stats, log } = await probeOne(company('posthog'), { 'ashby/posthog': [job(1), job(2)] }, { state, vendors: ['greenhouse', 'ashby', 'lever'] });
    if (result.outcome === 'live' && result.board.vendor === 'ashby' && result.board.jobs.length === 2 && log.join(',') === 'greenhouse/posthog,ashby/posthog'
      && stats.unreachable['404'] === 1 && stats.probes === 2) {
      pass('Greenhouse 404 -> Ashby live: the Ashby board is found, Lever is never asked, the one 404 is counted');
    } else {
      fail(`gh404->ashby: ${JSON.stringify({ outcome: result.outcome, log, unreachable: stats.unreachable })}`);
    }
  }
  {
    // Default order asks Ashby first, so a company on Ashby costs ONE request.
    const state = makeState(dir);
    const { result, log } = await probeOne(company('posthog'), { 'ashby/posthog': [job(1)], 'greenhouse/posthog': [job(2)] }, { state });
    if (result.board.vendor === 'ashby' && log.join(',') === 'ashby/posthog') pass('first board with postings wins: with Ashby and Greenhouse both live, only Ashby is fetched');
    else fail(`first-hit-wins: ${log.join(',')}`);
  }
  {
    // Nothing anywhere.
    const state = makeState(dir);
    const { result, stats, log } = await probeOne(company('ghost'), {}, { state });
    if (result.outcome === 'dead' && result.board === null && log.length === 3 && stats.unreachable['404'] === 3 && unreachableTotal(stats.unreachable) === 3) {
      pass('all three vendors 404: the company is dead, with three 404s counted and nothing else');
    } else {
      fail(`all dead: ${JSON.stringify({ outcome: result.outcome, log, u: stats.unreachable })}`);
    }
    // ...and asking again costs nothing.
    const again = await probeOne(company('ghost'), {}, { state });
    if (again.result.outcome === 'dead' && again.log.length === 0 && again.stats.cachedSkips === 3 && again.stats.probes === 0 && unreachableTotal(again.stats.unreachable) === 0) {
      pass('the same company again in the same run: three remembered 404s are skipped, no request is made');
    } else {
      fail(`all dead, second pass: ${JSON.stringify({ log: again.log, skips: again.stats.cachedSkips })}`);
    }
  }
  {
    // One vendor throttles: unknown, not dead, and not remembered as dead.
    const state = makeState(dir);
    const { result, stats } = await probeOne(company('throttled'), { 'ashby/throttled': 429 }, { state });
    if (result.outcome === 'unknown' && stats.unreachable['429'] === 1 && stats.unreachable['404'] === 2) {
      pass('one vendor answering 429 leaves the company unknown (not dead), and the 429 is counted apart from the 404s');
    } else {
      fail(`one 429: ${JSON.stringify({ outcome: result.outcome, u: stats.unreachable })}`);
    }
    const cache = state.cache;
    if (!cache.dead.has('ashby\tthrottled') && cache.dead.has('greenhouse\tthrottled') && cache.dead.has('lever\tthrottled')) {
      pass('a 429 is not remembered as dead; the 404s beside it are');
    } else {
      fail(`dead rows after a 429: ${[...cache.dead.keys()].join(' | ')}`);
    }
    const again = await probeOne(company('throttled'), { 'ashby/throttled': [job(9)] }, { state });
    if (again.result.outcome === 'live' && again.log.join(',') === 'ashby/throttled') pass('next run the throttled vendor is asked again (and the 404s are not)');
    else fail(`after 429: ${again.log.join(',')}`);

    // A throttle on one vendor does not stop another vendor from answering.
    const s2 = makeState(dir);
    const r2 = await probeOne(company('mixed'), { 'ashby/mixed': 429, 'greenhouse/mixed': [job(1)] }, { state: s2 });
    if (r2.result.outcome === 'live' && r2.result.board.vendor === 'greenhouse') pass('Ashby 429 then Greenhouse live: the company is still found');
    else fail(`429 then live: ${r2.result.outcome}`);
  }
  {
    // Timeouts and 5xx are unknown too, and classified.
    const state = makeState(dir);
    const { result, stats } = await probeOne(company('flaky'), { 'ashby/flaky': 'net', 'greenhouse/flaky': 502, 'lever/flaky': 403 }, { state });
    const u = stats.unreachable;
    if (result.outcome === 'unknown' && u.network === 1 && u['5xx'] === 1 && u['403'] === 1 && u['404'] === 0 && state.cache.dead.size === 0) {
      pass('timeout, 502 and 403 are each classified, leave the company unknown, and are never remembered as dead');
    } else {
      fail(`flaky: ${JSON.stringify({ outcome: result.outcome, u, dead: state.cache.dead.size })}`);
    }
  }
  {
    // A board that answers with nothing open is live but not final.
    const state = makeState(dir);
    const a = await probeOne(company('moved'), { 'ashby/moved': [], 'greenhouse/moved': [job(1)] }, { state });
    if (a.result.outcome === 'live' && a.result.board.vendor === 'greenhouse' && a.log.join(',') === 'ashby/moved,greenhouse/moved') {
      pass('an empty Ashby board does not end the search: the Greenhouse board with postings is used');
    } else {
      fail(`empty then live: ${a.result.outcome} ${a.log.join(',')}`);
    }
    const b = await probeOne(company('quiet'), { 'lever/quiet': [] }, { state });
    if (b.result.outcome === 'empty' && b.result.board === null && state.cache.live.get('yc\tquiet')?.vendor === 'lever' && !state.cache.dead.has('lever\tquiet')) {
      pass('a company whose only board is empty is "empty": remembered as live on that vendor, never as dead');
    } else {
      fail(`only empty: ${b.result.outcome}`);
    }
  }
  {
    // A board two companies lead to is scanned once.
    const state = makeState(dir);
    const first = await probeOne(company('shared-a'), { 'ashby/shared': [job(1)] }, { state, log: [] });
    // second company whose candidate IS ashby/shared
    const second = await probeOne(company('shared'), { 'ashby/shared': [job(1)] }, { state });
    state.liveBoards.add('ashby/shared');
    const third = await probeOne(company('shared'), { 'ashby/shared': [job(1)] }, { state });
    if (first.result.outcome === 'dead' && second.result.outcome === 'live' && third.result.outcome === 'duplicate' && third.log.length === 0) {
      pass('a board already covered this run is reported as a duplicate and not fetched again');
    } else {
      fail(`duplicate board: ${first.result.outcome}/${second.result.outcome}/${third.result.outcome}`);
    }
  }
  {
    // A candidate the provider will not route is skipped, not fetched.
    const state = makeState(dir);
    const { result, stats, log } = await probeOne(company('embed'), { 'ashby/embed': [job(1)] }, { state, vendors: ['greenhouse', 'ashby'] });
    if (stats.undetectable === 1 && !log.includes('greenhouse/embed') && result.outcome === 'live') pass('the Greenhouse slug "embed" is counted undetectable and not fetched; Ashby is still tried');
    else fail(`undetectable: ${stats.undetectable} ${log.join(',')}`);
    const none = await probeOne({ name: 'No Slug', slug: '', url: '', source: 'yc' }, {}, { state });
    if (none.result.outcome === 'none' && none.log.length === 0) pass('a company with no usable slug is "none" and costs no request');
    else fail(`no slug: ${none.result.outcome}`);
  }

  // ── memory across runs ──────────────────────────────────────────────
  {
    const d = join(dir, 'persist');
    const s1 = makeState(d);
    await probeOne(company('onlever'), { 'lever/onlever': [job(1)] }, { state: s1 });
    await probeOne(company('nowhere'), {}, { state: s1 });
    const saved = saveSeedState(s1);
    const deadFile = readFileSync(join(d, 'data', 'seed-dead-boards.tsv'), 'utf8');
    const liveFile = readFileSync(join(d, 'data', 'seed-live-boards.tsv'), 'utf8');
    if (saved.saved && /^ats\tboard\tmisses\tlast_checked\n/.test(deadFile) && /^seed\tcompany\tvendor\tboard\tlast_seen\nyc\tonlever\tlever\tonlever\t2026-10-13T12:00:00\.000Z\n$/.test(liveFile)
      && deadFile.includes('ashby\tonlever\t1\t') && deadFile.includes('greenhouse\tnowhere\t1\t') && !existsSync(join(d, 'data', 'seed-dead-boards.tsv.tmp'))) {
      pass('the memory is saved as two small TSVs (dead boards in the dead-boards format, live hints beside them), atomically');
    } else {
      fail(`saved files:\n${deadFile}\n${liveFile}`);
    }

    // A new run: the live company goes straight to its vendor, the dead one costs nothing.
    const s2 = makeState(d, { clock: T0 + 7 * DAY });
    const r1 = await probeOne(company('onlever'), { 'lever/onlever': [job(1)] }, { state: s2 });
    const r2 = await probeOne(company('nowhere'), {}, { state: s2 });
    if (r1.log.join(',') === 'lever/onlever' && r1.result.outcome === 'live' && r2.log.length === 0 && r2.stats.cachedSkips === 3) {
      pass('next week: a live company is probed on the vendor it resolved to (1 request, not 3); a dead one is skipped outright');
    } else {
      fail(`next run: ${r1.log.join(',')} / ${r2.log.join(',')} skips ${r2.stats.cachedSkips}`);
    }

    // The remembered vendor is not an article of faith: when it 404s, the hint is dropped and the rest are
    // tried. The other vendors' 404s are still remembered at this point, so a move shows up as they age out.
    const sEarly = makeState(d, { clock: T0 + 8 * DAY });
    const early = await probeOne(company('onlever'), { 'ashby/onlever': [job(2)] }, { state: sEarly });
    if (early.result.outcome === 'dead' && early.log.join(',') === 'lever/onlever' && !sEarly.cache.live.has('yc\tonlever')) {
      pass('a remembered board that now 404s is retired (hint dropped); the other vendors\' 404s from last week still stand');
    } else {
      fail(`moved vendor, early: ${early.result.outcome} ${early.log.join(',')}`);
    }
    const s3 = makeState(d, { clock: T0 + 8 * DAY + 46 * DAY });
    const r3 = await probeOne(company('onlever'), { 'ashby/onlever': [job(2)] }, { state: s3 });
    if (r3.result.outcome === 'live' && r3.result.board.vendor === 'ashby' && r3.log.join(',') === 'lever/onlever,ashby/onlever'
      && s3.cache.live.get('yc\tonlever')?.vendor === 'ashby' && s3.cache.dead.has('lever\tonlever')) {
      pass('once the old 404s age out, a company that moved vendors is found on the new one (the stale hint is asked once, 404s, and is replaced)');
    } else {
      fail(`moved vendor: ${r3.log.join(',')} hint ${JSON.stringify(s3.cache.live.get('yc\tonlever'))}`);
    }

    // refresh ignores the memory but still records what it finds.
    const s4 = makeState(d, { clock: T0 + 9 * DAY, state: { refresh: true } });
    const r4 = await probeOne(company('nowhere'), {}, { state: s4 });
    const r5 = await probeOne(company('onlever'), { 'lever/onlever': [job(1)] }, { state: s4 });
    if (r4.log.length === 3 && r4.stats.cachedSkips === 0 && r5.log.join(',') === 'ashby/onlever,greenhouse/onlever,lever/onlever') {
      pass('--refresh-seed-cache: every candidate is asked about again and remembered hints are not followed');
    } else {
      fail(`refresh: ${r4.log.join(',')} / ${r5.log.join(',')}`);
    }
    if (s4.cache.dirty && s4.cache.dead.get('greenhouse\tnowhere').lastChecked === T0 + 9 * DAY) pass('a refresh run still records its results (the memory is rewritten, not discarded)');
    else fail('refresh did not record results');

    // A dry run reads the memory and never writes it.
    const dd = join(dir, 'dry');
    const writer = makeState(dd);
    await probeOne(company('nowhere'), {}, { state: writer });
    saveSeedState(writer);
    const snapshot = () => ['seed-dead-boards.tsv', 'seed-live-boards.tsv', 'seed-dead-boards.tsv.tmp', 'seed-live-boards.tsv.tmp']
      .map((f) => (existsSync(join(dd, 'data', f)) ? readFileSync(join(dd, 'data', f), 'utf8') : null));
    const before = snapshot();
    const dry = makeState(dd, { clock: T0 + 100 * DAY, state: { persist: false } });
    const dryRun = await probeOne(company('nowhere'), {}, { state: dry }); // due again: probed, recorded in memory only
    await probeOne(company('another'), {}, { state: dry });
    const res = saveSeedState(dry);
    if (dryRun.stats.probes === 3 && dry.cache.dirty && res.saved === false && JSON.stringify(snapshot()) === JSON.stringify(before)) {
      pass('persist:false (--dry-run) reads the memory (a due 404 is re-probed) but saveSeedState writes nothing, not even a tmp file');
    } else {
      fail(`a dry run touched the seed memory: probes ${dryRun.stats.probes}, saved ${res.saved}`);
    }
    const fresh = makeState(join(dir, 'never-written'), { state: { persist: true } });
    if (saveSeedState(fresh).saved === false && !existsSync(join(dir, 'never-written'))) pass('nothing changed -> nothing written, no directory created');
    else fail('an untouched state created files');

    // A cache the disk will not take costs resumability, never the run.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'a file where a directory should be');
    const bad = makeState(blocked);
    await probeOne(company('nowhere'), {}, { state: bad });
    const r = saveSeedState(bad);
    if (r.saved === false && typeof r.error === 'string' && r.error.length > 0) pass('a failing cache write is reported, not thrown');
    else fail(`unwritable cache: ${JSON.stringify(r)}`);

    // Hand-edited / corrupt rows are ignored on load.
    const cd = join(dir, 'corrupt', 'data');
    mkdirSync(cd, { recursive: true });
    writeFileSync(join(cd, 'seed-live-boards.tsv'), [
      'seed\tcompany\tvendor\tboard\tlast_seen',
      'yc\tgood\tashby\tgood\t2026-10-01T00:00:00.000Z',
      'yc\tbad-vendor\tworkday\tx\t2026-10-01T00:00:00.000Z',
      'yc\tbad/slug\tashby\tx\t2026-10-01T00:00:00.000Z',
      'yc\tbad-board\tashby\ta b\t2026-10-01T00:00:00.000Z',
      'yc\tbad-date\tashby\tx\tnot-a-date',
      'yc\tshort',
    ].join('\n'));
    const loaded = loadLiveBoards(join(cd, 'seed-live-boards.tsv'));
    if (loaded.size === 1 && loaded.has('yc\tgood')) pass('live-hint rows with an unknown vendor, unsafe slug, bad date or too few columns are ignored on load');
    else fail(`corrupt live rows: ${[...loaded.keys()].join(' | ')}`);
  }

  // ── when a remembered 404 comes due ─────────────────────────────────
  {
    // Spread: the window is 15..45 days for a first miss, never a single date.
    const slugs = Array.from({ length: 2000 }, (_, i) => `company-${i}`);
    const days = slugs.map((s) => deadRecheckDays('ashby', s, 1));
    const min = Math.min(...days);
    const max = Math.max(...days);
    const mean = days.reduce((a, b) => a + b, 0) / days.length;
    if (min >= SEED_DEAD_TTL_DAYS * 0.5 && max < SEED_DEAD_TTL_DAYS * 1.5 && Math.abs(mean - SEED_DEAD_TTL_DAYS) < 1.5 && new Set(days.map((d) => d.toFixed(3))).size > 1800) {
      pass(`a remembered 404 comes due 15-45 days later (mean ${mean.toFixed(1)}), each slug at its own point in that window`);
    } else {
      fail(`recheck window: min ${min} max ${max} mean ${mean}`);
    }
    if (deadRecheckDays('ashby', 'acme', 2) === 2 * deadRecheckDays('ashby', 'acme', 1) && deadRecheckDays('ashby', 'acme', 3) === 3 * deadRecheckDays('ashby', 'acme', 1)
      && deadRecheckDays('ashby', 'acme', 9) === deadRecheckDays('ashby', 'acme', 3) && deadRecheckDays('ashby', 'acme', 0) === deadRecheckDays('ashby', 'acme', 1)) {
      pass('a slug that keeps coming back 404 is trusted longer: 2x after the second, 3x from the third on (capped)');
    } else {
      fail('miss-count scaling wrong');
    }
    if (hash01('x') === hash01('x') && hash01('x') !== hash01('y') && hash01('') >= 0 && hash01('zzz') < 1) pass('the stagger is a stable function of the board, not random per run');
    else fail('hash01 unstable');

    // The rotating fraction a weekly scan re-asks.
    const dd = join(dir, 'ttl');
    const state = makeState(dd);
    // Record a 404 for each straight into the memory, as probing would.
    for (const s of slugs) recordBoardResult(state.cache.dead, 'ashby', s, 404, T0);
    const due = (afterDays) => slugs.filter((s) => shouldProbeBoard(state.cache, 'ashby', s, T0 + afterDays * DAY)).length / slugs.length;
    const f14 = due(14), f20 = due(20), f30 = due(30), f44 = due(44), f46 = due(46);
    if (f14 === 0 && f20 > 0.10 && f20 < 0.25 && f30 > 0.4 && f30 < 0.6 && f44 > 0.95 && f46 === 1) {
      pass(`week by week the re-probe set rotates: ${(f20 * 100).toFixed(0)}% due at day 20, ${(f30 * 100).toFixed(0)}% at day 30, all by day 45 — not every slug on the same day`);
    } else {
      fail(`due fractions: 14d ${f14}, 20d ${f20}, 30d ${f30}, 44d ${f44}, 46d ${f46}`);
    }
    // A fresh, unrecorded slug is always probed; refresh probes everything.
    const refreshCache = { ...state.cache, refresh: true };
    if (shouldProbeBoard(state.cache, 'ashby', 'never-seen', T0) && shouldProbeBoard(refreshCache, 'ashby', slugs[0], T0 + 1)) pass('an unrecorded slug is probed, and a refresh cache probes even a fresh 404');
    else fail('shouldProbeBoard defaults wrong');

    // Re-asking a due slug: still 404 -> misses 2, trusted twice as long; now live -> forgotten.
    const s5 = makeState(dd, { clock: T0 + 46 * DAY });
    s5.cache.dead = state.cache.dead;
    const slug = slugs[0];
    const before = s5.cache.dead.get(`ashby\t${slug}`).misses;
    await probeOne(company(slug), {}, { state: s5, vendors: ['ashby'] });
    const row = s5.cache.dead.get(`ashby\t${slug}`);
    if (before === 1 && row.misses === 2 && row.lastChecked === T0 + 46 * DAY && !shouldProbeBoard(s5.cache, 'ashby', slug, T0 + 46 * DAY + 20 * DAY)) {
      pass('a due 404 that is still a 404 goes to 2 misses and is trusted ~2x as long');
    } else {
      fail(`second miss: ${JSON.stringify(row)}`);
    }
    const slug2 = slugs[1];
    const s6 = makeState(dd, { clock: T0 + 46 * DAY });
    s6.cache.dead = state.cache.dead;
    await probeOne(company(slug2), { [`ashby/${slug2}`]: [job(1)] }, { state: s6, vendors: ['ashby'] });
    if (!s6.cache.dead.has(`ashby\t${slug2}`) && s6.cache.live.get(`yc\t${slug2}`)?.vendor === 'ashby') pass('a due slug that now has a board is found, and its 404 is forgotten');
    else fail('new board not picked up after re-probe');
  }

  // ── dead-boards.mjs: the policy options the seed scan relies on ─────
  {
    const { shouldSkipDeadBoard, DEAD_BOARD_MISSES, DEAD_BOARD_RECHECK_DAYS } = await import(href('dead-boards.mjs'));
    const rows = new Map();
    recordBoardResult(rows, 'ashby', 'acme', 404, T0);
    const at = (days, policy) => shouldSkipDeadBoard(rows, 'ashby', 'acme', T0 + days * DAY, policy);
    if (at(1) === false && at(1, { minMisses: 1 }) === true) pass('shouldSkipDeadBoard: one 404 retires nothing by default (3 are needed), but does when minMisses is 1');
    else fail('minMisses policy wrong');
    if (at(29, { minMisses: 1 }) === true && at(31, { minMisses: 1 }) === false && at(9, { minMisses: 1, recheckDays: 10 }) === true && at(11, { minMisses: 1, recheckDays: 10 }) === false) {
      pass('shouldSkipDeadBoard: recheckDays defaults to the 30-day window and can be set');
    } else {
      fail('recheckDays policy wrong');
    }
    const seen = [];
    shouldSkipDeadBoard(rows, 'ashby', 'acme', T0, { minMisses: 1, recheckDays: (row) => { seen.push(row); return 5; } });
    if (seen.length === 1 && seen[0].misses === 1 && seen[0].board === 'acme' && DEAD_BOARD_MISSES === 3 && DEAD_BOARD_RECHECK_DAYS === 30) {
      pass('shouldSkipDeadBoard: recheckDays may be a function of the row, and the sweep defaults (3 misses, 30 days) are unchanged');
    } else {
      fail(`row policy: ${JSON.stringify(seen)}`);
    }
    if (shouldSkipDeadBoard(rows, 'ashby', 'unknown', T0, { minMisses: 1 }) === false) pass('shouldSkipDeadBoard: a board with no record is never skipped');
    else fail('unrecorded board skipped');
  }

  // ── the host gate ───────────────────────────────────────────────────
  {
    // Concurrency: never more than the cap per host, but independent across hosts.
    const gate = createHostGate({ withKeySlot: createKeyedLimiter(6), sleep: noSleep });
    const inflight = { a: 0, b: 0, c: 0 };
    const peak = { a: 0, b: 0, c: 0 };
    let total = 0;
    let peakTotal = 0;
    const work = (host) => gate.run(host, async () => {
      inflight[host]++; total++;
      peak[host] = Math.max(peak[host], inflight[host]);
      peakTotal = Math.max(peakTotal, total);
      await new Promise((r) => setTimeout(r, 5));
      inflight[host]--; total--;
    });
    await Promise.all(['a', 'b', 'c'].flatMap((h) => Array.from({ length: 30 }, () => work(h))));
    if (peak.a === 6 && peak.b === 6 && peak.c === 6 && peakTotal <= 18 && peakTotal > 6) {
      pass('per-host cap: 30 requests to each of three hosts never exceed 6 in flight per host, and the hosts run side by side');
    } else {
      fail(`host cap: peaks ${JSON.stringify(peak)}, total peak ${peakTotal}`);
    }
  }
  {
    // Spacing: starts to one host are at least minGapMs apart; another host has its own schedule.
    const sleeps = [];
    const fakeNow = 1_000_000;
    const gate = createHostGate({ withKeySlot: createKeyedLimiter(6), sleep: async (ms) => { sleeps.push(ms); }, now: () => fakeNow, minGapMs: 50 });
    await Promise.all([...Array.from({ length: 5 }, () => gate.run('slow-host', async () => 'x')), gate.run('other-host', async () => 'y')]);
    if (sleeps.join(',') === '50,100,150,200') {
      pass('minGapMs spaces request starts to one host (the 2nd waits 50 ms, the 3rd 100 ms, ...); the first request and other hosts do not wait');
    } else {
      fail(`gap schedule: ${sleeps.join(',')}`);
    }
    const none = [];
    const g0 = createHostGate({ withKeySlot: createKeyedLimiter(6), sleep: async (ms) => { none.push(ms); }, now: () => fakeNow });
    await Promise.all(Array.from({ length: 5 }, () => g0.run('h', async () => 'x')));
    if (none.length === 0) pass('the gate adds no spacing unless asked to (minGapMs defaults to 0)');
    else fail(`unexpected spacing: ${none.join(',')}`);
    const cases = [[undefined, SEED_HOST_GAP_MS], ['', SEED_HOST_GAP_MS], ['0', 0], ['250', 250], ['-5', SEED_HOST_GAP_MS], ['abc', SEED_HOST_GAP_MS], ['1e9', SEED_HOST_GAP_MS], [null, SEED_HOST_GAP_MS]];
    const bad = cases.filter(([raw, want]) => resolveSeedGapMs(raw) !== want);
    if (bad.length === 0 && SEED_HOST_GAP_MS === 50) pass('CAREER_OPS_SEED_HOST_GAP_MS: 0 turns spacing off, a number sets it, junk falls back to the 50 ms default');
    else fail(`resolveSeedGapMs: ${JSON.stringify(bad)}`);
  }
  {
    // A 429 pauses the host, honouring Retry-After (clamped); a different host is untouched.
    const sleeps = [];
    let release;
    const gate = createHostGate({
      withKeySlot: createKeyedLimiter(1),
      sleep: (ms) => { sleeps.push(ms); return new Promise((r) => { release = r; }); },
      cooldownBaseMs: 1000, cooldownMaxMs: 8000,
    });
    const order = [];
    const first = gate.run('h', async () => { order.push('first'); throw httpErr(429, { retryAfter: '3' }); }).catch(() => order.push('first-failed'));
    const second = gate.run('h', async () => { order.push('second'); return 'ok'; });
    const other = await gate.run('other', async () => 'free');
    await new Promise((r) => setTimeout(r, 20));
    const heldWhilePaused = !order.includes('second');
    release();
    await Promise.all([first, second]);
    if (other === 'free' && heldWhilePaused && sleeps.join(',') === '3000' && order.join(',') === 'first,first-failed,second') {
      pass('a 429 holds every queued request to that host for the Retry-After (3s), and other hosts are not held');
    } else {
      fail(`pause: sleeps ${sleeps.join(',')}, order ${order.join(',')}, held ${heldWhilePaused}`);
    }

    const sleeps2 = [];
    const g2 = createHostGate({ withKeySlot: createKeyedLimiter(1), sleep: async (ms) => { sleeps2.push(ms); }, cooldownBaseMs: 1000, cooldownMaxMs: 8000, blockLimit: 99 });
    for (const retryAfter of [null, null, null, '86400']) await g2.run('h', async () => { throw httpErr(429, { retryAfter }); }).catch(() => {});
    if (sleeps2.join(',') === '1000,2000,4000,8000') pass('without Retry-After the pause doubles (1s, 2s, 4s) and any wait is capped (a day-long Retry-After becomes 8s here)');
    else fail(`backoff: ${sleeps2.join(',')}`);
  }
  {
    // Ten refusals in a row abandon the host; a 404 or success in between resets the count.
    const abandoned = [];
    const gate = createHostGate({ withKeySlot: createKeyedLimiter(1), sleep: noSleep, blockLimit: 5, onAbandon: (h, cls, n) => abandoned.push(`${h}:${cls}:${n}`) });
    const refuse = (status) => gate.run('h', async () => { throw httpErr(status); }).catch((e) => e);
    for (let i = 0; i < 4; i++) await refuse(429);
    await gate.run('h', async () => 'fine'); // resets
    for (let i = 0; i < 4; i++) await refuse(403);
    await refuse(404); // resets
    for (let i = 0; i < 4; i++) await refuse(429);
    if (!gate.isAbandoned('h') && abandoned.length === 0) pass('refusals must be consecutive: a success or a 404 in between resets the count');
    else fail(`abandoned too early: ${JSON.stringify(abandoned)}`);
    await refuse(429); // fifth in a row
    let called = false;
    const after = await gate.run('h', async () => { called = true; return 'x'; }).catch((e) => e);
    const free = await gate.run('elsewhere', async () => 'ok');
    if (gate.isAbandoned('h') && abandoned.join() === 'h:429:5' && called === false && after?.hostAbandoned === true && free === 'ok' && gate.abandonedHosts().join() === 'h') {
      pass('five consecutive 429/403 abandon the host for the run: no further request is made, the error says so, other hosts carry on');
    } else {
      fail(`abandon: ${JSON.stringify({ abandoned, called, after: after?.message, free })}`);
    }
    if (classifyProbeError(after) === 'other') pass('an abandoned-host error classifies as "other" (callers recognise it by .hostAbandoned)');
    else fail(`abandoned error classified ${classifyProbeError(after)}`);
  }
  {
    // 5xx and network failures neither count toward abandonment nor reset it.
    const gate = createHostGate({ withKeySlot: createKeyedLimiter(1), sleep: noSleep, blockLimit: 3 });
    const go = (err) => gate.run('h', async () => { throw err; }).catch(() => {});
    await go(httpErr(429)); await go(httpErr(500)); await go(Object.assign(new Error('x'), { name: 'AbortError' })); await go(httpErr(429));
    const notYet = !gate.isAbandoned('h');
    await go(httpErr(429));
    if (notYet && gate.isAbandoned('h')) pass('5xx and timeouts between refusals do not reset the count (three 429s with noise between still abandon the host)');
    else fail(`noise handling: notYet ${notYet}, abandoned ${gate.isAbandoned('h')}`);
  }
  {
    // probeSeedCompany + gate: an abandoned host's probes are skipped, not recorded as dead.
    const abandonedDir = join(dir, 'abandoned');
    const state = makeState(abandonedDir, { state: { blockLimit: 2 } });
    const boards = { 'lever/a': 429, 'lever/b': 429, 'lever/c': [job(1)], 'lever/d': [job(1)] };
    const stats = newSeedStats('yc');
    for (const s of ['a', 'b', 'c', 'd']) await probeOne(company(s), boards, { state, stats, vendors: ['lever'] });
    if (state.gate.isAbandoned('api.lever.co') && stats.skippedAbandoned === 2 && stats.unreachable['429'] === 2
      && !state.cache.dead.has('lever\tc') && !state.cache.dead.has('lever\td')) {
      pass('after the host is abandoned its remaining candidates are counted as skipped and are not remembered as dead');
    } else {
      fail(`abandoned probes: ${JSON.stringify({ skipped: stats.skippedAbandoned, u: stats.unreachable, hosts: state.gate.abandonedHosts() })}`);
    }
  }

  // ── request counting ────────────────────────────────────────────────
  {
    const stats = newSeedStats('yc');
    const base = {
      sinceMs: 123,
      syntheticEntries: true,
      fetchJson: async (url) => { if (url.endsWith('/429')) throw httpErr(429); if (url.endsWith('/boom')) throw new Error('boom'); return { url }; },
      fetchText: async () => 'text',
    };
    const ctx = observeCtx(base, stats);
    const ok = await ctx.fetchJson('https://x.test/a');
    await ctx.fetchJson('https://x.test/429').catch(() => {});
    await ctx.fetchJson('https://x.test/429').catch(() => {});
    const err = await ctx.fetchJson('https://x.test/boom').catch((e) => e);
    await ctx.fetchText('https://x.test/t');
    if (ok.url === 'https://x.test/a' && err.message === 'boom' && stats.requests === 5 && stats.throttledResponses === 2 && ctx.sinceMs === 123 && ctx.syntheticEntries === true && ctx.fetchResponse === undefined) {
      pass('observeCtx counts every request (retries included) and throttled responses, passes results and errors through, keeps the rest of the context');
    } else {
      fail(`observeCtx: ${JSON.stringify(stats)}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
