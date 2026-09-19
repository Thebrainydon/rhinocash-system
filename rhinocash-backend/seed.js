// seed.js — run with: node seed.js
// Sets up everything the system needs to be usable: roles, the module and
// action permission matrix, the 4-level approval workflow sequence, a
// starter chart of accounts, and the one account instruction #4 requires —
// the initial Master System Administrator.
//
// Demo/test data (sample branches, staff, clients, loans) is OPT-IN via
// `node seed.js --demo`, per instruction #14: seed data must be clearly
// separated from what a real deployment needs. Running this file twice is
// safe — every insert is idempotent (INSERT ... ON CONFLICT DO NOTHING /
// existence checks).
'use strict';
const { get, run } = require('./src/db');
const { hashPassword, generateTempPassword } = require('./src/crypto');
const crypto = require('node:crypto');

const DEMO = process.argv.includes('--demo');

async function seedRoles() {
  const roles = [
    ['loan_officer', 'Loan Officer', 'Portfolio Access'],
    ['manager', 'Manager', 'Branch Management Access'],
    ['operational_manager', 'Operational Manager', 'Operations & Branch Expansion Access'],
    ['regional_manager', 'Regional Manager', 'Regional Management Access'],
    ['accountant', 'Accountant', 'Accounting & Financial Access'],
    ['admin', 'Admin', 'Master System Administration Access'],
    ['ceo', 'CEO', 'Executive Management Access'],
    ['director', 'Director', 'Strategic & Governance Access'],
  ];
  for (const [id, name, level] of roles) {
    await run('INSERT INTO roles (id, name, default_access_level) VALUES (?,?,?) ON CONFLICT DO NOTHING', [id, name, level]);
  }
}

async function seedModules() {
  const modules = [
    ['dashboard', 'Dashboard'], ['clients', 'Clients'], ['loanbook', 'LoanBook'], ['payments', 'Payments'],
    ['accounting', 'Accounting'], ['branches', 'Branches & Regions'], ['investors', 'Investor Management'], ['reports', 'Reports'], ['staff', 'Staff Management'], ['audit', 'Audit'],
    ['support', 'System & Help'], ['account', 'My Account'],
  ];
  for (const [id, label] of modules) {
    await run('INSERT INTO modules (id, label) VALUES (?,?) ON CONFLICT DO NOTHING', [id, label]);
  }

  const roleModules = {
    loan_officer: ['dashboard', 'clients', 'loanbook', 'payments', 'accounting', 'reports', 'support', 'account'],
    manager: ['dashboard', 'clients', 'loanbook', 'payments', 'accounting', 'reports', 'staff', 'support', 'account'],
    operational_manager: ['dashboard', 'clients', 'loanbook', 'payments', 'accounting', 'branches', 'reports', 'staff', 'support', 'account'],
    regional_manager: ['dashboard', 'clients', 'loanbook', 'payments', 'accounting', 'branches', 'reports', 'staff', 'support', 'account'],
    // Accountant needs 'loanbook' too, not just 'payments'/'accounting' —
    // they hold approve_loans (the Accountant is the final workflow step)
    // and the original spec's Accountant menu explicitly includes "Loan
    // Applications", "Pending Loan Approvals", "Loan Receivables". Without
    // this, an Accountant could approve a loan via the action permission
    // but then be unable to even view the loan they just approved.
    // Accountant also needs 'clients' — without it, GET /api/clients is
    // blocked, so every loan in their approval queue/Loan Accounting views
    // showed "—" instead of the real client name (found via the queue
    // rendering "—" for a client that genuinely existed and was correctly
    // scoped everywhere else). Reviewing a loan for financial sign-off
    // without knowing who it's for isn't meaningful.
    accountant: ['dashboard', 'clients', 'loanbook', 'payments', 'accounting', 'investors', 'reports', 'support', 'account'],
    admin: ['dashboard', 'clients', 'loanbook', 'payments', 'accounting', 'branches', 'investors', 'reports', 'audit', 'staff', 'support', 'account'],
    // CEO/Director get read visibility into 'accounting' (cash position,
    // P&L, ledger) — the original spec explicitly lists Cashflow/Revenue/
    // Profitability as executive KPIs for both roles, and without this
    // their dashboards had no real financial data source at all (not even
    // a wrong one — DB.transactions/cash-position simply never loaded).
    // This is visibility only: neither role holds post_accounting_entries
    // or any other financial action permission, so they still can't record
    // or modify a single transaction — same "system access vs. authority
    // to act" separation already applied elsewhere (e.g. Admin vs. finance).
    ceo: ['dashboard', 'clients', 'reports', 'accounting', 'branches', 'investors', 'staff', 'support', 'account'],
    director: ['dashboard', 'clients', 'reports', 'accounting', 'branches', 'investors', 'audit', 'support', 'account'],
  };
  for (const [role, mods] of Object.entries(roleModules)) {
    for (const m of mods) {
      await run('INSERT INTO role_modules (role_id, module_id) VALUES (?,?) ON CONFLICT DO NOTHING', [role, m]);
    }
  }
}

async function seedPermissions() {
  const perms = [
    ['approve_loans', 'Approve Loans'], ['disburse_loans', 'Disburse Loans'], ['record_payments', 'Record Payments'],
    ['reverse_payment', 'Reverse Payment'], ['post_accounting_entries', 'Post Accounting Entries'],
    ['manage_users', 'Manage Users'], ['manage_branches', 'Manage Branches'], ['open_new_branch', 'Open New Branch'],
    ['write_off_loans', 'Write Off Loans'], ['manage_system_settings', 'Manage System Settings'],
  ];
  for (const [id, label] of perms) {
    await run('INSERT INTO permissions (id, label) VALUES (?,?) ON CONFLICT DO NOTHING', [id, label]);
  }

  // role_id -> { permission_id: allowed }
  const matrix = {
    admin: { approve_loans: 1, disburse_loans: 1, record_payments: 1, reverse_payment: 1, post_accounting_entries: 1, manage_users: 1, manage_branches: 1, open_new_branch: 1, write_off_loans: 1, manage_system_settings: 1 },
    manager: { approve_loans: 1, disburse_loans: 1, record_payments: 1 },
    operational_manager: { approve_loans: 1, disburse_loans: 1, record_payments: 1, manage_branches: 1, open_new_branch: 1 },
    regional_manager: { approve_loans: 1, disburse_loans: 1, record_payments: 1 },
    accountant: { record_payments: 1, reverse_payment: 1, post_accounting_entries: 1, approve_loans: 1 },
    loan_officer: { record_payments: 1 },
    // CEO/Director get manage_users so they can reach the staff endpoints at
    // all (instruction #6/#7) — but every sensitive sub-action within those
    // endpoints (role-tier, status changes beyond Suspend, module/permission
    // overrides, resets, session revocation) is additionally hard-restricted
    // to role_id === 'admin' in code (see users.js / auth.js), because a
    // single boolean permission can't express "yes, but not on Admin
    // accounts, and not the really dangerous sub-actions."
    ceo: { manage_users: 1 },
    director: { manage_users: 1 },
  };
  for (const [role, perms2] of Object.entries(matrix)) {
    for (const [pid] of perms) {
      await run('INSERT INTO role_permissions (role_id, permission_id, allowed) VALUES (?,?,?) ON CONFLICT DO NOTHING', [role, pid, perms2[pid] ? 1 : 0]);
    }
  }
}

async function seedWorkflow() {
  // The exact sequential workflow from the spec, stored as data.
  const steps = [
    [1, 'manager', 'Waiting for Manager'],
    [2, 'regional_manager', 'Waiting for Regional Manager'],
    [3, 'operational_manager', 'Waiting for Operational Manager'],
    [4, 'accountant', 'Waiting for Accountant'],
  ];
  for (const [order, role, label] of steps) {
    await run('INSERT INTO approval_workflow_steps (step_order, role_id, status_label) VALUES (?,?,?) ON CONFLICT DO NOTHING', [order, role, label]);
  }
}

async function seedChartOfAccounts() {
  const accounts = [
    ['cash', '1000', 'Cash at Hand', 'Asset'],
    ['bank', '1010', 'Bank Account', 'Asset'],
    ['mpesa', '1020', 'M-Pesa Account', 'Asset'],
    ['loans_receivable', '1100', 'Loans Receivable', 'Asset'],
    ['interest_income', '4000', 'Interest Income', 'Revenue'],
    ['fee_income', '4010', 'Fee Income', 'Revenue'],
    ['penalty_income', '4020', 'Penalty Income', 'Revenue'],
    ['operating_expense', '5000', 'Operating Expenses', 'Expense'],
    ['overpayment_suspense', '2100', 'Overpayment Suspense (client credit balances)', 'Liability'],
    // Real non-Expense accounts a vendor payment's Journal Account can
    // also post to — the Vendor Payment Form isn't restricted to Expense
    // accounts the way a requisition is.
    ['bad_debt_reserve', '2101', 'Bad Debt Reserve', 'Liability'],
    ['bank_loans_payable', '2102', 'Bank loans payable', 'Liability'],
    ['clients_wallet', '2103', 'Clients Wallet', 'Liability'],
    ['deferred_income', '2104', 'Deffered income', 'Liability'],
    ['income_taxes_payable', '2105', 'Income taxes payable', 'Liability'],
    ['loan_overpayments', '2106', 'Loan overpayments', 'Liability'],
    // Granular expense accounts a requisition can actually be charged
    // to — previously every requisition landed on the one generic
    // "Operating Expenses" account regardless of what it was really for.
    ['exp_audit_fees', '5001', 'Audit Fees', 'Expense'],
    ['exp_bank_charges', '5002', 'Bank Charges', 'Expense'],
    ['exp_bulk_sms', '5003', 'Bulk SMS', 'Expense'],
    ['exp_collection_recovery', '5004', 'Collection & Recovery fees', 'Expense'],
    ['exp_commission', '5005', 'Commission Expenses', 'Expense'],
    ['exp_directors_emolument', '5006', 'Directors Emolument', 'Expense'],
    ['exp_electricity', '5007', 'Electricity', 'Expense'],
    ['exp_hired_labor', '5008', 'Hired Labor', 'Expense'],
    ['exp_interest_investor', '5009', 'Interest On Investor Fund', 'Expense'],
    ['exp_interest_longterm', '5010', 'Interest On Long-term Loans', 'Expense'],
    ['exp_interest_shortterm', '5011', 'Interest On Short Term Loans', 'Expense'],
    ['exp_internet', '5012', 'Internet Fees', 'Expense'],
    ['exp_legal_consultancy', '5013', 'Legal Consultancy Fee', 'Expense'],
    ['exp_licenses_permits', '5014', 'Licenses & Permits', 'Expense'],
    ['exp_local_travel', '5015', 'Local Travel', 'Expense'],
    ['exp_marketing', '5016', 'Marketing expenses', 'Expense'],
    ['exp_meals_refreshment', '5017', 'Meals & Refreshment', 'Expense'],
    ['exp_mpesa_bulk_charges', '5018', 'Mpesa bulk charges', 'Expense'],
    ['exp_office_repair', '5019', 'Office repair & Maintenance', 'Expense'],
    ['exp_operations_consultancy', '5020', 'Operations & consultancy fees', 'Expense'],
    ['exp_parcel_postage', '5021', 'Parcel and Postage', 'Expense'],
    ['exp_printing_stationary', '5022', 'Printing And Stationary', 'Expense'],
    ['exp_rent', '5023', 'Rent expense', 'Expense'],
    ['exp_salary_wages', '5024', 'Salary & Wages', 'Expense'],
    ['exp_server_charges', '5025', 'Server charges', 'Expense'],
    ['exp_staff_airtime', '5026', 'Staff Airtime', 'Expense'],
    ['exp_staff_training', '5027', 'Staff Training', 'Expense'],
    ['exp_staff_uniforms', '5028', 'Staff Uniforms', 'Expense'],
    ['exp_staff_bonus_gratuity', '5029', 'Staffs Bonus, awards & Gratuity', 'Expense'],
    ['exp_system_dev_maintenance', '5030', 'System Development & Maintenance', 'Expense'],
    ['exp_telephone', '5031', 'Telephone expenses', 'Expense'],
    ['exp_water', '5032', 'Water', 'Expense'],
  ];
  for (const [id, code, name, type] of accounts) {
    await run('INSERT INTO gl_accounts (id, code, name, account_type) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', [id, code, name, type]);
  }
}

async function seedRegionsAndDepartments() {
  await run('INSERT INTO regions (id, name) VALUES (?,?) ON CONFLICT DO NOTHING', ['rg_central', 'Central Region']);
  await run('INSERT INTO regions (id, name) VALUES (?,?) ON CONFLICT DO NOTHING', ['rg_coastwest', 'Coast & Western Region']);
  for (const d of ['Credit', 'Operations', 'Finance', 'Executive', 'Board', 'IT & Systems']) {
    await run('INSERT INTO departments (id, name) VALUES (?,?) ON CONFLICT DO NOTHING', [d.toLowerCase().replace(/[^a-z]+/g, '_'), d]);
  }
}

async function seedInitialAdmin() {
  const email = process.env.INITIAL_ADMIN_EMAIL || 'admin@rhinocash.co.ke';
  const existing = await get('SELECT * FROM users WHERE email = ?', [email]);
  if (existing) {
    console.log(`\nAdmin account already exists (${email}) — not recreated. Use the "reset password" API if you've lost the credentials.`);
    return;
  }
  const password = process.env.INITIAL_ADMIN_PASSWORD || generateTempPassword();
  const { hash, salt } = hashPassword(password);
  const id = 'usr_' + crypto.randomUUID();
  await run(
    `INSERT INTO users (id, staff_code, name, email, password_hash, password_salt, must_change_password,
      role_id, access_level, job_title, department_id, employment_status, status)
     VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?)`,
    [id, 'RC-0001', 'Rhinocash System Administrator', email, hash, salt,
      'admin', 'Master System Administration Access', 'System Administrator', 'it_systems', 'Full-time', 'Active']
  );
  console.log('\n================================================================');
  console.log('  INITIAL ADMINISTRATOR ACCOUNT CREATED');
  console.log('================================================================');
  console.log(`  Name:      Rhinocash System Administrator`);
  console.log(`  Email:     ${email}`);
  console.log(`  Password:  ${password}`);
  console.log('  This password is shown ONCE, here, and is not stored anywhere');
  console.log('  in plaintext or in source code. The account is forced to change');
  console.log('  it on first login (must_change_password = true).');
  console.log('================================================================\n');
}

async function seedDemoData() {
  const branches = [
    ['br_nairobi', 'Nairobi CBD', 'Nairobi', 'rg_central'],
    ['br_kisumu', 'Kisumu', 'Kisumu', 'rg_coastwest'],
    ['br_mombasa', 'Mombasa', 'Mombasa', 'rg_coastwest'],
  ];
  for (const [id, name, loc, region] of branches) {
    await run('INSERT INTO branches (id, name, location, region_id, status) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING', [id, name, loc, region, 'Active']);
  }

  // Real, configurable Strong/Normal/Needs Attention and portfolio-quality
  // thresholds — the single source of truth reused across every LoanBook
  // collection-rate and portfolio-quality page, never a second formula.
  const riskConfig = [
    ['strong_collection_rate_pct', 90, 'Collection rate at or above this is classified Strong'],
    ['normal_collection_rate_pct', 70, 'Collection rate at or above this (below Strong) is classified Normal'],
    ['quality_watch_par30_pct', 5, 'PAR-30 at or above this classifies portfolio quality as Watch'],
    ['quality_atrisk_par30_pct', 10, 'PAR-30 at or above this classifies portfolio quality as At Risk'],
    ['quality_critical_par30_pct', 20, 'PAR-30 at or above this classifies portfolio quality as Critical'],
    ['quality_default_par30_pct', 40, 'PAR-30 at or above this classifies portfolio quality as Default'],
  ];
  let riskIdx = 0;
  for (const [ruleName, value, desc] of riskConfig) {
    riskIdx++;
    await run('INSERT INTO client_risk_config (id, rule_name, threshold_value, description) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
      [`risk_cfg_${riskIdx}`, ruleName, value, desc]);
  }

  const products = [
    ['pr_boda', 'Boda Boda Asset Loan', 4, 10000, 150000, 3, 12],
    ['pr_biz', 'Business Working Capital', 3.5, 5000, 300000, 1, 12],
    ['pr_starter', 'Starter Loan', 5, 1000, 20000, 1, 6],
  ];
  for (const [id, name, rate, min, max, minT, maxT] of products) {
    await run(
      "INSERT INTO loan_products (id, name, rate_type, rate_pct, min_amount, max_amount, min_term_months, max_term_months, fee_pct, penalty_pct) VALUES (?,?,'Flat',?,?,?,?,?,2,5) ON CONFLICT DO NOTHING",
      [id, name, rate, min, max, minT, maxT]
    );
  }

  const demoStaff = [
    ['usr_opsmgr', 'Esther Wanjiku', 'opsmanager@rhinocash.co.ke', '0711000001', 'operational_manager', 'br_nairobi', 'rg_central', 'usr_ceo'],
    ['usr_regional', 'Daniel Kiptoo', 'regional@rhinocash.co.ke', '0711000002', 'regional_manager', 'br_kisumu', 'rg_coastwest', 'usr_opsmgr'],
    ['usr_manager', 'David Kariuki', 'manager@rhinocash.co.ke', '0711000003', 'manager', 'br_nairobi', 'rg_central', 'usr_opsmgr'],
    ['usr_manager_kisumu', 'Faith Njeri', 'manager.kisumu@rhinocash.co.ke', '0711000004', 'manager', 'br_kisumu', 'rg_coastwest', 'usr_regional'],
    ['usr_accountant', 'Grace Achieng', 'accountant@rhinocash.co.ke', '0711000005', 'accountant', 'br_nairobi', 'rg_central', 'usr_ceo'],
    ['usr_officer', 'Peter Otieno', 'officer@rhinocash.co.ke', '0711000006', 'loan_officer', 'br_kisumu', 'rg_coastwest', 'usr_manager_kisumu'],
    ['usr_ceo', 'James Mwangi', 'ceo@rhinocash.co.ke', '0711000007', 'ceo', 'br_nairobi', 'rg_central', null],
    ['usr_director', 'Naomi Kilonzo', 'director@rhinocash.co.ke', '0711000008', 'director', 'br_nairobi', 'rg_central', null],
  ];
  console.log('================================================================');
  console.log('  DEMO / TEST ACCOUNTS  (development only — not for production)');
  console.log('================================================================');
  for (const [id, name, email, phone, role, branch, region] of demoStaff) {
    const existing = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) continue;
    const password = generateTempPassword();
    const { hash, salt } = hashPassword(password);
    const role_row = await get('SELECT * FROM roles WHERE id = ?', [role]);
    await run(
      `INSERT INTO users (id, staff_code, name, email, phone, password_hash, password_salt, must_change_password,
        role_id, access_level, job_title, branch_id, region_id, reporting_manager_id, employment_status, status, monthly_disbursement_target, monthly_new_loan_target, leave_days_balance)
       VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,NULL, 'Full-time','Active',?,?,?)`,
      [id, 'RC-' + String(Math.floor(Math.random() * 9000) + 1000), name, email, phone, hash, salt,
        role, role_row.default_access_level, role_row.name, branch, region,
        role === 'loan_officer' ? 800000 : 0, role === 'loan_officer' ? 10 : 0, 10]
    );
    console.log(`  ${role.padEnd(20)} ${email.padEnd(30)} ${password}`);
  }
  // Second pass: wire up reporting lines now that every row exists (the
  // array above isn't in manager-before-report order, so doing this inline
  // in the first pass would hit a foreign-key violation on rows whose
  // manager hasn't been inserted yet).
  for (const [id, , , , , , , reportingManagerId] of demoStaff) {
    if (reportingManagerId) await run('UPDATE users SET reporting_manager_id = ? WHERE id = ? AND reporting_manager_id IS NULL', [reportingManagerId, id]);
  }
  console.log('================================================================\n');

  const investorId = 'inv_sara';
  if (!(await get('SELECT id FROM investors WHERE id = ?', [investorId]))) {
    const password = generateTempPassword();
    const { hash, salt } = hashPassword(password);
    await run(
      `INSERT INTO investors (id, name, email, password_hash, password_salt, amount, profit_share_pct, term_months, start_date, status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [investorId, 'Sara Mbula', 'sara.investor@example.com', hash, salt, 200000, 10, 6, new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10), 'Active']
    );
    console.log(`  investor             sara.investor@example.com     ${password}\n`);
  }
}

(async () => {
  await seedRoles();
  await seedModules();
  await seedPermissions();
  await seedWorkflow();
  await seedChartOfAccounts();
  await seedRegionsAndDepartments();
  await seedInitialAdmin();
  if (DEMO) await seedDemoData();
  else console.log('Run "node seed.js --demo" to also create sample branches, staff, loan products, and an investor for testing.\n');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
