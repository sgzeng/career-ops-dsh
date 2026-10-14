# seeds/ — VC Portfolio Seed Fetchers

A complementary discovery path for startup job-seekers: pull a **public VC portfolio company list** and probe each company's ATS for openings, feeding results into the same pipeline as tracked companies in `portals.yml`.

## What this does

`scan-ats-full.mjs` normally discovers companies by walking public ATS directories (Greenhouse, Lever, Ashby, Workday). The `seeds/` layer adds a **high-signal starting point for startup roles**: rather than waiting for companies to appear in ATS directories, we seed the universe from well-known VC portfolios — giving you instant coverage of hundreds of YC/a16z-backed companies.

Flow:
```
VC portfolio API/page
    ↓ seeds/vc-portfolios.mjs
SeedCompany[]            (YC: hiring-first order; a16z: exited companies dropped)
    ↓ toPortalCandidates()
Candidate boards         (Ashby, Greenhouse, Lever x the slug spellings worth trying)
    ↓ seeds/seed-probe.mjs  probeSeedCompany() — per-host cap + spacing, remembered 404s
First board with postings wins
    ↓ title_filter / location_filter / content_filter / level_filter / dedup (unchanged)
data/pipeline.md
```

A portfolio names companies, not boards, so each company is asked about on
**Ashby, Greenhouse and Lever** (in that order — on a 120-company YC sample,
boards with open postings were Ashby 9, Greenhouse 5, Lever 2). The first board
that answers with postings ends the search for that company. A board that
answers with none is remembered but the search goes on, since a vendor keeps an
old empty board answering after a company moves.

Slug spellings: YC companies are asked under their YC slug only (21 alternative
spellings of 16 boardless companies were probed and none answered). a16z has just
a display title, so it also tries the title with separators dropped
(`scale-ai` → `scaleai`) and the website's domain label (`scale.com` → `scale`).

## Usage

### Via scan-ats-full.mjs (recommended)

```bash
# Seed from Y Combinator portfolio, last 7 days
node scan-ats-full.mjs --seeds yc --since 7

# Seed from both YC and a16z, dry-run preview
node scan-ats-full.mjs --seeds yc,a16z --dry-run

# Combine seeds + regular ATS sources
node scan-ats-full.mjs --seeds yc --ats greenhouse,lever --since 5

# npm shortcuts
npm run scan:seeds   # yc + a16z
npm run scan:yc      # YC only
```

### Programmatic

```js
import { fetchYCCompanies, fetchA16zCompanies, toPortalEntry, SEED_SOURCES } from './seeds/vc-portfolios.mjs';

// Fetch YC companies
const companies = await fetchYCCompanies();
console.log(companies[0]);
// → { name: 'Stripe', slug: 'stripe', url: 'https://stripe.com', source: 'yc', batch: 'W11' }

// Convert to a PortalEntry for ATS provider.detect()
const entry = toPortalEntry(companies[0]);
// → { name: 'Stripe', careers_url: 'https://job-boards.greenhouse.io/stripe', source: 'yc' }

// Using the registry
for (const [id, source] of Object.entries(SEED_SOURCES)) {
  const companies = await source.fetch();
  console.log(`${source.label}: ${companies.length} companies`);
}
```

## Data sources

| Source | URL | Format | Auth |
|--------|-----|--------|------|
| Y Combinator | `https://api.ycombinator.com/v0.1/companies` | JSON API | None |
| a16z | `https://a16z.com/portfolio/` | Public HTML page | None |

- **YC**: walks the API page by page (253 pages × 25 companies as of 2026-10; `per_page` is ignored). A failing page is retried twice (honouring `Retry-After`), then skipped, and the walk goes on; three bad pages in a row end it. Either way the run says so, with the page numbers and reasons — a walk that stopped at 37% of the portfolio used to look like a smaller portfolio. YC's `isHiring` badge and company status set the probe order (below).
- **a16z**: the page ships the whole portfolio as one inline script, `window.a16z_portfolio_companies = [{"title":"11x","web":"https:\/\/www.11x.ai\/","exit_date":"",...}, ...];` (875 entries on 2026-10-13). The parser bracket-matches and JSON-parses it, skipping entries with an `exit_date` (acquired or public). If that list ever disappears it falls back to JSON-LD, `data-company-name`, the featured cards' `data-company='{json}'`, and card anchors, and a parse that returns far fewer than ~870 companies is reported as a likely layout change. The page itself is covered by a trimmed real excerpt in `tests/fixtures/a16z-portfolio-excerpt.html`.

## What a run remembers

`data/seed-dead-boards.tsv` and `data/seed-live-boards.tsv` (user layer, safe to delete). Without them every weekly run re-asks ~6k YC slugs about each vendor, all of which 404 again.

- A 404 on (vendor, slug) is remembered and not re-asked until it comes due, 15–45 days later (30 ± 50%, a stable per-slug offset, so ~a fifth of the dead set rotates back in each week rather than all of it on one day). A slug that is still 404 on the re-ask is trusted 2× as long, then 3×.
- Only a 404 means "no such board". A 429, 403, 5xx or timeout leaves the board unknown and is **not** remembered, so a throttled run does not blacklist anything.
- The vendor a live company resolved to is asked first next time.
- `--refresh-seed-cache` ignores the memory for the run (asks everything, follows no hint) and writes the results back. `--dry-run` reads the memory but never writes it.

## Request discipline

Six requests in flight per API host (`SINGLE_HOST_CONCURRENCY`, the same cap the directory sweep uses on these hosts) and at least 50 ms between request starts to a host (`CAREER_OPS_SEED_HOST_GAP_MS`, `0` turns it off), instead of 20 workers on one host. A 429/403 pauses that host for its `Retry-After` (else 15 s, doubling to 120 s); ten in a row abandon the host for the rest of the run, loudly, and its remaining probes are reported as skipped rather than as dead boards.

## What a posting must pass

Postings found on a seed company's board go through the filters the directory sweep applies, which are `scan.mjs`'s: date, title, `skip_tiers`, location, content, `country_eligibility_filter`, `visa_filter`, the level ceiling, the blacklist, and the URL and company+title duplicate checks (`scan-ats-full.mjs`: `firstRejectingFilter`, `createRoleDedup`). The summary's `Filtered by tier / visa / country` and `Duplicate roles` lines add the seed scan's drops to the sweep's; `--json` has them per seed under `seeds.<id>.gated`.

## Reading the summary

```
Unreachable boards: 17512
  seed boards:      404 17,401 | 403 0 | 429 0 | 5xx 3 | timeout/network 108 | other 0
Seed yc:          6,287 companies | 312 live (ashby 160 / greenhouse 90 / lever 62), 20 empty, 5,900 dead, 55 unknown | ...
⚠️  Seed yc: YC walk skipped 1 page: 93 (HTTP 429) — about 25 companies were NOT scanned (252 of 253 pages read)
```

`404` is the expected answer for nearly every guessed slug; `403` and `429` are a host refusing; `timeout/network` learned nothing about the board. **unknown** companies (no board found, at least one probe failed for a reason other than 404) are retried next run. `--json` carries the same figures under `seeds.<id>`.

### Probe order

`--limit` and an interrupted run keep what was probed first. YC companies with the `isHiring` badge go first and inactive ones last; nothing is dropped. Measured on 120 YC companies, 15 of which had a board with open postings: 8 carried the badge and 7 did not (so a filter would have lost 7 of 15), yet 8 of the 31 badged companies had a live board against 7 of 89 unbadged. Acquired companies had a live board as often as active ones (4 of 15 vs 11 of 93).

## Security

- All slugs — the portfolio's own, the separator-free spelling and the website's domain label — are validated against `SLUG_RE = /^[A-Za-z0-9._-]+$/` (and a 100-character cap) before any URL interpolation, consistent with the guard in `scan-ats-full.mjs`.
- Each candidate URL must be accepted by its provider's `detect()` (which pins the vendor's own API host) before anything is fetched.
- No authentication tokens, no headless browser, no LLM API calls.

## Adding more VC portfolios

1. Add a `parseXyzPayload(payload)` pure function (no network — testable with inline fixtures).
2. Add a `fetchXyzCompanies(opts?)` async function that calls the public endpoint and returns `SeedCompany[]`.
3. Register it in `SEED_SOURCES`:

```js
export const SEED_SOURCES = {
  yc: { fetch: fetchYCCompanies, label: 'Y Combinator Portfolio' },
  a16z: { fetch: fetchA16zCompanies, label: 'Andreessen Horowitz (a16z) Portfolio' },
  // Add yours:
  sequoia: { fetch: fetchSequoiaCompanies, label: 'Sequoia Portfolio' },
};
```

4. Add a discovered test (`tests/*.test.mjs`) covering your `parseXyzPayload()` function against a real, trimmed excerpt of the source (see `tests/vc-portfolios-a16z.test.mjs`). A hand-written fixture that guesses the markup is how the a16z parser came to return 0 from a real page.

## Prior art

The VC-portfolio seeding approach is inspired by [adityachaudhary99/job-hunt](https://github.com/adityachaudhary99/job-hunt) (`02-seeds/fetch_yc.py`, `fetch_a16z.py`), which was the original companion reference cited in issue #1370.
