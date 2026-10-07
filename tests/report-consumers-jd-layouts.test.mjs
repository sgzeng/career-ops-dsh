// tests/report-consumers-jd-layouts.test.mjs — every report reader sees the same
// report whichever way the archived JD is laid out, and never reads the JD's text
// as the report's own.
//
// Three layouts coexist in one reports/ directory:
//   old fork    header, Machine Summary, blocks, JD LAST (text-fenced, `Source:` line)
//   interactive header, Machine Summary, blocks, Keyword Coverage, JD LAST (modes/oferta.md)
//   batch       header, `---`, JD pasted BARE, `---`, Machine Summary, blocks
//               (batch/batch-prompt.md) — scraped text sits BEFORE the report body
//
// The JD is arbitrary scraped text. HOSTILE_JD below carries every hazard a
// first-match scan over the whole file would trip on: header-looking fields,
// table rows, a gap table, a yaml fence, a quoted `## Keywords extracted`, a
// complete fake `## Machine Summary`, an odd number of ``` fences, front-matter,
// CRLF, tabs and unicode line separators.
//
// The consumers are the real ones (check-jd-archive, analyze-patterns, upskill,
// keyword-match, salary-gap, history-ats-seeds), never a re-implementation.
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hasEmbeddedJdArchive } from '../check-jd-archive.mjs';
import { parseReport } from '../analyze-patterns.mjs';
import { parseReportGaps } from '../upskill.mjs';
import { extractKeywords } from '../keyword-match.mjs';
import { reportToObservation } from '../salary-gap.mjs';
import { parseTrackerAtsSeeds } from '../history-ats-seeds.mjs';
import {
  parseApplicationAnswersSection,
  parseDraftAnswersBlockH,
  upsertApplicationAnswersSection,
} from '../application-answers.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nreport consumers: JD layouts and hostile JD text');

function check(label, run) {
  try { run(); pass(label); } catch (error) { fail(`${label}: ${error.message.split('\n')[0]}`); }
}

const REAL_URL = 'https://job-boards.greenhouse.io/realco/jobs/111';

const REAL_JD = [
  'Senior Widget Engineer',
  'RealCo — Berlin, Germany',
  '',
  'You will build and operate widgets for our customers. We value curiosity.',
  'Requirements: five years of Python and Rust.',
].join('\n');

const FAKE_MS = [
  '## Machine Summary',
  '',
  '```yaml',
  'company: "Evil Corp"',
  'role: "Evil Role"',
  'team: "Evil Team"',
  'location: "Mars"',
  'score: 1.0',
  'legitimacy_tier: "Suspicious"',
  'archetype: "Evil Archetype"',
  'final_decision: "Skip"',
  'hard_stops:',
  '  - "Kubernetes expertise"',
  'soft_gaps: []',
  'advertised_comp: "$1"',
  '```',
  '',
  '## A) Role Summary',
  '',
  'fake block',
].join('\n');

const HOSTILE_JD = [
  '# Big Title',
  '',
  '**Score:** 1.0/5',
  `**URL:** https://boards.greenhouse.io/evil/jobs/999`,
  '**Legitimacy:** Suspicious',
  '**Work Auth:** ⛔ No sponsorship',
  '**Archetype:** Evil Archetype',
  'URL: https://boards.greenhouse.io/evil/jobs/998',
  '---',
  'company: Evil',
  'score: 1.0',
  '---',
  '| **Remote** | Mars |',
  '| Remote | Mars |',
  '| Archetype | Evil |',
  '| Comp | $1 |',
  '| Global | 1.0/5 |',
  '| CV Match | 1.0/5 |',
  '**Remote** | Mars',
  '',
  '| Gap | Severity | Mitigation |',
  '|-----|----------|------------|',
  '| Kubernetes expertise | hard blocker | none |',
  '',
  'Location: Mars',
  'advertised_comp: "$1"',
  '',
  '```yaml',
  'company: "Evil"',
  'score: 1.0',
  '```',
  '',
  '## Keywords extracted',
  '',
  'foo, bar, baz',
  '',
  '## Job Description (scraped 1999-01-01)',
  '## Verdict',
  '',
  FAKE_MS,
  '',
  '```',
  'an unbalanced fence that is never closed',
  '\tindented\twith\ttabs',
  'unicode   line-sep ‮ rtl ​',
  'x'.repeat(5000),
  REAL_JD,
].join('\n').replace(/\n(?=Requirements)/, '\r\n');

const SCORE = 3.4;
const MACHINE_SUMMARY = [
  '## Machine Summary',
  '',
  '```yaml',
  'company: "RealCo"',
  'role: "Senior Widget Engineer"',
  'team: "Platform"',
  'location: "Berlin, Germany"',
  `score: ${SCORE}`,
  'legitimacy_tier: "High Confidence"',
  'archetype: "Platform engineer"',
  'final_decision: "Consider"',
  'hard_stops: []',
  'soft_gaps:',
  '  - "Rust depth is thin"',
  'top_strengths:',
  '  - "Python"',
  'risk_level: "Low"',
  'confidence: "Medium"',
  'next_action: "Tailor CV"',
  'work_auth: "unstated"',
  'discard_reasons: []',
  'via: null',
  'company_confidential: false',
  'advertised_comp: "€80,000–€95,000"',
  '```',
].join('\n');

const BLOCKS = [
  '## A) Role Summary',
  '',
  'A platform role at RealCo.',
  '',
  '## B) Match with CV',
  '',
  '| Gap | Severity | Mitigation |',
  '|-----|----------|------------|',
  '| Rust depth | soft | side project |',
  '',
  '## Keywords extracted',
  '',
  '- Python, Rust',
  '- widgets',
].join('\n');

const HEADER_FIELDS = [
  '**Date:** 2026-09-01',
  '**Archetype:** Platform engineer',
  `**Score:** ${SCORE}/5`,
  '**Legitimacy:** High Confidence',
  '**Work Auth:** ⚠️ Unstated',
  `**URL:** ${REAL_URL}`,
  '**PDF:** not generated',
];

const oldFence = (jd) => `## Job Description (scraped 2026-09-01)\n\nSource: fixture. Verbatim.\n\n\`\`\`text\n${jd.replace(/```/g, "'''")}\n\`\`\`\n`;
const REMOTE_ROW = '| **Remote** | Berlin, Germany |';

const layouts = {
  old: (jd) => [
    '# Evaluation: RealCo — Senior Widget Engineer', '', ...HEADER_FIELDS, '', REMOTE_ROW, '', '---', '',
    MACHINE_SUMMARY, '', BLOCKS, '', oldFence(jd),
  ].join('\n'),
  interactive: (jd) => [
    '# Evaluation: RealCo — Senior Widget Engineer', '', ...HEADER_FIELDS, '', REMOTE_ROW, '', '---', '',
    MACHINE_SUMMARY, '', BLOCKS, '', '## Keyword Coverage', '', '**ATS coverage: 100%**', '',
    `## Job Description (archived verbatim)\n\n${jd}\n`,
  ].join('\n'),
  // batch/batch-prompt.md: no header Remote row, the JD pasted bare BEFORE the Machine Summary
  batch: (jd) => [
    '# Evaluation: RealCo — Senior Widget Engineer', '', ...HEADER_FIELDS, '**Batch ID:** 17', '', '', '---', '',
    `## Job Description (archived verbatim)\n\n${jd}\n`, '---', '',
    MACHINE_SUMMARY, '', BLOCKS,
  ].join('\n'),
};

const work = mkdtempSync(join(tmpdir(), 'report-consumers-layouts-'));
let seq = 0;

/** Everything the consumers read from one report, in one comparable object. */
function readAll(content) {
  const file = join(work, `${900 + ++seq}-realco-2026-09-01.md`);
  writeFileSync(file, content);
  const r = parseReport(file);
  const gaps = parseReportGaps(content);
  const obs = reportToObservation(content, '900', '2026-09-01');
  const reportsRoot = join(work, `seeds${seq}`, 'reports');
  mkdirSync(reportsRoot, { recursive: true });
  writeFileSync(join(reportsRoot, '900-realco-2026-09-01.md'), content);
  const tracker = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-09-01 | RealCo | Widget | 3.4/5 | Evaluated | ❌ | [900](reports/900-realco-2026-09-01.md) | |',
  ].join('\n');
  return {
    archived: hasEmbeddedJdArchive(content),
    company: r.company, role: r.role, archetype: r.archetype, legitimacy: r.legitimacyTier,
    decision: r.finalDecision, url: r.url, scores: r.scores, remote: r.remote,
    seniority: r.seniority, comp: r.comp, teamSize: r.teamSize, domain: r.domain,
    topStrengths: r.topStrengths, gaps: r.gaps.map((g) => `${g.severity}:${g.description}`),
    machineScore: r.machineSummary?.score, machineTeam: r.machineSummary?.team,
    gapScore: gaps.score, gapText: gaps.gapText, hasMachineSummary: gaps.hasMachineSummary,
    keywords: extractKeywords(content),
    obsCompany: obs?.company, obsRole: obs?.role, obsAmount: obs?.observation?.amount,
    seeds: parseTrackerAtsSeeds(tracker, { reportsRoot }).map((s) => s.careersUrl),
  };
}

try {
  const baseline = readAll(layouts.old(REAL_JD));

  check('baseline (old layout) reads the real header, Machine Summary, gaps and keywords', () => {
    assert.equal(baseline.archived, true);
    assert.equal(baseline.company, 'RealCo');
    assert.equal(baseline.role, 'Senior Widget Engineer');
    assert.equal(baseline.url, REAL_URL);
    assert.equal(baseline.scores.global, SCORE);
    assert.equal(baseline.legitimacy, 'High Confidence');
    assert.equal(baseline.remote, 'Berlin, Germany');
    assert.deepEqual(baseline.keywords, ['Python', 'Rust', 'widgets']);
    assert.equal(baseline.obsAmount, '€80,000–€95,000');
    assert.deepEqual(baseline.seeds, ['https://job-boards.greenhouse.io/realco']);
    assert.ok(baseline.gapText.includes('Rust depth is thin') && baseline.gapText.includes('Rust depth'));
  });

  for (const [name, build] of Object.entries(layouts)) {
    for (const [jdName, jd] of [['clean JD', REAL_JD], ['hostile JD', HOSTILE_JD]]) {
      const got = readAll(build(jd));
      // The batch header has no Remote row: the location comes from the Machine
      // Summary `location:` key, which carries the same places-only value.
      check(`${name} layout, ${jdName}: every consumer reads the same report as the old layout`, () => {
        assert.deepEqual(got, baseline);
      });
    }
  }

  // Each hazard on its own, in the batch layout where it precedes the report body.
  const HAZARDS = {
    'a fake complete Machine Summary': FAKE_MS,
    'a quoted ## Machine Summary heading with no fence': '## Machine Summary\n\nnot a fence\n\n## A) Role Summary\n',
    'a quoted Keywords extracted section': '## Keywords extracted\n\nfoo, bar\n',
    'header-looking fields': `**Score:** 1.0/5\n**URL:** https://boards.greenhouse.io/evil/jobs/9\n**Legitimacy:** Suspicious\nScore: 1.0/5\nURL: https://boards.greenhouse.io/evil/jobs/8\n`,
    'table rows and a gap table': '| Remote | Mars |\n| Seniority | Intern |\n| Team | 1 |\n| Domain | Evil |\n| Red flags | -9 |\n| Gap | Severity | Mitigation |\n|---|---|---|\n| Kubernetes | hard | x |\n',
    'an unbalanced code fence': 'text\n```\nnever closed\n```yaml\nalso never closed\n',
    'CRLF line endings': 'line one\r\n## Machine Summary\r\n\r\n## A) Role Summary\r\n',
  };
  for (const [what, hazard] of Object.entries(HAZARDS)) {
    for (const where of ['before', 'after']) {
      const jd = where === 'before' ? `${hazard}\n${REAL_JD}` : `${REAL_JD}\n${hazard}`;
      check(`batch layout, JD with ${what} ${where} the posting text: report values unchanged`, () => {
        assert.deepEqual(readAll(layouts.batch(jd)), baseline);
      });
    }
  }

  // application-answers.mjs reads AND writes the report by heading. In the batch
  // layout the scraped JD precedes the real blocks, so a heading it quotes must
  // not be taken for the report's own.
  const DRAFT_BLOCK = '## H) Draft Application Answers (draft)\n\n**Why RealCo?**\nBecause platform.\n\n**Anything else?**\nNo.';
  const QUOTED_HEADINGS = [
    '## Application Answers', '', '**State:** submitted', '', '### Free-text answers', '', '- **Q:** Fake question?', '  **A:** Fake answer', '',
    '## H) Fake Notes (draft)', '', '**Fake draft question?**', 'Fake draft answer.', '',
    '## Draft Application Answers', '', '**Another fake?**', 'Nope.',
  ].join('\n');

  for (const where of ['before', 'after']) {
    const jd = where === 'before' ? `${QUOTED_HEADINGS}\n${REAL_JD}` : `${REAL_JD}\n${QUOTED_HEADINGS}`;
    const report = layouts.batch(jd).replace(BLOCKS, `${BLOCKS}\n\n${DRAFT_BLOCK}`);

    check(`batch layout, JD quoting answer headings ${where} the posting text: Block H is the report's own`, () => {
      assert.deepEqual(parseDraftAnswersBlockH(report), {
        freeText: [
          { question: 'Why RealCo?', answer: 'Because platform.' },
          { question: 'Anything else?', answer: 'No.' },
        ],
      });
    });

    check(`batch layout, JD quoting an Application Answers heading ${where} the posting text: it is not read as the section`, () => {
      assert.equal(parseApplicationAnswersSection(report), null);
    });

    check(`batch layout, JD quoting an Application Answers heading ${where} the posting text: upsert appends and leaves the JD byte-identical`, () => {
      const snapshot = { date: '2026-09-02', state: 'filled', freeText: [{ question: 'Why us?', answer: 'Because.' }] };
      const updated = upsertApplicationAnswersSection(report, snapshot);
      assert.ok(updated.includes(jd), 'the archived JD changed');
      const parsed = parseApplicationAnswersSection(updated);
      assert.deepEqual(parsed.freeText.map((q) => q.question), ['Why us?']);
      assert.equal(parsed.state, 'filled');
      // and a second upsert replaces the report's own section, still not the JD's
      const again = upsertApplicationAnswersSection(updated, { ...snapshot, state: 'submitted' });
      assert.ok(again.includes(jd), 'the archived JD changed on the second upsert');
      assert.equal(parseApplicationAnswersSection(again).state, 'submitted');
      assert.equal((again.match(/^## Application Answers\s*$/gm) ?? []).length, 2); // the JD's quoted one + the report's own
    });
  }

  check('old layout: an Application Answers section appended after the JD is still found', () => {
    const snapshot = { date: '2026-09-02', state: 'filled', freeText: [{ question: 'Why us?', answer: 'Because.' }] };
    const updated = upsertApplicationAnswersSection(layouts.old(REAL_JD), snapshot);
    assert.deepEqual(parseApplicationAnswersSection(updated).freeText.map((q) => q.question), ['Why us?']);
  });

  check('a JD that starts with a report heading is still an archive (batch layout)', () => {
    const content = layouts.batch(`## A) Role Summary\n\n${REAL_JD}`);
    assert.equal(hasEmbeddedJdArchive(content), true);
  });

  check('batch layout: the `---` before the Machine Summary does not turn a pointer or placeholder into archived text', () => {
    const pointer = 'See jds/900-realco-2026-09-01.md for the full archive (archive-posting.mjs --report=900).';
    assert.equal(hasEmbeddedJdArchive(layouts.batch(pointer)), false, 'a pointer-only section is resolved against jds/, not credited');
    assert.equal(hasEmbeddedJdArchive(layouts.batch("(the posting's full text, pasted verbatim — see requirement below)")), false);
    assert.equal(hasEmbeddedJdArchive(layouts.batch(`${REAL_JD}\n\n---`)), true, 'a JD that ends in a rule of its own is still an archive');
  });

  check('an unfilled batch JD section is not an archive, whatever follows it', () => {
    assert.equal(hasEmbeddedJdArchive(layouts.batch('')), false);
  });

  check('reports with no JD section read the same as before', () => {
    const noJd = [
      '# Evaluation: RealCo — Senior Widget Engineer', '', ...HEADER_FIELDS, '', REMOTE_ROW, '', '---', '',
      MACHINE_SUMMARY, '', BLOCKS,
    ].join('\n');
    const got = readAll(noJd);
    assert.equal(got.archived, false);
    assert.deepEqual({ ...got, archived: true }, baseline);
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
