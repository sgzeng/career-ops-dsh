#!/usr/bin/env node

/**
 * scan-ats-full.mjs — Reverse ATS discovery scanner. Part of #230.
 *
 * Where scan.mjs scans the companies you track in portals.yml, this script
 * inverts the direction: it walks public directories of companies per ATS
 * (Greenhouse, Lever, Ashby, Workday, iCIMS, BambooHR) and surfaces fresh
 * postings that match your portals.yml `title_filter` / `location_filter` —
 * no manual company curation needed.
 *
 * Optional `title_filter_full` in portals.yml overrides `title_filter` for
 * THIS scanner only, so the keywords tuned for scan.mjs's curated company
 * list do not have to double as the filter for every public board. Absent,
 * `title_filter` is used exactly as before.
 *
 * Optional `title_filter_overrides` broadens the title net further still,
 * but scoped to specific companies (matched by slug) rather than the whole
 * sweep — e.g. letting known university/college employers surface general
 * campus-admin postings without loosening the net for everyone else. See
 * scan.mjs's buildTitleFilterOverrides()/buildTitleFilterWithOverrides().
 *
 * Optional `domain_filter` in portals.yml gates whole BOARDS before any title
 * is tested (#3105): a board with no domain-bearing posting is not this user's
 * industry, and is skipped entirely. Absent — the default — every board is
 * swept exactly as before. Not applied to --seeds: a VC portfolio is already a
 * curated corpus, so gating it would be redundant.
 *
 * After the title filter a posting also passes the gates scan.mjs applies —
 * skip_tiers, country_eligibility_filter, visa_filter — and the same company+title
 * duplicate check against the tracker, pipeline and scan history, so a role already
 * known under another URL is not appended again. A source whose host keeps
 * answering 429/403 is abandoned after SWEEP_REFUSAL_LIMIT refusals in a row, and a
 * run stopped by SIGTERM/SIGALRM (ops/daily-scan.sh's time limit) saves the matches
 * it already has. See createSweepGate(), buildQualityGates(), createRoleDedup().
 *
 * Company directories come from the public job-board-aggregator dataset
 * (github.com/Feashliaa/job-board-aggregator), cached in data/cache/ for 24h.
 *
 * Zero LLM tokens — pure HTTP + JSON, same providers/ modules as scan.mjs.
 * Postings without a usable publish date are skipped: a reverse scan is only
 * useful for fresh postings, and stale results would flood the pipeline.
 *
 * Usage:
 *   node scan-ats-full.mjs                      # scan all ATS directories, last 3 days
 *   node scan-ats-full.mjs --since 7            # postings from the last 7 days
 *   node scan-ats-full.mjs --ats greenhouse,workday  # subset of sources
 *   node scan-ats-full.mjs --history-seeds --ats successfactors # scan history-derived boards
 *   node scan-ats-full.mjs --limit 200          # max companies per ATS (default: all)
 *   node scan-ats-full.mjs --dry-run            # preview without writing files
 *   node scan-ats-full.mjs --liveness           # Playwright-verify matches before writing
 *   node scan-ats-full.mjs --include-blacklisted # audit: let data/blacklist.md matches through, annotated
 *   node scan-ats-full.mjs --verbose            # log per-board fetch failures
 *   node scan-ats-full.mjs --md-out <dir>       # also write a dated markdown digest to <dir>
 *   node scan-ats-full.mjs --resume             # continue an interrupted sweep from its checkpoint
 *   node scan-ats-full.mjs --seeds yc,a16z      # probe VC-portfolio companies (Greenhouse/Ashby/Lever)
 *   node scan-ats-full.mjs --seeds yc --refresh-seed-cache # ignore remembered 404s, re-probe everything
 *   node scan-ats-full.mjs --help               # print this usage block and exit
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { constants as osConstants } from 'os';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { renameSyncWithRetry } from './tracker-utils.mjs';

import { makeHttpCtx, fetchJson } from './providers/_http.mjs';
import { withConnectionScope } from './providers/_connection-scope.mjs';
import { isResolverFailure, dnsPacingStats } from './providers/_dns-cache.mjs';
import greenhouse from './providers/greenhouse.mjs';
import lever from './providers/lever.mjs';
import ashby from './providers/ashby.mjs';
import workday, { WORKDAY_TRUNCATED_REASON } from './providers/workday.mjs';
import icims from './providers/icims.mjs';
import bamboohr from './providers/bamboohr.mjs';
import {
  buildTitleFilter, buildTitleFilterOverrides, buildTitleFilterWithOverrides, buildLocationFilter, buildContentFilter,
  buildCountryEligibilityFilter, buildVisaFilter, loadCandidateCountry, matchedTitleKeywords, loadSeenUrls, loadDedupSnapshot,
  normalizeUrlForDedup, appendToPipeline, appendToScanHistory, findBlacklistEntry, loadBlacklist, parseSinceDays,
  buildCompanyCanonicalizer, companyRoleDedupKey, matchesSeenCompanyRole, requisitionIdsForDedup, languageFormsForDedup,
  recordForms, recordLanguages, resolveDedupIncludeLocation, resolveDedupIncludeLanguage, scanHistoryPolicy,
  PORTALS_PATH, PIPELINE_PATH, SCAN_HISTORY_PATH,
} from './scan.mjs';
import { buildMustCatch } from './lib/content-rescue.mjs';
import { classifyTier } from './classify-tier.mjs';
import { buildLevelFilter } from './lib/level-filter.mjs';
import { fetchJobDescription } from './lib/jd-text.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { SEED_SOURCES, prioritizeSeedCompanies } from './seeds/vc-portfolios.mjs';
import {
  classifyProbeError, createHostGate, createSeedRunState, emptyUnreachable, formatUnreachable, newSeedStats, observeCtx,
  probeSeedCompany, resolveSeedGapMs, saveSeedState, unreachableTotal,
} from './seeds/seed-probe.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { boardKey, loadDeadBoards, recordBoardFailure, recordBoardResult, saveDeadBoards, shouldSkipDeadBoard } from './dead-boards.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { barePrefixDomainKeywords, buildDomainFilter } from './title-keywords.mjs';
import { KNOWN_ATS_VENDORS } from './ats-vendor.mjs';
import { loadHistoryAtsSeeds } from './history-ats-seeds.mjs';
import { loadProviders } from './providers/_registry.mjs';

// ── Config ──────────────────────────────────────────────────────────

// PORTALS_PATH and PIPELINE_PATH are imported from scan.mjs rather than
// re-derived here (#3510). This file appends results through scan.mjs's
// appendToPipeline, so its own bare-relative copy meant it could create an empty
// data/pipeline.md in the cwd and then write the actual matches somewhere else.
// Its portals fallback had the same split: it honored CAREER_OPS_PORTALS but
// otherwise looked in the cwd instead of the data root.
const DATA_ROOT = getCareerOpsRoot();
const PROVIDERS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers');
const CACHE_DIR = path.join(DATA_ROOT, 'data/cache/ats-companies');
const CACHE_TTL_HOURS = 24;
// Tracks `main` deliberately: the dataset's value is freshness (new boards
// appear weekly), so pinning a commit would defeat the purpose. Integrity rests
// on two layers instead: SLUG_RE validates every entry against a safe charset
// before interpolation, and entryOnHost (below) re-parses each finished
// careers_url and drops anything that doesn't resolve to the ATS's own host —
// so a tampered dataset can at worst name boards that don't exist.
const DATASET_BASE = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';

// Default fan-out. Correct for sources whose boards each live on their OWN
// host — workday is {tenant}.{instance}.myworkdayjobs.com, so 20 in flight is
// 20 different servers and the resolver, not any one vendor, is the limit.
const CONCURRENCY = 20;

// Greenhouse, Lever and Ashby each serve their ENTIRE directory from a single
// hostname (boards-api.greenhouse.io, api.lever.co, api.ashbyhq.com), so the
// default is 20 sustained connections to ONE API across thousands of boards.
// That earns an HTTP throttle, and a throttled sweep loses live boards rather
// than failing loudly: two full sweeps an hour apart saw lever's unreachable
// count go 2,436 -> 4,100 and ashby's 683 -> 1,675, then recover to 2,525 / 684
// after a cooldown with no change to the dataset. The boards were never dead —
// they were refused, and the matches on them were silently missed.
const SINGLE_HOST_CONCURRENCY = 6;
// A refusing resolver fails every lookup in milliseconds, so a sweep that
// keeps going just feeds it (#2229). Stop after this many consecutive
// resolver-level failures — high enough that a handful of unlucky boards
// can't trip it, low enough to stop within seconds of a real outage.
const RESOLVER_FAILURE_LIMIT = 50;

// A host answering 429 or 403 is asking the sweep to slow down, and the
// greenhouse/lever providers do not retry, so a sweep that ignores it keeps
// firing at full speed and files every refused board under one "unreachable"
// number. The seed scan already has the mechanism (createHostGate: a refusal
// pauses the host, a run of them abandons it for the rest of the run); the sweep
// reuses it, one per source whose directory sits behind a single host (see
// createSourceGate), for the same reason the DNS breaker above exists.
//
// 25 is a number between the two limits already in this file. The seed scan's
// default of 10 is crossed by the second round of refusals, because six workers
// are in flight and the first refusal usually brings five more with it; 50 is
// the DNS limit, sized for lookups that fail in milliseconds and cost nothing.
// A refused host is paid for in waiting (15s, then 120s a round), so 25 means
// five rounds, about six minutes, which still fits inside the 600s daily-scan.sh
// allows one directory. Any 200 or 404 in between resets the count, so the
// scattered 403s a healthy sweep sees (1-17 per run, the board answering 200
// later) never accumulate.
export const SWEEP_REFUSAL_LIMIT = 25;
const SWEEP_COOLDOWN_BASE_MS = 15_000;
const SWEEP_COOLDOWN_MAX_MS = 120_000;

/**
 * The back-off clock for the sweep's refusal breaker. The defaults are the seed
 * scan's (15s doubling to 120s); the variables exist so a deployment can be more
 * patient and a test does not have to wait out the real thing. Unusable values
 * fall back rather than failing a scan over a typo.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ cooldownBaseMs: number, cooldownMaxMs: number }}
 */
export function resolveSweepCooldown(env = process.env) {
  const ms = (raw, fallback) => {
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 600_000 ? n : fallback;
  };
  const cooldownBaseMs = ms(env.CAREER_OPS_SWEEP_COOLDOWN_MS, SWEEP_COOLDOWN_BASE_MS);
  return { cooldownBaseMs, cooldownMaxMs: Math.max(cooldownBaseMs, ms(env.CAREER_OPS_SWEEP_COOLDOWN_MAX_MS, SWEEP_COOLDOWN_MAX_MS)) };
}

/**
 * One refusal breaker for a sweep run. Concurrency is parallelEach's job here, so
 * the gate's own per-key limiter is a pass-through; what it adds is the pause on
 * a 429/403 (the host's Retry-After, else 15s doubling to 120s), the reset on a
 * 404 or a success, and the abandon after SWEEP_REFUSAL_LIMIT in a row.
 *
 * @param {{ onAbandon?: (key: string, cls: string, count: number) => void, sleep?: (ms: number) => Promise<void>, now?: () => number, env?: Record<string, string | undefined> }} [opts]
 */
export function createSweepGate({ onAbandon, sleep, now, env = process.env } = {}) {
  return createHostGate({
    withKeySlot: (_key, fn) => fn(),
    blockLimit: SWEEP_REFUSAL_LIMIT,
    sleep,
    now,
    onAbandon,
    ...resolveSweepCooldown(env),
  });
}

/**
 * The breaker for one SOURCE, or null when the source has none.
 *
 * Only a source whose whole directory sits behind one hostname (greenhouse,
 * lever, ashby: `singleHost`) has one. There a 429/403 from any board is the host
 * talking to the sweep, and the next board will hear the same. A source that
 * gives every tenant its own host (workday, icims, bamboohr) cannot be read that
 * way: a 403 from one Workday tenant says nothing about the next, and 3 of 25
 * tenants in a live sample answered 403 to every request (a WAF in front of that
 * one tenant), so a source-wide pause would have stalled the sweep for each of
 * them. Those sources are classified (see the unreachable breakdown) and run as
 * they always did.
 *
 * @param {{ singleHost?: boolean }} source
 * @param {Parameters<typeof createSweepGate>[0]} [opts]
 */
export function createSourceGate(source, opts) {
  return source?.singleHost ? createSweepGate(opts) : null;
}

/**
 * Run one provider call for a board under the gate. A board that is itself
 * refused is asked once more after the pause its refusal started, so a short
 * throttle does not cost the matches on the boards it happened to hit. If the
 * retry runs into the abandon, the board reports its own refusal rather than
 * "skipped": it was asked, and answered 429/403.
 *
 * @template T
 * @param {ReturnType<typeof createSweepGate> | null} gate - null: no breaker for this source, the call is made as is.
 * @param {string} key - The source, standing in for the host.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runGuarded(gate, key, fn) {
  if (!gate) return fn();
  try {
    return await gate.run(key, fn);
  } catch (err) {
    const cls = err?.hostAbandoned ? null : classifyProbeError(err);
    if (cls !== '429' && cls !== '403') throw err;
    try {
      return await gate.run(key, fn);
    } catch (second) {
      throw second?.hostAbandoned ? err : second;
    }
  }
}

// Crash insurance for multi-hour directory sweeps: progress + matches are
// checkpointed every CHECKPOINT_EVERY companies so --resume can continue a
// dead run (with its ORIGINAL date window) instead of restarting from zero.
// Anchored too (#3510): a sweep resumed from a different directory found no
// checkpoint and silently restarted a multi-hour run from zero — the one failure
// mode --resume exists to prevent.
const CHECKPOINT_PATH = path.join(DATA_ROOT, 'data/cache/ats-full-checkpoint.json');
const CHECKPOINT_EVERY = 500;
const DEAD_BOARDS_PATH = path.join(DATA_ROOT, 'data/dead-boards.tsv');
// The seed scan's own memory, kept apart from the mass sweep's: it keys on
// (vendor, slug) rather than careers_url, retires a board after ONE 404 (a
// portfolio slug that 404s on a vendor is simply not there), and also records
// which vendor each live company resolved to. See seeds/seed-probe.mjs.
const SEED_DEAD_BOARDS_PATH = path.join(DATA_ROOT, 'data/seed-dead-boards.tsv');
const SEED_LIVE_BOARDS_PATH = path.join(DATA_ROOT, 'data/seed-live-boards.tsv');

export function loadCheckpoint(file = CHECKPOINT_PATH) {
  if (!existsSync(file)) return null;
  try {
    const cp = JSON.parse(readFileSync(file, 'utf-8'));
    if (cp?.version !== 1) return null;
    // A version tag alone isn't enough: `current` is consumed unchecked below
    // (`entriesAll.slice(resumeAt)`), so a truncated or hand-edited record with
    // a missing/non-numeric resumeAt would silently rescan from zero and then
    // persist `startAt + resumeAt === NaN` into every later checkpoint — a state
    // no subsequent resume can recover from. Reject the malformed record instead.
    if (cp.current !== null && cp.current !== undefined && !validCheckpointCurrent(cp.current)) return null;
    return cp;
  } catch {
    return null;
  }
}

function validCheckpointCurrent(cur) {
  return typeof cur === 'object'
    && typeof cur.name === 'string'
    && Number.isInteger(cur.resumeAt) && cur.resumeAt >= 0
    && Number.isInteger(cur.datasetLen) && cur.datasetLen >= 0
    && (cur.deferred === undefined
      || (Array.isArray(cur.deferred) && cur.deferred.every((i) => Number.isInteger(i) && i >= 0)));
}

// A checkpoint written under different scan settings must not be resumed —
// silently mixing sources, caps, or undated policy would corrupt the run's
// semantics. --shuffle is never resumable: the sampled order isn't reproducible.
export function checkpointCompatible(cp, opts) {
  return Boolean(cp)
    && !opts.shuffle
    && JSON.stringify(cp.ats) === JSON.stringify(opts.ats)
    && (cp.limit ?? null) === (opts.limit === Infinity ? null : opts.limit)
    && cp.includeUndated === opts.includeUndated;
}

// Flags are not the only settings a resume can mix. The portals.yml filters
// decide which boards and postings the swept part kept, so a filter edited
// between a run and its --resume leaves the checkpointed matches judged by one
// configuration and the rest by another. Each filter is fingerprinted under its
// own key, so the refusal can name what changed. title_filter_full replaces
// title_filter when present, so the pair is recorded under whichever key the
// sweep actually read. Keys are sorted before hashing: reordering a YAML
// mapping changes nothing the sweep does.
export function filterFingerprints(config, { candidateCountry = '' } = {}) {
  const titleKey = config?.title_filter_full ? 'title_filter_full' : 'title_filter';
  const fp = (v) => datasetFingerprint(sortKeys(v ?? null));
  return {
    [titleKey]: fp(resolveTitleFilterConfig(config)),
    title_filter_overrides: fp(config?.title_filter_overrides),
    location_filter: fp(config?.location_filter),
    content_filter: fp(config?.content_filter),
    domain_filter: fp(config?.domain_filter),
    // Fork-local: level_filter (lib/level-filter.mjs) also decides which swept
    // postings were kept, so an edit between a run and its --resume would mix
    // two ceilings the same way an edited title_filter would.
    level_filter: fp(config?.level_filter),
    // The gates scan.mjs applies that the sweep now applies too. The country
    // gate depends on the profile's country as well as on its own config (it is
    // inert for a United States profile), so both are recorded.
    skip_tiers: fp(config?.skip_tiers),
    visa_filter: fp(config?.visa_filter),
    country_eligibility_filter: fp(config?.country_eligibility_filter
      ? { filter: config.country_eligibility_filter, candidateCountry: String(candidateCountry ?? '').toLowerCase().trim() }
      : null),
  };
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

// A checkpoint written before filters were recorded carries no fingerprints, so
// there is nothing to compare and it resumes as it did before.
//
// A key the checkpoint never recorded (a filter this script learned after the
// checkpoint was written) reads as that filter being unset, which is what the
// run that wrote it did: it is a change only if the config now sets it.
export function changedFilterKeys(cp, fingerprints) {
  if (!cp?.filters) return [];
  const unset = datasetFingerprint(sortKeys(null));
  return Object.keys(fingerprints).filter((k) => (cp.filters[k] ?? unset) !== fingerprints[k]);
}

// Never throws: this runs from parallelEach's `finally`, so an escaping error
// (ENOSPC, EACCES, read-only volume) would reject the whole sweep and discard
// every in-memory match from a multi-hour run — the checkpoint killing the work
// it exists to protect. A failed write costs resumability, not the results.
function writeCheckpoint(cp) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${CHECKPOINT_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(cp), 'utf-8');
    renameSyncWithRetry(tmp, CHECKPOINT_PATH); // atomic: a crash mid-write can't corrupt the checkpoint; retries Windows contention
    return true;
  } catch (err) {
    console.error(`\n⚠ checkpoint write failed (${err.message}) — sweep continues, --resume unavailable`);
    return false;
  }
}

// Dead-board memory is useful resumability metadata, but a cache write must
// never discard the matches from a long-running sweep. Keep it best-effort,
// just like the main checkpoint write above.
function saveDeadBoardsBestEffort(rows) {
  try {
    saveDeadBoards(DEAD_BOARDS_PATH, rows);
    return true;
  } catch (err) {
    console.error(`\n⚠ dead-board cache write failed (${err.message}) — sweep continues`);
    return false;
  }
}

// Cheap content fingerprint of a source's company list. --resume relies on the
// dataset order being byte-for-byte reproducible; a same-length regeneration
// with different members would pass a bare length check and silently resume at
// the wrong offset (companies skipped or re-scanned). Hashing the list detects
// that drift so we can fail loudly instead.
export function datasetFingerprint(list) {
  return createHash('sha1').update(JSON.stringify(list)).digest('hex').slice(0, 16);
}

// Dataset entries are external input destined for URL interpolation — reject
// anything outside a conservative slug charset.
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

// ~47% of workday_companies.json is a data-quality defect in the upstream
// job-board-aggregator dataset: the tenant field holds an instance-name
// lookalike (wd1, wd5, wd12, ...) instead of a real company, with the site
// field copied from the corresponding real entry — every one of these hosts
// is unresolvable. Confirmed against the full dataset (2026-09): exactly 15
// distinct values match this pattern, every matching row sits inside one
// contiguous corrupted block, and none corresponds to a real company (#4454).
const WORKDAY_JUNK_TENANT_RE = /^wd\d+$/i;

// SSRF guard / defense in depth: confirm a constructed careers_url actually
// resolves to the expected ATS host before it reaches provider.fetch. Returns
// the synthetic entry, or null if the URL won't parse or the host isn't canonical.
export function entryOnHost(name, careersUrl, isCanonicalHost) {
  let hostname;
  try {
    ({ hostname } = new URL(careersUrl));
  } catch {
    return null;
  }
  return isCanonicalHost(hostname) ? { name, careers_url: careersUrl } : null;
}

// The public iCIMS dataset is not consistent about what an entry is. Most are a
// bare tenant ("acmefreight", served at careers-acmefreight.icims.com), but
// thousands are already the full portal subdomain: "careers-acmefreight",
// "uscareers-acme", "acmecareers-west". Prefixing every entry with "careers-"
// built hosts like careers-careers-acmefreight.icims.com that do not exist, so
// those boards answered 404 and were recorded as dead. Neither reading is safe
// on its own (a bare tenant can contain a hyphen, and some bare tenants are
// served without the prefix), so return the likelier host first and the other
// shape as a fallback that icims.fetch() tries only on a first-page 404.
export function icimsHostCandidates(slug) {
  const s = String(slug ?? '').toLowerCase().replace(/^-+/, '');
  if (!s) return [];
  const asIs = `${s}.icims.com`;
  const prefixed = `careers-${s}.icims.com`;
  if (s.startsWith('careers-')) return [asIs];
  return s.includes('careers') ? [asIs, prefixed] : [prefixed, asIs];
}

// Each source: the provider module that does the fetching, plus how to turn a
// dataset entry into a synthetic PortalEntry the provider can detect/fetch.
export const SOURCES = {
  greenhouse: {
    provider: greenhouse,
    // Whole directory behind one host — see SINGLE_HOST_CONCURRENCY.
    concurrency: SINGLE_HOST_CONCURRENCY,
    // One host means one keep-alive pool, so per-board connection scopes would
    // only add a TLS handshake per board (see boardScope below).
    singleHost: true,
    dataset: `${DATASET_BASE}/greenhouse_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://job-boards.greenhouse.io/${slug}`, h => h === 'job-boards.greenhouse.io')
      : null,
  },
  lever: {
    provider: lever,
    // Whole directory behind one host — see SINGLE_HOST_CONCURRENCY.
    concurrency: SINGLE_HOST_CONCURRENCY,
    // One host means one keep-alive pool, so per-board connection scopes would
    // only add a TLS handshake per board (see boardScope below).
    singleHost: true,
    dataset: `${DATASET_BASE}/lever_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://jobs.lever.co/${slug}`, h => h === 'jobs.lever.co')
      : null,
  },
  ashby: {
    provider: ashby,
    // Whole directory behind one host — see SINGLE_HOST_CONCURRENCY.
    concurrency: SINGLE_HOST_CONCURRENCY,
    // One host means one keep-alive pool, so per-board connection scopes would
    // only add a TLS handshake per board (see boardScope below).
    singleHost: true,
    dataset: `${DATASET_BASE}/ashby_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://jobs.ashbyhq.com/${slug}`, h => h === 'jobs.ashbyhq.com')
      : null,
  },
  workday: {
    provider: workday,
    dataset: `${DATASET_BASE}/workday_companies.json`,
    // Dataset entries are "tenant|instance|site" triples.
    toEntry: (line) => {
      const [tenant, instance, site] = String(line).split('|');
      if (![tenant, instance, site].every(p => p && SLUG_RE.test(p))) return null;
      if (WORKDAY_JUNK_TENANT_RE.test(tenant)) return null;
      return entryOnHost(
        tenant,
        `https://${tenant}.${instance}.myworkdayjobs.com/${site}`,
        h => h === `${tenant}.${instance}.myworkdayjobs.com` && h.endsWith('.myworkdayjobs.com'),
      );
    },
  },
  icims: {
    provider: icims,
    dataset: `${DATASET_BASE}/icims_companies.json`,
    toEntry: (slug) => {
      if (!SLUG_RE.test(String(slug))) return null;
      const hosts = icimsHostCandidates(slug);
      if (hosts.length === 0) return null;
      const [primary, ...fallbacks] = hosts.map((h) => `https://${h}/jobs/search?ss=1&in_iframe=1`);
      const entry = entryOnHost(String(slug), primary, (h) => h === hosts[0]);
      if (entry && fallbacks.length) entry.fallback_urls = fallbacks;
      return entry;
    },
  },
  bamboohr: {
    provider: bamboohr,
    // Per-tenant own host (<slug>.bamboohr.com), like workday/icims — default
    // CONCURRENCY is correct here, not SINGLE_HOST_CONCURRENCY.
    dataset: `${DATASET_BASE}/bamboohr_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://${slug}.bamboohr.com/careers`, h => h === `${slug}.bamboohr.com`)
      : null,
  },
};

// ── CLI args ────────────────────────────────────────────────────────

const KNOWN_FLAGS = [
  '--since', '--limit', '--ats', '--seeds', '--history-seeds', '--dry-run', '--liveness',
  '--verbose', '--md-out', '--json', '--include-undated', '--include-blacklisted',
  '--shuffle', '--resume', '--refresh-seed-cache', '--help', '-h',
];

// Flags that consume the next argv token as a value (space-separated form —
// the `--flag=value` form is self-contained and never needs this).
const VALUE_FLAGS = ['--since', '--limit', '--ats', '--seeds', '--md-out'];

const USAGE = `Usage:
  node scan-ats-full.mjs                      # scan all ATS directories, last 3 days
  node scan-ats-full.mjs --since 7            # postings from the last 7 days
  node scan-ats-full.mjs --ats greenhouse,workday  # subset of sources
  node scan-ats-full.mjs --history-seeds       # also scan boards from local application history
  node scan-ats-full.mjs --history-seeds --ats successfactors # history-derived boards for this ATS
  node scan-ats-full.mjs --limit 200          # max companies per ATS (default: all)
  node scan-ats-full.mjs --dry-run            # preview without writing files
  node scan-ats-full.mjs --liveness           # Playwright-verify matches before writing
  node scan-ats-full.mjs --include-blacklisted # audit: let data/blacklist.md matches through, annotated
  node scan-ats-full.mjs --verbose            # log per-board fetch failures
  node scan-ats-full.mjs --md-out <dir>       # also write a dated markdown digest to <dir>
  node scan-ats-full.mjs --resume             # continue an interrupted sweep from its checkpoint
  node scan-ats-full.mjs --seeds yc,a16z      # probe VC-portfolio companies (Greenhouse/Ashby/Lever)
  node scan-ats-full.mjs --seeds yc --refresh-seed-cache # ignore remembered 404s, re-probe everything
  node scan-ats-full.mjs --help               # print this usage block and exit`;

export function parseArgs(argv) {
  const args = argv.slice(2);

  // Shared with reply-watch.mjs/dedup-tracker.mjs/scan.mjs via
  // lib/cli-flags.mjs (#2775). This also fixes a latent ordering bug this
  // script had before the pattern was consolidated: the unrecognized-flag
  // check now runs BEFORE --help, so `--help --bogus` still errors instead
  // of exiting 0 having never looked at `--bogus` (the same ordering
  // CodeRabbit flagged on #2745/#2746).
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });

  const valueOf = (flag) => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
    const kv = args.find(a => a.startsWith(flag + '='));
    return kv ? kv.split('=').slice(1).join('=') : null;
  };
  // Validated by the SAME parser scan.mjs uses, so one flag name cannot mean
  // two different things (#2498). `Number(...) || 3` silently swallowed every
  // malformed operand: `--since abc` and `--since 0` became 3 while the user
  // believed they had scanned the window they typed; `--since -5` put the
  // cutoff in the FUTURE so nothing was ever eligible, which reads exactly like
  // "no new postings"; `--since 1e400` became Infinity → an -Infinity cutoff,
  // i.e. no window at all. Only the DEFAULT stays local: absent --since means
  // 3 days here, where scan.mjs means no bound.
  const sinceArg = parseSinceDays(args);
  if (sinceArg.error) {
    console.error(`Error: ${sinceArg.error}`);
    process.exit(1);
  }
  const sinceDays = sinceArg.days ?? 3;
  const limit = Number(valueOf('--limit')) || Infinity;
  const atsArg = valueOf('--ats');
  // --seeds: optional comma-separated VC portfolio sources (e.g. yc,a16z).
  // When set, the seed companies are fetched and probed via the ATS providers
  // instead of (or in addition to) the regular ATS directory walk.
  const seedsArg = valueOf('--seeds');
  const seeds = seedsArg
    ? seedsArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];
  const unknownSeeds = seeds.filter(s => !SEED_SOURCES[s]);
  if (unknownSeeds.length) {
    console.error(`Error: unknown seed source(s): ${unknownSeeds.join(', ')}. Valid: ${Object.keys(SEED_SOURCES).join(', ')}`);
    process.exit(1);
  }
  // When --seeds is the only discovery flag (no --ats), default --ats to none
  // so we don't also walk the full ATS directories unintentionally.
  const ats = atsArg
    ? atsArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : (seeds.length > 0 ? [] : Object.keys(SOURCES));
  const validAts = new Set([...Object.keys(SOURCES), ...KNOWN_ATS_VENDORS]);
  const unknown = ats.filter(a => !validAts.has(a));
  if (unknown.length) {
    console.error(`Error: unknown ATS source(s): ${unknown.join(', ')}. Valid: ${[...validAts].join(', ')}`);
    process.exit(1);
  }
  const historySeeds = args.includes('--history-seeds');
  const historyOnly = ats.filter(a => !SOURCES[a]);
  if (!historySeeds && historyOnly.length) {
    throw new Error(
      `--ats ${historyOnly.join(',')} ${historyOnly.length === 1 ? 'has' : 'have'} no public directory source; ` +
      're-run with --history-seeds to scan boards derived from local application history.',
    );
  }
  return {
    sinceDays,
    limit,
    ats,
    atsExplicit: Boolean(atsArg),
    historySeeds,
    seeds,
    dryRun: args.includes('--dry-run'),
    liveness: args.includes('--liveness'),
    verbose: args.includes('--verbose'),
    mdOut: valueOf('--md-out'),
    json: args.includes('--json'),
    includeUndated: args.includes('--include-undated'),
    includeBlacklisted: args.includes('--include-blacklisted'),
    shuffle: args.includes('--shuffle'),
    resume: args.includes('--resume'),
    refreshSeedCache: args.includes('--refresh-seed-cache'),
  };
}

// ── Company list cache (24h TTL) ────────────────────────────────────

// Returns { list, status } where status is:
//   'ok'    — fresh fetch, or a cache entry still within TTL
//   'stale' — network fetch failed; falling back to an expired cache
//   'empty' — no data at all (no cache, fetch failed/non-array)
// The status lets callers (and --json) distinguish a degraded scan from an empty one.
async function loadCompanyList(name, url) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${name}.json`);
  if (existsSync(cacheFile)) {
    const ageHours = (Date.now() - statSync(cacheFile).mtimeMs) / 3_600_000;
    if (ageHours < CACHE_TTL_HOURS) {
      try { return { list: JSON.parse(readFileSync(cacheFile, 'utf-8')), status: 'ok' }; } catch { /* refetch below */ }
    }
  }
  try {
    const data = await fetchJson(url, { timeoutMs: 30_000 });
    if (Array.isArray(data)) {
      writeFileSync(cacheFile, JSON.stringify(data), 'utf-8');
      return { list: data, status: 'ok' };
    }
  } catch (err) {
    console.error(`⚠️  ${name}: could not download company list — ${err.message}`);
  }
  // Stale cache beats nothing.
  if (existsSync(cacheFile)) {
    try { return { list: JSON.parse(readFileSync(cacheFile, 'utf-8')), status: 'stale' }; } catch { /* fall through */ }
  }
  return { list: [], status: 'empty' };
}

// Date gate for one posting in a reverse (fresh-first) scan:
//   'stale'   — dated, but older than the cutoff → always dropped
//   'undated' — no usable publish date → dropped by default, kept with --include-undated
//   'keep'    — dated and within the window
export function classifyPostingDate(job, cutoff) {
  if (job.postedAt && job.postedAt < cutoff) return 'stale';
  if (!job.postedAt) return 'undated';
  return 'keep';
}

// Can this board hold a match? Asked of a provider's cheap listing (titles and
// dates, no posting bodies) before its full fetch. Only the two checks that
// need no body run here, the same ones processJobs() starts with, so a board
// that might match still goes through fetch() and processJobs() unchanged.
// Undated postings count as possible: processJobs() decides them.
export function listingMayMatch(listing, { cutoff, titleFilter, companySlug }) {
  return listing.some(job => job.url && job.title
    && classifyPostingDate(job, cutoff) !== 'stale'
    && titleFilter(job.title, companySlug));
}

// Undated postings on a board the listing ruled out. processJobs() counts
// these into "Undated dropped" before its title filter, so a skipped board
// must report them too, or the pre-check would hide the degraded-scan signal.
export function undatedInListing(listing, cutoff) {
  return listing.filter(job => job.url && job.title
    && classifyPostingDate(job, cutoff) === 'undated').length;
}

// Apply the same user-owned do-not-apply gate as scan.mjs to reverse-scan
// results. Absent/empty blacklist is a no-op. Default skips are counted and
// never silent; --include-blacklisted keeps matches but marks them for audit.
export function filterBlacklistedOffers(offers, blacklist, { includeBlacklisted = false } = {}) {
  if (!blacklist || blacklist.size === 0) {
    return { offers, filteredBlacklist: 0, annotatedBlacklisted: 0 };
  }

  const kept = [];
  let filteredBlacklist = 0;
  let annotatedBlacklisted = 0;

  for (const offer of offers) {
    const entry = findBlacklistEntry(blacklist, offer.company || '', offer.url);
    if (!entry) {
      kept.push(offer);
      continue;
    }

    if (!includeBlacklisted) {
      filteredBlacklist++;
      continue;
    }

    annotatedBlacklisted++;
    const label = `blacklisted${entry.reason ? `: ${entry.reason}` : ''}`;
    kept.push({
      ...offer,
      blacklisted: true,
      note: typeof offer.note === 'string' && offer.note.trim()
        ? `${label} — ${offer.note}`
        : label,
    });
  }

  return { offers: kept, filteredBlacklist, annotatedBlacklisted };
}

// `title_filter` is written for scan.mjs, whose corpus is the curated
// tracked_companies list. That corpus is what makes a broad keyword safe:
// "Backend" at a company you already vetted is a real lead, and dropping it
// costs real roles — so tightening the shared key to protect this sweep is a
// regression for the scanner that actually produces applications.
//
// This sweep removes the corpus and leaves the same keywords carrying the
// whole burden against every public board. Broad keywords then match on a
// scale they were never chosen for, and ordinary English words land as
// unrelated product names: one 38,854-board sweep wrote 426 postings, of
// which 142 passed on "Backend" alone and the rest on Fuel Associate,
// Traffic Anchor, ICP Mass Spec, Principal Mechanical Canister Eng. Across
// 194 distinct companies, one matched a crypto name — a gas-station chain.
//
// Optional `title_filter_full` lets one portals.yml carry a strict profile
// for this sweep and a broad one for scan.mjs. Absent — the default — this
// returns `title_filter` and behaviour is byte-identical to before.
export function resolveTitleFilterConfig(config) {
  return config?.title_filter_full ?? config?.title_filter;
}

// Level ceiling for one posting that passed every other filter (fork-local,
// lib/level-filter.mjs). admit() returns false when the posting is dropped; a
// kept Staff+ posting carries a note telling stage 2 what to check. It answers
// synchronously unless the JD must be fetched, and then returns a Promise, so
// the caller's dedup check-then-add stays atomic in the common case. Counters
// live on the gate so both sweep paths report into one summary.
export function makeLevelGate(levelFilter) {
  const gate = { filter: levelFilter, dropped: [], fetched: 0, unchecked: 0 };
  const record = (job, level) => {
    if (level.fetched) gate.fetched++;
    if (level.drop) {
      gate.dropped.push(`${job.company || '?'} | ${job.title} | ${job.url} — ${level.reason}`);
      return false;
    }
    if (level.note) {
      if (/no JD text/.test(level.note)) gate.unchecked++;
      job.note = typeof job.note === 'string' && job.note.trim() ? `${job.note} — ${level.note}` : level.note;
    }
    return true;
  };
  gate.admit = (job) => {
    if (!levelFilter) return true;
    if (!levelFilter.needsFetch(job)) return record(job, levelFilter.assess(job.title, job.description));
    return levelFilter.check(job).then((level) => record(job, level));
  };
  return gate;
}

// The company-level gate (#3105). `title_filter` runs on the wrong axis for a
// reverse sweep: it asks the TITLE to answer both "is this the right role" and
// "is this employer in my industry", and a title cannot answer the second one —
// "Senior Backend Engineer" is character-for-character identical at a Solana
// infrastructure company and at a supermarket chain. scan.mjs never had that
// problem because tracked_companies settles the employer before a title is
// read; the sweep deletes that premise and hands the whole burden to keywords
// that were never chosen for it.
//
// So ask the cheaper question of the board as a whole first, using data already
// paid for — the board is fully in memory before filtering starts, so this
// costs one extra pass over an array and no HTTP request at all.
//
// THRESHOLD IS ONE, and that is measured rather than cautious. Over 546
// postings on 249 boards, raising it does not trade recall for precision, it
// inverts the gate: at two, twelve boards survive and every genuine crypto
// employer is gone, because ten of the twelve qualify on `defi` appearing
// repeatedly inside a Portuguese "Deficiência" or an Ohio "Defiance". A
// repeated false-positive substring is a property of large boards; the real
// finds are single openings at small companies — conduit, ethereum-foundation,
// mesh and ing each had exactly one domain-bearing posting, which is precisely
// the find the sweep exists for.
//
// KNOWN LIMIT: the gate assumes one board is one employer, and an aggregator
// breaks that premise. `jobgether` carried 25 domain-bearing postings among 93
// and so passes at every threshold under every matcher, admitting 68 unrelated
// ones on the strength of its crypto listings. No threshold fixes it — the
// board is simply not an employer. There the gate degrades to today's
// behaviour, which is a bounded failure and one of the reasons the whole
// feature is opt-in.
export function boardInDomain(jobs, domainFilter) {
  return jobs.some(job => job?.title && domainFilter(job.title));
}

/**
 * Decide what the sweep does with one fetched board, before any title is read.
 *
 * Split out from the call site because the truncation rule is the whole point
 * and an inline `if` hid it: an earlier revision gated a `workdayTruncated`
 * response on the part that was fetched, "like every other gate here". That
 * reasoning is wrong for exactly this gate. Every other filter here judges a
 * posting it has in hand, so a short response costs it the rows it never saw;
 * this one judges the BOARD from its rows, so a short response can invert the
 * verdict — the only domain-bearing posting may sit in the tail the sequential
 * retry is about to fetch, and the board is then dropped into a counter that
 * reads as "correctly excluded" rather than "not yet known".
 *
 * So an unmatched truncated board is deferred, not gated: it stays queued for
 * the retry and the fuller result decides it. A truncated board that ALREADY
 * matches needs no deferral — a domain-bearing posting in hand settles the
 * verdict whatever the retry returns — and processing its partial page keeps
 * today's behaviour of banking those matches even if the retry later fails.
 * What the retry then does with each kind is retryGateDecision's job.
 *
 * Reachability, since the obvious objection is that a truncated page might be
 * a ranked prefix and so already carry any domain-bearing posting: it is not.
 * `workdayTruncated` is set on `fetch-error` (retries exhausted MID-pagination
 * while other tenants hammered the same uplink), on `splitIncomplete` and on
 * `budgetExhausted` — see providers/workday.mjs. The cut is wherever the error
 * or the budget landed, which bears no relation to posting order, so no
 * ordering argument makes the deferral unnecessary.
 *
 * @param {object[]} jobs - Postings as returned by the provider.
 * @param {((title: string) => boolean)|null} domainFilter - Compiled gate, or null when opt-out.
 * @returns {'process'|'gate'|'defer'} What the caller should do with the board.
 */
export function boardGateDecision(jobs, domainFilter) {
  if (!domainFilter) return 'process';
  if (boardInDomain(jobs, domainFilter)) return 'process';
  // An iCIMS board stopped at the provider's page cap is never retried, so,
  // like a structural Workday cut, it is admitted ungated rather than judged
  // on the pages that happened to fit under the cap.
  if (jobs.icimsTruncated) return 'process';
  if (!jobs.workdayTruncated) return 'gate';
  // Only a transient cut is retried. A structural one comes back cut at the
  // same bound, so there is no fuller fetch to defer to: the board is admitted
  // ungated now, as the retry admits a board truncated twice.
  return jobs.workdayTruncated === WORKDAY_TRUNCATED_REASON.TRANSIENT ? 'defer' : 'process';
}

/**
 * Decide what the sequential retry does with a board the sweep queued.
 *
 * The retry is where a deferred board gets its verdict, so it needs the same
 * callable shape as the sweep, plus the one fact only the sweep knows: whether
 * the board was deferred or already admitted. Two cases hinge on that:
 *
 *   1. Already admitted (its truncated page matched). The retry cannot take
 *      that back: the retry can come back truncated too, cut somewhere else,
 *      so "the retry returns a superset" does not hold, and a cut that misses
 *      the domain posting would count a board whose matches are already banked
 *      as gated. It is processed, whatever the retry shows.
 *   2. Deferred, and the retry is truncated AGAIN with nothing domain-bearing.
 *      There is no third fetch to defer to, and the gated counter means
 *      "correctly excluded", which an incomplete page cannot establish. The
 *      board is admitted ungated, the same fallback the gate takes whenever it
 *      cannot judge a board (see the aggregator note on boardInDomain); the
 *      caller still counts it as an error for staying truncated.
 *
 * Only a deferred board whose retry is complete and carries nothing
 * domain-bearing is gated.
 *
 * @param {object[]} jobs - Postings from the retry fetch.
 * @param {((title: string) => boolean)|null} domainFilter - Compiled gate, or null when opt-out.
 * @param {boolean} wasDeferred - Whether the sweep deferred this board rather than processing it.
 * @returns {'process'|'gate'} What the caller should do with the board.
 */
export function retryGateDecision(jobs, domainFilter, wasDeferred) {
  if (!wasDeferred) return 'process';
  return boardGateDecision(jobs, domainFilter) === 'gate' ? 'gate' : 'process';
}

// The gates scan.mjs applies after the title filter that the sweep used to skip,
// built from the same portals.yml keys with the same builders so one setting
// cannot mean two things:
//
//   skip_tiers                  drop a title classifyTier() puts in a listed tier
//                               (scan.mjs: `skipTiers.includes(classifyTier(title))`;
//                               the classifier reads the title only, so title_net and
//                               title_filter_overrides play no part, and a tier name
//                               the classifier never returns simply never matches)
//   country_eligibility_filter  reads the description; a no-op when the profile's
//                               country is United States (buildCountryEligibilityFilter),
//                               which is the case for the author's profile — the
//                               setting is wired for parity, not because it fires there
//   visa_filter                 reads the description; passes a posting with none
//                               unless require_mention is set
//
// Null for a gate that is not configured, so an install without these keys behaves
// byte for byte as before. `inert` says a configured country gate will never fire.
export function buildQualityGates(config, { candidateCountry = '' } = {}) {
  const skipTiers = Array.isArray(config?.skip_tiers)
    ? config.skip_tiers.filter((t) => typeof t === 'string').map((t) => t.toLowerCase())
    : [];
  const countryConfigured = Boolean(config?.country_eligibility_filter);
  const visaOn = Boolean(config?.visa_filter) && config.visa_filter.enabled !== false;
  return {
    skipTiers,
    tierFilter: skipTiers.length ? (title) => !skipTiers.includes(classifyTier(title)) : null,
    countryFilter: countryConfigured ? buildCountryEligibilityFilter(config.country_eligibility_filter, candidateCountry) : null,
    countryInert: countryConfigured && String(candidateCountry ?? '').toLowerCase().trim() === 'united states',
    visaFilter: visaOn ? buildVisaFilter(config.visa_filter) : null,
  };
}

/** Per-gate drop counters, one set per run. */
export function newGateCounts() {
  return { tier: 0, country: 0, visa: 0, duplicateRole: 0 };
}

// Title/location/content filter chain for one posting, in the order scan.mjs runs
// it: title, tier, location, content, country, visa. Returns the name of the first
// gate that rejects the posting, or null when it passes — so a caller can count
// what each gate removes. The main ATS-directory loop and runSeedScan() both go
// through here, which keeps the content_filter.by_title_keyword wiring (#1846)
// and the rule order in one place; the tier, country and visa gates are skipped
// when the caller passes none (a caller that predates them is unchanged).
export function firstRejectingFilter(job, { titleFilter, tierFilter, locationFilter, contentFilter, countryFilter, visaFilter, titleFilterConfig, companySlug }) {
  if (!titleFilter(job.title, companySlug)) return 'title';
  if (tierFilter && !tierFilter(job.title)) return 'tier';
  // job.url is passed so the location filter can fall back to the URL's own
  // location segment when the provider reports a rolled-up "N Locations" string;
  // job.title so a title-stated remote role survives a city-only location.
  if (!locationFilter(job.location, job.url, job.title)) return 'location';
  if (contentFilter && !contentFilter(job.description, matchedTitleKeywords(job.title, titleFilterConfig))) return 'content';
  if (countryFilter && !countryFilter(job.description)) return 'country';
  if (visaFilter && !visaFilter(job.description)) return 'visa';
  return null;
}

export function passesFilters(job, deps) {
  return firstRejectingFilter(job, deps) === null;
}

/**
 * The company+title duplicate check scan.mjs runs after the URL check, for the
 * sweep and the seed scan. A role already known under another URL — a LinkedIn
 * row for the same employer and title, spelled with an alias or a parenthetical
 * — is not appended again. URL dedup stays first and untouched; this is the
 * second layer.
 *
 * It is scan.mjs's own check, not a lookalike: the same key (companyRoleDedupKey
 * over company_aliases and the trailing-qualifier fold), the same requisition
 * and language escape hatches (matchesSeenCompanyRole), the same snapshot
 * (applications.md, pipeline.md — Pending included — and scan-history.tsv under
 * scan_history.recheck_after_days). So first-seen wins exactly as it does there:
 * an employer-board posting is suppressed by a twin that is merely pending in
 * pipeline.md, and a role kept earlier in this run suppresses its later
 * city variants.
 *
 * KNOWN LIMIT, shared with scan.mjs for a board not flagged `aggregator: true`:
 * one board is read as one employer. A recruiter board that carries several
 * clients' postings under one slug collapses same-titled openings after the
 * first, unless a requisition id tells them apart.
 *
 * @param {ReturnType<typeof loadDedupSnapshot>} snapshot
 * @param {{ canonicalize: (name: unknown) => string, includeLocation?: boolean, includeLanguage?: boolean }} opts
 */
export function createRoleDedup(snapshot, { canonicalize, includeLocation = false, includeLanguage = false }) {
  const seenCompanyRoles = snapshot.seenCompanyRoles;
  const requisitions = snapshot.seenCompanyRoleRequisitions ?? new Map();
  const locatedRequisitions = snapshot.locatedRequisitionsByBase ?? new Map();
  const languages = snapshot.seenCompanyRoleLanguages ?? new Map();
  const locatedLanguages = snapshot.locatedLanguagesByBase ?? new Map();
  // A posting with no company label cannot be told from any other: scan.mjs never
  // seeds such a row, so letting one in would only file unrelated postings
  // together under `::title`.
  const keysFor = (job) => {
    if (!String(job?.company ?? '').trim() || !String(job?.title ?? '').trim()) return null;
    const baseKey = companyRoleDedupKey(job.company, job.title, canonicalize);
    return {
      baseKey,
      key: includeLocation ? companyRoleDedupKey(job.company, job.title, canonicalize, job.location) : baseKey,
      requisition: requisitionIdsForDedup({ url: job.url, text: job.title, requisitionId: job.requisitionId }),
      language: includeLanguage ? languageFormsForDedup(job.language) : [],
    };
  };
  return {
    /** True when the role is already known. */
    isDuplicate(job) {
      const k = keysFor(job);
      if (!k) return false;
      return matchesSeenCompanyRole({
        key: k.key, baseKey: k.baseKey, seen: seenCompanyRoles, requisitions, locatedRequisitions, languages, locatedLanguages,
      }, k.requisition, k.language);
    },
    /** Record a kept role, so a later twin in this run reads as a duplicate. */
    remember(job) {
      const k = keysFor(job);
      if (!k) return;
      seenCompanyRoles.add(k.key);
      recordForms(requisitions, k.key, k.requisition);
      recordLanguages(languages, k.key, k.requisition, k.language);
      if (k.key !== k.baseKey) {
        recordForms(locatedRequisitions, k.baseKey, k.requisition);
        recordLanguages(locatedLanguages, k.baseKey, k.requisition, k.language);
      }
    },
  };
}

// Prefer a provider's own scoped dedup key over URL normalization when the
// provider can derive one — e.g. workday.mjs's requisition ID, which
// collapses the same posting served under several sites of one tenant
// (different paths, sometimes different hosts) that normalizeUrlForDedup
// can't recognize as duplicates (#3439). `provider` is optional so this stays
// safe to call for seed-pass offers, which carry no SOURCES entry to look one
// up from. Falls back to the pre-#3439 behavior whenever no key is derived.
export function dedupTokenFor(job, provider) {
  return provider?.dedupKey?.(job) || normalizeUrlForDedup(job.url);
}

// Resolve an offer's provider from its recorded `source` string — shared by
// the checkpoint-resume reseed below and by loadSeenUrls' extraTokensFor
// hook. `source` is "{sourcesKey}-full" for the main sweep and
// "{seedId}-seed" for seed offers; SOURCES has no seed entries, so a seed
// offer's lookup misses and callers fall back to URL-only dedup, unchanged
// from before #3439.
export function providerForSource(source) {
  return SOURCES[String(source || '').replace(/(?:-history)?-full$/, '')]?.provider;
}

// Cap-aware company sampling. Default: the dataset's natural (alphabetical)
// prefix. With --shuffle: a random sample of `limit` companies, so a capped
// scan isn't always biased to the same alphabetical-first slice. Pure; returns
// a new array and never mutates `list`.
export function sampleCompanies(list, limit, shuffle = false) {
  if (!shuffle || limit >= list.length) return list.slice(0, limit);
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, limit);
}

/** One stderr JSON line per kept offer in `--json` mode so Explore can paint
 *  cards while the walk continues. Stdout stays the single summary object (#1199). */
export function formatLiveOfferLine(job, source) {
  let postedAt = null;
  if (job?.postedAt) {
    const d = new Date(job.postedAt);
    if (!Number.isNaN(d.getTime())) postedAt = d.toISOString().slice(0, 10);
  }
  return JSON.stringify({
    kind: 'offer',
    company: job.company,
    title: job.title,
    url: job.url,
    location: job.location || null,
    postedAt,
    source: source || job.source || '',
  });
}

export function parseLiveOfferLine(line) {
  const raw = String(line || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let ev;
  try {
    ev = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (!ev || ev.kind !== 'offer') return null;
  const url = typeof ev.url === 'string' ? ev.url.trim() : '';
  if (!url || !ev.company || !ev.title) return null;
  return ev;
}

export function emitLiveOffer(job, source, { json } = {}) {
  if (!json || !job?.url || !job.company || !job.title) return;
  console.error(formatLiveOfferLine(job, source));
}

export function keepAndMaybeEmit(job, source, sink, blacklist, opts) {
  const kept = { ...job, source, dateStatus: job.postedAt ? 'dated' : 'unknown' };
  sink.push(kept);
  const live = filterBlacklistedOffers([kept], blacklist, { includeBlacklisted: opts.includeBlacklisted });
  if (live.offers.length) emitLiveOffer(live.offers[0], source, { json: opts.json });
}

// ── VC portfolio seed scan ──────────────────────────────────────────

// The providers a portfolio company can be probed on, by vendor id. Workday is
// excluded: its URL format requires a tenant|instance|site triple that can't
// be derived from a portfolio slug alone. The probe order within a company is
// SEED_VENDOR_ORDER (seeds/vc-portfolios.mjs); this is only the lookup.
const SEED_PROVIDERS = { greenhouse, ashby, lever };

// The seed memory is written this often (in companies finished), not only at the
// end: a first run over ~6k YC companies is ~18k requests spread over three
// rate-limited hosts, and a run that dies halfway should keep the 404s it already
// paid for.
const SEED_SAVE_EVERY = 250;

/**
 * The one-line account of a finished seed scan, for the run log.
 * @param {ReturnType<typeof newSeedStats>} stats
 */
export function formatSeedDone(stats) {
  if (stats.fetchFailed) return `  ✗ FAILED — no portfolio to probe (${stats.failure})`;
  const n = (v) => v.toLocaleString('en-US');
  const vendors = Object.entries(stats.byVendor).map(([v, c]) => `${v} ${n(c)}`).join(' / ');
  const found = `${n(stats.live)} live${vendors ? ` (${vendors})` : ''}`;
  const rest = [
    stats.liveEmpty ? `${n(stats.liveEmpty)} live but empty` : '',
    `${n(stats.dead)} dead`,
    stats.unknown ? `${n(stats.unknown)} unknown` : '',
    stats.duplicate ? `${n(stats.duplicate)} already covered` : '',
    stats.noCandidate ? `${n(stats.noCandidate)} with no usable slug` : '',
  ].filter(Boolean).join(', ');
  const probes = `${n(stats.probes)} probes, ${n(stats.requests)} requests${stats.cachedSkips ? `, ${n(stats.cachedSkips)} remembered-dead skipped` : ''}`;
  const g = stats.gated;
  const gated = g && (g.tier || g.country || g.visa || g.duplicateRole)
    ? `  gated: tier ${n(g.tier)} | visa ${n(g.visa)} | country ${n(g.country)} | duplicate role ${n(g.duplicateRole)}\n`
    : '';
  return `  done — ${n(stats.companies)} companies: ${found}, ${rest}; ${n(stats.matches)} matches\n`
    + `  ${probes}\n`
    + gated
    + `  unreachable ${n(unreachableTotal(stats.unreachable))}: ${formatUnreachable(stats.unreachable)}`;
}

/**
 * Scan a VC portfolio seed source and return matching job offers.
 *
 * Each company is probed on Greenhouse, Ashby and Lever (probeSeedCompany): the
 * first board that answers with postings wins and its postings go through the
 * same date / title / location / content / level / blacklist / dedup filters as
 * a tracked company's. Probing is paced per host, remembers 404s between runs
 * and reports a degraded run loudly — see seeds/seed-probe.mjs.
 *
 * Always returns { offers, errors, total, stats }, including when the portfolio
 * could not be fetched (`stats.fetchFailed`), so the caller can print a summary
 * for every outcome.
 *
 * @param {string}   seedId      Key from SEED_SOURCES (e.g. 'yc').
 * @param {object}   opts        Parsed CLI options. `opts.seedState` (createSeedRunState) carries the
 *                               memory and host gate across seeds; absent, a throwaway one is made.
 * @param {object}   ctx         HTTP context from makeHttpCtx().
 * @param {Set}      seenUrls    Shared dedup set (mutated in place).
 * @param {string}   label       Human-readable source label for logs.
 * @param {{ providers?: Record<string, any>, state?: any, concurrency?: number, onProgress?: (p: { done: number, total: number, matches: number }) => void }} [deps]
 *   Test seams; the CLI passes only `onProgress`.
 * @returns {Promise<{ offers: object[], errors: number, total: number, stats: ReturnType<typeof newSeedStats> }>}
 */
export async function runSeedScan(seedId, opts, ctx, seenUrls, label, deps = {}) {
  const source = SEED_SOURCES[seedId];
  if (!source) throw new Error(`runSeedScan: unknown seed "${seedId}"`);

  const stats = newSeedStats(seedId);
  const warn = (msg) => {
    stats.warnings.push(msg);
    console.error(`⚠️  ${seedId}: ${msg}`);
  };

  let companies;
  const diag = {};
  try {
    companies = await source.fetch({ onWarn: warn, diag });
  } catch (err) {
    stats.fetchFailed = true;
    stats.failure = err.message;
    warn(`could not fetch portfolio — ${err.message}`);
    return { offers: [], errors: 0, total: 0, stats };
  }
  if (!Array.isArray(companies)) companies = [];
  stats.truncated = Boolean(diag.truncated);
  if (companies.length === 0 && stats.warnings.length === 0) warn('portfolio returned 0 companies — nothing was probed');

  // --limit keeps the companies most worth probing first (hiring ones, active
  // ones), not simply the newest; a shuffled cap is a random sample instead.
  // Probing order is the same priority order either way: it is a reordering,
  // never a filter.
  const limit = opts.limit ?? Infinity;
  const work = prioritizeSeedCompanies(sampleCompanies(prioritizeSeedCompanies(companies), limit, opts.shuffle));

  const providers = deps.providers ?? SEED_PROVIDERS;
  // Without a state from the caller the memory is in-process only: nothing read, nothing written.
  const state = deps.state ?? opts.seedState ?? createSeedRunState({
    deadPath: null,
    livePath: null,
    persist: false,
    withKeySlot: createKeyedLimiter(SINGLE_HOST_CONCURRENCY),
  });
  const probeCtx = observeCtx(ctx, stats);

  const cutoff = Date.now() - opts.sinceDays * 86_400_000;
  // `deps.sink` is the caller's own list of kept postings, so a run stopped by a
  // signal can flush what a half-finished seed had found. The return value is
  // still this seed's offers alone.
  const offers = deps.sink ?? [];
  const sinkStart = offers.length;
  const sourceName = `${seedId}-seed`;
  const tally = { live: 'live', empty: 'liveEmpty', dead: 'dead', unknown: 'unknown', none: 'noCandidate', duplicate: 'duplicate' };
  let finished = 0;

  await parallelEach(work, deps.concurrency ?? CONCURRENCY, async (company) => {
    const probe = await probeSeedCompany(company, {
      seedId,
      providers,
      ctx: probeCtx,
      state,
      stats,
      // 404 is the expected answer for nearly every guessed slug, so only the
      // failures that say something about the host are worth a line.
      onFailure: opts.verbose
        ? (co, vendor, slug, cls, err) => { if (cls !== '404') console.error(`  ✗ ${seedId}/${co.name} [${vendor}/${slug}] ${cls}: ${err.message}`); }
        : undefined,
    });
    stats.companies++;
    stats[tally[probe.outcome]]++;
    if (!probe.board) return;

    const { provider, jobs, vendor } = probe.board;
    stats.byVendor[vendor] = (stats.byVendor[vendor] || 0) + 1;
    for (const job of jobs) {
      if (!job.url || !job.title) continue;
      const dateClass = classifyPostingDate(job, cutoff);
      if (dateClass === 'stale') continue;
      if (dateClass === 'undated' && !opts.includeUndated) continue;
      const rejected = firstRejectingFilter(job, {
        titleFilter: opts.titleFilter,
        tierFilter: opts.gates?.tierFilter,
        locationFilter: opts.locationFilter,
        contentFilter: opts.contentFilter,
        countryFilter: opts.gates?.countryFilter,
        visaFilter: opts.gates?.visaFilter,
        companySlug: company.name,
        titleFilterConfig: opts.titleFilterConfig,
      });
      if (rejected) {
        if (rejected in stats.gated) stats.gated[rejected]++;
        continue;
      }
      // provider is always one of greenhouse/lever/ashby here — none currently
      // define dedupKey, so this is the same normalizeUrlForDedup behavior as
      // before; kept via the shared helper so the two dedup sites in this file
      // can't quietly drift apart (#3439).
      const dedupToken = dedupTokenFor(job, provider);
      if (seenUrls.has(dedupToken)) continue;
      if (opts.roleDedup?.isDuplicate(job)) { stats.gated.duplicateRole++; continue; }
      // Level ceiling: synchronous unless the JD must be fetched; after a fetch,
      // re-check dedup (a concurrent task may have taken the posting meanwhile).
      let levelOk = opts.levelGate ? opts.levelGate.admit(job) : true;
      if (levelOk !== true && levelOk !== false) {
        levelOk = (await levelOk) && !seenUrls.has(dedupToken);
        if (levelOk && opts.roleDedup?.isDuplicate(job)) { stats.gated.duplicateRole++; levelOk = false; }
      }
      if (!levelOk) continue;
      seenUrls.add(dedupToken);
      opts.roleDedup?.remember(job);
      keepAndMaybeEmit(job, sourceName, offers, opts.blacklist, opts);
    }
  }, () => {
    finished++;
    if (finished % SEED_SAVE_EVERY === 0) {
      const saved = saveSeedState(state);
      if (saved.error) warn(`could not save the seed memory (${saved.error}) — this run's 404s will be re-probed next time`);
    }
    if (finished % 200 === 0 || finished === work.length) {
      deps.onProgress?.({ done: finished, total: work.length, matches: offers.length - sinkStart });
    }
  });

  const seedOffers = offers.slice(sinkStart);
  stats.matches = seedOffers.length;
  stats.abandonedHosts = state.gate.abandonedHosts();
  const saved = saveSeedState(state);
  if (saved.error) warn(`could not save the seed memory (${saved.error}) — this run's 404s will be re-probed next time`);

  // Everything below is the run saying out loud that it did not see the whole
  // portfolio. Each is a different failure with a different remedy.
  if (stats.abandonedHosts.length) {
    warn(`${stats.abandonedHosts.join(', ')} kept refusing (429/403) and was abandoned for the rest of the run — ${stats.skippedAbandoned} probes skipped, not remembered as dead; rerun later`);
  } else if (stats.unreachable['429'] + stats.unreachable['403'] > 0) {
    warn(`${stats.unreachable['429']} probes were throttled (429) and ${stats.unreachable['403']} refused (403) — those boards are unknown, not dead`);
  }
  if (stats.unknown > 0) {
    warn(`${stats.unknown} companies have no known board and at least one candidate failed for a reason other than "no such board" (${formatUnreachable(stats.unreachable)}) — they are retried next run`);
  }

  return { offers: seedOffers, errors: unreachableTotal(stats.unreachable), total: work.length, stats };
}

/**
 * Scan the ATS boards derived from the user's tracker and scan history.
 * Unsupported vendor labels stay in the local seed set but make no network
 * request. Known labels begin feeding the sweep automatically when a provider
 * with the same id is added later, without a tracker migration.
 */
export async function runHistorySeedScan(seeds, providers, opts, ctx, processJobs) {
  const selected = opts.atsExplicit
    ? seeds.filter((seed) => opts.ats.includes(seed.vendor))
    : seeds;
  const grouped = new Map();
  for (const seed of selected) {
    if (!grouped.has(seed.vendor)) grouped.set(seed.vendor, []);
    grouped.get(seed.vendor).push(seed);
  }
  const capped = [...grouped.values()].flatMap((group) => sampleCompanies(group, opts.limit, opts.shuffle));
  const scannable = [];
  for (const seed of capped) {
    const provider = providers.get(seed.vendor);
    if (!provider) continue;
    const entry = { name: seed.company, careers_url: seed.careersUrl, provider: seed.vendor };
    try {
      if (provider.detect?.(entry)) scannable.push({ seed, provider, entry });
    } catch { /* unroutable history is a skipped seed, not a failed network request */ }
  }
  let errors = 0;
  const timeoutMs = opts.companyTimeoutMs ?? COMPANY_TIMEOUT_MS;
  const withHostSlot = createKeyedLimiter(SINGLE_HOST_CONCURRENCY);
  // An arbitrary provider may ignore cancellation or never settle. Once one
  // request times out, quarantine that host for the rest of this run: queued
  // boards are counted as errors instead of starting more requests behind the
  // six still potentially in flight. This lets the sweep finish without ever
  // exceeding the host cap.
  const quarantinedHosts = new Set();

  await parallelEach(scannable, CONCURRENCY, async ({ seed, provider, entry }) => {
    const hostKey = (() => {
      try { return new URL(entry.careers_url).hostname.toLowerCase(); } catch { return seed.vendor; }
    })();
    await withHostSlot(hostKey, () => withConnectionScope(async () => {
      if (quarantinedHosts.has(hostKey)) {
        errors++;
        if (opts.verbose) console.error(`  ✗ ${seed.vendor}-history/${entry.name}: host skipped after an earlier timeout`);
        return;
      }
      const operation = { active: true };
      const operationPromise = (async () => {
        const jobs = await provider.fetch(entry, ctx);
        if (!operation.active) return;
        await processJobs(jobs, `${seed.vendor}-history`, provider, entry.name, () => operation.active);
      })();
      let timedOut = false;
      try {
        await withTimeout(operationPromise, timeoutMs, `${seed.vendor}-history/${entry.name}`, () => {
          timedOut = true;
          operation.active = false;
        });
      } catch (err) {
        operation.active = false;
        if (timedOut) quarantinedHosts.add(hostKey);
        errors++;
        if (opts.verbose) console.error(`  ✗ ${seed.vendor}-history/${entry.name}: ${err.message}`);
      } finally {
        // Observe a late rejection without waiting indefinitely. A timed-out
        // operation keeps running at most as one of the host's original six;
        // quarantining prevents queued work from replacing it.
        operationPromise.catch(() => {});
      }
    }));
  });

  return {
    total: scannable.length,
    derived: selected.length,
    unsupported: capped.length - scannable.length,
    errors,
  };
}

// ── Parallel fetch with concurrency limit ───────────────────────────

// One company's whole fetch may not exceed this — even with per-request
// timeouts in _http.mjs, an unforeseen hang (DNS, a provider bug) must cost
// one company, not freeze a worker slot for the rest of a 12k-company sweep.
const COMPANY_TIMEOUT_MS = 5 * 60_000;

// Run one board's unit of work. For a source that gives every tenant its own
// hostname (workday, icims, bamboohr), the board gets a private connection
// pool that is destroyed when it finishes; without it, the process keeps one
// idle socket per tenant for the rest of the run, and a full sweep exhausts
// local connection capacity partway through (see providers/_connection-scope.mjs).
// Single-host sources share one pool already and run unscoped.
function boardScope(source, fn) {
  return source.singleHost ? fn() : withConnectionScope(fn);
}

export function createKeyedLimiter(limit) {
  const states = new Map();
  return async function withKeySlot(key, fn) {
    let state = states.get(key);
    if (!state) {
      state = { active: 0, queue: [] };
      states.set(key, state);
    }
    if (state.active >= limit) {
      await new Promise((resolve) => state.queue.push(resolve));
    } else {
      state.active++;
    }
    try {
      return await fn();
    } finally {
      const next = state.queue.shift();
      if (next) next();
      else {
        state.active--;
        if (state.active === 0) states.delete(key);
      }
    }
  };
}

export function withTimeout(promise, ms, label, onTimeout = null) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label}: timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function parallelEach(items, limit, fn, onItemDone = null, shouldStop = null) {
  let next = 0;
  let done = 0;
  const inFlight = new Set();
  async function worker() {
    while (next < items.length) {
      // Checked before claiming an index, so a stopped run leaves `next` where
      // the unclaimed work starts and onItemDone's resumeAt stays truthful.
      if (shouldStop && shouldStop()) return;
      const idx = next++;
      inFlight.add(idx);
      try {
        await fn(items[idx], idx);
      } finally {
        inFlight.delete(idx);
        done++;
        // Lowest not-yet-finished index: everything below it is complete, so
        // a resumed run can restart exactly here without skipping work.
        const resumeAt = inFlight.size ? Math.min(...inFlight) : next;
        if (onItemDone) onItemDone({ done, resumeAt });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

// ── Liveness verification (reuses liveness-browser.mjs) ────────────

async function filterLive(offers) {
  let chromium, checkUrlLiveness, newLivenessPage;
  try {
    ({ chromium } = await import('playwright'));
    ({ checkUrlLiveness, newLivenessPage } = await import('./liveness-browser.mjs'));
  } catch (err) {
    throw new Error(
      `--liveness requires Playwright with Chromium (run "npx playwright install chromium"): ${err.message}`,
      { cause: err },
    );
  }
  console.error(`\nVerifying liveness of ${offers.length} match(es) with Playwright (sequential)...`);
  const browser = await chromium.launch({ headless: true });
  const live = [];
  try {
    const page = await newLivenessPage(browser);
    // Sequential — project rule: never Playwright in parallel
    for (const offer of offers) {
      const { result, reason } = await checkUrlLiveness(page, offer.url);
      const icon = result === 'active' ? '✅' : result === 'expired' ? '❌' : '⚠️';
      console.error(`  ${icon} ${result.padEnd(9)} ${offer.company} | ${offer.title}${result === 'expired' ? ` (${reason})` : ''}`);
      if (result !== 'expired') live.push(offer); // keep 'uncertain' — transient errors retry next scan
    }
  } finally {
    await browser.close();
  }
  console.error(`  → ${live.length}/${offers.length} passed liveness`);
  return live;
}

// ── Main ────────────────────────────────────────────────────────────

// A provider can hand back an unparseable postedAt; new Date(bad).toISOString()
// throws on an invalid Date, which in the SIGTERM partial path would abort the
// whole dump and lose every collected offer. Degrade one bad value to null.
function isoDay(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function main() {
  const opts = parseArgs(process.argv);
  let checkpoint = null;
  if (opts.resume) {
    const cp = loadCheckpoint();
    if (!cp) {
      console.error(`Error: --resume passed but no checkpoint found at ${CHECKPOINT_PATH}.`);
      process.exit(1);
    }
    if (!checkpointCompatible(cp, opts)) {
      console.error('Error: checkpoint was written with different settings (--ats/--limit/--include-undated, or --shuffle is set) — rerun with the original flags, or delete the checkpoint to start fresh.');
      process.exit(1);
    }
    checkpoint = cp;
  } else if (loadCheckpoint() && !opts.dryRun) {
    console.error(`⚠️  Unfinished sweep checkpoint found at ${CHECKPOINT_PATH} — pass --resume to continue it; this fresh run will overwrite it.`);
  }
  // Resume reuses the ORIGINAL cutoff so the date window stays consistent
  // across the interruption instead of silently sliding forward.
  const cutoff = checkpoint ? checkpoint.cutoffMs : Date.now() - opts.sinceDays * 86_400_000;
  // In --json mode, stdout is reserved for the single machine-readable result,
  // so every human-facing line goes to stderr instead.
  const log = opts.json ? (...a) => console.error(...a) : (...a) => console.log(...a);
  // Same rule as `log` above: under --json the counter goes to stderr rather
  // than being dropped. Suppressing it left a sweep with no progress signal on
  // either stream, and `--dry-run --json` has no checkpoint to fall back on
  // (dry runs write no state), so a long run was indistinguishable from a hung
  // one.
  // `--json` consumers parse stderr as newline-delimited lines. The human
  // path overwrites one TTY row with `\r`; converting that to `\n` on stderr
  // keeps progress ticks and live-offer JSON from gluing onto the same line.
  const progress = (s) => {
    if (opts.json) process.stderr.write(String(s).replace(/\r$/, '\n'));
    else process.stdout.write(s);
  };

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first — the reverse scan reuses its title_filter/location_filter.');
    process.exit(1);
  }
  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const fullTitleFilterConfig = resolveTitleFilterConfig(config);
  // title_filter_overrides is independent of title_filter_full: it broadens
  // the net for specific companies on top of whichever title filter config
  // (title_filter or title_filter_full) this run is already using.
  const titleFilterOverrides = buildTitleFilterOverrides(config?.title_filter_overrides);
  const titleFilter = buildTitleFilterWithOverrides(fullTitleFilterConfig, titleFilterOverrides);
  // level_filter (lib/level-filter.mjs) caps seniority on the reverse scan too:
  // a Staff+ title is dropped only when its JD requires min_years+ or a team lead.
  opts.levelGate = makeLevelGate(buildLevelFilter(config?.level_filter, { fetchJd: fetchJobDescription }));
  const locationFilter = buildLocationFilter(config?.location_filter);
  // Same content_filter (incl. by_title_keyword scoping) scan.mjs applies —
  // see #1846. Built once here from the same portals.yml config.
  const baseContentFilter = buildContentFilter(config?.content_filter);
  // content_rescue.must_catch: >= N distinct listed concepts in a description always pass the
  // content gate (same rule as scan.mjs; the title gate of this sweep is unchanged).
  const mustCatch = buildMustCatch(config?.content_rescue?.must_catch);
  const contentFilter = mustCatch
    ? (description, ...rest) => Boolean(mustCatch(description)) || baseContentFilter(description, ...rest)
    : baseContentFilter;
  // Opt-in, and the opt-in IS the key: `domain_filter` does not exist in any
  // portals.yml written before this feature, so every existing install keeps
  // its exact behaviour and nobody loses a board without having asked for the
  // gate. buildDomainFilter returns null for an absent or empty list, which is
  // why the summary can tell "off" from "on and nothing was skipped".
  // A bare `word:`/`stem:` would build a gate that matches nothing and drops
  // every complete board, so refuse to start rather than sweep blind. Checked
  // here as well as in validate-portals.mjs, which a direct run never calls.
  const bareDomain = barePrefixDomainKeywords(config?.domain_filter);
  if (bareDomain.length) {
    console.error(`Error: portals.yml domain_filter[${bareDomain.join(', ')}]: a word:/stem: prefix needs a term after it.`);
    process.exit(1);
  }
  const domainFilter = buildDomainFilter(config?.domain_filter);
  // The profile's country decides whether the country gate can ever fire (it is
  // inert for a United States profile), so it is read before the fingerprint.
  const candidateCountry = loadCandidateCountry();
  const filters = filterFingerprints(config, { candidateCountry });
  const changedFilters = changedFilterKeys(checkpoint, filters);
  if (changedFilters.length) {
    console.error(`Error: portals.yml ${changedFilters.join(', ')} changed since the checkpoint was written — the boards already swept were filtered under the old settings. Restore them to finish this sweep, or delete ${CHECKPOINT_PATH} to start fresh.`);
    process.exit(1);
  }
  if (!fullTitleFilterConfig?.positive?.length) {
    const key = config?.title_filter_full ? 'title_filter_full' : 'title_filter';
    console.error(`⚠️  portals.yml has no ${key}.positive — every fresh posting on every board will match. Consider adding keywords.`);
  }
  // Attach filters to opts so runSeedScan can use them without extra parameters.
  opts.titleFilter = titleFilter;
  opts.locationFilter = locationFilter;
  opts.contentFilter = contentFilter;
  // Raw title_filter config, needed by matchedTitleKeywords() to scope
  // content_filter.by_title_keyword the same way scan.mjs does.
  opts.titleFilterConfig = fullTitleFilterConfig;
  // skip_tiers, visa_filter and country_eligibility_filter: the gates scan.mjs
  // applies that this scanner used to leave out (see buildQualityGates).
  const gates = buildQualityGates(config, { candidateCountry });
  opts.gates = gates;

  // User-layer history is an opt-in additive board directory. It fills vendors
  // that have no public community dataset without changing the tracker schema,
  // but an ordinary reverse scan never reads the user's application history.
  const historySeeds = opts.historySeeds
    ? loadHistoryAtsSeeds({ dataRoot: DATA_ROOT, scanHistoryPath: SCAN_HISTORY_PATH })
    : [];

  const atsSummary = opts.ats.length ? `ats: ${opts.ats.join(', ')}` : '';
  const seedsSummary = opts.seeds.length ? `seeds: ${opts.seeds.join(', ')}` : '';
  const historySummary = opts.historySeeds ? 'history seeds' : '';
  const sourcesSummary = [atsSummary, seedsSummary, historySummary].filter(Boolean).join(' | ');
  log(`Reverse ATS scan — ${sourcesSummary} | since ${opts.sinceDays}d${opts.limit < Infinity ? ` | limit ${opts.limit}/ats` : ''}${opts.shuffle ? ' | shuffled' : ''}${opts.includeUndated ? ' | +undated' : ''}${opts.seeds.length && opts.refreshSeedCache ? ' | seed cache refresh' : ''}${opts.liveness ? ' | liveness' : ''}${domainFilter ? ' | domain gate' : ''}${opts.dryRun ? ' | DRY RUN' : ''}`);

  // extraTokensFor: a historical scan-history.tsv row records the URL it was
  // FIRST seen on, so without this a Workday requisition seen last run under
  // site A's URL wouldn't be recognized when this run only sees it under
  // site B — the plain normalizeUrlForDedup comparison never matches across
  // sites, and only fresh-run offers were reseeded with the provider key
  // (#3439). `portal` here is scan-history.tsv's recorded `offer.source`, so
  // providerForSource resolves it the same way the checkpoint reseed above
  // does.
  const { seen: seenUrls } = loadSeenUrls({}, {
    extraTokensFor: (url, portal) => providerForSource(portal)?.dedupKey?.({ url }),
  });
  // The company+title check scan.mjs layers on the URL check, from the same
  // snapshot of the tracker, pipeline and scan history (see createRoleDedup).
  const dedupConfig = config ?? {};
  const canonicalizeCompany = buildCompanyCanonicalizer(dedupConfig.company_aliases);
  const dedupIncludeLocation = resolveDedupIncludeLocation(dedupConfig);
  const roleDedup = createRoleDedup(
    loadDedupSnapshot(scanHistoryPolicy(dedupConfig), canonicalizeCompany, { includeLocation: dedupIncludeLocation }),
    {
      canonicalize: canonicalizeCompany,
      includeLocation: dedupIncludeLocation,
      includeLanguage: resolveDedupIncludeLanguage(dedupConfig),
    },
  );
  opts.roleDedup = roleDedup;
  const blacklist = loadBlacklist();
  opts.blacklist = blacklist;
  // sinceMs and includeUndated let providers (currently only workday.mjs)
  // stop paginating a tenant early instead of always walking to max_pages:
  // sinceMs once postings are confidently past the --since window, and
  // includeUndated (when false) for a tenant that exposes no postedOn at
  // all, since its postings would all be dropped as undated below anyway.
  //
  // syntheticEntries states what this scanner's entries ARE: built from the
  // external ATS dataset, not read from portals.yml tracked_companies.
  // workday.mjs picks its cap-hit warning from it — there is no portal entry
  // here for the user to edit, so "raise max_pages on this entry" would be
  // inactionable. It used to infer that from sinceMs being set, which stopped
  // being true once #2418 taught scan.mjs --since to set it too (#2495).
  const ctx = {
    ...makeHttpCtx(),
    sinceMs: cutoff,
    includeUndated: opts.includeUndated,
    syntheticEntries: true,
    locationHints: config?.location_filter,
  };
  // The LOCAL calendar day, not the UTC one. This value lands in
  // scan-history.tsv's first_seen, which shouldDedupScanHistoryRow measures the
  // recheck window against using the local day (#3070). Stamping it in UTC put
  // the two sides of that comparison on different clocks.
  const date = localToday();

  // Same defensive default as completedSources/counters below: a version-1
  // checkpoint that lost its offers array would otherwise set this to undefined
  // and throw on the next line, instead of degrading to an empty resume.
  const newOffers = checkpoint?.offers || [];
  // Checkpointed matches were already deduped once — without re-seeding, a
  // resumed run re-scanning the in-flight overlap would duplicate them.
  // Reseed with the SAME token a fresh dedup check would produce (provider
  // key when the source's provider has one, URL otherwise, matching
  // processJobs below) — reseeding by URL alone would miss a Workday
  // requisition's key, letting the other of its two sites' offers back in
  // after a resume even though the pre-checkpoint sweep had already
  // collapsed them (#3439). o.source is "{sourcesKey}-full" for the main
  // sweep and "{seedId}-seed" for seed offers; SOURCES has no seed entries,
  // so a seed offer's lookup misses and falls back to URL — its unchanged,
  // pre-#3439 behavior.
  for (const o of newOffers) {
    seenUrls.add(dedupTokenFor(o, providerForSource(o.source)));
    roleDedup.remember(o);
  }
  const completedSources = new Set(checkpoint?.completedSources || []);
  const cc = checkpoint?.counters || {};
  let totalCompaniesScanned = cc.totalCompaniesScanned || 0;
  let totalCompaniesAvailable = 0;
  let totalErrors = cc.totalErrors || 0;
  let totalRetiredBoardsSkipped = cc.totalRetiredBoardsSkipped || 0;
  let droppedNoDate = cc.droppedNoDate || 0;
  let droppedContent = cc.droppedContent || 0;
  // What the gates scan.mjs applies removed, and what the sweep's boards failed
  // with, by cause (404 / 403 / 429 / 5xx / timeout-network / other). The seed
  // scan keeps its own copies on its stats; the summary adds them up.
  const gateCounts = { ...newGateCounts(), ...(cc.gateCounts || {}) };
  const sweepUnreachable = Object.assign(emptyUnreachable(), cc.sweepUnreachable || {});
  // Boards a refusal-abandoned source never asked: this run's only, since a --resume asks them.
  let skippedAbandonedBoards = 0;
  const sweepSources = {};
  const abandonedSources = [];
  let capHit = false;
  // Aggregated from providers/workday.mjs's jobs.workdayNoDateSkip tag — see
  // there for why this is a counter instead of a per-company console.error
  // (thousands of tenants hit this on a full directory scan; one line each
  // would just be the same message repeated thousands of times).
  let noDateSkipCompanies = cc.noDateSkipCompanies || 0;
  let noDateSkipJobs = cc.noDateSkipJobs || 0;
  // Boards that hit a provider's hard page cap (icims). Unlike a Workday
  // truncation this isn't a network hiccup, so a sequential retry would just
  // re-hit the cap — it's reported, not retried, so capped coverage is visible
  // instead of passing for a fully-walked board.
  let cappedBoards = cc.cappedBoards || 0;
  // Skipped boards are COUNTED, never silent. The gate's real failure mode is a
  // term missing from the domain list, and a missing term costs a whole board —
  // so the run has to say how much it declined to look at, and --verbose names
  // each board so a suspicious skip can be checked by hand.
  let domainGatedBoards = cc.domainGatedBoards || 0;
  let domainGatedPostings = cc.domainGatedPostings || 0;
  const datasetStatus = {};

  // Live deltas for the partial (stoppedEarly) report, so a mid-source signal
  // reports the work ACTUALLY done. totalCompaniesScanned is bumped by a whole
  // source's planned entries up front, and its errors fold into totalErrors only
  // once it finishes — the handler applies the same correction the checkpoint uses.
  let curEntries = 0;
  let curDone = 0;
  let curErrors = 0;
  let curDeadSkipped = 0;

  // The checkpoint file is this run's to rewrite only once it has written one
  // itself or resumed from one: a stale file from an older run is not ours.
  let checkpointOwned = Boolean(checkpoint);
  const saveCheckpoint = (cp) => {
    const ok = writeCheckpoint(cp);
    if (ok) checkpointOwned = true;
    return ok;
  };
  // Where the source being swept has got to: { current, counters } in the shape a
  // checkpoint stores, kept by the sweep loop and null between sources. A stop
  // signal reads it so its checkpoint says where the run actually was.
  let liveCheckpoint = null;
  // Matches already written to pipeline.md and scan-history.tsv must not ride
  // along in the checkpoint as well: --resume re-adds the checkpoint's offers to
  // the end of its own run, so a stopped run that both persisted them and
  // checkpointed them would append every one twice. The persisted ones live in
  // the files, and the resumed run's dedup reads those files.
  const clearCheckpointedOffers = () => {
    if (opts.dryRun || !checkpointOwned) return;
    const cp = loadCheckpoint();
    if (cp) saveCheckpoint({ ...cp, offers: [] });
  };
  // Set once every source of the sweep has run to the end (not stopped by a
  // breaker): from then on the checkpoint has nothing left to resume.
  let sweepComplete = false;
  const dropFinishedCheckpoint = () => {
    if (opts.dryRun || !checkpointOwned || !existsSync(CHECKPOINT_PATH)) return;
    try { unlinkSync(CHECKPOINT_PATH); } catch { /* a leftover file only earns the next run a warning */ }
  };

  // Everything the run keeps reaches pipeline.md and scan-history.tsv through
  // here, and at most once: the normal end of the run and a stop signal both come
  // this way, the first caller writes, and a later caller gets the same promise.
  let persistPromise = null;
  const persistOffers = (list) => {
    persistPromise ??= (async () => {
      // appendToPipeline assumes the file exists (onboarding creates it) — cover fresh setups.
      if (!existsSync(PIPELINE_PATH)) {
        mkdirSync(path.dirname(PIPELINE_PATH), { recursive: true });
        writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n', 'utf-8');
      }
      await appendToPipeline(list);
      await appendToScanHistory(list, date);
    })();
    return persistPromise;
  };

  // A stop signal: SIGTERM from `timeout` (ops/daily-scan.sh's limit, the web
  // layer's scan budget in web/src/lib/core/scan-timeout.mjs), or SIGALRM from the
  // perl alarm that same script falls back to where there is no timeout(1). A
  // sweep only reports at the very end, so a plain kill used to lose everything
  // found so far. Now the matches that already passed every filter are appended
  // to pipeline.md and scan-history.tsv exactly once (a --dry-run writes nothing),
  // the checkpoint is brought up to date so --resume continues from where the run
  // was, and the process exits the way it would have without a handler: 128 plus
  // the signal number, which is also what lets ops/daily-scan.sh recognise the
  // limit (142 from the alarm). In --json mode the web layer reads a well-formed
  // PARTIAL result (`stoppedEarly: true`) from stdout and the exit stays 0.
  let stopping = false;
  const onStopSignal = async (signal) => {
    if (stopping) return;
    stopping = true;
    const exitCode = opts.json ? 0 : 128 + (osConstants.signals[signal] ?? osConstants.signals.SIGTERM);
    // Taken together and before any await: the matches are exactly those of the
    // boards below the checkpoint's resume point, whatever finishes meanwhile.
    const kept = filterBlacklistedOffers(newOffers.slice(), blacklist, {
      includeBlacklisted: opts.includeBlacklisted,
    }).offers;
    const stopCheckpoint = !opts.dryRun && liveCheckpoint ? { ...checkpointBase(), ...liveCheckpoint(), offers: [] } : null;
    const resumeNote = stopCheckpoint?.current
      ? ` — --resume continues at company ${stopCheckpoint.current.resumeAt} of ${stopCheckpoint.current.name}` : '';
    let saved = false;
    let note = '';
    try {
      if (!opts.dryRun && kept.length) {
        await persistOffers(kept);
        saved = true;
      }
      if (!opts.dryRun) {
        if (stopCheckpoint) saveCheckpoint(stopCheckpoint);
        else if (sweepComplete) dropFinishedCheckpoint();
        else if (saved) clearCheckpointedOffers();
      }
    } catch (err) {
      note = ` (could not save them: ${err.message})`;
    }
    const outcome = opts.dryRun
      ? 'dry run — nothing written'
      : saved ? `${kept.length} match${kept.length === 1 ? '' : 'es'} saved to ${PIPELINE_PATH} and scan-history.tsv${resumeNote}`
        : `no matches to save${note}${resumeNote}`;
    log(`\n⏹  ${signal}: stopped before the sweep finished — ${outcome}`);
    if (!opts.json) process.exit(exitCode);
    try {
      process.stdout.write(JSON.stringify({
        date,
        sources: opts.ats,
        stoppedEarly: true,
        stoppedBySignal: signal,
        companiesAvailable: totalCompaniesAvailable,
        companiesScanned: Math.max(0, totalCompaniesScanned - (curEntries - curDone) - curDeadSkipped),
        capHit,
        datasetStatus,
        postingsKept: kept.length,
        postingsDroppedNoDate: droppedNoDate,
        postingsFilteredTier: gateCounts.tier,
        postingsFilteredCountry: gateCounts.country,
        postingsFilteredVisa: gateCounts.visa,
        postingsDuplicateRole: gateCounts.duplicateRole,
        unreachableBoards: totalErrors + curErrors,
        domainFilterActive: Boolean(domainFilter),
        domainGatedBoards,
        domainGatedPostings,
        saved,
        offers: kept.map((o) => ({
          company: o.company,
          title: o.title,
          url: o.url,
          location: o.location || null,
          postedAt: isoDay(o.postedAt),
          dateStatus: o.dateStatus || (o.postedAt ? 'dated' : 'unknown'),
          source: o.source,
        })),
      }) + '\n', () => process.exit(exitCode));
    } catch {
      process.exit(exitCode);
    }
  };
  for (const signal of ['SIGTERM', 'SIGALRM']) {
    // SIGALRM does not exist on Windows; a signal this platform cannot deliver is simply not handled.
    try { process.on(signal, () => { onStopSignal(signal); }); } catch { /* unsupported here */ }
  }

  const snapshotCounters = () => ({
    totalCompaniesScanned, totalErrors, totalRetiredBoardsSkipped,
    droppedNoDate, droppedContent,
    noDateSkipCompanies, noDateSkipJobs, cappedBoards,
    domainGatedBoards, domainGatedPostings,
    gateCounts: { ...gateCounts },
    sweepUnreachable: { ...sweepUnreachable },
  });
  const checkpointBase = () => ({
    version: 1,
    cutoffMs: cutoff,
    ats: opts.ats,
    limit: opts.limit === Infinity ? null : opts.limit,
    includeUndated: opts.includeUndated,
    filters,
    completedSources: [...completedSources],
    offers: newOffers,
    savedAt: new Date().toISOString(),
  });

  // Per-job filter chain, shared by the parallel sweep, the truncation retry
  // pass (workday), and date enrichment (icims). Closure over the filters and
  // counters so both passes update the same run totals.
  const processJobs = async (jobs, sourceName, provider, companySlug, shouldContinue = () => true) => {
    for (const job of jobs) {
      if (!shouldContinue()) return;
      if (!job.url || !job.title) continue;
      // Confirmed-stale postings are always dropped. Undated postings are
      // dropped by default (a reverse scan targets *fresh* roles) but
      // COUNTED so callers see the gap; --include-undated keeps them, marked.
      let dateClass = classifyPostingDate(job, cutoff);
      if (dateClass === 'stale') continue;
      // Providers whose list pages carry no date (icims) get one shot at dating
      // the posting from its detail page — but only after the cheap title and
      // location filters pass, so a 10k-tenant sweep never pays a detail-page
      // request for noise. The same (location, url) pair as the real filter
      // below: a stricter gate here would deny enrichment to jobs the final
      // check would have kept.
      //
      // Deliberately OUTSIDE the includeUndated branch. Gating enrichment on
      // !includeUndated meant --include-undated left every icims posting
      // undated, and since classifyPostingDate can never call an undated
      // posting stale, --since was silently ignored for the entire source.
      // Enrich first, then let the undated policy decide.
      if (dateClass === 'undated' && provider.enrichDate
          && titleFilter(job.title, companySlug) && (!gates.tierFilter || gates.tierFilter(job.title))
          && locationFilter(job.location, job.url, job.title)) {
        try { await provider.enrichDate(job, ctx); } catch { /* stays undated */ }
        if (!shouldContinue()) return;
        dateClass = classifyPostingDate(job, cutoff);
      }
      if (dateClass === 'stale') continue;
      if (dateClass === 'undated' && !opts.includeUndated) { droppedNoDate++; continue; }
      // Title, tier, location, content, country, visa — the order scan.mjs runs
      // them in, the cheap ones ahead of the level gate's JD fetch below.
      const rejected = firstRejectingFilter(job, {
        titleFilter, tierFilter: gates.tierFilter, locationFilter, contentFilter,
        countryFilter: gates.countryFilter, visaFilter: gates.visaFilter,
        titleFilterConfig: fullTitleFilterConfig, companySlug,
      });
      if (rejected) {
        if (rejected === 'content') droppedContent++;
        else if (rejected in gateCounts) gateCounts[rejected]++;
        continue;
      }
      const dedupToken = dedupTokenFor(job, provider);
      if (seenUrls.has(dedupToken)) continue;
      // The same employer and title already known under another URL (a LinkedIn
      // row, an alias spelling) is the same role: see createRoleDedup.
      if (roleDedup.isDuplicate(job)) { gateCounts.duplicateRole++; continue; }
      // Level ceiling: synchronous unless the JD must be fetched; after a fetch,
      // re-check dedup (a concurrent task may have taken the posting meanwhile).
      let levelOk = opts.levelGate ? opts.levelGate.admit(job) : true;
      if (levelOk !== true && levelOk !== false) {
        levelOk = (await levelOk) && !seenUrls.has(dedupToken);
        if (levelOk && roleDedup.isDuplicate(job)) { gateCounts.duplicateRole++; levelOk = false; }
      }
      if (!levelOk) continue;
      seenUrls.add(dedupToken); // intra-scan dedup
      roleDedup.remember(job);
      keepAndMaybeEmit(job, `${sourceName}-full`, newOffers, blacklist, opts);
    }
  };

  // Run-level, because resolverOutage below is per-source and long out of
  // scope by the time the checkpoint's fate is decided at the end of main().
  let stoppedByOutage = false;
  // The same, for the refusal breaker: a host answering 429/403 until the sweep
  // gave up on the source. Either stop leaves a checkpoint for --resume.
  let stoppedByRefusals = false;

  for (const name of opts.ats.filter((ats) => SOURCES[ats])) {
    const source = SOURCES[name];
    // Stats are accumulated BEFORE the completed-source skip: on --resume a
    // source finished before the checkpoint was written still contributed its
    // companies to the sweep, so it must still count toward the availability /
    // cap figures the final report and --json output show.
    const { list, status } = await loadCompanyList(name, source.dataset);
    datasetStatus[name] = status;
    totalCompaniesAvailable += list.length;
    if (opts.limit < list.length) capHit = true;
    if (completedSources.has(name)) {
      log(`\n⚙  ${name} — already complete in resumed checkpoint, skipping`);
      continue;
    }
    const datasetHash = datasetFingerprint(list);
    const entriesAll = sampleCompanies(list, opts.limit, opts.shuffle).map(source.toEntry).filter(Boolean);

    let startAt = 0;
    if (checkpoint && checkpoint.current?.name === name) {
      // datasetHash is absent in checkpoints written before this guard existed;
      // fall back to the length-only check for those rather than hard-failing.
      const hashMismatch = checkpoint.current.datasetHash != null
        && checkpoint.current.datasetHash !== datasetHash;
      if (checkpoint.current.datasetLen !== list.length || hashMismatch) {
        console.error(`Error: ${name} company dataset changed since the checkpoint — resume order is no longer valid. Delete ${CHECKPOINT_PATH} and rerun.`);
        process.exit(1);
      }
      startAt = checkpoint.current.resumeAt;
    }
    const entries = entriesAll.slice(startAt);
    const scannedBeforeSource = totalCompaniesScanned;
    totalCompaniesScanned += entries.length;
    curEntries = entries.length; curDone = 0; curErrors = 0; curDeadSkipped = 0;
    log(`\n⚙  ${name} — ${entriesAll.length} companies${status !== 'ok' ? ` (dataset: ${status})` : ''}${startAt ? ` — resuming at ${startAt}` : ''}`);

    let errors = 0;
    let deadBoardsSkipped = 0;
    const deadBoards = loadDeadBoards(DEAD_BOARDS_PATH);
    // What this source's unreachable boards failed with. A 404 is a board that is
    // not there; 403 and 429 are the host refusing the sweep, and are the ones to
    // act on. Sums to `errors`.
    const unreachable = emptyUnreachable();
    // The refusal breaker (see createSourceGate; none for a source with a host per
    // tenant). `abandoned` is set by the gate once SWEEP_REFUSAL_LIMIT refusals
    // have come in a row; from then on no board of this source is asked for anything.
    let abandoned = null;
    const sweepGate = createSourceGate(source, {
      onAbandon: (_key, cls, count) => { abandoned = { cls, count, board: null }; },
    });
    // Boards the abandoned source never asked about. Neither an error nor dead:
    // their state is unknown, so they are not recorded in dead-boards and they
    // are counted apart from the boards that were asked and failed.
    let skippedAbandoned = 0;
    // The boards lost to the refusal run in progress — refused (`cls` 429/403) or
    // never asked (`cls` null) — by position in the whole dataset. Any answer, a
    // 200 or a 404, ends the run, as it ends the gate's count. If the source is
    // abandoned the resume point cannot move past them, or --resume would skip
    // boards nobody read; and the refused ones, which --resume will read again,
    // must not stay counted as unreachable in the checkpoint.
    let refusedRun = [];
    const refusedFloor = () => (refusedRun.length ? Math.min(...refusedRun.map((r) => r.at)) : Infinity);
    // Counts every request the providers make for this source, retries included.
    const sweepStats = { requests: 0, throttledResponses: 0 };
    const sourceCtx = observeCtx(ctx, sweepStats);
    let consecutiveResolverFailures = 0;
    let resolverOutage = false;
    // The board whose failure tripped the breaker. `name` is only the ATS
    // vendor, and the resume offset is only a position — neither tells the user
    // which board to try by hand once the resolver is back.
    let resolverOutageCompany = null;
    // Latest progress reported by parallelEach. It computes both on every item
    // but keeps neither, and a run stopped mid-source needs them after the
    // call returns to checkpoint where it actually stopped (#2283).
    let lastDone = 0;
    let lastResumeAt = 0;
    const truncated = [];
    // The subset of `truncated` the gate deferred rather than admitted; the
    // retry needs to know which, see retryGateDecision. Each keeps its index in
    // entriesAll, so a checkpoint can carry it past the resume offset, and its
    // partial page, so a failed retry still has something to process.
    const deferred = new Map();
    // A board the interrupted run deferred sits below the resume offset, so
    // the sweep never revisits it: it goes straight to the retry. Its partial
    // page died with that run, so a failed retry has nothing to fall back to.
    for (const index of checkpoint?.current?.name === name ? checkpoint.current.deferred ?? [] : []) {
      if (index >= startAt || !entriesAll[index]) continue;
      truncated.push(entriesAll[index]);
      deferred.set(entriesAll[index], { index, jobs: null });
    }
    const deferredIndices = () => [...deferred.values()].map((d) => d.index);
    // True once parallelEach has returned: from then on the totals above are
    // already net of retired boards and the whole slice has been walked.
    let loopDone = false;
    // What a checkpoint stores for this source, whenever it is written — every
    // CHECKPOINT_EVERY boards, and by a stop signal wherever the run is. The
    // resume point is the lowest unfinished board, held at or below any board
    // lost to a refusal run in progress; the scanned count is only work actually
    // attempted (see the note in the stop block).
    liveCheckpoint = () => ({
      current: { name, resumeAt: Math.min(startAt + lastResumeAt, refusedFloor()), datasetLen: list.length, datasetHash, deferred: deferredIndices() },
      counters: {
        ...snapshotCounters(),
        totalRetiredBoardsSkipped: totalRetiredBoardsSkipped + deadBoardsSkipped,
        // totalCompaniesScanned was bumped by the FULL entries.length up
        // front; a checkpoint must store only work actually attempted, or
        // a resumed run (which re-adds its own slice) double-counts the
        // completed portion in the final summary. Retired boards were not
        // attempted and must not be counted as scanned either, nor were
        // boards that reached a source the refusal breaker had given up on.
        totalCompaniesScanned: totalCompaniesScanned - (loopDone ? 0 : (entries.length - lastDone) + deadBoardsSkipped + skippedAbandoned),
        // The refused boards of a run in progress are read again by --resume, so
        // they are not unreachable boards of the run that wrote this checkpoint.
        totalErrors: totalErrors + errors - refusedRun.filter((r) => r.cls).length,
        sweepUnreachable: Object.fromEntries(Object.keys(unreachable).map((k) => [
          k, sweepUnreachable[k] + unreachable[k] - refusedRun.filter((r) => r.cls === k).length,
        ])),
      },
    });
    const sweepSourceStats = () => ({
      boards: entriesAll.length,
      resumedAt: startAt,
      unreachable: { ...unreachable },
      retired: deadBoardsSkipped,
      boardsNotAsked: abandoned ? skippedAbandoned + (entries.length - lastDone) : 0,
      requests: sweepStats.requests,
      throttledResponses: sweepStats.throttledResponses,
      abandoned: abandoned ? { class: abandoned.cls, consecutive: abandoned.count, lastBoard: abandoned.board } : null,
    });
    await parallelEach(entries, source.concurrency ?? CONCURRENCY, async (entry, idx) => {
      const deadBoard = boardKey(entry);
      if (shouldSkipDeadBoard(deadBoards, name, deadBoard)) {
        deadBoardsSkipped++;
        return;
      }
      try {
        // The whole per-company unit — fetch AND processJobs (which may issue
        // per-job detail-page requests via provider.enrichDate) — runs inside
        // one watchdog, so enrichment latency can't blow past COMPANY_TIMEOUT_MS.
        await boardScope(source, () => withTimeout((async () => {
          // Most boards in a public directory hold nothing the title filter
          // wants; where the provider can list a board cheaply, find that out
          // before downloading every posting body.
          if (typeof source.provider.fetchListing === 'function') {
            const listing = await runGuarded(sweepGate, name, () => source.provider.fetchListing(entry, sourceCtx));
            if (!listingMayMatch(listing, { cutoff, titleFilter, companySlug: entry.name })) {
              if (!opts.includeUndated) droppedNoDate += undatedInListing(listing, cutoff);
              recordBoardResult(deadBoards, name, deadBoard, 200);
              consecutiveResolverFailures = 0;
              refusedRun = [];
              return;
            }
          }
          const jobs = await runGuarded(sweepGate, name, () => source.provider.fetch(entry, sourceCtx));
          recordBoardResult(deadBoards, name, deadBoard, 200);
          consecutiveResolverFailures = 0;
          refusedRun = [];
          // Queued BEFORE the gate, deliberately: a board the gate cannot yet
          // judge has to stay in the retry list, and the gate below is what
          // decides whether it was ever eligible. Only 'transient' is worth a
          // sequential retry — 'structural' means the board hit a fixed bound
          // (facet-split slice/depth/page budget) that a repeat run reaches
          // again, paying the same expensive split for the same result.
          if (jobs.workdayTruncated === WORKDAY_TRUNCATED_REASON.TRANSIENT) truncated.push(entry);
          // Ahead of processJobs, deliberately: a gated board is not merely
          // quieter but CHEAPER, since provider.enrichDate() issues a per-job
          // detail request for undated providers (icims) and a board dropped
          // here never pays for one. The one board that does not get decided
          // here is the truncated one — see boardGateDecision.
          const decision = boardGateDecision(jobs, domainFilter);
          if (decision === 'gate') {
            domainGatedBoards++;
            domainGatedPostings += jobs.length;
            if (opts.verbose) console.error(`  ⊘ ${name}/${entry.name}: no domain-bearing posting — board skipped`);
            return;
          }
          // Deferred: the retry below re-fetches the whole board and gates
          // THAT. Its partial page is not processed here — those rows would
          // bypass a gate that has not been decided yet, which is the loose
          // direction this feature exists to close. It is kept, though, for
          // the case where the retry fetch fails outright.
          if (decision === 'defer') {
            deferred.set(entry, { index: startAt + idx, jobs });
            return;
          }
          if (jobs.icimsTruncated) {
            cappedBoards++;
            if (opts.verbose) console.error(`  ⚠ ${name}/${entry.name}: hit the page cap — later postings not scanned`);
          }
          if (jobs.workdayNoDateSkip) { noDateSkipCompanies++; noDateSkipJobs += jobs.length; }
          await processJobs(jobs, name, source.provider, entry.name);
        })(), COMPANY_TIMEOUT_MS, `${name}/${entry.name}`));
      } catch (err) {
        if (err?.hostAbandoned) {
          // Reached the gate after the source was given up on. Not asked, so not
          // an error and not evidence about the board.
          skippedAbandoned++;
          refusedRun.push({ at: startAt + idx, cls: null });
          return;
        }
        // Mostly defunct boards in the public dataset — expected noise, so the
        // default stays quiet; --verbose surfaces per-board failures.
        errors++;
        const failureClass = classifyProbeError(err);
        unreachable[failureClass]++;
        if (failureClass === '404') {
          refusedRun = [];
        } else if (failureClass === '429' || failureClass === '403') {
          refusedRun.push({ at: startAt + idx, cls: failureClass });
          if (abandoned && !abandoned.board) abandoned.board = entry.name;
        }
        recordBoardFailure(deadBoards, name, deadBoard, err);
        // A dead board and a dead resolver look identical one at a time; only
        // the *consecutive* run tells them apart, so any non-resolver outcome
        // resets the count (#2229).
        if (isResolverFailure(err)) {
          // Record only the first board past the limit: in-flight boards keep
          // failing after the flag is set, and the last of them is not the one
          // that tripped it.
          if (++consecutiveResolverFailures >= RESOLVER_FAILURE_LIMIT && !resolverOutage) {
            resolverOutage = true;
            resolverOutageCompany = entry.name;
          }
        } else {
          consecutiveResolverFailures = 0;
        }
        if (opts.verbose) console.error(`  ✗ ${name}/${entry.name}: ${err.message}`);
      }
    }, ({ done, resumeAt }) => {
      lastDone = done;
      curDone = done; curErrors = errors; curDeadSkipped = deadBoardsSkipped;
      lastResumeAt = resumeAt;
      if (done % 200 === 0 || done === entries.length) {
        progress(`  ${done}/${entries.length} scanned, ${newOffers.length} total matches\r`);
      }
      if (done % CHECKPOINT_EVERY === 0 && !opts.dryRun) {
        saveDeadBoardsBestEffort(deadBoards);
        saveCheckpoint({ ...checkpointBase(), ...liveCheckpoint() });
      }
    }, () => resolverOutage || abandoned !== null);
    loopDone = true;
    // parallelEach reports a completed callback even when a retired board was
    // skipped, so remove those entries from the live scan total after the
    // source pass. The retired count remains visible separately.
    totalCompaniesScanned -= deadBoardsSkipped;
    // Second chance for boards the parallel sweep truncated: retry alone on a
    // quiet line. Re-processing the full board is safe — seenUrls already
    // holds every match from the partial first pass.
    // Skipped entirely under a resolver outage: retrying boards one by one is
    // more of exactly the traffic the breaker just stopped. A board deferred by
    // the gate is then neither processed nor counted here; the checkpoint
    // carries its index, and the resumed run retries it. The same goes for a
    // source the refusal breaker gave up on.
    if (truncated.length && !resolverOutage && !abandoned) {
      log(`\n  ↻ retrying ${truncated.length} truncated board(s) sequentially...`);
      for (const entry of truncated) {
        if (abandoned) break;
        try {
          await boardScope(source, () => withTimeout((async () => {
            const jobs = await runGuarded(sweepGate, name, () => source.provider.fetch(entry, sourceCtx));
            recordBoardResult(deadBoards, name, boardKey(entry), 200);
            // Where a board deferred by the parallel sweep is actually decided.
            // A board the sweep already admitted is never gated here, and one
            // still truncated is admitted rather than counted as gated.
            if (retryGateDecision(jobs, domainFilter, deferred.has(entry)) === 'gate') {
              domainGatedBoards++;
              domainGatedPostings += jobs.length;
              if (opts.verbose) console.error(`  ⊘ ${name}/${entry.name}: no domain-bearing posting — board skipped`);
            } else {
              await processJobs(jobs, name, source.provider, entry.name);
            }
            if (jobs.workdayTruncated) {
              errors++; // still not fully covered — move on
              unreachable.other++;
              // A board pushed here as 'transient' can legitimately come back
              // 'structural': the retry's root crawl succeeded, the clamp got
              // detected for the first time, and the split then hit its own
              // bound — that's a real first split, not a repeat.
              if (opts.verbose) {
                const why = jobs.workdayTruncated === WORKDAY_TRUNCATED_REASON.STRUCTURAL
                  ? 'facet split hit its bound' : 'still truncated';
                console.error(`  ✗ ${name}/${entry.name}: ${why} after sequential retry`);
              }
            }
          })(), COMPANY_TIMEOUT_MS, `${name}/${entry.name} (retry)`));
        } catch (err) {
          // Given up on while this board waited: not asked, so neither an error
          // nor a dead board (its partial page, if the gate deferred it, is
          // processed below like any failed retry).
          if (!err?.hostAbandoned) {
            errors++;
            unreachable[classifyProbeError(err)]++;
            recordBoardFailure(deadBoards, name, boardKey(entry), err);
          }
          if (opts.verbose) console.error(`  ✗ ${name}/${entry.name} (retry): ${err.message}`);
          // No fuller fetch is coming, so a deferred board's partial page is
          // admitted ungated, the fallback the retry takes for a board that
          // comes back truncated again. Without it, a title match already in
          // hand would be lost to the retry's failure.
          const partial = deferred.get(entry)?.jobs;
          if (partial) await processJobs(partial, name, source.provider, entry.name);
        }
      }
    }
    totalErrors += errors;
    totalRetiredBoardsSkipped += deadBoardsSkipped;
    for (const k of Object.keys(unreachable)) sweepUnreachable[k] += unreachable[k];
    // Boards the abandoned source never asked about: the ones that reached the
    // gate after it closed, and the ones parallelEach never claimed.
    const notAsked = abandoned ? skippedAbandoned + (entries.length - lastDone) : 0;
    skippedAbandonedBoards += notAsked;
    if (!opts.dryRun) saveDeadBoardsBestEffort(deadBoards);
    // A throttled run and a dead-board run both end in a big "unreachable"
    // number; the breakdown is what tells them apart.
    const breakdown = () => log(`  unreachable ${errors}: ${formatUnreachable(unreachable)}${sweepStats.throttledResponses ? ` — ${sweepStats.throttledResponses} of ${sweepStats.requests} requests were refused (403/429)` : ''}`);
    if (resolverOutage || abandoned) {
      // Deliberately before completedSources/checkpoint: this source did NOT
      // finish, and marking it done would make --resume skip the rest of it.
      if (resolverOutage) stoppedByOutage = true;
      if (abandoned) stoppedByRefusals = true;
      // The counter was bumped by the FULL entries.length up front, but the
      // breaker left entries.length - lastDone boards unattempted. Correct the
      // live counter, not just the checkpoint payload: this run's own summary
      // and --json would otherwise report companies nobody ever contacted as
      // scanned. Correcting it here also gives the checkpoint the right figure
      // for free — a resumed run re-adds its own slice, so a checkpoint holding
      // the full slice makes the completed portion count twice. (Boards that
      // reached a closed refusal gate were counted done by parallelEach but
      // never asked either.)
      totalCompaniesScanned -= (entries.length - lastDone) + skippedAbandoned;
      // Pin the resume point here rather than leaving the last periodic write
      // to stand for it. That one fires every CHECKPOINT_EVERY companies, so
      // it can be up to 500 boards behind where the breaker actually stopped —
      // and --resume would replay all of them against the resolver that just
      // refused. Under the refusal breaker the point also stays at or below the
      // boards that were refused or never asked: they are done as far as
      // parallelEach knows, and --resume must not skip them.
      const resumeAbs = Math.min(startAt + lastResumeAt, refusedFloor());
      // The refused boards are read again by --resume, so the checkpoint does not
      // keep them as unreachable (this run's own summary still does).
      const refusedAgain = refusedRun.filter((r) => r.cls);
      let checkpointWritten = false;
      if (!opts.dryRun) {
        const counters = snapshotCounters();
        // What a --resume must not count again is everything from the resume point
        // on, which it will read: the checkpoint's scanned figure is the boards
        // below that point.
        counters.totalCompaniesScanned = scannedBeforeSource + Math.max(0, resumeAbs - startAt - deadBoardsSkipped);
        counters.totalErrors -= refusedAgain.length;
        for (const r of refusedAgain) counters.sweepUnreachable[r.cls] -= 1;
        checkpointWritten = saveCheckpoint({
          ...checkpointBase(),
          current: { name, resumeAt: resumeAbs, datasetLen: list.length, datasetHash, deferred: deferredIndices() },
          counters,
        });
      }
      liveCheckpoint = null;
      breakdown();
      if (resolverOutage) {
        log(`\n  ⛔ stopped ${name}/${resolverOutageCompany}: ${RESOLVER_FAILURE_LIMIT} consecutive DNS failures.`);
        log(`     Your resolver is refusing queries — it may be rate-limiting this host.`);
        log(`     Lower CONCURRENCY, raise the resolver's per-client limit, or set`);
        log(`     CAREER_OPS_NO_DNS_CACHE=1 only if you know the cache is at fault.`);
        // Only claim resumability when a checkpoint actually exists: --dry-run
        // writes none, and a failed write (ENOSPC, read-only volume) leaves at
        // best the last periodic checkpoint — nothing at the offset named here.
        if (checkpointWritten) log(`     Rerun with --resume once the resolver recovers — checkpointed at company ${resumeAbs} of ${name}.`);
      }
      if (abandoned) {
        const n = (v) => v.toLocaleString('en-US');
        log(`\n  ⛔ stopped ${name}: ${abandoned.count} consecutive HTTP ${abandoned.cls} (last refused board: ${abandoned.board ?? '?'}); ${n(resumeAbs)} of ${n(entriesAll.length)} boards scanned; rerun later${checkpointWritten ? ' or with --resume' : ''}.`);
        log(`     The host is refusing this address (${unreachable['429']} x 429, ${unreachable['403']} x 403 on boards that were asked). ${n(notAsked)} boards were not asked and are not recorded as dead; the refused ones are unknown, not dead.`);
        if (checkpointWritten) log(`     --resume continues at company ${resumeAbs} of ${name}; the matches found so far are saved below.`);
        abandonedSources.push({
          source: name,
          class: abandoned.cls,
          consecutive: abandoned.count,
          lastBoard: abandoned.board,
          boardsScanned: resumeAbs,
          boardsTotal: entriesAll.length,
          boardsNotAsked: notAsked,
          resumeAt: resumeAbs,
          checkpointed: checkpointWritten,
        });
      }
      sweepSources[name] = sweepSourceStats();
      break;
    }
    completedSources.add(name);
    // Source finished and folded into the totals — clear the live deltas so a
    // SIGTERM between sources reports the totals, not this source's slice twice.
    curEntries = 0; curDone = 0; curErrors = 0; curDeadSkipped = 0;
    liveCheckpoint = null;
    if (!opts.dryRun) {
      saveCheckpoint({ ...checkpointBase(), current: null, counters: snapshotCounters() });
    }
    log(`\n  done (${errors} unreachable boards, ${deadBoardsSkipped} retired boards skipped)`);
    breakdown();
    sweepSources[name] = sweepSourceStats();
  }

  sweepComplete = !stoppedByOutage && !stoppedByRefusals;

  // ── User tracker + scan-history ATS seeds (#3697) ───────────────
  if (historySeeds.length && !stoppedByOutage && !stoppedByRefusals) {
    const providers = await loadProviders(PROVIDERS_DIR);
    log(`\n🌱 Application history — ${historySeeds.length} unique ATS board(s) derived locally...`);
    const result = await runHistorySeedScan(historySeeds, providers, opts, ctx, processJobs);
    totalCompaniesScanned += result.total;
    totalErrors += result.errors;
    log(`  done — ${result.total} board(s) probed, ${result.unsupported} without a scanner provider (${result.errors} errors)`);
  }

  // ── VC portfolio seed sources (--seeds flag) ───────────────────────
  /** @type {Record<string, ReturnType<typeof newSeedStats>>} */
  const seedStats = {};
  if (opts.refreshSeedCache && !opts.seeds.length) {
    console.error('⚠️  --refresh-seed-cache has no effect without --seeds');
  }
  if (opts.seeds.length) {
    // One memory and one set of per-host gates for every seed in the run, so a
    // slug YC and a16z both lead to is asked about once, and a host that
    // refused during the YC walk is still being avoided for a16z. A dry run
    // reads the memory (so it previews the real run) and never writes it.
    opts.seedState = createSeedRunState({
      deadPath: SEED_DEAD_BOARDS_PATH,
      livePath: SEED_LIVE_BOARDS_PATH,
      refresh: opts.refreshSeedCache,
      persist: !opts.dryRun,
      withKeySlot: createKeyedLimiter(SINGLE_HOST_CONCURRENCY),
      // Six in flight AND no more than ~20 request starts a second per host;
      // CAREER_OPS_SEED_HOST_GAP_MS tunes the spacing (0 turns it off).
      minGapMs: resolveSeedGapMs(process.env.CAREER_OPS_SEED_HOST_GAP_MS),
      onAbandon: (host, cls, count) => console.error(`\n⛔ ${host} answered ${cls} ${count} times in a row — no more requests to it this run. Its remaining probes are skipped (and not remembered as dead); rerun later.`),
    });
  }
  // A host that has just refused the sweep is not asked again by the seed scan
  // in the same run: its own breaker would take ten more refusals to learn it.
  const seedsToRun = stoppedByRefusals ? [] : opts.seeds;
  if (opts.seeds.length && stoppedByRefusals) {
    log(`\n🌱 seed scan skipped (${opts.seeds.join(', ')}) — the sweep was stopped by a host refusing requests; rerun later`);
  }
  for (const seedId of seedsToRun) {
    const seedSource = SEED_SOURCES[seedId];
    log(`\n🌱 ${seedSource.label} (${seedId}-seed) — fetching portfolio...`);
    // `sink` is the run's own list of kept matches, so a stop signal arriving
    // mid-seed can still flush what the seed had found.
    const result = await runSeedScan(seedId, opts, ctx, seenUrls, seedSource.label, {
      onProgress: ({ done, total, matches }) => progress(`  ${done}/${total} companies probed, ${matches} matches\r`),
      sink: newOffers,
    });
    seedStats[seedId] = result.stats;
    totalCompaniesScanned += result.total;
    totalErrors += result.errors;
    // The progress ticker ends in a carriage return, not a newline.
    log(`\n${formatSeedDone(result.stats)}`);
  }

  const blacklistResult = filterBlacklistedOffers(newOffers, blacklist, { includeBlacklisted: opts.includeBlacklisted });
  let offers = blacklistResult.offers;
  if (offers.length && opts.liveness) offers = await filterLive(offers);
  offers.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));

  printScanSummaryHeader('Reverse ATS Scan', date, log);
  log(`Companies scanned:  ${totalCompaniesScanned}${capHit ? ` of ${totalCompaniesAvailable} (capped)` : ''}`);
  log(`Unreachable boards: ${totalErrors}`);
  // The same figure by cause, so a run a host throttled (403/429) reads
  // differently from one that met dead boards (404).
  if (Object.keys(sweepSources).length || unreachableTotal(sweepUnreachable) > 0) {
    log(`  sweep boards:     ${formatUnreachable(sweepUnreachable)}`);
  }
  for (const a of abandonedSources) {
    const n = (v) => v.toLocaleString('en-US');
    log(`⛔ Stopped early:   ${a.source} — ${a.consecutive} consecutive HTTP ${a.class} (last refused board: ${a.lastBoard ?? '?'}); ${n(a.boardsScanned)} of ${n(a.boardsTotal)} boards scanned, ${n(a.boardsNotAsked)} not asked and not recorded as dead; rerun later${a.checkpointed ? ' or with --resume' : ''}`);
  }
  const seedIds = Object.keys(seedStats);
  if (seedIds.length) {
    const seedUnreachable = emptyUnreachable();
    for (const id of seedIds) for (const k of Object.keys(seedUnreachable)) seedUnreachable[k] += seedStats[id].unreachable[k] || 0;
    log(`  seed boards:      ${formatUnreachable(seedUnreachable)}`);
    for (const id of seedIds) {
      const st = seedStats[id];
      if (st.fetchFailed) { log(`Seed ${id}:          FAILED — ${st.failure}`); continue; }
      const vendors = Object.entries(st.byVendor).map(([v, c]) => `${v} ${c}`).join(' / ');
      log(`Seed ${id}:          ${st.companies} companies | ${st.live} live${vendors ? ` (${vendors})` : ''}, ${st.liveEmpty} empty, ${st.dead} dead, ${st.unknown} unknown | ${st.probes} probes, ${st.cachedSkips} remembered-dead skipped`);
    }
    for (const id of seedIds) {
      for (const w of seedStats[id].warnings) log(`⚠️  Seed ${id}: ${w}`);
    }
  }
  if (cappedBoards) log(`Page-capped boards: ${cappedBoards} (partial coverage — later postings not scanned)`);
  // Reported whenever the gate RAN, including when it skipped nothing: a zero
  // there is the useful reading that the domain list admitted every board, and
  // silence would be indistinguishable from the gate being off.
  if (domainFilter) {
    log(`Domain-gated boards: ${domainGatedBoards} skipped, ${domainGatedPostings} posting${domainGatedPostings === 1 ? '' : 's'} never filtered${domainGatedBoards && !opts.verbose ? ' (--verbose names them)' : ''}`);
  }
  // A paced sweep is slower on purpose. Say so, or the operator reads the
  // wall-clock time as a hang (#2229).
  const pacing = dnsPacingStats();
  if (pacing.delayed > 0) {
    log(`DNS pacing:         ${pacing.delayed} lookup${pacing.delayed === 1 ? '' : 's'} delayed, ${Math.round(pacing.waitedMs / 1000)}s total wait (CAREER_OPS_DNS_LOOKUPS_PER_MIN to tune, 0 disables)`);
  }
  // noDateSkipJobs is a subset of droppedNoDate, not a separate pool: every
  // no-postedOn workday posting counted here also hits the per-job undated
  // filter in the scan loop above and gets dropped there too. Report it as
  // a breakdown, not a second count — the two aren't additive.
  if (droppedNoDate) {
    const breakdown = noDateSkipCompanies
      ? ` (incl. ${noDateSkipJobs} from ${noDateSkipCompanies} workday companies with no postedOn)`
      : '';
    log(`Undated dropped: ${droppedNoDate}${breakdown}${opts.includeUndated ? '' : '. Use --include-undated to keep'}`);
  }
  if (blacklist.size > 0) {
    if (opts.includeBlacklisted) {
      log(`Blacklisted:      ${blacklistResult.annotatedBlacklisted} let through annotated (--include-blacklisted)`);
    } else {
      log(`Blacklisted:      ${blacklistResult.filteredBlacklist} skipped (blacklist)`);
    }
  }
  if (droppedContent) log(`Content-filtered:   ${droppedContent}`);
  // What the gates scan.mjs applies removed, sweep and seed scans together.
  const gateTotals = { ...gateCounts };
  for (const id of seedIds) for (const k of Object.keys(gateTotals)) gateTotals[k] += seedStats[id].gated?.[k] || 0;
  if (gates.skipTiers.length) log(`Filtered by tier:   ${gateTotals.tier} (skip_tiers: ${gates.skipTiers.join(', ')})`);
  if (gates.visaFilter) log(`Filtered by visa:   ${gateTotals.visa}`);
  if (gates.countryFilter) log(`Filtered by country: ${gateTotals.country}${gates.countryInert ? ' (inactive: the profile country is United States)' : ''}`);
  log(`Duplicate roles:    ${gateTotals.duplicateRole} (company+title already known under another URL)`);
  const gate = opts.levelGate;
  if (gate?.filter) {
    const extra = [
      gate.fetched ? `${gate.fetched} JDs fetched` : '',
      gate.unchecked ? `${gate.unchecked} kept unread (no JD text)` : '',
    ].filter(Boolean).join(', ');
    log(`Level-filtered:     ${gate.dropped.length} (Staff+ title AND JD requires ${gate.filter.minYears}+ yrs or team lead)${extra ? ` — ${extra}` : ''}`);
    for (const line of gate.dropped) log(`  - ${line}`);
  }
  log(`New matches:        ${offers.length}`);

  if (offers.length) {
    log('\nNew offers:');
    for (const o of offers) {
      const posted = o.postedAt ? new Date(o.postedAt).toISOString().slice(0, 10) : 'n/a';
      const blacklistSuffix = o.blacklisted ? ' [BLACKLISTED — on your do-not-apply list]' : '';
      log(`  + [${o.source}] ${posted} | ${o.company} | ${o.title} | ${o.location || 'N/A'}${blacklistSuffix}\n    ${o.url}`);
    }
  }

  // Persist (unless dry-run, or nothing to save).
  let saved = false;
  if (offers.length && !opts.dryRun) {
    await persistOffers(offers);
    saved = true;
    log(`\nResults saved to ${PIPELINE_PATH} and data/scan-history.tsv`);

    if (opts.mdOut) {
      try {
        mkdirSync(opts.mdOut, { recursive: true });
        const digest = [
          `# Reverse ATS Scan — ${date}`,
          `> ${offers.length} jobs | since ${opts.sinceDays}d | ${opts.liveness ? 'liveness ✓' : 'no liveness check'}`,
          '',
          ...offers.map(o => {
            const posted = o.postedAt ? new Date(o.postedAt).toISOString().slice(0, 10) : 'n/a';
            return `- [${o.title} @ ${o.company}](${o.url}) — ${o.location || 'N/A'} | ${o.source} | ${posted}`;
          }),
          '',
        ].join('\n');
        writeFileSync(path.join(opts.mdOut, `${date}.md`), digest, 'utf-8');
        log(`Markdown digest saved to ${path.join(opts.mdOut, `${date}.md`)}`);
      } catch (err) {
        console.error(`⚠️  Could not write markdown digest: ${err.message}`);
      }
    }
  }

  // Sweep completed — the checkpoint's job is done. A run the breaker stopped
  // did NOT complete: deleting here would destroy the resume point the outage
  // branch just wrote, which is the one case --resume exists for (#2283).
  const stoppedEarly = stoppedByOutage || stoppedByRefusals;
  if (!opts.dryRun && !stoppedEarly && existsSync(CHECKPOINT_PATH)) unlinkSync(CHECKPOINT_PATH);
  // A stopped run has written its matches above AND keeps a checkpoint whose
  // `offers` is every match so far. Left there, --resume would append them again.
  if (stoppedEarly && saved) clearCheckpointedOffers();

  // The authoritative machine-readable result: lets a caller (e.g. the web)
  // tell a *degraded* scan (capped / stale dataset / undated dropped) apart
  // from a genuinely *empty* one. In --json mode stdout carries ONLY this.
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      date,
      sources: opts.ats,
      resumed: Boolean(checkpoint),
      sinceDays: opts.sinceDays,
      companiesAvailable: totalCompaniesAvailable,
      companiesScanned: totalCompaniesScanned,
      capHit,
      // The most degraded outcome this payload can report: the sweep did not
      // finish its sources, and a checkpoint is waiting for --resume. Without
      // it a caller can't tell a stopped run from a complete one except by
      // stat'ing the checkpoint file itself.
      stoppedByOutage,
      // The sweep gave up on a source because its host kept answering 429/403;
      // a checkpoint is waiting for --resume. `abandonedSources` names each one.
      stoppedByRefusals,
      abandonedSources,
      boardsNotAsked: skippedAbandonedBoards,
      datasetStatus,
      postingsKept: offers.length,
      postingsDroppedNoDate: droppedNoDate,
      postingsFilteredBlacklist: blacklistResult.filteredBlacklist,
      postingsAnnotatedBlacklisted: blacklistResult.annotatedBlacklisted,
      postingsDroppedContent: droppedContent,
      unreachableBoards: totalErrors,
      // The same figure by cause for the directory sweep (seeds carry their own
      // below): a throttled run and a dead-board run are told apart by 403/429
      // against 404. `sweep` has it per source, with the request counts.
      unreachableByCause: sweepUnreachable,
      sweep: sweepSources,
      // What the gates scan.mjs applies removed, sweep and seed scans together.
      postingsFilteredTier: gateTotals.tier,
      postingsFilteredCountry: gateTotals.country,
      postingsFilteredVisa: gateTotals.visa,
      postingsDuplicateRole: gateTotals.duplicateRole,
      gates: {
        skipTiers: gates.skipTiers,
        visaFilterActive: Boolean(gates.visaFilter),
        countryFilterActive: Boolean(gates.countryFilter),
        countryFilterInert: gates.countryInert,
      },
      // Per seed source: what the probe found and what it could not reach, by
      // cause, plus the degraded-run warnings. Empty when --seeds is off.
      seeds: seedStats,
      retiredBoardsSkipped: totalRetiredBoardsSkipped,
      cappedBoards,
      // `domainFilterActive` is not derivable from the two counts: zero skipped
      // boards is equally what an absent domain_filter and a permissive one
      // produce, and a caller comparing two sweeps needs to know which.
      domainFilterActive: Boolean(domainFilter),
      domainGatedBoards,
      domainGatedPostings,
      dnsPacing: { delayed: pacing.delayed, waitedMs: Math.round(pacing.waitedMs) },
      saved,
      offers: offers.map(o => ({
        company: o.company,
        title: o.title,
        url: o.url,
        location: o.location || null,
        postedAt: o.postedAt ? new Date(o.postedAt).toISOString().slice(0, 10) : null,
        dateStatus: o.dateStatus || (o.postedAt ? 'dated' : 'unknown'),
        blacklisted: Boolean(o.blacklisted),
        note: o.note || null,
        source: o.source,
      })),
    }) + '\n');
    return;
  }

  if (!offers.length) {
    log('\nNothing new.');
    return;
  }
  if (opts.dryRun) {
    log('\n(dry run — run without --dry-run to save results)');
    return;
  }
  log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
}

// Only run main() when invoked directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
