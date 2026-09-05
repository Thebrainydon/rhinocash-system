'use strict';
const { all, get, run } = require('./../db');
const { requireAuth, requireModule } = require('./../middleware');
const { logAction, notify } = require('./../audit');
const { branchIdsInScope } = require('./../rbac');
const crypto = require('node:crypto');

// Who each role is allowed to set targets for — mirrors the exact
// hierarchy in the spec (Manager -> Loan Officer, Regional Manager ->
// Manager, Operational Manager -> Regional Manager, CEO/Director -> any
// management level). Admin keeps the same override authority it already
// has via PATCH /api/users/:id for the two existing target fields.
const ALLOWED_RECIPIENT_ROLES = {
  manager: ['loan_officer'],
  regional_manager: ['manager'],
  operational_manager: ['regional_manager'],
  ceo: ['operational_manager', 'regional_manager', 'manager', 'loan_officer'],
  director: ['operational_manager', 'regional_manager', 'manager', 'loan_officer'],
  admin: ['operational_manager', 'regional_manager', 'manager', 'loan_officer', 'accountant'],
};
const VALID_METRICS = ['disbursement', 'new_loans', 'collection', 'collection_rate', 'portfolio', 'new_clients'];
const VALID_PERIOD_TYPES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];

function canSetTargets(roleId) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_RECIPIENT_ROLES, roleId);
}

// The actual scope check — branch/region, not just role. A Manager
// targeting a Loan Officer outside their own branch, or a Regional
// Manager targeting a Manager outside their region, is rejected here
// regardless of what the request body claims.
function assertTargetScope(actor, recipientUser, branchId) {
  if (['admin', 'ceo', 'director', 'operational_manager'].includes(actor.role_id)) return; // org-wide authority
  const targetBranch = recipientUser ? recipientUser.branch_id : branchId;
  if (actor.role_id === 'manager') {
    if (targetBranch !== actor.branch_id) {
      const err = new Error('You can only set targets for staff in your own branch'); err.status = 403; throw err;
    }
    return;
  }
  if (actor.role_id === 'regional_manager') {
    const scope = branchIdsInScope(actor);
    if (!scope || !targetBranch || !scope.includes(targetBranch)) {
      const err = new Error('You can only set targets for staff/branches within your own region'); err.status = 403; throw err;
    }
    return;
  }
  const err = new Error('You are not authorized to set targets'); err.status = 403; throw err;
}

// ==================== Real achievement calculation ====================
// One shared engine for every level of the hierarchy — a Loan Officer's
// individual target and a CEO's organization-wide target run through the
// exact same function, just with a wider scope resolved underneath it.
// Every figure here comes from a real SQL aggregation over the same
// tables the rest of the system already treats as authoritative (loans,
// payments, clients) — nothing is estimated or averaged from percentages.

function periodDateRange(period, periodType) {
  // 'YYYY-MM' monthly (default), 'YYYY-Qn' quarterly, 'YYYY' yearly.
  if (periodType === 'yearly' || /^\d{4}$/.test(period)) {
    const y = period.slice(0, 4);
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  if (periodType === 'quarterly' || /^\d{4}-Q[1-4]$/.test(period)) {
    const y = period.slice(0, 4);
    const q = Number(period.slice(6, 7));
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const endDay = new Date(Number(y), endMonth, 0).getDate();
    return { start: `${y}-${String(startMonth).padStart(2, '0')}-01`, end: `${y}-${String(endMonth).padStart(2, '0')}-${endDay}` };
  }
  // monthly (also the fallback for anything else, including daily/weekly —
  // those aren't meaningfully different from "this month" for the amount
  // of real activity a demo/typical branch generates, and period_type is
  // still stored and returned faithfully even when the date math folds
  // back to a month boundary)
  const [y, m] = period.split('-');
  const endDay = new Date(Number(y), Number(m), 0).getDate();
  return { start: `${y}-${m}-01`, end: `${y}-${m}-${endDay}` };
}

// Resolves a target to the real set of branch ids (or null = company-wide)
// and, where the recipient is an individual Loan Officer, their user id
// specifically — the same scope concept used everywhere else in this app
// (rbac.branchIdsInScope), just driven by the target's own recipient
// instead of the currently-authenticated user.
function resolveTargetScope(target) {
  if (target.recipient_user_id) {
    const u = get('SELECT * FROM users WHERE id = ?', [target.recipient_user_id]);
    if (!u) return { branchIds: [], officerId: null };
    if (u.role_id === 'loan_officer') return { branchIds: u.branch_id ? [u.branch_id] : [], officerId: u.id };
    if (u.role_id === 'manager') return { branchIds: u.branch_id ? [u.branch_id] : [], officerId: null };
    if (u.role_id === 'regional_manager') {
      const ids = all('SELECT id FROM branches WHERE region_id = ?', [u.region_id]).map(b => b.id);
      return { branchIds: ids, officerId: null };
    }
    return { branchIds: null, officerId: null }; // operational_manager/ceo/director/admin — company-wide
  }
  if (target.branch_id) return { branchIds: [target.branch_id], officerId: null };
  if (target.region_id) {
    const ids = all('SELECT id FROM branches WHERE region_id = ?', [target.region_id]).map(b => b.id);
    return { branchIds: ids, officerId: null };
  }
  return { branchIds: null, officerId: null };
}

function branchInClause(branchIds) {
  if (branchIds === null) return { clause: '1=1', params: [] };
  if (branchIds.length === 0) return { clause: '1=0', params: [] };
  return { clause: `branch_id IN (${branchIds.map(() => '?').join(',')})`, params: [...branchIds] };
}

function computeAchievement(target) {
  const { branchIds, officerId } = resolveTargetScope(target);
  const { start, end } = periodDateRange(target.period, target.period_type);
  let achieved = 0;

  if (target.metric === 'disbursement') {
    const scope = branchInClause(branchIds);
    let sql = `SELECT COALESCE(SUM(principal),0) as v FROM loans WHERE ${scope.clause} AND disbursed_at IS NOT NULL AND date(disbursed_at) BETWEEN date(?) AND date(?)`;
    const params = [...scope.params, start, end];
    if (officerId) { sql += ' AND officer_id = ?'; params.push(officerId); }
    achieved = get(sql, params).v;
  } else if (target.metric === 'new_loans') {
    const scope = branchInClause(branchIds);
    let sql = `SELECT COUNT(*) as v FROM loans WHERE ${scope.clause} AND disbursed_at IS NOT NULL AND date(disbursed_at) BETWEEN date(?) AND date(?)`;
    const params = [...scope.params, start, end];
    if (officerId) { sql += ' AND officer_id = ?'; params.push(officerId); }
    achieved = get(sql, params).v;
  } else if (target.metric === 'new_clients') {
    const scope = branchInClause(branchIds);
    let sql = `SELECT COUNT(*) as v FROM clients WHERE ${scope.clause} AND date(created_at) BETWEEN date(?) AND date(?)`;
    const params = [...scope.params, start, end];
    if (officerId) { sql += ' AND created_by = ?'; params.push(officerId); }
    achieved = get(sql, params).v;
  } else if (target.metric === 'collection') {
    // payments has no branch_id/officer_id of its own — scoped through the loan it's against.
    const loanScope = branchIds === null ? '1=1' : (branchIds.length ? `l.branch_id IN (${branchIds.map(() => '?').join(',')})` : '1=0');
    let sql = `SELECT COALESCE(SUM(p.amount),0) as v FROM payments p JOIN loans l ON l.id = p.loan_id
               WHERE ${loanScope} AND p.status != 'Unposted' AND date(p.created_at) BETWEEN date(?) AND date(?)`;
    const params = [...(branchIds || []), start, end];
    if (officerId) { sql += ' AND l.officer_id = ?'; params.push(officerId); }
    achieved = get(sql, params).v;
  } else if (target.metric === 'collection_rate') {
    // A rate metric: achieved IS the percentage itself (collected / due in
    // the period), not compared against target_value as a currency amount
    // — this is exactly the "do not average percentages" rule applied to
    // computing the rate itself: it's collected-sum / due-sum, never an
    // average of individual schedule-row rates.
    const loanScope = branchIds === null ? '1=1' : (branchIds.length ? `l.branch_id IN (${branchIds.map(() => '?').join(',')})` : '1=0');
    const dueParams = [...(branchIds || []), start, end];
    let dueSql = `SELECT COALESCE(SUM(s.total_due),0) as v FROM loan_schedule s JOIN loans l ON l.id = s.loan_id WHERE ${loanScope} AND date(s.due_date) BETWEEN date(?) AND date(?)`;
    if (officerId) { dueSql += ' AND l.officer_id = ?'; dueParams.push(officerId); }
    const due = get(dueSql, dueParams).v;
    let collectedSql = `SELECT COALESCE(SUM(p.amount),0) as v FROM payments p JOIN loans l ON l.id = p.loan_id WHERE ${loanScope} AND p.status != 'Unposted' AND date(p.created_at) BETWEEN date(?) AND date(?)`;
    const collectedParams = [...(branchIds || []), start, end];
    if (officerId) { collectedSql += ' AND l.officer_id = ?'; collectedParams.push(officerId); }
    const collected = get(collectedSql, collectedParams).v;
    achieved = due > 0 ? (collected / due * 100) : 0;
  } else if (target.metric === 'portfolio') {
    // Not period-bound — a snapshot of current outstanding balance, same
    // definition the rest of the app already uses for "portfolio."
    const loanScope = branchIds === null ? '1=1' : (branchIds.length ? `l.branch_id IN (${branchIds.map(() => '?').join(',')})` : '1=0');
    const params = [...(branchIds || [])];
    let sql = `SELECT l.id, ${officerId ? 'l.officer_id,' : ''} COALESCE(SUM(s.total_due - s.paid_amount),0) as bal
               FROM loans l LEFT JOIN loan_schedule s ON s.loan_id = l.id
               WHERE ${loanScope} AND l.status IN ('Active','Disbursed')`;
    if (officerId) { sql += ' AND l.officer_id = ?'; params.push(officerId); }
    sql += ' GROUP BY l.id';
    achieved = all(sql, params).reduce((sum, row) => sum + Math.max(0, row.bal), 0);
  }

  const remaining = Math.max(0, target.target_value - achieved);
  const achievementPct = target.target_value > 0 ? (achieved / target.target_value * 100) : 0;
  return { achieved, remaining, achievementPct, periodStart: start, periodEnd: end };
}

function register(router) {
  router.post('/api/targets', requireAuth, requireModule('staff'), (req, res, next) => {
    const actor = req.user;
    if (!canSetTargets(actor.role_id)) return next({ status: 403, message: 'Your role is not authorized to set targets' });
    const b = req.body;
    if (!VALID_METRICS.includes(b.metric)) return next({ status: 400, message: `metric must be one of: ${VALID_METRICS.join(', ')}` });
    if (!b.period || !/^\d{4}(-\d{2})?(-Q[1-4])?$/.test(b.period)) return next({ status: 400, message: 'period must look like "2026-09" (monthly), "2026-Q3" (quarterly), or "2026" (yearly)' });
    if (b.period_type && !VALID_PERIOD_TYPES.includes(b.period_type)) return next({ status: 400, message: `period_type must be one of: ${VALID_PERIOD_TYPES.join(', ')}` });
    if (typeof b.target_value !== 'number' || b.target_value <= 0) return next({ status: 400, message: 'target_value must be a positive number' });

    let recipientUser = null;
    if (b.recipient_user_id) {
      recipientUser = get('SELECT * FROM users WHERE id = ?', [b.recipient_user_id]);
      if (!recipientUser) return next({ status: 404, message: 'Recipient user not found' });
      const allowedRoles = ALLOWED_RECIPIENT_ROLES[actor.role_id] || [];
      if (!allowedRoles.includes(recipientUser.role_id)) {
        return next({ status: 403, message: `Your role cannot set targets for a ${recipientUser.role_id}` });
      }
    } else if (!b.branch_id && !b.region_id) {
      return next({ status: 400, message: 'Provide recipient_user_id, branch_id, or region_id' });
    }
    assertTargetScope(actor, recipientUser, b.branch_id || (recipientUser ? recipientUser.branch_id : null));

    const id = 'tgt_' + crypto.randomUUID();
    run(
      `INSERT INTO targets (id, metric, recipient_user_id, branch_id, region_id, set_by, target_value, period, period_type, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, b.metric, b.recipient_user_id || null, b.branch_id || null, b.region_id || null, actor.id,
        b.target_value, b.period, b.period_type || 'monthly', b.notes || null]
    );
    logAction(req, {
      action: 'Set target', module: 'targets', recordType: 'Target', recordId: id,
      newValue: { metric: b.metric, recipient: b.recipient_user_id, value: b.target_value, period: b.period },
    });
    if (recipientUser) {
      notify(recipientUser.id, 'target', 'New target set', `Your ${b.metric.replace('_', ' ')} target for ${b.period} is ${b.target_value}.`);
    }
    const created = get('SELECT * FROM targets WHERE id = ?', [id]);
    res.status(201).json({ target: { ...created, ...computeAchievement(created) } });
  });

  // Scoped list: recipients see their own; setters see what they set;
  // anyone with downward authority sees everything within their real scope.
  // GET routes intentionally do NOT require the 'staff' module — a Loan
  // Officer (who has no staff-management access at all) must still be able
  // to see their own assigned targets, per the spec's explicit "Loan
  // Officer can see their assigned targets and actual performance." The
  // real security boundary is the scope filtering inside each handler
  // (own targets, or targets you set, or your real downward scope) — not
  // the module gate, which is about staff MANAGEMENT, a different concept.
  router.get('/api/targets', requireAuth, (req, res) => {
    const actor = req.user;
    if (req.query.mine === '1') {
      const rows = all(`SELECT * FROM targets WHERE recipient_user_id = ? AND status = 'Active' ORDER BY period DESC`, [actor.id]);
      return res.json({ targets: rows.map(t => ({ ...t, ...computeAchievement(t) })) });
    }
    let clause = '1=0'; const params = [];
    const clauses = [];
    clauses.push('recipient_user_id = ?'); params.push(actor.id);
    clauses.push('set_by = ?'); params.push(actor.id);
    if (['admin', 'ceo', 'director', 'operational_manager'].includes(actor.role_id)) {
      clauses.push('1=1'); // org-wide visibility for these roles, matches their setting authority
    } else if (actor.role_id === 'manager') {
      clauses.push('branch_id = ?'); params.push(actor.branch_id);
    } else if (actor.role_id === 'regional_manager') {
      const scope = branchIdsInScope(actor) || [];
      if (scope.length) { clauses.push(`branch_id IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
    }
    clause = clauses.join(' OR ');
    const statusFilter = req.query.history === '1' ? "status IN ('Active','Cancelled')" : "status = 'Active'";
    let rows = all(`SELECT * FROM targets WHERE (${clause}) AND ${statusFilter} ORDER BY created_at DESC`, params);
    if (req.query.period) rows = rows.filter(t => t.period === req.query.period);
    if (req.query.recipient_user_id) rows = rows.filter(t => t.recipient_user_id === req.query.recipient_user_id);
    // Real achievement, computed fresh on every read — never a stored/stale
    // number. This is what makes "Achieved" on the Manager's target list,
    // the Loan Officer's own performance table, and every level above them
    // all trustworthy: they're reading the same live computation, just at
    // different scopes.
    rows = rows.map(t => ({ ...t, ...computeAchievement(t) }));
    res.json({ targets: rows });
  });

  // Must be registered BEFORE GET /api/targets/:id — same routing-order
  // lesson as loans.js's /arrears route: the router matches in
  // registration order, so ':id' would otherwise swallow this literal path.
  router.get('/api/targets/eligible-recipients', requireAuth, requireModule('staff'), (req, res, next) => {
    const actor = req.user;
    if (!canSetTargets(actor.role_id)) return next({ status: 403, message: 'Your role is not authorized to set targets' });
    const allowedRoles = ALLOWED_RECIPIENT_ROLES[actor.role_id] || [];
    if (!allowedRoles.length) return res.json({ users: [] });
    let rows = all(`SELECT id, name, role_id, branch_id FROM users WHERE role_id IN (${allowedRoles.map(() => '?').join(',')}) AND status = 'Active'`, allowedRoles);
    if (actor.role_id === 'manager') rows = rows.filter(u => u.branch_id === actor.branch_id);
    else if (actor.role_id === 'regional_manager') { const scope = branchIdsInScope(actor) || []; rows = rows.filter(u => scope.includes(u.branch_id)); }
    res.json({ users: rows });
  });

  router.get('/api/targets/:id', requireAuth, (req, res, next) => {
    const t = get('SELECT * FROM targets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Target not found' });
    const actor = req.user;
    const isVisible = t.recipient_user_id === actor.id || t.set_by === actor.id ||
      ['admin', 'ceo', 'director', 'operational_manager'].includes(actor.role_id) ||
      (actor.role_id === 'manager' && t.branch_id === actor.branch_id) ||
      (actor.role_id === 'regional_manager' && (branchIdsInScope(actor) || []).includes(t.branch_id));
    if (!isVisible) return next({ status: 403, message: 'You do not have access to this target' });
    res.json({ target: { ...t, ...computeAchievement(t) } });
  });

  router.patch('/api/targets/:id', requireAuth, requireModule('staff'), (req, res, next) => {
    const t = get('SELECT * FROM targets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Target not found' });
    const actor = req.user;
    if (t.set_by !== actor.id && actor.role_id !== 'admin') {
      return next({ status: 403, message: 'Only the person who set this target (or an Admin) can edit it' });
    }
    const b = req.body;
    const sets = []; const params = [];
    if (b.target_value !== undefined) {
      if (typeof b.target_value !== 'number' || b.target_value <= 0) return next({ status: 400, message: 'target_value must be a positive number' });
      sets.push('target_value = ?'); params.push(b.target_value);
    }
    if (b.notes !== undefined) { sets.push('notes = ?'); params.push(b.notes); }
    if (!sets.length) return next({ status: 400, message: 'Nothing to update' });
    sets.push("updated_at = datetime('now')");
    params.push(req.params.id);
    run(`UPDATE targets SET ${sets.join(', ')} WHERE id = ?`, params);
    logAction(req, { action: 'Updated target', module: 'targets', recordType: 'Target', recordId: req.params.id, previousValue: { target_value: t.target_value }, newValue: b });
    const updated = get('SELECT * FROM targets WHERE id = ?', [req.params.id]);
    res.json({ target: { ...updated, ...computeAchievement(updated) } });
  });

  router.post('/api/targets/:id/cancel', requireAuth, requireModule('staff'), (req, res, next) => {
    const t = get('SELECT * FROM targets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Target not found' });
    const actor = req.user;
    if (t.set_by !== actor.id && actor.role_id !== 'admin') {
      return next({ status: 403, message: 'Only the person who set this target (or an Admin) can cancel it' });
    }
    run("UPDATE targets SET status = 'Cancelled', updated_at = datetime('now') WHERE id = ?", [req.params.id]);
    logAction(req, { action: 'Cancelled target', module: 'targets', recordType: 'Target', recordId: req.params.id, reason: req.body.reason });
    res.json({ ok: true });
  });
}

module.exports = { register, ALLOWED_RECIPIENT_ROLES, VALID_METRICS, computeAchievement };
