// tests/providers/comeet.test.mjs — moved verbatim from test-all.mjs (#1440).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — comeet');


try {
  const comeetModule = await import(pathToFileURL(join(ROOT, 'providers/comeet.mjs')).href);
  const comeet = comeetModule.default;
  const { parseComeetResponse } = comeetModule;

  if (comeet.id === 'comeet') pass('comeet.id is "comeet"');
  else fail(`comeet.id is ${JSON.stringify(comeet.id)}`);

  // detect: explicit api: careers-api URL is honoured (and the secret token is
  // redacted from the informational DetectHit url).
  const apiUrl = 'https://www.comeet.co/careers-api/2.0/company/30.005/positions?token=ABC123';
  const apiHit = comeet.detect({ name: 'Spark Hire', api: apiUrl, careers_url: 'https://www.comeet.com/jobs/spark-hire/30.005' });
  if (apiHit && apiHit.url === 'https://www.comeet.co/careers-api/2.0/company/30.005/positions?token=REDACTED') {
    pass('comeet.detect() resolves an explicit api: URL and redacts the token');
  } else {
    fail(`comeet.detect() api: → ${JSON.stringify(apiHit)}`);
  }

  // the DetectHit url must not leak the real token (it may be logged)
  if (apiHit && !apiHit.url.includes('ABC123')) {
    pass('comeet.detect() does not leak the real token in the DetectHit url');
  } else {
    fail(`comeet.detect() leaked the token: ${JSON.stringify(apiHit)}`);
  }

  // detect: full careers-api URL pasted into careers_url is also accepted
  const cuHit = comeet.detect({ name: 'X', careers_url: apiUrl });
  if (cuHit && cuHit.url === 'https://www.comeet.co/careers-api/2.0/company/30.005/positions?token=REDACTED') {
    pass('comeet.detect() accepts a careers-api URL in careers_url');
  } else {
    fail(`comeet.detect() careers_url → ${JSON.stringify(cuHit)}`);
  }

  // detect: a branded www.comeet.com/jobs page carries no token → not claimed
  if (comeet.detect({ name: 'X', careers_url: 'https://www.comeet.com/jobs/spark-hire/30.005' }) === null) {
    pass('comeet.detect() returns null for a branded careers page (no token)');
  } else {
    fail('comeet.detect() should not claim a tokenless branded careers page');
  }

  if (comeet.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('comeet.detect() returns null for non-comeet URLs');
  } else {
    fail('comeet.detect() should return null for non-comeet URLs');
  }

  if (comeet.detect({ name: 'X', careers_url: null }) === null && comeet.detect({ name: 'X', api: 7 }) === null) {
    pass('comeet.detect() returns null for non-string url fields (null and 7)');
  } else {
    fail('comeet.detect() should treat non-string url fields as missing');
  }

  // SSRF: comeet.co in the PATH (not host) must not be detected.
  if (comeet.detect({ name: 'Spoof', api: 'https://evil.example/www.comeet.co/careers-api/2.0/company/x/positions' }) === null) {
    pass('comeet.detect() rejects path-spoofed URLs');
  } else {
    fail('comeet.detect() must NOT misdetect path-spoofed URLs');
  }

  // SSRF: the wrong comeet host (www.comeet.com, the hosted-page origin) is rejected.
  if (comeet.detect({ name: 'Spoof', api: 'https://www.comeet.com/careers-api/2.0/company/x/positions?token=y' }) === null) {
    pass('comeet.detect() pins to www.comeet.co (rejects www.comeet.com)');
  } else {
    fail('comeet.detect() must pin to www.comeet.co');
  }

  // parseComeetResponse — top-level array (real shape, confirmed live)
  const sample = [
    {
      name: 'AI Engineer',
      url_active_page: 'https://www.comeet.com/jobs/spark-hire/30.005/ai-engineer/F1.B67',
      url_comeet_hosted_page: 'https://www.comeet.com/jobs/spark-hire/30.005/ai-engineer/F1.B67',
      time_updated: '2026-06-11T07:49:20Z',
      location: { name: 'Tel Aviv, Israel', is_remote: true },
    },
    {
      name: 'Backend Engineer',
      url_comeet_hosted_page: 'https://www.comeet.com/jobs/spark-hire/30.005/backend/AB.C12',
      location: { name: 'Berlin, Germany', is_remote: false },
    },
    { name: 'No URL row', location: { name: 'Remote' } },
    { name: 'Insecure URL', url_active_page: 'http://www.comeet.com/jobs/x', location: {} },
  ];
  const jobs = parseComeetResponse(sample, 'Spark Hire');

  if (jobs.length === 2) pass('parseComeetResponse keeps 2 rows (drops missing/non-https url)');
  else fail(`parseComeetResponse returned ${jobs.length} rows (expected 2)`);

  if (jobs[0]?.title === 'AI Engineer' && jobs[0]?.company === 'Spark Hire' && jobs[0]?.location === 'Tel Aviv, Israel, Remote') {
    pass('parseComeetResponse maps name/location.name and appends Remote');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[0]?.postedAt === Date.parse('2026-06-11T07:49:20Z')) {
    pass('parseComeetResponse parses time_updated → postedAt');
  } else {
    fail(`row 0 postedAt = ${JSON.stringify(jobs[0]?.postedAt)}`);
  }

  if (jobs[1]?.url === 'https://www.comeet.com/jobs/spark-hire/30.005/backend/AB.C12' && jobs[1]?.location === 'Berlin, Germany' && jobs[1]?.postedAt === undefined) {
    pass('parseComeetResponse falls back to url_comeet_hosted_page and omits absent postedAt');
  } else {
    fail(`row 1 = ${JSON.stringify(jobs[1])}`);
  }

  if (parseComeetResponse(null, 'X').length === 0 && parseComeetResponse({}, 'X').length === 0) {
    pass('non-array payload → empty result (no crash)');
  } else {
    fail('non-array payload should yield empty result');
  }

  // a location already containing "Remote" must not get a duplicate suffix
  const noDup = parseComeetResponse([{ name: 'R', url_active_page: 'https://www.comeet.com/jobs/x/r', location: { name: 'Remote, EMEA', is_remote: true } }], 'X');
  if (noDup[0]?.location === 'Remote, EMEA') pass('parseComeetResponse does not double-append Remote');
  else fail(`expected "Remote, EMEA", got ${JSON.stringify(noDup[0]?.location)}`);

  // A url_active_page shared by several positions is the generic careers index
  // (Noma Security, 2026-09: 16/28 positions → "https://noma.security/careers/").
  // Those positions must fall back to their per-position hosted page, or URL
  // dedup keeps only the first; a unique url_active_page is still preferred.
  const shared = parseComeetResponse([
    { name: 'Solutions Architect', url_active_page: 'https://noma.security/careers/', url_comeet_hosted_page: 'https://www.comeet.com/jobs/noma_security/3A.005/solutions-architect/0E.27B', location: { name: 'USA [Remote]', is_remote: true } },
    { name: 'Enablement Leader', url_active_page: 'https://noma.security/careers/', url_comeet_hosted_page: 'https://www.comeet.com/jobs/noma_security/3A.005/enablement-leader/9F.27C', location: { name: 'USA [Remote]', is_remote: true } },
    { name: 'Senior Security Researcher', url_active_page: 'https://noma.security/careers/co/tel-aviv/5D.A5A/senior-security-researcher/all/', url_comeet_hosted_page: 'https://www.comeet.com/jobs/noma_security/3A.005/senior-security-researcher/5D.A5A', location: { name: 'Tel Aviv' } },
    { name: 'No hosted page', url_active_page: 'https://noma.security/careers/', location: { name: 'Tel Aviv' } },
  ], 'Noma Security');
  const sharedUrls = shared.map(j => j.url);
  if (sharedUrls[0] === 'https://www.comeet.com/jobs/noma_security/3A.005/solutions-architect/0E.27B'
    && sharedUrls[1] === 'https://www.comeet.com/jobs/noma_security/3A.005/enablement-leader/9F.27C'
    && sharedUrls[2] === 'https://noma.security/careers/co/tel-aviv/5D.A5A/senior-security-researcher/all/'
    && sharedUrls[3] === 'https://noma.security/careers/') {
    pass('parseComeetResponse uses the hosted page when url_active_page is shared, keeps a unique active page');
  } else {
    fail(`shared active page urls = ${JSON.stringify(sharedUrls)}`);
  }

  // malformed members (null / non-object / whitespace-only name) must neither
  // throw nor slip through: a row needs a non-empty trimmed title AND a url.
  const dirty = [
    null,
    'not an object',
    42,
    { name: '   ', url_active_page: 'https://www.comeet.com/jobs/x/blank' }, // blank title → dropped
    { name: '  Padded Role  ', url_active_page: 'https://www.comeet.com/jobs/x/p', location: {} }, // trimmed, kept
  ];
  const cleaned = parseComeetResponse(dirty, 'X');
  if (cleaned.length === 1 && cleaned[0].title === 'Padded Role') {
    pass('parseComeetResponse skips null/non-object/blank-title rows and trims the title');
  } else {
    fail(`dirty parse = ${JSON.stringify(cleaned)} (expected 1 row "Padded Role")`);
  }

  // details → description. Live shape (Noma Security, 2026-09): sections
  // { name, value: HTML | null, order }, value null for most "Requirements".
  const { detailsToText } = comeetModule;
  const { FULL_DESCRIPTION_CAP } = await import(pathToFileURL(join(ROOT, 'providers/_html-to-text.mjs')).href);

  const ordered = detailsToText([
    { name: 'Requirements', value: '<ul><li>3+ years of Python</li><li>Fuzzing &amp; RE</li></ul>', order: 3 },
    { name: 'Description', value: '<p><strong>Join Noma</strong> Security.</p>', order: 1 },
    { name: 'Responsibilities', value: '<p>Find bugs</p>', order: 2 },
  ]);
  if (ordered === 'Join Noma Security.\n\nResponsibilities: Find bugs\n\nRequirements: 3+ years of Python Fuzzing & RE') {
    pass('detailsToText sorts by order, strips HTML, labels non-Description sections, joins with blank lines');
  } else {
    fail(`detailsToText ordered = ${JSON.stringify(ordered)}`);
  }

  const unordered = detailsToText([
    { name: 'About', value: '<p>last</p>' },
    { name: 'Description', value: '<p>first</p>', order: 1 },
    { name: 'Requirements', value: '<p>middle</p>' },
  ]);
  if (unordered === 'first\n\nAbout: last\n\nRequirements: middle') {
    pass('detailsToText puts sections without an order after ordered ones, in array order');
  } else {
    fail(`detailsToText unordered = ${JSON.stringify(unordered)}`);
  }

  const sparse = detailsToText([
    null,
    'not a section',
    7,
    { name: 'Description', value: '<p>Body</p>', order: 1 },
    { name: 'Requirements', value: null, order: 2 },
    { name: 'About The Company', value: '<p><br></p>', order: 3 },
    { name: 'Benefits', value: { html: '<p>x</p>' }, order: 4 },
    { value: '<p>Unnamed tail</p>', order: 5 },
  ]);
  if (sparse === 'Body\n\nUnnamed tail') {
    pass('detailsToText skips null/non-object sections and null/empty/non-string values; unnamed section is unlabelled');
  } else {
    fail(`detailsToText sparse = ${JSON.stringify(sparse)}`);
  }

  if (detailsToText(undefined) === '' && detailsToText(null) === '' && detailsToText('<p>x</p>') === ''
    && detailsToText({ name: 'Description', value: '<p>x</p>' }) === '' && detailsToText([]) === ''
    && detailsToText([{ name: 'Requirements', value: null }]) === '') {
    pass('detailsToText returns "" for non-array or empty details');
  } else {
    fail('detailsToText should return "" for non-array or empty details');
  }

  // One oversized section on its own: the per-section htmlToText cap must be
  // FULL_DESCRIPTION_CAP, not htmlToText's 4000-char default (live Noma
  // sections run past 5000 with the requirements inside the Description).
  const hugeSection = detailsToText([{ name: 'Description', value: `<p>${'word '.repeat(10000)}</p>`, order: 1 }]);
  if (hugeSection.length >= FULL_DESCRIPTION_CAP - 1 && hugeSection.length <= FULL_DESCRIPTION_CAP) {
    pass('detailsToText caps a single section at FULL_DESCRIPTION_CAP, not the 4000 default');
  } else {
    fail(`detailsToText single huge section length = ${hugeSection.length}`);
  }

  const huge = detailsToText([{ name: 'Description', value: `<p>${'word '.repeat(10000)}</p>`, order: 1 }, { name: 'Requirements', value: '<p>tail</p>', order: 2 }]);
  if (huge.length > 4000 && huge.length <= FULL_DESCRIPTION_CAP) pass('detailsToText caps the joined sections at FULL_DESCRIPTION_CAP');
  else fail(`detailsToText huge length = ${huge.length}`);

  const withDetails = parseComeetResponse([
    { name: 'Security Researcher', url_active_page: 'https://www.comeet.com/jobs/x/sr', details: [{ name: 'Description', value: '<p>Research &amp; exploit</p>', order: 1 }] },
    { name: 'No usable details', url_active_page: 'https://www.comeet.com/jobs/x/nd', details: [{ name: 'Requirements', value: null, order: 2 }] },
    { name: 'Details not an array', url_active_page: 'https://www.comeet.com/jobs/x/na', details: { name: 'Description', value: '<p>x</p>' } },
    { name: 'No details key', url_active_page: 'https://www.comeet.com/jobs/x/nk' },
  ], 'X');
  if (withDetails.length === 4 && withDetails[0].description === 'Research & exploit'
    && withDetails.slice(1).every(j => !('description' in j))) {
    pass('parseComeetResponse emits description from details and omits the key when nothing is usable');
  } else {
    fail(`parse with details = ${JSON.stringify(withDetails)}`);
  }

  // fetch() asks for details=true in the same request, keeping the token and
  // other params, never duplicating `details`, and keeping redirect:'error'.
  const captured = [];
  const ctx = {
    fetchJson: async (url, opts) => {
      captured.push({ url, opts });
      return [{ name: 'Role', url_active_page: 'https://www.comeet.com/jobs/x/r', details: [{ name: 'Description', value: '<p>JD body</p>', order: 1 }] }];
    },
  };
  const fetched = await comeet.fetch({ name: 'Spark Hire', api: `${apiUrl}&lang=en` }, ctx);
  const req = captured[0] ? new URL(captured[0].url) : null;
  if (req && req.hostname === 'www.comeet.co' && req.pathname === '/careers-api/2.0/company/30.005/positions'
    && req.searchParams.get('token') === 'ABC123' && req.searchParams.get('lang') === 'en'
    && req.searchParams.getAll('details').join() === 'true' && captured[0].opts?.redirect === 'error') {
    pass('comeet.fetch() requests details=true with the original token and params, redirect:"error"');
  } else {
    fail(`comeet.fetch() requested ${JSON.stringify(captured[0])}`);
  }
  if (fetched.length === 1 && fetched[0].description === 'JD body') pass('comeet.fetch() returns the description parsed from details');
  else fail(`comeet.fetch() returned ${JSON.stringify(fetched)}`);

  captured.length = 0;
  await comeet.fetch({ name: 'X', api: `${apiUrl}&details=false&details=true` }, ctx);
  const dup = captured[0] ? new URL(captured[0].url).searchParams.getAll('details') : [];
  if (dup.length === 1 && dup[0] === 'true') pass('comeet.fetch() replaces a configured details param instead of duplicating it');
  else fail(`comeet.fetch() details params = ${JSON.stringify(dup)}`);

  // Redaction: the token must not leak through detect() (details param
  // present) or a fetch() error.
  const detHit = comeet.detect({ name: 'X', api: `${apiUrl}&details=true` });
  if (detHit && !detHit.url.includes('ABC123') && detHit.url.includes('token=REDACTED')) {
    pass('comeet.detect() still redacts the token when the URL carries details=true');
  } else {
    fail(`comeet.detect() with details → ${JSON.stringify(detHit)}`);
  }
  const leakMessages = [];
  for (const [entry, fetchJson] of [
    [{ name: 'X', api: 'https://www.comeet.com/careers-api/2.0/company/x/positions?token=ABC123' }, ctx.fetchJson],
    [{ name: 'X', api: apiUrl }, async () => { throw new Error('HTTP 500 Internal Server Error'); }],
  ]) {
    try {
      await comeet.fetch(entry, { fetchJson });
      leakMessages.push('(no error thrown)');
    } catch (e) {
      leakMessages.push(String(e?.message));
    }
  }
  if (leakMessages.every(m => m !== '(no error thrown)' && !m.includes('ABC123'))) {
    pass('comeet.fetch() errors never carry the token');
  } else {
    fail(`comeet.fetch() error messages = ${JSON.stringify(leakMessages)}`);
  }

} catch (e) {
  fail(`comeet provider tests crashed: ${e.message}`);
}

