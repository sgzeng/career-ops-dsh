// tests/fixtures/identity-twins-board.mjs — a local-parser fixture board.
//
// The shape of the 2026-10-08 LinkedIn run: copies of roles the tracker or the
// scan history already hold, each under a DIFFERENT spelling of the same
// employer or the same title, plus controls that must still come through.
// Used by tests/scan-dedup-company-aliases.test.mjs; no network involved.
//
// local-parser requires the script to live inside the project root and reads a
// JSON array off stdout.
const li = (id, company, title, location = 'United States') => ({
  title, company, location, url: `https://www.linkedin.com/jobs/view/${id}`,
});

console.log(JSON.stringify([
  // Twins of tracked / seen roles: all must be dropped as duplicates.
  li(4438815745, 'TrendAI', 'Vulnerability Researcher - Global (All Levels)'),
  li(4326377987, 'Anthropic', 'Research Engineer, Cybersecurity RL (Reinforcement Learning)', 'New York, NY'),
  li(4461931489, 'NVIDIA', 'Senior Offensive Security Engineer, Vulnerability Operations', 'Virginia, United States'),
  // Controls: genuinely different openings, all must be kept.
  // "(Reinforcement Learning)" here is the team, not the expansion of an acronym in the title.
  li(4500000001, 'Anthropic', 'Research Engineer, Machine Learning (Reinforcement Learning)', 'New York, NY'),
  // A team qualifier is information: the tracker holds the bare Principal Security Researcher.
  li(4500000002, 'Palo Alto Networks', 'Principal Security Researcher (Decoder)', 'Santa Clara, CA'),
  // Same title and employer as a seen Workday row, but another requisition.
  {
    title: 'Vulnerability Researcher - Global (All Levels)',
    company: 'TrendAI (Trend Micro)',
    location: 'US Off-Site',
    url: 'https://trendmicro.wd3.myworkdayjobs.com/External/job/US-Off-Site/Vulnerability-Researcher---Global--All-Levels-_R0000777',
  },
  li(4500000003, 'Zeta Labs', 'Security Researcher, Fuzzing'),
]));
