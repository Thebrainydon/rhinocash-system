'use strict';
// intelligence.js — the real, server-side authority for the Intelligence
// module's permission catalog and per-role/per-user grants. Mirrors the
// existing modules/role_modules/user_module_access pattern (see rbac.js)
// at individual-submenu-item granularity, so a custom role created via
// POST /api/roles can receive Intelligence access through exactly the
// same generic grant mechanism as the 9 structural roles — nothing here
// is hardcoded to a fixed role list.
const { all, get, run } = require('./../db');
const { requireAuth, requirePermission } = require('./../middleware');
const { logAction } = require('./../audit');
const { effectiveIntelligenceFeatures, hasIntelligenceAccess, branchIdsInScope, hasInvestorIntelligenceAccess } = require('./../rbac');
const { computePAR, ledgerBalance } = require('./accounting');
const { verifyToken, tokenHash } = require('./../crypto');
const crypto = require('node:crypto');

// The Intelligence catalog (categories + feature ids/labels, no data) is
// the one endpoint both staff AND Investor sessions need — Investor has
// no row in `roles`/`users` at all, so it can't go through requireAuth,
// and the sidebar-building code on both sides reads the exact same
// finalAccess.intelligence shape. Checked directly against the token's
// own `type` claim rather than nesting requireAuth/requireInvestorAuth as
// middleware-calling-middleware (that pattern silently resolves the outer
// handler's promise before the inner check finishes, turning a later
// error into an unhandled rejection that crashes the whole process — the
// exact real bug the drilldown route itself hit and was fixed away from).
async function isAuthenticated(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return false;
  const payload = verifyToken(token);
  if (!payload) return false;
  const session = await get('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash(token)]);
  if (!session || session.revoked_at) return false;
  if (new Date(session.expires_at).getTime() < Date.now()) return false;
  return true;
}

function scopeClause(scope, column) {
  if (scope === null) return { clause: '1=1', params: [] };
  if (scope.length === 0) return { clause: '1=0', params: [] };
  return { clause: `${column} IN (${scope.map(() => '?').join(',')})`, params: [...scope] };
}

// Real, shared drill-down data engine — one query per real dimension,
// scoped exactly like every other module in this app (branchIdsInScope;
// null = company-wide). Covers only the dimensions with no pre-existing
// equivalent page (see index.html's LABEL_ROUTES/ROLE_ROUTE_OVERRIDES —
// "Collections", "Arrears", "Branches", "Revenue", "Disbursements",
// "Expenses", "Cashflow" and "Employee" all reuse an existing real page
// instead, per the spec's own "integrate rather than duplicate" rule).
async function computeDrillDown(dimension, scope) {
  const loanScope = scopeClause(scope, 'l.branch_id');
  const branchScope = scopeClause(scope, 'id');
  switch (dimension) {
    case 'drill-portfolio': {
      const row = await get(
        `SELECT COUNT(*) as loanCount, COALESCE(SUM(principal),0) as principal FROM loans l WHERE ${loanScope.clause} AND status IN ('Active','Disbursed')`,
        loanScope.params
      );
      const outstandingRow = await get(
        `SELECT COALESCE(SUM(ls.total_due - ls.paid_amount),0) as outstanding FROM loan_schedule ls JOIN loans l ON l.id = ls.loan_id WHERE ${loanScope.clause} AND l.status IN ('Active','Disbursed')`,
        loanScope.params
      );
      return { dimension, activeLoanCount: row.loanCount, principalDisbursed: row.principal, outstandingBalance: Math.max(0, outstandingRow.outstanding) };
    }
    case 'drill-officer':
    case 'drill-officers':
    case 'drill-officer-performance': {
      const rows = await all(
        `SELECT u.id, u.name, COUNT(l.id) as activeLoans, COALESCE(SUM(l.principal),0) as principal
         FROM users u LEFT JOIN loans l ON l.officer_id = u.id AND l.status IN ('Active','Disbursed') AND ${loanScope.clause.replace(/l\./g,'l.')}
         WHERE u.role_id = 'loan_officer' ${scope !== null ? (scope.length ? `AND u.branch_id IN (${scope.map(()=>'?').join(',')})` : 'AND 1=0') : ''}
         GROUP BY u.id, u.name ORDER BY principal DESC LIMIT 50`,
        [...loanScope.params, ...(scope !== null && scope.length ? scope : [])]
      );
      return { dimension, officers: rows };
    }
    case 'drill-region': {
      const rows = await all(
        `SELECT r.id, r.name, COUNT(DISTINCT b.id) as branchCount, COUNT(l.id) as activeLoans, COALESCE(SUM(l.principal),0) as principal
         FROM regions r
         LEFT JOIN branches b ON b.region_id = r.id
         LEFT JOIN loans l ON l.branch_id = b.id AND l.status IN ('Active','Disbursed')
         GROUP BY r.id, r.name ORDER BY r.name`
      );
      return { dimension, regions: rows };
    }
    case 'drill-branch': {
      const rows = await all(
        `SELECT b.id, b.name, COUNT(l.id) as activeLoans, COALESCE(SUM(l.principal),0) as principal
         FROM branches b LEFT JOIN loans l ON l.branch_id = b.id AND l.status IN ('Active','Disbursed')
         WHERE ${branchScope.clause.replace('id', 'b.id')} GROUP BY b.id, b.name ORDER BY principal DESC`,
        branchScope.params
      );
      return { dimension, branches: rows };
    }
    case 'drill-client': {
      const rows = await all(
        `SELECT c.id, c.name, c.branch_id, COALESCE(SUM(ls.total_due - ls.paid_amount),0) as outstanding
         FROM clients c JOIN loans l ON l.client_id = c.id AND l.status IN ('Active','Disbursed') AND ${loanScope.clause}
         JOIN loan_schedule ls ON ls.loan_id = l.id
         GROUP BY c.id, c.name, c.branch_id ORDER BY outstanding DESC LIMIT 50`,
        loanScope.params
      );
      return { dimension, topClientsByOutstanding: rows };
    }
    case 'drill-loan': {
      const rows = await all(
        `SELECT status, COUNT(*) as loanCount, COALESCE(SUM(principal),0) as principal FROM loans l WHERE ${loanScope.clause} GROUP BY status ORDER BY loanCount DESC`,
        loanScope.params
      );
      return { dimension, byStatus: rows };
    }
    case 'drill-payment': {
      const rows = await all(
        `SELECT p.channel, COUNT(*) as paymentCount, COALESCE(SUM(p.amount),0) as amount
         FROM payments p JOIN loans l ON l.id = p.loan_id WHERE ${loanScope.clause} AND p.created_at >= (CURRENT_DATE - INTERVAL '30 days')::text
         GROUP BY p.channel ORDER BY amount DESC`,
        loanScope.params
      );
      return { dimension, last30DaysByChannel: rows };
    }
    case 'drill-operations': {
      const branches = await get(`SELECT COUNT(*) as n FROM branches WHERE ${branchScope.clause}`, branchScope.params);
      const officers = await get(`SELECT COUNT(*) as n FROM users WHERE role_id = 'loan_officer' ${scope !== null ? (scope.length ? `AND branch_id IN (${scope.map(()=>'?').join(',')})` : 'AND 1=0') : ''}`, scope !== null && scope.length ? scope : []);
      const loans = await get(`SELECT COUNT(*) as n, COALESCE(SUM(principal),0) as principal FROM loans l WHERE ${loanScope.clause} AND status IN ('Active','Disbursed')`, loanScope.params);
      return { dimension, branchCount: branches.n, officerCount: officers.n, activeLoanCount: loans.n, principalDisbursed: loans.principal };
    }
    case 'drill-profitability': {
      const thisMonth = new Date().toISOString().slice(0, 7);
      const revenue = await get(`SELECT COALESCE(SUM(je.credit),0) as v FROM journal_entries je JOIN payments p ON p.id = je.ref_id AND je.ref_type='payment' JOIN loans l ON l.id = p.loan_id WHERE ${loanScope.clause} AND je.entry_date LIKE ?`, [...loanScope.params, `${thisMonth}%`]);
      const expenses = await get(`SELECT COALESCE(SUM(amount),0) as v FROM expenses WHERE status='Paid' AND created_at LIKE ?`, [`${thisMonth}%`]);
      const rev = revenue.v, exp = expenses.v;
      return { dimension, month: thisMonth, revenue: rev, expenses: exp, netProfit: rev - exp, marginPct: rev > 0 ? ((rev - exp) / rev * 100) : 0 };
    }
    case 'drill-company': {
      const clients = await get(`SELECT COUNT(*) as n FROM clients`);
      const loans = await get(`SELECT COUNT(*) as n, COALESCE(SUM(principal),0) as principal FROM loans WHERE status IN ('Active','Disbursed')`);
      const branches = await get(`SELECT COUNT(*) as n FROM branches`);
      const staff = await get(`SELECT COUNT(*) as n FROM users WHERE status='Active'`);
      return { dimension, totalClients: clients.n, activeLoanCount: loans.n, principalDisbursed: loans.principal, branchCount: branches.n, staffCount: staff.n };
    }
    case 'drill-product': {
      const rows = await all(
        `SELECT lp.id, lp.name, COUNT(l.id) as loanCount, COALESCE(SUM(l.principal),0) as principal, COALESCE(AVG(l.principal),0) as avgSize
         FROM loan_products lp LEFT JOIN loans l ON l.product_id = lp.id AND l.status IN ('Active','Disbursed') AND ${loanScope.clause}
         GROUP BY lp.id, lp.name ORDER BY principal DESC`,
        loanScope.params
      );
      return { dimension, products: rows };
    }
    case 'drill-organization': {
      const departments = await get(`SELECT COUNT(*) as n FROM departments`);
      const branches = await get(`SELECT COUNT(*) as n FROM branches`);
      const employees = await get(`SELECT COUNT(*) as n FROM users WHERE status='Active'`);
      const byStatus = await all(`SELECT employment_status, COUNT(*) as n FROM users GROUP BY employment_status`);
      return { dimension, departmentCount: departments.n, branchCount: branches.n, employeeCount: employees.n, byEmploymentStatus: byStatus };
    }
    case 'drill-department': {
      const rows = await all(
        `SELECT d.id, d.name, COUNT(u.id) as employeeCount FROM departments d LEFT JOIN users u ON u.department_id = d.id GROUP BY d.id, d.name ORDER BY employeeCount DESC`
      );
      return { dimension, departments: rows };
    }
    default:
      return null;
  }
}

// ---- Predictive Analytics -------------------------------------------
// Real, honest trend indicators computed from stored dates — never a
// trained model standing in for one. Each "forecast" is a real
// month-over-month (or wider, per Admin's configurable trend window)
// comparison of a real stored metric, or a real PAR/aging breakdown
// (reusing accounting.js's own computePAR). Two features — Attendance
// Trends and Turnover Prediction — have no real backing data anywhere in
// this system (no attendance/clock-in table, no termination/separation
// date field) and say so honestly rather than inventing numbers.
async function getTrendWindowMonths() {
  const row = await get("SELECT value FROM intelligence_settings WHERE key = 'trend_window_months'");
  const n = row ? parseInt(row.value, 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function monthKeyOffset(monthsBack) {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsBack);
  return d.toISOString().slice(0, 7);
}
// `sql` must select a single aliased column `v` and end with one LIKE ?
// placeholder for the month-prefix; `scopeParams` are whatever params the
// query needs before that final one.
async function trendCompare(sql, scopeParams) {
  const window = await getTrendWindowMonths();
  const thisMonth = monthKeyOffset(0);
  const lastMonth = monthKeyOffset(window);
  const thisRow = await get(sql, [...scopeParams, `${thisMonth}%`]);
  const lastRow = await get(sql, [...scopeParams, `${lastMonth}%`]);
  const thisPeriod = thisRow.v || 0, lastPeriod = lastRow.v || 0;
  const changePct = lastPeriod > 0 ? ((thisPeriod - lastPeriod) / lastPeriod * 100) : (thisPeriod > 0 ? 100 : 0);
  return { thisPeriod, lastPeriod, changePct, windowMonths: window, thisMonth, lastMonth };
}
async function qualityThresholds() {
  const watch = ((await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'quality_watch_par30_pct'`)) || { threshold_value: 5 }).threshold_value;
  const atRisk = ((await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'quality_atrisk_par30_pct'`)) || { threshold_value: 10 }).threshold_value;
  const critical = ((await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'quality_critical_par30_pct'`)) || { threshold_value: 20 }).threshold_value;
  const def = ((await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'quality_default_par30_pct'`)) || { threshold_value: 40 }).threshold_value;
  const classify = par30 => par30 >= def ? 'Default' : par30 >= critical ? 'Critical' : par30 >= atRisk ? 'At Risk' : par30 >= watch ? 'Watch' : 'Current';
  return { watch, atRisk, critical, def, classify };
}
async function riskView(scope, officerId) {
  const par = await computePAR(scope, officerId);
  const par30 = (par.par.find(p => p.threshold === 30) || {}).percentage || 0;
  const q = await qualityThresholds();
  return { ...par, qualityRating: q.classify(par30), thresholds: { watch: q.watch, atRisk: q.atRisk, critical: q.critical, default: q.def } };
}
async function computePredictive(featureId, req) {
  const scope = await branchIdsInScope(req.user);
  const loanScope = scopeClause(scope, 'l.branch_id');
  switch (featureId) {
    case 'pred-my-collection-prediction': {
      const trend = await trendCompare(
        `SELECT COALESCE(SUM(p.amount),0) as v FROM payments p JOIN loans l ON l.id = p.loan_id WHERE l.officer_id = ? AND p.created_at LIKE ?`,
        [req.user.id]
      );
      return { featureId, kind: 'trend', label: 'Collections', ...trend };
    }
    case 'pred-client-risk-indicators':
      return { featureId, kind: 'risk', ...(await riskView(scope, req.user.id)) };
    case 'pred-early-warning-signals':
    case 'pred-operational-early-warnings':
      return { featureId, kind: 'risk', ...(await riskView(scope)) };
    case 'pred-branch-collection-forecast':
    case 'pred-regional-collection-forecast':
    case 'pred-collection-forecast': {
      const trend = await trendCompare(
        `SELECT COALESCE(SUM(p.amount),0) as v FROM payments p JOIN loans l ON l.id = p.loan_id WHERE ${loanScope.clause} AND p.created_at LIKE ?`,
        loanScope.params
      );
      return { featureId, kind: 'trend', label: 'Collections', ...trend };
    }
    case 'pred-loan-default-prediction':
    case 'pred-default-prediction':
    case 'pred-risk-forecast':
      return { featureId, kind: 'risk', ...(await riskView(scope)) };
    case 'pred-portfolio-forecast':
    case 'pred-regional-portfolio-forecast': {
      const trend = await trendCompare(
        `SELECT COALESCE(SUM(l.principal),0) as v FROM loans l WHERE ${loanScope.clause} AND l.disbursed_at LIKE ?`,
        loanScope.params
      );
      return { featureId, kind: 'trend', label: 'Principal Disbursed', ...trend };
    }
    case 'pred-officer-performance-prediction':
    case 'pred-staff-performance': {
      const rows = await all(
        `SELECT u.id, u.name, COALESCE(SUM(p.amount),0) as thisMonthCollected
         FROM users u LEFT JOIN loans l ON l.officer_id = u.id
         LEFT JOIN payments p ON p.loan_id = l.id AND p.created_at LIKE ?
         WHERE u.role_id = 'loan_officer' ${scope !== null ? (scope.length ? `AND u.branch_id IN (${scope.map(()=>'?').join(',')})` : 'AND 1=0') : ''}
         GROUP BY u.id, u.name ORDER BY thisMonthCollected DESC LIMIT 50`,
        [`${monthKeyOffset(0)}%`, ...(scope !== null && scope.length ? scope : [])]
      );
      return { featureId, kind: 'officer-list', officers: rows };
    }
    case 'pred-branch-performance-prediction':
    case 'pred-branch-performance': {
      const rows = await all(
        `SELECT b.id, b.name, COALESCE(SUM(p.amount),0) as thisMonthCollected
         FROM branches b LEFT JOIN loans l ON l.branch_id = b.id
         LEFT JOIN payments p ON p.loan_id = l.id AND p.created_at LIKE ?
         WHERE ${scopeClause(scope,'b.id').clause} GROUP BY b.id, b.name ORDER BY thisMonthCollected DESC`,
        [`${monthKeyOffset(0)}%`, ...scopeClause(scope,'b.id').params]
      );
      return { featureId, kind: 'branch-list', branches: rows };
    }
    case 'pred-operations-forecast': {
      const trend = await trendCompare(
        `SELECT COALESCE(SUM(l.principal),0) as v FROM loans l WHERE ${loanScope.clause} AND l.disbursed_at LIKE ?`,
        loanScope.params
      );
      return { featureId, kind: 'trend', label: 'Principal Disbursed', ...trend };
    }
    case 'pred-cashflow-forecast': {
      // Needs the same month value twice (payments + expenses), so this
      // is built directly rather than via the shared trendCompare helper
      // (which only ever appends one month placeholder).
      const window = await getTrendWindowMonths();
      const thisMonth = monthKeyOffset(0), lastMonth = monthKeyOffset(window);
      const net = async (mk) => (await get(
        `SELECT (COALESCE((SELECT SUM(amount) FROM payments p JOIN loans l ON l.id=p.loan_id WHERE ${loanScope.clause} AND p.created_at LIKE ?),0) -
                 COALESCE((SELECT SUM(amount) FROM expenses WHERE status='Paid' AND created_at LIKE ?),0)) as v`,
        [...loanScope.params, `${mk}%`, `${mk}%`]
      )).v || 0;
      const thisPeriod = await net(thisMonth), lastPeriod = await net(lastMonth);
      const changePct = lastPeriod !== 0 ? ((thisPeriod - lastPeriod) / Math.abs(lastPeriod) * 100) : (thisPeriod !== 0 ? 100 : 0);
      return { featureId, kind: 'trend', label: 'Net Cashflow', thisPeriod, lastPeriod, changePct, windowMonths: window, thisMonth, lastMonth };
    }
    case 'pred-revenue-forecast':
    case 'pred-company-forecast': {
      const trend = await trendCompare(
        `SELECT COALESCE(SUM(je.credit),0) as v FROM journal_entries je JOIN payments p ON p.id = je.ref_id AND je.ref_type='payment' JOIN loans l ON l.id = p.loan_id WHERE ${loanScope.clause} AND je.entry_date LIKE ?`,
        loanScope.params
      );
      return { featureId, kind: 'trend', label: 'Interest Revenue', ...trend };
    }
    case 'pred-liquidity-forecast': {
      // Same real ledgerBalance() /api/accounting/cash-position itself
      // uses — never a second, guessed account-id query.
      const [cash, bank, mpesa] = await Promise.all([
        ledgerBalance('cash', scope), ledgerBalance('bank', scope), ledgerBalance('mpesa', scope),
      ]);
      return { featureId, kind: 'point', label: 'Current Cash Position', value: cash + bank + mpesa, breakdown: { cash, bank, mpesa } };
    }
    case 'pred-profit-forecast': {
      const window = await getTrendWindowMonths();
      const thisMonth = monthKeyOffset(0), lastMonth = monthKeyOffset(window);
      const profit = async (mk) => {
        const rev = (await get(`SELECT COALESCE(SUM(je.credit),0) as v FROM journal_entries je JOIN payments p ON p.id = je.ref_id AND je.ref_type='payment' JOIN loans l ON l.id = p.loan_id WHERE ${loanScope.clause} AND je.entry_date LIKE ?`, [...loanScope.params, `${mk}%`])).v;
        const exp = (await get(`SELECT COALESCE(SUM(amount),0) as v FROM expenses WHERE status='Paid' AND created_at LIKE ?`, [`${mk}%`])).v;
        return rev - exp;
      };
      const thisPeriod = await profit(thisMonth), lastPeriod = await profit(lastMonth);
      const changePct = lastPeriod !== 0 ? ((thisPeriod - lastPeriod) / Math.abs(lastPeriod) * 100) : (thisPeriod !== 0 ? 100 : 0);
      return { featureId, kind: 'trend', label: 'Net Profit', thisPeriod, lastPeriod, changePct, windowMonths: window, thisMonth, lastMonth };
    }
    case 'pred-capital-forecast': {
      const rows = await all(`SELECT holder_name, holder_type, percentage, capital_contributed FROM equity_holdings ORDER BY capital_contributed DESC NULLS LAST`);
      const total = rows.reduce((s, r) => s + Number(r.capital_contributed || 0), 0);
      return { featureId, kind: 'capital', totalCapital: total, holders: rows };
    }
    case 'pred-workforce-trends': {
      const trend = await trendCompare(
        `SELECT COUNT(*) as v FROM users WHERE created_at LIKE ?`, []
      );
      return { featureId, kind: 'trend', label: 'New Hires', ...trend };
    }
    case 'pred-attendance-trends':
      return { featureId, kind: 'no-data', message: 'No attendance/clock-in data is recorded anywhere in this system yet — this honestly reflects that rather than inventing a trend.' };
    case 'pred-turnover-prediction':
      return { featureId, kind: 'no-data', message: 'No employee separation/termination date is recorded anywhere in this system yet — this honestly reflects that rather than inventing a prediction.' };
    default:
      return null;
  }
}

// ---- Explainable Decisions -------------------------------------------
// Surfaces the real, already-recorded reasoning behind a decision or
// current state — the real loan_approvals audit trail (decision/comments/
// previous->new status), the real client_risk_config thresholds behind a
// risk classification, the real payment_allocations breakdown, the real
// adjustments.reason — never a generated/invented explanation. Every
// "why" here is a real stored field, read back, not synthesized.
async function computeExplainable(featureId, req) {
  const scope = await branchIdsInScope(req.user);
  const loanScope = scopeClause(scope, 'l.branch_id');
  switch (featureId) {
    case 'explain-loan-decision-explanation':
    case 'explain-loan-decisions':
    case 'explain-credit-decisions':
    case 'explain-approval-decisions':
    case 'explain-approval-explanation':
    case 'explain-strategic-decisions': {
      const rows = await all(
        `SELECT la.id, la.decision, la.comments, la.previous_status, la.new_status, la.created_at, la.role_id,
                c.name as clientName, l.principal
         FROM loan_approvals la JOIN loans l ON l.id = la.loan_id JOIN clients c ON c.id = l.client_id
         WHERE ${loanScope.clause} ORDER BY la.created_at DESC LIMIT 25`,
        loanScope.params
      );
      return { featureId, kind: 'decisions', decisions: rows };
    }
    case 'explain-client-risk-explanation':
      return { featureId, kind: 'risk', ...(await riskView(scope, req.user.id)) };
    case 'explain-risk-explanation':
    case 'explain-risk-decisions':
      return { featureId, kind: 'risk', ...(await riskView(scope)) };
    case 'explain-collection-priority-explanation': {
      const officerId = req.user.role_id === 'loan_officer' ? req.user.id : null;
      const rows = await all(
        `SELECT l.id as loanId, c.name as clientName, ls.due_date, ls.total_due - ls.paid_amount as outstanding,
                (CURRENT_DATE - ls.due_date::date) as daysOverdue
         FROM loan_schedule ls JOIN loans l ON l.id = ls.loan_id JOIN clients c ON c.id = l.client_id
         WHERE ${loanScope.clause} AND l.status IN ('Active','Disbursed') AND ls.paid_amount < ls.total_due - 0.01
           AND ls.due_date < CURRENT_DATE::text ${officerId ? 'AND l.officer_id = ?' : ''}
         ORDER BY daysOverdue DESC, outstanding DESC LIMIT 25`,
        officerId ? [...loanScope.params, officerId] : loanScope.params
      );
      return { featureId, kind: 'priority-list', items: rows };
    }
    case 'explain-branch-performance': {
      const rows = await all(
        `SELECT b.id, b.name, COALESCE(SUM(l.principal),0) as principal, COUNT(l.id) as activeLoans
         FROM branches b LEFT JOIN loans l ON l.branch_id = b.id AND l.status IN ('Active','Disbursed')
         WHERE ${scopeClause(scope,'b.id').clause} GROUP BY b.id, b.name ORDER BY principal DESC`,
        scopeClause(scope,'b.id').params
      );
      return { featureId, kind: 'branch-explain', branches: rows };
    }
    case 'explain-operational-alerts':
    case 'explain-business-alerts':
    case 'explain-hr-alerts': {
      const alerts = [];
      const risk = await riskView(scope);
      const par30 = (risk.par.find(p => p.threshold === 30) || {}).percentage || 0;
      if (risk.qualityRating !== 'Current') alerts.push({ severity: risk.qualityRating, message: `Portfolio quality is "${risk.qualityRating}" — PAR-30 at ${par30.toFixed(1)}% (threshold ${risk.thresholds.watch}%).` });
      const pendingLeave = await get(`SELECT COUNT(*) as n FROM leave_requests WHERE status = 'Pending' AND created_at < (CURRENT_DATE - INTERVAL '5 days')::text`);
      if (pendingLeave.n > 0) alerts.push({ severity: 'Watch', message: `${pendingLeave.n} leave request(s) have been pending for more than 5 days.` });
      const pendingAdvances = await get(`SELECT COUNT(*) as n FROM salary_advance_requests WHERE status = 'Pending' AND created_at < (CURRENT_DATE - INTERVAL '5 days')::text`);
      if (pendingAdvances.n > 0) alerts.push({ severity: 'Watch', message: `${pendingAdvances.n} salary advance request(s) have been pending for more than 5 days.` });
      if (!alerts.length) alerts.push({ severity: 'None', message: 'No real alert conditions are currently triggered.' });
      return { featureId, kind: 'alerts', alerts };
    }
    case 'explain-payment-allocation': {
      const rows = await all(
        `SELECT p.id as paymentId, p.amount, p.created_at, c.name as clientName, pa.bucket, pa.amount_applied
         FROM payments p JOIN loans l ON l.id = p.loan_id JOIN clients c ON c.id = l.client_id
         LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
         WHERE ${loanScope.clause} ORDER BY p.created_at DESC LIMIT 30`,
        loanScope.params
      );
      return { featureId, kind: 'allocations', allocations: rows };
    }
    case 'explain-financial-exceptions': {
      const rows = await all(
        `SELECT id, category, note as description, amount, status, created_at FROM expenses
         WHERE status = 'Rejected' OR (status = 'Pending' AND created_at < (CURRENT_DATE - INTERVAL '7 days')::text)
         ORDER BY created_at DESC LIMIT 25`
      );
      return { featureId, kind: 'exceptions', exceptions: rows };
    }
    case 'explain-accounting-adjustments': {
      const rows = await all(`SELECT id, reference, reason, amount, status, created_at FROM adjustments ORDER BY created_at DESC LIMIT 25`);
      return { featureId, kind: 'adjustments', adjustments: rows };
    }
    case 'explain-performance-decisions': {
      const rows = await all(
        `SELECT u.id, u.name, COALESCE(SUM(p.amount),0) as thisMonthCollected
         FROM users u LEFT JOIN loans l ON l.officer_id = u.id
         LEFT JOIN payments p ON p.loan_id = l.id AND p.created_at LIKE ?
         WHERE u.role_id = 'loan_officer' ${scope !== null ? (scope.length ? `AND u.branch_id IN (${scope.map(()=>'?').join(',')})` : 'AND 1=0') : ''}
         GROUP BY u.id, u.name ORDER BY thisMonthCollected DESC LIMIT 50`,
        [`${monthKeyOffset(0)}%`, ...(scope !== null && scope.length ? scope : [])]
      );
      return { featureId, kind: 'officer-list', officers: rows };
    }
    case 'explain-performance-changes':
    case 'explain-financial-changes': {
      const trend = await trendCompare(
        `SELECT COALESCE(SUM(je.credit),0) as v FROM journal_entries je JOIN payments p ON p.id = je.ref_id AND je.ref_type='payment' JOIN loans l ON l.id = p.loan_id WHERE ${loanScope.clause} AND je.entry_date LIKE ?`,
        loanScope.params
      );
      return { featureId, kind: 'trend', label: 'Revenue', ...trend };
    }
    default:
      return null;
  }
}

function requireAdminOnly(action) {
  return (req, res, next) => {
    if (req.user.role_id !== 'admin') {
      return next({ status: 403, message: `Only the System Administrator can ${action}` });
    }
    next();
  };
}

function register(router) {
  // Drill-Down Analytics — :dimension IS the real feature id (e.g.
  // "drill-portfolio"). Checked inline (not via the requireIntelligenceFeature
  // factory, which expects a static id known at route-registration time,
  // not one read from req.params) — a plain await/next, never a nested
  // callback the outer handler doesn't actually wait on, which would let
  // a later error inside it become an unhandled rejection the router's
  // own try/catch never sees.
  router.get('/api/intelligence/drilldown/:dimension', requireAuth, async (req, res, next) => {
    if (!(await hasIntelligenceAccess(req.user, req.params.dimension))) {
      return next({ status: 403, message: `You do not have access to the "${req.params.dimension}" Intelligence feature` });
    }
    const scope = await branchIdsInScope(req.user);
    const result = await computeDrillDown(req.params.dimension, scope);
    if (!result) return next({ status: 404, message: `No drill-down data available for "${req.params.dimension}"` });
    res.json(result);
  });

  // Predictive Analytics — :kind IS the real feature id (same inline
  // check as drilldown above, for the same unhandled-rejection reason).
  router.get('/api/intelligence/predictive/:kind', requireAuth, async (req, res, next) => {
    if (!(await hasIntelligenceAccess(req.user, req.params.kind))) {
      return next({ status: 403, message: `You do not have access to the "${req.params.kind}" Intelligence feature` });
    }
    const result = await computePredictive(req.params.kind, req);
    if (!result) return next({ status: 404, message: `No predictive data available for "${req.params.kind}"` });
    res.json(result);
  });

  // Explainable Decisions — same inline-check pattern.
  router.get('/api/intelligence/explain/:kind', requireAuth, async (req, res, next) => {
    if (!(await hasIntelligenceAccess(req.user, req.params.kind))) {
      return next({ status: 403, message: `You do not have access to the "${req.params.kind}" Intelligence feature` });
    }
    const result = await computeExplainable(req.params.kind, req);
    if (!result) return next({ status: 404, message: `No explanation available for "${req.params.kind}"` });
    res.json(result);
  });

  // Admin > Intelligence > Explainable Decisions > "Explanation Rules" /
  // "Decision Factors" — real, honest, read-only accounts of what data
  // this category's explanations actually draw from (no invented
  // reasoning engine).
  router.get('/api/intelligence/explanation-rules', requireAuth, requirePermission('manage_users'), requireAdminOnly('view Intelligence explanation rules'), async (req, res) => {
    res.json({
      rules: [
        { kind: 'decisions', source: 'The real loan_approvals audit trail (decision, comments, previous/new status) — every "why" shown is a real stored field, read back verbatim.' },
        { kind: 'risk', source: 'The same real PAR/aging computation and client_risk_config thresholds Predictive Analytics and Reports/LoanBook already use.' },
        { kind: 'priority-list', source: 'Real overdue loan_schedule rows ranked by real days-overdue and real outstanding balance.' },
        { kind: 'alerts', source: 'Real current threshold breaches (portfolio quality rating, leave/salary-advance requests pending too long) — no alert fires without a real stored condition.' },
        { kind: 'allocations', source: 'The real payment_allocations breakdown (principal/interest/penalty buckets) for each real payment.' },
        { kind: 'exceptions / adjustments', source: 'Real expenses rows flagged Rejected or stale-Pending, and the real adjustments table\'s own stored reason field.' },
      ],
    });
  });
  router.get('/api/intelligence/decision-factors', requireAuth, requirePermission('manage_users'), requireAdminOnly('view Intelligence decision factors'), async (req, res) => {
    const thresholds = await all('SELECT rule_name, threshold_value, description FROM client_risk_config ORDER BY rule_name');
    res.json({
      factors: [
        { factor: 'Loan approval workflow', detail: 'approval_workflow_steps (real sequential role order) + loan_approvals (real per-step decision record).' },
        { factor: 'Portfolio quality thresholds', detail: 'client_risk_config — the same editable values shown under Predictive Analytics > Thresholds.', thresholds },
        { factor: 'Alert staleness window', detail: 'Leave/salary-advance requests are flagged once Pending for more than 5 real days.' },
      ],
    });
  });

  // Admin > Intelligence > Predictive Analytics > "Prediction Rules" —
  // the one real, persisted, editable trend-window setting every
  // trendCompare() call above reads.
  router.get('/api/intelligence/settings/trend-window', requireAuth, requirePermission('manage_users'), requireAdminOnly('view Intelligence prediction settings'), async (req, res) => {
    res.json({ trendWindowMonths: await getTrendWindowMonths() });
  });
  router.put('/api/intelligence/settings/trend-window', requireAuth, requirePermission('manage_users'), requireAdminOnly('edit Intelligence prediction settings'), async (req, res, next) => {
    const n = parseInt(req.body.months, 10);
    if (!Number.isFinite(n) || n < 1 || n > 12) return next({ status: 400, message: 'months must be an integer between 1 and 12' });
    await run(
      `INSERT INTO intelligence_settings (key, value, updated_by, updated_at) VALUES ('trend_window_months', ?, ?, iso_now())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [String(n), req.user.id]
    );
    await logAction(req, { action: 'Changed Intelligence trend window', module: 'intelligence', recordType: 'IntelligenceSetting', recordId: 'trend_window_months', newValue: n });
    res.json({ ok: true, trendWindowMonths: n });
  });
  // Admin > Intelligence > Predictive Analytics > "Prediction Models" —
  // a real, honest, read-only account of the actual methods this system
  // computes predictions with (no invented ML claims).
  router.get('/api/intelligence/prediction-models', requireAuth, requirePermission('manage_users'), requireAdminOnly('view Intelligence prediction models'), async (req, res) => {
    res.json({
      models: [
        { kind: 'trend', method: 'Month-over-month comparison of a real stored metric (collections, disbursements, revenue, cashflow, profit, headcount), window configurable via Prediction Rules.' },
        { kind: 'risk', method: 'PAR aging breakdown (1/7/30/60/90 days overdue) via the same computePAR() every Reports/LoanBook risk view already uses, classified against the real configurable Thresholds.' },
        { kind: 'officer-list / branch-list', method: 'Real per-officer / per-branch current-month collection totals, ranked — not a trend, a real current snapshot.' },
        { kind: 'capital', method: 'Real recorded equity_holdings contributions, no projection.' },
        { kind: 'no-data', method: 'Attendance Trends and Turnover Prediction have no real backing data in this system (no attendance/clock-in table, no separation-date field) — they report that honestly instead of fabricating a number.' },
      ],
    });
  });
  // Admin > Intelligence > Predictive Analytics > "Thresholds" — the
  // real, existing client_risk_config table (already read live by
  // Reports/LoanBook/Collections) — a real edit here has a real,
  // immediate effect on those pages too, not a second, decorative copy.
  router.get('/api/intelligence/thresholds', requireAuth, requirePermission('manage_users'), requireAdminOnly('view risk thresholds'), async (req, res) => {
    res.json({ thresholds: await all('SELECT * FROM client_risk_config ORDER BY rule_name') });
  });
  router.put('/api/intelligence/thresholds/:ruleName', requireAuth, requirePermission('manage_users'), requireAdminOnly('edit risk thresholds'), async (req, res, next) => {
    const value = Number(req.body.threshold_value);
    if (!Number.isFinite(value)) return next({ status: 400, message: 'threshold_value must be a number' });
    const existing = await get('SELECT * FROM client_risk_config WHERE rule_name = ?', [req.params.ruleName]);
    if (!existing) return next({ status: 404, message: 'Unknown threshold rule' });
    await run('UPDATE client_risk_config SET threshold_value = ?, updated_by = ?, updated_at = iso_now() WHERE rule_name = ?', [value, req.user.id, req.params.ruleName]);
    await logAction(req, { action: 'Changed risk threshold', module: 'intelligence', recordType: 'ClientRiskConfig', recordId: req.params.ruleName, previousValue: existing.threshold_value, newValue: value });
    res.json({ ok: true });
  });


  // The full catalog (categories + every feature) — every authenticated
  // user needs this to label their own granted sidebar items, and the
  // Admin config UI needs it to render the grant checklist for any role,
  // including a brand-new custom one. Not sensitive: ids/labels only, no
  // data.
  router.get('/api/intelligence/catalog', async (req, res, next) => {
    if (!(await isAuthenticated(req))) return next({ status: 401, message: 'Not authenticated' });
    const categories = await all('SELECT * FROM intelligence_categories ORDER BY sort_order');
    const features = await all('SELECT * FROM intelligence_features ORDER BY category_id, sort_order');
    res.json({ categories, features });
  });

  // A role's current Intelligence grants — Admin-exclusive, same
  // "manage_users holds the door, requireAdminOnly holds the room" pattern
  // as GET/PUT /api/roles/:id/permissions.
  router.get('/api/roles/:id/intelligence', requireAuth, requirePermission('manage_users'), requireAdminOnly("view a role's Intelligence access"), async (req, res, next) => {
    const role = await get('SELECT id FROM roles WHERE id = ?', [req.params.id]);
    if (!role) return next({ status: 404, message: 'Role not found' });
    const rows = await all('SELECT feature_id FROM role_intelligence_access WHERE role_id = ?', [req.params.id]);
    res.json({ featureIds: rows.map(r => r.feature_id) });
  });

  // Bulk set — the page loads the current grant list via the GET above,
  // lets the Admin toggle any number of checkboxes locally (including for
  // a role they just created through POST /api/roles), then sends the
  // whole desired set here in one request. Computes the real added/
  // removed diff server-side and validates every id against the real
  // intelligence_features table — never a silent partial write, never a
  // fabricated feature id.
  router.put('/api/roles/:id/intelligence', requireAuth, requirePermission('manage_users'), requireAdminOnly("edit a role's Intelligence access"), async (req, res, next) => {
    const role = await get('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (!role) return next({ status: 404, message: 'Role not found' });
    const requested = Array.isArray(req.body.featureIds) ? [...new Set(req.body.featureIds)] : null;
    if (!requested) return next({ status: 400, message: 'featureIds must be an array' });
    const validFeatures = await all('SELECT id FROM intelligence_features');
    const validIds = new Set(validFeatures.map(f => f.id));
    const unknown = requested.filter(id => !validIds.has(id));
    if (unknown.length) return next({ status: 400, message: `Unknown Intelligence feature id(s): ${unknown.join(', ')}` });

    const before = (await all('SELECT feature_id FROM role_intelligence_access WHERE role_id = ?', [req.params.id])).map(r => r.feature_id);
    const beforeSet = new Set(before);
    const requestedSet = new Set(requested);
    const toAdd = requested.filter(id => !beforeSet.has(id));
    const toRemove = before.filter(id => !requestedSet.has(id));

    for (const id of toAdd) {
      await run('INSERT INTO role_intelligence_access (role_id, feature_id) VALUES (?,?) ON CONFLICT DO NOTHING', [req.params.id, id]);
    }
    for (const id of toRemove) {
      await run('DELETE FROM role_intelligence_access WHERE role_id = ? AND feature_id = ?', [req.params.id, id]);
    }
    await logAction(req, { action: 'Changed role Intelligence access', module: 'intelligence', recordType: 'Role', recordId: req.params.id, previousValue: before, newValue: requested });
    res.json({ ok: true, featureIds: requested });
  });

  // Per-user override — the personal list, same "empty/absent = use role
  // default" semantics as /api/users/:id/module-access.
  router.put('/api/users/:id/intelligence-access', requireAuth, requirePermission('manage_users'), requireAdminOnly("set a user's Intelligence access"), async (req, res, next) => {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return next({ status: 404, message: 'User not found' });
    const featureIds = Array.isArray(req.body.featureIds) ? req.body.featureIds : [];
    const before = await effectiveIntelligenceFeatures(user);
    await run('DELETE FROM user_intelligence_access WHERE user_id = ?', [user.id]);
    for (const id of featureIds) {
      await run('INSERT INTO user_intelligence_access (user_id, feature_id) VALUES (?,?) ON CONFLICT DO NOTHING', [user.id, id]);
    }
    const after = await effectiveIntelligenceFeatures(user);
    await logAction(req, { action: 'Set user Intelligence access', module: 'intelligence', recordType: 'User', recordId: user.id, previousValue: before, newValue: after, reason: req.body.reason });
    res.json({ ok: true, featureIds: after });
  });

  register_workspace(router);
}

// ---- Personalizable Workspaces -----------------------------------------
// Dashboard Layout / Saved Views / My Preferences — all real, persisted
// per-principal state, never a client-only convenience. Investor is a
// separate principal type with no row in users(id) (same reasoning as
// INVESTOR_INTELLIGENCE_FEATURES elsewhere in this file), so it gets its
// own parallel investor_workspace_preferences table rather than being
// forced through the staff-only FK — both share the exact same
// layout_json shape: { hiddenWidgets: string[], savedViews: {id,name,
// section,subtab,createdAt}[], defaultLanding: {section,subtab}|null }.

// The real catalog of widgets each role's actual Dashboard page is built
// from (the SAME pieCard()/staffPerformanceTable()/etc. calls already
// live on that page — see index.html) — never a second, invented set.
// Keys for pie charts are "pie:<exact literal title>" (pieCard() itself
// checks this), everything else is the shared function's own name. Not
// every role's Dashboard is built from cleanly reusable, titled widgets
// (the Accountant/CEO/Director/Investor pages are mostly bespoke inline
// cards) — those roles honestly get a smaller catalog rather than a
// fabricated one.
const DASHBOARD_WIDGET_CATALOG = {
  loan_officer: [
    { key: 'pie:Client Loans Analysis', label: 'Client Loans Analysis (chart)' },
    { key: "pie:My Clients' Loan Cycles", label: "My Clients' Loan Cycles (chart)" },
    { key: 'pie:My Loan Products Distribution', label: 'My Loan Products Distribution (chart)' },
    { key: 'pie:OLB Distribution — All Officers', label: 'OLB Distribution — All Officers (chart)' },
    { key: 'staffPerformanceTable', label: 'Staff Performance Table' },
    { key: 'performanceIndicatorsTable', label: 'Performance Indicators Table' },
  ],
  manager: [
    { key: 'teamCollectionPerformance', label: "Team Collection Performance" },
    { key: 'pie:Client Loans Analysis', label: 'Client Loans Analysis (chart)' },
    { key: "pie:Branch Clients' Loan Cycles", label: "Branch Clients' Loan Cycles (chart)" },
    { key: 'pie:Branch Loan Products Distribution', label: 'Branch Loan Products Distribution (chart)' },
    { key: 'pie:OLB Distribution — Branch Officers', label: 'OLB Distribution — Branch Officers (chart)' },
    { key: 'staffPerformanceTable', label: 'Staff Performance Table' },
    { key: 'performanceIndicatorsTable', label: 'Performance Indicators Table' },
  ],
  regional_manager: [
    { key: 'branchComparison', label: 'Regional Branch Comparison' },
    { key: 'branchPerformanceBars', label: 'Branch Performance Bars' },
    { key: 'pie:Client Loans Analysis', label: 'Client Loans Analysis (chart)' },
    { key: 'pie:Loan Products Distribution', label: 'Loan Products Distribution (chart)' },
    { key: 'staffPerformanceTable', label: 'Staff Performance Table' },
    { key: 'performanceIndicatorsTable', label: 'Performance Indicators Table' },
  ],
  operational_manager: [
    { key: 'branchComparison', label: 'Organization Branch Comparison' },
    { key: 'branchPerformanceBars', label: 'Branch Performance Bars' },
    { key: 'orgCounts', label: 'Organization Counts' },
    { key: 'pie:Client Loans Analysis', label: 'Client Loans Analysis (chart)' },
    { key: "pie:Active Clients' Loan Cycles", label: "Active Clients' Loan Cycles (chart)" },
    { key: 'pie:Loan Products Distribution', label: 'Loan Products Distribution (chart)' },
    { key: 'pie:OLB Distribution by Officer', label: 'OLB Distribution by Officer (chart)' },
    { key: 'staffPerformanceTable', label: 'Staff Performance Table' },
    { key: 'performanceIndicatorsTable', label: 'Performance Indicators Table' },
  ],
  accountant: [
    { key: 'postedUnpostedCollections', label: 'Posted/Unposted Collections' },
  ],
  ceo: [
    { key: 'ceo-branch-leaderboard', label: 'Branch Leaderboard' },
    { key: 'ceo-top-officers', label: 'Top Performing Officers' },
    { key: 'ceo-portfolio-quality', label: 'Portfolio Quality' },
    { key: 'ceo-liquidity', label: 'Liquidity' },
    { key: 'branchPerformanceBars', label: 'Branch Performance Bars' },
    { key: 'staffPerformanceTable', label: 'Staff Performance Table' },
    { key: 'performanceIndicatorsTable', label: 'Performance Indicators Table' },
  ],
  director: [
    { key: 'portfolioRisk', label: 'Portfolio Risk' },
    { key: 'branchPerformanceBars', label: 'Branch Performance Bars' },
    { key: 'staffPerformanceTable', label: 'Staff Performance Table' },
    { key: 'performanceIndicatorsTable', label: 'Performance Indicators Table' },
  ],
  hr: [],
};
const INVESTOR_WIDGET_CATALOG = [
  { key: 'investor-investment-timeline', label: 'Investment Timeline' },
  { key: 'investor-company-performance', label: 'Company Performance — Limited View' },
  { key: 'investor-collection-performance', label: 'Portfolio Collection Performance' },
  { key: 'investor-payment-history', label: 'Payment History' },
];
const ALL_WIDGET_KEYS = new Set([
  ...Object.values(DASHBOARD_WIDGET_CATALOG).flat().map(w => w.key),
  ...INVESTOR_WIDGET_CATALOG.map(w => w.key),
]);

function emptyWorkspaceState() {
  return { hiddenWidgets: [], savedViews: [], defaultLanding: null };
}
function parseWorkspaceState(layoutJson) {
  if (!layoutJson) return emptyWorkspaceState();
  try {
    const parsed = JSON.parse(layoutJson);
    return {
      hiddenWidgets: Array.isArray(parsed.hiddenWidgets) ? parsed.hiddenWidgets : [],
      savedViews: Array.isArray(parsed.savedViews) ? parsed.savedViews : [],
      defaultLanding: parsed.defaultLanding && typeof parsed.defaultLanding === 'object' ? parsed.defaultLanding : null,
    };
  } catch {
    return emptyWorkspaceState();
  }
}

// Same reasoning as isAuthenticated() above (the Intelligence catalog
// endpoint) — a real dual-audience principal check, done inline, never
// nested middleware-calling-middleware.
async function currentPrincipal(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const session = await get('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash(token)]);
  if (!session || session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  if (payload.type === 'investor') {
    const investor = await get('SELECT * FROM investors WHERE id = ?', [payload.sub]);
    if (!investor || investor.status !== 'Active') return null;
    return { kind: 'investor', id: investor.id, roleId: null };
  }
  const user = await get('SELECT * FROM users WHERE id = ?', [payload.sub]);
  if (!user || user.status !== 'Active') return null;
  return { kind: 'user', id: user.id, roleId: user.role_id };
}
async function principalHasFeature(principal, featureId) {
  if (principal.kind === 'investor') return hasInvestorIntelligenceAccess(featureId);
  return hasIntelligenceAccess({ id: principal.id, role_id: principal.roleId }, featureId);
}
async function loadWorkspaceState(principal) {
  if (principal.kind === 'investor') {
    const row = await get('SELECT layout_json FROM investor_workspace_preferences WHERE investor_id = ?', [principal.id]);
    return parseWorkspaceState(row && row.layout_json);
  }
  const row = await get('SELECT layout_json FROM user_workspace_preferences WHERE user_id = ?', [principal.id]);
  const state = parseWorkspaceState(row && row.layout_json);
  // A user who has never saved their own hiddenWidgets inherits the
  // role's real, Admin-configured default (Role Defaults) rather than
  // always starting from "everything visible" — but a user's OWN saved
  // list, even an empty one they explicitly chose, always wins.
  if (!row) {
    const roleDefault = await get('SELECT hidden_widgets_json FROM role_workspace_defaults WHERE role_id = ?', [principal.roleId]);
    if (roleDefault) {
      try { state.hiddenWidgets = JSON.parse(roleDefault.hidden_widgets_json) || []; } catch { /* ignore */ }
    }
  }
  return state;
}
async function saveWorkspaceState(principal, state) {
  const json = JSON.stringify(state);
  if (principal.kind === 'investor') {
    await run(
      `INSERT INTO investor_workspace_preferences (investor_id, layout_json, updated_at) VALUES (?,?,iso_now())
       ON CONFLICT(investor_id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at`,
      [principal.id, json]
    );
  } else {
    await run(
      `INSERT INTO user_workspace_preferences (user_id, layout_json, updated_at) VALUES (?,?,iso_now())
       ON CONFLICT(user_id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at`,
      [principal.id, json]
    );
  }
}

function register_workspace(router) {
  router.get('/api/intelligence/workspace/state', async (req, res, next) => {
    const principal = await currentPrincipal(req);
    if (!principal) return next({ status: 401, message: 'Not authenticated' });
    res.json(await loadWorkspaceState(principal));
  });

  router.put('/api/intelligence/workspace/hidden-widgets', async (req, res, next) => {
    const principal = await currentPrincipal(req);
    if (!principal) return next({ status: 401, message: 'Not authenticated' });
    if (!(await principalHasFeature(principal, 'workspace-dashboard-layout'))) {
      return next({ status: 403, message: 'You do not have access to the Dashboard Layout Intelligence feature' });
    }
    const hiddenWidgets = Array.isArray(req.body.hiddenWidgets) ? req.body.hiddenWidgets.filter(k => typeof k === 'string') : null;
    if (!hiddenWidgets) return next({ status: 400, message: 'hiddenWidgets must be an array of strings' });
    const state = await loadWorkspaceState(principal);
    state.hiddenWidgets = hiddenWidgets;
    await saveWorkspaceState(principal, state);
    res.json({ ok: true, hiddenWidgets });
  });

  router.post('/api/intelligence/workspace/saved-views', async (req, res, next) => {
    const principal = await currentPrincipal(req);
    if (!principal) return next({ status: 401, message: 'Not authenticated' });
    if (!(await principalHasFeature(principal, 'workspace-saved-views'))) {
      return next({ status: 403, message: 'You do not have access to the Saved Views Intelligence feature' });
    }
    const name = (req.body.name || '').trim();
    const section = (req.body.section || '').trim();
    if (!name || !section) return next({ status: 400, message: 'name and section are required' });
    const state = await loadWorkspaceState(principal);
    if (state.savedViews.length >= 50) return next({ status: 400, message: 'You already have 50 saved views — delete one first' });
    const view = { id: 'wv_' + crypto.randomUUID(), name, section, subtab: req.body.subtab || null, createdAt: new Date().toISOString() };
    state.savedViews.push(view);
    await saveWorkspaceState(principal, state);
    res.status(201).json({ ok: true, view, savedViews: state.savedViews });
  });

  router.delete('/api/intelligence/workspace/saved-views/:id', async (req, res, next) => {
    const principal = await currentPrincipal(req);
    if (!principal) return next({ status: 401, message: 'Not authenticated' });
    const state = await loadWorkspaceState(principal);
    const before = state.savedViews.length;
    state.savedViews = state.savedViews.filter(v => v.id !== req.params.id);
    if (state.savedViews.length === before) return next({ status: 404, message: 'Saved view not found' });
    await saveWorkspaceState(principal, state);
    res.json({ ok: true, savedViews: state.savedViews });
  });

  router.put('/api/intelligence/workspace/default-landing', async (req, res, next) => {
    const principal = await currentPrincipal(req);
    if (!principal) return next({ status: 401, message: 'Not authenticated' });
    if (!(await principalHasFeature(principal, 'workspace-my-preferences'))) {
      return next({ status: 403, message: 'You do not have access to the My Preferences Intelligence feature' });
    }
    const state = await loadWorkspaceState(principal);
    if (req.body.clear) {
      state.defaultLanding = null;
    } else {
      const section = (req.body.section || '').trim();
      if (!section) return next({ status: 400, message: 'section is required (or pass clear:true)' });
      state.defaultLanding = { section, subtab: req.body.subtab || null };
    }
    await saveWorkspaceState(principal, state);
    res.json({ ok: true, defaultLanding: state.defaultLanding });
  });

  // Admin > Intelligence > Personalizable Workspaces > "Workspace
  // Templates" — a real, read-only account of the actual widget catalog
  // every role's own Dashboard is built from (not a second, invented
  // design-time artifact).
  router.get('/api/intelligence/workspace/templates', requireAuth, requirePermission('manage_users'), requireAdminOnly('view Workspace Templates'), async (req, res) => {
    res.json({ roles: DASHBOARD_WIDGET_CATALOG, investor: INVESTOR_WIDGET_CATALOG });
  });

  // Admin > Intelligence > Personalizable Workspaces > "Widget
  // Management" — the deduplicated real widget inventory across every
  // role, with which roles each one belongs to.
  router.get('/api/intelligence/workspace/widgets', requireAuth, requirePermission('manage_users'), requireAdminOnly('view Widget Management'), async (req, res) => {
    const byKey = new Map();
    for (const [role, widgets] of Object.entries(DASHBOARD_WIDGET_CATALOG)) {
      for (const w of widgets) {
        if (!byKey.has(w.key)) byKey.set(w.key, { key: w.key, label: w.label, roles: [] });
        byKey.get(w.key).roles.push(role);
      }
    }
    for (const w of INVESTOR_WIDGET_CATALOG) {
      if (!byKey.has(w.key)) byKey.set(w.key, { key: w.key, label: w.label, roles: [] });
      byKey.get(w.key).roles.push('investor');
    }
    res.json({ widgets: [...byKey.values()] });
  });

  // Admin > Intelligence > Personalizable Workspaces > "Role Defaults" —
  // a REAL, editable default: any user of this role with no personal
  // override starts from this hidden-widget set (see loadWorkspaceState).
  router.get('/api/intelligence/workspace/role-defaults/:roleId', requireAuth, requirePermission('manage_users'), requireAdminOnly('view Role Defaults'), async (req, res, next) => {
    const role = await get('SELECT id FROM roles WHERE id = ?', [req.params.roleId]);
    if (!role) return next({ status: 404, message: 'Role not found' });
    const row = await get('SELECT hidden_widgets_json FROM role_workspace_defaults WHERE role_id = ?', [req.params.roleId]);
    let hiddenWidgets = [];
    if (row) { try { hiddenWidgets = JSON.parse(row.hidden_widgets_json) || []; } catch { /* ignore */ } }
    res.json({ roleId: req.params.roleId, hiddenWidgets });
  });
  router.put('/api/intelligence/workspace/role-defaults/:roleId', requireAuth, requirePermission('manage_users'), requireAdminOnly('edit Role Defaults'), async (req, res, next) => {
    const role = await get('SELECT id FROM roles WHERE id = ?', [req.params.roleId]);
    if (!role) return next({ status: 404, message: 'Role not found' });
    const hiddenWidgets = Array.isArray(req.body.hiddenWidgets) ? req.body.hiddenWidgets.filter(k => typeof k === 'string') : null;
    if (!hiddenWidgets) return next({ status: 400, message: 'hiddenWidgets must be an array of strings' });
    const unknown = hiddenWidgets.filter(k => !ALL_WIDGET_KEYS.has(k));
    if (unknown.length) return next({ status: 400, message: `Unknown widget key(s): ${unknown.join(', ')}` });
    await run(
      `INSERT INTO role_workspace_defaults (role_id, hidden_widgets_json, updated_by, updated_at) VALUES (?,?,?,iso_now())
       ON CONFLICT(role_id) DO UPDATE SET hidden_widgets_json = excluded.hidden_widgets_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [req.params.roleId, JSON.stringify(hiddenWidgets), req.user.id]
    );
    await logAction(req, { action: 'Changed role workspace defaults', module: 'intelligence', recordType: 'Role', recordId: req.params.roleId, newValue: hiddenWidgets });
    res.json({ ok: true, hiddenWidgets });
  });
}

module.exports = { register };
