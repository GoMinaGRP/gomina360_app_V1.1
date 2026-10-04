#!/usr/bin/env bash
# Image-upload implementation regression sweep (run after the 2026-10 changes).
set -u
cd /home/user/gomina360_app_V1.1
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/app_db}"
OUT=/tmp/img-sweep.txt
: > "$OUT"
say() { echo "$@" | tee -a "$OUT"; }

SUITES=(
  verify-photo-formats
  verify-logos
  verify-employees
  verify-documents
  verify-business-backup
  verify-audit-records
  verify-block-qc
  verify-feed-mill
  verify-fish-feed-mill
  verify-transport
  verify-transport-ui
  verify-expense-ui
  verify-p4-writers
  verify-p5-stock
  verify-single-writer
  verify-clean-state
  verify-orders-maps
  verify-tracking
  verify-online-ordering
  verify-credit-sales
  verify-storefront-areas
  verify-nav
  verify-shared-ui
  verify-boutique
  verify-inventory-permissions
)
for s in "${SUITES[@]}"; do
  say "── $s"
  f="dev-tooling/$s.mjs"
  [ -f "$f" ] || { say "  (missing)"; continue; }
  out=$(timeout 900 bash dev-tooling/run-suite.sh "$f" 2>&1)
  echo "$out" | grep -Ei "RESULT|checks passed|ALL .* PASSED|FAILED|❌|💥" | tail -4 | sed 's/^/  /' | tee -a "$OUT"
done
say "SWEEP-DONE"
