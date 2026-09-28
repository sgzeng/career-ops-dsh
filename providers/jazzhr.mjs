// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
/** @typedef {import('./_types.js').Job} Job */

// JazzHR provider — reads a tenant's public career page on applytojob.com.
// Single-company ATS adapter, wired in through a `tracked_companies:` entry.
// Auto-detects from a careers_url like `https://<tenant>.applytojob.com/apply`
// (any path on the tenant host; the board is always read at /apply).
//
// Source choice (measured 2026-09). JazzHR has no public JSON board feed:
//   - the authenticated REST API (api.resumatorapi.com) needs a customer key;
//   - `<tenant>.applytojob.com/apply/jobs/feed` answers 302 → app.applytojob.com/notfound.html;
//   - the embeddable widget `app.jazz.co/widgets/basic/create/<tenant>` is a
//     JavaScript file wrapping the same title/location/department/link HTML
//     (no description, no posting date), on a second host.
// The career page itself is server-rendered and lists every open posting in
// one response — no pagination (the largest board sampled rendered 570
// postings on one page), no auth, and the default fetch User-Agent is served.
// Each posting is:
//
//   <li class="list-group-item">
//     <h3 class='list-group-item-heading'>
//       <a href="https://<tenant>.applytojob.com/apply/<id>/<Title-Slug>">Title</a>
//     </h3>
//     <ul class='list-inline list-group-item-text'>
//       <li><i class='fa fa-map-marker'></i>Kansas City, MO</li>
//       <li><i class='fa fa-sitemap'></i>Construction</li>      (department, optional)
//     </ul>
//   </li>
//
// Field mapping: title from the anchor, url = the anchor's /apply/<id>/<slug>
// link rebuilt on the pinned tenant host, location from the map-marker item,
// company = the portal entry name. The department item has no slot in the Job
// contract and is not carried. An active board with nothing posted keeps its
// `jobs-list` container ("There are no open positions at this time.") and
// reads as []; a lapsed account answers 200 with "JazzHR - Inactive Career
// Page" and throws a named error; an unknown tenant answers 302 to
// info.jazzhr.com, which redirect:'error' turns into a fetch error.
//
// The list carries no description and no date, so — like rippling — fetch()
// reads each posting's own page once (DETAIL_BATCH at a time, at most
// MAX_DETAIL_REQUESTS per board). A detail page carries a schema.org
// JobPosting JSON-LD block (datePosted, HTML description) while the posting is
// inside its validThrough window (observed: datePosted + 90 days); an older
// posting's page drops the block, so it gets its description from the
// `#job-description` container and stays undated. Enrichment only: a detail
// that fails or is malformed leaves the list-level posting unchanged, and the
// step is skipped while a caller is probing (ctx.maxPages set, as
// verify-portals does).
//
// SSRF: the tenant is the only variable part of the host. It is charset-checked
// (`<tenant>.applytojob.com`, one DNS label) before any request, every request
// is re-checked against that exact host, and every request passes
// redirect:'error'. Posting links are only accepted on the same tenant host and
// are rebuilt from a charset-checked id and slug, so a scraped href can never
// point a detail request anywhere else.

import { decodeEntities } from './_html-entities.mjs';
import { htmlToText, FULL_DESCRIPTION_CAP } from './_html-to-text.mjs';
import { fetchTextWithRetry } from './_http.mjs';

const HOST_SUFFIX = 'applytojob.com';
// One DNS label, lowercase (URL parsing lowercases the hostname), no edge hyphen.
const TENANT_HOST_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.applytojob\.com$/;
// JazzHR's own hosts on the same domain, never a customer board.
const RESERVED_TENANTS = new Set(['www', 'app', 'api']);
// /apply/<id>[/<slug>][/] — ids are 10 alphanumerics on every board sampled;
// the bound leaves room without admitting /apply/jobs/feed or /apply/embed/…
const POSTING_PATH_RE = /^\/apply\/([A-Za-z0-9]{6,20})(?:\/([^/]*))?\/?$/;
// RFC 3986 pchar: what a parsed pathname segment may hold. A title with no
// ASCII letters yields an empty slug (`/apply/<id>/`), which is valid.
const SLUG_RE = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})*$/;

// Detail GETs in flight at once — same small-batch politeness as rippling.
const DETAIL_BATCH = 4;
// Detail GETs one board may spend (one per posting, no retries). Half of
// rippling's 200: a JazzHR detail is a full HTML page (~120 KB measured)
// rather than a JSON document. Loud when it truncates.
const MAX_DETAIL_REQUESTS = 100;
// A datePosted more than a year ahead is a bad value, not a posting date
// (same bound as rippling.mjs / local-parser.mjs).
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

// Content the browser never renders as markup. A tag-shaped literal inside one
// must not produce a job or count as the listing container.
const NON_RENDERED_RE = /<!--[\s\S]*?-->|<(script|style|template|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const CLASS_ATTR_RE = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const HREF_ATTR_RE = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const H3_OPEN_RE = /<h3\b([^>]*)>/gi;
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/g;
const UL_OPEN_RE = /<ul\b([^>]*)>/gi;
const LI_RE = /<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi;
const ICON_RE = /<i\b([^>]*)>/i;
// The listing container, part of the page template even when nothing is posted.
const BOARD_MARKER_RE = /<[a-z][a-z0-9]*\s(?:[^>]*\s)?class\s*=\s*(["'])(?:[^"']*\s)?(?:jobs-list|job-board-list)(?:\s[^"']*)?\1/i;
const INACTIVE_RE = /<title>\s*JazzHR\s*-\s*Inactive Career Page\s*<\/title>|This account is no longer active/i;

// Detail page.
const JSON_LD_RE = /<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script\s*>/gi;
const DESC_OPEN_RE = /<div\b[^>]*\sid\s*=\s*(["'])job-description\1[^>]*>/i;
// The two blocks the career-page template renders right after the description.
const DESC_END_RE = /<div\b[^>]*(?:resumator-mobile-apply-wrapper|job-application-form-container)/i;
const JOB_VALUE_INPUT_RE = /<input\b[^>]*\bid\s*=\s*(["'])resumator-job-value\1[^>]*>/i;
const VALUE_ATTR_RE = /\svalue\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** @param {string} attrs @returns {string[]} */
function classTokens(attrs) {
  const m = CLASS_ATTR_RE.exec(attrs);
  const value = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
  return value.split(/\s+/).filter(Boolean);
}

/** @param {string} attrs @returns {string} */
function hrefOf(attrs) {
  const m = HREF_ATTR_RE.exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
}

/**
 * Tenant host (`acme.applytojob.com`) from an entry's careers_url, or null for
 * a non-JazzHR, non-https, malformed, reserved or unsafe-label URL.
 * @param {import('./_types.js').PortalEntry | null | undefined} entry
 * @returns {string | null}
 */
function resolveTenantHost(entry) {
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url.trim() : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const m = TENANT_HOST_RE.exec(parsed.hostname);
  if (!m || RESERVED_TENANTS.has(m[1])) return null;
  return parsed.hostname;
}

/** @param {string} host */
function boardUrlForHost(host) {
  return `https://${host}/apply`;
}

/**
 * Throw unless `url` is https on exactly `host` (a validated tenant host).
 * @param {string} url
 * @param {string} host
 */
function assertJazzhrUrl(url, host) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jazzhr: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`jazzhr: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== host || !TENANT_HOST_RE.test(parsed.hostname)) {
    throw new Error(`jazzhr: untrusted hostname "${parsed.hostname}" — must be ${host} (<tenant>.${HOST_SUFFIX})`);
  }
  return url;
}

/**
 * Resolve a board anchor's href to `{ url, id }`, or null when it is not a
 * posting link on `host`. Relative hrefs resolve against the tenant origin;
 * an absolute one must name the same tenant host (http is upgraded — the
 * template's own back link is written as http). Exported for tests.
 * @param {unknown} href
 * @param {string} host  validated tenant host
 * @returns {{url: string, id: string} | null}
 */
export function resolveJazzhrPostingUrl(href, host) {
  if (typeof href !== 'string' || !href.trim()) return null;
  if (typeof host !== 'string' || !TENANT_HOST_RE.test(host)) return null;
  let parsed;
  try {
    parsed = new URL(href.trim(), `https://${host}/apply`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.hostname !== host || parsed.port || parsed.username || parsed.password) return null;
  const m = POSTING_PATH_RE.exec(parsed.pathname);
  if (!m) return null;
  const id = m[1];
  const slug = m[2] && SLUG_RE.test(m[2]) ? m[2] : '';
  return { url: `https://${host}/apply/${id}/${slug}`, id };
}

/**
 * Board rows as `{ job, id }` plus the number of posting headings seen, for
 * the markup-changed check. Rows missing a title or a usable link are skipped.
 * @param {string} rendered  page with non-rendered blocks removed
 * @param {string} host
 * @param {string} companyName
 */
function parseRows(rendered, host, companyName) {
  /** @type {Array<{job: Job, id: string}>} */
  const rows = [];
  const seen = new Set();
  /** @type {Array<{start: number, end: number}>} */
  const headings = [];
  for (const m of rendered.matchAll(H3_OPEN_RE)) {
    if (!classTokens(m[1]).includes('list-group-item-heading')) continue;
    headings.push({ start: m.index, end: m.index + m[0].length });
  }
  headings.forEach((h, i) => {
    // One posting's region runs to the next posting heading (the last one to
    // the end of the page — nothing after the list carries the meta class).
    const regionEnd = i + 1 < headings.length ? headings[i + 1].start : rendered.length;
    // The posting anchor is the first link inside the heading's region.
    ANCHOR_RE.lastIndex = h.end;
    const a = ANCHOR_RE.exec(rendered);
    if (!a || ANCHOR_RE.lastIndex > regionEnd) return;
    const link = resolveJazzhrPostingUrl(hrefOf(a[1]), host);
    // Dedup on the posting id: the slug is cosmetic (any slug serves the page).
    if (!link || seen.has(link.id)) return;
    const title = htmlToText(a[2]);
    if (!title) return;

    const region = rendered.slice(ANCHOR_RE.lastIndex, regionEnd);
    const locations = [];
    for (const ul of region.matchAll(UL_OPEN_RE)) {
      if (!classTokens(ul[1]).includes('list-group-item-text')) continue;
      const bodyStart = ul.index + ul[0].length;
      const close = region.indexOf('</ul', bodyStart);
      const body = region.slice(bodyStart, close < 0 ? region.length : close);
      for (const li of body.matchAll(LI_RE)) {
        const icon = ICON_RE.exec(li[1]);
        if (!icon || !classTokens(icon[1]).includes('fa-map-marker')) continue;
        const text = htmlToText(li[1]);
        if (text && !locations.includes(text)) locations.push(text);
      }
      break;
    }

    seen.add(link.id);
    rows.push({ job: { title, url: link.url, company: companyName, location: locations.join('; ') }, id: link.id });
  });
  return { rows, headings: headings.length };
}

/**
 * Parse a JazzHR career page (`<tenant>.applytojob.com/apply`) into rows.
 * Throws on an inactive account, and on a page that is neither a board with
 * postings nor an empty board, so a redesign surfaces instead of reading 0.
 * @param {unknown} html
 * @param {string} host
 * @param {string} companyName
 */
function parseBoardRows(html, host, companyName) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const rendered = html.replace(NON_RENDERED_RE, ' ');
  const { rows, headings } = parseRows(rendered, host, companyName);
  // A lapsed account's page (checked only when nothing parsed, so a posting
  // that happens to quote the phrase cannot void a live board).
  if (rows.length === 0 && INACTIVE_RE.test(html)) {
    throw new Error(`jazzhr: ${host} is an inactive JazzHR career page ("This account is no longer active")`);
  }
  if (rows.length === 0 && headings > 0) {
    throw new Error(
      `jazzhr: ${headings} list-group-item-heading block(s) on ${host} but none carried a title and an /apply/<id>/ link on that host; the board markup likely changed`,
    );
  }
  if (rows.length === 0 && !BOARD_MARKER_RE.test(rendered)) {
    throw new Error(`jazzhr: no postings and no jobs-list container on ${host}/apply; the page structure likely changed`);
  }
  return rows;
}

/**
 * Parse a JazzHR career page into list-level jobs. Exported for unit tests.
 *
 *   - title:    the posting anchor's text, entity-decoded and whitespace-collapsed.
 *   - url:      `https://<host>/apply/<id>/<slug>` — the anchor's link, accepted
 *               only on `host` and rebuilt from its checked id and slug; it is
 *               the dedup key.
 *   - location: the fa-map-marker item ('' when absent; several are joined "; ").
 *   - company:  the portal entry name (the page names no employer per row).
 *
 * @param {unknown} html
 * @param {string} host  validated tenant host, e.g. `acme.applytojob.com`
 * @param {string} companyName
 * @returns {Job[]}
 */
export function parseJazzhrBoard(html, host, companyName) {
  return parseBoardRows(html, host, companyName).map((r) => r.job);
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} node @returns {Record<string, any> | null} */
function findJobPosting(node) {
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      stack.push(...cur);
    } else if (isPlainObject(cur)) {
      const type = cur['@type'];
      if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return cur;
      if (Array.isArray(cur['@graph'])) stack.push(...cur['@graph']);
    }
  }
  return null;
}

/**
 * Epoch ms from a JSON-LD datePosted (observed `2026-07-14`; a date-only value
 * is UTC midnight). A date-time must carry its offset. NaN, non-positive and
 * far-future values are dropped.
 * @param {unknown} raw
 * @returns {number | undefined}
 */
function postedAtFromDate(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/.test(trimmed)) return undefined;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms) || ms <= 0 || ms > Date.now() + MAX_FUTURE_MS) return undefined;
  return ms;
}

/** Posting id named by a JSON-LD `url`, or '' when absent/unrecognizable. @param {unknown} url */
function idFromPostingUrl(url) {
  if (typeof url !== 'string') return '';
  try {
    return POSTING_PATH_RE.exec(new URL(url).pathname)?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * Read a posting's own page: `{ description?, postedAt? }`, or null when the
 * page is not that posting's detail page (it names a different posting id, or
 * carries neither a JobPosting block nor a #job-description container).
 * Exported for unit tests.
 * @param {unknown} html
 * @param {string} id  the posting id the page was requested for
 * @returns {{description?: string, postedAt?: number} | null}
 */
export function parseJazzhrDetail(html, id) {
  if (typeof html !== 'string' || !html) return null;

  /** @type {Record<string, any> | null} */
  let posting = null;
  for (const m of html.matchAll(JSON_LD_RE)) {
    let data;
    try {
      data = JSON.parse(m[2]);
    } catch {
      continue;
    }
    posting = findJobPosting(data);
    if (posting) break;
  }

  // Identity: a page naming another posting would put that job's text here.
  const ldId = posting ? idFromPostingUrl(posting.url) : '';
  const input = JOB_VALUE_INPUT_RE.exec(html);
  const valueMatch = input ? VALUE_ATTR_RE.exec(input[0]) : null;
  const formId = valueMatch ? (valueMatch[1] ?? valueMatch[2] ?? '').trim() : '';
  if ((ldId && ldId !== id) || (formId && formId !== id)) return null;

  let description = posting ? htmlToText(posting.description, FULL_DESCRIPTION_CAP) : '';
  let sawContainer = false;
  const open = DESC_OPEN_RE.exec(html);
  if (open) {
    sawContainer = true;
    if (!description) {
      const from = open.index + open[0].length;
      const rest = html.slice(from);
      const end = DESC_END_RE.exec(rest);
      // Without the template's closing neighbours the extent is unknown; take
      // nothing rather than the whole rest of the page.
      if (end) description = htmlToText(rest.slice(0, end.index), FULL_DESCRIPTION_CAP);
    }
  }
  if (!posting && !sawContainer) return null;

  /** @type {{description?: string, postedAt?: number}} */
  const out = {};
  if (description) out.description = description;
  const postedAt = posting ? postedAtFromDate(posting.datePosted) : undefined;
  if (postedAt !== undefined) out.postedAt = postedAt;
  return out;
}

/** @type {Provider} */
export default {
  id: 'jazzhr',

  detect(entry) {
    const host = resolveTenantHost(entry);
    return host ? { url: boardUrlForHost(host) } : null;
  },

  async fetch(entry, ctx) {
    const host = resolveTenantHost(entry);
    if (!host) throw new Error(`jazzhr: cannot derive a <tenant>.${HOST_SUFFIX} board URL for ${entry?.name}`);
    const listUrl = assertJazzhrUrl(boardUrlForHost(host), host);
    // redirect:'error' + the host check keep every request on the tenant host;
    // an unknown tenant's 302 to info.jazzhr.com surfaces as a fetch error.
    const html = await fetchTextWithRetry(ctx, listUrl, { redirect: 'error' });
    const rows = parseBoardRows(html, host, entry.name);

    // Detail enrichment answers "what does this job say", not "is this board
    // alive" — skipped while probing, so the probe stays at one request.
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    if (probing) return rows.map((r) => r.job);

    const pending = rows.slice(0, MAX_DETAIL_REQUESTS);
    /** @type {Map<string, {description?: string, postedAt?: number}>} */
    const details = new Map();
    let failed = 0;
    for (let i = 0; i < pending.length; i += DETAIL_BATCH) {
      const batch = pending.slice(i, i + DETAIL_BATCH);
      await Promise.all(batch.map(async ({ job, id }) => {
        try {
          assertJazzhrUrl(job.url, host);
          const page = await ctx.fetchText(job.url, { redirect: 'error' });
          const detail = parseJazzhrDetail(page, id);
          if (!detail) {
            failed++;
            return;
          }
          details.set(job.url, detail);
        } catch {
          // Enrichment only (a closed posting answers 410). Keep the list row.
          failed++;
        }
      }));
    }

    if (failed > 0 || rows.length > pending.length) {
      const unreadable = failed > 0 ? `, ${failed} posting page(s) unreadable` : '';
      const capped = rows.length > pending.length
        ? `, ${rows.length - pending.length} left undetailed by the ${MAX_DETAIL_REQUESTS}-request cap`
        : '';
      console.error(`ℹ️  jazzhr: ${entry.name} enriched ${details.size} of ${rows.length} posting(s)${unreadable}${capped}`);
    }

    return rows.map(({ job }) => {
      const detail = details.get(job.url);
      return detail ? { ...job, ...detail } : job;
    });
  },
};
