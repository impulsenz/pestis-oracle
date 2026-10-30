#!/usr/bin/env bash
# Runs every test: the server and its rules (api), the three real apps in Chromium (e2e), offline, and the test-site script.
# Each starts its own Pestis server with a throw-away database, fake Google keys and a fake email server.
#   tests/run.sh            all of them
#   tests/run.sh api        just one (api | e2e | offline | testsite)
set -uo pipefail
cd "$(dirname "$0")"
export PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1
which=("${@:-api e2e offline testsite}")
fail=0
for t in ${which[@]}; do
  echo "===== $t"
  out=$(timeout 300 node "$t.test.mjs" 2>&1); code=$?
  printf '%s\n' "$out" | grep -v '^PASS'
  [ $code = 0 ] || fail=1
done
[ $fail = 0 ] && echo "ALL TESTS PASSED" || { echo "SOME TESTS FAILED"; exit 1; }
