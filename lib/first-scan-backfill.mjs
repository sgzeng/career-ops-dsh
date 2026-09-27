// lib/first-scan-backfill.mjs — one wider scan window the first time a company is scanned.
//
// Fork-local (config/local-paths.txt). The daily scan runs `scan.mjs --since 14`,
// and --since is a lower bound on each posting's employer date. So a company
// newly added to portals.yml → tracked_companies only ever shows the scanner its
// postings from the last 14 days: every older posting that is still open is
// filtered on that first run and never seen again unless the employer reposts it.
// (Seen 2026-09: NVIDIA's Workday entry was first scanned 2026-09-03; "Harness and
// Platform Engineer" JR2021886, posted 2026-08-11, was 23 days old then and never
// reached the pipeline. A sibling req only arrived because NVIDIA reposted it.)
//
// Fix: a company with no row in data/scan-backfill.tsv is scanned ONCE with a
// posting-date window of first_scan_backfill.window_days (default
// max_posting_age_days) instead of --since. After that pass succeeds it gets a
// row, and later runs use --since as before.
//
// Scope:
//   - The relative --since bound is widened, for both the posted-date filter and
//     the provider early-stop hint (ctx.sinceMs). When window_days exceeds
//     max_posting_age_days, that company's age filter is widened to the window
//     for this pass too; every other company keeps max_posting_age_days. An
//     explicit --posted-after / --posted-before turns the backfill off for that
//     run: no widening and no rows written.
//   - Dedup is unchanged, with one addition: in a widened pass, a scan-history
//     `added` row that scan_history.recheck_after_days has released (a finished
//     pipeline row first seen long ago) still counts as seen (scan.mjs checks
//     `released`). Otherwise a 45-day pass would hand stage 2 postings it already
//     triaged away. A normal --since run keeps the usual recheck behaviour.
//   - A row is written only after the company's fetch succeeded AND returned at
//     least one posting. A provider error, a timeout, or an empty result writes no
//     row, and the next run tries again. A crawl the provider tagged as partial
//     (workdayTruncated / icimsTruncated) writes a `truncated` row and is retried;
//     after MAX_TRUNCATED_ATTEMPTS of them the company counts as covered, so a
//     board that is structurally clamped is not re-crawled every day. Each row
//     stores the window and the entry's max_pages; raising max_pages later
//     re-runs the pass, raising window_days does not (only new companies get the
//     wider window) unless first_scan_backfill.rerun_on_wider_window: true.
//     A truncated crawl still being retried uses the current window.
//     --dry-run widens (so it previews the backfill) but never writes.
//   - Not applied to job_boards (aggregator feeds: 45 days of an aggregator is a
//     flood, not a coverage fix), and not to local parsers by default: their
//     recency comes from their own args (google-careers.mjs / linkedin-jobs.mjs
//     `--since-days`), so widening scan.mjs's filter would recover nothing the
//     parser already dropped. An entry can override either way with
//     `first_scan_backfill: true|false`, e.g. a custom parser that returns a
//     whole board.
//
// Key: the entry's normalized careers_url (else api, else the parser command
// line, else the name). Renaming an entry's display name does not re-trigger
// the backfill. Pointing the entry at a different board does, which is correct
// because that board has never been covered. The `company` column is only for
// reading. An entry keyed by name alone (no URL and no parser) backfills again
// after a rename, as does deleting its row. A repeat costs one wider crawl; it
// re-adds nothing already seen, released recheck rows included (see above).
//
// Lanes (docs/SCRIPTS.md, #2271): the state follows the dedup history. With
// CAREER_OPS_SCAN_HISTORY set and CAREER_OPS_SCAN_BACKFILL not, the path is
// derived from the history path (scan-history.bridge.tsv → scan-backfill.bridge.tsv),
// so one lane's coverage never switches off another lane's first pass.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

export const BACKFILL_HEADER = 'key\tcompany\tbackfilled_at\twindow_days\tmax_pages\tstatus\n';
/** Partial crawls tolerated before a company counts as covered anyway. */
export const MAX_TRUNCATED_ATTEMPTS = 3;

const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);
// One whitespace-free-at-the-edges, single-spaced form for keys and cells, so a
// key survives the TSV round trip (tabs/newlines would split or break a row).
const squash = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * Resolve portals.yml `first_scan_backfill` (+ the --no-backfill CLI flag).
 *
 * Absent or `true` means enabled. `false` or `{ enabled: false }` disables it.
 * The window is `window_days`, else max_posting_age_days. It may exceed
 * max_posting_age_days (since 2026-09-27): scan.mjs then widens that company's
 * age filter to the window for its first pass only, so a newly added company's
 * still-open older postings are seen once (Cogent's AI Research Engineer /
 * Scientist and Armadin's MTS roles were 53–85 days old when first scanned).
 * With no window at all, the backfill is off: an unbounded first pass could
 * surface years-old postings.
 *
 * `rerun_on_wider_window: true` re-runs the pass for companies already covered
 * with a smaller window. Off by default: raising window_days is meant for
 * companies added from now on, not a re-crawl of every covered board.
 *
 * Fails CLOSED on anything else. js-yaml parses `off`/`no` as strings and an
 * empty key as null, and daily-scan.sh only warns on validate-portals errors, so
 * a mistyped opt-out (`enabled: off`, `window_days: 0`) must not silently run
 * the one-time full crawl. The reason ends up in the run's Backfill line.
 *
 * @returns {{ enabled: boolean, windowDays: number|null, off: string|null, rerunOnWiderWindow?: boolean, maxAgeDays?: number|null }}
 */
export function resolveBackfillConfig(raw, maxPostingAgeDays, { cliOff = false } = {}) {
  const off = (why) => ({ enabled: false, windowDays: null, off: why });
  if (cliOff) return off('--no-backfill');
  if (raw === false || (raw && typeof raw === 'object' && raw.enabled === false)) {
    return off('portals.yml first_scan_backfill.enabled: false');
  }
  const isBlock = raw && typeof raw === 'object' && !Array.isArray(raw);
  if (raw !== undefined && raw !== true && !isBlock) {
    return off(`portals.yml first_scan_backfill: ${JSON.stringify(raw)} is not true, false or { enabled, window_days }`);
  }
  if (isBlock && raw.enabled !== undefined && raw.enabled !== true) {
    return off(`portals.yml first_scan_backfill.enabled: ${JSON.stringify(raw.enabled)} is not a boolean`);
  }
  if (isBlock && raw.window_days !== undefined && posInt(raw.window_days) == null) {
    return off(`portals.yml first_scan_backfill.window_days: ${JSON.stringify(raw.window_days)} is not a positive integer`);
  }
  const maxAge = posInt(Number(maxPostingAgeDays));
  const configured = isBlock ? posInt(raw.window_days) : null;
  const window = configured ?? maxAge;
  if (window == null) {
    return off('no window: set max_posting_age_days or first_scan_backfill.window_days');
  }
  return {
    enabled: true, windowDays: window, off: null, maxAgeDays: maxAge,
    rerunOnWiderWindow: isBlock && raw.rerun_on_wider_window === true,
  };
}

function normalizeUrlKey(raw) {
  const s = String(raw).trim();
  try {
    const u = new URL(s);
    const host = u.host.toLowerCase().replace(/^www\./, '');
    return `${host}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    return s.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Stable identity for one portals.yml entry (see the header for the choice).
 * @param {{ name?: string, careers_url?: string, api?: string, parser?: object }} entry
 * @returns {string}
 */
// Every body is squashed, so the key the planner compares is byte-for-byte the
// one appendBackfillState writes and loadBackfillState reads back (a parser arg
// with a trailing space, a tab or a YAML `|` newline would otherwise never match
// its own row and re-backfill every day).
export function backfillKey(entry) {
  if (typeof entry.careers_url === 'string' && entry.careers_url.trim()) return `url:${squash(normalizeUrlKey(entry.careers_url))}`;
  if (typeof entry.api === 'string' && entry.api.trim()) return `url:${squash(normalizeUrlKey(entry.api))}`;
  const p = entry.parser;
  if (p && typeof p === 'object' && p.command) {
    const parts = [p.command, p.script, ...(Array.isArray(p.args) ? p.args : [])].filter((x) => x != null && x !== '');
    return `parser:${squash(parts.map(String).join(' '))}`;
  }
  return `name:${squash(String(entry.name || '').toLowerCase())}`;
}

/**
 * Backfill state path for this run. An explicit CAREER_OPS_SCAN_BACKFILL wins;
 * else a lane that overrides CAREER_OPS_SCAN_HISTORY gets a sibling file named
 * after its history; else the default data/scan-backfill.tsv.
 */
export function resolveBackfillPath({ explicit, historyOverride, historyPath, defaultPath }) {
  if (explicit) return explicit;
  if (!historyOverride) return defaultPath;
  const base = path.basename(historyPath);
  const derived = base.includes('scan-history')
    ? base.replace('scan-history', 'scan-backfill')
    : `${base.replace(/\.tsv$/i, '')}.backfill.tsv`;
  return path.join(path.dirname(historyPath), derived);
}

/** Did the provider tag this result as a partial crawl? (array tags, as scan-ats-full.mjs reads them) */
export function isTruncatedFetch(jobs) {
  return Boolean(jobs && (jobs.workdayTruncated || jobs.icimsTruncated));
}

/**
 * Is this company covered for the current max_pages (and window, when
 * rerunOnWiderWindow)? A row counts only if it was taken with (when the entry
 * sets max_pages) at least this many pages, so raising max_pages re-runs the
 * pass. A smaller recorded window counts as covered unless rerunOnWiderWindow.
 * A `complete` row covers; MAX_TRUNCATED_ATTEMPTS `truncated` rows also cover.
 */
function isCovered(rows, windowDays, maxPages, rerunOnWiderWindow = false) {
  const fits = (r) => (!rerunOnWiderWindow || r.windowDays == null || r.windowDays >= windowDays)
    && (maxPages == null || (r.maxPages != null && r.maxPages >= maxPages));
  const matching = rows.filter(fits);
  return matching.some((r) => r.status !== 'truncated')
    || matching.filter((r) => r.status === 'truncated').length >= MAX_TRUNCATED_ATTEMPTS;
}

/**
 * Build the per-target decision function for one run.
 *
 * Returned planner: (entry, providerId, isBoard) → null (normal --since scan, no
 * row) or { key, widen, maxPages }. `widen: true` scans with the backfill window.
 * `widen: false` means this run's own window already spans it, so the company
 * only needs its row. The run's span is the tighter of --since and
 * max_posting_age_days: with window_days above max_posting_age_days, a run
 * without --since still sees only max_posting_age_days, so it must widen too —
 * recording it as covered would spend the one-time wide pass at 45 days.
 *
 * Per entry, only a literal `first_scan_backfill: true` opts a board or local
 * parser in; any other set value (false, "no", "off", null) opts the entry out.
 */
export function makeBackfillPlanner({ cfg, sinceDays, explicitBounds, state }) {
  const active = cfg.enabled && !explicitBounds;
  const span = Math.min(
    Number.isFinite(sinceDays) ? sinceDays : Infinity,
    Number.isFinite(cfg.maxAgeDays) && cfg.maxAgeDays > 0 ? cfg.maxAgeDays : Infinity,
  );
  const widen = span < cfg.windowDays;
  return (entry, providerId, isBoard) => {
    if (!active) return null;
    const override = entry.first_scan_backfill;
    if (override !== undefined && override !== true) return null;
    if (override !== true && (isBoard || providerId === 'local-parser')) return null;
    const key = backfillKey(entry);
    const maxPages = posInt(entry.max_pages);
    if (isCovered(state.get(key) || [], cfg.windowDays, maxPages, cfg.rerunOnWiderWindow === true)) return null;
    return { key, widen, maxPages };
  };
}

/**
 * data/scan-backfill.tsv → Map key → rows [{ company, backfilledAt, windowDays, maxPages, status }].
 * Missing file = empty. A row without the later columns counts as `complete`.
 */
export function loadBackfillState(filePath) {
  const map = new Map();
  if (!existsSync(filePath)) return map;
  for (const line of readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('key\t')) continue;
    const [key, company = '', backfilledAt = '', windowDays = '', maxPages = '', status = ''] = line.split('\t');
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      company, backfilledAt,
      windowDays: Number(windowDays) || null,
      maxPages: Number(maxPages) || null,
      status: status.trim() === 'truncated' ? 'truncated' : 'complete',
    });
  }
  return map;
}

/** Append rows ({ key, company, windowDays, maxPages?, truncated? }); creates the file with its header. */
export function appendBackfillState(filePath, rows, now = new Date()) {
  if (rows.length === 0) return;
  const seen = new Set();
  const lines = rows
    .filter((r) => r.key && !seen.has(r.key) && seen.add(r.key))
    .map((r) => [squash(r.key), squash(r.company), now.toISOString(), r.windowDays ?? '', r.maxPages ?? '',
      r.truncated ? 'truncated' : 'complete'].join('\t') + '\n')
    .join('');
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (!existsSync(filePath)) {
    writeFileSync(filePath, BACKFILL_HEADER + lines, 'utf-8');
    return;
  }
  const existing = readFileSync(filePath, 'utf-8');
  appendFileSync(filePath, (existing && !existing.endsWith('\n') ? '\n' : '') + lines, 'utf-8');
}

/**
 * The one-line run summary.
 * @param {{ cfg: object, explicitBounds: boolean, widened: string[], recordOnly: string[], failed: string[], truncated?: string[], dryRun: boolean }} s
 */
export function formatBackfillSummary({ cfg, explicitBounds, widened, recordOnly, failed, truncated = [], dryRun }) {
  const label = 'Backfill:              ';
  if (!cfg.enabled) return `${label}off (${cfg.off})`;
  if (explicitBounds) return `${label}skipped this run (--posted-after/--posted-before set)`;
  const parts = [];
  const n = (k) => `${k} compan${k === 1 ? 'y' : 'ies'}`;
  if (widened.length > 0) parts.push(`${n(widened.length)} scanned with a ${cfg.windowDays}-day window (first coverage)`);
  if (recordOnly.length > 0) parts.push(`${n(recordOnly.length)} marked covered (this run's window already spans ${cfg.windowDays} days)`);
  if (parts.length === 0) return `${label}none pending (every eligible company already has first coverage)`;
  if (failed.length > 0) parts.push(`${failed.length} not recorded (fetch failed or returned nothing), retried next run: ${failed.join(', ')}`);
  if (truncated.length > 0) parts.push(`${truncated.length} crawl(s) truncated, retried next run (covered after ${MAX_TRUNCATED_ATTEMPTS} tries): ${truncated.join(', ')}`);
  return `${label}${parts.join('; ')}${dryRun ? ' (dry run, not recorded)' : ''}`;
}
