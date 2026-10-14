// @ts-check
/**
 * seeds/seed-probe.mjs — how the reverse-discovery seed scan finds a company's
 * board, and what it remembers between runs.
 *
 * A VC portfolio names companies, not boards. Each company has up to three
 * candidate boards (Greenhouse, Ashby, Lever) and the scan has to find which,
 * if any, answers — for ~6,300 YC companies and ~870 a16z ones, every week, on
 * three single-host APIs. This module is the part of that which is not the
 * posting filters:
 *
 *  - probeSeedCompany(): try a company's candidate boards in order, first board
 *    with postings wins, never the same company twice.
 *  - the memory (loadSeedCache): a 404 on (vendor, slug) is remembered, so the
 *    same ~6k dead slugs are not asked again next week; the vendor a live
 *    company resolved to is remembered, so it is asked first. Dead entries come
 *    back for a re-probe on a staggered schedule, so a company that opens a
 *    board later is still found, without a thundering herd on one day.
 *  - createHostGate(): a per-host concurrency cap that backs off when a host
 *    starts refusing, and gives up on it for the run rather than hammering.
 *  - classifyProbeError(): what kind of "unreachable" a failure was, because a
 *    404 (expected, almost all of them) and a 429 (act on it) are not the same.
 *
 * Network access is only through the providers and ctx handed in, so every
 * piece is unit-testable with stubs. Nothing here writes anywhere unless
 * saveSeedState() is called.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEAD_BOARD_RECHECK_DAYS,
  loadDeadBoards,
  recordBoardFailure,
  recordBoardResult,
  saveDeadBoards,
  shouldSkipDeadBoard,
} from '../dead-boards.mjs';
import { isRefusedRedirectError, parseRetryAfterMs } from '../providers/_http.mjs';
import { SEED_VENDOR_ORDER, SLUG_RE, VENDOR_BOARD_URL, toPortalCandidates } from './vc-portfolios.mjs';

// ── Failure classification ───────────────────────────────────────────

/** The kinds of unreachable board, in the order they are reported. */
export const PROBE_CLASSES = ['404', '403', '429', '5xx', 'network', 'other'];

const NETWORK_CODE_RE = /^(?:ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR|ABORT_ERR)/;
const NETWORK_MESSAGE_RE = /fetch failed|timed out|timeout|aborted|socket|network|ECONN|ENOTFOUND|EAI_AGAIN/i;

/**
 * What an unreachable board failed with.
 *
 * `404` is the board not being there, which is what nearly every guessed slug
 * gets; `403` and `429` are a host refusing us and are the ones to act on;
 * `network` is a timeout, abort or connection failure (nothing was learned
 * about the board); `other` is everything else — a 4xx that is neither of the
 * above, a refused redirect, a body that would not parse, a provider guard.
 *
 * @param {any} err
 * @returns {'404'|'403'|'429'|'5xx'|'network'|'other'}
 */
export function classifyProbeError(err) {
  const status = err?.status;
  if (typeof status === 'number') {
    if (status === 404) return '404';
    if (status === 403) return '403';
    if (status === 429) return '429';
    if (status >= 500) return '5xx';
    return 'other';
  }
  // A 3xx the SSRF guard refused is deterministic, and its message says
  // "fetch failed" like a dropped connection does.
  if (isRefusedRedirectError(err)) return 'other';
  if (!err) return 'other';
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'network';
  if (NETWORK_CODE_RE.test(String(err.code ?? err.cause?.code ?? ''))) return 'network';
  return NETWORK_MESSAGE_RE.test(String(err.message ?? '')) ? 'network' : 'other';
}

/** @returns {Record<string, number>} */
export function emptyUnreachable() {
  return Object.fromEntries(PROBE_CLASSES.map((c) => [c, 0]));
}

/**
 * "404 5812 | 403 0 | 429 0 | 5xx 1 | timeout/network 2 | other 0"
 * @param {Record<string, number>} unreachable
 */
export function formatUnreachable(unreachable) {
  return PROBE_CLASSES
    .map((c) => `${c === 'network' ? 'timeout/network' : c} ${(unreachable?.[c] ?? 0).toLocaleString('en-US')}`)
    .join(' | ');
}

/** @param {Record<string, number>} unreachable */
export function unreachableTotal(unreachable) {
  return PROBE_CLASSES.reduce((sum, c) => sum + (unreachable?.[c] ?? 0), 0);
}

// ── Run statistics ───────────────────────────────────────────────────

/**
 * Counters for one seed scan. Company-level outcomes sum to `companies`:
 * live + liveEmpty + dead + unknown + noCandidate + duplicate.
 *
 * @param {string} seedId
 */
export function newSeedStats(seedId) {
  return {
    seed: seedId,
    companies: 0,
    live: 0,          // a board answered with postings
    liveEmpty: 0,     // a board answered, with none open
    dead: 0,          // every candidate was 404 (just now, or remembered)
    unknown: 0,       // no board found, and at least one candidate failed for a reason that is not "no such board"
    noCandidate: 0,   // no usable slug
    duplicate: 0,     // resolved to a board another company already covered this run
    byVendor: /** @type {Record<string, number>} */ ({}),
    probes: 0,        // candidate boards actually asked about
    cachedSkips: 0,   // candidates not asked about, a remembered 404 being fresh enough
    undetectable: 0,
    skippedAbandoned: 0,
    requests: 0,      // HTTP requests issued, retries included
    throttledResponses: 0, // 403/429 responses seen, including ones a provider retried past
    unreachable: emptyUnreachable(),
    abandonedHosts: /** @type {string[]} */ ([]),
    fetchFailed: false,
    failure: /** @type {string | null} */ (null),
    truncated: false,
    warnings: /** @type {string[]} */ ([]),
    matches: 0,
    // Postings the quality gates removed (scan-ats-full.mjs: skip_tiers, country
    // eligibility, visa, and the company+title duplicate check).
    gated: { tier: 0, country: 0, visa: 0, duplicateRole: 0 },
  };
}

/**
 * Wrap a transport context so each HTTP request is counted. A provider that
 * retries internally (ashby) calls the context once per attempt, so this is the
 * real request count and sees a 429 that a retry later got past.
 *
 * @param {any} ctx
 * @param {ReturnType<typeof newSeedStats>} stats
 */
export function observeCtx(ctx, stats) {
  const wrapped = { ...ctx };
  for (const method of ['fetchJson', 'fetchText', 'fetchResponse']) {
    if (typeof ctx?.[method] !== 'function') continue;
    wrapped[method] = async (/** @type {string} */ url, /** @type {any} */ opts) => {
      stats.requests++;
      try {
        return await ctx[method](url, opts);
      } catch (err) {
        const status = /** @type {any} */ (err)?.status;
        if (status === 429 || status === 403) stats.throttledResponses++;
        throw err;
      }
    };
  }
  return wrapped;
}

// ── Per-host gate ────────────────────────────────────────────────────

/** @param {string} host */
function hostAbandonedError(host) {
  const err = /** @type {any} */ (new Error(`${host}: abandoned for this run after repeated refusals`));
  err.hostAbandoned = true;
  return err;
}

const defaultSleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One concurrency cap per API host, and a way to stop asking a host that has
 * started refusing.
 *
 * `minGapMs` spaces the START of consecutive requests to one host. A 404 comes
 * back in ~50-100 ms, so six in flight is 60+ requests a second at a single API;
 * the gap turns the first run's ~6k-probes-per-host burst into a steady trickle.
 *
 * A 429 or 403 pauses every queued request to that host (the retry-after the
 * host sent, else an exponential 15s..120s), and `blockLimit` of them in a row
 * abandons the host for the rest of the run: its remaining candidates are
 * reported as skipped, and — not being a 404 — are not remembered as dead, so
 * the next run asks again. A 404 or a success resets the count; 5xx and
 * network failures leave it alone.
 *
 * @param {{ withKeySlot: <T>(key: string, fn: () => Promise<T>) => Promise<T>, sleep?: (ms: number) => Promise<void>, now?: () => number, minGapMs?: number, blockLimit?: number, cooldownBaseMs?: number, cooldownMaxMs?: number, onAbandon?: (host: string, cls: string, count: number) => void }} opts
 *   `withKeySlot` is a keyed limiter (createKeyedLimiter in scan-ats-full.mjs).
 */
export function createHostGate({ withKeySlot, sleep = defaultSleep, now = Date.now, minGapMs = 0, blockLimit = 10, cooldownBaseMs = 15_000, cooldownMaxMs = 120_000, onAbandon }) {
  /** @type {Map<string, { refusals: number, pause: Promise<void> | null, abandoned: boolean, nextAt: number }>} */
  const hosts = new Map();
  const stateOf = (/** @type {string} */ host) => {
    let st = hosts.get(host);
    if (!st) hosts.set(host, st = { refusals: 0, pause: null, abandoned: false, nextAt: 0 });
    return st;
  };

  return {
    /** @param {string} host */
    isAbandoned: (host) => hosts.get(host)?.abandoned === true,
    abandonedHosts: () => [...hosts].filter(([, st]) => st.abandoned).map(([host]) => host),

    /**
     * @template T
     * @param {string} host
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async run(host, fn) {
      const st = stateOf(host);
      if (st.abandoned) throw hostAbandonedError(host);
      return withKeySlot(host, async () => {
        while (st.pause) await st.pause;
        if (st.abandoned) throw hostAbandonedError(host);
        if (minGapMs > 0) {
          const t = now();
          const startAt = Math.max(t, st.nextAt);
          st.nextAt = startAt + minGapMs;
          if (startAt > t) await sleep(startAt - t);
        }
        try {
          const result = await fn();
          st.refusals = 0;
          return result;
        } catch (err) {
          const cls = classifyProbeError(err);
          if (cls === '429' || cls === '403') {
            st.refusals++;
            if (st.refusals >= blockLimit) {
              if (!st.abandoned) {
                st.abandoned = true;
                onAbandon?.(host, cls, st.refusals);
              }
            } else if (!st.pause) {
              const retryAfter = parseRetryAfterMs(/** @type {any} */ (err)?.retryAfter);
              const wait = retryAfter !== null
                ? Math.min(retryAfter, cooldownMaxMs)
                : Math.min(cooldownBaseMs * 2 ** (st.refusals - 1), cooldownMaxMs);
              st.pause = sleep(wait).then(() => { st.pause = null; }, () => { st.pause = null; });
            }
          } else if (cls === '404') {
            st.refusals = 0;
          }
          throw err;
        }
      });
    },
  };
}

/** Default spacing between request starts to one API host: at most ~20 a second. */
export const SEED_HOST_GAP_MS = 50;

/**
 * Resolve the per-host request spacing from CAREER_OPS_SEED_HOST_GAP_MS.
 * 0 is valid (no spacing); anything unusable falls back to the default rather
 * than failing a scan over a typo in an environment variable.
 *
 * @param {unknown} raw
 * @returns {number} Milliseconds.
 */
export function resolveSeedGapMs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return SEED_HOST_GAP_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 60_000 ? n : SEED_HOST_GAP_MS;
}

// ── Memory between runs ──────────────────────────────────────────────

/** Base re-probe interval for a remembered 404. Same window the mass sweep uses. */
export const SEED_DEAD_TTL_DAYS = DEAD_BOARD_RECHECK_DAYS;
/** A 404 is re-probed anywhere from (1 - this) to (1 + this) times the base interval. */
export const SEED_DEAD_TTL_JITTER = 0.5;

/** FNV-1a over a string, mapped to [0, 1). Stable across runs and machines. */
export function hash01(/** @type {string} */ text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Days a remembered 404 stays trusted.
 *
 * Staggered per board, so the ~6k slugs recorded by one first run do not all
 * come due the same week: each has its own point in the 15..45-day window (base
 * 30, +-50%), derived from the slug, so a weekly scan re-asks a rotating
 * ~quarter of them rather than all or none. A board that keeps coming back 404
 * on those re-asks is trusted longer — 2x after the second, 3x from the third on
 * — since each is more evidence the slug is simply not on that vendor.
 *
 * @param {string} vendor
 * @param {string} slug
 * @param {number} misses - Consecutive 404s on record (1..3).
 */
export function deadRecheckDays(vendor, slug, misses) {
  const jitter = (1 - SEED_DEAD_TTL_JITTER) + 2 * SEED_DEAD_TTL_JITTER * hash01(`${vendor}/${slug}`);
  return SEED_DEAD_TTL_DAYS * jitter * Math.min(3, Math.max(1, misses));
}

export const LIVE_BOARD_HEADER = 'seed\tcompany\tvendor\tboard\tlast_seen';

/**
 * @param {string} file
 * @returns {Map<string, { seed: string, company: string, vendor: string, board: string, lastSeen: number }>}
 */
export function loadLiveBoards(file) {
  const rows = new Map();
  if (!existsSync(file)) return rows;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    const [seed, company, vendor, board, seen] = line.split('\t');
    const lastSeen = Date.parse(seen || '');
    if (!seed || !company || !SLUG_RE.test(company) || !VENDOR_BOARD_URL[/** @type {keyof typeof VENDOR_BOARD_URL} */ (vendor)]
      || !board || !SLUG_RE.test(board) || !Number.isFinite(lastSeen)) continue;
    rows.set(`${seed}\t${company}`, { seed, company, vendor, board, lastSeen });
  }
  return rows;
}

/**
 * @param {string} file
 * @param {Map<string, { seed: string, company: string, vendor: string, board: string, lastSeen: number }>} rows
 */
export function saveLiveBoards(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  const body = [...rows.values()]
    .sort((a, b) => a.seed.localeCompare(b.seed) || a.company.localeCompare(b.company))
    .map((r) => `${r.seed}\t${r.company}\t${r.vendor}\t${r.board}\t${new Date(r.lastSeen).toISOString()}`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${LIVE_BOARD_HEADER}\n${body.length ? `${body.join('\n')}\n` : ''}`, 'utf8');
  renameSync(tmp, file);
}

/**
 * Everything a seed scan remembers: which (vendor, slug) are known 404s and
 * which board each live company resolved to. In memory until saveSeedState().
 *
 * `refresh` makes decisions ignore all of it (every candidate is asked about,
 * no hint is followed) while still recording what comes back, so one refresh
 * run rewrites the memory from scratch for the companies it touched.
 *
 * @param {{ deadPath: string | null, livePath: string | null, refresh?: boolean, now?: number }} opts
 */
export function loadSeedCache({ deadPath, livePath, refresh = false, now = Date.now() }) {
  return {
    deadPath,
    livePath,
    refresh,
    dirty: false,
    // No path means a memory that lives and dies with the run: nothing is read
    // from disk (so a library caller or a test is not at the mercy of whatever a
    // data root holds) and, with persist off, nothing is written.
    dead: deadPath ? loadDeadBoards(deadPath, now) : new Map(),
    live: livePath ? loadLiveBoards(livePath) : new Map(),
  };
}

/** @typedef {ReturnType<typeof loadSeedCache>} SeedCache */

/**
 * Whether to ask about a (vendor, slug) this run.
 * @param {SeedCache} cache
 */
export function shouldProbeBoard(cache, vendor, slug, now) {
  if (cache.refresh) return true;
  return !shouldSkipDeadBoard(cache.dead, vendor, slug, now, {
    minMisses: 1,
    recheckDays: (row) => deadRecheckDays(vendor, slug, row.misses),
  });
}

/** @param {SeedCache} cache */
export function liveHint(cache, seedId, companySlug) {
  if (cache.refresh) return null;
  const row = cache.live.get(`${seedId}\t${companySlug}`);
  return row ? { vendor: row.vendor, slug: row.board } : null;
}

/** @param {SeedCache} cache */
export function noteLiveBoard(cache, seedId, companySlug, vendor, slug, now) {
  cache.live.set(`${seedId}\t${companySlug}`, { seed: seedId, company: companySlug, vendor, board: slug, lastSeen: now });
  cache.dirty = true;
}

/** @param {SeedCache} cache */
export function forgetLiveBoard(cache, seedId, companySlug, vendor, slug) {
  const key = `${seedId}\t${companySlug}`;
  const row = cache.live.get(key);
  if (row && row.vendor === vendor && row.board === slug) {
    cache.live.delete(key);
    cache.dirty = true;
  }
}

/**
 * The run's shared state: the memory, the per-host gate, and the boards already
 * covered, so a board two portfolios (or two slug spellings) both lead to is
 * fetched once.
 *
 * @param {{ deadPath: string | null, livePath: string | null, refresh?: boolean, persist?: boolean, withKeySlot: <T>(key: string, fn: () => Promise<T>) => Promise<T>, sleep?: (ms: number) => Promise<void>, now?: () => number, onAbandon?: (host: string, cls: string, count: number) => void, blockLimit?: number, minGapMs?: number }} opts
 *   `persist: false` (a dry run) makes saveSeedState() a no-op.
 */
export function createSeedRunState({ deadPath, livePath, refresh = false, persist = true, withKeySlot, sleep, now = Date.now, onAbandon, blockLimit, minGapMs }) {
  return {
    persist,
    now,
    cache: loadSeedCache({ deadPath, livePath, refresh, now: now() }),
    gate: createHostGate({ withKeySlot, sleep, onAbandon, blockLimit, minGapMs }),
    /** @type {Set<string>} */
    liveBoards: new Set(),
  };
}

/**
 * Write the memory back. A no-op for a dry run or when nothing changed; never
 * throws, because losing the cache must not lose the matches of a long scan.
 *
 * @param {ReturnType<typeof createSeedRunState>} state
 * @returns {{ saved: boolean, error?: string }}
 */
export function saveSeedState(state) {
  if (!state.persist || !state.cache.dirty || !state.cache.deadPath || !state.cache.livePath) return { saved: false };
  try {
    saveDeadBoards(state.cache.deadPath, state.cache.dead);
    saveLiveBoards(state.cache.livePath, state.cache.live);
    state.cache.dirty = false;
    return { saved: true };
  } catch (err) {
    return { saved: false, error: /** @type {any} */ (err)?.message ?? String(err) };
  }
}

// ── Probing ──────────────────────────────────────────────────────────

/** @param {string} url */
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * Find a company's board.
 *
 * Candidates (toPortalCandidates) are tried in order. A board that answers with
 * postings wins and ends the search. One that answers with none is remembered as
 * live but the search goes on, since a vendor can keep an old, empty board
 * answering after a company moved to another. A 404 is remembered as dead; a
 * 403/429/5xx/timeout is not (nothing was learned about the board), and makes
 * the company's outcome `unknown` rather than `dead`.
 *
 * @param {import('./vc-portfolios.mjs').SeedCompany} company
 * @param {{
 *   seedId: string,
 *   providers: Record<string, any>,
 *   ctx: any,
 *   state: ReturnType<typeof createSeedRunState>,
 *   stats: ReturnType<typeof newSeedStats>,
 *   vendors?: string[],
 *   onFailure?: (company: import('./vc-portfolios.mjs').SeedCompany, vendor: string, slug: string, cls: string, err: any) => void,
 * }} deps
 * @returns {Promise<{ outcome: 'live'|'empty'|'dead'|'unknown'|'none'|'duplicate', board: null | { vendor: string, slug: string, entry: any, provider: any, jobs: any[] } }>}
 */
export async function probeSeedCompany(company, { seedId, providers, ctx, state, stats, vendors = SEED_VENDOR_ORDER, onFailure }) {
  const { cache, gate } = state;
  const candidates = toPortalCandidates(company, {
    vendors: vendors.filter((v) => providers[v]),
    hint: liveHint(cache, seedId, company.slug),
  });

  let sawUnknown = false;
  let sawDead = false;
  /** @type {{ vendor: string, slug: string } | null} */
  let emptyBoard = null;

  for (const c of candidates) {
    const provider = providers[c.vendor];
    const entry = { name: c.name, careers_url: c.careers_url };
    let detected = null;
    try { detected = provider.detect?.(entry); } catch { /* an unroutable slug is a skipped candidate */ }
    if (!detected) { stats.undetectable++; continue; }

    const boardId = `${c.vendor}/${c.slug}`;
    if (state.liveBoards.has(boardId)) return { outcome: 'duplicate', board: null };

    if (!shouldProbeBoard(cache, c.vendor, c.slug, state.now())) {
      stats.cachedSkips++;
      sawDead = true;
      continue;
    }

    const host = hostOf(detected.url || c.careers_url) || c.vendor;
    let jobs;
    try {
      stats.probes++;
      jobs = await gate.run(host, () => provider.fetch(entry, ctx));
    } catch (err) {
      if (/** @type {any} */ (err)?.hostAbandoned) {
        stats.skippedAbandoned++;
        sawUnknown = true;
        continue;
      }
      const cls = classifyProbeError(err);
      stats.unreachable[cls]++;
      onFailure?.(company, c.vendor, c.slug, cls, err);
      recordBoardFailure(cache.dead, c.vendor, c.slug, err, state.now());
      cache.dirty = true;
      if (cls === '404') {
        sawDead = true;
        forgetLiveBoard(cache, seedId, company.slug, c.vendor, c.slug);
      } else {
        sawUnknown = true;
      }
      continue;
    }

    recordBoardResult(cache.dead, c.vendor, c.slug, 200, state.now());
    cache.dirty = true;
    if (!Array.isArray(jobs) || jobs.length === 0) {
      emptyBoard ??= { vendor: c.vendor, slug: c.slug };
      continue;
    }
    state.liveBoards.add(boardId);
    noteLiveBoard(cache, seedId, company.slug, c.vendor, c.slug, state.now());
    return { outcome: 'live', board: { vendor: c.vendor, slug: c.slug, entry, provider, jobs } };
  }

  if (emptyBoard) {
    noteLiveBoard(cache, seedId, company.slug, emptyBoard.vendor, emptyBoard.slug, state.now());
    return { outcome: 'empty', board: null };
  }
  if (sawUnknown) return { outcome: 'unknown', board: null };
  if (sawDead) return { outcome: 'dead', board: null };
  return { outcome: 'none', board: null };
}
