// saveDeadBoards under concurrent sweeps (ops/daily-scan.sh runs one
// scan-ats-full per ATS directory at once). Each process holds a snapshot taken
// at start and saves several times; no process may erase another's rows, and a
// row a process removed must stay removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeadBoards, saveDeadBoards, recordBoardResult, DEAD_BOARD_HEADER } from '../dead-boards.mjs';

const MODULE = fileURLToPath(new URL('../dead-boards.mjs', import.meta.url));

const WORKER = `
import { loadDeadBoards, saveDeadBoards, recordBoardResult } from ${JSON.stringify(MODULE)};
const [file, ats, count] = process.argv.slice(2);
const rows = loadDeadBoards(file);
for (let i = 0; i < Number(count); i++) {
  recordBoardResult(rows, ats, 'b' + i, 404);
  saveDeadBoards(file, rows);
}
`;

function runWorker(workerFile, file, ats, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerFile, file, ats, String(count)], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${ats} exited ${code}`))));
    child.on('error', reject);
  });
}

test('concurrent saves from different ATS runs keep every run\'s rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dead-boards-'));
  try {
    const file = join(dir, 'dead-boards.tsv');
    const workerFile = join(dir, 'worker.mjs');
    writeFileSync(workerFile, WORKER);
    const ats = ['greenhouse', 'ashby', 'lever'];
    const per = 25;
    await Promise.all(ats.map((a) => runWorker(workerFile, file, a, per)));
    const rows = loadDeadBoards(file);
    for (const a of ats) {
      for (let i = 0; i < per; i++) assert.ok(rows.has(`${a}\tb${i}`), `${a} b${i} was lost`);
    }
    assert.equal(rows.size, ats.length * per);
    assert.deepEqual(readdirSync(dir).sort(), ['dead-boards.tsv', 'worker.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run still removes its own rows and leaves other ATS rows alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dead-boards-'));
  try {
    const file = join(dir, 'dead-boards.tsv');
    const at = '2026-01-01T00:00:00.000Z';
    writeFileSync(file, `${DEAD_BOARD_HEADER}\nashby\ta1\t3\t${at}\ngreenhouse\tg1\t3\t${at}\ngreenhouse\tg2\t1\t${at}\n`);
    const rows = loadDeadBoards(file);
    recordBoardResult(rows, 'greenhouse', 'g1', 200); // the board answered again
    // Another run adds an ashby row after this run took its snapshot.
    writeFileSync(file, `${readFileSync(file, 'utf8')}ashby\ta2\t1\t${at}\n`);
    saveDeadBoards(file, rows);
    const after = loadDeadBoards(file);
    assert.ok(!after.has('greenhouse\tg1'), 'removed row came back');
    assert.ok(after.has('greenhouse\tg2'));
    assert.ok(after.has('ashby\ta1'));
    assert.ok(after.has('ashby\ta2'), 'row written by another run was erased');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
