// lib/content-rescue.mjs — let a job's description overrule a title_filter miss.
//
// Fork-local (config/local-paths.txt). title_filter is a hard gate in scan.mjs:
// a posting whose title carries no positive keyword is dropped before
// content_filter ever sees the description, so "Research Scientist, AI Secure
// Code" (body: "vulnerability research ... reverse engineering ... agentic")
// never surfaced. This rescues such a posting when the description itself is
// strong evidence; the rescued job then runs through every remaining filter
// (tier, location, age, content, country, visa, dedup) like any other.
//
// Evidence = distinct keywords (content_rescue.keywords, default
// content_filter.positive, ∪ thesis_words) found in the description. Unlike
// content_filter's plain substring test, a keyword must START a word ("0-day"
// must not hit "30-day", "red team" must not hit "empowered team"), and a
// `word:` entry must be the whole word ("word:fuzz" skips "fuzzy",
// "word:autonomous" skips "autonomously") — same prefixes as title_filter,
// via title-keywords.mjs. Here the match is the evidence that overrides the
// title gate, so it has to be tighter than content_filter's pass-through test.
//
// Company boilerplate is discounted first, over the company's distinct
// described postings (counted once per title, so a role listed in four cities
// does not strip itself) and only when there are ≥ min_company_jobs of them —
// a small board can't tell boilerplate from a genuinely focused company.
// content_rescue.boilerplate picks what counts as boilerplate:
//   "sentence" (default) — a SENTENCE found in ≥ 2 postings and in ≥
//     sentence_df_pct (default 25) of them is company copy ("About depthfirst
//     ... zero-day ..." pasted into every JD). It is cut from each posting and
//     the keywords are matched on what is left.
//   "keyword" (legacy) — a KEYWORD found in ≥ boilerplate_df_pct (default 40)
//     of the postings stops counting, wherever it appears.
// Unknown values fall back to "sentence". The keyword rule wiped out the domain
// vocabulary of security-only startups: Cogent builds AI agents, so "ai agent",
// "agentic" and "autonomous" sit in >40% of its JDs in role-specific sentences
// (7AI, Nebulock, Glow, Runlayer alike). On 2026-09-27 that left 36 of 129
// technical title misses across 27 AI-security startups with no evidence at
// all; on 12,695 live jobs the sentence rule rescued 6 more fresh US postings
// (Horizon3 "Senior Software Engineer, Agentic Systems", Cogent "Software
// Engineer - Applied AI", ...) and lost none. sentence_df_pct sits below
// boilerplate_df_pct because a sentence's DF, unlike a keyword's, does not add
// up over rewordings: XBOW's About copy comes in four wordings, the commonest
// in 3 of 8 JDs (37.5%), so at 40 its "exploits ... zero-days ...
// autonomously" rescued three generic engineering roles. Any of 20-30 drops
// exactly those on the 39 security boards and keeps every other gain.
// Rescue when (≥1 thesis word AND ≥ min_distinct keywords) OR
// ≥ min_distinct_no_thesis keywords, counted after that stripping.

import { compileKeyword } from '../title-keywords.mjs';

const DEFAULTS = {
  min_distinct: 2,
  min_distinct_no_thesis: 3,
  boilerplate_df_pct: 40,
  sentence_df_pct: 25,
  min_company_jobs: 5,
  min_description_chars: 500,
};

const PREFIX_RE = /^(word|stem):/;

// Sentence mode. A sentence ends at . ! ? (optionally closed by a quote or
// bracket) followed by whitespace, at a line break, or at a bullet glyph (list
// items some ATSs ship on one line: "• Go • Rust"). The capture group keeps the
// separators in split() output, so a posting is rebuilt byte-for-byte minus
// its boilerplate sentences and neighbouring words never run together.
const SENTENCE_SPLIT_RE = /(\s*[\r\n•●▪◦‣∙·][\s•●▪◦‣∙·]*|(?<=[.!?][)"'”’]?)\s+)/;
// Shorter fragments ("Requirements:", "Benefits") repeat across any board and
// carry no company copy worth cutting.
const MIN_SENTENCE_CHARS = 25;

/** Lowercased, whitespace-collapsed sentence. */
function normalizeSentence(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The distinct normalized sentences of a description long enough to judge. */
function sentencesOf(description) {
  const out = new Set();
  const parts = description.split(SENTENCE_SPLIT_RE);
  for (let i = 0; i < parts.length; i += 2) {
    // Normalizing only collapses whitespace, so a fragment already under the
    // floor is skipped unnormalized (withoutSentences gates the same way).
    if (parts[i].length < MIN_SENTENCE_CHARS) continue;
    const s = normalizeSentence(parts[i]);
    if (s.length >= MIN_SENTENCE_CHARS) out.add(s);
  }
  return out;
}

/** description with every sentence in `boilerplate` blanked; separators kept. */
function withoutSentences(description, boilerplate) {
  if (boilerplate.size === 0) return description;
  const parts = description.split(SENTENCE_SPLIT_RE);
  let cut = false;
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i].length >= MIN_SENTENCE_CHARS && boilerplate.has(normalizeSentence(parts[i]))) {
      parts[i] = '';
      cut = true;
    }
  }
  return cut ? parts.join('') : description;
}

// Same shape tolerance as scan.mjs normalizeKeywordList: a bare YAML string is a
// one-item list, non-strings are dropped.
function normalizeList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value])
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Keyword text without a word:/stem: prefix — used as the evidence label. */
export function keywordLabel(keyword) {
  return keyword.replace(PREFIX_RE, '').trim();
}

/**
 * @param {object|undefined} rescueCfg - portals.yml `content_rescue`
 * @param {object|undefined} contentCfg - portals.yml `content_filter`
 * @returns {null | { forCompany(jobs: object[], opts?: {providerId?: string}): null | { check(job: object): null | {keywords: string[], thesis: string[]} } }}
 *   null when disabled or there are no keywords to look for.
 */
export function buildContentRescue(rescueCfg, contentCfg) {
  if (!rescueCfg || typeof rescueCfg !== 'object' || rescueCfg.enabled !== true) return null;

  const thesisList = normalizeList(rescueCfg.thesis_words);
  const evidenceList = rescueCfg.keywords != null ? normalizeList(rescueCfg.keywords) : normalizeList(contentCfg?.positive);
  const keywords = [...new Set([...evidenceList, ...thesisList])];
  if (keywords.length === 0) return null;
  const thesis = new Set(thesisList.map(keywordLabel));
  // Plain entries match at a word start (stem semantics); word:/stem: as written.
  const matchers = keywords.map((k) => ({
    label: keywordLabel(k),
    test: compileKeyword(PREFIX_RE.test(k) ? k : `stem:${k}`),
  }));

  const setting = (key) => {
    const v = rescueCfg[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULTS[key];
  };
  const minDistinct = setting('min_distinct');
  const minDistinctNoThesis = setting('min_distinct_no_thesis');
  const boilerplatePct = setting('boilerplate_df_pct');
  const sentencePct = setting('sentence_df_pct');
  const minCompanyJobs = setting('min_company_jobs');
  const minChars = setting('min_description_chars');
  const titleRequireAny = normalizeList(rescueCfg.title_require_any);
  const skipProviders = new Set(normalizeList(rescueCfg.skip_providers));
  // Only the string "keyword" selects the legacy rule; a YAML list or number
  // that happens to stringify to it does not.
  const mode = rescueCfg.boilerplate;
  const sentenceMode = !(typeof mode === 'string' && mode.trim().toLowerCase() === 'keyword');

  // min_description_chars is judged on the posting as published, before any
  // boilerplate is cut from it.
  const judgeable = (job) => typeof job?.description === 'string' && job.description.length >= minChars;
  // `labels` limits the pass to keywords already found (re-matching cut text).
  const keywordsIn = (text, labels = null) => {
    const lower = text.toLowerCase();
    const found = matchers.filter((m) => (labels === null || labels.includes(m.label)) && m.test(lower));
    return [...new Set(found.map((m) => m.label))];
  };

  return {
    forCompany(jobs, { providerId = '' } = {}) {
      if (skipProviders.has(String(providerId).toLowerCase())) return null;
      const list = Array.isArray(jobs) ? jobs : [];
      // Keywords in the whole description, before any boilerplate is discounted.
      const cache = new Map();
      const hitsFor = (job) => {
        if (!cache.has(job)) cache.set(job, keywordsIn(job.description));
        return cache.get(job);
      };

      // The company's distinct described postings. Greenhouse/Lever list one
      // requisition per city with the same title; bodies differ only in
      // pay-range text, so the title is the key. Too few → no stripping.
      const distinctPostings = () => {
        const seen = new Set();
        const described = [];
        for (const job of list) {
          if (!judgeable(job)) continue;
          const key = String(job?.title ?? '').trim().toLowerCase() || job.description;
          if (seen.has(key)) continue;
          seen.add(key);
          described.push(job);
        }
        return described.length >= minCompanyJobs ? described : [];
      };

      // Document frequency of sentences (default) or keywords (legacy) over
      // those postings, computed on the first check() that needs it.
      let boilerplate = null;
      const boilerplateSet = () => {
        if (boilerplate) return boilerplate;
        boilerplate = new Set();
        const described = distinctPostings();
        const df = new Map();
        for (const job of described) {
          const units = sentenceMode ? sentencesOf(job.description) : hitsFor(job);
          for (const k of units) df.set(k, (df.get(k) || 0) + 1);
        }
        // A sentence seen in one posting is that posting's own, whatever its share.
        const minCount = sentenceMode ? 2 : 1;
        const pct = sentenceMode ? sentencePct : boilerplatePct;
        for (const [k, n] of df) {
          if (n >= minCount && (n / described.length) * 100 >= pct) boilerplate.add(k);
        }
        return boilerplate;
      };

      // Evidence left once company boilerplate is discounted. Cutting text can
      // only lose keywords, so a posting with none skips the company pass.
      const effectiveFor = (job) => {
        const hits = hitsFor(job);
        if (hits.length === 0) return hits;
        const strip = boilerplateSet();
        if (!sentenceMode) return hits.filter((k) => !strip.has(k));
        const cut = withoutSentences(job.description, strip);
        return cut === job.description ? hits : keywordsIn(cut, hits);
      };

      return {
        check(job) {
          const title = String(job?.title ?? '').toLowerCase();
          if (titleRequireAny.length > 0 && !titleRequireAny.some((w) => title.includes(w))) return null;
          if (!judgeable(job)) return null;
          const effective = effectiveFor(job);
          if (effective.length === 0) return null;
          const thesisHits = effective.filter((k) => thesis.has(k));
          const rescued = (thesisHits.length >= 1 && effective.length >= minDistinct)
            || effective.length >= minDistinctNoThesis;
          return rescued ? { keywords: effective, thesis: thesisHits } : null;
        },
      };
    },
  };
}
