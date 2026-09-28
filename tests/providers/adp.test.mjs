// tests/providers/adp.test.mjs — ADP Workforce Now career-center provider.
import { pass, fail, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — adp');

try {
  const adpModule = await import(pathToFileURL(join(ROOT, 'providers/adp.mjs')).href);
  const adp = adpModule.default;
  const { parseAdpResponse, mergeAdpDetail } = adpModule;

  // Fictional tenant — the shapes mirror the live API, the ids do not.
  const CID = '11111111-2222-4333-8444-555555555555';
  const CCID = '19000101_000001';
  const HOST = 'workforcenow.adp.com';
  const CAREERS = `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}&ccId=${CCID}&lang=en_US`;
  const LIST = `https://${HOST}/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions`;
  const POSTING = `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html`;
  const BOARD = { cid: CID, ccId: CCID, lang: 'en_US' };
  const entry = { name: 'Acme', careers_url: CAREERS };
  const noSleep = async () => {};

  /** A list row in the live shape. */
  const req = (n, over = {}) => ({
    itemID: `${9000 + n}_1`,
    requisitionTitle: `Role ${n}`,
    postDate: '2026-09-01T09:53:00.000-04:00',
    requisitionLocations: [{ address: { cityName: 'Springfield' }, nameCode: { shortName: ' Springfield, IL, US' } }],
    customFieldGroup: {
      stringFields: [{ stringValue: String(500 + n), nameCode: { codeValue: 'ExternalJobID' } }],
      // Live shape: the same wall-clock as postDate, mislabelled Z.
      dateFields: [{ dateValue: '2026-09-01T09:53Z', nameCode: { codeValue: 'PostingDate' } }],
    },
    ...over,
  });
  const postingUrl = (jobId) => `${POSTING}?cid=${CID}&ccId=${CCID}&jobId=${jobId}&lang=en_US`;
  const skipOf = (url) => Number(new URL(url).searchParams.get('$skip'));
  const isList = (url) => new URL(url).pathname.endsWith('/job-requisitions');

  /**
   * A fake board of `total` rows served like the live API: 1-based $skip,
   * pages clamped to 20, `{ jobRequisitions: [] }` past the end.
   */
  function fakeBoard(total, { reportTotal = total, detail = null } = {}) {
    const rows = Array.from({ length: total }, (_, i) => req(i + 1));
    const calls = [];
    const fetchJson = async (url, opts) => {
      calls.push({ url, opts });
      if (isList(url)) {
        const start = skipOf(url);
        const page = rows.slice(start - 1, start - 1 + 20);
        if (page.length === 0) return { jobRequisitions: [] };
        return { jobRequisitions: page, meta: { startSequence: start, totalNumber: reportTotal } };
      }
      const itemID = decodeURIComponent(new URL(url).pathname.split('/').pop());
      return detail ? detail(itemID) : { itemID, requisitionTitle: 'x', requisitionDescription: `<p>JD for ${itemID}</p>` };
    };
    return { calls, ctx: { fetchJson, sleep: noSleep } };
  }

  // ── id ────────────────────────────────────────────────────────────────
  if (adp.id === 'adp') pass('adp.id is "adp"');
  else fail(`adp.id is ${JSON.stringify(adp.id)}`);

  // ── detect() ──────────────────────────────────────────────────────────
  const hit = adp.detect(entry);
  if (hit && hit.url === `${LIST}?cid=${CID}&ccId=${CCID}&lang=en_US&locale=en_US&$top=20&$skip=1`) {
    pass('adp.detect() resolves a recruitment.html careers_url → list API URL');
  } else {
    fail(`adp.detect() returned ${JSON.stringify(hit)}`);
  }

  const lowerCcid = adp.detect({ name: 'X', careers_url: `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}&ccid=${CCID}` });
  const noCcid = adp.detect({ name: 'X', careers_url: `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}` });
  const viaApi = adp.detect({ name: 'X', api: `${LIST}?cid=${CID}&ccId=${CCID}` });
  const frCa = adp.detect({ name: 'X', careers_url: `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}&lang=fr_CA` });
  if (lowerCcid?.url.includes(`&ccId=${CCID}&`)
      && noCcid?.url === `${LIST}?cid=${CID}&lang=en_US&locale=en_US&$top=20&$skip=1`
      && viaApi?.url.startsWith(`${LIST}?cid=${CID}&ccId=${CCID}&`)
      && frCa?.url.includes('&lang=fr_CA&locale=fr_CA&')) {
    pass('adp.detect() reads ccid case-insensitively, tolerates a missing ccId, accepts entry.api, forwards a valid lang');
  } else {
    fail(`adp.detect() variants → ${JSON.stringify({ lowerCcid, noCcid, viaApi, frCa })}`);
  }

  const badLang = adp.detect({ name: 'X', careers_url: `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}&lang=en_US%26x%3D1` });
  if (badLang?.url.includes('&lang=en_US&locale=en_US&') && !badLang.url.includes('x=1')) {
    pass('adp.detect() falls back to en_US for a lang outside xx_YY (no query injection)');
  } else {
    fail(`adp.detect() bad lang → ${JSON.stringify(badLang)}`);
  }

  const rejected = [
    ['untrusted host', `https://careers.example.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}`],
    ['path-spoofed host', `https://evil.example/${HOST}/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}`],
    ['suffix-spoofed host', `https://${HOST}.evil.example/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}`],
    ['userinfo-spoofed host', `https://${HOST}@evil.example/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}`],
    ['non-https', `http://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}`],
    ['outside /mascsr/', `https://${HOST}/theme/index.html?cid=${CID}`],
    ['no cid', `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?ccId=${CCID}`],
    ['non-GUID cid', `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?cid=acme`],
    ['traversal cid', `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?cid=..%2F..%2Fadmin`],
    ['unsafe ccId', `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}&ccId=a%26b%3Dc`],
    ['malformed', 'not a url'],
  ];
  const leaked = rejected.filter(([, url]) => adp.detect({ name: 'X', careers_url: url }) !== null);
  if (leaked.length === 0) pass(`adp.detect() rejects ${rejected.map(([why]) => why).join(', ')}`);
  else fail(`adp.detect() should reject: ${JSON.stringify(leaked)}`);

  let junkThrew = false;
  let junkHits = 0;
  for (const junk of [{ name: 'X' }, { name: 'X', careers_url: null }, { name: 'X', careers_url: 7 }, { name: 'X', careers_url: '' }, {}, null, undefined]) {
    try {
      if (adp.detect(junk) !== null) junkHits++;
    } catch {
      junkThrew = true;
    }
  }
  if (!junkThrew && junkHits === 0) pass('adp.detect() returns null (no throw) for missing / null / non-string careers_url and a null entry');
  else fail(`adp.detect() junk input: threw=${junkThrew} hits=${junkHits}`);

  // A branded page that only embeds the widget is never auto-claimed.
  if (adp.detect({ name: 'X', careers_url: 'https://www.acme.example/careers', adp: { cid: CID, ccId: CCID } }) === null) {
    pass('adp.detect() does not claim a branded careers_url even with an adp: block (needs explicit provider: adp)');
  } else {
    fail('adp.detect() must not claim a branded careers_url');
  }

  // ── parseAdpResponse(): mapping ───────────────────────────────────────
  const surrogateId = '\uD800';
  const parsed = parseAdpResponse({
    meta: { startSequence: 1, totalNumber: 9 },
    jobRequisitions: [
      req(1, { requisitionTitle: '  Detection Engineer  ' }),
      req(2, { requisitionLocations: [
        { nameCode: { shortName: ' Springfield, IL, US' } },
        { nameCode: { shortName: 'Shelbyville, IL, US ' } },
        { nameCode: { shortName: 'springfield, il, us' } },          // duplicate, other case
        { address: { cityName: 'Capital City', countrySubdivisionLevel1: { codeValue: 'IL' } } }, // no shortName
        null,
      ] }),
      req(3, { customFieldGroup: {} }),                               // no ExternalJobID → itemID
      req(4, { customFieldGroup: { stringFields: [{ stringValue: surrogateId, nameCode: { codeValue: 'ExternalJobID' } }] } }),
      req(5, { itemID: 7, customFieldGroup: {} }),                    // no usable id at all → drop
      req(6, { requisitionTitle: '   ' }),                            // drop: blank title
      req(7, { postDate: '2026-09-01T09:53:00', requisitionLocations: [] }), // offset-less → PostingDate field
      req(8, { postDate: 'not a date', customFieldGroup: {
        stringFields: [{ stringValue: 808, nameCode: { codeValue: 'ExternalJobID' } }],
        dateFields: [{ dateValue: '2026-09-01T09:53Z', nameCode: { codeValue: 'PostingDate' } }],
      } }),
      null, 42, 'row',                                                // junk rows
    ],
  }, BOARD, 'Acme');

  const byTitle = Object.fromEntries(parsed.map((j) => [j.title, j]));
  if (parsed.length === 6) pass('parseAdpResponse keeps 6 rows (drops blank title, no usable id, junk rows) without throwing');
  else fail(`parseAdpResponse kept ${parsed.length}: ${JSON.stringify(parsed.map((j) => j.title))}`);

  const first = byTitle['Detection Engineer'];
  if (first
      && first.url === postingUrl('501')
      && first.company === 'Acme'
      && first.location === 'Springfield, IL, US'
      && first.postedAt === Date.parse('2026-09-01T09:53:00.000-04:00')
      && Object.keys(first).sort().join(',') === 'company,location,postedAt,title,url') {
    pass('parseAdpResponse maps title (trimmed), share-link url with ExternalJobID, entry-name company, trimmed shortName, postDate');
  } else {
    fail(`parseAdpResponse row 1 = ${JSON.stringify(first)}`);
  }

  if (byTitle['Role 2']?.location === 'Springfield, IL, US; Shelbyville, IL, US; Capital City, IL') {
    pass('parseAdpResponse joins multiple locations with "; ", de-duplicated, address fallback for a location without shortName');
  } else {
    fail(`parseAdpResponse multi-location = ${JSON.stringify(byTitle['Role 2']?.location)}`);
  }

  if (byTitle['Role 3']?.url === postingUrl('9003_1') && byTitle['Role 4']?.url === postingUrl('9004_1')) {
    pass('parseAdpResponse falls back to itemID for a missing or lone-surrogate ExternalJobID (no URIError)');
  } else {
    fail(`parseAdpResponse itemID fallback = ${JSON.stringify([byTitle['Role 3']?.url, byTitle['Role 4']?.url])}`);
  }

  if (byTitle['Role 7']?.postedAt === Date.parse('2026-09-01') && byTitle['Role 7']?.location === ''
      && byTitle['Role 8']?.postedAt === Date.parse('2026-09-01') && byTitle['Role 8']?.url === postingUrl('808')) {
    pass('parseAdpResponse: offset-less / unparseable postDate → DATE of the PostingDate field (its Z time is not trusted); numeric ExternalJobID accepted; no locations → ""');
  } else {
    fail(`parseAdpResponse date fallback = ${JSON.stringify([byTitle['Role 7'], byTitle['Role 8']])}`);
  }

  const undated = parseAdpResponse({ jobRequisitions: [req(1, { postDate: '2026-09-01T09:53:00', customFieldGroup: { stringFields: [{ stringValue: '1', nameCode: { codeValue: 'ExternalJobID' } }] } })] }, BOARD, 'Acme');
  if (undated.length === 1 && !('postedAt' in undated[0])) pass('parseAdpResponse omits postedAt when no offset-bearing date exists');
  else fail(`parseAdpResponse undated = ${JSON.stringify(undated)}`);

  const postingDateOnly = (dateValue) => parseAdpResponse({ jobRequisitions: [req(1, { postDate: null, customFieldGroup: {
    stringFields: [{ stringValue: '1', nameCode: { codeValue: 'ExternalJobID' } }],
    dateFields: [{ dateValue, nameCode: { codeValue: 'PostingDate' } }],
  } })] }, BOARD, 'Acme')[0]?.postedAt;
  const pdCases = {
    lateEvening: postingDateOnly('2026-09-01T23:30Z'),   // Eastern 23:30 — still Sep 1, not Sep 2
    bare: postingDateOnly('2026-09-03'),
    junk: postingDateOnly('Sep 3 2026'),
    farFuture: postingDateOnly('2099-01-01T00:00Z'),
  };
  if (pdCases.lateEvening === Date.parse('2026-09-01') && pdCases.bare === Date.parse('2026-09-03')
      && pdCases.junk === undefined && pdCases.farFuture === undefined) {
    pass('parseAdpResponse PostingDate fallback keeps only the date (UTC midnight), drops non-ISO and far-future values');
  } else {
    fail(`parseAdpResponse PostingDate fallback = ${JSON.stringify(pdCases)}`);
  }

  // ── Envelope: empty vs. unrecognisable ────────────────────────────────
  const empties = [null, undefined, {}, [], { jobRequisitions: null }, { jobRequisitions: [] }];
  if (empties.every((e) => Array.isArray(parseAdpResponse(e, BOARD, 'Acme')) && parseAdpResponse(e, BOARD, 'Acme').length === 0)) {
    pass('parseAdpResponse: null / {} / [] / {jobRequisitions: null|[]} → []');
  } else {
    fail('parseAdpResponse should return [] for contentless bodies');
  }
  const shapeErrors = [];
  for (const bad of [{ timestamp: 'x', status: 500, error: 'Internal Server Error' }, { jobRequisitions: {} }, 'oops', [{ itemID: '1' }]]) {
    try {
      parseAdpResponse(bad, BOARD, 'Acme');
      shapeErrors.push(null);
    } catch (e) {
      shapeErrors.push(e.message);
    }
  }
  if (shapeErrors.every((m) => typeof m === 'string' && m.startsWith('adp: unexpected API response'))
      && shapeErrors[0].includes('timestamp, status, error')) {
    pass('parseAdpResponse throws a descriptive error (naming the keys) on a body that is not the documented shape');
  } else {
    fail(`parseAdpResponse shape errors = ${JSON.stringify(shapeErrors)}`);
  }

  // ── fetch(): full walk + enrichment ───────────────────────────────────
  {
    const { calls, ctx } = fakeBoard(42);
    const jobs = await adp.fetch(entry, ctx);
    const listCalls = calls.filter((c) => isList(c.url));
    const detailCalls = calls.filter((c) => !isList(c.url));
    if (jobs.length === 42 && listCalls.map((c) => skipOf(c.url)).join(',') === '1,21,41') {
      pass('adp.fetch() walks a 42-row board with 1-based $skip 1,21,41 and stops at meta.totalNumber');
    } else {
      fail(`adp.fetch() walk: ${jobs.length} jobs, skips ${JSON.stringify(listCalls.map((c) => skipOf(c.url)))}`);
    }
    const allSafe = calls.every((c) => {
      const u = new URL(c.url);
      return u.protocol === 'https:' && u.hostname === HOST && c.opts?.redirect === 'error';
    });
    if (allSafe && detailCalls.length === 42) {
      pass('adp.fetch() sends every list AND detail request to https workforcenow.adp.com with redirect:"error"');
    } else {
      fail(`adp.fetch() request hygiene: safe=${allSafe} details=${detailCalls.length}`);
    }
    if (detailCalls.every((c) => /\/job-requisitions\/\d+_1\?cid=/.test(c.url))
        && jobs[0].description === 'JD for 9001_1' && jobs.every((j) => j.description)) {
      pass('adp.fetch() enriches every posting with requisitionDescription (HTML → text) from job-requisitions/<itemID>');
    } else {
      fail(`adp.fetch() enrichment: ${JSON.stringify(jobs[0])}`);
    }
  }

  // Reported-total boundary: the 41st row sits alone on page 3 ($skip=41).
  {
    const { calls, ctx } = fakeBoard(41);
    const jobs = await adp.fetch({ ...entry, adp: { fetchDetails: false } }, ctx);
    const skips = calls.filter((c) => isList(c.url)).map((c) => skipOf(c.url)).join(',');
    if (jobs.length === 41 && skips === '1,21,41' && jobs.some((j) => j.title === 'Role 41')) {
      pass('adp.fetch() fetches the last posting of a totalNumber=41 board ($skip 1,21,41), then stops');
    } else {
      fail(`adp.fetch() total=41: ${jobs.length} jobs, skips ${skips}`);
    }
  }
  {
    const { calls, ctx } = fakeBoard(40);
    const jobs = await adp.fetch({ ...entry, adp: { fetchDetails: false } }, ctx);
    const skips = calls.filter((c) => isList(c.url)).map((c) => skipOf(c.url)).join(',');
    if (jobs.length === 40 && skips === '1,21') pass('adp.fetch() stops at exactly totalNumber=40 without an empty extra page');
    else fail(`adp.fetch() total=40: ${jobs.length} jobs, skips ${skips}`);
  }

  // Enrichment is soft: a failing or foreign detail leaves the list job alone.
  {
    const { ctx } = fakeBoard(3, {
      detail: (itemID) => {
        if (itemID === '9001_1') throw new Error('HTTP 503');
        if (itemID === '9002_1') return { itemID: '9999_1', requisitionDescription: '<p>someone else</p>' };
        return { requisitionTitle: '' }; // the stub an unknown id gets: no itemID
      },
    });
    const { result: jobs, errors } = await captureConsoleErrors(() => adp.fetch(entry, ctx));
    if (jobs.length === 3 && jobs.every((j) => !('description' in j) && j.postedAt)
        && errors.some((e) => String(e).includes('enriched 0 of 3') && String(e).includes('3 detail document(s) unreadable'))) {
      pass('adp.fetch() keeps list-level jobs when details fail, belong to another itemID, or are id-less stubs — and says so');
    } else {
      fail(`adp.fetch() soft enrichment: ${JSON.stringify({ jobs, errors })}`);
    }
  }

  {
    const { calls, ctx } = fakeBoard(5);
    const { result: jobs, errors } = await captureConsoleErrors(() => adp.fetch({ ...entry, adp: { fetchDetails: false } }, ctx));
    if (jobs.length === 5 && calls.every((c) => isList(c.url)) && errors.length === 0) {
      pass('adp.fetch() with adp.fetchDetails:false makes no detail requests (and stays quiet)');
    } else {
      fail(`adp.fetch() fetchDetails:false → ${calls.length} calls, errors ${JSON.stringify(errors)}`);
    }
  }

  // ── Detail enrichment bounds (ADP's per-IP 429, see the provider header) ──
  // At most MAX_DETAIL_REQUESTS (100) per board, and it says so.
  {
    const { calls, ctx } = fakeBoard(250);
    const { result: jobs, errors } = await captureConsoleErrors(() => adp.fetch(entry, ctx));
    const detailCalls = calls.filter((c) => !isList(c.url));
    if (jobs.length === 250 && detailCalls.length === 100 && jobs.filter((j) => j.description).length === 100
        && errors.some((e) => String(e).includes('enriched 100 of 250') && String(e).includes('150 left undetailed by the 100-request cap'))) {
      pass('adp.fetch() sends at most 100 detail requests per board, keeps all 250 postings, and reports the cap');
    } else {
      fail(`adp.fetch() detail cap: ${jobs.length} jobs, ${detailCalls.length} detail calls, ${JSON.stringify(errors)}`);
    }
  }

  // No more than DETAIL_BATCH (4) detail requests in flight at once.
  {
    const { ctx } = fakeBoard(42);
    let inFlight = 0;
    let peak = 0;
    const fetchJson = async (url, opts) => {
      if (isList(url)) return ctx.fetchJson(url, opts);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return ctx.fetchJson(url, opts);
    };
    const jobs = await adp.fetch(entry, { ...ctx, fetchJson });
    if (peak === 4 && jobs.every((j) => j.description)) pass('adp.fetch() keeps at most 4 detail requests in flight');
    else fail(`adp.fetch() detail concurrency peak = ${peak}`);
  }

  // Detail batches are paced through ctx.sleep — between batches, not before the first.
  {
    const { ctx } = fakeBoard(42);
    const events = [];
    const fetchJson = async (url, opts) => {
      events.push(isList(url) ? 'L' : 'D');
      return ctx.fetchJson(url, opts);
    };
    await adp.fetch(entry, { fetchJson, sleep: async (ms) => { events.push(ms > 0 ? 'S' : 'Z'); } });
    const seq = events.join('');
    // 3 list pages (2 inter-page pauses), then 42 details = 10 batches of 4 + 2.
    if (/^LSLSL(DDDDS){10}DD$/.test(seq)) pass('adp.fetch() pauses (via ctx.sleep) between detail batches of 4, not before the first');
    else fail(`adp.fetch() detail pacing sequence = ${seq}`);
  }

  // A detail 429 ends enrichment after its batch: no retry, no further details,
  // every list-level posting kept, and the reason logged.
  {
    const detailSeen = [];
    const { calls, ctx } = fakeBoard(42, {
      detail: (itemID) => {
        detailSeen.push(itemID);
        if (itemID === '9006_1') throw Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429 });
        return { itemID, requisitionDescription: `<p>JD for ${itemID}</p>` };
      },
    });
    const { result: jobs, errors } = await captureConsoleErrors(() => adp.fetch(entry, ctx));
    const detailCalls = calls.filter((c) => !isList(c.url));
    const text = errors.join('\n');
    if (jobs.length === 42 && detailCalls.length === 8 && detailSeen.filter((id) => id === '9006_1').length === 1
        && jobs.filter((j) => j.description).length === 7
        && text.includes('enriched 7 of 42') && text.includes('stopped by an HTTP 429 (ADP rate limit) with 34 not requested')) {
      pass('adp.fetch() stops detail requests after the batch that drew a 429 (no retry), keeping all 42 list-level postings');
    } else {
      fail(`adp.fetch() detail 429: ${jobs.length} jobs, ${detailCalls.length} detail calls, seen ${JSON.stringify(detailSeen)}, ${JSON.stringify(errors)}`);
    }
  }
  // A non-429 detail failure does not stop the others.
  {
    const { calls, ctx } = fakeBoard(12, {
      detail: (itemID) => {
        if (itemID === '9002_1') throw Object.assign(new Error('HTTP 503'), { status: 503 });
        return { itemID, requisitionDescription: '<p>JD</p>' };
      },
    });
    const { result: jobs } = await captureConsoleErrors(() => adp.fetch(entry, ctx));
    if (calls.filter((c) => !isList(c.url)).length === 12 && jobs.filter((j) => j.description).length === 11) {
      pass('adp.fetch() keeps enriching past a non-429 detail failure');
    } else {
      fail(`adp.fetch() detail 503: ${calls.length} calls, ${jobs.filter((j) => j.description).length} described`);
    }
  }

  const mergedDetail = mergeAdpDetail({ title: 't', url: 'u', company: 'c', location: '' }, { itemID: '1', postDate: '2026-09-02T10:00:00.000-04:00', requisitionDescription: '<div><p>Reverse &amp; engineer</p><script>x()</script></div>' });
  const keptDate = mergeAdpDetail({ title: 't', url: 'u', company: 'c', location: '', postedAt: 5 }, { postDate: '2026-09-02T10:00:00.000-04:00' });
  if (mergedDetail.description === 'Reverse & engineer' && mergedDetail.postedAt === Date.parse('2026-09-02T10:00:00.000-04:00')
      && keptDate.postedAt === 5 && !('description' in keptDate) && mergeAdpDetail({ title: 't' }, null).title === 't') {
    pass('mergeAdpDetail: stripped + entity-decoded description, detail postDate only fills a missing date, non-object → unchanged');
  } else {
    fail(`mergeAdpDetail = ${JSON.stringify({ mergedDetail, keptDate })}`);
  }

  // Explicit provider: adp + adp: block for a branded careers_url.
  {
    const { calls, ctx } = fakeBoard(2);
    const jobs = await adp.fetch({ name: 'Acme', provider: 'adp', careers_url: 'https://www.acme.example/careers', adp: { cid: CID, ccid: CCID } }, { ...ctx });
    if (jobs.length === 2 && calls[0].url === `${LIST}?cid=${CID}&ccId=${CCID}&lang=en_US&locale=en_US&$top=20&$skip=1`
        && jobs[0].url === postingUrl('501')) {
      pass('adp.fetch() reads an explicit adp: { cid, ccid } block when careers_url is a branded page');
    } else {
      fail(`adp.fetch() adp block → ${JSON.stringify({ first: calls[0]?.url, jobs })}`);
    }
  }

  // ── SSRF guard runs before any request ────────────────────────────────
  for (const [why, bad] of [
    ['off-host careers_url', { name: 'Acme', careers_url: `https://evil.example/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}` }],
    ['path-spoofed careers_url', { name: 'Acme', careers_url: `https://evil.example/${HOST}/mascsr/x?cid=${CID}` }],
    ['explicit block with an unsafe cid', { name: 'Acme', provider: 'adp', adp: { cid: '../../admin' } }],
    ['explicit block with an unsafe ccId', { name: 'Acme', provider: 'adp', adp: { cid: CID, ccId: 'a&b=c' } }],
  ]) {
    let called = false;
    let threw = null;
    try {
      await adp.fetch(bad, { fetchJson: async () => { called = true; return { jobRequisitions: [] }; }, sleep: noSleep });
    } catch (e) {
      threw = e;
    }
    if (threw && !called && threw.message.startsWith('adp: cannot derive')) pass(`adp.fetch() rejects ${why} before any network call`);
    else fail(`adp.fetch() ${why}: threw=${threw?.message} called=${called}`);
  }

  // ── Pagination bounds ────────────────────────────────────────────────
  // A source that reports a huge total and never runs dry: the provider's own
  // DEFAULT_MAX_PAGES (50) stops it, loudly.
  function endlessBoard() {
    const calls = [];
    const fetchJson = async (url) => {
      calls.push(url);
      if (!isList(url)) return {};
      const start = skipOf(url);
      return {
        meta: { startSequence: start, totalNumber: 1_000_000 },
        jobRequisitions: Array.from({ length: 20 }, (_, i) => req(start + i)),
      };
    };
    return { calls, ctx: { fetchJson, sleep: noSleep } };
  }
  {
    const { calls, ctx } = endlessBoard();
    const { result: jobs, errors } = await captureConsoleErrors(() => adp.fetch({ ...entry, adp: { fetchDetails: false } }, ctx));
    if (calls.length === 50 && jobs.length === 1000 && errors.some((e) => String(e).includes('raise max_pages'))) {
      pass('adp.fetch() stops at its own DEFAULT_MAX_PAGES (50) despite totalNumber=1e6, and warns "raise max_pages"');
    } else {
      fail(`adp.fetch() default cap: ${calls.length} requests, ${jobs.length} jobs, ${JSON.stringify(errors)}`);
    }
  }
  {
    const { calls, ctx } = endlessBoard();
    await captureConsoleErrors(() => adp.fetch({ ...entry, max_pages: 3, adp: { fetchDetails: false } }, ctx));
    const big = endlessBoard();
    await captureConsoleErrors(() => adp.fetch({ ...entry, max_pages: 1_000_000, adp: { fetchDetails: false } }, big.ctx));
    if (calls.length === 3 && big.calls.length === 250) {
      pass('adp.fetch() honours entry max_pages (3) and clamps an oversized one to MAX_PAGES_CAP (250)');
    } else {
      fail(`adp.fetch() max_pages: ${calls.length} / clamp ${big.calls.length}`);
    }
  }

  // A server that ignores $skip (same page forever) stops after one repeat.
  {
    const calls = [];
    const page = { meta: { totalNumber: 1000 }, jobRequisitions: Array.from({ length: 20 }, (_, i) => req(i + 1)) };
    const jobs = await adp.fetch({ ...entry, adp: { fetchDetails: false } }, { fetchJson: async (url) => { calls.push(url); return page; }, sleep: noSleep });
    if (calls.length === 2 && jobs.length === 20) pass('adp.fetch() stops when a page only repeats rows already seen');
    else fail(`adp.fetch() repeat page: ${calls.length} requests, ${jobs.length} jobs`);
  }

  // No meta.totalNumber: a short page ends the walk.
  {
    const calls = [];
    const fetchJson = async (url) => {
      calls.push(url);
      const start = skipOf(url);
      const n = start === 1 ? 20 : 7;
      return { jobRequisitions: Array.from({ length: n }, (_, i) => req(start + i)) };
    };
    const jobs = await adp.fetch({ ...entry, adp: { fetchDetails: false } }, { fetchJson, sleep: noSleep });
    if (calls.length === 2 && jobs.length === 27) pass('adp.fetch() without a reported total stops on a short page');
    else fail(`adp.fetch() no total: ${calls.length} requests, ${jobs.length} jobs`);
  }

  // Inter-page delay: only between pages, through ctx.sleep.
  {
    const slept = [];
    const { ctx } = fakeBoard(42);
    await adp.fetch({ ...entry, adp: { fetchDetails: false } }, { ...ctx, sleep: async (ms) => { slept.push(ms); } });
    if (slept.length === 2 && slept.every((ms) => ms > 0 && ms <= 1000)) pass('adp.fetch() pauses (via ctx.sleep) between pages only, not before the first');
    else fail(`adp.fetch() sleeps = ${JSON.stringify(slept)}`);
  }

  // ── Failure policy ───────────────────────────────────────────────────
  // Page 2 keeps failing (429 through every retry): keep page 1, warn — and
  // never the "raise max_pages" advice.
  {
    let attempts = 0;
    const fetchJson = async (url) => {
      if (!isList(url)) return {};
      if (skipOf(url) === 1) return { meta: { totalNumber: 42 }, jobRequisitions: Array.from({ length: 20 }, (_, i) => req(i + 1)) };
      attempts++;
      const err = new Error('HTTP 429');
      err.status = 429;
      throw err;
    };
    const { result: jobs, errors } = await captureConsoleErrors(() => adp.fetch({ ...entry, adp: { fetchDetails: false } }, { fetchJson, sleep: noSleep }));
    const text = errors.join('\n');
    if (jobs.length === 20 && attempts === 3 && text.includes('stopped at page 2 after 3 attempt(s)') && !text.includes('max_pages')) {
      pass('adp.fetch() retries a failing page 2 (3 attempts), then keeps page 1 and warns without the max_pages advice');
    } else {
      fail(`adp.fetch() page-2 failure: ${jobs.length} jobs, ${attempts} attempts, ${JSON.stringify(errors)}`);
    }
  }

  // Page 1 failing is a broken board: the rejection propagates.
  {
    const gone = Object.assign(new Error('HTTP 404'), { status: 404 });
    let caught = null;
    try {
      await adp.fetch(entry, { fetchJson: async () => { throw gone; }, sleep: noSleep });
    } catch (e) {
      caught = e;
    }
    if (caught === gone) pass('adp.fetch() propagates a first-page rejection (unknown cid → 404) unwrapped');
    else fail(`adp.fetch() first-page failure → ${caught}`);
  }

  // A garbage envelope on page 1 is a loud failure, not an empty board.
  {
    let caught = null;
    try {
      await adp.fetch(entry, { fetchJson: async () => ({ unexpected: true }), sleep: noSleep });
    } catch (e) {
      caught = e;
    }
    if (caught && caught.message.includes('got keys: [unexpected]')) pass('adp.fetch() throws on an unrecognisable first-page body');
    else fail(`adp.fetch() bad envelope → ${caught}`);
  }

  // ── Probe cooperation (verify-portals: ctx.maxPages = 1) ─────────────
  {
    const { calls, ctx } = fakeBoard(42);
    const jobs = await adp.fetch(entry, { ...ctx, maxPages: 1 });
    if (calls.length === 1 && isList(calls[0].url) && jobs.length === 20 && jobs.every((j) => !('description' in j))) {
      pass('adp.fetch() under ctx.maxPages=1 makes exactly one list request and no detail enrichment');
    } else {
      fail(`adp.fetch() probe: ${calls.length} requests, ${jobs.length} jobs`);
    }
  }
  {
    class BudgetSentinel extends Error {}
    const sentinel = new BudgetSentinel('budget');
    let caught = null;
    const fetchJson = async (url) => {
      if (skipOf(url) === 1) return { meta: { totalNumber: 42 }, jobRequisitions: Array.from({ length: 20 }, (_, i) => req(i + 1)) };
      throw sentinel;
    };
    try {
      await adp.fetch(entry, { fetchJson, sleep: noSleep, maxPages: 2 });
    } catch (e) {
      caught = e;
    }
    if (caught === sentinel) pass('adp.fetch() propagates a later-page rejection unwrapped while probing (not swallowed into a partial list)');
    else fail(`adp.fetch() probe rejection → ${caught}`);
  }
} catch (e) {
  fail(`adp provider tests crashed: ${e.stack || e.message}`);
}
