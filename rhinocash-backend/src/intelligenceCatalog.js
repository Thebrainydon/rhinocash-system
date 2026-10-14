// intelligenceCatalog.js — the Intelligence menus (categories, features)
// and each role's default grants. Used by seed.js and, once per database,
// by the startup migration in db.js — so a database seeded before
// Intelligence existed still gets its menus.
'use strict';
async function seedIntelligenceCatalog(run, opts = {}) {
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
      if (opts.grants === false) continue;
      await run('INSERT INTO role_intelligence_access (role_id, feature_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM roles WHERE id = ?) ON CONFLICT DO NOTHING', [role, f, role]);
    }
  }
}


module.exports = { seedIntelligenceCatalog };
