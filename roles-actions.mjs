#!/usr/bin/env node
/**
 * roles-actions.mjs — write layer for the roles web view.
 *
 * Every mutation goes through career-ops' existing write gates
 * (set-status.mjs, tracker.mjs) rather than touching applications.md by
 * hand — same discipline the experimental web/ UI uses (see
 * web/src/app/api/status/route.ts, web/src/app/api/tracker/delete/route.ts).
 *
 * Usable both from serve-roles.mjs and directly from the CLI:
 *   node roles-actions.mjs move tracker:12 submitted
 *   node roles-actions.mjs temporary-delete tracker:12
 *   node roles-actions.mjs permanent-delete pipeline:https://...
 *   node roles-actions.mjs blacklist-company tracker:12 "reason text"
 */

import { execFile } from 'child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import path from 'path';
import { normalizeUrlForDedup } from './scan.mjs';
import { buildRoleModel, TAB_TARGET_STATUS } from './roles-model.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const TRACKER = path.join(ROOT, 'data/applications.md');
const PIPELINE = path.join(ROOT, 'data/pipeline.md');
const SCAN_HISTORY = path.join(ROOT, 'data/scan-history.tsv');
const BLACKLIST = path.join(ROOT, 'data/blacklist.md');
const BLACKLIST_TEMPLATE = path.join(ROOT, 'templates/blacklist.example.md');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile('node', [cmd, ...args], { cwd: ROOT, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(stderr?.trim() || err.message);
        e.code = err.code;
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function findRow(rows, id) {
  const row = rows.find((r) => r.id === id);
  if (!row) {
    const e = new Error(`No row with id "${id}"`);
    e.code = 'NOT_FOUND';
    throw e;
  }
  return row;
}

/** Materialize a tracker row for a pipeline-only entry (no report yet). */
async function materializeFromPipeline(row) {
  const reserveOut = (await run('reserve-report-num.mjs', ['--count', '1'])).stdout.trim();
  const m = reserveOut.match(/(\d+)/);
  if (!m) throw new Error(`reserve-report-num.mjs: could not parse "${reserveOut}"`);
  const num = parseInt(m[1], 10);
  const date = new Date().toISOString().slice(0, 10);
  const line = [num, date, row.co, row.role, 'Evaluated', '—', '❌', '—', 'Added from New openings (roles web)', row.url].join('\t');
  const additionsDir = path.join(ROOT, 'batch/tracker-additions');
  const file = path.join(additionsDir, `${String(num).padStart(3, '0')}-web-materialize.tsv`);
  writeFileSync(file, line + '\n', 'utf-8');
  await run('merge-tracker.mjs', []);
  return num;
}

/** Move a role to a new status (UI tab). */
export async function move(id, tab) {
  const targetStatus = TAB_TARGET_STATUS[tab];
  if (!targetStatus) throw Object.assign(new Error(`Unknown target tab "${tab}"`), { code: 'BAD_TAB' });

  const { rows } = buildRoleModel({ root: ROOT });
  const row = findRow(rows, id);
  if (row.tab === tab) throw Object.assign(new Error(`Row is already in "${tab}"`), { code: 'NOOP' });

  let num = row.trackerNum;
  if (num == null) num = await materializeFromPipeline(row);

  const { stdout } = await run('set-status.mjs', ['--row', String(num), targetStatus, '--source', 'web', '--json']);
  return JSON.parse(stdout);
}

/** Remove the row from applications.md + pipeline.md, but let the scanner
 *  re-surface it after a 30-day cooldown (data/scan-history.tsv). */
export async function temporaryDelete(id) {
  const { rows } = buildRoleModel({ root: ROOT });
  const row = findRow(rows, id);

  if (row.trackerNum != null) {
    await run('tracker.mjs', ['delete', '--num', String(row.trackerNum)]);
  }
  removeFromPipeline(row.url);
  if (row.url) cooldownScanHistory(row.url, row.co, 30);
  return { id, action: 'temporary-delete', url: row.url };
}

/** Remove the row and mark it SKIP so the scanner never re-adds that URL
 *  (collectSeenUrls treats every URL in applications.md as permanently seen). */
export async function permanentDelete(id) {
  const { rows } = buildRoleModel({ root: ROOT });
  const row = findRow(rows, id);

  let num = row.trackerNum;
  if (num == null) num = await materializeFromPipeline(row);

  await run('set-status.mjs', ['--row', String(num), 'SKIP', '--source', 'web', '--note', `permanent delete ${new Date().toISOString().slice(0, 10)}`]);
  removeFromPipeline(row.url);
  return { id, action: 'permanent-delete', trackerNum: num };
}

/** Add the company to data/blacklist.md so scan.mjs / scan-ats-full.mjs skip
 *  every future posting from it. Discovery-time only — does not retroactively
 *  touch rows already in the tracker. */
export function blacklistCompany(id, reason, rowsOverride) {
  const rows = rowsOverride || buildRoleModel({ root: ROOT }).rows;
  const row = findRow(rows, id);
  const since = new Date().toISOString().slice(0, 10);

  let content;
  if (existsSync(BLACKLIST)) {
    content = readFileSync(BLACKLIST, 'utf-8');
  } else {
    content = readFileSync(BLACKLIST_TEMPLATE, 'utf-8');
    // Strip the two example rows the template ships with.
    content = content.replace(/\| Acme Corp \|.*\n/, '').replace(/\| Globex \|.*\n/, '');
  }
  const cleanReason = String(reason || 'blacklisted from roles web').replace(/[\r\n|]+/g, ' ').trim();
  const newRow = `| ${row.co} | ${since} | company | ${cleanReason} |\n`;
  if (!content.endsWith('\n')) content += '\n';
  writeFileSync(BLACKLIST, content + newRow, 'utf-8');
  return { id, action: 'blacklist-company', company: row.co };
}

// ── pipeline.md / scan-history.tsv edits (no shared lock exists for these
// two files from Node today; scan.mjs's withPipelineLock is scan.mjs-internal
// and not exported, so these are best-effort direct edits — acceptable because
// the daily scan runs once/day via launchd, not concurrently with browsing). ──

function removeFromPipeline(url) {
  if (!url || !existsSync(PIPELINE)) return;
  const key = normalizeUrlForDedup(url);
  const lines = readFileSync(PIPELINE, 'utf-8').split('\n');
  const kept = lines.filter((line) => {
    if (!/^-\s*\[[ x]\]/.test(line.trim())) return true;
    const m = line.match(/https?:\/\/\S+/);
    if (!m) return true;
    return normalizeUrlForDedup(m[0].replace(/[|,)]+$/, '')) !== key;
  });
  writeFileSync(PIPELINE, kept.join('\n'), 'utf-8');
}

function cooldownScanHistory(url, company, days) {
  if (!existsSync(SCAN_HISTORY)) return;
  const key = normalizeUrlForDedup(url);
  const until = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const lines = readFileSync(SCAN_HISTORY, 'utf-8').split('\n');
  let touched = false;
  const out = lines.map((line, i) => {
    if (i === 0 || !line.trim()) return line;
    const cells = line.split('\t');
    if (normalizeUrlForDedup(cells[0]) !== key) return line;
    cells[5] = `cooldown:${company}:${until}`;
    touched = true;
    return cells.join('\t');
  });
  if (touched) writeFileSync(SCAN_HISTORY, out.join('\n'), 'utf-8');
}

// ── CLI entry ────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, id, arg] = process.argv.slice(2);
  try {
    let result;
    if (cmd === 'move') result = await move(id, arg);
    else if (cmd === 'temporary-delete') result = await temporaryDelete(id);
    else if (cmd === 'permanent-delete') result = await permanentDelete(id);
    else if (cmd === 'blacklist-company') result = blacklistCompany(id, arg);
    else {
      console.error('Usage: node roles-actions.mjs <move|temporary-delete|permanent-delete|blacklist-company> <id> [arg]');
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
