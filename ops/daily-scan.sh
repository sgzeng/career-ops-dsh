#!/bin/bash
# daily-scan.sh — stage 1 of the daily job scan. Runs NATIVELY on macOS.
#
# This is the zero-token half, all of it talking straight to public ATS JSON
# APIs (Greenhouse / Ashby / Lever / Workday) — no Claude, no API cost:
#
#   1. scan.mjs           — the curated watchlist in portals.yml → tracked_companies.
#   2. verify-portals.mjs — re-probes every tracked slug (silent-404 catcher).
#      Then a read-only health digest (detect-reposts, stats; monthly on the
#      first week: filter-audit, close-stale dry run, reeval-candidates,
#      audit-portals). Advisory only: a failure logs WARN and never stops the scan.
#   3. discover-ats.mjs against data/seeds/*.yml — resolves any seed list
#      (e.g. conference sponsors, a VC portfolio) to real ATS boards and
#      promotes the ones that resolve into portals.yml → tracked_companies, so
#      they join step 1's zero-token scan from then on.
#   4. scan-ats-full.mjs --ats greenhouse,ashby,lever — reverse discovery over
#      the FULL public ATS directory (Feashliaa/job-board-aggregator): every
#      board that dataset lists, matched against the SAME title_filter /
#      location_filter / level_filter in portals.yml, so companies nobody
#      curated surface. One invocation per ATS under a hard time limit.
#   5. scan-ats-full.mjs --seeds yc,a16z — reverse discovery over the YC and
#      a16z portfolios, same filters.
#
# All of them append to data/pipeline.md and data/scan-history.tsv.
#
# THE ORDER IS DELIBERATE. Steps 4 and 5 are the heavy bursts (thousands of
# requests to boards-api.greenhouse.io / api.lever.co / api.ashbyhq.com; the
# YC seed sweep runs 20 wide against ONE host). They used to run right after
# scan.mjs and BEFORE verify-portals, and in 4 of the 6 logged runs that swept
# ~6,200 YC companies, verify-portals then met 1-17 HTTP 403s on Greenhouse
# boards that answered 200 later in the same run (12 of 13 on Oct 8; data/logs,
# Sep 7 - Oct 8). Nothing here proves a Greenhouse rate limit, but nothing that
# needs a clean answer from those hosts should run after a burst, so the bursts
# go last, the polite one (6 wide, step 4) before the aggressive one (step 5).
#
# Stage 2 (triage + A-G scoring + tracker + HTML) is the scheduled Claude task:
# it runs `/career-ops pipeline` over the data/pipeline.md this wrote, then
# WebSearches the portals.yml `scan_method: websearch` companies into the same
# pipeline, then `node roles/render-roles-html.mjs`. See modes/_custom.md
# (the scoring ruleset).
#
# Environment (all optional):
#   CAREER_OPS_FULL_SWEEP=0               skip step 4 entirely (default: on)
#   CAREER_OPS_FULL_SWEEP_ATS="a b c"     which directories, in order
#                                         (default: greenhouse ashby lever)
#   CAREER_OPS_FULL_SWEEP_SINCE=14        posting window in days (default 14,
#                                         twice the weekly cadence: a skipped
#                                         week or a killed sweep is re-covered
#                                         by the overlap, dedup makes it free)
#   CAREER_OPS_FULL_SWEEP_STEP_SECS=600   hard limit for ONE directory
#   CAREER_OPS_FULL_SWEEP_BUDGET_SECS=900 hard limit for step 4 as a whole, so
#                                         stage 1 ends before stage 2 starts
#   CAREER_OPS_TIMEOUT_IMPL=auto          auto | timeout | perl | none — how the
#                                         limit is enforced (see run_limited)
#
# Run by hand:   ./ops/daily-scan.sh   (from the career-ops root)
# Or on a timer: see ops/daily-scan.plist.example (launchd, macOS)

set -uo pipefail
# This script lives in career-ops/ops/; every path below is relative to the
# career-ops root, so step up one level from the script's own directory.
cd "$(dirname "$0")/.." || exit 1

LOG_DIR="data/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/scan-$(date +%Y-%m-%d).log"

# run_limited <seconds> <command...> — run a command under a wall-clock limit
# and return its exit status (124/137 from timeout, 142 from the perl alarm).
# macOS ships neither `timeout` nor `gtimeout` (both are Homebrew coreutils),
# but it always ships perl, and an alarm() armed before exec survives the exec
# and ends the process with SIGALRM — one process, no watchdog left behind.
# A killed scan-ats-full run is not a lost one: on SIGTERM (timeout) or SIGALRM
# (the perl alarm) it appends the matches it already has to pipeline.md and
# scan-history.tsv before it exits. Only the -k SIGKILL that timeout sends 15s
# later, if the flush has not finished, loses them. Step 4 still runs one
# directory per invocation, so one hung directory costs the rest of that
# directory and nothing else.
run_limited() {
  local secs=$1
  shift
  local impl="${CAREER_OPS_TIMEOUT_IMPL:-auto}"
  if [ "$impl" = "auto" ]; then
    if command -v timeout >/dev/null 2>&1; then impl=timeout
    elif command -v gtimeout >/dev/null 2>&1; then impl=gtimeout
    elif command -v perl >/dev/null 2>&1; then impl=perl
    else impl=none
    fi
  fi
  case "$impl" in
    timeout|gtimeout) "$impl" -k 15 "$secs" "$@" ;;
    perl) perl -e 'alarm shift; exec @ARGV or die "exec $ARGV[0]: $!\n"' "$secs" "$@" ;;
    *)
      echo "WARN: no timeout, gtimeout or perl found — running without a time limit"
      "$@"
      ;;
  esac
}

# digits_or <value> <default> — the value as a plain decimal when it is a
# positive integer of at most 9 digits, else the default. A typo in an env var
# must not reach the arithmetic below as-is: bash reads "08" as a bad octal
# number and a non-interactive shell exits on it, ending the whole scan.
digits_or() {
  case "$1" in
    ''|*[!0-9]*|??????????*) echo "$2" ;;
    *)
      local n=$((10#$1))
      if [ "$n" -gt 0 ]; then echo "$n"; else echo "$2"; fi
      ;;
  esac
}

{
  echo "=== career-ops daily scan — $(date '+%Y-%m-%d %H:%M:%S %Z') ==="

  # Keep node on PATH under launchd, which does not source your shell profile.
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

  if ! command -v node >/dev/null 2>&1; then
    echo "FATAL: node not on PATH. Fix the PATH line above to point at your node."
    exit 1
  fi

  echo "--- portals.yml schema preflight ---"
  node validate-portals.mjs || echo "WARN: portals.yml has schema issues (see above) — scanning anyway"

  # Known titles/locations that must (not) pass the filters; catches a config
  # edit that silently drops a class of roles. WARN only, never blocks the scan.
  echo "--- filter regression fixtures ---"
  node ops/check-config-regression.mjs || echo "WARN: filter regression fixtures failed (see above) — scanning anyway"

  # Windows are wider than the weekly cadence on purpose: a run that fires late
  # (Mac asleep) or a skipped week must not leave jobs unreachable. Overlap is
  # free — only `added` rows reach scan-history.tsv, so re-seen jobs dedup.
  echo "--- node scan.mjs --since 14 (curated watchlist) ---"
  node scan.mjs --since 14 --quiet
  echo "scan.mjs exit=$?"

  # Re-probe every tracked slug so a silently-404ing board gets caught.
  # This script runs weekly (Mondays), so this runs once a week.
  echo "--- slug sweep: verify-portals.mjs ---"
  node verify-portals.mjs
  echo "verify-portals.mjs exit=$?"

  # Health digest. Every tool here only reads (close-stale without --confirm is
  # a dry run), so a failure is a WARN line and nothing else. The monthly block
  # runs in the first week of the month; CAREER_OPS_MONTHLY_DIGEST=1 forces it.
  echo "--- health digest: detect-reposts ---"
  node detect-reposts.mjs --summary || echo "WARN: detect-reposts.mjs failed"
  echo "--- health digest: stats ---"
  node stats.mjs --summary || echo "WARN: stats.mjs failed"
  if [ "$(date +%d)" -le 7 ] || [ "${CAREER_OPS_MONTHLY_DIGEST:-0}" = "1" ]; then
    echo "--- monthly digest: filter-audit ---"
    node filter-audit.mjs --summary || echo "WARN: filter-audit.mjs failed"
    echo "--- monthly digest: close-stale (dry run) ---"
    node close-stale.mjs --summary || echo "WARN: close-stale.mjs failed"
    echo "--- monthly digest: reeval-candidates ---"
    node reeval-candidates.mjs --status Evaluated,Applied --summary || echo "WARN: reeval-candidates.mjs failed"
    echo "--- monthly digest: audit-portals (network, one fetch per enabled board) ---"
    audit_prev="data/portal-audit.json"
    audit_args=(--json)
    [ -f "$audit_prev" ] && audit_args+=(--baseline "$audit_prev")
    if node audit-portals.mjs "${audit_args[@]}" > "$audit_prev.tmp"; then
      mv "$audit_prev.tmp" "$audit_prev"
    else
      rm -f "$audit_prev.tmp"
      echo "WARN: audit-portals.mjs failed; baseline kept at $audit_prev"
    fi
  fi

  # Resolve any seed list in data/seeds/ (e.g. Black Hat sponsors) against live
  # ATS boards and promote hits into portals.yml. --write is additive and
  # idempotent (discover-ats.mjs dedupes by slug), so this is safe to run
  # unattended on every scan.
  for seed in data/seeds/*.yml; do
    [ -f "$seed" ] || continue
    echo "--- seed resolution: discover-ats.mjs --in $seed --write ---"
    node discover-ats.mjs --in "$seed" --write --summary
    echo "discover-ats.mjs --in $seed exit=$?"
  done

  # Reverse discovery over the whole public ATS directory. One invocation per
  # directory: a hang or a kill costs one directory's matches, not all three,
  # and each leaves its own header and exit= line. Highest yield per request
  # first (measured 2026-10-13 over 45-day windows: greenhouse 10 matches per
  # 366 requests, ashby 4 per 221, lever 1 per 251). No --resume: a checkpoint
  # pins the date window of the run that wrote it, and the next weekly run
  # wants its own. Exit status never stops the rest of the script.
  if [ "${CAREER_OPS_FULL_SWEEP:-1}" = "0" ]; then
    echo "--- full ATS sweep: skipped (CAREER_OPS_FULL_SWEEP=0) ---"
  else
    sweep_since=$(digits_or "${CAREER_OPS_FULL_SWEEP_SINCE:-14}" 14)
    sweep_step=$(digits_or "${CAREER_OPS_FULL_SWEEP_STEP_SECS:-600}" 600)
    sweep_budget=$(digits_or "${CAREER_OPS_FULL_SWEEP_BUDGET_SECS:-900}" 900)
    sweep_start=$SECONDS
    # Unquoted on purpose: the value is a space-separated list of directories.
    for ats in ${CAREER_OPS_FULL_SWEEP_ATS:-greenhouse ashby lever}; do
      remaining=$(( sweep_budget - (SECONDS - sweep_start) ))
      if [ "$remaining" -lt 30 ]; then
        echo "--- full ATS sweep: $ats skipped (the ${sweep_budget}s budget is used up) ---"
        continue
      fi
      limit=$sweep_step
      [ "$remaining" -lt "$limit" ] && limit=$remaining
      echo "--- node scan-ats-full.mjs --ats $ats --since $sweep_since (full public $ats directory, limit ${limit}s) ---"
      step_start=$SECONDS
      run_limited "$limit" node scan-ats-full.mjs --ats "$ats" --since "$sweep_since"
      rc=$?
      case "$rc" in
        124|137|142|143) echo "scan-ats-full.mjs --ats $ats: STOPPED at the ${limit}s limit — the matches found before it were saved (see its ⏹ line); the next run's window covers the rest" ;;
      esac
      echo "scan-ats-full.mjs --ats $ats exit=$rc ($((SECONDS - step_start))s)"
    done
  fi

  # Last on purpose, see the header. Windows as above.
  echo "--- node scan-ats-full.mjs --seeds yc,a16z (reverse discovery, not limited to the watchlist) ---"
  node scan-ats-full.mjs --seeds yc,a16z --since 10
  echo "scan-ats-full.mjs exit=$?"

  echo "--- pipeline.md now has $(grep -c '^\- \[ \]' data/pipeline.md 2>/dev/null || echo 0) unprocessed entries ---"
  echo "=== done $(date '+%H:%M:%S') ==="
} >>"$LOG" 2>&1

# Keep 30 days of logs.
find "$LOG_DIR" -name 'scan-*.log' -mtime +30 -delete 2>/dev/null

tail -20 "$LOG"
