#!/bin/bash
# daily-scan.sh — stage 1 of the daily job scan. Runs NATIVELY on macOS.
#
# This is the zero-token half, all of it talking straight to public ATS JSON
# APIs (Greenhouse / Ashby / Lever / Workday) — no Claude, no API cost:
#
#   1. scan.mjs           — the curated watchlist in portals.yml → tracked_companies.
#   2. scan-ats-full.mjs  — reverse discovery: walks YC + a16z portfolio companies
#                            (--seeds yc,a16z) and matches postings against the
#                            SAME title_filter/location_filter in portals.yml, so
#                            new companies surface without anyone curating a list.
#   3. discover-ats.mjs against data/seeds/*.yml — resolves any seed list
#      (currently: Black Hat USA sponsors, AIxCC teams) to real ATS boards and
#      promotes the ones that resolve into portals.yml → tracked_companies, so
#      they join step 1's zero-token scan from then on.
#
# All three append to data/pipeline.md and data/scan-history.tsv.
#
# Stage 2 (triage + A-G scoring + tracker + HTML) is the scheduled Claude task:
# it runs `/career-ops pipeline` over the data/pipeline.md this wrote, then
# WebSearches the portals.yml `scan_method: websearch` companies into the same
# pipeline, then `node roles/render-roles-html.mjs`. See ../../HOWTO.md and
# modes/_custom.md (the scoring ruleset).
#
# Run by hand:   ./ops/daily-scan.sh   (from the career-ops root)
# Or on a timer: see ops/com.haochen.careerops.daily-scan.plist

set -uo pipefail
# This script lives in career-ops/ops/; every path below is relative to the
# career-ops root, so step up one level from the script's own directory.
cd "$(dirname "$0")/.." || exit 1

LOG_DIR="data/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/scan-$(date +%Y-%m-%d).log"

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

  echo "--- node scan.mjs --since 7 (curated watchlist) ---"
  node scan.mjs --since 7 --quiet
  echo "scan.mjs exit=$?"

  echo "--- node scan-ats-full.mjs --seeds yc,a16z (reverse discovery, not limited to the watchlist) ---"
  node scan-ats-full.mjs --seeds yc,a16z --since 3
  echo "scan-ats-full.mjs exit=$?"

  # Re-probe every tracked slug so a silently-404ing board gets caught.
  # This script runs weekly (Mondays), so this runs once a week.
  echo "--- slug sweep: verify-portals.mjs ---"
  node verify-portals.mjs || true

  # Resolve any seed list in data/seeds/ (e.g. Black Hat sponsors) against live
  # ATS boards and promote hits into portals.yml. --write is additive and
  # idempotent (discover-ats.mjs dedupes by slug), so this is safe to run
  # unattended on every scan.
  for seed in data/seeds/*.yml; do
    [ -f "$seed" ] || continue
    echo "--- seed resolution: discover-ats.mjs --in $seed --write ---"
    node discover-ats.mjs --in "$seed" --write --summary || true
  done

  echo "--- pipeline.md now has $(grep -c '^\- \[ \]' data/pipeline.md 2>/dev/null || echo 0) unprocessed entries ---"
  echo "=== done $(date '+%H:%M:%S') ==="
} >>"$LOG" 2>&1

# Keep 30 days of logs.
find "$LOG_DIR" -name 'scan-*.log' -mtime +30 -delete 2>/dev/null

tail -20 "$LOG"
