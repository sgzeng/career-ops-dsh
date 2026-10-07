#!/usr/bin/env node
/**
 * report-format.mjs — the one place that knows the on-disk shape of an
 * evaluation report (`reports/{NNN}-{slug}-{date}.md`).
 *
 * Two consumers used to encode this format independently and drift apart:
 *   - roles-model.mjs  read  the header fields + the `## Machine Summary` YAML
 *                            fence + the `| **Remote** |` row.
 *   - roles-actions.mjs wrote the same fence / Remote row on a manual cell edit.
 *
 * Both now import from here, so a report-format change is a one-file edit.
 *
 * The Machine Summary schema itself is documented in batch/batch-prompt.md;
 * this module only parses/patches whatever keys it is asked for.
 */

// The fenced YAML block, `## Machine Summary` immediately followed by a
// ```yaml / ```yml / ``` fence. Group 1 is the raw YAML body.
export const MACHINE_SUMMARY_FENCE_RE =
  /##\s*Machine Summary\s*\n+```(?:ya?ml)?\n([\s\S]*?)\n```/;

// The header table row `| **Remote** | {location} |`. Group 1 is the cell text.
export const REMOTE_ROW_RE = /\|\s*\*\*Remote\*\*\s*\|\s*([^|]+?)\s*\|/;

// Same row, but with the surrounding delimiters captured so a replacer can
// swap only the middle cell (group 2) and keep `pre`/`post` byte-identical.
const REMOTE_ROW_REPLACE_RE = /(\|\s*\*\*Remote\*\*\s*\|\s*)([^|]+?)(\s*\|)/;

// ── Report layouts and the archived JD ───────────────────────────────
// Three on-disk layouts coexist in one reports/ directory:
//   old fork    header, ## Machine Summary, A-G..., then the JD LAST as
//               `## Job Description (scraped DATE)` (text-fenced, Source: line)
//   interactive header, ## Machine Summary, A-G..., ## Keyword Coverage, then the
//               JD LAST as `## Job Description (archived verbatim)` (modes/oferta.md)
//   batch       header, `---`, `## Job Description (archived verbatim)` with the raw
//               scraped text pasted BARE, `---`, `## Machine Summary`, A-G...
//               (batch/batch-prompt.md)
// The JD is arbitrary scraped text: it can hold `**Score:**`, `**URL:**`, table
// rows, yaml fences, a complete fake `## Machine Summary`, an odd number of
// ``` fences, CRLF ... In the batch layout it sits BEFORE the Machine Summary,
// so a whole-file "first match" reads the JD instead of the report. Every
// consumer therefore goes through the helpers below, which treat the JD as an
// opaque span (never trusting fences or headings inside it) and locate the real
// Machine Summary by position relative to it.

// First line of the archived JD section. Same literal English prefix
// check-jd-archive.mjs matches (the heading is an exact-string contract).
export const JD_HEADING_RE = /^##[ \t]+Job Description\b/im;

// Report sections that follow the JD in the batch layout; fallback JD end when
// no Machine Summary fence can be found (never needed for a well-formed report).
const NEXT_REPORT_SECTION_RE =
  /^##[ \t]+(?:Machine Summary|Keywords extracted|[A-Z]\)|Risk Summary|Score Evidence|Extracted Keywords)/im;

// Candidate finder only: heading, whitespace, a fence opener. It must stay a SUPERSET
// of what a consumer's own fence regex accepts (those require `\n+` before the
// fence); the sticky pass below enforces the exact shape at each candidate. Do not
// write it as `\s*\n+` - on a long run of newlines after a "## Machine Summary" line
// that fails by backtracking quadratically (80,000 newlines took ~18 s per parse).
const LOOSE_MS_HEAD_SRC = '##\\s*Machine Summary\\s*```';
const stickyCache = new WeakMap();
function stickyOf(re) {
  let st = stickyCache.get(re);
  if (!st) {
    st = new RegExp(re.source, re.flags.replace(/[gy]/g, '') + 'y');
    stickyCache.set(re, st);
  }
  return st;
}

/**
 * Locate the REAL `## Machine Summary` fence. Drop-in for `text.match(FENCE_RE)`:
 * returns the same match array (`[0]` whole, `[1..]` groups, `.index`) or null.
 *
 * Every candidate heading is tried independently (so an unclosed fake fence in
 * the JD cannot swallow the real heading), then:
 *   - the JD heading comes BEFORE the first candidate  → batch layout: the real
 *     Machine Summary is the LAST candidate (anything earlier is JD text);
 *   - otherwise (old/interactive layout, JD last)       → the FIRST candidate.
 * For a report with no JD section, or a JD that follows the Machine Summary,
 * this is exactly `text.match(re)`.
 *
 * @param {string} text
 * @param {RegExp} [re]  the consumer's own fence regex (must start with the
 *   `##\s*Machine Summary\s*\n+```` prefix); defaults to MACHINE_SUMMARY_FENCE_RE.
 */
export function matchMachineSummary(text, re = MACHINE_SUMMARY_FENCE_RE) {
  const s = String(text ?? '');
  const loose = new RegExp(LOOSE_MS_HEAD_SRC, re.flags.includes('i') ? 'gi' : 'g');
  const st = stickyOf(re);
  const found = [];
  let h;
  while ((h = loose.exec(s)) !== null) {
    st.lastIndex = h.index;
    const m = st.exec(s);
    if (m) found.push(m);
  }
  if (!found.length) return null;
  const j = s.search(JD_HEADING_RE);
  return j >= 0 && found[0].index > j ? found[found.length - 1] : found[0];
}

const ANY_MS_FENCE_RE = /##\s*Machine Summary\s*\n+```(?:ya?ml|json)?\s*\n([\s\S]*?)\n```/i;

/**
 * The archived JD section as a [start, end) span of `text`, or null when the
 * report has none. Batch layout: from the JD heading up to the real Machine
 * Summary heading. Otherwise (JD last): from the JD heading to the end of file.
 */
export function archivedJdRange(text) {
  const s = String(text ?? '');
  const start = s.search(JD_HEADING_RE);
  if (start < 0) return null;
  const ms = matchMachineSummary(s, ANY_MS_FENCE_RE);
  if (ms && ms.index > start) return [start, ms.index];
  if (ms) return [start, s.length];
  // No Machine Summary at all: end at the first known report section, else EOF.
  const rest = s.slice(start).replace(JD_HEADING_RE, (m) => ' '.repeat(m.length));
  const next = rest.search(NEXT_REPORT_SECTION_RE);
  return [start, next < 0 ? s.length : start + next];
}

/**
 * The report with its archived JD cut out. Everything that reads a header field,
 * a table row or the Machine Summary from a report should read this, not the raw
 * text. Identical to the input when the report has no JD section.
 */
export function stripArchivedJd(text) {
  const s = String(text ?? '');
  const r = archivedJdRange(s);
  return r ? s.slice(0, r[0]) + s.slice(r[1]) : s;
}

/**
 * First match of `re` (non-global) that lies outside the archived JD, with the
 * same shape as `text.match(re)` but `.index` relative to the full `text`.
 */
export function matchOutsideJd(text, re) {
  const s = String(text ?? '');
  const r = archivedJdRange(s);
  const g = new RegExp(re.source, re.flags.replace(/[gy]/g, '') + 'g');
  let m;
  while ((m = g.exec(s)) !== null) {
    if (!r || m.index < r[0] || m.index >= r[1]) return m;
    if (m[0] === '') g.lastIndex++;
  }
  return null;
}

/**
 * Parse an evaluation report's text into the flat metadata object the roles
 * view renders. Never throws; unknown/absent keys are simply omitted.
 *
 * @param {string} text  the full report markdown
 * @returns {Record<string, any>}
 */
export function parseReportMeta(text) {
  const out = {};
  if (!text) return out;
  // The archived JD is arbitrary scraped text (and sits before the Machine
  // Summary in the batch layout): never read a header field or table row from it.
  text = stripArchivedJd(text);

  const url = text.match(/^\*\*URL:\*\*\s*(\S+)/m);
  if (url && /^https?:\/\//.test(url[1])) out.url = url[1];

  const arche = text.match(/^\*\*Archetype:\*\*\s*(.+)$/m);
  if (arche) out.archetype = arche[1].trim();

  const legHeader = text.match(/^\*\*Legitimacy:\*\*\s*(.+)$/m);
  if (legHeader) out.legitimacy_tier = legHeader[1].trim();

  const workAuthHeader = text.match(/^\*\*Work Auth:\*\*\s*(.+)$/m);
  if (workAuthHeader) out.work_auth_header = workAuthHeader[1].trim();

  const remoteRow = text.match(REMOTE_ROW_RE);
  if (remoteRow) out.loc = remoteRow[1].trim();

  const ms = matchMachineSummary(text, MACHINE_SUMMARY_FENCE_RE);
  if (ms) {
    const y = ms[1];
    // A YAML double-quoted string escapes inner quotes as \" — drop the outer
    // quotes and unescape, or the page shows a literal backslash.
    const unquote = (s) => {
      const t = s.trim();
      if (/^".*"$/.test(t)) return t.slice(1, -1).replace(/\\(["\\])/g, '$1');
      return t.replace(/^'|'$/g, '');
    };
    const scalar = (k) => {
      const m = y.match(new RegExp('^' + k + ':\\s*(.+)$', 'm'));
      return m ? unquote(m[1]) : null;
    };
    const list = (k) => {
      const m = y.match(new RegExp('^' + k + ':\\s*\\n((?:\\s*-\\s*.*\\n?)+)', 'm'));
      if (!m) return [];
      return m[1].split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('-'))
        .map((l) => unquote(l.replace(/^-\s*/, '')))
        .filter(Boolean);
    };
    const nullable = (v) => (v == null || v === 'null' ? null : v);

    const pct = scalar('pct');
    if (pct != null && /^\d+$/.test(pct)) out.pct = +pct;
    // Location: the Machine Summary `location:` key is the structured source;
    // the `| **Remote** | … |` header row (read above) is the fallback for
    // older reports that carry only the row. Both hold places only — see
    // lib/column-contract.mjs → locationProblem.
    const msLoc = nullable(scalar('location'));
    if (msLoc) out.loc = msLoc;
    out.legitimacy_tier = out.legitimacy_tier || nullable(scalar('legitimacy_tier'));
    out.archetype = out.archetype || nullable(scalar('archetype'));
    // Team is the posting's own team name, never the archetype verdict.
    out.team = nullable(scalar('team'));
    out.final_decision = nullable(scalar('final_decision'));
    out.risk_level = nullable(scalar('risk_level'));
    out.confidence = nullable(scalar('confidence'));
    out.next_action = nullable(scalar('next_action'));
    out.work_auth = nullable(scalar('work_auth'));
    out.via = nullable(scalar('via'));
    out.reports_to = nullable(scalar('reports_to'));
    const comp = nullable(scalar('advertised_comp'));
    if (comp) out.advertised_comp = comp;
    out.hard_stops = list('hard_stops');
    out.soft_gaps = list('soft_gaps');
    out.discard_reasons = list('discard_reasons');
    const strengths = list('top_strengths');
    if (strengths.length) out.why = strengths[0];
    out.risk_summary = {
      legitimacy: nullable(scalar('legitimacy')),
      classification: nullable(scalar('classification')),
      culture: nullable(scalar('culture')),
      interview_redflags: nullable(scalar('interview_redflags')),
      ai_infra: nullable(scalar('ai_infra')),
      ai_screening_disclosure: nullable(scalar('ai_screening_disclosure')),
    };
  }
  if (out.loc) out.remote = /\bremote\b/i.test(out.loc);
  return out;
}

/**
 * Set a scalar key inside the `## Machine Summary` YAML fence. Replaces the key
 * in place if it already exists, otherwise inserts it at the top of the fence.
 * `literal` is inserted verbatim (already quoted/escaped by the caller) — a
 * function replacer is used so `$1`, `$&` etc. in user text are not expanded.
 *
 * @param {string} text
 * @param {string} key
 * @param {string} literal  e.g. `"80-90k EUR"` or `null`
 * @returns {string}
 */
export function setMachineSummaryScalar(text, key, literal) {
  return editMachineSummaryBody(text, (body) => {
    const re = new RegExp(`^(${key}:[ \\t]*).*$`, 'm');
    return re.test(body)
      ? body.replace(re, (_m, pre) => pre + literal)
      : `${key}: ${literal}\n${body}`;
  });
}

/**
 * Apply `fn(body) -> newBody` to the body of the REAL `## Machine Summary` fence
 * only (never to a lookalike inside the archived JD, which can carry its own
 * "location:" / "team:" / "top_strengths:" lines). Splices by position, so an
 * identical string elsewhere in the file is never touched. Returns the text
 * unchanged when there is no Machine Summary.
 *
 * @param {string} text
 * @param {(body: string) => string} fn
 * @returns {string}
 */
export function editMachineSummaryBody(text, fn) {
  const fence = matchMachineSummary(text, /(##\s*Machine Summary\s*\n+```(?:ya?ml)?\n)([\s\S]*?)(\n```)/);
  if (!fence) return text;
  const [whole, open, body, close] = fence;
  return text.slice(0, fence.index) + open + fn(body) + close + text.slice(fence.index + whole.length);
}

/**
 * Replace the middle cell of the `| **Remote** | … |` header row with
 * `nextValue`, leaving the delimiters byte-identical. Returns the text
 * unchanged (and `changed: false`) when there is no Remote row.
 *
 * @param {string} text
 * @param {string} nextValue  the new cell text (caller computes it)
 * @returns {{text: string, changed: boolean}}
 */
export function setRemoteRow(text, nextValue) {
  // Outside the archived JD only: the batch layout has no header Remote row, so
  // the first `| **Remote** |` in the file can be a line of scraped JD text.
  const m = matchOutsideJd(text, REMOTE_ROW_REPLACE_RE);
  if (!m) return { text, changed: false };
  return {
    text: text.slice(0, m.index) + m[1] + nextValue + m[3] + text.slice(m.index + m[0].length),
    changed: true,
  };
}
