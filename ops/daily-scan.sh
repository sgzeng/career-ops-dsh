#!/bin/bash
# daily-scan.sh — stage 1 of the daily job scan. Runs NATIVELY on macOS.
#
# This is the zero-token half, all of it talking straight to public ATS JSON
# APIs (Greenhouse / Ashby / Lever / Workday) — no Claude, no API cost.
# The steps run in WAVES; everything inside one wave runs concurrently, and a
# wave starts only when the previous one has fully finished:
#
#   wave 0  validate-portals.mjs ‖ check-config-regression.mjs   (local, seconds)
#   wave 1  ONE AFTER ANOTHER, never together: all four talk to the same ATS hosts
#           (Greenhouse / Ashby / Lever / Workday ...), and two of them at once
#           would double the request rate on one host.
#           scan.mjs             — the curated watchlist (portals.yml → tracked_companies)
#           → verify-portals.mjs — re-probes every tracked slug (silent-404 catcher)
#           → audit-portals.mjs  — one fetch per enabled board (1-3 minutes)
#           → discover-ats.mjs   — resolves data/seeds/*.yml (conference sponsors, a
#                                  VC portfolio) to ATS boards, promotes hits into
#                                  portals.yml → tracked_companies
#   wave 2  scan-ats-full.mjs --ats greenhouse ‖ ashby ‖ lever — reverse discovery
#           over the FULL public ATS directory (Feashliaa/job-board-aggregator),
#           matched against the SAME title/location/level filters in portals.yml.
#           One process per directory, three different API hosts, so they do not
#           compete for one host's rate limit. This is the only wave where
#           network steps overlap, and only because their hosts differ.
#   wave 3  scan-ats-full.mjs --seeds yc,a16z — reverse discovery over the YC and
#           a16z portfolios, same filters.
#   wave 4  ops/stage1-liveness.mjs — zero-token liveness over pending non-LinkedIn
#           rows: dead ones to Processed, live ones tagged for stage 2 to skip.
#   wave 5  health digest, read-only: detect-reposts, stats, filter-audit,
#           close-stale (dry run), reeval-candidates.
#           Advisory only: a failure logs WARN and never stops anything.
#
# Output: each concurrent step writes to its own temp log, and the wave then
# appends them to the day's log in the fixed order above, so the log reads the
# same as the old serial one (headers, `exit=` lines, grep patterns in HOWTO.md)
# plus a `[lane X finished in Ns]` line per step and a `wave N done` line.
#
# WHY THE WAVES ARE SAFE (every file two lanes can both touch):
#   data/pipeline.md, data/scan-history.tsv, data/scan-runs.tsv
#       Written only through scan.mjs's appendToPipeline / appendToScanHistory,
#       which hold pipeline-lock.mjs (a cross-process directory lock) around the
#       whole read-modify-write. Wave 1 has one writer (scan.mjs); wave 2's three
#       sweeps are the only concurrent writers, and they sweep disjoint ATS
#       directories, so the same posting cannot be found twice. Each wave starts
#       after the previous one wrote, so its dedup snapshot already contains it.
#   data/portals.yml
#       One writer in the whole script (discover-ats, atomic tmp + rename), and
#       readers get either the old or the new file, never half of one.
#   data/cache/ats-full-checkpoint.json
#       One shared file would be overwritten (and deleted) by the sweeps; each
#       sweep now gets its own via CAREER_OPS_ATS_FULL_CHECKPOINT.
#   data/dead-boards.tsv
#       Whole-file rewrite from a snapshot; saveDeadBoards (dead-boards.mjs) now
#       re-reads under a lock and replaces only the ATS rows the run owns.
#   data/.linkedin-limiter.json
#       Already a cross-process slot file (lib/linkedin-limiter.mjs).
#   data/cache/http, data/cache/provider-ids, data/cache/ats-companies/<ats>.json,
#   jds/stage1/<hash>.md
#       Atomic writes, locked merges, or one file per lane / per posting URL.
#   everything in the health digest
#       Read-only, and it runs after every writer has finished.
#
# THE ORDER IS DELIBERATE. The sweeps and the YC/a16z seeds are the heavy bursts
# (thousands of requests to boards-api.greenhouse.io / api.lever.co /
# api.ashbyhq.com; the YC seed sweep runs 20 wide against ONE host). They used to
# run right after scan.mjs and BEFORE verify-portals, and in 4 of the 6 logged
# runs that swept ~6,200 YC companies, verify-portals then met 1-17 HTTP 403s on
# Greenhouse boards that answered 200 later in the same run (12 of 13 on Oct 8;
# data/logs, Sep 7 - Oct 8). Nothing here proves a Greenhouse rate limit, but
# nothing that needs a clean answer from those hosts should run after a burst, so
# the polite probes (wave 1) go first, the per-directory sweeps (wave 2) next and
# the aggressive YC/a16z sweep (wave 3) last. Rule for any new step: two steps
# that talk to the same host never share a wave; only steps on different hosts
# (or on no host) may run concurrently.
#
# Stage 2 (triage + A-G scoring + tracker + HTML) is the scheduled Claude task:
# it runs `/career-ops pipeline` over the data/pipeline.md this wrote, then
# WebSearches the portals.yml `scan_method: websearch` companies into the same
# pipeline, then `node roles/render-roles-html.mjs`. See modes/_custom.md
# (the scoring ruleset).
#
# Environment (all optional):
#   CAREER_OPS_PARALLEL=0                 run every step one after another, in
#                                         the same wave order (default 1:
#                                         concurrent waves)
#   CAREER_OPS_FULL_SWEEP=0               skip wave 2 entirely (default: on)
#   CAREER_OPS_FULL_SWEEP_ATS="a b c"     which directories (default:
#                                         greenhouse ashby lever); one lane each
#   CAREER_OPS_FULL_SWEEP_SINCE=14        posting window in days (default 14,
#                                         twice the weekly cadence: a skipped
#                                         week or a killed sweep is re-covered
#                                         by the overlap, dedup makes it free)
#   CAREER_OPS_FULL_SWEEP_STEP_SECS=600   hard limit for ONE directory (they run
#                                         side by side, so this is also the
#                                         wall time of wave 2)
#   CAREER_OPS_FULL_SWEEP_BUDGET_SECS=900 upper cap on any one directory's limit
#   CAREER_OPS_SCAN_TIMEOUT_SECS=1500     scan.mjs
#   CAREER_OPS_VERIFY_TIMEOUT_SECS=900    verify-portals.mjs
#   CAREER_OPS_DISCOVER_TIMEOUT_SECS=900  discover-ats.mjs, all seed files together
#   CAREER_OPS_AUDIT_TIMEOUT_SECS=600     audit-portals.mjs
#   CAREER_OPS_SEEDS_TIMEOUT_SECS=1800    scan-ats-full.mjs --seeds yc,a16z
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
# later, if the flush has not finished, loses them. Wave 2 runs one directory per
# process, so one hung directory costs the rest of that directory and nothing
# else.
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

# ── wave machinery ────────────────────────────────────────────────────────────
# lane <name> <function> [args...] starts a step in the background with its
# stdout+stderr in its own temp log; join_wave waits for every lane started
# since the last join and appends their logs, in start order, to the day's log.
# With CAREER_OPS_PARALLEL=0 a lane runs in the foreground instead, so the same
# code path gives the serial behaviour. serial <name> <function> runs one step in
# the foreground, straight into the log, for steps that must not overlap.
PARALLEL="${CAREER_OPS_PARALLEL:-1}"
STEP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/career-ops-scan.XXXXXX") || exit 1
trap 'rm -rf "$STEP_DIR"' EXIT
LANE_NAMES=()
LANE_PIDS=()

_run_lane() {
  local name=$1 t0=$SECONDS
  shift
  "$@"
  echo "[lane $name finished in $((SECONDS - t0))s]"
}

serial() {
  local name=$1
  shift
  _run_lane "$name" "$@"
}

lane() {
  local name=$1
  shift
  LANE_NAMES+=("$name")
  if [ "$PARALLEL" = "0" ]; then
    _run_lane "$name" "$@" >"$STEP_DIR/$name.log" 2>&1
    LANE_PIDS+=(0)
  else
    _run_lane "$name" "$@" >"$STEP_DIR/$name.log" 2>&1 &
    LANE_PIDS+=($!)
  fi
}

join_wave() {
  local label=$1 i rc
  for i in "${!LANE_NAMES[@]}"; do
    rc=0
    if [ "${LANE_PIDS[$i]}" != "0" ]; then
      wait "${LANE_PIDS[$i]}" || rc=$?
    fi
    cat "$STEP_DIR/${LANE_NAMES[$i]}.log"
    # A lane's own commands report their exit codes in the log; a non-zero
    # status here means the lane itself died (killed, or a shell error).
    [ "$rc" -ne 0 ] && echo "WARN: lane ${LANE_NAMES[$i]} ended abnormally (status $rc)"
  done
  LANE_NAMES=()
  LANE_PIDS=()
  echo "--- $label done (${SECONDS}s since start) ---"
}

# ── steps ────────────────────────────────────────────────────────────────────

step_validate() {
  echo "--- portals.yml schema preflight ---"
  node validate-portals.mjs || echo "WARN: portals.yml has schema issues (see above) — scanning anyway"
}

# Known titles/locations that must (not) pass the filters; catches a config
# edit that silently drops a class of roles. WARN only, never blocks the scan.
step_regression() {
  echo "--- filter regression fixtures ---"
  node ops/check-config-regression.mjs || echo "WARN: filter regression fixtures failed (see above) — scanning anyway"
}

# Windows are wider than the weekly cadence on purpose: a run that fires late
# (Mac asleep) or a skipped week must not leave jobs unreachable. Overlap is
# free — only `added` rows reach scan-history.tsv, so re-seen jobs dedup.
step_scan() {
  echo "--- node scan.mjs --since 14 (curated watchlist) ---"
  # Hard 25-minute limit (CAREER_OPS_SCAN_TIMEOUT_SECS): 20 logged runs took
  # 170-542s (median 324s) before the shared LinkedIn limiter (lib/linkedin-limiter.mjs)
  # spaced every LinkedIn request ~4.5s apart (a heavy day adds ~10 min), so 1500s. On 2026-11-11 scan.mjs
  # finished its work but never exited (a leaked keep-alive socket), and since
  # nothing bounded it, every later step waited behind it for hours.
  run_limited "$(digits_or "${CAREER_OPS_SCAN_TIMEOUT_SECS:-}" 1500)" node scan.mjs --since 14 --quiet
  local rc=$?
  echo "scan.mjs exit=$rc"
  case "$rc" in
    124|137|142|143) echo "WARN: scan.mjs hit the time limit (exit $rc) — continuing with the next step" ;;
  esac
}

# Re-probe every tracked slug so a silently-404ing board gets caught.
# Runs on every invocation; nothing in this script depends on the date.
step_verify() {
  echo "--- slug sweep: verify-portals.mjs ---"
  # Limit CAREER_OPS_VERIFY_TIMEOUT_SECS (default 900s; a normal run is ~270s).
  run_limited "$(digits_or "${CAREER_OPS_VERIFY_TIMEOUT_SECS:-}" 900)" node verify-portals.mjs
  echo "verify-portals.mjs exit=$?"
}

# Resolve any seed list in data/seeds/ (e.g. Black Hat sponsors) against live
# ATS boards and promote hits into portals.yml. --write is additive and
# idempotent (discover-ats.mjs dedupes by slug) and replaces portals.yml
# atomically, so this is safe to run unattended on every scan and next to the
# steps that only read portals.yml. The seed files go one after another inside
# this lane: each --write is a read-modify-write of portals.yml, so two of them
# at once would drop one side's additions. Companies promoted here join the
# NEXT run's scan.mjs, as they always did.
step_discover() {
  local deadline=$((SECONDS + $(digits_or "${CAREER_OPS_DISCOVER_TIMEOUT_SECS:-}" 900)))
  local seed left
  for seed in data/seeds/*.yml; do
    [ -f "$seed" ] || continue
    left=$((deadline - SECONDS))
    if [ "$left" -lt 15 ]; then
      echo "--- seed resolution: $seed skipped (the discover time budget is used up) ---"
      continue
    fi
    echo "--- seed resolution: discover-ats.mjs --in $seed --write ---"
    run_limited "$left" node discover-ats.mjs --in "$seed" --write --summary
    echo "discover-ats.mjs --in $seed exit=$?"
  done
}

# One fetch per enabled board (1-3 minutes). Reads portals.yml, writes
# only its own baseline file. Hits the same hosts as scan.mjs, so it runs after it.
step_audit() {
  echo "--- health digest: audit-portals (network, one fetch per enabled board) ---"
  local audit_prev="data/portal-audit.json"
  local audit_args=(--json)
  [ -f "$audit_prev" ] && audit_args+=(--baseline "$audit_prev")
  if run_limited "$(digits_or "${CAREER_OPS_AUDIT_TIMEOUT_SECS:-}" 600)" node audit-portals.mjs "${audit_args[@]}" > "$audit_prev.tmp"; then
    mv "$audit_prev.tmp" "$audit_prev"
  else
    rm -f "$audit_prev.tmp"
    echo "WARN: audit-portals.mjs failed; baseline kept at $audit_prev"
  fi
}

# Reverse discovery over the whole public ATS directory, ONE PROCESS PER
# DIRECTORY, all at once: a hang or a kill costs one directory's matches, not
# all three, each leaves its own header and exit= line, and they talk to three
# different hosts. Yield per request, for reference (measured 2026-10-13 over
# 45-day windows: greenhouse 10 matches per 366 requests, ashby 4 per 221, lever
# 1 per 251). No --resume: a checkpoint pins the date window of the run that
# wrote it, and the next weekly run wants its own. Each directory keeps its own
# checkpoint file so the three never overwrite each other's.
step_sweep() {
  local ats=$1
  local since step budget limit t0 rc
  since=$(digits_or "${CAREER_OPS_FULL_SWEEP_SINCE:-14}" 14)
  step=$(digits_or "${CAREER_OPS_FULL_SWEEP_STEP_SECS:-600}" 600)
  budget=$(digits_or "${CAREER_OPS_FULL_SWEEP_BUDGET_SECS:-900}" 900)
  limit=$step
  [ "$budget" -lt "$limit" ] && limit=$budget
  echo "--- node scan-ats-full.mjs --ats $ats --since $since (full public $ats directory, limit ${limit}s) ---"
  t0=$SECONDS
  run_limited "$limit" env "CAREER_OPS_ATS_FULL_CHECKPOINT=data/cache/ats-full-checkpoint.$ats.json" \
    node scan-ats-full.mjs --ats "$ats" --since "$since"
  rc=$?
  case "$rc" in
    124|137|142|143) echo "scan-ats-full.mjs --ats $ats: STOPPED at the ${limit}s limit — the matches found before it were saved (see its ⏹ line); the next run's window covers the rest" ;;
  esac
  echo "scan-ats-full.mjs --ats $ats exit=$rc ($((SECONDS - t0))s)"
}

# Last of the network steps on purpose, see the header. Windows as above. This
# step had no time limit before; the 2026-11-11 scan.mjs hang showed what an
# unbounded step costs, and scan-ats-full flushes its matches on SIGTERM/SIGALRM.
step_seeds() {
  echo "--- node scan-ats-full.mjs --seeds yc,a16z (reverse discovery, not limited to the watchlist) ---"
  run_limited "$(digits_or "${CAREER_OPS_SEEDS_TIMEOUT_SECS:-}" 1800)" node scan-ats-full.mjs --seeds yc,a16z --since 10
  echo "scan-ats-full.mjs exit=$?"
}

# After all writers above: dead postings move to Processed, live ones get
# `liveness active <date>` in their note so stage 2 skips its own sweep for them
# today. Deliberately NOT under run_limited: it rewrites pipeline.md, and a kill
# landing mid-write would leave that file truncated.
step_liveness() {
  echo "--- stage-1 liveness: ops/stage1-liveness.mjs ---"
  node ops/stage1-liveness.mjs || echo "WARN: stage1-liveness.mjs failed — stage 2 runs its own sweep"
}

# Health digest. Every tool here only reads (close-stale without --confirm is a
# dry run), so a failure is a WARN line and nothing else.
step_reposts() {
  echo "--- health digest: detect-reposts ---"
  node detect-reposts.mjs --summary || echo "WARN: detect-reposts.mjs failed"
}
step_stats() {
  echo "--- health digest: stats ---"
  node stats.mjs --summary || echo "WARN: stats.mjs failed"
}
step_filter_audit() {
  echo "--- health digest: filter-audit ---"
  node filter-audit.mjs --summary || echo "WARN: filter-audit.mjs failed"
}
step_close_stale() {
  echo "--- health digest: close-stale (dry run) ---"
  node close-stale.mjs --summary || echo "WARN: close-stale.mjs failed"
}
step_reeval() {
  echo "--- health digest: reeval-candidates ---"
  node reeval-candidates.mjs --status Evaluated,Applied --summary || echo "WARN: reeval-candidates.mjs failed"
}

{
  echo "=== career-ops daily scan — $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
  [ "$PARALLEL" = "0" ] && echo "(CAREER_OPS_PARALLEL=0: every step runs serially)"

  # Keep node on PATH under launchd, which does not source your shell profile.
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

  if ! command -v node >/dev/null 2>&1; then
    echo "FATAL: node not on PATH. Fix the PATH line above to point at your node."
    exit 1
  fi

  # Wave 0 — local preflight.
  lane validate step_validate
  lane regression step_regression
  join_wave "wave 0 (preflight)"

  # Wave 1 — the polite network probes, one at a time: they share ATS hosts.
  serial scan step_scan
  serial verify step_verify
  serial audit step_audit
  serial discover step_discover
  echo "--- wave 1 (scan, verify, audit, discover; serial) done (${SECONDS}s since start) ---"

  # Wave 2 — one reverse-discovery sweep per ATS directory, side by side.
  if [ "${CAREER_OPS_FULL_SWEEP:-1}" = "0" ]; then
    echo "--- full ATS sweep: skipped (CAREER_OPS_FULL_SWEEP=0) ---"
  else
    # Unquoted on purpose: the value is a space-separated list of directories.
    for ats in ${CAREER_OPS_FULL_SWEEP_ATS:-greenhouse ashby lever}; do
      lane "sweep-$ats" step_sweep "$ats"
    done
    join_wave "wave 2 (full ATS sweeps)"
  fi

  # Wave 3 — the aggressive burst, alone.
  lane seeds step_seeds
  join_wave "wave 3 (yc/a16z seeds)"

  # Wave 4 — after every pipeline.md writer.
  lane liveness step_liveness
  join_wave "wave 4 (liveness)"

  # Wave 5 — read-only digest of the finished day.
  lane reposts step_reposts
  lane stats step_stats
  lane filter-audit step_filter_audit
  lane close-stale step_close_stale
  lane reeval step_reeval
  join_wave "wave 5 (health digest)"

  echo "--- pipeline.md now has $(grep -c '^\- \[ \]' data/pipeline.md 2>/dev/null || echo 0) unprocessed entries ---"
  echo "=== done $(date '+%H:%M:%S') ==="
} >>"$LOG" 2>&1

# Keep 30 days of logs.
find "$LOG_DIR" -name 'scan-*.log' -mtime +30 -delete 2>/dev/null

tail -20 "$LOG"
