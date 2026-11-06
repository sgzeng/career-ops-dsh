// tests/jd-cache.test.mjs — fork-local stage-1 JD cache (lib/jd-cache.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveJdCacheConfig, enrichOffersWithJd, writeJdCaches, jdCacheFileName, isLinkedInUrl, MIN_JD_CHARS,
} from '../lib/jd-cache.mjs';
import { buildVisaFilter } from '../scan.mjs';

const LONG = 'We build fuzzers and program analysis tooling for native code. '.repeat(12);
const cfg = (over = {}) => ({ ...resolveJdCacheConfig({}), linkedinGapMs: 0, gapMs: 0, ...over });
const noSleep = async () => {};

test('config defaults, false, and unsafe dirs', () => {
  assert.equal(resolveJdCacheConfig(undefined).enabled, false, 'opt-in: no block, no cache');
  assert.equal(resolveJdCacheConfig(null).enabled, false);
  const d = resolveJdCacheConfig({});
  assert.equal(d.enabled, true);
  assert.equal(d.dir, 'jds/stage1');
  assert.equal(d.fetchMax, 200);
  assert.equal(d.budgetMs, 300_000);
  assert.equal(resolveJdCacheConfig(false).enabled, false);
  assert.equal(resolveJdCacheConfig({ enabled: false }).enabled, false);
  assert.equal(resolveJdCacheConfig({ dir: '../outside' }).dir, 'jds/stage1');
  assert.equal(resolveJdCacheConfig({ dir: '/etc' }).dir, 'jds/stage1');
  assert.equal(resolveJdCacheConfig({ dir: 'jds/s1/' }).dir, 'jds/s1');
  assert.equal(resolveJdCacheConfig({ fetch_max_per_run: -3 }).fetchMax, 200);
});

test('isLinkedInUrl', () => {
  assert.ok(isLinkedInUrl('https://www.linkedin.com/jobs/view/4467598749'));
  assert.ok(!isLinkedInUrl('https://jobs.ashbyhq.com/x/1'));
  assert.ok(!isLinkedInUrl('not a url'));
});

test('a listing with a full JD is not fetched; a blind one is', async () => {
  const calls = [];
  const offers = [
    { url: 'https://jobs.ashbyhq.com/a/1', company: 'A', title: 'VR', description: LONG },
    { url: 'https://www.linkedin.com/jobs/view/111111', company: 'B', title: 'Fuzzing Eng', description: '' },
  ];
  const { kept, stats } = await enrichOffersWithJd(offers, cfg(), {
    fetchJd: async (u) => { calls.push(u); return LONG; }, sleep: noSleep,
  });
  assert.deepEqual(calls, ['https://www.linkedin.com/jobs/view/111111']);
  assert.equal(kept.length, 2);
  assert.equal(stats.listing, 1);
  assert.equal(stats.fetched, 1);
  assert.equal(kept[1].jdSource, 'fetched');
});

test('a fetched JD that fails the visa gate is dropped, with the verdict', async () => {
  const visa = buildVisaFilter({ enabled: true });
  const offers = [{ url: 'https://www.linkedin.com/jobs/view/222222', company: 'C', title: 'VR', description: '' }];
  const { kept, visaDropped } = await enrichOffersWithJd(offers, cfg(), {
    fetchJd: async () => `${LONG} Applicants must be a U.S. Person as defined under 22 CFR 120.62.`,
    visaFilter: visa, sleep: noSleep,
  });
  assert.equal(kept.length, 0);
  assert.equal(visaDropped.length, 1);
  assert.equal(visaDropped[0].verdict.category, 'citizenship');
});

test('a listing JD is not re-judged here (the scanner loop already did)', async () => {
  let assessed = 0;
  const offers = [{ url: 'https://jobs.ashbyhq.com/a/2', company: 'A', title: 'VR', description: LONG }];
  await enrichOffersWithJd(offers, cfg(), {
    fetchJd: async () => LONG, visaFilter: { assess: () => { assessed++; return { pass: false }; } }, sleep: noSleep,
  });
  assert.equal(assessed, 0);
});

test('LinkedIn stops after three misses in a row; other hosts keep going', async () => {
  const calls = [];
  const offers = [1, 2, 3, 4].map((n) => ({ url: `https://www.linkedin.com/jobs/view/30000${n}`, company: 'L', title: `T${n}` }));
  offers.push({ url: 'https://jobs.lever.co/x/abc', company: 'X', title: 'VR' });
  const { kept, stats } = await enrichOffersWithJd(offers, cfg(), {
    fetchJd: async (u) => { calls.push(u); return u.includes('lever') ? LONG : null; }, sleep: noSleep,
  });
  assert.equal(calls.length, 4, 'the 4th LinkedIn row is not requested');
  assert.ok(calls.at(-1).includes('lever'));
  assert.equal(stats.linkedinStopped, true);
  assert.equal(stats.failed, 3);
  assert.equal(stats.notTried, 1);
  assert.equal(kept.length, 5, 'unread rows are kept, never dropped');
});

test('fetch_max_per_run and the time budget cap the requests', async () => {
  const blind = (n) => ({ url: `https://jobs.lever.co/x/${n}`, company: 'X', title: `T${n}` });
  let calls = 0;
  const r1 = await enrichOffersWithJd([1, 2, 3].map(blind), cfg({ fetchMax: 2 }), {
    fetchJd: async () => { calls++; return LONG; }, sleep: noSleep,
  });
  assert.equal(calls, 2);
  assert.equal(r1.stats.notTried, 1);
  let t = 0;
  const r2 = await enrichOffersWithJd([1, 2, 3].map(blind), cfg({ budgetMs: 1000 }), {
    fetchJd: async () => { t += 600; return LONG; }, sleep: noSleep, now: () => t,
  });
  assert.equal(r2.stats.fetched, 2);
  assert.equal(r2.stats.notTried, 1);
});

test('pacing: the LinkedIn gap is used around LinkedIn requests', async () => {
  const waits = [];
  const offers = [
    { url: 'https://www.linkedin.com/jobs/view/400001', company: 'L', title: 'A' },
    { url: 'https://www.linkedin.com/jobs/view/400002', company: 'L', title: 'B' },
    { url: 'https://jobs.lever.co/x/1', company: 'X', title: 'C' },
    { url: 'https://jobs.lever.co/x/2', company: 'X', title: 'D' },
  ];
  await enrichOffersWithJd(offers, cfg({ linkedinGapMs: 2000, gapMs: 250 }), {
    fetchJd: async () => LONG, sleep: async (ms) => { waits.push(ms); },
  });
  assert.deepEqual(waits, [2000, 2000, 250]);
});

test('writeJdCaches writes one verbatim file per JD and labels every note', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jdcache-'));
  try {
    const offers = [
      { url: 'https://jobs.ashbyhq.com/a/1', company: 'Acme, Inc.', title: 'Vulnerability Researcher', location: 'SF', description: LONG, note: 'campus: x' },
      { url: 'https://www.linkedin.com/jobs/view/5', company: 'B', title: 'T', description: 'short' },
    ];
    const r = writeJdCaches(offers, cfg(), { root, date: '2026-11-05' });
    assert.deepEqual(r, { written: 1, unread: 1 });
    const files = readdirSync(path.join(root, 'jds/stage1'));
    assert.equal(files.length, 1);
    assert.equal(files[0], jdCacheFileName(offers[0], '2026-11-05'));
    assert.match(files[0], /^2026-11-05_acme-inc_vulnerability-researcher_[0-9a-f]{16}\.md$/);
    const body = readFileSync(path.join(root, 'jds/stage1', files[0]), 'utf8');
    assert.ok(body.includes('**URL:** https://jobs.ashbyhq.com/a/1'));
    assert.ok(body.includes('## Job Description (scraped 2026-11-05)'));
    assert.ok(body.includes(LONG.trim()), 'JD text is verbatim');
    assert.equal(offers[0].note, `campus: x — jd: local:jds/stage1/${files[0]}`);
    assert.equal(offers[1].note, 'jd: unread');
    // Idempotent: a second pass neither rewrites the file nor doubles the note.
    const again = writeJdCaches(offers, cfg(), { root, date: '2026-11-05' });
    assert.equal(again.written, 0);
    assert.equal(offers[0].note.match(/jd: /g).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('disabled cache writes nothing and leaves notes alone', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jdcache-'));
  try {
    const offers = [{ url: 'https://x.test/1', company: 'X', title: 'T', description: LONG }];
    assert.deepEqual(writeJdCaches(offers, cfg({ enabled: false }), { root, date: '2026-11-05' }), { written: 0, unread: 0 });
    assert.equal(offers[0].note, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MIN_JD_CHARS matches the visa gate threshold', () => {
  assert.equal(MIN_JD_CHARS, 400);
});
