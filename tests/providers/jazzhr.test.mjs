// tests/providers/jazzhr.test.mjs — JazzHR (<tenant>.applytojob.com) career-page provider.
import { pass, fail, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — jazzhr');

// Markup mirrors the live career-page template (measured 2026-09): an
// <li class="list-group-item"> per posting, the title link in an
// <h3 class='list-group-item-heading'>, and a meta list with a map-marker
// (location) and an optional sitemap (department) item.
const HOST = 'acme.applytojob.com';
const LIST_URL = `https://${HOST}/apply`;

/** @param {string} href @param {string} title @param {string} [location] @param {string} [dept] */
function card(href, title, location = 'Remote', dept = '') {
  return `
                            <li class="list-group-item">
                                <h3 class='list-group-item-heading'>
                                    <a href="${href}">
                                        ${title}                                    </a>
                                </h3>
                                <ul class='list-inline list-group-item-text'>
                                    ${location ? `<li><i class='fa fa-map-marker'></i>${location}</li>` : ''}
                                    ${dept ? `<li><i class='fa fa-sitemap'></i>${dept}</li>` : ''}
                                </ul>
                            </li>`;
}

/** @param {string} items @param {string} [heading] */
function page(items, heading = "<h2 class='page-title page-title-open'>Current Openings</h2>") {
  return `<!DOCTYPE html><html><head><title>Acme - Career Page</title>
<style>.job-board-list .jobs-list .list-group-item .list-group-item-heading a {color: #333}</style>
<script>var tpl = '<h3 class="list-group-item-heading"><a href="https://${HOST}/apply/Scr1pt0000/From-Script">Script Job</a></h3>';</script>
</head>
<body class="resumator-jobboard-home jobboard job- dept-">
<a href="http://${HOST}/apply/" id='resumator-back-button' class="btn btn-link hidden">View All Jobs</a>
<main><div class='job-board-list-wrapper'><div class='container'><div class='row job-board-list'>
<div class='col col-xs-7 jobs-list'>
  ${heading}
  <ul class='list-group'>${items}
  </ul>
</div></div></div></div></main>
<!-- ${card(`https://${HOST}/apply/Comm3nt000/Commented-Out`, 'Commented Out')} -->
<footer><a href="https://info.jazzhr.com/job-seekers.html">Powered by JazzHR</a></footer>
</body></html>`;
}

const BOARD = page([
  card(`https://${HOST}/apply/AbCdE12345/Senior-Security-Engineer`, 'Senior Security Engineer', 'Remote', 'Engineering'),
  card(`https://${HOST}/apply/FgHiJ67890/R-D-Engineer`, 'R&amp;D Engineer &#8211; Detection', 'Gurgaon &amp; Pune, India', 'Analytics &amp; Research'),
  card('/apply/KlMnO11111/Relative-Link', 'Relative Link Role', 'Austin, TX'),
  card(`http://${HOST}/apply/PqRsT22222/Http-Link`, 'Http Link Role', 'Denver, CO'),
  card(`https://${HOST}/apply/UvWxY33333/`, 'ผู้ฝึกสอนด้านสุขภาพ', 'Bangkok, Thailand'),
  card(`https://${HOST}/apply/NoLoc44444/No-Location`, 'No Location Role', ''),
  card(`https://${HOST}/apply/AbCdE12345/Senior-Security-Engineer`, 'Senior Security Engineer', 'Remote'), // duplicate
  card(`https://${HOST}/apply/AbCdE12345/Renamed-Slug`, 'Senior Security Engineer (renamed)', 'Remote'),     // duplicate id, other slug
  card(`https://evil.example/apply/Evil000001/Off-Host`, 'Off Host Role'),                            // drop: other host
  card(`https://evil.example/${HOST}/apply/Evil000002/Path-Spoof`, 'Path Spoof Role'),                // drop: path-spoofed
  card(`https://${HOST}.evil.example/apply/Evil000003/Suffix`, 'Suffix Spoof Role'),                  // drop: suffix-spoofed host
  card(`//evil.example/apply/Evil000004/Proto-Relative`, 'Protocol Relative Role'),                   // drop: other host
  card(`https://other.applytojob.com/apply/Evil000005/Other-Tenant`, 'Other Tenant Role'),            // drop: another tenant
  card(`https://${HOST}/apply/jobs/feed`, 'Feed Link'),                                               // drop: not a posting path
  card(`javascript:alert(1)`, 'Script Href Role'),                                                    // drop: not http(s)
  card(`https://${HOST}/apply/Empty55555/Empty-Title`, '   '),                                        // drop: empty title
].join(''));

/** @param {string} id @param {{datePosted?: string, description?: string, jsonLd?: boolean, ldUrlId?: string, formId?: string}} [o] */
function detailPage(id, o = {}) {
  const jsonLd = o.jsonLd === false ? '' : `<script type="application/ld+json">
{
    "@context": "http:\\/\\/schema.org\\/",
    "@type": "JobPosting",
    "url": "https:\\/\\/${HOST}\\/apply\\/${o.ldUrlId ?? id}\\/Some-Slug",
    "title": "Some Title",
    "description": ${JSON.stringify(o.description ?? `<p><strong>About ${id}</strong></p><ul><li>Rust &amp; Go</li></ul>`)},
    "datePosted": "${o.datePosted ?? '2026-07-14'}",
    "validThrough": "2026-10-12"
}
</script>`;
  return `<html><head><title>Some Title - Acme - Career Page</title>
<script type="application/ld+json">{"@type": "Organization", "name": "Acme", "url": ""}</script>
${jsonLd}</head><body>
<a href="#job-description" class="skip-link">Skip To Job Description</a>
<div class='page-body job-details'><div class='container'><div class='row'>
<div class='col col-xs-7 description' id="job-description">
<p>Container text for ${id}. Python &amp; C++.</p><div><p>nested block</p></div>
</div>
<div class="resumator-mobile-apply-wrapper mobile"><button>Apply</button></div>
<div id="job-application-form-container" class='col col-xs-5 job-application-form'>
<input type="hidden" name="resumator-job-value" id="resumator-job-value" value="${o.formId ?? id}" />
</div></div></div></div></body></html>`;
}

const idOf = (url) => new URL(url).pathname.split('/')[2];

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/jazzhr.mjs')).href);
  const jazzhr = mod.default;
  const { parseJazzhrBoard, parseJazzhrDetail, resolveJazzhrPostingUrl } = mod;

  if (jazzhr.id === 'jazzhr') pass('jazzhr.id is "jazzhr"');
  else fail(`jazzhr.id is ${JSON.stringify(jazzhr.id)}`);

  // ── detect() ────────────────────────────────────────────────────────
  const positives = [
    'https://acme.applytojob.com/apply',
    'https://acme.applytojob.com/apply/',
    'https://acme.applytojob.com/',
    'https://acme.applytojob.com',
    'https://Acme.applytojob.com/apply',
    'https://acme.applytojob.com/apply/AbCdE12345/Senior-Security-Engineer',
    '  https://acme.applytojob.com/apply  ',
  ];
  const posHits = positives.map((u) => jazzhr.detect({ name: 'Acme', careers_url: u }));
  if (posHits.every((h) => h?.url === LIST_URL)) {
    pass('jazzhr.detect() resolves any https <tenant>.applytojob.com URL (case-folded) → https://<tenant>.applytojob.com/apply');
  } else {
    fail(`jazzhr.detect() positives → ${JSON.stringify(posHits)}`);
  }
  if (jazzhr.detect({ name: 'X', careers_url: 'https://1647.applytojob.com/apply' })?.url === 'https://1647.applytojob.com/apply'
      && jazzhr.detect({ name: 'X', careers_url: 'https://acme-corp.applytojob.com/apply' })?.url === 'https://acme-corp.applytojob.com/apply') {
    pass('jazzhr.detect() accepts all-digit and internal-hyphen tenant labels');
  } else {
    fail('jazzhr.detect() should accept all-digit and internal-hyphen tenant labels');
  }

  const negatives = [
    'http://acme.applytojob.com/apply',                       // non-https
    'https://example.com/apply',                              // other host
    'https://evil.example/acme.applytojob.com/apply',         // path-spoofed
    'https://acme.applytojob.com.evil.example/apply',         // suffix-spoofed
    'https://evilapplytojob.com/apply',                       // lookalike domain
    'https://applytojob.com/apply',                           // bare domain, no tenant
    'https://a.b.applytojob.com/apply',                       // two labels
    'https://www.applytojob.com/apply',                       // reserved
    'https://app.applytojob.com/notfound.html',               // reserved
    'https://-acme.applytojob.com/apply',                     // edge hyphen
    'https://acme-.applytojob.com/apply',                     // edge hyphen
    'https://app.jazz.co/widgets/basic/create/acme',          // widget host is not a board
    'not a url',
    '',
  ];
  const negHits = negatives.map((u) => jazzhr.detect({ name: 'X', careers_url: u }));
  if (negHits.every((h) => h === null)) {
    pass('jazzhr.detect() rejects non-https, other/spoofed/lookalike hosts, bare/reserved/multi-label/edge-hyphen tenants, malformed');
  } else {
    fail(`jazzhr.detect() negatives → ${JSON.stringify(negatives.map((u, i) => [u, negHits[i]]))}`);
  }
  let junkThrew = false;
  let junkHits = [];
  try {
    junkHits = [
      jazzhr.detect({ name: 'X', careers_url: null }),
      jazzhr.detect({ name: 'X', careers_url: 7 }),
      jazzhr.detect({ name: 'X' }),
      jazzhr.detect({ name: 'X', api: 'https://acme.applytojob.com/apply' }),
      jazzhr.detect(null),
      jazzhr.detect(undefined),
    ];
  } catch {
    junkThrew = true;
  }
  if (!junkThrew && junkHits.every((h) => h === null)) {
    pass('jazzhr.detect() returns null (no throw) for null / non-string / missing careers_url, api-only, null entry');
  } else {
    fail(`jazzhr.detect() junk → threw=${junkThrew} ${JSON.stringify(junkHits)}`);
  }

  // ── resolveJazzhrPostingUrl ─────────────────────────────────────────
  const r1 = resolveJazzhrPostingUrl('/apply/AbCdE12345/Some-Slug', HOST);
  const r2 = resolveJazzhrPostingUrl(`http://${HOST}/apply/AbCdE12345/Some-Slug?source=Widget#x`, HOST);
  const r3 = resolveJazzhrPostingUrl(`https://${HOST}/apply/AbCdE12345`, HOST);
  const r4 = resolveJazzhrPostingUrl(`https://${HOST}:8443/apply/AbCdE12345/Port`, HOST);
  const r5 = resolveJazzhrPostingUrl(`https://user@${HOST}/apply/AbCdE12345/Userinfo`, HOST);
  const r6 = resolveJazzhrPostingUrl(`https://${HOST}/apply/../../evil/AbCdE12345/x`, HOST);
  const r7 = resolveJazzhrPostingUrl(`https://${HOST}/apply/AbCdE12345/Some-Slug`, 'evil.example');
  if (r1?.url === `https://${HOST}/apply/AbCdE12345/Some-Slug` && r1.id === 'AbCdE12345'
      && r2?.url === `https://${HOST}/apply/AbCdE12345/Some-Slug`
      && r3?.url === `https://${HOST}/apply/AbCdE12345/`
      && r4 === null && r5 === null && r6 === null && r7 === null) {
    pass('resolveJazzhrPostingUrl() rebuilds relative / http / query-carrying links on the tenant host; rejects port, userinfo, traversal, unvalidated host');
  } else {
    fail(`resolveJazzhrPostingUrl() → ${JSON.stringify([r1, r2, r3, r4, r5, r6, r7])}`);
  }

  // ── parseJazzhrBoard ────────────────────────────────────────────────
  const jobs = parseJazzhrBoard(BOARD, HOST, 'Acme');
  const titles = jobs.map((j) => j.title);
  const expectedTitles = [
    'Senior Security Engineer',
    'R&D Engineer – Detection',
    'Relative Link Role',
    'Http Link Role',
    'ผู้ฝึกสอนด้านสุขภาพ',
    'No Location Role',
  ];
  if (JSON.stringify(titles) === JSON.stringify(expectedTitles)) {
    pass('parseJazzhrBoard() keeps the six usable postings in page order; off-host, spoofed, other-tenant, non-posting, non-http, empty-title and duplicate cards are dropped; script/comment markup ignored');
  } else {
    fail(`parseJazzhrBoard() titles = ${JSON.stringify(titles)}`);
  }
  const byTitle = (t) => jobs.find((j) => j.title === t);
  const rd = byTitle('R&D Engineer – Detection');
  if (rd && rd.location === 'Gurgaon & Pune, India' && rd.url === `https://${HOST}/apply/FgHiJ67890/R-D-Engineer`
      && /R&D/.test(rd.title)) {
    pass('parseJazzhrBoard() decodes entities in title and location before any keyword match (&amp; → &)');
  } else {
    fail(`parseJazzhrBoard() entity row = ${JSON.stringify(rd)}`);
  }
  const sse = byTitle('Senior Security Engineer');
  if (sse && sse.company === 'Acme' && sse.location === 'Remote'
      && Object.keys(sse).sort().join(',') === 'company,location,title,url') {
    pass('parseJazzhrBoard() maps company = entry name, location = map-marker item; department is not leaked into location');
  } else {
    fail(`parseJazzhrBoard() SSE row = ${JSON.stringify(sse)}`);
  }
  if (byTitle('Relative Link Role')?.url === `https://${HOST}/apply/KlMnO11111/Relative-Link`
      && byTitle('Http Link Role')?.url === `https://${HOST}/apply/PqRsT22222/Http-Link`
      && byTitle('ผู้ฝึกสอนด้านสุขภาพ')?.url === `https://${HOST}/apply/UvWxY33333/`
      && byTitle('No Location Role')?.location === '') {
    pass('parseJazzhrBoard() resolves relative links, upgrades http, keeps an empty-slug posting, and leaves a missing location as ""');
  } else {
    fail(`parseJazzhrBoard() link rows = ${JSON.stringify(jobs)}`);
  }
  if (jobs.every((j) => new URL(j.url).hostname === HOST && new URL(j.url).protocol === 'https:')) {
    pass('parseJazzhrBoard() emits only https URLs on the tenant host');
  } else {
    fail('parseJazzhrBoard() emitted an off-host or non-https URL');
  }

  // Empty / alive-empty / inactive / changed-structure.
  const emptyBoard = page('', "<h2 class='page-title'>There are no open positions at this time.</h2>");
  if (parseJazzhrBoard('', HOST, 'Acme').length === 0 && parseJazzhrBoard(null, HOST, 'Acme').length === 0
      && parseJazzhrBoard('   ', HOST, 'Acme').length === 0 && parseJazzhrBoard(emptyBoard, HOST, 'Acme').length === 0) {
    pass('parseJazzhrBoard() → [] for an empty body and for an alive board with no openings (jobs-list container, no cards)');
  } else {
    fail('parseJazzhrBoard() should return [] for empty body / empty board');
  }
  const inactive = '<html><head><title>JazzHR - Inactive Career Page</title></head><body><h1>This account is no longer active. <a href="https://info.jazzhr.com/job-seekers.html">Learn more</a></h1></body></html>';
  let inactiveErr = null;
  try { parseJazzhrBoard(inactive, HOST, 'Acme'); } catch (e) { inactiveErr = e; }
  if (inactiveErr && /inactive JazzHR career page/.test(inactiveErr.message)) {
    pass('parseJazzhrBoard() throws a named error on a lapsed ("Inactive Career Page") account instead of reading 0');
  } else {
    fail(`parseJazzhrBoard() inactive → ${inactiveErr?.message}`);
  }
  const quoted = page(card(`https://${HOST}/apply/AbCdE12345/Faq`, 'FAQ: What if this account is no longer active?'));
  if (parseJazzhrBoard(quoted, HOST, 'Acme').length === 1) {
    pass('parseJazzhrBoard() does not treat a live posting that quotes the inactive phrase as an inactive board');
  } else {
    fail('parseJazzhrBoard() voided a live board over a quoted phrase');
  }
  let shapeErr = null;
  try { parseJazzhrBoard('<html><body><h1>Just a moment...</h1></body></html>', HOST, 'Acme'); } catch (e) { shapeErr = e; }
  if (shapeErr && /no postings and no jobs-list container/.test(shapeErr.message)) {
    pass('parseJazzhrBoard() throws a descriptive error on a page that is not a JazzHR board (challenge page / redesign)');
  } else {
    fail(`parseJazzhrBoard() unknown shape → ${shapeErr?.message}`);
  }
  let cardsErr = null;
  const unusable = page([
    card('https://evil.example/apply/Evil000001/x', 'Off Host'),
    card(`https://${HOST}/careers/123`, 'Wrong Path'),
  ].join(''));
  try { parseJazzhrBoard(unusable, HOST, 'Acme'); } catch (e) { cardsErr = e; }
  if (cardsErr && /2 list-group-item-heading block\(s\).*markup likely changed/.test(cardsErr.message)) {
    pass('parseJazzhrBoard() throws when posting headings match but none yields a usable job (markup moved)');
  } else {
    fail(`parseJazzhrBoard() unusable cards → ${cardsErr?.message}`);
  }

  // ── parseJazzhrDetail ───────────────────────────────────────────────
  const d1 = parseJazzhrDetail(detailPage('AbCdE12345'), 'AbCdE12345');
  if (d1 && d1.postedAt === Date.parse('2026-07-14T00:00:00Z') && d1.description === 'About AbCdE12345 Rust & Go') {
    pass('parseJazzhrDetail() reads JSON-LD JobPosting: date-only datePosted → UTC epoch ms, HTML description → plain text');
  } else {
    fail(`parseJazzhrDetail() JSON-LD → ${JSON.stringify(d1)}`);
  }
  const d2 = parseJazzhrDetail(detailPage('AbCdE12345', { jsonLd: false }), 'AbCdE12345');
  if (d2 && !('postedAt' in d2) && d2.description === 'Container text for AbCdE12345. Python & C++. nested block') {
    pass('parseJazzhrDetail() without a JobPosting block (past validThrough) falls back to #job-description text, stays undated');
  } else {
    fail(`parseJazzhrDetail() container fallback → ${JSON.stringify(d2)}`);
  }
  const d3 = parseJazzhrDetail(detailPage('AbCdE12345', { ldUrlId: 'Other00000' }), 'AbCdE12345');
  const d4 = parseJazzhrDetail(detailPage('AbCdE12345', { jsonLd: false, formId: 'Other00000' }), 'AbCdE12345');
  if (d3 === null && d4 === null) {
    pass('parseJazzhrDetail() rejects a page naming another posting id (JSON-LD url or the apply form job value)');
  } else {
    fail(`parseJazzhrDetail() mismatched id → ${JSON.stringify([d3, d4])}`);
  }
  const far = parseJazzhrDetail(detailPage('AbCdE12345', { datePosted: '2999-01-01' }), 'AbCdE12345');
  const junkDate = parseJazzhrDetail(detailPage('AbCdE12345', { datePosted: 'July 14' }), 'AbCdE12345');
  const noOffset = parseJazzhrDetail(detailPage('AbCdE12345', { datePosted: '2026-07-14T10:00:00' }), 'AbCdE12345');
  if (far && !('postedAt' in far) && junkDate && !('postedAt' in junkDate) && noOffset && !('postedAt' in noOffset)
      && far.description) {
    pass('parseJazzhrDetail() drops far-future, unparseable and offset-less date-times (description kept)');
  } else {
    fail(`parseJazzhrDetail() bad dates → ${JSON.stringify([far, junkDate, noOffset])}`);
  }
  const brokenLd = `<script type="application/ld+json">{not json</script>
<script type="application/ld+json">{"@graph": [{"@type": "Organization"}, {"@type": ["JobPosting"], "url": "https://${HOST}/apply/AbCdE12345/x", "datePosted": "2026-09-01", "description": "<p>Graph body</p>"}]}</script>`;
  const d5 = parseJazzhrDetail(brokenLd, 'AbCdE12345');
  if (d5 && d5.description === 'Graph body' && d5.postedAt === Date.parse('2026-09-01T00:00:00Z')) {
    pass('parseJazzhrDetail() skips a malformed JSON-LD block and finds a JobPosting inside @graph / array @type');
  } else {
    fail(`parseJazzhrDetail() @graph → ${JSON.stringify(d5)}`);
  }
  if (parseJazzhrDetail('<html><body>Acme - Career Page</body></html>', 'AbCdE12345') === null
      && parseJazzhrDetail('', 'AbCdE12345') === null && parseJazzhrDetail(undefined, 'AbCdE12345') === null) {
    pass('parseJazzhrDetail() → null for a page with neither a JobPosting block nor a #job-description container');
  } else {
    fail('parseJazzhrDetail() should return null for a non-detail page');
  }
  const noEnd = parseJazzhrDetail(`<div id="job-description"><p>text</p></div><footer>rest of page</footer>`, 'AbCdE12345');
  if (noEnd && !('description' in noEnd)) {
    pass('parseJazzhrDetail() takes no container text when the template terminators are missing (never the rest of the page)');
  } else {
    fail(`parseJazzhrDetail() no terminator → ${JSON.stringify(noEnd)}`);
  }

  // ── fetch(): SSRF guard before any request ─────────────────────────
  let guardCalls = 0;
  let guardErr = null;
  try {
    await jazzhr.fetch({ name: 'Evil', careers_url: 'https://evil.example/acme.applytojob.com/apply' },
      { fetchText: async () => { guardCalls++; return BOARD; }, fetchJson: async () => { guardCalls++; return {}; } });
  } catch (e) { guardErr = e; }
  if (guardErr && /cannot derive/.test(guardErr.message) && guardCalls === 0) {
    pass('jazzhr.fetch() rejects a non-tenant careers_url before any fetchText/fetchJson call');
  } else {
    fail(`jazzhr.fetch() SSRF guard → err=${guardErr?.message} calls=${guardCalls}`);
  }

  // ── fetch(): list + enrichment ──────────────────────────────────────
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const ctx = {
    sleep: async () => {},
    fetchText: async (url, opts) => {
      calls.push({ url, opts });
      if (url === LIST_URL) return BOARD;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const id = idOf(url);
      if (id === 'KlMnO11111') { const e = new Error('HTTP 410'); e.status = 410; throw e; } // closed posting
      if (id === 'PqRsT22222') return detailPage('Other00000');                             // someone else's page
      if (id === 'UvWxY33333') return detailPage(id, { jsonLd: false });                     // past validThrough
      return detailPage(id);
    },
  };
  const { result: fetched, errors: logged } = await captureConsoleErrors(() =>
    jazzhr.fetch({ name: 'Acme', careers_url: 'https://acme.applytojob.com/apply' }, ctx));

  if (calls.every((c) => c.opts?.redirect === 'error')) {
    pass('jazzhr.fetch() passes redirect:"error" on every request (list and detail pages)');
  } else {
    fail(`jazzhr.fetch() request options = ${JSON.stringify(calls.map((c) => c.opts))}`);
  }
  const detailCalls = calls.filter((c) => c.url !== LIST_URL);
  if (calls[0]?.url === LIST_URL && detailCalls.length === 6
      && detailCalls.every((c) => new URL(c.url).hostname === HOST && new URL(c.url).protocol === 'https:')
      && !calls.some((c) => /evil|other\.applytojob|Scr1pt|Comm3nt/.test(c.url))) {
    pass('jazzhr.fetch() fetches the /apply list once, then each posting page once — all https on the tenant host, never a dropped link');
  } else {
    fail(`jazzhr.fetch() URLs = ${JSON.stringify(calls.map((c) => c.url))}`);
  }
  if (maxInFlight > 0 && maxInFlight <= 4) pass(`jazzhr.fetch() bounds detail concurrency (max ${maxInFlight} in flight ≤ 4)`);
  else fail(`jazzhr.fetch() detail concurrency peaked at ${maxInFlight}`);

  const f = (t) => fetched.find((j) => j.title === t);
  if (fetched.length === 6
      && f('Senior Security Engineer')?.description === 'About AbCdE12345 Rust & Go'
      && f('Senior Security Engineer')?.postedAt === Date.parse('2026-07-14T00:00:00Z')
      && f('Senior Security Engineer')?.location === 'Remote') {
    pass('jazzhr.fetch() merges detail description + postedAt onto the list row (list fields kept)');
  } else {
    fail(`jazzhr.fetch() enriched rows = ${JSON.stringify(fetched)}`);
  }
  const keys = (t) => Object.keys(f(t) || {}).sort().join(',');
  if (keys('Relative Link Role') === 'company,location,title,url' && keys('Http Link Role') === 'company,location,title,url'
      && keys('ผู้ฝึกสอนด้านสุขภาพ') === 'company,description,location,title,url') {
    pass('jazzhr.fetch() leaves failed (410) and mismatched-page postings list-level; an undated page adds only its description');
  } else {
    fail(`jazzhr.fetch() fallback rows = ${JSON.stringify(fetched)}`);
  }
  if (logged.length === 1 && /enriched 4 of 6 posting\(s\), 2 posting page\(s\) unreadable/.test(logged[0])) {
    pass('jazzhr.fetch() logs one summary line when posting pages are unreadable');
  } else {
    fail(`jazzhr.fetch() logged ${JSON.stringify(logged)}`);
  }

  // Cap: 105 postings → exactly 100 detail GETs, every row returned, loud.
  const bigBoard = page(Array.from({ length: 105 }, (_, i) =>
    card(`https://${HOST}/apply/Big${String(i).padStart(7, '0')}/Role-${i}`, `Role ${i}`)).join(''));
  let bigDetail = 0;
  const { result: capped, errors: capLogged } = await captureConsoleErrors(() => jazzhr.fetch(
    { name: 'Big', careers_url: LIST_URL },
    { fetchText: async (url) => { if (url === LIST_URL) return bigBoard; bigDetail++; return detailPage(idOf(url)); } },
  ));
  if (bigDetail === 100 && capped.length === 105 && capped.filter((j) => j.description).length === 100
      && !('description' in capped[104])) {
    pass('jazzhr.fetch() stops at the 100-detail-request cap and keeps the rest as list-level jobs');
  } else {
    fail(`jazzhr.fetch() cap: ${bigDetail} detail calls, ${capped.length} jobs`);
  }
  if (capLogged.length === 1 && /5 left undetailed by the 100-request cap/.test(capLogged[0])) {
    pass('jazzhr.fetch() reports cap truncation on stderr (does not throw)');
  } else {
    fail(`jazzhr.fetch() cap log = ${JSON.stringify(capLogged)}`);
  }

  // Healthy board: silent.
  const { errors: quiet } = await captureConsoleErrors(() => jazzhr.fetch(
    { name: 'Quiet', careers_url: LIST_URL },
    { fetchText: async (url) => (url === LIST_URL ? page(card(`https://${HOST}/apply/AbCdE12345/X`, 'X')) : detailPage(idOf(url))) },
  ));
  if (quiet.length === 0) pass('jazzhr.fetch() stays silent when every posting page resolves');
  else fail(`jazzhr.fetch() logged on a healthy board: ${JSON.stringify(quiet)}`);

  // Empty board through fetch(): one request, [].
  const emptyCalls = [];
  const emptyJobs = await jazzhr.fetch({ name: 'Acme', careers_url: LIST_URL },
    { fetchText: async (url) => { emptyCalls.push(url); return emptyBoard; } });
  if (Array.isArray(emptyJobs) && emptyJobs.length === 0 && emptyCalls.length === 1) {
    pass('jazzhr.fetch() returns [] for an alive board with no openings (one request)');
  } else {
    fail(`jazzhr.fetch() empty board → ${JSON.stringify(emptyJobs)} after ${emptyCalls.length} call(s)`);
  }

  // ── probe (ctx.maxPages) ────────────────────────────────────────────
  const probeUrls = [];
  const probed = await jazzhr.fetch({ name: 'Acme', careers_url: LIST_URL },
    { maxPages: 1, fetchText: async (url) => { probeUrls.push(url); return url === LIST_URL ? BOARD : detailPage(idOf(url)); } });
  if (probeUrls.length === 1 && probeUrls[0] === LIST_URL && probed.length === 6
      && probed.every((j) => !('description' in j) && !('postedAt' in j))) {
    pass('jazzhr.fetch() under ctx.maxPages (health probe) makes exactly one list request and skips detail enrichment');
  } else {
    fail(`jazzhr.fetch() probe requested ${JSON.stringify(probeUrls)}`);
  }
  class ProbeBudget extends Error {}
  const budgetErr = new ProbeBudget();
  let probeThrown = null;
  try {
    await jazzhr.fetch({ name: 'Acme', careers_url: LIST_URL },
      { maxPages: 1, sleep: async () => {}, fetchText: async () => { throw budgetErr; } });
  } catch (e) { probeThrown = e; }
  if (probeThrown === budgetErr) pass('jazzhr.fetch() propagates a ctx.fetchText rejection unwrapped while probing (sentinel identity survives)');
  else fail(`jazzhr.fetch() probe rejection → ${probeThrown}`);

  // ── list retry: a transient 503 is retried; a refused redirect is not ──
  let attempts = 0;
  const retried = await jazzhr.fetch({ name: 'Acme', careers_url: LIST_URL }, {
    maxPages: 1,
    sleep: async () => {},
    fetchText: async () => {
      attempts++;
      if (attempts === 1) { const e = new Error('HTTP 503'); e.status = 503; throw e; }
      return BOARD;
    },
  });
  if (attempts === 2 && retried.length === 6) pass('jazzhr.fetch() retries a transient 5xx on the list request');
  else fail(`jazzhr.fetch() retry → attempts=${attempts} jobs=${retried.length}`);

  let redirectAttempts = 0;
  const redirectErr = new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  let redirectThrown = null;
  try {
    await jazzhr.fetch({ name: 'Ghost', careers_url: 'https://ghost.applytojob.com/apply' }, {
      sleep: async () => {},
      fetchText: async () => { redirectAttempts++; throw redirectErr; },
    });
  } catch (e) { redirectThrown = e; }
  if (redirectThrown === redirectErr && redirectAttempts === 1) {
    pass('jazzhr.fetch() fails an unknown tenant (302 refused by redirect:"error") on the first attempt, unwrapped');
  } else {
    fail(`jazzhr.fetch() refused redirect → attempts=${redirectAttempts} err=${redirectThrown}`);
  }

  let inactiveFetchErr = null;
  try {
    await jazzhr.fetch({ name: 'Gone', careers_url: 'https://gone.applytojob.com/apply' }, { fetchText: async () => inactive });
  } catch (e) { inactiveFetchErr = e; }
  if (inactiveFetchErr && /gone\.applytojob\.com is an inactive JazzHR career page/.test(inactiveFetchErr.message)) {
    pass('jazzhr.fetch() surfaces an inactive account as a named error (verify-portals reads it as missing, not empty)');
  } else {
    fail(`jazzhr.fetch() inactive → ${inactiveFetchErr?.message}`);
  }
} catch (e) {
  fail(`jazzhr provider tests crashed: ${e.stack || e.message}`);
}
