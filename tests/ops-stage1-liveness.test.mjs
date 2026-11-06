// Fork-local: ops/stage1-liveness.mjs maps check-liveness.mjs verdicts onto
// data/pipeline.md. Pure functions only; no network, no files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingRows, rowsToCheck, parseVerdicts, applyVerdicts, tagActive } from '../ops/stage1-liveness.mjs';

const TODAY = '2026-11-05';
const PIPE = [
  '# Pipeline',
  '',
  '## Pending',
  '',
  '- [ ] https://job-boards.greenhouse.io/a/jobs/1 | A | Dead Role | Arlington, VA',
  '- [ ] https://jobs.ashbyhq.com/b/2 | B | Live Role | note: content-rescue: fuzz',
  '- [ ] https://jobs.lever.co/c/3 | C | Unsure Role',
  '- [ ] https://www.linkedin.com/jobs/view/4484113146 | LI | LI Role',
  '- [x] https://done.example/4 | D | Done',
  '',
  '## Processed',
  '',
  '- [x] #1 | https://example.com/x | X | Y | 4.0/5 | PDF ❌',
].join('\n');

test('LinkedIn rows and rows already checked today are not swept', () => {
  assert.equal(pendingRows(PIPE).length, 4);
  assert.deepEqual(rowsToCheck(PIPE, TODAY).map((r) => r.url), [
    'https://job-boards.greenhouse.io/a/jobs/1', 'https://jobs.ashbyhq.com/b/2', 'https://jobs.lever.co/c/3',
  ]);
  const checked = PIPE.replace('| C | Unsure Role', `| C | Unsure Role | note: liveness active ${TODAY}`);
  assert.equal(rowsToCheck(checked, TODAY).length, 2);
});

test('verdict lines are parsed from check-liveness.mjs output, junk ignored', () => {
  const out = [
    'Checking 3 URL(s)... (throttle ~5-10s)',
    '❌ expired    (api) https://job-boards.greenhouse.io/a/jobs/1',
    '           ATS API 404 — posting removed',
    '✅ active     (api) https://jobs.ashbyhq.com/b/2',
    '⚠️ uncertain        https://jobs.lever.co/c/3',
    'Results: 1 active  1 expired  1 uncertain',
  ].join('\n');
  assert.deepEqual([...parseVerdicts(out)], [
    ['https://job-boards.greenhouse.io/a/jobs/1', 'expired'],
    ['https://jobs.ashbyhq.com/b/2', 'active'],
    ['https://jobs.lever.co/c/3', 'uncertain'],
  ]);
});

test('expired moves to Processed, active is tagged in note:, uncertain is untouched', () => {
  const v = new Map([
    ['https://job-boards.greenhouse.io/a/jobs/1', 'expired'],
    ['https://jobs.ashbyhq.com/b/2', 'active'],
    ['https://jobs.lever.co/c/3', 'uncertain'],
  ]);
  const { text, expired, active } = applyVerdicts(PIPE, v, TODAY);
  assert.deepEqual(expired, ['https://job-boards.greenhouse.io/a/jobs/1']);
  assert.deepEqual(active, ['https://jobs.ashbyhq.com/b/2']);
  const lines = text.split('\n');
  const pendingEnd = lines.indexOf('## Processed');
  assert.ok(!lines.slice(0, pendingEnd).some((l) => l.includes('/a/jobs/1')));
  assert.ok(lines.slice(pendingEnd).includes(
    `- [x] ~~https://job-boards.greenhouse.io/a/jobs/1 | A | Dead Role~~ — posting expired (liveness sweep, stage 1 ${TODAY})`));
  assert.ok(lines.includes(`- [ ] https://jobs.ashbyhq.com/b/2 | B | Live Role | note: content-rescue: fuzz — liveness active ${TODAY}`));
  assert.ok(lines.includes('- [ ] https://jobs.lever.co/c/3 | C | Unsure Role'));
  assert.ok(lines.includes('- [ ] https://www.linkedin.com/jobs/view/4484113146 | LI | LI Role'));
});

test('the tag never adds an unknown labeled segment, and replaces an older date', () => {
  assert.equal(tagActive('- [ ] https://a/1 | A | R', TODAY), `- [ ] https://a/1 | A | R | note: liveness active ${TODAY}`);
  assert.equal(tagActive(`- [ ] https://a/1 | A | R | note: x — liveness active 2026-10-01`, TODAY),
    `- [ ] https://a/1 | A | R | note: x — liveness active ${TODAY}`);
});
