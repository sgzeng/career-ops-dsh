// lib/linkedin-limiter.mjs — one shared request budget for every LinkedIn guest call (fork-local).
//
// Why this exists (measured 2026-11-12, see ops/README or the commit message):
// LinkedIn's guest endpoints rate-limit per IP on the AGGREGATE request rate, not
// on any one client's cadence. One stream at a fixed 3.5 s survived 120 requests
// (~17/min). Two streams at the same 3.5 s (what scan.mjs does when its two LinkedIn
// parsers run side by side, ~34/min) were blocked at request 91 after 191 s.
// The JD cache adds ~30/min on top (2 s gap), and a 429 made every caller keep
// going or give up on its own, so a block was never waited out.
//
// Every LinkedIn caller (scripts/parsers/linkedin-jobs.mjs, lib/jd-text.mjs,
// liveness-api.mjs) now takes a slot here first. The slots are spaced across ALL
// processes through a small JSON file guarded by an mkdir lock, and a 429 from any
// one of them opens a cooldown that every other caller waits out.
//
// State file: <data root>/data/.linkedin-limiter.json
//   { nextAt, blockedUntil, strikes, lastBlockAt }
// Override the path with CAREER_OPS_LI_LIMITER_FILE (tests).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';

export const LI_GAP_MS = 4500; // ~13 requests/min across all callers, under the ~17/min that ran clean
export const LI_JITTER = 0.3; // +-30%: avoids a metronome, not what keeps us under the limit
export const LI_MAX_WAIT_MS = 10 * 60_000; // longest a caller will queue behind other callers or a cooldown
// Measured 2026-11-12: after a 429 the first recovery probe, 90 s later, already got a 200. So the first
// block waits 100 s and the run carries on; a block right after that escalates (4 min, then 10 min).
export const LI_COOLDOWNS_MS = [100_000, 4 * 60_000, 10 * 60_000];

const LOCK_STALE_MS = 5_000;
const LOCK_GIVE_UP_MS = 4_000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function limiterFile(env = process.env) {
  if (env.CAREER_OPS_LI_LIMITER_FILE) return env.CAREER_OPS_LI_LIMITER_FILE;
  try {
    return path.join(getCareerOpsRoot(), 'data', '.linkedin-limiter.json');
  } catch {
    return path.join(os.tmpdir(), 'career-ops-linkedin-limiter.json');
  }
}

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  } catch { /* the limiter must never break a scan */ }
}

/** Run `fn(state) -> state|undefined` under the cross-process lock. Fails open after a few seconds. */
async function withState(file, fn, { now = Date.now, sleep = defaultSleep } = {}) {
  const lock = `${file}.lock`;
  const began = now();
  let held = false;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.mkdirSync(lock);
      held = true;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') break; // cannot lock at all: proceed unlocked
      try {
        if (now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (now() - began > LOCK_GIVE_UP_MS) break;
      await sleep(10 + Math.floor(Math.random() * 30));
    }
  }
  try {
    const state = readState(file);
    const next = fn(state);
    if (next) writeState(file, next);
    return next || state;
  } finally {
    if (held) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

/**
 * Reserve the next request slot and wait for it.
 * @returns {Promise<{ ok: boolean, waitedMs: number, blockedMs?: number }>}
 *   ok:false means the wait would exceed maxWaitMs (a long cooldown is open): the caller should
 *   treat it like a block and stop, not queue.
 */
export async function acquireLinkedInSlot({
  gapMs = LI_GAP_MS, jitter = LI_JITTER, maxWaitMs = LI_MAX_WAIT_MS,
  file = limiterFile(), now = Date.now, sleep = defaultSleep, rand = Math.random,
} = {}) {
  let waitMs = 0;
  let refused = false;
  await withState(file, (s) => {
    const t = now();
    const slot = Math.max(t, s.nextAt || 0, s.blockedUntil || 0);
    waitMs = slot - t;
    if (waitMs > maxWaitMs) { refused = true; return undefined; }
    const gap = Math.max(0, gapMs * (1 + jitter * (2 * rand() - 1)));
    return { ...s, nextAt: slot + gap };
  }, { now, sleep });
  if (refused) return { ok: false, waitedMs: 0, blockedMs: waitMs };
  if (waitMs > 0) await sleep(waitMs);
  return { ok: true, waitedMs: waitMs };
}

/** A LinkedIn call answered 429/403/999. Opens (or extends) the shared cooldown. */
export async function reportLinkedInBlock({ file = limiterFile(), now = Date.now, sleep = defaultSleep, cooldownsMs = LI_COOLDOWNS_MS } = {}) {
  let result = { cooldownMs: 0, blockedUntil: 0, strikes: 0 };
  await withState(file, (s) => {
    const t = now();
    // Two callers can hit the same block within seconds; that is one strike, not two.
    const sameBlock = s.blockedUntil && t < s.blockedUntil && t - (s.lastBlockAt || 0) < 30_000;
    const strikes = sameBlock ? (s.strikes || 1) : (s.strikes || 0) + 1;
    const cooldownMs = cooldownsMs[Math.min(strikes, cooldownsMs.length) - 1];
    const blockedUntil = sameBlock ? s.blockedUntil : t + cooldownMs;
    result = { cooldownMs: Math.max(0, blockedUntil - t), blockedUntil, strikes };
    return { ...s, strikes, blockedUntil, lastBlockAt: sameBlock ? s.lastBlockAt : t, nextAt: Math.max(s.nextAt || 0, blockedUntil) };
  }, { now, sleep });
  return result;
}

/** A LinkedIn call succeeded: a clean run resets the escalation. */
export async function reportLinkedInOk({ file = limiterFile(), now = Date.now, sleep = defaultSleep } = {}) {
  await withState(file, (s) => ((s.strikes || 0) > 0 ? { ...s, strikes: 0 } : undefined), { now, sleep });
}
