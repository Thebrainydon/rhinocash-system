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
# Portable by design:
#   - Never writes anywhere under /tmp. Some sandboxed environments (e.g.
#     Termux) don't have a usable /tmp for arbitrary processes, so every
#     scratch file this script creates (seed output, server logs, the test
#     database itself) lives under test/tmp, next to this script.
#   - Never touches rhinocash-backend/data/, the application's real,
#     permanent database location. Tests get a completely separate
#     database (via RHINOCASH_DB_PATH) and completely separate session/
#     encryption secrets (via SESSION_SECRET/MPESA_ENCRYPTION_KEY, both
#     real env overrides already supported by src/crypto.js — see there).
#     A test run can therefore never read, corrupt, or delete real data,
#     and never depends on rhinocash-backend/data/ being writable at all.
#
# Usage:
#   bash test/run-all.sh
#   RHINOCASH_DB_PATH=/some/other/path/test.db bash test/run-all.sh
#     (overrides where the test database lives; defaults to
#     rhinocash-backend/test/tmp/rhinocash-test.db)

set -u

# Resolve paths from THIS script's real location, not the caller's $PWD —
# this is what makes `cd "$(dirname "$0")/.."` safe to run from anywhere,
# including via `npm test` (a different cwd) or a symlinked invocation.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BACKEND_DIR" || { echo "FATAL: could not cd into $BACKEND_DIR"; exit 1; }

TMP_DIR="$BACKEND_DIR/test/tmp"
mkdir -p "$TMP_DIR"

# The test database and its WAL/SHM sidecars live entirely under
# test/tmp — never under data/ — unless the caller explicitly points
# RHINOCASH_DB_PATH somewhere else (e.g. a known-good Termux path).
TEST_DB_PATH="${RHINOCASH_DB_PATH:-$TMP_DIR/rhinocash-test.db}"
PORT="${PORT:-4000}"
BASE_URL="http://127.0.0.1:$PORT"

SUITES="integration v2 branchExpansion mpesaConfig notifications targets
paymentsPagination accounting accountingControl staffManagement
branchesRegions clients collections myAccount investorManagement
mpesaIntegration mpesaC2b mpesaB2c systemHealth support reports
systemAdmin logout atomicity uploads"

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

for suite in $SUITES; do
  echo "=== $suite ==="

  rm -f "$TEST_DB_PATH" "${TEST_DB_PATH}-wal" "${TEST_DB_PATH}-shm"

  # Fresh session-signing secret and M-Pesa encryption key per suite, via
  # the real env-var overrides src/crypto.js already supports — this is
  # what keeps the test run from ever writing into data/, not a new
  # mechanism bolted on top of it. 32 random bytes hex-encoded either way
  # (MPESA_ENCRYPTION_KEY specifically needs to be a 32-byte key for
  # AES-256-GCM; SESSION_SECRET has no format requirement but the same
  # value shape is simplest to generate once and reuse).
  SESSION_SECRET_VAL="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  MPESA_KEY_VAL="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"

  SEED_OUTPUT="$TMP_DIR/seed-output-$suite.txt"
  RHINOCASH_DB_PATH="$TEST_DB_PATH" \
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
  # intended mechanism for retrieving them, not a workaround; there is no
  # other credential-export path in this codebase. Reading them back from
  # this suite's own captured file (not /tmp) is the only change from the
  # original approach.
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
  RHINOCASH_DB_PATH="$TEST_DB_PATH" \
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
  # mpesaConfig) legitimately `require('../src/db')` or read the DB file
  # directly, IN this same test process, rather than going only through
  # the HTTP API — to inspect encryption-at-rest, transaction atomicity,
  # etc. That in-process connection must resolve to the exact same
  # database and crypto keys the server was started with, or it silently
  # opens/creates a second, empty database at the old default path
  # instead (ENOENT / FK-constraint failures that look like application
  # bugs but are really just this process missing the same env the
  # server got).
  env SEEDED_ADMIN_PASSWORD="$ADMIN" SEEDED_MANAGER_PASSWORD="$MANAGER" \
      SEEDED_MANAGER_KISUMU_PASSWORD="$MANAGERK" SEEDED_REGIONAL_PASSWORD="$REGIONAL" \
      SEEDED_OPSMGR_PASSWORD="$OPSMGR" SEEDED_ACCOUNTANT_PASSWORD="$ACCOUNTANT" \
      SEEDED_OFFICER_PASSWORD="$OFFICER" SEEDED_CEO_PASSWORD="$CEO" \
      SEEDED_DIRECTOR_PASSWORD="$DIRECTOR" SEEDED_INVESTOR_PASSWORD="$INVESTOR" \
      BASE_URL="$BASE_URL" \
      RHINOCASH_DB_PATH="$TEST_DB_PATH" \
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
