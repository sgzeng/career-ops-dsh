import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMustCatch } from '../lib/content-rescue.mjs';

const cfg = { min_distinct: 3, keywords: ['stem:system', 'stem:security', ['property-based testing', 'property based testing'], 'stem:compiler', 'word:ai', 'stem:vulnerab'] };
const mc = buildMustCatch(cfg);

test('three different concepts are caught, in any order and inflection', () => {
  assert.deepEqual(mc('We build AI systems that find vulnerabilities.')?.length, 3);
  assert.ok(mc('Security, compilers and property based testing.'));
  assert.ok(mc('Deep expertise across: systems, security, formal verification, compilers.'), 'the Theorem Systems Engineer JD');
});

test('two concepts, or one concept repeated, are not enough', () => {
  assert.equal(mc('Systems systems systems and security.'), null);
  assert.equal(mc('security and ai only'), null);
});

test('word: and word-start matching do not fire inside other words', () => {
  assert.equal(mc('We maintain the paid chain of custody and a railway.'), null, '"ai" must be a whole word');
  assert.equal(mc('ecosystem, insecurity, decompilers'), null, 'matches start at a word boundary');
});

test('aliases of one concept count once', () => {
  assert.equal(mc('property-based testing and property based testing'), null);
});

test('missing or malformed config disables the rule', () => {
  assert.equal(buildMustCatch(undefined), null);
  assert.equal(buildMustCatch({ keywords: [] }), null);
  assert.equal(buildMustCatch({}), null);
});

import { buildContentRescue } from '../lib/content-rescue.mjs';
test('title-miss path discounts company boilerplate before counting concepts', () => {
  const about = 'About Acme. We build AI systems and take security seriously for every customer we serve. ';
  const body = (t) => about + t + ' '.repeat(5) + 'x'.repeat(500);
  const jobs = [
    { title: 'HR Business Partner', description: body('You will partner with managers on hiring plans.') },
    { title: 'Events Producer', description: body('You will run our conference calendar.') },
    { title: 'Finance Lead', description: body('You will own the budget.') },
    { title: 'Recruiter', description: body('You will source candidates.') },
    { title: 'Office Manager', description: body('You will run the office.') },
    { title: 'Systems Engineer', description: body('Deep expertise in systems, security and compilers is required for this role.') },
  ];
  const rescue = buildContentRescue({ enabled: true, keywords: ['exploit'], must_catch: { min_distinct: 3, keywords: ['stem:system', 'stem:security', 'stem:compiler', 'word:ai'] } }, {}).forCompany(jobs);
  assert.equal(rescue.mustCatch(jobs[0]), null, 'HR role: only the shared About paragraph names the concepts');
  assert.ok(rescue.mustCatch(jobs[5]), 'Systems Engineer names systems, security and compilers in its own sentence');
});
