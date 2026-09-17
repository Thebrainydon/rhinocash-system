// db.js — database connection + schema.
//
// Uses Node's built-in `node:sqlite` (stable enough to build on, still
// flagged experimental upstream — see README "Moving to Postgres" for the
// production-scale path). Zero external dependencies: this file is the
// entire data layer. Every other module talks to the database only through
// the exported `db` handle and the query helpers below, so swapping engines
// later means rewriting this one file, not the whole app.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
// Defensive, explicit permission check — fail loudly and early at startup
// with an actionable message, rather than letting a cryptic native SQLite
// error surface later during a user's login attempt.
try {
  fs.chmodSync(DATA_DIR, 0o755);
} catch (e) {
  // Non-fatal: chmod can fail on some filesystems (e.g. certain Android
  // storage backends) even when the directory is genuinely writable;
  // the accessSync check below is the real gate.
}
try {
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  throw new Error(
    `Rhinocash database directory is not writable: ${DATA_DIR}\n` +
    `Set RHINOCASH_DB_PATH to a writable location, or fix permissions on this directory.`
  );
}
const DB_PATH = process.env.RHINOCASH_DB_PATH || path.join(DATA_DIR, 'rhinocash.db');
const dbFileExistedBeforeOpen = fs.existsSync(DB_PATH);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
// Real fix for "attempt to write a readonly database" on constrained/
// FUSE-backed filesystems (this affects Termux/Android storage in
// particular): SQLite's DEFAULT rollback-journal mode needs to create a
// `-journal` sidecar file in this same directory on every write
// transaction, and that sidecar-file creation is exactly what fails on
// those filesystems even though ordinary file creation succeeds. WAL
// mode uses `-wal`/`-shm` sidecar files instead, which are compatible
// with far more filesystem types, and is the standard, documented fix
// for this exact failure mode — not a workaround, the correct journal
// mode for this deployment target.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');

// Explicit startup self-test: prove the database can actually be
// written to right now, at server boot, rather than discovering this
// for the first time during a user's login attempt. This makes the
// database lifecycle explicit — the server should refuse to start with
// a clear message instead of starting "successfully" and then failing
// opaquely on the first real write.
try {
  db.exec('CREATE TABLE IF NOT EXISTS _startup_write_check (id INTEGER PRIMARY KEY, checked_at TEXT)');
  db.prepare('INSERT INTO _startup_write_check (checked_at) VALUES (?)').run(new Date().toISOString());
  db.exec('DROP TABLE _startup_write_check');
} catch (e) {
  throw new Error(
    `Rhinocash database opened but a real write attempt failed: ${e.message}\n` +
    `Database path: ${DB_PATH}\n` +
    `This is almost always a filesystem/journal-mode incompatibility (common on ` +
    `Termux/Android storage), not a code bug. If this error persists after the WAL ` +
    `journal-mode fix, try setting RHINOCASH_DB_PATH to a path on internal, non-FUSE ` +
    `storage (e.g. Termux's own $HOME, not shared/external storage).`
  );
}

const SCHEMA = `
-- ===================== Access model =====================
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,                 -- e.g. 'loan_officer', 'admin'
  name TEXT NOT NULL UNIQUE,           -- display name, e.g. 'Loan Officer'
  default_access_level TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,                 -- e.g. 'approve_loans'
  label TEXT NOT NULL UNIQUE           -- e.g. 'Approve Loans'
);

CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,                 -- e.g. 'clients', 'loanbook'
  label TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS role_modules (      -- baseline module access per role
  role_id TEXT NOT NULL REFERENCES roles(id),
  module_id TEXT NOT NULL REFERENCES modules(id),
  PRIMARY KEY (role_id, module_id)
);

CREATE TABLE IF NOT EXISTS role_permissions (  -- baseline action permissions per role
  role_id TEXT NOT NULL REFERENCES roles(id),
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  allowed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',  -- Active | Inactive
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  location TEXT,
  phone TEXT,
  region_id TEXT REFERENCES regions(id),
  manager_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'Active',       -- Active | Closed | Pending Opening
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- Branch expansion: a real proposal -> approval -> activation workflow
-- (instruction: do not create an Open New Branch menu that only displays
-- a form). No row in the branches table exists until a proposal is approved.
CREATE TABLE IF NOT EXISTS branch_proposals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  region_id TEXT REFERENCES regions(id),
  justification TEXT,
  feasibility_notes TEXT,
  budget REAL,
  proposed_assigned_manager_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'Proposed', -- Proposed | Approved | Rejected | Activated
  proposed_by TEXT REFERENCES users(id),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  decision_reason TEXT,
  branch_id TEXT REFERENCES branches(id),  -- set once approved and the real branch row exists
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  status TEXT NOT NULL DEFAULT 'Active',        -- Active | Suspended | Deactivated
  avatar_path TEXT,                             -- real uploaded-file reference, see /uploads
  monthly_disbursement_target REAL DEFAULT 0,
  monthly_new_loan_target INTEGER DEFAULT 0,
  leave_days_balance INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_module_access (   -- personal override; presence = restriction list
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
  token_hash TEXT PRIMARY KEY,           -- sha256 of the bearer token; raw token never stored
  user_id TEXT NOT NULL,                 -- references users(id) OR investors(id) — two principal
                                          -- types share this table, so no single FK target fits;
                                          -- referential integrity for this column is enforced in
                                          -- application code (see requireAuth / requireInvestorAuth).
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  success INTEGER NOT NULL,
  reason TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  client_type TEXT NOT NULL DEFAULT 'Individual',  -- Individual | SME | Group
  branch_id TEXT REFERENCES branches(id),
  officer_id TEXT REFERENCES users(id),
  group_id TEXT,
  status TEXT NOT NULL DEFAULT 'Active',           -- Active | Dormant | Blacklisted
  verification_status TEXT NOT NULL DEFAULT 'Unverified',  -- Unverified | Pending | Verified | Rejected
  verified_by TEXT REFERENCES users(id),
  verified_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clients_branch ON clients(branch_id);
CREATE INDEX IF NOT EXISTS idx_clients_officer ON clients(officer_id);

CREATE TABLE IF NOT EXISTS client_leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'New',              -- New | Contacted | Converted
  notes TEXT,
  converted_client_id TEXT REFERENCES clients(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS client_interactions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  type TEXT NOT NULL,                              -- Call | Visit | SMS | Meeting
  note TEXT,
  staff_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS client_documents (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  doc_type TEXT,
  file_path TEXT,                                  -- real uploaded-file reference
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Loans =====================
CREATE TABLE IF NOT EXISTS loan_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rate_type TEXT NOT NULL DEFAULT 'Flat',
  rate_pct REAL NOT NULL,
  min_amount REAL NOT NULL,
  max_amount REAL NOT NULL,
  min_term_months INTEGER NOT NULL,
  max_term_months INTEGER NOT NULL,
  fee_pct REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- The 4-level sequential workflow lives as an ordered config, not a hardcoded
-- if/else chain, so the sequence itself is data (per instruction #11: "the
-- exact workflow must be stored in the database").
CREATE TABLE IF NOT EXISTS approval_workflow_steps (
  step_order INTEGER PRIMARY KEY,        -- 1, 2, 3, 4
  role_id TEXT NOT NULL REFERENCES roles(id),
  status_label TEXT NOT NULL             -- e.g. 'Waiting for Manager'
);

CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  product_id TEXT NOT NULL REFERENCES loan_products(id),
  principal REAL NOT NULL,
  term_months INTEGER NOT NULL,
  rate_pct REAL NOT NULL,
  purpose TEXT,
  guarantor TEXT,
  guarantor_contact TEXT,
  loan_securities TEXT,
  loan_category TEXT,  -- optional real classification: New | Top-up | Renewal | Emergency
  officer_id TEXT REFERENCES users(id),
  branch_id TEXT REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'Waiting for Manager',
  -- status values: 'Waiting for Manager' | 'Waiting for Regional Manager' |
  -- 'Waiting for Operational Manager' | 'Waiting for Accountant' |
  -- 'Approved for Disbursement' | 'Disbursed' | 'Active' | 'Rejected' |
  -- 'Returned for Correction' | 'Completed' | 'Written Off' | 'Restructured'
  current_step INTEGER NOT NULL DEFAULT 1,
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  disbursed_at TEXT,
  written_off_at TEXT
);

-- Every approval decision, permanently — matches instruction #11/#12 exactly:
-- approver, role, decision, date/time, comments, previous/new status.
CREATE TABLE IF NOT EXISTS loan_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  step_order INTEGER NOT NULL,
  approver_id TEXT NOT NULL REFERENCES users(id),
  role_id TEXT NOT NULL,
  decision TEXT NOT NULL,               -- Approved | Rejected | Returned
  comments TEXT,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loan_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  period INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  principal_due REAL NOT NULL,
  interest_due REAL NOT NULL,
  total_due REAL NOT NULL,
  paid_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending'   -- Pending | Partial | Paid | Overdue
);

-- ===================== Payments =====================
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  amount REAL NOT NULL,
  channel TEXT NOT NULL,                 -- M-Pesa | Bank | Cash
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'Posted', -- Unposted | Posted | Overpayment | Reversed
  allocated_principal REAL NOT NULL DEFAULT 0,
  allocated_interest REAL NOT NULL DEFAULT 0,
  recorded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Accounting =====================
CREATE TABLE IF NOT EXISTS gl_accounts (          -- Chart of Accounts
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL,            -- Asset | Liability | Equity | Revenue | Expense
  status TEXT NOT NULL DEFAULT 'Active'  -- Active | Inactive — deactivate, never hard-delete an account with real postings
);

CREATE TABLE IF NOT EXISTS journal_entries (       -- General Ledger / Cashbook feed
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL DEFAULT (datetime('now')),
  account_id TEXT NOT NULL REFERENCES gl_accounts(id),
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  description TEXT,
  ref_type TEXT,                          -- 'loan' | 'payment' | 'expense' | ...
  ref_id TEXT,
  branch_id TEXT REFERENCES branches(id), -- real branch attribution — every posting route below now sets this
  posted_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_branch ON journal_entries(branch_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_account ON journal_entries(account_id, entry_date);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  branch_id TEXT REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'Pending', -- Pending | Approved | Paid | Rejected
  submitted_by TEXT REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  paid_by TEXT REFERENCES users(id),
  rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Requisitions =====================
-- Staff submits -> Manager approves -> Accountant verifies/pays. Reuses
-- the same expenses table + real accounting posting once actually paid,
-- rather than a second competing financial-record mechanism — a
-- requisition IS an expense with a pre-payment approval chain in front of it.
CREATE TABLE IF NOT EXISTS requisitions (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT,
  branch_id TEXT REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'Pending', -- Pending | Approved | Rejected | Returned | Paid | Cancelled
  submitted_by TEXT REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  decision_reason TEXT,
  expense_id TEXT REFERENCES expenses(id), -- set once paid — the real expense/journal record this requisition became
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Utility Payments =====================
-- A thin, purpose-specific record (provider/account number/utility type)
-- that becomes a real expense (and therefore a real balanced journal
-- entry) once paid — not a parallel accounting engine.
CREATE TABLE IF NOT EXISTS utility_payments (
  id TEXT PRIMARY KEY,
  utility_type TEXT NOT NULL,             -- Electricity | Water | Internet | Rent | Telephone | Other
  provider TEXT,
  account_reference TEXT,
  amount REAL NOT NULL,
  branch_id TEXT REFERENCES branches(id),
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'Paid',    -- mirrors the expense it creates
  expense_id TEXT REFERENCES expenses(id),
  paid_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Staff HR =====================
CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  leave_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Pending', -- Pending | Approved | Rejected
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS salary_advance_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Investors =====================
CREATE TABLE IF NOT EXISTS investors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  password_hash TEXT,
  password_salt TEXT,
  amount REAL NOT NULL,
  profit_share_pct REAL NOT NULL,
  term_months INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',  -- Active | Completed
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS investor_payouts (
  id TEXT PRIMARY KEY,
  investor_id TEXT NOT NULL REFERENCES investors(id),
  period TEXT NOT NULL,                  -- 'YYYY-MM'
  company_net_profit REAL NOT NULL DEFAULT 0,
  investor_profit REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending', -- Pending | Paid
  reference TEXT,
  paid_at TEXT
);

-- ===================== Notifications / Support =====================
-- ===================== M-Pesa integration surface (see src/integrations/mpesa.js) =====================
-- Credentials are stored encrypted (AES-256-GCM, src/crypto.js) — this
-- table never holds a plaintext consumer_secret/consumer_key/passkey.
-- One row per environment; only the active one is actually used to call
-- Safaricom, but both can be configured and tested independently so
-- switching between them is a single flag flip, not a re-entry of secrets.
CREATE TABLE IF NOT EXISTS mpesa_environment_configs (
  environment TEXT PRIMARY KEY,          -- 'sandbox' | 'production'
  consumer_key_enc TEXT,
  consumer_secret_enc TEXT,
  shortcode TEXT,                        -- not secret, safe to store plain
  passkey_enc TEXT,
  callback_url TEXT,
  initiator_name TEXT,                   -- not secret — the real Daraja B2C initiator username
  security_credential_enc TEXT,          -- real secret — the encrypted initiator password, Safaricom-cert-encrypted in production
  b2c_shortcode TEXT,                    -- often the same as shortcode, but Safaricom allows a distinct B2C-enabled shortcode
  configured INTEGER NOT NULL DEFAULT 0, -- 1 once every required field is present
  b2c_configured INTEGER NOT NULL DEFAULT 0, -- 1 once initiator_name + security_credential + b2c_shortcode are present — B2C is optional, STK/C2B can work without it
  last_test_status TEXT NOT NULL DEFAULT 'Never Tested', -- Never Tested | Connection Successful | Connection Failed
  last_test_at TEXT,
  last_test_message TEXT,                -- safe, human-readable only — never a raw secret or raw provider error body
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS mpesa_active_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_environment TEXT                -- 'sandbox' | 'production' | NULL
);

CREATE TABLE IF NOT EXISTS mpesa_b2c_requests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT UNIQUE,             -- Safaricom's ConversationID — the real de-dupe key once accepted
  originator_conversation_id TEXT UNIQUE,  -- our own real idempotency key, generated before the API call
  loan_id TEXT NOT NULL REFERENCES loans(id),
  phone TEXT NOT NULL,
  amount REAL NOT NULL,
  environment TEXT,
  status TEXT NOT NULL DEFAULT 'Requested',  -- Requested | Pending | Success | Failed | Timeout
  result_code TEXT,
  result_desc TEXT,
  mpesa_receipt_number TEXT,
  initiated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);


CREATE TABLE IF NOT EXISTS mpesa_c2b_transactions (
  id TEXT PRIMARY KEY,
  trans_id TEXT NOT NULL UNIQUE,  -- Safaricom's TransID — the real C2B de-dupe key
  environment TEXT,
  amount REAL,
  msisdn TEXT,
  bill_ref_number TEXT,           -- what the customer typed as "Account Number" at the till/paybill
  matched_loan_id TEXT REFERENCES loans(id),
  match_method TEXT,              -- 'loan_id' | 'phone' | 'unmatched'
  payment_id TEXT REFERENCES payments(id),
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);


CREATE TABLE IF NOT EXISTS mpesa_stk_requests (
  checkout_request_id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  phone TEXT NOT NULL,
  amount REAL NOT NULL,
  account_ref TEXT,
  environment TEXT,
  initiated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mpesa_callbacks (
  id TEXT PRIMARY KEY,
  checkout_request_id TEXT NOT NULL UNIQUE,   -- Safaricom's id — the natural de-dupe key
  environment TEXT,
  result_code TEXT,
  result_desc TEXT,
  amount REAL,
  mpesa_receipt_number TEXT,
  phone TEXT,
  loan_id TEXT REFERENCES loans(id),
  payment_id TEXT REFERENCES payments(id),  -- set once the callback has genuinely become a real payment
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Target / Performance Management =====================
-- One unified table for the whole hierarchy (Loan Officer targets set by
-- Manager, Manager targets set by Regional Manager, Regional Manager
-- targets set by Operational Manager, org-wide targets set by CEO/Director)
-- rather than a separate mechanism per level. The existing
-- users.monthly_disbursement_target / monthly_new_loan_target columns stay
-- exactly as they are and remain the fallback the performance table already
-- uses — a row here for the current period simply takes priority once one
-- exists, so nothing that already worked stops working.
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,                    -- 'disbursement' | 'new_loans' | 'collection' | 'collection_rate' | 'portfolio' | 'new_clients'
  recipient_user_id TEXT REFERENCES users(id),   -- who the target is for (an individual)
  branch_id TEXT REFERENCES branches(id),        -- set instead of/alongside recipient for a branch-aggregate target
  region_id TEXT REFERENCES regions(id),         -- set for a region-aggregate target
  set_by TEXT REFERENCES users(id),
  target_value REAL NOT NULL,
  period TEXT NOT NULL,                    -- 'YYYY-MM' for monthly; 'YYYY-Qn' quarterly; 'YYYY' yearly — paired with period_type
  period_type TEXT NOT NULL DEFAULT 'monthly',
  status TEXT NOT NULL DEFAULT 'Active',   -- Active | Cancelled
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_targets_recipient ON targets(recipient_user_id, period);
CREATE INDEX IF NOT EXISTS idx_targets_branch ON targets(branch_id, period);

-- ===================== Payment allocation traceability =====================
-- One row per real schedule installment a payment actually touched,
-- written by the same allocate() loop that already updates loan_schedule —
-- not a second, separately-computed classification. This is what makes
-- "was this payment a prepayment" a real fact instead of a guess: we know,
-- for each installment a payment was applied to, whether that installment
-- was already due, still in the future, or overdue at the moment of payment.
CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  schedule_id INTEGER NOT NULL REFERENCES loan_schedule(id),
  period INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  amount_applied REAL NOT NULL,
  bucket TEXT NOT NULL   -- 'arrears' | 'current' | 'future' — relative to due_date vs. payment date
);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment ON payment_allocations(payment_id);

-- ===================== Accounting Periods =====================
CREATE TABLE IF NOT EXISTS accounting_periods (
  id TEXT PRIMARY KEY,        -- 'YYYY-MM'
  status TEXT NOT NULL DEFAULT 'Open',  -- Open | Closed
  closed_by TEXT REFERENCES users(id),
  closed_at TEXT,
  reopened_by TEXT REFERENCES users(id),
  reopened_at TEXT,
  reopen_reason TEXT
);

-- ===================== Collections =====================
-- Real, genuinely new entities — the loan schedule/payments/PAR
-- calculations that Collections is BUILT ON already exist and are reused
-- as-is; these three tables cover the parts of Collections that had no
-- database representation anywhere in the system before now.
CREATE TABLE IF NOT EXISTS collection_activities (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  loan_id TEXT REFERENCES loans(id),
  staff_id TEXT NOT NULL REFERENCES users(id),
  activity_type TEXT NOT NULL,   -- Phone Call | SMS | WhatsApp | Visit | Promise to Pay | Payment Received | No Contact | Client Unavailable | Follow-Up Required | Other
  notes TEXT,
  outcome TEXT,
  next_follow_up_date TEXT,
  branch_id TEXT REFERENCES branches(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  status TEXT NOT NULL DEFAULT 'Pending',  -- Pending | Completed | Cancelled | Overdue (Overdue is derived, not stored — see route)
  notes TEXT,
  outcome TEXT,
  branch_id TEXT REFERENCES branches(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_staff ON follow_ups(responsible_staff_id, status);

CREATE TABLE IF NOT EXISTS promises_to_pay (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  loan_id TEXT NOT NULL REFERENCES loans(id),
  promised_amount REAL NOT NULL,
  promise_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',  -- Pending | Fulfilled | Partially Fulfilled | Broken | Cancelled
  fulfilled_amount REAL NOT NULL DEFAULT 0,
  fulfilled_at TEXT,
  notes TEXT,
  branch_id TEXT REFERENCES branches(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_promises_loan ON promises_to_pay(loan_id);

-- ===================== Governance: Board Resolutions & Equity =====================
-- Genuinely new entities for Director-level governance — previously these
-- were explicitly NOT backed by any real table (documented as session-only
-- in earlier work). Real, small, auditable structures, not decorative.
CREATE TABLE IF NOT EXISTS board_resolutions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'Proposed',  -- Proposed | Approved | Rejected
  proposed_by TEXT REFERENCES users(id),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equity_holdings (
  id TEXT PRIMARY KEY,
  holder_name TEXT NOT NULL,
  holder_type TEXT NOT NULL,  -- Founder | Investor | Employee | Other
  percentage REAL NOT NULL,
  capital_contributed REAL,
  notes TEXT,
  recorded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);


-- A separate, explicit correction mechanism — distinct from expenses/
-- requisitions/payments, which all represent real business transactions.
-- An adjustment exists only to correct the books themselves.
CREATE TABLE IF NOT EXISTS adjustments (
  id TEXT PRIMARY KEY,
  reference TEXT,
  reason TEXT NOT NULL,
  debit_account TEXT NOT NULL REFERENCES gl_accounts(id),
  credit_account TEXT NOT NULL REFERENCES gl_accounts(id),
  amount REAL NOT NULL,
  branch_id TEXT REFERENCES branches(id),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'Draft', -- Draft | Submitted | Approved | Rejected | Posted
  created_by TEXT REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);


CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id),      -- NULL = broadcast/system-wide
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  status TEXT NOT NULL DEFAULT 'Completed',  -- Completed | Failed
  table_count INTEGER,
  row_count INTEGER,
  size_bytes INTEGER,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS report_filter_presets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);


CREATE TABLE IF NOT EXISTS communication_log (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,          -- 'sms' | 'email'
  template TEXT NOT NULL,
  recipient TEXT,                 -- phone or email address — never a credential
  subject TEXT,                   -- email only
  status TEXT NOT NULL,           -- mirrors the real integration's honest status (e.g. NOT_CONFIGURED)
  related_type TEXT,              -- e.g. 'Ticket'
  related_id TEXT,
  sent_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_filter_presets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);


CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',  -- General | Technical | Billing | Feature Request | Bug Report | Account
  priority TEXT NOT NULL DEFAULT 'Medium',   -- Low | Medium | High | Critical (Medium == "Normal" in the spec's naming)
  status TEXT NOT NULL DEFAULT 'Open',       -- Open | In Progress | Resolved | Closed
  assigned_to TEXT REFERENCES users(id),
  created_by TEXT REFERENCES users(id),
  branch_id TEXT REFERENCES branches(id),   -- captured at creation, drives visibility scoping
  client_id TEXT REFERENCES clients(id),
  loan_id TEXT REFERENCES loans(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  reopened_at TEXT,
  escalated_at TEXT   -- set once, real idempotent escalation marker — never re-escalated on every page load
);

CREATE TABLE IF NOT EXISTS support_ticket_comments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  author_id TEXT REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faq_articles (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Real, configurable thresholds used consistently for collection-rate and
-- portfolio-quality classification across LoanBook (Strong/Normal/Needs
-- Attention, and quality ratings) — a single source of truth, never a
-- second per-page formula.
CREATE TABLE IF NOT EXISTS client_risk_config (
  id TEXT PRIMARY KEY,
  rule_name TEXT NOT NULL UNIQUE,
  threshold_value REAL NOT NULL,
  description TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
CREATE INDEX IF NOT EXISTS idx_loans_officer ON loans(officer_id);
CREATE INDEX IF NOT EXISTS idx_loans_branch ON loans(branch_id);
CREATE INDEX IF NOT EXISTS idx_payments_loan ON payments(loan_id);
CREATE INDEX IF NOT EXISTS idx_clients_branch ON clients(branch_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

db.exec(SCHEMA);

// ---- tiny query helpers (keeps route files free of raw SQL boilerplate) ----
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }

// Real BEGIN/COMMIT/ROLLBACK transaction wrapper — the fix for the
// production-readiness audit's critical finding (no atomicity around
// multi-step financial writes). fn is a synchronous function containing
// ordinary run()/all()/get() calls; on any thrown error every change
// inside is rolled back together, never left half-applied.
//
// SQLite does not support nested BEGIN — a transaction() call made while
// already inside one (e.g. a route handler that calls another function
// which also wraps itself in transaction()) joins the outer transaction
// instead of starting a second one, so nested real code keeps working
// unchanged: the outer commit/rollback governs the whole thing.
let txDepth = 0;
function transaction(fn) {
  const isOutermost = txDepth === 0;
  if (isOutermost) db.exec('BEGIN');
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    if (isOutermost) db.exec('COMMIT');
    return result;
  } catch (e) {
    txDepth--;
    if (isOutermost) {
      try { db.exec('ROLLBACK'); } catch (rollbackErr) { /* nothing left to roll back */ }
    }
    throw e;
  }
}

module.exports = { db, all, get, run, transaction, DB_PATH };
