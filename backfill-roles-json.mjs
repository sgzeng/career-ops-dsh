#!/usr/bin/env node
/**
 * backfill-roles-json.mjs — one-shot migration of the orphaned data/roles.json
 * layer into the native career-ops tracker.
 *
 * data/roles.json was a hand-maintained snapshot that predates the native
 * pipeline layer being wired up end-to-end. Nothing reads it today. This
 * script converts each role + each `rejected_this_scan` entry into a TSV
 * under batch/tracker-additions/, in the exact 9-column-plus-url shape
 * merge-tracker.mjs expects (see AGENTS.md "TSV Format for Tracker
 * Additions"), so the standard merge path — locking, atomic write, dedup —
 * is the only thing that ever touches applications.md.
 *
 * Usage:
 *   node backfill-roles-json.mjs --dry-run     # preview, writes nothing
 *   node backfill-roles-json.mjs               # write TSVs, then run:
 *   node merge-tracker.mjs
 *
 * After merging, archive the source:
 *   mkdir -p data/archive
 *   mv data/roles.json data/archive/roles.json.$(date +%F).bak
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const ROLES_PATH = path.join(ROOT, 'data/roles.json');
const ADDITIONS_DIR = path.join(ROOT, 'batch/tracker-additions');

if (!existsSync(ROLES_PATH)) {
  console.error(`backfill-roles-json: ${ROLES_PATH} not found — nothing to migrate.`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(ROLES_PATH, 'utf-8'));
const roles = data.roles || [];
const rejected = data.rejected_this_scan || [];
const total = roles.length + rejected.length;

if (total === 0) {
  console.log('backfill-roles-json: nothing to migrate.');
  process.exit(0);
}

// Reserve a contiguous block of report numbers up front so every row gets a
// stable identity even though most have no report file (score sentinel `—`
// keeps merge-tracker's isUnscoreable() guard happy, and `report: —` is a
// recognized placeholder, not ambiguous input).
let nums;
if (DRY_RUN) {
  nums = Array.from({ length: total }, (_, i) => 900 + i); // placeholder range for preview only
} else {
  const out = execFileSync('node', ['reserve-report-num.mjs', '--count', String(total)], { cwd: ROOT }).toString().trim();
  const m = out.match(/(\d+)-(\d+)/) || out.match(/(\d+)/);
  if (!m) { console.error(`backfill-roles-json: could not parse reserve-report-num.mjs output: ${out}`); process.exit(1); }
  const start = parseInt(m[1], 10);
  nums = Array.from({ length: total }, (_, i) => start + i);
}

const tsvLines = [];
let i = 0;

for (const r of roles) {
  const num = nums[i++];
  const date = r.first_seen || data.updated || new Date().toISOString().slice(0, 10);
  const score = (Math.round((r.pct / 20) * 10) / 10).toFixed(1) + '/5';
  const status = 'Evaluated';
  const pdf = '❌';
  const report = '—';
  const noteParts = [`pct ${r.pct}`];
  if (r.team) noteParts.push(r.team);
  if (r.why) noteParts.push(r.why);
  const notes = noteParts.join(' · ').replace(/[\t\n]/g, ' ');
  const url = r.url || '';
  tsvLines.push({
    file: `${String(num).padStart(3, '0')}-${slug(r.co)}.tsv`,
    line: [num, date, r.co, r.role, status, score, pdf, report, notes, url].join('\t'),
  });
}

for (const rej of rejected) {
  const num = nums[i++];
  const date = data.updated || new Date().toISOString().slice(0, 10);
  const status = 'SKIP';
  const score = '—';
  const pdf = '❌';
  const report = '—';
  const notes = (rej.reason || '').replace(/[\t\n]/g, ' ');
  tsvLines.push({
    file: `${String(num).padStart(3, '0')}-${slug(rej.co)}.tsv`,
    line: [num, date, rej.co, rej.role, status, score, pdf, report, notes].join('\t'),
  });
}

function slug(s) {
  return String(s || 'role').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'role';
}

console.log(`backfill-roles-json: ${roles.length} roles + ${rejected.length} rejections → ${total} TSVs`);
for (const t of tsvLines) console.log(`  ${t.file}\t${t.line}`);

if (DRY_RUN) {
  console.log('\n--dry-run: nothing written. Re-run without the flag, then `node merge-tracker.mjs`.');
  process.exit(0);
}

mkdirSync(ADDITIONS_DIR, { recursive: true });
for (const t of tsvLines) {
  writeFileSync(path.join(ADDITIONS_DIR, t.file), t.line + '\n', 'utf-8');
}
console.log(`\nWrote ${tsvLines.length} TSVs to ${ADDITIONS_DIR}. Now run: node merge-tracker.mjs`);
