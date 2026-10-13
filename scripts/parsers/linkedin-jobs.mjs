#!/usr/bin/env node
/**
 * LinkedIn job-search parser for career-ops `providers/local-parser.mjs`.
 *
 * LOCAL ONLY — never upstream. CONTRIBUTING.md:134 forbids LinkedIn scrapers in
 * the project. This runs on the user's own machine, hits only LinkedIn's
 * unauthenticated guest endpoint (no cookie, no login), throttles every request,
 * and is wired in through a single `parser:` entry in the user's `portals.yml`.
 *
 * Contract with local-parser.mjs: print a JSON array of
 *   { title, url, company, location, postedAt?, source? }
 * to stdout. local-parser keeps title/url/company/location and passes postedAt
 * through (YYYY-MM-DD → UTC-midnight epoch ms, used by scan.mjs's age filters);
 * source is dropped. postedAt also drives this script's own recency filter.
 *
 * The guest endpoint returns an HTML fragment of 10 <li> cards per request, and
 * `start` is a RESULT OFFSET (not a page index):
 *   GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
 *       ?keywords=<kw>&location=<loc>&f_TPR=r<seconds>&start=<0,10,20,...>
 *
 * Usage:
 *   node scripts/parsers/linkedin-jobs.mjs [flags] <keyword> [<keyword> ...]
 *
 *   --since-days N     recency window, also LinkedIn's f_TPR (default 7)
 *   --pages N          max guest requests per keyword, 10 cards each (default 5,
 *                      i.e. the top ~50 results; paging stops early at the end)
 *   --location STR     LinkedIn location filter (default "United States")
 *   --throttle-ms N    delay between requests (default 3500, mirrors liveness-api)
 *   --dry-run          also print a human table to stderr
 *   --fixture FILE     parse a saved HTML file instead of fetching (one page); for tests
 *   --dump DIR         write each fetched page to DIR/<kw>-<start>.html for debugging
 *
 * Exit codes: 0 ok (JSON on stdout) · 2 blocked/rate-limited before any job was
 * collected (no JSON, stderr reason — local-parser then reports the error instead
 * of a silent zero).
 *
 * A block (429/403/999) or network failure AFTER at least one job was collected
 * is a PARTIAL result, not a failure: requesting stops, the jobs gathered so far
 * go to stdout, a "PARTIAL RESULT" warning naming keyword and offset goes to
 * stderr, and the exit code is 0 — discarding rows already paid for in
 * throttled requests would turn one late 429 into a whole lost scan.
 * local-parser forwards that stderr into the scan output.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { BROWSER_LIKE_USER_AGENT } from '../../user-agent.mjs';
import { decodeEntities } from '../../providers/_html-entities.mjs';

const GUEST_SEARCH_URL =
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
// One guest request returns 10 cards and `start` is a result offset: start=0,
// 10 and 25 each gave 10 cards with no overlap (live check 2026-10-13). Paging by
// 25 therefore skipped results 11-25 of every keyword. Used only to tell a short
// (last) page from a full one; the offset itself advances by cards actually seen.
const GUEST_PAGE_SIZE = 10;
const DEFAULT_PAGES = 5; // 5 requests x 10 cards = the top ~50 results per keyword

const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Parse one guest-search HTML fragment into job records.
 * Pure and deterministic — no I/O. Exported for the test.
 *
 * @param {string} html
 * @returns {{id:string,url:string,title:string,company:string,location:string,postedAt:string}[]}
 */
export function parseLinkedInSearchPage(html) {
  if (typeof html !== 'string' || !html) return [];
  const cards = html.match(/<li>[\s\S]*?<\/li>/g) || [];
  const out = [];
  for (const card of cards) {
    const idM = card.match(/data-entity-urn="urn:li:jobPosting:(\d+)"/);
    if (!idM) continue;
    const id = idM[1];

    const titleM = card.match(/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/);
    const title = titleM ? stripTags(titleM[1]) : '';
    if (!title) continue;

    const subM = card.match(
      /<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/,
    );
    const company = subM ? stripTags(subM[1]) : '';

    const locM = card.match(
      /<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/,
    );
    const location = locM ? stripTags(locM[1]) : '';

    const dateM = card.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/);
    const postedAt = dateM ? dateM[1] : '';

    // Canonical URL only — no slug, no tracking query. This is the form
    // normalizeUrlForDedup (scan.mjs) and the liveness `linkedin` rung
    // (liveness-api.mjs) both expect.
    out.push({
      id,
      url: `https://www.linkedin.com/jobs/view/${id}`,
      title,
      company,
      location,
      postedAt,
    });
  }
  return out;
}

/**
 * How many result cards a fragment holds, parseable or not. A page counts as
 * short (end of results) on this, not on parseLinkedInSearchPage().length, so a
 * single card the parser cannot read does not end paging early.
 */
export function countSearchCards(html) {
  if (typeof html !== 'string' || !html) return 0;
  return (html.match(/<li>[\s\S]*?<\/li>/g) || []).length;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchPage(keyword, { location, sinceDays, start }) {
  const url = new URL(GUEST_SEARCH_URL);
  url.searchParams.set('keywords', keyword);
  url.searchParams.set('location', location);
  url.searchParams.set('f_TPR', `r${sinceDays * 86400}`);
  url.searchParams.set('start', String(start));

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const e = new Error(`linkedin-jobs: request failed for "${keyword}" (start=${start}): ${err.message}`);
    e.fatal = true;
    throw e;
  }
  if (res.status === 429 || res.status === 999 || res.status === 403) {
    const e = new Error(`linkedin-jobs: HTTP ${res.status} for "${keyword}" (start=${start}) — rate-limited or blocked`);
    e.fatal = true;
    throw e;
  }
  if (!res.ok) {
    // 400 past the last page is normal; treat any other non-2xx as end-of-results.
    return '';
  }
  return res.text();
}

export function withinWindow(postedAt, sinceDays, now = Date.now()) {
  if (!postedAt) return true; // undated card — keep, scan.mjs / stage-2 will judge
  const posted = Date.parse(`${postedAt}T00:00:00Z`);
  if (Number.isNaN(posted)) return true;
  const ageDays = (now - posted) / 86400000;
  return ageDays <= sinceDays + 1; // +1 day slack for tz / listdate rounding
}

/**
 * Search every keyword, paging each by the number of cards actually returned.
 *
 * Returns `{ jobs, partial }`. `partial` is null on a complete run; when a
 * block (429/403/999) or network failure hits after at least one job was
 * collected, requesting stops and `partial` describes where. A failure before
 * any job was collected still throws (err.fatal → exit 2 in main()).
 *
 * `opts.fetchPage` / `opts.sleep` are injection points for tests; they default
 * to the real network fetch and a real timer.
 */
export async function collectJobs(keywords, opts) {
  const { pages, throttleMs, dump } = opts;
  const getPage = opts.fetchPage || fetchPage;
  const wait = opts.sleep || sleep;
  const seen = new Set();
  const jobs = [];
  let requests = 0;
  let partial = null;

  keywordLoop:
  for (const [keywordIndex, keyword] of keywords.entries()) {
    // The stop condition is per keyword: a page that is entirely ids an EARLIER
    // keyword already produced says nothing about the pages after it.
    const seenForKeyword = new Set();
    let start = 0;
    for (let p = 0; p < pages; p++) {
      if (requests > 0) await wait(throttleMs);
      requests++;
      let html;
      try {
        html = await getPage(keyword, { ...opts, start });
      } catch (err) {
        if (!err.fatal || jobs.length === 0) throw err;
        partial = { keyword, start, keywordIndex, keywordCount: keywords.length, error: err };
        break keywordLoop;
      }
      if (dump) {
        try {
          mkdirSync(dump, { recursive: true });
          writeFileSync(join(dump, `${keyword.replace(/\W+/g, '_')}-${start}.html`), html);
        } catch { /* debugging aid only */ }
      }
      if (!html.trim()) break; // no more results for this keyword
      const parsed = parseLinkedInSearchPage(html);
      if (parsed.length === 0) break;
      let fresh = 0;
      for (const j of parsed) {
        if (!seenForKeyword.has(j.id)) {
          seenForKeyword.add(j.id);
          fresh++;
        }
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        if (!withinWindow(j.postedAt, opts.sinceDays)) continue;
        jobs.push({
          title: j.title,
          url: j.url,
          company: j.company,
          location: j.location,
          postedAt: j.postedAt || undefined,
          source: 'linkedin',
        });
      }
      if (fresh === 0) break; // the endpoint is repeating itself
      if (countSearchCards(html) < GUEST_PAGE_SIZE) break; // short page: end of results
      // Advance by what was actually read, never by an assumed page size: a
      // card the parser dropped is then re-seen (and deduped) next page instead
      // of skipped, and a page larger than GUEST_PAGE_SIZE leaves no gap.
      start += parsed.length;
    }
  }
  return { jobs, partial };
}

/** The stderr line for a partial result; names the keyword and the offset. */
export function formatPartialWarning(partial, jobCount) {
  const cause = partial.error.message.replace(/^linkedin-jobs: /, '');
  const untouched = partial.keywordCount - partial.keywordIndex - 1;
  return `linkedin-jobs: PARTIAL RESULT — ${cause}. Stopped requesting; kept ${jobCount} job(s) from `
    + `before the block. "${partial.keyword}" (keyword ${partial.keywordIndex + 1}/${partial.keywordCount}) was cut off `
    + `at start=${partial.start} and ${untouched} later keyword(s) were not searched.`;
}

const USAGE = `Usage:
  node scripts/parsers/linkedin-jobs.mjs [flags] <keyword> [<keyword> ...]

  --since-days N     recency window, also LinkedIn's f_TPR (default 7)
  --pages N          max guest requests per keyword, 10 cards each; stops early at
                     the end of the results (default 5, the top ~50)
  --location STR     LinkedIn location filter (default "United States")
  --throttle-ms N    delay between requests (default 3500)
  --dry-run          also print a human table to stderr
  --fixture FILE     parse a saved HTML file instead of fetching (one page); for tests
  --dump DIR         write each fetched page to DIR/<kw>-<start>.html (start = result offset)
  --help, -h         print this usage block and exit

Prints a JSON array on stdout. Exit codes: 0 ok (also a PARTIAL result: a block after
jobs were collected prints them plus a warning on stderr), 1 fetch failure, 2 blocked or
rate-limited before any job was collected, or bad flags.`;

async function main() {
  // Before anything is fetched: an unhandled flag must never run the search
  // (tests/help-flag-handled.test.mjs).
  if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'since-days': { type: 'string', default: '7' },
        pages: { type: 'string', default: String(DEFAULT_PAGES) },
        location: { type: 'string', default: 'United States' },
        'throttle-ms': { type: 'string', default: '3500' },
        'dry-run': { type: 'boolean', default: false },
        fixture: { type: 'string' },
        dump: { type: 'string' },
      },
    });
  } catch (err) {
    process.stderr.write(`linkedin-jobs: ${err.message}\n`);
    process.exit(2);
  }

  const keywords = parsed.positionals.filter(Boolean);
  const sinceDays = Math.max(1, Number(parsed.values['since-days']) || 7);
  const opts = {
    sinceDays,
    pages: Math.max(1, Math.floor(Number(parsed.values.pages)) || DEFAULT_PAGES),
    location: parsed.values.location,
    throttleMs: Math.max(0, Number(parsed.values['throttle-ms']) || 3500),
    dump: parsed.values.dump,
  };

  let jobs;
  let partial = null;
  try {
    if (parsed.values.fixture) {
      const html = readFileSync(parsed.values.fixture, 'utf-8');
      jobs = parseLinkedInSearchPage(html)
        .filter((j) => withinWindow(j.postedAt, sinceDays))
        .map((j) => ({
          title: j.title,
          url: j.url,
          company: j.company,
          location: j.location,
          postedAt: j.postedAt || undefined,
          source: 'linkedin',
        }));
    } else {
      if (keywords.length === 0) {
        process.stderr.write('linkedin-jobs: no keywords given\n');
        process.exit(2);
      }
      ({ jobs, partial } = await collectJobs(keywords, opts));
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.fatal ? 2 : 1);
  }

  if (partial) process.stderr.write(`${formatPartialWarning(partial, jobs.length)}\n`);

  if (parsed.values['dry-run']) {
    process.stderr.write(`\nlinkedin-jobs: ${jobs.length} job(s) after recency filter (${sinceDays}d)\n`);
    for (const j of jobs) {
      process.stderr.write(
        `  ${(j.postedAt || '----------').padEnd(10)}  ${String(j.company).padEnd(24).slice(0, 24)}  ${j.title}\n`,
      );
    }
    process.stderr.write('\n');
  }

  process.stdout.write(JSON.stringify(jobs));
}

if (isMainModule(import.meta.url)) {
  main();
}
