// tests/roles-report-links.test.mjs — the report → tracker → roles-view link path.
//
// Regression cover for the bug where the tracker Report column was `—` on every
// row (the interactive pipeline path wrote `report #NNNN` into Notes instead of
// `[NNNN](reports/…)` into column 8), so roles-model.mjs never loaded any
// report's `## Machine Summary` and Location / Legitimacy / Work auth / Risk /
// gaps rendered blank. Three fixes are asserted here:
//   1. roles-model.mjs resolves reports/{rowNum}-*.md by the row's own number
//      even when the Report cell is `—` (self-healing fallback).
//   2. merge-tracker.mjs --backfill-reports links link-less rows from disk.
//   3. render-roles-html.mjs renders the Report cell as a clickable <a>.
import { pass, fail } from './helpers.mjs';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRoleModel } from '../roles-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MERGE = join(ROOT, 'merge-tracker.mjs');
const RENDER = join(ROOT, 'render-roles-html.mjs');
const NODE = process.execPath;
const ok = (name, fn) => { try { fn(); pass(name); } catch (e) { fail(`${name} — ${e.message}`); } };

const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |';
const SEP = '|---|---|---|---|---|---|---|---|---|---|';

const REPORT = (num, company, role) => `# Evaluation: ${company} — ${role}

**Date:** 2026-09-02
**URL:** https://example.com/jobs/${num}
**Legitimacy:** High Confidence
**Work Auth:** ⚠️ Unstated

## Machine Summary

\`\`\`yaml
company: "${company}"
role: "${role}"
score: 4.3
pct: 85
legitimacy_tier: "High Confidence"
archetype: "Test Archetype"
work_auth: "unstated"
risk_level: "Low"
advertised_comp: "180-220k USD"
hard_stops: []
soft_gaps:
  - "needs production infra experience"
top_strengths:
  - "PBFuzz maps directly to the ask"
\`\`\`

## A) Role Summary
Body.
`;

function makeEnv() {
  const base = mkdtempSync(join(tmpdir(), 'roles-links-'));
  const dataDir = join(base, 'data');
  const addDir = join(base, 'additions');
  const reportsDir = join(base, 'reports');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(addDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  const tracker = join(dataDir, 'applications.md');
  const pipeline = join(dataDir, 'pipeline.md');
  const scanHistory = join(dataDir, 'scan-history.tsv');
  writeFileSync(pipeline, '# Pipeline\n\n## Pending\n\n## Processed\n');
  writeFileSync(scanHistory, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\n');
  return { base, dataDir, addDir, reportsDir, tracker, pipeline, scanHistory };
}
const cleanup = (env) => rmSync(env.base, { recursive: true, force: true });
const writeTracker = (env, rows) =>
  writeFileSync(env.tracker, ['# Applications Tracker', '', HEADER, SEP, ...rows, ''].join('\n'));

// ── 1. roles-model.mjs self-healing fallback ───────────────────────────────
console.log('\nroles-model — reports/{rowNum}-*.md fallback when Report cell is —');
ok('a `—` Report cell still loads Machine Summary via the row number', () => {
  const env = makeEnv();
  try {
    writeFileSync(join(env.reportsDir, '9028-acme-sec-eng-2026-09-02.md'), REPORT(9028, 'Acme', 'Security Engineer'));
    writeTracker(env, [
      `| 9028 | 2026-09-02 | Acme | Security Engineer | 4.3/5 | Evaluated | ❌ | — | pct 85 · report #9028 · strong fit | https://example.com/jobs/9028 |`,
    ]);
    const { rows } = buildRoleModel({
      root: env.base, trackerPath: env.tracker, reportsDir: env.reportsDir,
      pipelinePath: env.pipeline, scanHistoryPath: env.scanHistory,
    });
    const r = rows.find((x) => x.co === 'Acme');
    assert.ok(r, 'row present');
    assert.equal(r.legitimacy_tier, 'High Confidence', 'legitimacy from report');
    assert.equal(r.sal, '180-220k USD', 'advertised_comp from report');
    assert.equal(r.risk_level, 'Low', 'risk from report');
    assert.deepEqual(r.soft_gaps, ['needs production infra experience'], 'soft_gaps from report');
    assert.equal(r.reportFile, '9028-acme-sec-eng-2026-09-02.md', 'reportFile basename emitted');
  } finally { cleanup(env); }
});

// ── 2. merge-tracker.mjs --backfill-reports ────────────────────────────────
console.log('\nmerge-tracker --backfill-reports');
ok('dry-run reports the link-less-with-report rows; real run writes the link', () => {
  const env = makeEnv();
  try {
    writeFileSync(join(env.reportsDir, '9030-acme-vuln-researcher-2026-09-02.md'), REPORT(9030, 'Acme', 'Vuln Researcher'));
    writeTracker(env, [
      `| 9030 | 2026-09-02 | Acme | Vuln Researcher | 4.0/5 | Evaluated | ❌ | — | pct 80 · report #9030 · fit | https://example.com/jobs/9030 |`,
      `| 9031 | 2026-09-02 | Beta | Corp Sec | 1.0/5 | Evaluated | ❌ | — | pct 20 · no report on disk | https://example.com/jobs/9031 |`,
    ]);
    const envv = { ...process.env, CAREER_OPS_TRACKER: env.tracker, CAREER_OPS_ADDITIONS: env.addDir };
    const dry = execFileSync(NODE, [MERGE, '--backfill-reports', '--dry-run'], { env: envv, encoding: 'utf-8' });
    assert.match(dry, /would link 1 row/i, `dry-run output: ${dry}`);
    assert.match(readFileSync(env.tracker, 'utf-8'), /\| — \|.*jobs\/9030/, 'dry-run leaves the file unchanged');

    execFileSync(NODE, [MERGE, '--backfill-reports'], { env: envv, encoding: 'utf-8' });
    const after = readFileSync(env.tracker, 'utf-8');
    assert.match(after, /\[9030\]\((?:\.\.\/)?reports\/9030-acme-vuln-researcher-2026-09-02\.md\)/, 'row 9030 linked');
    assert.match(after, /9031 \| 2026-09-02 \| Beta \| Corp Sec \| 1\.0\/5 \| Evaluated \| ❌ \| — \|/, 'row 9031 left as — (no file)');
  } finally { cleanup(env); }
});

// ── 3. render-roles-html.mjs clickable Report cell ─────────────────────────
console.log('\nrender-roles-html — Report cell renders a clickable <a>');
ok('the `report` cell renderer emits an <a> whose href branches on IS_LIVE', () => {
  const src = readFileSync(RENDER, 'utf-8');
  const m = src.match(/case 'report':\s*\{([\s\S]*?)\n {4}\}/);
  assert.ok(m, 'case \'report\' block present');
  const block = m[1];
  assert.match(block, /r\.reportFile/, 'keys off r.reportFile');
  assert.match(block, /<a class="apply-link"[^>]*href="/, 'renders an anchor');
  assert.match(block, /IS_LIVE \? '\/reports\/' : 'career-ops\/reports\/'/, 'href branches on IS_LIVE');
  assert.match(block, /target="_blank" rel="noopener"/, 'opens in a new tab safely');
});
ok('serve-roles.mjs exposes a guarded GET /reports/ route', () => {
  const src = readFileSync(join(ROOT, 'serve-roles.mjs'), 'utf-8');
  assert.match(src, /url\.pathname\.startsWith\('\/reports\/'\)/, 'route present');
  assert.match(src, /name\.includes\('\.\.'\)/, 'rejects ".." traversal');
  assert.match(src, /\[A-Za-z0-9\._-\]\+\\\.md\$/, 'restricts to a bare .md filename');
});
