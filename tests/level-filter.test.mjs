// tests/level-filter.test.mjs — lib/level-filter.mjs and its scan.mjs hook.
//
// A level cap can't be a title_filter negative: "Staff" must go, yet "Member of
// Technical Staff" is a flat title and "Senior/Staff" keeps its Senior half.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { buildLevelFilter } from '../lib/level-filter.mjs';

console.log('\nscan.mjs — level filter');

const CFG = {
  enabled: true,
  block: ['staff', 'principal', 'distinguished'],
  exempt: ['member of technical staff', 'technical staff', 'senior/staff', 'senior / principal'],
};

// 1. Off unless enabled with something to block
{
  if (buildLevelFilter(undefined) === null && buildLevelFilter({ enabled: false, block: ['staff'] }) === null
      && buildLevelFilter({ enabled: true, block: [] }) === null) {
    pass('absent, disabled, or empty block list → null');
  } else {
    fail('level filter must be off unless enabled with block words');
  }
}

// 2. Verdicts
{
  const keep = buildLevelFilter(CFG);
  const cases = [
    ['Staff Security Engineer', false],
    ['Security Engineer, Staff', false],
    ['Staff+ Application Security Engineer', false],
    ['Senior Staff Software Engineer', false],
    ['Principal Engineer, Memory Safety', false],
    ['Distinguished Engineer, AI Security', false],
    ['Member of Technical Staff, Security', true],
    ['Senior/Staff Security Researcher', true],
    ['Senior / Principal Security Researcher', true],
    ['Senior Security Engineer', true],
    ['Staffing Coordinator', true],
    ['Research Engineer, Principles of AI Safety', true],
  ];
  const wrong = cases.filter(([t, want]) => keep(t) !== want);
  if (wrong.length === 0) pass(`${cases.length} titles get the expected verdict (whole words, exemptions, no substring hits)`);
  else fail(`wrong verdicts: ${JSON.stringify(wrong)}`);

  const bare = buildLevelFilter({ enabled: true, block: 'principal' });
  if (bare && bare('Principal Engineer') === false) pass('a bare-string block list is a one-item list');
  else fail('bare-string block list ignored');
}

// 3. END-TO-END: real scan.mjs over a fixture board (local parser, no network)
{
  const dir = mkdtempSync(join(tmpdir(), 'scan-level-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`);
    writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n');
    writeFileSync(join(dir, 'portals.yml'), `title_filter:
  positive:
    - "Security Engineer"
level_filter:
  enabled: true
  block: ${JSON.stringify(CFG.block)}
  exempt: ${JSON.stringify(CFG.exempt)}
tracked_companies:
  - name: Level Co
    parser:
      command: node
      script: tests/fixtures/level-board.mjs
`);
    const stdout = execFileSync(NODE, [join(ROOT, 'scan.mjs'), '--quiet'], {
      cwd: dir,
      // CAREER_OPS_ROOT, not cwd, anchors data/ (path-resolver.mjs): without it
      // this run would write into the real data/pipeline.md.
      env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: join(dir, 'portals.yml') },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const p = join(dir, 'data', 'pipeline.md');
    const lines = existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(l => l.startsWith('- [ ] ')) : [];
    const titles = lines.map(l => l.split(' | ')[2]);
    const want = ['Member of Technical Staff, Security Engineer', 'Senior/Staff Security Engineer', 'Security Engineer'];
    if (titles.length === 3 && want.every(t => titles.includes(t))) {
      pass('Staff and Principal titles are dropped; MTS, dual-level and plain titles are kept');
    } else {
      fail(`pipeline titles: ${JSON.stringify(titles)}`);
    }
    if (/Filtered by level:\s+2 removed/.test(stdout)) pass('summary reports the level-filter count');
    else fail(`summary line missing: ${stdout.split('\n').filter(l => /level/i.test(l)).join(' | ')}`);
  } catch (err) {
    fail(`e2e level scan failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
