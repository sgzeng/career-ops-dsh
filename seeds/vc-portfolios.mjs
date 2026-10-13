// @ts-check
/**
 * seeds/vc-portfolios.mjs — VC portfolio seed fetchers for career-ops.
 *
 * Pulls public VC portfolio company lists (Y Combinator, Andreessen Horowitz)
 * and emits company entries compatible with the existing ATS scan/discovery
 * path (same shape as tracked_companies entries in portals.yml).
 *
 * Design constraints:
 *  - Zero auth — public sources only, no login, no API keys.
 *  - Zero LLM tokens — pure HTTP + JSON / HTML.
 *  - Same SLUG_RE guard used by scan-ats-full.mjs for every slug that reaches
 *    URL interpolation — a tampered or malformed payload can never inject
 *    unexpected characters into a URL.
 *  - `parseSeedEntries()` is a pure, synchronous function (no network) so it
 *    can be unit-tested with inline fixtures without any mocking.
 *
 * Typical usage (via scan-ats-full.mjs --seeds flag):
 *   node scan-ats-full.mjs --seeds yc
 *   node scan-ats-full.mjs --seeds yc,a16z --since 7 --dry-run
 *
 * Direct usage:
 *   import { fetchYCCompanies, fetchA16zCompanies } from './seeds/vc-portfolios.mjs';
 *   const companies = await fetchYCCompanies();
 */

import { DEFAULT_USER_AGENT } from '../user-agent.mjs';

// ── Constants ────────────────────────────────────────────────────────

/**
 * Safe charset for slug values that will be interpolated into ATS URLs.
 * Consistent with the SLUG_RE guard in scan-ats-full.mjs.
 */
export const SLUG_RE = /^[A-Za-z0-9._-]+$/;

const DEFAULT_TIMEOUT_MS = 20_000;

// Runaway guard for the YC pagination walk, NOT the stop condition: the walk
// normally ends at the API's own `totalPages` (246 as of Aug 2026, 25 per page).
// It exists only for the case where the API stops reporting pagination metadata
// at all. Sized well clear of the real total on purpose - a ceiling that sits
// close to today's page count stops being a guard and becomes a silent truncation
// the day the catalogue grows past it, which is the exact failure this file was
// fixed for. Exported so the walk is clamped to it as a hard ceiling and tests
// can assert the contract.
export const YC_MAX_PAGES = 500;

/**
 * YC public company API.
 * Returns paginated JSON with company objects including name, slug, website.
 * Documentation: https://www.ycombinator.com/companies (public, no auth needed).
 */
const YC_API_URL = 'https://api.ycombinator.com/v0.1/companies?page=1&per_page=1000';

/**
 * a16z public portfolio page.
 * The portfolio is a publicly accessible HTML page listing all portfolio companies.
 */
const A16Z_PORTFOLIO_URL = 'https://a16z.com/portfolio/';

// The a16z page ships ~870 companies. A parse that lands far below that has
// matched the wrong thing (or the page changed shape), which the caller should
// hear about rather than scan a sliver of the portfolio in silence.
export const A16Z_MIN_EXPECTED = 200;

// A page that fails is retried this many extra times before the walk gives it
// up. The 3 of 9 logged runs that stopped at 2,300 / 2,925 companies did so on
// the first failure of any kind, and said nothing.
const YC_PAGE_RETRIES = 2;
// Consecutive pages that fail or come back empty before the walk concludes the
// API is down rather than that one page is bad.
const YC_MAX_BAD_PAGES = 3;
// After a throttle or server error, space the remaining pages out. Applied only
// once trouble has been seen, so a healthy walk is unchanged.
const YC_THROTTLED_PAGE_DELAY_MS = 250;
const RETRY_BASE_MS = 750;
const RETRY_AFTER_CAP_MS = 30_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── HTTP helper (local — avoids importing providers/_http.mjs to keep seeds/ self-contained) ──

/**
 * Minimal fetch wrapper with timeout + user-agent header.
 * A non-2xx response throws an Error carrying `status` and `retryAfter`, so a
 * caller can tell a throttle from a missing page without parsing the message.
 * `consume` reads the body while the timer is still armed: a server that sends
 * headers and then stalls would otherwise hang the walk with nothing left to
 * abort it.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, consume?: (res: Response) => Promise<any> }} [opts]
 * @returns {Promise<any>}
 */
async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, consume = async (res) => res } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': DEFAULT_USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      const snippet = await res.text().catch(() => '').then(t => t.slice(0, 200));
      const err = /** @type {any} */ (new Error(`HTTP ${res.status}${snippet ? ': ' + snippet.replace(/\s+/g, ' ').trim() : ''}`));
      err.status = res.status;
      err.retryAfter = res.headers?.get?.('retry-after') ?? null;
      throw err;
    }
    return await consume(res);
  } finally {
    clearTimeout(timer);
  }
}

/** A failure worth another attempt: no status (network, timeout, truncated JSON), 408, 429 or 5xx. */
function isTransientSeedError(err) {
  const status = err?.status;
  if (status === undefined) return true;
  return status === 408 || status === 429 || status >= 500;
}

function retryDelayMs(err, attempt) {
  // Number(null) is 0, which would turn "no Retry-After" into "retry at once".
  const header = err?.retryAfter;
  const secs = header === null || header === undefined || String(header).trim() === '' ? NaN : Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
  return RETRY_BASE_MS * 2 ** attempt;
}

/** Why a request failed, short enough for a warning line (the error text can carry a response body). */
function failureReason(err) {
  if (typeof err?.status === 'number') return `HTTP ${err.status}`;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'timed out';
  return String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 80);
}

// ── Shared types (JSDoc only — no runtime cost) ──────────────────────

/**
 * A single VC-portfolio company entry — the output unit of both seed fetchers.
 *
 * @typedef {object} SeedCompany
 * @property {string}   name            Display name, e.g. "Stripe".
 * @property {string}   slug            URL-safe slug, validated against SLUG_RE.
 * @property {string}   url             Company website URL.
 * @property {string}   [ats]           ATS platform if detectable: 'greenhouse' | 'lever' | 'ashby'.
 * @property {string}   [ats_id]        ATS board/org slug for URL construction.
 * @property {string}   [source]        Which VC list this came from: 'yc' | 'a16z'.
 * @property {string}   [batch]         YC batch label, e.g. "W21" (YC only).
 * @property {boolean}  [hiring]        YC flags the company as currently hiring (YC only).
 * @property {string}   [status]        YC company status: 'Active' | 'Inactive' | 'Acquired' | ... (YC only).
 */

/**
 * A PortalEntry-compatible object ready to be passed to ATS provider.detect().
 * Shape matches the PortalEntry typedef in providers/_types.js.
 *
 * @typedef {object} SeedPortalEntry
 * @property {string} name
 * @property {string} careers_url   Best-effort ATS or website URL.
 * @property {string} [source]      Seed origin ('yc' | 'a16z').
 */

/**
 * One board a company might have: a vendor plus the slug to try on it.
 *
 * @typedef {object} SeedCandidate
 * @property {'greenhouse'|'ashby'|'lever'} vendor
 * @property {string} slug
 * @property {string} name
 * @property {string} careers_url   What the provider's detect() reads.
 * @property {string} [source]
 */

// ── Slug helpers ─────────────────────────────────────────────────────

// No real ATS board slug is anywhere near this long; a payload that produces
// one is hostile or garbage, and it would only ever 404.
const MAX_SLUG_LEN = 100;
const MAX_NAME_LEN = 120;

/**
 * Lowercase ASCII slug from a company name: accents folded, every other run of
 * non-alphanumerics collapsed to one hyphen. Empty when nothing survives.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function slugify(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * A display name from an untrusted payload: control characters and runs of
 * whitespace become one space, and it is capped. It ends up in log lines and
 * pipeline rows, and a name with a newline or a terminal escape in it should not
 * be able to forge either.
 *
 * @param {unknown} value
 * @returns {string}
 */
function cleanName(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim().slice(0, MAX_NAME_LEN) : '';
}

const LEGAL_SUFFIX_RE = /[\s,]+(?:inc|incorporated|llc|ltd|limited|corp|corporation|gmbh|pbc)\.?$/i;

/**
 * The part of a portfolio title an ATS board is likely to be named after:
 * "Dynamic Labs, Inc." -> "Dynamic Labs", "Yuga Labs (BAYC)" -> "Yuga Labs".
 * Falls back to the title itself when stripping would leave nothing.
 *
 * @param {unknown} title
 * @returns {string}
 */
export function coreCompanyName(title) {
  const raw = String(title ?? '').trim();
  let s = raw.replace(/\s*\([^)]*\)\s*$/, '');
  for (let i = 0; i < 2; i++) s = s.replace(LEGAL_SUFFIX_RE, '');
  return s.trim() || raw;
}

// Hosts that belong to a platform, not to the company whose site lives there:
// their first label names the platform's tenant namespace, never an ATS slug.
const HOSTED_SITE_SUFFIXES = [
  'github.io', 'vercel.app', 'netlify.app', 'notion.site', 'webflow.io', 'framer.website',
  'framer.app', 'herokuapp.com', 'pages.dev', 'web.app', 'firebaseapp.com', 'wixsite.com',
  'carrd.co', 'linktr.ee', 'medium.com', 'substack.com', 'twitter.com', 'x.com',
  'linkedin.com', 'facebook.com', 'instagram.com', 'youtube.com', 'apple.com', 'google.com',
  // Directories that stand in for a company with no site of its own. YC's own
  // listing page is the one that bites: its label, `ycombinator`, is YC's board.
  'ycombinator.com', 'workatastartup.com', 'a16z.com', 'crunchbase.com', 'wikipedia.org',
  'angel.co', 'wellfound.com', 'producthunt.com',
];
// Registrable domains under a country code, e.g. example.co.uk, example.com.au.
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

/**
 * The registrable label of a website: "https://www.posthog.com/" -> "posthog",
 * "https://app.example.co.uk" -> "example". Empty for an IP, a hosted-site
 * platform, or anything that does not parse.
 *
 * @param {unknown} url
 * @returns {string}
 */
export function domainLabel(url) {
  let host;
  try { host = new URL(String(url ?? '')).hostname.toLowerCase(); } catch { return ''; }
  host = host.replace(/^www\d?\./, '').replace(/\.$/, '');
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return '';
  if (HOSTED_SITE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return '';
  const parts = host.split('.');
  if (parts.length < 2) return '';
  let at = parts.length - 2;
  if (parts.length >= 3 && parts[parts.length - 1].length === 2 && SECOND_LEVEL_LABELS.has(parts[at])) at -= 1;
  const label = parts[at];
  return label && label.length >= 2 && SLUG_RE.test(label) ? label : '';
}

/**
 * Build an a16z SeedCompany from a title and website, or null when the title is
 * a placeholder or yields no safe slug.
 *
 * @param {unknown} title
 * @param {unknown} url
 * @returns {SeedCompany | null}
 */
function a16zCompany(title, url) {
  const name = cleanName(title);
  if (!name || /^\[[^\]]*\]$/.test(name)) return null;
  const slug = slugify(coreCompanyName(name));
  if (!slug || slug.length > MAX_SLUG_LEN || !SLUG_RE.test(slug)) return null;
  const site = typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : '';
  return { name, slug, url: site, source: 'a16z' };
}

// ── Pure parser: YC ──────────────────────────────────────────────────

/**
 * Parse a raw YC API response payload into SeedCompany entries.
 *
 * This is the testable unit — pure, no network, no side effects.
 * The YC API returns a paginated JSON object:
 *   { companies: [{ id, name, slug, website, batch, status, badges, ... }], ... }
 *
 * @param {unknown} payload   Parsed JSON from the YC API (or a fixture in tests).
 * @returns {SeedCompany[]}
 */
export function parseYCPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const raw = /** @type {any} */ (payload);
  const list = Array.isArray(raw.companies) ? raw.companies : (Array.isArray(raw) ? raw : []);
  /** @type {Map<string, SeedCompany>} */
  const seen = new Map();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;

    const name = cleanName(item.name);
    if (!name) continue;

    // Prefer explicit slug; derive from name as fallback.
    const rawSlug = typeof item.slug === 'string' ? item.slug.trim() : slugify(name);
    if (!rawSlug || rawSlug.length > MAX_SLUG_LEN || !SLUG_RE.test(rawSlug)) continue;

    // Deduplicate by slug.
    if (seen.has(rawSlug)) continue;

    const url = typeof item.website === 'string' && item.website.startsWith('http')
      ? item.website.trim()
      : (typeof item.url === 'string' && item.url.startsWith('http') ? item.url.trim() : '');

    /** @type {SeedCompany} */
    const entry = {
      name,
      slug: rawSlug,
      url,
      source: 'yc',
    };

    if (typeof item.batch === 'string' && item.batch.trim()) {
      entry.batch = item.batch.trim();
    }

    // YC's own "currently hiring" flag rides in badges[]. It is a hint for what
    // to probe first, never a filter: it is maintained by hand, so a company
    // can be hiring without it (see runSeedScan's prioritisation).
    if (item.isHiring === true || (Array.isArray(item.badges) && item.badges.includes('isHiring'))) {
      entry.hiring = true;
    }
    if (typeof item.status === 'string' && item.status.trim()) {
      entry.status = item.status.trim();
    }

    seen.set(rawSlug, entry);
  }

  return [...seen.values()];
}

// ── Pure parser: a16z ────────────────────────────────────────────────

/**
 * The index just past the JSON value that starts at `start` (an opening `[` or
 * `{`), or -1 when it never closes. Strings are skipped whole, so a bracket,
 * brace, semicolon or `</script>` inside a title or blurb cannot end the value
 * early.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function matchJsonEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true; // backslash
      else if (c === 34) inString = false; // closing quote
      continue;
    }
    if (c === 34) inString = true;
    else if (c === 91 || c === 123) depth++; // [ {
    else if (c === 93 || c === 125) { // ] }
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * The JSON value a script assigns to `name` (`window.x = [...];`), or undefined
 * when it is absent or does not parse. Takes the first occurrence that parses,
 * so the name appearing earlier inside a string or comment is not fatal.
 *
 * @param {string} text
 * @param {string} name
 * @returns {unknown}
 */
export function extractAssignedJson(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w$])${escaped}\\s*=\\s*(?=[\\[{])`, 'g');
  let match;
  for (let tries = 0; tries < 5 && (match = re.exec(text)); tries++) {
    const start = match.index + match[0].length;
    const end = matchJsonEnd(text, start);
    if (end < 0) continue;
    try {
      return JSON.parse(text.slice(start, end));
    } catch {
      // Not JSON (a JS literal, or cut short): try the next occurrence.
    }
  }
  return undefined;
}

/**
 * Strategy 0: the whole portfolio, which the page ships as one inline script:
 *   window.a16z_portfolio_companies = [{"id":"373009","title":"11x","web":"https://www.11x.ai/",...}, ...];
 * An entry with an `exit_date` has been acquired or gone public, so it has no
 * board of its own to find.
 *
 * @param {string} html
 * @returns {SeedCompany[]}
 */
function parseA16zInlineList(html) {
  const list = extractAssignedJson(html, 'window.a16z_portfolio_companies');
  if (!Array.isArray(list)) return [];
  /** @type {Map<string, SeedCompany>} */
  const seen = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (String(item.exit_date ?? '').trim()) continue;
    const company = a16zCompany(item.title, item.web);
    if (company && !seen.has(company.slug)) seen.set(company.slug, company);
  }
  return [...seen.values()];
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" };

/** Attribute-level entity decode, just enough to read a JSON blob kept in an attribute. */
function decodeAttribute(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#39|#x27);/gi, (_, e) => HTML_ENTITIES[e.toLowerCase()]);
}

/**
 * Parse raw a16z portfolio HTML into SeedCompany entries.
 *
 * This is the testable unit — pure, no network, no side effects.
 *
 * Strategy 0 (the real page): the inline `window.a16z_portfolio_companies`
 * list, bracket-matched and JSON-parsed — the whole portfolio, ~870 companies.
 * Everything below is a fallback for a page that stops shipping it, tried only
 * when the list yields nothing:
 *  1. JSON-LD Organization blocks.
 *  2. `data-company-name="Stripe"` attributes.
 *  3. `data-company='{"name":"Stripe","url":"https://stripe.com",...}'` cards
 *     (what the page's ~40 featured logos carry).
 *  4. Portfolio card anchors / heading text.
 *
 * @param {string} html    Raw HTML from the a16z portfolio page (or a fixture in tests).
 * @returns {SeedCompany[]}
 */
export function parseA16zPayload(html) {
  if (typeof html !== 'string' || !html.trim()) return [];

  const inline = parseA16zInlineList(html);
  if (inline.length) return inline;

  /** @type {Map<string, SeedCompany>} */
  const seen = new Map();
  const add = (title, url) => {
    const company = a16zCompany(title, url);
    if (company && !seen.has(company.slug)) seen.set(company.slug, company);
  };

  // Strategy 1: JSON-LD embedded in the page (structured data block).
  // a16z sometimes embeds schema.org/Organization blocks — extract if present.
  const jsonLdMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item?.['@type'] === 'Organization' || item?.['@type'] === 'Corporation') {
          add(item.name, item.url);
        }
      }
    } catch {
      // Malformed JSON-LD — skip silently.
    }
  }

  // Strategy 2: data-company-name attributes (a16z uses React-rendered data attrs).
  // Pattern: data-company-name="Stripe" (optionally with data-company-url)
  const dataAttrRe = /data-company-name=["']([^"']+)["'](?:[^>]*data-company-url=["']([^"']+)["'])?/gi;
  for (const match of html.matchAll(dataAttrRe)) {
    add(match[1]?.trim(), match[2]?.trim());
  }

  // Strategy 3: featured cards, whose whole record is JSON in one attribute.
  const dataCompanyRe = /data-company=(?:'([^']*)'|"([^"]*)")/g;
  for (const match of html.matchAll(dataCompanyRe)) {
    try {
      const card = JSON.parse(decodeAttribute(match[1] ?? match[2] ?? ''));
      if (card && typeof card === 'object') add(card.name ?? card.post_title, card.url);
    } catch {
      // Not a JSON card — skip.
    }
  }

  // Strategy 4: Portfolio card anchors / heading text fallback.
  // Matches patterns like: <a href="https://stripe.com" class="...portfolio...">Stripe</a>
  // or company names in h3/h4 elements within portfolio sections.
  const portfolioAnchorRe = /<a\s+[^>]*href=["'](https?:\/\/[^"'?\s]+)["'][^>]*class=["'][^"']*(?:portfolio|company|card)[^"']*["'][^>]*>\s*([A-Z][^<]{1,60}?)\s*<\/a>/gi;
  for (const match of html.matchAll(portfolioAnchorRe)) {
    const url = match[1]?.trim();
    const name = match[2]?.trim().replace(/\s+/g, ' ');
    if (!name || !url) continue;
    // Filter out nav/generic link text.
    if (/^(read more|learn more|visit|see all|view|more|news|blog|press|contact)/i.test(name)) continue;
    add(name, url);
  }

  return [...seen.values()];
}

// ── Generic pure parser (entry point for test-all.mjs) ───────────────

/**
 * Parse a raw seed payload (either YC JSON or a16z HTML) into validated
 * SeedCompany entries. This is the universal testable unit cited in the
 * issue acceptance criteria.
 *
 * @param {unknown} payload     JSON object (YC) or HTML string (a16z).
 * @param {'yc'|'a16z'} source  Which VC portfolio this payload came from.
 * @returns {SeedCompany[]}
 */
export function parseSeedEntries(payload, source) {
  if (source === 'a16z') {
    return parseA16zPayload(typeof payload === 'string' ? payload : '');
  }
  // Default: YC (also used for unknown sources — parse defensively).
  return parseYCPayload(payload);
}

// ── Candidate boards ─────────────────────────────────────────────────

/** Public board URL per vendor, in the form each provider's detect() reads. */
export const VENDOR_BOARD_URL = {
  greenhouse: (slug) => `https://job-boards.greenhouse.io/${slug}`,
  ashby: (slug) => `https://jobs.ashbyhq.com/${slug}`,
  lever: (slug) => `https://jobs.lever.co/${slug}`,
};

/**
 * The order a company with no ATS hint is probed in. Most-likely first, since
 * the first board that answers with postings ends the search. Measured
 * 2026-10-13 on 120 YC companies spread over six pages of the API, probing each
 * vendor under the YC slug: boards with open postings were Ashby 9, Greenhouse
 * 5, Lever 2 (Lever also answered with an empty board for 3 more). Ashby first
 * therefore saves the most probes, and its 404s are as cheap as the others'
 * (median ~110 ms against ~60 ms).
 */
export const SEED_VENDOR_ORDER = ['ashby', 'greenhouse', 'lever'];

/**
 * How many slug spellings are tried per company, by portfolio.
 *
 * YC gets one: its own slug is already a company handle, and the alternatives
 * found nothing — 21 other spellings (separators dropped, the website's domain
 * label) of 16 companies that had no board under their YC slug were probed on
 * all three vendors, and none answered. a16z has only a display title to start
 * from, which loses to the board's own spelling more often ("Dynamic Labs, Inc."
 * is `dynamiclabs` or `dynamic-labs`), so it also tries the separator-free form
 * and the website's label.
 */
const SLUG_VARIANTS_BY_SOURCE = {
  yc: { max: 1 },
  a16z: { max: 3 },
};

/**
 * The slugs a company's board might be filed under, most likely first: the
 * portfolio's own slug, then the same with separators dropped (`scale-ai` ->
 * `scaleai`), then the website's domain label (`scale.com` -> `scale`). Every
 * value is checked against SLUG_RE before it can reach a URL.
 *
 * @param {SeedCompany} company
 * @param {{ max?: number, domain?: boolean }} [opts] - `domain: false` leaves the website label out.
 * @returns {string[]}
 */
export function slugVariants(company, { max = 3, domain = true } = {}) {
  /** @type {string[]} */
  const out = [];
  const push = (value) => {
    if (typeof value !== 'string') return;
    const slug = value.trim();
    if (slug && slug.length <= MAX_SLUG_LEN && SLUG_RE.test(slug) && !out.includes(slug)) out.push(slug);
  };
  const base = typeof company?.slug === 'string' ? company.slug.trim() : '';
  push(base);
  const collapsed = base.replace(/[-._]+/g, '');
  if (collapsed.length >= 3) push(collapsed);
  if (domain) push(domainLabel(company?.url));
  return out.slice(0, max);
}

/**
 * Every board a company might have, in the order to probe them.
 *
 * An explicit `ats` + `ats_id` on the company is trusted and is the only
 * candidate. Otherwise: a board remembered from an earlier run (`hint`) goes
 * first, then each slug variant on each vendor, the primary slug across all
 * vendors before the next variant is tried. The caller stops at the first
 * candidate that answers with postings.
 *
 * @param {SeedCompany} company
 * @param {{ vendors?: string[], hint?: { vendor: string, slug: string } | null, variants?: { max?: number, domain?: boolean } }} [opts]
 * @returns {SeedCandidate[]}
 */
export function toPortalCandidates(company, { vendors = SEED_VENDOR_ORDER, hint = null, variants = SLUG_VARIANTS_BY_SOURCE[company?.source] ?? {} } = {}) {
  /** @type {SeedCandidate[]} */
  const out = [];
  const seen = new Set();
  const add = (vendor, slug) => {
    if (!VENDOR_BOARD_URL[vendor] || typeof slug !== 'string' || !SLUG_RE.test(slug)) return;
    const id = `${vendor}\t${slug}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ vendor, slug, name: company.name, careers_url: VENDOR_BOARD_URL[vendor](slug), source: company.source });
  };

  if (company.ats && company.ats_id && VENDOR_BOARD_URL[company.ats] && SLUG_RE.test(company.ats_id)) {
    add(company.ats, company.ats_id);
    return out;
  }
  if (hint) add(hint.vendor, hint.slug);
  for (const slug of slugVariants(company, variants)) {
    for (const vendor of vendors) add(vendor, slug);
  }
  return out;
}

/**
 * Probe order: companies YC marks as hiring first, inactive ones last, the rest
 * between in portfolio order. A reordering only — nothing is dropped, because
 * the flag is a hint and not a census. Measured 2026-10-13 on 120 YC companies
 * (15 with a board that had open postings): 8 carried the hiring badge and 7 did
 * not, so filtering on it would have lost 7 of 15; the badge still concentrates
 * the hits (8 of 31 flagged companies had a live board, against 7 of 89 that
 * were not). It matters under `--limit` or an interrupted run, where what is
 * probed first is what gets probed. Acquired companies are not demoted: 4 of 15
 * had a live board, as often as active ones did (11 of 93); inactive ones had
 * none (0 of 12).
 *
 * @param {SeedCompany[]} companies
 * @returns {SeedCompany[]}
 */
export function prioritizeSeedCompanies(companies) {
  const rank = (c) => {
    if (String(c.status || '').toLowerCase() === 'inactive') return 2;
    return c.hiring ? 0 : 1;
  };
  return companies
    .map((company, index) => ({ company, index, rank: rank(company) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.company);
}

// ── toPortalEntry converter ──────────────────────────────────────────

/**
 * Convert a SeedCompany into a PortalEntry-shaped object that ATS provider
 * detect() can consume directly.
 *
 * This is the single-board form, kept for callers that want one URL. The scan
 * itself uses toPortalCandidates(), which tries every vendor.
 *
 * Resolution order for careers_url:
 *  1. If `company.ats === 'greenhouse'` and `company.ats_id` is set → Greenhouse board URL.
 *  2. If `company.ats === 'lever'` and `company.ats_id` is set → Lever URL.
 *  3. If `company.ats === 'ashby'` and `company.ats_id` is set → Ashby URL.
 *  4. Derive from slug: the Greenhouse URL (the first candidate).
 *  5. Fallback: company website URL (the ATS may be on a custom subdomain).
 *
 * @param {SeedCompany} company
 * @returns {SeedPortalEntry}
 */
export function toPortalEntry(company) {
  let careers_url = '';

  // Explicit ATS hint from the YC dataset.
  const atsId = company.ats_id && SLUG_RE.test(company.ats_id) ? company.ats_id : null;
  if (atsId) {
    if (company.ats === 'greenhouse') {
      careers_url = `https://job-boards.greenhouse.io/${atsId}`;
    } else if (company.ats === 'lever') {
      careers_url = `https://jobs.lever.co/${atsId}`;
    } else if (company.ats === 'ashby') {
      careers_url = `https://jobs.ashbyhq.com/${atsId}`;
    }
  }

  // No explicit ATS: the Greenhouse URL from the slug.
  if (!careers_url && company.slug && SLUG_RE.test(company.slug)) {
    careers_url = `https://job-boards.greenhouse.io/${company.slug}`;
  }

  // Last resort: company website (ATS may auto-detect from the domain).
  if (!careers_url) {
    careers_url = company.url || '';
  }

  return {
    name: company.name,
    careers_url,
    source: company.source,
  };
}

// ── Network fetchers ─────────────────────────────────────────────────

/**
 * What a seed fetcher reports about its own run, filled in by the fetcher and
 * read by the caller. `warnings` are the loud ones: a run that came back
 * partial or empty says so, instead of looking like a smaller portfolio.
 *
 * @typedef {object} SeedFetchDiag
 * @property {string[]} [warnings]
 * @property {number | null} [pagesTotal]      Pages the API reported (YC).
 * @property {number} [pagesFetched]           Pages that returned companies (YC).
 * @property {{ page: number, reason: string }[]} [failedPages]
 * @property {number[]} [emptyPages]
 * @property {boolean} [truncated]             The walk ended before the last page.
 */

/**
 * Fetch one YC page, retrying a transient failure.
 *
 * @param {number} page
 * @param {{ timeoutMs: number, retries: number, sleep: (ms: number) => Promise<void>, onRetry?: (err: any, attempt: number) => void }} opts
 */
async function fetchYCPage(page, { timeoutMs, retries, sleep, onRetry }) {
  const url = `https://api.ycombinator.com/v0.1/companies?page=${page}&per_page=1000`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url, { timeoutMs, consume: (res) => res.json() });
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransientSeedError(err)) break;
      onRetry?.(err, attempt);
      await sleep(retryDelayMs(err, attempt));
    }
  }
  throw lastErr;
}

/**
 * Fetch the Y Combinator public company list and return parsed SeedCompany entries.
 *
 * Uses the public YC API (no auth, no API key). The response is a JSON object
 * with a `companies` array plus `page`/`totalPages` pagination fields. The API
 * caps page size server-side (~25/page; `per_page` is ignored), so the whole
 * portfolio is walked page by page, newest batches first.
 *
 * The walk does not give up quietly. A failing page is retried, and once it is
 * given up on the walk moves to the next page when `totalPages` says there is
 * one, so one bad page costs 25 companies rather than everything after it.
 * Whatever is still missing at the end is reported through `onWarn` / `diag`
 * with the page numbers and reasons. Page 1 failing is still fatal.
 *
 * @param {{ timeoutMs?: number, maxPages?: number, onWarn?: (msg: string) => void, diag?: SeedFetchDiag, sleep?: (ms: number) => Promise<void>, retries?: number }} [opts]
 *   `maxPages` is clamped to YC_MAX_PAGES, which is a hard ceiling; pagination
 *   normally stops at the API-reported last page.
 * @returns {Promise<SeedCompany[]>}
 */
export async function fetchYCCompanies({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxPages = YC_MAX_PAGES,
  onWarn = undefined,
  diag = undefined,
  sleep = defaultSleep,
  retries = YC_PAGE_RETRIES,
} = {}) {
  /** @type {SeedCompany[]} */
  const all = [];
  const seen = new Set();

  const info = diag ?? {};
  Object.assign(info, { pagesTotal: null, pagesFetched: 0, failedPages: [], emptyPages: [], truncated: false });
  const warnings = (info.warnings ??= []);
  const warn = (msg) => { warnings.push(msg); onWarn?.(msg); };

  // YC_MAX_PAGES is a hard ceiling: clamp here so an explicit maxPages (or a
  // stray Infinity) can never spin the walk past the runaway guard.
  const limit = Math.min(maxPages, YC_MAX_PAGES);

  let page = 1;
  let reportedTotal = null;
  let badRun = 0;
  let paceMs = 0;
  let stoppedAt = null;
  let ceilingHit = false;
  for (let fetched = 0; ; fetched++) {
    if (fetched >= limit) { ceilingHit = true; stoppedAt = page; break; }
    if (paceMs) await sleep(paceMs);

    let payload;
    try {
      payload = await fetchYCPage(page, {
        timeoutMs,
        retries,
        sleep,
        onRetry: (err) => {
          if (err?.status === 429 || err?.status >= 500) paceMs = YC_THROTTLED_PAGE_DELAY_MS;
        },
      });
    } catch (err) {
      if (page === 1) throw new Error(`vc-portfolios: YC API fetch failed — ${err.message}`);
      info.failedPages.push({ page, reason: failureReason(err) });
      if (err?.status === 429 || err?.status >= 500) paceMs = YC_THROTTLED_PAGE_DELAY_MS;
      badRun++;
      if (reportedTotal && page < reportedTotal && badRun < YC_MAX_BAD_PAGES) { page += 1; continue; }
      // The last page failing is a gap, not an early stop: nothing came after it.
      if (!reportedTotal || page < reportedTotal) stoppedAt = page;
      break;
    }

    const raw = /** @type {any} */ (payload);
    if (Number.isInteger(raw?.totalPages) && raw.totalPages > 0) reportedTotal = raw.totalPages;
    info.pagesTotal = reportedTotal;

    const entries = parseYCPayload(payload);
    if (entries.length === 0) {
      info.emptyPages.push(page);
      badRun++;
      // Mid-walk, with pages still to come, an empty page is not the end of the
      // list: say so and keep going, until a run of them says the shape changed.
      // Without a reported total there is nothing to be mid-way through, and an
      // empty page is how the walk ends.
      if (reportedTotal && page < reportedTotal) {
        if (badRun < YC_MAX_BAD_PAGES) { page += 1; continue; }
        stoppedAt = page;
      }
      break;
    }
    badRun = 0;
    info.pagesFetched++;

    for (const e of entries) {
      if (!seen.has(e.slug)) {
        seen.add(e.slug);
        all.push(e);
      }
    }

    // The API caps page size server-side and reports totalPages — follow its
    // signal instead of guessing from batch size.
    if (reportedTotal) {
      if (page >= reportedTotal) break;
      page += 1;
      continue;
    }
    // When totalPages is absent, follow the nextPage target the API hands back
    // rather than stopping — tolerating a bare number, a page=N fragment, or a
    // full URL, and requiring forward progress so it can't spin. This is the
    // case that bites the day YC changes the response shape again.
    const next = parseYCNextPage(raw?.nextPage);
    if (next == null || next <= page) break;
    page = next;
  }

  // Judge the walk against what the API said it would serve. Two different
  // degradations: the walk STOPPED before the last page (everything after it is
  // unscanned), or it reached the last page having skipped some pages (a gap of
  // ~25 companies each).
  const gaps = [
    ...info.failedPages.map((f) => `${f.page} (${f.reason})`),
    ...info.emptyPages.map((p) => `${p} (empty)`),
  ];
  info.truncated = stoppedAt !== null || (info.pagesTotal ? info.pagesFetched < info.pagesTotal : false);
  if (stoppedAt !== null) {
    const of = info.pagesTotal ? ` of ${info.pagesTotal}` : '';
    const why = ceilingHit ? `hit the ${limit}-page ceiling` : `stopped at page ${stoppedAt}`;
    warn(`YC walk ended early: ${info.pagesFetched}${of} pages, ${all.length} companies — ${why}, so the rest of the portfolio was NOT scanned${gaps.length ? ` (bad pages: ${gaps.join(', ')})` : ''}`);
  } else if (info.truncated) {
    warn(`YC walk skipped ${gaps.length} page${gaps.length === 1 ? '' : 's'}: ${gaps.join(', ')} — about ${gaps.length * 25} companies were NOT scanned (${info.pagesFetched} of ${info.pagesTotal} pages read)`);
  }
  if (all.length === 0) warn('YC API returned 0 companies');

  return all;
}

/**
 * Extract the next page number from the YC API's `nextPage` field, which may be
 * a bare page number, a `page=N` query fragment, or a full URL carrying a
 * `page=N` query param. Returns null when no forward page number can be read.
 *
 * @param {unknown} nextPage
 * @returns {number | null}
 */
export function parseYCNextPage(nextPage) {
  if (nextPage == null || nextPage === false) return null;
  if (typeof nextPage === 'number') {
    return Number.isInteger(nextPage) && nextPage > 0 ? nextPage : null;
  }
  if (typeof nextPage === 'string') {
    const m = nextPage.match(/(?:^|[?&/])page[=/](\d+)/) || nextPage.match(/^\s*(\d+)\s*$/);
    if (m) {
      const n = Number(m[1]);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  }
  return null;
}

/**
 * Fetch the a16z public portfolio page and return parsed SeedCompany entries.
 *
 * a16z does not expose a public JSON API, so we fetch the HTML portfolio page
 * and parse it with `parseA16zPayload()`. A fetch that fails is tried once more;
 * a parse that comes back empty or far below the ~870 the page carries is
 * reported, because that is the page changing shape, not a small portfolio.
 *
 * @param {{ timeoutMs?: number, onWarn?: (msg: string) => void, diag?: SeedFetchDiag, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<SeedCompany[]>}
 */
export async function fetchA16zCompanies({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onWarn = undefined,
  diag = undefined,
  sleep = defaultSleep,
} = {}) {
  const info = diag ?? {};
  const warnings = (info.warnings ??= []);
  const warn = (msg) => { warnings.push(msg); onWarn?.(msg); };

  let html;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      html = await fetchWithTimeout(A16Z_PORTFOLIO_URL, { timeoutMs, consume: (res) => res.text() });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (!isTransientSeedError(err)) break;
      if (attempt === 0) await sleep(retryDelayMs(err, 0));
    }
  }
  if (lastErr) throw new Error(`vc-portfolios: a16z portfolio fetch failed — ${lastErr.message}`);

  const companies = parseA16zPayload(html);
  if (companies.length === 0) {
    warn('a16z portfolio page parsed to 0 companies — the page layout has probably changed');
  } else if (companies.length < A16Z_MIN_EXPECTED) {
    warn(`a16z portfolio page parsed to only ${companies.length} companies (expected ~870) — the page layout has probably changed`);
  }
  return companies;
}

// ── SEED_SOURCES registry ────────────────────────────────────────────

/**
 * Registry mapping seed source names to their fetch functions.
 * Consumed by scan-ats-full.mjs --seeds flag and CLI tooling.
 *
 * To add a new VC portfolio:
 *  1. Add a fetchXyzCompanies() function above.
 *  2. Add an entry here: { fetch: fetchXyzCompanies, label: 'XYZ Portfolio' }
 *
 * `fetch` may be handed `{ onWarn, diag }` (see SeedFetchDiag) to report a
 * partial or empty result loudly; a fetcher that has nothing to say ignores them.
 *
 * @type {Record<string, { fetch: (opts?: object) => Promise<SeedCompany[]>, label: string }>}
 */
export const SEED_SOURCES = {
  yc: {
    fetch: fetchYCCompanies,
    label: 'Y Combinator Portfolio',
  },
  a16z: {
    fetch: fetchA16zCompanies,
    label: 'Andreessen Horowitz (a16z) Portfolio',
  },
};
