#!/usr/bin/env node
/**
 * Generic self-hosted careers-page parser for career-ops `providers/local-parser.mjs`.
 *
 * For companies that list roles on their OWN website instead of an ATS (Greenhouse /
 * Ashby / Lever ...), so scan.mjs has no API to call. Without this they could only be
 * covered by a `scan_method: websearch` entry, which is stage 2: it costs agent tokens
 * every day and surfaces nothing until the scheduled agent runs. This makes them stage 1:
 * zero tokens, same filters, same dedup, rows land in pipeline.md on the next scan.
 *
 * Fetches server-rendered HTML only (plain fetch, no browser, no login). If the listing
 * needs JavaScript to show roles, use a websearch entry instead.
 *
 * Contract with local-parser.mjs: print a JSON array of
 *   { title, url, company, location, description?, postedAt? }
 * to stdout.
 *
 * Usage (portals.yml `parser.args`; `{careers_url}` / `{company}` are interpolated):
 *   node scripts/parsers/careers-page.mjs --url {careers_url} --link '^/about/careers/[a-z-]+$' \
 *        --company {company} --location 'San Francisco, CA'
 *
 *   --url URL          the page that LISTS the open roles (required)
 *   --link REGEX       JavaScript regex; an href on that page is a role link when it matches the
 *                      href as written OR its absolute URL (required unless --page-as-job)
 *   --exclude REGEX    drop role links that match this (optional)
 *   --company NAME     employer name for the emitted rows
 *   --location STR     location when a role page does not state one (JSON-LD wins)
 *   --title-strip RE   regex removed from a page <title> to get the role title
 *                      (default: ` [|–—-] .*$`, i.e. everything after the first separator)
 *   --max N            at most N role pages are fetched (default 40)
 *   --throttle-ms N    delay between requests (default 400)
 *   --no-detail        do not fetch role pages; title = anchor text (only for listings whose
 *                      anchor text IS the title)
 *   --page-as-job TITLE  the listing page itself is the posting (no per-role pages, e.g. one
 *                      "Member of Technical Staff" blurb). Emits one job only while TITLE still
 *                      appears in the page text, so a removed role disappears.
 *   --allow-host H     (repeatable) also accept role links on host H (e.g. jobs.ashbyhq.com); by
 *                      default links must stay on the listing's own site
 *   --keep-query       keep the query string of role links (/jobs?id=7); dropped by default
 *   --fixture FILE     parse a saved listing instead of fetching (tests); role pages are
 *                      read from FILE.<slug>.html when present
 *
 * Exit codes: 0 ok (JSON on stdout, possibly []) · 2 listing unreachable (no JSON, stderr
 * reason, so local-parser reports an error instead of a silent zero).
 */

import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { BROWSER_LIKE_USER_AGENT } from '../../user-agent.mjs';
import { fetchResponse } from '../../providers/_http.mjs';
import { decodeEntities } from '../../providers/_html-entities.mjs';
import { htmlToText, FULL_DESCRIPTION_CAP } from '../../providers/_html-to-text.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Role links on a listing page: hrefs matching `linkRe` (as written or absolute) and not
 * `excludeRe`, resolved against `baseUrl`, fragment and query dropped, deduped in page order.
 * Pure. The anchor text is kept as a fallback title.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @param {RegExp} linkRe
 * @param {RegExp|null} [excludeRe]
 * @returns {{url:string,anchorText:string}[]}
 */
export function extractRoleLinks(html, baseUrl, linkRe, excludeRe = null, { allowHosts = [], keepQuery = false } = {}) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*?(?<![\w-])href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]{0,2000}?)<\/a\s*>/gi;
  const baseHost = new URL(baseUrl).hostname.toLowerCase();
  const sameSite = (h) => h === baseHost || h.endsWith('.' + baseHost) || baseHost.endsWith('.' + h) || h.split('.').slice(-2).join('.') === baseHost.split('.').slice(-2).join('.') || allowHosts.includes(h);
  let m;
  while ((m = re.exec(String(html || '')))) {
    const raw = decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
    if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript):/i.test(raw)) continue;
    let abs;
    try {
      abs = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    // A hostile page must not steer the fetcher to another site: role links stay on the
    // listing's site unless the portals.yml entry names the host in --allow-host.
    if (!sameSite(abs.hostname.toLowerCase())) continue;
    abs.hash = '';
    if (!keepQuery) abs.search = '';
    const href = abs.href.replace(/\/$/, '');
    const path = (abs.pathname + (keepQuery ? abs.search : '')).replace(/\/$/, '') || '/';
    const matches = (re2) => re2.test(raw) || re2.test(href) || re2.test(path);
    if (!matches(linkRe)) continue;
    if (excludeRe && matches(excludeRe)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ url: href, anchorText: stripTags(m[4].replace(/<(script|style|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')) });
  }
  return out;
}

/** JSON-LD blocks that describe a JobPosting, flattened. Pure. */
export function jobPostingsFromJsonLd(html) {
  const out = [];
  const blocks = String(html || '').match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const type = node['@type'];
    if ((Array.isArray(type) ? type : [type]).includes('JobPosting')) out.push(node);
    if (node['@graph']) visit(node['@graph']);
  };
  for (const b of blocks) {
    const body = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try {
      visit(JSON.parse(body));
    } catch {
      /* a malformed block is skipped, the page may still parse by title */
    }
  }
  return out;
}

function jsonLdLocation(posting) {
  const loc = posting?.jobLocation;
  const one = (l) => {
    if (!l) return '';
    if (typeof l === 'string') return l;
    const a = l.address || l;
    if (typeof a === 'string') return a;
    return [a.addressLocality, a.addressRegion, a.addressCountry && (a.addressCountry.name || a.addressCountry)]
      .filter(Boolean)
      .join(', ');
  };
  const parts = (Array.isArray(loc) ? loc : [loc]).map(one).filter(Boolean);
  const remote = String(posting?.jobLocationType || '').toUpperCase() === 'TELECOMMUTE';
  if (remote && !parts.length) return 'Remote';
  return parts.join(' / ');
}

/**
 * One role page -> { title, location, description, postedAt }. Title preference: JSON-LD
 * JobPosting.title, then <h1>, then og:title, then <title> with the site suffix stripped.
 * Pure.
 *
 * @param {string} html
 * @param {{titleStrip?:RegExp, defaultLocation?:string, fallbackTitle?:string}} [opts]
 */
export function parseRolePage(html, opts = {}) {
  const src = String(html || '');
  const [posting] = jobPostingsFromJsonLd(src);
  const strip = opts.titleStrip || /\s+[|–—-]\s+.*$/;
  const metaTitle = (src.match(/<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i) || [])[1];
  const h1 = (src.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i) || [])[1];
  const pageTitle = (src.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i) || [])[1];
  const clean = (t) => stripTags(t || '').replace(strip, '').trim();
  const title =
    (posting?.title && stripTags(posting.title)) ||
    stripTags(h1 || '') ||
    stripTags(metaTitle || '').replace(strip, '').trim() ||
    clean(pageTitle) ||
    '';
  const body = posting?.description ? htmlToText(String(posting.description), FULL_DESCRIPTION_CAP) : '';
  const description = body || htmlToText(src, FULL_DESCRIPTION_CAP);
  const location = jsonLdLocation(posting) || opts.defaultLocation || '';
  const rawDate = posting?.datePosted ? String(posting.datePosted).trim() : '';
  let postedAt;
  if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) postedAt = rawDate.slice(0, 10);
  else if (rawDate && !Number.isNaN(Date.parse(rawDate))) postedAt = new Date(Date.parse(rawDate)).toISOString().slice(0, 10);
  return { title, location, description, ...(postedAt ? { postedAt } : {}) };
}

/**
 * The listing page is itself the posting. Emits one job while `title` is still on the page.
 * Pure.
 */
export function pageAsJob(html, url, title, opts = {}) {
  const text = htmlToText(String(html || ''), FULL_DESCRIPTION_CAP);
  if (!title || !text.toLowerCase().includes(title.toLowerCase())) return [];
  return [{ title, url, company: opts.company || '', location: opts.location || '', description: text }];
}

// Every request goes through providers/_http.mjs so the parser gets the same SSRF guard as
// the ATS providers (private / loopback / link-local addresses refused, also for a literal IP
// and on every redirect hop) and the same timeout. A page can link anywhere, so this matters:
// a role link to http://169.254.169.254/ must not be dialled. Redirects are followed by hand,
// at most MAX_HOPS, because fetchResponse() defaults to refusing them and careers pages do
// redirect (www, trailing slash).
const MAX_HOPS = 3;
const MAX_BODY_CHARS = 2_000_000; // a careers page is ~100KB; anything near this is hostile or broken
const MAX_OUTPUT_CHARS = 1_500_000;
async function fetchHtml(url, hops = 0) {
  const res = await fetchResponse(url, {
    headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'manual',
    timeoutMs: 15000,
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc || hops >= MAX_HOPS) throw new Error(`too many redirects for ${url}`);
    const next = new URL(loc, url);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error(`refused redirect to ${next.protocol}`);
    return fetchHtml(next.href, hops + 1);
  }
  return (await res.text()).slice(0, MAX_BODY_CHARS);
}

function compile(src, flag) {
  if (!src) return null;
  try {
    return new RegExp(src, 'i');
  } catch (e) {
    throw new Error(`careers-page: --${flag} is not a valid regex: ${e.message}`);
  }
}

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      link: { type: 'string' },
      exclude: { type: 'string' },
      company: { type: 'string', default: '' },
      location: { type: 'string', default: '' },
      'title-strip': { type: 'string' },
      max: { type: 'string', default: '40' },
      'throttle-ms': { type: 'string', default: '400' },
      'no-detail': { type: 'boolean', default: false },
      'page-as-job': { type: 'string' },
      'allow-host': { type: 'string', multiple: true, default: [] },
      'keep-query': { type: 'boolean', default: false },
      fixture: { type: 'string' },
    },
    allowPositionals: false,
  });
  if (!values.url) throw new Error('careers-page: --url is required');
  if (!values.link && values['page-as-job'] === undefined) {
    throw new Error('careers-page: --link REGEX is required (or --page-as-job TITLE)');
  }
  const max = Math.max(1, Math.min(100, Number(values.max) || 40));
  const throttle = Math.max(0, Number(values['throttle-ms']) || 0);
  const titleStrip = compile(values['title-strip'], 'title-strip') || undefined;

  let listing;
  try {
    listing = values.fixture ? readFileSync(values.fixture, 'utf8') : await fetchHtml(values.url);
  } catch (e) {
    const err = new Error(`careers-page: listing unreachable: ${e.message}`);
    err.exitCode = 2;
    throw err;
  }

  if (values['page-as-job'] !== undefined) {
    return pageAsJob(listing, values.url, values['page-as-job'], { company: values.company, location: values.location });
  }

  const links = extractRoleLinks(listing, values.url, compile(values.link, 'link'), compile(values.exclude, 'exclude'), { allowHosts: values['allow-host'].map((h) => h.toLowerCase()), keepQuery: values['keep-query'] }).slice(0, max);
  const jobs = [];
  for (const link of links) {
    let page = null;
    if (!values['no-detail']) {
      try {
        if (values.fixture) {
          const slug = link.url.split('/').filter(Boolean).pop();
          const f = `${values.fixture}.${slug}.html`;
          page = existsSync(f) ? readFileSync(f, 'utf8') : null;
        } else {
          if (jobs.length) await sleep(throttle);
          page = await fetchHtml(link.url);
        }
      } catch (e) {
        // Skip, never fall back to the anchor text: "View role" would become the title and
        // change the next run when the fetch succeeds.
        process.stderr.write(`careers-page: role page skipped (${e.message})\n`);
        continue;
      }
    }
    const parsed = page
      ? parseRolePage(page, { titleStrip, defaultLocation: values.location, fallbackTitle: link.anchorText })
      : { title: link.anchorText, location: values.location, description: '' };
    if (!parsed.title) continue;
    jobs.push({
      title: parsed.title.slice(0, 300),
      url: link.url,
      company: values.company,
      location: (parsed.location || values.location).slice(0, 200),
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.postedAt ? { postedAt: parsed.postedAt } : {}),
    });
  }
  let size = 0;
  return jobs.filter((j) => (size += JSON.stringify(j).length) <= MAX_OUTPUT_CHARS);
}

if (isMainModule(import.meta.url)) {
  run(process.argv.slice(2))
    .then((jobs) => process.stdout.write(JSON.stringify(jobs)))
    .catch((e) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(e.exitCode || 1);
    });
}
