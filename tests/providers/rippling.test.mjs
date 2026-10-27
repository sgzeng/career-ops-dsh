// tests/providers/rippling.test.mjs — direct provider-contract tests.
//
// Rippling's board API is a same-origin, paginated
// `ats.rippling.com/api/v2/board/<slug>/jobs?page=&pageSize=` envelope
// (`{ items, page, pageSize, totalItems, totalPages }`) — see the header
// comment in providers/rippling.mjs for the full shape. Each posting's detail
// document (`.../jobs/<id>`) supplies description / postedAt / salary.
import { pass, fail, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — rippling');

try {
  const ripplingModule = await import(pathToFileURL(join(ROOT, 'providers/rippling.mjs')).href);
  const rippling = ripplingModule.default;
  const { parseRipplingPage } = ripplingModule;

  if (rippling.id === 'rippling') pass('rippling.id is "rippling"');
  else fail(`rippling.id is ${JSON.stringify(rippling.id)}`);

  // detect(): ats.rippling.com/<slug>/jobs → page-0 board API URL.
  const hit = rippling.detect({ name: 'Acme', careers_url: 'https://ats.rippling.com/acme-corp/jobs' });
  if (hit && hit.url === 'https://ats.rippling.com/api/v2/board/acme-corp/jobs?page=0&pageSize=1000') {
    pass('rippling.detect() resolves ats.rippling.com/<slug>/jobs → v2 board API URL');
  } else {
    fail(`rippling.detect() returned ${JSON.stringify(hit)}`);
  }

  // detect() also works when careers_url is just /<slug> (no /jobs suffix).
  const hitNoJobs = rippling.detect({ name: 'X', careers_url: 'https://ats.rippling.com/acme-corp' });
  if (hitNoJobs && hitNoJobs.url === 'https://ats.rippling.com/api/v2/board/acme-corp/jobs?page=0&pageSize=1000') {
    pass('rippling.detect() derives the slug from the first path segment (no /jobs needed)');
  } else {
    fail(`rippling.detect() no-/jobs returned ${JSON.stringify(hitNoJobs)}`);
  }

  if (rippling.detect({ name: 'X', careers_url: 'https://example.com/acme/jobs' }) === null) {
    pass('rippling.detect() returns null for non-rippling hosts');
  } else {
    fail('rippling.detect() should return null for non-rippling hosts');
  }

  // careers_url with non-string value → detect() returns null without crashing.
  if (rippling.detect({ name: 'X', careers_url: null }) === null && rippling.detect({ name: 'X', careers_url: 7 }) === null) {
    pass('rippling.detect() returns null for non-string careers_url (null and 7)');
  } else {
    fail('rippling.detect() should treat non-string careers_url as missing');
  }

  // SSRF/format: non-https, empty path (no slug), and host-spoof in the path.
  if (rippling.detect({ name: 'X', careers_url: 'http://ats.rippling.com/acme/jobs' }) === null
      && rippling.detect({ name: 'X', careers_url: 'https://ats.rippling.com/' }) === null
      && rippling.detect({ name: 'X', careers_url: 'https://evil.example/ats.rippling.com/acme/jobs' }) === null) {
    pass('rippling.detect() rejects non-https, empty-path, and path-spoofed URLs');
  } else {
    fail('rippling.detect() must reject non-https / empty-path / path-spoofed URLs');
  }

  // Slug safety: a first segment that is not a clean token (space, dot, hyphen-edged) is rejected.
  if (rippling.detect({ name: 'X', careers_url: 'https://ats.rippling.com/a%20b/jobs' }) === null
      && rippling.detect({ name: 'X', careers_url: 'https://ats.rippling.com/acme.corp/jobs' }) === null
      && rippling.detect({ name: 'X', careers_url: 'https://ats.rippling.com/-acme/jobs' }) === null) {
    pass('rippling.detect() rejects unsafe slugs (space, dot, leading hyphen)');
  } else {
    fail('rippling.detect() must reject unsafe slugs');
  }

  // Internal hyphens are valid.
  if (rippling.detect({ name: 'X', careers_url: 'https://ats.rippling.com/just-appraised-jobs/jobs' })?.url
      === 'https://ats.rippling.com/api/v2/board/just-appraised-jobs/jobs?page=0&pageSize=1000') {
    pass('rippling.detect() accepts slugs with internal hyphens');
  } else {
    fail('rippling.detect() should accept internal hyphens in the slug');
  }

  // parseRipplingPage — deterministic sample (one page's `items[]`).
  const sample = {
    page: 0, pageSize: 1000, totalItems: 4, totalPages: 1,
    items: [
      { id: '1', name: 'Account Executive', url: 'https://ats.rippling.com/acme/jobs/uuid-1', department: { name: 'Sales' }, locations: [{ name: 'Remote (United States)' }] },
      { id: '2', name: '  ML Engineer  ', url: '  https://ats.rippling.com/acme/jobs/uuid-2  ', locations: [{ name: 'Berlin, Germany' }, { name: 'Hamburg, Germany' }] },
      { id: '3', name: 'No Loc Role', url: 'https://ats.rippling.com/acme/jobs/uuid-3', locations: [] },
      { id: '4', name: 'Missing Locations', url: 'https://ats.rippling.com/acme/jobs/uuid-4' },
      { id: '5', name: '', url: 'https://ats.rippling.com/acme/jobs/uuid-5' },   // drop: empty name
      { id: '6', name: 'No URL Role' },                                          // drop: no url
      { id: '7', name: 'Insecure', url: 'http://ats.rippling.com/acme/jobs/uuid-7' }, // drop: non-https
    ],
  };
  const { jobs, rawCount } = parseRipplingPage(sample, 'Acme');

  if (rawCount === 7) pass('parseRipplingPage reports the source\'s raw item count (before row filtering)');
  else fail(`parseRipplingPage rawCount = ${rawCount} (expected 7)`);

  if (jobs.length === 4) pass('parseRipplingPage keeps 4 valid postings (drops empty-name / no-url / non-https)');
  else fail(`parseRipplingPage returned ${jobs.length} postings (expected 4)`);

  if (jobs[0] && Object.keys(jobs[0]).sort().join(',') === 'company,location,title,url') {
    pass('parseRipplingPage returns the normalized { title, url, company, location } shape');
  } else {
    fail(`parseRipplingPage row 0 keys = ${JSON.stringify(jobs[0] && Object.keys(jobs[0]))}`);
  }

  if (jobs[0]?.title === 'Account Executive'
      && jobs[0]?.url === 'https://ats.rippling.com/acme/jobs/uuid-1'
      && jobs[0]?.company === 'Acme'
      && jobs[0]?.location === 'Remote (United States)') {
    pass('parseRipplingPage maps name→title, url, company from entry name, locations[0].name→location');
  } else {
    fail(`parseRipplingPage row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[1]?.title === 'ML Engineer' && jobs[1]?.url === 'https://ats.rippling.com/acme/jobs/uuid-2'
      && jobs[1]?.location === 'Berlin, Germany · Hamburg, Germany') {
    pass('parseRipplingPage trims whitespace from name/url and joins multiple locations with " · "');
  } else {
    fail(`parseRipplingPage row 1 = ${JSON.stringify(jobs[1])}`);
  }

  if (jobs[2]?.location === '' && jobs[3]?.location === '') {
    pass('parseRipplingPage yields "" location for an empty or missing locations array');
  } else {
    fail(`parseRipplingPage loc fallbacks = ${JSON.stringify({ empty: jobs[2]?.location, missing: jobs[3]?.location })}`);
  }

  // Regression: the per-item url is host-locked to ats.rippling.com — an external
  // https URL is dropped, a valid ats.rippling.com posting URL is kept.
  const hostLocked = parseRipplingPage(
    { items: [
      { name: 'External Host', url: 'https://evil.example/acme/jobs/uuid-x' },
      { name: 'Valid Host', url: 'https://ats.rippling.com/acme/jobs/uuid-9' },
    ] },
    'Acme',
  );
  if (hostLocked.jobs.length === 1 && hostLocked.jobs[0]?.title === 'Valid Host'
      && hostLocked.jobs[0]?.url === 'https://ats.rippling.com/acme/jobs/uuid-9') {
    pass('parseRipplingPage host-locks the posting url to ats.rippling.com (drops external https URLs)');
  } else {
    fail(`parseRipplingPage host-lock = ${JSON.stringify(hostLocked)}`);
  }

  // Empty-vs-broken split (ADDING_A_PROVIDER.md §2): a present-and-empty
  // `items: []` is a genuinely empty board → no throw, rawCount 0.
  const emptyBoard = parseRipplingPage({ items: [], page: 0, pageSize: 1000, totalItems: 0, totalPages: 0 }, 'X');
  if (emptyBoard.jobs.length === 0 && emptyBoard.rawCount === 0) {
    pass('parseRipplingPage returns [] for a present-and-empty items[] (genuinely empty board)');
  } else {
    fail(`parseRipplingPage empty-board handling = ${JSON.stringify(emptyBoard)}`);
  }

  // An envelope that isn't the documented shape (`items` absent/wrong-typed, or
  // a bare non-object body) throws a descriptive error instead of silently
  // reading as "0 jobs forever".
  for (const bad of [{}, { items: null }, { items: 'nope' }, null, 'not json', 42]) {
    let threw = false;
    try { parseRipplingPage(bad, 'X'); } catch (e) { threw = /unexpected response/.test(e.message); }
    if (!threw) fail(`parseRipplingPage should throw a descriptive error for ${JSON.stringify(bad)}`);
  }
  pass('parseRipplingPage throws a descriptive error for a non-{items[]} envelope');

  // fetch(): requests the derived board API URL (page 0) and passes the SSRF guard.
  let capturedUrl = null;
  let capturedOpts = null;
  let fetchCalls = 0;
  const fetched = await rippling.fetch(
    { name: 'Acme', careers_url: 'https://ats.rippling.com/acme-corp/jobs' },
    { fetchJson: async (url, opts) => { fetchCalls++; capturedUrl = url; capturedOpts = opts; return sample; } },
  );

  if (capturedUrl === 'https://ats.rippling.com/api/v2/board/acme-corp/jobs?page=0&pageSize=1000') {
    pass('rippling.fetch() requests the derived board API URL');
  } else {
    fail(`rippling.fetch() requested ${JSON.stringify(capturedUrl)}`);
  }

  if (capturedOpts && capturedOpts.redirect === 'error') {
    pass('rippling.fetch() passes redirect:"error" to fetchJson (SSRF guard)');
  } else {
    fail(`rippling.fetch() should pass redirect:"error", got: ${JSON.stringify(capturedOpts)}`);
  }

  if (fetched.length === 4 && fetched[0]?.company === 'Acme') {
    pass('rippling.fetch() returns normalized jobs with company from entry name');
  } else {
    fail(`rippling.fetch() returned ${fetched.length} jobs, row 0 = ${JSON.stringify(fetched[0])}`);
  }

  // A short first page (rawCount < PAGE_SIZE) is the natural end — exactly one request.
  if (fetchCalls === 1) pass('rippling.fetch() stops after one request when the first page is short (natural end)');
  else fail(`rippling.fetch() made ${fetchCalls} requests for a short single page`);

  // fetch(): a non-rippling careers_url cannot derive an endpoint → throws,
  // and never even reaches fetchJson (not just "returns null/[]").
  let badEntryThrew = false;
  let badEntryFetchCalled = false;
  try {
    await rippling.fetch(
      { name: 'X', careers_url: 'https://example.com/careers' },
      { fetchJson: async () => { badEntryFetchCalled = true; return { items: [] }; } },
    );
  } catch (e) {
    badEntryThrew = /cannot derive API URL/.test(e.message);
  }
  if (badEntryThrew && !badEntryFetchCalled) {
    pass('rippling.fetch() throws (without calling fetchJson) when the careers_url is not an ats.rippling.com host');
  } else {
    fail(`rippling.fetch() bad-entry handling: threw=${badEntryThrew}, fetchJson called=${badEntryFetchCalled}`);
  }

  // Pagination: a board bigger than one page walks page 0, 1, 2, ... and stops
  // on the natural short-page end, even though `totalPages` alone would have
  // stopped it earlier or later — the walk's own short page is the proof.
  const bigEntry = { name: 'BigCo', careers_url: 'https://ats.rippling.com/bigco/jobs' };
  const pageOf = (n, count) => ({
    page: n, pageSize: 1000, totalItems: 2000, totalPages: 2,
    items: Array.from({ length: count }, (_, i) => ({
      id: `${n}-${i}`, name: `Role ${n}-${i}`, url: `https://ats.rippling.com/bigco/jobs/${n}-${i}`, locations: [],
    })),
  });
  let bigPages = 0;
  const bigJobs = await rippling.fetch(bigEntry, {
    sleep: async () => {},
    fetchJson: async () => {
      bigPages++;
      return bigPages === 1 ? pageOf(0, 1000) : pageOf(1, 500); // page 0 full, page 1 short → natural end
    },
  });
  if (bigPages === 2 && bigJobs.length === 1500) {
    pass(`rippling.fetch() paginates past page 0 and stops on the natural short-page end (${bigPages} pages, ${bigJobs.length} jobs)`);
  } else {
    fail(`rippling.fetch() pagination: ${bigPages} pages, ${bigJobs.length} jobs (expected 2 pages, 1500 jobs)`);
  }

  // Regression: a short final page that happens to land exactly on the last
  // ALLOWED page (max_pages reached and short) must still read as a natural
  // end, not as the ceiling having truncated a healthy board.
  let lastPageShortPages = 0;
  const { result: lastPageShortJobs, errors: lastPageShortErrors } = await captureConsoleErrors(() => rippling.fetch(
    { ...bigEntry, max_pages: 2 },
    {
      sleep: async () => {},
      fetchJson: async () => {
        lastPageShortPages++;
        return lastPageShortPages === 1 ? pageOf(0, 1000) : pageOf(1, 300); // page 1 IS the last allowed page, and short
      },
    },
  ));
  if (lastPageShortPages === 2 && lastPageShortJobs.length === 1300) {
    pass(`rippling.fetch() stops on a short page that is also the last allowed page (${lastPageShortPages} pages, ${lastPageShortJobs.length} jobs)`);
  } else {
    fail(`rippling.fetch() last-page-short handling: ${lastPageShortPages} pages, ${lastPageShortJobs.length} jobs (expected 2 pages, 1300 jobs)`);
  }
  if (!lastPageShortErrors.some((e) => /raise max_pages/.test(e))) {
    pass('rippling.fetch() does not warn "raise max_pages" when the last allowed page is short (natural end, not a cap stop)');
  } else {
    fail(`rippling.fetch() should not warn "raise max_pages" for a short last-allowed page, got: ${JSON.stringify(lastPageShortErrors)}`);
  }

  // DEFAULT_MAX_PAGES (10) stops an ever-full board even when the source
  // never reports a short page — and warns, since this IS a healthy board
  // truncated by the ceiling.
  let hugePages = 0;
  const { result: hugeJobs, errors: hugeErrors } = await captureConsoleErrors(() => rippling.fetch(bigEntry, {
    sleep: async () => {},
    fetchJson: async () => {
      hugePages++;
      if (hugePages > 15) throw new Error('rippling paginated past any sane bound');
      return pageOf(hugePages, 1000); // always full
    },
  }));
  if (hugePages === 10 && hugeJobs.length === 10_000) {
    pass(`rippling.fetch() clamps pagination at its own DEFAULT_MAX_PAGES for an always-full board (${hugePages} pages)`);
  } else {
    fail(`rippling.fetch() made ${hugePages} requests, ${hugeJobs.length} jobs (expected DEFAULT_MAX_PAGES=10 pages, 10,000 jobs)`);
  }
  if (hugeErrors.some((e) => /raise max_pages/.test(e))) {
    pass('rippling.fetch() warns to raise max_pages when the ceiling truncated a healthy (always-full) board');
  } else {
    fail(`rippling.fetch() should warn "raise max_pages" on a real cap stop, got: ${JSON.stringify(hugeErrors)}`);
  }
  if (hugeJobs.ripplingTruncated === true) pass('rippling.fetch() tags a cap-truncated board ripplingTruncated');
  else fail(`rippling cap-truncated board should carry ripplingTruncated, got ${hugeJobs.ripplingTruncated}`);

  // An explicit max_pages override stops the walk earlier than the default,
  // capped at the provider's own hard ceiling.
  let overridePages = 0;
  await rippling.fetch({ ...bigEntry, max_pages: 2 }, {
    sleep: async () => {},
    fetchJson: async () => { overridePages++; return pageOf(overridePages, 1000); },
  });
  if (overridePages === 2) pass('rippling.fetch() honors an entry.max_pages override');
  else fail(`rippling.fetch() made ${overridePages} requests despite max_pages: 2`);

  // ctx.maxPages (the portal health probe passes 1) caps pagination
  // independently of max_pages, and every list request still carries redirect:'error'.
  let probePages = 0;
  let probeOpts = null;
  await rippling.fetch(bigEntry, {
    maxPages: 1,
    fetchJson: async (_url, opts) => { probePages++; probeOpts = opts; return pageOf(0, 1000); },
  });
  if (probePages === 1) pass('rippling.fetch() honors ctx.maxPages as a health-probe cap (exactly one list request)');
  else fail(`rippling.fetch() made ${probePages} requests despite ctx.maxPages=1`);
  if (probeOpts?.redirect === 'error') pass('rippling.fetch() probe request still passes redirect:"error"');
  else fail(`rippling.fetch() probe request redirect = ${JSON.stringify(probeOpts?.redirect)}`);

  // A ctx.fetch* rejection while ctx.maxPages is set (a probe) propagates
  // UNWRAPPED — verify-portals identifies ProbePageBudgetReached by instanceof,
  // so it must not be caught/swallowed/rewrapped here.
  class FakeProbeBudget extends Error {}
  let probeRejectionSame = false;
  try {
    await rippling.fetch(bigEntry, {
      maxPages: 1,
      fetchJson: async () => { throw new FakeProbeBudget('probe budget reached'); },
    });
  } catch (e) {
    probeRejectionSame = e instanceof FakeProbeBudget;
  }
  if (probeRejectionSame) pass('rippling.fetch() propagates a ctx.fetch* rejection unwrapped while ctx.maxPages is set');
  else fail('rippling.fetch() must not swallow/rewrap a rejection while probing');

  // Pagination + a later page's transient failure (retries exhausted): keeps
  // the pages already collected and does not throw — the board is alive
  // (page 0 proved it) — and must NOT fire the "raise max_pages" warning,
  // since a fetch-error stop means the board broke, not that the ceiling
  // truncated a healthy one.
  let laterFailPages = 0;
  const { result: laterFail, errors: laterFailErrors } = await captureConsoleErrors(() => rippling.fetch(bigEntry, {
    sleep: async () => {},
    fetchJson: async () => {
      laterFailPages++;
      if (laterFailPages === 1) return pageOf(0, 1000); // full page → walk continues
      throw new Error('page 1 blew up');
    },
  }));
  if (laterFail.length === 1000) {
    pass('rippling.fetch() keeps earlier pages and truncates gracefully when a LATER page fails after exhausting retries');
  } else {
    fail(`rippling.fetch() later-page failure handling returned ${laterFail.length} jobs (expected 1000)`);
  }
  if (!laterFailErrors.some((e) => /raise max_pages/.test(e))) {
    pass('rippling.fetch() does not warn "raise max_pages" on a fetch-error stop');
  } else {
    fail(`rippling.fetch() should not warn "raise max_pages" on a fetch-error stop, got: ${JSON.stringify(laterFailErrors)}`);
  }
  if (laterFail.ripplingTruncated === true) {
    pass('rippling.fetch() tags a fetch-error stop ripplingTruncated');
  } else {
    fail(`rippling fetch-error stop should carry ripplingTruncated, got ${laterFail.ripplingTruncated}`);
  }

  // ── Detail enrichment (description / postedAt / salary) ─────────────────
  const { mergeRipplingDetail } = ripplingModule;
  const baseJob = { title: 'Senior Software Engineer', url: 'https://ats.rippling.com/acme/jobs/x', company: 'Acme', location: 'San Jose, CA' };
  const baseSnapshot = JSON.stringify(baseJob);

  // Object description (the live shape): role first, then company boilerplate;
  // markup stripped and entities decoded.
  const objMerged = mergeRipplingDetail(baseJob, {
    description: {
      company: '<meta><p style="font-family:&quot;Basel&quot;">About Acme &amp; friends</p>',
      role: '<p><b>What you will do</b></p><ul><li>Build fuzzers</li></ul>',
    },
    createdOn: '2026-06-19T14:10:49.247000-07:00',
  });
  if (objMerged.description === 'What you will do Build fuzzers\nAbout Acme & friends') {
    pass('mergeRipplingDetail: object description → role section first, then company, as plain text');
  } else {
    fail(`mergeRipplingDetail object description = ${JSON.stringify(objMerged.description)}`);
  }
  if (objMerged.postedAt === Date.parse('2026-06-19T21:10:49.247Z')) {
    pass('mergeRipplingDetail: createdOn (µs fraction + offset) → postedAt epoch ms');
  } else {
    fail(`mergeRipplingDetail postedAt = ${objMerged.postedAt}`);
  }
  if (JSON.stringify(baseJob) === baseSnapshot && objMerged !== baseJob
      && objMerged.title === baseJob.title && objMerged.url === baseJob.url && objMerged.location === baseJob.location) {
    pass('mergeRipplingDetail is pure: keeps list fields, never mutates the input job');
  } else {
    fail(`mergeRipplingDetail mutated or lost list fields: ${JSON.stringify({ baseJob, objMerged })}`);
  }

  // Unknown extra sections sit between role and company.
  const extraSections = mergeRipplingDetail(baseJob, { description: { company: 'Co', benefits: '<p>Bens</p>', role: 'Role' } });
  if (extraSections.description === 'Role\nBens\nCo') {
    pass('mergeRipplingDetail: unknown description sections go after role, before company');
  } else {
    fail(`mergeRipplingDetail extra sections = ${JSON.stringify(extraSections.description)}`);
  }

  // Bare string description.
  const strMerged = mergeRipplingDetail(baseJob, { description: '<div>Plain &lt;b&gt;JD&lt;/b&gt; body</div>', createdOn: '2026-09-01' });
  if (strMerged.description === 'Plain JD body' && strMerged.postedAt === Date.parse('2026-09-01T00:00:00Z')) {
    pass('mergeRipplingDetail: string description (double-encoded) → plain text; date-only createdOn → UTC midnight');
  } else {
    fail(`mergeRipplingDetail string description = ${JSON.stringify({ d: strMerged.description, p: strMerged.postedAt })}`);
  }

  // Cap: FULL_DESCRIPTION_CAP (20000), not the 4000 default.
  const longMerged = mergeRipplingDetail(baseJob, { description: { role: 'x'.repeat(25000) } });
  if (longMerged.description?.length === 20000) pass('mergeRipplingDetail caps the description at FULL_DESCRIPTION_CAP');
  else fail(`mergeRipplingDetail long description length = ${longMerged.description?.length}`);

  // The cap applies to the JOINED sections too: each section fits under it on
  // its own, together they don't — the role text survives, the tail is cut.
  const joinedLong = mergeRipplingDetail(baseJob, { description: { role: 'x'.repeat(19990), company: 'y'.repeat(100) } });
  if (joinedLong.description?.length === 20000 && joinedLong.description.startsWith('x'.repeat(19990))) {
    pass('mergeRipplingDetail caps the joined multi-section description at FULL_DESCRIPTION_CAP, role text first');
  } else {
    fail(`mergeRipplingDetail joined description length = ${joinedLong.description?.length}`);
  }

  // Empty / whitespace-only / non-string sections → description omitted.
  const emptyDesc = mergeRipplingDetail(baseJob, { description: { role: '  <p> </p> ', company: 42 } });
  const nullDesc = mergeRipplingDetail(baseJob, { description: null });
  if (!('description' in emptyDesc) && !('description' in nullDesc)) {
    pass('mergeRipplingDetail omits description when every section is empty / non-string / null');
  } else {
    fail(`mergeRipplingDetail empty description = ${JSON.stringify({ emptyDesc, nullDesc })}`);
  }

  // Bad dates are ignored, never NaN.
  const farFuture = new Date(Date.now() + 2 * 365 * 86_400_000).toISOString();
  const badDates = ['garbage', '2026-06-19T14:10:49', '', 1781903449247, null, farFuture, '0000-01-01T00:00:00Z'];
  const badDateHits = badDates.filter((createdOn) => 'postedAt' in mergeRipplingDetail(baseJob, { createdOn }));
  if (badDateHits.length === 0) {
    pass('mergeRipplingDetail ignores unusable createdOn (garbage, offset-less time, number, null, far-future, epoch ≤ 0)');
  } else {
    fail(`mergeRipplingDetail accepted bad createdOn: ${JSON.stringify(badDateHits)}`);
  }

  // Malformed detail documents return the job unchanged.
  if ([null, undefined, 'x', 7, [{ description: 'y' }]].every((d) => mergeRipplingDetail(baseJob, d) === baseJob)) {
    pass('mergeRipplingDetail returns the job unchanged for a non-object detail (null / string / number / array)');
  } else {
    fail('mergeRipplingDetail should ignore a non-object detail');
  }

  // payRangeDetails → annualized salary envelope; mixed currency / bad rows → none.
  const pay = (ranges) => mergeRipplingDetail(baseJob, { payRangeDetails: ranges }).salary;
  const yearly = pay([{ location: 'Coworking (Downtown)', currency: 'usd', frequency: 'YEAR', rangeStart: 130000, rangeEnd: 180000 }]);
  const envelope = pay([
    { currency: 'USD', frequency: 'YEAR', rangeStart: 150000, rangeEnd: 200000 },
    { currency: 'USD', frequency: 'HOUR', rangeStart: 50, rangeEnd: 60 },  // 104000 – 124800
  ]);
  const oneSided = pay([{ currency: 'USD', frequency: 'YEAR', rangeStart: 0, rangeEnd: 140000 }]);
  if (JSON.stringify(yearly) === JSON.stringify({ min: 130000, max: 180000, currency: 'USD' })
      && JSON.stringify(envelope) === JSON.stringify({ min: 104000, max: 200000, currency: 'USD' })
      && JSON.stringify(oneSided) === JSON.stringify({ min: 140000, max: 140000, currency: 'USD' })) {
    pass('mergeRipplingDetail: payRangeDetails → annualized {min,max,currency} envelope (0 bound ignored)');
  } else {
    fail(`mergeRipplingDetail salary = ${JSON.stringify({ yearly, envelope, oneSided })}`);
  }
  const noSalary = [
    [],
    [{ currency: 'USD', frequency: 'YEAR', rangeStart: 100000 }, { currency: 'EUR', frequency: 'YEAR', rangeStart: 90000 }],
    [{ currency: 'USD', frequency: 'FORTNIGHT', rangeStart: 1, rangeEnd: 2 }],
    [{ currency: 'USD', frequency: 'YEAR', rangeStart: 'abc', rangeEnd: null }],
    [null, 'x'],
    'not-an-array',
  ].filter((r) => pay(r) !== undefined);
  if (noSalary.length === 0) {
    pass('mergeRipplingDetail omits salary for empty / mixed-currency / unknown-frequency / non-numeric / malformed ranges');
  } else {
    fail(`mergeRipplingDetail attached salary for: ${JSON.stringify(noSalary)}`);
  }

  // ── fetch() with detail requests ────────────────────────────────────────
  const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const LIST_URL = 'https://ats.rippling.com/api/v2/board/acme-corp/jobs?page=0&pageSize=1000';
  const board = (items) => ({ page: 0, pageSize: 1000, totalItems: items.length, totalPages: 1, items });
  const row = (n, loc) => ({ id: U(n), name: `Role ${n}`, url: `https://ats.rippling.com/acme-corp/jobs/${U(n)}`, locations: [{ name: loc }] });
  const detailFor = (n) => ({ uuid: U(n), description: { role: `<p>Role ${n} body</p>`, company: '<p>Acme</p>' }, createdOn: '2026-09-01T10:00:00-07:00' });

  // Mocked board: uuid 1 repeated per location, 2 fails, 3 is malformed, 4 is
  // another posting's document, 5 is fine; plus rows whose uuid is unsafe.
  const list = [
    row(1, 'Chicago, IL'), row(1, 'Houston, TX'), row(1, 'Dallas, TX'),
    row(2, 'Remote'), row(3, 'Remote'), row(4, 'Remote'), row(5, 'New York, NY'),
    { id: '../../../../evil', name: 'Traversal', url: 'https://ats.rippling.com/acme-corp/jobs/t', locations: [{ name: 'Remote' }] },
    { id: 'x?host=evil.example#', name: 'Query', url: 'https://ats.rippling.com/acme-corp/jobs/q', locations: [{ name: 'Remote' }] },
    { id: '//evil.example/a', name: 'Authority', url: 'https://ats.rippling.com/acme-corp/jobs/a', locations: [{ name: 'Remote' }] },
    { name: 'No UUID', url: 'https://ats.rippling.com/acme-corp/jobs/n', locations: [{ name: 'Remote' }] },
  ];
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const detailCtx = {
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      if (url === LIST_URL) return board(list);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const n = Number(url.slice(url.lastIndexOf('-') + 1));
      if (n === 2) throw new Error('HTTP 500');
      if (n === 3) return ['not', 'a', 'document'];
      if (n === 4) return detailFor(99);
      return detailFor(n);
    },
  };
  const { result: enriched, errors: logged } = await captureConsoleErrors(() =>
    rippling.fetch({ name: 'Acme', careers_url: 'https://ats.rippling.com/acme-corp/jobs' }, detailCtx));

  const detailCalls = calls.filter((c) => c.url !== LIST_URL);
  const detailUrls = detailCalls.map((c) => c.url);
  if (enriched.length === list.length) {
    pass('rippling.fetch() keeps every list row — failed, malformed, mismatched and un-enrichable postings included');
  } else {
    fail(`rippling.fetch() returned ${enriched.length} of ${list.length} rows`);
  }
  if (detailUrls.length === 5 && new Set(detailUrls).size === 5
      && detailUrls.filter((u) => u.endsWith(U(1))).length === 1) {
    pass('rippling.fetch() fetches each distinct uuid once (uuid repeated per location row → one GET)');
  } else {
    fail(`rippling.fetch() detail URLs = ${JSON.stringify(detailUrls)}`);
  }
  const hostPinned = detailCalls.every((c) => {
    const p = new URL(c.url);
    return p.protocol === 'https:' && p.hostname === 'ats.rippling.com' && c.opts?.redirect === 'error'
      && /^\/api\/v2\/board\/acme-corp\/jobs\/[0-9a-f-]{36}$/.test(p.pathname) && !p.search && !p.hash;
  });
  if (hostPinned && !detailUrls.some((u) => /evil|\.\.|%2F|\?|#/i.test(u))) {
    pass('rippling.fetch() detail GETs are https ats.rippling.com v2 board path, redirect:"error", clean uuid path — unsafe uuids never requested');
  } else {
    fail(`rippling.fetch() detail calls = ${JSON.stringify(detailCalls)}`);
  }
  if (maxInFlight > 0 && maxInFlight <= 4) pass(`rippling.fetch() bounds detail concurrency (max ${maxInFlight} in flight ≤ 4)`);
  else fail(`rippling.fetch() detail concurrency peaked at ${maxInFlight}`);

  const byTitle = (t) => enriched.filter((j) => j.title === t);
  const role1 = byTitle('Role 1');
  if (role1.length === 3
      && role1.map((j) => j.location).join('|') === 'Chicago, IL|Houston, TX|Dallas, TX'
      && role1.every((j) => j.description === 'Role 1 body\nAcme' && j.postedAt === Date.parse('2026-09-01T17:00:00Z'))) {
    pass('rippling.fetch() merges one detail into every location row of that uuid (locations kept)');
  } else {
    fail(`rippling.fetch() Role 1 rows = ${JSON.stringify(role1)}`);
  }
  const keysOf = (t) => Object.keys(byTitle(t)[0] || {}).sort().join(',');
  if (['Role 2', 'Role 3', 'Role 4', 'Traversal', 'Query', 'Authority', 'No UUID'].every((t) => keysOf(t) === 'company,location,title,url')) {
    pass('rippling.fetch() leaves failed / malformed / other-uuid / unsafe-uuid postings as list-level jobs');
  } else {
    fail(`rippling.fetch() fallback rows = ${JSON.stringify(enriched.filter((j) => j.title !== 'Role 1' && j.title !== 'Role 5'))}`);
  }
  if (byTitle('Role 5')[0]?.description === 'Role 5 body\nAcme') pass('rippling.fetch() enriches a healthy posting');
  else fail(`rippling.fetch() Role 5 = ${JSON.stringify(byTitle('Role 5'))}`);
  if (logged.length === 1 && /enriched 2 of 5 posting\(s\), 3 detail document\(s\) unreadable/.test(logged[0])) {
    pass('rippling.fetch() logs one summary line when detail documents are unreadable');
  } else {
    fail(`rippling.fetch() logged ${JSON.stringify(logged)}`);
  }

  // Cap: 205 distinct uuids → exactly 200 detail GETs, all rows returned, loud.
  const bigList = Array.from({ length: 205 }, (_, i) => row(i + 1, 'Remote'));
  let bigDetailCalls = 0;
  const { result: capped, errors: capLogged } = await captureConsoleErrors(() => rippling.fetch(
    { name: 'Big', careers_url: 'https://ats.rippling.com/acme-corp/jobs' },
    { fetchJson: async (url) => {
      if (url === LIST_URL) return board(bigList);
      bigDetailCalls++;
      return detailFor(Number(url.slice(url.lastIndexOf('-') + 1)));
    } },
  ));
  if (bigDetailCalls === 200 && capped.length === 205
      && capped.filter((j) => j.description).length === 200 && !('description' in capped[204])) {
    pass('rippling.fetch() stops at the 200-detail-request cap and keeps the rest as list-level jobs');
  } else {
    fail(`rippling.fetch() cap: ${bigDetailCalls} detail calls, ${capped.length} jobs, ${capped.filter((j) => j.description).length} enriched`);
  }
  if (capLogged.length === 1 && /5 left undetailed by the 200-request cap/.test(capLogged[0])) {
    pass('rippling.fetch() reports cap truncation on stderr (does not throw)');
  } else {
    fail(`rippling.fetch() cap log = ${JSON.stringify(capLogged)}`);
  }

  // Healthy board: no log line at all.
  const { errors: quietLogged } = await captureConsoleErrors(() => rippling.fetch(
    { name: 'Quiet', careers_url: 'https://ats.rippling.com/acme-corp/jobs' },
    { fetchJson: async (url) => (url === LIST_URL ? board([row(1, 'Remote'), row(2, 'Remote')]) : detailFor(Number(url.slice(url.lastIndexOf('-') + 1)))) },
  ));
  if (quietLogged.length === 0) pass('rippling.fetch() stays silent when every detail resolves');
  else fail(`rippling.fetch() logged on a healthy board: ${JSON.stringify(quietLogged)}`);

  // Probe (ctx.maxPages): exactly one list request, no detail enrichment.
  const probeUrls = [];
  const probed = await rippling.fetch(
    { name: 'Acme', careers_url: 'https://ats.rippling.com/acme-corp/jobs' },
    { maxPages: 1, fetchJson: async (url) => { probeUrls.push(url); return url === LIST_URL ? board(list) : detailFor(1); } },
  );
  if (probeUrls.length === 1 && probeUrls[0] === LIST_URL && probed.length === list.length && probed.every((j) => !('description' in j))) {
    pass('rippling.fetch() under ctx.maxPages (health probe) makes one list request and skips detail enrichment');
  } else {
    fail(`rippling.fetch() probe requested ${JSON.stringify(probeUrls)}`);
  }

  // A list-request failure still propagates (unwrapped) — only details are soft.
  const listErr = new Error('HTTP 503');
  let propagated = null;
  try {
    await rippling.fetch({ name: 'Acme', careers_url: 'https://ats.rippling.com/acme-corp/jobs' }, { sleep: async () => {}, fetchJson: async () => { throw listErr; } });
  } catch (e) {
    propagated = e;
  }
  if (propagated === listErr) pass('rippling.fetch() propagates a list-request rejection unwrapped');
  else fail(`rippling.fetch() list failure → ${propagated}`);

} catch (e) {
  fail(`rippling provider tests crashed: ${e.message}`);
}
