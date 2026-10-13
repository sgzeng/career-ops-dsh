// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Rippling provider — hits the tenant's public v2 board JSON API.
// Auto-detects from a careers_url like `https://ats.rippling.com/<slug>/jobs`
// (the `<slug>` is the first path segment).
//
// Board API (same origin as the careers pages — no separate API host):
//   GET https://ats.rippling.com/api/v2/board/<slug>/jobs?page=<n>&pageSize=<n>
// Response: `{ items: [...], page, pageSize, totalItems, totalPages }`, each
// item `{ id, name, url, department: { name }, locations: [{ name, ... }], language }`.
// A posting open in several places appears once PER LOCATION, same id.
//
// The client itself caps pageSize at 1000; requesting that size returns a
// tenant's whole board in one request for any realistically-sized company —
// Rippling's own board, the largest tenant seen, runs 606 postings, still
// one page under that cap. Still paginated below with its own page-count
// ceiling — never trusting the source's own `totalPages` alone — for the
// rare tenant whose board exceeds one page.
//
// The list carries no description and no date, so every Rippling posting used
// to reach scan.mjs undated and description-less. The per-posting detail
// document has both, on the same origin:
//   GET https://ats.rippling.com/api/v2/board/<slug>/jobs/<id>
//   → { uuid, name, description: { role, company } (HTML), createdOn,
//       workLocations, payRangeDetails: [{ currency, frequency, rangeStart,
//       rangeEnd, location }], employmentType, jsonLd, ... }
// (the same document the legacy api.rippling.com/platform/api/ats/v1 detail
// endpoint serves; `uuid` there equals the list item's `id`.)
// fetch() pulls it once per distinct id, DETAIL_BATCH at a time, at most
// MAX_DETAIL_REQUESTS per board. Unlike smartrecruiters/vdab this is not an
// opt-in, because a posting with no date or text is invisible to --since and
// content_filter. Cost scales with the board: one GET per distinct posting
// (measured on the legacy host: Kai 20 postings ~1.1–1.5 s, Comp AI /
// just-appraised-jobs ~0.3–0.4 s; Rippling's own board, 330 postings, ~9 s).
// A board past the cap is enriched in list order — roughly alphabetical by
// title on the live boards — so its remaining postings stay undated and
// description-less, and the cap line on stderr says how many.
// Enrichment only — a detail that fails or is malformed leaves the list-level
// posting exactly as it was, and the whole step is skipped while a caller is
// probing (ctx.maxPages set, as verify-portals does).
//
// The careers/API host (`ats.rippling.com`) is fixed; the per-tenant slug and
// the posting id are the only variable parts. Both are constrained to safe
// tokens before interpolation so they cannot inject extra path segments, a
// query, or traversal into the API URL.

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { htmlToText, FULL_DESCRIPTION_CAP } from './_html-to-text.mjs';

const CAREERS_HOST = 'ats.rippling.com';
const API_BASE = `https://${CAREERS_HOST}/api/v2/board`;
const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const UUID_RE = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

// Detail GETs in flight at once — same small-batch politeness as
// smartrecruiters/vdab, so a board cannot burst the shared API host.
const DETAIL_BATCH = 4;
// Detail GETs one board may spend (one per distinct id, no retries). Same
// ceiling as workday's placeholder enrichment; loud when it truncates, because
// a silent cap reads as "every posting was enriched" when it wasn't.
const MAX_DETAIL_REQUESTS = 200;

// A createdOn more than a year ahead is a bad value, not a posting date — same
// bound local-parser.mjs applies (past the Date range it would also make
// scan.mjs's toISOString() throw).
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

// payRangeDetails[].frequency → annual multiplier (ashby.mjs's table, in
// Rippling's vocabulary). An unknown frequency drops that range, never guesses.
const FREQUENCY_MULTIPLIERS = { YEAR: 1, MONTH: 12, WEEK: 52, DAY: 260, HOUR: 2080 };

// Largest pageSize the client itself ever requests (see header comment).
const PAGE_SIZE = 1000;

// Page count ceiling, independent of what `totalPages` reports — a growing
// or tampered response must not turn one portals.yml line into an unbounded
// request loop. DEFAULT_MAX_PAGES * PAGE_SIZE = 10,000 postings is already
// implausible for one company; MAX_PAGES_CAP leaves headroom for an explicit
// override without going unbounded.
const DEFAULT_MAX_PAGES = 10;
const MAX_PAGES_CAP = 50;

// Delay between successive pages of one tenant's own pagination loop — the
// common single-page board never pays it.
const INTER_PAGE_DELAY_MS = 200;

const RETRY_POLICY = { retries: 2 };

// Why the walk over one tenant's pages stopped.
const STOP_REASON = {
  COMPLETE: 'complete',
  CAP: 'cap',
  FETCH_ERROR: 'fetch-error',
};

/**
 * Resolve the tenant slug (e.g. `just-appraised-jobs`) from a careers_url.
 * Returns null for non-Rippling, malformed, or unsafe-slug URLs.
 * @param {import('./_types.js').PortalEntry} entry
 */
function resolveSlug(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== CAREERS_HOST) return null;
  const segment = parsed.pathname.split('/').filter(Boolean)[0] || '';
  if (!SLUG_RE.test(segment)) return null;
  return segment;
}

/** Build one page's board API URL for a validated slug. */
function apiUrlForSlug(slug, page) {
  // slug is config-derived (portals.yml careers_url), already restricted to
  // SLUG_RE's charset — plain encodeURIComponent here is defense-in-depth,
  // not a host-controlled response field that would need a surrogate-safe
  // encoder with a drop-the-posting fallback.
  const encodedSlug = encodeURIComponent(slug);
  const apiUrl = new URL(`${API_BASE}/${encodedSlug}/jobs`);
  apiUrl.searchParams.set('page', String(page));
  apiUrl.searchParams.set('pageSize', String(PAGE_SIZE));
  return apiUrl.href;
}

/** Build the posting-detail API URL for a validated slug + posting id (UUID_RE-checked). */
function detailUrlFor(slug, id) {
  return `${API_BASE}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(id)}`;
}

/** @param {string} url */
function assertRipplingApiUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`rippling: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`rippling: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== CAREERS_HOST) {
    throw new Error(`rippling: untrusted hostname "${parsed.hostname}" — must be ${CAREERS_HOST}`);
  }
  return url;
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Plain-text description from a detail document. `description` is observed as
 * an object of HTML sections (`{ company, role }`); the role section goes
 * first so the requirements survive the cap, then any other section, then the
 * company boilerplate. A bare HTML string is accepted as-is. Capped like
 * lever's leverDescription (each HTML piece at FULL_DESCRIPTION_CAP, then the
 * joined text); the sections are joined by one newline here, where lever puts a
 * blank line between its parts.
 * @param {Record<string, any>} detail
 * @returns {string}
 */
function descriptionFromDetail(detail) {
  const raw = detail.description;
  /** @type {unknown[]} */
  let sections = [];
  if (typeof raw === 'string') {
    sections = [raw];
  } else if (raw != null && typeof raw === 'object') {
    const keys = Object.keys(raw);
    const ordered = [
      ...keys.filter((k) => k === 'role'),
      ...keys.filter((k) => k !== 'role' && k !== 'company'),
      ...keys.filter((k) => k === 'company'),
    ];
    sections = ordered.map((k) => raw[k]);
  }
  return sections
    .map((s) => htmlToText(s, FULL_DESCRIPTION_CAP))
    .filter(Boolean)
    .join('\n')
    .slice(0, FULL_DESCRIPTION_CAP);
}

/**
 * Epoch ms from `createdOn` (observed as `2026-06-19T14:10:49.247000-07:00`),
 * or undefined. A date-time must state its offset: without one Date.parse
 * reads it as the scanning machine's local time and the day can move (see
 * workday.mjs postedAtFromDetail). NaN, non-positive and far-future values are
 * dropped rather than trusted.
 * @param {unknown} raw
 * @returns {number|undefined}
 */
function postedAtFromCreatedOn(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/.test(trimmed)) return undefined;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms) || ms <= 0 || ms > Date.now() + MAX_FUTURE_MS) return undefined;
  return ms;
}

/**
 * Annualized salary envelope from `payRangeDetails` (one range per pay zone),
 * or null. Rippling names pay zones ("Coworking (Downtown)") rather than the
 * list's locations ("Springfield, IL"), so zones cannot be matched to list rows;
 * the posting gets the envelope across its zones instead — lowest start to
 * highest end. Ranges in more than one currency have no single envelope and
 * yield null. Non-positive bounds are ignored: a 0 would read as the floor in
 * scan.mjs's salary_filter (`min ?? max`).
 * @param {unknown} ranges
 * @returns {{min: number, max: number, currency: string}|null}
 */
function salaryFromPayRanges(ranges) {
  if (!Array.isArray(ranges)) return null;
  /** @param {unknown} v */
  const positive = (v) => {
    if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const currencies = new Set();
  let min = Infinity;
  let max = -Infinity;
  for (const r of ranges) {
    if (!isPlainObject(r)) continue;
    const freq = typeof r.frequency === 'string' ? r.frequency.trim().toUpperCase() : '';
    const multiplier = Object.hasOwn(FREQUENCY_MULTIPLIERS, freq)
      ? FREQUENCY_MULTIPLIERS[/** @type {keyof typeof FREQUENCY_MULTIPLIERS} */ (freq)]
      : 0;
    if (!multiplier) continue;
    const start = positive(r.rangeStart);
    const end = positive(r.rangeEnd);
    if (start == null && end == null) continue;
    const lo = /** @type {number} */ (start ?? end) * multiplier;
    const hi = /** @type {number} */ (end ?? start) * multiplier;
    min = Math.min(min, lo, hi);
    max = Math.max(max, lo, hi);
    currencies.add(typeof r.currency === 'string' ? r.currency.trim().toUpperCase() : '');
  }
  if (currencies.size !== 1 || !Number.isFinite(min)) return null;
  return { min, max, currency: [...currencies][0] };
}

/**
 * Merge a posting-detail document into a list-level job. Exported for unit
 * tests. Pure: returns a new object and never mutates `job`.
 *
 *   - description: role section first, then other sections, then company
 *                  boilerplate, as plain text capped at FULL_DESCRIPTION_CAP
 *                  (content_filter / visa_filter read the requirements, which
 *                  a 4000-char cap cuts); omitted when empty.
 *   - postedAt:    from `createdOn` (offset-bearing ISO only); omitted when
 *                  unusable — an absent date never erases a present one.
 *   - salary:      annualized envelope of `payRangeDetails`; omitted when none.
 *
 * A detail that is not an object returns `job` unchanged.
 *
 * @param {{title: string, url: string, company: string, location: string}} job
 * @param {unknown} detail
 * @returns {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number, salary?: {min: number, max: number, currency: string}}}
 */
export function mergeRipplingDetail(job, detail) {
  if (!isPlainObject(detail)) return job;
  /** @type {any} */
  const out = { ...job };
  const description = descriptionFromDetail(detail);
  if (description) out.description = description;
  const postedAt = postedAtFromCreatedOn(detail.createdOn);
  if (postedAt !== undefined) out.postedAt = postedAt;
  const salary = salaryFromPayRanges(detail.payRangeDetails);
  if (salary) out.salary = salary;
  return out;
}

/**
 * One page of the v2 envelope as `{ rows, rawCount }` — parseRipplingPage plus
 * the posting id fetch() needs for the detail GET. `id` is '' when absent or
 * not a clean UUID, which leaves that posting un-enriched rather than dropped.
 * Throws on a non-`{items[]}` envelope (empty-vs-broken split: `items: []` is a
 * genuinely empty board, anything else unexpected is an error).
 * @param {any} json
 * @param {string} companyName
 * @returns {{rows: Array<{job: {title: string, url: string, company: string, location: string}, id: string}>, rawCount: number}}
 */
function parseRipplingRows(json, companyName) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.items)) {
    const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(`rippling: unexpected response — expected items[], got: [${got}]`);
  }
  const rawCount = json.items.length;
  /** @type {Array<{job: {title: string, url: string, company: string, location: string}, id: string}>} */
  const rows = [];
  for (const j of json.items) {
    const title = typeof j?.name === 'string' ? j.name.trim() : '';
    if (!title) continue;

    // url must be an absolute https posting link on ats.rippling.com — Rippling
    // always serves postings there (no custom-domain case), so an off-host URL
    // is untrusted and dropped. url is the dedup key.
    let url = '';
    const rawUrl = typeof j?.url === 'string' ? j.url.trim() : '';
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'https:' && parsed.hostname === CAREERS_HOST) url = parsed.href;
      } catch {
        // malformed URL → leave url = '' → dropped below
      }
    }
    if (!url) continue;

    const locs = Array.isArray(j?.locations) ? j.locations : [];
    const location = locs
      .map((l) => (l && typeof l.name === 'string' ? l.name.trim() : ''))
      .filter(Boolean)
      .join(' · ');

    const id = typeof j?.id === 'string' && UUID_RE.test(j.id) ? j.id : '';
    rows.push({ job: { title, url, location, company: companyName }, id });
  }
  return { rows, rawCount };
}

/**
 * Parse one page of the Rippling v2 board API response. Exported for unit
 * tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `name`, trimmed (postings without one are dropped).
 *   - url:      `url` — an absolute `https:` posting URL host-locked to
 *               `ats.rippling.com` (Rippling always serves postings there, so
 *               an off-host or non-https URL is untrusted and the posting is
 *               dropped). It is the dedup key and is display-only (written to
 *               the pipeline/history, never server-fetched here).
 *   - company:  the portal entry name (the feed is per-tenant and carries no
 *               company field, same as recruitee).
 *   - location: every `locations[].name`, joined with ` · ` (a posting can
 *               list more than one place); "" when the array is empty/absent.
 *
 * List-level only: description/postedAt/salary come from the per-posting
 * detail document, merged by fetch() via mergeRipplingDetail.
 *
 * @param {any} json
 * @param {string} companyName
 * @returns {{jobs: Array<{title: string, url: string, company: string, location: string}>, rawCount: number}}
 */
export function parseRipplingPage(json, companyName) {
  const { rows, rawCount } = parseRipplingRows(json, companyName);
  return { jobs: rows.map((r) => r.job), rawCount };
}

/** @type {Provider} */
export default {
  id: 'rippling',

  detect(entry) {
    const slug = resolveSlug(entry);
    return slug ? { url: apiUrlForSlug(slug, 0) } : null;
  },

  /**
   * @param {{ name?: string, careers_url?: string, max_pages?: number }} entry
   * @param {{ fetchJson: (url: string, opts?: object) => Promise<any>, maxPages?: number, sleep?: (ms: number) => Promise<void> }} ctx
   */
  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`rippling: cannot derive API URL for ${entry.name}`);

    const maxPages = resolveMaxPages(entry);
    const ctxMaxPages = Number(ctx?.maxPages);
    const ctxCap = ctxMaxPages > 0 ? ctxMaxPages : Infinity;
    const pagesToFetch = Math.min(maxPages, ctxCap);
    // Health probe (verify-portals) sets ctx.maxPages: 1 — don't wrap or
    // swallow its ProbePageBudgetReached rejection, propagate it unwrapped.
    const probing = ctxCap !== Infinity;

    /** @type {Array<{job: {title: string, url: string, company: string, location: string}, id: string}>} */
    const rows = [];
    let stopReason = STOP_REASON.COMPLETE;
    let page = 0;
    for (; page < pagesToFetch; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = apiUrlForSlug(slug, page);
      assertRipplingApiUrl(url);

      let json;
      try {
        json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' }, RETRY_POLICY);
      } catch (err) {
        // A failure on page 0 means the board itself is unreachable — propagate
        // (scan.mjs records the entry as errored) instead of reporting a dead
        // board as a healthy empty one. Only a LATER page's failure, after page
        // 0 proved the board alive, truncates gracefully.
        if (probing || page === 0) throw err;
        const attempts = err?.attempts ?? RETRY_POLICY.retries + 1;
        console.error(`⚠️  rippling: ${entry.name} truncated at page ${page + 1} of ${pagesToFetch} after ${attempts} attempts (${rows.length} jobs): ${err.message}`);
        stopReason = STOP_REASON.FETCH_ERROR;
        break;
      }

      const { rows: pageRows, rawCount } = parseRipplingRows(json, entry.name);
      rows.push(...pageRows);

      // Natural end: the source's own raw row count for this page (before
      // malformed-row filtering) is short of PAGE_SIZE. Break WITHOUT
      // incrementing page — a short page that happens to land on the last
      // allowed page must still read as a natural end below, not as the
      // ceiling having truncated a healthy board.
      if (rawCount < PAGE_SIZE) break;
    }

    // Only a healthy walk that ran out of its OWN entry.max_pages /
    // DEFAULT_MAX_PAGES budget counts as capped — never a probe's ctx.maxPages
    // cap and never a fetch-error stop: this warning means the ceiling
    // truncated a healthy board, not that the board broke.
    if (stopReason === STOP_REASON.COMPLETE && page === pagesToFetch && pagesToFetch === maxPages) {
      stopReason = STOP_REASON.CAP;
      console.error(`⚠️  rippling: ${entry.name} truncated at max_pages=${maxPages} (${rows.length} jobs) — raise max_pages on this entry for more`);
    }

    // Detail enrichment answers "what does this job say", not "is this
    // endpoint alive" — skip it entirely while probing (same rule as
    // smartrecruiters/vdab/workday), so the probe stays at one request.
    if (probing) return rows.map((r) => r.job);

    // One GET per distinct id: the list repeats a posting once per location
    // row, and every row of it gets the same detail.
    const ids = [...new Set(rows.map((r) => r.id).filter(Boolean))];
    const pending = ids.slice(0, MAX_DETAIL_REQUESTS);
    /** @type {Map<string, any>} */
    const details = new Map();
    let failed = 0;
    for (let i = 0; i < pending.length; i += DETAIL_BATCH) {
      const batch = pending.slice(i, i + DETAIL_BATCH);
      await Promise.all(batch.map(async (id) => {
        try {
          const detailUrl = detailUrlFor(slug, id);
          assertRipplingApiUrl(detailUrl);
          // redirect:'error' prevents SSRF via server-side redirects
          const detail = await ctx.fetchJson(detailUrl, { redirect: 'error' });
          // A document for some other posting (or not a document at all) is
          // malformed — merging it would put another job's text on this one.
          if (!isPlainObject(detail) || (detail.uuid != null && detail.uuid !== id)) {
            failed++;
            return;
          }
          details.set(id, detail);
        } catch {
          // Detail fetch is an enrichment only. Keep the listing result.
          failed++;
        }
      }));
    }

    if (failed > 0 || ids.length > pending.length) {
      const unreadable = failed > 0 ? `, ${failed} detail document(s) unreadable` : '';
      const capped = ids.length > pending.length
        ? `, ${ids.length - pending.length} left undetailed by the ${MAX_DETAIL_REQUESTS}-request cap`
        : '';
      console.error(`ℹ️  rippling: ${entry.name} enriched ${details.size} of ${ids.length} posting(s)${unreadable}${capped}`);
    }

    return rows.map((r) => {
      const detail = r.id ? details.get(r.id) : undefined;
      return detail ? mergeRipplingDetail(r.job, detail) : r.job;
    });
  },
};
