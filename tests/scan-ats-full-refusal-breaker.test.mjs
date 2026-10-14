// tests/scan-ats-full-refusal-breaker.test.mjs — the full-directory sweep stops
// asking a host that keeps answering 429/403, and says so.
//
// The sweep used to meet a throttled host the way it meets a dead one: the
// greenhouse/lever providers do not retry, so every refused board was a
// separate "unreachable" board, the next board was asked at once, and a run
// that was being refused for ~8.7k requests ended with one number and matches
// silently missing. The seed scan already had the mechanism (createHostGate);
// the sweep now reuses it, keyed by source.
//
// Part 1 drives the gate and runGuarded() in-process with an injected clock: the
// pause, the Retry-After it honours, the reset on a 404, the abandon. Part 2 runs
// the whole scanner in a child process against a scripted `fetch` (see
// tests/sweep-harness.mjs): what the operator sees, what lands on disk, and that
// --resume picks the run up without losing or repeating a match.
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from './helpers.mjs';
import { ghBoard, makeSweepSandbox, runSweep } from './sweep-harness.mjs';

console.log('\nscan-ats-full — refusal breaker for the directory sweep');

const full = await import(pathToFileURL(join(ROOT, 'scan-ats-full.mjs')).href);
const { SWEEP_REFUSAL_LIMIT, SOURCES, createSweepGate, createSourceGate, runGuarded, resolveSweepCooldown } = full;

const httpErr = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Part 1: the gate, in-process ──────────────────────────────────────────

if (SWEEP_REFUSAL_LIMIT === 25) pass('the sweep abandons a source after 25 refusals in a row (the seed scan\'s 10 is crossed by its second round of six workers)');
else fail(`SWEEP_REFUSAL_LIMIT is ${SWEEP_REFUSAL_LIMIT}`);

{
  const d = resolveSweepCooldown({});
  const e = resolveSweepCooldown({ CAREER_OPS_SWEEP_COOLDOWN_MS: '20', CAREER_OPS_SWEEP_COOLDOWN_MAX_MS: '60' });
  const junk = resolveSweepCooldown({ CAREER_OPS_SWEEP_COOLDOWN_MS: 'soon', CAREER_OPS_SWEEP_COOLDOWN_MAX_MS: '-1' });
  const inverted = resolveSweepCooldown({ CAREER_OPS_SWEEP_COOLDOWN_MS: '500', CAREER_OPS_SWEEP_COOLDOWN_MAX_MS: '100' });
  if (eq(d, { cooldownBaseMs: 15_000, cooldownMaxMs: 120_000 }) && eq(e, { cooldownBaseMs: 20, cooldownMaxMs: 60 })
    && eq(junk, d) && inverted.cooldownMaxMs >= inverted.cooldownBaseMs) {
    pass('back-off defaults to 15s doubling to 120s, is tunable by env, and falls back on junk instead of failing a scan');
  } else {
    fail(`resolveSweepCooldown: ${JSON.stringify({ d, e, junk, inverted })}`);
  }
}

/** A gate with a recording clock that never actually waits. */
function newGate(env = {}) {
  const sleeps = [];
  const abandons = [];
  const gate = createSweepGate({
    sleep: async (ms) => { sleeps.push(ms); },
    onAbandon: (key, cls, count) => abandons.push({ key, cls, count }),
    env,
  });
  return { gate, sleeps, abandons };
}

// A single 429 pauses (it does not abort), for as long as the host said.
{
  const { gate, sleeps, abandons } = newGate();
  let calls = 0;
  const result = await runGuarded(gate, 'greenhouse', async () => {
    calls += 1;
    if (calls === 1) throw httpErr(429, { retryAfter: '7' });
    return ['board'];
  });
  if (eq(result, ['board']) && calls === 2 && eq(sleeps, [7000]) && abandons.length === 0) {
    pass('a single 429 pauses the source for the Retry-After it sent (7s), and the refused board is asked once more instead of lost');
  } else {
    fail(`single 429: result=${JSON.stringify(result)} calls=${calls} sleeps=${JSON.stringify(sleeps)} abandons=${abandons.length}`);
  }
}
{
  const { gate, sleeps } = newGate();
  let calls = 0;
  await runGuarded(gate, 'greenhouse', async () => {
    calls += 1;
    if (calls === 1) throw httpErr(403, { retryAfter: '3600' });
    return [];
  });
  if (eq(sleeps, [120_000])) pass('a Retry-After longer than the run can wait is capped at 120s (and a 403 pauses like a 429)');
  else fail(`capped Retry-After: ${JSON.stringify(sleeps)}`);
}
{
  const { gate, sleeps } = newGate();
  let calls = 0;
  await runGuarded(gate, 'greenhouse', async () => {
    calls += 1;
    if (calls === 1) throw httpErr(429);
    return [];
  });
  if (eq(sleeps, [15_000])) pass('with no Retry-After the first pause is 15s');
  else fail(`default pause: ${JSON.stringify(sleeps)}`);
}

// Only a directory behind ONE host has a breaker: a 403 from one Workday tenant says nothing about the next one
// (3 of 25 tenants in a live sample answered 403 to everything), so a source-wide pause would stall the sweep for each.
{
  const single = ['greenhouse', 'lever', 'ashby'].every((n) => createSourceGate(SOURCES[n]) !== null);
  const perTenant = ['workday', 'icims', 'bamboohr'].every((n) => createSourceGate(SOURCES[n]) === null);
  let calls = 0;
  let thrown = null;
  try { await runGuarded(null, 'workday', async () => { calls += 1; throw httpErr(403); }); } catch (e) { thrown = e; }
  if (single && perTenant && thrown?.status === 403 && calls === 1) {
    pass('greenhouse, lever and ashby get a breaker; workday, icims and bamboohr (a host per tenant) get none, and a 403 there is thrown as is, asked once');
  } else {
    fail(`source gates: single=${single} perTenant=${perTenant} calls=${calls} thrown=${thrown?.status}`);
  }
}

// Not a refusal → not retried, not paused.
for (const err of [httpErr(404), httpErr(500), Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })]) {
  const { gate, sleeps } = newGate();
  let calls = 0;
  try {
    await runGuarded(gate, 'greenhouse', async () => { calls += 1; throw err; });
    fail('a failing call returned');
  } catch (e) {
    if (e === err && calls === 1 && sleeps.length === 0) pass(`${err.status ?? 'network error'}: thrown as is, asked once, no pause`);
    else fail(`non-refusal ${err.status}: calls=${calls} sleeps=${JSON.stringify(sleeps)}`);
  }
}

// N refusals in a row abandon the source, and not one request more.
{
  const { gate, abandons } = newGate({ CAREER_OPS_SWEEP_COOLDOWN_MS: '0', CAREER_OPS_SWEEP_COOLDOWN_MAX_MS: '0' });
  let asked = 0;
  const outcomes = [];
  for (let board = 0; board < 40; board += 1) {
    try {
      await runGuarded(gate, 'greenhouse', async () => { asked += 1; throw httpErr(429); });
      outcomes.push('ok');
    } catch (e) {
      outcomes.push(e.hostAbandoned ? 'skipped' : `refused:${e.status}`);
    }
  }
  const tipper = outcomes.findIndex((o) => o === 'refused:429' && outcomes.indexOf('skipped') > outcomes.indexOf(o));
  if (asked === SWEEP_REFUSAL_LIMIT && abandons.length === 1 && eq(abandons[0], { key: 'greenhouse', cls: '429', count: SWEEP_REFUSAL_LIMIT })
    && outcomes.includes('skipped') && gate.isAbandoned('greenhouse')) {
    pass(`${SWEEP_REFUSAL_LIMIT} consecutive 429s abandon the source exactly once; exactly ${SWEEP_REFUSAL_LIMIT} requests were made and the rest were never asked`);
  } else {
    fail(`abandon: asked=${asked} abandons=${JSON.stringify(abandons)} outcomes=${outcomes.join(',')}`);
  }
  const lastRefused = outcomes.lastIndexOf('refused:429');
  if (lastRefused >= 0 && outcomes[lastRefused + 1] === 'skipped') {
    pass('the board whose refusal tipped the breaker reports its own 429 (it was asked); only later boards are "skipped"');
  } else {
    fail(`tipping board: ${outcomes.slice(Math.max(0, lastRefused - 2), lastRefused + 3).join(',')} (tipper index ${tipper})`);
  }
}

// A 404 proves the host is answering: it resets the count. A success does too.
for (const [label, answer] of [['a 404', () => { throw httpErr(404); }], ['a success', async () => []]]) {
  const { gate, abandons } = newGate({ CAREER_OPS_SWEEP_COOLDOWN_MS: '0', CAREER_OPS_SWEEP_COOLDOWN_MAX_MS: '0' });
  const refuse = async () => { throw httpErr(429); };
  // 24 refusals (12 boards × 2 attempts), the reset, 24 more: 48 in all, never 25 in a row.
  for (let i = 0; i < 12; i += 1) await runGuarded(gate, 'greenhouse', refuse).catch(() => {});
  await runGuarded(gate, 'greenhouse', answer).catch(() => {});
  for (let i = 0; i < 12; i += 1) await runGuarded(gate, 'greenhouse', refuse).catch(() => {});
  if (abandons.length === 0 && !gate.isAbandoned('greenhouse')) pass(`${label} resets the consecutive count: 24 refusals, ${label}, 24 refusals does not abandon`);
  else fail(`${label} did not reset: ${JSON.stringify(abandons)}`);
}
{
  // The same shape with a 5xx in the middle: a 5xx neither resets nor adds, so 24 + 1 refusals abandon.
  const { gate, abandons } = newGate({ CAREER_OPS_SWEEP_COOLDOWN_MS: '0', CAREER_OPS_SWEEP_COOLDOWN_MAX_MS: '0' });
  const refuse = async () => { throw httpErr(429); };
  for (let i = 0; i < 12; i += 1) await runGuarded(gate, 'greenhouse', refuse).catch(() => {});
  await runGuarded(gate, 'greenhouse', async () => { throw httpErr(503); }).catch(() => {});
  await runGuarded(gate, 'greenhouse', refuse).catch(() => {});
  if (abandons.length === 1) pass('a 5xx leaves the count alone: it neither resets it nor counts toward it');
  else fail(`5xx in the middle: ${JSON.stringify(abandons)}`);
}
{
  // Sources are independent: one abandoned source does not close another.
  const { gate } = newGate({ CAREER_OPS_SWEEP_COOLDOWN_MS: '0', CAREER_OPS_SWEEP_COOLDOWN_MAX_MS: '0' });
  for (let i = 0; i < 30; i += 1) await runGuarded(gate, 'greenhouse', async () => { throw httpErr(429); }).catch(() => {});
  const other = await runGuarded(gate, 'lever', async () => 'ok');
  if (gate.isAbandoned('greenhouse') && !gate.isAbandoned('lever') && other === 'ok') pass('the breaker is per source: greenhouse abandoned, lever untouched');
  else fail('sources share breaker state');
}

// ── Part 2: the whole scanner against a scripted host ───────────────────────

const slug = (i) => `sandbox-${i}`;
const posting = (i) => ({ id: 5000 + i, title: `Security Engineer ${i}` });
const HEALTHY = 8;       // boards 0..7 answer; everything from board 8 is refused
const BOARDS = 80;
const boardsList = Array.from({ length: BOARDS }, (_, i) => slug(i));
const healthyRules = (n) => Array.from({ length: n }, (_, i) => ghBoard(slug(i), [posting(i)]));
const refuseAll = { match: 'boards-api\\.greenhouse\\.io', status: 429, headers: { 'retry-after': '0' } };
const refusedRequests = (sb, from) => sb.requests().filter((u) => {
  const m = /v1\/boards\/sandbox-(\d+)\/jobs/.exec(u);
  return m && Number(m[1]) >= from;
});
const pendingUrls = (md) => (md ?? '').split('\n').filter((l) => l.startsWith('- [ ]')).map((l) => l.replace(/^- \[ \]\s*/, '').split(/\s+\|\s+/)[0].trim());
const historyUrls = (tsv) => (tsv ?? '').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t')[0]);
const dupes = (list) => list.filter((u, i) => list.indexOf(u) !== i);

// one 429 in the middle of a healthy sweep: pause, ask again, nothing lost
{
  const sb = makeSweepSandbox({
    boards: boardsList.slice(0, 10),
    // board 3's first request is refused (the listing); every later one is answered.
    rules: [
      { match: `v1/boards/${slug(3)}/jobs`, status: 429, headers: { 'retry-after': '0' }, limit: 1 },
      ...healthyRules(10),
    ],
  });
  try {
    const r = runSweep(sb, ['--json', '--dry-run']);
    const j = r.json;
    const asked3 = sb.requests().filter((u) => u.includes(`/${slug(3)}/`)).length;
    if (r.status === 0 && j && j.postingsKept === 10 && j.unreachableBoards === 0 && j.stoppedByRefusals === false
      && j.sweep.greenhouse.throttledResponses === 1 && asked3 === 3 && eq(j.abandonedSources, [])) {
      pass('one 429 mid-sweep: the source pauses, the refused board is asked again, all 10 matches arrive and nothing is reported unreachable');
    } else {
      fail(`single 429 sweep: status=${r.status} kept=${j?.postingsKept} unreachable=${j?.unreachableBoards} throttled=${j?.sweep?.greenhouse?.throttledResponses} asked3=${asked3}\n${r.stderr.slice(0, 600)}`);
    }
  } finally { sb.cleanup(); }
}

// a host that refuses everything from board 8 on
{
  const sb = makeSweepSandbox({
    boards: boardsList,
    rules: [
      { match: `v1/boards/${slug(3)}/jobs`, status: 404 },      // one genuinely dead board among the healthy ones
      ...healthyRules(HEALTHY),
      refuseAll,
    ],
  });
  try {
    const r = runSweep(sb, []);
    const out = r.stdout;
    const stoppedLine = /⛔ stopped greenhouse: (\d+) consecutive HTTP 429 \(last refused board: (sandbox-\d+)\); ([\d,]+) of 80 boards scanned; rerun later or with --resume\./.exec(out);
    // The count that matters is the unbroken run of refusals at the end of the log: the last
    // 200/404 the host gave ended the previous run, so everything after it is what the breaker
    // allowed. Exactly SWEEP_REFUSAL_LIMIT tripped it; the other workers had already sent theirs.
    const answered = sb.responses();
    let trailing = 0;
    while (trailing < answered.length && answered[answered.length - 1 - trailing].status === '429') trailing += 1;
    if (r.status === 0 && stoppedLine && Number(stoppedLine[1]) === SWEEP_REFUSAL_LIMIT) {
      pass(`the run says it loudly and exits 0 like the DNS breaker does: "${stoppedLine[0].slice(0, 110)}..."`);
    } else {
      fail(`stop line / exit: status=${r.status} line=${stoppedLine?.[0]}\n${out.slice(0, 1500)}`);
    }
    if (trailing >= SWEEP_REFUSAL_LIMIT && trailing <= SWEEP_REFUSAL_LIMIT + 5) {
      pass(`after the host's last good answer it was asked ${trailing} more times and refused every one: the limit (${SWEEP_REFUSAL_LIMIT}) plus the workers already in flight, not the remaining ${BOARDS - HEALTHY} boards`);
    } else {
      fail(`unbroken refusals at the end of the log: ${trailing}`);
    }
    const refused = refusedRequests(sb, HEALTHY);
    if (refused.length >= trailing && refused.length < 2 * (BOARDS - HEALTHY)) pass(`in all ${refused.length} requests went to boards the host refused, well under what asking all ${BOARDS - HEALTHY} of them (twice, with the retry) would have cost`);
    else fail(`requests to refused boards: ${refused.length}`);

    // the scan-summary block: "Unreachable boards" stays parseable, the breakdown and the stop are in it
    const summary = out.slice(out.indexOf('::career-ops:scan-summary::'));
    const unreachable = /Unreachable boards:\s+(\d+)/.exec(summary);
    const byCause = /sweep boards:\s+404 (\d+) \| 403 (\d+) \| 429 (\d+) \| 5xx (\d+) \| timeout\/network (\d+) \| other (\d+)/.exec(summary);
    const stoppedSummary = /⛔ Stopped early:\s+greenhouse — 25 consecutive HTTP 429 .* not recorded as dead; rerun later or with --resume/.exec(summary);
    if (unreachable && byCause && Number(byCause[1]) === 1 && Number(byCause[3]) >= 1 && Number(byCause[2]) === 0
      && Number(unreachable[1]) === Number(byCause[1]) + Number(byCause[3])
      && stoppedSummary && /Companies scanned:\s+\d+/.test(summary) && /New matches:\s+7/.test(summary)) {
      pass('the summary block keeps "Unreachable boards: N" (N = 404s + 429s), splits it by cause (404 1, 403 0, 429 n), names the stopped source, and reports 7 matches');
    } else {
      fail(`summary block:\n${summary.slice(0, 1800)}`);
    }

    // matches found before the throttle are written; refused and skipped boards are not remembered as dead
    const pending = pendingUrls(sb.read('data/pipeline.md'));
    const history = historyUrls(sb.read('data/scan-history.tsv'));
    const expected = [0, 1, 2, 4, 5, 6, 7].map((i) => `https://job-boards.greenhouse.io/${slug(i)}/jobs/${5000 + i}`).sort();
    if (eq([...pending].sort(), expected) && eq([...history].sort(), expected)) {
      pass('the 7 matches found before the throttle are in pipeline.md and scan-history.tsv, once each');
    } else {
      fail(`persisted matches: pipeline=${JSON.stringify(pending)} history=${JSON.stringify(history)}`);
    }
    const dead = (sb.read('data/dead-boards.tsv') ?? '').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t'));
    if (dead.length === 1 && dead[0][1].endsWith(`/${slug(3)}`) && dead[0][2] === '1') {
      pass('dead-boards.tsv holds only the genuine 404 (board 3, one miss): no refused board and none of the skipped ones is remembered as dead');
    } else {
      fail(`dead-boards.tsv: ${JSON.stringify(dead)}`);
    }

    // the checkpoint --resume needs
    const cp = JSON.parse(sb.read('data/cache/ats-full-checkpoint.json') ?? 'null');
    if (cp && cp.current?.name === 'greenhouse' && !cp.completedSources.includes('greenhouse')
      && Number.isInteger(cp.current.resumeAt) && cp.current.resumeAt <= HEALTHY && cp.current.datasetLen === BOARDS) {
      pass(`the checkpoint keeps greenhouse open at board ${cp.current.resumeAt}: at or below the first refused board (${HEALTHY}), so --resume cannot skip one`);
    } else {
      fail(`checkpoint: ${JSON.stringify(cp?.current)} completed=${JSON.stringify(cp?.completedSources)}`);
    }
    if (cp && eq(cp.offers, [])) pass('matches already written are not also carried in the checkpoint (a --resume would append them twice)');
    else fail(`checkpoint still holds ${cp?.offers?.length} offers`);
    // The refused boards are read again by --resume, so the checkpoint keeps only what stays true:
    // the one genuine 404, and a scanned count that stops at the resume point.
    if (cp?.counters?.sweepUnreachable?.['404'] === 1 && cp.counters.sweepUnreachable['429'] === 0 && cp.counters.totalErrors === 1
      && cp.counters.totalCompaniesScanned === cp.current.resumeAt) {
      pass('the checkpoint does not keep the refused boards as unreachable or as scanned (--resume reads them again): 1 error (the 404), scanned = the resume point');
    } else {
      fail(`checkpoint counters: ${JSON.stringify(cp?.counters)} resumeAt=${cp?.current?.resumeAt}`);
    }

    // --resume: the host recovers; every board the first run did not read is read, nothing is repeated
    sb.setRules([{ match: `v1/boards/${slug(3)}/jobs`, status: 404 }, ...healthyRules(BOARDS)]);
    sb.clearRequests();
    const r2 = runSweep(sb, ['--resume', '--json']);
    const asked = new Set(sb.requests().map((u) => /v1\/boards\/(sandbox-\d+)\//.exec(u)?.[1]).filter(Boolean));
    const resumeAt = cp?.current?.resumeAt ?? BOARDS;
    const mustAsk = Array.from({ length: BOARDS - HEALTHY }, (_, k) => slug(HEALTHY + k));
    const pending2 = pendingUrls(sb.read('data/pipeline.md'));
    const all = Array.from({ length: BOARDS }, (_, i) => i).filter((i) => i !== 3)
      .map((i) => `https://job-boards.greenhouse.io/${slug(i)}/jobs/${5000 + i}`).sort();
    if (r2.status === 0 && r2.json?.resumed === true && mustAsk.every((b) => asked.has(b)) && !asked.has(slug(0))) {
      pass(`--resume asks every board the first run did not read (${slug(HEALTHY)}..${slug(BOARDS - 1)}) and none of the ${resumeAt} it had finished`);
    } else {
      fail(`--resume: status=${r2.status} resumed=${r2.json?.resumed} asked-board-0=${asked.has(slug(0))} missing=${mustAsk.filter((b) => !asked.has(b)).slice(0, 5)}\n${r2.stderr.slice(0, 500)}`);
    }
    if (eq([...pending2].sort(), all) && dupes(pending2).length === 0 && dupes(historyUrls(sb.read('data/scan-history.tsv'))).length === 0) {
      pass(`after --resume pipeline.md and scan-history.tsv hold all ${all.length} matches exactly once: none lost to the throttle, none repeated`);
    } else {
      fail(`after resume: ${pending2.length} pending, duplicates ${JSON.stringify(dupes(pending2))}, missing ${all.filter((u) => !pending2.includes(u)).length}`);
    }
    if (r2.json?.companiesScanned === BOARDS && r2.json.unreachableBoards === 1 && r2.json.unreachableByCause['404'] === 1 && r2.json.unreachableByCause['429'] === 0) {
      pass(`the resumed run's totals add up: ${BOARDS} companies scanned across both runs, 1 unreachable board (the 404), none of the boards that were refused once`);
    } else {
      fail(`resumed totals: scanned=${r2.json?.companiesScanned} unreachable=${r2.json?.unreachableBoards} byCause=${JSON.stringify(r2.json?.unreachableByCause)}`);
    }
    if (!sb.read('data/cache/ats-full-checkpoint.json')) pass('a resumed sweep that finishes deletes its checkpoint');
    else fail('a finished resumed sweep left its checkpoint behind');
  } finally { sb.cleanup(); }
}

// --json says what stopped it and how far it got
{
  const sb = makeSweepSandbox({ boards: boardsList, rules: [...healthyRules(HEALTHY), refuseAll] });
  try {
    const r = runSweep(sb, ['--json', '--dry-run']);
    const j = r.json;
    const a = j?.abandonedSources?.[0];
    if (r.status === 0 && j?.stoppedByRefusals === true && j.stoppedByOutage === false && a?.source === 'greenhouse'
      && a.class === '429' && a.consecutive === SWEEP_REFUSAL_LIMIT && a.boardsTotal === BOARDS
      && a.boardsScanned <= HEALTHY && a.boardsNotAsked > 0 && a.checkpointed === false
      && j.unreachableByCause['429'] >= 1 && j.unreachableByCause['404'] === 0 && j.boardsNotAsked === a.boardsNotAsked
      && j.sweep.greenhouse.abandoned?.class === '429') {
      pass('--json carries stoppedByRefusals, abandonedSources (class, consecutive, boards scanned/total/not asked), unreachableByCause and the per-source sweep stats');
    } else {
      fail(`--json: ${JSON.stringify({ stoppedByRefusals: j?.stoppedByRefusals, a, byCause: j?.unreachableByCause })}\n${r.stderr.slice(0, 500)}`);
    }
    const dry = sb.read('data/cache/ats-full-checkpoint.json') === null && sb.read('data/pipeline.md') === null && sb.read('data/dead-boards.tsv') === null;
    if (dry && j.saved === false && a.checkpointed === false) pass('--dry-run reports the stop identically but writes no checkpoint, pipeline, history or dead-board file');
    else fail('--dry-run wrote files after a refusal stop');
    if (/⛔ stopped greenhouse: 25 consecutive HTTP 429/.test(r.stderr)) pass('under --json the loud line goes to stderr, so stdout stays the single JSON object');
    else fail(`--json stderr: ${r.stderr.slice(0, 400)}`);
  } finally { sb.cleanup(); }
}

// 404s between refusals keep a sweep alive; take them away and it stops.
{
  const patterned = (every) => {
    const rules = [];
    for (let i = 0; i < BOARDS; i += 1) {
      rules.push(every && i % every === every - 1
        ? { match: `v1/boards/${slug(i)}/jobs`, status: 404 }
        : { match: `v1/boards/${slug(i)}/jobs`, status: 429, headers: { 'retry-after': '0' } });
    }
    return rules;
  };
  const withDead = makeSweepSandbox({ boards: boardsList, rules: patterned(5) });
  const without = makeSweepSandbox({ boards: boardsList, rules: patterned(0) });
  try {
    const a = runSweep(withDead, ['--json', '--dry-run']).json;
    const b = runSweep(without, ['--json', '--dry-run']).json;
    const askedA = new Set(withDead.requests().map((u) => /boards\/(sandbox-\d+)\//.exec(u)?.[1]));
    if (a && a.stoppedByRefusals === false && askedA.size === BOARDS && a.unreachableByCause['404'] === BOARDS / 5) {
      pass(`a 404 every fifth board (four refused boards between them) never reaches ${SWEEP_REFUSAL_LIMIT} in a row: all ${BOARDS} boards are asked, ${BOARDS / 5} reported 404`);
    } else {
      fail(`404-reset sweep: stopped=${a?.stoppedByRefusals} asked=${askedA.size} 404s=${a?.unreachableByCause?.['404']}`);
    }
    if (b?.stoppedByRefusals === true) pass('control: the same sweep with the 404s replaced by 429s is stopped, so the previous result is the reset and not a missing breaker');
    else fail('control arm did not stop');
  } finally { withDead.cleanup(); without.cleanup(); }
}

// a refusal stop does not start the seed scan against the same hosts
{
  const sb = makeSweepSandbox({ boards: boardsList, rules: [...healthyRules(HEALTHY), refuseAll] });
  try {
    const r = runSweep(sb, ['--dry-run', '--seeds', 'yc']);
    const nonBoard = sb.requests().filter((u) => !/boards-api\.greenhouse\.io/.test(u));
    if (r.status === 0 && /seed scan skipped \(yc\) — the sweep was stopped by a host refusing requests/.test(r.stdout) && nonBoard.length === 0) {
      pass('after a refusal stop the seed scan is skipped (and says so) rather than probing the same hosts again');
    } else {
      fail(`seeds after a stop: status=${r.status} other requests=${JSON.stringify(nonBoard.slice(0, 3))}\n${r.stdout.slice(-600)}`);
    }
  } finally { sb.cleanup(); }
}

// The DNS breaker stops a run the same way, and shares the fix: matches it wrote must not ride in its
// checkpoint too, or --resume appends every one of them a second time.
{
  const resolverDown = { match: 'boards-api\\.greenhouse\\.io', fail: 'EAI_AGAIN' };
  const sb = makeSweepSandbox({ boards: boardsList, rules: [...healthyRules(HEALTHY), resolverDown] });
  try {
    const first = runSweep(sb, []);
    const cp = JSON.parse(sb.read('data/cache/ats-full-checkpoint.json') ?? 'null');
    const written = pendingUrls(sb.read('data/pipeline.md'));
    if (first.status === 0 && /⛔ stopped greenhouse\/sandbox-\d+: 50 consecutive DNS failures/.test(first.stdout) && written.length === HEALTHY && cp?.current?.name === 'greenhouse') {
      pass('(control) a resolver outage still stops the run at 50 DNS failures, writes the matches it had, and leaves a checkpoint');
    } else {
      fail(`outage stop: status=${first.status} written=${written.length} cp=${JSON.stringify(cp?.current)}\n${first.stdout.slice(-500)}`);
    }
    if (cp && eq(cp.offers, [])) pass('...and that checkpoint does not also carry the matches it already wrote');
    else fail(`outage checkpoint still holds ${cp?.offers?.length} offers`);
    sb.setRules(healthyRules(BOARDS));
    const second = runSweep(sb, ['--resume', '--json']);
    const after = pendingUrls(sb.read('data/pipeline.md'));
    const afterHistory = historyUrls(sb.read('data/scan-history.tsv'));
    // The boards that failed DNS lookups are below the resume point and are not asked again — that is
    // the DNS breaker's existing contract (--resume must not replay them against the resolver that
    // refused). What changed is only that the first run's HEALTHY matches are not appended twice.
    const resumeAt = cp?.current?.resumeAt ?? 0;
    if (second.status === 0 && after.length === HEALTHY + (BOARDS - resumeAt) && dupes(after).length === 0 && dupes(afterHistory).length === 0) {
      pass(`--resume after the outage appends only the boards it reads (${BOARDS - resumeAt}); the first run's ${HEALTHY} matches are in the files once, not twice`);
    } else {
      fail(`resume after outage: status=${second.status} pending=${after.length} (want ${HEALTHY + BOARDS - resumeAt}) duplicates=${dupes(after).length}`);
    }
  } finally { sb.cleanup(); }
}
