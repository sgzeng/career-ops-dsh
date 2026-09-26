// Fixture local parser for tests/first-scan-backfill.test.mjs: one board whose
// postings are dated relative to NOW (2, 20, 40 and 60 days old), so a
// `--since 14` scan and a 45-day first-coverage pass see different subsets.
// Offline: every URL is on jobs.example.com. BACKFILL_FIXTURE switches variants
// without changing the parser's argv (argv is part of the backfill key):
//   second → adds a 1-day and a 25-day posting (the 25-day one must NOT pass a
//            normal --since 14 run once the company has its row)
//   empty  → []            fail → exit 1
const variant = process.env.BACKFILL_FIXTURE || '';
if (variant === 'fail') {
  console.error('fixture: simulated provider failure');
  process.exit(1);
}
const DAY = 86_400_000;
const job = (id, daysOld) => ({
  title: `Security Engineer ${id}`,
  url: `https://jobs.example.com/backfill/${id}`,
  company: 'Backfill Co',
  location: 'San Francisco, CA',
  postedAt: new Date(Date.now() - daysOld * DAY).toISOString(),
});
const jobs = variant === 'empty' ? [] : [job('d2', 2), job('d20', 20), job('d40', 40), job('d60', 60)];
if (variant === 'second') jobs.push(job('d1', 1), job('d25', 25));
console.log(JSON.stringify(jobs));
