#!/usr/bin/env node
/**
 * roles-model.mjs — shared row model for the roles web view.
 *
 * Builds one array of "role rows" from every file the daily pipeline writes:
 *   - data/applications.md   (tracker; evaluated/applied/... rows)
 *   - reports/*.md           (Machine Summary YAML — full schema, not just pct)
 *   - data/pipeline.md       (## Pending — scan hits with no tracker row yet)
 *   - data/scan-history.tsv  (posted_at / portal / location join, by URL)
 *
 * Both render-roles-html.mjs (static, one-shot) and serve-roles.mjs (live
 * server) call buildRoleModel() so there is exactly one parsing path.
 *
 * Canonical status → UI tab mapping lives here too (see STATUS_TO_TAB) so the
 * renderer, the server and roles-actions.mjs agree on the same seven tabs.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import { normalizeUrlForDedup } from '../scan.mjs';
import { parseReportMeta } from '../report-format.mjs';

// ── Tab model ────────────────────────────────────────────────────────
// UI tab id → canonical states.yml labels it shows (case-sensitive, matches
// the Status cell written by set-status.mjs).
export const TAB_STATUSES = {
  new: [],                       // pipeline.md rows with no tracker entry
  evaluated: ['Evaluated'],
  submitted: ['Applied'],
  pending: ['Responded', 'Interview'],
  rejected: ['Rejected'],
  offered: ['Offer', 'Hired'],
  archived: ['Discarded'],
  deleted: ['SKIP'],
};
// Canonical state written when a UI action moves a row into a given tab.
// (pending has two source statuses; "move to Pending" always means Interview —
// Responded is a state the row can only arrive at via reply-watch, not a
// deliberate manual move.)
export const TAB_TARGET_STATUS = {
  evaluated: 'Evaluated',
  submitted: 'Applied',
  pending: 'Interview',
  rejected: 'Rejected',
  offered: 'Offer',
  archived: 'Discarded',
};

export function tabForStatus(status) {
  const s = String(status || '').trim();
  for (const [tab, statuses] of Object.entries(TAB_STATUSES)) {
    if (statuses.includes(s)) return tab;
  }
  return null;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

function clampPct(n) {
  if (n == null || !Number.isFinite(+n)) return null;
  return Math.max(0, Math.min(100, Math.round(+n)));
}

// ── reports/*.md — full Machine Summary schema ──────────────────────
// The on-disk report format (header fields + `## Machine Summary` YAML fence +
// `| **Remote** |` row) lives in report-format.mjs, shared with the write path
// in roles-actions.mjs. This is just the file read.
function parseReport(file) {
  let text;
  try { text = readFileSync(file, 'utf-8'); } catch { return {}; }
  return parseReportMeta(text);
}

function resolveReport(reportCell, reportsDir, root, fallbackNum) {
  // 1. Explicit markdown link in the Report cell — `[N](reports/N-slug-date.md)`
  //    or an already-normalized `../reports/...`.
  const linkM = String(reportCell || '').match(/\(([^)]+\.md)\)/);
  if (linkM && linkM[1]) {
    const p = path.resolve(root, linkM[1].replace(/^(?:\.\.\/)+/, ''));
    if (existsSync(p)) return p;
    const alt = path.join(reportsDir, path.basename(linkM[1]));
    if (existsSync(alt)) return alt;
  }
  // 2. Bare number in the cell, or (last resort) the row's own tracker number:
  //    report files are `reports/{num}-{slug}-{date}.md` with a 2–4 digit
  //    prefix, so a row whose Report cell is `—` still resolves as long as
  //    reports/{rowNum}-*.md exists (report num == tracker num in the common
  //    single-eval case). Handles 4-digit numbers the old `\d{2,3}` regex and
  //    padStart(3) could not (9028 → looked for `902-*.md`).
  const cellNum = (String(reportCell || '').match(/\b(\d{2,4})\b/) || [])[1];
  for (const cand of [cellNum, fallbackNum != null ? String(fallbackNum) : null]) {
    if (!cand || !existsSync(reportsDir)) continue;
    const prefixes = cand.length < 3 ? [cand, cand.padStart(3, '0')] : [cand];
    const hit = readdirSync(reportsDir).find(
      (f) => f.endsWith('.md') && !f.endsWith('-RESERVED.md')
        && prefixes.some((v) => f.startsWith(v + '-')),
    );
    if (hit) return path.join(reportsDir, hit);
  }
  return null;
}

// ── data/pipeline.md — ## Pending entries with no tracker row yet ──
// Format (formatPipelineOffer, scan.mjs): `- [ ] {url} | {company} | {title}
// [| {location} [| {compensation}]] [| posted: YYYY-MM-DD] [| trust: ...] [| note: ...]`
function parsePendingPipeline(text) {
  const rows = [];
  const lines = text.split('\n');
  let inPending = false;
  for (const line of lines) {
    if (/^##\s*(Pending|Pendientes)\s*$/.test(line.trim())) { inPending = true; continue; }
    if (/^##\s*(Processed|Procesadas)\s*$/.test(line.trim())) { inPending = false; continue; }
    if (!inPending) continue;
    const m = line.match(/^-\s*\[\s*\]\s*(.+)$/);
    if (!m) continue;
    const cells = m[1].split('|').map((s) => s.trim()).filter((s) => s !== '');
    if (!cells.length || !/^https?:\/\//.test(cells[0])) continue;
    const url = cells[0];
    const company = cells[1] || '';
    const title = cells[2] || '';
    let location = '';
    let posted = null;
    for (const c of cells.slice(3)) {
      const pm = c.match(/^posted:\s*(\d{4}-\d{2}-\d{2})/i);
      if (pm) { posted = pm[1]; continue; }
      if (/^(trust|note):/i.test(c)) continue;
      if (!location) location = c;
    }
    if (!company || !title) continue;
    rows.push({ url, company, role: title, loc: location, posted_at: posted });
  }
  return rows;
}

// ── data/scan-history.tsv — join by normalized URL ──────────────────
function loadScanHistory(text) {
  const byUrl = new Map();
  const lines = text.split('\n');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const [url, firstSeen, portal, title, company, status, location, , postedAt] = line.split('\t');
    if (!url) continue;
    const key = normalizeUrlForDedup(url);
    byUrl.set(key, { firstSeen, portal, title, company, status, location, postedAt });
  }
  return byUrl;
}

/**
 * @param {object} opts
 * @param {string} opts.root - career-ops root dir (script location).
 * @param {string} [opts.trackerPath] - defaults to data/applications.md
 * @param {string} [opts.reportsDir] - defaults to reports/
 * @param {string} [opts.pipelinePath] - defaults to data/pipeline.md
 * @param {string} [opts.scanHistoryPath] - defaults to data/scan-history.tsv
 * @returns {{rows: object[], generatedAt: string}}
 */
export function buildRoleModel(opts = {}) {
  const root = opts.root || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const TRACKER = opts.trackerPath || path.join(root, 'data/applications.md');
  const REPORTS = opts.reportsDir || path.join(root, 'reports');
  const PIPELINE = opts.pipelinePath || path.join(root, 'data/pipeline.md');
  const SCAN_HISTORY = opts.scanHistoryPath || path.join(root, 'data/scan-history.tsv');

  const scanHistory = existsSync(SCAN_HISTORY)
    ? loadScanHistory(readFileSync(SCAN_HISTORY, 'utf-8'))
    : new Map();

  const rows = [];

  // -- Tracker rows (evaluated / submitted / pending / rejected / offered / archived / deleted)
  if (existsSync(TRACKER)) {
    const text = readFileSync(TRACKER, 'utf-8');
    const lines = text.split('\n');
    const colmap = resolveColumns(lines);
    for (const line of lines) {
      const r = parseTrackerRow(line, colmap);
      if (!r) continue;
      if (!r.company || !r.role) continue;

      const tab = tabForStatus(r.status);
      if (!tab) continue; // unrecognized status — skip rather than misclassify

      const urlCellIdx = colmap.url;
      const url = urlCellIdx != null ? (line.split('|').map((s) => s.trim())[urlCellIdx] || '') : '';

      const reportPath = resolveReport(r.report, REPORTS, root, r.num);
      const meta = reportPath ? parseReport(reportPath) : {};

      const notePct = (r.notes.match(/\bpct[:\s]+(\d{1,3})\b/i) || [])[1];
      const score1to5 = parseFloat(r.score);
      const pct = clampPct(
        meta.pct ?? (notePct != null ? +notePct : null)
          ?? (Number.isFinite(score1to5) ? Math.round(score1to5 * 20) : null),
      );

      // Fallback for rows with no report yet: our own backfill (and manual
      // Notes entries) use the `pct N · team · why` convention — pull team/why
      // out of Notes rather than showing blank columns.
      let noteTeam = '';
      let noteWhy = '';
      const noteParts = r.notes.split(' · ');
      if (noteParts.length >= 3 && /^pct\s+\d+$/i.test(noteParts[0].trim())) {
        noteTeam = noteParts[1].trim();
        noteWhy = noteParts.slice(2).join(' · ').trim();
      }

      const hist = url ? scanHistory.get(normalizeUrlForDedup(url)) : null;

      rows.push({
        id: `tracker:${r.num}`,
        trackerNum: r.num,
        tab,
        status: r.status,
        co: r.company,
        team: meta.archetype || noteTeam,
        role: r.role,
        loc: meta.loc || hist?.location || '—',
        remote: meta.remote ? 1 : 0,
        sal: meta.advertised_comp || '—',
        pct,
        score: r.score,
        url: url || meta.url || null,
        via: meta.via || (r.via || null),
        why: meta.why || noteWhy,
        legitimacy_tier: meta.legitimacy_tier || null,
        work_auth: meta.work_auth_display || meta.work_auth || null,
        risk_level: meta.risk_level || null,
        confidence: meta.confidence || null,
        final_decision: meta.final_decision || null,
        hard_stops: meta.hard_stops || [],
        soft_gaps: meta.soft_gaps || [],
        discard_reasons: meta.discard_reasons || [],
        next_action: meta.next_action || null,
        reports_to: meta.reports_to || null,
        risk_summary: meta.risk_summary || null,
        notes: r.notes,
        report: r.report && r.report !== '—' ? r.report : null,
        reportFile: reportPath ? path.basename(reportPath) : null,
        pdf: r.pdf || '',
        date: r.date,
        posted_at: hist?.postedAt || null,
        source: hist?.portal || null,
        isNew: r.date === today() ? 1 : 0,
        age: r.date ? daysBetween(r.date, today()) : null,
      });
    }
  }

  // -- Pipeline-only rows: scan hits with no tracker entry yet.
  if (existsSync(PIPELINE)) {
    const pending = parsePendingPipeline(readFileSync(PIPELINE, 'utf-8'));
    // Skip any pending URL that already has a tracker row (already evaluated,
    // just not yet moved out of pipeline.md by the pipeline mode).
    const trackerUrls = new Set(rows.filter((r) => r.url).map((r) => normalizeUrlForDedup(r.url)));
    for (const p of pending) {
      const key = normalizeUrlForDedup(p.url);
      if (trackerUrls.has(key)) continue;
      const hist = scanHistory.get(key);
      rows.push({
        id: `pipeline:${key}`,
        trackerNum: null,
        tab: 'new',
        status: null,
        co: p.company,
        team: '',
        role: p.role,
        loc: p.loc || hist?.location || '—',
        remote: /remote/i.test(p.loc || '') ? 1 : 0,
        sal: '—',
        pct: null,
        score: null,
        url: p.url,
        via: null,
        why: '',
        legitimacy_tier: null,
        work_auth: null,
        risk_level: null,
        confidence: null,
        final_decision: null,
        hard_stops: [],
        soft_gaps: [],
        discard_reasons: [],
        next_action: null,
        reports_to: null,
        risk_summary: null,
        notes: '',
        report: null,
        reportFile: null,
        pdf: '',
        date: p.posted_at || hist?.firstSeen || null,
        posted_at: p.posted_at || hist?.postedAt || null,
        source: hist?.portal || null,
        isNew: (p.posted_at || hist?.firstSeen) === today() ? 1 : 0,
        age: (p.posted_at || hist?.firstSeen) ? daysBetween(p.posted_at || hist.firstSeen, today()) : null,
      });
    }
  }

  return { rows, generatedAt: today() };
}
