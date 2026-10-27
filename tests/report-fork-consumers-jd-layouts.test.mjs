// tests/report-fork-consumers-jd-layouts.test.mjs — the fork's report readers and
// writers see the same report whichever way the archived JD is laid out, and never
// treat the JD's text as the report's own.
//
// Three layouts coexist in one reports/ directory:
//   old fork    header, Machine Summary, blocks, JD LAST (`## Job Description (scraped DATE)`,
//               text-fenced with a `Source:` line)
//   interactive header, Machine Summary, blocks, Keyword Coverage, JD LAST (modes/oferta.md)
//   batch       header, `---`, `## Job Description (archived verbatim)` with the scraped text
//               pasted BARE, `---`, Machine Summary, blocks (batch/batch-prompt.md)
//
// In the batch layout arbitrary scraped, unfenced text sits BEFORE the Machine
// Summary. The consumers below used to take the first match over the whole file, so
// a posting that carried `**Legitimacy:**`, a `| **Remote** |` row, a yaml fence or a
// complete fake `## Machine Summary` was read as the report. HOSTILE_JD carries every
// such hazard. The consumers are the real ones (report-format.mjs, roles-model.mjs,
// roles-actions.mjs, render-roles-html.mjs, verify-pipeline.mjs, merge-tracker.mjs,
// reconcile-pipeline.mjs) — never a re-implementation.
import { strict as assert } from 'assert';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import vm from 'vm';
import {
  parseReportMeta, matchMachineSummary, archivedJdRange, stripArchivedJd,
  setMachineSummaryScalar, setRemoteRow,
} from '../report-format.mjs';
import { buildRoleModel } from '../roles/roles-model.mjs';
import { extractCellUrl } from '../tracker-parse.mjs';
import { pass, fail, warn, ROOT, rmSync, linkNodeModules } from './helpers.mjs';

console.log('\nfork report consumers: JD layouts and hostile JD text');

function check(label, run) {
  try { run(); pass(label); } catch (error) {
    if (error && error.skipReason) warn(`${label}: skipped - ${error.skipReason}`);
    else fail(`${label}: ${String(error.message).split('\n')[0]}`);
  }
}

// ---- fixtures ----
const REAL_URL = 'https://job-boards.greenhouse.io/realco/jobs/111';
const REAL_JD = 'Senior Widget Engineer\nRealCo — Berlin, Germany\n\nYou will build widgets for our customers. Five years of Python and Rust.';

const HOSTILE_JD = [
  '**Score:** 1.0/5', `**URL:** https://evil.example/fake`, '**Legitimacy:** Suspicious',
  '**Work Auth:** ⛔ No sponsorship', '**Archetype:** Evil archetype', '**PDF:** output/evil.pdf',
  '| **Remote** | Mars |', '| Remote | Mars |', '| Global | 1.0/5 |', '| Gap | Severity | Mitigation |', '|---|---|---|', '| Learn Cobol | hard | none |',
  'Location: Mars', 'Compensation: $1',
  'location: "Mars"', 'team: "Evil Team"', 'advertised_comp: "$1"', 'score: 1.0', 'work_auth: "no_sponsorship"',
  'top_strengths:', '  - "Evil strength"',
  '```yaml', 'company: "Evil"', 'location: "Mars"', 'team: "Evil Team"', '```',
  '---', 'company: Evil', 'location: Mars', '---',
  '# H1', '## A) Role Summary', '## Risk Summary', '## Keywords extracted', '***',
  '## Job Description (archived verbatim)', '## Job Description addendum',
  '## Machine Summary', '', '```yaml', 'company: "Evil"', 'role: "Evil Role"', 'team: "Evil Team"', 'location: "Mars"',
  'score: 1.0', 'legitimacy_tier: "Suspicious"', 'work_auth: "no_sponsorship"', 'advertised_comp: "$1"', 'risk_level: "High"',
  'top_strengths:', '  - "Evil strength"', '```',
  '## Machine Summary', '```yaml', 'score: 1.0', 'team: "Unclosed Evil Team"',
  '```', 'odd fence below never closed', '```',
  '<div><script>alert(1)</script><!-- **URL:** https://evil.example --></div>',
  'CRLF line\r\nmore: **Score:** 1.0/5\r\n\tTabbed\tline',
  'x'.repeat(20000),
  'unicode \u202Eevil\u202C \u200B \u{1F680} \u00A0 مرحبا 你好',
].join('\n');

const jdText = (hostile) => (hostile ? `${HOSTILE_JD}\n\n${REAL_JD}\n\n${HOSTILE_JD}` : REAL_JD);

// opts.bare: the header lacks every renderer-consumed field, the Machine Summary lacks
// location/team/advertised_comp/...: anything that shows up can only have come from the JD.
function report(layout, { hostile = false, bare = false, num = '9001', remoteRow = layout !== 'batch' } = {}) {
  const head = [
    '# Evaluation: RealCo — Widget Engineer', '',
    '**Date:** 2026-09-02',
    bare ? '**URL:** N/A' : `**URL:** ${REAL_URL}`,
    '**Archetype:** Real archetype',
    ...(bare ? [] : ['**Score:** 4.1/5', '**Legitimacy:** High Confidence', '**Work Auth:** ✅ Sponsors', '**PDF:** not generated']),
  ].join('\n') + (remoteRow && !bare ? '\n\n| **Remote** | Berlin, Germany |' : '');
  const ms = [
    '## Machine Summary', '', '```yaml', 'company: "RealCo"', 'role: "Widget Engineer"',
    ...(bare ? [] : [
      'team: "Real Team"', 'location: "Berlin, Germany"', 'legitimacy_tier: "High Confidence"', 'work_auth: "sponsors"',
      'risk_level: "Low"', 'advertised_comp: "$150,000–$200,000"', 'top_strengths:', '  - "Real strength"',
    ]),
    'score: 4.1', 'archetype: "Real archetype"', 'final_decision: "Apply"', 'hard_stops:', '  - "Real stop"', 'soft_gaps: []', '```',
  ].join('\n');
  const blocks = '## A) Role Summary\n\nReal summary.\n\n## B) CV Match\n\nReal match.\n\n## Risk Summary\n\nReal risk.';
  const jd = jdText(hostile);
  if (layout === 'old') {
    return `${head}\n\n---\n\n${ms}\n\n${blocks}\n\n## Job Description (scraped 2026-09-02)\n\nSource: LinkedIn\n\n\`\`\`text\n${jd}\n\`\`\`\n`;
  }
  if (layout === 'interactive') {
    return `${head}\n\n---\n\n${ms}\n\n${blocks}\n\n## Keyword Coverage\n\nCoverage 60%\n\n## Job Description (archived verbatim)\n\n${jd}\n`;
  }
  return `${head}\n**Batch ID:** 42\n\n---\n\n## Job Description (archived verbatim)\n\n${jd}\n\n---\n\n${ms}\n\n${blocks}\n`;
}

const LAYOUTS = ['old', 'interactive', 'batch'];
const same = (a, b) => assert.equal(JSON.stringify(sortKeys(a)), JSON.stringify(sortKeys(b)));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// ---- 1. parseReportMeta: same values in every layout, hostile or not ----
const EXPECTED = parseReportMeta(report('old'));
check('old layout parses to the real header + Machine Summary values', () => {
  assert.equal(EXPECTED.url, REAL_URL);
  assert.equal(EXPECTED.loc, 'Berlin, Germany');
  assert.equal(EXPECTED.team, 'Real Team');
  assert.equal(EXPECTED.advertised_comp, '$150,000–$200,000');
  assert.equal(EXPECTED.legitimacy_tier, 'High Confidence');
  assert.equal(EXPECTED.work_auth, 'sponsors');
  assert.equal(EXPECTED.work_auth_header, '✅ Sponsors');
  assert.equal(EXPECTED.risk_level, 'Low');
  assert.deepEqual(EXPECTED.hard_stops, ['Real stop']);
  assert.equal(EXPECTED.why, 'Real strength');
  assert.equal(EXPECTED.archetype, 'Real archetype');
});
for (const layout of LAYOUTS) {
  for (const hostile of [false, true]) {
    check(`parseReportMeta: ${layout} layout${hostile ? ', hostile JD' : ''} reads the same report`, () => {
      same(parseReportMeta(report(layout, { hostile })), EXPECTED);
    });
  }
}
for (const layout of LAYOUTS) {
  check(`parseReportMeta: ${layout} layout, hostile JD never fills a field the report lacks`, () => {
    const bare = parseReportMeta(report(layout, { hostile: true, bare: true }));
    const clean = parseReportMeta(report(layout, { hostile: false, bare: true }));
    same(bare, clean);
    assert.equal(bare.url, undefined);
    assert.equal(bare.loc, undefined);
    assert.equal(bare.team, null);
    assert.equal(bare.advertised_comp, undefined);
    assert.equal(bare.legitimacy_tier, null);
    assert.equal(bare.work_auth, null);
    assert.equal(bare.work_auth_header, undefined);
    assert.deepEqual(bare.hard_stops, ['Real stop']);
  });
}

// ---- 2. the locator itself ----
check('matchMachineSummary: batch layout picks the LAST fence, JD-last layouts the FIRST', () => {
  const fenceOf = (t) => matchMachineSummary(t)?.[1] ?? '';
  for (const layout of LAYOUTS) {
    const body = fenceOf(report(layout, { hostile: true }));
    assert.match(body, /company: "RealCo"/, layout);
    assert.doesNotMatch(body, /Evil/, layout);
  }
});
check('matchMachineSummary: an unclosed fake fence cannot swallow the real heading', () => {
  const t = '## Job Description (archived verbatim)\n\n## Machine Summary\n```yaml\nscore: 1.0\n\n---\n\n## Machine Summary\n\n```yaml\nscore: 4.1\n```\n';
  assert.match(matchMachineSummary(t)[1], /^score: 4\.1$/);
});
check('matchMachineSummary: no JD section is exactly text.match(re)', () => {
  const t = report('old').replace(/\n## Job Description[\s\S]*$/, '\n');
  assert.equal(archivedJdRange(t), null);
  assert.equal(matchMachineSummary(t).index, t.search(/##\s*Machine Summary/));
  assert.equal(stripArchivedJd(t), t);
  assert.equal(matchMachineSummary('no summary here'), null);
});
check('matchMachineSummary: a long run of newlines after a "## Machine Summary" line parses in linear time', () => {
  // `\s*\n+` before the fence backtracks quadratically on a pure newline run: 80,000
  // newlines took ~18 s per call. The candidate finder must not have that shape.
  const hostile = '# Evaluation: X\n\n**Score:** 4.0/5\n\n## Job Description (archived verbatim)\n\n## Machine Summary'
    + '\n'.repeat(80000) + 'tail\n\n## Machine Summary\n\n```yaml\ncompany: "X"\nscore: 4.0\n```\n';
  const started = Date.now();
  const m = matchMachineSummary(hostile);
  stripArchivedJd(hostile);
  const elapsed = Date.now() - started;
  assert.ok(m && m[0].includes('score: 4.0'), 'the real Machine Summary is still found');
  assert.ok(elapsed < 2000, `took ${elapsed} ms`);
});

check('archivedJdRange: batch JD ends at the real Machine Summary, JD-last runs to EOF', () => {
  const b = report('batch', { hostile: true });
  const [s, e] = archivedJdRange(b);
  assert.ok(b.slice(s, e).includes(HOSTILE_JD));
  assert.ok(b.slice(e).startsWith('## Machine Summary'));
  const o = report('old', { hostile: true });
  assert.equal(archivedJdRange(o)[1], o.length);
});
check('stripArchivedJd: the report minus its JD is identical across layouts', () => {
  for (const hostile of [false, true]) {
    const sections = (t) => stripArchivedJd(t).split('\n').filter((l) => /^##? /.test(l));
    const old = sections(report('old', { hostile }));
    assert.deepEqual(sections(report('batch', { hostile })), old);
  }
});

// ---- 3. the dashboard model (roles-model.mjs -> parseReport) ----
function makeRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `career-ops-${prefix}-`));
}
function writeRoot(root, layout, opts, { num = '9001', role = 'Widget Engineer' } = {}) {
  mkdirSync(join(root, 'reports'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  const file = `${num}-realco-2026-09-02.md`;
  writeFileSync(join(root, 'reports', file), report(layout, { ...opts, num }));
  writeFileSync(join(root, 'data/applications.md'), [
    '# Applications Tracker', '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |',
    '|---|---|---|---|---|---|---|---|---|---|',
    `| ${num} | 2026-09-02 | RealCo | ${role} | 4.1/5 | Evaluated | ❌ | [${num}](reports/${file}) | note | |`, '',
  ].join('\n'));
  return file;
}
const modelRow = (root) => {
  const { rows } = buildRoleModel({
    root, trackerPath: join(root, 'data/applications.md'), reportsDir: join(root, 'reports'),
    pipelinePath: join(root, 'data/none.md'), scanHistoryPath: join(root, 'data/none.tsv'),
  });
  const { age, isNew, ...row } = rows[0];
  return row;
};
const cleanup = [];
const baseline = (() => { const r = makeRoot('model-old'); cleanup.push(r); writeRoot(r, 'old', {}); return modelRow(r); })();
check('buildRoleModel: old layout fills Location / Team / Salary / Legitimacy / Work auth from the report', () => {
  assert.equal(baseline.loc, 'Berlin, Germany');
  assert.equal(baseline.team, 'Real Team');
  assert.equal(baseline.sal, '$150,000–$200,000');
  assert.equal(baseline.legitimacy_tier, 'High Confidence');
  assert.equal(baseline.work_auth, 'Sponsors');
  assert.equal(baseline.url, REAL_URL);
  assert.deepEqual(baseline.hard_stops, ['Real stop']);
});
for (const layout of LAYOUTS) {
  for (const hostile of [false, true]) {
    check(`buildRoleModel: ${layout} layout${hostile ? ', hostile JD' : ''} gives the same dashboard row`, () => {
      const r = makeRoot(`model-${layout}`); cleanup.push(r);
      writeRoot(r, layout, { hostile });
      same(modelRow(r), baseline);
    });
  }
}
check('buildRoleModel: hostile JD never fills a blank dashboard column', () => {
  const r = makeRoot('model-bare'); cleanup.push(r);
  writeRoot(r, 'batch', { hostile: true, bare: true });
  const row = modelRow(r);
  assert.equal(row.loc, '—');
  assert.equal(row.team, '');
  assert.equal(row.sal, '—');
  assert.equal(row.legitimacy_tier, null);
  assert.equal(row.work_auth, null);
  assert.equal(row.url, null);
});

// ---- 4. write path: edits land in the real report, never in the JD ----
check('setMachineSummaryScalar: edits the real fence only (batch layout, hostile JD with its own fence)', () => {
  const t = report('batch', { hostile: true });
  const out = setMachineSummaryScalar(t, 'team', '"New Team"');
  assert.equal(parseReportMeta(out).team, 'New Team');
  assert.ok(out.includes(HOSTILE_JD), 'JD text untouched');
  const [s, e] = archivedJdRange(out);
  assert.equal(out.slice(s, e), t.slice(...archivedJdRange(t)));
  // a key the real fence lacks is inserted there, not into the lookalike
  const bare = report('batch', { hostile: true, bare: true });
  const added = setMachineSummaryScalar(bare, 'team', '"Added Team"');
  assert.equal(parseReportMeta(added).team, 'Added Team');
  assert.ok(added.includes(HOSTILE_JD));
});
check('setRemoteRow: never rewrites a `| **Remote** |` line inside the JD', () => {
  const batchNoRow = report('batch', { hostile: true });
  const r = setRemoteRow(batchNoRow, 'Elsewhere');
  assert.equal(r.changed, false);
  assert.equal(r.text, batchNoRow);
  const old = report('old', { hostile: true });
  const r2 = setRemoteRow(old, 'Elsewhere');
  assert.equal(r2.changed, true);
  assert.match(r2.text, /\| \*\*Remote\*\* \| Elsewhere \|/);
  assert.ok(r2.text.includes(HOSTILE_JD));
});

// A throwaway "install" whose top-level entries are symlinks to this checkout and whose
// data/ and reports/ are its own: roles-actions.mjs / render-roles-html.mjs resolve their
// root from their own location, and --preserve-symlinks keeps that location.
function symRoot(layout, opts, extraTracker = null) {
  const root = makeRoot(`sym-${layout}`); cleanup.push(root);
  for (const e of readdirSync(ROOT)) {
    if (['data', 'reports', 'config', '.git', 'node_modules'].includes(e)) continue;
    symlinkSync(join(ROOT, e), join(root, e));
  }
  // linkNodeModules() rather than a raw symlinkSync: a bare call leaves a dangling link when
  // the tree is absent (every assertion would then pass or fail for the wrong reason) and
  // skips the Windows junction. It returns a reason instead, which skips the check.
  const depsReason = linkNodeModules(root, ROOT);
  if (depsReason) throw Object.assign(new Error(depsReason), { skipReason: depsReason });
  const file = writeRoot(root, layout, opts);
  if (extraTracker) writeFileSync(join(root, 'data/applications.md'), extraTracker(file));
  return { root, file };
}
const SYM_FLAGS = ['--preserve-symlinks', '--preserve-symlinks-main'];

if (process.platform !== 'win32') {
  check('roles-actions editField: batch layout + hostile JD, every edit lands in the real report', () => {
    const { root, file } = symRoot('batch', { hostile: true });
    const script = `
      import { editField } from ${JSON.stringify(join(root, 'roles/roles-actions.mjs'))};
      const out = {};
      for (const [f, v] of [['loc', 'Testville, CA'], ['remote', 'yes'], ['team', 'Zeta Team'], ['sal', '$100,000–$200,000'], ['why', 'New strength']]) {
        try { await editField('tracker:9001', f, v); out[f] = 'ok'; } catch (e) { out[f] = 'ERR ' + e.message; }
      }
      console.log(JSON.stringify(out));`;
    const stdout = execFileSync(process.execPath, [...SYM_FLAGS, '--input-type=module', '-e', script], { cwd: root, encoding: 'utf-8' });
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').pop()), { loc: 'ok', remote: 'ok', team: 'ok', sal: 'ok', why: 'ok' });
    const edited = readFileSync(join(root, 'reports', file), 'utf-8');
    assert.ok(edited.includes(HOSTILE_JD), 'JD text untouched');
    const meta = parseReportMeta(edited);
    assert.equal(meta.loc, 'Testville, CA / Remote');
    assert.equal(meta.team, 'Zeta Team');
    assert.equal(meta.advertised_comp, '$100,000–$200,000');
    assert.equal(meta.why, 'New strength');
    assert.equal(meta.url, REAL_URL);
  });

  check('render-roles-html: a `</script>` in a row value cannot end the data block', () => {
    const evil = '</script><img src=x onerror=alert(1)><!-- \u2028 tail';
    const { root } = symRoot('batch', {}, (file) => [
      '# Applications Tracker', '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |',
      '|---|---|---|---|---|---|---|---|---|---|',
      `| 9001 | 2026-09-02 | RealCo | Role ${evil} | 4.1/5 | Evaluated | ❌ | [9001](reports/${file}) | ${evil} | |`, '',
    ].join('\n'));
    const out = join(root, 'out.html');
    execFileSync(process.execPath, [...SYM_FLAGS, join(root, 'roles/render-roles-html.mjs'), '--out', out], { cwd: root, encoding: 'utf-8' });
    const html = readFileSync(out, 'utf-8');
    const start = html.indexOf('const D = ');
    const end = html.indexOf(';\nconst COLS', start);
    assert.ok(start > 0 && end > start, 'data block found');
    const literal = html.slice(start + 'const D = '.length, end);
    assert.doesNotMatch(literal, /</, 'no raw < inside the data literal');
    const data = vm.runInNewContext(`(${literal})`);
    assert.equal(data[0].role, `Role ${evil}`, 'the page still sees the exact original string');
    assert.equal((html.match(/<\/script/gi) || []).length, (html.match(/<script/gi) || []).length, 'script tags balanced');
  });
}

// ---- 5. script consumers that read a report through CAREER_OPS_ROOT ----
function runScript(script, args, root) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(ROOT, script), ...args], { env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}

const vpOutput = (layout, opts) => {
  const r = makeRoot(`vp-${layout}`); cleanup.push(r);
  writeRoot(r, layout, opts);
  return runScript('verify-pipeline.mjs', [], r);
};
for (const layout of LAYOUTS) {
  check(`verify-pipeline (Checks 18/19): ${layout} layout, hostile JD changes nothing in a complete report`, () => {
    const benign = vpOutput(layout, {});
    const hostile = vpOutput(layout, { hostile: true });
    assert.equal(hostile.code, 0, hostile.out);
    assert.equal(hostile.out, benign.out);
    assert.match(hostile.out, /All referenced reports carry the renderer-consumed fields/);
    assert.match(hostile.out, /Every roles-view column holds only its own field/);
  });
  check(`verify-pipeline (Checks 18/19): ${layout} layout, hostile JD cannot satisfy or break the checks`, () => {
    const benign = vpOutput(layout, { bare: true });
    const hostile = vpOutput(layout, { bare: true, hostile: true });
    assert.equal(hostile.out, benign.out);
    for (const needle of ['header **URL:** missing', 'header **Legitimacy:** missing', 'no "| **Remote** | … |" row', 'no advertised_comp: key', 'no team: key']) {
      assert.ok(hostile.out.includes(needle), `still warns: ${needle}`);
    }
    assert.doesNotMatch(hostile.out, /❌/);
  });
}
check('verify-pipeline Check 19: a JD full of out-of-contract values is not a contract violation', () => {
  const bad = ['**Work Auth:** bogus value', '**Legitimacy:** nonsense tier', '| **Remote** | $$$ 100 on-site |',
    'location: "Mars 5 days on-site"', 'team: "Evil: team (fit)"', 'advertised_comp: "lots of money"', 'risk_level: "Extreme"'].join('\n');
  const r = makeRoot('vp-contract'); cleanup.push(r);
  const file = writeRoot(r, 'batch', {});
  writeFileSync(join(r, 'reports', file), report('batch').replace(REAL_JD, `${bad}\n${REAL_JD}`));
  const res = runScript('verify-pipeline.mjs', [], r);
  assert.equal(res.code, 0, res.out);
  assert.doesNotMatch(res.out, /❌/);
});

check('merge-tracker --backfill-urls: a URL is only ever taken from the header, never from the JD', () => {
  const r = makeRoot('mt'); cleanup.push(r);
  mkdirSync(join(r, 'reports'), { recursive: true });
  mkdirSync(join(r, 'data'), { recursive: true });
  const rows = [];
  for (const [num, variant] of [['9001', 'good'], ['9002', 'na'], ['9003', 'none']]) {
    const file = `${num}-realco-2026-09-02.md`;
    let t = report('batch', { hostile: true });
    if (variant === 'na') t = t.replace(`**URL:** ${REAL_URL}`, '**URL:** N/A');
    if (variant === 'none') t = t.replace(`**URL:** ${REAL_URL}\n`, '');
    writeFileSync(join(r, 'reports', file), t);
    rows.push(`| ${num} | 2026-09-02 | RealCo | Role ${num} | 4.1/5 | Evaluated | ❌ | [${num}](reports/${file}) | note | |`);
  }
  writeFileSync(join(r, 'data/applications.md'), ['# Applications Tracker', '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |', '|---|---|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n'));
  const res = runScript('merge-tracker.mjs', ['--backfill-urls'], r);
  assert.equal(res.code, 0, res.out);
  const urls = readFileSync(join(r, 'data/applications.md'), 'utf-8').split('\n')
    .filter((l) => /^\| 900\d/.test(l)).map((l) => l.split('|').map((c) => c.trim())[10]);
  // merge-tracker renders the URL cell as a markdown link (#3516), so the cell is
  // compared by the href it points at, which is the part that must come from the header.
  assert.deepEqual(urls.map(extractCellUrl), [REAL_URL, '', '']);
});

check('reconcile-pipeline: Score / PDF come from the header, a JD line cannot stand in for a missing one', () => {
  const line = (r, layout, opts, num) => {
    const file = `${num}-realco-2026-09-02.md`;
    writeFileSync(join(r, 'reports', file), report(layout, { ...opts, num }));
    return file;
  };
  const r = makeRoot('rec'); cleanup.push(r);
  mkdirSync(join(r, 'reports'), { recursive: true });
  mkdirSync(join(r, 'data'), { recursive: true });
  mkdirSync(join(r, 'batch'), { recursive: true });
  line(r, 'batch', { hostile: true }, '9001');
  line(r, 'batch', { hostile: true, bare: true }, '9002');
  writeFileSync(join(r, 'batch/batch-state.tsv'), [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '1\thttps://x.example/1\tcompleted\t-\t-\t9001\t-\t-\t0',
    '2\thttps://x.example/2\tcompleted\t-\t-\t9002\t-\t-\t0',
  ].join('\n') + '\n');
  writeFileSync(join(r, 'data/pipeline.md'), '# Pipeline\n\n## Pending\n\n- [ ] https://x.example/1 | RealCo | Role 1\n- [ ] https://x.example/2 | RealCo | Role 2\n');
  // batch-state.tsv is read from the codebase root unless --state names it (upstream).
  const res = runScript('reconcile-pipeline.mjs', ['--dry-run', '--state', join(r, 'batch/batch-state.tsv')], r);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /#9001 RealCo — Role 1 \(4\.1\/5\)/);
  assert.match(res.out, /#9002 RealCo — Role 2 \(N\/A\)/);
});

for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
