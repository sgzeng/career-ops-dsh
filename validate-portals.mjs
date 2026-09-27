#!/usr/bin/env node

/**
 * validate-portals.mjs — schema/shape validator for portals.yml.
 *
 * Usage:
 *   node validate-portals.mjs
 *   node validate-portals.mjs --file templates/portals.example.yml
 *   node validate-portals.mjs --self-test
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(ROOT, 'providers');
const DEFAULT_PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';

function add(list, path, message) {
  list.push({ path, message });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function validateUrl(value, path, errors) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') {
    add(errors, path, 'must be a string URL');
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    add(errors, path, `invalid URL: ${value}`);
    return;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    add(errors, path, `unsupported URL protocol: ${parsed.protocol}`);
  }
}

function validateKeywordList(value, path, errors) {
  if (value === undefined || value === null) return;
  const arr = Array.isArray(value) ? value : [value];
  for (const [idx, item] of arr.entries()) {
    if (typeof item !== 'string') {
      add(errors, `${path}[${idx}]`, 'keyword must be a string');
      continue;
    }
    if (item.trim() === '') {
      add(errors, `${path}[${idx}]`, 'keyword must not be empty');
    }
  }
}

function validateParser(parser, path, errors) {
  if (parser === undefined || parser === null) return;
  if (!isObject(parser)) {
    add(errors, path, 'parser must be an object');
    return;
  }
  if (typeof parser.command !== 'string' || parser.command.trim() === '') {
    add(errors, `${path}.command`, 'parser.command must be a non-empty string');
  }
  if (parser.script !== undefined && (typeof parser.script !== 'string' || parser.script.trim() === '')) {
    add(errors, `${path}.script`, 'parser.script must be a non-empty string when set');
  }
  if (parser.args !== undefined && !Array.isArray(parser.args)) {
    add(errors, `${path}.args`, 'parser.args must be an array when set');
  }
  if (parser.timeout_ms !== undefined && (!Number.isFinite(Number(parser.timeout_ms)) || Number(parser.timeout_ms) <= 0)) {
    add(errors, `${path}.timeout_ms`, 'parser.timeout_ms must be a positive number when set');
  }
  if (parser.max_buffer_bytes !== undefined && (!Number.isFinite(Number(parser.max_buffer_bytes)) || Number(parser.max_buffer_bytes) <= 0)) {
    add(errors, `${path}.max_buffer_bytes`, 'parser.max_buffer_bytes must be a positive number when set');
  }
}

async function loadProviderIds() {
  const ids = new Set();
  if (existsSync(PROVIDERS_DIR)) {
    const files = readdirSync(PROVIDERS_DIR)
      .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
      .sort();
    for (const file of files) {
      const mod = await import(pathToFileURL(join(PROVIDERS_DIR, file)).href);
      if (mod.default?.id) ids.add(mod.default.id);
    }
  }

  // scan.mjs accepts explicit provider-plugin ids even when a plugin is
  // disabled or missing credentials (the runtime installs an actionable
  // inactive-provider stub). Keep validation aligned with that contract.
  try {
    const { discoverPlugins, pluginRoots, resolveSuccessorIds } = await import('./plugins/_engine.mjs');
    const manifests = discoverPlugins(pluginRoots(ROOT), resolveSuccessorIds(ROOT));
    for (const manifest of manifests) {
      if (manifest.hooks.includes('provider')) ids.add(manifest.id);
    }
  } catch (err) {
    // A stripped-down checkout may not include plugin infrastructure. Core
    // provider validation should continue to work in that environment.
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
  return ids;
}

const TITLE_FILTER_FIELDS = ['positive', 'negative', 'seniority_boost'];

// Top-level keys the scanner + the stage-2 agent understand. An unknown key here
// is almost always a typo (`serch_queries`) that would silently do nothing, so it
// is surfaced as a warning (not an error — a stripped-down or future config may
// legitimately carry keys this checkout does not know).
const KNOWN_TOP_LEVEL = new Set([
  'scan_history', 'location_filter', 'visa_filter', 'country_eligibility_filter',
  'max_posting_age_days', 'trust_filter', 'skip_tiers', 'title_filter',
  'title_filter_full', 'title_filter_overrides', 'tracked_title_overrides', 'content_filter', 'content_rescue', 'level_filter', 'salary_filter', 'search_keyword_groups',
  'search_queries', 'linkedin_post_queries', 'tracked_companies', 'job_boards',
  'interamt_searches', 'hn_hiring', 'first_scan_backfill',
]);

// Per-entry keys recognised on tracked_companies[] / job_boards[].
const KNOWN_COMPANY_KEYS = new Set([
  'name', 'careers_url', 'api', 'provider', 'parser', 'domain', 'enabled',
  'max_pages', 'ibm', 'amazon', 'notes', 'verified',
  'scan_method', 'scan_query', 'groups', 'search_site', 'first_scan_backfill',
]);

const KNOWN_SEARCH_QUERY_KEYS = new Set(['name', 'query', 'groups', 'site', 'enabled']);

const SCAN_METHODS = new Set(['websearch', 'playwright', 'local_parser']);

function looksScoped(str) {
  return typeof str === 'string' && /\bsite:/i.test(str);
}

export async function validatePortalsConfig(config, { providerIds = new Set() } = {}) {
  const errors = [];
  const warnings = [];

  if (!isObject(config)) {
    add(errors, '<root>', 'portals config must be a YAML object');
    return { errors, warnings };
  }

  if (config.title_filter !== undefined) {
    if (!isObject(config.title_filter)) {
      add(errors, 'title_filter', 'title_filter must be an object');
    } else {
      validateKeywordList(config.title_filter.positive, 'title_filter.positive', errors);
      validateKeywordList(config.title_filter.negative, 'title_filter.negative', errors);
      validateKeywordList(config.title_filter.seniority_boost, 'title_filter.seniority_boost', errors);
    }
  }

  // Optional per-scanner override consumed only by scan-ats-full.mjs. Same
  // shape as title_filter, so it gets the same structural checks — an
  // unvalidated key would let a typo ("positve") silently resolve to a
  // profile with no positive keywords, which matches every posting.
  if (config.title_filter_full !== undefined) {
    if (!isObject(config.title_filter_full)) {
      add(errors, 'title_filter_full', 'title_filter_full must be an object');
    } else {
      // A misspelled field is the dangerous case, not a missing one:
      // `positve:` leaves `positive` undefined, buildTitleFilter treats an
      // empty positive list as "no positive constraint", and the sweep then
      // matches every title on every board — the exact outcome this key
      // exists to prevent. An unknown field is therefore an error, while
      // `positive: []` stays valid as a deliberate choice.
      for (const key of Object.keys(config.title_filter_full)) {
        if (!TITLE_FILTER_FIELDS.includes(key)) {
          add(errors, `title_filter_full.${key}`, `unknown title_filter_full field - expected one of ${TITLE_FILTER_FIELDS.join(', ')}`);
        }
      }
      validateKeywordList(config.title_filter_full.positive, 'title_filter_full.positive', errors);
      validateKeywordList(config.title_filter_full.negative, 'title_filter_full.negative', errors);
      validateKeywordList(config.title_filter_full.seniority_boost, 'title_filter_full.seniority_boost', errors);
    }
  }

  if (config.location_filter !== undefined) {
    if (!isObject(config.location_filter)) {
      add(errors, 'location_filter', 'location_filter must be an object');
    } else {
      validateKeywordList(config.location_filter.always_allow, 'location_filter.always_allow', errors);
      validateKeywordList(config.location_filter.allow, 'location_filter.allow', errors);
      validateKeywordList(config.location_filter.block, 'location_filter.block', errors);
      validateKeywordList(config.location_filter.block_hard, 'location_filter.block_hard', errors);
      if (config.location_filter.strict !== undefined && typeof config.location_filter.strict !== 'boolean') {
        add(errors, 'location_filter.strict', 'must be a boolean when set');
      }
    }
  }

  if (config.content_filter !== undefined) {
    if (!isObject(config.content_filter)) {
      add(errors, 'content_filter', 'content_filter must be an object');
    } else {
      validateKeywordList(config.content_filter.positive, 'content_filter.positive', errors);
      validateKeywordList(config.content_filter.negative, 'content_filter.negative', errors);
      if (config.content_filter.by_title_keyword !== undefined) {
        if (!isObject(config.content_filter.by_title_keyword)) {
          add(errors, 'content_filter.by_title_keyword', 'by_title_keyword must be an object keyed by title_filter.positive keyword');
        } else {
          const titlePositive = new Set(
            (Array.isArray(config.title_filter?.positive) ? config.title_filter.positive : [])
              .filter(k => typeof k === 'string')
              .map(k => k.trim().toLowerCase())
          );
          for (const [kw, rule] of Object.entries(config.content_filter.by_title_keyword)) {
            const path = `content_filter.by_title_keyword.${kw}`;
            if (!titlePositive.has(kw.trim().toLowerCase())) {
              add(warnings, path, `"${kw}" does not match any title_filter.positive keyword and will never apply`);
            }
            if (!isObject(rule)) {
              add(errors, path, 'must be an object with positive/negative keyword lists');
              continue;
            }
            validateKeywordList(rule.positive, `${path}.positive`, errors);
            validateKeywordList(rule.negative, `${path}.negative`, errors);
          }
        }
      }
    }
  }

  // Fork-local (lib/content-rescue.mjs): description evidence can keep a title miss.
  if (config.content_rescue !== undefined) {
    const cr = config.content_rescue;
    if (!isObject(cr)) {
      add(errors, 'content_rescue', 'content_rescue must be an object');
    } else {
      if (cr.enabled !== undefined && typeof cr.enabled !== 'boolean') {
        add(errors, 'content_rescue.enabled', 'must be a boolean when set');
      }
      for (const key of ['min_distinct', 'min_distinct_no_thesis', 'boilerplate_df_pct', 'min_company_jobs', 'min_description_chars']) {
        if (cr[key] !== undefined && !(typeof cr[key] === 'number' && Number.isFinite(cr[key]) && cr[key] >= 0)) {
          add(errors, `content_rescue.${key}`, 'must be a non-negative number when set');
        }
      }
      validateKeywordList(cr.thesis_words, 'content_rescue.thesis_words', errors);
      validateKeywordList(cr.keywords, 'content_rescue.keywords', errors);
      validateKeywordList(cr.title_require_any, 'content_rescue.title_require_any', errors);
      validateKeywordList(cr.skip_providers, 'content_rescue.skip_providers', errors);
      // A rescue keyword whose text contains no content_filter.positive keyword
      // can rescue a job that content_filter then drops on the same evidence.
      const positive = (Array.isArray(config.content_filter?.positive) ? config.content_filter.positive : [])
        .filter(k => typeof k === 'string').map(k => k.trim().toLowerCase()).filter(Boolean);
      for (const listKey of ['thesis_words', 'keywords']) {
        const list = cr[listKey] == null ? [] : (Array.isArray(cr[listKey]) ? cr[listKey] : [cr[listKey]]);
        for (const w of list) {
          if (typeof w !== 'string' || positive.length === 0) continue;
          const bare = w.trim().toLowerCase().replace(/^(word|stem):/, '');
          if (!positive.some(p => bare.includes(p))) {
            add(warnings, `content_rescue.${listKey}`, `"${w}" contains no content_filter.positive keyword`);
          }
        }
      }
    }
  }

  // Fork-local (lib/level-filter.mjs): whole-word level cap on titles.
  if (config.level_filter !== undefined) {
    const lf = config.level_filter;
    if (!isObject(lf)) {
      add(errors, 'level_filter', 'level_filter must be an object');
    } else {
      if (lf.enabled !== undefined && typeof lf.enabled !== 'boolean') {
        add(errors, 'level_filter.enabled', 'must be a boolean when set');
      }
      validateKeywordList(lf.block, 'level_filter.block', errors);
      validateKeywordList(lf.exempt, 'level_filter.exempt', errors);
      if (lf.min_years !== undefined && (typeof lf.min_years !== 'number' || !(lf.min_years > 0))) {
        add(errors, 'level_filter.min_years', 'must be a positive number when set');
      }
      if (lf.fetch_jd !== undefined && typeof lf.fetch_jd !== 'boolean') {
        add(errors, 'level_filter.fetch_jd', 'must be a boolean when set');
      }
    }
  }

  if (config.visa_filter !== undefined) {
    if (!isObject(config.visa_filter)) {
      add(errors, 'visa_filter', 'visa_filter must be an object');
    } else {
      if (config.visa_filter.enabled !== undefined && typeof config.visa_filter.enabled !== 'boolean') {
        add(errors, 'visa_filter.enabled', 'must be a boolean when set');
      }
      if (config.visa_filter.require_mention !== undefined && typeof config.visa_filter.require_mention !== 'boolean') {
        add(errors, 'visa_filter.require_mention', 'must be a boolean when set');
      }
      validateKeywordList(config.visa_filter.positive, 'visa_filter.positive', errors);
      validateKeywordList(config.visa_filter.negative, 'visa_filter.negative', errors);
    }
  }

  // search_keyword_groups: the canonical vocabulary the stage-2 agent expands
  // into `site:<domain> ("t1" OR "t2" …)`. Object of name -> non-empty keyword list.
  const groupNames = new Set();
  if (config.search_keyword_groups !== undefined) {
    if (!isObject(config.search_keyword_groups)) {
      add(errors, 'search_keyword_groups', 'must be an object of name -> keyword list');
    } else {
      for (const [name, list] of Object.entries(config.search_keyword_groups)) {
        groupNames.add(name);
        const path = `search_keyword_groups.${name}`;
        if (!Array.isArray(list) || list.length === 0) {
          add(errors, path, 'must be a non-empty list of keyword strings');
          continue;
        }
        validateKeywordList(list, path, errors);
      }
    }
  }

  if (config.search_queries !== undefined) {
    if (!Array.isArray(config.search_queries)) {
      add(errors, 'search_queries', 'search_queries must be an array when set');
    } else {
      for (const [idx, entry] of config.search_queries.entries()) {
        const path = `search_queries[${idx}]`;
        if (!isObject(entry)) {
          add(errors, path, 'must be an object');
          continue;
        }
        const hasQuery = typeof entry.query === 'string' && entry.query.trim() !== '';
        const hasGroups = Array.isArray(entry.groups) && entry.groups.length > 0;
        if (!hasQuery && !hasGroups) {
          add(errors, path, 'must have either a non-empty `query` string or a non-empty `groups` list');
        }
        if (hasQuery && hasGroups) {
          add(errors, path, 'has both `query` and `groups` — use one (a literal `query` wins and makes `groups` dead)');
        }
        if (hasGroups) {
          for (const g of entry.groups) {
            if (!groupNames.has(g)) {
              add(errors, `${path}.groups`, `references unknown keyword group "${g}"`);
            }
          }
          if (entry.site !== undefined && (typeof entry.site !== 'string' || entry.site.trim() === '')) {
            add(errors, `${path}.site`, 'must be a non-empty domain string when `groups` is used');
          } else if (entry.site === undefined) {
            add(warnings, path, 'uses `groups` without a `site:` scope — the expanded query will be unscoped');
          }
        }
        if (hasQuery && !looksScoped(entry.query)) {
          add(warnings, `${path}.query`, 'literal query has no `site:` scope — unscoped queries return SEO listicles');
        }
        for (const key of Object.keys(entry)) {
          if (!KNOWN_SEARCH_QUERY_KEYS.has(key)) {
            add(warnings, `${path}.${key}`, `unknown search_queries field — expected one of ${[...KNOWN_SEARCH_QUERY_KEYS].join(', ')}`);
          }
        }
      }
    }
  }

  // Fork-local (lib/first-scan-backfill.mjs): `false`, or { enabled, window_days }.
  // scan.mjs fails closed (backfill off) on every value rejected here.
  if (config.first_scan_backfill !== undefined && typeof config.first_scan_backfill !== 'boolean') {
    const fb = config.first_scan_backfill;
    if (!isObject(fb)) {
      add(errors, 'first_scan_backfill', 'must be true, false or an object { enabled, window_days }');
    } else {
      if (fb.enabled !== undefined && typeof fb.enabled !== 'boolean') {
        add(errors, 'first_scan_backfill.enabled', 'must be a boolean when set');
      }
      if (fb.window_days !== undefined && !(Number.isInteger(fb.window_days) && fb.window_days > 0)) {
        add(errors, 'first_scan_backfill.window_days', 'must be a positive integer when set');
      }
    }
  }

  for (const key of Object.keys(config)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      add(warnings, key, 'unknown top-level portals.yml key (typo?)');
    }
  }

  // tracked_title_overrides (scan.mjs, fork-local): `companies` are matched to
  // tracked_companies names exactly (case-insensitive), so a name that matches
  // no entry — a typo, or an entry renamed later — silently broadens nothing.
  if (config.tracked_title_overrides !== undefined) {
    const tto = config.tracked_title_overrides;
    if (!Array.isArray(tto)) {
      add(errors, 'tracked_title_overrides', 'must be an array of { companies, positive_extra }');
    } else {
      const tracked = new Set((Array.isArray(config.tracked_companies) ? config.tracked_companies : [])
        .filter(e => isObject(e) && typeof e.name === 'string')
        .map(e => e.name.trim().toLowerCase()));
      for (const [idx, ov] of tto.entries()) {
        const base = `tracked_title_overrides[${idx}]`;
        if (!isObject(ov)) { add(errors, base, 'must be an object'); continue; }
        if (!Array.isArray(ov.companies) || ov.companies.length === 0) {
          add(errors, `${base}.companies`, 'must be a non-empty list of tracked_companies names');
        } else {
          for (const name of ov.companies) {
            if (typeof name !== 'string' || !tracked.has(name.trim().toLowerCase())) {
              add(warnings, `${base}.companies`, `"${name}" matches no tracked_companies name — it broadens nothing`);
            }
          }
        }
        validateKeywordList(ov.positive_extra, `${base}.positive_extra`, errors);
      }
    }
  }

  // tracked_companies and job_boards share one entry schema (name / careers_url /
  // api / provider / parser) and one dedup namespace downstream, so validate them
  // in a single pass. seenEnabledNames spans both lists: a board and a company
  // that share a name would still collide in the scanner's reporting.
  const seenEnabledNames = new Map();
  const validateEntryList = (list, key, noun) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      add(errors, key, `${key} must be an array when set`);
      return;
    }
    for (const [idx, entry] of list.entries()) {
      const base = `${key}[${idx}]`;
      if (!isObject(entry)) {
        add(errors, base, `${noun} entry must be an object`);
        continue;
      }
      if (entry.enabled === false) continue;

      if (typeof entry.name !== 'string' || entry.name.trim() === '') {
        add(errors, `${base}.name`, `enabled ${noun} must have a non-empty string name`);
      } else {
        const normalized = normalizeName(entry.name);
        if (seenEnabledNames.has(normalized)) {
          add(warnings, `${base}.name`, `duplicate enabled ${noun} name also seen at ${seenEnabledNames.get(normalized)}`);
        } else {
          seenEnabledNames.set(normalized, `${base}.name`);
        }
      }

      validateUrl(entry.careers_url, `${base}.careers_url`, errors);
      validateUrl(entry.api, `${base}.api`, errors);

      if (entry.provider !== undefined) {
        if (typeof entry.provider !== 'string' || entry.provider.trim() === '') {
          add(errors, `${base}.provider`, 'provider must be a non-empty string when set');
        } else if (!providerIds.has(entry.provider)) {
          add(errors, `${base}.provider`, `unknown provider "${entry.provider}"`);
        }
      }

      validateParser(entry.parser, `${base}.parser`, errors);

      // Fork-local stage-2 WebSearch fields (companies only, as before the
      // tracked_companies/job_boards merge into this shared validator).
      if (noun === 'company') {
        if (entry.scan_method !== undefined && !SCAN_METHODS.has(entry.scan_method)) {
          add(warnings, `${base}.scan_method`, `unrecognised scan_method "${entry.scan_method}" — expected one of ${[...SCAN_METHODS].join(', ')}`);
        }
        if (entry.scan_query !== undefined) {
          if (typeof entry.scan_query !== 'string' || entry.scan_query.trim() === '') {
            add(errors, `${base}.scan_query`, 'must be a non-empty string when set');
          } else if (!looksScoped(entry.scan_query)) {
            add(warnings, `${base}.scan_query`, 'has no `site:` scope — unscoped queries return SEO listicles');
          }
        }
        if (entry.groups !== undefined) {
          if (!Array.isArray(entry.groups) || entry.groups.length === 0) {
            add(errors, `${base}.groups`, 'must be a non-empty list of keyword-group names');
          } else {
            for (const g of entry.groups) {
              if (!groupNames.has(g)) {
                add(errors, `${base}.groups`, `references unknown keyword group "${g}"`);
              }
            }
          }
          if (entry.scan_query !== undefined) {
            add(warnings, `${base}.groups`, 'ignored — a literal `scan_query` overrides `groups`');
          }
        }
        if (entry.search_site !== undefined && (typeof entry.search_site !== 'string' || entry.search_site.trim() === '')) {
          add(errors, `${base}.search_site`, 'must be a non-empty domain string when set');
        }
        if (entry.first_scan_backfill !== undefined && typeof entry.first_scan_backfill !== 'boolean') {
          add(errors, `${base}.first_scan_backfill`, 'must be a boolean when set (per-entry override)');
        }

        for (const key of Object.keys(entry)) {
          if (!KNOWN_COMPANY_KEYS.has(key)) {
            add(warnings, `${base}.${key}`, 'unknown company field (typo?)');
          }
        }
      }
    }
  };

  validateEntryList(config.tracked_companies, 'tracked_companies', 'company');
  validateEntryList(config.job_boards, 'job_boards', 'job board');

  return { errors, warnings };
}

function formatIssue(issue) {
  return `${issue.path}: ${issue.message}`;
}

async function validateFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const providerIds = await loadProviderIds();
  const parsed = yaml.load(readFileSync(filePath, 'utf-8'));
  return validatePortalsConfig(parsed, { providerIds });
}

async function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-validate-portals-self-test-'));
  try {
    const file = join(tmp, 'bad.yml');
    writeFileSync(file, `
title_filter:
  positive: ["AI", ""]
tracked_companies:
  - name: "Acme"
    provider: "not-real"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');
    const result = await validateFile(file);
    if (result.errors.length !== 2) {
      throw new Error(`expected 2 errors, got ${result.errors.length}`);
    }
    console.log('validate-portals self-test OK');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    await runSelfTest();
    return;
  }

  // An explicit but empty `--file=` must reach the usage error below. Passing
  // '' to resolve() would return the CURRENT DIRECTORY, and the script would
  // then try to validate a directory and report a filesystem error instead.
  const fileFlag = hasFlag(args, '--file') ? (flagValue(args, '--file') ?? '') : undefined;
  const filePath = fileFlag === undefined ? resolve(DEFAULT_PORTALS_PATH) : (fileFlag ? resolve(fileFlag) : '');
  if (!filePath) {
    console.error('Usage: node validate-portals.mjs [--file portals.yml] [--self-test]');
    process.exit(1);
  }

  let result;
  try {
    result = await validateFile(filePath);
  } catch (err) {
    console.error(`validate-portals failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`validate-portals: ${filePath}`);
  for (const warning of result.warnings) console.log(`warning: ${formatIssue(warning)}`);
  for (const error of result.errors) console.log(`error: ${formatIssue(error)}`);
  console.log(`${result.errors.length} errors, ${result.warnings.length} warnings`);

  if (result.errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`validate-portals failed: ${err.message}`);
  process.exit(1);
});
