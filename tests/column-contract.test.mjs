// tests/column-contract.test.mjs — each roles-view column holds only its own
// field. The rejected strings below are real values that reached the dashboard
// before lib/column-contract.mjs existed (fit verdicts in Team, pay bands and
// JD quotes in Location, JD sentences in Salary, req IDs in Role).
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  teamProblem, locationProblem, providerLocationProblem, compProblem, roleProblem,
  enumProblem, RISK_LEVELS, workAuthFromHeader,
} from '../lib/column-contract.mjs';
import { setMachineSummaryScalar } from '../report-format.mjs';
import { parseAmount } from '../salary-gap.mjs';
import { buildRoleModel } from '../roles/roles-model.mjs';

console.log('\ncolumn contract — each roles-view column holds only its own field');
const ok = (name, fn) => { try { fn(); pass(name); } catch (e) { fail(`${name} — ${e.message}`); } };
const accepts = (fn, vals) => vals.forEach((v) => assert.equal(fn(v), null, `should accept ${JSON.stringify(v)}: ${fn(v)}`));
const rejects = (fn, vals) => vals.forEach((v) => assert.ok(fn(v), `should reject ${JSON.stringify(v)}`));

ok('Team: team names only, never fit verdicts', () => {
  accepts(teamProblem, [null, '', 'Security Engineering', 'Network Security', 'Horizons / Cybersecurity RL', 'Unit 42']);
  rejects(teamProblem, [
    'mismatch (compiler engineering, off keyword spine)',
    'Adjacent — Security Research Engineer (TDR/detection-engineering, not fuzzing/PoV-generation core)',
    'AI-assisted Vulnerability Research / Autonomous Offensive Security (primary)',
    'none of the six — corporate/IAM security',
  ]);
});

ok('Location: places only', () => {
  accepts(locationProblem, [null, 'San Jose, CA', 'United States', 'Remote', 'Remote (US, Canada)',
    'San Francisco, CA / New York, NY / Remote (US)', 'London, United Kingdom']);
  rejects(locationProblem, [
    'San Jose (JD states "Location: San Jose" with no remote/hybrid qualifier; LinkedIn listed it On-site)',
    'Virtual, Texas, USA - $136,000 - $184,000 USD annually',
    'Menlo Park, CA (+2 locations)',
    'San Francisco, CA — hybrid (25% in office)',
    'US — Remote',
  ]);
});

ok('Provider location strings: ATS spelling kept, junk rejected', () => {
  accepts(providerLocationProblem, ['Remote - USA', 'United States / Canada (Remote)', 'US-CA-Santa Clara']);
  rejects(providerLocationProblem, ['Apple Hardware Technologies (location unresolved)', 'Remote, $150k-$200k']);
});

ok('Salary: bare pay range only, and salary-gap.mjs parses it', () => {
  accepts(compProblem, [null, '$218,400–$480,000', '$200,000', '€80,000–€90,000', '$55.00–$70.00/hr']);
  rejects(compProblem, [
    'The base salary range for this position in the selected city is $218400 - $480000 annually.',
    'Not stated on posting',
    'US $153,000-$376,000 base + equity',
  ]);
  assert.deepEqual(parseAmount('$218,400–$480,000'), { min: 218400, max: 480000, mid: 349200 });
});

ok('Role: posted title only — req IDs and remarks rejected', () => {
  accepts(roleProblem, ['Software Engineer (AI Agent Security)', 'Security Engineer (Remote)', 'Direct outreach']);
  rejects(roleProblem, [
    'Sr. Security Researcher (Remote) — req R29549',
    'Security Research Engineer, AI Safety and Security Engineering — req JR2021887',
    'Security Engineer, Level 4 (Workday confirmation used "Systems Security Engineer, Level 4")',
    'Direct outreach — AI security research',
  ]);
});

ok('Enums reject appended commentary', () => {
  assert.equal(enumProblem('Medium', RISK_LEVELS), null);
  assert.ok(enumProblem('Medium (years gap may be a hard screen)', RISK_LEVELS));
  assert.equal(workAuthFromHeader('— Silent (no visa/sponsorship language)'), 'unstated');
  assert.equal(workAuthFromHeader('⛔ No sponsorship'), 'no_sponsorship');
});

ok('setMachineSummaryScalar writes inside the fence only', () => {
  const text = '## Machine Summary\n\n```yaml\npct: 80\n```\n\n## Job Description\n\n```text\nlocation: Austin\n```\n';
  const out = setMachineSummaryScalar(setMachineSummaryScalar(text, 'location', '"San Jose, CA"'), 'team', '"Security"');
  assert.match(out, /```yaml\nteam: "Security"\nlocation: "San Jose, CA"\npct: 80\n```/);
  assert.match(out, /```text\nlocation: Austin\n```/, 'archived JD line was rewritten');
});

const tmp = mkdtempSync(join(tmpdir(), 'co-column-contract-'));
try {
  ok('pipeline.md: a pay cell is never taken for the location', () => {
    const pipe = join(tmp, 'pipeline.md');
    writeFileSync(pipe, '## Pending\n- [ ] https://acme.example/1 | Acme | Security Researcher | $150k-$200k\n\n## Processed\n');
    const { rows } = buildRoleModel({
      root: tmp, trackerPath: join(tmp, 'none.md'), reportsDir: join(tmp, 'none'),
      pipelinePath: pipe, scanHistoryPath: join(tmp, 'none.tsv'),
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].loc, '—');
  });

  ok('Team: a report with team null never falls back to the Notes segment', () => {
    const reportsDir = join(tmp, 'rm-reports');
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, '7-acme-2026-09-25.md'), '# Evaluation: Acme — X\n\n## Machine Summary\n\n```yaml\npct: 50\nteam: null\n```\n');
    const trackerPath = join(tmp, 'rm-apps.md');
    writeFileSync(trackerPath, '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n'
      + '| 7 | 2026-09-25 | Acme | X | 2.5/5 | Evaluated | ❌ | [7](rm-reports/7-acme-2026-09-25.md) | pct 50 · report #9028 · why |\n'
      + '| 8 | 2026-09-25 | Beta | Y | 4.0/5 | Evaluated | ❌ | — | pct 80 · Safeguards · why |\n');
    const { rows } = buildRoleModel({ root: tmp, trackerPath, reportsDir, pipelinePath: join(tmp, 'none.md'), scanHistoryPath: join(tmp, 'none.tsv') });
    assert.equal(rows.find((r) => r.co === 'Acme').team, '');
    assert.equal(rows.find((r) => r.co === 'Beta').team, 'Safeguards');
    assert.ok(teamProblem('report #9028'));
  });

  ok('verify-pipeline Check 18 errors on junk and passes clean data', () => {
    const reports = join(tmp, 'reports');
    mkdirSync(reports, { recursive: true });
    const tracker = join(tmp, 'applications.md');
    const portals = join(tmp, 'portals.yml');
    writeFileSync(portals, 'tracked_companies: []\n');
    const report = (team, loc, comp) => `# Evaluation: Acme — Security Researcher\n\n**URL:** https://acme.example/1\n**Archetype:** Primary\n**Legitimacy:** High Confidence\n**Work Auth:** ⚠️ Unstated\n\n| **Remote** | ${loc} |\n\n## Machine Summary\n\n\`\`\`yaml\npct: 80\nteam: ${team}\nlocation: "${loc}"\nadvertised_comp: ${comp}\nwork_auth: "unstated"\nrisk_level: "Low"\nlegitimacy_tier: "High Confidence"\n\`\`\`\n`;
    const row = (role) => `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-09-25 | Acme | ${role} | 4.0/5 | Evaluated | ❌ | [1](reports/1-acme-2026-09-25.md) | pct 80 |\n`;
    const run = () => {
      const env = { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_REPORTS: reports, CAREER_OPS_PORTALS: portals };
      try {
        return { code: 0, out: execFileSync(NODE, [join(ROOT, 'verify-pipeline.mjs')], { cwd: ROOT, env, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 }) };
      } catch (err) { return { code: err.status, out: String(err.stdout || '') }; }
    };

    writeFileSync(join(reports, '1-acme-2026-09-25.md'), report('"mismatch (off keyword spine)"', 'San Jose, CA — $150,000', '"Not stated on posting"'));
    writeFileSync(tracker, row('Security Researcher — req JR12345'));
    const bad = run();
    assert.equal(bad.code, 1, 'junk must fail the run');
    for (const needle of ['team:', 'location:', '| **Remote** | row', 'advertised_comp:', 'Role']) {
      assert.ok(bad.out.includes(needle), `no Check 18 error for ${needle}\n${bad.out}`);
    }

    writeFileSync(join(reports, '1-acme-2026-09-25.md'), report('"Product Security"', 'San Jose, CA', '"$150,000–$200,000"'));
    writeFileSync(tracker, row('Security Researcher'));
    const good = run();
    assert.ok(good.out.includes('Every roles-view column holds only its own field'), `clean data not accepted\n${good.out}`);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
