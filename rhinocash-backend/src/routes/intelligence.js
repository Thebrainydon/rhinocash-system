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
const { effectiveIntelligenceFeatures, hasIntelligenceAccess, branchIdsInScope } = require('./../rbac');
const { computePAR, ledgerBalance } = require('./accounting');
const { verifyToken, tokenHash } = require('./../crypto');

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
}

module.exports = { register };
