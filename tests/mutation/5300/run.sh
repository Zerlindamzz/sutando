#!/bin/bash
# Re-runs PR #5300's mutation controls: each patch must make a focused suite fail.
# Needs a clean tree; every patch is reverted after its run.
set -u
cd "$(git rev-parse --show-toplevel)"
tests=(tests/withheld-review-decision-final.test.py tests/gateway-disposal-delegation.test.py
       tests/withheld-review-dm.test.py tests/health-check-outbox-parked.test.py)
git diff --quiet || { echo "run.sh: needs a clean tree" >&2; exit 2; }
survived=0
for patch in tests/mutation/5300/*.patch; do
  if ! git apply "$patch"; then echo "APPLY-FAILED $(basename "$patch")"; survived=$((survived + 1)); continue; fi
  cp src/policy/egress/result.py packages/ag2-sparrow/ag2_sparrow/team_result_guard.py
  killed=no
  for t in "${tests[@]}"; do
    env -i HOME="$HOME" PATH="$PATH" python3 "$t" >/dev/null 2>&1 || { killed=yes; break; }
  done
  git checkout -q -- src packages
  [ "$killed" = yes ] && echo "KILLED   $(basename "$patch")" || { echo "SURVIVED $(basename "$patch")"; survived=$((survived + 1)); }
done
echo "run.sh: $(ls tests/mutation/5300/*.patch | wc -l | tr -d ' ') patches, $survived survived"
[ "$survived" -eq 0 ]
