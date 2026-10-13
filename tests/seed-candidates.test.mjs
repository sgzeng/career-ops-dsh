// tests/seed-candidates.test.mjs — which boards a VC-portfolio company might have.
//
// The seed scan used to build ONE board URL per company, Greenhouse, even
// though its own comment promised Greenhouse -> Lever -> Ashby, and the scan
// took the first provider whose detect() matched. So a YC company on Ashby (all
// seven of the AI-security targets this was built for) was never asked. These
// pin the candidate list that replaces it: every vendor, a sensible order, the
// slug spellings worth trying, and nothing that could put an unsafe character
// into a URL.

import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\nseed candidates — Greenhouse, Ashby and Lever per company');

const vc = await import(pathToFileURL(join(ROOT, 'seeds/vc-portfolios.mjs')).href);
const {
  slugify, coreCompanyName, domainLabel, slugVariants, toPortalCandidates, toPortalEntry,
  prioritizeSeedCompanies, parseYCPayload, SEED_VENDOR_ORDER, VENDOR_BOARD_URL, SLUG_RE,
} = vc;
const greenhouse = (await import(pathToFileURL(join(ROOT, 'providers/greenhouse.mjs')).href)).default;
const ashby = (await import(pathToFileURL(join(ROOT, 'providers/ashby.mjs')).href)).default;
const lever = (await import(pathToFileURL(join(ROOT, 'providers/lever.mjs')).href)).default;
const detectors = { greenhouse, ashby, lever };

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── slug helpers ─────────────────────────────────────────────────────
{
  const cases = [
    [slugify('Posthog'), 'posthog'],
    [slugify('Scale AI'), 'scale-ai'],
    [slugify('  Ünïcode — Café!! '), 'unicode-cafe'],
    [slugify('Walker & Co'), 'walker-co'],
    [slugify('!!!'), ''],
    [slugify(null), ''],
    [coreCompanyName('Dynamic Labs, Inc.'), 'Dynamic Labs'],
    [coreCompanyName('Warbler Labs, Incorporated'), 'Warbler Labs'],
    [coreCompanyName('Yuga Labs (BAYC)'), 'Yuga Labs'],
    [coreCompanyName('Espresso (Translucence Research Inc)'), 'Espresso'],
    [coreCompanyName('Acme LLC'), 'Acme'],
    [coreCompanyName('Walker & Co'), 'Walker & Co'],
    [coreCompanyName('(Only Parens)'), '(Only Parens)'],
    [coreCompanyName('Inc'), 'Inc'],
  ];
  const bad = cases.filter(([got, want]) => got !== want);
  if (bad.length === 0) pass('slugify and coreCompanyName fold accents, drop legal suffixes and trailing parentheticals, and keep a name that would otherwise vanish');
  else fail(`slug helpers: ${JSON.stringify(bad)}`);
}

// ── domainLabel ──────────────────────────────────────────────────────
{
  const cases = [
    ['https://www.posthog.com/', 'posthog'],
    ['https://posthog.com', 'posthog'],
    ['https://app.example.co.uk/x', 'example'],
    ['https://shop.example.com.au', 'example'],
    ['https://www.11x.ai/', '11x'],
    ['https://a.b.c.example.io', 'example'],
    // not a company's own site
    ['https://acme.github.io/', ''],
    ['https://foo.vercel.app', ''],
    ['https://www.ycombinator.com/companies/foo', ''],
    ['https://twitter.com/foo', ''],
    ['http://127.0.0.1:8080/', ''],
    ['http://[::1]/', ''],
    ['not a url', ''],
    ['', ''],
    [null, ''],
  ];
  const bad = cases.filter(([url, want]) => domainLabel(url) !== want);
  if (bad.length === 0) pass('domainLabel reads the registrable label, and gives nothing for hosted-site platforms, directories, IPs and junk');
  else fail(`domainLabel: ${JSON.stringify(bad.map(([u, w]) => [u, w, domainLabel(u)]))}`);
}

// ── slugVariants ─────────────────────────────────────────────────────
{
  const co = { name: 'Scale AI', slug: 'scale-ai', url: 'https://scale.com', source: 'a16z' };
  if (eq(slugVariants(co), ['scale-ai', 'scaleai', 'scale'])) pass('slugVariants: own slug, then separators dropped, then the website label');
  else fail(`slugVariants: ${JSON.stringify(slugVariants(co))}`);
  if (eq(slugVariants(co, { max: 1 }), ['scale-ai']) && eq(slugVariants(co, { domain: false }), ['scale-ai', 'scaleai'])) {
    pass('slugVariants: max and domain:false narrow the list');
  } else {
    fail('slugVariants max/domain options ignored');
  }
  if (eq(slugVariants({ slug: 'posthog', url: 'https://posthog.com' }), ['posthog'])) pass('slugVariants: no duplicate when the spellings coincide');
  else fail(`slugVariants duplicate: ${JSON.stringify(slugVariants({ slug: 'posthog', url: 'https://posthog.com' }))}`);

  // Safety: nothing outside SLUG_RE, however hostile the inputs.
  const hostile = [
    { slug: 'a/b', url: 'https://x.com' },
    { slug: 'ok', url: 'https://ex ample.com' },
    { slug: 'ok-co', url: 'https://%2e%2e.com' },
    { slug: 'x'.repeat(200), url: '' },
    { slug: '', url: 'https://good.example' },
    { slug: 'sp ace', url: '' },
    { slug: 42, url: 7 },
    null,
  ];
  const all = hostile.flatMap((h) => slugVariants(/** @type {any} */ (h)));
  if (all.every((s) => SLUG_RE.test(s) && s.length <= 100) && !all.includes('a/b') && !all.includes('sp ace')) {
    pass('slugVariants never returns a value outside SLUG_RE or longer than 100 characters');
  } else {
    fail(`slugVariants leaked ${JSON.stringify(all)}`);
  }
}

// ── toPortalCandidates ───────────────────────────────────────────────
{
  if (eq(SEED_VENDOR_ORDER, ['ashby', 'greenhouse', 'lever'])) pass('the default probe order is Ashby, Greenhouse, Lever (the order measured to pay for the fewest probes)');
  else fail(`SEED_VENDOR_ORDER ${JSON.stringify(SEED_VENDOR_ORDER)}`);

  const yc = { name: 'PostHog', slug: 'posthog', url: 'https://posthog.com', source: 'yc' };
  const c = toPortalCandidates(yc);
  const urls = c.map((x) => x.careers_url);
  if (eq(urls, ['https://jobs.ashbyhq.com/posthog', 'https://job-boards.greenhouse.io/posthog', 'https://jobs.lever.co/posthog'])) {
    pass('a YC company with no ATS hint gets all three boards, Ashby first, on its YC slug only');
  } else {
    fail(`YC candidates: ${JSON.stringify(urls)}`);
  }
  if (c.every((x) => x.name === 'PostHog' && x.source === 'yc' && x.slug === 'posthog')) pass('each candidate carries the display name, source and slug');
  else fail(`candidate fields: ${JSON.stringify(c)}`);

  const a16z = { name: 'Dynamic Labs, Inc.', slug: 'dynamic-labs', url: 'https://dynamic.xyz', source: 'a16z' };
  const ac = toPortalCandidates(a16z).map((x) => `${x.vendor}/${x.slug}`);
  const expected = [
    'ashby/dynamic-labs', 'greenhouse/dynamic-labs', 'lever/dynamic-labs',
    'ashby/dynamiclabs', 'greenhouse/dynamiclabs', 'lever/dynamiclabs',
    'ashby/dynamic', 'greenhouse/dynamic', 'lever/dynamic',
  ];
  if (eq(ac, expected)) pass('an a16z company is probed on its title slug across all vendors before the separator-free and website-label spellings');
  else fail(`a16z candidates: ${JSON.stringify(ac)}`);

  // Every candidate is something the real provider will route, on its own host.
  const detected = c.every((x) => {
    const d = detectors[x.vendor].detect({ name: x.name, careers_url: x.careers_url });
    return d && new URL(d.url).hostname === { greenhouse: 'boards-api.greenhouse.io', ashby: 'api.ashbyhq.com', lever: 'api.lever.co' }[x.vendor];
  });
  if (detected) pass('every candidate is accepted by its provider\'s detect(), on that vendor\'s API host');
  else fail('a candidate was rejected by its provider');

  // An explicit hint on the company is trusted and exclusive; a remembered board goes first.
  const hinted = toPortalCandidates({ ...yc, ats: 'lever', ats_id: 'posthog-inc' });
  if (eq(hinted.map((x) => x.careers_url), ['https://jobs.lever.co/posthog-inc'])) pass('an explicit ats + ats_id on the company is the only candidate');
  else fail(`explicit hint: ${JSON.stringify(hinted)}`);
  const remembered = toPortalCandidates(yc, { hint: { vendor: 'lever', slug: 'posthog' } }).map((x) => `${x.vendor}/${x.slug}`);
  if (eq(remembered, ['lever/posthog', 'ashby/posthog', 'greenhouse/posthog'])) pass('a remembered board is probed first and not listed twice');
  else fail(`remembered hint: ${JSON.stringify(remembered)}`);
  const junkHint = toPortalCandidates(yc, { hint: { vendor: 'nope', slug: 'x/y' } }).map((x) => `${x.vendor}/${x.slug}`);
  if (eq(junkHint, ['ashby/posthog', 'greenhouse/posthog', 'lever/posthog'])) pass('a hint naming an unknown vendor or an unsafe slug is ignored');
  else fail(`junk hint: ${JSON.stringify(junkHint)}`);

  if (toPortalCandidates({ name: 'No Slug', slug: '', url: '', source: 'yc' }).length === 0) pass('a company with no usable slug has no candidates (and so is never turned into a URL)');
  else fail('a slugless company produced candidates');
  if (eq(toPortalCandidates(yc, { vendors: ['lever', 'ashby'] }).map((x) => x.vendor), ['lever', 'ashby'])) pass('the vendor order is overridable');
  else fail('vendors option ignored');

  const unsafe = toPortalCandidates({ name: 'x', slug: 'a/../b', url: 'https://good.example', source: 'a16z' });
  if (unsafe.every((x) => SLUG_RE.test(x.slug) && !x.careers_url.includes('..'))) pass('an unsafe slug never reaches a URL (only the safe website label survives)');
  else fail(`unsafe slug candidates: ${JSON.stringify(unsafe)}`);

  // The 'embed' slug is a real Greenhouse path segment that is not a board.
  const embed = toPortalCandidates({ name: 'Embed', slug: 'embed', url: '', source: 'yc' });
  const gh = embed.find((x) => x.vendor === 'greenhouse');
  if (gh && greenhouse.detect({ name: gh.name, careers_url: gh.careers_url }) === null) pass('the slug "embed" is routable on Ashby/Lever but not Greenhouse, so the probe counts it undetectable instead of fetching a non-board');
  else fail('greenhouse accepted the "embed" slug');

  // toPortalEntry keeps its single-URL contract (Greenhouse from the slug).
  if (toPortalEntry(yc).careers_url === VENDOR_BOARD_URL.greenhouse('posthog')) pass('toPortalEntry still returns the single Greenhouse URL');
  else fail(`toPortalEntry: ${JSON.stringify(toPortalEntry(yc))}`);
}

// ── YC flags and probe order ─────────────────────────────────────────
{
  const parsed = parseYCPayload({ companies: [
    { name: 'Hiring Co', slug: 'hiring-co', website: 'https://h.co', badges: ['highlightWomen', 'isHiring'], status: 'Active' },
    { name: 'Plain Co', slug: 'plain-co', badges: [], status: 'Active' },
    { name: 'Acquired Co', slug: 'acquired-co', status: 'Acquired' },
    { name: 'Inactive Co', slug: 'inactive-co', status: 'Inactive', badges: ['isHiring'] },
    { name: 'Flat Flag Co', slug: 'flat-flag-co', isHiring: true },
    { name: 'No Fields Co', slug: 'no-fields-co' },
  ] });
  const by = Object.fromEntries(parsed.map((c) => [c.slug, c]));
  if (by['hiring-co'].hiring === true && by['hiring-co'].status === 'Active' && by['flat-flag-co'].hiring === true
    && by['plain-co'].hiring === undefined && by['no-fields-co'].status === undefined && by['acquired-co'].status === 'Acquired') {
    pass('parseYCPayload carries the isHiring badge (or flag) and the status');
  } else {
    fail(`YC flags: ${JSON.stringify(parsed)}`);
  }

  const input = parsed.slice();
  const ordered = prioritizeSeedCompanies(input);
  const order = ordered.map((c) => c.slug).join(',');
  // hiring first (portfolio order within), then the rest in portfolio order, inactive last — even an inactive one that is flagged
  if (order === 'hiring-co,flat-flag-co,plain-co,acquired-co,no-fields-co,inactive-co') pass('prioritizeSeedCompanies puts hiring first and inactive last, otherwise keeping portfolio order');
  else fail(`priority order: ${order}`);
  if (ordered.length === input.length && new Set(ordered).size === input.length && input.map((c) => c.slug).join(',') === parsed.map((c) => c.slug).join(',')) {
    pass('prioritizing drops nothing and does not reorder its input');
  } else {
    fail('prioritizeSeedCompanies dropped or mutated');
  }
}
