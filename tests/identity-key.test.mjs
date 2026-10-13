// tests/identity-key.test.mjs — company and title identity for duplicate detection.
//
// identity-key.mjs is the one place scan.mjs (stage 1) and merge-tracker.mjs (the
// tracker write) decide that two spellings are one employer or one opening. The
// cases below are the real Oct 8 failures (a LinkedIn copy of an already tracked
// role, written once more because "TrendAI" != "TrendAI (Trend Micro)" and
// "...RL (Reinforcement Learning)" != "...RL"), and the guards that matter more
// than the fix: folding two different things into one silently drops an opening,
// while splitting one thing in two only leaves a duplicate the user can see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldCompanyQualifier,
  isRedundantTitleQualifier,
  dropRedundantTitleQualifier,
  buildCompanyIdentity,
} from '../identity-key.mjs';
import { normalizeCompany } from '../tracker-utils.mjs';

// ── foldCompanyQualifier ────────────────────────────────────────────────────

test('folds a trailing parenthetical qualifier', () => {
  assert.equal(foldCompanyQualifier('NVIDIA (Product Security / AI Red Team)'), 'NVIDIA');
  assert.equal(foldCompanyQualifier('TrendAI (Trend Micro)'), 'TrendAI');
  assert.equal(foldCompanyQualifier('Palo Alto Networks (Unit 42 / AI Research, per scanner)'), 'Palo Alto Networks');
});

test('folds every trailing qualifier, and only trailing ones', () => {
  assert.equal(foldCompanyQualifier('Acme (Labs) (EU)'), 'Acme');
  assert.equal(foldCompanyQualifier('Acme (Labs) Holdings'), 'Acme (Labs) Holdings');
});

test('a label with nothing to fold comes back as the very same string', () => {
  // Byte-for-byte: a caller's behaviour for ordinary names must not move.
  for (const name of ['Anthropic', '  Anthropic ', 'ＡＢＣ Corp', 'Snap Inc.', '', 'a (b']) {
    assert.equal(foldCompanyQualifier(name), name);
  }
});

test('the unknown-employer marker and qualifier-only names are never folded', () => {
  // `?` is how the tracker records a blind posting (#1596). Folding "? (client of
  // Michael Page)" would make every agency's blind rows one company.
  assert.equal(foldCompanyQualifier('? (client of Michael Page)'), '? (client of Michael Page)');
  assert.equal(foldCompanyQualifier('? (a) (b)'), '? (a) (b)');
  assert.equal(foldCompanyQualifier('(Acme)'), '(Acme)');
  assert.equal(foldCompanyQualifier('--- (x)'), '--- (x)');
});

test('nested or unbalanced groups are left alone rather than guessed at', () => {
  assert.equal(foldCompanyQualifier('Acme (A (B))'), 'Acme (A (B))');
  assert.equal(foldCompanyQualifier('Acme (A) B)'), 'Acme (A) B)');
  assert.equal(foldCompanyQualifier('Acme )('), 'Acme )(');
});

test('full-width parentheses fold like ASCII ones, and non-Latin names survive', () => {
  assert.equal(foldCompanyQualifier('株式会社アカネ（東京）'), '株式会社アカネ');
  assert.equal(foldCompanyQualifier('Яндекс (Yandex)'), 'Яндекс');
});

test('the characters that remain are the characters that were passed in', () => {
  // The caller compares labels under its own key; a fold that quietly NFKC'd the
  // result would make "ＡＢＣ (x)" and "ＡＢＣ" disagree under a key that does not.
  assert.equal(foldCompanyQualifier('ＡＢＣ (x)'), 'ＡＢＣ');
  assert.equal(foldCompanyQualifier('ＡＢＣ（x）'), 'ＡＢＣ');
  assert.equal(foldCompanyQualifier('Acme\u3000(x)'), 'Acme');
  assert.equal(dropRedundantTitleQualifier('ＳＲＥ Site Reliability Engineer (SRE)'), 'ＳＲＥ Site Reliability Engineer');
});

test('hostile input: empty, non-string, huge, and pathological runs terminate fast', () => {
  assert.equal(foldCompanyQualifier(undefined), '');
  assert.equal(foldCompanyQualifier(null), '');
  assert.equal(foldCompanyQualifier(42), '42');
  assert.equal(foldCompanyQualifier({}), '[object Object]');
  const t0 = Date.now();
  assert.equal(foldCompanyQualifier(`${'a'.repeat(1_000_000)} (x)`), 'a'.repeat(1_000_000));
  // An unclosed group after a long whitespace run is what makes a regex like
  // /^(.*\S)\s*\((.*)\)\s*$/ quadratic.
  foldCompanyQualifier(`a${' '.repeat(200_000)}(x`);
  foldCompanyQualifier(`a${' '.repeat(200_000)}(x) `);
  foldCompanyQualifier('('.repeat(200_000));
  foldCompanyQualifier(`${'('.repeat(100_000)})`);
  foldCompanyQualifier('a (b) '.repeat(50_000));
  foldCompanyQualifier(`x${'(a)'.repeat(100_000)}`);
  foldCompanyQualifier(`x${' (aa) '.repeat(100_000)}`);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
});

// ── isRedundantTitleQualifier / dropRedundantTitleQualifier ─────────────────

test('a qualifier that spells out an acronym already in the title is redundant', () => {
  assert.ok(isRedundantTitleQualifier('Research Engineer, Cybersecurity RL', 'Reinforcement Learning'));
  assert.ok(isRedundantTitleQualifier(
    'Senior Security Research Engineer, SONAR', 'Security Operations and Novel Adversary Research'));
  assert.ok(isRedundantTitleQualifier('Sr. Security Engineer, Security Search and Observability', 'SSO'));
  assert.ok(isRedundantTitleQualifier('AI Engineer', 'Artificial Intelligence'));
});

test('a qualifier that IS the acronym of the title is redundant too', () => {
  assert.ok(isRedundantTitleQualifier('Site Reliability Engineer', 'SRE'));
  assert.ok(isRedundantTitleQualifier('Security Engineer, AWS Customer Incident Response Team', 'CIRT'));
  assert.ok(isRedundantTitleQualifier('Product Security Incident Response Team', 'PSIRT'));
});

test('a team, product, skill or level qualifier is NOT redundant', () => {
  // Palo Alto Networks posts these as four different requisitions, and the
  // tracker holds separate Applied rows for some of them.
  for (const q of ['Xpanse', 'Decoder', 'Advanced Threat Prevention', 'AI-Assisted Vulnerability Research',
    'Malware Research - Anti-Virus Systems', 'Cloud', 'Auth0', 'Windows Security', 'Senior', 'Junior', 'II', 'All Levels']) {
    assert.equal(isRedundantTitleQualifier('Principal Security Researcher', q), false, q);
  }
});

test('an expansion that no acronym in the title spells is not redundant', () => {
  // "Reinforcement Learning" is the TEAM of an Anthropic req called "Research
  // Engineer, Machine Learning"; it is not the expansion of anything in the title.
  assert.equal(isRedundantTitleQualifier('Research Engineer, Machine Learning', 'Reinforcement Learning'), false);
  assert.equal(isRedundantTitleQualifier('Research Engineer, Code RL', 'Machine Learning'), false);
});

test('a long chain of redundant qualifiers is bounded, not unbounded work', () => {
  const title = `Site Reliability Engineer${' (SRE)'.repeat(8)}`;
  assert.equal(dropRedundantTitleQualifier(title), `Site Reliability Engineer${' (SRE)'.repeat(2)}`);
  assert.equal(dropRedundantTitleQualifier(`${'x'.repeat(600)} SRE (SRE)`), `${'x'.repeat(600)} SRE (SRE)`);
});

test('degenerate arguments are never redundant', () => {
  assert.equal(isRedundantTitleQualifier('', 'RL'), false);
  assert.equal(isRedundantTitleQualifier('Engineer', ''), false);
  assert.equal(isRedundantTitleQualifier(undefined, undefined), false);
  assert.equal(isRedundantTitleQualifier('Engineer', '()!'), false);
  // One initial is not an acronym; a lone letter must not match "Engineer, A".
  assert.equal(isRedundantTitleQualifier('Engineer, A', 'Alpha'), false);
  assert.equal(isRedundantTitleQualifier('Engineer 2027', '2027 Start'), false);
  // An expansion made of a whole paragraph is not an acronym expansion.
  assert.equal(isRedundantTitleQualifier('Engineer, RL', 'reinforcement learning '.repeat(100)), false);
  const nine = 'one two three four five six seven eight nine'.split(' ');
  assert.equal(isRedundantTitleQualifier(`Engineer, ${nine.map((w) => w[0]).join('')}`, nine.join(' ')), false);
});

test('non-Latin and mixed titles do not throw and do not over-match', () => {
  assert.equal(isRedundantTitleQualifier('バックエンドエンジニア', '東京'), false);
  assert.equal(isRedundantTitleQualifier('Ingénieur Sécurité', 'Éléments Rares'), false);
  assert.ok(isRedundantTitleQualifier('Ingénieur ML', 'Machine Learning'));
});

test('dropRedundantTitleQualifier peels redundant qualifiers and stops at the first real one', () => {
  assert.equal(
    dropRedundantTitleQualifier('Research Engineer, Cybersecurity RL (Reinforcement Learning)'),
    'Research Engineer, Cybersecurity RL');
  assert.equal(dropRedundantTitleQualifier('Principal Security Researcher (Xpanse)'), 'Principal Security Researcher (Xpanse)');
  assert.equal(
    dropRedundantTitleQualifier('Site Reliability Engineer (SRE) (Cloud)'),
    'Site Reliability Engineer (SRE) (Cloud)');
  // The real qualifier is last, so the peel reaches the redundant one before it.
  assert.equal(dropRedundantTitleQualifier('Site Reliability Engineer (Cloud) (SRE)'), 'Site Reliability Engineer (Cloud)');
});

test('dropRedundantTitleQualifier returns the identical string when nothing is dropped', () => {
  for (const title of ['Security Engineer', 'Engineer (Senior)', '', 'RL (Reinforcement Learning', 'Foo (A (B))']) {
    assert.equal(dropRedundantTitleQualifier(title), title);
  }
  assert.equal(dropRedundantTitleQualifier(null), '');
  assert.equal(dropRedundantTitleQualifier(undefined), '');
});

test('dropRedundantTitleQualifier on hostile input terminates fast', () => {
  const t0 = Date.now();
  dropRedundantTitleQualifier(`${'word '.repeat(100_000)}(${'x '.repeat(100_000)})`);
  dropRedundantTitleQualifier('('.repeat(100_000));
  dropRedundantTitleQualifier('RL (Reinforcement Learning) '.repeat(20_000));
  // Every qualifier redundant, and the "title" long enough that a word split per
  // peel would take half a minute: a megabyte of groups is not a title.
  dropRedundantTitleQualifier(`Site Reliability Engineer ${'(SRE)'.repeat(20_000)}`);
  dropRedundantTitleQualifier(`${'word '.repeat(50_000)}Site Reliability Engineer ${'(SRE)'.repeat(2_000)}`);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
});

// ── buildCompanyIdentity ────────────────────────────────────────────────────

test('without aliases it is the qualifier fold plus the supplied normalizer', () => {
  const id = buildCompanyIdentity(undefined);
  assert.equal(id('TrendAI (Trend Micro)'), 'trendai');
  assert.equal(id('  TrendAI '), 'trendai');
  assert.equal(id('Acme Corp'), 'acme corp');
  const tracker = buildCompanyIdentity(undefined, { normalize: normalizeCompany });
  assert.equal(tracker('Snap Inc.'), tracker('Snap Inc'));
  assert.equal(tracker('Trend Micro (Zero Day Initiative)'), 'trendmicro');
});

test('the Oct 8 spellings of one employer resolve to one key once the rename is declared', () => {
  const id = buildCompanyIdentity({ TrendAI: ['Trend Micro'] });
  const keys = ['TrendAI', 'TrendAI (Trend Micro)', 'Trend Micro', 'Trend Micro (Zero Day Initiative)', 'Trend Micro (ZDI)']
    .map(id);
  assert.deepEqual(new Set(keys), new Set(['trendai']));
  // Without the alias the tracker's spelling is a different employer, which is
  // exactly why the rename has to be declared and cannot be guessed.
  assert.notEqual(buildCompanyIdentity(undefined)('Trend Micro (Zero Day Initiative)'), 'trendai');
});

test('an alias written with its qualifier wins over the fold (the namesake escape)', () => {
  const id = buildCompanyIdentity({ 'Cobalt Robotics': ['Cobalt (robotics)'] });
  assert.equal(id('Cobalt (robotics)'), 'cobalt robotics');
  assert.equal(id('Cobalt (security)'), 'cobalt');
  assert.notEqual(id('Cobalt (robotics)'), id('Cobalt (security)'));
});

test('an alias still reaches a label that carries a qualifier', () => {
  const id = buildCompanyIdentity({ Fin: ['Intercom'] });
  assert.equal(id('Intercom (Fin AI)'), 'fin');
});

test('malformed alias config degrades to no aliases instead of throwing', () => {
  for (const bad of [undefined, null, 'x', 7, ['a', 'b'], { '': ['x'] }]) {
    assert.equal(buildCompanyIdentity(bad)('Intercom'), 'intercom');
  }
  assert.equal(buildCompanyIdentity({ Fin: [null, 'Intercom', 42, '', {}] })('Intercom'), 'fin');
  assert.equal(buildCompanyIdentity({ Fin: [null, 'Intercom', 42] })('42'), 'fin');
  assert.equal(buildCompanyIdentity({ Fin: 'Intercom' })('Intercom'), 'fin');
});

test('canonical names keep their identity, and an ambiguous alias merges nothing', () => {
  assert.equal(buildCompanyIdentity({ Fin: ['Intercom'], Intercom: [] })('Intercom'), 'intercom');
  assert.equal(buildCompanyIdentity({ Intercom: [], Fin: ['Intercom'] })('Intercom'), 'intercom');
  const a = buildCompanyIdentity({ Fin: ['Shared ATS'], Acme: ['Shared ATS'] });
  const b = buildCompanyIdentity({ Acme: ['Shared ATS'], Fin: ['Shared ATS'] });
  assert.equal(a('Shared ATS'), 'shared ats');
  assert.equal(b('Shared ATS'), 'shared ats');
});

test('two different companies stay two keys', () => {
  const id = buildCompanyIdentity({ TrendAI: ['Trend Micro'] });
  assert.notEqual(id('Acme (Labs)'), id('Globex (Labs)'));
  assert.notEqual(id('Acme Solutions'), id('Acme Technologies'));
  assert.notEqual(id('Acme'), id('Acme Robotics'));
});

test('a blind employer keeps one key per agency spelling and never collapses to empty', () => {
  const id = buildCompanyIdentity(undefined, { normalize: normalizeCompany });
  assert.notEqual(id('? (client of Michael Page)'), id('? (client of Q1 Tech)'));
  assert.notEqual(id('? (client of Michael Page)'), '');
});

test('keys for empty and non-string labels are empty, never "undefined" or "null"', () => {
  const id = buildCompanyIdentity({ Fin: ['Intercom'] });
  assert.equal(id(undefined), '');
  assert.equal(id(null), '');
  assert.equal(id(''), '');
  assert.equal(id('   '), '');
});

test('very long labels resolve without blowing up', () => {
  const id = buildCompanyIdentity({ Fin: ['Intercom'] });
  const long = 'x'.repeat(500_000);
  assert.equal(id(`${long} (y)`), long);
});
