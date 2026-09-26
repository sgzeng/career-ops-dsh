// tests/level-filter.test.mjs — lib/level-filter.mjs, lib/jd-text.mjs and their
// scan.mjs / scan-ats-full.mjs hooks.
//
// The rule is a conjunction: a Staff / Principal / Distinguished title is
// dropped only when its JD ALSO requires 8+ years or a team lead. The title
// alone never drops a job, and every doubtful case keeps it.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  buildLevelFilter, findYearsRequirement, findLeadDuty,
} from '../lib/level-filter.mjs';
import {
  smartRecruitersDetailUrl, smartRecruitersJobText, linkedInDetailUrl, linkedInJobText, fetchJobDescription,
} from '../lib/jd-text.mjs';
import { makeLevelGate } from '../scan-ats-full.mjs';

console.log('\nlevel filter — JD-based Staff+ gate');

const CFG = {
  enabled: true,
  block: ['staff', 'principal', 'distinguished'],
  exempt: ['member of technical staff', 'technical staff'],
};
// Padding so a short excerpt reads as a JD (assess() treats < MIN_JD_CHARS as "no JD").
const PAD = ' We build security products for engineering teams and offer competitive benefits.'.repeat(8);
const jd = (s) => `${s}${PAD}`;

// 1. Off unless enabled with something to block
{
  if (buildLevelFilter(undefined) === null && buildLevelFilter({ enabled: false, block: ['staff'] }) === null
      && buildLevelFilter({ enabled: true, block: [] }) === null) {
    pass('absent, disabled, or empty block list → null');
  } else {
    fail('level filter must be off unless enabled with block words');
  }
  const lf = buildLevelFilter({ enabled: true, block: 'principal' });
  if (lf && lf.gated('Principal Engineer') && lf.minYears === 8) pass('a bare-string block list is a one-item list; min_years defaults to 8');
  else fail('bare-string block list or min_years default wrong');
}

// 1b. validate-portals.mjs knows the level_filter keys (run as a CLI: importing
// it would run its main() against the real portals.yml)
{
  const dir = mkdtempSync(join(tmpdir(), 'level-validate-'));
  const validate = (body) => {
    const file = join(dir, 'portals.yml');
    writeFileSync(file, `level_filter:\n  enabled: true\n  block: ["staff"]\n${body}`);
    try {
      return { code: 0, out: execFileSync(NODE, [join(ROOT, 'validate-portals.mjs'), '--file', file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (err) {
      return { code: err.status, out: String(err.stdout) };
    }
  };
  try {
    const ok = validate('  min_years: 8\n  fetch_jd: true\n');
    const bad = validate('  min_years: -1\n  fetch_jd: "yes"\n');
    if (!/level_filter/.test(ok.out) && bad.code === 1
        && /level_filter\.min_years/.test(bad.out) && /level_filter\.fetch_jd/.test(bad.out)) {
      pass('validate-portals accepts min_years / fetch_jd and rejects bad values');
    } else {
      fail(`validate-portals level_filter: ok=${ok.out} bad=${bad.out}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. Which titles are gated at all
{
  const lf = buildLevelFilter(CFG);
  const cases = [
    ['Staff Security Engineer', true],
    ['Security Engineer, Staff', true],
    ['Staff+ Application Security Engineer', true],
    ['Senior Staff Software Engineer', true],
    ['Principal Engineer, Memory Safety', true],
    ['Distinguished Engineer, AI Security', true],
    ['Member of Technical Staff, Security', false],
    ['Senior/Staff Security Researcher', false],
    ['Senior / Principal Security Researcher', false],
    ['Sr./Staff Engineer', false],
    ['Staff/Senior Engineer', false],
    ['Senior/Lead/Principal Offensive Security', false],
    ['Senior Security Engineer', false],
    ['Staffing Coordinator', false],
    ['Research Engineer, Principles of AI Safety', false],
  ];
  const wrong = cases.filter(([t, want]) => lf.gated(t) !== want);
  if (wrong.length === 0) pass(`${cases.length} titles gated as expected (whole words, flat MTS, Senior multi-level reqs never gated)`);
  else fail(`wrong gating: ${JSON.stringify(wrong)}`);
}

// 3. The title alone never drops: a gated title with no JD text is kept, with a note
{
  const lf = buildLevelFilter(CFG);
  const v = lf.assess('Principal Engineer, Memory Safety', 'Apply now.');
  if (!v.drop && v.gated && /no JD text/.test(v.note)) pass('Staff+ title without JD text is kept with a "level-check: … no JD text" note');
  else fail(`no-JD verdict: ${JSON.stringify(v)}`);
  const u = lf.assess('Security Engineer', jd('Requirements: 15+ years of experience.'));
  if (!u.drop && !u.gated && u.note === null) pass('an ungated title is never dropped, whatever its JD asks');
  else fail(`ungated verdict: ${JSON.stringify(u)}`);
}

// 4. Years: required figures, alternatives, preferences, non-requirements.
// Excerpts are verbatim or near-verbatim from live postings (2026-09-23).
{
  const cases = [
    // [text, expected years (null = no requirement)]
    ['Minimum qualifications: Bachelor’s degree or equivalent practical experience. 8 years of experience with security assessments or security design reviews or threat modeling.', 8],
    ['15 years of professional software development experience, or 13 years with an advanced degree.', 13],
    ['Bachelor’s degree and 8 years of experience, or Master’s degree and 6 years of experience, or PhD and 4 years of experience in software engineering.', 4],
    ['You may be a good fit if you: have 8-15+ years of software engineering experience implementing and maintaining critical systems at scale', 8],
    ['Minimum qualifications At least 8 years of software engineering or security engineering experience, including building security controls', 8],
    ['What we need to see: - bachelor’s degree (or equivalent experience) with 18+ years designing and building complex systems.', 18],
    ['10+ Years of Solutions Engineering Mastery: A proven track record in a customer-facing technical role', 10],
    ['You bring over a decade of experience in offensive security.', 10],
    ['Experience: 10+ years in vulnerability research.', 10],
    ['at least eight (8) years of professional experience in product security', 8],
    // preferences never count
    ['Preferred qualifications: 7+ years in application security or product security engineering', null],
    ['you may be a good fit if you: proficiency in python strong candidates may also: 8+ years of experience in a software engineering position have experience with abuse detection', null],
    ['Requirements: 5+ years of experience in security engineering. 10+ years of industry experience is a plus.', 5],
    ['Ideally, 10+ years of hands-on experience in exploit development.', null],
    ['What will make you stand out (preferred qualifications): 10+ years of experience building agents', null],
    // a PhD in place of the years
    ['PhD in Computer Science, or 8+ years of equivalent industry experience in program analysis.', null],
    ['8+ years of industry experience or a PhD in a related field.', null],
    // not experience requirements
    ['Founded in 2014, we have been protecting customers for over 10 years.', null],
    ['Vacation accrues at 6.15 hours per pay period for the first five years of employment.', null],
    ['Applicants must be 18 years old or older.', null],
    ['You will define our 10-year roadmap for memory safety.', null],
    ['Requirements: 3+ years of experience with C or C++ and 5+ years of experience in security.', 5],
  ];
  const wrong = [];
  for (const [text, want] of cases) {
    const got = findYearsRequirement(text)?.years ?? null;
    if (got !== want) wrong.push({ text: text.slice(0, 80), want, got });
  }
  if (wrong.length === 0) pass(`${cases.length} years excerpts read correctly (alternatives, preferences, PhD waiver, non-requirements)`);
  else fail(`years misread: ${JSON.stringify(wrong, null, 1)}`);
}

// 5. Team lead: explicit leadership of a team counts; influence and mentoring don't
{
  const cases = [
    ['As a Staff Security Engineer on Security Incident Response, you’ll serve as a senior technical leader and builder for the team.', true],
    ['NVIDIA is seeking a Distinguished Engineer to serve as the founding technical leader for our AI Safety & Security Engineering team.', true],
    ['Provide technical leadership and mentor engineers on your team.', true],
    ['3 years of experience in a technical leadership or tech lead role setting strategy for security programs.', true],
    ['5 years of experience in managing a team of engineers or security professionals.', true],
    ['Responsibilities: You will lead a team of four engineers and set its roadmap.', true],
    ['You will hire, grow and mentor a team of security engineers.', true],
    ['This role has direct reports.', true],
    ['You will serve as the tech lead for the fuzzing team.', true],
    // soft or negated
    ['Mentor engineers across the security team and broader engineering organization, contribute to hiring, and grow security engineering culture.', false],
    ['Lead complex, multi-functional projects and initiatives across teams.', false],
    ['Lead red team operations against production infrastructure.', false],
    ['Lead cross-team security initiatives and design reviews.', false],
    ['Partner with engineering managers and tech leads across the company.', false],
    ['This is an individual contributor role with no people management responsibilities.', false],
    ['3 years of experience leading teams in a technical capacity or leading technical risk analysis.', false],
    ['Preferred qualifications: experience leading a team of engineers.', false],
    ['Lead incident response for product-related issues.', false],
  ];
  const wrong = cases.filter(([text, want]) => Boolean(findLeadDuty(text)) !== want)
    .map(([text, want]) => ({ text: text.slice(0, 90), want, got: findLeadDuty(text)?.phrase ?? null }));
  if (wrong.length === 0) pass(`${cases.length} lead excerpts read correctly (explicit team lead vs mentoring / projects / cross-team / negated)`);
  else fail(`lead misread: ${JSON.stringify(wrong, null, 1)}`);
}

// 5b. Adversarial corpus: synthetic JDs written to break the filter in both
// directions (non-experience figures, preference wording, degree ladders,
// other people's teams, flattened bullets, HTML artifacts). Every case must hold.
{
  const { cases } = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/level-jd-cases.json'), 'utf-8'));
  const lf = buildLevelFilter(CFG);
  const verdict = (c) => (lf.assess(c.title, c.text).drop ? 'drop' : 'keep');
  // A known_miss is a deliberate stage-1 gap and may only be a missed drop.
  const badKnown = cases.filter((c) => c.known_miss && c.expected !== 'drop');
  const wrong = cases.filter((c) => !c.known_miss && verdict(c) !== c.expected)
    .map((c) => `${c.expected.toUpperCase()} expected: ${c.title} — ${c.why}`);
  const known = cases.filter((c) => c.known_miss).length;
  const drops = cases.filter((c) => c.expected === 'drop').length;
  if (wrong.length === 0 && badKnown.length === 0) {
    pass(`${cases.length - known} adversarial JDs judged correctly (${drops} drop, ${cases.length - drops} keep; ${known} known stage-2 miss)`);
  } else {
    fail(`${wrong.length}/${cases.length} adversarial JDs misjudged${badKnown.length ? `, ${badKnown.length} known_miss not a drop` : ''}:\n    ${wrong.join('\n    ')}`);
  }
}

// 6. The conjunction, end to end through assess()
{
  const lf = buildLevelFilter(CFG);
  const drop8 = lf.assess('Staff Security Engineer', jd('Minimum qualifications: 8 years of experience in security engineering.'));
  const keep7 = lf.assess('Staff+ Application Security Engineer', jd('Requirements: strong AppSec skills. Preferred qualifications: 7+ years in application security.'));
  const dropLead = lf.assess('Principal Security Engineer', jd('Requirements: 5+ years of experience. You will manage a team of 6 engineers.'));
  const keep6 = lf.assess('Staff Product Security Engineer, PSIRT', jd('What you bring: 6+ years of experience in information security. Mentor junior engineers.'));
  if (drop8.drop && /8\+ yrs/.test(drop8.reason)) pass('Staff title + required 8 yrs → drop, reason quotes the JD');
  else fail(`8-yr verdict: ${JSON.stringify(drop8)}`);
  if (!keep7.drop && /no team-lead duty/.test(keep7.note)) pass('Staff title + years only preferred, no lead → keep with a level-check note');
  else fail(`preferred-only verdict: ${JSON.stringify(keep7)}`);
  if (dropLead.drop && /team lead/.test(dropLead.reason)) pass('Principal title + 5 yrs but manages a team → drop');
  else fail(`lead verdict: ${JSON.stringify(dropLead)}`);
  if (!keep6.drop && /requires 6 yrs/.test(keep6.note)) pass('Staff title + 6 yrs + mentoring only → keep, note records the 6 yrs');
  else fail(`6-yr verdict: ${JSON.stringify(keep6)}`);
  const lf10 = buildLevelFilter({ ...CFG, min_years: 10 });
  if (!lf10.assess('Staff Security Engineer', jd('Requirements: 8+ years of experience in security.')).drop) pass('min_years raises the bar (8 yrs kept at min_years 10)');
  else fail('min_years ignored');
}

// 7. check(): fetches the JD only for a gated title whose listing has none
{
  const lf = buildLevelFilter(CFG, {
    fetchJd: async (url) => (url.endsWith('/big') ? jd('Minimum qualifications: 10+ years of experience in security.') : null),
  });
  let calls = 0;
  const counting = buildLevelFilter(CFG, { fetchJd: async () => { calls++; return null; } });
  const fetchedDrop = await lf.check({ title: 'Staff Security Engineer', url: 'https://x.example/big' });
  const failedFetch = await lf.check({ title: 'Staff Security Engineer', url: 'https://x.example/none' });
  await counting.check({ title: 'Security Engineer', url: 'https://x.example/a' });
  await counting.check({ title: 'Staff Security Engineer', url: 'https://x.example/b', description: jd('Requirements: 5 years of experience.') });
  const off = buildLevelFilter({ ...CFG, fetch_jd: false }, { fetchJd: async () => { calls++; return jd('10+ years of experience.'); } });
  const offVerdict = await off.check({ title: 'Staff Security Engineer', url: 'https://x.example/c' });
  if (fetchedDrop.drop && fetchedDrop.fetched) pass('check() fetches a missing JD and judges it');
  else fail(`fetched verdict: ${JSON.stringify(fetchedDrop)}`);
  if (!failedFetch.drop && /no JD text/.test(failedFetch.note)) pass('a failed fetch keeps the posting with a no-JD note');
  else fail(`failed-fetch verdict: ${JSON.stringify(failedFetch)}`);
  if (calls === 0 && !offVerdict.drop) pass('no fetch for an ungated title, a listing that has its JD, or fetch_jd: false');
  else fail(`unexpected fetches: ${calls}`);
}

// 8. lib/jd-text.mjs
{
  const url = smartRecruitersDetailUrl('https://jobs.smartrecruiters.com/servicenow/744000151377000-principal-ai-security-engineer');
  if (url === 'https://api.smartrecruiters.com/v1/companies/servicenow/postings/744000151377000'
      && smartRecruitersDetailUrl('https://example.com/servicenow/1') === null) {
    pass('SmartRecruiters posting URL maps to its detail API; other hosts do not');
  } else {
    fail(`smartRecruitersDetailUrl: ${url}`);
  }
  const text = smartRecruitersJobText({ jobAd: { sections: {
    companyDescription: { text: '<p>' + 'Company blurb. '.repeat(400) + '</p>' },
    jobDescription: { text: '<p>Build fuzzers.</p>' },
    qualifications: { text: '<ul><li>10+ years of experience</li></ul>' },
  } } });
  if (/Build fuzzers/.test(text) && /10\+ years/.test(text) && !/Company blurb/.test(text)) {
    pass('SmartRecruiters JD text is the job sections, without the company blurb that used to crowd them out');
  } else {
    fail(`smartRecruitersJobText: ${text.slice(0, 120)}`);
  }
  const seen = [];
  const fake = async (u) => { seen.push(u); return { ok: true, json: async () => ({ jobAd: { sections: { qualifications: { text: '8+ years' } } } }) }; };
  const got = await fetchJobDescription('https://jobs.smartrecruiters.com/acme/123-x', { fetchImpl: fake });
  const none = await fetchJobDescription('https://jobs.example.com/levels/7');
  if (got === '8+ years' && seen.length === 1 && none === null) pass('fetchJobDescription: SmartRecruiters via its API, unknown hosts → null without a request');
  else fail(`fetchJobDescription: ${JSON.stringify({ got, seen, none })}`);

  const liApi = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4431980866';
  if (linkedInDetailUrl('https://www.linkedin.com/jobs/view/4431980866') === liApi
      && linkedInDetailUrl('https://www.linkedin.com/jobs/view/staff-offensive-security-engineer-at-robinhood-4431980866/?trk=x') === liApi
      && linkedInDetailUrl('https://example.com/jobs/view/4431980866') === null) {
    pass('LinkedIn job-view URLs (bare id or slug-id) map to the public guest posting endpoint');
  } else {
    fail('linkedInDetailUrl mapping wrong');
  }
  const page = '<section><div class="show-more-less-html__markup relative overflow-hidden"><strong>What You Bring</strong>'
    + '<ul><li>8+ years of experience conducting red team operations</li></ul></div><div class="other">sidebar</div></section>';
  const liSeen = [];
  const liFake = async (u) => { liSeen.push(u); return { ok: true, text: async () => page }; };
  const liText = await fetchJobDescription('https://www.linkedin.com/jobs/view/4431980866', { fetchImpl: liFake });
  if (/8\+ years of experience conducting red team/.test(linkedInJobText(page)) && !/sidebar/.test(liText ?? 'sidebar')
      && liSeen[0] === liApi) {
    pass('LinkedIn JD text is the posting markup only, fetched from the guest endpoint');
  } else {
    fail(`LinkedIn JD text: ${JSON.stringify({ liText, liSeen })}`);
  }
}

// 9. scan-ats-full.mjs makeLevelGate: drops, notes, counts
{
  const gate = makeLevelGate(buildLevelFilter(CFG));
  const dropJob = { title: 'Staff Security Engineer', company: 'A', description: jd('Requirements: 9+ years of experience.') };
  const keepJob = { title: 'Staff Security Engineer', company: 'B', description: jd('Requirements: 4+ years of experience.') };
  const a = await gate.admit(dropJob);
  const b = await gate.admit(keepJob);
  const open = makeLevelGate(null);
  if (!a && b && gate.dropped.length === 1 && /level-check/.test(keepJob.note) && await open.admit(dropJob)) {
    pass('reverse-scan gate drops on JD evidence, notes kept Staff+ jobs, and is a no-op when disabled');
  } else {
    fail(`gate: ${JSON.stringify({ a, b, dropped: gate.dropped, note: keepJob.note })}`);
  }
}

// 10. END-TO-END: real scan.mjs over a fixture board (local parser, no network)
{
  const dir = mkdtempSync(join(tmpdir(), 'scan-level-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`);
    writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n');
    writeFileSync(join(dir, 'portals.yml'), `title_filter:
  positive:
    - "Security Engineer"
level_filter:
  enabled: true
  min_years: 8
  block: ${JSON.stringify(CFG.block)}
  exempt: ${JSON.stringify(CFG.exempt)}
tracked_companies:
  - name: Level Co
    parser:
      command: node
      script: tests/fixtures/level-board.mjs
`);
    const stdout = execFileSync(NODE, [join(ROOT, 'scan.mjs')], {
      cwd: dir,
      // CAREER_OPS_ROOT, not cwd, anchors data/ (path-resolver.mjs): without it
      // this run would write into the real data/pipeline.md.
      env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: join(dir, 'portals.yml') },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const p = join(dir, 'data', 'pipeline.md');
    const lines = existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(l => l.startsWith('- [ ] ')) : [];
    const titles = lines.map(l => l.split(' | ')[2]);
    const want = ['Principal Security Engineer', 'Member of Technical Staff, Security Engineer',
      'Senior/Staff Security Engineer', 'Security Engineer', 'Staff Product Security Engineer'];
    if (titles.length === want.length && want.every(t => titles.includes(t))) {
      pass('only Staff+ titles whose JD requires 8+ yrs or a team lead are dropped; the rest reach the pipeline');
    } else {
      fail(`pipeline titles: ${JSON.stringify(titles)}`);
    }
    const principal = lines.find(l => l.includes('| Principal Security Engineer'));
    const unread = lines.find(l => l.includes('| Staff Product Security Engineer'));
    if (principal && /level-check: Staff\+ title, JD requires 5 yrs/.test(principal)
        && unread && /level-check: Staff\+ title, no JD text/.test(unread)) {
      pass('kept Staff+ rows carry a level-check note for stage 2');
    } else {
      fail(`notes: ${JSON.stringify({ principal, unread })}`);
    }
    if (/Filtered by level:\s+2 removed/.test(stdout)
        && /- Level Co \| Staff Security Engineer \| https:\/\/jobs\.example\.com\/levels\/1 — requires 8\+ yrs/.test(stdout)
        && /- Level Co \| Staff Security Engineer, Platform \| https:\/\/jobs\.example\.com\/levels\/6 — team lead/.test(stdout)) {
      pass('summary counts the level drops and lists each with its URL and JD evidence');
    } else {
      fail(`summary: ${stdout.split('\n').filter(l => /level|Level Co/i.test(l)).join(' | ')}`);
    }
  } catch (err) {
    fail(`e2e level scan failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

