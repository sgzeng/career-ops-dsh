#!/usr/bin/env node
/**
 * Google Careers feed parser for career-ops `providers/local-parser.mjs`.
 *
 * LOCAL ONLY (fork file, listed in config/local-paths.txt). Google has no ATS
 * list API, and WebSearch `site:google.com/about/careers` returned mostly dead
 * job IDs, so DeepMind/Google security roles were never reaching stage 1.
 * Google does publish every open job in one public, no-login feed:
 *
 *   GET https://www.google.com/about/careers/applications/jobs/feed.xml
 *   (~20 MB, served gzipped; robots.txt allows it)
 *
 * Each <job> carries published, jobid, title, description (escaped HTML),
 * url, employer (Google / DeepMind / YouTube) and locations.
 *
 * local-parser.mjs passes postedAt (→ epoch ms) and description (plain text,
 * capped at 20000) through to scan.mjs, which applies max_posting_age_days,
 * content/visa/country filters and content rescue to them, plus title_filter,
 * location_filter and dedup, as for every other source. This script's
 * --since-days window and topic regex are a pre-filter that keeps the ~3.4k-job
 * feed down to a small output.
 *
 * Usage:
 *   node scripts/parsers/google-careers.mjs [flags]
 *
 *   --since-days N     keep jobs published in the last N days (default 14)
 *   --employers LIST   comma-separated feed employers (default DeepMind,Google,YouTube)
 *   --regex STR        case-insensitive topic regex over title + description;
 *                      empty (the default) keeps every job in the window. Set it
 *                      in portals.yml args to keep the output small, e.g.
 *                      "fuzz|vulnerab|secure code|exploit|reverse engineer"
 *   --min-jobs N       fail if the feed parses to fewer jobs than this — guards
 *                      against a truncated or changed feed (default 1000;
 *                      default 1 with --fixture)
 *   --fixture FILE     parse a saved feed file instead of fetching; for tests
 *   --dry-run          also print a human table to stderr
 *
 * Exit codes: 0 ok (JSON array on stdout, possibly []) · 1 fetch/parse failure
 * (no JSON; reason on stderr, so local-parser reports an error instead of a
 * silent zero) · 2 bad flags.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { BROWSER_LIKE_USER_AGENT } from '../../user-agent.mjs';
import { decodeEntities } from '../../providers/_html-entities.mjs';

export const FEED_URL = 'https://www.google.com/about/careers/applications/jobs/feed.xml';
const CANONICAL_BASE = 'https://www.google.com/about/careers/applications/jobs/results/';
const FETCH_TIMEOUT_MS = 45_000;
const DESCRIPTION_CAP = 20_000;
const DAY_MS = 86_400_000;

export const DEFAULT_EMPLOYERS = ['DeepMind', 'Google', 'YouTube'];
// No topic filter by default: which topics matter is the user's call, passed
// via --regex from portals.yml. title_filter in scan.mjs still gates the rest.
export const DEFAULT_TOPIC_REGEX = '';

// Feed employer → the company name already used for these employers in the
// tracker and scan-history (LinkedIn rows), so company+role dedup lines up.
const COMPANY_NAME = { deepmind: 'Google DeepMind', google: 'Google', youtube: 'YouTube' };

const unwrapCdata = (s) => s.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? unwrapCdata(m[1].trim()) : '';
}

// The description is entity-escaped HTML: decode once to get markup, strip the
// tags, decode again for entities that were inside the markup.
export function htmlToPlain(escaped) {
  const markup = decodeEntities(escaped);
  return decodeEntities(markup.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function formatLocations(block) {
  const locs = [];
  for (const m of block.matchAll(/<location>([\s\S]*?)<\/location>/g)) {
    const parts = ['city', 'state', 'country'].map((k) => decodeEntities(tag(m[1], k))).filter(Boolean);
    if (parts.length) locs.push(parts.join(', '));
  }
  return locs.join('; ');
}

/**
 * Parse the feed XML into job records. Pure, no I/O. Exported for the test.
 * @param {string} xml
 * @returns {{jobId:string,title:string,url:string,employer:string,company:string,
 *   location:string,remote:boolean,postedAt:string,description:string}[]}
 */
export function parseFeed(xml) {
  if (typeof xml !== 'string' || !xml) return [];
  const out = [];
  for (const m of xml.matchAll(/<job>([\s\S]*?)<\/job>/g)) {
    const block = m[1];
    const jobId = tag(block, 'jobid');
    const title = decodeEntities(tag(block, 'title')).replace(/\s+/g, ' ').trim();
    if (!/^\d+$/.test(jobId) || !title) continue;
    const employer = decodeEntities(tag(block, 'employer'));
    const remote = /^(yes|true)$/i.test(tag(block, 'isRemote')) || tag(block, 'remote').toLowerCase() === 'remote';
    const locations = formatLocations(block);
    out.push({
      jobId,
      title,
      // Canonical id-only form: the slugged careers.google.com URL in the feed
      // redirects here, and it is the form already stored in the tracker.
      url: `${CANONICAL_BASE}${jobId}`,
      employer,
      company: COMPANY_NAME[employer.toLowerCase()] || employer || 'Google',
      location: remote ? (locations ? `Remote; ${locations}` : 'Remote') : locations,
      remote,
      postedAt: tag(block, 'published'),
      description: htmlToPlain(tag(block, 'description')).slice(0, DESCRIPTION_CAP),
    });
  }
  return out;
}

/**
 * Recency, employer and topic filtering. Pure; `now` is injectable for tests.
 * An unparseable published date is kept (same policy as scan.mjs for undated jobs).
 */
export function filterJobs(jobs, { sinceDays = 14, employers = DEFAULT_EMPLOYERS, regex = DEFAULT_TOPIC_REGEX, now = Date.now() } = {}) {
  const cutoff = now - sinceDays * DAY_MS;
  const allowed = new Set(employers.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const topic = regex ? new RegExp(regex, 'i') : null;
  return jobs
    .filter((j) => allowed.size === 0 || allowed.has(j.employer.toLowerCase()))
    .filter((j) => {
      const t = Date.parse(j.postedAt);
      return Number.isNaN(t) || t >= cutoff;
    })
    .filter((j) => !topic || topic.test(`${j.title}\n${j.description}`))
    .sort((a, b) => (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0));
}

async function fetchFeed() {
  const res = await fetch(FEED_URL, {
    headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'application/xml,text/xml' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`google-careers: feed HTTP ${res.status}`);
  return res.text();
}

function toOutputRow(j) {
  return {
    title: j.title,
    url: j.url,
    company: j.company,
    location: j.location,
    postedAt: j.postedAt || undefined,
    description: j.description,
    jobId: j.jobId,
    source: 'google-careers',
  };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        'since-days': { type: 'string', default: '14' },
        employers: { type: 'string', default: DEFAULT_EMPLOYERS.join(',') },
        regex: { type: 'string', default: DEFAULT_TOPIC_REGEX },
        'min-jobs': { type: 'string' },
        fixture: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`google-careers: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  const v = parsed.values;
  const sinceDays = Math.max(1, Number(v['since-days']) || 14);
  const minJobs = v['min-jobs'] != null ? Math.max(0, Number(v['min-jobs']) || 0) : (v.fixture ? 1 : 1000);

  let jobs;
  try {
    const xml = v.fixture ? readFileSync(v.fixture, 'utf-8') : await fetchFeed();
    if (!/<jobs[\s>]/.test(xml.slice(0, 2000))) throw new Error('google-careers: response is not the jobs feed (no <jobs> root)');
    if (!/<\/jobs>\s*$/.test(xml)) throw new Error('google-careers: feed truncated (no closing </jobs>)');
    const all = parseFeed(xml);
    if (all.length < minJobs) throw new Error(`google-careers: parsed ${all.length} jobs, expected at least ${minJobs} — feed format may have changed`);
    jobs = filterJobs(all, {
      sinceDays,
      employers: String(v.employers).split(','),
      regex: v.regex,
    });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (v['dry-run']) {
    process.stderr.write(`\ngoogle-careers: ${jobs.length} job(s) in ${sinceDays}d matching topic regex\n`);
    for (const j of jobs) {
      process.stderr.write(`  ${(j.postedAt || '').slice(0, 10).padEnd(10)}  ${j.company.padEnd(16).slice(0, 16)}  ${j.title}  [${j.location}]\n`);
    }
    process.stderr.write('\n');
  }

  process.stdout.write(JSON.stringify(jobs.map(toOutputRow)));
}

if (isMainModule(import.meta.url)) {
  main();
}
