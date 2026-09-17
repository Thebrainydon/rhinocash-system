#!/usr/bin/env bash
# Runs the real frontend integration suite: it extracts the actual inline
# <script> from rhinocash-app/index.html (no separate build step — that
# file IS the frontend), combines it with the test harness (a minimal
# document/window mock) and the assertions, and runs the result as a
# plain Node script against a live, freshly-seeded backend.
#
# Like test/run-all.sh, this resets a dedicated PostgreSQL test database
# to a genuinely empty schema before running, and never writes anywhere
# under /tmp — every scratch file lives under test/tmp, next to this
# script.
#
# Usage:
#   TEST_DATABASE_URL=postgres://rhinocash:yourpassword@localhost:5432/rhinocash_test \
#     bash test/run-frontend.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BACKEND_DIR" || { echo "FATAL: could not cd into $BACKEND_DIR"; exit 1; }

TMP_DIR="$BACKEND_DIR/test/tmp"
mkdir -p "$TMP_DIR"

TEST_DATABASE_URL="${TEST_DATABASE_URL:-}"
if [ -z "$TEST_DATABASE_URL" ]; then
  echo "FATAL: TEST_DATABASE_URL is not set. Example:"
  echo "  TEST_DATABASE_URL=postgres://rhinocash:yourpassword@localhost:5432/rhinocash_test bash test/run-frontend.sh"
  exit 1
fi
case "$TEST_DATABASE_URL" in
  *test*) ;;
  *) echo "FATAL: TEST_DATABASE_URL does not look like a test database (expected \"test\" somewhere in it) — refusing to run against it, since this script resets its contents: $TEST_DATABASE_URL"; exit 1 ;;
esac

PORT="${PORT:-4000}"
BASE_URL="http://127.0.0.1:$PORT"
SERVER_PID=""

cleanup_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  SERVER_PID=""
}
trap cleanup_server EXIT INT TERM

wait_for_server() {
  local tries=0
  while [ "$tries" -lt 100 ]; do
    if node -e "
      fetch('$BASE_URL/api/health')
        .then(r => process.exit(r.ok ? 0 : 1))
        .catch(() => process.exit(1));
    " >/dev/null 2>&1; then
      return 0
    fi
    tries=$((tries + 1))
    sleep 0.2
  done
  return 1
}

python3 -c "
import re
html = open('../rhinocash-app/index.html').read()
m = re.search(r'<script>(.*)</script>', html, re.S)
open('../rhinocash-app/extracted.js', 'w').write(m.group(1))
"
cat test/frontend-harness-prefix.js ../rhinocash-app/extracted.js test/frontend-integration-suffix.js > test/frontend-integration.combined.js
node --check test/frontend-integration.combined.js || { echo "Syntax error in combined frontend test file"; exit 1; }

# Wipe the test database's public schema — the app's own startup
# self-test rebuilds the full schema fresh on next connect.
node -e "
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  c.connect()
    .then(() => c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'))
    .then(() => c.end())
    .then(() => process.exit(0))
    .catch(e => { console.error(e.message); process.exit(1); });
" || { echo "FATAL: could not reset the test database"; exit 1; }

SEED_OUTPUT="$TMP_DIR/seed-output-frontend.txt"
DATABASE_URL="$TEST_DATABASE_URL" node seed.js --demo > "$SEED_OUTPUT" 2>&1
if [ $? -ne 0 ]; then
  echo "FAIL: seeding failed — see $SEED_OUTPUT"
  tail -n 20 "$SEED_OUTPUT"
  exit 1
fi

ADMIN=$(grep "Password:" "$SEED_OUTPUT" | awk '{print $2}')
MANAGER=$(awk '$2=="manager@rhinocash.co.ke"{print $NF}' "$SEED_OUTPUT")
MANAGERK=$(awk '$2=="manager.kisumu@rhinocash.co.ke"{print $NF}' "$SEED_OUTPUT")
REGIONAL=$(awk '$2=="regional@rhinocash.co.ke"{print $NF}' "$SEED_OUTPUT")
OPSMGR=$(awk '$2=="opsmanager@rhinocash.co.ke"{print $NF}' "$SEED_OUTPUT")
ACCOUNTANT=$(awk '$2=="accountant@rhinocash.co.ke"{print $NF}' "$SEED_OUTPUT")
OFFICER=$(awk '$2=="officer@rhinocash.co.ke"{print $NF}' "$SEED_OUTPUT")
CEO=$(awk '$2=="ceo@rhinocash.co.ke"{print $NF}' "$SEED_OUTPUT")
DIRECTOR=$(awk '$2=="director@rhinocash.co.ke"{print $NF}' "$SEED_OUTPUT")
INVESTOR=$(awk '$2=="sara.investor@example.com"{print $NF}' "$SEED_OUTPUT")

if [ -z "$ADMIN" ]; then
  echo "FAIL: could not parse the admin password out of $SEED_OUTPUT (seed.js's output format may have changed)"
  exit 1
fi

# Higher rate limit: the frontend suite makes far more requests than any
# single backend suite (it drives real UI functions end-to-end for all 9 roles).
SERVER_LOG="$TMP_DIR/server-frontend.log"
DATABASE_URL="$TEST_DATABASE_URL" RATE_LIMIT_PER_MINUTE=50000 PORT="$PORT" \
  node server.js > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

if ! wait_for_server; then
  echo "FAIL: server never came up on $BASE_URL — see $SERVER_LOG"
  tail -n 20 "$SERVER_LOG"
  exit 1
fi

env SEEDED_ADMIN_PASSWORD="$ADMIN" SEEDED_MANAGER_PASSWORD="$MANAGER" \
    SEEDED_MANAGER_KISUMU_PASSWORD="$MANAGERK" SEEDED_REGIONAL_PASSWORD="$REGIONAL" \
    SEEDED_OPSMGR_PASSWORD="$OPSMGR" SEEDED_ACCOUNTANT_PASSWORD="$ACCOUNTANT" \
    SEEDED_OFFICER_PASSWORD="$OFFICER" SEEDED_CEO_PASSWORD="$CEO" \
    SEEDED_DIRECTOR_PASSWORD="$DIRECTOR" SEEDED_INVESTOR_PASSWORD="$INVESTOR" \
    BACKEND_URL="$BASE_URL" \
    node test/frontend-integration.combined.js
RESULT=$?

cleanup_server
exit $RESULT
