// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Dover provider — `tracked_companies:` (one entry per employer). Reads the
// public careers-page API behind app.dover.com, the same JSON the careers page
// and the per-posting apply pages render from: zero-auth, no cookie, plain JSON.
//
// Auto-detects a careers_url on app.dover.com in any of its three public shapes:
//   https://app.dover.com/jobs/<slug>                  careers page — what an
//                                                      employer's "View open
//                                                      roles" button links to
//   https://app.dover.com/<Name>/careers/<client-id>   older careers-page route
//   https://app.dover.com/apply/<Name>/<job-id>        one posting's apply page
// The first is the one to put in portals.yml. The apply-page form resolves the
// board through that one posting, so it stops working when the posting closes.
//
// Endpoints (all GET, observed 2026-09):
//   /api/v1/careers-page-slug/<slug>     → { id, slug, name, ... } (slug match
//                                          is case-insensitive; unknown → 404)
//   /api/v1/careers-page/<client-id>     → the same client document
//   /api/v1/careers-page/<client-id>/jobs?limit=&offset=
//     → Django REST limit/offset envelope { count, next, previous, results: [
//         { id, title, locations: [{ name, location_type, is_primary,
//           location_option: { display_name, city, state, country } }],
//           workplace_type, is_published, is_sample } ] }
//     The careers page renders from /job-groups/<client-id>/job-groups instead;
//     both returned the same posting set on every board compared (Pixee 1,
//     Dover 5, SemiAnalysis 50). This one is paginated and in Dover's OpenAPI
//     client, so it is the one read here.
//   /api/v1/inbound/application-portal-job/<job-id>
//     → { id, client_id, client_name, title, user_provided_description (HTML),
//         created, compensation: { lower_bound, upper_bound, currency_code,
//         salary_range_type, open_to_sharing_comp }, locations, ... } — the
//         document the apply page loads.
//
// Posting URL: https://app.dover.com/apply/<client name>/<job id>/ — the href
// the careers page builds (minus its `?rs=` referral tag). The name segment is
// cosmetic: the apply page loads by job id alone (verified live with a wrong
// name in that segment), so an unusable name falls back to the slug, then to
// the client id, without breaking the link.
//
// The list carries no description, date or pay, so fetch() reads each posting's
// apply-page document once to fill them — bounded enrichment like rippling, and
// skipped while probing (ctx.maxPages). Dover's Cloudflare front is the reason
// the bound is small and sequential: measured 2026-09-27, ~25-30 back-to-back
// requests to these endpoints (also at 400 ms spacing) drew `429` with
// `cf-mitigated: challenge`, cleared within about a minute. So details go one
// at a time, DETAIL_DELAY_MS apart, at most MAX_DETAIL_REQUESTS per board, and
// the first 429/403 (or non-JSON body) ends enrichment for the board instead of
// retrying into the block. An un-enriched posting is kept exactly as listed.
//
// Host pinned to app.dover.com for every request; the slug and both uuids are
// charset-validated before they are interpolated into an API path.

import { htmlToText, FULL_DESCRIPTION_CAP } from './_html-to-text.mjs';
import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const HOST = 'app.dover.com';
const API_BASE = `https://${HOST}/api/v1`;
const APPLY_BASE = `https://${HOST}/apply`;

// Observed slugs: `pixee`, `semianalysis`, `rentok-0ef01d90`. Alnum edges, with
// hyphens/underscores inside — never a dot, slash or percent-escape.
const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;
// Client and job ids are 8-4-4-4-12 hex. Not version-checked: Dover's own
// client id is `733c3162-cbbd-6558-…`, not a v4 uuid.
const UUID_RE = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

// Page size asked for. offset advances by the rows actually returned, so a
// server that clamps `limit` lower cannot make the walk skip postings.
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10; // 1,000 postings — Dover boards are startup-sized
const MAX_PAGES_CAP = 50; // hard ceiling even for an entry's max_pages override
const INTER_PAGE_DELAY_MS = 250;

// Enrichment budget per board (see the header for the measured rate limit).
const MAX_DETAIL_REQUESTS = 15;
const DETAIL_DELAY_MS = 500;

// A `created` more than a year ahead is a bad value, not a posting date — same
// bound rippling.mjs / local-parser.mjs apply.
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

// compensation.salary_range_type → annual multiplier (the enum in Dover's
// OpenAPI client is YEARLY / MONTHLY / HOURLY). Unknown → no salary, never a guess.
const SALARY_MULTIPLIERS = { YEARLY: 1, MONTHLY: 12, HOURLY: 2080 };

// workplace_type values that change where the job can be done. ONSITE (and the
// per-location IN_OFFICE) adds nothing to a place name, so it is not appended.
const WORKPLACE_LABELS = { REMOTE: 'Remote', HYBRID: 'Hybrid' };

// Keys of the DRF envelope — a body carrying only these (or nothing) and no
// results array is an empty board, anything else is an API change.
const ENVELOPE_KEYS = new Set(['count', 'next', 'previous', 'results']);

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} v */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Which board a careers_url names, or null for anything that is not a public
 * app.dover.com careers/apply URL with clean identifiers.
 * @param {import('./_types.js').PortalEntry} entry
 * @returns {{kind: 'slug', slug: string} | {kind: 'client', clientId: string} | {kind: 'job', jobId: string} | null}
 */
function resolveTarget(entry) {
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url.trim() : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== HOST) return null;
  const segs = parsed.pathname.split('/').filter(Boolean);
  if (segs[0] === 'jobs' && segs.length >= 2) {
    return SLUG_RE.test(segs[1]) ? { kind: 'slug', slug: segs[1] } : null;
  }
  if (segs[0] === 'apply' && segs.length >= 3) {
    return UUID_RE.test(segs[2]) ? { kind: 'job', jobId: segs[2].toLowerCase() } : null;
  }
  if (segs[1] === 'careers' && segs.length >= 3) {
    return UUID_RE.test(segs[2]) ? { kind: 'client', clientId: segs[2].toLowerCase() } : null;
  }
  return null;
}

/**
 * The API URL that resolves a target to its client — also detect()'s `url`.
 * @param {NonNullable<ReturnType<typeof resolveTarget>>} target
 */
function resolveUrlFor(target) {
  if (target.kind === 'slug') return `${API_BASE}/careers-page-slug/${encodeURIComponent(target.slug)}`;
  if (target.kind === 'client') return `${API_BASE}/careers-page/${target.clientId}`;
  return `${API_BASE}/inbound/application-portal-job/${target.jobId}`;
}

/** @param {string} clientId @param {number} offset */
function jobsPageUrl(clientId, offset) {
  return `${API_BASE}/careers-page/${clientId}/jobs?limit=${PAGE_SIZE}&offset=${offset}`;
}

/** @param {string} jobId */
function detailUrlFor(jobId) {
  return `${API_BASE}/inbound/application-portal-job/${jobId}`;
}

/** @param {string} url */
function assertDoverApiUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`dover: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`dover: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== HOST) {
    throw new Error(`dover: untrusted hostname "${parsed.hostname}" — must be ${HOST}`);
  }
  return url;
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/**
 * The client a target belongs to: `{ id, name, slug }` plus, for an apply-page
 * target, the posting document that was read to find it (reused as that
 * posting's detail). Throws on a response that names no clean client id — the
 * board cannot be listed without one, and a silent `[]` would read as "no jobs".
 * @param {any} json
 * @param {NonNullable<ReturnType<typeof resolveTarget>>} target
 */
function clientFromResolve(json, target) {
  if (!isPlainObject(json)) {
    throw new Error(`dover: ${target.kind} lookup returned ${Array.isArray(json) ? 'an array' : typeof json}, expected an object`);
  }
  const id = target.kind === 'job' ? str(json.client_id) : str(json.id);
  if (!UUID_RE.test(id)) {
    throw new Error(`dover: ${target.kind} lookup carried no client id (keys: ${Object.keys(json).slice(0, 10).join(', ')})`);
  }
  return {
    id: id.toLowerCase(),
    name: target.kind === 'job' ? str(json.client_name) : str(json.name),
    slug: target.kind === 'job' ? '' : str(json.slug),
    seedDetail: target.kind === 'job' ? json : null,
  };
}

/**
 * Rows and continuation of one jobs page. Exported for unit tests.
 *
 * `null`, `{}`, `[]`, `{ results: null }` and a bare envelope with no results
 * are an empty board. A body that is recognisably not the DRF envelope (a
 * non-empty array, a non-array `results`, unrelated keys) throws, naming what
 * it got, so an API change surfaces instead of a board that returns 0 forever.
 *
 * @param {any} json
 * @returns {{rows: any[], hasNext: boolean, count: number|null}}
 */
export function readDoverJobsPage(json) {
  const empty = { rows: [], hasNext: false, count: null };
  if (json == null) return empty;
  if (Array.isArray(json)) {
    if (json.length === 0) return empty;
    throw new Error(`dover: jobs response is an array of ${json.length}, expected a { count, next, results } envelope`);
  }
  if (!isPlainObject(json)) throw new Error(`dover: jobs response is ${typeof json}, expected an object`);
  if (json.results == null) {
    const keys = Object.keys(json);
    if (keys.every((k) => ENVELOPE_KEYS.has(k))) return empty;
    throw new Error(`dover: jobs response has no results array (keys: ${keys.slice(0, 10).join(', ')})`);
  }
  if (!Array.isArray(json.results)) {
    throw new Error(`dover: jobs response results is ${typeof json.results}, expected an array`);
  }
  const count = Number.isInteger(json.count) && json.count >= 0 ? json.count : null;
  return { rows: json.results, hasNext: typeof json.next === 'string' && json.next.trim() !== '', count };
}

/**
 * Location string for a list row. Exported for unit tests.
 *
 * Place names (`location_option.display_name`, else `name`) in the careers
 * page's order — primary first — deduped and joined with "; ", then the work
 * model appended when it widens where the job can be done:
 *   Baltimore, MD (Hybrid) · United States (Remote) · Remote (no place given).
 * `display_name` already carries the country outside the US ("Paris, France")
 * and "City, ST" inside it. The job-level `workplace_type` is the one the
 * careers page shows; when absent, the per-location `location_type` is used
 * only if every location agrees. ONSITE / IN_OFFICE append nothing.
 *
 * @param {any} row
 * @returns {string}
 */
export function formatDoverLocation(row) {
  const locs = Array.isArray(row?.locations) ? row.locations.filter(isPlainObject) : [];
  const ordered = [...locs.filter((l) => l.is_primary === true), ...locs.filter((l) => l.is_primary !== true)];
  /** @type {string[]} */
  const names = [];
  for (const l of ordered) {
    const opt = isPlainObject(l.location_option) ? l.location_option : {};
    const name = str(opt.display_name) || str(l.name);
    if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  let wt = str(row?.workplace_type).toUpperCase();
  if (!wt) {
    const types = new Set(locs.map((l) => str(l.location_type).toUpperCase()).filter(Boolean));
    if (types.size === 1) wt = [...types][0];
  }
  const label = Object.hasOwn(WORKPLACE_LABELS, wt)
    ? WORKPLACE_LABELS[/** @type {keyof typeof WORKPLACE_LABELS} */ (wt)]
    : '';
  const place = names.join('; ');
  if (!label) return place;
  if (!place) return label;
  if (place.toLowerCase().includes(label.toLowerCase())) return place;
  return `${place} (${label})`;
}

/**
 * List rows → `{ id, job }`. Exported for unit tests.
 *
 *   - title:    `title`, trimmed; rows without one are dropped.
 *   - url:      `${APPLY_BASE}/<urlSegment>/<id>/` — `id` must be a clean uuid
 *               (else the row is dropped: it is the dedup key and the detail key).
 *   - company:  the portal entry name (the list carries none per row).
 *   - location: formatDoverLocation().
 * `is_sample: true` (Dover's placeholder postings) and `is_published: false`
 * rows are dropped; a non-object row is skipped, never fatal.
 *
 * @param {any[]} rows
 * @param {string} companyName
 * @param {string} urlSegment  already-encoded client segment of the apply URL
 * @returns {Array<{id: string, job: {title: string, url: string, company: string, location: string}}>}
 */
export function parseDoverRows(rows, companyName, urlSegment) {
  if (!Array.isArray(rows)) return [];
  /** @type {Array<{id: string, job: {title: string, url: string, company: string, location: string}}>} */
  const out = [];
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    if (row.is_sample === true || row.is_published === false) continue;
    const rawId = str(row.id);
    if (!UUID_RE.test(rawId)) continue;
    const id = rawId.toLowerCase();
    const title = str(row.title);
    if (!title) continue;
    out.push({
      id,
      job: { title, url: `${APPLY_BASE}/${urlSegment}/${id}/`, company: companyName, location: formatDoverLocation(row) },
    });
  }
  return out;
}

/**
 * The apply URL's client segment, as the careers page builds it from the client
 * name. Encoded via safeEncodeURIComponent (the name is host-controlled); an
 * absent or unencodable name falls back to the slug, then the client id — the
 * segment is cosmetic, so any of them opens the same posting.
 * @param {{id: string, name: string, slug: string}} client
 */
function urlSegmentFor(client) {
  const byName = client.name ? safeEncodeURIComponent(client.name) : null;
  if (byName) return byName;
  if (client.slug && SLUG_RE.test(client.slug)) return client.slug;
  return client.id;
}

/**
 * Epoch ms from `created` (observed `2026-09-22T20:22:56.231573Z`), or
 * undefined. Offset-bearing ISO only — without one Date.parse would read the
 * scanning machine's local time. NaN, non-positive and far-future dropped.
 * @param {unknown} raw
 * @returns {number|undefined}
 */
function postedAtFromCreated(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) return undefined;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms) || ms <= 0 || ms > Date.now() + MAX_FUTURE_MS) return undefined;
  return ms;
}

/**
 * Annualized salary from a posting's `compensation`, or null. Only when the
 * employer chose to show it (`open_to_sharing_comp: true` — the apply page
 * displays the range exactly then) and at least one bound is a positive number.
 * @param {unknown} comp
 * @returns {{min: number, max: number, currency: string}|null}
 */
function salaryFromCompensation(comp) {
  if (!isPlainObject(comp) || comp.open_to_sharing_comp !== true) return null;
  const type = str(comp.salary_range_type).toUpperCase();
  if (!Object.hasOwn(SALARY_MULTIPLIERS, type)) return null;
  const multiplier = SALARY_MULTIPLIERS[/** @type {keyof typeof SALARY_MULTIPLIERS} */ (type)];
  /** @param {unknown} v */
  const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const lo = positive(comp.lower_bound);
  const hi = positive(comp.upper_bound);
  if (lo == null && hi == null) return null;
  const a = /** @type {number} */ (lo ?? hi) * multiplier;
  const b = /** @type {number} */ (hi ?? lo) * multiplier;
  return { min: Math.min(a, b), max: Math.max(a, b), currency: str(comp.currency_code).toUpperCase() };
}

/**
 * Merge a posting's apply-page document into its list-level job. Exported for
 * unit tests. Pure: returns a new object, never mutates `job`.
 *
 *   - description: `user_provided_description` (HTML) as plain text, capped at
 *                  FULL_DESCRIPTION_CAP; omitted when empty.
 *   - postedAt:    from `created`; omitted when unusable.
 *   - salary:      salaryFromCompensation(); omitted when none.
 *
 * @param {{title: string, url: string, company: string, location: string}} job
 * @param {unknown} detail
 */
export function mergeDoverDetail(job, detail) {
  if (!isPlainObject(detail)) return job;
  /** @type {any} */
  const out = { ...job };
  const description = htmlToText(detail.user_provided_description, FULL_DESCRIPTION_CAP);
  if (description) out.description = description;
  const postedAt = postedAtFromCreated(detail.created);
  if (postedAt !== undefined) out.postedAt = postedAt;
  const salary = salaryFromCompensation(detail.compensation);
  if (salary) out.salary = salary;
  return out;
}

/** @type {Provider} */
export default {
  id: 'dover',

  detect(entry) {
    const target = resolveTarget(entry);
    return target ? { url: resolveUrlFor(target) } : null;
  },

  async fetch(entry, ctx) {
    const target = resolveTarget(entry);
    if (!target) throw new Error(`dover: cannot derive a board from careers_url for ${entry?.name}`);
    const probing = Number.isInteger(ctx?.maxPages) && /** @type {number} */ (ctx.maxPages) > 0;

    // 1. Resolve the client (id + name). A 404 here is a board that is gone —
    //    it propagates, so verify-portals reports it as missing.
    const resolveUrl = assertDoverApiUrl(resolveUrlFor(target));
    // redirect:'error' prevents SSRF via server-side redirects
    const client = clientFromResolve(await fetchJsonWithRetry(ctx, resolveUrl, { redirect: 'error' }), target);
    const urlSegment = urlSegmentFor(client);

    // 2. Walk the jobs pages.
    const maxPages = resolveMaxPages(entry);
    const pagesToFetch = probing ? Math.min(maxPages, /** @type {number} */ (ctx.maxPages)) : maxPages;
    /** @type {Map<string, {title: string, url: string, company: string, location: string}>} */
    const byId = new Map();
    let offset = 0;
    let more = false;
    let stoppedOnError = false;
    let page = 0;
    for (; page < pagesToFetch; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const pageUrl = assertDoverApiUrl(jobsPageUrl(client.id, offset));
      let json;
      try {
        json = await fetchJsonWithRetry(ctx, pageUrl, { redirect: 'error' });
      } catch (err) {
        // Page 1 failing is the board failing; while probing, propagate as-is
        // so ProbePageBudgetReached keeps its identity. A later page in a real
        // scan keeps what was collected and says so.
        if (page === 0 || probing) throw err;
        const attempts = /** @type {any} */ (err)?.attempts ?? 1;
        console.error(`⚠️  dover: ${entry.name} truncated at page ${page + 1} after ${attempts} attempt(s) (${byId.size} postings kept): ${/** @type {Error} */ (err).message}`);
        stoppedOnError = true;
        break;
      }
      const { rows, hasNext, count } = readDoverJobsPage(json);
      for (const { id, job } of parseDoverRows(rows, entry.name, urlSegment)) {
        if (!byId.has(id)) byId.set(id, job);
      }
      offset += rows.length;
      more = hasNext && rows.length > 0 && (count == null || offset < count);
      if (!more) break;
    }
    if (more && !stoppedOnError && !probing && page >= maxPages) {
      console.error(`⚠️  dover: ${entry.name} truncated at max_pages=${maxPages} (${byId.size} postings) — raise max_pages on this entry for more`);
    }

    // 3. Enrichment answers "what does this job say", not "is this board
    //    alive" — skipped entirely while probing.
    if (probing || byId.size === 0) return [...byId.values()];

    /** @type {Map<string, Record<string, any>>} */
    const details = new Map();
    if (client.seedDetail && byId.has(str(client.seedDetail.id).toLowerCase())) {
      details.set(str(client.seedDetail.id).toLowerCase(), client.seedDetail);
    }
    const pending = [...byId.keys()].filter((id) => !details.has(id));
    const budgeted = pending.slice(0, MAX_DETAIL_REQUESTS);
    let failed = 0;
    let firstFailure = '';
    let blockedBy = '';
    for (let i = 0; i < budgeted.length; i++) {
      const id = budgeted[i];
      if (i > 0) await sleep(DETAIL_DELAY_MS, ctx);
      try {
        const detailUrl = assertDoverApiUrl(detailUrlFor(id));
        const detail = await ctx.fetchJson(detailUrl, { redirect: 'error' });
        // Another posting's document (or no document) would put the wrong
        // text on this job — treat it as unreadable.
        if (!isPlainObject(detail) || str(detail.id).toLowerCase() !== id) {
          failed++;
          firstFailure ||= 'not this posting\'s document';
          continue;
        }
        details.set(id, detail);
      } catch (err) {
        // Enrichment only: keep the list-level posting. A 429/403 is the
        // Cloudflare rate limit, and a body that is not JSON at all is how
        // its challenge page reads if served with a 2xx — stop here rather
        // than dig the block deeper.
        const status = /** @type {any} */ (err)?.status;
        if (status === 429 || status === 403 || err instanceof SyntaxError) {
          blockedBy = status ? `HTTP ${status}` : 'a non-JSON body';
          break;
        }
        failed++;
        firstFailure ||= String(/** @type {any} */ (err)?.message || err).slice(0, 80);
      }
    }

    const total = byId.size;
    if (details.size < total) {
      const parts = [];
      if (failed > 0) parts.push(`${failed} detail document(s) unreadable (first: ${firstFailure})`);
      if (blockedBy) parts.push(`stopped at a rate limit (${blockedBy})`);
      if (pending.length > budgeted.length) parts.push(`${pending.length - budgeted.length} left undetailed by the ${MAX_DETAIL_REQUESTS}-request cap`);
      console.error(`ℹ️  dover: ${entry.name} enriched ${details.size} of ${total} posting(s)${parts.length ? `, ${parts.join(', ')}` : ''}`);
    }

    return [...byId.entries()].map(([id, job]) => {
      const detail = details.get(id);
      return detail ? mergeDoverDetail(job, detail) : job;
    });
  },
};
