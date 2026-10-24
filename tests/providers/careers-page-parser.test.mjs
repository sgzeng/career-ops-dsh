// tests/providers/careers-page-parser.test.mjs
//
// Covers scripts/parsers/careers-page.mjs: the zero-token stage-1 parser for companies that
// list roles on their own site (no ATS), and confirms local-parser accepts the portals.yml
// entry shape. HTML is inline and trimmed from a real listing (General Analysis, 2026-10-19).
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from '../helpers.mjs';
import { normalizeParserJob } from '../../providers/local-parser.mjs';

console.log('\nParser — careers-page');

const mod = await import(pathToFileURL(join(ROOT, 'scripts/parsers/careers-page.mjs')).href);
const { extractRoleLinks, parseRolePage, pageAsJob, jobPostingsFromJsonLd } = mod;

const LISTING = `
<nav><a href="/about">About</a><a href="/about/careers">Careers</a><a href="/blog">Blog</a></nav>
<h2>Open roles</h2>
<a href="/about/careers/ai-cyber-researcher">View role</a>
<a href="/about/careers/research-engineer-post-training?utm=x#apply">View role</a>
<a href="https://generalanalysis.com/about/careers/research-engineer-post-training/">View role</a>
<a href='/about/careers/factotum'>Factotum</a>
<a href="mailto:jobs@generalanalysis.com">Mail</a>
<a href="#top">Top</a>`;
const LINK = /^\/about\/careers\/[a-z0-9-]+$/i;

// 1. extractRoleLinks: pattern, dedupe, query/fragment/trailing-slash folding, non-http dropped
{
  const links = extractRoleLinks(LISTING, 'https://generalanalysis.com/about/careers', LINK);
  const urls = links.map((l) => l.url);
  if (urls.length === 3) pass('three distinct role links (nav, mailto, anchor and duplicate dropped)');
  else fail(`expected 3 links, got ${JSON.stringify(urls)}`);
  if (urls.includes('https://generalanalysis.com/about/careers/research-engineer-post-training')) pass('query, fragment and trailing slash fold to one URL');
  else fail(`fold failed: ${JSON.stringify(urls)}`);
  if (!urls.includes('https://generalanalysis.com/about/careers')) pass('the listing page itself is not a role');
  else fail('listing page leaked in as a role');
  const ex = extractRoleLinks(LISTING, 'https://generalanalysis.com/about/careers', LINK, /factotum/i);
  if (ex.length === 2) pass('--exclude removes a matching role link');
  else fail(`exclude failed: ${ex.length}`);
}

// 2. parseRolePage: title from <title> minus the site suffix; description is page text
{
  const page = `<html><head><title>AI/Cyber Researcher | Careers | General Analysis</title></head>
    <body><h1>AI/Cyber Researcher</h1><p>Original CTF-style exploitation tasks and network attack simulations.</p></body></html>`;
  const r = parseRolePage(page, { defaultLocation: 'San Francisco, CA' });
  if (r.title === 'AI/Cyber Researcher') pass('title: <title> with the "| Careers | ..." suffix stripped');
  else fail(`title was ${JSON.stringify(r.title)}`);
  if (r.location === 'San Francisco, CA') pass('default location applied when the page states none');
  else fail(`location was ${JSON.stringify(r.location)}`);
  if (/CTF-style exploitation/.test(r.description)) pass('description carries the page text (feeds content_filter / content_rescue)');
  else fail('description missing');
}

// 3. JSON-LD JobPosting wins over the page title; location, date and remote handled
{
  const page = `<html><head><title>Careers | Acme</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme"},
    {"@type":"JobPosting","title":"Research Engineer, Cyber","datePosted":"2026-10-12T00:00:00Z",
     "description":"<p>Build cyber &amp; RL environments</p>",
     "jobLocation":{"@type":"Place","address":{"addressLocality":"San Francisco","addressRegion":"CA","addressCountry":"US"}}}]}</script>
    </head><body></body></html>`;
  if (jobPostingsFromJsonLd(page).length === 1) pass('JobPosting found inside an @graph');
  else fail('JobPosting not found in @graph');
  const r = parseRolePage(page);
  if (r.title === 'Research Engineer, Cyber' && r.location === 'San Francisco, CA, US' && r.postedAt === '2026-10-12' && /cyber & RL environments/.test(r.description)) pass('JSON-LD supplies title, location, date and entity-decoded description');
  else fail(`json-ld parse wrong: ${JSON.stringify(r)}`);
  const remote = parseRolePage(page.replace(/"jobLocation":\{.*?\}\}\}/s, '"jobLocationType":"TELECOMMUTE"}'));
  if (remote.location === 'Remote') pass('TELECOMMUTE with no place reads as Remote');
  else fail(`remote location was ${JSON.stringify(remote.location)}`);
}

// 4. A malformed JSON-LD block does not break the page
{
  const r = parseRolePage('<title>Founding Engineer | Acme</title><script type="application/ld+json">{oops</script>');
  if (r.title === 'Founding Engineer') pass('malformed JSON-LD falls back to <title>');
  else fail(`fallback title was ${JSON.stringify(r.title)}`);
}

// 5. pageAsJob: emitted only while the role title is still on the page
{
  const html = '<h1>Careers</h1><h2>Member of Technical Staff</h2><p>We use self-play and reinforcement learning to build cyber environments.</p>';
  const jobs = pageAsJob(html, 'https://www.incalmo.ai/careers/', 'Member of Technical Staff', { company: 'Incalmo', location: 'Menlo Park, CA' });
  if (jobs.length === 1 && jobs[0].company === 'Incalmo' && /reinforcement learning/.test(jobs[0].description)) pass('page-as-job emits one job with the page text');
  else fail(`page-as-job wrong: ${JSON.stringify(jobs)}`);
  if (pageAsJob('<h1>Careers</h1><p>No openings right now.</p>', 'https://www.incalmo.ai/careers/', 'Member of Technical Staff').length === 0) pass('page-as-job emits nothing once the role is gone');
  else fail('page-as-job kept a removed role');
}

// 6. local-parser accepts a parser row and keeps the description
{
  const row = normalizeParserJob(
    { title: 'AI/Cyber Researcher', url: '/about/careers/ai-cyber-researcher', company: 'General Analysis', location: 'San Francisco, CA', description: 'x'.repeat(30), postedAt: '2026-10-12' },
    { name: 'General Analysis', careers_url: 'https://generalanalysis.com/about/careers' },
  );
  if (row && row.url === 'https://generalanalysis.com/about/careers/ai-cyber-researcher' && row.description && row.postedAt) pass('local-parser normalizes a careers-page row (relative URL resolved, description and date kept)');
  else fail(`normalizeParserJob wrong: ${JSON.stringify(row)}`);
}

// 7. SSRF: the listing URL goes through the shared provider HTTP guard, so a private or
// link-local address is refused before any connection (exit 2, no JSON on stdout)
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/parsers/careers-page.mjs'), '--url', 'http://169.254.169.254/latest/meta-data/', '--link', 'x'], { encoding: 'utf8' });
  if (r.status === 2 && /non-public address/.test(r.stderr) && r.stdout === '') pass('metadata-service address refused (exit 2, nothing on stdout)');
  else fail(`SSRF guard did not hold: status=${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
}

// 8. Review fixes (2026-10-19): origin restriction, title precedence, date parsing, query, unquoted href
{
  const L = '<a href="https://evil.example/careers/x">A</a><a href=/careers/b>B</a><a data-href="/careers/z" href="/careers/c">C</a><a href="https://jobs.ashbyhq.com/acme/1">D</a>';
  const urls = (o) => extractRoleLinks(L, 'https://acme.com/careers', /careers\/[a-z]$|ashbyhq\.com\/acme/, null, o).map((l) => l.url);
  const a = urls({});
  if (a.length === 2 && a.every((u) => u.startsWith('https://acme.com/'))) pass('links to other hosts are ignored by default; unquoted href read; data-href not mistaken for href');
  else fail(`origin/unquoted wrong: ${JSON.stringify(a)}`);
  if (urls({ allowHosts: ['jobs.ashbyhq.com'] }).includes('https://jobs.ashbyhq.com/acme/1')) pass('--allow-host admits a named ATS host');
  else fail('allow-host ignored');
  const q = extractRoleLinks('<a href="/jobs?id=1">A</a><a href="/jobs?id=2">B</a>', 'https://a.com/jobs', /jobs\?id=/, null, { keepQuery: true });
  if (q.length === 2) pass('--keep-query keeps distinct ?id= roles apart');
  else fail(`keepQuery gave ${q.length}`);
  if (parseRolePage('<title>Careers | Acme</title><h1>Staff Engineer</h1>').title === 'Staff Engineer') pass('h1 beats a generic <title>');
  else fail('title precedence wrong');
  const d = (v) => parseRolePage(`<script type="application/ld+json">{"@type":"JobPosting","title":"X","datePosted":"${v}"}</script>`).postedAt;
  if (d('October 12, 2026') === '2026-10-12' && d('2026-10-12T10:00:00Z') === '2026-10-12' && d('garbage') === undefined) pass('datePosted: ISO kept, free-form parsed whole, junk dropped');
  else fail(`dates: ${d('October 12, 2026')} ${d('garbage')}`);
}

// 9. Several roles inline on one page (Theorem-style): one job each, own URL, own description
{
  const html = '<h2>Systems Engineer</h2><p>Deep expertise in systems and formal verification.</p><h2>ML Researcher</h2><p>Teach models to tackle hard software problems.</p>';
  const titles = ['Systems Engineer', 'ML Researcher'];
  const jobs = titles.flatMap((t) => pageAsJob(html, 'https://theorem.dev/careers/', t, { company: 'Theorem', siblings: titles }));
  if (jobs.length === 2 && jobs[0].url.endsWith('?role=systems-engineer') && /formal verification/.test(jobs[0].description) && !/Teach models/.test(jobs[0].description) && jobs[1].url !== jobs[0].url) pass('multi-role page: distinct URLs, descriptions split at the next title');
  else fail(`multi-role wrong: ${JSON.stringify(jobs)}`);
}

// 10. A role card built as <a><div>...long...</div></a> (Pensar-style) is still a link
{
  const card = '<a class="g" href="/careers/security-research-engineer"><div>' + '<span>x</span>'.repeat(400) + '</div></a>';
  const links = extractRoleLinks(card + card.replace('security-research-engineer', 'offensive-agent-engineer'), 'https://pensar.dev/careers', /^\/careers\/[a-z-]+$/);
  if (links.length === 2) pass('long nested anchor cards still yield role links');
  else fail(`nested anchors gave ${links.length}`);
}
