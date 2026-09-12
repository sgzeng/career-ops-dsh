// tests/roles-model-drift.test.mjs — pins roles-model.mjs to the upstream
// contracts it silently depends on, so a rebase that changes one of them fails
// here instead of dropping rows out of the roles web view unnoticed.
//
// Three drift points:
//   1. roles-model.mjs TAB_STATUSES hard-codes the canonical state labels. A
//      new/renamed state in templates/states.yml that no tab lists makes
//      tabForStatus() return null and the row vanishes from roles.html.
//   2. buildRoleModel() reads specific fields off parseTrackerRow() — a rename
//      in tracker-parse.mjs would blank those columns.
//   3. parseReportMeta() (report-format.mjs) reads specific report-format
//      anchors — a report-template change would blank Location / Legitimacy /
//      Risk / gaps.
import { pass, fail } from './helpers.mjs';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { TAB_STATUSES, TAB_TARGET_STATUS, tabForStatus } from '../roles/roles-model.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import { parseReportMeta } from '../report-format.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ok = (name, fn) => { try { fn(); pass(name); } catch (e) { fail(`${name} — ${e.message}`); } };

// ── 1. states.yml ↔ TAB_STATUSES ────────────────────────────────────
const statesDoc = yaml.load(readFileSync(join(ROOT, 'templates/states.yml'), 'utf-8'));
const canonicalLabels = statesDoc.states.map((s) => s.label);
const allTabLabels = new Set(Object.values(TAB_STATUSES).flat());

ok('every canonical state in states.yml is shown by some roles-view tab', () => {
  const missing = canonicalLabels.filter((l) => !allTabLabels.has(l));
  assert.deepEqual(
    missing, [],
    `states.yml has label(s) no TAB_STATUSES array lists: ${missing.join(', ')} — `
    + 'add them to roles-model.mjs TAB_STATUSES or a row in that state disappears from the view',
  );
});

ok('tabForStatus() resolves every canonical state to a tab', () => {
  const orphans = canonicalLabels.filter((l) => tabForStatus(l) == null);
  assert.deepEqual(orphans, [], `tabForStatus() returns null for: ${orphans.join(', ')}`);
});

ok('every TAB_STATUSES label is a real states.yml label', () => {
  const unknown = [...allTabLabels].filter((l) => !canonicalLabels.includes(l));
  assert.deepEqual(unknown, [], `TAB_STATUSES references non-canonical label(s): ${unknown.join(', ')}`);
});

ok('every TAB_TARGET_STATUS value is a real states.yml label', () => {
  const unknown = Object.values(TAB_TARGET_STATUS).filter((l) => !canonicalLabels.includes(l));
  assert.deepEqual(unknown, [], `TAB_TARGET_STATUS references non-canonical label(s): ${unknown.join(', ')}`);
});

// ── 2. tracker-parse.mjs row schema ─────────────────────────────────
const TRACKER_FIXTURE = [
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |',
  '|---|---|---|---|---|---|---|---|---|---|',
  '| 42 | 2026-09-02 | Acme | Security Researcher | 4.3/5 | Evaluated | ❌ | [42](reports/42-acme-2026-09-02.md) | pct 86 | https://acme.example/jobs/42 |',
].join('\n');

ok('parseTrackerRow still returns the fields buildRoleModel reads', () => {
  const lines = TRACKER_FIXTURE.split('\n');
  const colmap = resolveColumns(lines);
  const row = parseTrackerRow(lines[2], colmap);
  assert.ok(row, 'row did not parse');
  for (const f of ['num', 'date', 'company', 'role', 'score', 'status', 'pdf', 'report', 'notes']) {
    assert.ok(f in row, `parseTrackerRow no longer returns "${f}"`);
  }
  assert.equal(row.num, 42);
  assert.equal(row.company, 'Acme');
  assert.equal(row.status, 'Evaluated');
  assert.ok(colmap.url != null, 'resolveColumns no longer maps a "url" column');
});

// ── 3. report-format.mjs anchors ────────────────────────────────────
const REPORT_FIXTURE = `# Evaluation: Acme — Security Researcher

**URL:** https://acme.example/jobs/42
**Archetype:** Offensive Security
**Legitimacy:** High Confidence
**Work Auth:** ⚠️ Unstated

| Field | Value |
|---|---|
| **Remote** | Remote — US |

## Machine Summary

\`\`\`yaml
pct: 86
legitimacy_tier: "High Confidence"
archetype: "Offensive Security"
final_decision: "apply"
risk_level: "low"
work_auth: "unstated"
advertised_comp: "180-220k USD"
top_strengths:
  - "Ships PoVs, not crash buckets"
hard_stops: []
soft_gaps:
  - "no formal RE cert"
\`\`\`
`;

ok('parseReportMeta extracts every field the roles view consumes', () => {
  const m = parseReportMeta(REPORT_FIXTURE);
  const checks = {
    url: 'https://acme.example/jobs/42',
    archetype: 'Offensive Security',
    legitimacy_tier: 'High Confidence',
    work_auth_display: '⚠️ Unstated',
    loc: 'Remote — US',
    remote: true,
    pct: 86,
    final_decision: 'apply',
    risk_level: 'low',
    advertised_comp: '180-220k USD',
    why: 'Ships PoVs, not crash buckets',
  };
  for (const [k, v] of Object.entries(checks)) {
    assert.deepEqual(m[k], v, `parseReportMeta.${k} = ${JSON.stringify(m[k])}, expected ${JSON.stringify(v)}`);
  }
  assert.deepEqual(m.soft_gaps, ['no formal RE cert']);
  // risk_summary is always present as a key set (values populate from top-level
  // scalars only; nested `risk_summary:` sub-keys are not read — pre-existing).
  assert.ok(m.risk_summary && typeof m.risk_summary === 'object', 'risk_summary map missing');
});
