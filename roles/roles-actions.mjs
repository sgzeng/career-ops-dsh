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
 *   node roles/roles-actions.mjs move tracker:12 submitted
 *   node roles/roles-actions.mjs temporary-delete tracker:12
 *   node roles/roles-actions.mjs permanent-delete pipeline:https://...
 *   node roles/roles-actions.mjs blacklist-company tracker:12 "reason text"
 */

import { execFile } from 'child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import path from 'path';
import { normalizeUrlForDedup } from '../scan.mjs';
import { buildRoleModel, TAB_TARGET_STATUS } from './roles-model.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { openTrackerTransaction, rebuildRow } from '../tracker-utils.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import { setMachineSummaryScalar, setRemoteRow } from '../report-format.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
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

// ── manual cell edits from the roles web view ────────────────────────
// The roles page shows one flat row per opening, but its columns come from four
// different files. A manual edit is routed to whichever file actually owns that
// field for that row:
//   co / role      → the tracker column        (locked tracker transaction)
//   team / why     → the report Machine Summary, else the `pct N · team · why`
//                    convention in the tracker Notes cell
//   sal            → the report `advertised_comp:` scalar
//   loc / remote   → the report `| **Remote** |` row, else scan-history.tsv
//   (pipeline-only rows: co / role / loc live on the pipeline.md line itself)
// Reports and pipeline.md / scan-history.tsv have no Node-side lock (same
// best-effort rationale as the block below); the tracker edits go through the
// same locked, atomic path as set-status.mjs.
const EDITABLE_FIELDS = new Set(['co', 'role', 'team', 'why', 'sal', 'loc', 'remote']);

export async function editField(id, field, rawValue) {
  if (!EDITABLE_FIELDS.has(field)) {
    throw Object.assign(new Error(`Field "${field}" is not editable`), { code: 'BAD_FIELD' });
  }
  const value = String(rawValue ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '/').trim();
  const { rows } = buildRoleModel({ root: ROOT });
  const row = findRow(rows, id);

  if (row.trackerNum == null) return editPipelineField(row, field, value);

  if (field === 'co' || field === 'role') {
    return editTrackerColumn(row.trackerNum, field === 'co' ? 'company' : 'role', value);
  }
  if (field === 'loc' || field === 'remote') return editLocation(row, field, value);

  // team / why / sal
  const reportPath = row.reportFile ? path.join(ROOT, 'reports', row.reportFile) : null;
  if (reportPath && existsSync(reportPath)) return editReportField(reportPath, field, value, row);
  if (field === 'team' || field === 'why') return editTrackerNote(row.trackerNum, field, value, row);
  throw new Error(`"${field}" has no editable source for this row yet (no evaluation report)`);
}

async function editTrackerColumn(num, key, value) {
  const tx = await openTrackerTransaction(TRACKER);
  try {
    const lines = tx.read().split('\n');
    const colmap = resolveColumns(lines);
    if (colmap[key] == null) throw new Error(`Tracker has no ${key} column`);
    let hit = -1;
    for (let i = 0; i < lines.length; i++) {
      const r = parseTrackerRow(lines[i], colmap);
      if (r && r.num === num) { hit = i; break; }
    }
    if (hit < 0) throw new Error(`Tracker row #${num} not found`);
    const parts = lines[hit].split('|').map((s) => s.trim());
    parts[colmap[key]] = value || '—';
    lines[hit] = rebuildRow(parts);
    tx.replace(lines.join('\n'));
  } finally {
    tx.close();
  }
  return { id: `tracker:${num}`, field: key, value };
}

async function editTrackerNote(num, field, value, row) {
  const tx = await openTrackerTransaction(TRACKER);
  try {
    const lines = tx.read().split('\n');
    const colmap = resolveColumns(lines);
    let hit = -1;
    let r = null;
    for (let i = 0; i < lines.length; i++) {
      const rr = parseTrackerRow(lines[i], colmap);
      if (rr && rr.num === num) { hit = i; r = rr; break; }
    }
    if (hit < 0) throw new Error(`Tracker row #${num} not found`);
    const parts = (r.notes || '').split(' · ');
    let pctSeg;
    let team;
    let why;
    if (parts.length >= 3 && /^pct\s+\d+$/i.test(parts[0].trim())) {
      pctSeg = parts[0].trim();
      team = parts[1].trim();
      why = parts.slice(2).join(' · ').trim();
    } else if (row.pct != null) {
      pctSeg = `pct ${row.pct}`;
      team = row.team || '';
      why = row.why || '';
    } else {
      throw new Error('No report and no "pct N · team · why" note to edit — evaluate the role first');
    }
    if (field === 'team') team = value; else why = value;
    const cells = lines[hit].split('|').map((s) => s.trim());
    cells[colmap.notes] = [pctSeg, team, why].join(' · ');
    lines[hit] = rebuildRow(cells);
    tx.replace(lines.join('\n'));
  } finally {
    tx.close();
  }
  return { id: `tracker:${num}`, field, value };
}

function editReportField(file, field, value, row) {
  let text = readFileSync(file, 'utf-8');
  const before = text;
  const q = (s) => `"${String(s).replace(/"/g, "'")}"`;
  if (field === 'team') {
    text = setMachineSummaryScalar(text, 'archetype', value ? q(value) : 'null');
    text = text.replace(/^\*\*Archetype:\*\*[ \t]*.*$/m, () => `**Archetype:** ${value || '—'}`);
  } else if (field === 'sal') {
    text = setMachineSummaryScalar(text, 'advertised_comp', value ? q(value) : 'null');
  } else if (field === 'why') {
    if (!value) throw new Error('"Why it fits" cannot be blank');
    if (/^top_strengths:[ \t]*\[[ \t]*\][ \t]*$/m.test(text)) {
      text = text.replace(/^top_strengths:[ \t]*\[[ \t]*\][ \t]*$/m, () => `top_strengths:\n  - ${q(value)}`);
    } else {
      text = text.replace(/^(top_strengths:[ \t]*\n[ \t]*-[ \t]*).*$/m, (_m, pre) => pre + q(value));
    }
  }
  if (text === before) throw new Error(`Could not find the ${field} field in ${path.basename(file)}`);
  writeFileSync(file, text, 'utf-8');
  return { id: row.id, field, value };
}

function editLocation(row, field, value) {
  const file = row.reportFile ? path.join(ROOT, 'reports', row.reportFile) : null;
  if (file && existsSync(file)) {
    const text = readFileSync(file, 'utf-8');
    const m = text.match(/\|\s*\*\*Remote\*\*\s*\|\s*([^|]+?)\s*\|/);
    if (m) {
      const cur = m[1].trim();
      const next = field === 'loc'
        ? (value || '—')
        : (value === 'yes'
          ? (/remote/i.test(cur) ? cur : `Remote${cur && cur !== '—' ? ` — ${cur}` : ''}`)
          : (cur.replace(/remote(\s*[—-]\s*)?/i, '').trim() || '—'));
      const { text: patched } = setRemoteRow(text, next);
      writeFileSync(file, patched, 'utf-8');
      return { id: row.id, field, value };
    }
  }
  if (row.url && editScanHistoryLocation(row.url, field, value)) return { id: row.id, field, value };
  throw new Error(
    `No editable location source for this row (its report has no Remote row${row.url ? '' : ', and it has no URL'})`,
  );
}

function editScanHistoryLocation(url, field, value) {
  if (!existsSync(SCAN_HISTORY)) return false;
  const key = normalizeUrlForDedup(url);
  const lines = readFileSync(SCAN_HISTORY, 'utf-8').split('\n');
  let touched = false;
  const out = lines.map((line, i) => {
    if (i === 0 || !line.trim()) return line;
    const cells = line.split('\t');
    if (normalizeUrlForDedup(cells[0]) !== key) return line;
    while (cells.length < 9) cells.push('');
    const cur = cells[6] || '';
    cells[6] = field === 'loc'
      ? value
      : (value === 'yes'
        ? (/remote/i.test(cur) ? cur : `Remote${cur ? ` — ${cur}` : ''}`)
        : cur.replace(/remote(\s*[—-]\s*)?/i, '').trim());
    touched = true;
    return cells.join('\t');
  });
  if (touched) writeFileSync(SCAN_HISTORY, out.join('\n'), 'utf-8');
  return touched;
}

function editPipelineField(row, field, value) {
  if (!['co', 'role', 'loc'].includes(field)) {
    throw new Error(`"${field}" can't be edited before the role is evaluated — pipeline.md only stores company, role and location`);
  }
  if (!row.url || !existsSync(PIPELINE)) throw new Error('pipeline.md row not found for this URL');
  const key = normalizeUrlForDedup(row.url);
  const lines = readFileSync(PIPELINE, 'utf-8').split('\n');
  let touched = false;
  const out = lines.map((line) => {
    const m = line.match(/^(\s*-\s*\[\s*\]\s*)(.+)$/);
    if (!m) return line;
    const cells = m[2].split('|').map((s) => s.trim());
    if (!/^https?:\/\//.test(cells[0] || '') || normalizeUrlForDedup(cells[0]) !== key) return line;
    if (field === 'co') cells[1] = value;
    else if (field === 'role') cells[2] = value;
    else {
      let idx = -1;
      for (let i = 3; i < cells.length; i++) {
        if (/^(posted|trust|note):/i.test(cells[i])) continue;
        idx = i; break;
      }
      if (idx === -1) cells.splice(3, 0, value);
      else cells[idx] = value;
    }
    touched = true;
    return m[1] + cells.join(' | ');
  });
  if (!touched) throw new Error('Pending pipeline row not found for this URL');
  writeFileSync(PIPELINE, out.join('\n'), 'utf-8');
  return { id: row.id, field, value };
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
if (isMainModule(import.meta.url)) {
  const [cmd, id, arg, arg2] = process.argv.slice(2);
  try {
    let result;
    if (cmd === 'move') result = await move(id, arg);
    else if (cmd === 'temporary-delete') result = await temporaryDelete(id);
    else if (cmd === 'permanent-delete') result = await permanentDelete(id);
    else if (cmd === 'blacklist-company') result = blacklistCompany(id, arg);
    else if (cmd === 'edit') result = await editField(id, arg, arg2);
    else {
      console.error('Usage: node roles/roles-actions.mjs <move|temporary-delete|permanent-delete|blacklist-company|edit> <id> [arg] [value]');
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
