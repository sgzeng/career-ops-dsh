// lib/level-filter.mjs — drop postings titled above the candidate's level ceiling.
//
// Fork-local. title_filter.negative can't express a level cap: "Staff" must go
// (Google L6 / Meta E6 and up), but "Member of Technical Staff" is a flat title,
// and "Senior/Staff Security Researcher" is a dual-level req whose Senior half
// may still fit. So `block` words match as whole words (via title-keywords.mjs
// `word:` matching) AFTER every `exempt` phrase has been blanked out of the
// title. Runs after title_filter (and content rescue) in scan.mjs, and wraps
// scan-ats-full.mjs's title filter, so rescued and reverse-discovered jobs are
// capped too.
//
// portals.yml:
//   level_filter:
//     enabled: true
//     block: ["staff", "principal", "distinguished"]
//     exempt: ["member of technical staff", "senior/staff"]

import { compileKeyword } from '../title-keywords.mjs';

function normalizeList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value])
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {object|undefined} cfg - portals.yml `level_filter`
 * @returns {null | ((title: string) => boolean)} true = keep; null when disabled.
 */
export function buildLevelFilter(cfg) {
  if (!cfg || typeof cfg !== 'object' || cfg.enabled !== true) return null;
  const block = normalizeList(cfg.block).map((w) => compileKeyword(`word:${w.replace(/^word:/, '')}`));
  if (block.length === 0) return null;
  // Longest first, so "member of technical staff" is blanked before "technical staff".
  const exempt = normalizeList(cfg.exempt).sort((a, b) => b.length - a.length);

  return (title) => {
    let lower = String(title ?? '').toLowerCase();
    for (const phrase of exempt) lower = lower.split(phrase).join(' ');
    return !block.some((matches) => matches(lower));
  };
}
