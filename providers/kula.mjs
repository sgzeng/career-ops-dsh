// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Kula provider — per-tenant public RSS jobs feed (→ tracked_companies:).
//
// Kula career sites live at `https://careers.kula.ai/<slug>`. The board page is
// a Next.js App Router app whose job list only exists inside the RSC flight
// payload, but every tenant also serves a zero-auth RSS 2.0 feed at
//   https://careers.kula.ai/<slug>/feed
// (`application/rss+xml`, with a `job:` extension namespace,
// xmlns:job="https://kula.ai/rss"). That feed is what this provider reads — a
// syndication format is a steadier contract than the React payload. Measured
// 2026-09-27 over all 156 tenants in careers.kula.ai/sitemap-index.xml: every
// feed answered 200 and parsed; its job ids equalled the tenant sitemap's on
// 151, and the job ids in the board page's own payload on 149 of the 151
// boards small enough to embed them all (the two others: Kula's e2e test
// tenant, and a board whose page lists no jobs). The sitemap differences
// spot-checked were sitemap lag — a sitemap-only id rendering Kula's "job
// closed" page, a live board job not yet in the sitemap. Unknown tenant → 404
// `{"errors":["err_account_not_found"]}`.
//
// Item shape:
//   <title>, <link>, <guid>, <pubDate> (RFC 822, the job's launch time),
//   <category> (department), <description> (full JD HTML in CDATA),
//   <job:employmentType>, <job:workplace> (OFFICE|HYBRID|REMOTE),
//   <job:location>{ officeName, remote, city?, state?, country?, isHQ }</job:location>*,
//   <job:salary>{ currency, minAmount, maxAmount, interval, type }</job:salary>?
// Two tenant variants were observed live:
//   - one item PER OFFICE: <link> is `/<slug>/<id>/apply` and
//     <job:referencenumber> is `<id>-<officeId>` — items sharing an id are one
//     posting and are merged here;
//   - one item per posting: <link> is `/<slug>/<id>`, one <job:location> per
//     office.
// The description rides in the same feed, so `description` costs no extra
// request.
//
// Job.url is `https://careers.kula.ai/<slug>/<id>` for both variants: the form
// the second variant's own <link> uses, and the posting page — Kula answers it
// with a 308 to the canonical `/<slug>/<id>-<title-slug>` page. It is kept
// instead of the canonical form because that one changes whenever a recruiter
// edits the title, and Job.url is the dedup key.
//
// SSRF: the only request is to a URL assembled from the fixed literal host
// and a slug validated against SLUG_RE; assertKulaFeedUrl re-checks it before
// the fetch and redirect:'error' refuses any hop. Item links are never
// fetched: they are parsed only for the numeric job id, and one that is not on
// careers.kula.ai under this tenant's slug drops that item.

import { decodeEntities } from './_html-entities.mjs';
import { htmlToText, FULL_DESCRIPTION_CAP } from './_html-to-text.mjs';
import { fetchTextWithRetry } from './_http.mjs';

const KULA_HOST = 'careers.kula.ai';
const KULA_ORIGIN = `https://${KULA_HOST}`;
// Every slug in the sitemap index (156 tenants) is lowercase [a-z0-9-]. Kula
// resolves slugs case-insensitively, so a config slug is lowercased first.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// First path segments careers.kula.ai routes itself (the RSC route tree lists
// `api`, `robots.txt`, `sitemap-index.xml` beside the tenant slug; `_next`
// serves assets); only `api` survives SLUG_RE.
const RESERVED_SEGMENTS = new Set(['api']);
// Item link path: `/<slug>/<id>` or `/<slug>/<id>/apply`.
const JOB_PATH_RE = /^\/([^/]+)\/(\d{1,15})(?:\/apply)?\/?$/;

// The feed is one unpaginated document, so there is no page count to cap. The
// hard ceiling bounds the parse instead — items, not jobs, because the
// per-office variant repeats a posting once per office. Largest live feed
// measured: 1,289 items (4.1 MB).
export const MAX_FEED_ITEMS = 20_000;
// That 4.1 MB feed took 4.6 s end to end; the shared 10 s default leaves too
// little room for a slow CloudFront miss on a big tenant.
const FEED_TIMEOUT_MS = 30_000;

// <job:interval> → annual multiplier. ONE_TIME and anything unknown drop that
// range rather than guess. BI_WEEKLY and SEMI_MONTHLY are left out on purpose:
// on those, the feed's interval is the payroll frequency, not the unit of the
// amounts. Every non-placeholder range filed under them in the 2026-09-27
// sweep of all 156 tenants (8 of 8) carried annual figures — 10xgenomics'
// BI_WEEKLY 164100–222100 is the JD's "$164,100—$222,100 USD" — so ×26 / ×24
// would have emitted $1.3M–$11.8M and let salary_filter drop real postings.
// With the unit unknowable, no figure is emitted: an absent salary always
// passes salary_filter, a wrong one silently drops the job.
const INTERVAL_MULTIPLIERS = {
  YEARLY: 1,
  QUARTERLY: 4,
  MONTHLY: 12,
  WEEKLY: 52,
  DAILY: 260,
  HOURLY: 2080,
};
// The same mix-up turns up, more rarely, under the intervals that are read
// (live: deepcentered's HOURLY 80000–100000, which ×2080 is $166M). A
// sub-annual range is annualized only when its figures look like per-period
// pay: an upper bound under ANNUAL_SIZED_AMOUNT and an annualized upper bound
// of at most MAX_ANNUALIZED. Both are currency-blind, so they also drop some
// genuine per-period ranges in high-denomination currencies (a ₹1,00,000
// monthly salary). That is the safe direction, for the reason above.
const ANNUAL_SIZED_AMOUNT = 20_000;
const MAX_ANNUALIZED = 2_000_000;

/**
 * Tenant slug from `entry.api` (a feed URL) or `entry.careers_url` (the board
 * or any page under it): the first path segment of an https careers.kula.ai
 * URL, lowercased. Null for any other host, a non-https or malformed URL, a
 * reserved segment, or a slug outside SLUG_RE. Never throws.
 * @param {import('./_types.js').PortalEntry} entry
 * @returns {string|null}
 */
function resolveSlug(entry) {
  for (const raw of [entry?.api, entry?.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== KULA_HOST) continue;
    const segment = (parsed.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    if (!SLUG_RE.test(segment) || RESERVED_SEGMENTS.has(segment)) continue;
    return segment;
  }
  return null;
}

/** Feed URL for a slug already validated by resolveSlug(). */
function feedUrlForSlug(slug) {
  return `${KULA_ORIGIN}/${slug}/feed`;
}

/** @param {string} url */
function assertKulaFeedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`kula: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`kula: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== KULA_HOST) {
    throw new Error(`kula: untrusted hostname "${parsed.hostname}" — must be ${KULA_HOST}`);
  }
  return url;
}

/** @param {import('./_types.js').PortalEntry} entry */
function entryName(entry) {
  return typeof entry?.name === 'string' ? entry.name.trim() : '';
}

/** @type {Provider} */
export default {
  id: 'kula',

  detect(entry) {
    const slug = resolveSlug(entry);
    return slug ? { url: feedUrlForSlug(slug) } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`kula: cannot derive a ${KULA_HOST}/<slug> feed for ${entryName(entry) || 'entry'}`);
    const feedUrl = assertKulaFeedUrl(feedUrlForSlug(slug));
    // One request whatever ctx.maxPages says: the feed is the whole board and
    // there is no enrichment to skip while probing. No catch — a rejection
    // (a 404 for an unknown tenant, a probe sentinel) propagates unwrapped.
    const xml = await fetchTextWithRetry(ctx, feedUrl, { redirect: 'error', timeoutMs: FEED_TIMEOUT_MS });
    return parseKulaFeed(xml, slug, entryName(entry));
  },
};

// Inner markup of the first <tag>…</tag> in a block, or null when absent.
// Tag names may carry a namespace prefix (job:city).
function tagInner(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}

// Every <tag>…</tag> inner in a block, in document order.
function tagInners(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  return [...block.matchAll(re)].map((m) => m[1]);
}

// Text of the first <tag>: a CDATA section is unwrapped as-is, anything else
// is entity-decoded (`Research &amp; Development` → `Research & Development`).
// '' when absent.
function tagText(block, tag) {
  const inner = tagInner(block, tag);
  if (inner === null) return '';
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? cdata[1] : decodeEntities(inner)).trim();
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Numeric job id from an item's <link> (falling back to <guid>), or null when
 * neither is an https careers.kula.ai URL under `slug`.
 * @param {string} meta - item markup with <description> removed
 * @param {string} slug
 */
function jobIdFromItem(meta, slug) {
  for (const tag of ['link', 'guid']) {
    const raw = tagText(meta, tag);
    if (!raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== KULA_HOST) continue;
    const m = parsed.pathname.match(JOB_PATH_RE);
    if (m && m[1].toLowerCase() === slug) return m[2];
  }
  return null;
}

/**
 * One office as a location label. Kula geocodes offices into city / state /
 * country, which reads better for location_filter than the free-text office
 * name ("Headquarters", "Bengaluru Main"), so those win when present, with
 * repeats dropped ("Jakarta, Jakarta, Indonesia" → "Jakarta, Indonesia"); the
 * office name is the fallback. " (Remote)" is appended for a remote office or
 * a REMOTE posting — the same "United Kingdom (Remote)" Kula's board prints.
 * @param {string} block - inner of one <job:location>
 * @param {boolean} postingIsRemote
 */
function officeLabel(block, postingIsRemote) {
  /** @type {string[]} */
  const parts = [];
  for (const tag of ['job:city', 'job:state', 'job:country']) {
    const v = tagText(block, tag);
    if (v && !parts.some((p) => p.toLowerCase() === v.toLowerCase())) parts.push(v);
  }
  const place = parts.length ? parts.join(', ') : tagText(block, 'job:officeName');
  const remote = postingIsRemote || tagText(block, 'job:remote').toLowerCase() === 'true';
  if (!remote) return place;
  if (!place) return 'Remote';
  return /\bremote\b/i.test(place) ? place : `${place} (Remote)`;
}

/**
 * Annualized ranges from an item's <job:salary> blocks. Skipped, never
 * guessed: non-BASE pay; an interval not in INTERVAL_MULTIPLIERS; non-positive
 * bounds (a 0 would read as the floor in scan.mjs's salary_filter); the
 * "0.0–1.0" placeholder tenants file to hide the pay (an upper bound ≤ 1,
 * which ×2080 would read as a $2,080 job); and a sub-annual range whose
 * figures are annual-sized (see ANNUAL_SIZED_AMOUNT).
 * @param {string} meta
 * @returns {Array<{lo: number, hi: number, currency: string}>}
 */
function salaryRanges(meta) {
  /** @param {string} v */
  const positive = (v) => {
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const out = [];
  for (const block of tagInners(meta, 'job:salary')) {
    const type = tagText(block, 'job:type').toUpperCase();
    if (type && type !== 'BASE') continue;
    const interval = tagText(block, 'job:interval').toUpperCase();
    const multiplier = Object.hasOwn(INTERVAL_MULTIPLIERS, interval)
      ? INTERVAL_MULTIPLIERS[/** @type {keyof typeof INTERVAL_MULTIPLIERS} */ (interval)]
      : 0;
    if (!multiplier) continue;
    const min = positive(tagText(block, 'job:minAmount'));
    const max = positive(tagText(block, 'job:maxAmount'));
    if (min === null && max === null) continue;
    const a = /** @type {number} */ (min ?? max);
    const b = /** @type {number} */ (max ?? min);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi <= 1) continue;
    if (multiplier !== 1 && (hi >= ANNUAL_SIZED_AMOUNT || hi * multiplier > MAX_ANNUALIZED)) continue;
    out.push({ lo: lo * multiplier, hi: hi * multiplier, currency: tagText(block, 'job:currency').toUpperCase() });
  }
  return out;
}

/**
 * Parse a Kula `/<slug>/feed` RSS document. Exported for unit tests.
 *
 *   - title:       <title>, entity-decoded; an item without one is skipped.
 *   - url:         `https://careers.kula.ai/<slug>/<id>`, the id taken from
 *                  <link> (else <guid>), which must be an https careers.kula.ai
 *                  URL under this slug; any other item is skipped.
 *   - company:     `companyName` (the portals.yml name), else the channel
 *                  <title>.
 *   - location:    every office of the posting (all its items, in feed order),
 *                  de-duplicated and joined with "; " — see officeLabel().
 *   - postedAt:    <pubDate> (NaN-safe); omitted when unusable.
 *   - description: <description> HTML as plain text, FULL_DESCRIPTION_CAP.
 *   - salary:      annualized min/max envelope of the <job:salary> ranges
 *                  salaryRanges() keeps, when they share one currency.
 *
 * Items sharing a job id (the per-office variant) merge into one posting.
 * Empty / whitespace / non-string input → []. A body that is not RSS, or a
 * feed whose items all lack a recognisable job link (a format change, not an
 * empty board), throws — so the board fails loud instead of reading 0 forever.
 *
 * @param {unknown} xml - raw feed body
 * @param {string} slug - validated tenant slug
 * @param {string} [companyName]
 * @param {{maxItems?: number}} [opts] - test hook; clamped to MAX_FEED_ITEMS
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number, description?: string, salary?: {min: number, max: number, currency: string}}>}
 */
export function parseKulaFeed(xml, slug, companyName = '', opts = {}) {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  const label = companyName || slug;
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) {
    throw new Error(`kula: ${label}: feed is not RSS (body starts ${JSON.stringify(xml.trim().slice(0, 80))})`);
  }
  // The channel header runs up to the first <item>; its first <title> is the
  // tenant's display name (the <image> block repeats it further down).
  const firstItem = xml.search(/<item\b/i);
  const company = companyName || tagText(firstItem === -1 ? xml : xml.slice(0, firstItem), 'title');

  const allItems = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  const cap = Number.isInteger(opts?.maxItems) && /** @type {number} */ (opts.maxItems) > 0
    ? Math.min(/** @type {number} */ (opts.maxItems), MAX_FEED_ITEMS)
    : MAX_FEED_ITEMS;
  const items = allItems.slice(0, cap);
  if (allItems.length > items.length) {
    console.error(`⚠️  kula: ${label}: feed has ${allItems.length} items; parsed the first ${items.length} (MAX_FEED_ITEMS)`);
  }

  /** @type {Map<string, {title: string, postedAt?: number, description: string, locations: string[], salaries: Array<{lo: number, hi: number, currency: string}>}>} */
  const byId = new Map();
  let linked = 0;
  for (const item of items) {
    // Read the metadata with the (large, free-form) description cut out, so
    // markup inside the JD can never shadow an item-level tag.
    const desc = item.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i);
    const meta = desc ? item.slice(0, desc.index) + item.slice(/** @type {number} */ (desc.index) + desc[0].length) : item;

    const id = jobIdFromItem(meta, slug);
    if (!id) continue;
    linked++;

    let agg = byId.get(id);
    if (!agg) {
      agg = { title: '', description: '', locations: [], salaries: [] };
      byId.set(id, agg);
    }
    if (!agg.title) agg.title = tagText(meta, 'title');
    const postedAt = toEpochMs(tagText(meta, 'pubDate'));
    if (postedAt !== undefined && (agg.postedAt === undefined || postedAt < agg.postedAt)) agg.postedAt = postedAt;
    if (!agg.description && desc) {
      // CDATA unwrapped in place (a body split into several sections to escape
      // `]]>` rejoins), then the shared two-pass decode + strip.
      agg.description = htmlToText(desc[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'), FULL_DESCRIPTION_CAP);
    }
    const postingIsRemote = tagText(meta, 'job:workplace').toUpperCase() === 'REMOTE';
    const offices = tagInners(meta, 'job:location');
    const labels = offices.length ? offices.map((o) => officeLabel(o, postingIsRemote)) : [postingIsRemote ? 'Remote' : ''];
    for (const l of labels) {
      if (l && !agg.locations.some((x) => x.toLowerCase() === l.toLowerCase())) agg.locations.push(l);
    }
    agg.salaries.push(...salaryRanges(meta));
  }

  if (items.length > 0 && linked === 0) {
    const sample = tagText(items[0], 'link') || tagText(items[0], 'guid');
    throw new Error(`kula: ${label}: ${items.length} feed item(s) but none links to ${KULA_HOST}/${slug}/<id> (first link: ${JSON.stringify(sample)}) — feed format changed?`);
  }

  const jobs = [];
  for (const [id, agg] of byId) {
    if (!agg.title) continue;
    /** @type {{title: string, url: string, company: string, location: string, postedAt?: number, description?: string, salary?: {min: number, max: number, currency: string}}} */
    const job = {
      title: agg.title,
      url: `${KULA_ORIGIN}/${slug}/${id}`,
      company,
      location: agg.locations.join('; '),
    };
    if (agg.postedAt !== undefined) job.postedAt = agg.postedAt;
    if (agg.description) job.description = agg.description;
    const currencies = new Set(agg.salaries.map((s) => s.currency));
    if (agg.salaries.length && currencies.size === 1) {
      job.salary = {
        min: Math.min(...agg.salaries.map((s) => s.lo)),
        max: Math.max(...agg.salaries.map((s) => s.hi)),
        currency: [...currencies][0],
      };
    }
    jobs.push(job);
  }
  return jobs;
}
