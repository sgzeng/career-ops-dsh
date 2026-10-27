// lib/campus-track.mjs — let a new-grad / PhD-graduate posting through the gates
// that were tuned for experienced security hires.
//
// Fork-local (2026-10-27). Campus postings were reaching scan.mjs and dying at
// four separate gates, none of which was meant for them:
//   - title_filter: "Software Engineer, New Grad", "Research Scientist,
//     University Graduate", "Software Engineer, Early Career" carry no thesis
//     word, and only "word:PhD" stood in for the whole campus funnel;
//   - content_filter: the general "pass the bar, get slotted later" JD names no
//     fuzzing / exploit / red-team keyword, so even a title hit was dropped;
//   - max_posting_age_days + --since: campus reqs open in Aug-Oct and stay up
//     all season. 48 of the 105 campus rows in scan-history.tsv up to
//     2026-10-25 were `skipped_age` (ByteDance "Software Engineer - AI Agent
//     Infra Graduate (Security Engineering) - 2027 Start" among them);
//   - skip_tiers: "Software Development Engineer I (New Grad)" and
//     "Software Engineer - Entry Level (PhD)" classify as `entry`.
//
// A title is a campus posting when it names a campus MARKER ("New Grad",
// "University Graduate", "2027 Start", "PhD", ...) AND a technical ROLE word
// ("Software Engineer", "Research Scientist", "Security", ...), and no
// `exclude` phrase ("Student Researcher" is a PhD internship by another name).
// The role list keeps "Network Support (New Grads 2026)" and "ASIC Design
// Engineer - New College Grad" out.
// title_filter.negative still vetoes (Intern, Manager, Sales, ...), and the
// location / salary / country / visa / dedup gates still run. Only tracked
// companies get the track; scan-ats-full.mjs (15.9k public boards) does not,
// so the reverse sweeps do not pull in every startup's new-grad SWE req.
//
// Same keyword syntax as title_filter (title-keywords.mjs): plain substring,
// `word:` whole word, `stem:` word start, "a + b" AND-group.
//
// degree_filter (2026-10-27, user: keep the Master's and PhD campus channels, drop
// the ones plainly opened for CS undergrads). A campus row is dropped when its
// title names an undergraduate degree ("Software Engineer (Bachelor's New College
// Grad)"), or its JD names one and no graduate degree anywhere, required or
// preferred. A title naming a graduate degree keeps the row outright, so does a JD
// that mentions a Master's or PhD at all ("BS/MS", "Master's or PhD preferred"),
// and so does a row whose JD could not be read: stage 2 decides those.

import { compilePositiveKeyword, foldAccents } from '../title-keywords.mjs';

const DAY_MS = 86_400_000;

// Curly apostrophes ("Master’s") read as straight ones.
const normalize = text => foldAccents(text.toLowerCase()).replace(/[\u2018\u2019]/g, "'");

function compileList(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter(k => typeof k === 'string' && k.trim())
    .map(k => {
      const kw = normalize(k.trim());
      return { kw, matches: compilePositiveKeyword(kw) };
    });
}

/**
 * @param {object|undefined} cfg - portals.yml `campus_track`.
 * @param {number} [now]
 * @returns {null | {
 *   windowDays: number,
 *   sinceMs: number,
 *   match: (title: string) => string|null,
 *   keepsTier: (tier: string) => boolean,
 *   inWindow: (postedAt: unknown) => boolean,
 *   bypassContent: boolean,
 *   degree: null | { fetchJd: boolean, verdict: (title: string, description: unknown) => { keep: boolean, reason: string } },
 * }}
 */
export function buildCampusTrack(cfg, now = Date.now()) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || cfg.enabled === false) return null;
  const markers = compileList(cfg.markers);
  const roles = compileList(cfg.roles);
  const exclude = compileList(cfg.exclude);
  if (markers.length === 0) return null;
  const windowDays = Number.isInteger(cfg.window_days) && cfg.window_days > 0 ? cfg.window_days : 180;
  const sinceMs = now - windowDays * DAY_MS;
  const keepTiers = new Set(
    (Array.isArray(cfg.keep_tiers) ? cfg.keep_tiers : ['entry'])
      .filter(t => typeof t === 'string')
      .map(t => t.toLowerCase()),
  );
  return {
    windowDays,
    sinceMs,
    // The marker that makes `title` a campus posting, or null.
    match(title) {
      if (typeof title !== 'string' || !title.trim()) return null;
      const lower = foldAccents(title.toLowerCase());
      const marker = markers.find(m => m.matches(lower));
      if (!marker) return null;
      if (roles.length > 0 && !roles.some(r => r.matches(lower))) return null;
      if (exclude.some(x => x.matches(lower))) return null;
      return marker.kw;
    },
    keepsTier: tier => typeof tier === 'string' && keepTiers.has(tier.toLowerCase()),
    // Replaces both max_posting_age_days and the --since bound for a campus row.
    // No date passes, the same convention as buildPostingAgeFilter.
    inWindow(postedAt) {
      if (typeof postedAt !== 'number' || !Number.isFinite(postedAt)) return true;
      return postedAt >= sinceMs;
    },
    bypassContent: cfg.bypass_content_filter !== false,
    degree: buildDegreeFilter(cfg.degree_filter),
  };
}

function buildDegreeFilter(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || cfg.enabled === false) return null;
  const graduateTitle = compileList(cfg.graduate_title);
  const undergradTitle = compileList(cfg.undergrad_title);
  const graduateJd = compileList(cfg.graduate_jd);
  const undergradJd = compileList(cfg.undergrad_jd);
  const first = (list, lower) => list.find(k => k.matches(lower))?.kw;
  return {
    fetchJd: cfg.fetch_jd !== false,
    verdict(title, description) {
      const t = normalize(typeof title === 'string' ? title : '');
      const grad = first(graduateTitle, t);
      if (grad) return { keep: true, reason: `title: ${grad}` };
      const under = first(undergradTitle, t);
      if (under) return { keep: false, reason: `title names "${under}"` };
      if (typeof description !== 'string' || !description.trim()) return { keep: true, reason: 'JD unread' };
      const d = normalize(description);
      const gradJd = first(graduateJd, d);
      if (gradJd) return { keep: true, reason: `JD: ${gradJd}` };
      const underJd = first(undergradJd, d);
      if (underJd) return { keep: false, reason: `JD names "${underJd}" and no graduate degree` };
      return { keep: true, reason: 'no degree stated' };
    },
  };
}
