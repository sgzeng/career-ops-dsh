#!/usr/bin/env node
/**
 * Stage-1 liveness sweep over data/pipeline.md (fork-local, ops/).
 *
 * Runs at the end of ops/daily-scan.sh, zero token. For every `- [ ]` row in
 * `## Pending` that is not a LinkedIn URL and was not already checked today:
 *   - expired (closure evidence) -> moved to `## Processed` as
 *     `- [x] ~~url | company | title~~ — posting expired (liveness sweep, stage 1 DATE)`,
 *     the same shape modes/pipeline.md's own sweep writes;
 *   - active                     -> `liveness active DATE` added to the row's
 *     `note:` segment (a new `| note:` when it has none), so the stage-2 agent
 *     skips its own sweep for that row the same day. It rides inside `note:`
 *     because the labeled-segment set is closed (scan.mjs
 *     PIPELINE_LABELED_SEGMENT_RE): an unknown `liveness:` label would be read
 *     as the location cell;
 *   - uncertain / unreadable     -> left exactly as it was.
 * LinkedIn rows are never touched (AGENTS.md LinkedIn JD loading guard).
 *
 * The checking itself is check-liveness.mjs (API first, then Playwright,
 * `--no-fallback` because launchd has no display for a headed retry). It also
 * records expired URLs in scan-history.tsv. This file only maps its verdicts
 * back onto pipeline.md, under the same lock scan.mjs uses.
 *
 * Fail-safe: a verdict line this parser cannot read leaves its row pending.
 *
 * Usage: node ops/stage1-liveness.mjs [--dry-run] [--today YYYY-MM-DD]
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LINKEDIN_RE = /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\//i;
const LIVENESS_TAG_RE = /\s*(?:—|·)?\s*liveness active \d{4}-\d{2}-\d{2}/g;
const NOTE_SEG_RE = /\| note: [^|]*$/;

/** The row with today's liveness tag in its note segment, replacing an older one. */
export function tagActive(line, today) {
  const tag = `liveness active ${today}`;
  const base = line.replace(LIVENESS_TAG_RE, '').replace(/\| note:\s*$/, '').trimEnd();
  if (NOTE_SEG_RE.test(base)) return `${base} — ${tag}`;
  return `${base} | note: ${tag}`;
}
// check-liveness.mjs prints one line per URL: `<icon> <result> [(api)] <url>`.
const VERDICT_RE = /^(?:✅|❌|⚠️)\s+(active|expired|uncertain)\s+(?:\(api\)\s+)?(\S+)\s*$/u;

/** Line range of a `## Heading` section: [start (heading line), end (exclusive)]. */
function sectionRange(lines, heading) {
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return [start, end];
}

/** Pending `- [ ]` rows: { index, url, line }. */
export function pendingRows(text) {
  const lines = String(text).split('\n');
  const range = sectionRange(lines, 'Pending');
  if (!range) return [];
  const rows = [];
  for (let i = range[0] + 1; i < range[1]; i++) {
    const m = /^- \[ \] (\S+)/.exec(lines[i]);
    if (m) rows.push({ index: i, url: m[1], line: lines[i] });
  }
  return rows;
}

/** Rows this sweep should check today. */
export function rowsToCheck(text, today) {
  return pendingRows(text).filter((r) => !LINKEDIN_RE.test(r.url)
    && !r.line.includes(`liveness active ${today}`));
}

/** Verdicts from check-liveness.mjs stdout: Map url -> 'active'|'expired'|'uncertain'. */
export function parseVerdicts(stdout) {
  const out = new Map();
  for (const raw of String(stdout).split('\n')) {
    const m = VERDICT_RE.exec(raw.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * Apply verdicts to pipeline.md text. Only rows still pending are touched.
 * @returns {{ text: string, expired: string[], active: string[] }}
 */
export function applyVerdicts(text, verdicts, today) {
  const lines = String(text).split('\n');
  const expired = [];
  const active = [];
  const moved = [];
  const drop = new Set();
  for (const row of pendingRows(text)) {
    const v = verdicts.get(row.url);
    if (v === 'active') {
      lines[row.index] = tagActive(row.line, today);
      active.push(row.url);
    } else if (v === 'expired') {
      const cells = row.line.replace(/^- \[ \] /, '').split(' | ');
      const head = cells.slice(0, 3).join(' | ');
      moved.push(`- [x] ~~${head}~~ — posting expired (liveness sweep, stage 1 ${today})`);
      drop.add(row.index);
      expired.push(row.url);
    }
  }
  let kept = lines.filter((_, i) => !drop.has(i));
  if (moved.length) {
    let range = sectionRange(kept, 'Processed');
    if (!range) {
      kept.push('', '## Processed', '');
      range = sectionRange(kept, 'Processed');
    }
    kept.splice(range[0] + 1, 0, '', ...moved);
  }
  return { text: kept.join('\n'), expired, active };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node ops/stage1-liveness.mjs [--dry-run] [--today YYYY-MM-DD]');
    return;
  }
  const dryRun = args.includes('--dry-run');
  const ti = args.indexOf('--today');
  const { localToday } = await import(path.join(REPO, 'lib/local-today.mjs'));
  const today = ti >= 0 ? args[ti + 1] : localToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today))) {
    console.error('--today expects YYYY-MM-DD');
    process.exitCode = 1;
    return;
  }
  const { PIPELINE_PATH } = await import(path.join(REPO, 'scan.mjs'));
  const { withPipelineLock } = await import(path.join(REPO, 'pipeline-lock.mjs'));

  const todo = rowsToCheck(readFileSync(PIPELINE_PATH, 'utf8'), today);
  if (todo.length === 0) {
    console.log('stage1-liveness: nothing to check (LinkedIn rows and rows already checked today are skipped)');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'stage1-liveness-'));
  let verdicts;
  try {
    const file = path.join(dir, 'urls.txt');
    writeFileSync(file, todo.map((r) => r.url).join('\n') + '\n');
    const res = spawnSync(process.execPath,
      [path.join(REPO, 'check-liveness.mjs'), '--no-fallback', '--throttle', ...(dryRun ? ['--no-record'] : []), '--file', file],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    process.stdout.write(res.stdout || '');
    process.stderr.write(res.stderr || '');
    verdicts = parseVerdicts(res.stdout || '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (verdicts.size < todo.length) {
    console.log(`WARN stage1-liveness: ${todo.length - verdicts.size} of ${todo.length} URL(s) got no readable verdict; left pending`);
  }

  const write = (text) => {
    const result = applyVerdicts(text, verdicts, today);
    if (!dryRun && (result.expired.length || result.active.length)) writeFileSync(PIPELINE_PATH, result.text);
    return result;
  };
  const result = dryRun
    ? write(readFileSync(PIPELINE_PATH, 'utf8'))
    : await withPipelineLock(PIPELINE_PATH, () => write(readFileSync(PIPELINE_PATH, 'utf8')));
  console.log(`stage1-liveness${dryRun ? ' (dry run)' : ''}: ${todo.length} checked · ${result.active.length} active · ${result.expired.length} expired → Processed · ${todo.length - result.active.length - result.expired.length} left as they were`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`stage1-liveness: ${err.message}`);
    process.exitCode = 1;
  });
}
