/**
 * identity-key.mjs — company and title identity for duplicate detection.
 *
 * One employer reaches the pipeline under several spellings, and the scanner and
 * the tracker writer used to compare them with different rules:
 *
 *   - A scanned company label is whatever the board or the user's portals.yml
 *     calls it: "NVIDIA (Product Security / AI Red Team)", "TrendAI (Trend
 *     Micro)". A LinkedIn copy of the same role says "NVIDIA", "TrendAI". The
 *     parenthetical is a label the user wrote for their own watchlist, not part
 *     of the employer's name, so the two never compared equal and the same
 *     role was surfaced twice (10 times in one real scan history, and again as
 *     a second tracker row when stage 2 evaluated both).
 *   - The tracker stores yet another spelling ("Trend Micro (Zero Day
 *     Initiative)"), which no amount of punctuation folding connects to
 *     "TrendAI". That one is a rename, and only the user can say so: it goes in
 *     `portals.yml → company_aliases`.
 *
 * This module is the single place those two ideas live, so scan.mjs (stage 1)
 * and merge-tracker.mjs (the tracker write) cannot drift apart again. Every
 * function here is for COMPARISON ONLY. Nothing rewrites a stored name or title.
 *
 * What is deliberately NOT here: a general "drop the trailing parenthetical"
 * rule for TITLES. Measured on a real scan history and tracker (889 titles, 128
 * with a trailing qualifier that is not a location), a qualifier is nearly always
 * a team or product that tells two openings apart: Palo Alto Networks posts
 * "Principal Security Researcher", "... (Xpanse)", "... (Decoder)" and
 * "... (AI-Assisted Vulnerability Research)" as different requisitions, and the
 * user applied to some of them separately. Dropping every qualifier would have
 * fused 14 pairs of sibling titles (12 of them different openings), and even the
 * narrower "bare title vs the same title plus a qualifier" fused 21 pairs, 7 of
 * them different openings. Only a qualifier that carries no information of its
 * own is dropped — see {@link isRedundantTitleQualifier}.
 */

/**
 * Full-width parentheses read as ASCII ones, one UTF-16 unit for one, so an index
 * into the result is an index into the label as written. (A whole-string NFKC
 * would also fold them, but it rewrites the label, and a caller that compares
 * labels under its own key must get back the characters it passed in.)
 */
const asciiParens = (text) => text.replace(/（/g, '(').replace(/）/g, ')');

const isSpace = (char) => /\s/u.test(char);

/**
 * Find ONE trailing parenthetical group in `text[0, end)`.
 *
 * Hand-rolled rather than a regex: `^(.*\S)\s*\((.*)\)\s*$` backtracks
 * quadratically on a long run of whitespace followed by an unclosed `(`, and
 * these labels come from job boards. Works on indices, so peeling a label that
 * is nothing but groups costs one pass, not one copy per group.
 *
 * Nested or unbalanced groups ("Acme (A (B))", "Acme (A) B)") are left alone:
 * guessing where the qualifier starts there is how a real name gets cut.
 *
 * @param {string} text - Label with ASCII parentheses ({@link asciiParens}).
 * @param {number} end - Look at the label up to here.
 * @returns {{baseEnd: number, qualifier: string}|null} Where the text before the
 *   group ends and the group's content, or null when there is no trailing group
 *   or nothing before it.
 */
function trailingGroup(text, end) {
  let close = end;
  while (close > 0 && isSpace(text[close - 1])) close -= 1;
  if (close === 0 || text[close - 1] !== ')') return null;
  const open = text.lastIndexOf('(', close - 1);
  if (open <= 0) return null;
  for (let i = open + 1; i < close - 1; i += 1) {
    if (text[i] === ')') return null;
  }
  let baseEnd = open;
  while (baseEnd > 0 && isSpace(text[baseEnd - 1])) baseEnd -= 1;
  return baseEnd > 0 ? { baseEnd, qualifier: text.slice(open + 1, close - 1) } : null;
}

/**
 * A company label without its trailing parenthetical qualifier(s), for
 * comparison only.
 *
 * "NVIDIA (Product Security / AI Red Team)" → "NVIDIA". Applied repeatedly, so
 * "Acme (Labs) (EU)" → "Acme".
 *
 * The label is returned UNCHANGED (same string, no normalization) when there is
 * nothing to fold, so a caller's existing behaviour for names without a
 * qualifier is byte for byte what it was. It is also returned unchanged when
 * folding would leave no name behind:
 *
 *   - "? (client of Michael Page)" — `?` is the unknown-employer marker
 *     (#1596). Folding it would make every blind row at every agency one
 *     company, which is exactly the double-submission hazard the Via column
 *     exists to surface.
 *   - "(Acme)" — nothing precedes the group.
 *
 * Two different companies that differ only by a parenthetical ("Cobalt
 * (robotics)" and "Cobalt (security)") fold together. That is the cost of the
 * rule, and `company_aliases` is the way out: an alias is looked up on the
 * label as written BEFORE the fold, so listing the exact spelling under its own
 * canonical name keeps it apart.
 *
 * @param {unknown} name - Company label from a board, a tracker row, a history row.
 * @returns {string} The label with trailing qualifiers removed, or the label
 *   itself when there are none to remove.
 */
export function foldCompanyQualifier(name) {
  const original = String(name ?? '');
  const probe = asciiParens(original);
  let end = probe.length;
  for (let group = trailingGroup(probe, end); group; group = trailingGroup(probe, end)) {
    end = group.baseEnd;
  }
  // All or nothing: "? (a) (b)" must not stop half way at "? (a)", a key no
  // other spelling of the same blind row would produce.
  return end < probe.length && /[\p{L}\p{N}]/u.test(original.slice(0, end)) ? original.slice(0, end) : original;
}

/**
 * Connector words skipped when a phrase is read as the initials of an acronym:
 * "Security Operations AND Novel Adversary Research" is SONAR.
 */
const ACRONYM_CONNECTORS = new Set(['and', 'of', 'the', 'for', 'to', 'in', 'on', 'a', 'an']);

// An acronym expansion that needs more words than this is a sentence, not a title qualifier.
const MAX_EXPANSION_WORDS = 8;
// Real titles and qualifiers are short. Bounding both keeps a hostile "title" (a
// megabyte of repeated groups) from costing a word split per group.
const MAX_QUALIFIER_CHARS = 200;
const MAX_TITLE_CHARS = 500;
const MAX_QUALIFIERS_PEELED = 6;

function wordsOf(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const startsWithLetter = (word) => /^\p{L}/u.test(word);
const initialOf = (word) => Array.from(word)[0];

/**
 * Whether a trailing title qualifier is the same information as the title it
 * decorates, so that "X (Q)" and "X" are one opening.
 *
 * The one class that is provably redundant is an acronym and its expansion:
 *
 *   "Research Engineer, Cybersecurity RL (Reinforcement Learning)"
 *   "Senior Security Research Engineer, SONAR (Security Operations and Novel Adversary Research)"
 *   "Site Reliability Engineer (SRE)"
 *
 * The qualifier is redundant when its initials spell a word already in the
 * title, or when it is a short word spelled by the initials of words in the
 * title. Two initials are needed to count, and every word of the expansion must
 * start with a letter: the check is "these words are that acronym", never "this
 * looks like an abbreviation".
 *
 * It does NOT fire on a team, product or skill name — "(Xpanse)", "(Decoder)",
 * "(Cloud)", "(Auth0)" — because those say something the bare title does not.
 * It also does not fire on "(Reinforcement Learning)" under "Research Engineer,
 * Machine Learning": no acronym in that title is spelled by those words, and an
 * Anthropic req by that name is a different role from the plain one.
 *
 * @param {string} base - The title without the qualifier.
 * @param {string} qualifier - The text inside the trailing parentheses.
 * @returns {boolean}
 */
export function isRedundantTitleQualifier(base, qualifier) {
  if (String(qualifier ?? '').length > MAX_QUALIFIER_CHARS || String(base ?? '').length > MAX_TITLE_CHARS) return false;
  const qualifierWords = wordsOf(qualifier);
  const baseWords = wordsOf(base);
  if (qualifierWords.length === 0 || baseWords.length === 0) return false;

  // The qualifier spells out an acronym that stands in the title.
  const expansion = qualifierWords.filter((word) => !ACRONYM_CONNECTORS.has(word));
  if (expansion.length >= 2 && expansion.length <= MAX_EXPANSION_WORDS && expansion.every(startsWithLetter)) {
    if (baseWords.includes(expansion.map(initialOf).join(''))) return true;
  }

  // The qualifier IS an acronym, spelled by the title's own words.
  if (qualifierWords.length === 1 && Array.from(qualifierWords[0]).length >= 2) {
    const acronym = Array.from(qualifierWords[0]);
    const candidates = baseWords.filter((word) => !ACRONYM_CONNECTORS.has(word) && startsWithLetter(word));
    for (let start = 0; start + acronym.length <= candidates.length; start += 1) {
      if (acronym.every((letter, i) => initialOf(candidates[start + i]) === letter)) return true;
    }
  }
  return false;
}

/**
 * A role title without trailing qualifiers that repeat the title (see
 * {@link isRedundantTitleQualifier}), for comparison only. A qualifier that is
 * not redundant stops the peel: "X (Cloud)" stays "X (Cloud)".
 *
 * @param {unknown} title - Role title from the tracker, a TSV addition, a board.
 * @returns {string} The title, or the title itself when nothing was dropped.
 */
export function dropRedundantTitleQualifier(title) {
  const original = String(title ?? '');
  const probe = asciiParens(original);
  let end = probe.length;
  for (let peeled = 0; peeled < MAX_QUALIFIERS_PEELED; peeled += 1) {
    const group = trailingGroup(probe, end);
    if (!group || !isRedundantTitleQualifier(probe.slice(0, group.baseEnd), group.qualifier)) break;
    end = group.baseEnd;
  }
  return end < probe.length ? original.slice(0, end) : original;
}

const lowerTrim = (name) => String(name ?? '').trim().toLowerCase();

/**
 * Build a company-identity function from `portals.yml → company_aliases`.
 *
 * The map is `{ CanonicalName: [alias, ...] }`. The returned function maps a raw
 * company label to a comparison key; two labels name the same employer when
 * their keys are equal and non-empty.
 *
 * Lookup order, so that what the user wrote always beats a guess:
 *   1. the label as written — an explicit alias (or canonical name) wins;
 *   2. the label with its trailing parenthetical folded away
 *      ({@link foldCompanyQualifier}), so "Trend Micro (Zero Day Initiative)"
 *      reaches an alias for "Trend Micro";
 *   3. the folded label itself.
 *
 * With no alias map this is {@link foldCompanyQualifier} plus `normalize`, and a
 * label without a trailing qualifier gets exactly `normalize(label)`.
 *
 * Canonical names keep their own identity when an alias collides with one, and
 * an alias claimed by more than one canonical name is ignored rather than
 * resolved by config order: malformed config can let a duplicate through, but it
 * cannot merge two companies.
 *
 * @param {Record<string, unknown>|undefined|null} aliases - Canonical company
 *   name → alias list. Anything else is treated as no aliases.
 * @param {{normalize?: (name: unknown) => string}} [options] - Key function
 *   applied to every label; the default trims and lowercases (scan.mjs). The
 *   tracker writer passes its punctuation-free `normalizeCompany`.
 * @returns {(name: unknown) => string} Comparison key; '' when the label has no
 *   usable text.
 */
export function buildCompanyIdentity(aliases, { normalize = lowerTrim } = {}) {
  const map = new Map();
  if (aliases && typeof aliases === 'object' && !Array.isArray(aliases)) {
    const entries = Object.entries(aliases);
    const canonicalKeys = new Set();

    // Canonical names always own their identity, independent of YAML key order.
    for (const [canonical] of entries) {
      const canon = normalize(canonical);
      if (!canon) continue;
      map.set(canon, canon);
      canonicalKeys.add(canon);
    }

    const aliasTargets = new Map();
    for (const [canonical, list] of entries) {
      const canon = normalize(canonical);
      if (!canon) continue;
      const arr = Array.isArray(list) ? list : [list];
      for (const a of arr) {
        const alias = normalize(a);
        if (!alias || canonicalKeys.has(alias)) continue;
        if (!aliasTargets.has(alias)) aliasTargets.set(alias, new Set());
        aliasTargets.get(alias).add(canon);
      }
    }

    // Ambiguous aliases fail open as their raw normalized label.
    for (const [alias, targets] of aliasTargets) {
      if (targets.size === 1) map.set(alias, targets.values().next().value);
    }
  }

  return function companyIdentity(name) {
    const asWritten = normalize(name);
    const exact = map.get(asWritten);
    if (exact !== undefined) return exact;
    const folded = normalize(foldCompanyQualifier(name));
    return map.get(folded) ?? folded;
  };
}
