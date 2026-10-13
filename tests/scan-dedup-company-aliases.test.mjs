// tests/scan-dedup-company-aliases.test.mjs — stage-1 dedup knows one employer under
// several spellings, and one title under its own acronym.
//
// The 2026-10-08 scan added LinkedIn copies of roles the tracker and the scan
// history already held, because the company+role key compared spellings verbatim:
//
//   - "TrendAI" (LinkedIn) vs "TrendAI (Trend Micro)" (the watchlist label the
//     Workday rows carry) vs "Trend Micro (Zero Day Initiative)" (the tracker);
//   - "NVIDIA" vs "NVIDIA (Product Security / AI Red Team)" — 4 of the 11
//     historical LinkedIn rows that duplicated an earlier ATS row;
//   - "Research Engineer, Cybersecurity RL (Reinforcement Learning)" vs the
//     tracker's "Research Engineer, Cybersecurity RL".
//
// The unit half drives the same collectSeenCompanyRoles / matchesSeenCompanyRole
// pair main() uses. The end-to-end half runs the real scan.mjs over a fixture
// board, because the defect that mattered lived in how main() wires the alias map
// into both sides of the comparison, which no unit observes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildCompanyCanonicalizer,
  collectSeenCompanyRoles,
  companyRoleDedupKey,
  matchesSeenCompanyRole,
  normalizeRoleForDedup,
  requisitionIdsForDedup,
} from '../scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TRACKER_HEAD = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|-----|
`;
const TRACKER_ROWS = [
  '| 1 | 2026-09-02 | Anthropic | Research Engineer, Cybersecurity RL | 4.8/5 | Applied | ❌ | [9036](../reports/9036-x.md) | pct 98 | https://job-boards.greenhouse.io/anthropic/jobs/5025624008 |',
  '| 9062 | 2026-09-03 | Trend Micro (Zero Day Initiative) | Vulnerability Researcher - Global (All Levels) | 4.2/5 | Applied | ❌ | [9062](../reports/9062-x.md) | pct 83 | https://trendmicro.wd3.myworkdayjobs.com/External/job/US-Off-Site/Vulnerability-Researcher---Global--All-Levels-_R0009938 |',
  '| 9269 | 2026-09-28 | Trend Micro (Zero Day Initiative) | Vulnerability Researcher - Global (All Levels) | 3.3/5 | Discarded | ❌ | [9269](../reports/9269-x.md) | pct 65 | https://trendmicro.wd3.myworkdayjobs.com/External/job/US-Off-Site/Vulnerability-Researcher---Global--All-Levels-_R0009938 |',
  '| 9104 | 2026-09-07 | Palo Alto Networks | Principal Security Researcher | 3.0/5 | Discarded | ❌ | [9104](../reports/9104-x.md) | pct 60 | |',
].join('\n');
const HISTORY_HEAD = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation';
const WORKDAY_TREND = 'https://trendmicro.wd3.myworkdayjobs.com/External/job/US-Off-Site/Vulnerability-Researcher---Global--All-Levels-_R0009938';
const HISTORY_ROWS = [
  `${WORKDAY_TREND}\t2026-09-28\tworkday-api\tVulnerability Researcher - Global (All Levels)\tTrendAI (Trend Micro)\tadded\tUS Off-Site`,
  'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-VA-Remote/Senior-Offensive-Security-Engineer--Vulnerability-Operations_JR2026001\t2026-09-03\tworkday-api\tSenior Offensive Security Engineer, Vulnerability Operations\tNVIDIA (Product Security / AI Red Team)\tadded\t6 Locations',
  // The Greenhouse copy of the Anthropic role was only dropped for age that day. A
  // skipped_age row is observational and must seed nothing.
  'https://job-boards.greenhouse.io/anthropic/jobs/5412334008\t2026-10-08\tgreenhouse-api\tResearch Engineer, Machine Learning (Reinforcement Learning)\tAnthropic\tskipped_age\tLondon, UK',
].join('\n');

const sources = ({ history = HISTORY_ROWS } = {}) => ({
  applicationsText: TRACKER_HEAD + TRACKER_ROWS,
  scanHistoryText: `${HISTORY_HEAD}\n${history}\n`,
});

// A candidate, run through the same keys and the same decision main() makes.
function isDuplicate(canonicalize, seen, requisitions, { company, title, url }) {
  const baseKey = companyRoleDedupKey(company, title, canonicalize);
  return matchesSeenCompanyRole(
    { key: baseKey, baseKey, seen, requisitions, locatedRequisitions: new Map() },
    requisitionIdsForDedup({ url, text: title }),
  );
}

function seedWith(canonicalize, src = sources()) {
  const requisitions = new Map();
  const seen = collectSeenCompanyRoles(src, {}, canonicalize, { requisitionsByBase: requisitions });
  return { seen, requisitions };
}

// ── unit: the seen set and the decision ─────────────────────────────────────

test('the Oct 8 twins are duplicates of the tracker and history rows they copy', () => {
  const canonicalize = buildCompanyCanonicalizer({ TrendAI: ['Trend Micro'] });
  const { seen, requisitions } = seedWith(canonicalize);
  const dup = (candidate) => isDuplicate(canonicalize, seen, requisitions, candidate);

  assert.ok(dup({ company: 'TrendAI', title: 'Vulnerability Researcher - Global (All Levels)', url: 'https://www.linkedin.com/jobs/view/4438815745' }));
  assert.ok(dup({ company: 'Anthropic', title: 'Research Engineer, Cybersecurity RL (Reinforcement Learning)', url: 'https://www.linkedin.com/jobs/view/4326377987' }));
  assert.ok(dup({ company: 'NVIDIA', title: 'Senior Offensive Security Engineer, Vulnerability Operations', url: 'https://www.linkedin.com/jobs/view/4461931489' }));
});

test('without an alias the history row still catches the scanner-labelled twin, the tracker spelling alone does not', () => {
  // "TrendAI (Trend Micro)" folds to "trendai" by itself; "Trend Micro (Zero Day
  // Initiative)" is a rename only the user can declare.
  const plain = buildCompanyCanonicalizer(undefined);
  const withHistory = seedWith(plain);
  const linkedin = { company: 'TrendAI', title: 'Vulnerability Researcher - Global (All Levels)', url: 'https://www.linkedin.com/jobs/view/4438815745' };
  assert.ok(isDuplicate(plain, withHistory.seen, withHistory.requisitions, linkedin));

  const trackerOnly = seedWith(plain, sources({ history: '' }));
  assert.equal(isDuplicate(plain, trackerOnly.seen, trackerOnly.requisitions, linkedin), false);

  const aliased = buildCompanyCanonicalizer({ TrendAI: ['Trend Micro'] });
  const trackerOnlyAliased = seedWith(aliased, sources({ history: '' }));
  assert.ok(isDuplicate(aliased, trackerOnlyAliased.seen, trackerOnlyAliased.requisitions, linkedin));
});

test('different requisitions of one role stay different openings under the new keys', () => {
  const canonicalize = buildCompanyCanonicalizer({ TrendAI: ['Trend Micro'] });
  const { seen, requisitions } = seedWith(canonicalize);
  const other = 'https://trendmicro.wd3.myworkdayjobs.com/External/job/US-Off-Site/Vulnerability-Researcher---Global--All-Levels-_R0000777';
  assert.equal(
    isDuplicate(canonicalize, seen, requisitions, { company: 'TrendAI (Trend Micro)', title: 'Vulnerability Researcher - Global (All Levels)', url: other }),
    false);
  // The same requisition under the other spelling is the same opening.
  assert.ok(isDuplicate(canonicalize, seen, requisitions, { company: 'TrendAI', title: 'Vulnerability Researcher - Global (All Levels)', url: WORKDAY_TREND }));
});

test('a team qualifier or a different acronym expansion is not folded onto the bare title', () => {
  const canonicalize = buildCompanyCanonicalizer({ TrendAI: ['Trend Micro'] });
  const { seen, requisitions } = seedWith(canonicalize);
  const li = 'https://www.linkedin.com/jobs/view/4500000002';
  assert.equal(isDuplicate(canonicalize, seen, requisitions, { company: 'Palo Alto Networks', title: 'Principal Security Researcher (Decoder)', url: li }), false);
  assert.equal(isDuplicate(canonicalize, seen, requisitions, { company: 'Anthropic', title: 'Research Engineer, Machine Learning (Reinforcement Learning)', url: li }), false);
  assert.notEqual(
    normalizeRoleForDedup('Principal Security Researcher (Xpanse)'),
    normalizeRoleForDedup('Principal Security Researcher (Decoder)'));
});

test('observational history rows seed nothing, even when the spelling now folds', () => {
  const canonicalize = buildCompanyCanonicalizer(undefined);
  const { seen } = seedWith(canonicalize);
  assert.equal(seen.has(companyRoleDedupKey('Anthropic', 'Research Engineer, Machine Learning (Reinforcement Learning)', canonicalize)), false);
});

test('the default canonicalizer folds too, so a caller that passes none still agrees with itself', () => {
  const seen = collectSeenCompanyRoles(sources());
  assert.ok(seen.has(companyRoleDedupKey('TrendAI', 'Vulnerability Researcher - Global (All Levels)')));
  assert.ok(seen.has(companyRoleDedupKey('NVIDIA', 'Senior Offensive Security Engineer, Vulnerability Operations')));
});

test('the unknown-employer marker keeps agencies apart', () => {
  const canonicalize = buildCompanyCanonicalizer(undefined);
  assert.notEqual(
    companyRoleDedupKey('? (client of Q1 Tech)', 'Offensive Security Engineer', canonicalize),
    companyRoleDedupKey('? (client of J&M Group)', 'Offensive Security Engineer', canonicalize));
});

// ── end to end: the real scan.mjs over a fixture board ──────────────────────

function runScan({ portalsExtra = '', history = HISTORY_ROWS }) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-aliases-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), TRACKER_HEAD + TRACKER_ROWS + '\n');
    writeFileSync(join(dir, 'data', 'scan-history.tsv'), `${HISTORY_HEAD}\n${history}\n`);
    writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n\n## Processed\n');
    const portals = join(dir, 'portals.yml');
    writeFileSync(portals, `title_filter:
  positive:
    - "Researcher"
    - "Research Engineer"
    - "Security"
${portalsExtra}tracked_companies:
  - name: LinkedIn fixture search
    parser:
      command: node
      script: tests/fixtures/identity-twins-board.mjs
`);
    execFileSync(process.execPath, [join(ROOT, 'scan.mjs')], {
      cwd: dir,
      env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: portals },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pipeline = readFileSync(join(dir, 'data', 'pipeline.md'), 'utf-8');
    return pipeline.split('\n').filter((line) => /^- \[ \]\s+https?:\/\//.test(line))
      .map((line) => line.replace(/^- \[ \]\s+/, '').split(' | ')[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const KEPT = [
  'https://www.linkedin.com/jobs/view/4500000001',
  'https://www.linkedin.com/jobs/view/4500000002',
  'https://trendmicro.wd3.myworkdayjobs.com/External/job/US-Off-Site/Vulnerability-Researcher---Global--All-Levels-_R0000777',
  'https://www.linkedin.com/jobs/view/4500000003',
];

test('e2e: only the genuinely new roles reach the pipeline', () => {
  const added = runScan({ portalsExtra: 'company_aliases:\n  TrendAI: ["Trend Micro"]\n' });
  assert.deepEqual([...added].sort(), [...KEPT].sort());
});

test('e2e: with no company_aliases at all the history-backed twins are still dropped', () => {
  // Auto-folding is what catches TrendAI (via the Workday row's "TrendAI (Trend
  // Micro)" label), NVIDIA and the acronym title; nothing here is configured.
  const added = runScan({});
  assert.deepEqual([...added].sort(), [...KEPT].sort());
});

test('e2e: the tracker spelling alone needs the alias; declaring it closes the gap', () => {
  const linkedinTrend = 'https://www.linkedin.com/jobs/view/4438815745';
  const noHistory = HISTORY_ROWS.split('\n').filter((row) => !row.includes('TrendAI')).join('\n');
  assert.ok(runScan({ history: noHistory }).includes(linkedinTrend), 'unaliased: the rename is not guessable');
  assert.equal(
    runScan({ history: noHistory, portalsExtra: 'company_aliases:\n  TrendAI: ["Trend Micro"]\n' }).includes(linkedinTrend),
    false);
});

test('the fixture board and its sandbox helpers exist', () => {
  assert.ok(existsSync(join(ROOT, 'tests', 'fixtures', 'identity-twins-board.mjs')));
});
