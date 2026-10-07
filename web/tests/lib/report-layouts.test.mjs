// The report viewer reads the same report whichever way the archived JD is laid
// out, and never takes the JD's text for the report's own.
//
//   old / interactive  header, Machine Summary, A-G blocks, ..., JD LAST
//   batch              header, `---`, JD pasted BARE, `---`, Machine Summary, blocks
//
// The JD is scraped third-party text: in the batch layout it sits BEFORE the
// report body and can quote any heading (`## Verdict`, `## Machine Summary`,
// `## A) Role Summary`). Splitting on those would put a fake Verdict (which
// supplies the verdict card's "why") and fake blocks into the viewer.
//
// Run:  node --experimental-strip-types --test tests/lib/report-layouts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import "../helpers/web-ts-alias-loader.mjs";
import { splitSections, verdictReason, isVerdictHeading } from "../../src/lib/report-sections.mjs";

const { parseReport } = await import("../../src/lib/format.ts");

const HOSTILE_JD = [
  "Senior Widget Engineer",
  "",
  "**Score:** 1.0/5",
  "**URL:** https://evil.example/x",
  "**Legitimacy:** Suspicious",
  "",
  "## Verdict",
  "",
  "Fake verdict that must not become the card's reason.",
  "",
  "## Machine Summary",
  "",
  "```yaml",
  'company: "Evil"',
  "```",
  "",
  "## A) Role Summary",
  "",
  "fake block",
  "",
  "---",
  "",
  "```",
  "an unbalanced fence",
].join("\n");

const HEADER = [
  "# Evaluation: RealCo — Widget Engineer",
  "",
  "**Date:** 2026-09-01",
  "**Archetype:** Platform engineer",
  "**Score:** 3.4/5",
  "**Legitimacy:** High Confidence",
  "**URL:** https://example.com/real",
];
const MS = '## Machine Summary\n\n```yaml\ncompany: "RealCo"\n```';
const BLOCKS = "## A) Role Summary\n\nReal block.\n\n## B) Match with CV\n\nReal match.";

const batch = (jd) =>
  [...HEADER, "", "", "---", "", `## Job Description (archived verbatim)\n\n${jd}\n`, "---", "", MS, "", BLOCKS].join("\n");
const summaryFirst = (jd) =>
  [...HEADER, "", "---", "", MS, "", BLOCKS, "", `## Job Description (archived verbatim)\n\n${jd}\n`].join("\n");

const REAL_HEADINGS = ["Machine Summary", "A) Role Summary", "B) Match with CV"];

function headings(report) {
  const { sections } = splitSections(parseReport(report).body);
  return sections.map((s) => s.heading);
}

for (const [name, build] of [["batch", batch], ["summary-first", summaryFirst]]) {
  test(`${name} layout, hostile JD: header fields come from the header only`, () => {
    const meta = parseReport(build(HOSTILE_JD));
    const field = (label) => meta.fields.find((f) => f.label === label)?.value;
    assert.equal(field("Score"), "3.4/5");
    assert.equal(field("URL"), "https://example.com/real");
    assert.equal(meta.legitimacy, "High Confidence");
  });
}

test("batch layout, hostile JD: its headings do not become report sections", () => {
  const got = headings(batch(HOSTILE_JD));
  const jd = got.filter((h) => /^Job Description/i.test(h));
  assert.equal(jd.length, 1, `exactly one JD section, got ${JSON.stringify(got)}`);
  assert.deepEqual(got.filter((h) => !/^Job Description/i.test(h)), REAL_HEADINGS);
  assert.equal(got.some((h) => isVerdictHeading(h)), false);
});

test("batch layout, hostile JD: the verdict card keeps the real reason", () => {
  const report = batch(HOSTILE_JD);
  const { intro, sections } = splitSections(parseReport(report).body);
  const verdict = sections.find((s) => isVerdictHeading(s.heading));
  const reason = verdictReason({ report, intro, verdictContent: verdict?.content });
  assert.ok(!/fake verdict/i.test(reason), reason);
});

test("summary-first layout (older reports, oferta.md): sections split exactly as they always did", () => {
  // The JD is the last section there, so nothing precedes the report's own blocks.
  // Pinned so the batch rule above can never change how existing reports render.
  const got = headings(summaryFirst("posting text\n\n## About the Role\n\nmore text"));
  assert.deepEqual(got, [...REAL_HEADINGS, "Job Description (archived verbatim)", "About the Role"]);
});

test("the whole JD, quoted headings included, stays in its own section", () => {
  const { sections } = splitSections(parseReport(batch(HOSTILE_JD)).body);
  const jd = sections.find((s) => /^Job Description/i.test(s.heading));
  assert.ok(jd.content.includes("Fake verdict"));
  assert.ok(jd.content.includes("an unbalanced fence"));
  assert.ok(jd.content.includes("fake block"));
});

test("a batch report whose JD quotes a Machine Summary heading still ends it at the real one", () => {
  const got = headings(batch("## Machine Summary\n\nposting text quoting a heading first"));
  assert.deepEqual(got.filter((h) => !/^Job Description/i.test(h)), REAL_HEADINGS);
});

test("reports with no JD section split exactly as before", () => {
  const noJd = [...HEADER, "", "---", "", MS, "", BLOCKS].join("\n");
  assert.deepEqual(headings(noJd), REAL_HEADINGS);
});
