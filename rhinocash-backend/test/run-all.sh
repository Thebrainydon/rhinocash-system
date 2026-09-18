#!/usr/bin/env bash
# Runs the complete real backend test suite, one file at a time, each
# against a genuinely fresh PostgreSQL schema.
#
# Each suite needs its OWN fresh seed and server restart — not a shortcut,
# a real requirement: several suites mutate shared state as a side effect
# of what they're legitimately testing (integration.test.js changes the
# seeded Admin password as part of testing forced-password-change;
# myAccount.test.js changes the seeded officer's email; mpesaIntegration/
# mpesaB2c/mpesaConfig all activate real M-Pesa environment config).
# Reusing one seed/server across suites means later suites see stale
# credentials or leftover business state, which looks like failure but
# isn't the application's fault — confirmed by hand while building this
# runner: every one of those cross-suite "failures" disappeared the moment
# each suite ran against its own fresh seed.
#
# Portable by design:
#   - Never writes anywhere under /tmp. Some sandboxed environments (e.g.
#     Termux) don't have a usable /tmp for arbitrary processes, so every
#     scratch file this script creates (seed output, server logs) lives
#     under test/tmp, next to this script.
#   - Never touches the real dev/production PostgreSQL database. Tests get
#     a completely separate database via TEST_DATABASE_URL, reset to a
#     genuinely empty schema before every single suite (DROP SCHEMA public
#     CASCADE; CREATE SCHEMA public — the app's own real startup self-test
#     in src/db.js then rebuilds the full schema fresh, the exact same
#     migration path production uses, never a second hand-maintained
#     schema definition here) — plus completely separate session/
#     encryption secrets (via SESSION_SECRET/MPESA_ENCRYPTION_KEY, both
#     real env overrides already supported by src/crypto.js — see there).
#     A test run can therefore never read, corrupt, or delete real data.
#   - Refuses to run at all against a TEST_DATABASE_URL that doesn't look
#     like a test database (no "test" in the database name) — a database
#     name is the only signal this script has, so it insists on that
#     signal being present rather than trusting the caller silently.
#
# Usage:
#   TEST_DATABASE_URL=postgres://rhinocash:yourpassword@localhost:5432/rhinocash_test bash test/run-all.sh
#
# Prerequisites: a running PostgreSQL server, and a database already
# created (e.g. `createdb -O rhinocash rhinocash_test`, or
# `psql -c "CREATE DATABASE rhinocash_test OWNER rhinocash;"`) — this
# script resets that database's contents on every run, but does not create
# the database itself, since doing so needs privileges this script
# shouldn't assume it has.

set -u

# Resolve paths from THIS script's real location, not the caller's $PWD —
# this is what makes `cd "$(dirname "$0")/.."` safe to run from anywhere,
# including via `npm test` (a different cwd) or a symlinked invocation.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BACKEND_DIR" || { echo "FATAL: could not cd into $BACKEND_DIR"; exit 1; }

TMP_DIR="$BACKEND_DIR/test/tmp"
mkdir -p "$TMP_DIR"

TEST_DATABASE_URL="${TEST_DATABASE_URL:-}"
if [ -z "$TEST_DATABASE_URL" ]; then
  echo "FATAL: TEST_DATABASE_URL is not set. Example:"
  echo "  TEST_DATABASE_URL=postgres://rhinocash:yourpassword@localhost:5432/rhinocash_test bash test/run-all.sh"
  exit 1
fi
case "$TEST_DATABASE_URL" in
  *test*) ;;
  *) echo "FATAL: TEST_DATABASE_URL does not look like a test database (expected \"test\" somewhere in it) — refusing to run against it, since this script resets its contents on every suite: $TEST_DATABASE_URL"; exit 1 ;;
esac

PORT="${PORT:-4000}"
BASE_URL="http://127.0.0.1:$PORT"

SUITES="integration v2 branchExpansion mpesaConfig notifications targets
paymentsPagination accounting accountingControl staffManagement
branchesRegions clients collections myAccount investorManagement
mpesaIntegration mpesaC2b mpesaB2c systemHealth support reports
systemAdmin logout atomicity uploads cors chat"

FAILED=""
SERVER_PID=""

# Reliable cleanup — runs on normal completion AND on Ctrl-C/kill, so a
# server from an interrupted run never lingers on $PORT for the next one.
cleanup_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  SERVER_PID=""
}
trap cleanup_server EXIT INT TERM

# Polls /api/health with Node's own fetch instead of a fixed `sleep` —
# a fixed sleep is either a race (server not up yet, especially on a
# slower device) or wasted time (server was already up). No dependency
# on curl, which isn't guaranteed present (e.g. a bare Termux install).
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

# Wipes every table/object in the test database's public schema. The
# app's own real startup self-test (src/db.js's startupSelfTest(), run
# automatically the moment server.js or seed.js next connects) then
# rebuilds the full schema fresh — the exact same migration path
# production uses, so this never risks drifting from the real schema.
reset_test_db() {
  DATABASE_URL="$TEST_DATABASE_URL" node -e "
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    c.connect()
      .then(() => c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'))
      .then(() => c.end())
      .then(() => process.exit(0))
      .catch(e => { console.error(e.message); process.exit(1); });
  "
}

for suite in $SUITES; do
  echo "=== $suite ==="

  if ! reset_test_db; then
    echo "FAIL: could not reset the test database — is PostgreSQL running and TEST_DATABASE_URL correct?"
    FAILED="$FAILED $suite"
    continue
  fi

  # Fresh session-signing secret and M-Pesa encryption key per suite, via
  # the real env-var overrides src/crypto.js already supports — this is
  # what keeps the test run from ever writing into the real dev/production
  # secrets, not a new mechanism bolted on top of it. 32 random bytes
  # hex-encoded either way (MPESA_ENCRYPTION_KEY specifically needs to be a
  # 32-byte key for AES-256-GCM; SESSION_SECRET has no format requirement
  # but the same value shape is simplest to generate once and reuse).
  SESSION_SECRET_VAL="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  MPESA_KEY_VAL="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"

  SEED_OUTPUT="$TMP_DIR/seed-output-$suite.txt"
  DATABASE_URL="$TEST_DATABASE_URL" \
  SESSION_SECRET="$SESSION_SECRET_VAL" \
  MPESA_ENCRYPTION_KEY="$MPESA_KEY_VAL" \
    node seed.js --demo > "$SEED_OUTPUT" 2>&1
  SEED_EXIT=$?

  if [ "$SEED_EXIT" -ne 0 ]; then
    echo "FAIL: seeding failed (exit $SEED_EXIT) — see $SEED_OUTPUT"
    tail -n 20 "$SEED_OUTPUT"
    FAILED="$FAILED $suite"
    continue
  fi

  # seed.js prints generated credentials to stdout in a fixed, deliberately
  # parseable format (see seed.js's own console.log calls) — this IS the
  # intended mechanism for retrieving them, not a workaround.
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
    FAILED="$FAILED $suite"
    continue
  fi

  SERVER_LOG="$TMP_DIR/server-$suite.log"
  DATABASE_URL="$TEST_DATABASE_URL" \
  SESSION_SECRET="$SESSION_SECRET_VAL" \
  MPESA_ENCRYPTION_KEY="$MPESA_KEY_VAL" \
  PORT="$PORT" \
    node server.js > "$SERVER_LOG" 2>&1 &
  SERVER_PID=$!

  if ! wait_for_server; then
    echo "FAIL: server never came up on $BASE_URL — see $SERVER_LOG"
    tail -n 20 "$SERVER_LOG"
    FAILED="$FAILED $suite"
    cleanup_server
    continue
  fi

  # A handful of suites (atomicity, mpesaB2c, mpesaIntegration, support,
  # mpesaConfig) legitimately `require('../src/db')` directly IN this same
  # test process, rather than going only through the HTTP API — to inspect
  # transaction atomicity, encryption-at-rest, etc. That in-process
  # connection must resolve to the exact same database the server was
  # started with, or it silently opens a second, unrelated connection pool
  # (against a database with none of this run's data) instead.
  env SEEDED_ADMIN_PASSWORD="$ADMIN" SEEDED_MANAGER_PASSWORD="$MANAGER" \
      SEEDED_MANAGER_KISUMU_PASSWORD="$MANAGERK" SEEDED_REGIONAL_PASSWORD="$REGIONAL" \
      SEEDED_OPSMGR_PASSWORD="$OPSMGR" SEEDED_ACCOUNTANT_PASSWORD="$ACCOUNTANT" \
      SEEDED_OFFICER_PASSWORD="$OFFICER" SEEDED_CEO_PASSWORD="$CEO" \
      SEEDED_DIRECTOR_PASSWORD="$DIRECTOR" SEEDED_INVESTOR_PASSWORD="$INVESTOR" \
      BASE_URL="$BASE_URL" \
      DATABASE_URL="$TEST_DATABASE_URL" \
      SESSION_SECRET="$SESSION_SECRET_VAL" \
      MPESA_ENCRYPTION_KEY="$MPESA_KEY_VAL" \
      node "test/${suite}.test.js" || FAILED="$FAILED $suite"

  cleanup_server
done

echo ""
if [ -n "$FAILED" ]; then
  echo "FAILED SUITES:$FAILED"
  exit 1
else
  echo "All backend suites passed."
fi
