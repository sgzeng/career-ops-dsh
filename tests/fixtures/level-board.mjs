// Fixture local parser for tests/level-filter.test.mjs: one board mixing level
// words, a flat "Member of Technical Staff" title and a dual-level req. Offline.
const job = (id, title) => ({
  title,
  url: `https://jobs.example.com/levels/${id}`,
  company: 'Level Co',
  location: 'San Francisco, CA',
});

console.log(JSON.stringify([
  job(1, 'Staff Security Engineer'),
  job(2, 'Principal Security Engineer'),
  job(3, 'Member of Technical Staff, Security Engineer'),
  job(4, 'Senior/Staff Security Engineer'),
  job(5, 'Security Engineer'),
]));
