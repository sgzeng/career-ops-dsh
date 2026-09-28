// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// ADP Workforce Now provider — the public "Career Center" (recruitment.html /
// "MyJobs" current-openings widget) of one WFN tenant. Single-company ATS
// adapter: wire it in via a `tracked_companies:` entry.
//
// Auto-detects from a careers_url (or api) on workforcenow.adp.com that carries
// the tenant's `cid` — the public human URL is
//   https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=<cid>&ccId=<ccId>&lang=en_US
// A company site that only EMBEDS the widget
//   <recruitment-current-openings cid='<cid>' ccid='<ccId>' ...>
// can be pointed at the same board without changing careers_url:
//   provider: adp
//   adp: { cid: <cid>, ccId: <ccId> }        # ccId optional, lang optional
// `ccId` picks one career center of the tenant. It is optional, but when the
// careers page names one, keep it: live, one tenant answered 37 postings
// without it and 42 with the ccId its own widget uses (2026-09).
//
// The widget's list call is public, no-auth JSON:
//   GET https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions
//       ?cid=<cid>&ccId=<ccId>&lang=en_US&locale=en_US&$top=20&$skip=<n>
//   → { meta: { startSequence, totalNumber }, jobRequisitions: [ { itemID,
//       requisitionTitle, postDate, requisitionLocations: [ { nameCode:
//       { shortName } , address } ], customFieldGroup: { stringFields: [
//       { nameCode: { codeValue: 'ExternalJobID' }, stringValue } ] }, ... } ] }
// Observed live: `$skip` is 1-BASED (it is echoed back as meta.startSequence;
// `$skip=0` yields one row fewer than `$skip=1`), and the page is clamped to 20
// rows whatever `$top` asks for. An empty board — or a `$skip` past the end — is
// `{ "jobRequisitions": [] }` with no meta; an unknown cid is an HTTP 404.
//
// Job URL: the career center's own share link for the posting, the exact form
// the widget copies to the clipboard (minus its constant `jwId` widget tag):
//   recruitment.html?cid=<cid>&ccId=<ccId>&jobId=<ExternalJobID>&lang=<lang>
// The page is a JS app; opened in a browser it renders that posting (and
// "no longer accepting applications" once it closes). The app loads it via
// job-requisitions/<jobId>, which accepts the itemID too, so a row without an
// ExternalJobID falls back to its itemID rather than being dropped.
//
// The list carries title, location and date but no body. The per-requisition
// document (…/job-requisitions/<itemID>, same query) adds `requisitionDescription`
// (HTML). Like rippling, fetch() pulls it by default — DETAIL_BATCH at a time,
// DETAIL_BATCH_DELAY_MS apart, at most MAX_DETAIL_REQUESTS per board, no
// retries — because content_filter / visa_filter read the JD. It is enrichment
// only: a detail that fails or is malformed leaves the list-level posting as it
// was, the whole step is skipped while probing (ctx.maxPages), and
// `adp: { fetchDetails: false }` turns it off.
//
// Rate limit (observed live 2026-09, not published): workforcenow.adp.com sits
// behind a BigIP that answers `429 Request blocked Exceeded requests limit.`,
// with no Retry-After, once one IP has sent ~200 requests in ~19 s (a 567-row
// tenant: 29 list + 170 detail GETs, unpaced). The block lasts about a minute
// and covers every tenant, so a retry inside it is wasted and the NEXT ADP
// board scanned in that minute fails outright. Hence the lower detail cap, the
// pause between detail batches, and the first detail 429 ending enrichment for
// the board (the list-level postings are all kept). ThreatLocker's 45 requests
// never tripped it.
//
// Every request goes to the fixed host workforcenow.adp.com; the tenant's cid /
// ccId / lang and the per-posting itemID are the only variable parts, each
// charset-checked before interpolation so none can inject a path, a query or
// traversal into the URL.

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { htmlToText, FULL_DESCRIPTION_CAP } from './_html-to-text.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const ADP_HOST = 'workforcenow.adp.com';
const LIST_URL = `https://${ADP_HOST}/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions`;
const POSTING_PAGE = `https://${ADP_HOST}/mascsr/default/mdf/recruitment/recruitment.html`;
// Both the human career center and its API live under this prefix; a
// workforcenow.adp.com URL elsewhere (the employee login) is not a board.
const BOARD_PATH_PREFIX = '/mascsr/';

// cid is a GUID on every tenant observed; ccId looks like `19000101_000003`.
const CID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const CCID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LANG_RE = /^[a-z]{2}_[A-Z]{2}$/;
const DEFAULT_LANG = 'en_US';
// itemID (`31303207_1`) goes into the detail path; ExternalJobID (`10675`) into
// the posting link. Anything outside this charset is not trusted as either.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// The server clamps a page to 20 rows (`$top=100` still returns 20).
const PAGE_SIZE = 20;
// 50 × 20 = 1000 postings, well past any single employer's board seen so far
// (ThreatLocker 42, the largest tenant tried 567). Neither constant is tied to
// what the source reports.
const DEFAULT_MAX_PAGES = 50;
const MAX_PAGES_CAP = 250;
const INTER_PAGE_DELAY_MS = 200;

// Detail GETs in flight at once (rippling's batch size), the pause between
// batches, and the most one board may spend. Half rippling's 200 ceiling: even
// a full 50-page walk then stays at ≤ 150 requests, paced, well under the ~200
// in ~19 s that drew ADP's 429 (see the header).
const DETAIL_BATCH = 4;
const DETAIL_BATCH_DELAY_MS = 300;
const MAX_DETAIL_REQUESTS = 100;

// A postDate more than a year ahead is a bad value, not a posting date (same
// bound as rippling / local-parser).
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * @typedef {object} AdpBoard
 * @property {string} cid
 * @property {string} ccId  '' when the entry names no career center
 * @property {string} lang
 */

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
 * First value of a query parameter, matched case-insensitively (the share link
 * spells it `ccId`, the embed tag `ccid`).
 * @param {URL} parsed
 * @param {string} name lower-case
 */
function queryParam(parsed, name) {
  for (const [k, v] of parsed.searchParams) {
    if (k.toLowerCase() === name) return v.trim();
  }
  return '';
}

/**
 * Board coordinates from a workforcenow.adp.com career-center or API URL, or
 * null for anything else (other host, non-https, outside /mascsr/, no valid
 * cid, an unsafe ccId). Never throws.
 * @param {unknown} raw
 * @returns {AdpBoard|null}
 */
function boardFromUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== ADP_HOST) return null;
  if (!parsed.pathname.startsWith(BOARD_PATH_PREFIX)) return null;
  return boardFromParts(queryParam(parsed, 'cid'), queryParam(parsed, 'ccid'), queryParam(parsed, 'lang'));
}

/**
 * Validate cid / ccId / lang. An invalid lang falls back to en_US (it only
 * picks the language of the page); an invalid cid or ccId rejects the board.
 * @param {unknown} cid @param {unknown} ccId @param {unknown} lang
 * @returns {AdpBoard|null}
 */
function boardFromParts(cid, ccId, lang) {
  const c = typeof cid === 'string' ? cid.trim() : '';
  if (!CID_RE.test(c)) return null;
  const cc = typeof ccId === 'string' ? ccId.trim() : '';
  if (cc && !CCID_RE.test(cc)) return null;
  const l = typeof lang === 'string' && LANG_RE.test(lang.trim()) ? lang.trim() : DEFAULT_LANG;
  return { cid: c, ccId: cc, lang: l };
}

/**
 * Board for a portals.yml entry: an explicit `adp: { cid, ccId, lang }` block
 * first (for a branded careers_url that only embeds the widget), then
 * careers_url, then api.
 * @param {any} entry
 * @returns {AdpBoard|null}
 */
function resolveBoard(entry) {
  const block = isPlainObject(entry?.adp) ? entry.adp : null;
  if (block && block.cid != null) {
    return boardFromParts(block.cid, block.ccId ?? block.ccid, block.lang);
  }
  return boardFromUrl(entry?.careers_url) || boardFromUrl(entry?.api);
}

/** Shared tenant query string; every part is charset-validated. */
function boardQuery(board) {
  return `cid=${board.cid}${board.ccId ? `&ccId=${board.ccId}` : ''}&lang=${board.lang}&locale=${board.lang}`;
}

/** List API URL for a validated board; `skip` is the 1-based start row. */
function listUrlFor(board, skip) {
  return `${LIST_URL}?${boardQuery(board)}&$top=${PAGE_SIZE}&$skip=${skip}`;
}

/** Per-requisition API URL; `itemID` must already match ID_RE. */
function detailUrlFor(board, itemID) {
  return `${LIST_URL}/${itemID}?${boardQuery(board)}`;
}

/** @param {string} url */
function assertAdpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`adp: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`adp: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== ADP_HOST) {
    throw new Error(`adp: untrusted hostname "${parsed.hostname}" — must be ${ADP_HOST}`);
  }
  return url;
}

/**
 * The career center's share link for one posting, or null when the id cannot
 * be encoded (lone surrogate → drop the posting).
 * @param {AdpBoard} board
 * @param {string} jobId
 */
function postingUrlFor(board, jobId) {
  const seg = safeEncodeURIComponent(jobId);
  if (seg === null) return null;
  return `${POSTING_PAGE}?cid=${board.cid}${board.ccId ? `&ccId=${board.ccId}` : ''}&jobId=${seg}&lang=${board.lang}`;
}

/**
 * Epoch ms from an ADP `postDate` (`2026-09-24T17:00:00.000-04:00`), or
 * undefined. The time must state its offset — without one Date.parse reads it
 * as the scanning machine's local time. NaN, non-positive and far-future values
 * are dropped.
 * @param {unknown} raw
 * @returns {number|undefined}
 */
function toEpochMs(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/.test(trimmed)) return undefined;
  return boundedMs(Date.parse(trimmed));
}

/**
 * Epoch ms (UTC midnight) of the DATE part of the `PostingDate` custom field,
 * or undefined. Only the date is trusted: its `Z` is a mislabel — live, every
 * row's `2026-09-24T17:00Z` is the same wall-clock as its postDate
 * `2026-09-24T17:00:00.000-04:00` (US-Eastern; CurrentServerDateTime is skewed
 * the same way), so reading the time as UTC would land 4-5 h early.
 * @param {unknown} raw
 * @returns {number|undefined}
 */
function postingDateMs(raw) {
  if (typeof raw !== 'string') return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(raw.trim());
  return m ? boundedMs(Date.parse(m[1])) : undefined;
}

/** @param {number} ms @returns {number|undefined} */
function boundedMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0 || ms > Date.now() + MAX_FUTURE_MS) return undefined;
  return ms;
}

/**
 * A named value out of `customFieldGroup.<group>[]` (matched on
 * `nameCode.codeValue`), or undefined.
 * @param {any} r
 * @param {'stringFields'|'dateFields'} group
 * @param {string} code
 * @param {'stringValue'|'dateValue'} key
 */
function customField(r, group, code, key) {
  const fields = r?.customFieldGroup?.[group];
  if (!Array.isArray(fields)) return undefined;
  for (const f of fields) {
    if (isPlainObject(f) && f.nameCode?.codeValue === code) return f[key];
  }
  return undefined;
}

/**
 * Display location of a requisition: every `requisitionLocations[].nameCode.shortName`
 * (trimmed — ADP pads it: " Orlando, FL, US"), de-duplicated, joined with '; '.
 * A location with no shortName is assembled from its address (city, state).
 * @param {unknown} locations
 */
function locationOf(locations) {
  if (!Array.isArray(locations)) return '';
  /** @type {string[]} */
  const out = [];
  for (const l of locations) {
    if (!isPlainObject(l)) continue;
    let name = typeof l.nameCode?.shortName === 'string' ? l.nameCode.shortName.trim() : '';
    if (!name && isPlainObject(l.address)) {
      const a = l.address;
      name = [a.cityName, a.countrySubdivisionLevel1?.codeValue, a.country?.codeValue ?? a.countryCode]
        .filter((v) => typeof v === 'string' && v.trim())
        .map((v) => v.trim())
        .join(', ');
    }
    if (name && !out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out.join('; ');
}

/**
 * Normalize one list row into `{ job, itemID }`, or null to drop it. itemID is
 * '' when absent or unsafe, which leaves the posting un-enriched, not dropped.
 * @param {unknown} r
 * @param {AdpBoard} board
 * @param {string} companyName
 * @returns {{job: {title: string, url: string, company: string, location: string, postedAt?: number}, itemID: string}|null}
 */
function normalizeRow(r, board, companyName) {
  if (!isPlainObject(r)) return null;
  const title = typeof r.requisitionTitle === 'string' ? r.requisitionTitle.trim() : '';
  if (!title) return null;

  const itemID = typeof r.itemID === 'string' && ID_RE.test(r.itemID.trim()) ? r.itemID.trim() : '';
  const rawExternal = customField(r, 'stringFields', 'ExternalJobID', 'stringValue');
  const external = typeof rawExternal === 'string' || typeof rawExternal === 'number' ? String(rawExternal).trim() : '';
  const jobId = ID_RE.test(external) ? external : itemID;
  if (!jobId) return null;
  const url = postingUrlFor(board, jobId);
  if (!url) return null;

  /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}} */
  const job = { title, url, company: companyName, location: locationOf(r.requisitionLocations) };
  const postedAt = toEpochMs(r.postDate) ?? postingDateMs(customField(r, 'dateFields', 'PostingDate', 'dateValue'));
  if (postedAt !== undefined) job.postedAt = postedAt;
  return { job, itemID };
}

/**
 * `jobRequisitions` of one page. Empty / contentless bodies (`null`, `{}`,
 * `[]`, `{ jobRequisitions: null }`) → []. A body that is recognisably not this
 * endpoint's shape throws, naming what it got, so an API change surfaces
 * instead of reading as an empty board forever.
 * @param {unknown} json
 * @returns {unknown[]}
 */
function requisitionsOf(json) {
  if (json == null) return [];
  if (Array.isArray(json)) {
    if (json.length === 0) return [];
    throw new Error('adp: unexpected API response — expected { jobRequisitions: [...] }, got a top-level array');
  }
  if (!isPlainObject(json)) {
    throw new Error(`adp: unexpected API response — expected { jobRequisitions: [...] }, got ${typeof json}`);
  }
  const reqs = json.jobRequisitions;
  if (Array.isArray(reqs)) return reqs;
  if (reqs === null || (reqs === undefined && Object.keys(json).length === 0)) return [];
  throw new Error(
    `adp: unexpected API response — expected { jobRequisitions: [...] }, got keys: [${Object.keys(json).join(', ')}]`,
  );
}

/**
 * Parse one job-requisitions page. Exported for unit tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `requisitionTitle`, trimmed (rows without one are dropped).
 *   - url:      the career center's share link, `recruitment.html?cid=…&ccId=…
 *               &jobId=<ExternalJobID>&lang=…` on workforcenow.adp.com, falling
 *               back to the itemID; a row with neither is dropped. Built from
 *               the validated board, so it is always on the ADP host.
 *   - company:  the portal entry name (the feed is per-tenant and names no
 *               employer per row).
 *   - location: `requisitionLocations[].nameCode.shortName`, trimmed, joined '; '.
 *   - postedAt: `postDate` (offset-bearing ISO), else the DATE of the
 *               `PostingDate` custom field (UTC midnight — its time is
 *               mislabelled Z); omitted when unusable.
 *
 * @param {unknown} json
 * @param {AdpBoard} board
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseAdpResponse(json, board, companyName) {
  return requisitionsOf(json)
    .map((r) => normalizeRow(r, board, companyName))
    .filter((row) => row !== null)
    .map((row) => /** @type {NonNullable<typeof row>} */ (row).job);
}

/**
 * Merge a per-requisition document into a list-level job. Exported for unit
 * tests. Pure: returns a new object and never mutates `job`.
 *   - description: `requisitionDescription` as plain text, capped at
 *                  FULL_DESCRIPTION_CAP; omitted when empty.
 *   - postedAt:    the detail's `postDate`, only when the list had none.
 * A detail that is not an object returns `job` unchanged.
 * @param {{title: string, url: string, company: string, location: string, postedAt?: number}} job
 * @param {unknown} detail
 */
export function mergeAdpDetail(job, detail) {
  if (!isPlainObject(detail)) return job;
  /** @type {any} */
  const out = { ...job };
  const description = htmlToText(detail.requisitionDescription, FULL_DESCRIPTION_CAP);
  if (description) out.description = description;
  if (out.postedAt === undefined) {
    const postedAt = toEpochMs(detail.postDate);
    if (postedAt !== undefined) out.postedAt = postedAt;
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'adp',

  detect(entry) {
    // URL shapes only — a branded careers_url that merely embeds the widget
    // needs an explicit `provider: adp` + `adp: { cid }`.
    const board = boardFromUrl(entry?.careers_url) || boardFromUrl(entry?.api);
    return board ? { url: listUrlFor(board, 1) } : null;
  },

  async fetch(entry, ctx) {
    const board = resolveBoard(entry);
    if (!board) throw new Error(`adp: cannot derive a Workforce Now board (cid) for ${entry?.name}`);
    const companyName = typeof entry?.name === 'string' ? entry.name : '';

    const maxPages = resolveMaxPages(entry);
    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const probing = ctxCap !== Infinity;
    const pagesToFetch = Math.min(maxPages, ctxCap);

    /** @type {Map<string, {job: any, itemID: string}>} keyed by job url */
    const byUrl = new Map();
    const seenItems = new Set();
    let skip = 1;
    /** @type {number|null} */
    let total = null;
    // 'more' = the loop ran out of pages with the board not yet exhausted.
    let stopReason = 'more';
    let page = 0;
    for (; page < pagesToFetch; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = assertAdpUrl(listUrlFor(board, skip));
      let reqs;
      let json;
      try {
        // redirect:'error' prevents SSRF via server-side redirects
        json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' });
        reqs = requisitionsOf(json);
      } catch (err) {
        // The first page failing is a broken board; while probing, the
        // rejection must reach verify-portals unwrapped. Past that, keep what
        // the earlier pages gave.
        if (page === 0 || probing) throw err;
        const attempts = /** @type {any} */ (err)?.attempts ?? 1;
        console.error(`⚠️  adp: ${entry.name} stopped at page ${page + 1} after ${attempts} attempt(s) — keeping ${byUrl.size} posting(s): ${/** @type {any} */ (err)?.message}`);
        stopReason = 'fetch-error';
        break;
      }
      const reported = /** @type {any} */ (json)?.meta?.totalNumber;
      if (total === null && Number.isInteger(reported) && reported >= 0) total = reported;

      let fresh = 0;
      for (const r of reqs) {
        const id = isPlainObject(r) && typeof r.itemID === 'string' ? r.itemID : null;
        if (id !== null) {
          if (seenItems.has(id)) continue;
          seenItems.add(id);
        }
        fresh++;
        const row = normalizeRow(r, board, companyName);
        if (row && !byUrl.has(row.job.url)) byUrl.set(row.job.url, row);
      }

      // Stop at the end of the board: an empty page, a page that only repeated
      // rows already seen (a server ignoring $skip), past the reported total,
      // or — when no total was reported — a short page.
      if (reqs.length === 0 || fresh === 0) { stopReason = 'complete'; break; }
      skip += reqs.length;
      if (total !== null ? skip > total : reqs.length < PAGE_SIZE) { stopReason = 'complete'; break; }
    }
    if (stopReason === 'more' && !probing && page === maxPages) {
      console.error(`⚠️  adp: ${entry.name} truncated at max_pages=${maxPages} (${byUrl.size}${total !== null ? ` of ${total}` : ''} postings) — raise max_pages on this entry for more`);
    }

    const rows = [...byUrl.values()];
    // Detail enrichment answers "what does this job say", not "is this board
    // alive" — skip it while probing so the probe stays at one request.
    if (probing || entry?.adp?.fetchDetails === false) return rows.map((r) => r.job);

    const itemIDs = [...new Set(rows.map((r) => r.itemID).filter(Boolean))];
    const pending = itemIDs.slice(0, MAX_DETAIL_REQUESTS);
    /** @type {Map<string, any>} */
    const details = new Map();
    let failed = 0;
    let requested = 0;
    let rateLimited = false;
    for (let i = 0; i < pending.length && !rateLimited; i += DETAIL_BATCH) {
      if (i > 0) await sleep(DETAIL_BATCH_DELAY_MS, ctx);
      const batch = pending.slice(i, i + DETAIL_BATCH);
      requested += batch.length;
      await Promise.all(batch.map(async (itemID) => {
        try {
          const detailUrl = assertAdpUrl(detailUrlFor(board, itemID));
          const detail = await ctx.fetchJson(detailUrl, { redirect: 'error' });
          // An unknown id comes back 200 with an itemID-less stub; a document
          // for another requisition would put someone else's JD on this job.
          if (!isPlainObject(detail) || detail.itemID !== itemID) {
            failed++;
            return;
          }
          details.set(itemID, detail);
        } catch (err) {
          // Enrichment only — keep the list-level posting. A 429 is ADP's
          // per-IP block (see the header): stop asking after this batch.
          if (/** @type {any} */ (err)?.status === 429) rateLimited = true;
          failed++;
        }
      }));
    }

    if (failed > 0 || itemIDs.length > pending.length) {
      const unreadable = failed > 0 ? `, ${failed} detail document(s) unreadable` : '';
      const stopped = rateLimited
        ? `, stopped by an HTTP 429 (ADP rate limit) with ${pending.length - requested} not requested`
        : '';
      const capped = itemIDs.length > pending.length
        ? `, ${itemIDs.length - pending.length} left undetailed by the ${MAX_DETAIL_REQUESTS}-request cap`
        : '';
      console.error(`ℹ️  adp: ${entry.name} enriched ${details.size} of ${itemIDs.length} posting(s)${unreadable}${stopped}${capped}`);
    }

    return rows.map((r) => {
      const detail = r.itemID ? details.get(r.itemID) : undefined;
      return detail ? mergeAdpDetail(r.job, detail) : r.job;
    });
  },
};
