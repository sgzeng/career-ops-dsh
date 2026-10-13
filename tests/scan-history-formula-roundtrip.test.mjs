// tests/scan-history-formula-roundtrip.test.mjs — scan.mjs over a local-parser
// board (fork pipeline: title gate, level ceiling, content rescue, first-coverage
// backfill) writes formula-leading cells into scan-history.tsv with the reversible
// escaping from lib/tsv-formula-escape.mjs, and reads them back to dedup.
//
// Upstream made the escaping reversible (a stored `'=x` is read as `=x`). Before
// that, a role whose title or company started with = + - @ was written as `'-x`
// and read back as `'-x`, so it never matched the live `-x` and came back as new
// on every scan. The fork's own readers (roles/roles-model.mjs,
// lib/first-scan-backfill.mjs, ops/) must not reintroduce that, so this runs the
// real scanner twice: the second run serves the same roles under new URLs, which
// only company+role dedup against the history rows can recognise.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';
import { escapeFormulaCell, unescapeFormulaCell } from '../lib/tsv-formula-escape.mjs';
import { parseScanHistoryLine } from '../lib/scan-history-columns.mjs';

console.log('\nscan.mjs — formula-leading titles survive the scan-history round trip');

// 1. The helpers themselves: reversible for every shape the fixture uses.
{
  const cells = ['=SUM(A1)', '+1 Engineer', '-Staff', '@home', "'-x", "''=x", 'plain', "it's", ''];
  const bad = cells.filter((c) => unescapeFormulaCell(escapeFormulaCell(c)) !== c);
  bad.length === 0
    ? pass('escapeFormulaCell/unescapeFormulaCell round-trip every formula-leading shape')
    : fail(`not reversible: ${JSON.stringify(bad)}`);
  parseScanHistoryLine(`'=https://x\t2026-10-13\tp\t'-Title\t'@Co\tadded`).title === '-Title'
    ? pass('parseScanHistoryLine undoes the escaping on a stored row')
    : fail('parseScanHistoryLine left the stored form in place');
}

// 2. END-TO-END: two real runs, second one under new URLs.
{
  const dir = mkdtempSync(join(tmpdir(), 'scan-formula-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`);
    writeFileSync(join(dir, 'portals.yml'), `title_filter:
  positive:
    - "Security Engineer"
level_filter:
  enabled: true
  min_years: 8
  block: ["staff", "principal"]
  exempt: ["member of technical staff"]
max_posting_age_days: 45
first_scan_backfill: true
tracked_companies:
  - name: Formula Labs
    first_scan_backfill: true
    parser:
      command: node
      script: tests/fixtures/formula-board.mjs
`);
    const run = (suffix) => {
      // Only scan-history.tsv may carry the dedup decision on the second run.
      writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n');
      const r = spawnSync(NODE, [join(ROOT, 'scan.mjs'), '--since', '14', '--quiet'], {
        cwd: dir,
        // CAREER_OPS_ROOT, not cwd, anchors data/ (path-resolver.mjs): without it
        // this run would write into the real data/.
        env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: join(dir, 'portals.yml'), FORMULA_URL_SUFFIX: suffix },
        encoding: 'utf-8',
      });
      const p = join(dir, 'data', 'pipeline.md');
      const lines = existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter((l) => l.startsWith('- [ ] ')) : [];
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines };
    };

    const first = run('a');
    first.status === 0 && first.lines.length === 7
      ? pass('first run adds all 7 formula-leading and plain roles')
      : fail(`first run: exit ${first.status}, ${first.lines.length} rows, ${first.stderr.slice(0, 300)}`);

    const historyPath = join(dir, 'data', 'scan-history.tsv');
    const rows = readFileSync(historyPath, 'utf-8').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t'));
    const title = (needle) => rows.find((c) => c[3].includes(needle))?.[3];
    const stored = {
      '=': title('Alpha'), '+': title('Beta'), '-': title('Gamma'), '@': title('Delta'),
      "'": title('Epsilon'), plain: title('Zeta'),
    };
    const escaped = stored['='] === "'=Security Engineer Alpha"
      && stored['+'] === "'+Security Engineer Beta"
      && stored['-'] === "'-Security Engineer Gamma"
      && stored['@'] === "'@Security Engineer Delta"
      && stored["'"] === "''-Security Engineer Epsilon"
      && stored.plain === 'Security Engineer Zeta';
    escaped
      ? pass('history cells that start with = + - @ (or an apostrophe before one) are stored escaped; plain cells are untouched')
      : fail(`stored titles: ${JSON.stringify(stored)}`);
    const companies = rows.map((c) => c[4]);
    companies.includes("'@Formula Labs") && companies.includes("'=Cmd Corp")
      ? pass('a company name that starts with @ or = is stored escaped too')
      : fail(`stored companies: ${JSON.stringify([...new Set(companies)])}`);

    const second = run('b');
    second.status === 0 && second.lines.length === 0 && /Duplicates:\s+7 skipped/.test(second.stdout.replace(/\x1b\[[0-9;]*m/g, '') || '')
      ? pass('second run (new URLs, same roles) adds nothing: company+role dedup reads the escaped history back')
      : fail(`second run: exit ${second.status}, ${second.lines.length} new rows: ${second.lines.map((l) => l.slice(0, 90)).join(' || ')}`);
  } catch (err) {
    fail(`e2e formula round trip failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
