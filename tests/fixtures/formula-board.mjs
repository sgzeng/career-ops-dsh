// Fixture local parser for tests/scan-history-formula-roundtrip.test.mjs: one
// board whose titles and company start with a spreadsheet-formula character
// (= + - @) or with an apostrophe followed by one. scan-history.tsv stores such
// a cell with a leading apostrophe (lib/tsv-formula-escape.mjs), and every
// reader has to undo it. FORMULA_URL_SUFFIX changes the URLs between runs so the
// second run can only be recognised as a duplicate by company+role, which is read
// back from the history rows. Offline: every URL is on jobs.example.com.
const suffix = process.env.FORMULA_URL_SUFFIX || 'a';
const posted = new Date(Date.now() - 2 * 86400000).toISOString();
const job = (id, title, company = '@Formula Labs') => ({
  title,
  url: `https://jobs.example.com/formula/${id}-${suffix}`,
  company,
  location: 'San Francisco, CA',
  postedAt: posted,
});

console.log(JSON.stringify([
  job(1, '=Security Engineer Alpha'),
  job(2, '+Security Engineer Beta'),
  job(3, '-Security Engineer Gamma'),
  job(4, '@Security Engineer Delta'),
  job(5, "'-Security Engineer Epsilon"),
  job(6, 'Security Engineer Zeta'),
  job(7, '=Security Engineer Eta', '=Cmd Corp'),
]));
