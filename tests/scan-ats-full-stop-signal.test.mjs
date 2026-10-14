// tests/scan-ats-full-stop-signal.test.mjs — a sweep killed at its time limit
// keeps what it found.
//
// ops/daily-scan.sh runs each directory under `timeout` (SIGTERM after 10
// minutes; SIGALRM from the perl fallback). The scanner only wrote pipeline.md
// and scan-history.tsv at the very end, and its SIGTERM handler existed only for
// --json (the web layer) and only printed to stdout — so a CLI run killed at the
// limit lost every match it had found, and the script said so ("its matches were
// not saved"). Now a stop signal appends the matches that already passed every
// filter, exactly once, brings the checkpoint up to date so --resume continues
// from where the run was, and exits the way it would have without a handler.
//
// Each case starts the real scanner in a child process against a scripted host
// whose later boards never answer, sends it the signal, and reads the files.
import { readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.mjs';
import { ghBoard, makeSweepSandbox, runSweep, startSweep, waitFor } from './sweep-harness.mjs';

console.log('\nscan-ats-full — a stop signal flushes the matches found so far, once');

const slug = (i) => `sandbox-${i}`;
const BOARDS = 30;
const FINISHED = 6;                   // boards 0..5 answer; the six workers then stall on boards 6..11
const boardsList = Array.from({ length: BOARDS }, (_, i) => slug(i));
const posting = (i) => ({ id: 7000 + i, title: `Security Engineer ${i}` });
const url = (i) => `https://job-boards.greenhouse.io/${slug(i)}/jobs/${7000 + i}`;
const answered = (n) => Array.from({ length: n }, (_, i) => ghBoard(slug(i), [posting(i)]));
const stalledRules = () => [...answered(FINISHED), { match: 'boards-api\\.greenhouse\\.io', stall: true }];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pendingUrls = (md) => (md ?? '').split('\n').filter((l) => l.startsWith('- [ ]')).map((l) => l.replace(/^- \[ \]\s*/, '').split(/\s+\|\s+/)[0].trim());
const historyUrls = (tsv) => (tsv ?? '').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t')[0]);
const dupes = (list) => list.filter((u, i) => list.indexOf(u) !== i);
const env = { CAREER_OPS_HTTP_TIMEOUT_MS: '60000' };

/** Start a sweep, wait until the six workers are all stalled on a board, hand back the live run. */
async function stalledRun(sb, args = []) {
  const run = startSweep(sb, args, { env });
  const stalled = await waitFor(() => sb.responses().filter((r) => r.status === 'stall').length >= 6);
  if (!stalled) {
    run.child.kill('SIGKILL');
    throw new Error(`the sweep never reached its stall: ${run.out.stderr.slice(0, 400)}`);
  }
  return run;
}

// ── SIGTERM: the limit `timeout` enforces ───────────────────────────────────
{
  const sb = makeSweepSandbox({ boards: boardsList, rules: stalledRules() });
  try {
    const run = await stalledRun(sb);
    run.child.kill('SIGTERM');
    const { code, signal } = await run.exited;
    const expected = Array.from({ length: FINISHED }, (_, i) => url(i)).sort();
    const pending = pendingUrls(sb.read('data/pipeline.md'));
    const history = historyUrls(sb.read('data/scan-history.tsv'));

    if (code === 143 && signal === null) pass('SIGTERM ends the run with status 143, the status it had when no handler existed (and what a perl alarm\'s 142 is to daily-scan.sh)');
    else fail(`SIGTERM exit: code=${code} signal=${signal}\n${run.out.stderr.slice(0, 500)}`);

    if (eq([...pending].sort(), expected) && dupes(pending).length === 0) pass(`the ${FINISHED} matches found before the kill are in pipeline.md, once each`);
    else fail(`pipeline.md after SIGTERM: ${JSON.stringify(pending)}`);
    if (eq([...history].sort(), expected) && dupes(history).length === 0) pass('...and in scan-history.tsv, once each, so the next run does not offer them again');
    else fail(`scan-history.tsv after SIGTERM: ${JSON.stringify(history)}`);

    if (/⏹  SIGTERM: stopped before the sweep finished — 6 matches saved to .*pipeline\.md and scan-history\.tsv — --resume continues at company 6 of greenhouse/.test(run.out.stdout)) {
      pass('the log says what was saved and where --resume continues');
    } else {
      fail(`log line missing:\n${run.out.stdout.slice(-700)}`);
    }

    const cp = JSON.parse(sb.read('data/cache/ats-full-checkpoint.json') ?? 'null');
    if (cp?.current?.name === 'greenhouse' && cp.current.resumeAt === FINISHED && eq(cp.offers, [])
      && !cp.completedSources.includes('greenhouse') && cp.counters.totalCompaniesScanned === FINISHED) {
      pass(`the checkpoint is brought up to date: greenhouse open at board ${FINISHED} (the lowest board still in flight), ${FINISHED} scanned, and no matches in it — they are in the files`);
    } else {
      fail(`checkpoint after SIGTERM: ${JSON.stringify({ current: cp?.current, offers: cp?.offers?.length, counters: cp?.counters })}`);
    }

    // The point of not carrying them in the checkpoint: a later --resume must not append them again.
    sb.setRules(answered(BOARDS));
    sb.clearRequests();
    const resumed = runSweep(sb, ['--resume', '--json']);
    const asked = new Set(sb.requests().map((u) => /boards\/(sandbox-\d+)\//.exec(u)?.[1]).filter(Boolean));
    const everyUrl = Array.from({ length: BOARDS }, (_, i) => url(i)).sort();
    const pending2 = pendingUrls(sb.read('data/pipeline.md'));
    const history2 = historyUrls(sb.read('data/scan-history.tsv'));
    if (resumed.status === 0 && resumed.json?.resumed === true && !asked.has(slug(0)) && !asked.has(slug(FINISHED - 1)) && asked.has(slug(FINISHED)) && asked.has(slug(BOARDS - 1))) {
      pass(`--resume continues from board ${FINISHED}: boards 0-${FINISHED - 1} are not asked again, the rest are`);
    } else {
      fail(`--resume after SIGTERM: status=${resumed.status} resumed=${resumed.json?.resumed} asked0=${asked.has(slug(0))}\n${resumed.stderr.slice(0, 400)}`);
    }
    if (eq([...pending2].sort(), everyUrl) && dupes(pending2).length === 0 && eq([...history2].sort(), everyUrl) && dupes(history2).length === 0) {
      pass(`after --resume all ${BOARDS} matches are in pipeline.md and scan-history.tsv exactly once: nothing lost to the kill, nothing duplicated by the resume`);
    } else {
      fail(`after resume: pending ${pending2.length}, duplicates ${JSON.stringify(dupes(pending2))}, missing ${everyUrl.filter((u) => !pending2.includes(u)).length}`);
    }
  } finally { sb.cleanup(); }
}

// ── the same flush on SIGALRM (the perl fallback's limit) and a second signal ──────────
{
  const sb = makeSweepSandbox({ boards: boardsList, rules: stalledRules() });
  try {
    const run = await stalledRun(sb);
    run.child.kill('SIGALRM');
    const { code } = await run.exited;
    const pending = pendingUrls(sb.read('data/pipeline.md'));
    if (code === 142 && pending.length === FINISHED && dupes(pending).length === 0) pass('SIGALRM (what the perl time limit sends) flushes the same matches and exits 142, which daily-scan.sh already reads as "stopped at the limit"');
    else fail(`SIGALRM: code=${code} pending=${pending.length}\n${run.out.stderr.slice(0, 400)}`);
  } finally { sb.cleanup(); }
}
{
  const sb = makeSweepSandbox({ boards: boardsList, rules: stalledRules() });
  try {
    const run = await stalledRun(sb);
    run.child.kill('SIGTERM');
    run.child.kill('SIGTERM');
    await run.exited;
    const pending = pendingUrls(sb.read('data/pipeline.md'));
    const history = historyUrls(sb.read('data/scan-history.tsv'));
    if (pending.length === FINISHED && dupes(pending).length === 0 && history.length === FINISHED && dupes(history).length === 0) {
      pass('two signals in a row still write the matches once (the second is ignored while the first is flushing)');
    } else {
      fail(`double signal: pending=${pending.length} history=${history.length}`);
    }
  } finally { sb.cleanup(); }
}

// ── --dry-run writes nothing; --json keeps its contract ─────────────────────────
{
  const sb = makeSweepSandbox({ boards: boardsList, rules: stalledRules() });
  try {
    const run = await stalledRun(sb, ['--dry-run']);
    run.child.kill('SIGTERM');
    const { code } = await run.exited;
    const wrote = ['data/pipeline.md', 'data/scan-history.tsv', 'data/cache/ats-full-checkpoint.json', 'data/dead-boards.tsv'].filter((f) => sb.read(f) !== null);
    if (code === 143 && wrote.length === 0 && /dry run — nothing written/.test(run.out.stdout)) pass('a --dry-run killed mid-sweep writes nothing at all, and says so');
    else fail(`dry-run SIGTERM: code=${code} wrote=${JSON.stringify(wrote)}\n${run.out.stdout.slice(-300)}`);
  } finally { sb.cleanup(); }
}
{
  // The web layer runs `--json --dry-run` and SIGTERMs at its budget: a well-formed partial result, exit 0.
  const sb = makeSweepSandbox({ boards: boardsList, rules: stalledRules() });
  try {
    const run = await stalledRun(sb, ['--json', '--dry-run']);
    run.child.kill('SIGTERM');
    const { code } = await run.exited;
    let parsed = null;
    try { parsed = JSON.parse(run.out.stdout); } catch { /* reported below */ }
    if (code === 0 && parsed?.stoppedEarly === true && parsed.stoppedBySignal === 'SIGTERM' && parsed.postingsKept === FINISHED
      && parsed.offers.length === FINISHED && parsed.saved === false && sb.read('data/pipeline.md') === null) {
      pass('--json --dry-run (the web layer): exit 0 and one partial JSON object on stdout with the matches found, nothing written');
    } else {
      fail(`json dry-run SIGTERM: code=${code} parsed=${JSON.stringify(parsed)?.slice(0, 300)}`);
    }
  } finally { sb.cleanup(); }
}
{
  // --json without --dry-run saves like a finished --json run does.
  const sb = makeSweepSandbox({ boards: boardsList, rules: stalledRules() });
  try {
    const run = await stalledRun(sb, ['--json']);
    run.child.kill('SIGTERM');
    const { code } = await run.exited;
    let parsed = null;
    try { parsed = JSON.parse(run.out.stdout); } catch { /* reported below */ }
    const pending = pendingUrls(sb.read('data/pipeline.md'));
    if (code === 0 && parsed?.saved === true && pending.length === FINISHED && dupes(pending).length === 0) pass('--json without --dry-run saves the partial matches too, and reports saved: true');
    else fail(`json SIGTERM: code=${code} saved=${parsed?.saved} pending=${pending.length}`);
  } finally { sb.cleanup(); }
}

// ── a run that finishes normally is untouched, and its handler leaves the matches alone ───────
{
  const sb = makeSweepSandbox({ boards: boardsList.slice(0, 10), rules: answered(10) });
  try {
    const r = runSweep(sb, ['--json']);
    const pending = pendingUrls(sb.read('data/pipeline.md'));
    if (r.status === 0 && r.json?.saved === true && pending.length === 10 && dupes(pending).length === 0 && sb.read('data/cache/ats-full-checkpoint.json') === null) {
      pass('a sweep that finishes on its own writes its matches once and leaves no checkpoint (the single persist path is shared)');
    } else {
      fail(`normal finish: status=${r.status} saved=${r.json?.saved} pending=${pending.length}`);
    }
  } finally { sb.cleanup(); }
}

// ── the script that sends the signal knows matches survive it ─────────────────────────────────
{
  const script = readFileSync(join(ROOT, 'ops/daily-scan.sh'), 'utf-8');
  if (!/matches were not saved/.test(script) && /STOPPED at the \$\{limit\}s limit/.test(script)) pass('ops/daily-scan.sh no longer tells the operator a killed directory\'s matches were lost');
  else fail('ops/daily-scan.sh still claims a killed sweep saves nothing');
}
