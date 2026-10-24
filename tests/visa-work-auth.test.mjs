// tests/visa-work-auth.test.mjs — the work-authorization half of visa_filter:
// clearance, citizenship and sponsorship refusal, plus the "keep" cases that
// make the rule safe to run unattended.
//
// The cases below are the real JDs stage 2 hard-blocked on 2026-10-23 (18 of
// them). Stage 1 let every one through: 10 were LinkedIn rows whose parser
// carries no description, 1 was IBM (the provider asked for `description` and
// dropped it), 1 was Workday (the detail document was fetched and its JD
// discarded), and 6 had text that the old literal list could not match
// ("U.S. Citizenship required." never matched "us citizenship required").
//
// The KEEP block is the half that matters more. A filter that catches all 18
// but also drops "security clearance preferred", "must be authorized to work
// in the US", or a Cloudflare export-license footer loses real jobs silently,
// which is worse than a stage-2 read.

import { pass, fail } from './helpers.mjs';
import {
  buildVisaFilter, normalizeVisaText, DEFAULT_VISA_PATTERNS,
} from '../scan.mjs';

console.log('\nwork authorization — clearance / citizenship / no-sponsorship');

const filter = buildVisaFilter({ enabled: true, require_mention: false });

// ── Must DROP: real sentences from the 18 stage-2 blockers ────────────────
const DROPS = [
  ['clearance', 'Candidates must hold or be eligible to obtain a valid Personnel Security Clearance as a condition of employment.'],
  ['clearance', 'Active TS/SCI security clearance.'],
  ['clearance', 'Clearance: Active TS/SCI security clearance is strictly required.'],
  ['clearance', 'Active TS/SCI clearance with Polygraph required.'],
  ['clearance', 'TS/SCI with FSP Poly'],
  ['clearance', 'TS/SCI level clearance with a Full Scope Polygraph.'],
  ['clearance', 'Ability to obtain/maintain a Secret DoD clearance, U.S. Citizenship required.'],
  ['clearance', 'Security Clearance Eligibility: Ability to obtain Department of Homeland Security (DHS) Entry on Duty (EOD) authorization.'],
  ['clearance', 'Minimum Clearance Required: TS clearance with SCI eligibility'],
  ['citizenship', 'This position requires verification of U.S. citizenship due to citizenship-based legal restrictions.'],
  ['citizenship', 'Applicants selected will be subject to a government security investigation and must meet eligibility requirements for access to classified information. US Citizenship Required'],
  ['no_sponsorship', 'IBM will not be providing visa sponsorship for this position now or in the future.'],
  ['no_sponsorship', 'Is role eligible for Immigration Sponsorship? No. Please note that we will not sponsor applicants for work visas for this position.'],
  ['no_sponsorship', 'Applicants for employment in the US must have work authorization that does not now or in the future require sponsorship of a visa for employment authorization in the United States.'],
  ['no_sponsorship', 'Must already be authorized to work in the United States on a full-time, permanent basis without requiring current or future visa sponsorship.'],
  ['no_sponsorship', 'Location: Remote - US based candidates only, no visa sponsorship available'],
  ['no_sponsorship', 'We are unable to sponsor visas for this role.'],
];

for (const [category, text] of DROPS) {
  const verdict = filter.assess(text);
  if (!verdict.pass && verdict.category === category) {
    pass(`${category}: ${text.slice(0, 60)}`);
  } else {
    fail(`expected a ${category} drop, got ${JSON.stringify({ pass: verdict.pass, category: verdict.category, reason: verdict.reason })} — ${text.slice(0, 90)}`);
  }
}

// Punctuation/typography folding: the exact reason the old literal list missed
// "U.S. Citizenship required." while it caught "us citizenship required".
const folded = normalizeVisaText('U.S. Citizenship required.');
if (folded === 'us citizenship required.') pass('U.S. punctuation is folded before matching');
else fail(`normalizeVisaText left the punctuation in: ${JSON.stringify(folded)}`);

const nbHyphen = normalizeVisaText('citizenship\u2011based restrictions');
if (nbHyphen === 'citizenship-based restrictions') pass('U+2011 non-breaking hyphen folds to ASCII');
else fail(`U+2011 was not folded: ${JSON.stringify(nbHyphen)}`);

// ── Must KEEP: the conservative half ───────────────────────────────────────
const KEEPS = [
  ['empty description', ''],
  ['authorized to work, no refusal', 'You must be authorized to work in the United States.'],
  ['legally authorized to work', 'Candidates must be legally authorized to work in the US.'],
  ['clearance preferred only', 'An active security clearance is preferred but not required.'],
  ['clearance not required', 'No security clearance is required for this role.'],
  ['clearance: none required', 'Clearance: None required.'],
  ['does not require a clearance', 'This position does not require a security clearance.'],
  ['requires no clearance', 'This position requires no security clearance.'],
  ['customs clearance', 'Customs clearance documentation is required for hardware shipments.'],
  ['sponsors visas', 'We will sponsor H-1B visas for this role.'],
  ['bare ITAR mention', 'Familiarity with ITAR and export-control processes is a plus.'],
  ['citizenship not required', 'U.S. citizenship is not required for this position.'],
  ['US person, citizen or GC', 'Must be a U.S. person (citizen or green card holder).'],
  ['export license boilerplate', 'The role is controlled under these U.S. export laws without sponsorship for an export license.'],
  ['no sponsorship needed by role', 'This position does not require sponsorship; it is open to candidates with existing work authorization.'],
];

for (const [label, text] of KEEPS) {
  const verdict = filter.assess(text);
  if (verdict.pass) pass(`keep — ${label}`);
  else fail(`dropped a job it must keep (${label}): ${JSON.stringify(verdict)} — ${text.slice(0, 90)}`);
}

// A missing description is KEPT: stage 2 reads the JD, or P2 fetches it.
if (filter.assess(undefined).pass && filter.assess(null).pass) pass('no description is kept, never dropped');
else fail('a missing description was dropped');

// ── Sentence evidence for the log ──────────────────────────────────────────
{
  const text = 'About us. Active TS/SCI security clearance is required for this role. Apply now.';
  const verdict = filter.assess(text);
  if (!verdict.pass && /ts\/sci/i.test(verdict.sentence) && !/apply now/i.test(verdict.sentence)) {
    pass('the dropped sentence is quoted for the scan log');
  } else {
    fail(`sentence extraction was wrong: ${JSON.stringify(verdict.sentence)}`);
  }
}

// ── require_mention keeps working as before ───────────────────────────────
{
  const strict = buildVisaFilter({ enabled: true, require_mention: true });
  if (!strict.assess('Great team, hard problems.').pass && strict.assess('We sponsor H-1B visas.').pass) {
    pass('require_mention: true still keeps only explicit sponsorship');
  } else {
    fail('require_mention behaviour changed');
  }
  if (strict.assess('').pass === false) pass('require_mention: true still rejects an empty description');
  else fail('require_mention: true accepted an empty description');
}

// ── Config escape hatches and additions ────────────────────────────────────
{
  const literalOnly = buildVisaFilter({ enabled: true, patterns: false });
  if (literalOnly.assess('Active TS/SCI security clearance.').pass) {
    pass('patterns: false restores literal-only matching (escape hatch)');
  } else {
    fail('patterns: false did not disable the pattern tier');
  }

  const extra = buildVisaFilter({ enabled: true, patterns: [{ category: 'customer', pattern: 'must hold a blue badge' }] });
  const verdict = extra.assess('Candidates must hold a blue badge.');
  if (!verdict.pass && verdict.category === 'customer') pass('a config pattern is additive and keeps its category');
  else fail(`config pattern did not fire: ${JSON.stringify(verdict)}`);

  const explicitKeep = buildVisaFilter({ enabled: true, keep_patterns: [{ pattern: 'ts\\/sci.*preferred' }] });
  if (explicitKeep.assess('TS/SCI preferred.').pass) pass('a config keep-pattern can veto a drop');
  else fail('config keep_patterns did not veto the drop');
}

// ── The P2 hook: "does this listing need a JD fetch?" ─────────────────────
{
  if (filter.needsJd({ url: 'https://example.com/j', description: '' })
      && filter.needsJd({ url: 'https://example.com/j' })
      && strictSafe(filter, { url: 'https://example.com/j', description: 'x'.repeat(600) }) === false) {
    pass('needsJd: empty/short text fetches, a full JD does not');
  } else {
    fail('needsJd thresholds are wrong');
  }
  if (!filter.needsJd({ description: '' }) && !filter.needsJd(null)) pass('needsJd: no URL means no fetch');
  else fail('needsJd asked to fetch without a URL');
}

function strictSafe(f, job) {
  return f.needsJd(job);
}

// ── Defaults are exactly the three families ───────────────────────────────
{
  const categories = new Set(DEFAULT_VISA_PATTERNS.map((p) => p.category));
  if (['clearance', 'citizenship', 'no_sponsorship'].every((c) => categories.has(c)) && categories.size === 3) {
    pass('the default pattern set is exactly clearance / citizenship / no_sponsorship');
  } else {
    fail(`unexpected default categories: ${[...categories].join(', ')}`);
  }
}

// ── The disabled filter is inert and still exposes the API ────────────────
{
  const off = buildVisaFilter({ enabled: false });
  if (off('Active TS/SCI security clearance.') && off.assess('x').pass && off.needsJd({ url: 'https://e.com', description: '' }) === false) {
    pass('visa_filter.enabled: false stays inert');
  } else {
    fail('the disabled filter is not inert');
  }
}

// ── P1: the two providers that were throwing the JD away ──────────────────
// Both payloads below are the shapes those APIs actually return; the point is
// that the description now reaches the gate at all, not that the parser is
// exotic.
import { parseIbmResponse } from '../providers/ibm.mjs';
import { descriptionFromDetail } from '../providers/workday.mjs';

{
  const page = parseIbmResponse({
    hits: {
      hits: [{
        _source: {
          title: 'Technical Consultant - Data and AI Security',
          url: 'https://careers.ibm.com/careers/JobDetail?jobId=137601',
          field_keyword_19: 'Austin, TX',
          description: '<p>IBM will not be providing visa sponsorship for this position now or in the future.</p>',
        },
      }],
    },
  });
  if (page.length === 1 && /visa sponsorship/.test(page[0].description || '')
      && !page[0].description.includes('<p>')) {
    pass('IBM: the search payload’s HTML description is kept and stripped');
  } else {
    fail(`IBM description mapping: ${JSON.stringify(page[0] || null)}`);
  }
  if (page.length === 1 && filter.assess(page[0].description).pass === false) {
    pass('IBM: that description now reaches the visa gate end-to-end');
  } else {
    fail('IBM description did not reach the gate');
  }
}

{
  const jd = descriptionFromDetail({
    jobPostingInfo: {
      jobDescription: '<div><p>Active TS/SCI security clearance is required.</p></div>',
      location: 'Reston, VA',
    },
  });
  if (/TS\/SCI/.test(jd) && !jd.includes('<p>')) pass('Workday: the detail document’s JD is extracted and stripped');
  else fail(`Workday description extraction: ${JSON.stringify(jd)}`);

  if (filter.assess(jd).pass === false) pass('Workday: that detail JD now reaches the visa gate');
  else fail('Workday description did not reach the gate');

  if (descriptionFromDetail({ jobPostingInfo: { location: 'X' } }) === ''
      && descriptionFromDetail(null) === ''
      && descriptionFromDetail({}) === '') {
    pass('Workday: no JD body yields "", never a fabricated description');
  } else {
    fail('Workday descriptionFromDetail invented text for a document without a JD');
  }
}
