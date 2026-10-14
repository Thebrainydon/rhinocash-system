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
const { collectionTotals } = require('./collections');
const { groupMetrics, agingProvision, loanFacts } = require('./../portfolioMetrics');
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
// Names of the officers / branches / regions / products a caller can see,
// so groups with nothing running still show (as zeros).
async function namesInScope(kind, scope) {
  const inList = (col) => scope === null ? { c: '1=1', p: [] } : scope.length ? { c: `${col} IN (${scope.map(() => '?').join(',')})`, p: [...scope] } : { c: '1=0', p: [] };
  let rows = [];
  if (kind === 'officer') { const w = inList('branch_id'); rows = await all(`SELECT id, name FROM users WHERE role_id = 'loan_officer' AND status = 'Active' AND ${w.c}`, w.p); }
  if (kind === 'branch') { const w = inList('id'); rows = await all(`SELECT id, name FROM branches WHERE COALESCE(status,'Active') <> 'Closed' AND ${w.c}`, w.p); }
  if (kind === 'region') { const w = inList('b.id'); rows = await all(`SELECT DISTINCT r.id, r.name FROM regions r JOIN branches b ON b.region_id = r.id WHERE ${w.c}`, w.p); }
  if (kind === 'product') rows = await all(`SELECT id, name FROM loan_products`);
  return Object.fromEntries(rows.map(r => [r.id, r.name]));
}
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
      const g = await groupMetrics('branch', scope, { names: await namesInScope('branch', scope) });
      const aging = await agingProvision(scope, null, 10);
      return { dimension, activeLoanCount: row.loanCount, principalDisbursed: row.principal, outstandingBalance: Math.max(0, outstandingRow.outstanding), summary: g.total, branches: g.rows, classes: aging.classes };
    }
    case 'drill-officer':
    case 'drill-officers':
    case 'drill-officer-performance': {
      const g = await groupMetrics('officer', scope, { names: await namesInScope('officer', scope) });
      return { dimension, officers: g.rows, total: g.total };
    }
    case 'drill-region': {
      // Only the regions the caller covers (a Regional Manager: their own).
      const names = await namesInScope('region', scope);
      const g = await groupMetrics('region', scope, { names });
      const counts = await all(`SELECT region_id, COUNT(*)::int AS n FROM branches WHERE ${branchScope.clause} GROUP BY region_id`, branchScope.params);
      const rows = g.rows.filter(r => names[r.id]).map(r => ({ ...r, branchCount: (counts.find(c => c.region_id === r.id) || { n: 0 }).n }));
      return { dimension, regions: rows, total: g.total };
    }
    case 'drill-branch': {
      const g = await groupMetrics('branch', scope, { names: await namesInScope('branch', scope) });
      return { dimension, branches: g.rows, total: g.total };
    }
    case 'drill-client': {
      const byClient = new Map();
      for (const l of await loanFacts(scope)) {
        const c = byClient.get(l.client_id) || { id: l.client_id, name: l.client_name, phone: l.client_phone, officer: l.officer_name, branch: l.branch_name, loans: 0, principal: 0, outstanding: 0, arrears: 0, daysOverdue: 0, provision: 0, classLabel: l.classLabel };
        c.loans++; c.principal += l.principal; c.outstanding += l.outstanding; c.arrears += l.arrears; c.provision += l.provision;
        if (l.daysOverdue >= c.daysOverdue) { c.daysOverdue = l.daysOverdue; c.classLabel = l.classLabel; }
        byClient.set(l.client_id, c);
      }
      const rows = [...byClient.values()].sort((a, b) => b.outstanding - a.outstanding).slice(0, 50);
      return { dimension, topClientsByOutstanding: rows };
    }
    case 'drill-loan': {
      const rows = await all(
        `SELECT status, COUNT(*)::int as loanCount, COALESCE(SUM(principal),0) as principal, COALESCE(AVG(principal),0) as avgPrincipal FROM loans l WHERE ${loanScope.clause} GROUP BY status ORDER BY loanCount DESC`,
        loanScope.params
      );
      const n = rows.reduce((s, r) => s + Number(r.loancount), 0), amt = rows.reduce((s, r) => s + Number(r.principal), 0);
      return { dimension, byStatus: rows.map(r => ({ ...r, avgprincipal: Math.round(Number(r.avgprincipal)), countSharePct: n ? Math.round(r.loancount / n * 1000) / 10 : 0, amountSharePct: amt ? Math.round(r.principal / amt * 1000) / 10 : 0 })) };
    }
    case 'drill-payment': {
      const rows = await all(
        `SELECT p.channel, COUNT(*)::int as paymentCount, COALESCE(SUM(p.amount),0) as amount, COALESCE(AVG(p.amount),0) as avgAmount,
                COUNT(DISTINCT p.client_id)::int as clients, MAX(p.created_at) as lastPayment
         FROM payments p JOIN loans l ON l.id = p.loan_id WHERE ${loanScope.clause} AND p.status NOT IN ('Unposted','Reversed') AND p.created_at >= (CURRENT_DATE - INTERVAL '30 days')::text
         GROUP BY p.channel ORDER BY amount DESC`,
        loanScope.params
      );
      const tot = rows.reduce((s, r) => s + Number(r.amount), 0);
      return { dimension, last30DaysByChannel: rows.map(r => ({ ...r, avgamount: Math.round(Number(r.avgamount)), sharePct: tot ? Math.round(r.amount / tot * 1000) / 10 : 0 })) };
    }
    case 'drill-operations': {
      const branches = await get(`SELECT COUNT(*) as n FROM branches WHERE ${branchScope.clause}`, branchScope.params);
      const officers = await get(`SELECT COUNT(*) as n FROM users WHERE role_id = 'loan_officer' ${scope !== null ? (scope.length ? `AND branch_id IN (${scope.map(()=>'?').join(',')})` : 'AND 1=0') : ''}`, scope !== null && scope.length ? scope : []);
      const loans = await get(`SELECT COUNT(*) as n, COALESCE(SUM(principal),0) as principal FROM loans l WHERE ${loanScope.clause} AND status IN ('Active','Disbursed')`, loanScope.params);
      const g = await groupMetrics('branch', scope, { names: await namesInScope('branch', scope) });
      return { dimension, branchCount: branches.n, officerCount: officers.n, activeLoanCount: loans.n, principalDisbursed: loans.principal, summary: g.total, branches: g.rows,
        loansPerOfficer: officers.n ? Math.round(loans.n / officers.n * 10) / 10 : 0, portfolioPerOfficer: officers.n ? Math.round(g.total.outstanding / officers.n) : 0 };
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
      const g = await groupMetrics('branch', null, { names: await namesInScope('branch', null) });
      return { dimension, totalClients: clients.n, activeLoanCount: loans.n, principalDisbursed: loans.principal, branchCount: branches.n, staffCount: staff.n, summary: g.total, branches: g.rows };
    }
    case 'drill-product': {
      const g = await groupMetrics('product', scope, { names: await namesInScope('product', scope) });
      return { dimension, products: g.rows, total: g.total };
    }
    case 'drill-organization': {
      const departments = await get(`SELECT COUNT(*) as n FROM departments`);
      const branches = await get(`SELECT COUNT(*) as n FROM branches`);
      const employees = await get(`SELECT COUNT(*) as n FROM users WHERE status='Active'`);
      const byStatus = await all(`SELECT employment_status, COUNT(*)::int as n, COUNT(*) FILTER (WHERE status = 'Active')::int as active FROM users GROUP BY employment_status ORDER BY n DESC`);
      const byRole = await all(`SELECT u.role_id, COALESCE(r.name, u.role_id) as role, COUNT(*)::int as n, COUNT(*) FILTER (WHERE u.status = 'Active')::int as active, COALESCE(SUM(u.basic_salary) FILTER (WHERE u.status <> 'Terminated'),0) as payroll
        FROM users u LEFT JOIN roles r ON r.id = u.role_id GROUP BY u.role_id, r.name ORDER BY n DESC`);
      return { dimension, departmentCount: departments.n, branchCount: branches.n, employeeCount: employees.n, byEmploymentStatus: byStatus, byRole };
    }
    case 'drill-department': {
      const rows = await all(
        `SELECT d.id, d.name, COUNT(u.id)::int as employeeCount,
                COUNT(u.id) FILTER (WHERE u.status = 'Active')::int as active, COUNT(u.id) FILTER (WHERE u.status = 'On Leave')::int as onLeave,
                COUNT(u.id) FILTER (WHERE u.status = 'Terminated')::int as terminated,
                COALESCE(SUM(u.basic_salary) FILTER (WHERE u.status <> 'Terminated'),0) as payroll,
                COALESCE(AVG(u.basic_salary) FILTER (WHERE u.status <> 'Terminated'),0) as avgSalary
         FROM departments d LEFT JOIN users u ON u.department_id = d.id GROUP BY d.id, d.name ORDER BY employeeCount DESC`
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
// A monthly figure over the last six months, the change against the
// comparison month (Admin's trend window), the month-end run-rate (this
// month so far ÷ days elapsed × days in month) and the 3-month average of
// the previous complete months.
async function seriesTrend(valueFor) {
  const window = await getTrendWindowMonths();
  const months = [5, 4, 3, 2, 1, 0].map(monthKeyOffset);
  const values = [];
  for (const m of months) values.push(Number(await valueFor(m)) || 0);
  const thisMonth = months[5], thisPeriod = values[5];
  const lastMonth = monthKeyOffset(window);
  const lastPeriod = window <= 5 ? values[5 - window] : (Number(await valueFor(lastMonth)) || 0);
  const change = (a, b) => a !== 0 ? ((b - a) / Math.abs(a) * 100) : (b !== 0 ? 100 : 0);
  const now = new Date();
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const runRate = Math.round(thisPeriod / Math.max(1, now.getDate()) * dim);
  const avg3 = Math.round((values[2] + values[3] + values[4]) / 3);
  return {
    thisPeriod, lastPeriod, changePct: change(lastPeriod, thisPeriod), windowMonths: window, thisMonth, lastMonth,
    history: months.map((m, i) => ({ month: m, value: values[i], changePct: i ? change(values[i - 1], values[i]) : null })),
    runRate, avg3, runRateVsAvg3Pct: avg3 ? change(avg3, runRate) : null, daysElapsed: now.getDate(), daysInMonth: dim,
  };
}
async function trendCompare(sql, scopeParams) {
  return seriesTrend(async mk => (await get(sql, [...scopeParams, `${mk}%`])).v);
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
  const aging = await agingProvision(scope, officerId, 25);
  // Loans and clients behind each PAR line.
  const loans = await loanFacts(scope, officerId);
  const parRows = par.par.map(p => { const ls = loans.filter(l => l.daysOverdue >= p.threshold); return { ...p, loans: ls.length, clients: new Set(ls.map(l => l.client_id)).size, arrears: ls.reduce((s, l) => s + l.arrears, 0) }; });
  return { ...par, par: parRows, qualityRating: q.classify(par30), thresholds: { watch: q.watch, atRisk: q.atRisk, critical: q.critical, default: q.def },
    classes: aging.classes, atRisk: aging.atRisk, totalProvision: aging.totalProvision, provisionCoveragePct: aging.provisionCoveragePct, activeLoans: loans.length };
}
async function computePredictive(featureId, req) {
  const scope = await branchIdsInScope(req.user);
  const loanScope = scopeClause(scope, 'l.branch_id');
  const lo = req.user.role_id === 'loan_officer' ? req.user.id : null; // a Loan Officer sees their own book
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
      return { featureId, kind: 'risk', ...(await riskView(scope, lo)) };
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
      return { featureId, kind: 'risk', ...(await riskView(scope, lo)) };
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
      const g = await groupMetrics('officer', scope, { names: await namesInScope('officer', scope) });
      return { featureId, kind: 'officer-list', officers: g.rows, total: g.total };
    }
    case 'pred-branch-performance-prediction':
    case 'pred-branch-performance': {
      const g = await groupMetrics('branch', scope, { names: await namesInScope('branch', scope) });
      return { featureId, kind: 'branch-list', branches: g.rows, total: g.total };
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
      return { featureId, kind: 'trend', label: 'Net Cashflow', ...(await seriesTrend(net)) };
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
      return { featureId, kind: 'trend', label: 'Net Profit', ...(await seriesTrend(profit)) };
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
    case 'pred-attendance-trends': {
      // From HR › Attendance: attendance rate = (Present + Late + Remote + ½ Half Day) ÷ (days recorded − On Leave).
      const rows = await all(`SELECT substr(date, 1, 7) AS month,
          COUNT(*) FILTER (WHERE status = 'Present')::int AS present, COUNT(*) FILTER (WHERE status = 'Late')::int AS late,
          COUNT(*) FILTER (WHERE status = 'Absent')::int AS absent, COUNT(*) FILTER (WHERE status = 'On Leave')::int AS onleave,
          COUNT(*) FILTER (WHERE status = 'Half Day')::int AS halfday, COUNT(*) FILTER (WHERE status = 'Remote')::int AS remote,
          COALESCE(SUM(minutes_late),0)::int AS minuteslate, COUNT(DISTINCT employee_id)::int AS employees
        FROM hr_attendance WHERE date >= ? GROUP BY 1 ORDER BY 1`, [monthKeyOffset(5) + '-01']);
      const months = [5, 4, 3, 2, 1, 0].map(monthKeyOffset).map(m => {
        const r = rows.find(x => x.month === m) || { present: 0, late: 0, absent: 0, onleave: 0, halfday: 0, remote: 0, minuteslate: 0, employees: 0 };
        const base = r.present + r.late + r.absent + r.halfday + r.remote;
        return { month: m, ...r, ratePct: base ? Math.round((r.present + r.late + r.remote + r.halfday / 2) / base * 1000) / 10 : null, latePct: base ? Math.round(r.late / base * 1000) / 10 : null };
      });
      return { featureId, kind: 'attendance', months, formula: 'Attendance rate = (Present + Late + Remote + ½ Half Day) ÷ (days recorded − On Leave) × 100' };
    }
    case 'pred-turnover-prediction': {
      // Leavers = employees set to Terminated in the month (audit trail); turnover = leavers ÷ average headcount.
      const leavers = await all(`SELECT substr(created_at, 1, 7) AS month, COUNT(DISTINCT record_id)::int AS n FROM audit_logs
        WHERE action = 'Set employment status to Terminated' AND created_at >= ? GROUP BY 1`, [monthKeyOffset(11) + '-01']);
      const hires = await all(`SELECT substr(created_at, 1, 7) AS month, COUNT(*)::int AS n FROM users WHERE created_at >= ? GROUP BY 1`, [monthKeyOffset(11) + '-01']);
      const headNow = (await get(`SELECT COUNT(*)::int AS n FROM users WHERE status <> 'Terminated'`)).n;
      const months = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(monthKeyOffset);
      // Walk back from today's headcount to each month-end.
      const out = []; let head = headNow;
      for (let i = months.length - 1; i >= 0; i--) {
        const m = months[i]; const l = (leavers.find(x => x.month === m) || { n: 0 }).n; const h = (hires.find(x => x.month === m) || { n: 0 }).n;
        const end = head, start = head - h + l; head = start;
        const avg = (start + end) / 2;
        out.unshift({ month: m, hires: h, leavers: l, headcountStart: start, headcountEnd: end, turnoverPct: avg > 0 ? Math.round(l / avg * 1000) / 10 : 0 });
      }
      const last12 = out.reduce((s, r) => s + r.leavers, 0);
      const avgHead = out.reduce((s, r) => s + (r.headcountStart + r.headcountEnd) / 2, 0) / out.length;
      return { featureId, kind: 'turnover', months: out, annualTurnoverPct: avgHead ? Math.round(last12 / avgHead * 1000) / 10 : 0, leavers12: last12, headcount: headNow,
        formula: 'Monthly turnover = leavers in the month ÷ average headcount × 100; annual = leavers in 12 months ÷ average headcount × 100' };
    }
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
  const lo = req.user.role_id === 'loan_officer' ? req.user.id : null;
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
      return { featureId, kind: 'risk', ...(await riskView(scope, lo)) };
    case 'explain-collection-priority-explanation': {
      // Priority score (0–100) = 60 × min(days overdue, 90) ÷ 90 + 40 × arrears ÷ balance.
      const lastPay = new Map((await all(`SELECT p.loan_id, MAX(p.created_at) AS at FROM payments p JOIN loans l ON l.id = p.loan_id WHERE ${loanScope.clause} AND p.status NOT IN ('Unposted','Reversed') GROUP BY p.loan_id`, loanScope.params)).map(r => [r.loan_id, r.at]));
      const items = (await loanFacts(scope, lo)).filter(l => l.daysOverdue > 0).map(l => {
        const score = Math.round(60 * Math.min(l.daysOverdue, 90) / 90 + 40 * (l.outstanding > 0 ? Math.min(1, l.arrears / l.outstanding) : 0));
        return { loanId: l.id, clientname: l.client_name, phone: l.client_phone, officer: l.officer_name, branch: l.branch_name, daysoverdue: l.daysOverdue, missed: l.missed,
          arrears: l.arrears, outstanding: l.outstanding, lastPayment: lastPay.get(l.id) || null, classLabel: l.classLabel, score,
          reason: `${l.daysOverdue} day${l.daysOverdue === 1 ? '' : 's'} overdue · ${l.missed} missed installment${l.missed === 1 ? '' : 's'} · ${Math.round(l.outstanding ? l.arrears / l.outstanding * 100 : 0)}% of the balance in arrears` };
      }).sort((a, b) => b.score - a.score || b.arrears - a.arrears).slice(0, 50);
      return { featureId, kind: 'priority-list', items, formula: 'Priority score (0–100) = 60 × min(days overdue, 90) ÷ 90 + 40 × arrears ÷ outstanding balance' };
    }
    case 'explain-branch-performance': {
      const g = await groupMetrics('branch', scope, { names: await namesInScope('branch', scope) });
      return { featureId, kind: 'branch-explain', branches: g.rows, total: g.total };
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
      const g = await groupMetrics('officer', scope, { names: await namesInScope('officer', scope) });
      return { featureId, kind: 'officer-list', officers: g.rows, total: g.total };
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

// ---- Fraud & Risk Detection --------------------------------------------
// Real, rule-based signals against existing data — no trained fraud
// model, no invented scoring. Every signal is a plain, explainable SQL
// condition over real rows (duplicate national_id, a Reversed payment
// status, written_off_at close to disbursed_at, a per-officer approval
// aggregate, a real salary_advance_requests count). One feature id per
// concept, shared across every role that holds it — the compute function
// itself scopes by the caller's real branchIdsInScope/role_id, same
// pattern as every other Intelligence category.
async function getFraudSettings() {
  const rows = await all(
    "SELECT key, value FROM intelligence_settings WHERE key IN ('fraud_rapid_writeoff_days','fraud_advance_request_count_threshold','fraud_advance_request_window_days')"
  );
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const n = (key, def) => { const v = parseInt(byKey[key], 10); return Number.isFinite(v) && v > 0 ? v : def; };
  return {
    rapidWriteoffDays: n('fraud_rapid_writeoff_days', 14),
    advanceRequestCountThreshold: n('fraud_advance_request_count_threshold', 3),
    advanceRequestWindowDays: n('fraud_advance_request_window_days', 30),
  };
}
async function computeFraud(featureId, req) {
  const scope = await branchIdsInScope(req.user);
  const settings = await getFraudSettings();
  switch (featureId) {
    // Company-wide duplicate-identity check (a duplicate can legitimately
    // span two different branches, which is exactly the pattern worth
    // flagging) — then filtered down to only the groups that include at
    // least one client within the caller's own real scope, so a Loan
    // Officer sees only groups touching their own clients, a Manager only
    // ones touching their branch, etc., while still showing the full
    // cross-branch group for context.
    case 'fraud-duplicate-clients': {
      const dupes = await all(
        `SELECT c.national_id, array_agg(c.id) as ids, array_agg(c.name) as names, array_agg(c.branch_id) as branch_ids, array_agg(c.officer_id) as officer_ids,
                array_agg(COALESCE(c.phone,'')) as phones, array_agg(COALESCE(u.name,'')) as officer_names, array_agg(c.created_at) as created, array_agg(c.status) as statuses,
                array_agg((SELECT COUNT(*) FROM loans l WHERE l.client_id = c.id)) as loan_counts
         FROM clients c LEFT JOIN users u ON u.id = c.officer_id WHERE c.national_id IS NOT NULL AND c.national_id != ''
         GROUP BY c.national_id HAVING COUNT(*) > 1`
      );
      const officerId = req.user.role_id === 'loan_officer' ? req.user.id : null;
      const groups = dupes
        .map(d => ({
          nationalId: d.national_id,
          clients: d.ids.map((id, i) => ({ id, name: d.names[i], branchId: d.branch_ids[i], officerId: d.officer_ids[i], phone: d.phones[i], officer: d.officer_names[i], createdAt: d.created[i], status: d.statuses[i], loans: Number(d.loan_counts[i]) })),
        }))
        .filter(g => g.clients.some(c =>
          (officerId ? c.officerId === officerId : true) &&
          (scope === null ? true : scope.includes(c.branchId))
        ));
      return { featureId, kind: 'duplicate-list', groups };
    }
    case 'fraud-payment-reversals': {
      const loanScope = scopeClause(scope, 'l.branch_id');
      const rows = await all(
        `SELECT p.id, p.amount, p.created_at, p.channel, p.reference, c.name as clientname, u.name as officername, b.name as branchname, rb.name as recordedby
         FROM payments p JOIN loans l ON l.id = p.loan_id JOIN clients c ON c.id = p.client_id
         LEFT JOIN users u ON u.id = l.officer_id LEFT JOIN branches b ON b.id = l.branch_id LEFT JOIN users rb ON rb.id = p.recorded_by
         WHERE p.status = 'Reversed' AND ${loanScope.clause} ORDER BY p.created_at DESC LIMIT 30`,
        loanScope.params
      );
      return { featureId, kind: 'reversal-list', items: rows };
    }
    case 'fraud-rapid-writeoff': {
      const loanScope = scopeClause(scope, 'l.branch_id');
      const rows = await all(
        `SELECT l.id, l.principal, l.disbursed_at, l.written_off_at, c.name as clientname, u.name as officername, b.name as branchname,
                (written_off_at::date - disbursed_at::date) as daystowriteoff,
                COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.loan_id = l.id AND p.status NOT IN ('Unposted','Reversed')),0) as repaid
         FROM loans l JOIN clients c ON c.id = l.client_id LEFT JOIN users u ON u.id = l.officer_id LEFT JOIN branches b ON b.id = l.branch_id
         WHERE l.status = 'Written Off' AND l.disbursed_at IS NOT NULL AND l.written_off_at IS NOT NULL
           AND (written_off_at::date - disbursed_at::date) <= ? AND ${loanScope.clause}
         ORDER BY daystowriteoff ASC LIMIT 30`,
        [settings.rapidWriteoffDays, ...loanScope.params]
      );
      return { featureId, kind: 'writeoff-list', items: rows, dayWindow: settings.rapidWriteoffDays };
    }
    case 'fraud-overpayment-pattern': {
      const officerId = req.user.role_id === 'loan_officer' ? req.user.id : null;
      const loanScope = scopeClause(scope, 'l.branch_id');
      const rows = await all(
        `SELECT c.id as clientid, c.name as clientname, c.phone, MAX(u.name) as officername, MAX(b.name) as branchname,
                COUNT(*)::int as overpaymentcount, COALESCE(SUM(p.amount),0) as totalamount, COALESCE(AVG(p.amount),0) as avgamount, MAX(p.created_at) as lastat
         FROM payments p JOIN loans l ON l.id = p.loan_id JOIN clients c ON c.id = p.client_id
         LEFT JOIN users u ON u.id = l.officer_id LEFT JOIN branches b ON b.id = l.branch_id
         WHERE p.status = 'Overpayment' AND ${loanScope.clause} ${officerId ? 'AND l.officer_id = ?' : ''}
         GROUP BY c.id, c.name, c.phone ORDER BY overpaymentcount DESC LIMIT 25`,
        officerId ? [...loanScope.params, officerId] : loanScope.params
      );
      return { featureId, kind: 'overpayment-list', items: rows };
    }
    case 'fraud-officer-approval-pattern': {
      const userScope = scopeClause(scope, 'u.branch_id');
      const rows = await all(
        `SELECT u.id, u.name, MAX(b.name) as branchname, MAX(COALESCE(r.name, u.role_id)) as rolename,
                COUNT(la.id)::int as totaldecisions,
                SUM(CASE WHEN la.decision = 'Approved' THEN 1 ELSE 0 END)::int as approvedcount,
                SUM(CASE WHEN la.created_at::date = l.created_at::date THEN 1 ELSE 0 END)::int as samedayapprovals,
                COALESCE(SUM(CASE WHEN la.decision = 'Approved' THEN l.principal ELSE 0 END),0) as approvedprincipal
         FROM users u JOIN loan_approvals la ON la.approver_id = u.id JOIN loans l ON l.id = la.loan_id
         LEFT JOIN branches b ON b.id = u.branch_id LEFT JOIN roles r ON r.id = u.role_id
         WHERE ${userScope.clause} GROUP BY u.id, u.name HAVING COUNT(la.id) >= 3 ORDER BY approvedcount DESC LIMIT 25`,
        userScope.params
      );
      return { featureId, kind: 'officer-anomaly-list', items: rows.map(r => ({ ...r, approvalratepct: r.totaldecisions ? Math.round(r.approvedcount / r.totaldecisions * 1000) / 10 : 0, samedaypct: r.totaldecisions ? Math.round(r.samedayapprovals / r.totaldecisions * 1000) / 10 : 0 })) };
    }
    case 'fraud-overview': {
      const loanScope = scopeClause(scope, 'l.branch_id');
      const reversals = await get(`SELECT COUNT(*)::int as n, COALESCE(SUM(p.amount),0) as amt FROM payments p JOIN loans l ON l.id = p.loan_id WHERE p.status = 'Reversed' AND ${loanScope.clause}`, loanScope.params);
      const writeoffs = await get(
        `SELECT COUNT(*)::int as n, COALESCE(SUM(l.principal),0) as amt FROM loans l WHERE l.status = 'Written Off' AND l.disbursed_at IS NOT NULL AND l.written_off_at IS NOT NULL
           AND (written_off_at::date - disbursed_at::date) <= ? AND ${loanScope.clause}`,
        [settings.rapidWriteoffDays, ...loanScope.params]
      );
      const overpay = await get(`SELECT COUNT(*)::int as n, COALESCE(SUM(p.amount),0) as amt FROM payments p JOIN loans l ON l.id = p.loan_id WHERE p.status = 'Overpayment' AND ${loanScope.clause}`, loanScope.params);
      const dupeRows = await all(`SELECT national_id FROM clients WHERE national_id IS NOT NULL AND national_id != '' GROUP BY national_id HAVING COUNT(*) > 1`);
      const cs = scopeClause(scope, 'branch_id');
      const dupeInScope = await get(`SELECT COUNT(*)::int as n FROM clients WHERE ${cs.clause} AND national_id IN (SELECT national_id FROM clients WHERE national_id IS NOT NULL AND national_id != '' GROUP BY national_id HAVING COUNT(*) > 1)`, cs.params);
      const recent = await get(`SELECT COUNT(*)::int as n FROM payments p JOIN loans l ON l.id = p.loan_id WHERE p.status = 'Reversed' AND ${loanScope.clause} AND p.created_at >= (CURRENT_DATE - INTERVAL '30 days')::text`, loanScope.params);
      return {
        featureId, kind: 'overview',
        signals: [
          { label: 'Reversed Payments', count: reversals.n, amount: Number(reversals.amt), last30: recent.n },
          { label: 'Rapid Write-Offs', count: writeoffs.n, amount: Number(writeoffs.amt), note: `within ${settings.rapidWriteoffDays} days of disbursement` },
          { label: 'Overpayments', count: overpay.n, amount: Number(overpay.amt) },
          { label: 'Clients sharing an ID (your scope)', count: dupeInScope.n },
          { label: 'Duplicate Client Identities (company-wide)', count: dupeRows.length },
        ],
      };
    }
    case 'fraud-branch-risk-ranking': {
      // Risk score = 3 × rapid write-offs + 2 × reversals + duplicate identities + PAR-30 % ÷ 5.
      const bs = scopeClause(scope, 'b.id');
      const rows = await all(
        `SELECT b.id, b.name,
                (SELECT COUNT(*) FROM payments p JOIN loans l2 ON l2.id = p.loan_id WHERE p.status='Reversed' AND l2.branch_id = b.id)::int as reversalcount,
                (SELECT COUNT(*) FROM loans l3 WHERE l3.branch_id = b.id AND l3.status='Written Off' AND l3.disbursed_at IS NOT NULL AND l3.written_off_at IS NOT NULL AND (l3.written_off_at::date - l3.disbursed_at::date) <= ?)::int as writeoffcount,
                (SELECT COUNT(*) FROM clients c WHERE c.branch_id = b.id AND c.national_id IN (SELECT national_id FROM clients WHERE national_id IS NOT NULL AND national_id != '' GROUP BY national_id HAVING COUNT(*) > 1))::int as duplicatecount
         FROM branches b WHERE ${bs.clause}`,
        [settings.rapidWriteoffDays, ...bs.params]
      );
      const g = await groupMetrics('branch', scope, { names: await namesInScope('branch', scope) });
      const out = rows.map(r => { const m = g.rows.find(x => x.id === r.id) || { par30Pct: 0, outstanding: 0 };
        return { ...r, par30pct: m.par30Pct, outstanding: m.outstanding, riskscore: Math.round((3 * r.writeoffcount + 2 * r.reversalcount + r.duplicatecount + m.par30Pct / 5) * 10) / 10 }; })
        .sort((a, b) => b.riskscore - a.riskscore);
      return { featureId, kind: 'branch-risk-list', branches: out, formula: 'Risk score = 3 × rapid write-offs + 2 × reversed payments + duplicate-identity clients + PAR-30 % ÷ 5' };
    }
    case 'fraud-staff-advance-pattern': {
      const rows = await all(
        `SELECT u.id, u.name, MAX(b.name) as branchname, MAX(COALESCE(r.name, u.role_id)) as rolename, MAX(u.basic_salary) as salary,
                COUNT(s.id)::int as requestcount, COALESCE(SUM(s.amount),0) as totalamount, MAX(s.created_at) as lastat,
                SUM(CASE WHEN s.status IN ('Approved','Paid','Disbursed') THEN 1 ELSE 0 END)::int as approvedcount
         FROM users u JOIN salary_advance_requests s ON s.user_id = u.id
         LEFT JOIN branches b ON b.id = u.branch_id LEFT JOIN roles r ON r.id = u.role_id
         WHERE s.created_at >= (CURRENT_DATE - (? || ' days')::interval)::text
         GROUP BY u.id, u.name HAVING COUNT(s.id) >= ? ORDER BY requestcount DESC LIMIT 25`,
        [settings.advanceRequestWindowDays, settings.advanceRequestCountThreshold]
      );
      return { featureId, kind: 'advance-pattern-list', items: rows, windowDays: settings.advanceRequestWindowDays, countThreshold: settings.advanceRequestCountThreshold };
    }
    default:
      return null;
  }
}

// ---- What-If Simulation -------------------------------------------------
// Real arithmetic projections on real CURRENT data — never a forecast
// model, never invented future data. Every scenario starts from a real
// baseline (today's actual collection rate, actual PAR, actual revenue,
// ...), applies the caller's own delta, and reports both numbers side by
// side with an honest, literal formula string. Two deltas semantics,
// stated per metric: "percentage points" (rates already expressed as a
// %, e.g. collection rate, PAR, capital utilization) or "percentage
// change" (amounts, e.g. disbursement volume, revenue, payroll) — a rate
// cannot sensibly be scaled multiplicatively the same way an amount can.
async function getWhatIfSettings() {
  const rows = await all("SELECT key, value FROM intelligence_settings WHERE key IN ('whatif_delta_min','whatif_delta_max')");
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const n = (key, def) => { const v = parseFloat(byKey[key]); return Number.isFinite(v) ? v : def; };
  return { deltaMin: n('whatif_delta_min', -50), deltaMax: n('whatif_delta_max', 50) };
}
function clampDelta(deltaRaw, bounds) {
  const d = parseFloat(deltaRaw);
  if (!Number.isFinite(d)) return 0;
  return Math.max(bounds.deltaMin, Math.min(bounds.deltaMax, d));
}
async function computeWhatIf(featureId, req, deltaRaw) {
  const scope = await branchIdsInScope(req.user);
  const bounds = await getWhatIfSettings();
  const delta = clampDelta(deltaRaw, bounds);
  const loanScope = scopeClause(scope, 'l.branch_id');
  const officerId = req.user.role_id === 'loan_officer' ? req.user.id : null;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  switch (featureId) {
    case 'whatif-business-quality': {
      const { businessQualityFor, FORMULAS } = require('./../businessQuality');
      return { featureId, kind: 'business-quality', formulas: FORMULAS, ...(await businessQualityFor(req.user, { month: req.query.month })) };
    }
    case 'whatif-collection-rate': {
      const loanIds = (await all(
        `SELECT l.id FROM loans l WHERE ${loanScope.clause} ${officerId ? 'AND l.officer_id = ?' : ''}`,
        officerId ? [...loanScope.params, officerId] : loanScope.params
      )).map(r => r.id);
      const { expected, collected } = await collectionTotals(loanIds, monthStart, today);
      const baselineRate = expected > 0 ? (collected / expected * 100) : 0;
      const projectedRate = Math.max(0, baselineRate + delta);
      const projectedCollected = expected * (projectedRate / 100);
      return {
        featureId, kind: 'projection', delta, deltaBounds: bounds,
        formula: 'Collection Rate: delta is added as percentage points to the real current month-to-date rate. Projected Collections = month-to-date expected amount × the projected rate.',
        metrics: [
          { label: 'Collection Rate', baseline: baselineRate, projected: projectedRate, unit: '%' },
          { label: 'Projected Collections (MTD)', baseline: collected, projected: projectedCollected, unit: 'currency' },
        ],
      };
    }
    case 'whatif-disbursement-volume': {
      const row = await get(
        `SELECT COALESCE(SUM(l.principal),0) as v FROM loans l WHERE ${loanScope.clause} AND l.disbursed_at LIKE ?`,
        [...loanScope.params, `${monthKeyOffset(0)}%`]
      );
      const projected = row.v * (1 + delta / 100);
      return {
        featureId, kind: 'projection', delta, deltaBounds: bounds,
        formula: 'Disbursement Volume: delta is applied as a percentage change to the real current month-to-date disbursed principal.',
        metrics: [{ label: 'Disbursement Volume (MTD)', baseline: row.v, projected, unit: 'currency' }],
      };
    }
    case 'whatif-portfolio-growth': {
      const row = await get(
        `SELECT COALESCE(SUM(ls.total_due - ls.paid_amount),0) as outstanding FROM loan_schedule ls JOIN loans l ON l.id = ls.loan_id WHERE ${loanScope.clause} AND l.status IN ('Active','Disbursed')`,
        loanScope.params
      );
      const baseline = Math.max(0, row.outstanding);
      const projected = baseline * (1 + delta / 100);
      return {
        featureId, kind: 'projection', delta, deltaBounds: bounds,
        formula: 'Portfolio Growth: delta is applied as a percentage change to the real current outstanding loan balance in your region.',
        metrics: [{ label: 'Portfolio Outstanding', baseline, projected, unit: 'currency' }],
      };
    }
    case 'whatif-par-change': {
      const risk = await riskView(scope);
      const par30 = risk.par.find(p => p.threshold === 30) || { percentage: 0 };
      const projectedPct = Math.max(0, Math.min(100, par30.percentage + delta));
      return {
        featureId, kind: 'projection', delta, deltaBounds: bounds,
        formula: `PAR Change: delta is added as percentage points to the real current PAR-30 (${risk.formula}). Provision for bad debts is not modeled here — see the real, editable tiered-rate provision on the Accountant dashboard.`,
        metrics: [{ label: 'PAR-30', baseline: par30.percentage, projected: projectedPct, unit: '%' }],
      };
    }
    case 'whatif-expense-change': {
      const row = await get(`SELECT COALESCE(SUM(amount),0) as v FROM expenses WHERE created_at LIKE ?`, [`${monthKeyOffset(0)}%`]);
      const revenueRow = await get(
        `SELECT COALESCE(SUM(je.credit),0) as v FROM journal_entries je JOIN payments p ON p.id = je.ref_id AND je.ref_type='payment' JOIN loans l ON l.id = p.loan_id WHERE ${loanScope.clause} AND je.entry_date LIKE ?`,
        [...loanScope.params, `${monthKeyOffset(0)}%`]
      );
      const projectedExpenses = row.v * (1 + delta / 100);
      const baselineProfit = revenueRow.v - row.v;
      const projectedProfit = revenueRow.v - projectedExpenses;
      return {
        featureId, kind: 'projection', delta, deltaBounds: bounds,
        formula: 'Expense Change: delta is applied as a percentage change to the real current month-to-date expenses. Net Profit = real revenue (held constant) − expenses.',
        metrics: [
          { label: 'Expenses (MTD)', baseline: row.v, projected: projectedExpenses, unit: 'currency' },
          { label: 'Net Profit (MTD)', baseline: baselineProfit, projected: projectedProfit, unit: 'currency' },
        ],
      };
    }
    case 'whatif-revenue-growth': {
      const revenueRow = await get(
        `SELECT COALESCE(SUM(je.credit),0) as v FROM journal_entries je JOIN payments p ON p.id = je.ref_id AND je.ref_type='payment' JOIN loans l ON l.id = p.loan_id WHERE ${loanScope.clause} AND je.entry_date LIKE ?`,
        [...loanScope.params, `${monthKeyOffset(0)}%`]
      );
      const expensesRow = await get(`SELECT COALESCE(SUM(amount),0) as v FROM expenses WHERE created_at LIKE ?`, [`${monthKeyOffset(0)}%`]);
      const projectedRevenue = revenueRow.v * (1 + delta / 100);
      const baselineProfit = revenueRow.v - expensesRow.v;
      const projectedProfit = projectedRevenue - expensesRow.v;
      return {
        featureId, kind: 'projection', delta, deltaBounds: bounds,
        formula: 'Revenue Growth: delta is applied as a percentage change to the real current month-to-date revenue. Net Profit = projected revenue − real expenses (held constant).',
        metrics: [
          { label: 'Revenue (MTD)', baseline: revenueRow.v, projected: projectedRevenue, unit: 'currency' },
          { label: 'Net Profit (MTD)', baseline: baselineProfit, projected: projectedProfit, unit: 'currency' },
        ],
      };
    }
    case 'whatif-capital-utilization': {
      // Share capital has no real backing table in this system yet (the
      // Director dashboard's own "Ownership & Equity" card is explicitly
      // browser-session-only, not database-backed) — so this uses only
      // the real, persisted investor capital, not a fabricated combined
      // "total capital employed" figure.
      const outstandingRow = await get(
        `SELECT COALESCE(SUM(ls.total_due - ls.paid_amount),0) as outstanding FROM loan_schedule ls JOIN loans l ON l.id = ls.loan_id WHERE l.status IN ('Active','Disbursed')`
      );
      const investorCapitalRow = await get(`SELECT COALESCE(SUM(amount),0) as v FROM investors WHERE status = 'Active'`);
      const totalInvestorCapital = investorCapitalRow.v;
      const baselineDeployed = Math.max(0, outstandingRow.outstanding);
      const projectedDeployed = baselineDeployed * (1 + delta / 100);
      const baselineUtilization = totalInvestorCapital > 0 ? (baselineDeployed / totalInvestorCapital * 100) : 0;
      const projectedUtilization = totalInvestorCapital > 0 ? (projectedDeployed / totalInvestorCapital * 100) : 0;
      return {
        featureId, kind: 'projection', delta, deltaBounds: bounds,
        formula: 'Investor Capital Utilization: delta is applied as a percentage change to the real current capital deployed (outstanding loan book). Utilization = capital deployed ÷ real active investor capital (share capital has no database-backed figure yet, so it is not included).',
        metrics: [
          { label: 'Capital Deployed', baseline: baselineDeployed, projected: projectedDeployed, unit: 'currency' },
          { label: 'Investor Capital Utilization', baseline: baselineUtilization, projected: projectedUtilization, unit: '%' },
        ],
      };
    }
    case 'whatif-headcount-change': {
      const row = await get(`SELECT COUNT(*) as n, COALESCE(SUM(basic_salary),0) as payroll FROM users WHERE status = 'Active'`);
      const projectedHeadcount = Math.round(row.n * (1 + delta / 100));
      const projectedPayroll = row.payroll * (1 + delta / 100);
      return {
        featureId, kind: 'projection', delta, deltaBounds: bounds,
        formula: 'Headcount & Payroll: delta is applied as a percentage change to the real current active headcount and the real current total monthly basic_salary payroll (scaled proportionally).',
        metrics: [
          { label: 'Headcount', baseline: row.n, projected: projectedHeadcount, unit: 'count' },
          { label: 'Monthly Payroll Cost', baseline: row.payroll, projected: projectedPayroll, unit: 'currency' },
        ],
      };
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

  // Fraud & Risk Detection — same inline-check pattern.
  router.get('/api/intelligence/fraud/:kind', requireAuth, async (req, res, next) => {
    if (!(await hasIntelligenceAccess(req.user, req.params.kind))) {
      return next({ status: 403, message: `You do not have access to the "${req.params.kind}" Intelligence feature` });
    }
    const result = await computeFraud(req.params.kind, req);
    if (!result) return next({ status: 404, message: `No fraud/risk data available for "${req.params.kind}"` });
    res.json(result);
  });

  // Admin > Intelligence > Fraud & Risk Detection > "Fraud Detection
  // Rules" — a real, honest account of what each signal actually checks
  // (no invented fraud-scoring model).
  router.get('/api/intelligence/fraud-detection-rules', requireAuth, requirePermission('manage_users'), requireAdminOnly('view Fraud Detection Rules'), async (req, res) => {
    res.json({
      rules: [
        { kind: 'duplicate-list', source: 'Real clients.national_id values shared by more than one client record, company-wide — a plain SQL GROUP BY, not an identity-matching model.' },
        { kind: 'reversal-list', source: 'Real payments with status = Reversed, the same status the Accountant\'s own Reconciliation Center already reads.' },
        { kind: 'writeoff-list', source: 'Real loans.written_off_at minus loans.disbursed_at, flagged when under the configurable Rapid Write-Off window (see Fraud Thresholds).' },
        { kind: 'overpayment-list', source: 'Real payments with status = Overpayment, grouped by client.' },
        { kind: 'officer-anomaly-list', source: 'A real per-officer aggregate of loan_approvals (total decisions, approved count, same-day approvals) — a plain tally, not a predictive risk score.' },
        { kind: 'overview / branch-risk-list', source: 'Real counts of the signals above, aggregated company-wide or per branch.' },
        { kind: 'advance-pattern-list', source: 'A real count of salary_advance_requests per staff member within the configurable rolling window, flagged once it meets the configurable count threshold (see Fraud Thresholds).' },
      ],
    });
  });
  // Admin > Intelligence > Fraud & Risk Detection > "Fraud Thresholds" —
  // the real, persisted, editable parameters computeFraud() above reads.
  router.get('/api/intelligence/fraud-thresholds', requireAuth, requirePermission('manage_users'), requireAdminOnly('view Fraud Thresholds'), async (req, res) => {
    res.json(await getFraudSettings());
  });
  router.put('/api/intelligence/fraud-thresholds', requireAuth, requirePermission('manage_users'), requireAdminOnly('edit Fraud Thresholds'), async (req, res, next) => {
    const fields = {
      fraud_rapid_writeoff_days: req.body.rapidWriteoffDays,
      fraud_advance_request_count_threshold: req.body.advanceRequestCountThreshold,
      fraud_advance_request_window_days: req.body.advanceRequestWindowDays,
    };
    for (const [key, value] of Object.entries(fields)) {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1 || n > 365) return next({ status: 400, message: `${key} must be an integer between 1 and 365` });
    }
    for (const [key, value] of Object.entries(fields)) {
      await run(
        `INSERT INTO intelligence_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, iso_now())
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [key, String(parseInt(value, 10)), req.user.id]
      );
    }
    await logAction(req, { action: 'Changed Fraud thresholds', module: 'intelligence', recordType: 'IntelligenceSetting', recordId: 'fraud-thresholds', newValue: fields });
    res.json(await getFraudSettings());
  });

  // What-If Simulation — same inline-check pattern. delta comes from the
  // query string (a real user input, not a stored scenario) and is
  // always clamped server-side to the real, Admin-editable bounds below.
  router.get('/api/intelligence/whatif/:kind', requireAuth, async (req, res, next) => {
    if (!(await hasIntelligenceAccess(req.user, req.params.kind))) {
      return next({ status: 403, message: `You do not have access to the "${req.params.kind}" Intelligence feature` });
    }
    const result = await computeWhatIf(req.params.kind, req, req.query.delta);
    if (!result) return next({ status: 404, message: `No simulation available for "${req.params.kind}"` });
    res.json(result);
  });

  // Admin > Intelligence > What-If Simulation > "Simulation Models" — a
  // real, honest account of every scenario's actual formula (no invented
  // forecasting engine).
  router.get('/api/intelligence/whatif-simulation-models', requireAuth, requirePermission('manage_users'), requireAdminOnly('view Simulation Models'), async (req, res) => {
    res.json({
      models: [
        { kind: 'whatif-business-quality', formula: 'Arrears Collection % = (Arrears Collected ÷ Current Arrears) × 100; Disbursement Counts % = (Disbursement Counts ÷ Target) × 100; Portfolio Quality (BQ) % = (Performing Loans ÷ Active Clients) × 100 — real figures for the caller\'s scope this month; the page lets the user try different numbers.' },
        { kind: 'whatif-collection-rate', formula: 'Real month-to-date expected/collected amounts (the same collectionTotals() Collection Rate/MTD pages use); delta is added in percentage points.' },
        { kind: 'whatif-disbursement-volume', formula: 'Real month-to-date disbursed principal; delta is a percentage change.' },
        { kind: 'whatif-portfolio-growth', formula: 'Real current outstanding loan balance in scope; delta is a percentage change.' },
        { kind: 'whatif-par-change', formula: 'Real current PAR-30 (the same computePAR() every other Intelligence category and Reports/LoanBook use); delta is added in percentage points. Provision for bad debts is not modeled.' },
        { kind: 'whatif-expense-change', formula: 'Real month-to-date expenses and revenue; delta applies to expenses only (percentage change), revenue held constant.' },
        { kind: 'whatif-revenue-growth', formula: 'Real month-to-date revenue and expenses; delta applies to revenue only (percentage change), expenses held constant.' },
        { kind: 'whatif-capital-utilization', formula: 'Real outstanding loan book ÷ real active investor capital; delta applies to the loan book (percentage change).' },
        { kind: 'whatif-headcount-change', formula: 'Real active headcount and real total basic_salary payroll; delta applies to both proportionally (percentage change).' },
      ],
    });
  });
  // Admin > Intelligence > What-If Simulation > "Simulation Bounds" — the
  // real, persisted, editable min/max delta every scenario above clamps
  // to, so a user can never request a nonsensical simulated change.
  router.get('/api/intelligence/whatif-simulation-bounds', requireAuth, requirePermission('manage_users'), requireAdminOnly('view Simulation Bounds'), async (req, res) => {
    res.json(await getWhatIfSettings());
  });
  router.put('/api/intelligence/whatif-simulation-bounds', requireAuth, requirePermission('manage_users'), requireAdminOnly('edit Simulation Bounds'), async (req, res, next) => {
    const min = parseFloat(req.body.deltaMin);
    const max = parseFloat(req.body.deltaMax);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max || min < -1000 || max > 1000) {
      return next({ status: 400, message: 'deltaMin must be less than deltaMax, both within [-1000, 1000]' });
    }
    await run(
      `INSERT INTO intelligence_settings (key, value, updated_by, updated_at) VALUES ('whatif_delta_min', ?, ?, iso_now())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [String(min), req.user.id]
    );
    await run(
      `INSERT INTO intelligence_settings (key, value, updated_by, updated_at) VALUES ('whatif_delta_max', ?, ?, iso_now())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [String(max), req.user.id]
    );
    await logAction(req, { action: 'Changed What-If simulation bounds', module: 'intelligence', recordType: 'IntelligenceSetting', recordId: 'whatif-simulation-bounds', newValue: { min, max } });
    res.json(await getWhatIfSettings());
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
    { key: 'businessQuality', label: 'Business Quality (Performance KPIs)' },
    { key: 'mapWeather', label: 'Map, Weather & Live Location' },
    { key: 'pie:Client Loans Analysis', label: 'Client Loans Analysis (chart)' },
    { key: "pie:My Clients' Loan Cycles", label: "My Clients' Loan Cycles (chart)" },
    { key: 'pie:My Loan Products Distribution', label: 'My Loan Products Distribution (chart)' },
    { key: 'pie:OLB Distribution — All Officers', label: 'OLB Distribution — All Officers (chart)' },
    { key: 'staffPerformanceTable', label: 'Staff Performance Table' },
    { key: 'performanceIndicatorsTable', label: 'Performance Indicators Table' },
  ],
  manager: [
    { key: 'businessQuality', label: 'Business Quality (Performance KPIs)' },
    { key: 'mapWeather', label: 'Map, Weather & Live Location' },
    { key: 'teamCollectionPerformance', label: "Team Collection Performance" },
    { key: 'pie:Client Loans Analysis', label: 'Client Loans Analysis (chart)' },
    { key: "pie:Branch Clients' Loan Cycles", label: "Branch Clients' Loan Cycles (chart)" },
    { key: 'pie:Branch Loan Products Distribution', label: 'Branch Loan Products Distribution (chart)' },
    { key: 'pie:OLB Distribution — Branch Officers', label: 'OLB Distribution — Branch Officers (chart)' },
    { key: 'staffPerformanceTable', label: 'Staff Performance Table' },
    { key: 'performanceIndicatorsTable', label: 'Performance Indicators Table' },
  ],
  regional_manager: [
    { key: 'businessQuality', label: 'Business Quality (Performance KPIs)' },
    { key: 'mapWeather', label: 'Map, Weather & Live Location' },
    { key: 'branchComparison', label: 'Regional Branch Comparison' },
    { key: 'branchPerformanceBars', label: 'Branch Performance Bars' },
    { key: 'pie:Client Loans Analysis', label: 'Client Loans Analysis (chart)' },
    { key: 'pie:Loan Products Distribution', label: 'Loan Products Distribution (chart)' },
    { key: 'staffPerformanceTable', label: 'Staff Performance Table' },
    { key: 'performanceIndicatorsTable', label: 'Performance Indicators Table' },
  ],
  operational_manager: [
    { key: 'businessQuality', label: 'Business Quality (Performance KPIs)' },
    { key: 'mapWeather', label: 'Map, Weather & Live Location' },
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
    { key: 'businessQuality', label: 'Business Quality (Performance KPIs)' },
    { key: 'mapWeather', label: 'Map, Weather & Live Location' },
    { key: 'postedUnpostedCollections', label: 'Posted/Unposted Collections' },
  ],
  ceo: [
    { key: 'businessQuality', label: 'Business Quality (Performance KPIs)' },
    { key: 'mapWeather', label: 'Map, Weather & Live Location' },
    { key: 'ceo-branch-leaderboard', label: 'Branch Leaderboard' },
    { key: 'ceo-top-officers', label: 'Top Performing Officers' },
    { key: 'ceo-portfolio-quality', label: 'Portfolio Quality' },
    { key: 'ceo-liquidity', label: 'Liquidity' },
    { key: 'branchPerformanceBars', label: 'Branch Performance Bars' },
    { key: 'staffPerformanceTable', label: 'Staff Performance Table' },
    { key: 'performanceIndicatorsTable', label: 'Performance Indicators Table' },
  ],
  director: [
    { key: 'businessQuality', label: 'Business Quality (Performance KPIs)' },
    { key: 'mapWeather', label: 'Map, Weather & Live Location' },
    { key: 'portfolioRisk', label: 'Portfolio Risk' },
    { key: 'branchPerformanceBars', label: 'Branch Performance Bars' },
    { key: 'staffPerformanceTable', label: 'Staff Performance Table' },
    { key: 'performanceIndicatorsTable', label: 'Performance Indicators Table' },
  ],
  hr: [
    { key: 'businessQuality', label: 'Business Quality (Performance KPIs)' },
    { key: 'mapWeather', label: 'Map, Weather & Live Location' },
  ],
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

  // Admin > Intelligence > Drill-Down Analytics > "Analytics
  // Configuration" — a real, read-only account of every Drill-Down
  // dimension and which real roles currently hold it (role_intelligence_
  // access), never a second, invented settings surface.
  router.get('/api/intelligence/analytics-configuration', requireAuth, requirePermission('manage_users'), requireAdminOnly('view Analytics Configuration'), async (req, res) => {
    const features = await all("SELECT id, label FROM intelligence_features WHERE category_id = 'drilldown-analytics' ORDER BY sort_order");
    const grants = await all(
      `SELECT ria.feature_id, ria.role_id FROM role_intelligence_access ria
       JOIN intelligence_features f ON f.id = ria.feature_id WHERE f.category_id = 'drilldown-analytics'`
    );
    const rolesByFeature = new Map();
    grants.forEach(g => {
      if (!rolesByFeature.has(g.feature_id)) rolesByFeature.set(g.feature_id, []);
      rolesByFeature.get(g.feature_id).push(g.role_id);
    });
    res.json({ dimensions: features.map(f => ({ id: f.id, label: f.label, roles: rolesByFeature.get(f.id) || [] })) });
  });

  // Admin > Intelligence > Drill-Down Analytics > "KPI Configuration" — the
  // real, fixed PAR aging buckets every risk/drill-down view (computePAR)
  // uses — honestly reported as not yet editable, not hidden behind a
  // fake settings form.
  router.get('/api/intelligence/kpi-configuration', requireAuth, requirePermission('manage_users'), requireAdminOnly('view KPI Configuration'), async (req, res) => {
    res.json({
      parBuckets: [1, 7, 30, 60, 90],
      note: 'These are the real, fixed days-overdue buckets every PAR/aging computation in Drill-Down Analytics, Predictive Analytics and Reports/LoanBook shares (computePAR) — not yet editable from here; the portfolio-quality rating thresholds applied on top of these buckets are editable under Predictive Analytics > Thresholds.',
    });
  });
}

module.exports = { register };
