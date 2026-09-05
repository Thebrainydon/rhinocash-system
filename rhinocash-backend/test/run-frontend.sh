#!/usr/bin/env bash
# Runs the real frontend integration suite: it extracts the actual inline
# <script> from rhinocash-app/index.html (no separate build step — that
# file IS the frontend), combines it with the test harness (a minimal
# document/window mock) and the assertions, and runs the result as a
# plain Node script against a live, freshly-seeded backend.
#
# Usage: bash test/run-frontend.sh

cd "$(dirname "$0")/.."

python3 -c "
import re
html = open('../rhinocash-app/index.html').read()
m = re.search(r'<script>(.*)</script>', html, re.S)
open('../rhinocash-app/extracted.js', 'w').write(m.group(1))
"
cat test/frontend-harness-prefix.js ../rhinocash-app/extracted.js test/frontend-integration-suffix.js > test/frontend-integration.combined.js
node --check test/frontend-integration.combined.js || { echo "Syntax error in combined frontend test file"; exit 1; }

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

# Higher rate limit: the frontend suite makes far more requests than any
# single backend suite (it drives real UI functions end-to-end for all 9 roles).
RATE_LIMIT_PER_MINUTE=50000 node server.js > /tmp/rhinocash_frontend_server.log 2>&1 &
SERVER_PID=$!
sleep 2

env SEEDED_ADMIN_PASSWORD="$ADMIN" SEEDED_MANAGER_PASSWORD="$MANAGER" \
    SEEDED_MANAGER_KISUMU_PASSWORD="$MANAGERK" SEEDED_REGIONAL_PASSWORD="$REGIONAL" \
    SEEDED_OPSMGR_PASSWORD="$OPSMGR" SEEDED_ACCOUNTANT_PASSWORD="$ACCOUNTANT" \
    SEEDED_OFFICER_PASSWORD="$OFFICER" SEEDED_CEO_PASSWORD="$CEO" \
    SEEDED_DIRECTOR_PASSWORD="$DIRECTOR" SEEDED_INVESTOR_PASSWORD="$INVESTOR" \
    node test/frontend-integration.combined.js
RESULT=$?

kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null
exit $RESULT
