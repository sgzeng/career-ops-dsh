// Fixture local parser for tests/content-rescue.test.mjs: one company whose
// every posting carries the same boilerplate ("zero-day", "ai agent"), plus a
// title-filter miss with a genuinely on-topic description. Offline; prints the
// local-parser JSON contract with descriptions (passed through since 2026-09-23).
const BOILERPLATE = 'Acme trains AI agent systems that find zero-day vulnerabilities in open source. '
  + 'We are a small team in San Francisco with a strong engineering culture and generous benefits. '
  + 'Our mission is to secure the world\'s software, and every role here contributes to it. ';
const pad = (s) => (BOILERPLATE + s + ' ').repeat(3);
const posted = new Date(Date.now() - 2 * 86400000).toISOString();
const job = (id, title, body) => ({
  title,
  url: `https://jobs.example.com/acme/${id}`,
  company: 'Acme Security',
  location: 'San Francisco, CA',
  postedAt: posted,
  description: pad(body),
});

console.log(JSON.stringify([
  job(1, 'Research Scientist, AI Secure Code',
    'Experience with vulnerability research, reverse engineering and exploitation. Develop agentic techniques and fuzz harnesses.'),
  job(2, 'Research Engineering Manager, Code Security',
    'Lead the team. Vulnerability research, reverse engineering, fuzz infrastructure, program analysis.'),
  job(3, 'Backend Engineer', 'Build APIs and data pipelines in Go.'),
  job(4, 'Product Designer', 'Design the dashboard.'),
  job(5, 'Frontend Engineer', 'Build the React app.'),
  job(6, 'Data Engineer', 'Own the warehouse.'),
  job(7, 'Security Engineer', 'Harden our cloud.'),
]));
