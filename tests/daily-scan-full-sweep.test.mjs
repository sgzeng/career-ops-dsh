// tests/daily-scan-full-sweep.test.mjs — ops/daily-scan.sh: step order, the
// time-limited full-directory sweep, and the opt-out.
//
// The script is run for real, through the same bash launchd uses (/bin/bash,
// 3.2, on macOS), against a throwaway repo whose scan.mjs, scan-ats-full.mjs,
// verify-portals.mjs, ... are stubs that record their argv and can be told to
// fail or hang. So the test pins what the script DOES (order, flags, exit
// lines, time limit, isolation of a failing step), not what it says. Nothing
// here touches the network or the real data directory.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pass, fail, ROOT, rmSync } from './helpers.mjs';

console.log('\nops/daily-scan.sh — full ATS sweep, step order, time limit');

const SCRIPT = join(ROOT, 'ops/daily-scan.sh');
const src = readFileSync(SCRIPT, 'utf-8').replace(/\r\n/g, '\n');

// ── static: the order is the point of the reorder ───────────────────────────

const at = (needle) => src.indexOf(needle);
const order = [
  ['scan.mjs', 'node scan.mjs --since 14'],
  ['verify-portals', 'node verify-portals.mjs'],
  ['discover-ats seed resolution', 'node discover-ats.mjs --in'],
  ['full sweep', 'node scan-ats-full.mjs --ats "$ats"'],
  ['YC/a16z seeds', 'node scan-ats-full.mjs --seeds yc,a16z'],
];
const positions = order.map(([, needle]) => at(needle));
if (positions.every((p) => p > 0) && positions.every((p, i) => i === 0 || p > positions[i - 1])) {
  pass('scan.mjs, verify-portals, seed resolution, full sweep, YC/a16z seeds appear in that order');
} else {
  fail(`step order wrong or a step is missing: ${order.map(([n], i) => `${n}@${positions[i]}`).join(', ')}`);
}
if (/^set -uo pipefail$/m.test(src) && !/^set -[a-z]*e/m.test(src)) {
  pass('keeps `set -uo pipefail` and does not add errexit (one failing step must not end the scan)');
} else {
  fail('daily-scan.sh must keep `set -uo pipefail` and must not set -e');
}

// ── run it for real ─────────────────────────────────────────────────────────

const bash = process.platform === 'darwin' ? '/bin/bash' : 'bash';
const hasBash = process.platform !== 'win32' && spawnSync(bash, ['-c', 'true']).status === 0;
if (!hasBash) {
  pass('behaviour checks skipped: daily-scan.sh is a macOS/Linux script and no bash is available here');
} else {
  const syntax = spawnSync(bash, ['-n', SCRIPT], { encoding: 'utf-8' });
  syntax.status === 0
    ? pass(`${bash} -n accepts the script`)
    : fail(`${bash} -n: ${syntax.stderr}`);

  // One stub per script daily-scan.sh calls. It logs "<name> <argv>" to
  // $STUB_CALLS, hangs when its spec contains a STUB_HANG entry, exits 3 when it
  // contains a STUB_FAIL entry, and sleeps STUB_SLEEP seconds when it contains
  // a STUB_SLOW entry.
  const stubSource = (name) => `import { appendFileSync } from 'node:fs';
const spec = ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ');
appendFileSync(process.env.STUB_CALLS, spec + '\\n');
const hits = (v) => (process.env[v] || '').split(',').filter(Boolean).some((r) => spec.includes(r));
if (hits('STUB_HANG')) await new Promise((r) => setTimeout(r, 60_000));
if (hits('STUB_SLOW')) await new Promise((r) => setTimeout(r, 3_000));
if (hits('STUB_FAIL')) process.exitCode = 3;
console.log('stub ran: ' + spec);
`;

  const work = mkdtempSync(join(tmpdir(), 'daily-scan-'));
  let seq = 0;
  const run = (env = {}) => {
    const repo = join(work, `repo${seq++}`);
    mkdirSync(join(repo, 'ops'), { recursive: true });
    mkdirSync(join(repo, 'data/seeds'), { recursive: true });
    copyFileSync(SCRIPT, join(repo, 'ops/daily-scan.sh'));
    for (const stub of ['validate-portals.mjs', 'scan.mjs', 'verify-portals.mjs', 'discover-ats.mjs', 'scan-ats-full.mjs', 'ops/check-config-regression.mjs']) {
      writeFileSync(join(repo, stub), stubSource(stub.replace(/^ops\//, '')));
    }
    writeFileSync(join(repo, 'data/seeds/s1.yml'), 'companies: []\n');
    writeFileSync(join(repo, 'data/pipeline.md'), '# Pipeline\n\n## Pending\n- [ ] https://a\n- [ ] https://b\n');
    const calls = join(repo, 'calls.log');
    writeFileSync(calls, '');
    const started = Date.now();
    const res = spawnSync(bash, [join(repo, 'ops/daily-scan.sh')], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
        STUB_CALLS: calls,
        CAREER_OPS_FULL_SWEEP: '',
        CAREER_OPS_FULL_SWEEP_ATS: '',
        CAREER_OPS_FULL_SWEEP_SINCE: '',
        CAREER_OPS_FULL_SWEEP_STEP_SECS: '',
        CAREER_OPS_FULL_SWEEP_BUDGET_SECS: '',
        CAREER_OPS_TIMEOUT_IMPL: '',
        STUB_HANG: '',
        STUB_SLOW: '',
        STUB_FAIL: '',
        ...env,
      },
    });
    const logDir = join(repo, 'data/logs');
    const logFile = readdirSync(logDir).find((f) => /^scan-\d{4}-\d{2}-\d{2}\.log$/.test(f));
    return {
      status: res.status,
      elapsed: (Date.now() - started) / 1000,
      calls: readFileSync(calls, 'utf-8').split('\n').filter(Boolean),
      log: logFile ? readFileSync(join(logDir, logFile), 'utf-8') : '',
    };
  };

  try {
    // 1. Default run: order, flags, one header and one exit= line per step.
    const ok = run();
    const expected = [
      'validate-portals.mjs ',
      'check-config-regression.mjs ',
      'scan.mjs --since 14 --quiet',
      'verify-portals.mjs ',
      'discover-ats.mjs --in data/seeds/s1.yml --write --summary',
      'scan-ats-full.mjs --ats greenhouse --since 14',
      'scan-ats-full.mjs --ats ashby --since 14',
      'scan-ats-full.mjs --ats lever --since 14',
      'scan-ats-full.mjs --seeds yc,a16z --since 10',
    ];
    JSON.stringify(ok.calls) === JSON.stringify(expected)
      ? pass('default run: watchlist, health checks and seed resolution first, then greenhouse/ashby/lever sweeps, then the YC/a16z seeds')
      : fail(`default run called ${JSON.stringify(ok.calls)}`);
    const exitLines = [
      /^scan\.mjs exit=0$/m,
      /^verify-portals\.mjs exit=0$/m,
      /^discover-ats\.mjs --in data\/seeds\/s1\.yml exit=0$/m,
      /^scan-ats-full\.mjs --ats greenhouse exit=0 \(\d+s\)$/m,
      /^scan-ats-full\.mjs --ats ashby exit=0 \(\d+s\)$/m,
      /^scan-ats-full\.mjs --ats lever exit=0 \(\d+s\)$/m,
      /^scan-ats-full\.mjs exit=0$/m,
    ];
    exitLines.every((re) => re.test(ok.log))
      ? pass('every step logs its own exit= line; scan.mjs and the seed sweep keep their historical wording')
      : fail(`missing exit= lines in:\n${ok.log}`);
    /^--- node scan-ats-full\.mjs --ats greenhouse --since 14 \(full public greenhouse directory, limit 600s\) ---$/m.test(ok.log)
      ? pass('each sweep prints a header with its time limit (step cap 600s by default)')
      : fail(`sweep header missing:\n${ok.log}`);
    /unprocessed entries ---\n=== done /.test(ok.log) && ok.status === 0
      ? pass('the run ends with the pipeline count and the done line, exit 0')
      : fail(`ending wrong (status ${ok.status}):\n${ok.log}`);

    // 2. Opt-out.
    const off = run({ CAREER_OPS_FULL_SWEEP: '0' });
    (off.calls.every((c) => !c.includes('--ats')) && off.calls.includes('scan-ats-full.mjs --seeds yc,a16z --since 10') && /full ATS sweep: skipped \(CAREER_OPS_FULL_SWEEP=0\)/.test(off.log))
      ? pass('CAREER_OPS_FULL_SWEEP=0 skips the sweep, says so, and still runs the seeds')
      : fail(`opt-out: ${JSON.stringify(off.calls)}\n${off.log}`);

    // 3. A failing sweep blocks nothing.
    const bad = run({ STUB_FAIL: '--ats greenhouse' });
    (/--ats greenhouse exit=3 /.test(bad.log)
      && bad.calls.includes('scan-ats-full.mjs --ats ashby --since 14')
      && bad.calls.includes('scan-ats-full.mjs --ats lever --since 14')
      && bad.calls.includes('scan-ats-full.mjs --seeds yc,a16z --since 10')
      && /=== done /.test(bad.log) && bad.status === 0)
      ? pass('a sweep that exits non-zero is logged and the other directories, the seeds and the summary still run')
      : fail(`failing sweep: status ${bad.status}\n${bad.log}`);

    // 4. Hard time limit, with whatever mechanism this machine has.
    for (const impl of ['auto', 'perl']) {
      if (impl === 'perl' && spawnSync('perl', ['-e', '1']).status !== 0) continue;
      const hung = run({ STUB_HANG: '--ats greenhouse', CAREER_OPS_FULL_SWEEP_STEP_SECS: '2', CAREER_OPS_TIMEOUT_IMPL: impl === 'auto' ? '' : impl });
      const rc = /--ats greenhouse exit=(\d+) /.exec(hung.log)?.[1];
      (['124', '137', '142'].includes(rc ?? '') && /--ats greenhouse: STOPPED at the 2s limit/.test(hung.log)
        && hung.calls.includes('scan-ats-full.mjs --ats lever --since 14') && hung.elapsed < 40)
        ? pass(`a hung sweep is killed at its limit (impl=${impl}, exit=${rc}, ${hung.elapsed.toFixed(1)}s) and the next directory still runs`)
        : fail(`time limit impl=${impl}: rc=${rc} elapsed=${hung.elapsed}\n${hung.log}`);
    }

    // 5. The total budget: a sweep that eats it makes the rest skip.
    const slow = run({ STUB_SLOW: '--ats greenhouse', CAREER_OPS_FULL_SWEEP_BUDGET_SECS: '31' });
    (/limit 31s\) ---/.test(slow.log)
      && /full ATS sweep: ashby skipped \(the 31s budget is used up\)/.test(slow.log)
      && /full ATS sweep: lever skipped/.test(slow.log)
      && !slow.calls.some((c) => c.includes('--ats ashby') || c.includes('--ats lever'))
      && slow.calls.includes('scan-ats-full.mjs --seeds yc,a16z --since 10'))
      ? pass('the budget caps the first sweep and skips the directories it leaves no room for')
      : fail(`budget: ${JSON.stringify(slow.calls)}\n${slow.log}`);

    // 6. Env hygiene: junk numbers fall back, the ATS list and window are honoured.
    const junk = run({ CAREER_OPS_FULL_SWEEP_STEP_SECS: 'abc', CAREER_OPS_FULL_SWEEP_BUDGET_SECS: '0', CAREER_OPS_FULL_SWEEP_SINCE: '-3', CAREER_OPS_FULL_SWEEP_ATS: 'lever' });
    (JSON.stringify(junk.calls.filter((c) => c.includes('--ats'))) === JSON.stringify(['scan-ats-full.mjs --ats lever --since 14'])
      && /limit 600s\) ---/.test(junk.log) && junk.status === 0)
      ? pass('non-numeric or non-positive limits fall back to the defaults; CAREER_OPS_FULL_SWEEP_ATS selects the directories')
      : fail(`env hygiene: ${JSON.stringify(junk.calls)}\n${junk.log}`);

    // 6b. A zero-padded or enormous number is read as decimal, not as octal or
    // overflow: bash would otherwise exit the whole script on "08".
    const padded = run({ CAREER_OPS_FULL_SWEEP_STEP_SECS: '08', CAREER_OPS_FULL_SWEEP_BUDGET_SECS: '0045', CAREER_OPS_FULL_SWEEP_ATS: 'lever' });
    const huge = run({ CAREER_OPS_FULL_SWEEP_BUDGET_SECS: '99999999999999999999', CAREER_OPS_FULL_SWEEP_ATS: 'lever' });
    (/--ats lever --since 14 \(full public lever directory, limit 8s\) ---/.test(padded.log) && padded.status === 0
      && /limit 600s\) ---/.test(huge.log) && huge.calls.includes('scan-ats-full.mjs --seeds yc,a16z --since 10'))
      ? pass('"08" and "0045" are read as decimal (limit 8s, not an arithmetic error), and a 20-digit number falls back to the default')
      : fail(`padded: ${JSON.stringify(padded.calls)}\n${padded.log}\nhuge: ${huge.log}`);

    // 7. No limiter available: runs anyway, says so.
    const none = run({ CAREER_OPS_TIMEOUT_IMPL: 'none', CAREER_OPS_FULL_SWEEP_ATS: 'ashby' });
    (/WARN: no timeout, gtimeout or perl found/.test(none.log) && none.calls.includes('scan-ats-full.mjs --ats ashby --since 14') && /--ats ashby exit=0 /.test(none.log))
      ? pass('without any way to enforce a limit the sweep still runs, with a WARN in the log')
      : fail(`no limiter: ${JSON.stringify(none.calls)}\n${none.log}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
