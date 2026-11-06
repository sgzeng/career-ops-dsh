// lib/jd-cache.mjs — stage-1 JD cache (fork-local).
//
// Every posting the scanners append to data/pipeline.md gets its JD text read
// once, here, with zero LLM tokens, and saved under jds/stage1/. The pipeline
// row carries `jd: local:jds/stage1/<file>` in its note, so the stage-2 agent
// reads a local file instead of re-fetching: it runs in a sandbox whose egress
// refuses the ATS APIs, and LinkedIn costs it a logged-in Chrome session per
// row. A row whose JD could not be read is marked `jd: unread` and stage 2
// falls back to its own route.
//
// Two scanners call this: scan.mjs (watchlist) and scan-ats-full.mjs (reverse
// sweep). Both pass their already-deduplicated new offers, so a fetch is never
// spent on a posting that will not reach pipeline.md.
//
// The visa gate runs again on every JD fetched here: the in-loop visa fetch in
// scan.mjs is capped (visa_filter.fetch_jd_max_per_run) and spent before
// dedup, so a blind listing (LinkedIn) used to reach the pipeline unread and
// stage 2 hard-blocked it on a citizenship line stage 1 could have quoted.
//
// Config (portals.yml, all optional):
//   jd_cache:                  # absent = off
//     enabled: true            # default true once the block exists
//     dir: jds/stage1          # relative to the data root
//     fetch_max_per_run: 200   # JD requests per scanner run
//     fetch_budget_secs: 300   # wall-clock cap for those requests
//     linkedin_gap_ms: 2000    # pause between LinkedIn requests
//     gap_ms: 250              # pause between other requests

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Below this many characters a description is a teaser, not a JD (the same
// threshold scan.mjs's visa gate and lib/level-filter.mjs use).
export const MIN_JD_CHARS = 400;
const LINKEDIN_BREAKER = 3;

const DEFAULTS = Object.freeze({
  enabled: true,
  dir: 'jds/stage1',
  fetchMax: 200,
  budgetMs: 300_000,
  linkedinGapMs: 2000,
  gapMs: 250,
});

function nonNegInt(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** @param {unknown} raw portals.yml `jd_cache` */
export function resolveJdCacheConfig(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // Kept inside the data root: an absolute path or a `..` segment falls back to
  // the default (validate-portals.mjs reports it as an error).
  const raw_dir = typeof c.dir === 'string' ? c.dir.trim().replace(/\/+$/, '') : '';
  const dir = raw_dir && !raw_dir.startsWith('/') && !raw_dir.split('/').includes('..') ? raw_dir : DEFAULTS.dir;
  return {
    // Opt-in: only a `jd_cache:` block in portals.yml turns it on, so an
    // install (or a test sandbox) without one sends no extra JD requests.
    enabled: raw != null && raw !== false && c.enabled !== false,
    dir,
    fetchMax: nonNegInt(c.fetch_max_per_run, DEFAULTS.fetchMax),
    budgetMs: nonNegInt(c.fetch_budget_secs, DEFAULTS.budgetMs / 1000) * 1000,
    linkedinGapMs: nonNegInt(c.linkedin_gap_ms, DEFAULTS.linkedinGapMs),
    gapMs: nonNegInt(c.gap_ms, DEFAULTS.gapMs),
  };
}

export function isLinkedInUrl(url) {
  try {
    return /(^|\.)linkedin\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function hasJdText(offer) {
  return typeof offer?.description === 'string' && offer.description.trim().length >= MIN_JD_CHARS;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a JD for each offer that lacks one, then re-run the visa gate on the
 * fetched text. Offers are mutated in place (`description`, `jdSource`).
 *
 * @param {Array<object>} offers already-deduplicated new offers
 * @param {ReturnType<typeof resolveJdCacheConfig>} cfg
 * @param {{ fetchJd: (url: string) => Promise<string|null>, visaFilter?: { assess: Function } | null,
 *   now?: () => number, sleep?: (ms: number) => Promise<void> }} deps
 * @returns {Promise<{ kept: object[], visaDropped: object[], stats: object }>}
 */
export async function enrichOffersWithJd(offers, cfg, deps) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || defaultSleep;
  const stats = { listing: 0, fetched: 0, failed: 0, notTried: 0, linkedinStopped: false };
  const started = now();
  let attempts = 0;
  let linkedinFails = 0;
  let lastWasLinkedIn = null;
  const kept = [];
  const visaDropped = [];

  for (const offer of offers) {
    if (hasJdText(offer)) {
      offer.jdSource = offer.jdSource || 'listing';
      stats.listing++;
      kept.push(offer);
      continue;
    }
    const li = isLinkedInUrl(offer.url);
    const outOfBudget = attempts >= cfg.fetchMax || now() - started >= cfg.budgetMs;
    if (!cfg.enabled || outOfBudget || (li && stats.linkedinStopped) || typeof offer.url !== 'string') {
      stats.notTried++;
      kept.push(offer);
      continue;
    }
    if (attempts > 0) await sleep(li || lastWasLinkedIn ? cfg.linkedinGapMs : cfg.gapMs);
    attempts++;
    lastWasLinkedIn = li;
    let text = null;
    try { text = await deps.fetchJd(offer.url); } catch { text = null; }
    if (typeof text === 'string' && text.trim().length >= MIN_JD_CHARS) {
      offer.description = text;
      offer.jdSource = 'fetched';
      stats.fetched++;
      if (li) linkedinFails = 0;
      const verdict = deps.visaFilter?.assess ? deps.visaFilter.assess(text) : { pass: true };
      if (!verdict.pass) {
        visaDropped.push({ offer, verdict });
        continue;
      }
    } else {
      stats.failed++;
      // Three LinkedIn misses in a row is a rate limit (HTTP 429), not three
      // dead postings: stop asking for the rest of this run.
      if (li && ++linkedinFails >= LINKEDIN_BREAKER) stats.linkedinStopped = true;
    }
    kept.push(offer);
  }
  return { kept, visaDropped, stats };
}

function slug(value, max) {
  return String(value ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, max).replace(/-+$/g, '') || 'x';
}

export function jdCacheFileName(offer, date) {
  const hash = createHash('sha256').update(String(offer.url)).digest('hex').slice(0, 16);
  return `${date}_${slug(offer.company, 30)}_${slug(offer.title, 50)}_${hash}.md`;
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function appendNote(offer, segment) {
  const note = typeof offer.note === 'string' ? offer.note.trim() : '';
  if (/(?:^|— )jd: /.test(note)) return;
  offer.note = note ? `${note} — ${segment}` : segment;
}

/**
 * Write one cache file per offer that has JD text, and label every offer's
 * note with where its JD is (`jd: local:<path>`) or `jd: unread`.
 *
 * @param {Array<object>} offers
 * @param {ReturnType<typeof resolveJdCacheConfig>} cfg
 * @param {{ root: string, date: string }} where
 * @returns {{ written: number, unread: number }}
 */
export function writeJdCaches(offers, cfg, { root, date }) {
  let written = 0;
  let unread = 0;
  if (!cfg.enabled) return { written, unread };
  const absDir = path.resolve(root, cfg.dir);
  for (const offer of offers) {
    if (!hasJdText(offer)) {
      appendNote(offer, 'jd: unread');
      unread++;
      continue;
    }
    const name = jdCacheFileName(offer, date);
    const rel = `${cfg.dir}/${name}`;
    const file = path.join(absDir, name);
    if (!existsSync(file)) {
      mkdirSync(absDir, { recursive: true });
      const text = offer.description.trim();
      const source = offer.jdSource === 'fetched' ? 'fetched from the posting\'s public JD endpoint' : 'the board listing';
      const body = [
        `# ${oneLine(offer.title)} — ${oneLine(offer.company)}`,
        '',
        `**URL:** ${oneLine(offer.url)}`,
        offer.location ? `**Location:** ${oneLine(offer.location)}` : null,
        `**Captured:** ${date} by the stage-1 scanner (zero-token), from ${source}; ${text.length} chars, HTML stripped, otherwise verbatim.`,
        '',
        `## Job Description (scraped ${date})`,
        '',
        text,
        '',
      ].filter((line) => line !== null).join('\n');
      writeFileSync(file, body, 'utf-8');
      written++;
    }
    appendNote(offer, `jd: local:${rel}`);
  }
  return { written, unread };
}

/** One summary line for the scan log. */
export function formatJdCacheSummary(stats, writes, droppedCount) {
  const parts = [
    `${stats.listing} from listing`,
    `${stats.fetched} fetched`,
    stats.failed ? `${stats.failed} fetch failed` : '',
    stats.notTried ? `${stats.notTried} not tried (budget/limit)` : '',
    stats.linkedinStopped ? 'LinkedIn stopped after 3 misses in a row (rate limit?)' : '',
    `${writes.written} cached, ${writes.unread} unread`,
    droppedCount ? `${droppedCount} dropped by the visa gate on the fetched JD` : '',
  ].filter(Boolean);
  return `JD cache:              ${parts.join(', ')}`;
}
