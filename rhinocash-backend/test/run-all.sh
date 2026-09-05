#!/usr/bin/env bash
# Runs the complete real backend test suite, one file at a time.
#
# Each suite needs its OWN fresh seed and server restart — not a shortcut,
# a real requirement: v2.test.js deliberately exhausts the per-minute rate
# limit as its last test, and integration.test.js legitimately changes the
# seeded Admin password as part of testing forced-password-change. Reusing
# one seed/server across suites means later suites see stale credentials
# or a rate-limited server, which looks like failure but isn't the app's
# fault.
#
# Usage: bash test/run-all.sh

cd "$(dirname "$0")/.."

# Deliberately no `set -e`: `kill $SERVER_PID` followed by `wait $SERVER_PID`
# legitimately returns a non-zero exit status for the just-killed server
# process on every single iteration — with `set -e` that would abort this
# whole script after the very first suite, even though the suite itself
# passed. Test failures are instead tracked explicitly via $FAILED below.

SUITES="integration v2 branchExpansion mpesaConfig notifications targets \
paymentsPagination accounting accountingControl staffManagement \
branchesRegions clients collections myAccount investorManagement \
mpesaIntegration mpesaC2b mpesaB2c systemHealth support reports \
systemAdmin logout atomicity uploads"

FAILED=""

for suite in $SUITES; do
  rm -f data/rhinocash.db data/.session_secret data/.mpesa_encryption_key
  node seed.js --demo > /tmp/rhinocash_seed_output.txt 2>&1

  ADMIN=$(grep "Password:" /tmp/rhinocash_seed_output.txt | awk '{print $2}')
  MANAGER=$(awk '$2=="manager@rhinocash.co.ke"{print $NF}' /tmp/rhinocash_seed_output.txt)
  MANAGERK=$(awk '$2=="manager.kisumu@rhinocash.co.ke"{print $NF}' /tmp/rhinocash_seed_output.txt)
  REGIONAL=$(awk '$2=="regional@rhinocash.co.ke"{print $NF}' /tmp/rhinocash_seed_output.txt)
  OPSMGR=$(awk '$2=="opsmanager@rhinocash.co.ke"{print $NF}' /tmp/rhinocash_seed_output.txt)
  ACCOUNTANT=$(awk '$2=="accountant@rhinocash.co.ke"{print $NF}' /tmp/rhinocash_seed_output.txt)
  OFFICER=$(awk '$2=="officer@rhinocash.co.ke"{print $NF}' /tmp/rhinocash_seed_output.txt)
  CEO=$(awk '$2=="ceo@rhinocash.co.ke"{print $NF}' /tmp/rhinocash_seed_output.txt)
  DIRECTOR=$(awk '$2=="director@rhinocash.co.ke"{print $NF}' /tmp/rhinocash_seed_output.txt)
  INVESTOR=$(awk '$2=="sara.investor@example.com"{print $NF}' /tmp/rhinocash_seed_output.txt)

  node server.js > /tmp/rhinocash_server_${suite}.log 2>&1 &
  SERVER_PID=$!
  sleep 1.5

  echo "=== $suite ==="
  env SEEDED_ADMIN_PASSWORD="$ADMIN" SEEDED_MANAGER_PASSWORD="$MANAGER" \
      SEEDED_MANAGER_KISUMU_PASSWORD="$MANAGERK" SEEDED_REGIONAL_PASSWORD="$REGIONAL" \
      SEEDED_OPSMGR_PASSWORD="$OPSMGR" SEEDED_ACCOUNTANT_PASSWORD="$ACCOUNTANT" \
      SEEDED_OFFICER_PASSWORD="$OFFICER" SEEDED_CEO_PASSWORD="$CEO" \
      SEEDED_DIRECTOR_PASSWORD="$DIRECTOR" SEEDED_INVESTOR_PASSWORD="$INVESTOR" \
      node test/${suite}.test.js || FAILED="$FAILED $suite"

  kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null
done

echo ""
if [ -n "$FAILED" ]; then
  echo "FAILED SUITES:$FAILED"
  exit 1
else
  echo "All backend suites passed."
fi
