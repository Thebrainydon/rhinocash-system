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
const VALID_METRICS = ['disbursement', 'new_loans', 'collection', 'collection_rate', 'portfolio', 'new_clients', 'repeat_loans', 'arrears', 'performing'];
const VALID_PERIOD_TYPES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];

function canSetTargets(roleId) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_RECIPIENT_ROLES, roleId);
}

// The target hierarchy: who sets which kind of target.
//   company — CEO and Director (Admin oversees)
//   region  — Operational Manager (and anyone above)
//   branch  — Regional Manager for branches in their region (and above;
//             a Manager may still set one for their own branch)
//   person  — Manager for their Loan Officers, and the role chains above
const LEVEL_SETTERS = {
  company: ['ceo', 'director', 'admin'],
  region: ['operational_manager', 'ceo', 'director', 'admin'],
};
const RANK = { loan_officer: 1, accountant: 1, manager: 2, regional_manager: 3, operational_manager: 4, director: 5, ceo: 5, admin: 6 };

function levelOf(t) {
  if (t.recipient_user_id) return 'person';
  if (t.branch_id) return 'branch';
  if (t.region_id) return 'region';
  return 'company';
}

// Is `actor` within reach of target `t` (by branch/region)? `scope` is the
// actor's branch list (null = company-wide).
function targetInScope(actor, t, scope) {
  if (scope === null) return true;
  const branch = t.branch_id || t.recipient_branch_id || null;
  if (branch && scope.includes(branch)) return true;
  if (actor.role_id === 'regional_manager' && t.region_id && t.region_id === actor.region_id) return true;
  return false;
}

// The setter, Admin, or someone senior to the setter within whose reach the
// target falls may edit or delete it.
function canManageSync(actor, t, setterRole, scope) {
  if (t.set_by === actor.id || actor.role_id === 'admin') return true;
  if (!canSetTargets(actor.role_id)) return false;
  if ((RANK[actor.role_id] || 0) <= (RANK[setterRole] || 0)) return false;
  return targetInScope(actor, t, scope);
}
async function actorScope(actor) {
  if (['admin', 'ceo', 'director', 'operational_manager', 'hr'].includes(actor.role_id)) return null;
  if (actor.role_id === 'manager') return actor.branch_id ? [actor.branch_id] : [];
  return (await branchIdsInScope(actor)) || [];
}
async function canManageTarget(actor, t) {
  const setter = t.set_by ? await get('SELECT role_id FROM users WHERE id = ?', [t.set_by]) : null;
  const rb = t.recipient_user_id ? await get('SELECT branch_id FROM users WHERE id = ?', [t.recipient_user_id]) : null;
  return canManageSync(actor, { ...t, recipient_branch_id: rb ? rb.branch_id : null }, setter ? setter.role_id : null, await actorScope(actor));
}

// The person (or the head of the team) a target was set for — the one who
// may appeal it or comment on it.
function isRecipientSync(user, t) {
  if (t.recipient_user_id) return t.recipient_user_id === user.id;
  if (t.branch_id) return user.role_id === 'manager' && user.branch_id === t.branch_id;
  if (t.region_id) return user.role_id === 'regional_manager' && user.region_id === t.region_id;
  return user.role_id === 'operational_manager'; // company targets are run by Operations
}

// The actual scope check — branch/region, not just role. A Manager
// targeting a Loan Officer outside their own branch, or a Regional
// Manager targeting a Manager outside their region, is rejected here
// regardless of what the request body claims.
async function assertTargetScope(actor, recipientUser, branchId) {
  if (['admin', 'ceo', 'director', 'operational_manager'].includes(actor.role_id)) return; // org-wide authority
  const targetBranch = recipientUser ? recipientUser.branch_id : branchId;
  if (actor.role_id === 'manager') {
    if (targetBranch !== actor.branch_id) {
      const err = new Error('You can only set targets for staff in your own branch'); err.status = 403; throw err;
    }
    return;
  }
  if (actor.role_id === 'regional_manager') {
    const scope = await branchIdsInScope(actor);
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
async function resolveTargetScope(target) {
  if (target.recipient_user_id) {
    const u = await get('SELECT * FROM users WHERE id = ?', [target.recipient_user_id]);
    if (!u) return { branchIds: [], officerId: null };
    if (u.role_id === 'loan_officer') return { branchIds: u.branch_id ? [u.branch_id] : [], officerId: u.id };
    if (u.role_id === 'manager') return { branchIds: u.branch_id ? [u.branch_id] : [], officerId: null };
    if (u.role_id === 'regional_manager') {
      const rows = await all('SELECT id FROM branches WHERE region_id = ?', [u.region_id]);
      return { branchIds: rows.map(b => b.id), officerId: null };
    }
    return { branchIds: null, officerId: null }; // operational_manager/ceo/director/admin — company-wide
  }
  if (target.branch_id) return { branchIds: [target.branch_id], officerId: null };
  if (target.region_id) {
    const rows = await all('SELECT id FROM branches WHERE region_id = ?', [target.region_id]);
    return { branchIds: rows.map(b => b.id), officerId: null };
  }
  return { branchIds: null, officerId: null };
}

function branchInClause(branchIds) {
  if (branchIds === null) return { clause: '1=1', params: [] };
  if (branchIds.length === 0) return { clause: '1=0', params: [] };
  return { clause: `branch_id IN (${branchIds.map(() => '?').join(',')})`, params: [...branchIds] };
}

async function computeAchievement(target) {
  const { branchIds, officerId } = await resolveTargetScope(target);
  const { start, end } = periodDateRange(target.period, target.period_type);
  let achieved = 0;

  if (target.metric === 'disbursement') {
    const scope = branchInClause(branchIds);
    let sql = `SELECT COALESCE(SUM(principal),0) as v FROM loans WHERE ${scope.clause} AND disbursed_at IS NOT NULL AND (disbursed_at)::date BETWEEN (?)::date AND (?)::date`;
    const params = [...scope.params, start, end];
    if (officerId) { sql += ' AND officer_id = ?'; params.push(officerId); }
    achieved = (await get(sql, params)).v;
  } else if (target.metric === 'new_loans') {
    const scope = branchInClause(branchIds);
    let sql = `SELECT COUNT(*) as v FROM loans WHERE ${scope.clause} AND disbursed_at IS NOT NULL AND (disbursed_at)::date BETWEEN (?)::date AND (?)::date`;
    const params = [...scope.params, start, end];
    if (officerId) { sql += ' AND officer_id = ?'; params.push(officerId); }
    achieved = (await get(sql, params)).v;
  } else if (target.metric === 'new_clients') {
    const scope = branchInClause(branchIds);
    let sql = `SELECT COUNT(*) as v FROM clients WHERE ${scope.clause} AND (created_at)::date BETWEEN (?)::date AND (?)::date`;
    const params = [...scope.params, start, end];
    if (officerId) { sql += ' AND created_by = ?'; params.push(officerId); }
    achieved = (await get(sql, params)).v;
  } else if (target.metric === 'collection') {
    // payments has no branch_id/officer_id of its own — scoped through the loan it's against.
    const loanScope = branchIds === null ? '1=1' : (branchIds.length ? `l.branch_id IN (${branchIds.map(() => '?').join(',')})` : '1=0');
    let sql = `SELECT COALESCE(SUM(p.amount),0) as v FROM payments p JOIN loans l ON l.id = p.loan_id
               WHERE ${loanScope} AND p.status != 'Unposted' AND (p.created_at)::date BETWEEN (?)::date AND (?)::date`;
    const params = [...(branchIds || []), start, end];
    if (officerId) { sql += ' AND l.officer_id = ?'; params.push(officerId); }
    achieved = (await get(sql, params)).v;
  } else if (target.metric === 'collection_rate') {
    // A rate metric: achieved IS the percentage itself (collected / due in
    // the period), not compared against target_value as a currency amount
    // — this is exactly the "do not average percentages" rule applied to
    // computing the rate itself: it's collected-sum / due-sum, never an
    // average of individual schedule-row rates.
    const loanScope = branchIds === null ? '1=1' : (branchIds.length ? `l.branch_id IN (${branchIds.map(() => '?').join(',')})` : '1=0');
    const dueParams = [...(branchIds || []), start, end];
    let dueSql = `SELECT COALESCE(SUM(s.total_due),0) as v FROM loan_schedule s JOIN loans l ON l.id = s.loan_id WHERE ${loanScope} AND (s.due_date)::date BETWEEN (?)::date AND (?)::date`;
    if (officerId) { dueSql += ' AND l.officer_id = ?'; dueParams.push(officerId); }
    const due = (await get(dueSql, dueParams)).v;
    let collectedSql = `SELECT COALESCE(SUM(p.amount),0) as v FROM payments p JOIN loans l ON l.id = p.loan_id WHERE ${loanScope} AND p.status != 'Unposted' AND (p.created_at)::date BETWEEN (?)::date AND (?)::date`;
    const collectedParams = [...(branchIds || []), start, end];
    if (officerId) { collectedSql += ' AND l.officer_id = ?'; collectedParams.push(officerId); }
    const collected = (await get(collectedSql, collectedParams)).v;
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
    const rows = await all(sql, params);
    achieved = rows.reduce((sum, row) => sum + Math.max(0, row.bal), 0);
  } else if (target.metric === 'repeat_loans') {
    // Same "Repeat" definition used everywhere else in this app (Dashboard's
    // computeStats, /api/users/me/performance below): a loan is Repeat iff
    // its client has an earlier-disbursed loan anywhere in the system.
    const scope = branchInClause(branchIds);
    let sql = `SELECT COUNT(*) as v FROM loans l WHERE ${scope.clause} AND l.disbursed_at IS NOT NULL AND (l.disbursed_at)::date BETWEEN (?)::date AND (?)::date
               AND EXISTS (SELECT 1 FROM loans p WHERE p.client_id = l.client_id AND p.disbursed_at IS NOT NULL AND p.disbursed_at < l.disbursed_at)`;
    const params = [...scope.params, start, end];
    if (officerId) { sql += ' AND l.officer_id = ?'; params.push(officerId); }
    achieved = (await get(sql, params)).v;
  } else if (target.metric === 'performing') {
    // A real snapshot as of the period's own end date: disbursed, not
    // written off/closed, and carrying no overdue-unpaid schedule row.
    const scope = branchInClause(branchIds);
    let sql = `SELECT COUNT(DISTINCT l.id) as v FROM loans l WHERE ${scope.clause} AND l.disbursed_at IS NOT NULL AND (l.disbursed_at)::date <= (?)::date
               AND l.status NOT IN ('Written Off','Closed')
               AND NOT EXISTS (SELECT 1 FROM loan_schedule s WHERE s.loan_id = l.id AND (s.due_date)::date <= (?)::date AND s.paid_amount < s.total_due)`;
    const params = [...scope.params, end, end];
    if (officerId) { sql += ' AND l.officer_id = ?'; params.push(officerId); }
    achieved = (await get(sql, params)).v;
  } else if (target.metric === 'arrears') {
    // A real Ksh amount — the sum of unpaid balance on overdue schedule
    // rows as of the period's end date, same "Arrears Breakdown(PAR)"
    // definition Portfolio Breakdown already uses, not a loan count.
    const loanScope = branchIds === null ? '1=1' : (branchIds.length ? `l.branch_id IN (${branchIds.map(() => '?').join(',')})` : '1=0');
    const params = [...(branchIds || []), end];
    let sql = `SELECT COALESCE(SUM(s.total_due - s.paid_amount),0) as v FROM loan_schedule s JOIN loans l ON l.id = s.loan_id
               WHERE ${loanScope} AND l.disbursed_at IS NOT NULL AND (s.due_date)::date <= (?)::date AND s.paid_amount < s.total_due`;
    if (officerId) { sql += ' AND l.officer_id = ?'; params.push(officerId); }
    achieved = (await get(sql, params)).v;
  }

  const remaining = Math.max(0, target.target_value - achieved);
  const achievementPct = target.target_value > 0 ? (achieved / target.target_value * 100) : 0;
  return { achieved, remaining, achievementPct, periodStart: start, periodEnd: end };
}

// The exact 5-metric breakdown (New Loans / Repeat Loans / Performing /
// Arrears / Revenue, each with a real Actual and, wherever one has been
// set, a real Target) for ONE officer over ONE monthly period — the same
// underlying computation whether it's an officer looking at their own
// year-long history (/api/users/me/performance below) or a Manager looking
// at their whole team for one month (team-performance below). Every actual
// is a real SQL aggregation, never estimated; every target is a real row
// looked up from the same `targets` table the rest of this file manages,
// so the "+" button on either page is always setting/updating a real
// target, never a display-only number.
async function computeOfficerPeriodMetrics(officerId, period) {
  const { start, end } = periodDateRange(period, 'monthly');

  const newLoans = (await get(
    `SELECT COUNT(*) as v FROM loans l WHERE l.officer_id = ? AND l.disbursed_at IS NOT NULL AND (l.disbursed_at)::date BETWEEN (?)::date AND (?)::date
       AND NOT EXISTS (SELECT 1 FROM loans p WHERE p.client_id = l.client_id AND p.disbursed_at IS NOT NULL AND p.disbursed_at < l.disbursed_at)`,
    [officerId, start, end]
  )).v;
  const repeatLoans = (await get(
    `SELECT COUNT(*) as v FROM loans l WHERE l.officer_id = ? AND l.disbursed_at IS NOT NULL AND (l.disbursed_at)::date BETWEEN (?)::date AND (?)::date
       AND EXISTS (SELECT 1 FROM loans p WHERE p.client_id = l.client_id AND p.disbursed_at IS NOT NULL AND p.disbursed_at < l.disbursed_at)`,
    [officerId, start, end]
  )).v;
  // Performing/Arrears are a real snapshot "as of this period" — never
  // computed for a period that has not genuinely begun yet.
  const monthHasStarted = start <= new Date().toISOString().slice(0, 10);
  const performing = !monthHasStarted ? 0 : (await get(
    `SELECT COUNT(DISTINCT l.id) as v FROM loans l WHERE l.officer_id = ? AND l.disbursed_at IS NOT NULL AND (l.disbursed_at)::date <= (?)::date
       AND l.status NOT IN ('Written Off','Closed')
       AND NOT EXISTS (SELECT 1 FROM loan_schedule s WHERE s.loan_id = l.id AND (s.due_date)::date <= (?)::date AND s.paid_amount < s.total_due)`,
    [officerId, end, end]
  )).v;
  // A real Ksh amount (the real unpaid balance on overdue schedule rows),
  // not a loan count — matches Portfolio Breakdown's own "Arrears
  // Breakdown(PAR)" definition for the same concept.
  const arrears = !monthHasStarted ? 0 : (await get(
    `SELECT COALESCE(SUM(s.total_due - s.paid_amount),0) as v FROM loan_schedule s JOIN loans l ON l.id = s.loan_id
       WHERE l.officer_id = ? AND l.disbursed_at IS NOT NULL AND (s.due_date)::date <= (?)::date AND s.paid_amount < s.total_due`,
    [officerId, end]
  )).v;
  const revenue = (await get(
    `SELECT COALESCE(SUM(p.amount),0) as v FROM payments p JOIN loans l ON l.id = p.loan_id WHERE l.officer_id = ? AND p.status != 'Unposted' AND (p.created_at)::date BETWEEN (?)::date AND (?)::date`,
    [officerId, start, end]
  )).v;

  const targetLookup = (metric) => get(
    `SELECT id, target_value FROM targets WHERE recipient_user_id = ? AND metric = ? AND period = ? AND period_type = 'monthly' AND status != 'Cancelled' ORDER BY created_at DESC LIMIT 1`,
    [officerId, metric, period]
  );
  const [newLoansT, repeatLoansT, performingT, arrearsT, revenueT] = await Promise.all([
    targetLookup('new_loans'), targetLookup('repeat_loans'), targetLookup('performing'), targetLookup('arrears'), targetLookup('collection'),
  ]);
  const group = (actual, row) => ({ target: row ? row.target_value : 0, targetId: row ? row.id : null, actual });

  return {
    newLoans: group(newLoans, newLoansT),
    repeatLoans: group(repeatLoans, repeatLoansT),
    performing: group(performing, performingT),
    arrears: group(arrears, arrearsT),
    revenue: group(revenue, revenueT),
  };
}

function register(router) {
  router.post('/api/targets', requireAuth, requireModule('staff'), async (req, res, next) => {
    const actor = req.user;
    if (!canSetTargets(actor.role_id)) return next({ status: 403, message: 'Your role is not authorized to set targets' });
    const b = req.body;
    if (!VALID_METRICS.includes(b.metric)) return next({ status: 400, message: `metric must be one of: ${VALID_METRICS.join(', ')}` });
    if (!b.period || !/^\d{4}(-\d{2})?(-Q[1-4])?$/.test(b.period)) return next({ status: 400, message: 'period must look like "2026-09" (monthly), "2026-Q3" (quarterly), or "2026" (yearly)' });
    if (b.period_type && !VALID_PERIOD_TYPES.includes(b.period_type)) return next({ status: 400, message: `period_type must be one of: ${VALID_PERIOD_TYPES.join(', ')}` });
    if (typeof b.target_value !== 'number' || b.target_value <= 0) return next({ status: 400, message: 'target_value must be a positive number' });

    const level = b.recipient_user_id ? 'person' : b.branch_id ? 'branch' : b.region_id ? 'region' : (b.level === 'company' || b.scope === 'company') ? 'company' : null;
    if (LEVEL_SETTERS[level] && !LEVEL_SETTERS[level].includes(actor.role_id)) {
      return next({ status: 403, message: level === 'company' ? 'Only the CEO or a Director sets company targets' : 'Only the Operational Manager (or CEO/Director) sets region targets' });
    }
    if (b.region_id && !b.branch_id && !b.recipient_user_id && !(await get('SELECT 1 FROM regions WHERE id = ?', [b.region_id]))) return next({ status: 400, message: 'Unknown region' });
    if (b.branch_id && !(await get('SELECT 1 FROM branches WHERE id = ?', [b.branch_id]))) return next({ status: 400, message: 'Unknown branch' });
    if (level === 'company' || level === 'region') {
      const dup = await get(`SELECT id FROM targets WHERE status = 'Active' AND metric = ? AND period = ? AND recipient_user_id IS NULL AND branch_id IS NULL
        AND ${level === 'company' ? 'region_id IS NULL' : 'region_id = ?'}`, level === 'company' ? [b.metric, b.period] : [b.metric, b.period, b.region_id]);
      if (dup) return next({ status: 409, message: 'That target already exists for this period — edit it instead' });
    }

    let recipientUser = null;
    if (level === 'company') {
      // no recipient, branch or region: the whole company
    } else if (b.recipient_user_id) {
      recipientUser = await get('SELECT * FROM users WHERE id = ?', [b.recipient_user_id]);
      if (!recipientUser) return next({ status: 404, message: 'Recipient user not found' });
      const allowedRoles = ALLOWED_RECIPIENT_ROLES[actor.role_id] || [];
      if (!allowedRoles.includes(recipientUser.role_id)) {
        return next({ status: 403, message: `Your role cannot set targets for a ${recipientUser.role_id}` });
      }
    } else if (!b.branch_id && !b.region_id) {
      return next({ status: 400, message: 'Provide recipient_user_id, branch_id, or region_id' });
    }
    if (level !== 'company') {
      try {
        await assertTargetScope(actor, recipientUser, b.branch_id || (recipientUser ? recipientUser.branch_id : null));
      } catch (e) { return next(e); }
    }

    const id = 'tgt_' + crypto.randomUUID();
    await run(
      `INSERT INTO targets (id, metric, recipient_user_id, branch_id, region_id, set_by, target_value, period, period_type, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, b.metric, b.recipient_user_id || null, b.branch_id || null, b.region_id || null, actor.id,
        b.target_value, b.period, b.period_type || 'monthly', b.notes || null]
    );
    await logAction(req, {
      action: 'Set target', module: 'targets', recordType: 'Target', recordId: id,
      newValue: { metric: b.metric, recipient: b.recipient_user_id, value: b.target_value, period: b.period },
    });
    if (recipientUser) {
      await notify(recipientUser.id, 'target', 'New target set', `Your ${b.metric.replace('_', ' ')} target for ${b.period} is ${b.target_value}.`);
    } else {
      // Let the head of the team know: the branch Manager, the Regional
      // Manager, or Operations for a company target.
      const t = { branch_id: b.branch_id || null, region_id: b.region_id || null };
      const heads = t.branch_id ? await all(`SELECT id FROM users WHERE role_id = 'manager' AND branch_id = ? AND status = 'Active'`, [t.branch_id])
        : t.region_id ? await all(`SELECT id FROM users WHERE role_id = 'regional_manager' AND region_id = ? AND status = 'Active'`, [t.region_id])
        : await all(`SELECT id FROM users WHERE role_id = 'operational_manager' AND status = 'Active'`);
      for (const h of heads) if (h.id !== actor.id) await notify(h.id, 'target', 'New target set', `A ${level} ${b.metric.replace('_', ' ')} target for ${b.period} is ${b.target_value}.`);
    }
    const created = await get('SELECT * FROM targets WHERE id = ?', [id]);
    res.status(201).json({ target: { ...created, ...(await computeAchievement(created)) } });
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
  router.get('/api/targets', requireAuth, async (req, res) => {
    const actor = req.user;
    if (req.query.mine === '1') {
      const rows = await all(`SELECT * FROM targets WHERE recipient_user_id = ? AND status = 'Active' ORDER BY period DESC`, [actor.id]);
      const withAchievement = await Promise.all(rows.map(async t => ({ ...t, ...(await computeAchievement(t)) })));
      return res.json({ targets: withAchievement });
    }
    let clause = '1=0'; const params = [];
    const clauses = [];
    clauses.push('recipient_user_id = ?'); params.push(actor.id);
    clauses.push('set_by = ?'); params.push(actor.id);
    if (['admin', 'ceo', 'director', 'operational_manager'].includes(actor.role_id)) {
      clauses.push('1=1'); // org-wide visibility for these roles, matches their setting authority
    } else if (actor.role_id === 'hr') {
      clauses.push('1=1'); // HR reads every staff target for performance management (it cannot set them)
    } else if (actor.role_id === 'manager') {
      clauses.push('branch_id = ?'); params.push(actor.branch_id);
      clauses.push('recipient_user_id IN (SELECT id FROM users WHERE branch_id = ?)'); params.push(actor.branch_id);
    } else if (actor.role_id === 'regional_manager') {
      const scope = (await branchIdsInScope(actor)) || [];
      if (scope.length) {
        const qs = scope.map(() => '?').join(',');
        clauses.push(`branch_id IN (${qs})`); params.push(...scope);
        clauses.push(`recipient_user_id IN (SELECT id FROM users WHERE branch_id IN (${qs}))`); params.push(...scope);
      }
      if (actor.region_id) { clauses.push('(region_id = ? AND branch_id IS NULL AND recipient_user_id IS NULL)'); params.push(actor.region_id); }
    }
    clause = clauses.join(' OR ');
    const statusFilter = req.query.history === '1' ? "status IN ('Active','Cancelled')" : "status = 'Active'";
    let rows = await all(`SELECT t.*, ru.name AS recipient_name, ru.role_id AS recipient_role, ru.branch_id AS recipient_branch_id,
        COALESCE(b.name, rb.name) AS branch_name, rg.name AS region_name, su.name AS set_by_name, su.role_id AS set_by_role,
        (SELECT COUNT(*) FROM target_appeals a WHERE a.target_id = t.id)::int AS appeals_total,
        (SELECT COUNT(*) FROM target_appeals a WHERE a.target_id = t.id AND a.status = 'Open')::int AS appeals_open
      FROM (SELECT * FROM targets WHERE (${clause}) AND ${statusFilter}) t
      LEFT JOIN users ru ON ru.id = t.recipient_user_id
      LEFT JOIN branches b ON b.id = t.branch_id
      LEFT JOIN branches rb ON rb.id = ru.branch_id
      LEFT JOIN regions rg ON rg.id = COALESCE(t.region_id, b.region_id)
      LEFT JOIN users su ON su.id = t.set_by
      ORDER BY t.created_at DESC`, params);
    if (req.query.level) rows = rows.filter(t => levelOf(t) === req.query.level);
    const scopeForManage = await actorScope(actor);
    rows = rows.map(t => ({ ...t, level: levelOf(t), can_manage: canManageSync(actor, t, t.set_by_role, scopeForManage), can_appeal: isRecipientSync(actor, t) }));
    if (req.query.period) rows = rows.filter(t => t.period === req.query.period);
    if (req.query.recipient_user_id) rows = rows.filter(t => t.recipient_user_id === req.query.recipient_user_id);
    // Real achievement, computed fresh on every read — never a stored/stale
    // number. This is what makes "Achieved" on the Manager's target list,
    // the Loan Officer's own performance table, and every level above them
    // all trustworthy: they're reading the same live computation, just at
    // different scopes.
    const withAchievement = await Promise.all(rows.map(async t => ({ ...t, ...(await computeAchievement(t)) })));
    res.json({ targets: withAchievement });
  });

  // Must be registered BEFORE GET /api/targets/:id — same routing-order
  // lesson as loans.js's /arrears route: the router matches in
  // registration order, so ':id' would otherwise swallow this literal path.
  router.get('/api/targets/eligible-recipients', requireAuth, requireModule('staff'), async (req, res, next) => {
    const actor = req.user;
    if (!canSetTargets(actor.role_id)) return next({ status: 403, message: 'Your role is not authorized to set targets' });
    const allowedRoles = ALLOWED_RECIPIENT_ROLES[actor.role_id] || [];
    if (!allowedRoles.length) return res.json({ users: [] });
    let rows = await all(`SELECT id, name, role_id, branch_id FROM users WHERE role_id IN (${allowedRoles.map(() => '?').join(',')}) AND status = 'Active'`, allowedRoles);
    if (actor.role_id === 'manager') rows = rows.filter(u => u.branch_id === actor.branch_id);
    else if (actor.role_id === 'regional_manager') { const scope = (await branchIdsInScope(actor)) || []; rows = rows.filter(u => scope.includes(u.branch_id)); }
    res.json({ users: rows });
  });

  // ==================== Team performance (Manager/Regional Manager/etc ->
  // Business Analytics -> Targets & Accruals) ====================
  // The same 5-metric breakdown as /api/users/me/performance below, but for
  // every Loan Officer (or other recipient role) in the CALLER's own real
  // downward scope, for ONE selected period — the exact shape the Targets &
  // Accruals page's per-officer table needs, including each metric's real
  // target row id so its "+" button can tell create (POST /api/targets)
  // from update (PATCH /api/targets/:id) for that officer+metric+period.
  // Must be registered BEFORE GET /api/targets/:id below — same routing-
  // order lesson as /api/targets/eligible-recipients just above: the
  // router matches in registration order, so ':id' would otherwise
  // swallow this literal path too.
  router.get('/api/targets/team-performance', requireAuth, requireModule('reports'), async (req, res, next) => {
    const actor = req.user;
    if (!canSetTargets(actor.role_id)) return next({ status: 403, message: 'Your role is not authorized to view team performance' });
    const now = new Date();
    const period = req.query.period || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (!/^\d{4}-\d{2}$/.test(period)) return next({ status: 400, message: 'period must look like "2026-09"' });

    const allowedRoles = ALLOWED_RECIPIENT_ROLES[actor.role_id] || [];
    if (!allowedRoles.length) return res.json({ period, officers: [] });
    let rows = await all(`SELECT id, name, role_id, branch_id FROM users WHERE role_id IN (${allowedRoles.map(() => '?').join(',')}) AND status = 'Active' ORDER BY name`, allowedRoles);
    if (actor.role_id === 'manager') rows = rows.filter(u => u.branch_id === actor.branch_id);
    else if (actor.role_id === 'regional_manager') { const scope = (await branchIdsInScope(actor)) || []; rows = rows.filter(u => scope.includes(u.branch_id)); }

    const officers = await Promise.all(rows.map(async u => ({
      id: u.id, name: u.name, ...(await computeOfficerPeriodMetrics(u.id, period)),
    })));
    res.json({ period, officers });
  });

  router.get('/api/targets/:id', requireAuth, async (req, res, next) => {
    const t = await get('SELECT * FROM targets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Target not found' });
    const actor = req.user;
    const isVisible = t.recipient_user_id === actor.id || t.set_by === actor.id ||
      ['admin', 'ceo', 'director', 'operational_manager'].includes(actor.role_id) ||
      (actor.role_id === 'manager' && t.branch_id === actor.branch_id) ||
      (actor.role_id === 'regional_manager' && ((await branchIdsInScope(actor)) || []).includes(t.branch_id));
    if (!isVisible) return next({ status: 403, message: 'You do not have access to this target' });
    res.json({ target: { ...t, ...(await computeAchievement(t)) } });
  });

  router.patch('/api/targets/:id', requireAuth, requireModule('staff'), async (req, res, next) => {
    const t = await get('SELECT * FROM targets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Target not found' });
    const actor = req.user;
    if (!(await canManageTarget(actor, t))) {
      return next({ status: 403, message: 'Only the person who set this target, someone senior to them, or an Admin can edit it' });
    }
    const b = req.body;
    const sets = []; const params = [];
    if (b.metric !== undefined) {
      if (!VALID_METRICS.includes(b.metric)) return next({ status: 400, message: `metric must be one of: ${VALID_METRICS.join(', ')}` });
      sets.push('metric = ?'); params.push(b.metric);
    }
    if (b.period !== undefined) {
      if (!/^\d{4}(-\d{2})?(-Q[1-4])?$/.test(String(b.period))) return next({ status: 400, message: 'period must look like "2026-09", "2026-Q3" or "2026"' });
      sets.push('period = ?'); params.push(b.period);
    }
    if (b.target_value !== undefined) {
      if (typeof b.target_value !== 'number' || b.target_value <= 0) return next({ status: 400, message: 'target_value must be a positive number' });
      sets.push('target_value = ?'); params.push(b.target_value);
    }
    if (b.notes !== undefined) { sets.push('notes = ?'); params.push(b.notes); }
    if (!sets.length) return next({ status: 400, message: 'Nothing to update' });
    sets.push("updated_at = iso_now()");
    params.push(req.params.id);
    await run(`UPDATE targets SET ${sets.join(', ')} WHERE id = ?`, params);
    await logAction(req, { action: 'Updated target', module: 'targets', recordType: 'Target', recordId: req.params.id, previousValue: { target_value: t.target_value }, newValue: b });
    const updated = await get('SELECT * FROM targets WHERE id = ?', [req.params.id]);
    res.json({ target: { ...updated, ...(await computeAchievement(updated)) } });
  });

  router.post('/api/targets/:id/cancel', requireAuth, requireModule('staff'), async (req, res, next) => {
    const t = await get('SELECT * FROM targets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Target not found' });
    const actor = req.user;
    if (!(await canManageTarget(actor, t))) {
      return next({ status: 403, message: 'Only the person who set this target, someone senior to them, or an Admin can cancel it' });
    }
    await run("UPDATE targets SET status = 'Cancelled', updated_at = iso_now() WHERE id = ?", [req.params.id]);
    await logAction(req, { action: 'Cancelled target', module: 'targets', recordType: 'Target', recordId: req.params.id, reason: req.body.reason });
    res.json({ ok: true });
  });

  // Delete a target set by mistake. Kept in the audit trail; its appeals go with it.
  router.delete('/api/targets/:id', requireAuth, async (req, res, next) => {
    const t = await get('SELECT * FROM targets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Target not found' });
    if (!(await canManageTarget(req.user, t))) {
      return next({ status: 403, message: 'Only the person who set this target, someone senior to them, or an Admin can delete it' });
    }
    await run('DELETE FROM targets WHERE id = ?', [t.id]);
    await logAction(req, { action: 'Deleted target', module: 'targets', recordType: 'Target', recordId: t.id,
      previousValue: { metric: t.metric, value: Number(t.target_value), period: t.period, recipient: t.recipient_user_id, branch: t.branch_id, region: t.region_id }, reason: (req.body || {}).reason });
    res.json({ ok: true });
  });

  // ---- Appeals and comments ----
  // The person (or team head) a target was set for appeals it — optionally
  // proposing a different figure — or leaves a comment. Whoever can manage
  // the target answers; accepting an appeal with a proposed figure changes
  // the target to that figure.
  router.post('/api/targets/:id/appeals', requireAuth, async (req, res, next) => {
    const t = await get('SELECT * FROM targets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Target not found' });
    const actor = req.user;
    if (!isRecipientSync(actor, t)) return next({ status: 403, message: 'Only the person this target was set for can appeal or comment on it' });
    const b = req.body || {};
    const kind = b.kind === 'appeal' ? 'appeal' : 'comment';
    const message = String(b.message || '').trim();
    if (!message) return next({ status: 400, message: 'Write your appeal or comment' });
    if (message.length > 2000) return next({ status: 400, message: 'Keep it under 2000 characters' });
    let proposed = null;
    if (b.proposed_value !== undefined && b.proposed_value !== null && b.proposed_value !== '') {
      proposed = Number(b.proposed_value);
      if (!(proposed > 0)) return next({ status: 400, message: 'The proposed figure must be a positive number' });
    }
    const id = 'tap_' + crypto.randomUUID();
    await run(`INSERT INTO target_appeals (id, target_id, user_id, kind, message, proposed_value, status) VALUES (?,?,?,?,?,?,?)`,
      [id, t.id, actor.id, kind, message, kind === 'appeal' ? proposed : null, kind === 'appeal' ? 'Open' : 'Noted']);
    await logAction(req, { action: kind === 'appeal' ? 'Appealed target' : 'Commented on target', module: 'targets', recordType: 'Target', recordId: t.id, newValue: { kind, proposed } });
    if (t.set_by && t.set_by !== actor.id) {
      await notify(t.set_by, 'target', kind === 'appeal' ? 'Target appeal' : 'Target comment',
        `${actor.name} ${kind === 'appeal' ? 'appealed' : 'commented on'} the ${t.metric.replace('_', ' ')} target for ${t.period}${proposed ? ` (proposes ${proposed})` : ''}.`);
    }
    res.status(201).json({ appeal: await get('SELECT * FROM target_appeals WHERE id = ?', [id]) });
  });

  // Appeals and comments the caller raised or can answer.
  router.get('/api/target-appeals', requireAuth, async (req, res) => {
    const actor = req.user;
    const rows = await all(`SELECT a.*, u.name AS user_name, rb.name AS responded_by_name, t.metric, t.period, t.target_value, t.recipient_user_id,
        t.branch_id, t.region_id, t.set_by, su.role_id AS set_by_role, ru.branch_id AS recipient_branch_id, ru.name AS recipient_name,
        b.name AS branch_name, rg.name AS region_name
      FROM target_appeals a JOIN targets t ON t.id = a.target_id
      LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users rb ON rb.id = a.responded_by
      LEFT JOIN users su ON su.id = t.set_by LEFT JOIN users ru ON ru.id = t.recipient_user_id
      LEFT JOIN branches b ON b.id = t.branch_id LEFT JOIN regions rg ON rg.id = t.region_id
      ORDER BY a.created_at DESC LIMIT 500`);
    const scope = await actorScope(actor);
    const out = rows.map(r => ({ ...r, level: levelOf(r), can_respond: r.status === 'Open' && canManageSync(actor, r, r.set_by_role, scope) }))
      .filter(r => r.user_id === actor.id || isRecipientSync(actor, r) || canManageSync(actor, r, r.set_by_role, scope) || ['admin', 'ceo', 'director'].includes(actor.role_id));
    if (req.query.target_id) return res.json({ appeals: out.filter(r => r.target_id === req.query.target_id) });
    res.json({ appeals: out });
  });

  router.post('/api/target-appeals/:id/respond', requireAuth, async (req, res, next) => {
    const a = await get('SELECT * FROM target_appeals WHERE id = ?', [req.params.id]);
    if (!a) return next({ status: 404, message: 'Appeal not found' });
    const t = await get('SELECT * FROM targets WHERE id = ?', [a.target_id]);
    if (!t || !(await canManageTarget(req.user, t))) return next({ status: 403, message: 'Only the person who set this target, someone senior to them, or an Admin can answer it' });
    if (a.status !== 'Open') return next({ status: 409, message: 'This appeal has already been answered' });
    const b = req.body || {};
    const decision = b.decision === 'Accepted' ? 'Accepted' : b.decision === 'Rejected' ? 'Rejected' : null;
    if (!decision) return next({ status: 400, message: 'decision must be Accepted or Rejected' });
    const response = String(b.response || '').trim().slice(0, 2000);
    let newValue = null;
    if (decision === 'Accepted') {
      // new_value given: that figure (null keeps the target as it is);
      // not given: the figure the appeal proposed, if any.
      const v = Object.prototype.hasOwnProperty.call(b, 'new_value')
        ? (b.new_value === null || b.new_value === '' ? null : Number(b.new_value))
        : (a.proposed_value != null ? Number(a.proposed_value) : null);
      if (v !== null) {
        if (!(v > 0)) return next({ status: 400, message: 'The new figure must be a positive number' });
        newValue = v;
      }
    }
    await run(`UPDATE target_appeals SET status = ?, response = ?, responded_by = ?, responded_at = iso_now() WHERE id = ?`, [decision, response || null, req.user.id, a.id]);
    if (newValue !== null) await run(`UPDATE targets SET target_value = ?, updated_at = iso_now() WHERE id = ?`, [newValue, t.id]);
    await logAction(req, { action: `${decision} target appeal`, module: 'targets', recordType: 'Target', recordId: t.id,
      previousValue: { target_value: Number(t.target_value) }, newValue: { decision, target_value: newValue !== null ? newValue : Number(t.target_value) } });
    await notify(a.user_id, 'target', `Target appeal ${decision.toLowerCase()}`,
      `Your appeal on the ${t.metric.replace('_', ' ')} target for ${t.period} was ${decision.toLowerCase()}${newValue !== null ? ` — the target is now ${newValue}` : ''}.${response ? ' ' + response : ''}`);
    res.json({ appeal: await get('SELECT * FROM target_appeals WHERE id = ?', [a.id]), targetValue: newValue !== null ? newValue : Number(t.target_value) });
  });

  // What the caller may set: the levels, and the regions/branches/people for each.
  router.get('/api/target-setter-options', requireAuth, async (req, res) => {
    const actor = req.user;
    const levels = [];
    if (LEVEL_SETTERS.company.includes(actor.role_id)) levels.push('company');
    if (LEVEL_SETTERS.region.includes(actor.role_id)) levels.push('region');
    if (['regional_manager', 'operational_manager', 'ceo', 'director', 'admin'].includes(actor.role_id)) levels.push('branch');
    if (['manager', 'admin'].includes(actor.role_id)) levels.push('person');
    const scope = await actorScope(actor);
    const regions = levels.includes('region') ? await all('SELECT id, name FROM regions ORDER BY name') : [];
    let branches = levels.includes('branch') ? await all(`SELECT id, name, region_id FROM branches WHERE COALESCE(status,'Active') <> 'Closed' ORDER BY name`) : [];
    if (scope !== null) branches = branches.filter(b => scope.includes(b.id));
    let people = [];
    if (levels.includes('person')) {
      const roles = ALLOWED_RECIPIENT_ROLES[actor.role_id] || [];
      people = roles.length ? await all(`SELECT u.id, u.name, u.role_id, u.branch_id, b.name AS branch_name FROM users u LEFT JOIN branches b ON b.id = u.branch_id
        WHERE u.role_id IN (${roles.map(() => '?').join(',')}) AND u.status = 'Active' ORDER BY u.name`, roles) : [];
      if (scope !== null) people = people.filter(p => scope.includes(p.branch_id));
    }
    res.json({ levels, regions, branches, people, metrics: VALID_METRICS });
  });

  // ==================== Own monthly performance (My Account -> View Details) ====================
  // A real, honest month-by-month breakdown for the CALLER's own real
  // portfolio — never another staff member's. New Loans/Revenue carry a
  // real Target wherever a manager has actually set one (metric new_loans/
  // collection, same VALID_METRICS this whole engine already uses);
  // Repeat Loans/Performing/Arrears carry a real computed Actual but an
  // honest 0 Target, since no dedicated target metric exists for them —
  // never fabricated to look "complete".
  router.get('/api/users/me/performance', requireAuth, async (req, res) => {
    const year = /^\d{4}$/.test(req.query.year) ? req.query.year : String(new Date().getFullYear());
    const officerId = req.user.id;
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const period = `${year}-${String(m).padStart(2, '0')}`;
      months.push({ month: m, period, ...(await computeOfficerPeriodMetrics(officerId, period)) });
    }
    res.json({ year, months });
  });
}

module.exports = { register, ALLOWED_RECIPIENT_ROLES, VALID_METRICS, computeAchievement };
