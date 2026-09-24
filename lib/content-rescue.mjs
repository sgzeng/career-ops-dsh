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
// Company boilerplate is discounted first: a keyword found in ≥
// boilerplate_df_pct of one company's distinct postings ("zero-day" in every
// depthfirst JD) says nothing about this one. Postings are counted once per
// title, so a role listed in four cities does not strip its own keywords.
// Rescue when (≥1 thesis word AND ≥ min_distinct keywords) OR
// ≥ min_distinct_no_thesis keywords, counted after that stripping.

import { compileKeyword } from '../title-keywords.mjs';

const DEFAULTS = {
  min_distinct: 2,
  min_distinct_no_thesis: 3,
  boilerplate_df_pct: 40,
  min_company_jobs: 5,
  min_description_chars: 500,
};

const PREFIX_RE = /^(word|stem):/;

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
  const minCompanyJobs = setting('min_company_jobs');
  const minChars = setting('min_description_chars');
  const titleRequireAny = normalizeList(rescueCfg.title_require_any);
  const skipProviders = new Set(normalizeList(rescueCfg.skip_providers));

  // null = no usable description (too short to judge); [] = judged, no hits.
  const keywordsIn = (description) => {
    if (typeof description !== 'string' || description.length < minChars) return null;
    const lower = description.toLowerCase();
    return [...new Set(matchers.filter((m) => m.test(lower)).map((m) => m.label))];
  };

  return {
    forCompany(jobs, { providerId = '' } = {}) {
      if (skipProviders.has(String(providerId).toLowerCase())) return null;
      const list = Array.isArray(jobs) ? jobs : [];
      const cache = new Map();
      const hitsFor = (job) => {
        if (!cache.has(job)) cache.set(job, keywordsIn(job?.description));
        return cache.get(job);
      };

      // Document frequency over the company's distinct described postings,
      // computed on the first check() that needs it. Too few → no stripping:
      // a small board can't tell boilerplate from a genuinely focused company.
      let boilerplate = null;
      const boilerplateKeywords = () => {
        if (boilerplate) return boilerplate;
        boilerplate = new Set();
        const seen = new Set();
        const described = [];
        for (const job of list) {
          const hits = hitsFor(job);
          if (!hits) continue;
          // Greenhouse/Lever list one requisition per city with the same title;
          // bodies differ only in pay-range text, so the title is the key.
          const key = String(job?.title ?? '').trim().toLowerCase() || job.description;
          if (seen.has(key)) continue;
          seen.add(key);
          described.push(hits);
        }
        if (described.length >= minCompanyJobs) {
          const df = new Map();
          for (const hits of described) for (const k of hits) df.set(k, (df.get(k) || 0) + 1);
          for (const [k, n] of df) {
            if ((n / described.length) * 100 >= boilerplatePct) boilerplate.add(k);
          }
        }
        return boilerplate;
      };

      return {
        check(job) {
          const title = String(job?.title ?? '').toLowerCase();
          if (titleRequireAny.length > 0 && !titleRequireAny.some((w) => title.includes(w))) return null;
          const hits = hitsFor(job);
          if (!hits || hits.length === 0) return null;
          const strip = boilerplateKeywords();
          const effective = hits.filter((k) => !strip.has(k));
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
