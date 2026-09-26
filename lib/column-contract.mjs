// column-contract.mjs — what each roles-view column is allowed to hold.
//
// Every dashboard column is fed by one stored field (tracker cell, report
// header line, or Machine Summary key). Those fields used to be free text, so
// evaluators wrote fit verdicts into Team, pay bands and JD quotes into
// Location, and whole JD sentences into Salary. The rules here are the single
// definition of each field's shape: verify-pipeline.mjs errors on any stored
// value that breaks them, and the writer prompts (batch/batch-prompt.md,
// modes/oferta.md, modes/_custom.md) describe the same shapes.
//
// Each `*Problem(value)` returns null when the value is acceptable (null/empty
// always is — the column renders "—"), else a one-line reason.

export const WORK_AUTH_LABEL = {
  sponsors: 'Sponsors',
  not_needed: 'Not needed',
  unstated: 'Unstated',
  no_sponsorship: 'No sponsorship',
};
export const WORK_AUTH_HEADER = {
  sponsors: '✅ Sponsors',
  not_needed: '➖ Not needed',
  unstated: '⚠️ Unstated',
  no_sponsorship: '⛔ No sponsorship',
};
export const LEGITIMACY_TIERS = ['High Confidence', 'Proceed with Caution', 'Suspicious'];
export const RISK_LEVELS = ['Low', 'Medium', 'High'];

const blank = (v) => v == null || String(v).trim() === '';

// Team: the team / org / lab the posting names ("Security Engineering",
// "Frontier Red Team", "Unit 42"). Never a fit verdict — that judgment is the
// candidate's, and the report keeps it under **Archetype:**.
export function teamProblem(v) {
  if (blank(v)) return null;
  const s = String(v).trim();
  if (s.length > 60) return 'longer than a team name';
  if (/[()[\]"“”;:]/.test(s)) return 'contains parentheses/quotes/punctuation — team name only';
  if (/\s[—–]\s|--/.test(s)) return 'contains a dash clause — team name only';
  if (/#\s?\d/.test(s)) return 'contains a tracker/report reference — team name only';
  if (/\b(mismatch|adjacent|primary|secondary|archetype|keyword spine|none of|fit|stretch|override|generalist)\b/i.test(s)) {
    return 'contains an evaluation verdict — team name only';
  }
  return null;
}

// Location: places only, " / "-separated. A place is "City, ST", "City,
// Country", "Country", or "Remote" / "Remote (US)". No pay, no quotes, no
// on-site/hybrid policy, no commentary.
const PLACE_PART = /^[A-Z][A-Za-z.'’-]*(?: [A-Za-z][A-Za-z.'’-]*)*$/;
const REMOTE_SEG = /^Remote(?: \(([^()]+)\))?$/;
function placeOk(seg) {
  const m = seg.match(REMOTE_SEG);
  if (m) return !m[1] || m[1].split(', ').every((p) => PLACE_PART.test(p));
  const parts = seg.split(', ');
  return parts.length <= 3 && parts.every((p) => PLACE_PART.test(p));
}
export function locationProblem(v) {
  if (blank(v)) return null;
  const s = String(v).trim();
  if (/[$€£]|\d/.test(s)) return 'contains numbers/pay — places only';
  if (/["“”]/.test(s)) return 'contains a quote — places only';
  if (s.length > 140) return 'too long — places only';
  const bad = s.split(' / ').map((x) => x.trim()).find((seg) => !placeOk(seg));
  if (bad != null) return `"${bad}" is not a place — use "City, ST", "Country" or "Remote (US)"`;
  return null;
}

// Provider-sourced location strings (pipeline.md lines, scan-history.tsv) keep
// the ATS's own spelling ("Remote - USA", "US-CA-Santa Clara"), so only junk is
// rejected there: pay, quotes, and evaluator remarks.
export function providerLocationProblem(v) {
  if (blank(v)) return null;
  const s = String(v).trim();
  if (/[$€£]\s?\d|\b\d{2,3}k\b|\d{2,3},\d{3}/i.test(s)) return 'contains pay — places only';
  if (/["“”]/.test(s)) return 'contains a quote — places only';
  if (/\b(unresolved|unknown|per|JD|posting|listed|implied|states|see|TBD)\b/.test(s)) return 'contains a remark — places only';
  return null;
}

// Salary: the posted base-pay figure(s) and nothing else — "$218,400–$480,000",
// "$200,000", "€80,000–€90,000", "$55.00–$70.00/hr". Multiple bands collapse to
// their overall span; the full wording stays in the report's archived JD.
const MONEY = String.raw`[$€£]\d{1,3}(?:,\d{3})*(?:\.\d{2})?`;
const COMP_RE = new RegExp(`^${MONEY}(?:–${MONEY})?(?:/hr)?$`);
export function compProblem(v) {
  if (blank(v)) return null;
  return COMP_RE.test(String(v).trim())
    ? null
    : 'not a bare pay range — write "$150,000–$200,000" or null';
}

// Role: the posting's own title. Req IDs and evaluator remarks go in Notes.
export function roleProblem(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'empty';
  if (/["“”]/.test(s)) return 'contains a quote — posted title only';
  if (/\b(req|requisition|job\s*id|job\s*code)\b|\bJR[-\s]?\d|\bR_?\d{5,}\b/i.test(s)) {
    return 'contains a req/job ID — put it in Notes (e.g. "req JR2021887")';
  }
  if (/^direct outreach\s*[—–-]/i.test(s)) return 'outreach target in Role — Role is "Direct outreach", the target goes in Notes';
  if (/\b(careers page|confirmation|posted as|listed as|a\.?k\.?a\.?|per (the )?(jd|posting|linkedin))\b/i.test(s)) {
    return 'contains an evaluator remark — posted title only';
  }
  return null;
}

export function enumProblem(v, allowed) {
  if (blank(v)) return null;
  return allowed.includes(String(v).trim()) ? null : `"${v}" is not one of ${allowed.join(' | ')}`;
}

// `**Work Auth:**` header → work_auth enum. Used only as a display fallback for
// reports that carry the header but no Machine Summary `work_auth:` key.
export function workAuthFromHeader(h) {
  // Order matters: a silent header often reads "Silent (no visa/sponsorship
  // language)", which must never fall through to "Sponsors".
  const s = String(h ?? '');
  if (/⛔|\bno sponsorship\b|\bwill not sponsor\b/i.test(s)) return 'no_sponsorship';
  if (/⚠️|\bunstated\b|\bsilent\b/i.test(s)) return 'unstated';
  if (/➖|\bnot needed\b/i.test(s)) return 'not_needed';
  if (/✅|\bsponsors\b/i.test(s)) return 'sponsors';
  return null;
}
