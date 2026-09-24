// tests/content-rescue.test.mjs — lib/content-rescue.mjs and its scan.mjs hook.
//
// title_filter is a hard gate; content rescue lets a strong description keep a
// title miss ("Research Scientist, AI Secure Code" was dropped for saying
// "Secure" instead of "security"). Unit checks cover the evidence rule and the
// per-company boilerplate stripping; the last check runs the real scan.mjs over
// a fixture board so the hook's wiring (negative veto, note, counters) is observed.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { buildContentRescue } from '../lib/content-rescue.mjs';

console.log('\nscan.mjs — content rescue');

const CONTENT = {
  positive: ['fuzz', 'program analysis', 'reverse engineering', 'vulnerability research', 'exploit',
    'zero-day', 'ai agent', 'agentic', 'autonomous'],
};
const CFG = {
  enabled: true,
  thesis_words: ['fuzz', 'program analysis', 'reverse engineering', 'vulnerability research'],
  min_distinct: 2,
  min_distinct_no_thesis: 3,
  boilerplate_df_pct: 40,
  min_company_jobs: 5,
  min_description_chars: 100,
  title_require_any: ['engineer', 'scientist', 'research'],
};
const filler = ' Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.'.repeat(2);
const j = (title, body) => ({ title, description: body + filler });

// 1. Disabled / empty config → null (scan.mjs then behaves exactly as before)
{
  if (buildContentRescue(undefined, CONTENT) === null && buildContentRescue({ enabled: false }, CONTENT) === null
      && buildContentRescue({ enabled: 'yes' }, CONTENT) === null) {
    pass('absent, disabled, or non-boolean enabled → null');
  } else {
    fail('rescue must be off unless enabled: true');
  }
  if (buildContentRescue({ enabled: true }, {}) === null) pass('no keywords at all → null');
  else fail('rescue with no keywords should be null');
}

// 2. The evidence rule on a small company (no boilerplate stripping below 5 jobs)
{
  const secureCode = j('Research Scientist, AI Secure Code',
    'Experience with vulnerability research (e.g., auditing, reverse engineering, exploitation). Develop novel agentic techniques.');
  const agentOnly = j('AI Engineer', 'Build agentic, autonomous workflows.');
  const agentPlus = j('AI Engineer', 'Build agentic, autonomous workflows that find zero-day bugs.');
  const oneThesis = j('Software Engineer', 'Some fuzz testing experience is a plus.');
  const shortDesc = { title: 'Research Engineer', description: 'vulnerability research, fuzz' };
  const notEng = j('Account Director', 'Sell vulnerability research and fuzz tooling to enterprises.');
  const rescue = buildContentRescue(CFG, CONTENT).forCompany([secureCode, agentOnly, agentPlus, oneThesis]);

  const r = rescue.check(secureCode);
  if (r && r.thesis.includes('vulnerability research') && r.keywords.includes('agentic')) {
    pass('DeepMind "AI Secure Code" description is rescued (thesis word + ≥2 distinct)');
  } else {
    fail(`secure-code check = ${JSON.stringify(r)}`);
  }
  if (rescue.check(agentOnly) === null) pass('2 non-thesis keywords (agentic, autonomous) are not enough');
  else fail('agentic+autonomous alone should not rescue');
  if (rescue.check(agentPlus)) pass('3 distinct non-thesis keywords rescue (min_distinct_no_thesis)');
  else fail('3 distinct keywords should rescue');
  if (rescue.check(oneThesis) === null) pass('a lone thesis word ("fuzz") is not enough');
  else fail('a single keyword should not rescue');
  if (rescue.check(shortDesc) === null) pass('description under min_description_chars is not judged');
  else fail('short description should not rescue');
  if (rescue.check(notEng) === null) pass('title without a title_require_any word is not rescued');
  else fail('"Account Director" should not be rescued');
}

// 3. Per-company boilerplate: a keyword in ≥40% of a company's postings stops counting
{
  const bp = 'We train AI agent systems that find zero-day vulnerabilities.';
  const jobs = [
    j('Backend Engineer', `${bp} Build Go services.`),
    j('Frontend Engineer', `${bp} Build React.`),
    j('Data Engineer', `${bp} Own the warehouse.`),
    j('Platform Engineer', `${bp} Run Kubernetes.`),
    j('Research Engineer', `${bp} Fuzz harnesses and program analysis for agentic exploit generation.`),
    j('Solutions Engineer', `${bp} Demo the autonomous agentic product and its fuzz reports.`),
  ];
  const rescue = buildContentRescue(CFG, CONTENT).forCompany(jobs);
  if (rescue.check(jobs[0]) === null) pass('boilerplate-only posting (zero-day, ai agent in every JD) is not rescued');
  else fail(`boilerplate posting rescued: ${JSON.stringify(rescue.check(jobs[0]))}`);
  const research = rescue.check(jobs[4]);
  if (research && !research.keywords.includes('zero-day') && !research.keywords.includes('ai agent')
      && research.keywords.includes('program analysis')) {
    pass('on-topic posting is rescued on its own keywords, boilerplate stripped');
  } else {
    fail(`research check = ${JSON.stringify(research)}`);
  }
  const small = buildContentRescue(CFG, CONTENT).forCompany([jobs[4], jobs[0], jobs[1], jobs[2]]);
  const smallHit = small.check(jobs[4]);
  if (smallHit && smallHit.keywords.includes('zero-day') && smallHit.keywords.includes('ai agent')) {
    pass('fewer than min_company_jobs postings → no stripping (boilerplate keywords still count)');
  } else {
    fail(`4-job company check = ${JSON.stringify(smallHit)}`);
  }
  if (buildContentRescue({ ...CFG, skip_providers: ['local-parser'] }, CONTENT).forCompany(jobs, { providerId: 'local-parser' }) === null) {
    pass('skip_providers disables rescue for that provider');
  } else {
    fail('skip_providers ignored');
  }
}

// 3b. Review regressions (2026-09-23 adversarial review)
{
  // Word-start matching: loose substrings must not count as evidence.
  const precise = {
    ...CFG,
    thesis_words: ['word:fuzz', 'fuzzing', 'program analysis'],
    keywords: ['0-day', 'red team', 'word:autonomous', 'agentic'],
  };
  const r = buildContentRescue(precise, CONTENT).forCompany([]);
  const loose = j('Search Relevance Engineer',
    'Fuzzy matching over catalogs, working autonomously in an empowered team, 30-day pilots, agentic tools.');
  if (r.check(loose) === null) pass('"fuzzy", "autonomously", "30-day", "empowered team" are not evidence');
  else fail(`loose substrings rescued: ${JSON.stringify(r.check(loose))}`);
  const real = j('Research Engineer', 'Build fuzzing and program analysis for agentic 0-day discovery with the red team.');
  const hit = r.check(real);
  if (hit && ['fuzzing', 'program analysis', 'agentic', '0-day', 'red team'].every(k => hit.keywords.includes(k))) {
    pass('word-start matches still fire (fuzzing, 0-day, red team)');
  } else {
    fail(`real evidence = ${JSON.stringify(hit)}`);
  }
  const wordFuzz = r.check(j('Research Engineer', 'We fuzz parsers and apply program analysis.'));
  if (wordFuzz && wordFuzz.keywords.includes('fuzz') && !wordFuzz.keywords.some(k => k.includes(':'))) {
    pass('"word:fuzz" matches the bare word and reports the label without its prefix');
  } else {
    fail(`word:fuzz = ${JSON.stringify(wordFuzz)}`);
  }

  // Per-location copies of one role count once for boilerplate DF.
  const generic = ['Backend', 'Frontend', 'Data', 'Platform', 'Mobile', 'Infra'].map(t => j(`${t} Engineer`, 'Ship product features.'));
  const onTopic = () => j('Research Scientist, AI for Code', 'Vulnerability research, reverse engineering and fuzz testing with agentic tools.');
  const copies = [onTopic(), onTopic(), onTopic(), onTopic()];
  const multi = buildContentRescue(CFG, CONTENT).forCompany([...generic, ...copies]);
  if (multi.check(copies[0])) pass('a role listed in 4 locations is not stripped by its own copies');
  else fail('multi-location copies suppressed their own rescue');

  // Blank/zero settings never rescue a posting with no surviving evidence.
  const bp = 'We train AI agent systems that find zero-day vulnerabilities.';
  const allBp = ['A', 'B', 'C', 'D', 'E', 'F'].map(t => j(`${t} Engineer`, bp));
  const zero = buildContentRescue({ ...CFG, min_distinct_no_thesis: 0 }, CONTENT).forCompany(allBp);
  if (zero.check(allBp[0]) === null) pass('min_distinct_no_thesis: 0 cannot rescue a boilerplate-only posting');
  else fail('empty evidence was rescued with min_distinct_no_thesis: 0');
  const blank = buildContentRescue({ ...CFG, min_distinct_no_thesis: null, min_distinct: '' }, CONTENT)
    .forCompany([]).check(j('AI Engineer', 'Build agentic, autonomous workflows.'));
  if (blank === null) pass('blank YAML settings fall back to defaults, not 0');
  else fail(`blank settings rescued: ${JSON.stringify(blank)}`);

  // A bare-string list is a one-item list, not silently ignored.
  const bare = buildContentRescue({ ...CFG, title_require_any: 'scientist' }, CONTENT).forCompany([]);
  if (bare.check(j('Security Engineer', 'Vulnerability research and reverse engineering.')) === null) {
    pass('bare-string title_require_any is honored');
  } else {
    fail('bare-string title_require_any was ignored');
  }
}

// 4. END-TO-END: real scan.mjs over a fixture board (local parser, no network)
{
  const dir = mkdtempSync(join(tmpdir(), 'scan-rescue-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`);
    const portalsYml = (enabled) => `title_filter:
  positive:
    - "Security Engineer"
  negative:
    - "Manager"
content_filter:
  positive: ${JSON.stringify(CONTENT.positive)}
content_rescue:
  enabled: ${enabled}
  thesis_words: ${JSON.stringify(CFG.thesis_words)}
  min_distinct: 2
  min_distinct_no_thesis: 3
  boilerplate_df_pct: 40
  min_company_jobs: 5
  min_description_chars: 500
  title_require_any: ["engineer", "scientist", "research"]
tracked_companies:
  - name: Acme Security
    parser:
      command: node
      script: tests/fixtures/rescue-board.mjs
`;
    const run = (enabled) => {
      writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n');
      writeFileSync(join(dir, 'portals.yml'), portalsYml(enabled));
      const stdout = execFileSync(NODE, [join(ROOT, 'scan.mjs'), '--quiet'], {
        cwd: dir,
        // CAREER_OPS_ROOT, not cwd, anchors data/ (path-resolver.mjs): without it
        // this run would write into the real data/pipeline.md.
        env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: join(dir, 'portals.yml') },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const p = join(dir, 'data', 'pipeline.md');
      const lines = existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(l => l.startsWith('- [ ] ')) : [];
      rmSync(join(dir, 'data', 'scan-history.tsv'), { force: true });
      return { stdout, lines };
    };

    const off = run(false);
    if (off.lines.length === 1 && off.lines[0].includes('| Security Engineer')) {
      pass('rescue disabled: only the title-matching posting is added (pre-change behavior)');
    } else {
      fail(`rescue disabled lines: ${JSON.stringify(off.lines)}`);
    }

    const on = run(true);
    const rescued = on.lines.find(l => l.includes('Research Scientist, AI Secure Code'));
    if (rescued && /note: content-rescue: .*vulnerability research/.test(rescued)) {
      pass('rescue enabled: the title miss is added with a "content-rescue:" note');
    } else {
      fail(`rescue enabled lines: ${JSON.stringify(on.lines)}`);
    }
    if (!on.lines.some(l => l.includes('Manager'))) pass('title negative ("Manager") still vetoes a rescue');
    else fail('a Manager title was rescued');
    if (!on.lines.some(l => l.includes('Backend Engineer'))) pass('boilerplate-only posting stays filtered end to end');
    else fail('boilerplate-only Backend Engineer was rescued');
    if (/Content-rescued:\s+1 title misses kept on description evidence \(1 new\)/.test(on.stdout)) {
      pass('summary reports the rescue count');
    } else {
      fail(`summary line missing: ${on.stdout.split('\n').filter(l => /rescue/i.test(l)).join(' | ')}`);
    }
  } catch (err) {
    fail(`e2e rescue scan failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
