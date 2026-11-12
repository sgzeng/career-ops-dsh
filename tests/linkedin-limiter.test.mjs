// tests/linkedin-limiter.test.mjs
//
// lib/linkedin-limiter.mjs: one shared request budget for every LinkedIn guest call.
// No network, no real timers: `now` is a fake clock and `sleep` advances it.
//
// What is being modelled (measured live 2026-11-12): a single stream at a fixed 3.5 s
// ran 120 requests clean; two streams at 3.5 s were blocked at request 91; the first
// recovery probe 90 s after the block already got a 200.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pass, fail, rmSync, ROOT } from './helpers.mjs';

console.log('\nLinkedIn limiter — shared budget and cooldown');

const { acquireLinkedInSlot, reportLinkedInBlock, reportLinkedInOk, LI_GAP_MS, LI_COOLDOWNS_MS } =
  await import(pathToFileURL(join(ROOT, 'lib/linkedin-limiter.mjs')).href);

const check = (cond, msg, detail = '') => (cond ? pass(msg) : fail(`${msg}${detail ? ` — ${detail}` : ''}`));

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; }, get t() { return t; } };
}

const dir = mkdtempSync(join(tmpdir(), 'li-limiter-'));
let n = 0;
const fresh = () => join(dir, `state-${++n}.json`);
const noJitter = { jitter: 0, rand: () => 0.5 };

try {
  // 1. Slots are spaced by the gap, and a caller that arrives early waits for its slot.
  {
    const c = clock(); const file = fresh();
    const a = await acquireLinkedInSlot({ gapMs: 4500, ...noJitter, file, ...c });
    const b = await acquireLinkedInSlot({ gapMs: 4500, ...noJitter, file, ...c });
    const d = await acquireLinkedInSlot({ gapMs: 4500, ...noJitter, file, ...c });
    check(a.waitedMs === 0 && b.waitedMs === 4500 && d.waitedMs === 4500, 'consecutive callers are spaced one gap apart',
      JSON.stringify([a.waitedMs, b.waitedMs, d.waitedMs]));
  }

  // 2. Two callers sharing the file get distinct slots: the aggregate rate is the gap, not 2x.
  {
    const c = clock(); const file = fresh();
    const slotTimes = [];
    // Interleave A and B the way two parser processes would: each asks, then waits.
    for (let i = 0; i < 6; i++) {
      await acquireLinkedInSlot({ gapMs: 4500, ...noJitter, file, ...c });
      slotTimes.push(c.t);
    }
    const gaps = slotTimes.slice(1).map((t, i) => t - slotTimes[i]);
    check(gaps.every((g) => g === 4500), 'six requests from interleaved callers come out one per gap (~13/min), not two per gap', JSON.stringify(gaps));
  }

  // 3. Jitter stays inside +-30% and never below zero.
  {
    const c = clock(); const file = fresh();
    const waits = [];
    for (let i = 0; i < 40; i++) waits.push((await acquireLinkedInSlot({ gapMs: 4500, jitter: 0.3, file, ...c })).waitedMs);
    const body = waits.slice(1);
    check(body.every((w) => w >= 4500 * 0.7 - 1 && w <= 4500 * 1.3 + 1), 'jittered gaps stay within +-30% of the average', `${Math.min(...body)}..${Math.max(...body)}`);
    check(new Set(body).size > 10, 'jitter actually varies the gap');
  }

  // 4. A 429 opens a ~100 s cooldown that the next caller waits out instead of hammering.
  {
    const c = clock(); const file = fresh();
    await acquireLinkedInSlot({ gapMs: 4500, ...noJitter, file, ...c });
    const b = await reportLinkedInBlock({ file, ...c });
    check(b.strikes === 1 && b.cooldownMs === LI_COOLDOWNS_MS[0], 'first block: strike 1, first cooldown', JSON.stringify(b));
    const t0 = c.t;
    const next = await acquireLinkedInSlot({ gapMs: 4500, ...noJitter, file, ...c });
    check(next.ok && c.t - t0 === LI_COOLDOWNS_MS[0], 'the next caller waits the full cooldown', `${c.t - t0}ms`);
  }

  // 5. Two callers hitting the same block within seconds count as ONE strike.
  {
    const c = clock(); const file = fresh();
    const first = await reportLinkedInBlock({ file, ...c });
    c.advance(2000);
    const second = await reportLinkedInBlock({ file, ...c });
    check(first.strikes === 1 && second.strikes === 1, 'the same block reported twice in 2 s is one strike', JSON.stringify([first, second]));
  }

  // 6. A block right after the retry escalates; a clean request resets it.
  {
    const c = clock(); const file = fresh();
    const one = await reportLinkedInBlock({ file, ...c });
    c.advance(one.cooldownMs + 1000);
    const two = await reportLinkedInBlock({ file, ...c });
    check(two.strikes === 2 && two.cooldownMs === LI_COOLDOWNS_MS[1], 'a block after the cooldown escalates to strike 2', JSON.stringify(two));
    c.advance(two.cooldownMs + 1000);
    await reportLinkedInOk({ file, ...c });
    c.advance(1000);
    const again = await reportLinkedInBlock({ file, ...c });
    check(again.strikes === 1, 'a clean request resets the escalation', JSON.stringify(again));
  }

  // 7. A caller refuses to queue behind a cooldown longer than maxWaitMs (no request is made).
  {
    const c = clock(); const file = fresh();
    await reportLinkedInBlock({ file, ...c, cooldownsMs: [400_000] });
    const t0 = c.t;
    const r = await acquireLinkedInSlot({ gapMs: 4500, maxWaitMs: 150_000, file, ...c });
    check(r.ok === false && r.blockedMs > 150_000 && c.t === t0, 'a cooldown longer than maxWaitMs refuses instead of queueing', JSON.stringify(r));
    const later = await acquireLinkedInSlot({ gapMs: 4500, maxWaitMs: 600_000, file, ...c });
    check(later.ok === true, 'a caller with a longer patience still gets through');
  }

  // 8. A stale lock directory does not wedge the limiter.
  {
    const { mkdirSync, utimesSync } = await import('node:fs');
    const file = fresh();
    mkdirSync(`${file}.lock`, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    const r = await acquireLinkedInSlot({ gapMs: 10, jitter: 0, file });
    check(r.ok === true, 'a stale lock (a crashed process) is broken and the request proceeds');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
