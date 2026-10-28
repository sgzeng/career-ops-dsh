#!/usr/bin/env node

/**
 * validate-portals.mjs — schema/shape validator for portals.yml.
 *
 * Usage:
 *   node validate-portals.mjs
 *   node validate-portals.mjs --file templates/portals.example.yml
 *   node validate-portals.mjs --self-test
 *   node validate-portals.mjs --help
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { loadYaml } from './lib/yaml-document.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { barePrefixDomainKeywords } from './title-keywords.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(ROOT, 'providers');
// providers/ ships with the checkout, but portals.yml is user data: it lives in
// the data root, where scan.mjs reads it. A bare 'portals.yml' resolved against
// the cwd instead, so `npm run validate:portals` (npm always runs it from the
// checkout) could not find an external data root's file, and a run from any
// other directory validated whatever copy sat there.
const DEFAULT_PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(getCareerOpsRoot(), 'portals.yml');

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function hasValue(value) {
  if (Array.isArray(value)) return value.some(hasValue);
  return hasText(value) || typeof value === 'number' || typeof value === 'boolean';
}

// amazon.jobs facets filter only as `key[]=`, which the provider emits for a
// YAML array (or a key already ending in `[]`); a scalar facet is ignored.
const AMAZON_FACETS = new Set([
  'normalized_country_code', 'normalized_state_name', 'normalized_city_name', 'normalized_location',
  'location', 'category', 'business_category', 'job_function_id', 'schedule_type_id',
  'employee_class', 'is_manager', 'is_intern',
]);
// Never narrow: request shaping, facet-count requests, and loc_query, which
// leaves the hit count unchanged.
const AMAZON_NON_FILTERS = new Set(['sort', 'result_limit', 'offset', 'facets', 'loc_query']);

// Providers that narrow a large board with a block named after themselves and
// silently treat a missing or unusable block as `{}`. Each predicate reports
// whether the block carries a filter the provider actually sends; without one
// the scan reads the whole board (amazon.jobs: 100k+ postings) while the entry
// reads as coverage. Hand-kept: there is no provider metadata to derive this from.
// A warning, not an error: the entry still scans, just too broadly.
const PROVIDER_BLOCK_FILTERS = {
  amazon: (block) => Object.entries(block).some(([key, value]) => {
    if (key.endsWith('[]')) return hasValue(value);
    if (AMAZON_NON_FILTERS.has(key)) return false;
    if (AMAZON_FACETS.has(key)) return Array.isArray(value) && value.some(hasValue);
    return hasValue(value);
  }),
  ibm: (block) => hasText(block.country)
    || (Array.isArray(block.categories) && block.categories.some(hasText)),
  // lang and urlPrefix only shape the request; country 'global' is the default.
  phenom: (block) => (hasText(block.country) && block.country !== 'global')
    || (isObject(block.selectedFields) && Object.values(block.selectedFields).some(hasValue)),
};

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

// buildTitleFilter reads only an array as a keyword list and drops anything else,
// so a bare string leaves the filter matching every title. validateKeywordList
// accepts one (location_filter and content_filter do wrap it), so the title
// filter's own lists are checked here. A warning, not an error: title_filter has
// always been lenient about this and a hard failure would break configs that
// currently load.
function warnBareStringKeywords(block, path, warnings) {
  for (const key of ['positive', 'negative']) {
    if (typeof block[key] === 'string') {
      add(warnings, `${path}.${key}`, `a bare string is ignored by the title filter, so this list does nothing; write it as a list: [${JSON.stringify(block[key])}]`);
    }
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
// #3438. field_filters blocks are compiled by buildTitleFilter(), which reads
// positive and negative and nothing else — seniority_boost is a title-level
// concept with no consumer here. A block containing only seniority_boost would
// otherwise validate clean and compile to an empty positive list, which reads
// as "no positive constraint" and matches every posting: the pass-all
// whitelist this validation exists to catch.
const FIELD_FILTER_FIELDS = ['positive', 'negative'];

// Top-level keys the scanner + the stage-2 agent understand. An unknown key here
// is almost always a typo (`serch_queries`) that would silently do nothing, so it
// is surfaced as a warning (not an error — a stripped-down or future config may
// legitimately carry keys this checkout does not know).
const KNOWN_TOP_LEVEL = new Set([
  'scan_history', 'location_filter', 'visa_filter', 'country_eligibility_filter',
  'max_posting_age_days', 'trust_filter', 'skip_tiers', 'title_filter',
  'title_filter_full', 'title_filter_overrides', 'title_nets', 'content_filter', 'content_rescue', 'campus_track', 'level_filter', 'salary_filter', 'search_keyword_groups',
  'search_queries', 'tracked_companies', 'job_boards',
  'interamt_searches', 'hn_hiring', 'first_scan_backfill',
  'field_filters', 'company_aliases', 'portal_health_threshold', // upstream: scan.mjs #3438 field gates, aliasing, health
  'domain_filter', // upstream: scan-ats-full.mjs board gate (#3105), validated in the domain_filter block below
  'dayforce_boards', 'portal_health_stale_days', 'portal_prune_quiet_days', // upstream: scan-dayforce.mjs / stats.mjs read these top-level keys
  'preferred_languages', // upstream: scan.mjs language versions, validated below
]);

// Per-entry keys recognised on tracked_companies[] / job_boards[].
const KNOWN_COMPANY_KEYS = new Set([
  'name', 'careers_url', 'api', 'provider', 'parser', 'domain', 'enabled',
  'max_pages', 'ibm', 'amazon', 'notes', 'verified',
  'scan_method', 'scan_query', 'groups', 'search_site', 'first_scan_backfill', 'title_net', 'search_text', 'campus_track', 'include_description',
  'company_eid', // providers/jobvite.mjs: explicit company eid (no network lookup)
  'adp', // providers/adp.mjs: { cid, ccId } for a branded careers_url with provider: adp
  'filter_on', // upstream: scan.mjs #3438, gate on a field_filters block instead of the title
]);

// A provider's own config block is keyed by its id (`phenom:`, `ultipro:`,
// `startup_jobs:`) or `<id>_<option>` (`getro_*`, `consider_*`). Upstream adds one
// with nearly every provider, so a closed list of them would warn "unknown company
// field" on every upstream sync; recognise them by the registry's provider ids.
function isProviderConfigKey(key, providerIds) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const lower = String(key).toLowerCase();
  for (const id of providerIds) {
    if (norm(key) === norm(id)) return true;
    if (lower.startsWith(`${String(id).toLowerCase().replace(/-/g, '_')}_`)) return true;
  }
  return false;
}

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
      warnBareStringKeywords(config.title_filter, 'title_filter', warnings);
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
      warnBareStringKeywords(config.title_filter_full, 'title_filter_full', warnings);
      validateKeywordList(config.title_filter_full.positive, 'title_filter_full.positive', errors);
      validateKeywordList(config.title_filter_full.negative, 'title_filter_full.negative', errors);
      validateKeywordList(config.title_filter_full.seniority_boost, 'title_filter_full.seniority_boost', errors);
    }
  }

  // Consumed only by scan-ats-full.mjs's board gate (#3105). A bare list, not
  // an object like the filters around it: the gate has one dimension. A
  // negative domain term would have to mean "this employer is NOT in my
  // industry because of one posting", which no single posting can establish,
  // and the threshold is fixed at one by measurement rather than configurable.
  //
  // Validated even though its failure direction is the safe one. A malformed
  // domain_filter leaves the gate OFF, which is exactly today's behaviour — but
  // the user is then sweeping unguarded while believing the opposite, and the
  // scanner cannot warn them, because an absent domain_filter is a legitimate
  // configuration it has to stay silent about. That silence is what makes this
  // the only place the typo can surface.
  if (config.domain_filter !== undefined) {
    if (!Array.isArray(config.domain_filter)) {
      add(errors, 'domain_filter', 'domain_filter must be a list of keywords');
    } else {
      validateKeywordList(config.domain_filter, 'domain_filter', errors);
      // A bare `word:` or `stem:` is nonblank, so the check above passes it,
      // but it compiles to a term that never matches: the gate stays on and
      // drops every complete board. Checked per AND-group term too, since
      // `solana + word:` can never match either.
      for (const idx of barePrefixDomainKeywords(config.domain_filter)) {
        add(errors, `domain_filter[${idx}]`, 'a word:/stem: prefix needs a term after it');
      }
    }
  }

  // The languages a posting is wanted in, best first. scan.mjs skips an entry
  // it cannot read, so a malformed list would quietly fall back to the default
  // version — the typo can only surface here.
  if (config.preferred_languages !== undefined) {
    const list = config.preferred_languages;
    if (!Array.isArray(list) && typeof list !== 'string') {
      add(errors, 'preferred_languages', 'preferred_languages must be a list of language codes (e.g. [en])');
    } else {
      (Array.isArray(list) ? list : [list]).forEach((entry, idx) => {
        if (typeof entry !== 'string' || !entry.trim()) {
          add(errors, `preferred_languages[${idx}]`, 'each preferred language must be a non-empty language code');
        }
      });
    }
  }

  // #3438. Per-field whitelists a target can gate on instead of title. Each
  // block has the same shape as title_filter and is compiled by the same
  // buildTitleFilter(), so it gets the same structural checks for the same
  // reason: a misspelled `positve:` leaves positive empty, and an empty
  // positive list means "no positive constraint" — the whitelist would match
  // everything while looking configured.
  if (config.field_filters !== undefined) {
    if (!isObject(config.field_filters)) {
      add(errors, 'field_filters', 'field_filters must be an object keyed by field name');
    } else {
      for (const [field, block] of Object.entries(config.field_filters)) {
        if (field === 'title') {
          // title routes to the top-level title_filter by definition. A block
          // here would be silently ignored, so say so rather than ignore it.
          add(errors, 'field_filters.title', 'field_filters.title is not read - filter_on: title uses the top-level title_filter');
          continue;
        }
        if (!isObject(block)) {
          add(errors, `field_filters.${field}`, `field_filters.${field} must be an object`);
          continue;
        }
        for (const key of Object.keys(block)) {
          if (!FIELD_FILTER_FIELDS.includes(key)) {
            add(errors, `field_filters.${field}.${key}`, `unknown field_filters field - expected one of ${FIELD_FILTER_FIELDS.join(', ')}`);
          }
        }
        // Stricter than title_filter on purpose: a bare-string list is dropped
        // by buildTitleFilter, and a block with no keyword at all matches every
        // posting. title_filter keeps that leniency for existing configs;
        // field_filters is new and has none to preserve. scan.mjs applies the
        // same rules at startup.
        let keywordCount = 0;
        let malformedList = false;
        for (const key of FIELD_FILTER_FIELDS) {
          const list = block[key];
          if (list === undefined || list === null) continue;
          if (!Array.isArray(list)) {
            add(errors, `field_filters.${field}.${key}`, 'must be a list of strings - a bare string is ignored');
            malformedList = true;
            continue;
          }
          validateKeywordList(list, `field_filters.${field}.${key}`, errors);
          keywordCount += list.length;
        }
        if (keywordCount === 0 && !malformedList) {
          add(errors, `field_filters.${field}`, 'no keyword in positive or negative - it would match every posting');
        }
      }
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
      if (config.location_filter.remote_title_fallback !== undefined && typeof config.location_filter.remote_title_fallback !== 'boolean') {
        add(errors, 'location_filter.remote_title_fallback', 'must be a boolean when set');
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
          add(errors, 'content_filter.by_title_keyword', 'by_title_keyword must be an object keyed by title_filter.positive (or title_filter_full.positive) keyword');
        } else {
          // scan-ats-full matches titles against title_filter_full when it is
          // set and scopes by_title_keyword by that match, so a key that only
          // exists there is live config for the sweep, not dead config.
          const titlePositive = new Set(
            [config.title_filter?.positive, config.title_filter_full?.positive]
              .flatMap(list => (Array.isArray(list) ? list : []))
              .filter(k => typeof k === 'string')
              .map(k => k.trim().toLowerCase())
          );
          for (const [kw, rule] of Object.entries(config.content_filter.by_title_keyword)) {
            const path = `content_filter.by_title_keyword.${kw}`;
            if (!titlePositive.has(kw.trim().toLowerCase())) {
              add(warnings, path, `"${kw}" does not match any title_filter.positive or title_filter_full.positive keyword and will never apply`);
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
      for (const key of ['min_distinct', 'min_distinct_no_thesis', 'boilerplate_df_pct', 'sentence_df_pct', 'min_company_jobs', 'min_description_chars']) {
        if (cr[key] !== undefined && !(typeof cr[key] === 'number' && Number.isFinite(cr[key]) && cr[key] >= 0)) {
          add(errors, `content_rescue.${key}`, 'must be a non-negative number when set');
        }
      }
      // lib/content-rescue.mjs treats any other value as "sentence"; a typo such
      // as "keywords" would silently switch the stripping rule.
      const mode = typeof cr.boilerplate === 'string' ? cr.boilerplate.trim().toLowerCase() : cr.boilerplate;
      if (cr.boilerplate !== undefined && mode !== 'sentence' && mode !== 'keyword') {
        add(warnings, 'content_rescue.boilerplate', `${JSON.stringify(cr.boilerplate)} is not "sentence" or "keyword" — treated as "sentence"`);
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

  // company_aliases: canonical company name -> alias (or list of aliases), read by
  // scan.mjs and merge-tracker.mjs for company identity. Both readers ignore what
  // they cannot use rather than fail, so a malformed entry looks like coverage
  // and does nothing; that is why it is named here.
  if (config.company_aliases !== undefined && config.company_aliases !== null) {
    if (!isObject(config.company_aliases)) {
      add(errors, 'company_aliases', 'must be an object of canonical company name -> alias list');
    } else {
      const canonicals = new Map();
      for (const canonical of Object.keys(config.company_aliases)) {
        if (!normalizeName(canonical)) {
          add(errors, 'company_aliases', 'canonical company name must not be empty');
        } else {
          canonicals.set(normalizeName(canonical), canonical);
        }
      }
      const claimedBy = new Map();
      for (const [canonical, value] of Object.entries(config.company_aliases)) {
        // `Fin:` and `Fin: []` are fine: they pin the canonical name's identity.
        const list = value === null || value === undefined ? [] : (Array.isArray(value) ? value : [value]);
        const path = `company_aliases.${canonical}`;
        for (const [idx, rawAlias] of list.entries()) {
          // A bare YAML number (`3000: ...` style names) reads as the string the
          // scanner compares it as.
          const alias = typeof rawAlias === 'number' ? String(rawAlias) : rawAlias;
          if (typeof alias !== 'string' || alias.trim() === '') {
            add(errors, Array.isArray(value) ? `${path}[${idx}]` : path, 'alias must be a non-empty string');
            continue;
          }
          const key = normalizeName(alias);
          if (key === normalizeName(canonical)) {
            add(warnings, path, `alias "${alias}" is the canonical name itself (no effect)`);
          } else if (canonicals.has(key)) {
            add(warnings, path, `alias "${alias}" is also a canonical name (${canonicals.get(key)}); canonical names keep their own identity, so this alias is ignored`);
          } else {
            if (!claimedBy.has(key)) claimedBy.set(key, new Set());
            claimedBy.get(key).add(canonical);
          }
        }
      }
      for (const [key, owners] of claimedBy) {
        if (owners.size > 1) {
          add(warnings, 'company_aliases', `alias "${key}" is claimed by ${[...owners].join(' and ')}; an ambiguous alias is ignored, so it merges nothing`);
        }
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
      if (fb.rerun_on_wider_window !== undefined && typeof fb.rerun_on_wider_window !== 'boolean') {
        add(errors, 'first_scan_backfill.rerun_on_wider_window', 'must be a boolean when set');
      }
    }
  }

  for (const key of Object.keys(config)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      add(warnings, key, 'unknown top-level portals.yml key (typo?)');
    }
  }

  // title_nets (scan.mjs, fork-local): net name -> extra title_filter positives,
  // applied to tracked_companies entries tagged `title_net: <name>` (checked per
  // entry below — an undefined net name would silently broaden nothing).
  const titleNets = isObject(config.title_nets) ? config.title_nets : {};
  if (config.title_nets !== undefined) {
    if (!isObject(config.title_nets)) {
      add(errors, 'title_nets', 'must be a mapping of net name -> list of title keywords');
    } else {
      for (const [name, list] of Object.entries(config.title_nets)) {
        if (!Array.isArray(list) || list.length === 0) {
          add(errors, `title_nets.${name}`, 'must be a non-empty list of title keywords');
        } else {
          validateKeywordList(list, `title_nets.${name}`, errors);
        }
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
      // Every consumer reads only a boolean `false` as "off". js-yaml follows
      // YAML 1.2, where `no`, `off` and a quoted "false" are strings, so such an
      // entry is scanned while looking disabled. Flagged here, because the
      // scanners cannot tell a typo from a deliberate non-boolean.
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
        add(errors, `${base}.enabled`, `enabled must be true or false, got ${JSON.stringify(entry.enabled)} - only a boolean false turns this ${noun} off, so it is still scanned`);
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

      const blockFilters = typeof entry.provider === 'string' && Object.hasOwn(PROVIDER_BLOCK_FILTERS, entry.provider)
        ? PROVIDER_BLOCK_FILTERS[entry.provider]
        : null;
      // An absent block is not flagged: a global sweep is a valid choice.
      if (blockFilters && entry[entry.provider] !== undefined) {
        const block = entry[entry.provider];
        if (!isObject(block) || !blockFilters(block)) {
          add(
            warnings,
            `${base}.${entry.provider}`,
            `${entry.provider} block sets no filter, so the scan reads the provider's entire board — add a location or keyword filter`
          );
        }
      }

      // #3438. Which field this target's whitelist reads. scan.mjs exits on a
      // name with no field_filters block; this catches the shape earlier and
      // checks the cross-reference here too, where the whole config is in hand.
      if (entry.filter_on !== undefined) {
        const declared = Array.isArray(entry.filter_on) ? entry.filter_on : [entry.filter_on];
        if (declared.length === 0) {
          add(errors, `${base}.filter_on`, 'filter_on must not be an empty list - omit the key to gate on title');
        }
        for (const field of declared) {
          if (typeof field !== 'string' || field.trim() === '') {
            add(errors, `${base}.filter_on`, 'filter_on must be a non-empty string or a list of them');
            continue;
          }
          const name = field.trim();
          // Own keys only: `filter_on: __proto__` must not find Object.prototype.
          const block = isObject(config.field_filters) && Object.hasOwn(config.field_filters, name)
            ? config.field_filters[name]
            : undefined;
          if (name !== 'title' && !isObject(block)) {
            add(errors, `${base}.filter_on`, `filter_on "${name}" has no field_filters.${name} block`);
          }
        }
      }

      validateParser(entry.parser, `${base}.parser`, errors);

      if (entry.title_net !== undefined && noun !== 'company') {
        add(errors, `${base}.title_net`, 'title_net applies to tracked_companies only (an aggregator board would widen the net for every employer on it)');
      } else if (entry.title_net !== undefined
        && (typeof entry.title_net !== 'string' || !Object.hasOwn(titleNets, entry.title_net))) {
        add(errors, `${base}.title_net`, `"${entry.title_net}" is not a title_nets name (defined: ${Object.keys(titleNets).join(', ') || 'none'})`);
      }

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
          if (!KNOWN_COMPANY_KEYS.has(key) && !isProviderConfigKey(key, providerIds)) {
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
  const parsed = loadYaml(readFileSync(filePath, 'utf-8'));
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

const KNOWN_FLAGS = ['--file', '--self-test', '--help', '-h'];
const VALUE_FLAGS = ['--file'];

const USAGE = `Usage:
  node validate-portals.mjs                                    # validate portals.yml in the data root
  node validate-portals.mjs --file templates/portals.example.yml  # validate a specific portals file
  node validate-portals.mjs --self-test                        # run the built-in fixture checks
  node validate-portals.mjs --help                             # print this usage block and exit`;

async function main() {
  const args = process.argv.slice(2);
  // Before any file is read: an unrecognized flag exits 1, --help/-h prints
  // USAGE and exits 0. Neither used to be checked at all (#4601) — only
  // --self-test and --file were read, so `--fiel templates/portals.example.yml`
  // validated the data root's own portals.yml and exited 0 with its counts.
  // The path on the first output line was the only hint that the file the
  // caller named was never opened.
  // requireOperand: without it, `--file --self-test` reads --self-test as the
  // file path (flagValue() returns args[idx + 1] unconditionally, with no check
  // that it is not itself another flag), and a bare trailing --file reaches
  // resolve('') — the current directory. Same shape, same fix as the sibling
  // verify-portals.mjs (#4250/#4254).
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

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
