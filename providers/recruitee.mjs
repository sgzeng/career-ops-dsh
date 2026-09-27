// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Recruitee provider — hits the public per-tenant offers API.
// Auto-detects from careers_url pattern `https://<slug>.recruitee.com`.
// Per-tenant subdomains are the variable part — SSRF defence uses a
// regex match on `<safe-slug>.recruitee.com` rather than a static
// allowlist.

import { htmlToText } from './_html-to-text.mjs';

const RECRUITEE_HOST_RE = /^[a-z0-9][a-z0-9-]*\.recruitee\.com$/;
// A `location` string that names no place — treated as absent (see parseRecruiteeResponse).
const PLACEHOLDER_LOCATION_RE = /^remote(?:\s+job)?$/i;

function assertRecruiteeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`recruitee: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`recruitee: URL must use HTTPS: ${url}`);
  if (!RECRUITEE_HOST_RE.test(parsed.hostname)) {
    throw new Error(`recruitee: untrusted hostname "${parsed.hostname}" — must match <slug>.recruitee.com`);
  }
  return url;
}

function resolveApiUrl(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!RECRUITEE_HOST_RE.test(parsed.hostname)) return null;
  return `https://${parsed.hostname}/api/offers/`;
}

/** @type {Provider} */
export default {
  id: 'recruitee',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`recruitee: cannot derive API URL for ${entry.name}`);
    assertRecruiteeUrl(apiUrl);
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    return parseRecruiteeResponse(json, entry.name);
  },
};

/**
 * Parse a Recruitee /api/offers/ response. Exported for unit tests.
 *
 * Recruitee returns:
 *   { offers: [{ title, careers_url?, url?, city?, country?, remote?, location? }] }
 *
 * - url: prefer `careers_url`, fall back to `url`. Recruitee tenants commonly
 *   serve postings on their own custom domain (e.g. `careers.hostaway.com`),
 *   so this URL is NOT host-locked to `*.recruitee.com`. Unlike the API
 *   endpoint, the per-offer URL is display-only — it is written to the pipeline
 *   and scan history but never server-fetched here, so the SSRF rationale does
 *   not apply. It is sourced from the already-validated tenant API response.
 *   Requirement: a well-formed `https:` URL; a non-HTTPS or malformed URL is
 *   dropped (empty string returned per the Job contract).
 * - location: prefer the explicit `location` field; else assemble from
 *   city/country, appending "Remote" when `remote` is true. A `location` that
 *   names no place ("Remote job") counts as absent: Aikido's remote offers in
 *   France, Saudi Arabia, Singapore … all read just "Remote job", which passed
 *   a US location filter on its bare "Remote" allow entry. Further entries of a
 *   multi-location offer's `locations[]` are appended ("; Chicago, United
 *   States"), so a Ghent role also open in Chicago is not dropped as Belgian.
 * - description: Recruitee's list payload embeds each offer's full HTML body
 *   for free (same request — verified against a live board), so it is
 *   stripped to plain text here and feeds scan.mjs's content_filter /
 *   visa_filter. Omitted when the offer carries no usable body.
 *
 * @param {any} json
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string, description?: string}>}
 */
export function parseRecruiteeResponse(json, companyName) {
  const offers = json?.offers;
  if (!Array.isArray(offers)) return [];
  return offers.map(j => {
    const city = j.city || '';
    const country = j.country || '';
    const remote = j.remote ? 'Remote' : '';
    const explicit = typeof j.location === 'string' ? j.location.trim() : '';
    const primary = explicit && !PLACEHOLDER_LOCATION_RE.test(explicit)
      ? explicit
      : [city, country, remote].filter(Boolean).join(', ');
    const seen = [primary.toLowerCase()];
    const extra = [];
    for (const l of Array.isArray(j.locations) ? j.locations : []) {
      if (!l || typeof l !== 'object') continue;
      const place = [l.city, l.country].filter(v => typeof v === 'string' && v.trim()).join(', ');
      const key = (typeof l.city === 'string' && l.city.trim() ? l.city : place).toLowerCase();
      if (!place || seen.some(s => s.includes(key))) continue;
      seen.push(place.toLowerCase());
      extra.push(place);
    }
    const location = [primary, ...extra].filter(Boolean).join('; ');
    const description = htmlToText(j.description);

    // Resolve offer URL. Recruitee tenants commonly publish postings on their
    // own custom domain (e.g. careers.hostaway.com), so the per-offer URL is
    // NOT host-locked to *.recruitee.com — it is display-only (recorded in the
    // pipeline/history, never server-fetched here) and comes from the already-
    // validated tenant API response. Require only a well-formed https: URL;
    // a non-https or malformed URL is dropped (empty string per the Job contract).
    let url = '';
    const rawUrl = j.careers_url || j.url || '';
    if (typeof rawUrl === 'string' && rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'https:') {
          url = parsed.href;
        }
      } catch {
        // malformed URL → leave url = ''
      }
    }

    return {
      title: j.title || '',
      url,
      location,
      company: companyName,
      ...(description ? { description } : {}),
    };
  });
}
