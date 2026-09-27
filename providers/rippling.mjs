// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Rippling provider — hits the public per-tenant ATS board API.
// Auto-detects from a careers_url like `https://ats.rippling.com/<slug>/jobs`
// (the `<slug>` is the first path segment). Rippling's board API is public and
// zero-auth:
//   https://api.rippling.com/platform/api/ats/v1/board/<slug>/jobs
// Response shape: a JSON ARRAY of
//   { uuid, name, department: { id, label }, url, workLocation: { id, label } }
// A posting open in several places appears once PER LOCATION, same uuid.
//
// The list carries no description and no date, so every Rippling posting used
// to reach scan.mjs undated and description-less. The per-posting detail
// document has both:
//   https://api.rippling.com/platform/api/ats/v1/board/<slug>/jobs/<uuid>
//   → { uuid, name, description: { role, company } (HTML), createdOn,
//       workLocations, payRangeDetails: [{ currency, frequency, rangeStart,
//       rangeEnd, location }], employmentType, jsonLd, ... }
// fetch() pulls it once per distinct uuid, DETAIL_BATCH at a time, at most
// MAX_DETAIL_REQUESTS per board. Unlike smartrecruiters/vdab this is not an
// opt-in, because a posting with no date or text is invisible to --since and
// content_filter. Cost scales with the board: one GET per distinct posting
// (measured: Kai 20 postings ~1.1–1.5 s, Comp AI / just-appraised-jobs ~0.3–0.4 s;
// Rippling's own board, 330 postings, ~9 s). A board past the cap is enriched
// in list order — roughly alphabetical by title on the live boards — so its
// remaining postings stay undated and description-less, and the cap line on
// stderr says how many.
// Enrichment only — a detail that fails or is malformed leaves the list-level
// posting exactly as it was, and the whole step is skipped while a caller is
// probing (ctx.maxPages set, as verify-portals does).
//
// The careers host (`ats.rippling.com`) and the API host (`api.rippling.com`)
// are both fixed; the per-tenant slug and the posting uuid are the only
// variable parts. Both are constrained to safe tokens before interpolation so
// they cannot inject extra path segments, a query, or traversal into the API URL.

import { htmlToText, FULL_DESCRIPTION_CAP } from './_html-to-text.mjs';

const CAREERS_HOST = 'ats.rippling.com';
const API_HOST = 'api.rippling.com';
const API_BASE = `https://${API_HOST}/platform/api/ats/v1/board`;
const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const UUID_RE = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

// Detail GETs in flight at once — same small-batch politeness as
// smartrecruiters/vdab, so a board cannot burst the shared API host.
const DETAIL_BATCH = 4;
// Detail GETs one board may spend (one per distinct uuid, no retries). Same
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

/** Build the board API URL for a validated slug. */
function apiUrlForSlug(slug) {
  return `${API_BASE}/${encodeURIComponent(slug)}/jobs`;
}

/** Build the posting-detail API URL for a validated slug + uuid. */
function detailUrlFor(slug, uuid) {
  return `${apiUrlForSlug(slug)}/${encodeURIComponent(uuid)}`;
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
  if (parsed.hostname !== API_HOST) {
    throw new Error(`rippling: untrusted hostname "${parsed.hostname}" — must be ${API_HOST}`);
  }
  return url;
}

/** @type {Provider} */
export default {
  id: 'rippling',

  detect(entry) {
    const slug = resolveSlug(entry);
    return slug ? { url: apiUrlForSlug(slug) } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`rippling: cannot derive API URL for ${entry.name}`);
    const apiUrl = apiUrlForSlug(slug);
    assertRipplingApiUrl(apiUrl);
    // redirect:'error' prevents SSRF via server-side redirects
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    const rows = parseRipplingRows(json, entry.name);

    // Detail enrichment answers "what does this job say", not "is this
    // endpoint alive" — skip it entirely while probing (same rule as
    // smartrecruiters/vdab/workday), so the probe stays at one request.
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    if (probing) return rows.map((r) => r.job);

    // One GET per distinct uuid: the list repeats a posting once per location
    // row, and every row of it gets the same detail.
    const uuids = [...new Set(rows.map((r) => r.uuid).filter(Boolean))];
    const pending = uuids.slice(0, MAX_DETAIL_REQUESTS);
    /** @type {Map<string, any>} */
    const details = new Map();
    let failed = 0;
    for (let i = 0; i < pending.length; i += DETAIL_BATCH) {
      const batch = pending.slice(i, i + DETAIL_BATCH);
      await Promise.all(batch.map(async (uuid) => {
        try {
          const detailUrl = detailUrlFor(slug, uuid);
          assertRipplingApiUrl(detailUrl);
          const detail = await ctx.fetchJson(detailUrl, { redirect: 'error' });
          // A document for some other posting (or not a document at all) is
          // malformed — merging it would put another job's text on this one.
          if (!isPlainObject(detail) || (detail.uuid != null && detail.uuid !== uuid)) {
            failed++;
            return;
          }
          details.set(uuid, detail);
        } catch {
          // Detail fetch is an enrichment only. Keep the listing result.
          failed++;
        }
      }));
    }

    if (failed > 0 || uuids.length > pending.length) {
      const unreadable = failed > 0 ? `, ${failed} detail document(s) unreadable` : '';
      const capped = uuids.length > pending.length
        ? `, ${uuids.length - pending.length} left undetailed by the ${MAX_DETAIL_REQUESTS}-request cap`
        : '';
      console.error(`ℹ️  rippling: ${entry.name} enriched ${details.size} of ${uuids.length} posting(s)${unreadable}${capped}`);
    }

    return rows.map((r) => {
      const detail = r.uuid ? details.get(r.uuid) : undefined;
      return detail ? mergeRipplingDetail(r.job, detail) : r.job;
    });
  },
};

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Plain-text description from a detail document. `description` is observed as
 * an object of HTML sections (`{ company, role }`); the role section goes
 * first so the requirements survive the cap, then any other section, then the
 * company boilerplate. A bare HTML string is accepted as-is. Joined like
 * lever's fullDescription (one line per section, then the overall cap).
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
 * List rows as `{ job, uuid }` — parseRipplingResponse plus the posting uuid
 * fetch() needs for the detail GET. `uuid` is '' when absent or not a clean
 * UUID, which leaves that posting un-enriched rather than dropped.
 * @param {any} json
 * @param {string} companyName
 * @returns {Array<{job: {title: string, url: string, company: string, location: string}, uuid: string}>}
 */
function parseRipplingRows(json, companyName) {
  if (!Array.isArray(json)) return [];
  /** @type {Array<{job: {title: string, url: string, company: string, location: string}, uuid: string}>} */
  const rows = [];
  for (const j of json) {
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

    const wl = j?.workLocation;
    const location =
      wl && typeof wl === 'object' && typeof wl.label === 'string'
        ? wl.label.trim()
        : typeof wl === 'string'
          ? wl.trim()
          : '';

    const uuid = typeof j?.uuid === 'string' && UUID_RE.test(j.uuid) ? j.uuid : '';
    rows.push({ job: { title, url, location, company: companyName }, uuid });
  }
  return rows;
}

/**
 * Parse a Rippling board API response. Exported for unit tests.
 *
 * The response is a top-level JSON ARRAY of postings. Field mapping → the
 * normalized Job shape:
 *   - title:    `name`, trimmed (postings without one are dropped).
 *   - url:      `url` — an absolute `https:` posting URL host-locked to
 *               `ats.rippling.com` (Rippling always serves postings there, so an
 *               off-host or non-https URL is untrusted and the posting is dropped).
 *               It is the dedup key and is display-only (written to the
 *               pipeline/history, never server-fetched here).
 *   - company:  the portal entry name (the feed is per-tenant and carries no
 *               company field, same as recruitee).
 *   - location: `workLocation.label` (e.g. "Remote (United States)"); falls back
 *               to a bare string `workLocation`, else "".
 *
 * List-level only: description/postedAt/salary come from the per-posting
 * detail document, merged by fetch() via mergeRipplingDetail.
 *
 * @param {any} json
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseRipplingResponse(json, companyName) {
  return parseRipplingRows(json, companyName).map((r) => r.job);
}
