// tests/roles-tracker-url-cell.test.mjs — the roles view against the tracker's
// URL cell and the other tracker/scan-history formats upstream changed.
//
// merge-tracker.mjs renders the tracker's URL cell as a markdown link
// (`[greenhouse](https://…)`, #3516) on every row it writes, while rows it has not
// rewritten still carry the bare URL; one tracker holds both. The roles view has to
//   - read the HREF from either form (the scan-history join, the pipeline dedup and the
//     "Open" link all key on it), and
//   - write a manual cell edit back without touching, double-wrapping or stripping the
//     link it did not edit.
// scan-history.tsv cells are stored with reversible formula escaping
// (lib/tsv-formula-escape.mjs): a reader that splits the line itself sees `'+Remote`.
// And `Assessment` (states.yml) is a canonical state the view has to place on a tab.
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { buildRoleModel, tabForStatus } from '../roles/roles-model.mjs';
import { SCAN_HISTORY_COLUMNS } from '../lib/scan-history-columns.mjs';
import { escapeFormulaCell } from '../lib/tsv-formula-escape.mjs';
import { pass, fail, warn, ROOT, rmSync, linkNodeModules } from './helpers.mjs';

console.log('\nroles view: markdown-link URL cell, scan-history escaping, Assessment tab');

function check(label, run) {
  try { run(); pass(label); } catch (error) {
    if (error && error.skipReason) warn(`${label}: skipped - ${error.skipReason}`);
    else fail(`${label}: ${String(error.message).split('\n')[0]}`);
  }
}

const cleanup = [];
const makeRoot = (prefix) => { const d = mkdtempSync(join(tmpdir(), `career-ops-${prefix}-`)); cleanup.push(d); return d; };

const GH_URL = 'https://job-boards.greenhouse.io/acme/jobs/111';
const GH_CELL = `[greenhouse](${GH_URL})`;
const LI_URL = 'https://www.linkedin.com/jobs/view/4420746887';
// A hand-annotated bare cell: the real tracker carries a few of these.
const NOTE_CELL = `${LI_URL} ⚠️ DUPLICATE (flagged 2026-10-06): same requisition as #9285`;
const BARE_URL = 'https://boards.greenhouse.io/other/jobs/222';

const TRACKER = [
  '# Applications Tracker', '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |',
  '|---|---|---|---|---|---|---|---|---|---|',
  `| 1 | 2026-09-02 | Acme | Security Engineer | 4.1/5 | Evaluated | ❌ | — | pct 82 · Platform · fits the stack | ${GH_CELL} |`,
  `| 2 | 2026-09-02 | Other | Research Engineer | 3.9/5 | Applied | ❌ | — | pct 78 · Labs · adjacent | ${BARE_URL} |`,
  `| 3 | 2026-09-02 | Third | Red Team Lead | 3.5/5 | Responded | ❌ | — | pct 70 | ${NOTE_CELL} |`,
  '| 4 | 2026-09-02 | Fourth | Detection Engineer | 3.2/5 | Evaluated | ❌ | — | pct 64 | — |',
  '| 5 | 2026-09-02 | Fifth | AppSec Engineer | 3.6/5 | Assessment | ❌ | — | pct 72 | [ashby](https://jobs.ashbyhq.com/fifth/555) |',
  '| 6 | 2026-09-02 | Sixth | Vuln Researcher | 3.7/5 | Interview | ❌ | — | pct 74 | |', '',
].join('\n');

function scanHistoryLine(fields) {
  return SCAN_HISTORY_COLUMNS.map((name) => escapeFormulaCell(fields[name] ?? '')).join('\t');
}
const SCAN_HISTORY = [
  SCAN_HISTORY_COLUMNS.join('\t'),
  scanHistoryLine({ url: GH_URL, first_seen: '2026-08-30', portal: 'greenhouse-api', title: 'Security Engineer', company: 'Acme', status: 'added', location: 'Austin, TX', posted_at: '2026-08-28' }),
  scanHistoryLine({ url: BARE_URL, first_seen: '2026-08-31', portal: 'greenhouse-api', title: 'Research Engineer', company: 'Other', status: 'added', location: '+Remote (US)', posted_at: '2026-08-29' }),
].join('\n') + '\n';

function writeRoot(root) {
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'reports'), { recursive: true });
  writeFileSync(join(root, 'data/applications.md'), TRACKER);
  writeFileSync(join(root, 'data/scan-history.tsv'), SCAN_HISTORY);
}

const modelRows = (root) => {
  const { rows } = buildRoleModel({
    root, trackerPath: join(root, 'data/applications.md'), reportsDir: join(root, 'reports'),
    pipelinePath: join(root, 'data/none.md'), scanHistoryPath: join(root, 'data/scan-history.tsv'),
    contactsPath: join(root, 'data/none-contacts.tsv'),
  });
  return Object.fromEntries(rows.map((r) => [r.trackerNum, r]));
};

const root = makeRoot('url-cell');
writeRoot(root);
const byNum = modelRows(root);

check('a markdown-link URL cell yields the href, not the link text', () => {
  assert.equal(byNum[1].url, GH_URL);
});
check('a bare URL cell yields the same kind of value', () => {
  assert.equal(byNum[2].url, BARE_URL);
});
check('the scan-history join (posted date, portal) works through either URL form', () => {
  assert.equal(byNum[1].posted_at, '2026-08-28');
  assert.equal(byNum[1].source, 'greenhouse-api');
  assert.equal(byNum[2].posted_at, '2026-08-29');
  assert.equal(byNum[2].source, 'greenhouse-api');
});
check('a placeholder URL cell is no URL (the report URL, if any, can stand in)', () => {
  assert.equal(byNum[4].url, null);
  assert.equal(byNum[6].url, null);
});
check('scan-history cells are read with the formula escaping undone (`\'+Remote` -> `+Remote`)', () => {
  assert.equal(byNum[2].loc, '+Remote (US)');
  assert.equal(byNum[1].loc, 'Austin, TX');
});
check('Assessment is a roles tab state (in-process, with Responded and Interview)', () => {
  assert.equal(tabForStatus('Assessment'), 'pending');
  assert.equal(byNum[5].tab, 'pending');
  assert.equal(byNum[3].tab, 'pending');
  assert.equal(byNum[6].tab, 'pending');
});

// ---- write-back: a throwaway install whose top-level entries link to this checkout
// and whose data/ is its own (roles-actions.mjs resolves its root from its own location,
// and --preserve-symlinks keeps that location).
const SYM_FLAGS = ['--preserve-symlinks', '--preserve-symlinks-main'];
function symRoot() {
  const r = makeRoot('url-cell-sym');
  for (const e of readdirSync(ROOT)) {
    if (['data', 'reports', 'config', '.git', 'node_modules'].includes(e)) continue;
    symlinkSync(join(ROOT, e), join(r, e));
  }
  const reason = linkNodeModules(r, ROOT);
  if (reason) throw Object.assign(new Error(reason), { skipReason: reason });
  writeRoot(r);
  return r;
}
const runEdits = (r, edits) => {
  const script = `
    import { editField } from ${JSON.stringify(join(r, 'roles/roles-actions.mjs'))};
    const out = [];
    for (const [id, f, v] of ${JSON.stringify(edits)}) {
      try { await editField(id, f, v); out.push('ok'); } catch (e) { out.push('ERR ' + e.message); }
    }
    console.log(JSON.stringify(out));`;
  const stdout = execFileSync(process.execPath, [...SYM_FLAGS, '--input-type=module', '-e', script], { cwd: r, encoding: 'utf-8' });
  return JSON.parse(stdout.trim().split('\n').pop());
};
const trackerRows = (r) => readFileSync(join(r, 'data/applications.md'), 'utf-8').split('\n');
const cells = (line) => line.split('|').map((s) => s.trim());

if (process.platform !== 'win32') {
  check('editing company / role leaves every URL cell byte-identical (link not double-wrapped, not stripped)', () => {
    const r = symRoot();
    const before = trackerRows(r);
    const res = runEdits(r, [
      ['tracker:1', 'co', 'Acme Corp'], ['tracker:1', 'role', 'Senior Security Engineer'],
      ['tracker:2', 'role', 'Research Engineer II'],
      ['tracker:3', 'co', 'Third Co'],
    ]);
    assert.deepEqual(res, ['ok', 'ok', 'ok', 'ok']);
    const after = trackerRows(r);
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
      if (!before[i].startsWith('| ')) { assert.equal(after[i], before[i]); continue; }
      assert.equal(cells(after[i])[10], cells(before[i])[10], `URL cell of row ${cells(before[i])[1]} changed`);
    }
    assert.equal(cells(after[4])[3], 'Acme Corp');
    assert.equal(cells(after[4])[4], 'Senior Security Engineer');
    assert.equal(cells(after[4])[10], GH_CELL);
    assert.equal(cells(after[5])[4], 'Research Engineer II');
    assert.equal(cells(after[6])[3], 'Third Co');
    assert.equal(cells(after[6])[10], NOTE_CELL, 'a hand-annotated URL cell is carried through verbatim');
    // Rows nobody edited are untouched, bytes and all.
    for (const i of [7, 8, 9]) assert.equal(after[i], before[i]);
  });

  check('editing Team / Why on a report-less row rewrites only the Notes cell', () => {
    const r = symRoot();
    const before = trackerRows(r);
    assert.deepEqual(runEdits(r, [['tracker:1', 'team', 'Trust Platform'], ['tracker:1', 'why', 'Same stack, same scale']]), ['ok', 'ok']);
    const after = trackerRows(r);
    const a = cells(after[4]);
    const b = cells(before[4]);
    assert.equal(a[9], 'pct 82 · Trust Platform · Same stack, same scale');
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 10]) assert.equal(a[i], b[i], `column ${i} changed`);
    // ...and the model reads the edit back through the same URL.
    const row = modelRows(r)[1];
    assert.equal(row.team, 'Trust Platform');
    assert.equal(row.why, 'Same stack, same scale');
    assert.equal(row.url, GH_URL);
  });

  check('a manual location edit is stored with the formula escaping and reads back unchanged', () => {
    const r = symRoot();
    // Row 2 has no report, so Location lives in scan-history. The value starts with a
    // formula character: a spreadsheet would run it unless it is stored behind a `'`.
    assert.deepEqual(runEdits(r, [['tracker:2', 'loc', '=Remote (EU)']]), ['ok']);
    const line = readFileSync(join(r, 'data/scan-history.tsv'), 'utf-8').split('\n').find((l) => l.startsWith(BARE_URL));
    assert.equal(line.split('\t')[6], "'=Remote (EU)");
    assert.equal(modelRows(r)[2].loc, '=Remote (EU)');
    // Toggling Remote on an already-escaped cell edits the value, not the stored form.
    assert.deepEqual(runEdits(r, [['tracker:2', 'loc', '+Remote (US)'], ['tracker:2', 'remote', 'no']]), ['ok', 'ok']);
    const stored = readFileSync(join(r, 'data/scan-history.tsv'), 'utf-8').split('\n').find((l) => l.startsWith(BARE_URL)).split('\t')[6];
    // "Remote" is dropped from the value `+Remote (US)`; the result still starts with a
    // formula character, so it is stored with exactly one escape and reads back whole.
    assert.equal(stored, "'+ (US)");
    assert.equal(modelRows(r)[2].loc, '+ (US)');
  });

  check('a tab typed into a cell edit cannot open a new scan-history column', () => {
    const r = symRoot();
    assert.deepEqual(runEdits(r, [['tracker:2', 'loc', 'Remote\tUS']]), ['ok']);
    const line = readFileSync(join(r, 'data/scan-history.tsv'), 'utf-8').split('\n').find((l) => l.startsWith(BARE_URL));
    assert.equal(line.split('\t').length, SCAN_HISTORY_COLUMNS.length);
    assert.equal(line.split('\t')[6], 'Remote US');
  });
}

for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
