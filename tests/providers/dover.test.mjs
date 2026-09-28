// tests/providers/dover.test.mjs — direct provider-contract tests for dover.
// Offline: every request goes through a scripted ctx.fetchJson. Fixture shapes
// mirror the live app.dover.com careers-page API (2026-09); names are fictional.
import { pass, fail, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — dover');

const API = 'https://app.dover.com/api/v1';
const CLIENT_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const JOB_A = 'bbbbbbbb-0000-4000-8000-000000000001';
const JOB_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const JOB_C = 'bbbbbbbb-0000-4000-8000-000000000003';

/** A job id for index n (for bulk fixtures). */
const jid = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;

const clientDoc = { id: CLIENT_ID, slug: 'acme', name: 'Acme Labs', careers_page_info: '<p>About</p>' };

const hybridRow = {
  id: JOB_A,
  title: '  Senior AI Engineer ',
  locations: [{
    location_type: 'HYBRID',
    location_option: { id: 'x', display_name: 'Baltimore, MD', location_type: 'CITY', city: 'Baltimore', state: 'Maryland', country: 'US' },
    name: 'Baltimore, MD',
    is_primary: true,
  }],
  workplace_type: 'HYBRID',
  is_published: true,
  is_sample: false,
};
const remoteRow = {
  id: JOB_B.toUpperCase(),
  title: 'Security Researcher',
  locations: [
    { location_type: 'REMOTE', location_option: { display_name: 'Canada' }, name: 'Canada', is_primary: false },
    { location_type: 'REMOTE', location_option: { display_name: 'United States' }, name: 'United States', is_primary: true },
    { location_type: 'REMOTE', location_option: { display_name: 'united states' }, name: 'United States', is_primary: false },
  ],
  workplace_type: 'REMOTE',
  is_published: true,
  is_sample: false,
};
const onsiteRow = {
  id: JOB_C,
  title: 'Office Manager',
  locations: [{ location_type: 'IN_OFFICE', location_option: { display_name: 'New York City, NY' }, name: 'New York, NY', is_primary: true }],
  workplace_type: 'ONSITE',
  is_published: true,
  is_sample: false,
};
const badRows = [
  null,
  'not a row',
  { id: jid(90), title: 'Sample Posting', is_sample: true, is_published: true },
  { id: jid(91), title: 'Unpublished', is_published: false },
  { id: 'not-a-uuid', title: 'Bad Id' },
  { id: jid(92), title: '   ' },
  { title: 'No Id' },
];

/**
 * Scripted ctx: `routes` maps an exact URL (or a predicate) to a body or a
 * function returning one; a thrown value rejects. Records every call.
 */
function makeCtx(routes, extra = {}) {
  const calls = [];
  const ctx = {
    calls,
    sleep: async () => {},
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      for (const [match, body] of routes) {
        const hit = typeof match === 'function' ? match(url) : match === url;
        if (!hit) continue;
        const value = typeof body === 'function' ? body(url) : body;
        if (value instanceof Error) throw value;
        return value;
      }
      const err = new Error(`HTTP 404 (unscripted ${url})`);
      /** @type {any} */ (err).status = 404;
      throw err;
    },
    fetchText: async () => { throw new Error('fetchText must not be used'); },
    ...extra,
  };
  return ctx;
}

const pageUrl = (offset, clientId = CLIENT_ID) => `${API}/careers-page/${clientId}/jobs?limit=100&offset=${offset}`;
const detailUrl = (id) => `${API}/inbound/application-portal-job/${id}`;
const envelope = (results, next = null, count = results.length) => ({ count, next, previous: null, results });
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/dover.mjs')).href);
  const dover = mod.default;
  const { formatDoverLocation, readDoverJobsPage, parseDoverRows, mergeDoverDetail } = mod;

  if (dover.id === 'dover') pass('dover.id is "dover"');
  else fail(`dover.id is ${JSON.stringify(dover.id)}`);

  // ── detect() ────────────────────────────────────────────────────────
  const detectCases = [
    ['https://app.dover.com/jobs/acme', `${API}/careers-page-slug/acme`],
    ['https://app.dover.com/jobs/acme-0ef01d90/', `${API}/careers-page-slug/acme-0ef01d90`],
    [`https://app.dover.com/Acme%20Labs/careers/${CLIENT_ID.toUpperCase()}`, `${API}/careers-page/${CLIENT_ID}`],
    [`https://app.dover.com/apply/Acme/${JOB_A}/?rs=123`, `${API}/inbound/application-portal-job/${JOB_A}`],
  ];
  for (const [careersUrl, want] of detectCases) {
    const hit = dover.detect({ name: 'Acme', careers_url: careersUrl });
    if (hit?.url === want) pass(`dover.detect() claims ${careersUrl}`);
    else fail(`dover.detect(${careersUrl}) → ${JSON.stringify(hit)}, want ${want}`);
  }

  const rejected = [
    'https://evil.example/jobs/acme',
    'https://evil.example/app.dover.com/jobs/acme', // path-spoofed host
    'https://app.dover.com.evil.example/jobs/acme', // suffix-spoofed host
    'https://app.dover.com@evil.example/jobs/acme', // userinfo spoof → host is evil.example
    'https://dover.com/jobs/acme',
    'http://app.dover.com/jobs/acme',
    'https://app.dover.com/jobs',
    'https://app.dover.com/',
    'https://app.dover.com/jobs/acme.corp',
    'https://app.dover.com/jobs/-acme',
    'https://app.dover.com/jobs/%2e%2e',
    'https://app.dover.com/jobs/a%2Fb',
    'https://app.dover.com/apply/Acme/not-a-uuid',
    'https://app.dover.com/Acme/careers/123',
    'not a url',
    '',
  ];
  const wronglyClaimed = rejected.filter((u) => dover.detect({ name: 'X', careers_url: u }) !== null);
  if (wronglyClaimed.length === 0) pass('dover.detect() rejects off-host, spoofed, non-https, malformed and unsafe-id URLs');
  else fail(`dover.detect() claimed: ${wronglyClaimed.join(', ')}`);

  let junkThrew = false;
  let junkHit = false;
  try {
    for (const e of [{ name: 'X', careers_url: null }, { name: 'X', careers_url: 7 }, { name: 'X' }, {}, null, undefined]) {
      if (dover.detect(/** @type {any} */ (e)) !== null) junkHit = true;
    }
  } catch { junkThrew = true; }
  if (!junkThrew && !junkHit) pass('dover.detect() returns null (no throw) for null / non-string / missing careers_url and a null entry');
  else fail(`dover.detect() junk input: threw=${junkThrew} hit=${junkHit}`);

  // ── pure helpers ────────────────────────────────────────────────────
  const locCases = [
    [hybridRow, 'Baltimore, MD (Hybrid)'],
    [remoteRow, 'United States; Canada (Remote)'], // primary first, case-insensitive dedupe
    [onsiteRow, 'New York City, NY'], // display_name wins over name; ONSITE appends nothing
    [{ workplace_type: 'REMOTE', locations: [] }, 'Remote'],
    [{ workplace_type: 'ONSITE', locations: [] }, ''],
    [{ locations: [{ location_type: 'HYBRID', name: 'Austin, TX' }] }, 'Austin, TX (Hybrid)'], // per-location fallback
    [{ locations: [{ location_type: 'HYBRID', name: 'A' }, { location_type: 'REMOTE', name: 'B' }] }, 'A; B'], // disagree → no label
    [{ workplace_type: 'REMOTE', locations: [{ name: 'Remote - US' }] }, 'Remote - US'], // no "(Remote)" twice
    [{ workplace_type: 'HYBRID', locations: [null, 'x', { location_option: null, name: 'Paris, France' }] }, 'Paris, France (Hybrid)'],
    [{ locations: 'nope' }, ''],
  ];
  const locBad = locCases.filter(([row, want]) => formatDoverLocation(row) !== want)
    .map(([row, want]) => `${JSON.stringify(row).slice(0, 60)} → ${JSON.stringify(formatDoverLocation(row))} (want ${JSON.stringify(want)})`);
  if (locBad.length === 0) pass('formatDoverLocation(): primary-first names, dedupe, Remote/Hybrid suffix, fallbacks');
  else fail(`formatDoverLocation(): ${locBad.join(' | ')}`);

  const parsed = parseDoverRows([hybridRow, remoteRow, onsiteRow, ...badRows], 'Acme', 'Acme%20Labs');
  if (parsed.length === 3
      && parsed[0].id === JOB_A
      && parsed[0].job.title === 'Senior AI Engineer'
      && parsed[0].job.url === `https://app.dover.com/apply/Acme%20Labs/${JOB_A}/`
      && parsed[0].job.company === 'Acme'
      && parsed[0].job.location === 'Baltimore, MD (Hybrid)'
      && parsed[1].id === JOB_B && parsed[1].job.url.endsWith(`/${JOB_B}/`)
      && Object.keys(parsed[0].job).sort().join(',') === 'company,location,title,url') {
    pass('parseDoverRows(): maps title/url/company/location, lower-cases the id, skips sample/unpublished/bad rows');
  } else {
    fail(`parseDoverRows() → ${JSON.stringify(parsed)}`);
  }
  if (parseDoverRows(/** @type {any} */ (null), 'Acme', 'x').length === 0) pass('parseDoverRows(): non-array → []');
  else fail('parseDoverRows(): non-array should give []');

  // readDoverJobsPage(): empty bodies vs a shape change.
  const emptyBodies = [null, undefined, {}, [], { results: null }, { count: 0, next: null, previous: null }];
  if (emptyBodies.every((b) => readDoverJobsPage(b).rows.length === 0 && readDoverJobsPage(b).hasNext === false)) {
    pass('readDoverJobsPage(): null / {} / [] / {results:null} / bare envelope → empty');
  } else {
    fail('readDoverJobsPage(): an empty body should read as an empty page');
  }
  const shapeChanges = [{ jobs: [hybridRow] }, { results: 'x' }, [hybridRow], 'text'];
  const shapeMsgs = shapeChanges.map((b) => { try { readDoverJobsPage(b); return null; } catch (e) { return e.message; } });
  if (shapeMsgs.every((m) => typeof m === 'string' && m.startsWith('dover:')) && /keys: jobs/.test(shapeMsgs[0])) {
    pass('readDoverJobsPage(): an undocumented shape throws a descriptive dover: error naming the keys');
  } else {
    fail(`readDoverJobsPage() shape-change messages: ${JSON.stringify(shapeMsgs)}`);
  }

  // mergeDoverDetail(): description / postedAt / salary.
  const baseJob = { title: 'T', url: 'https://app.dover.com/apply/Acme/x/', company: 'Acme', location: '' };
  const merged = mergeDoverDetail(baseJob, {
    id: JOB_A,
    user_provided_description: '<h1>Senior AI Engineer</h1><p>Build agents &amp; evals.</p>',
    created: '2026-09-22T20:22:56.231573Z',
    compensation: { lower_bound: 190000, upper_bound: 260000, currency_code: 'usd', open_to_sharing_comp: true, salary_range_type: 'YEARLY' },
  });
  if (merged.description === 'Senior AI Engineer Build agents & evals.'
      && merged.postedAt === Date.parse('2026-09-22T20:22:56.231573Z')
      && merged.salary?.min === 190000 && merged.salary?.max === 260000 && merged.salary?.currency === 'USD'
      && !('description' in baseJob)) {
    pass('mergeDoverDetail(): HTML description → text, created → postedAt, shared comp → salary; input not mutated');
  } else {
    fail(`mergeDoverDetail() → ${JSON.stringify(merged)}`);
  }
  const hourly = mergeDoverDetail(baseJob, { compensation: { lower_bound: 55, upper_bound: null, currency_code: 'USD', open_to_sharing_comp: true, salary_range_type: 'HOURLY' } });
  const hidden = mergeDoverDetail(baseJob, { compensation: { lower_bound: 100000, upper_bound: 120000, currency_code: 'USD', open_to_sharing_comp: false, salary_range_type: 'YEARLY' } });
  const junk = mergeDoverDetail(baseJob, { created: '2026-09-22 20:22', user_provided_description: '', compensation: { open_to_sharing_comp: true, salary_range_type: 'WEEKLY', lower_bound: 5 } });
  if (hourly.salary?.min === 55 * 2080 && hourly.salary?.max === 55 * 2080
      && !('salary' in hidden) && !('salary' in junk) && !('postedAt' in junk) && !('description' in junk)
      && mergeDoverDetail(baseJob, null) === baseJob) {
    pass('mergeDoverDetail(): hourly annualized; unshared comp, unknown pay period, offset-less date and empty body omitted');
  } else {
    fail(`mergeDoverDetail() edge cases: ${JSON.stringify({ hourly, hidden, junk })}`);
  }

  // ── fetch(): full path against the live response shape ──────────────
  const slugUrl = `${API}/careers-page-slug/acme`;
  const entry = { name: 'Acme', careers_url: 'https://app.dover.com/jobs/acme' };
  {
    const ctx = makeCtx([
      [slugUrl, clientDoc],
      [pageUrl(0), envelope([hybridRow, remoteRow, ...badRows])],
      [detailUrl(JOB_A), { id: JOB_A, client_id: CLIENT_ID, user_provided_description: '<p>Role</p>', created: '2026-09-22T20:22:56Z', compensation: { open_to_sharing_comp: false } }],
      [detailUrl(JOB_B), { id: JOB_C, user_provided_description: '<p>Wrong posting</p>' }], // mismatched id → not merged
    ]);
    const { result: jobs, errors } = await captureConsoleErrors(() => dover.fetch(entry, ctx));
    const urls = ctx.calls.map((c) => c.url);
    if (jobs.length === 2
        && jobs[0].url === `https://app.dover.com/apply/Acme%20Labs/${JOB_A}/`
        && jobs[0].description === 'Role' && jobs[0].postedAt === Date.parse('2026-09-22T20:22:56Z')
        && jobs[1].title === 'Security Researcher' && !('description' in jobs[1])) {
      pass('dover.fetch(): resolves slug → client, lists, enriches; a mismatched detail document is not merged');
    } else {
      fail(`dover.fetch() jobs = ${JSON.stringify(jobs)}`);
    }
    if (urls.join(' ') === [slugUrl, pageUrl(0), detailUrl(JOB_A), detailUrl(JOB_B)].join(' ')) {
      pass('dover.fetch(): request sequence is slug lookup → jobs page → one detail per posting');
    } else {
      fail(`dover.fetch() requests = ${JSON.stringify(urls)}`);
    }
    if (ctx.calls.every((c) => c.opts?.redirect === 'error')) pass('dover.fetch(): every request passes redirect: "error"');
    else fail(`dover.fetch(): redirect opts = ${JSON.stringify(ctx.calls.map((c) => c.opts))}`);
    if (ctx.calls.every((c) => new URL(c.url).hostname === 'app.dover.com')) pass('dover.fetch(): every request stays on app.dover.com');
    else fail('dover.fetch(): a request left app.dover.com');
    if (errors.some((e) => /enriched 1 of 2 posting\(s\), 1 detail document\(s\) unreadable/.test(String(e)))) {
      pass('dover.fetch(): reports partial enrichment on stderr');
    } else {
      fail(`dover.fetch() stderr = ${JSON.stringify(errors)}`);
    }
  }

  // Client-id route resolves via /careers-page/<id>; a name-less client falls back to the slug in the URL.
  {
    const ctx = makeCtx([
      [`${API}/careers-page/${CLIENT_ID}`, { id: CLIENT_ID, slug: 'acme', name: '' }],
      [pageUrl(0), envelope([onsiteRow])],
      [detailUrl(JOB_C), httpErr(500)], // detail failure → posting kept as listed
    ]);
    const { result: jobs } = await captureConsoleErrors(() => dover.fetch({ name: 'Acme', careers_url: `https://app.dover.com/Acme/careers/${CLIENT_ID}` }, ctx));
    if (jobs.length === 1 && jobs[0].url === `https://app.dover.com/apply/acme/${JOB_C}/` && jobs[0].location === 'New York City, NY' && !('description' in jobs[0])) {
      pass('dover.fetch(): client-id route works; empty name → slug URL segment; failed detail keeps the listing');
    } else {
      fail(`dover.fetch() client route → ${JSON.stringify(jobs)}`);
    }
  }

  // Apply-page route: resolves the board through the posting and reuses that
  // posting's document as its detail (no second request for it). A name with a
  // lone surrogate cannot be encoded → the client id is the segment.
  {
    const seed = { id: JOB_A, client_id: CLIENT_ID.toUpperCase(), client_name: 'Acme \uD800', user_provided_description: '<p>Seeded</p>', created: '2026-09-01T00:00:00Z' };
    const ctx = makeCtx([
      [detailUrl(JOB_A), seed],
      [pageUrl(0), envelope([hybridRow])],
    ]);
    const { result: jobs } = await captureConsoleErrors(() => dover.fetch({ name: 'Acme', careers_url: `https://app.dover.com/apply/Acme/${JOB_A}/` }, ctx));
    const detailCalls = ctx.calls.filter((c) => c.url === detailUrl(JOB_A)).length;
    if (jobs.length === 1 && jobs[0].description === 'Seeded' && detailCalls === 1
        && jobs[0].url === `https://app.dover.com/apply/${CLIENT_ID}/${JOB_A}/`) {
      pass('dover.fetch(): apply-page route resolves via the posting, reuses its document, unencodable name → client id segment');
    } else {
      fail(`dover.fetch() apply route → ${JSON.stringify(jobs)} (detail calls ${detailCalls})`);
    }
  }

  // ── SSRF: the guard runs before any request ─────────────────────────
  for (const careersUrl of ['https://evil.example/app.dover.com/jobs/acme', 'https://app.dover.com.evil.example/jobs/acme', 'http://app.dover.com/jobs/acme']) {
    const ctx = makeCtx([]);
    let threw = null;
    try { await dover.fetch({ name: 'Evil', careers_url: careersUrl }, ctx); } catch (e) { threw = e; }
    if (threw && /dover:/.test(threw.message) && ctx.calls.length === 0) pass(`dover.fetch() rejects ${careersUrl} before any request`);
    else fail(`dover.fetch(${careersUrl}): threw=${threw?.message} calls=${ctx.calls.length}`);
  }

  // A resolve response without a client id is a shape change → throw, not [].
  {
    const ctx = makeCtx([[slugUrl, { detail: 'something else' }]]);
    let threw = null;
    try { await dover.fetch(entry, ctx); } catch (e) { threw = e; }
    if (threw && /no client id \(keys: detail\)/.test(threw.message)) pass('dover.fetch(): a slug lookup with no client id throws a descriptive error');
    else fail(`dover.fetch() bad resolve → ${threw?.message}`);
  }

  // A 404 on the slug lookup (board gone) propagates.
  {
    const gone = httpErr(404);
    const ctx = makeCtx([[slugUrl, gone]]);
    let threw = null;
    try { await dover.fetch(entry, ctx); } catch (e) { threw = e; }
    if (threw === gone && ctx.calls.length === 1) pass('dover.fetch(): a 404 slug lookup propagates unwrapped, not retried');
    else fail(`dover.fetch() 404 slug → ${threw?.message} after ${ctx.calls.length} call(s)`);
  }

  // Empty board bodies → [] with no detail requests.
  for (const body of [null, {}, [], { results: null }, envelope([])]) {
    const ctx = makeCtx([[slugUrl, clientDoc], [pageUrl(0), body]]);
    const jobs = await dover.fetch(entry, ctx);
    if (!(Array.isArray(jobs) && jobs.length === 0 && ctx.calls.length === 2)) {
      fail(`dover.fetch() empty body ${JSON.stringify(body)} → ${JSON.stringify(jobs)} after ${ctx.calls.length} calls`);
    }
  }
  pass('dover.fetch(): empty / contentless jobs bodies → [] with no further requests');
  {
    const ctx = makeCtx([[slugUrl, clientDoc], [pageUrl(0), { jobs: [hybridRow] }]]);
    let threw = null;
    try { await dover.fetch(entry, ctx); } catch (e) { threw = e; }
    if (threw && /no results array/.test(threw.message)) pass('dover.fetch(): an undocumented jobs envelope throws');
    else fail(`dover.fetch() bad envelope → ${threw?.message}`);
  }

  // ── Pagination ──────────────────────────────────────────────────────
  // Server clamps limit=100 to 50: offset advances by rows returned (0, 50, 100).
  {
    const rowsFor = (from, n) => Array.from({ length: n }, (_, i) => ({ id: jid(from + i), title: `Role ${from + i}`, locations: [], workplace_type: 'REMOTE', is_published: true, is_sample: false }));
    const ctx = makeCtx([
      [slugUrl, clientDoc],
      [pageUrl(0), envelope(rowsFor(0, 50), `${API}/careers-page/${CLIENT_ID}/jobs?limit=50&offset=50`, 120)],
      [pageUrl(50), envelope(rowsFor(50, 50), `${API}/careers-page/${CLIENT_ID}/jobs?limit=50&offset=100`, 120)],
      [pageUrl(100), envelope(rowsFor(100, 20), null, 120)],
      [(u) => u.startsWith(`${API}/inbound/`), (u) => ({ id: u.split('/').pop() })],
    ]);
    const { result: jobs } = await captureConsoleErrors(() => dover.fetch(entry, ctx));
    const pages = ctx.calls.filter((c) => c.url.includes('/jobs?')).map((c) => new URL(c.url).searchParams.get('offset'));
    if (jobs.length === 120 && pages.join(',') === '0,50,100') pass('dover.fetch(): follows next with offset advanced by rows returned (clamped page size safe)');
    else fail(`dover.fetch() pagination: ${jobs.length} jobs, offsets ${pages.join(',')}`);
    const details = ctx.calls.filter((c) => c.url.includes('/inbound/')).length;
    if (details === 15) pass('dover.fetch(): detail enrichment capped at 15 requests per board');
    else fail(`dover.fetch(): ${details} detail requests (want 15)`);
  }

  // The provider's own DEFAULT_MAX_PAGES (10) stops a source that never ends, and says so.
  {
    const endless = (u) => {
      const off = Number(new URL(u).searchParams.get('offset'));
      return envelope([{ id: jid(1000 + off), title: `Role ${off}`, locations: [] }], `${u}#more`, 1_000_000);
    };
    const ctx = makeCtx([[slugUrl, clientDoc], [(u) => u.includes('/jobs?'), endless], [(u) => u.includes('/inbound/'), (u) => ({ id: u.split('/').pop() })]]);
    const { result: jobs, errors } = await captureConsoleErrors(() => dover.fetch(entry, ctx));
    const pages = ctx.calls.filter((c) => c.url.includes('/jobs?')).length;
    if (pages === 10 && jobs.length === 10 && errors.some((e) => /raise max_pages/.test(String(e)))) {
      pass('dover.fetch(): DEFAULT_MAX_PAGES stops an endless source at 10 pages and warns to raise max_pages');
    } else {
      fail(`dover.fetch() endless: ${pages} pages, ${jobs.length} jobs, stderr ${JSON.stringify(errors)}`);
    }

    const ctx2 = makeCtx([[slugUrl, clientDoc], [(u) => u.includes('/jobs?'), endless], [(u) => u.includes('/inbound/'), (u) => ({ id: u.split('/').pop() })]]);
    await captureConsoleErrors(() => dover.fetch({ ...entry, max_pages: 2 }, ctx2));
    const pages2 = ctx2.calls.filter((c) => c.url.includes('/jobs?')).length;
    const ctx3 = makeCtx([[slugUrl, clientDoc], [(u) => u.includes('/jobs?'), endless], [(u) => u.includes('/inbound/'), (u) => ({ id: u.split('/').pop() })]]);
    await captureConsoleErrors(() => dover.fetch({ ...entry, max_pages: 99999 }, ctx3));
    const pages3 = ctx3.calls.filter((c) => c.url.includes('/jobs?')).length;
    if (pages2 === 2 && pages3 === 50) pass('dover.fetch(): entry.max_pages is honoured and hard-capped at 50');
    else fail(`dover.fetch() max_pages: 2 → ${pages2} pages, 99999 → ${pages3} pages`);
  }

  // Page 2 failing after retries: keep page 1, warn, and do NOT say "raise max_pages".
  {
    const ctx = makeCtx([
      [slugUrl, clientDoc],
      [pageUrl(0), envelope([hybridRow], `${API}/careers-page/${CLIENT_ID}/jobs?limit=100&offset=1`, 2)],
      [pageUrl(1), httpErr(503)],
      [(u) => u.includes('/inbound/'), (u) => ({ id: u.split('/').pop() })],
    ]);
    const { result: jobs, errors } = await captureConsoleErrors(() => dover.fetch(entry, ctx));
    const page2Attempts = ctx.calls.filter((c) => c.url === pageUrl(1)).length;
    if (jobs.length === 1 && page2Attempts === 3
        && errors.some((e) => /truncated at page 2 after 3 attempt/.test(String(e)))
        && !errors.some((e) => /raise max_pages/.test(String(e)))) {
      pass('dover.fetch(): a 503 on page 2 is retried, then page 1 is kept with a warning (no "raise max_pages")');
    } else {
      fail(`dover.fetch() page-2 failure: ${jobs.length} jobs, ${page2Attempts} attempts, stderr ${JSON.stringify(errors)}`);
    }
  }

  // ── Probe cooperation (ctx.maxPages) ────────────────────────────────
  {
    const ctx = makeCtx([
      [slugUrl, clientDoc],
      [pageUrl(0), envelope([hybridRow, remoteRow], `${API}/careers-page/${CLIENT_ID}/jobs?limit=100&offset=2`, 500)],
    ], { maxPages: 1 });
    const { result: jobs, errors } = await captureConsoleErrors(() => dover.fetch(entry, ctx));
    const listCalls = ctx.calls.filter((c) => c.url.includes('/jobs?')).length;
    const detailCalls = ctx.calls.filter((c) => c.url.includes('/inbound/')).length;
    if (jobs.length === 2 && listCalls === 1 && detailCalls === 0 && ctx.calls.length === 2 && errors.length === 0) {
      pass('dover.fetch() with ctx.maxPages=1: one list request, no enrichment, no warning');
    } else {
      fail(`dover.fetch() probe: ${jobs.length} jobs, ${listCalls} list, ${detailCalls} detail, ${ctx.calls.length} total, stderr ${JSON.stringify(errors)}`);
    }
  }
  {
    class ProbeBudget extends Error {}
    const sentinel = new ProbeBudget('budget');
    const ctx = makeCtx([
      [slugUrl, clientDoc],
      [pageUrl(0), envelope([hybridRow], `${API}/careers-page/${CLIENT_ID}/jobs?limit=100&offset=1`, 2)],
      [pageUrl(1), sentinel],
    ], { maxPages: 3 });
    let threw = null;
    try { await dover.fetch(entry, ctx); } catch (e) { threw = e; }
    if (threw === sentinel) pass('dover.fetch(): a ctx.fetchJson rejection while probing propagates unwrapped (identity kept)');
    else fail(`dover.fetch() probe rejection → ${threw}`);
  }

  // ── Enrichment rate limit: the first 429 ends enrichment ────────────
  {
    const ctx = makeCtx([
      [slugUrl, clientDoc],
      [pageUrl(0), envelope([hybridRow, remoteRow, onsiteRow])],
      [detailUrl(JOB_A), httpErr(429)],
    ]);
    const { result: jobs, errors } = await captureConsoleErrors(() => dover.fetch(entry, ctx));
    const detailCalls = ctx.calls.filter((c) => c.url.includes('/inbound/')).length;
    if (jobs.length === 3 && detailCalls === 1 && errors.some((e) => /enriched 0 of 3 .*rate limit/.test(String(e)))) {
      pass('dover.fetch(): a 429 on a detail stops enrichment for the board and keeps every listing');
    } else {
      fail(`dover.fetch() 429: ${jobs.length} jobs, ${detailCalls} detail calls, stderr ${JSON.stringify(errors)}`);
    }
  }

  // A challenge page served with a 2xx reaches fetchJson as a non-JSON body
  // (SyntaxError) — same stop as a 429; an ordinary failure does not stop.
  {
    const ctx = makeCtx([
      [slugUrl, clientDoc],
      [pageUrl(0), envelope([hybridRow, remoteRow, onsiteRow])],
      [detailUrl(JOB_A), httpErr(500)],
      [detailUrl(JOB_B), new SyntaxError('Unexpected token < in JSON at position 0')],
    ]);
    const { result: jobs, errors } = await captureConsoleErrors(() => dover.fetch(entry, ctx));
    const detailCalls = ctx.calls.filter((c) => c.url.includes('/inbound/')).length;
    if (jobs.length === 3 && detailCalls === 2
        && errors.some((e) => /1 detail document\(s\) unreadable \(first: HTTP 500\).*rate limit \(a non-JSON body\)/.test(String(e)))) {
      pass('dover.fetch(): a 500 detail is skipped, a non-JSON detail body stops enrichment; stderr names both');
    } else {
      fail(`dover.fetch() non-JSON detail: ${jobs.length} jobs, ${detailCalls} detail calls, stderr ${JSON.stringify(errors)}`);
    }
  }

  // Pages overlapping (a list that shifted between requests) dedupe by job id.
  {
    const ctx = makeCtx([
      [slugUrl, clientDoc],
      [pageUrl(0), envelope([hybridRow], `${API}/careers-page/${CLIENT_ID}/jobs?limit=100&offset=1`, 3)],
      [pageUrl(1), envelope([hybridRow, onsiteRow], null, 3)],
      [(u) => u.includes('/inbound/'), (u) => ({ id: u.split('/').pop() })],
    ]);
    const { result: jobs } = await captureConsoleErrors(() => dover.fetch(entry, ctx));
    if (jobs.length === 2 && new Set(jobs.map((j) => j.url)).size === 2) pass('dover.fetch(): a posting repeated across pages is kept once');
    else fail(`dover.fetch() dedupe → ${JSON.stringify(jobs.map((j) => j.url))}`);
  }
} catch (e) {
  fail(`dover provider tests crashed: ${e.stack || e.message}`);
}
