// tests/vc-portfolios-yc-walk.test.mjs — the YC pagination walk must not lose
// the rest of the portfolio quietly.
//
// The walk is 253 sequential requests (25 companies a page). It used to `break`
// on the first page that threw, and on the first empty one, and say nothing: 3 of
// 9 logged weekly runs scanned only 2,300 / 2,300 / 2,925 companies (37-47% of the
// portfolio) and the run summary read like a smaller portfolio. These tests pin
// the replacement behaviour: retry a failing page, move past one that stays bad,
// stop only on a run of bad pages, and report every gap with its page number and
// reason. (The happy-path walk is in vc-portfolios-yc-pagination.test.mjs.)
//
// A stubbed global.fetch serves the pages and an injected sleep keeps the backoff
// instant, so no network and no wall-clock waiting is involved.

import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nvc-portfolios — YC walk: retries, gaps and loud degradation');

const { fetchYCCompanies } = await import(pathToFileURL(join(ROOT, 'seeds/vc-portfolios.mjs')).href);
const realFetch = global.fetch;

const co = (n) => ({ name: `Co ${n}`, slug: `co-${n}` });
const pageBody = (page, total, perPage = 2) => ({
  page,
  totalPages: total,
  companies: Array.from({ length: perPage }, (_, i) => co(page * 100 + i)),
});

/**
 * Serve pages from `handler(page, attempt)` → { status, body, retryAfter }.
 * `attempt` counts requests for that page, from 1.
 */
function install(handler) {
  const requests = [];
  const attempts = new Map();
  global.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    const attempt = (attempts.get(page) ?? 0) + 1;
    attempts.set(page, attempt);
    requests.push(page);
    const { status = 200, body = {}, retryAfter = null } = handler(page, attempt) ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
      async json() { return body; },
      async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    };
  };
  return { requests, attempts };
}

async function walk(opts = {}) {
  const sleeps = [];
  const warnings = [];
  const diag = {};
  const companies = await fetchYCCompanies({
    sleep: async (ms) => { sleeps.push(ms); },
    onWarn: (m) => warnings.push(m),
    diag,
    ...opts,
  });
  return { companies, sleeps, warnings, diag };
}

const slugsOf = (list) => list.map((c) => c.slug);

try {
  // A healthy walk is unchanged: no warnings, no waiting, a clean diagnosis.
  {
    install((page) => ({ body: pageBody(page, 4) }));
    const { companies, sleeps, warnings, diag } = await walk();
    if (companies.length === 8 && warnings.length === 0 && sleeps.length === 0 && diag.pagesFetched === 4 && diag.pagesTotal === 4 && diag.truncated === false) {
      pass('a healthy walk reads every page with no warning and no backoff');
    } else {
      fail(`healthy walk: ${companies.length} companies, warnings ${JSON.stringify(warnings)}, sleeps ${sleeps.length}, diag ${JSON.stringify(diag)}`);
    }
  }

  // A page that fails twice and then answers is simply retried.
  {
    const { requests } = install((page, attempt) => (page === 2 && attempt <= 2 ? { status: 503 } : { body: pageBody(page, 3) }));
    const { companies, sleeps, warnings } = await walk();
    // 750 ms then 1.5 s between the attempts; the 250 ms is the pacing that follows a server error.
    if (companies.length === 6 && requests.join(',') === '1,2,2,2,3' && warnings.length === 0 && sleeps.join(',') === '750,1500,250') {
      pass('a page that fails twice with 503 and then answers is retried, backing off 750 ms then 1.5 s, with no warning');
    } else {
      fail(`retry: requests ${requests.join(',')}, ${companies.length} companies, warnings ${JSON.stringify(warnings)}, sleeps ${JSON.stringify(sleeps)}`);
    }
  }

  // A page that stays bad costs that page, not the rest of the walk.
  {
    const { requests } = install((page) => (page === 2 ? { status: 500 } : { body: pageBody(page, 4) }));
    const { companies, warnings, diag } = await walk();
    const got = slugsOf(companies);
    if (requests.join(',') === '1,2,2,2,3,4'
      && got.includes('co-100') && got.includes('co-300') && got.includes('co-400') && !got.includes('co-200')) {
      pass('a page that stays bad (3 attempts) is skipped and the walk goes on to pages 3 and 4');
    } else {
      fail(`skip: requests ${requests.join(',')}, got ${got.join(',')}`);
    }
    if (warnings.length === 1 && /skipped 1 page: 2 \(HTTP 500\)/.test(warnings[0]) && /about 25 companies were NOT scanned/.test(warnings[0])
      && diag.truncated === true && diag.failedPages.length === 1 && diag.failedPages[0].page === 2 && /HTTP 500/.test(diag.failedPages[0].reason)) {
      pass('the gap is reported with its page number and reason, and the walk is marked truncated');
    } else {
      fail(`gap warning: ${JSON.stringify(warnings)} diag ${JSON.stringify(diag)}`);
    }
  }

  // A run of bad pages means the API is down: stop, and say where.
  {
    const { requests } = install((page) => (page >= 3 ? { status: 502 } : { body: pageBody(page, 10) }));
    const { companies, warnings, diag } = await walk();
    const fetchedPages = [...new Set(requests)].join(',');
    if (companies.length === 4 && fetchedPages === '1,2,3,4,5' && diag.truncated === true) {
      pass('three bad pages in a row end the walk instead of grinding through the other 5');
    } else {
      fail(`run of bad pages: pages ${fetchedPages}, ${companies.length} companies, diag ${JSON.stringify(diag)}`);
    }
    if (warnings.length === 1 && /ended early/.test(warnings[0]) && /stopped at page 5/.test(warnings[0])
      && /2 of 10 pages/.test(warnings[0]) && /NOT scanned/.test(warnings[0]) && /3 \(HTTP 502\)/.test(warnings[0])) {
      pass('the early stop names the page it stopped at, how many pages were read of the total, and the bad pages');
    } else {
      fail(`early-stop warning: ${JSON.stringify(warnings)}`);
    }
  }

  // An empty page mid-walk is not the end of the list.
  {
    install((page) => (page === 2 ? { body: { page, totalPages: 3, companies: [] } } : { body: pageBody(page, 3) }));
    const { companies, warnings, diag } = await walk();
    const got = slugsOf(companies);
    if (got.includes('co-100') && got.includes('co-300') && diag.emptyPages.join(',') === '2'
      && warnings.length === 1 && /skipped 1 page: 2 \(empty\)/.test(warnings[0])) {
      pass('an empty page 2 of 3 is walked past and reported as empty, not taken for the end of the list');
    } else {
      fail(`empty mid-walk: got ${got.join(',')}, warnings ${JSON.stringify(warnings)}, diag ${JSON.stringify(diag)}`);
    }
  }

  // Every page after the first comes back empty: the response shape changed.
  {
    const { requests } = install((page) => (page === 1 ? { body: pageBody(1, 8) } : { body: { page, totalPages: 8, companies: [] } }));
    const { companies, warnings } = await walk();
    if (companies.length === 2 && Math.max(...requests) === 4 && warnings.length === 1 && /ended early/.test(warnings[0]) && /stopped at page 4/.test(warnings[0])) {
      pass('a run of empty pages ends the walk loudly (the API changed shape), after three of them');
    } else {
      fail(`all-empty: requests ${requests.join(',')}, warnings ${JSON.stringify(warnings)}`);
    }
  }

  // Page 1 failing is still fatal: there is nothing to scan.
  {
    install(() => ({ status: 500 }));
    let threw = '';
    try { await walk(); } catch (err) { threw = err.message; }
    if (/YC API fetch failed/.test(threw) && /HTTP 500/.test(threw)) pass('page 1 failing after its retries is fatal, as before');
    else fail(`page 1 failure threw ${JSON.stringify(threw)}`);
  }

  // A non-transient answer (404) is not retried.
  {
    const { attempts } = install((page) => (page === 2 ? { status: 404 } : { body: pageBody(page, 3) }));
    await walk();
    if (attempts.get(2) === 1) pass('a 404 page is not retried');
    else fail(`a 404 page was requested ${attempts.get(2)} times`);
  }

  // Retry-After is honoured, but a hostile value cannot stall the walk.
  {
    install((page, attempt) => (page === 2 && attempt === 1 ? { status: 429, retryAfter: '2' } : { body: pageBody(page, 2) }));
    const a = await walk();
    if (a.sleeps.join(',') === '2000' && a.companies.length === 4 && a.warnings.length === 0) pass('Retry-After: 2 on a 429 waits 2s before the retry');
    else fail(`Retry-After: sleeps ${a.sleeps.join(',')}`);

    install((page, attempt) => (page === 2 && attempt === 1 ? { status: 429, retryAfter: '86400' } : { body: pageBody(page, 2) }));
    const b = await walk();
    if (b.sleeps.length === 1 && b.sleeps[0] === 30_000) pass('a Retry-After of a day is capped at 30s');
    else fail(`capped Retry-After: sleeps ${b.sleeps.join(',')}`);
  }

  // After a throttle the remaining pages are spaced out; a healthy walk is not.
  {
    install((page, attempt) => (page === 2 && attempt === 1 ? { status: 429, retryAfter: '1' } : { body: pageBody(page, 4) }));
    const { sleeps } = await walk();
    // one Retry-After wait, then a 250ms gap before each of pages 3 and 4... and page 2's retry
    if (sleeps[0] === 1000 && sleeps.slice(1).every((ms) => ms === 250) && sleeps.length >= 3) {
      pass('after a 429 the remaining pages are paced (250 ms apart)');
    } else {
      fail(`pacing after a throttle: sleeps ${sleeps.join(',')}`);
    }
  }

  // Without totalPages, an empty page reached by following nextPage is the ordinary end.
  {
    install((page) => (page === 1
      ? { body: { page, companies: [co(1)], nextPage: 'page=2' } }
      : { body: { page, companies: [], nextPage: null } }));
    const { companies, warnings, diag } = await walk();
    if (companies.length === 1 && warnings.length === 0 && diag.truncated === false) pass('with no totalPages, an empty page at the end of the nextPage chain is not a warning');
    else fail(`no-total end: warnings ${JSON.stringify(warnings)}, diag ${JSON.stringify(diag)}`);
  }

  // Zero companies at all.
  {
    install(() => ({ body: { page: 1, totalPages: 1, companies: [] } }));
    const { companies, warnings } = await walk();
    if (companies.length === 0 && warnings.some((w) => /returned 0 companies/.test(w))) pass('a walk that returns 0 companies says so');
    else fail(`zero companies: warnings ${JSON.stringify(warnings)}`);
  }

  // The hard ceiling is a truncation, and says so.
  {
    install((page) => ({ body: { companies: [co(page)], page, nextPage: `page=${page + 1}` } }));
    const { companies, warnings, diag } = await walk({ maxPages: 3 });
    if (companies.length === 3 && diag.truncated === true && warnings.length === 1 && /hit the 3-page ceiling/.test(warnings[0])) {
      pass('stopping at the page ceiling while the API still advertises more is reported');
    } else {
      fail(`ceiling: ${companies.length} companies, warnings ${JSON.stringify(warnings)}`);
    }
  }
} finally {
  global.fetch = realFetch;
}
