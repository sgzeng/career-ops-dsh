import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCampusTrack } from '../lib/campus-track.mjs';

const cfg = { markers: ['word:PhD'], company_nets: { seed: ['ByteDance', 'TikTok'] } };
const nets = { seed: ['Security', 'word:Safety'] };

test('netGate holds a listed employer to its title net', () => {
  const campus = buildCampusTrack(cfg, Date.now(), nets);
  assert.equal(campus.netGate('ByteDance Seed', 'Research Scientist, PhD, Vision'), false);
  assert.equal(campus.netGate('tiktok', 'PhD Security Engineer'), true);
});

test('netGate leaves other employers and unknown nets alone', () => {
  assert.equal(buildCampusTrack(cfg, Date.now(), nets).netGate('Google', 'PhD Vision Scientist'), true);
  assert.equal(buildCampusTrack(cfg, Date.now(), {}).netGate('ByteDance', 'PhD Vision Scientist'), true);
  assert.equal(buildCampusTrack({ markers: ['word:PhD'] }).netGate('ByteDance', 'PhD Vision Scientist'), true);
});
