// tests/sweep-harness.mjs — a whole `scan-ats-full.mjs` run in a child process,
// against a sandbox data root and a scripted `fetch`. Not a suite (no `.test.mjs`
// suffix, so test-all.mjs does not discover it); the sweep-hardening suites
// import it.
//
// The child is a launcher that replaces `globalThis.fetch` before importing the
// scanner. Single-host sources (greenhouse here) go through the global fetch
// (providers/_http.mjs), so the scanner's real providers, filters, dedup,
// checkpoint and persistence code all run, with no network and no DNS.
//
// A script is an ordered list of rules. The first rule whose `match` (a RegExp
// source tested against the request URL) applies answers the request:
//
//   status / json / text / headers   the response
//   skip: n                          the rule ignores its first n matches
//   limit: m                         ...and answers at most m after that
//   stall: true                      never answers (until the request's abort signal fires)
//   fail: "EAI_AGAIN"                the request fails the way a refusing resolver makes it fail
//   touch: path                      writes the request count so far to path when it answers
//
// Every request is appended to the request log as `status<TAB>url`, in the order the
// stub answered it, so a test can assert how many requests went where and what
// they were told.
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { NODE, ROOT, rmSync } from './helpers.mjs';

const LAUNCHER = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const script = JSON.parse(readFileSync(process.env.STUB_SCRIPT, 'utf8'));
const requestLog = process.env.STUB_LOG;
const matches = new Map();
let total = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url ?? input);
  total += 1;
  for (const [i, rule] of script.rules.entries()) {
    if (!new RegExp(rule.match).test(url)) continue;
    const n = matches.get(i) ?? 0;
    matches.set(i, n + 1);
    const skip = rule.skip ?? 0;
    if (n < skip) continue;
    if (rule.limit != null && n >= skip + rule.limit) continue;
    if (rule.touch) writeFileSync(rule.touch, String(total));
    if (rule.fail) {
      appendFileSync(requestLog, 'fail\\t' + url + '\\n');
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ' + rule.fail), { code: rule.fail }) });
    }
    if (rule.stall) {
      appendFileSync(requestLog, 'stall\\t' + url + '\\n');
      await new Promise((_, reject) => init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('stub fetch aborted'), { name: 'AbortError' }));
      }));
    }
    const status = rule.status ?? 200;
    appendFileSync(requestLog, status + '\\t' + url + '\\n');
    const body = rule.json !== undefined ? JSON.stringify(rule.json) : (rule.text ?? '');
    return new Response(body, { status, headers: { 'content-type': 'application/json', ...(rule.headers ?? {}) } });
  }
  appendFileSync(requestLog, '404\\t' + url + '\\n');
  return new Response('not found', { status: 404 });
};
process.argv[1] = ${JSON.stringify(join(ROOT, 'scan-ats-full.mjs'))};
await import(${JSON.stringify(pathToFileURL(join(ROOT, 'scan-ats-full.mjs')).href)});
`;

/** The `first_published` of a posting `daysAgo` days old, as Greenhouse sends it. */
export const daysAgoIso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

/**
 * One Greenhouse posting as the boards API lists it. `content` is the entity-escaped
 * HTML the provider decodes into `description`.
 *
 * @param {string} slug
 * @param {{ id: number|string, title: string, location?: string, daysAgo?: number, description?: string, requisitionId?: string|null }} p
 */
export function ghPosting(slug, { id, title, location = 'Remote, United States', daysAgo = 2, description = '', requisitionId = null }) {
  return {
    id,
    title,
    absolute_url: `https://job-boards.greenhouse.io/${slug}/jobs/${id}`,
    location: { name: location },
    first_published: daysAgoIso(daysAgo),
    requisition_id: requisitionId,
    content: description ? `&lt;p&gt;${description}&lt;/p&gt;` : '',
  };
}

/** A rule answering one board's listing AND full fetch (the same URL, with or without content=true). */
export const ghBoard = (slug, postings, extra = {}) => ({
  match: `boards-api\\.greenhouse\\.io/v1/boards/${slug}/jobs`,
  json: { jobs: postings.map((p) => ghPosting(slug, p)) },
  ...extra,
});

/**
 * Build a sandbox data root for a greenhouse sweep.
 *
 * @param {{
 *   boards: string[],                 the dataset: board slugs, in sweep order
 *   rules: object[],                  the fetch script (see the header)
 *   portals?: string,                 portals.yml text
 *   profile?: string,                 config/profile.yml text (absent: no profile)
 *   files?: Record<string, string>,   other files, by path under the root
 * }} spec
 */
export function makeSweepSandbox({ boards, rules, portals = DEFAULT_PORTALS, profile, files = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-sweep-'));
  const put = (rel, text) => {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf-8');
  };
  put('portals.yml', portals);
  if (profile !== undefined) put('config/profile.yml', profile);
  put('data/cache/ats-companies/greenhouse.json', JSON.stringify(boards));
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  put('stub-script.json', JSON.stringify({ rules }));
  put('launch.mjs', LAUNCHER);
  writeFileSync(join(dir, 'requests.log'), '', 'utf-8');
  const read = (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf-8') : null);
  return {
    dir,
    path: (rel) => join(dir, rel),
    put,
    read,
    /** Every request so far, in the order it was answered: { status, url } (status "stall" for one never answered). */
    responses: () => readFileSync(join(dir, 'requests.log'), 'utf-8').split('\n').filter(Boolean).map((l) => {
      const [status, url] = l.split('\t');
      return { status, url };
    }),
    /** URLs requested so far, in order. */
    requests: () => readFileSync(join(dir, 'requests.log'), 'utf-8').split('\n').filter(Boolean).map((l) => l.split('\t')[1]),
    /** Replace the fetch script (a later run of the same sandbox answers differently). */
    setRules: (next) => put('stub-script.json', JSON.stringify({ rules: next })),
    clearRequests: () => writeFileSync(join(dir, 'requests.log'), '', 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The sandbox's environment: its own data root, no pacing, a short refusal back-off. */
export function sweepEnv(sandbox, extra = {}) {
  return {
    ...process.env,
    CAREER_OPS_ROOT: sandbox.dir,
    CAREER_OPS_DATA_DIR: '',
    CAREER_OPS_PORTALS: '',
    CAREER_OPS_PIPELINE: '',
    CAREER_OPS_SCAN_HISTORY: '',
    CAREER_OPS_PROFILE: '',
    CAREER_OPS_SCAN_BACKFILL: '',
    CAREER_OPS_DNS_LOOKUPS_PER_MIN: '0',
    CAREER_OPS_SWEEP_COOLDOWN_MS: '20',
    CAREER_OPS_SWEEP_COOLDOWN_MAX_MS: '60',
    STUB_SCRIPT: sandbox.path('stub-script.json'),
    STUB_LOG: sandbox.path('requests.log'),
    ...extra,
  };
}

/**
 * Run one sweep to completion.
 *
 * @returns {{ status: number|null, stdout: string, stderr: string, json: any }}
 *   `json` is the parsed stdout when the run used --json and it parsed, else null.
 */
export function runSweep(sandbox, args = [], { env = {}, timeout = 90_000 } = {}) {
  const res = spawnSync(NODE, [sandbox.path('launch.mjs'), '--ats', 'greenhouse', '--since', '14', ...args], {
    cwd: sandbox.dir,
    env: sweepEnv(sandbox, env),
    encoding: 'utf-8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  let json = null;
  if (args.includes('--json')) {
    try { json = JSON.parse(res.stdout); } catch { /* left null */ }
  }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', json };
}

/** Start a sweep and hand back the live child, for a test that signals it. */
export function startSweep(sandbox, args = [], { env = {} } = {}) {
  const child = spawn(NODE, [sandbox.path('launch.mjs'), '--ats', 'greenhouse', '--since', '14', ...args], {
    cwd: sandbox.dir,
    env: sweepEnv(sandbox, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, out, exited };
}

/** Wait until `predicate()` is truthy, polling; false on timeout. */
export async function waitFor(predicate, { timeoutMs = 20_000, everyMs = 25 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return false;
}

// Shapes taken from a real portals.yml, trimmed to what the sweep reads: the tier,
// visa and country gates are the ones the author runs; the title net is generic.
export const DEFAULT_PORTALS = `
title_filter:
  positive:
    - security
    - red team
  negative:
    - sales
location_filter:
  always_allow:
    - "United States"
    - "Remote"
skip_tiers: [intern, entry]
visa_filter:
  enabled: true
  require_mention: false
  negative:
    - "no sponsorship"
    - "unable to sponsor"
    - "us citizenship required"
    - "must be a us citizen"
    - "ts/sci"
country_eligibility_filter:
  exclusionary:
    - "must be located in the united states"
  inclusive:
    - "will sponsor"
scan_history:
  recheck_after_days: 30
company_aliases:
  TrendAI: ["Trend Micro"]
`;

/** A `config/profile.yml` for a candidate outside the United States: the country gate is live. */
export const NON_US_PROFILE = 'location:\n  country: "Canada"\n';
/** ...and for a United States candidate, which makes the country gate inert. */
export const US_PROFILE = 'location:\n  country: "United States"\n';
