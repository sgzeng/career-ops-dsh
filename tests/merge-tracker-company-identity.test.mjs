// tests/merge-tracker-company-identity.test.mjs — a re-evaluation of a tracked role
// updates its row when the company is spelled differently or the title carries
// its own acronym, instead of adding a second row.
//
// 2026-10-08, stage 2 evaluated two LinkedIn copies of roles already in the
// tracker and merge-tracker wrote both as NEW rows (#9324 and #9326), breaking
// "never create a second entry for an existing company+role":
//
//   - #9324 "Anthropic | Research Engineer, Cybersecurity RL (Reinforcement
//     Learning)" vs #1 "Research Engineer, Cybersecurity RL" (Applied). roleFuzzyMatch
//     refuses a title that adds two content words to another, so the pair never
//     matched.
//   - #9326 "TrendAI | Vulnerability Researcher - Global (All Levels)" vs #9062 /
//     #9269 "Trend Micro (Zero Day Initiative)". normalizeCompany() strips the
//     parenthetical's punctuation and keeps its words, so "trendmicro..." != "trendai".
//
// Every case drives the REAL merge-tracker.mjs CLI against a temp workspace via the
// CAREER_OPS_TRACKER / CAREER_OPS_ADDITIONS env hooks; the resulting rows are what
// proves the fix. The guards matter more than the fix: folding two openings into one
// row is unrecoverable (the tracker is gitignored, no .bak), a duplicate row is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedBatchStatePath } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MERGE = join(HERE, '..', 'merge-tracker.mjs');

const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |';
const SEP = '|---|---|---|---|---|---|---|---|---|---|';

const GH_ANTHROPIC = 'https://job-boards.greenhouse.io/anthropic/jobs/5025624008';
const LI_ANTHROPIC = 'https://www.linkedin.com/jobs/view/4326377987';
const WD_TREND = 'https://trendmicro.wd3.myworkdayjobs.com/External/job/US-Off-Site/Vulnerability-Researcher---Global--All-Levels-_R0009938';
const LI_TREND = 'https://www.linkedin.com/jobs/view/4438815745';

function makeEnv({ portals } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'merge-identity-test-'));
  mkdirSync(join(base, 'data'), { recursive: true });
  mkdirSync(join(base, 'additions'), { recursive: true });
  if (portals !== undefined) writeFileSync(join(base, 'portals.yml'), portals);
  return { base, addDir: join(base, 'additions'), tracker: join(base, 'data', 'applications.md') };
}

const row = (n, company, role, { status = 'Evaluated', score = '4.0/5', notes = 'n', url = '' } = {}) =>
  `| ${n} | 2026-09-02 | ${company} | ${role} | ${score} | ${status} | ❌ | [${n}](reports/${n}-a.md) | ${notes} | ${url} |`;

function merge({ rows, additions, portals }) {
  const env = makeEnv({ portals });
  try {
    writeFileSync(env.tracker, ['# Applications Tracker', '', HEADER, SEP, ...rows, ''].join('\n'));
    // The report files the rows link to, so the merge has no dead link to warn about.
    mkdirSync(join(env.base, 'reports'), { recursive: true });
    const touchReport = (n, suffix) => writeFileSync(join(env.base, 'reports', `${n}-${suffix}.md`), '# report\n');
    for (const r of rows) touchReport(r.split('|')[1].trim(), 'a');
    additions.forEach((a, i) => {
      const n = a.num ?? 9400 + i;
      touchReport(n, 'b');
      writeFileSync(join(env.addDir, `${n}-add.tsv`), [
        'num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl',
        [n, '2026-10-09', a.company, a.role, 'Evaluated', a.score ?? '3.9/5', '❌', `[${n}](reports/${n}-b.md)`, a.notes ?? 'n', a.url ?? ''].join('\t'),
      ].join('\n'));
    });
    const run = spawnSync(process.execPath, [MERGE], {
      encoding: 'utf-8',
      env: { ...process.env, CAREER_OPS_TRACKER: env.tracker, CAREER_OPS_ADDITIONS: env.addDir, CAREER_OPS_BATCH_STATE: isolatedBatchStatePath(env.addDir) },
    });
    assert.equal(run.status, 0, `merge-tracker exited ${run.status}: ${run.stderr}`);
    const rowsAfter = readFileSync(env.tracker, 'utf-8').split('\n')
      .filter((l) => l.startsWith('|') && !/^\|[\s|:-]+\|\s*$/.test(l) && !/^\|\s*#\s*\|/.test(l));
    return { rows: rowsAfter, out: run.stdout, err: run.stderr };
  } finally {
    rmSync(env.base, { recursive: true, force: true });
  }
}

// ── the two Oct 8 failures ──────────────────────────────────────────────────

test('THE BUG (#9324): a LinkedIn copy whose title spells out the acronym updates the tracked row', () => {
  const { rows, out } = merge({
    rows: [row(1, 'Anthropic', 'Research Engineer, Cybersecurity RL', { status: 'Applied', score: '4.8/5', url: GH_ANTHROPIC })],
    additions: [{ company: 'Anthropic', role: 'Research Engineer, Cybersecurity RL (Reinforcement Learning)', url: LI_ANTHROPIC }],
  });
  assert.equal(rows.length, 1, `expected the row to be UPDATED, got:\n${rows.join('\n')}`);
  assert.match(out, /Update: #1 Anthropic/);
  // The row keeps its title and its status; only a confirmed same-posting match may rename it.
  assert.match(rows[0], /\| Research Engineer, Cybersecurity RL \|/);
  assert.match(rows[0], /\| Applied \|/);
});

test('THE BUG (#9326): the tracker spelling and the scanner spelling are one employer once the rename is declared', () => {
  const portals = 'company_aliases:\n  TrendAI: ["Trend Micro"]\n';
  const { rows, out } = merge({
    portals,
    rows: [
      row(9062, 'Trend Micro (Zero Day Initiative)', 'Vulnerability Researcher - Global (All Levels)', { status: 'Applied', score: '4.2/5', url: WD_TREND }),
      row(9269, 'Trend Micro (Zero Day Initiative)', 'Vulnerability Researcher - Global (All Levels)', { status: 'Discarded', score: '3.3/5' }),
    ],
    additions: [{ company: 'TrendAI', role: 'Vulnerability Researcher - Global (All Levels)', url: LI_TREND }],
  });
  assert.equal(rows.length, 2, `expected an update, got ${rows.length} rows:\n${rows.join('\n')}`);
  assert.match(out, /Update: #9062 TrendAI/);
  // The row keeps the spelling it was filed under: company-history, the blacklist and
  // the follow-ups all join on it.
  assert.ok(rows.some((r) => /^\| 9062 \|.*\| Trend Micro \(Zero Day Initiative\) \|/.test(r)), rows.join('\n'));
  assert.ok(!rows.some((r) => /\| TrendAI \|/.test(r)), 'no row was renamed or added under the new spelling');
});

test('without the alias the tracker-only spelling is still a different employer (the rename cannot be guessed)', () => {
  const { rows } = merge({
    rows: [row(9062, 'Trend Micro (Zero Day Initiative)', 'Vulnerability Researcher - Global (All Levels)', { status: 'Applied', url: WD_TREND })],
    additions: [{ company: 'TrendAI', role: 'Vulnerability Researcher - Global (All Levels)', url: LI_TREND }],
  });
  assert.equal(rows.length, 2);
});

test('a trailing qualifier alone needs no alias: "TrendAI (Trend Micro)" is "TrendAI"', () => {
  const { rows, out } = merge({
    rows: [row(9100, 'TrendAI (Trend Micro)', 'Senior Threat Researcher, FTR', { url: 'https://trendmicro.wd3.myworkdayjobs.com/External/job/US-Off-Site/Senior-Threat-Researcher--FTR_R0010038' })],
    additions: [{ company: 'TrendAI', role: 'Senior Threat Researcher, FTR', url: 'https://www.linkedin.com/jobs/view/4447701052' }],
  });
  assert.equal(rows.length, 1, rows.join('\n'));
  assert.match(out, /Update: #9100/);
});

// ── the guards: these must stay two rows ────────────────────────────────────

test('GUARD: a team qualifier is not an acronym expansion (Palo Alto Networks keeps its siblings apart)', () => {
  const { rows } = merge({
    rows: [row(9104, 'Palo Alto Networks', 'Principal Security Researcher', { status: 'Applied' })],
    additions: [{ company: 'Palo Alto Networks (Unit 42 / AI Research)', role: 'Principal Security Researcher (AI-Assisted Vulnerability Research)' }],
  });
  assert.equal(rows.length, 2, 'a different requisition of the same family must stay its own row');
});

test('GUARD: "(Reinforcement Learning)" under "Machine Learning" is a team, not the expansion of RL', () => {
  const { rows } = merge({
    rows: [row(1, 'Anthropic', 'Research Engineer, Machine Learning', { url: 'https://job-boards.greenhouse.io/anthropic/jobs/111' })],
    additions: [{ company: 'Anthropic', role: 'Research Engineer, Machine Learning (Reinforcement Learning)', url: 'https://job-boards.greenhouse.io/anthropic/jobs/222' }],
  });
  assert.equal(rows.length, 2);
});

test('GUARD: two different requisition ids stay two postings across a company alias', () => {
  const portals = 'company_aliases:\n  TrendAI: ["Trend Micro"]\n';
  const { rows } = merge({
    portals,
    rows: [row(9062, 'Trend Micro (Zero Day Initiative)', 'Vulnerability Researcher', { notes: 'req JR-10423' })],
    additions: [{ company: 'TrendAI', role: 'Vulnerability Researcher', notes: 'req JR-99999' }],
  });
  assert.equal(rows.length, 2, 'a req-number mismatch proves two openings (#1524)');
});

test('GUARD: two different employer-board URLs stay two postings across a company alias', () => {
  const portals = 'company_aliases:\n  TrendAI: ["Trend Micro"]\n';
  const { rows } = merge({
    portals,
    rows: [row(9062, 'Trend Micro (Zero Day Initiative)', 'Vulnerability Researcher', { url: 'https://job-boards.greenhouse.io/trend/jobs/1' })],
    additions: [{ company: 'TrendAI', role: 'Vulnerability Researcher', url: 'https://job-boards.greenhouse.io/trend/jobs/2' }],
  });
  assert.equal(rows.length, 2);
});

test('GUARD: two different LinkedIn posting ids stay two postings', () => {
  const { rows } = merge({
    rows: [row(9100, 'TrendAI (Trend Micro)', 'Senior Threat Researcher, FTR', { url: 'https://www.linkedin.com/jobs/view/4001' })],
    additions: [{ company: 'TrendAI', role: 'Senior Threat Researcher, FTR', url: 'https://www.linkedin.com/jobs/view/4002' }],
  });
  assert.equal(rows.length, 2);
});

test('GUARD: a different employer is not pulled in by a shared first word or qualifier', () => {
  const portals = 'company_aliases:\n  TrendAI: ["Trend Micro"]\n';
  const { rows } = merge({
    portals,
    rows: [row(9062, 'Trend Micro (Zero Day Initiative)', 'Vulnerability Researcher')],
    additions: [
      { company: 'Trend Finance (Zero Day Initiative)', role: 'Vulnerability Researcher' },
      { company: 'Acme Labs', role: 'Vulnerability Researcher' },
    ],
  });
  assert.equal(rows.length, 3);
});

test('GUARD: blind-employer rows from different agencies never merge', () => {
  const { rows } = merge({
    rows: [row(9200, '? (client of Q1 Tech)', 'Offensive Security Engineer')],
    additions: [{ company: '? (client of J&M Group)', role: 'Offensive Security Engineer' }],
  });
  assert.equal(rows.length, 2);
});

test('GUARD: an alias written with its qualifier keeps two namesakes apart', () => {
  const portals = 'company_aliases:\n  Cobalt Robotics: ["Cobalt (robotics)"]\n';
  const { rows } = merge({
    portals,
    rows: [row(9300, 'Cobalt (security)', 'Security Engineer', { url: '' })],
    additions: [{ company: 'Cobalt (robotics)', role: 'Security Engineer' }],
  });
  assert.equal(rows.length, 2);
});

test('GUARD: the report-number tier does not accept the wider company match', () => {
  // Same report number, but the companies only agree under the alias: that is
  // report-sequence drift between two employers, not a re-evaluation (#912).
  const portals = 'company_aliases:\n  TrendAI: ["Trend Micro"]\n';
  const { rows } = merge({
    portals,
    rows: [row(5, 'Trend Micro', 'Completely Different Title')],
    additions: [{ num: 5, company: 'TrendAI', role: 'Another Unrelated Opening Entirely' }],
  });
  assert.equal(rows.length, 2);
});

// ── configuration failures never stop a merge ───────────────────────────────

test('an unparseable portals.yml merges without aliases and says so', () => {
  const { rows, out, err } = merge({
    portals: 'company_aliases: [unclosed\n  - : :\n',
    rows: [row(9062, 'Trend Micro (Zero Day Initiative)', 'Vulnerability Researcher')],
    additions: [{ company: 'TrendAI', role: 'Vulnerability Researcher' }],
  });
  assert.equal(rows.length, 2);
  assert.match(out, /Add #/);
  assert.match(err, /cannot read company_aliases/);
});

test('a portals.yml without company_aliases, or with a malformed one, changes nothing', () => {
  for (const portals of ['title_filter:\n  positive: ["x"]\n', 'company_aliases: [a, b]\n', 'company_aliases: 7\n', '']) {
    const { rows } = merge({
      portals,
      rows: [row(9062, 'Trend Micro (Zero Day Initiative)', 'Vulnerability Researcher')],
      additions: [{ company: 'TrendAI', role: 'Vulnerability Researcher' }],
    });
    assert.equal(rows.length, 2, JSON.stringify(portals));
  }
});
