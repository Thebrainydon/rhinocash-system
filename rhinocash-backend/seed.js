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
const { nextStaffCode } = require('./src/routes/users');
const crypto = require('node:crypto');

const DEMO = process.argv.includes('--demo');

async function seedRoles() {
  // description is real, persisted data (Admin > Roles & Access Control >
  // Roles reads it directly) — only ever set here on first insert
  // (ON CONFLICT DO NOTHING), so a real Admin edit is never clobbered by
  // a later reseed. is_system=1 marks these as the 8 structural roles
  // this application's sidebar/module-permission dispatch is wired to by
  // exact name, distinct from a role created via POST /api/roles.
  const roles = [
    ['loan_officer', 'Loan Officer', 'Portfolio Access', 'Front-line lending — manages their own client portfolio, submits loan applications, and records payments within their branch.'],
    ['manager', 'Manager', 'Branch Management Access', 'Runs a single branch — approves loans, manages branch staff, and oversees day-to-day branch operations.'],
    ['operational_manager', 'Operational Manager', 'Operations & Branch Expansion Access', 'Company-wide operations oversight — branch expansion, cross-branch loan approvals and operational performance.'],
    ['regional_manager', 'Regional Manager', 'Regional Management Access', 'Oversees every branch in their region — regional loan approvals, branch performance and staff across the region.'],
    ['accountant', 'Accountant', 'Accounting & Financial Access', 'Financial control — posts accounting entries, reconciles payments, and holds the final loan-approval step.'],
    ['admin', 'Admin', 'Master System Administration Access', 'Master System Administrator — the only role with full system configuration, user management and role/permission authority.'],
    ['ceo', 'CEO', 'Executive Management Access', 'Executive oversight of company-wide performance, portfolio health and financial results.'],
    ['director', 'Director', 'Strategic & Governance Access', 'Governance and ownership oversight — capital, shareholders, board matters and strategic risk.'],
    ['hr', 'HR', 'HR & People Management Access', 'Human Resources — manages staff records and holds company-wide visibility into employees across every branch.'],
  ];
  for (const [id, name, level, description] of roles) {
    await run(
      `INSERT INTO roles (id, name, default_access_level, description, status, is_system) VALUES (?,?,?,?,'Active',1) ON CONFLICT DO NOTHING`,
      [id, name, level, description]
    );
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
    manager: ['dashboard', 'clients', 'loanbook', 'payments', 'accounting', 'branches', 'reports', 'staff', 'support', 'account'],
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
    // 'branches'/'staff' added alongside the above — the Accountant
    // sidebar now includes real Branches & Regions and Employees
    // submenus too, same read/visibility-only reasoning: no
    // manage_branches/manage_users action permission accompanies it.
    accountant: ['dashboard', 'clients', 'loanbook', 'payments', 'accounting', 'branches', 'investors', 'reports', 'staff', 'support', 'account'],
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
    // 'loanbook'/'payments' added alongside the above accounting/branches
    // grant — the CEO sidebar now includes real LoanBook and Payments
    // submenus (Loan Applications, Collection Sheet, Receipts, etc.),
    // which are read-only visibility for the CEO: no approve_loans/
    // disburse_loans/record_payments action permission is granted here,
    // same "visibility vs. authority to act" separation as accounting.
    ceo: ['dashboard', 'clients', 'loanbook', 'payments', 'reports', 'accounting', 'branches', 'investors', 'staff', 'support', 'account'],
    // 'loanbook'/'payments'/'staff' added alongside the existing grant —
    // the Director sidebar now includes real LoanBook/Payments/Employees
    // submenus too, same real/visibility-only reasoning as the CEO grant
    // above: no approve_loans/disburse_loans/record_payments/manage_users
    // action permission accompanies it.
    director: ['dashboard', 'clients', 'loanbook', 'payments', 'reports', 'accounting', 'branches', 'investors', 'staff', 'audit', 'support', 'account'],
    // HR has no lending/accounting/branch authority — just the Staff
    // Management module it shares (read-level, same as every other
    // operational role) with the universal dashboard/support/account
    // baseline. No 'audit' — that module is the full company-wide
    // financial/system audit trail, out of HR's intended scope (see
    // ROLE_ROUTE_OVERRIDES["HR"] in index.html, which redirects HR's own
    // "Login Activity" sidebar item rather than granting this module).
    hr: ['dashboard', 'staff', 'support', 'account'],
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
    // HR holds no action permission yet: its one real, structural route
    // (Employees > View Employees) is gated by module access only
    // (requireModule('staff')), not by any of these 10 action
    // permissions. manage_users specifically would do nothing for HR
    // today even if granted — canActOnStaffRecord() in rbac.js is
    // hard-restricted to admin/ceo/director regardless of permission —
    // so granting it now would only have the side effect of silently
    // handing HR company-wide leave/salary-advance decide authority
    // (misc.js's canDecideOn()) before that's actually been asked for.
    // Revisit when HR's own Leave Management / User & Access Management
    // submenus are built out.
    hr: {},
  };
  for (const [role, perms2] of Object.entries(matrix)) {
    for (const [pid] of perms) {
      await run('INSERT INTO role_permissions (role_id, permission_id, allowed) VALUES (?,?,?) ON CONFLICT DO NOTHING', [role, pid, perms2[pid] ? 1 : 0]);
    }
  }
}

// Intelligence module — real, data-driven, per-submenu-item permission
// catalog (role_intelligence_access/user_intelligence_access mirror
// role_modules/user_module_access exactly — see db.js/rbac.js). Phase 1:
// Predictive Analytics, Drill-Down Analytics, Explainable Decisions,
// Personalizable Workspaces, plus Fraud & Risk Detection (Phase 2 — real
// rule-based signals against existing data, no new infrastructure
// needed). Offline Field Operations, Route Optimization, AI Assistant and
// What-If Simulation remain deliberately absent — each needs real
// third-party infrastructure (mapping/geocoding provider, an LLM API, a
// client-side offline-sync architecture) still undecided, and seeding
// fake catalog rows for them would just be a disguised placeholder.
async function seedIntelligence() {
  const categories = [
    ['predictive-analytics', 'Predictive Analytics', '📈', 1],
    ['drilldown-analytics', 'Drill-Down Analytics', '🔍', 2],
    ['explainable-decisions', 'Explainable Decisions', '💡', 3],
    ['personalizable-workspaces', 'Personalizable Workspaces', '🧩', 4],
    ['fraud-risk-detection', 'Fraud & Risk Detection', '🚨', 5],
    ['whatif-simulation', 'What-If Simulation', '🧮', 6],
  ];
  for (const [id, label, icon, sort] of categories) {
    await run('INSERT INTO intelligence_categories (id, label, icon, sort_order) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', [id, label, icon, sort]);
  }
  // Default Predictive Analytics trend window — real, editable later via
  // Admin > Intelligence > Prediction Rules (PUT /api/intelligence/settings/trend-window).
  await run(`INSERT INTO intelligence_settings (key, value) VALUES ('trend_window_months', '1') ON CONFLICT DO NOTHING`);
  // Default Fraud & Risk Detection thresholds — real, editable later via
  // Admin > Intelligence > Fraud Thresholds (PUT /api/intelligence/fraud/thresholds).
  await run(`INSERT INTO intelligence_settings (key, value) VALUES ('fraud_rapid_writeoff_days', '14') ON CONFLICT DO NOTHING`);
  await run(`INSERT INTO intelligence_settings (key, value) VALUES ('fraud_advance_request_count_threshold', '3') ON CONFLICT DO NOTHING`);
  await run(`INSERT INTO intelligence_settings (key, value) VALUES ('fraud_advance_request_window_days', '30') ON CONFLICT DO NOTHING`);
  // Default What-If Simulation bounds — real, editable later via
  // Admin > Intelligence > Simulation Bounds (PUT /api/intelligence/whatif-simulation-bounds).
  await run(`INSERT INTO intelligence_settings (key, value) VALUES ('whatif_delta_min', '-50') ON CONFLICT DO NOTHING`);
  await run(`INSERT INTO intelligence_settings (key, value) VALUES ('whatif_delta_max', '50') ON CONFLICT DO NOTHING`);

  // [id, category_id, label, sort_order] — one row per unique real label
  // across every role's spec; a label repeated verbatim across roles
  // (e.g. "Portfolio Forecast" for Manager and CEO alike) is ONE feature
  // row shared by both roles' grants below, not duplicated.
  const features = [
    // Predictive Analytics
    ['pred-my-collection-prediction', 'predictive-analytics', 'My Collection Prediction', 1],
    ['pred-client-risk-indicators', 'predictive-analytics', 'Client Risk Indicators', 2],
    ['pred-early-warning-signals', 'predictive-analytics', 'Early Warning Signals', 3],
    ['pred-branch-collection-forecast', 'predictive-analytics', 'Branch Collection Forecast', 4],
    ['pred-loan-default-prediction', 'predictive-analytics', 'Loan Default Prediction', 5],
    ['pred-portfolio-forecast', 'predictive-analytics', 'Portfolio Forecast', 6],
    ['pred-officer-performance-prediction', 'predictive-analytics', 'Officer Performance Prediction', 7],
    ['pred-regional-portfolio-forecast', 'predictive-analytics', 'Regional Portfolio Forecast', 8],
    ['pred-regional-collection-forecast', 'predictive-analytics', 'Regional Collection Forecast', 9],
    ['pred-default-prediction', 'predictive-analytics', 'Default Prediction', 10],
    ['pred-branch-performance-prediction', 'predictive-analytics', 'Branch Performance Prediction', 11],
    ['pred-operations-forecast', 'predictive-analytics', 'Operations Forecast', 12],
    ['pred-collection-forecast', 'predictive-analytics', 'Collection Forecast', 13],
    ['pred-branch-performance', 'predictive-analytics', 'Branch Performance', 14],
    ['pred-operational-early-warnings', 'predictive-analytics', 'Operational Early Warnings', 15],
    ['pred-cashflow-forecast', 'predictive-analytics', 'Cashflow Forecast', 16],
    ['pred-revenue-forecast', 'predictive-analytics', 'Revenue Forecast', 17],
    ['pred-liquidity-forecast', 'predictive-analytics', 'Liquidity Forecast', 18],
    ['pred-company-forecast', 'predictive-analytics', 'Company Forecast', 19],
    ['pred-profit-forecast', 'predictive-analytics', 'Profit Forecast', 20],
    ['pred-capital-forecast', 'predictive-analytics', 'Capital Forecast', 21],
    ['pred-risk-forecast', 'predictive-analytics', 'Risk Forecast', 22],
    ['pred-investment-performance', 'predictive-analytics', 'Investment Performance', 23],
    ['pred-portfolio-performance', 'predictive-analytics', 'Portfolio Performance', 24],
    ['pred-investment-return-forecast', 'predictive-analytics', 'Investment Return Forecast', 25],
    ['pred-staff-performance', 'predictive-analytics', 'Staff Performance', 26],
    ['pred-workforce-trends', 'predictive-analytics', 'Workforce Trends', 27],
    ['pred-attendance-trends', 'predictive-analytics', 'Attendance Trends', 28],
    ['pred-turnover-prediction', 'predictive-analytics', 'Turnover Prediction', 29],
    ['pred-prediction-models', 'predictive-analytics', 'Prediction Models', 30],
    ['pred-prediction-rules', 'predictive-analytics', 'Prediction Rules', 31],
    ['pred-thresholds', 'predictive-analytics', 'Thresholds', 32],
    // Drill-Down Analytics
    ['drill-portfolio', 'drilldown-analytics', 'Portfolio', 1],
    ['drill-collections', 'drilldown-analytics', 'Collections', 2],
    ['drill-arrears', 'drilldown-analytics', 'Arrears', 3],
    ['drill-officer-performance', 'drilldown-analytics', 'Officer Performance', 4],
    ['drill-region', 'drilldown-analytics', 'Region', 5],
    ['drill-branch', 'drilldown-analytics', 'Branch', 6],
    ['drill-officer', 'drilldown-analytics', 'Officer', 7],
    ['drill-client', 'drilldown-analytics', 'Client', 8],
    ['drill-loan', 'drilldown-analytics', 'Loan', 9],
    ['drill-payment', 'drilldown-analytics', 'Payment', 10],
    ['drill-operations', 'drilldown-analytics', 'Operations', 11],
    ['drill-branches', 'drilldown-analytics', 'Branches', 12],
    ['drill-officers', 'drilldown-analytics', 'Officers', 13],
    ['drill-revenue', 'drilldown-analytics', 'Revenue', 14],
    ['drill-disbursements', 'drilldown-analytics', 'Disbursements', 15],
    ['drill-expenses', 'drilldown-analytics', 'Expenses', 16],
    ['drill-profitability', 'drilldown-analytics', 'Profitability', 17],
    ['drill-cashflow', 'drilldown-analytics', 'Cashflow', 18],
    ['drill-company', 'drilldown-analytics', 'Company', 19],
    ['drill-product', 'drilldown-analytics', 'Product', 20],
    ['drill-investment', 'drilldown-analytics', 'Investment', 21],
    ['drill-profit', 'drilldown-analytics', 'Profit', 22],
    ['drill-distributions', 'drilldown-analytics', 'Distributions', 23],
    ['drill-organization', 'drilldown-analytics', 'Organization', 24],
    ['drill-department', 'drilldown-analytics', 'Department', 25],
    ['drill-employee', 'drilldown-analytics', 'Employee', 26],
    ['drill-analytics-configuration', 'drilldown-analytics', 'Analytics Configuration', 27],
    ['drill-kpi-configuration', 'drilldown-analytics', 'KPI Configuration', 28],
    // Explainable Decisions
    ['explain-loan-decision-explanation', 'explainable-decisions', 'Loan Decision Explanation', 1],
    ['explain-client-risk-explanation', 'explainable-decisions', 'Client Risk Explanation', 2],
    ['explain-collection-priority-explanation', 'explainable-decisions', 'Collection Priority Explanation', 3],
    ['explain-risk-explanation', 'explainable-decisions', 'Risk Explanation', 4],
    ['explain-approval-explanation', 'explainable-decisions', 'Approval Explanation', 5],
    ['explain-loan-decisions', 'explainable-decisions', 'Loan Decisions', 6],
    ['explain-risk-decisions', 'explainable-decisions', 'Risk Decisions', 7],
    ['explain-branch-performance', 'explainable-decisions', 'Branch Performance', 8],
    ['explain-approval-decisions', 'explainable-decisions', 'Approval Decisions', 9],
    ['explain-operational-alerts', 'explainable-decisions', 'Operational Alerts', 10],
    ['explain-payment-allocation', 'explainable-decisions', 'Payment Allocation', 11],
    ['explain-financial-exceptions', 'explainable-decisions', 'Financial Exceptions', 12],
    ['explain-accounting-adjustments', 'explainable-decisions', 'Accounting Adjustments', 13],
    ['explain-credit-decisions', 'explainable-decisions', 'Credit Decisions', 14],
    ['explain-business-alerts', 'explainable-decisions', 'Business Alerts', 15],
    ['explain-performance-changes', 'explainable-decisions', 'Performance Changes', 16],
    ['explain-strategic-decisions', 'explainable-decisions', 'Strategic Decisions', 17],
    ['explain-financial-changes', 'explainable-decisions', 'Financial Changes', 18],
    ['explain-investment-performance', 'explainable-decisions', 'Investment Performance', 19],
    ['explain-major-portfolio-changes', 'explainable-decisions', 'Major Portfolio Changes', 20],
    ['explain-performance-decisions', 'explainable-decisions', 'Performance Decisions', 21],
    ['explain-hr-alerts', 'explainable-decisions', 'HR Alerts', 22],
    ['explain-explanation-rules', 'explainable-decisions', 'Explanation Rules', 23],
    ['explain-decision-factors', 'explainable-decisions', 'Decision Factors', 24],
    // Personalizable Workspaces
    ['workspace-dashboard-layout', 'personalizable-workspaces', 'Dashboard Layout', 1],
    ['workspace-saved-views', 'personalizable-workspaces', 'Saved Views', 2],
    ['workspace-my-preferences', 'personalizable-workspaces', 'My Preferences', 3],
    ['workspace-templates', 'personalizable-workspaces', 'Workspace Templates', 4],
    ['workspace-widget-management', 'personalizable-workspaces', 'Widget Management', 5],
    ['workspace-role-defaults', 'personalizable-workspaces', 'Role Defaults', 6],
    // Fraud & Risk Detection — real rule-based signals against existing
    // data (duplicate client identities, reversed/overpaid payments,
    // loans written off shortly after disbursement, per-officer approval-
    // pattern anomalies, staff salary-advance frequency), never a trained
    // fraud model. One feature id per concept, shared across every role
    // that holds it (same real compute, scoped by that role's own real
    // branchIdsInScope/officer-id — identical pattern to every other
    // Intelligence category already built).
    ['fraud-duplicate-clients', 'fraud-risk-detection', 'Duplicate Client Alerts', 1],
    ['fraud-payment-reversals', 'fraud-risk-detection', 'Payment Reversal Alerts', 2],
    ['fraud-rapid-writeoff', 'fraud-risk-detection', 'Rapid Write-Off Alerts', 3],
    ['fraud-overpayment-pattern', 'fraud-risk-detection', 'Overpayment Pattern', 4],
    ['fraud-officer-approval-pattern', 'fraud-risk-detection', 'Officer Approval Patterns', 5],
    ['fraud-overview', 'fraud-risk-detection', 'Fraud Overview', 6],
    ['fraud-branch-risk-ranking', 'fraud-risk-detection', 'Branch Risk Ranking', 7],
    ['fraud-staff-advance-pattern', 'fraud-risk-detection', 'Staff Advance Pattern Alerts', 8],
    ['fraud-detection-rules', 'fraud-risk-detection', 'Fraud Detection Rules', 9],
    ['fraud-thresholds', 'fraud-risk-detection', 'Fraud Thresholds', 10],
    // What-If Simulation — real arithmetic projections on real current
    // data (never a forecast model). One feature id per scenario, shared
    // across every role that holds it, same pattern as every category above.
    ['whatif-collection-rate', 'whatif-simulation', 'Collection Rate Simulation', 1],
    ['whatif-disbursement-volume', 'whatif-simulation', 'Disbursement Volume Simulation', 2],
    ['whatif-portfolio-growth', 'whatif-simulation', 'Portfolio Growth Simulation', 3],
    ['whatif-par-change', 'whatif-simulation', 'Portfolio Risk Simulation', 4],
    ['whatif-expense-change', 'whatif-simulation', 'Expense Simulation', 5],
    ['whatif-revenue-growth', 'whatif-simulation', 'Revenue Growth Simulation', 6],
    ['whatif-capital-utilization', 'whatif-simulation', 'Capital Utilization Simulation', 7],
    ['whatif-headcount-change', 'whatif-simulation', 'Headcount & Payroll Simulation', 8],
    ['whatif-simulation-models', 'whatif-simulation', 'Simulation Models', 9],
    ['whatif-simulation-bounds', 'whatif-simulation', 'Simulation Bounds', 10],
  ];
  for (const [id, cat, label, sort] of features) {
    await run('INSERT INTO intelligence_features (id, category_id, label, sort_order) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', [id, cat, label, sort]);
  }

  // role_id -> [feature_id,...] — the exact per-role grant matrix given in
  // the spec. Investor is deliberately absent here: it has no row in the
  // real `roles` table at all (a structurally separate principal
  // type/table, same reasoning documented at seedRoles() and in
  // index.html's ROLE_DESCRIPTIONS) so it cannot hold a role_intelligence_access
  // row — its grants are instead a small hardcoded constant in rbac.js
  // (INVESTOR_INTELLIGENCE_FEATURES), the exact same pre-existing pattern
  // Investor's NAV_PERMISSIONS/SIDEBAR_MENUS already use for everything else.
  const roleGrants = {
    loan_officer: [
      'pred-my-collection-prediction', 'pred-client-risk-indicators', 'pred-early-warning-signals',
      'explain-loan-decision-explanation', 'explain-client-risk-explanation', 'explain-collection-priority-explanation',
      'fraud-duplicate-clients', 'fraud-overpayment-pattern',
      'whatif-collection-rate',
      'workspace-dashboard-layout', 'workspace-saved-views', 'workspace-my-preferences',
    ],
    manager: [
      'pred-branch-collection-forecast', 'pred-loan-default-prediction', 'pred-portfolio-forecast', 'pred-officer-performance-prediction', 'pred-early-warning-signals',
      'explain-loan-decision-explanation', 'explain-risk-explanation', 'explain-approval-explanation', 'explain-collection-priority-explanation',
      'drill-portfolio', 'drill-collections', 'drill-arrears', 'drill-officer-performance',
      'fraud-duplicate-clients', 'fraud-payment-reversals', 'fraud-rapid-writeoff',
      'whatif-collection-rate', 'whatif-disbursement-volume',
      'workspace-dashboard-layout', 'workspace-saved-views', 'workspace-my-preferences',
    ],
    regional_manager: [
      'pred-regional-portfolio-forecast', 'pred-regional-collection-forecast', 'pred-default-prediction', 'pred-branch-performance-prediction', 'pred-early-warning-signals',
      'explain-loan-decisions', 'explain-risk-decisions', 'explain-branch-performance',
      'drill-region', 'drill-branch', 'drill-officer', 'drill-client', 'drill-loan', 'drill-payment',
      'fraud-duplicate-clients', 'fraud-rapid-writeoff', 'fraud-overview',
      'whatif-collection-rate', 'whatif-portfolio-growth',
      'workspace-dashboard-layout', 'workspace-saved-views', 'workspace-my-preferences',
    ],
    operational_manager: [
      'pred-operations-forecast', 'pred-collection-forecast', 'pred-portfolio-forecast', 'pred-branch-performance', 'pred-operational-early-warnings',
      'explain-approval-decisions', 'explain-risk-decisions', 'explain-operational-alerts',
      'drill-operations', 'drill-branches', 'drill-officers', 'drill-collections', 'drill-portfolio',
      'fraud-payment-reversals', 'fraud-rapid-writeoff', 'fraud-officer-approval-pattern',
      'whatif-disbursement-volume', 'whatif-par-change',
      'workspace-dashboard-layout', 'workspace-saved-views', 'workspace-my-preferences',
    ],
    accountant: [
      'pred-cashflow-forecast', 'pred-collection-forecast', 'pred-revenue-forecast', 'pred-portfolio-forecast', 'pred-liquidity-forecast',
      'explain-payment-allocation', 'explain-financial-exceptions', 'explain-accounting-adjustments',
      'drill-revenue', 'drill-collections', 'drill-disbursements', 'drill-expenses', 'drill-profitability', 'drill-cashflow',
      'fraud-payment-reversals', 'fraud-overpayment-pattern',
      'whatif-expense-change', 'whatif-par-change',
      'workspace-dashboard-layout', 'workspace-saved-views', 'workspace-my-preferences',
    ],
    ceo: [
      'pred-company-forecast', 'pred-portfolio-forecast', 'pred-revenue-forecast', 'pred-profit-forecast', 'pred-cashflow-forecast', 'pred-default-prediction', 'pred-branch-performance-prediction',
      'explain-credit-decisions', 'explain-risk-decisions', 'explain-business-alerts', 'explain-performance-changes',
      'drill-company', 'drill-region', 'drill-branch', 'drill-officer', 'drill-client', 'drill-loan', 'drill-payment',
      'fraud-overview', 'fraud-branch-risk-ranking',
      'whatif-revenue-growth', 'whatif-par-change',
      'workspace-dashboard-layout', 'workspace-saved-views', 'workspace-my-preferences',
    ],
    director: [
      'pred-company-forecast', 'pred-portfolio-forecast', 'pred-profit-forecast', 'pred-cashflow-forecast', 'pred-capital-forecast', 'pred-risk-forecast',
      'explain-strategic-decisions', 'explain-credit-decisions', 'explain-risk-decisions', 'explain-financial-changes',
      'drill-company', 'drill-region', 'drill-branch', 'drill-product', 'drill-portfolio', 'drill-loan',
      'fraud-officer-approval-pattern', 'fraud-overview',
      'whatif-revenue-growth', 'whatif-capital-utilization',
      'workspace-dashboard-layout', 'workspace-saved-views', 'workspace-my-preferences',
    ],
    hr: [
      'pred-staff-performance', 'pred-workforce-trends', 'pred-attendance-trends', 'pred-turnover-prediction',
      'explain-performance-decisions', 'explain-hr-alerts',
      'drill-organization', 'drill-department', 'drill-branch', 'drill-employee',
      'fraud-staff-advance-pattern',
      'whatif-headcount-change',
      'workspace-dashboard-layout', 'workspace-saved-views', 'workspace-my-preferences',
    ],
    admin: [
      // Admin gets Intelligence CONFIGURATION/CONTROL items, not the
      // operational outputs above — per the spec's explicit distinction.
      'pred-prediction-models', 'pred-prediction-rules', 'pred-thresholds',
      'explain-explanation-rules', 'explain-decision-factors',
      'drill-analytics-configuration', 'drill-kpi-configuration',
      'fraud-detection-rules', 'fraud-thresholds',
      'whatif-simulation-models', 'whatif-simulation-bounds',
      'workspace-templates', 'workspace-widget-management', 'workspace-role-defaults',
    ],
  };
  for (const [role, feats] of Object.entries(roleGrants)) {
    for (const f of feats) {
      await run('INSERT INTO role_intelligence_access (role_id, feature_id) VALUES (?,?) ON CONFLICT DO NOTHING', [role, f]);
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
  await run('INSERT INTO regions (id, name) VALUES (?,?) ON CONFLICT DO NOTHING', ['rg_lower_coast', 'Lower Coast']);
  await run('INSERT INTO regions (id, name) VALUES (?,?) ON CONFLICT DO NOTHING', ['rg_mt_kenya', 'Mt. Kenya']);
  await run('INSERT INTO regions (id, name) VALUES (?,?) ON CONFLICT DO NOTHING', ['rg_upper_coast', 'Upper Coast']);
  // A real single company-wide Paybill — never overwritten on a reseed if
  // an Admin has since genuinely changed it.
  await run(`INSERT INTO organization_settings (id, paybill) VALUES (1, ?) ON CONFLICT (id) DO NOTHING`, ['400200']);
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
    [id, 'RC-0001', 'System Administrator', email, hash, salt,
      'admin', 'Master System Administration Access', 'System Administrator', 'it_systems', 'Full-time', 'Active']
  );
  console.log('\n================================================================');
  console.log('  INITIAL ADMINISTRATOR ACCOUNT CREATED');
  console.log('================================================================');
  console.log(`  Name:      System Administrator`);
  console.log(`  Email:     ${email}`);
  console.log(`  Password:  ${password}`);
  console.log('  This password is shown ONCE, here, and is not stored anywhere');
  console.log('  in plaintext or in source code. The account is forced to change');
  console.log('  it on first login (must_change_password = true).');
  console.log('================================================================\n');
}

async function seedDemoData() {
  // The full real branch list for the 3 real regions (Lower Coast/Mt.
  // Kenya/Upper Coast) — every one genuinely created here, standing in
  // for the real Admin action, matching the reference "Company Regions"/
  // "Company Branches" design exactly. The 2 pre-existing branch IDs
  // (br_nairobi, br_kisumu — dozens of existing tests hardcode these by
  // ID) are kept, but renamed/relocated onto 2 of these real reference
  // towns (Likoni, Ukunda) rather than existing as their own separate
  // "Nairobi CBD"/"Kisumu" rows alongside a genuinely duplicate real
  // Likoni/Ukunda branch. br_kisumu stays paired with br_mombasa under
  // Lower Coast (as they already were) so the existing "Regional Manager
  // scoped to Kisumu+Mombasa" test coverage keeps holding.
  const branches = [
    ['br_nairobi', 'Likoni', 'Likoni', 'rg_upper_coast'],
    ['br_kisumu', 'Ukunda', 'Ukunda', 'rg_lower_coast'],
    ['br_mombasa', 'Mombasa', 'Mombasa', 'rg_lower_coast'],
    ['br_kwale', 'Kwale', 'Kwale', 'rg_lower_coast'],
    ['br_changamwe', 'Changamwe', 'Changamwe', 'rg_lower_coast'],
    ['br_msambweni', 'Msambweni', 'Msambweni', 'rg_lower_coast'],
    ['br_lungalunga', 'Lungalunga', 'Lungalunga', 'rg_lower_coast'],
    ['br_kinango', 'Kinango', 'Kinango', 'rg_lower_coast'],
    ['br_minjila', 'Minjila', 'Minjila', 'rg_lower_coast'],
    ['br_kagio', 'Kagio', 'Kagio', 'rg_mt_kenya'],
    ['br_maua', 'Maua', 'Maua', 'rg_mt_kenya'],
    ['br_nyahururu', 'Nyahururu', 'Nyahururu', 'rg_mt_kenya'],
    ['br_kangari', 'Kangari', 'Kangari', 'rg_mt_kenya'],
    ['br_wote', 'Wote', 'Wote', 'rg_mt_kenya'],
    ['br_nkubu', 'Nkubu', 'Nkubu', 'rg_mt_kenya'],
    ['br_runyenjes', 'Runyenjes', 'Runyenjes', 'rg_mt_kenya'],
    ['br_ruiru', 'Ruiru', 'Ruiru', 'rg_mt_kenya'],
    ['br_karatina', 'Karatina', 'Karatina', 'rg_mt_kenya'],
    ['br_chuka', 'Chuka', 'Chuka', 'rg_mt_kenya'],
    ['br_kitui', 'Kitui', 'Kitui', 'rg_mt_kenya'],
    ['br_embakasi', 'Embakasi', 'Embakasi', 'rg_mt_kenya'],
    ['br_nyeri', 'Nyeri', 'Nyeri', 'rg_mt_kenya'],
    ['br_malindi', 'Malindi', 'Malindi', 'rg_upper_coast'],
    ['br_mariakani', 'Mariakani', 'Mariakani', 'rg_upper_coast'],
    ['br_kilifi', 'Kilifi', 'Kilifi', 'rg_upper_coast'],
    ['br_mtwapa', 'Mtwapa', 'Mtwapa', 'rg_upper_coast'],
    ['br_taveta', 'Taveta', 'Taveta', 'rg_upper_coast'],
    ['br_voi', 'Voi', 'Voi', 'rg_upper_coast'],
    ['br_mpeketoni', 'Mpeketoni', 'Mpeketoni', 'rg_upper_coast'],
    ['br_loitoktok', 'Loitoktok', 'Loitoktok', 'rg_upper_coast'],
    ['br_kibwezi', 'Kibwezi', 'Kibwezi', 'rg_upper_coast'],
    ['br_wudanyi', 'Wudanyi', 'Wudanyi', 'rg_upper_coast'],
    ['br_kaloleni', 'Kaloleni', 'Kaloleni', 'rg_upper_coast'],
    ['br_bamba', 'Bamba', 'Bamba', 'rg_upper_coast'],
    ['br_gongoni', 'Gongoni', 'Gongoni', 'rg_upper_coast'],
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

  // Real short-term, single-repayment loan products (the actual product
  // catalog Loan Officers pick from on Create Loan Application): a flat
  // rate for the loan's ENTIRE real fixed term — 20% for the 4-week tier,
  // 30% for the 6-week ("Special") tier — repaid once, in a single real
  // installment due term_weeks after disbursement (see buildSchedule()'s
  // own note on how term_weeks changes schedule generation). Each pair
  // shares its real amount range; the "Special" variant is the same
  // product at a longer real term and a real higher rate. Kept as
  // separate rows (added after the 3 above, in this fixed order) rather
  // than replacing them so every existing product_id already hardcoded
  // across the test suite keeps working unchanged.
  const weeklyProducts = [
    ['pr_ln_starter', 'Starter', 20, 3000, 5000, 4],
    ['pr_ln_starter_special', 'Starter Special', 30, 3000, 5000, 6],
    ['pr_ln_jijenge', 'Jijenge', 20, 6000, 10000, 4],
    ['pr_ln_jijenge_special', 'Jijenge Special', 30, 6000, 10000, 6],
    // The id keeps its original 'ibuka' spelling (an internal identifier,
    // never shown to a real user, and already referenced by real
    // existing loans/tests) — only the real, user-facing display name
    // was ever actually misspelled, and only that changes here.
    ['pr_ln_ibuka', 'Inuka', 20, 11000, 15000, 4],
    ['pr_ln_ibuka_special', 'Inuka Special', 30, 11000, 15000, 6],
    ['pr_ln_mavuno', 'Mavuno', 20, 16000, 20000, 4],
    ['pr_ln_mavuno_special', 'Mavuno Special', 30, 16000, 20000, 6],
    ['pr_ln_fly', 'Fly', 20, 21000, 25000, 4],
    ['pr_ln_fly_special', 'Fly Special', 30, 21000, 25000, 6],
  ];
  // A real, flat, admin-editable processing fee (KES 600, matching the
  // reference site's own Charges column for the large majority of real
  // loans shown there) — required, and collected up front via a real
  // confirmed loan_fee_payments record, before any of these weekly
  // products can be submitted as a loan application. Legacy monthly
  // products are untouched (processing_fee_amount stays NULL for them,
  // so no upfront fee is required — they keep using fee_pct at
  // disbursement exactly as before).
  const WEEKLY_PRODUCT_PROCESSING_FEE = 600;
  for (const [id, name, rate, min, max, weeks] of weeklyProducts) {
    await run(
      "INSERT INTO loan_products (id, name, rate_type, rate_pct, min_amount, max_amount, min_term_months, max_term_months, fee_pct, penalty_pct, term_weeks, processing_fee_amount) VALUES (?,?,'Flat',?,?,?,1,1,0,0,?,?) ON CONFLICT DO NOTHING",
      [id, name, rate, min, max, weeks, WEEKLY_PRODUCT_PROCESSING_FEE]
    );
  }

  const demoStaff = [
    ['usr_opsmgr', 'Esther Wanjiku', 'opsmanager@rhinocash.co.ke', '0711000001', 'operational_manager', 'br_nairobi', 'rg_upper_coast', 'usr_ceo'],
    ['usr_regional', 'Daniel Kiptoo', 'regional@rhinocash.co.ke', '0711000002', 'regional_manager', 'br_kisumu', 'rg_lower_coast', 'usr_opsmgr'],
    ['usr_manager', 'David Kariuki', 'manager@rhinocash.co.ke', '0711000003', 'manager', 'br_nairobi', 'rg_upper_coast', 'usr_opsmgr'],
    ['usr_manager_kisumu', 'Faith Njeri', 'manager.kisumu@rhinocash.co.ke', '0711000004', 'manager', 'br_kisumu', 'rg_lower_coast', 'usr_regional'],
    ['usr_accountant', 'Grace Achieng', 'accountant@rhinocash.co.ke', '0711000005', 'accountant', 'br_nairobi', 'rg_upper_coast', 'usr_ceo'],
    ['usr_officer', 'Peter Otieno', 'officer@rhinocash.co.ke', '0711000006', 'loan_officer', 'br_kisumu', 'rg_lower_coast', 'usr_manager_kisumu'],
    ['usr_ceo', 'James Mwangi', 'ceo@rhinocash.co.ke', '0711000007', 'ceo', 'br_nairobi', 'rg_upper_coast', null],
    ['usr_director', 'Naomi Kilonzo', 'director@rhinocash.co.ke', '0711000008', 'director', 'br_nairobi', 'rg_upper_coast', null],
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
      [id, await nextStaffCode(), name, email, phone, hash, salt,
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

  // A real, modest set of demo M-Pesa Paybill collections for the current
  // month (weekdays only, up to today — never a future date, since a
  // payment can't genuinely be "received" before it happens) — otherwise
  // nothing else in --demo seeding ever creates mpesa_c2b_transactions
  // rows, leaving the real "Daily Paybill Collection" calendar (Loan
  // Officer > Payments) with nothing at all to show on a freshly seeded
  // database. Left unmatched (matched_loan_id stays NULL) since matching
  // is a real, separate action — these exist only to make the calendar's
  // real amount/Print-button cells genuinely demonstrable out of the box.
  const c2bNow = new Date();
  const c2bYear = c2bNow.getFullYear(), c2bMonth = c2bNow.getMonth() + 1, c2bToday = c2bNow.getDate();
  for (let day = 1; day <= c2bToday; day++) {
    const weekday = new Date(c2bYear, c2bMonth - 1, day).getDay(); // 0=Sun..6=Sat
    if (weekday === 0 || weekday === 6) continue;
    const dd = String(day).padStart(2, '0'), mm = String(c2bMonth).padStart(2, '0');
    const transId = `DEMOC2B${c2bYear}${mm}${dd}`;
    const amount = 400000 + ((day * 9973) % 400000);
    const msisdn = '2547' + String(10000000 + ((day * 7919) % 90000000));
    await run(
      `INSERT INTO mpesa_c2b_transactions (id, trans_id, environment, amount, msisdn, bill_ref_number, created_at)
       VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      ['c2b_' + crypto.randomUUID(), transId, 'sandbox', amount, msisdn, 'DEMO', `${c2bYear}-${mm}-${dd}T12:00:00.000Z`]
    );
  }
}

(async () => {
  await seedRoles();
  await seedModules();
  await seedPermissions();
  await seedIntelligence();
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
