// Persistent board-existence memory for reverse ATS sweeps (#2840).
// Only a real HTTP 404 may advance a miss counter. Throttles, transport
// failures and DNS errors mean "unknown", never "dead".

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEAD_BOARD_HEADER = 'ats\tboard\tmisses\tlast_checked';
export const DEAD_BOARD_MISSES = 3;
export const DEAD_BOARD_RECHECK_DAYS = 30;

function key(ats, board) { return `${ats}\t${board}`; }

export function loadDeadBoards(file, now = Date.now()) {
  const rows = new Map();
  if (!existsSync(file)) return rows;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    const [ats, board, missesRaw, checked] = line.split('\t');
    const misses = Number(missesRaw);
    const lastChecked = Date.parse(checked || '');
    if (!ats || !board || !Number.isInteger(misses) || misses < 1 || !Number.isFinite(lastChecked)) continue;
    rows.set(key(ats, board), { ats, board, misses, lastChecked, now });
  }
  return rows;
}

export function boardKey(entry) {
  return String(entry?.careers_url || entry?.name || '').trim();
}

/**
 * Whether a board is retired right now.
 *
 * The defaults are the mass-sweep policy (three consecutive 404s, a 30-day
 * window). A caller whose 404 is already conclusive can lower `minMisses`, and
 * one that wants re-probes spread out can make `recheckDays` a function of the
 * row — the seed scan does both (seeds/seed-probe.mjs).
 *
 * @param {Map<string, object>} rows - Dead-board rows from loadDeadBoards().
 * @param {string} ats - Source id.
 * @param {string} board - Board key.
 * @param {number} [now] - Clock, for tests.
 * @param {{ minMisses?: number, recheckDays?: number | ((row: object) => number) }} [policy]
 * @returns {boolean}
 */
export function shouldSkipDeadBoard(rows, ats, board, now = Date.now(), { minMisses = DEAD_BOARD_MISSES, recheckDays = DEAD_BOARD_RECHECK_DAYS } = {}) {
  const row = rows.get(key(ats, board));
  if (!row || row.misses < minMisses) return false;
  const days = typeof recheckDays === 'function' ? recheckDays(row) : recheckDays;
  return now - row.lastChecked < days * 86_400_000;
}

export function recordBoardResult(rows, ats, board, status, now = Date.now()) {
  const rowKey = key(ats, board);
  if (status === 200) {
    rows.delete(rowKey);
    return;
  }
  const previous = rows.get(rowKey);
  if (status !== 404) {
    if (!previous || previous.misses < DEAD_BOARD_MISSES) {
      rows.delete(rowKey);
    } else {
      rows.set(rowKey, { ...previous, lastChecked: now });
    }
    return;
  }
  const misses = Math.min(DEAD_BOARD_MISSES, (previous?.misses || 0) + 1);
  rows.set(rowKey, { ats, board, misses, lastChecked: now });
}

/**
 * Record a failed fetch, given the error instead of a status picked off it.
 *
 * A provider that walks several pages marks its errors with `firstPage`
 * (providers/icims.mjs). `firstPage: false` means the board had already
 * answered its first page with postings when a later request failed, so the
 * board is there whatever that later status was: it is recorded the way a
 * success is. Without this a 404 on page 3 of a live board counted as a miss,
 * and three sweeps of it retired the board for the whole re-probe window.
 *
 * An error without the mark is read as before, by its status.
 *
 * @param {Map<string, object>} rows - Dead-board rows from loadDeadBoards().
 * @param {string} ats - Source id.
 * @param {string} board - Board key from boardKey().
 * @param {unknown} err - What the provider threw.
 * @param {number} [now] - Clock, for tests.
 * @returns {void}
 */
export function recordBoardFailure(rows, ats, board, err, now = Date.now()) {
  recordBoardResult(rows, ats, board, err?.firstPage === false ? 200 : err?.status, now);
}

export function saveDeadBoards(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  const body = [...rows.values()]
    .sort((a, b) => a.ats.localeCompare(b.ats) || a.board.localeCompare(b.board))
    .map((row) => `${row.ats}\t${row.board}\t${row.misses}\t${new Date(row.lastChecked).toISOString()}`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${DEAD_BOARD_HEADER}\n${body.length ? `${body.join('\n')}\n` : ''}`, 'utf8');
  renameSync(tmp, file);
}
