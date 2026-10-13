// tests/validate-portals-company-aliases.test.mjs — validate-portals checks the shape
// of `company_aliases`.
//
// scan.mjs and merge-tracker.mjs both read the map and both IGNORE what they cannot
// use rather than fail, so a malformed entry reads as coverage and silently does
// nothing: the same role is scanned again and evaluated twice. The key was already
// accepted as a top-level name; its content was never looked at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATE = join(ROOT, 'validate-portals.mjs');

// validate-portals.mjs runs its CLI on import, so it is driven as one: a YAML file
// in, "error:" / "warning:" lines out.
function validate(yamlText) {
  const dir = mkdtempSync(join(tmpdir(), 'vp-aliases-'));
  try {
    const file = join(dir, 'portals.yml');
    writeFileSync(file, yamlText);
    const run = spawnSync(process.execPath, [VALIDATE, '--file', file], { encoding: 'utf-8' });
    const lines = run.stdout.split('\n');
    return {
      status: run.status,
      errors: lines.filter((l) => l.startsWith('error: ')).map((l) => l.slice(7)),
      warnings: lines.filter((l) => l.startsWith('warning: ')).map((l) => l.slice(9)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a well-formed map is clean, including a pinned canonical name with no aliases', () => {
  const r = validate(`company_aliases:
  TrendAI: ["Trend Micro"]
  Fin: Intercom
  NVIDIA: ["NVIDIA AI", 3000]
  Pinned:
  Empty: []
`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.status, 0);
});

test('an absent or null company_aliases is fine', () => {
  assert.deepEqual(validate('title_filter:\n  positive: ["x"]\n').errors, []);
  assert.deepEqual(validate('company_aliases:\n').errors, []);
});

test('a list or a scalar instead of a map is an error', () => {
  for (const bad of ['[a, b]', 'Fin', '7', 'true']) {
    const r = validate(`company_aliases: ${bad}\n`);
    assert.equal(r.status, 1, bad);
    assert.deepEqual(r.errors.map((e) => e.split(':')[0]), ['company_aliases'], bad);
  }
});

test('an empty canonical name and an empty or non-string alias are errors', () => {
  const r = validate(`company_aliases:
  "  ": [x]
  TrendAI: ["Trend Micro", "", "   ", {}, [], null]
`);
  assert.equal(r.status, 1);
  assert.ok(r.errors.some((e) => /^company_aliases: canonical company name must not be empty/.test(e)));
  const aliasErrors = r.errors.filter((e) => e.startsWith('company_aliases.TrendAI')).map((e) => e.split(':')[0]).sort();
  assert.deepEqual(aliasErrors, [1, 2, 3, 4, 5].map((i) => `company_aliases.TrendAI[${i}]`));
});

test('an alias claimed by two companies is warned about: scan.mjs ignores it', () => {
  const r = validate('company_aliases:\n  Acme: ["Shared ATS"]\n  Globex: ["shared ats"]\n');
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /claimed by Acme and Globex/);
  assert.equal(r.status, 0, 'a warning does not fail the preflight');
});

test('an alias that is its own canonical name, or another canonical name, is warned about', () => {
  const r = validate('company_aliases:\n  Fin: ["fin", "Intercom"]\n  Intercom: []\n');
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 2);
  assert.ok(r.warnings.some((w) => /canonical name itself/.test(w)));
  assert.ok(r.warnings.some((w) => /also a canonical name \(Intercom\)/.test(w)));
});

test('the shipped example config has no company_aliases error', () => {
  const run = spawnSync(process.execPath, [VALIDATE, '--file', join(ROOT, 'templates', 'portals.example.yml')], { encoding: 'utf-8' });
  assert.equal(run.status, 0, run.stdout);
  assert.ok(!/company_aliases/.test(run.stdout), run.stdout);
});
