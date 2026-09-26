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

  const ms = text.match(MACHINE_SUMMARY_FENCE_RE);
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
  // Scoped to the fence body: the archived JD at the end of a report can carry
  // its own "location:" / "team:" lines, which must never be rewritten.
  const fence = text.match(/(##\s*Machine Summary\s*\n+```(?:ya?ml)?\n)([\s\S]*?)(\n```)/);
  if (!fence) return text;
  const [whole, open, body, close] = fence;
  const re = new RegExp(`^(${key}:[ \\t]*).*$`, 'm');
  const nextBody = re.test(body)
    ? body.replace(re, (_m, pre) => pre + literal)
    : `${key}: ${literal}\n${body}`;
  return text.replace(whole, () => open + nextBody + close);
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
  if (!REMOTE_ROW_REPLACE_RE.test(text)) return { text, changed: false };
  return {
    text: text.replace(REMOTE_ROW_REPLACE_RE, (_m, pre, _cur, post) => pre + nextValue + post),
    changed: true,
  };
}
