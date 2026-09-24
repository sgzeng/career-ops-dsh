#!/usr/bin/env node
/**
 * Filter regression check for portals.yml (fork-local, ops/).
 *
 * Runs the real title_filter, level_filter, skip_tiers and location_filter from
 * portals.yml against a fixtures file using the same code scan.mjs uses
 * (title-keywords.mjs, lib/level-filter.mjs, classify-tier.mjs, scan.mjs
 * buildLocationFilter), so a config edit that silently drops a known-good role,
 * or re-admits a known-bad one, fails loudly. Called from ops/daily-scan.sh as a
 * WARN-only preflight.
 *
 * The fixtures are the user's own targeting, so they live in the gitignored
 * data/ dir (default data/filter-regression-fixtures.json). Shape:
 *   { "titles_kept": [{ "text": "...", "why": "..." }], "titles_dropped": [...],
 *     "locations_kept": [...], "locations_dropped": [...] }
 * No fixtures file → nothing to check, exit 0.
 *
 * Usage:  node ops/check-config-regression.mjs [--portals PATH] [--fixtures PATH]
 * Exit:   0 all fixtures hold (or none defined) · 1 a fixture broke · 2 bad input
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let values;
try {
  ({ values } = parseArgs({
    options: {
      portals: { type: 'string', default: process.env.CAREER_OPS_PORTALS || join(ROOT, 'portals.yml') },
      fixtures: { type: 'string', default: join(ROOT, 'data/filter-regression-fixtures.json') },
    },
  }));
} catch (err) {
  console.error(`check-config-regression: ${err.message}`);
  process.exit(2);
}

if (!existsSync(values.fixtures)) {
  console.log(`check-config-regression: no fixtures at ${values.fixtures} — nothing to check`);
  process.exit(0);
}

// scan.mjs creates data/ relative to cwd at import time; pin cwd to the repo root.
process.chdir(ROOT);
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const yaml = await import('js-yaml');
const { buildTitleFilter } = await load('title-keywords.mjs');
const { classifyTier } = await load('classify-tier.mjs');
const { buildLocationFilter } = await load('scan.mjs');
const { buildLevelFilter } = await load('lib/level-filter.mjs');

let config;
let fixtures;
try {
  config = yaml.load(readFileSync(values.portals, 'utf-8'));
  fixtures = JSON.parse(readFileSync(values.fixtures, 'utf-8'));
} catch (err) {
  console.error(`check-config-regression: ${err.message}`);
  process.exit(2);
}

const titleFilter = buildTitleFilter(config.title_filter);
const skipTiers = (Array.isArray(config.skip_tiers) ? config.skip_tiers : []).map((t) => String(t).toLowerCase());
const locationFilter = buildLocationFilter(config.location_filter);
const levelFilter = buildLevelFilter(config.level_filter);
const titleKept = (t) => titleFilter(t) && (!levelFilter || levelFilter(t)) && !skipTiers.includes(classifyTier(t));

const suites = [
  ['titles_kept', titleKept, true],
  ['titles_dropped', titleKept, false],
  ['locations_kept', (l) => locationFilter(l), true],
  ['locations_dropped', (l) => locationFilter(l), false],
];

let checked = 0;
const failures = [];
for (const [key, predicate, expected] of suites) {
  for (const item of fixtures[key] || []) {
    const text = typeof item === 'string' ? item : item.text;
    checked++;
    if (predicate(text) !== expected) {
      failures.push(`${key}: "${text}" was ${expected ? 'DROPPED' : 'KEPT'}${item.why ? ` — ${item.why}` : ''}`);
    }
  }
}

if (failures.length) {
  console.log(`❌ ${failures.length}/${checked} filter fixtures broke:`);
  for (const f of failures) console.log(`   ${f}`);
  process.exit(1);
}
console.log(`✅ ${checked}/${checked} filter fixtures hold`);
