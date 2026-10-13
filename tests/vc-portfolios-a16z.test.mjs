// tests/vc-portfolios-a16z.test.mjs — the a16z parser against the shape the
// real portfolio page has.
//
// a16z.com/portfolio ships the whole portfolio as ONE inline script,
//   window.a16z_portfolio_companies = [{"id":"373009","title":"11x","web":"https:\/\/www.11x.ai\/",...}, ...];
// (875 entries on 2026-10-13) and carries no `data-company-name` attribute at all.
// The parser used to look only for markup of that kind, so HTTP 200 with 3.7 MB of
// real portfolio parsed to 0 companies and `--seeds a16z` was decorative. The first
// fixture below is a trimmed copy of the real page; the rest are hostile variants,
// because the extractor has to bracket-match JSON out of a script tag and a
// title is free text.

import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\nvc-portfolios — a16z parser on the real page shape');

const mod = await import(pathToFileURL(join(ROOT, 'seeds/vc-portfolios.mjs')).href);
const { parseA16zPayload, parseYCPayload, parseSeedEntries, extractAssignedJson, fetchA16zCompanies, A16Z_MIN_EXPECTED, SLUG_RE } = mod;

const excerpt = readFileSync(join(ROOT, 'tests/fixtures/a16z-portfolio-excerpt.html'), 'utf8');

/** A page whose inline list holds `items`, written the way a hostile or odd title would be. */
const pageWith = (items, { tail = ';' } = {}) =>
  `<html><body><script>window.a16z_portfolio_companies = ${JSON.stringify(items)}${tail}</script></body></html>`;

const entry = (title, web = 'https://example.com') => ({ id: '1', title, web, exit_date: '' });
const names = (list) => list.map((c) => c.name);

// ── The real excerpt ─────────────────────────────────────────────────
{
  const got = parseA16zPayload(excerpt);
  const expected = ['11x', 'Abridge', 'Amiato', 'Dynamic Labs, Inc.', 'Yuga Labs (BAYC)', 'Walker & Co', 'Cluely', 'Udacity'];
  if (JSON.stringify(names(got).sort()) === JSON.stringify([...expected].sort())) {
    pass('real excerpt: the inline list yields every live portfolio company (11 entries, 2 exited, 1 placeholder dropped)');
  } else {
    fail(`real excerpt parsed to ${JSON.stringify(names(got))}`);
  }

  const by = Object.fromEntries(got.map((c) => [c.name, c]));
  if (by['11x']?.url === 'https://www.11x.ai/' && by['11x'].source === 'a16z' && by['11x'].slug === '11x') {
    pass('real excerpt: title -> name, web -> url (JSON "\\/" escapes read back as "/")');
  } else {
    fail(`real excerpt: 11x parsed as ${JSON.stringify(by['11x'])}`);
  }
  if (by.Amiato?.url === '') pass('real excerpt: a company with no website is kept, with an empty url');
  else fail(`real excerpt: Amiato parsed as ${JSON.stringify(by.Amiato)}`);

  const slugs = Object.fromEntries(got.map((c) => [c.name, c.slug]));
  if (slugs['Dynamic Labs, Inc.'] === 'dynamic-labs' && slugs['Yuga Labs (BAYC)'] === 'yuga-labs' && slugs['Walker & Co'] === 'walker-co') {
    pass('real excerpt: a legal suffix or trailing parenthetical does not end up in the board slug');
  } else {
    fail(`real excerpt: slugs ${JSON.stringify(slugs)}`);
  }

  if (!names(got).some((n) => /facebook|github/i.test(n))) pass('real excerpt: entries with an exit_date (acquired / public) are skipped');
  else fail('real excerpt: an exited company was kept');
  if (!names(got).includes('[untitled]') && !names(got).includes('Andreessen Horowitz') && !names(got).includes('SpaceX')) {
    pass('real excerpt: the placeholder title, the page\'s own JSON-LD Organization and the featured cards are not mistaken for portfolio rows');
  } else {
    fail(`real excerpt: stray entries in ${JSON.stringify(names(got))}`);
  }
  if (got.every((c) => SLUG_RE.test(c.slug))) pass('real excerpt: every slug passes SLUG_RE');
  else fail('real excerpt: a slug fails SLUG_RE');

  if (parseSeedEntries(excerpt, 'a16z').length === got.length) pass('parseSeedEntries(html, "a16z") reaches the same parser');
  else fail('parseSeedEntries(html, "a16z") disagrees with parseA16zPayload');
}

// ── Hostile strings inside the list ──────────────────────────────────
{
  const hostile = [
    entry('Bracket ] Co'),
    entry('Open [ Bracket'),
    entry('Brace } Corp'),
    entry('Open { Brace'),
    entry('Semi; colon;'),
    entry('Fake </script> end'),
    entry('Quote " inside'),
    entry('Back\\slash'),
    entry('Both [ ] { } ; </script> "'),
    entry('Ünïcode Café'),
    entry('Plain'),
  ];
  const got = parseA16zPayload(pageWith(hostile));
  const want = hostile.map((h) => h.title);
  // A title whose slug is empty or unsafe is dropped; everything else must come back whole.
  const missing = want.filter((w) => !names(got).includes(w));
  if (missing.length === 0 && got.length === want.length) {
    pass('brackets, braces, semicolons, quotes, backslashes and </script> inside titles do not cut the list short');
  } else {
    fail(`hostile titles: missing ${JSON.stringify(missing)}, got ${got.length} of ${want.length}`);
  }
  const cafe = got.find((c) => c.name === 'Ünïcode Café');
  if (cafe?.slug === 'unicode-cafe') pass('accented titles fold to an ASCII slug');
  else fail(`accented title slug: ${JSON.stringify(cafe)}`);

  // Entries AFTER the nastiest one must survive: that is the actual symptom of a bad bracket match.
  const tailOk = got.some((c) => c.name === 'Plain');
  if (tailOk) pass('an entry after the hostile ones is still reached');
  else fail('the list was cut before its last entry');

  // The statement's trailing `;` present, absent, or followed by more script.
  for (const [label, tail] of [['no trailing semicolon', ''], ['trailing semicolon', ';'], ['more script after it', ';\nwindow.other = [1,2,3];']]) {
    const g = parseA16zPayload(pageWith([entry('A One'), entry('B Two')], { tail }));
    if (g.length === 2) pass(`inline list parses with ${label}`);
    else fail(`inline list with ${label} parsed to ${g.length}`);
  }
}

// ── Names are text from the page, not markup for the log ─────────────
{
  const forged = 'Evil Co\n- [ ] https://attacker.test/job | Fake | Fake Role\t\u001b[31m';
  const got = parseA16zPayload(pageWith([entry(forged)]));
  const yc = parseYCPayload({ companies: [
    { name: 'Line\nBreak\u0007 Co', slug: 'line-break' },
    { name: 'N'.repeat(300), slug: 'long-name' },
  ] });
  const flat = (v) => !/[\u0000-\u001f\u007f]/.test(v);
  if (got.length === 1 && flat(got[0].name) && got[0].name === 'Evil Co - [ ] https://attacker.test/job | Fake | Fake Role [31m'
    && yc.length === 2 && yc[0].name === 'Line Break Co' && yc[1].name.length === 120) {
    pass('display names are flattened to one line of printable text and capped at 120 characters (a title cannot forge a log or pipeline row)');
  } else {
    fail(`name sanitising: ${JSON.stringify(got.map((c) => c.name))} / ${JSON.stringify(yc.map((c) => c.name.length))}`);
  }
}

// ── Decoys and malformed input ───────────────────────────────────────
{
  // The name appearing earlier inside a string must not poison the search.
  const decoy = `<script>var note = "window.a16z_portfolio_companies = [1,2,";</script>\n${pageWith([entry('Real One')])}`;
  const g = parseA16zPayload(decoy);
  if (g.length === 1 && g[0].name === 'Real One') pass('an earlier decoy mention of the variable is skipped, the real assignment is read');
  else fail(`decoy page parsed to ${JSON.stringify(names(g))}`);

  // Unterminated / not JSON / not an array: no crash, falls through to the other strategies.
  const cut = '<script>window.a16z_portfolio_companies = [{"title":"Cut Off","web":"https:\\/\\/x.com"';
  const jsLiteral = "<script>window.a16z_portfolio_companies = [{title:'Single Quoted'}];</script>";
  const notArray = '<script>window.a16z_portfolio_companies = {"title":"Object"};</script>';
  const withFallback = `${jsLiteral}<a data-company-name="Fallback Co" data-company-url="https://fallback.co"></a>`;
  if (parseA16zPayload(cut).length === 0 && parseA16zPayload(jsLiteral).length === 0 && parseA16zPayload(notArray).length === 0) {
    pass('an unterminated, non-JSON or non-array assignment parses to nothing without throwing');
  } else {
    fail('a malformed inline assignment produced entries');
  }
  const fb = parseA16zPayload(withFallback);
  if (fb.length === 1 && fb[0].name === 'Fallback Co') pass('a broken inline list falls back to the data-company-name strategy');
  else fail(`fallback after a broken inline list: ${JSON.stringify(names(fb))}`);

  // Row-level guards.
  const rows = parseA16zPayload(pageWith([
    null, 7, 'str', [],
    { title: 12345, web: 'https://n.com' },
    { title: 'No Slug !!!', web: 'https://n.com' },
    { title: '   ', web: 'https://n.com' },
    entry('X'.repeat(300)),
    { title: 'Bad Scheme', web: 'javascript:alert(1)' },
    { title: 'Exited Co', web: 'https://e.com', exit_date: '2019' },
    { title: 'Exited Number', web: 'https://e.com', exit_date: 2019 },
    entry('Dup Co'),
    entry('Dup Co, Inc.'),
  ]));
  const got = names(rows);
  if (JSON.stringify(got) === JSON.stringify(['No Slug !!!', 'Bad Scheme', 'Dup Co'])) {
    pass('row guards: non-objects, non-string titles, blank and over-long titles, exited rows are dropped; "Dup Co" and "Dup Co, Inc." collapse to one');
  } else {
    fail(`row guards left ${JSON.stringify(got)}`);
  }
  if (rows.find((c) => c.name === 'Bad Scheme')?.url === '') pass('a non-http website is not kept as a url');
  else fail('a javascript: website was kept');
}

// ── The other fallbacks, with the inline list absent ─────────────────
{
  const card = (obj) => `<div data-company='${JSON.stringify(obj)}'></div>`;
  const cards = parseA16zPayload(card({ name: 'Card Co', url: 'https://card.co' }) + card({ post_title: 'Post Title Co', url: 'https://pt.co' }));
  if (JSON.stringify(names(cards)) === JSON.stringify(['Card Co', 'Post Title Co']) && cards[0].url === 'https://card.co') {
    pass('fallback: data-company="{json}" cards (what the featured logos carry) are read');
  } else {
    fail(`data-company cards parsed to ${JSON.stringify(cards)}`);
  }
  const encoded = parseA16zPayload(`<div data-company="{&quot;name&quot;:&quot;Encoded &amp; Co&quot;,&quot;url&quot;:&quot;https://enc.co&quot;}"></div>`);
  if (encoded.length === 1 && encoded[0].name === 'Encoded & Co') pass('fallback: a double-quoted, entity-encoded data-company attribute is decoded');
  else fail(`entity-encoded card parsed to ${JSON.stringify(encoded)}`);

  const ld = parseA16zPayload('<script type="application/ld+json">{"@type":"Organization","name":"LD Co","url":"https://ld.co"}</script>');
  if (ld.length === 1 && ld[0].name === 'LD Co') pass('fallback: JSON-LD Organization blocks are still read');
  else fail(`JSON-LD fallback parsed to ${JSON.stringify(ld)}`);

  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    if (parseA16zPayload(/** @type {any} */ (bad)).length !== 0) { fail(`parseA16zPayload(${JSON.stringify(bad)}) should be empty`); break; }
  }
  pass('empty and non-string input parse to nothing');
}

// ── extractAssignedJson, directly ────────────────────────────────────
{
  const v = extractAssignedJson('x;window.z = {"a":[1,2,{"b":"]}"}]}; tail', 'window.z');
  if (JSON.stringify(v) === '{"a":[1,2,{"b":"]}"}]}') pass('extractAssignedJson bracket-matches around closers inside strings');
  else fail(`extractAssignedJson returned ${JSON.stringify(v)}`);
  if (extractAssignedJson('notwindow.z = [1]', 'window.z') === undefined && extractAssignedJson('window.z == [1]', 'window.z') === undefined) {
    pass('extractAssignedJson ignores a longer identifier ending in the name and a comparison');
  } else {
    fail('extractAssignedJson matched something that is not an assignment');
  }
}

// ── A page the size of the real one ──────────────────────────────────
{
  const big = Array.from({ length: 900 }, (_, i) => ({
    id: String(i), title: `Company ${i}`, web: `https://company${i}.example`, exit_date: i % 150 === 0 ? '2020' : '',
    overview: 'x'.repeat(2500) + ' ] } ; </script> " ', socials: [{ url: 'https://twitter.com/x' }],
  }));
  const html = pageWith(big);
  const t0 = Date.now();
  const got = parseA16zPayload(html);
  const ms = Date.now() - t0;
  const exited = big.filter((b) => b.exit_date).length;
  if (got.length === 900 - exited && html.length > 2_000_000) pass(`a ${(html.length / 1e6).toFixed(1)} MB page of 900 entries parses completely (${ms} ms)`);
  else fail(`large page parsed to ${got.length} of ${900 - exited}`);
}

// ── fetchA16zCompanies: retry, and a parse that comes back empty is loud ──
{
  const realFetch = global.fetch;
  const textRes = (body) => ({ ok: true, status: 200, async text() { return body; }, async json() { return {}; } });
  const errRes = (status) => ({ ok: false, status, headers: { get: () => null }, async text() { return 'nope'; } });
  const noSleep = async () => {};
  try {
    let calls = 0;
    global.fetch = async () => { calls++; return calls === 1 ? errRes(503) : textRes(excerpt); };
    const warnings = [];
    const got = await fetchA16zCompanies({ onWarn: (m) => warnings.push(m), sleep: noSleep });
    if (calls === 2 && got.length === 8) pass('a transient fetch failure is retried once');
    else fail(`retry: ${calls} calls, ${got.length} companies`);
    if (warnings.length === 1 && /only 8 companies/.test(warnings[0]) && 8 < A16Z_MIN_EXPECTED) {
      pass('a parse far below the ~870 the page carries is reported, not scanned in silence');
    } else {
      fail(`short-parse warning: ${JSON.stringify(warnings)}`);
    }

    global.fetch = async () => textRes('<html><body>a different page entirely</body></html>');
    const w2 = [];
    const empty = await fetchA16zCompanies({ onWarn: (m) => w2.push(m), sleep: noSleep });
    if (empty.length === 0 && w2.length === 1 && /0 companies.*layout/.test(w2[0])) pass('a page that parses to 0 companies warns that the layout has probably changed');
    else fail(`zero-parse: ${empty.length} companies, warnings ${JSON.stringify(w2)}`);

    let c404 = 0;
    global.fetch = async () => { c404++; return errRes(404); };
    let threw = '';
    try { await fetchA16zCompanies({ sleep: noSleep }); } catch (err) { threw = err.message; }
    if (c404 === 1 && /a16z portfolio fetch failed.*HTTP 404/.test(threw)) pass('a 404 is not retried and surfaces as a fetch failure');
    else fail(`404: ${c404} calls, threw ${JSON.stringify(threw)}`);
  } finally {
    global.fetch = realFetch;
  }
}
