// tests/scan-ats-full-role-dedup.test.mjs — the sweep and the seed scan ask the
// same company+title question scan.mjs asks, not only "have I seen this URL".
//
// The sweep deduped by URL alone. A role already in the pipeline under another
// URL — the LinkedIn row for the same employer and title, or the watchlist's
// spelling "Trend Micro (Zero Day Initiative)" against the board's "TrendAI" —
// came back as a fresh match every time (the Stripe yc-seed row and its
// LinkedIn twin, in the run this was written against). scan.mjs has the check
// (companyRoleDedupKey over company_aliases, the requisition and language escape
// hatches, the tracker + pipeline + scan-history snapshot); the sweep now uses
// that check, through the same functions, with the same first-seen-wins reading.
//
// Part 1 exercises createRoleDedup() on snapshots read from fixture files.
// Part 2 runs the whole scanner against a scripted host and fixture history.
// Part 3 runs the seed scan with stub providers.
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, rmSync, ROOT } from './helpers.mjs';
import { DEFAULT_PORTALS, ghBoard, makeSweepSandbox, runSweep } from './sweep-harness.mjs';

console.log('\nscan-ats-full — company+title dedup parity with scan.mjs');

const href = (rel) => pathToFileURL(join(ROOT, rel)).href;
const full = await import(href('scan-ats-full.mjs'));
const scan = await import(href('scan.mjs'));
const { localToday } = await import(href('lib/local-today.mjs'));
const { createRoleDedup } = full;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const today = localToday();
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// scan-history.tsv rows, 15 columns in file order.
const HISTORY_HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company\trequisition_id\tlanguage\tlisting_key\n';
const historyRow = ({ url, firstSeen = today, portal = 'linkedin-api', title, company, status = 'added', location = '', requisitionId = '' }) =>
  [url, firstSeen, portal, title, company, status, location, '', '', '', '', '', requisitionId, '', ''].join('\t') + '\n';
const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|-----|
| 9001 | 2026-09-03 | Trend Micro (Zero Day Initiative) | Security Vulnerability Researcher - Global (All Levels) | 4.1/5 | Applied | ❌ | — | pct 83 | https://trendmicro.example/jobs/9938 |
`;
const PIPELINE = `# Pipeline

## Pending
- [ ] https://www.linkedin.com/jobs/view/4461931489 | NVIDIA (Product Security / AI Red Team) | Senior Offensive Security Engineer | Remote

## Processed
`;
const ALIASES = { TrendAI: ['Trend Micro'], NVIDIA: ['NVIDIA AI'] };

function snapshotFrom({ history = '', pipeline = '', applications = '', policy = {}, includeLocation = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-roledup-'));
  const paths = {
    scanHistoryPath: join(dir, 'scan-history.tsv'),
    pipelinePath: join(dir, 'pipeline.md'),
    applicationsPath: join(dir, 'applications.md'),
  };
  writeFileSync(paths.scanHistoryPath, history ? HISTORY_HEADER + history : '');
  writeFileSync(paths.pipelinePath, pipeline);
  writeFileSync(paths.applicationsPath, applications);
  const canonicalize = scan.buildCompanyCanonicalizer(ALIASES);
  const snapshot = scan.loadDedupSnapshot(policy, canonicalize, { ...paths, includeLocation });
  rmSync(dir, { recursive: true, force: true });
  return { snapshot, canonicalize };
}
const job = (company, title, extra = {}) => ({ company, title, url: `https://boards.example/${company}/${encodeURIComponent(title)}`, location: 'Remote', ...extra });

// ── Part 1: the check itself ────────────────────────────────────────────────

{
  const history = historyRow({ url: 'https://www.linkedin.com/jobs/view/1', title: 'Security Engineer, Product Security', company: 'Stripe' })
    + historyRow({ url: 'https://www.linkedin.com/jobs/view/2', title: 'Staff Engineer', company: 'Globex', requisitionId: 'REQ-1' })
    + historyRow({ url: 'https://www.linkedin.com/jobs/view/3', title: 'Platform Engineer', company: 'Initech', status: 'skipped_expired' })
    + historyRow({ url: 'https://www.linkedin.com/jobs/view/4', title: 'Detection Engineer', company: 'Hooli', firstSeen: daysAgo(90) });
  const { snapshot, canonicalize } = snapshotFrom({ history, pipeline: PIPELINE, applications: TRACKER, policy: { recheckAfterDays: 30 } });
  const dedup = createRoleDedup(snapshot, { canonicalize });
  const dup = (j) => dedup.isDuplicate(j);

  if (dup(job('stripe', 'Security Engineer, Product Security'))) pass('the board\'s lowercase slug and the LinkedIn row\'s "Stripe" are one employer: the same role is a duplicate');
  else fail('slug vs display name not matched');
  if (dup(job('stripe', 'Security Engineer – Product  Security'))) pass('punctuation and spacing in the title do not make a new role');
  else fail('title punctuation variant treated as new');
  if (dup(job('TrendAI', 'Security Vulnerability Researcher - Global (All Levels)'))) pass('company_aliases join the board\'s "TrendAI" to the tracker\'s "Trend Micro (Zero Day Initiative)"');
  else fail('alias twin not matched');
  if (dup(job('nvidia', 'Senior Offensive Security Engineer'))) pass('a watchlist label with a parenthetical ("NVIDIA (Product Security / AI Red Team)") folds to the bare employer');
  else fail('qualifier fold not applied');
  if (!dup(job('stripe', 'Security Engineer, Infrastructure Security')) && !dup(job('plaid', 'Security Engineer, Product Security'))) pass('a different title at the same employer, and the same title at another employer, are different roles');
  else fail('distinct role treated as a duplicate');
  if (!dup(job('globex', 'Staff Engineer', { requisitionId: 'REQ-2' }))) pass('the same title with a DIFFERENT known requisition id is a different opening and is kept');
  else fail('a different requisition was dropped as a duplicate');
  if (dup(job('globex', 'Staff Engineer', { requisitionId: 'REQ-1' })) && dup(job('globex', 'Staff Engineer'))) pass('the same requisition, or one the board does not number, stays a duplicate (an unknown id keeps the historical answer)');
  else fail('requisition handling differs from scan.mjs');
  if (!dup(job('initech', 'Platform Engineer'))) pass('a row scan.mjs recorded as skipped_expired does not pin its role (an expired twin must not bury the live one)');
  else fail('skipped_expired row seeded a role key');
  if (!dup(job('hooli', 'Detection Engineer'))) pass('scan_history.recheck_after_days (30) releases a 90-day-old row, exactly as it does for scan.mjs');
  else fail('recheck policy ignored');
  if (dup(job('nvidia', 'Senior Offensive Security Engineer', { url: 'https://other.example/jobs/9' }))) pass('first-seen wins: a twin that is only PENDING in pipeline.md already suppresses the employer-board posting, as in scan.mjs');
  else fail('pending pipeline row did not suppress');

  // a kept role suppresses its later twins in the same run
  const first = job('acme', 'Security Engineer, Cloud');
  const second = job('acme', 'Security Engineer, Cloud', { url: 'https://boards.example/acme/other-city', location: 'Austin, TX' });
  if (!dup(first)) { dedup.remember(first); }
  if (dup(second)) pass('a role kept earlier in the run suppresses its later city variant (first-seen wins within a run, like scan.mjs)');
  else fail('intra-run twin kept');
  if (!dup(job('acme', 'Security Engineer, Cloud', { company: '' })) && !dup({ company: '', title: 'x', url: 'u' })) pass('a posting with no company label is never filed under "::title" with every other one');
  else fail('companyless posting deduped');
}
{
  const history = historyRow({ url: 'https://www.linkedin.com/jobs/view/9', title: 'Security Engineer, Cloud', company: 'Acme', location: 'New York, NY' });
  const { snapshot, canonicalize } = snapshotFrom({ history, includeLocation: true });
  const dedup = createRoleDedup(snapshot, { canonicalize, includeLocation: true });
  const sameCity = dedup.isDuplicate(job('acme', 'Security Engineer, Cloud', { location: 'New York, NY' }));
  const otherCity = dedup.isDuplicate(job('acme', 'Security Engineer, Cloud', { location: 'Austin, TX' }));
  if (sameCity && !otherCity) pass('scan_history.dedup_include_location is honoured: the same role in another city is kept');
  else fail(`include_location: same=${sameCity} other=${otherCity}`);
}

// ── Part 2: the whole scanner ────────────────────────────────────────────────

// DEFAULT_PORTALS already carries scan_history.recheck_after_days and company_aliases (TrendAI: [Trend Micro]).
const PORTALS = DEFAULT_PORTALS;
const slugUrl = (slug, id) => `https://job-boards.greenhouse.io/${slug}/jobs/${id}`;
const pending = (md) => (md ?? '').split('\n').filter((l) => l.startsWith('- [ ]')).map((l) => l.replace(/^- \[ \]\s*/, '').split(/\s+\|\s+/)[0].trim());
{
  const sb = makeSweepSandbox({
    boards: ['stripe', 'trendai', 'globex', 'acme', 'initech', 'umbrella'],
    portals: PORTALS,
    files: {
      'data/scan-history.tsv': HISTORY_HEADER
        + historyRow({ url: 'https://www.linkedin.com/jobs/view/11', title: 'Security Engineer, Product Security', company: 'Stripe' })
        + historyRow({ url: 'https://www.linkedin.com/jobs/view/12', title: 'Security Engineer, Platform', company: 'Globex', requisitionId: 'R-1' })
        + historyRow({ url: slugUrl('initech', 301), portal: 'greenhouse-full', title: 'Security Engineer, Detection', company: 'initech' }),
      'data/applications.md': TRACKER,
    },
    rules: [
      ghBoard('stripe', [
        { id: 101, title: 'Security Engineer, Product Security' },     // LinkedIn twin → duplicate
        { id: 102, title: 'Security Engineer, Infrastructure' },       // different title → kept
      ]),
      ghBoard('trendai', [{ id: 201, title: 'Security Vulnerability Researcher - Global (All Levels)' }]),  // alias twin of a tracker row → duplicate
      ghBoard('globex', [{ id: 401, title: 'Security Engineer, Platform', requisitionId: 'R-2' }]), // different requisition → kept
      ghBoard('acme', [
        { id: 501, title: 'Security Engineer, Cloud', location: 'New York, NY' },
        { id: 502, title: 'Security Engineer, Cloud', location: 'Austin, TX' },              // twin of the first, same run → duplicate
      ]),
      ghBoard('initech', [{ id: 301, title: 'Security Engineer, Detection' }]),               // same URL as history → the URL check, not the role check
      ghBoard('umbrella', [{ id: 601, title: 'Security Engineer, Hardware' }]),
    ],
  });
  try {
    const r = runSweep(sb, ['--json']);
    const j = r.json;
    const got = pending(sb.read('data/pipeline.md')).sort();
    const want = [slugUrl('stripe', 102), slugUrl('globex', 401), slugUrl('acme', 501), slugUrl('umbrella', 601)].sort();
    if (r.status === 0 && eq(got, want)) pass('a role known under another URL is not appended again: the LinkedIn twin, the alias twin and the later city variant are gone; the other four are in pipeline.md');
    else fail(`sweep dedup: status=${r.status} got=${JSON.stringify(got)}\n${r.stderr.slice(0, 400)}`);
    if (j?.postingsDuplicateRole === 3 && j.postingsKept === 4) pass('the three suppressed roles are counted: postingsDuplicateRole 3 (the URL-twin is not among them: the URL check caught it first)');
    else fail(`counts: duplicateRole=${j?.postingsDuplicateRole} kept=${j?.postingsKept}`);
    if (!got.includes(slugUrl('initech', 301))) pass('the URL-key dedup is intact: an already-seen URL is still skipped');
    else fail('URL dedup regressed');

    // human summary line
    const human = runSweep(sb, ['--dry-run']);
    if (/Duplicate roles:\s+\d+ \(company\+title already known under another URL\)/.test(human.stdout)) pass('the summary prints "Duplicate roles: N" like scan.mjs prints its duplicates');
    else fail(`summary line missing:\n${human.stdout.slice(-600)}`);
  } finally { sb.cleanup(); }
}

// the same sweep with dedup_include_location: the second city is a different opening
{
  const sb = makeSweepSandbox({
    boards: ['acme'],
    portals: PORTALS.replace('recheck_after_days: 30', 'recheck_after_days: 30\n  dedup_include_location: true'),
    rules: [ghBoard('acme', [
      { id: 501, title: 'Security Engineer, Cloud', location: 'New York, NY' },
      { id: 502, title: 'Security Engineer, Cloud', location: 'Austin, TX' },
    ])],
  });
  try {
    const j = runSweep(sb, ['--json', '--dry-run']).json;
    if (j?.postingsKept === 2 && j.postingsDuplicateRole === 0) pass('with scan_history.dedup_include_location both cities of one role are kept in the sweep too');
    else fail(`include_location sweep: kept=${j?.postingsKept} dup=${j?.postingsDuplicateRole}`);
  } finally { sb.cleanup(); }
}

// the same sweep run twice: the second run finds the first one's rows
{
  const sb = makeSweepSandbox({ boards: ['acme'], portals: PORTALS, rules: [ghBoard('acme', [{ id: 1, title: 'Security Engineer, Cloud' }])] });
  try {
    const first = runSweep(sb, ['--json']);
    // second run, fresh: the first run's rows are in history and pipeline now
    const second = runSweep(sb, ['--json']);
    if (first.json?.postingsKept === 1 && second.json?.postingsKept === 0 && pending(sb.read('data/pipeline.md')).length === 1) pass('running the same sweep twice appends the role once (the second run sees it in history and pipeline)');
    else fail(`rerun: first=${first.json?.postingsKept} second=${second.json?.postingsKept}`);
  } finally { sb.cleanup(); }
}

// ── Part 3: the seed scan ─────────────────────────────────────────────────────

{
  const probe = await import(href('seeds/seed-probe.mjs'));
  const vc = await import(href('seeds/vc-portfolios.mjs'));
  const greenhouse = (await import(href('providers/greenhouse.mjs'))).default;
  const { runSeedScan, createKeyedLimiter } = full;
  const { snapshot, canonicalize } = snapshotFrom({
    history: historyRow({ url: 'https://www.linkedin.com/jobs/view/21', title: 'Security Engineer, Product Security', company: 'Stripe' }),
  });
  const roleDedup = createRoleDedup(snapshot, { canonicalize });
  const DAY = 86_400_000;
  const mk = (title, over = {}) => ({ title, url: `https://jobs.example.test/${encodeURIComponent(title)}`, company: 'stripe', location: 'Remote', postedAt: Date.now() - DAY, description: 'security', ...over });
  const provider = { ...greenhouse, async fetch() { return [mk('Security Engineer, Product Security'), mk('Security Engineer, Fraud')]; } };
  const YC = vc.SEED_SOURCES.yc;
  const realFetch = YC.fetch;
  const realWarn = console.error;
  YC.fetch = async () => [{ name: 'Stripe', slug: 'stripe', url: '', source: 'yc' }];
  console.error = () => {};
  try {
    const sink = [];
    const state = probe.createSeedRunState({ deadPath: null, livePath: null, persist: false, withKeySlot: createKeyedLimiter(6), sleep: async () => {} });
    const titleFilterConfig = { positive: ['security engineer'] };
    const opts = {
      sinceDays: 10, limit: Infinity, shuffle: false, includeUndated: false,
      titleFilter: scan.buildTitleFilter(titleFilterConfig),
      locationFilter: scan.buildLocationFilter({}),
      contentFilter: scan.buildContentFilter({}),
      titleFilterConfig, blacklist: new Map(), includeBlacklisted: false, json: false, verbose: false, levelGate: null,
      roleDedup,
    };
    const result = await runSeedScan('yc', opts, {}, new Set(), 'YC', { providers: { greenhouse: provider, ashby: provider, lever: provider }, state, sink });
    const titles = result.offers.map((o) => o.title);
    if (eq(titles, ['Security Engineer, Fraud']) && result.stats.gated.duplicateRole === 1) pass('the seed scan applies the same check: the LinkedIn twin of Stripe\'s role is dropped and counted, the other posting kept');
    else fail(`seed dedup: ${JSON.stringify(titles)} gated=${JSON.stringify(result.stats.gated)}`);
    if (sink.length === 1 && sink[0].title === 'Security Engineer, Fraud') pass('kept seed postings are pushed to the caller\'s own list as they are found (what a stop signal flushes), and still returned');
    else fail(`sink: ${JSON.stringify(sink.map((o) => o.title))}`);
  } finally {
    console.error = realWarn;
    YC.fetch = realFetch;
  }
}
