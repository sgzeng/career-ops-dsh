import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationFilter, listsUsLocation } from '../scan.mjs';

const cfg = { always_allow: ['United States', 'USA', 'US'], block_hard: ['United Kingdom', 'India'], block: ['London'], block_hard_unless_us_listed: true };

test('multi-location posting that lists a US place survives a block_hard country', () => {
  const f = buildLocationFilter(cfg);
  assert.equal(f('Palo Alto · United States · London · United Kingdom'), true);
  assert.equal(f('San Francisco, CA; London, United Kingdom'), true);
  assert.equal(f('Remote - US; Remote - United Kingdom'), true);
});

test('single-country and non-US postings still die on block_hard', () => {
  const f = buildLocationFilter(cfg);
  assert.equal(f('London · United Kingdom'), false);
  assert.equal(f('Bengaluru, India'), false);
  assert.equal(f('Bengaluru, India · Pune, India'), false);
});

test('without the opt-in flag block_hard behaves as before', () => {
  const f = buildLocationFilter({ ...cfg, block_hard_unless_us_listed: false });
  assert.equal(f('Palo Alto · United States · London · United Kingdom'), false);
});

test('listsUsLocation needs more than one place and a US segment', () => {
  assert.equal(listsUsLocation('palo alto · united states · london · united kingdom'), true);
  assert.equal(listsUsLocation('united states'), false);
  assert.equal(listsUsLocation('london · united kingdom'), false);
  assert.equal(listsUsLocation('berlin · bonus'), false);
});
