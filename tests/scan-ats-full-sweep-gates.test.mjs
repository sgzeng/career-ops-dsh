// tests/scan-ats-full-sweep-gates.test.mjs — the sweep applies the gates
// scan.mjs applies after the title filter: skip_tiers, visa_filter and
// country_eligibility_filter.
//
// The sweep used to stop at title + location + content. In a sample of the real
// sweep's 17 matches, three were PhD/other internships and one said it would not
// sponsor; scan.mjs would have removed all four from the same boards. The gates
// are built by scan.mjs's own builders from the same portals.yml keys, run in
// scan.mjs's order (title, tier, location, content, country, visa), and are
// counted per gate in the summary and --json.
//
// Part 1 checks the gate builders and the order. Part 2 runs the whole scanner.
// Part 3 checks that --resume refuses a checkpoint written under other gates.
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from './helpers.mjs';
import { DEFAULT_PORTALS, NON_US_PROFILE, US_PROFILE, ghBoard, makeSweepSandbox, runSweep } from './sweep-harness.mjs';

console.log('\nscan-ats-full — tier, visa and country gates on the sweep');

const href = (rel) => pathToFileURL(join(ROOT, rel)).href;
const full = await import(href('scan-ats-full.mjs'));
const scan = await import(href('scan.mjs'));
const { classifyTier } = await import(href('classify-tier.mjs'));
const { buildQualityGates, firstRejectingFilter, passesFilters, filterFingerprints, changedFilterKeys } = full;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Part 1: the builders ──────────────────────────────────────────────────────

{
  const none = buildQualityGates({});
  const absent = buildQualityGates(undefined);
  if (none.tierFilter === null && none.countryFilter === null && none.visaFilter === null && none.skipTiers.length === 0
    && absent.tierFilter === null && absent.visaFilter === null) {
    pass('a portals.yml with none of the three keys builds no gate at all: an existing install sweeps exactly as before');
  } else {
    fail(`gates without config: ${JSON.stringify(none)}`);
  }
  const off = buildQualityGates({ visa_filter: { enabled: false, negative: ['no sponsorship'] } });
  if (off.visaFilter === null) pass('visa_filter with enabled: false builds no gate (scan.mjs: "all jobs pass")');
  else fail('disabled visa_filter still gates');
}

{
  const { tierFilter, skipTiers } = buildQualityGates({ skip_tiers: ['Intern', 'entry', 7, null, 'bogus'] });
  const dropped = ['Security Engineer Intern', 'Software Engineering Internships: Ph.D. Research', 'Junior Security Engineer', 'Associate Security Researcher', 'Security Analyst I', 'Graduate Engineer Program'];
  const kept = ['Security Engineer', 'Senior Security Engineer', 'Security Engineer II', 'Staff Security Researcher', 'University Graduate, Security Engineer', 'Member of Technical Staff, Security'];
  const wrong = [...dropped.filter((t) => tierFilter(t)), ...kept.filter((t) => !tierFilter(t))];
  if (wrong.length === 0 && eq(skipTiers, ['intern', 'entry', 'bogus'])) {
    pass('skip_tiers [intern, entry]: interns and entry-level titles are dropped, mid/senior and "University Graduate" titles kept; names are lowercased and non-strings ignored, as in scan.mjs');
  } else {
    fail(`tier gate misjudged: ${JSON.stringify(wrong)} skipTiers=${JSON.stringify(skipTiers)}`);
  }
  const sameAsScan = [...dropped, ...kept].every((t) => tierFilter(t) === !['intern', 'entry'].includes(classifyTier(t)));
  if (sameAsScan) pass('the gate is `skipTiers.includes(classifyTier(title))` itself: title only, so title_filter_overrides and title nets play no part');
  else fail('tier gate disagrees with classifyTier');
  const unknown = buildQualityGates({ skip_tiers: ['senior-ish'] }).tierFilter;
  if (unknown && unknown('Senior Security Engineer') && unknown('Security Intern')) pass('a tier name the classifier never returns matches nothing, as in scan.mjs');
  else fail('unknown tier name dropped something');
}

{
  const REAL_SHAPE = {
    enabled: true, require_mention: false,
    negative: ['no sponsorship', 'unable to sponsor', 'not able to sponsor', 'will not sponsor', 'does not offer sponsorship', 'without sponsorship', 'us citizenship required', 'must be a us citizen', 'active security clearance', 'ts/sci', 'top secret'],
  };
  const { visaFilter } = buildQualityGates({ visa_filter: REAL_SHAPE });
  const scanFilter = scan.buildVisaFilter(REAL_SHAPE);
  const texts = [
    ['We are unable to sponsor visas for this role.', false],
    ['Active TS/SCI clearance required.', false],
    ['US citizenship required.', false],
    ['We do sponsor visas!', true],
    ['', true],
    [undefined, true],
    // export-control boilerplate is about an export license, not a work visa
    ['This position may require a license under U.S. export laws, without sponsorship for an export license.', true],
  ];
  const wrong = texts.filter(([t, want]) => visaFilter(t) !== want || visaFilter(t) !== scanFilter(t));
  if (wrong.length === 0) pass('the visa gate is scan.mjs\'s buildVisaFilter: explicit refusals and clearances drop, silence and "we do sponsor" pass, the export-license boilerplate does not trip it');
  else fail(`visa gate: ${JSON.stringify(wrong)}`);

  // CONTRACT (2026-10-23): a custom `negative` list ADDS to the canonical
  // patterns; it can no longer narrow them away. Before this, the author's list
  // replaced the defaults, which is how 18 clearance/citizenship/no-sponsorship
  // postings reached stage 2 on 2026-10-23. `patterns: false` is the escape
  // hatch for an install that really wants literal-only matching.
  const turquoise = 'This role requires current authorization to work in the United States. Turquoise does not sponsor employment visas (H-1B, PERM, etc.) for this position.';
  const withDefaults = buildQualityGates({ visa_filter: { enabled: true } }).visaFilter;
  const literalOnly = buildQualityGates({ visa_filter: { enabled: true, patterns: false, negative: ['will not sponsor'] } }).visaFilter;
  if (visaFilter(turquoise) === false && withDefaults(turquoise) === false && literalOnly(turquoise) === true) {
    pass('a custom visa_filter.negative is additive: the canonical patterns still drop "does not sponsor", and patterns: false opts out');
  } else {
    fail('a custom negative list can still narrow the canonical patterns away');
  }
  const strict = buildQualityGates({ visa_filter: { enabled: true, require_mention: true, positive: ['will sponsor'] } }).visaFilter;
  if (strict('We will sponsor.') && !strict('Nothing about visas.') && !strict('')) pass('require_mention keeps only postings that advertise sponsorship, a missing description included');
  else fail('require_mention semantics changed');
}

{
  const cfg = { country_eligibility_filter: { exclusionary: ['must be located in the united states'], inclusive: ['will sponsor'] } };
  const us = buildQualityGates(cfg, { candidateCountry: 'United States' });
  const usSpaced = buildQualityGates(cfg, { candidateCountry: '  united STATES ' });
  const ca = buildQualityGates(cfg, { candidateCountry: 'Canada' });
  const unknown = buildQualityGates(cfg, { candidateCountry: '' });
  const must = 'Candidates must be located in the United States.';
  const widened = 'Candidates must be located in the United States. We will sponsor.';
  const named = 'Candidates must be located in the United States or Canada.';
  if (us.countryInert && usSpaced.countryInert && us.countryFilter(must) === true && usSpaced.countryFilter(must) === true) {
    pass('country_eligibility_filter is inert for a United States profile (case and spacing aside): the gate is wired and reported inactive, and drops nothing');
  } else {
    fail('country gate fires for a US profile');
  }
  if (!ca.countryInert && ca.countryFilter(must) === false && ca.countryFilter(widened) === true && ca.countryFilter(named) === true && ca.countryFilter('No location rule.') === true
    && unknown.countryFilter(must) === false) {
    pass('for any other profile country it drops "must be located in…" unless an inclusive phrase widens it or the candidate\'s own country is named');
  } else {
    fail('country gate semantics differ from buildCountryEligibilityFilter');
  }
}

// order: title, tier, location, content, country, visa — the order scan.mjs counts in
{
  const gates = buildQualityGates({
    skip_tiers: ['intern'],
    visa_filter: { enabled: true, negative: ['unable to sponsor'] },
    country_eligibility_filter: { exclusionary: ['must be located in the united states'] },
  }, { candidateCountry: 'Canada' });
  const deps = {
    titleFilter: scan.buildTitleFilter({ positive: ['security'], negative: ['sales'] }),
    tierFilter: gates.tierFilter,
    locationFilter: scan.buildLocationFilter({ block: ['Berlin'] }),
    contentFilter: scan.buildContentFilter({ positive: ['threat'] }),
    countryFilter: gates.countryFilter,
    visaFilter: gates.visaFilter,
    titleFilterConfig: { positive: ['security'] },
    companySlug: 'acme',
  };
  const verdict = (job) => firstRejectingFilter({ url: 'https://x.test/1', location: 'Remote', description: 'threat intel', ...job }, deps);
  const cases = [
    [{ title: 'Pastry Chef Intern' }, 'title'],
    [{ title: 'Sales Security Intern' }, 'title'],
    [{ title: 'Security Intern', location: 'Berlin' }, 'tier'],                  // fails tier AND location: tier, as scan.mjs counts it
    [{ title: 'Security Engineer', location: 'Berlin' }, 'location'],
    [{ title: 'Security Engineer', description: 'pastries' }, 'content'],
    [{ title: 'Security Engineer', description: 'threat. Must be located in the United States. Unable to sponsor.' }, 'country'], // country before visa
    [{ title: 'Security Engineer', description: 'threat. Unable to sponsor.' }, 'visa'],
    [{ title: 'Security Engineer' }, null],
  ];
  const wrong = cases.filter(([job, want]) => verdict(job) !== want).map(([job, want]) => `${job.title}/${job.location ?? ''} wanted ${want} got ${verdict(job)}`);
  if (wrong.length === 0) pass('first rejecting gate, in scan.mjs\'s order: title, tier, location, content, country, visa (a posting failing two is counted under the earlier)');
  else fail(`gate order: ${JSON.stringify(wrong)}`);
  if (passesFilters({ title: 'Security Engineer', url: 'u', location: 'Remote' }, { titleFilter: deps.titleFilter, locationFilter: deps.locationFilter, titleFilterConfig: deps.titleFilterConfig }) === true
    && passesFilters({ title: 'Pastry Chef', url: 'u' }, { titleFilter: deps.titleFilter, locationFilter: deps.locationFilter }) === false) {
    pass('passesFilters keeps its old contract for a caller that passes none of the new gates');
  } else {
    fail('passesFilters changed for old callers');
  }
}

// ── Part 2: the whole scanner ─────────────────────────────────────────────────

const GATED_PORTALS = `
title_filter:
  positive: [security]
  negative: [sales]
location_filter:
  block: [Berlin]
skip_tiers: [intern, entry]
visa_filter:
  enabled: true
  negative: ["unable to sponsor", "us citizenship required"]
country_eligibility_filter:
  exclusionary: ["must be located in the united states"]
  inclusive: ["will sponsor"]
`;
const BOARD = ghBoard('acme', [
  { id: 1, title: 'Senior Security Engineer', description: 'We will sponsor visas.' },                                  // kept
  { id: 2, title: 'Security Engineer Intern', description: 'Summer program.' },                                       // tier
  { id: 3, title: 'Junior Security Analyst', description: 'Learn on the job.' },                                       // tier (entry)
  { id: 4, title: 'Security Intern', location: 'Berlin, Germany', description: 'Summer program.' },                   // tier, not location
  { id: 5, title: 'Security Engineer, Platform', description: 'We are unable to sponsor work visas.' },                // visa
  { id: 6, title: 'Security Researcher', description: 'US citizenship required.' },                                    // visa
  { id: 7, title: 'Security Engineer, Cloud', description: 'Candidates must be located in the United States.' },       // country (non-US profile only)
  { id: 8, title: 'Security Engineer, Berlin', location: 'Berlin, Germany', description: 'On site.' },                 // location
  { id: 9, title: 'Sales Security Intern', description: 'Quota carrying.' },                                           // title (not counted as tier)
]);
{
  const sb = makeSweepSandbox({ boards: ['acme'], portals: GATED_PORTALS, profile: US_PROFILE, rules: [BOARD] });
  try {
    const r = runSweep(sb, ['--json', '--dry-run']);
    const j = r.json;
    const titles = (j?.offers ?? []).map((o) => o.title).sort();
    const want = ['Senior Security Engineer', 'Security Engineer, Cloud'].sort();
    if (r.status === 0 && eq(titles, want)) pass('United States profile: the two postings that survive are the sponsoring one and the "must be located in the US" one (the country gate is inert for this profile)');
    else fail(`US profile kept ${JSON.stringify(titles)}\n${r.stderr.slice(0, 400)}`);
    if (j?.postingsFilteredTier === 3 && j.postingsFilteredVisa === 2 && j.postingsFilteredCountry === 0
      && eq(j.gates, { skipTiers: ['intern', 'entry'], visaFilterActive: true, countryFilterActive: true, countryFilterInert: true })) {
      pass('--json counts what each gate removed (tier 3, visa 2, country 0) and says which gates ran and that the country gate is inert');
    } else {
      fail(`gate counts: ${JSON.stringify({ t: j?.postingsFilteredTier, v: j?.postingsFilteredVisa, c: j?.postingsFilteredCountry, g: j?.gates })}`);
    }
    const human = runSweep(sb, ['--dry-run']).stdout;
    const summary = human.slice(human.indexOf('::career-ops:scan-summary::'));
    if (/Filtered by tier:\s+3 \(skip_tiers: intern, entry\)/.test(summary) && /Filtered by visa:\s+2\b/.test(summary)
      && /Filtered by country:\s+0 \(inactive: the profile country is United States\)/.test(summary)) {
      pass('the summary block prints "Filtered by tier / visa / country" like scan.mjs does, and says the country gate is inactive for this profile');
    } else {
      fail(`summary block:\n${summary.slice(0, 900)}`);
    }
  } finally { sb.cleanup(); }
}
{
  const sb = makeSweepSandbox({ boards: ['acme'], portals: GATED_PORTALS, profile: NON_US_PROFILE, rules: [BOARD] });
  try {
    const j = runSweep(sb, ['--json', '--dry-run']).json;
    const titles = (j?.offers ?? []).map((o) => o.title).sort();
    if (eq(titles, ['Senior Security Engineer']) && j.postingsFilteredCountry === 1 && j.gates?.countryFilterInert === false) {
      pass('a non-US profile (Canada): the country gate is live and removes the "must be located in the United States" posting');
    } else {
      fail(`Canada profile: kept ${JSON.stringify(titles)} country=${j?.postingsFilteredCountry}`);
    }
  } finally { sb.cleanup(); }
}
{
  // No gate configured: nothing is removed, no gate line is printed (scan.mjs prints a line per gate it runs).
  const sb = makeSweepSandbox({ boards: ['acme'], portals: 'title_filter:\n  positive: [security]\n', profile: US_PROFILE, rules: [BOARD] });
  try {
    const r = runSweep(sb, ['--dry-run']);
    const j = runSweep(sb, ['--json', '--dry-run']).json;
    if (j?.postingsKept === 9) {
      pass('without skip_tiers / visa_filter / country_eligibility_filter nothing extra is removed: all 9 postings that pass the title filter are kept');
    } else {
      fail(`ungated sweep kept ${j?.postingsKept}`);
    }
    if (!/Filtered by (tier|visa|country)/.test(r.stdout) && j.postingsFilteredTier === 0) pass('and the summary prints no "Filtered by tier/visa/country" line for a gate that is not configured');
    else fail('gate line printed for an unconfigured gate');
  } finally { sb.cleanup(); }
}
{
  // The real configuration's shape, through the whole scanner: DEFAULT_PORTALS mirrors the author's keys.
  const sb = makeSweepSandbox({
    boards: ['figma', 'turquoise'],
    portals: DEFAULT_PORTALS,
    profile: US_PROFILE,
    rules: [
      ghBoard('figma', [
        { id: 1, title: 'PhD Intern, Security Research (2027)', description: 'Summer.' },
        { id: 2, title: 'Security Scientist', description: 'Join us.' },
      ]),
      ghBoard('turquoise', [{ id: 3, title: 'Senior Application Security Engineer', description: 'We will not offer sponsorship, no sponsorship available.' }]),
    ],
  });
  try {
    const j = runSweep(sb, ['--json', '--dry-run']).json;
    const titles = (j?.offers ?? []).map((o) => o.title).sort();
    if (eq(titles, ['Security Scientist']) && j.postingsFilteredTier === 1 && j.postingsFilteredVisa === 1) pass('a figma PhD intern and a "no sponsorship" Greenhouse posting are removed; the security scientist stays (the sample\'s junk, replayed)');
    else fail(`sample replay: ${JSON.stringify(titles)} tier=${j?.postingsFilteredTier} visa=${j?.postingsFilteredVisa}`);
  } finally { sb.cleanup(); }
}

// the seed scan runs the same gates, counts them per seed, and says so in its done line
{
  const probe = await import(href('seeds/seed-probe.mjs'));
  const vc = await import(href('seeds/vc-portfolios.mjs'));
  const greenhouse = (await import(href('providers/greenhouse.mjs'))).default;
  const { runSeedScan, createKeyedLimiter, formatSeedDone } = full;
  const DAY = 86_400_000;
  const mk = (title, over = {}) => ({ title, url: `https://jobs.example.test/${encodeURIComponent(title)}`, company: 'acme', location: 'Remote', postedAt: Date.now() - DAY, description: 'security', ...over });
  const provider = {
    ...greenhouse,
    async fetch() {
      return [
        mk('Senior Security Engineer', { description: 'We will sponsor visas.' }),
        mk('Security Engineer Intern'),
        mk('Security Engineer, Platform', { description: 'We are unable to sponsor.' }),
        mk('Security Engineer, Cloud', { description: 'Must be located in the United States.' }),
      ];
    },
  };
  const YC = vc.SEED_SOURCES.yc;
  const realFetch = YC.fetch;
  const realWarn = console.error;
  YC.fetch = async () => [{ name: 'Acme', slug: 'acme', url: '', source: 'yc' }];
  console.error = () => {};
  try {
    const run = async (country) => {
      const gates = buildQualityGates({
        skip_tiers: ['intern', 'entry'],
        visa_filter: { enabled: true, negative: ['unable to sponsor'] },
        country_eligibility_filter: { exclusionary: ['must be located in the united states'] },
      }, { candidateCountry: country });
      const titleFilterConfig = { positive: ['security'] };
      const opts = {
        sinceDays: 10, limit: Infinity, shuffle: false, includeUndated: false,
        titleFilter: scan.buildTitleFilter(titleFilterConfig), locationFilter: scan.buildLocationFilter({}),
        contentFilter: scan.buildContentFilter({}), titleFilterConfig, blacklist: new Map(), includeBlacklisted: false,
        json: false, verbose: false, levelGate: null, gates,
      };
      const state = probe.createSeedRunState({ deadPath: null, livePath: null, persist: false, withKeySlot: createKeyedLimiter(6), sleep: async () => {} });
      return runSeedScan('yc', opts, {}, new Set(), 'YC', { providers: { greenhouse: provider, ashby: provider, lever: provider }, state });
    };
    const us = await run('United States');
    const ca = await run('Canada');
    if (eq(us.offers.map((o) => o.title).sort(), ['Security Engineer, Cloud', 'Senior Security Engineer']) && eq(us.stats.gated, { tier: 1, country: 0, visa: 1, duplicateRole: 0 })) {
      pass('the seed scan applies the tier and visa gates (country inert for a US profile) and counts each per seed');
    } else {
      fail(`seed gates (US): ${JSON.stringify(us.offers.map((o) => o.title))} ${JSON.stringify(us.stats.gated)}`);
    }
    if (eq(ca.offers.map((o) => o.title), ['Senior Security Engineer']) && eq(ca.stats.gated, { tier: 1, country: 1, visa: 1, duplicateRole: 0 })) {
      pass('...and the country gate too for a profile outside the United States');
    } else {
      fail(`seed gates (CA): ${JSON.stringify(ca.offers.map((o) => o.title))} ${JSON.stringify(ca.stats.gated)}`);
    }
    if (/gated: tier 1 \| visa 1 \| country 1 \| duplicate role 0/.test(formatSeedDone(ca.stats)) && !/gated:/.test(formatSeedDone({ ...ca.stats, gated: { tier: 0, country: 0, visa: 0, duplicateRole: 0 } }))) {
      pass('the seed done line names what the gates removed, and stays as it was when they removed nothing');
    } else {
      fail(`seed done line: ${formatSeedDone(ca.stats)}`);
    }
  } finally {
    console.error = realWarn;
    YC.fetch = realFetch;
  }
}

// ── Part 3: a checkpoint is only resumed under the gates it was written with ───────────

{
  const base = { title_filter: { positive: ['security'] } };
  const withGates = { ...base, skip_tiers: ['intern'], visa_filter: { enabled: true, negative: ['no sponsorship'] }, country_eligibility_filter: { exclusionary: ['x'] } };
  const cp = { filters: filterFingerprints(withGates, { candidateCountry: 'Canada' }) };
  const changed = (c, country = 'Canada') => changedFilterKeys(cp, filterFingerprints(c, { candidateCountry: country }));
  if (changed(structuredClone(withGates)).length === 0) pass('unchanged gate settings resume');
  else fail(`gates reported changed: ${changed(withGates)}`);
  const edits = [
    ['skip_tiers', (c) => { c.skip_tiers = ['intern', 'entry']; }],
    ['visa_filter', (c) => { c.visa_filter.negative.push('cannot sponsor'); }],
    ['country_eligibility_filter', (c) => { c.country_eligibility_filter.exclusionary.push('y'); }],
  ];
  for (const [key, edit] of edits) {
    const c = structuredClone(withGates);
    edit(c);
    if (eq(changed(c), [key])) pass(`a ${key} edit is named when --resume refuses`);
    else fail(`${key} edit reported as ${JSON.stringify(changed(c))}`);
  }
  if (eq(changed(structuredClone(withGates), 'United States'), ['country_eligibility_filter'])) pass('moving the profile country between a run and its --resume changes what the country gate does, so it is named too');
  else fail('profile country change not detected');
  if (changedFilterKeys({ filters: filterFingerprints(base) }, filterFingerprints({ ...base, country_eligibility_filter: undefined }, { candidateCountry: 'Canada' })).length === 0) pass('the profile country is only part of the fingerprint when the country gate is configured');
  else fail('profile country changed an unconfigured fingerprint');

  // A checkpoint written before these gates existed carries no keys for them: it is read as "they were not set".
  const legacy = { filters: Object.fromEntries(Object.entries(filterFingerprints(base)).filter(([k]) => !['skip_tiers', 'visa_filter', 'country_eligibility_filter'].includes(k))) };
  const unset = changedFilterKeys(legacy, filterFingerprints(base));
  const nowSet = changedFilterKeys(legacy, filterFingerprints({ ...base, skip_tiers: ['intern'] }));
  if (unset.length === 0 && eq(nowSet, ['skip_tiers'])) pass('a checkpoint from before these gates still resumes if they are still unset, and is refused by name if skip_tiers is set now (its boards were swept without it)');
  else fail(`legacy checkpoint: unset=${JSON.stringify(unset)} nowSet=${JSON.stringify(nowSet)}`);
}
