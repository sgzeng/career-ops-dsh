// Fixture local parser for tests/level-filter.test.mjs: one board mixing
// Staff/Principal titles whose JDs do and don't clear the level rule, a flat
// "Member of Technical Staff" title, a dual-level req and a Staff title with no
// JD text. Offline: every URL is on jobs.example.com, which no JD fetcher claims.
const BOILERPLATE = 'Level Co builds security tooling for software teams. We offer competitive pay, '
  + 'health coverage, and a hybrid schedule in San Francisco. We are an equal opportunity employer '
  + 'and welcome applicants of every background. Our engineers work closely with product and research '
  + 'teams to ship defenses that hold up against real attackers. ';

const job = (id, title, description) => ({
  title,
  url: `https://jobs.example.com/levels/${id}`,
  company: 'Level Co',
  location: 'San Francisco, CA',
  ...(description ? { description } : {}),
});

console.log(JSON.stringify([
  job(1, 'Staff Security Engineer', `${BOILERPLATE}Minimum qualifications: 8+ years of experience in `
    + 'application security or security engineering. Experience with threat modeling. '
    + 'Preferred qualifications: PhD in Computer Science.'),
  job(2, 'Principal Security Engineer', `${BOILERPLATE}What you bring: 5+ years of experience in security `
    + 'engineering. You mentor engineers and lead design reviews. Nice to have: 10+ years of industry experience.'),
  job(3, 'Member of Technical Staff, Security Engineer', `${BOILERPLATE}Requirements: 10+ years of experience.`),
  job(4, 'Senior/Staff Security Engineer', `${BOILERPLATE}Requirements: 8+ years of experience.`),
  job(5, 'Security Engineer', `${BOILERPLATE}Requirements: 12+ years of experience.`),
  job(6, 'Staff Security Engineer, Platform', `${BOILERPLATE}Responsibilities: You will lead a team of four `
    + 'engineers and set its roadmap. Requirements: 5+ years of experience in platform security.'),
  job(7, 'Staff Product Security Engineer'),
]));
