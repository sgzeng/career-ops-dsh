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

// 3. Per-company boilerplate: a sentence repeated across a company's postings stops counting
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
  // boilerplate: "keyword" = the pre-2026-09-27 rule: same verdicts here, with
  // zero-day / ai agent stripped by keyword DF instead of by their sentence.
  const legacy = buildContentRescue({ ...CFG, boilerplate: 'keyword' }, CONTENT).forCompany(jobs);
  if (legacy.check(jobs[0]) === null && JSON.stringify(legacy.check(jobs[4]))
      === JSON.stringify({ keywords: ['fuzz', 'program analysis', 'exploit', 'agentic'], thesis: ['fuzz', 'program analysis'] })) {
    pass('boilerplate: "keyword" reproduces the legacy result');
  } else {
    fail(`keyword mode = ${JSON.stringify(legacy.check(jobs[4]))}`);
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

// 3a. Sentence vs keyword boilerplate (2026-09-27). The keyword rule stripped a
// security startup's domain vocabulary: Cogent builds AI agents, so "ai agent",
// "agentic" and "autonomous" are in most of its JDs, each time in a sentence
// about that role. Only text repeated verbatim across postings is company copy.
{
  // depthfirst-shaped: an "About" block (paragraph + list, descriptionPlain
  // layout) pasted into every JD, whose last inline bullet shares a line with
  // the role's own bullets.
  const about = 'ABOUT DEPTHFIRST\n\nDepthfirst builds autonomous AI agent systems that find zero-day bugs. '
    + 'Our agentic platform already secures some of the most critical code in the world.\n\n'
    + 'Our team comes from:\n - Offensive security teams that exploit browsers and kernels\n'
    + ' - Research labs that publish on program analysis and fuzzing\n\n'
    + 'WHAT YOU\'LL DO • Ship code our AI agent customers depend on daily • ';
  const depthfirst = [
    j('Backend Engineer', `${about}Build Go services.`),
    j('Frontend Engineer', `${about}Build the React console.`),
    j('Data Engineer', `${about}Own the warehouse.`),
    j('Solutions Engineer', `${about}Run proofs of value.`),
    j('Research Engineer', `${about}Build fuzzing harnesses for parsers • Apply program analysis to Rust crates.`),
  ];
  const rescue = buildContentRescue(CFG, CONTENT).forCompany(depthfirst);
  if (rescue.check(depthfirst[0]) === null) {
    pass('a boilerplate "About" paragraph repeated across postings is not evidence (depthfirst)');
  } else {
    fail(`depthfirst boilerplate rescued: ${JSON.stringify(rescue.check(depthfirst[0]))}`);
  }
  const research = rescue.check(depthfirst[4]);
  if (research && JSON.stringify(research.keywords) === JSON.stringify(['fuzz', 'program analysis'])) {
    pass('role-specific bullets survive the cut; the About block\'s keywords do not');
  } else {
    fail(`depthfirst research check = ${JSON.stringify(research)}`);
  }
  // min_description_chars is judged on the posting as published: every posting
  // clears this floor, and what the cut leaves of the research one does not.
  const floor = Math.min(...depthfirst.map((p) => p.description.length));
  const uncut = buildContentRescue({ ...CFG, min_description_chars: floor }, CONTENT).forCompany(depthfirst).check(depthfirst[4]);
  if (uncut && uncut.keywords.includes('program analysis')) pass('min_description_chars is judged before the boilerplate cut');
  else fail(`judged on the cut text: ${JSON.stringify(uncut)}`);

  const about2 = 'Cogent is an applied research lab with offices in San Francisco and New York.\n\n';
  const cogent = [
    j('Software Engineer - Applied AI', `${about2}Ship the AI agent runtime that triages vulnerability findings. `
      + 'Design agentic planning loops over enterprise data. Make remediation autonomous, managed by exception.'),
    j('AI Research Engineer', `${about2}Train the AI agent models behind our taskforce. `
      + 'Evaluate agentic reasoning on long-horizon tasks. Study when an autonomous workflow should hand off.'),
    j('Forward Deployed Agent Engineer', `${about2}Deploy each AI agent into customer environments. `
      + 'Tune agentic workflows to a customer stack. Keep autonomous remediation within change policy.'),
    j('Software Engineer - Backend', `${about2}Build Go services and Postgres schemas.`),
    j('Software Engineer - Frontend', `${about2}Build the React console.`),
    j('Solutions Engineer', `${about2}Run proofs of value with prospects.`),
  ];
  const applied = buildContentRescue(CFG, CONTENT).forCompany(cogent).check(cogent[0]);
  if (applied && ['ai agent', 'agentic', 'autonomous'].every((k) => applied.keywords.includes(k))) {
    pass('a keyword in ≥40% of postings but in role-specific sentences still counts (Cogent)');
  } else {
    fail(`Cogent applied-AI check = ${JSON.stringify(applied)}`);
  }

  // boilerplate: "keyword" = the pre-2026-09-27 rule.
  const legacy = { ...CFG, boilerplate: 'keyword' };
  if (buildContentRescue(legacy, CONTENT).forCompany(cogent).check(cogent[0]) === null) {
    pass('boilerplate: "keyword" strips the same Cogent keywords as the legacy rule (no rescue)');
  } else {
    fail('keyword mode should strip ai agent / agentic / autonomous at 50% DF');
  }
  const legacyDf = buildContentRescue(legacy, CONTENT).forCompany(depthfirst).check(depthfirst[4]);
  if (legacyDf === null) pass('boilerplate: "keyword" also strips a thesis word the About block mentions (legacy)');
  else fail(`keyword mode kept depthfirst's About-block keywords: ${JSON.stringify(legacyDf)}`);

  // Fewer than min_company_jobs distinct postings → no stripping in either mode.
  const fewCogent = cogent.slice(0, 4);
  const fewDf = [depthfirst[4], ...depthfirst.slice(0, 3)];
  const smallModes = ['sentence', 'keyword'].map((mode) => {
    const cfg = { ...CFG, boilerplate: mode };
    const c = buildContentRescue(cfg, CONTENT).forCompany(fewCogent).check(fewCogent[0]);
    const d = buildContentRescue(cfg, CONTENT).forCompany(fewDf).check(fewDf[0]);
    return c?.keywords.includes('agentic') && d?.keywords.includes('zero-day') && d.keywords.includes('ai agent');
  });
  if (smallModes.every(Boolean)) pass('fewer than min_company_jobs postings → no stripping in sentence or keyword mode');
  else fail(`small-company stripping per mode (sentence, keyword) = ${JSON.stringify(smallModes)}`);

  // An unknown or blank mode is the sentence rule, not "no stripping" and not
  // keyword — including a YAML list that stringifies to "keyword".
  const unknown = [' Sentence ', 'paragraph', 42, '', null, ['keyword']].map((mode) => {
    const cfg = { ...CFG, boilerplate: mode };
    return buildContentRescue(cfg, CONTENT).forCompany(cogent).check(cogent[0]) !== null
      && buildContentRescue(cfg, CONTENT).forCompany(depthfirst).check(depthfirst[0]) === null;
  });
  if (unknown.every(Boolean)) pass('an unknown boilerplate value behaves like "sentence"');
  else fail(`unknown boilerplate values (sentence-like?) = ${JSON.stringify(unknown)}`);
  if (buildContentRescue({ ...CFG, boilerplate: ' KEYWORD ' }, CONTENT).forCompany(cogent).check(cogent[0]) === null) {
    pass('boilerplate: " KEYWORD " selects the legacy rule (trimmed, case-insensitive)');
  } else {
    fail('" KEYWORD " did not select keyword mode');
  }

  // A sentence in one posting is that posting's own, even at sentence_df_pct: 0.
  const allDf = buildContentRescue({ ...CFG, sentence_df_pct: 0 }, CONTENT).forCompany(depthfirst).check(depthfirst[4]);
  if (allDf && allDf.keywords.includes('program analysis')) {
    pass('a sentence seen in only one posting is never boilerplate (sentence_df_pct: 0)');
  } else {
    fail(`sentence_df_pct: 0 stripped a unique sentence: ${JSON.stringify(allDf)}`);
  }
}

// 3c. Sentence-rule details (2026-09-27 review). The sentence rule has its own
// cut-off, sentence_df_pct (default 25), below the keyword rule's 40: a company
// that rewords its About copy puts no single sentence in 40% of its JDs even
// though every JD carries some version of it. CFG's boilerplate_df_pct: 40
// must not leak into sentence mode.
{
  // XBOW-shaped (live board, 2026-09-27): 8 postings, About wording A in 3
  // (37.5%), wording B in exactly 2 (25%), one-off wordings in the rest.
  const aboutA = 'Build the future of offensive security with Xbow. '
    + 'Our AI-powered system autonomously discovers, validates, and even exploits vulnerabilities. '
    + 'Our AI has uncovered thousands of real-world zero-days across open source.\n\n';
  const aboutB = 'At Xbow we are building the first autonomous pentester, powered by an AI agent. '
    + 'Our mission is to exploit every bug before attackers do, with zero-day research at scale.\n\n';
  const once = (n) => `Xbow wording number ${n} appears in this one posting only.\n\n`;
  const xbow = [
    j('Software Engineer - AI Systems', `${aboutA}Build the services behind our product.`),
    j('Software Engineer - Platform - Americas', `${aboutA}Run our Kubernetes clusters.`),
    j('Software Engineer - Platform - EMEA', `${aboutA}Own the deploy pipeline end to end.`),
    j('Backend Engineer', `${aboutB}Build Go services and Postgres schemas.`),
    j('Frontend Engineer', `${aboutB}Build the React console.`),
    j('Data Engineer', `${once(1)}Own the warehouse.`),
    j('Solutions Engineer', `${once(2)}Run proofs of value.`),
    j('Sales Engineer', `${once(3)}Demo the product.`),
  ];
  const rescue = buildContentRescue(CFG, CONTENT).forCompany(xbow);
  const leaked = xbow.filter((p) => rescue.check(p)).map((p) => p.title);
  if (leaked.length === 0) {
    pass('reworded About copy (3 of 8 and exactly 2 of 8 JDs) is still boilerplate at sentence_df_pct 25 (XBOW)');
  } else {
    fail(`XBOW About copy rescued: ${JSON.stringify(leaked)}`);
  }
  const at40 = buildContentRescue({ ...CFG, sentence_df_pct: 40 }, CONTENT).forCompany(xbow);
  if (at40.check(xbow[0]) && at40.check(xbow[3])) pass('at sentence_df_pct: 40 the same About copy would count as evidence');
  else fail(`sentence_df_pct: 40 = ${JSON.stringify([at40.check(xbow[0]), at40.check(xbow[3])])}`);

  // A list item under 25 characters ("• Fuzzing") is not judged as a sentence:
  // short bullets repeat across a focused team's JDs and are the role's own.
  const research = ['Research Engineer', 'Research Scientist', 'Security Researcher', 'Fuzzing Engineer', 'Analysis Engineer']
    .map((t, i) => j(t, `Role ${i} builds tooling number ${i} for the team.\n• Fuzzing\n• Program analysis\nOwn project ${i} end to end.`));
  const bullets = buildContentRescue(CFG, CONTENT).forCompany(research).check(research[0]);
  if (bullets && JSON.stringify(bullets.keywords) === JSON.stringify(['fuzz', 'program analysis'])) {
    pass('short list items repeated in every posting still count as evidence');
  } else {
    fail(`short repeated bullets = ${JSON.stringify(bullets)}`);
  }

  // Sentences are compared lowercased with whitespace collapsed: an About line
  // retyped in capitals or with extra spaces/tabs is the same company copy.
  // (The spacing variant keeps "ai agent" intact so its keywords still match.)
  const line = 'Acme builds AI agent systems that find zero-day bugs.';
  const variants = [
    ...['A', 'B', 'C', 'D', 'E'].map((t) => j(`${t} Engineer`, `${line}\nBuild Go services.`)),
    j('Platform Engineer', `${line.toUpperCase()}\nThe exploit pipeline is yours to own.`),
    j('Research Engineer', `${line.replace('Acme builds', 'Acme   builds').replace('find ', 'find\t')}\nThe exploit pipeline is ours to own.`),
  ];
  const vr = buildContentRescue(CFG, CONTENT).forCompany(variants);
  if (vr.check(variants[5]) === null && vr.check(variants[6]) === null) {
    pass('an About line that differs only in case or spacing is still cut');
  } else {
    fail(`case/space variants = ${JSON.stringify([vr.check(variants[5]), vr.check(variants[6])])}`);
  }

  // Cutting a sentence keeps the separators around it, so the next one still
  // starts a word ("roadmap\nProgram analysis", not "roadmapProgram analysis").
  const about = 'Acme builds AI agent systems that find zero-day bugs in code.';
  const cutJobs = ['A', 'B', 'C', 'D'].map((t) => j(`${t} Engineer`, `${about}\nBuild Go services.`));
  cutJobs.push(j('Research Engineer', `Own the parser roadmap\n${about}\nProgram analysis of Rust crates • Fuzzing harnesses for parsers`));
  const joined = buildContentRescue(CFG, CONTENT).forCompany(cutJobs).check(cutJobs[4]);
  if (joined && JSON.stringify(joined.keywords) === JSON.stringify(['fuzz', 'program analysis'])) {
    pass('a keyword opening the sentence after a cut one still matches');
  } else {
    fail(`after-cut keywords = ${JSON.stringify(joined)}`);
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
