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
const { computePAR } = require('./accounting');
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
