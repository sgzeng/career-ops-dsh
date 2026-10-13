# tests/

Auto-discovered test files for the career-ops suite.

## Purpose

`test-all.mjs` (repo root) is the suite runner: it executes its inline core
checks (syntax, scripts, dashboard, data contract, personal data, paths) and
then auto-discovers every `*.test.mjs` file under this directory. There is no
test framework by design — the suite must run on a fresh clone with only
Node.js (`tests/helpers.mjs`).

## Layout

- `helpers.mjs` — shared assertion helpers and counters. Exports `pass`,
  `fail`, `warn`, plus `ROOT` (repo root), `QUICK` (`--quick` flag), and
  `NODE` (current Node binary).
- `run-discovered-child.mjs` — not a suite. `test-all.mjs` starts it once per
  discovered suite when suites run in parallel (see "Parallel runs" below).
- `providers/{name}.test.mjs` — one file per scanner provider (see
  [providers/ADDING_A_PROVIDER.md](../providers/ADDING_A_PROVIDER.md) for the
  test pattern), plus shared cross-provider tests such as
  `ats-ssrf-hardening.test.mjs`.
  Underscore-prefixed files (e.g. `_html-entities.test.mjs`) test shared
  helper modules.
- Other `*.test.mjs` files at this level (e.g. `stats.test.mjs`) cover root
  scripts. Note: standalone `*.test.mjs` files in the repo root are not
  discovered and will not run — `tests/no-root-suites.test.mjs` fails the
  build if one shows up (see "Why the flat root" in ARCHITECTURE.md).
  A handful of `*-tests.mjs` suites do remain at the root (a flag-driven CI
  harness, a suite that asserts on its own filename, two needing a per-script
  timeout, and one added after the convention was written); those are registered in
  `test-all.mjs`'s `scripts` list or invoked by a workflow, and
  `root-tests-registration.test.mjs` asserts every one of them is reachable.

**Web tests do not live here.** `web/` runs its own `npm test` over
`web/tests/**/*.test.mjs` (see [../web/README.md](../web/README.md)); this
directory is for the core. The two suites also differ in style on purpose: web
suites use `node:test`, while suites here use the `pass`/`fail` helpers because
this suite must run on a bare clone with no framework — "not even `node:test`"
(#1440). Don't carry either style across the boundary.

The one exception to the split is a guard *about* web's layout —
`web-test-layout.test.mjs` lives here on purpose, because `web-ci.yml` is
informative by design and never blocks a merge, while `test-all.mjs` runs on
every PR as a required check.

## Running

```bash
node test-all.mjs                            # full suite — run before pushing
node test-all.mjs --quick                    # full suite, skip dashboard build
node test-all.mjs --only providers/themuse   # only matching tests/ files
node test-all.mjs --quick --jobs 4           # at most 4 suites at a time
```

Discovery walks `tests/` recursively, sorted lexicographically for a
deterministic cross-OS order. `--only` filters on the tests-relative path and
exits 1 when nothing matches (so a typo cannot turn CI green).

**`--only` is a dev convenience, not a PR gate:** it skips every inline core
section of `test-all.mjs`. A green `--only` run is not a green suite — always
run the full `node test-all.mjs` before pushing.

## Parallel runs

The files in this directory are most of a full run, so they run several at a
time, each in a process of its own. How many, in order of precedence:

| Setting | Scope |
|---------|-------|
| `--jobs N` | this run |
| `CAREER_OPS_TEST_JOBS=N` | this machine: a shell profile, a CI job |
| every available CPU | the default |

`--jobs 1` (or `CAREER_OPS_TEST_JOBS=1`) imports every suite into the runner's
own process, one after another, which is how the suite ran before `--jobs`
existed. A value that is not a positive integer is a usage error, not a
fallback to the default.

**What does not change.** The output is printed in discovery order whatever
finished first: each suite's output is held until its turn comes, so two runs
of the same tree print the same log. The totals and the exit code are the same
as a serial run's. The inline sections of `test-all.mjs` still run one after
another, before the discovered suites.

**What a suite must not rely on.** Running alone in a process is stricter than
running after 600 others in one:

- **Another suite's leftovers.** An environment variable, a module-level cache
  or a process-wide listener set by an earlier suite is not there. Set up what
  you need.
- **A fixed path.** Two suites writing the same file now do it at the same
  time. Use `mkdtempSync` for scratch space, never a constant name.
- **An open handle.** A server, watcher or timer you do not close keeps the
  process alive. The runner cuts the suite off a few seconds after it finishes
  and names it at the end of the run; close what you open.
- **Work you did not await.** Use top-level `await`. An error thrown from a
  timer after the suite has finished is reported as a failure of that suite.
- **A tight time limit.** With every core busy a suite takes noticeably longer
  than it does alone. A `node:test` suite gets four times its usual 30-second
  budget in a parallel run for that reason; a timeout inside a suite gets no
  such allowance.

**If a parallel run looks wrong**, rerun it with `--jobs 1`. A failure that
disappears there is one of the cases above, in the suite that failed or in one
it used to follow.

A suite that starts a `test-all.mjs` of its own gets a serial one unless it
passes `--jobs` itself: the runner sets `CAREER_OPS_TEST_JOBS=1` for everything
it starts, so N workers do not fan out N more each.

## Adding a test

Add one `{name}.test.mjs` file here — it is auto-discovered, no registration
needed. Do not add a section to `test-all.mjs`. Import the helpers with a
path relative to the test file's location:

```js
import { pass, fail, ROOT } from './helpers.mjs';    // tests/*.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';   // tests/providers/*.test.mjs
```

See `CONTRIBUTING.md` for the full contribution flow.
