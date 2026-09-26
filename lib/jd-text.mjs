// lib/jd-text.mjs — fetch a posting's JD text from its ATS, for the level
// filter (lib/level-filter.mjs), which must read the JD before it may drop a
// Staff/Principal-titled posting whose listing carried no description.
//
// Fork-local. Three routes, all zero-token and browser-free:
//   - SmartRecruiters public posting page → the public posting-detail API
//     (the provider only fetches details when an entry opts in, and caps them);
//   - LinkedIn job view → the public guest posting endpoint, the same no-login
//     API family scripts/parsers/linkedin-jobs.mjs searches with (the search
//     cards carry no description);
//   - Greenhouse / Lever / Ashby / Workday → browser-extract.mjs's
//     fetchJdViaKnownApi() (imported lazily, so a scan that never needs it
//     never loads it).
// Anything else returns null and the caller keeps the posting for stage 2.

import { htmlToText, FULL_DESCRIPTION_CAP } from '../providers/_html-to-text.mjs';
import { DEFAULT_USER_AGENT, BROWSER_LIKE_USER_AGENT } from '../user-agent.mjs';

export const JD_FETCH_TIMEOUT_MS = 15000;

// jobs.smartrecruiters.com/<Company>/<numericId>-<slug>
const SR_POSTING_RE = /^https?:\/\/jobs\.smartrecruiters\.com\/([A-Za-z0-9_-]+)\/(\d+)(?:-[^/?#]*)?(?:[/?#]|$)/;

export function smartRecruitersDetailUrl(url) {
  const m = SR_POSTING_RE.exec(String(url ?? ''));
  return m ? `https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}` : null;
}

// The provider's extractDescription() leads with the company blurb and caps at
// 4000 chars, which can cut off the qualifications; the level check needs the
// job's own sections in full.
export function smartRecruitersJobText(detail) {
  const sections = detail?.jobAd?.sections;
  if (!sections || typeof sections !== 'object') return '';
  const parts = ['jobDescription', 'qualifications', 'additionalInformation']
    .map((key) => sections[key]?.text)
    .filter((t) => typeof t === 'string' && t.trim());
  return parts.length ? htmlToText(parts.join('\n'), FULL_DESCRIPTION_CAP) : '';
}

// linkedin.com/jobs/view/<id> or /jobs/view/<slug>-<id>, any subdomain.
const LI_VIEW_RE = /^https?:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})(?:[/?#]|$)/i;

export function linkedInDetailUrl(url) {
  const m = LI_VIEW_RE.exec(String(url ?? ''));
  return m ? `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${m[1]}` : null;
}

// The guest posting page puts the JD in one "show-more-less-html__markup" div.
export function linkedInJobText(html) {
  const m = /class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(String(html ?? ''));
  return m ? htmlToText(m[1], FULL_DESCRIPTION_CAP) : '';
}

async function fetchText(url, { timeoutMs, fetchImpl, userAgent, accept }) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': userAgent, accept },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.ok ? res : null;
}

/**
 * @param {string} url - the posting URL as the scanner recorded it
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<string|null>} plain JD text, or null when no route applies or it failed
 */
export async function fetchJobDescription(url, { timeoutMs = JD_FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const sr = smartRecruitersDetailUrl(url);
  if (sr) {
    try {
      const res = await fetchText(sr, { timeoutMs, fetchImpl, userAgent: DEFAULT_USER_AGENT, accept: 'application/json' });
      return res ? smartRecruitersJobText(await res.json()) || null : null;
    } catch {
      return null;
    }
  }
  const li = linkedInDetailUrl(url);
  if (li) {
    try {
      const res = await fetchText(li, { timeoutMs, fetchImpl, userAgent: BROWSER_LIKE_USER_AGENT, accept: 'text/html' });
      return res ? linkedInJobText(await res.text()) || null : null;
    } catch {
      return null;
    }
  }
  try {
    const { fetchJdViaKnownApi } = await import('../browser-extract.mjs');
    const result = await fetchJdViaKnownApi(url, 20000, timeoutMs);
    return typeof result?.text === 'string' && result.text.trim() ? result.text : null;
  } catch {
    return null;
  }
}
