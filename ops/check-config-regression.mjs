#!/usr/bin/env node
/**
 * Filter regression check for portals.yml (fork-local, ops/).
 *
 * Runs the real title_filter + title_nets, skip_tiers, location_filter and
 * level_filter from portals.yml against a fixtures file using the same code
 * scan.mjs uses (scan.mjs buildScanTitleFilter + buildLocationFilter,
 * classify-tier.mjs, lib/level-filter.mjs), so a config or code edit that
 * silently drops a known-good role, or re-admits a known-bad one, fails loudly.
 * Called from ops/daily-scan.sh as a WARN-only preflight.
 *
 * The fixtures are the user's own targeting, so they live in the gitignored
 * data/ dir (default data/filter-regression-fixtures.json). Shape:
 *   { "titles_kept": [{ "text": "...", "title_net": "security", "why": "..." }], "titles_dropped": [...],
 *     "locations_kept": [...], "locations_dropped": [...],
 *     "levels": [{ "title": "...", "jd": "full JD text", "expected": "drop" | "keep", "why": "..." }] }
 * A titles_* case with `title_net` is judged as at a tracked company tagged with
 * that net (scan.mjs's titleFilter(title, entry.title_net)); a name missing from
 * title_nets fails the case. Without it, the plain title_filter decides. A
 * titles_* case may also name its `company`: the case then fails unless that
 * tracked_companies entry exists and carries exactly that title_net, so dropping
 * a company's tag breaks the fixture instead of passing it silently. title_net
 * and company mean nothing for locations_* cases and fail them.
 * level_filter judges the JD, not the title, so titles_* never apply it; a
 * `levels` case runs the title AND its JD through level_filter's assess().
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
const { classifyTier } = await load('classify-tier.mjs');
const { buildLocationFilter, buildScanTitleFilter } = await load('scan.mjs');
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

// scan.mjs's title gate; with no net argument it is exactly buildTitleFilter(title_filter).
const titleFilter = buildScanTitleFilter(config);
const titleNets = config.title_nets && typeof config.title_nets === 'object' && !Array.isArray(config.title_nets)
  ? config.title_nets
  : {};
const skipTiers = (Array.isArray(config.skip_tiers) ? config.skip_tiers : []).map((t) => String(t).toLowerCase());
const locationFilter = buildLocationFilter(config.location_filter);
const levelFilter = buildLevelFilter(config.level_filter);
const titleKept = (t, net) => titleFilter(t, net) && !skipTiers.includes(classifyTier(t));

const trackedByName = new Map((Array.isArray(config.tracked_companies) ? config.tracked_companies : [])
  .filter((e) => e && typeof e === 'object' && typeof e.name === 'string')
  .map((e) => [e.name.trim().toLowerCase(), e]));
// [key, predicate, expected, takes title_net/company]
const suites = [
  ['titles_kept', titleKept, true, true],
  ['titles_dropped', titleKept, false, true],
  ['locations_kept', (l) => locationFilter(l), true, false],
  ['locations_dropped', (l) => locationFilter(l), false, false],
];

let checked = 0;
const failures = [];
for (const [key, predicate, expected, netAware] of suites) {
  for (const item of fixtures[key] || []) {
    const text = typeof item === 'string' ? item : item.text;
    const net = item.title_net;
    const company = item.company;
    const label = net === undefined ? `"${text}"` : `"${text}" [title_net: ${JSON.stringify(net)}]`;
    checked++;
    if (!netAware && (net !== undefined || company !== undefined)) {
      failures.push(`${key}: ${label} — title_net / company apply to titles_* cases only`);
      continue;
    }
    if (company !== undefined) {
      const entry = typeof company === 'string' ? trackedByName.get(company.trim().toLowerCase()) : undefined;
      if (!entry || entry.title_net !== net) {
        failures.push(`${key}: ${label} — company ${JSON.stringify(company)} ${entry ? `is tagged title_net: ${JSON.stringify(entry.title_net ?? null)}` : 'is not a tracked_companies entry'}`);
        continue;
      }
    }
    // An unknown net would silently read as "no net": a titles_dropped case
    // would still hold. Same rule as validate-portals' entry.title_net check.
    if (net !== undefined && (typeof net !== 'string' || !Object.hasOwn(titleNets, net))) {
      failures.push(`${key}: ${label} names no title_nets entry (defined: ${Object.keys(titleNets).join(', ') || 'none'})`);
      continue;
    }
    if (predicate(text, net) !== expected) {
      failures.push(`${key}: ${label} was ${expected ? 'DROPPED' : 'KEPT'}${item.why ? ` — ${item.why}` : ''}`);
    }
  }
}

for (const item of fixtures.levels || []) {
  checked++;
  if (!levelFilter) {
    failures.push(`levels: "${item.title}" — level_filter is disabled, cannot check`);
    continue;
  }
  const verdict = levelFilter.assess(item.title, item.jd);
  const got = verdict.drop ? 'drop' : 'keep';
  if (got !== item.expected) {
    failures.push(`levels: "${item.title}" was ${got.toUpperCase()}, expected ${item.expected}${verdict.reason ? ` (${verdict.reason})` : ''}${item.why ? ` — ${item.why}` : ''}`);
  }
}

if (failures.length) {
  console.log(`❌ ${failures.length}/${checked} filter fixtures broke:`);
  for (const f of failures) console.log(`   ${f}`);
  process.exit(1);
}
console.log(`✅ ${checked}/${checked} filter fixtures hold`);
