// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Lever provider — hits the public postings endpoint.
// Auto-detects from careers_url via jobs.(eu.)?lever.co/<slug>.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

import { htmlToText, FULL_DESCRIPTION_CAP } from './_html-to-text.mjs';

const ALLOWED_LEVER_HOSTS = new Set(['api.lever.co', 'api.eu.lever.co']);

/** @param {string} url */
function assertLeverUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`lever: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`lever: URL must use HTTPS: ${url}`);
  if (!ALLOWED_LEVER_HOSTS.has(parsed.hostname))
    throw new Error(`lever: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_LEVER_HOSTS].join(', ')}`);
  return url;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  // Explicit api: wins — lets an entry keep a human-facing corporate
  // careers_url (e.g. https://www.coalfire.com/careers) while still pinning
  // the Lever postings board (mirrors greenhouse's api: precedence).
  if (entry.api) {
    assertLeverUrl(entry.api);
    return entry.api;
  }
  let url;
  try {
    url = new URL(entry.careers_url || '');
  } catch {
    return null;
  }
  const host = url.hostname.match(/^jobs\.((?:eu\.)?lever\.co)$/);
  if (!host) return null;
  const slug = url.pathname.split('/').filter(Boolean)[0];
  if (!slug) return null;
  return `https://api.${host[1]}/v0/postings/${slug}`;
}

/** Fold `categories.location` together with any extra `categories.allLocations`
 *  into one string. Lever puts a SINGLE primary city in `location`, and exposes
 *  the full set on multi-location postings in `allLocations` — reading only the
 *  former silently hides every other eligible location from scan.mjs's
 *  location_filter (e.g. a req open in Barcelona AND Montevideo looks
 *  Barcelona-only). Mirrors resolveLocation() in providers/remotli.mjs.
 *  @param {any} categories */
function resolveLocation(categories) {
  const primary = typeof categories?.location === 'string' ? categories.location.trim() : '';
  const all = Array.isArray(categories?.allLocations)
    ? categories.allLocations.filter(l => typeof l === 'string' && l.trim()).map(l => l.trim())
    : [];
  const merged = [];
  for (const l of [primary, ...all]) {
    if (l && !merged.some(m => m.toLowerCase() === l.toLowerCase())) merged.push(l);
  }
  return merged.join('; ');
}

/** `descriptionPlain` is only a posting's intro. Its responsibilities and
 *  requirements live in `lists[]` (heading `text` + HTML `content`) and the
 *  closing `additionalPlain` (measured on magnetforensics: ~2k chars of intro vs
 *  ~11k total), so content/visa filters reading only the intro missed them.
 *  A posting without lists or additional text maps to exactly its intro.
 *  @param {any} j */
function fullDescription(j) {
  const parts = [];
  if (typeof j.descriptionPlain === 'string') parts.push(j.descriptionPlain);
  if (Array.isArray(j.lists)) {
    for (const list of j.lists) {
      if (typeof list?.text === 'string') parts.push(list.text);
      if (typeof list?.content === 'string') parts.push(htmlToText(list.content, FULL_DESCRIPTION_CAP));
    }
  }
  if (typeof j.additionalPlain === 'string') parts.push(j.additionalPlain);
  return parts.map(p => p.trim()).filter(Boolean).join('\n').slice(0, FULL_DESCRIPTION_CAP);
}

/** @type {Provider} */
export default {
  id: 'lever',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`lever: cannot derive API URL for ${entry.name}`);
    assertLeverUrl(apiUrl);
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    if (!Array.isArray(json)) return [];
    return json.map(j => ({
      title: j.text || '',
      url: j.hostedUrl || '',
      company: entry.name,
      location: resolveLocation(j.categories),
      // Lever's v0 postings list ships the full description for free (same
      // payload, no per-job request) — enables scan.mjs content_filter.
      description: fullDescription(j),
      postedAt: typeof j.createdAt === 'number' ? j.createdAt : undefined,
    }));
  },
};
