// db.js — database connection + schema.
//
// V2 uses PostgreSQL (via the `pg` driver) instead of V1's node:sqlite.
// Every other module still talks to the database only through the
// exported `all`/`get`/`run`/`transaction` helpers below, so this is
// still the one file that knows it's Postgres.
//
// Design choices carried over deliberately from the SQLite version,
// and why:
//   - IDs stay app-generated TEXT (crypto.randomUUID()-based, prefixed
//     like 'usr_...'), not native UUID/serial columns — no code above
//     this file needs to change how it creates or compares ids.
//   - Timestamp columns stay TEXT, storing the exact same ISO-8601
//     strings (`YYYY-MM-DDTHH:MI:SS.sssZ`) the app has always used —
//     not native TIMESTAMPTZ. The entire app compares, slices, and
//     parses these as strings (`due_date < today`, `.slice(0,10)`,
//     `new Date(row.created_at)`); switching to native timestamps would
//     hand JS a `Date` object instead of a string at every one of those
//     call sites — a second, much deeper and riskier migration than
//     "change the database engine", and explicitly out of scope here.
//   - Boolean-flag columns (must_change_password, configured, read,
//     processed, allowed, ...) stay INTEGER (0/1), not native BOOLEAN —
//     JS's truthy/falsy checks on them (`!!user.must_change_password`)
//     behave identically either way, so there is no correctness reason
//     to touch them, and doing so would be a schema-type change with no
//     behavioral benefit.
//   - Money columns become real NUMERIC(14,2) (see "Money & precision"
//     in the README) instead of SQLite's REAL (an IEEE double even at
//     rest). That's a genuine precision improvement at the storage and
//     SQL-aggregation layer (SUM() etc. is now exact decimal arithmetic,
//     not float accumulation) with zero risk to the existing calculation
//     code: the type parser below hands NUMERIC values back to JS as
//     plain numbers, exactly what every existing arithmetic call site
//     already expects.
'use strict';
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');

// Postgres NUMERIC (OID 1700) comes back as a string by default — pg's own
// safeguard against silently losing precision for values a JS double can't
// exactly represent. This app's calculation code (loan schedules, interest,
// ledger balances, collection totals, ...) was written against node:sqlite,
// which always returned plain JS numbers for REAL/NUMERIC columns; parsing
// NUMERIC back to a number here keeps that contract, so every existing
// arithmetic call site is unchanged and correct. See the README for the one
// further step (an exact-decimal JS layer end-to-end) this deliberately
// does not take, and why.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

// Same reasoning for BIGINT/BIGSERIAL (OID 20) — every auto-increment id
// in this schema (audit_logs, loan_schedule, journal_entries,
// notifications, payment_allocations, login_attempts, loan_approvals) is
// BIGSERIAL, and pg's default of returning BIGINT as a string exists
// only to protect values that could exceed Number.MAX_SAFE_INTEGER. This
// app's own row-counter ids never approach that range, and node:sqlite
// always handed these back as plain numbers — parsing them back to a
// number here keeps every existing `row.id`-shaped comparison and every
// JSON response's id field exactly as it was.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

// Connection: a single DATABASE_URL is the one required piece of config
// (see .env.example). No hardcoded host/user/password/database name
// anywhere — a fresh clone must supply this itself.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Rhinocash V2 requires a PostgreSQL connection ' +
    'string, e.g. postgres://user:password@localhost:5432/rhinocash_dev — ' +
    'see .env.example.'
  );
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Modest pool ceiling — this is a microfinance branch-office app, not a
  // high-concurrency consumer service; a real production deployment can
  // raise this via PGPOOL_MAX if it genuinely needs to.
  max: Number(process.env.PGPOOL_MAX) || 10,
});
pool.on('error', (err) => {
  // A pool-level error (e.g. an idle client's connection was dropped by
  // the server) must never crash the whole process — log it and let the
  // pool recover the next time a client is requested.
  console.error('[pg pool error]', err.message);
});

// ---- transaction context ----
// Real BEGIN/COMMIT/ROLLBACK — the same guarantee the SQLite version's
// transaction() gave: every write inside fn() commits together or rolls
// back together, never left half-applied. Implemented with
// AsyncLocalStorage rather than threading a `client` parameter through
// every function signature in every route file: any all()/get()/run()
// call made anywhere during fn()'s execution (directly, or nested many
// calls deep through ordinary function calls) automatically joins the
// same transaction, with no call site above this file needing to know a
// transaction is even in progress. A transaction() call made while
// already inside one joins the outer transaction (same client, no nested
// BEGIN) — nested real code (e.g. a route handler that calls a shared
// helper which also wraps itself in transaction()) keeps working
// unchanged, exactly like the SQLite version's txDepth counter did.
const txContext = new AsyncLocalStorage();

function toPgParams(sql) {
  // Route files write ordinary `?` placeholders (kept unchanged from the
  // SQLite version, rather than hand-renumbering every one of the ~900
  // call sites across the codebase to Postgres's `$1, $2, ...` — that
  // hand-edit is exactly the kind of mechanical, error-prone change this
  // translation layer exists to avoid). `?` never legitimately appears
  // inside this app's own SQL strings outside of placeholders (no JSON
  // operators, no literal '?' in any query here), so a straight
  // left-to-right replace is safe.
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Ungated — talks straight to the pool/transaction client with no wait on
// schema readiness. Used only by schema setup itself (initSchema,
// ensureConstraint, startupSelfTest below): those ARE what establishes
// readiness, so they can't also wait on it without deadlocking on their
// own promise.
async function rawQuery(sql, params) {
  const pgSql = toPgParams(sql);
  const client = txContext.getStore();
  if (client) return client.query(pgSql, params);
  return pool.query(pgSql, params);
}
async function rawAll(sql, params = []) { return (await rawQuery(sql, params)).rows; }
async function rawGet(sql, params = []) { return (await rawQuery(sql, params)).rows[0]; }
async function rawRun(sql, params = []) { return { changes: (await rawQuery(sql, params)).rowCount }; }

// Gated — every ordinary call site in the app (every route file, seed.js,
// every test) goes through these. They transparently wait for schema
// setup to finish before the very first real query, so nothing above
// this file needs its own "has the schema been created yet?" check or an
// explicit ready-promise to await — exactly as transparent as module
// load was with the old synchronous node:sqlite driver.
async function query(sql, params) {
  await schemaReadyPromise;
  return rawQuery(sql, params);
}
async function all(sql, params = []) {
  const res = await query(sql, params);
  return res.rows;
}
async function get(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0];
}
async function run(sql, params = []) {
  const res = await query(sql, params);
  // Only `.changes` is ever read off a run() result anywhere in this
  // codebase (see routes/auth.js's session-revocation count) — never
  // lastInsertRowid, since every table's id is app-generated, not
  // auto-increment. rowCount is the exact equivalent.
  return { changes: res.rowCount };
}

async function transaction(fn) {
  await schemaReadyPromise;
  const existing = txContext.getStore();
  if (existing) return fn(); // join the outer transaction — no nested BEGIN
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await txContext.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* nothing left to roll back */ }
    throw e;
  } finally {
    client.release();
  }
}

const SCHEMA = `
-- Small helpers centralizing "an ISO-8601 string for right now" (and an
-- offset from it) in ONE place, in the one format every existing date/
-- string call site in the app already expects — see the file header for
-- why these columns are TEXT, not native timestamps.
CREATE OR REPLACE FUNCTION iso_now() RETURNS TEXT AS $$
  SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION iso_offset(delta INTERVAL) RETURNS TEXT AS $$
  SELECT to_char((now() + delta) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$ LANGUAGE SQL STABLE;

-- ===================== Access model =====================
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  default_access_level TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS role_modules (
  role_id TEXT NOT NULL REFERENCES roles(id),
  module_id TEXT NOT NULL REFERENCES modules(id),
  PRIMARY KEY (role_id, module_id)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id),
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  allowed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  location TEXT,
  phone TEXT,
  region_id TEXT REFERENCES regions(id),
  manager_id TEXT,
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS branch_proposals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  region_id TEXT REFERENCES regions(id),
  justification TEXT,
  feasibility_notes TEXT,
  budget NUMERIC(14,2),
  proposed_assigned_manager_id TEXT,
  status TEXT NOT NULL DEFAULT 'Proposed',
  proposed_by TEXT,
  decided_by TEXT,
  decided_at TEXT,
  decision_reason TEXT,
  branch_id TEXT REFERENCES branches(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

-- ===================== Users / Staff =====================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  staff_code TEXT UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  role_id TEXT NOT NULL REFERENCES roles(id),
  access_level TEXT NOT NULL,
  job_title TEXT,
  department_id TEXT REFERENCES departments(id),
  branch_id TEXT REFERENCES branches(id),
  region_id TEXT REFERENCES regions(id),
  reporting_manager_id TEXT REFERENCES users(id),
  employment_status TEXT NOT NULL DEFAULT 'Full-time',
  status TEXT NOT NULL DEFAULT 'Active',
  avatar_path TEXT,
  monthly_disbursement_target NUMERIC(14,2) DEFAULT 0,
  monthly_new_loan_target INTEGER DEFAULT 0,
  leave_days_balance INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT iso_now(),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_module_access (
  user_id TEXT NOT NULL REFERENCES users(id),
  module_id TEXT NOT NULL REFERENCES modules(id),
  PRIMARY KEY (user_id, module_id)
);

CREATE TABLE IF NOT EXISTS user_permission_overrides (
  user_id TEXT NOT NULL REFERENCES users(id),
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  allowed INTEGER NOT NULL,
  PRIMARY KEY (user_id, permission_id)
);

-- ===================== Sessions / security =====================
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT iso_now(),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  success INTEGER NOT NULL,
  reason TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  user_name TEXT,
  role_id TEXT,
  action TEXT NOT NULL,
  module TEXT,
  record_type TEXT,
  record_id TEXT,
  previous_value TEXT,
  new_value TEXT,
  reason TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

-- ===================== Clients =====================
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  client_code TEXT UNIQUE,
  name TEXT NOT NULL,
  gender TEXT,
  national_id TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  next_of_kin TEXT,
  next_of_kin_phone TEXT,
  business_type TEXT,
  client_type TEXT NOT NULL DEFAULT 'Individual',
  branch_id TEXT REFERENCES branches(id),
  officer_id TEXT REFERENCES users(id),
  group_id TEXT,
  status TEXT NOT NULL DEFAULT 'Active',
  verification_status TEXT NOT NULL DEFAULT 'Unverified',
  verified_by TEXT REFERENCES users(id),
  verified_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);
CREATE INDEX IF NOT EXISTS idx_clients_branch ON clients(branch_id);
CREATE INDEX IF NOT EXISTS idx_clients_officer ON clients(officer_id);

CREATE TABLE IF NOT EXISTS client_leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'New',
  notes TEXT,
  branch_id TEXT REFERENCES branches(id),
  converted_client_id TEXT REFERENCES clients(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS client_interactions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  type TEXT NOT NULL,
  note TEXT,
  staff_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS client_documents (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  doc_type TEXT,
  file_path TEXT,
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

-- ===================== Loans =====================
CREATE TABLE IF NOT EXISTS loan_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rate_type TEXT NOT NULL DEFAULT 'Flat',
  rate_pct NUMERIC(9,4) NOT NULL,
  min_amount NUMERIC(14,2) NOT NULL,
  max_amount NUMERIC(14,2) NOT NULL,
  min_term_months INTEGER NOT NULL,
  max_term_months INTEGER NOT NULL,
  fee_pct NUMERIC(9,4) NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS approval_workflow_steps (
  step_order INTEGER PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(id),
  status_label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  product_id TEXT NOT NULL REFERENCES loan_products(id),
  principal NUMERIC(14,2) NOT NULL,
  term_months INTEGER NOT NULL,
  rate_pct NUMERIC(9,4) NOT NULL,
  purpose TEXT,
  guarantor TEXT,
  guarantor_contact TEXT,
  loan_securities TEXT,
  loan_category TEXT,
  officer_id TEXT REFERENCES users(id),
  branch_id TEXT REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'Waiting for Manager',
  current_step INTEGER NOT NULL DEFAULT 1,
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT iso_now(),
  disbursed_at TEXT,
  written_off_at TEXT
);

CREATE TABLE IF NOT EXISTS loan_approvals (
  id BIGSERIAL PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  step_order INTEGER NOT NULL,
  approver_id TEXT NOT NULL REFERENCES users(id),
  role_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  comments TEXT,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS loan_schedule (
  id BIGSERIAL PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  period INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  principal_due NUMERIC(14,2) NOT NULL,
  interest_due NUMERIC(14,2) NOT NULL,
  total_due NUMERIC(14,2) NOT NULL,
  paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending'
);

-- ===================== Payments =====================
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  amount NUMERIC(14,2) NOT NULL,
  channel TEXT NOT NULL,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'Posted',
  allocated_principal NUMERIC(14,2) NOT NULL DEFAULT 0,
  allocated_interest NUMERIC(14,2) NOT NULL DEFAULT 0,
  recorded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

-- ===================== Accounting =====================
CREATE TABLE IF NOT EXISTS gl_accounts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id BIGSERIAL PRIMARY KEY,
  entry_date TEXT NOT NULL DEFAULT iso_now(),
  account_id TEXT NOT NULL REFERENCES gl_accounts(id),
  debit NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit NUMERIC(14,2) NOT NULL DEFAULT 0,
  description TEXT,
  ref_type TEXT,
  ref_id TEXT,
  branch_id TEXT REFERENCES branches(id),
  posted_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_branch ON journal_entries(branch_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_account ON journal_entries(account_id, entry_date);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  note TEXT,
  branch_id TEXT REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'Pending',
  submitted_by TEXT REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  paid_by TEXT REFERENCES users(id),
  rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS requisitions (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  description TEXT,
  branch_id TEXT REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'Pending',
  submitted_by TEXT REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  decision_reason TEXT,
  expense_id TEXT REFERENCES expenses(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS utility_payments (
  id TEXT PRIMARY KEY,
  utility_type TEXT NOT NULL,
  provider TEXT,
  account_reference TEXT,
  amount NUMERIC(14,2) NOT NULL,
  branch_id TEXT REFERENCES branches(id),
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'Paid',
  expense_id TEXT REFERENCES expenses(id),
  paid_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

-- ===================== Staff HR =====================
CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  leave_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS salary_advance_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount NUMERIC(14,2) NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

-- ===================== Investors =====================
CREATE TABLE IF NOT EXISTS investors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  password_hash TEXT,
  password_salt TEXT,
  amount NUMERIC(14,2) NOT NULL,
  profit_share_pct NUMERIC(9,4) NOT NULL,
  term_months INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS investor_payouts (
  id TEXT PRIMARY KEY,
  investor_id TEXT NOT NULL REFERENCES investors(id),
  period TEXT NOT NULL,
  company_net_profit NUMERIC(14,2) NOT NULL DEFAULT 0,
  investor_profit NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending',
  reference TEXT,
  paid_at TEXT
);

-- ===================== M-Pesa integration surface =====================
CREATE TABLE IF NOT EXISTS mpesa_environment_configs (
  environment TEXT PRIMARY KEY,
  consumer_key_enc TEXT,
  consumer_secret_enc TEXT,
  shortcode TEXT,
  passkey_enc TEXT,
  callback_url TEXT,
  initiator_name TEXT,
  security_credential_enc TEXT,
  b2c_shortcode TEXT,
  configured INTEGER NOT NULL DEFAULT 0,
  b2c_configured INTEGER NOT NULL DEFAULT 0,
  last_test_status TEXT NOT NULL DEFAULT 'Never Tested',
  last_test_at TEXT,
  last_test_message TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS mpesa_active_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_environment TEXT
);

CREATE TABLE IF NOT EXISTS mpesa_b2c_requests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT UNIQUE,
  originator_conversation_id TEXT UNIQUE,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  phone TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  environment TEXT,
  status TEXT NOT NULL DEFAULT 'Requested',
  result_code TEXT,
  result_desc TEXT,
  mpesa_receipt_number TEXT,
  initiated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now(),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS mpesa_c2b_transactions (
  id TEXT PRIMARY KEY,
  trans_id TEXT NOT NULL UNIQUE,
  environment TEXT,
  amount NUMERIC(14,2),
  msisdn TEXT,
  bill_ref_number TEXT,
  matched_loan_id TEXT REFERENCES loans(id),
  match_method TEXT,
  payment_id TEXT REFERENCES payments(id),
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS mpesa_stk_requests (
  checkout_request_id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  phone TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  account_ref TEXT,
  environment TEXT,
  initiated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS mpesa_callbacks (
  id TEXT PRIMARY KEY,
  checkout_request_id TEXT NOT NULL UNIQUE,
  environment TEXT,
  result_code TEXT,
  result_desc TEXT,
  amount NUMERIC(14,2),
  mpesa_receipt_number TEXT,
  phone TEXT,
  loan_id TEXT REFERENCES loans(id),
  payment_id TEXT REFERENCES payments(id),
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

-- ===================== Target / Performance Management =====================
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,
  recipient_user_id TEXT REFERENCES users(id),
  branch_id TEXT REFERENCES branches(id),
  region_id TEXT REFERENCES regions(id),
  set_by TEXT REFERENCES users(id),
  target_value NUMERIC(14,2) NOT NULL,
  period TEXT NOT NULL,
  period_type TEXT NOT NULL DEFAULT 'monthly',
  status TEXT NOT NULL DEFAULT 'Active',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT iso_now(),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_targets_recipient ON targets(recipient_user_id, period);
CREATE INDEX IF NOT EXISTS idx_targets_branch ON targets(branch_id, period);

-- ===================== Payment allocation traceability =====================
CREATE TABLE IF NOT EXISTS payment_allocations (
  id BIGSERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  schedule_id BIGINT NOT NULL REFERENCES loan_schedule(id),
  period INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  amount_applied NUMERIC(14,2) NOT NULL,
  bucket TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment ON payment_allocations(payment_id);

-- ===================== Accounting Periods =====================
CREATE TABLE IF NOT EXISTS accounting_periods (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'Open',
  closed_by TEXT REFERENCES users(id),
  closed_at TEXT,
  reopened_by TEXT REFERENCES users(id),
  reopened_at TEXT,
  reopen_reason TEXT
);

-- ===================== Collections =====================
CREATE TABLE IF NOT EXISTS collection_activities (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  loan_id TEXT REFERENCES loans(id),
  staff_id TEXT NOT NULL REFERENCES users(id),
  activity_type TEXT NOT NULL,
  notes TEXT,
  outcome TEXT,
  next_follow_up_date TEXT,
  branch_id TEXT REFERENCES branches(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);
CREATE INDEX IF NOT EXISTS idx_collection_activities_client ON collection_activities(client_id);
CREATE INDEX IF NOT EXISTS idx_collection_activities_staff ON collection_activities(staff_id);

CREATE TABLE IF NOT EXISTS follow_ups (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  loan_id TEXT REFERENCES loans(id),
  responsible_staff_id TEXT NOT NULL REFERENCES users(id),
  follow_up_date TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  notes TEXT,
  outcome TEXT,
  branch_id TEXT REFERENCES branches(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_staff ON follow_ups(responsible_staff_id, status);

CREATE TABLE IF NOT EXISTS promises_to_pay (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  loan_id TEXT NOT NULL REFERENCES loans(id),
  promised_amount NUMERIC(14,2) NOT NULL,
  promise_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',
  fulfilled_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  fulfilled_at TEXT,
  notes TEXT,
  branch_id TEXT REFERENCES branches(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);
CREATE INDEX IF NOT EXISTS idx_promises_loan ON promises_to_pay(loan_id);

-- ===================== Governance: Board Resolutions & Equity =====================
CREATE TABLE IF NOT EXISTS board_resolutions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'Proposed',
  proposed_by TEXT REFERENCES users(id),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS equity_holdings (
  id TEXT PRIMARY KEY,
  holder_name TEXT NOT NULL,
  holder_type TEXT NOT NULL,
  percentage NUMERIC(9,4) NOT NULL,
  capital_contributed NUMERIC(14,2),
  notes TEXT,
  recorded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS adjustments (
  id TEXT PRIMARY KEY,
  reference TEXT,
  reason TEXT NOT NULL,
  debit_account TEXT NOT NULL REFERENCES gl_accounts(id),
  credit_account TEXT NOT NULL REFERENCES gl_accounts(id),
  amount NUMERIC(14,2) NOT NULL,
  branch_id TEXT REFERENCES branches(id),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'Draft',
  created_by TEXT REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS organization_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT,
  trading_name TEXT,
  registration_number TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  currency TEXT NOT NULL DEFAULT 'KES',
  timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi',
  financial_year_start_month INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS system_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  maintenance_mode INTEGER NOT NULL DEFAULT 0,
  maintenance_message TEXT,
  session_warning_minutes INTEGER NOT NULL DEFAULT 5,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'Completed',
  table_count INTEGER,
  row_count INTEGER,
  size_bytes BIGINT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS report_filter_presets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS communication_log (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  template TEXT NOT NULL,
  recipient TEXT,
  subject TEXT,
  status TEXT NOT NULL,
  related_type TEXT,
  related_id TEXT,
  sent_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS ticket_filter_presets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  priority TEXT NOT NULL DEFAULT 'Medium',
  status TEXT NOT NULL DEFAULT 'Open',
  assigned_to TEXT REFERENCES users(id),
  created_by TEXT REFERENCES users(id),
  branch_id TEXT REFERENCES branches(id),
  client_id TEXT REFERENCES clients(id),
  loan_id TEXT REFERENCES loans(id),
  created_at TEXT NOT NULL DEFAULT iso_now(),
  resolved_at TEXT,
  reopened_at TEXT,
  escalated_at TEXT
);

CREATE TABLE IF NOT EXISTS support_ticket_comments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  author_id TEXT REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE TABLE IF NOT EXISTS faq_articles (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now()
);

-- Internal staff-to-staff direct messaging. One conversation per unordered
-- pair of users (enforced by always storing user_a < user_b and the UNIQUE
-- constraint below), so starting a chat with the same colleague twice
-- always returns the same conversation rather than creating duplicates.
-- Deliberately never touches investors — the investor principal type stays
-- structurally isolated from staff data, same as every other module.
CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL REFERENCES users(id),
  user_b TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT iso_now(),
  last_message_at TEXT,
  UNIQUE(user_a, user_b)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT iso_now(),
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS client_risk_config (
  id TEXT PRIMARY KEY,
  rule_name TEXT NOT NULL UNIQUE,
  threshold_value NUMERIC(9,4) NOT NULL,
  description TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT iso_now()
);

CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
CREATE INDEX IF NOT EXISTS idx_loans_officer ON loans(officer_id);
CREATE INDEX IF NOT EXISTS idx_loans_branch ON loans(branch_id);
CREATE INDEX IF NOT EXISTS idx_payments_loan ON payments(loan_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

// The FK additions on branches.manager_id / branch_proposals.* reference
// users(id), and users references branches(id) — a genuine circular
// dependency, unlike SQLite (which never actually enforces a FK it can't
// resolve at CREATE time unless PRAGMA foreign_keys is on AND the
// referenced table already exists — this schema relied on that laxness).
// Postgres enforces every FK it's given, so branches/branch_proposals are
// created above with those specific columns as plain TEXT (no inline
// REFERENCES), and the FKs are added here instead, once both sides exist.
// ALTER ... ADD CONSTRAINT has no IF NOT EXISTS in Postgres, so each is
// guarded individually against being re-run on a database that already
// has it — using the raw, ungated helpers since this function IS what
// establishes schema readiness.
async function ensureConstraint(name, ddl) {
  const exists = await rawGet(`SELECT 1 FROM pg_constraint WHERE conname = ?`, [name]);
  if (!exists) await rawRun(ddl);
}

async function initSchema() {
  await rawQuery(SCHEMA);
  await ensureConstraint('branches_manager_fk',
    'ALTER TABLE branches ADD CONSTRAINT branches_manager_fk FOREIGN KEY (manager_id) REFERENCES users(id)');
  await ensureConstraint('branch_proposals_manager_fk',
    'ALTER TABLE branch_proposals ADD CONSTRAINT branch_proposals_manager_fk FOREIGN KEY (proposed_assigned_manager_id) REFERENCES users(id)');
  await ensureConstraint('branch_proposals_proposed_by_fk',
    'ALTER TABLE branch_proposals ADD CONSTRAINT branch_proposals_proposed_by_fk FOREIGN KEY (proposed_by) REFERENCES users(id)');
  await ensureConstraint('branch_proposals_decided_by_fk',
    'ALTER TABLE branch_proposals ADD CONSTRAINT branch_proposals_decided_by_fk FOREIGN KEY (decided_by) REFERENCES users(id)');
}

// Explicit startup self-test: prove the database can actually be written
// to right now, rather than discovering this for the first time during a
// user's login attempt — carried over from the SQLite version's same
// real fix, now against the real failure modes that matter for Postgres
// (wrong DATABASE_URL, server not running, role lacks privileges,
// database doesn't exist) instead of filesystem/journal ones.
async function startupSelfTest() {
  try {
    await initSchema();
    await rawRun('CREATE TABLE IF NOT EXISTS _startup_write_check (id BIGSERIAL PRIMARY KEY, checked_at TEXT)');
    await rawRun('INSERT INTO _startup_write_check (checked_at) VALUES (?)', [new Date().toISOString()]);
    await rawRun('DROP TABLE _startup_write_check');
  } catch (e) {
    throw new Error(
      `Rhinocash could not initialize its PostgreSQL database: ${e.message}\n` +
      `DATABASE_URL: ${DATABASE_URL.replace(/:[^:@]*@/, ':****@')}\n` +
      `Check that PostgreSQL is running, the database exists, and the ` +
      `role in DATABASE_URL has CREATE privileges on it — see README ` +
      `"PostgreSQL setup".`
    );
  }
}

// Every ordinary all()/get()/run()/transaction() call transparently
// awaits this once (see query() above) before its real query — nothing
// above this file needs to know schema setup is even a separate step.
const schemaReadyPromise = startupSelfTest();
// Surface a real startup failure immediately and loudly (unhandled
// rejection -> non-zero exit) rather than only on the first request.
schemaReadyPromise.catch((e) => { console.error(e.message); process.exitCode = 1; });

module.exports = { pool, all, get, run, transaction, ready: schemaReadyPromise, DATABASE_URL };
