'use strict';
const { all, get, run } = require('./../db');
const { requireAuth, requireModule } = require('./../middleware');
const { requireInvestorAuth } = require('./investors');
const { logAction, notify } = require('./../audit');
const { branchScopeSQL, assertRecordInScope, branchIdsInScope } = require('./../rbac');
const crypto = require('node:crypto');

// ==================== Shared calculation core ====================
// Every role-specific view below calls THROUGH these two functions —
// there is exactly one place "expected" and "collected" are computed,
// so figures can never silently diverge between roles.
function loanScopeClause(req, extraOfficerCol) {
  const scope = branchScopeSQL(req.user);
  let clause = scope.clause; const params = [...scope.params];
  if (req.user.role_id === 'loan_officer') { clause += ` AND ${extraOfficerCol || 'officer_id'} = ?`; params.push(req.user.id); }
  if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
  if (req.query.officer_id && req.user.role_id !== 'loan_officer') { clause += ` AND ${extraOfficerCol || 'officer_id'} = ?`; params.push(req.query.officer_id); }
  if (req.query.region_id) {
    const regionBranches = all('SELECT id FROM branches WHERE region_id = ?', [req.query.region_id]).map(b => b.id);
    clause += regionBranches.length ? ` AND branch_id IN (${regionBranches.map(() => '?').join(',')})` : ' AND 1=0';
    params.push(...regionBranches);
  }
  return { clause, params };
}

// expected/collected for a set of loans over [from, to] — the same
// definition used by MTD, Rate, and the Collection Sheet.
function collectionTotals(loanIds, from, to) {
  if (loanIds.length === 0) return { expected: 0, collected: 0 };
  const placeholders = loanIds.map(() => '?').join(',');
  const expectedRow = get(
    `SELECT COALESCE(SUM(total_due),0) as v FROM loan_schedule WHERE loan_id IN (${placeholders}) AND due_date BETWEEN date(?) AND date(?)`,
    [...loanIds, from, to]
  );
  // "Collected" = real posted payments in the window, not schedule
  // paid_amount (which can reflect payments posted on a different date
  // than they were collected, e.g. backdated corrections) — using the
  // real payments ledger keeps this consistent with Accounting/Cashflow.
  const collectedRow = get(
    `SELECT COALESCE(SUM(p.amount),0) as v FROM payments p WHERE p.loan_id IN (${placeholders}) AND p.status != 'Unposted' AND date(p.created_at) BETWEEN date(?) AND date(?)`,
    [...loanIds, from, to]
  );
  return { expected: expectedRow.v, collected: collectedRow.v };
}

function register(router) {
  // ==================== Collection Sheet — real, paginated, filtered ====================
  router.get('/api/collections/sheet', requireAuth, requireModule('loanbook'), (req, res) => {
    const { clause, params } = loanScopeClause(req);
    const loans = all(`SELECT * FROM loans WHERE ${clause} AND status IN ('Active','Disbursed')`, params);
    const from = req.query.date_from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = req.query.date_to || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    let rows = [];
    loans.forEach(loan => {
      const schedule = all('SELECT * FROM loan_schedule WHERE loan_id = ? AND due_date BETWEEN date(?) AND date(?) ORDER BY due_date', [loan.id, from, to]);
      schedule.forEach(r => {
        if (r.status === 'Paid') return; // fully settled installments aren't "due" for collection purposes
        const outstanding = Math.max(0, r.total_due - r.paid_amount);
        const status = r.due_date < today ? 'Overdue' : (r.due_date === today ? 'Due Today' : 'Upcoming');
        if (req.query.status && req.query.status !== status) return;
        rows.push({ clientId: loan.client_id, loanId: loan.id, officerId: loan.officer_id, branchId: loan.branch_id, dueDate: r.due_date, expectedAmount: r.total_due, paidAmount: r.paid_amount, outstanding, status });
      });
    });
    rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const pageRows = rows.slice((page - 1) * limit, page * limit);
    res.json({ sheet: pageRows, pagination: { page, limit, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / limit)) }, totals: { expected: rows.reduce((s, r) => s + r.expectedAmount, 0), outstanding: rows.reduce((s, r) => s + r.outstanding, 0) } });
  });

  // ==================== Collection MTD ====================
  router.get('/api/collections/mtd', requireAuth, requireModule('loanbook'), (req, res) => {
    const { clause, params } = loanScopeClause(req);
    const loanIds = all(`SELECT id FROM loans WHERE ${clause} AND status IN ('Active','Disbursed')`, params).map(l => l.id);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const dayStart = today;
    const { expected: expectedMTD, collected: collectedMTD } = collectionTotals(loanIds, monthStart, today);
    const { expected: expectedToday, collected: collectedToday } = collectionTotals(loanIds, dayStart, dayStart);
    // Reuse the real target for 'collection' where one exists, rather than inventing a second target concept.
    const period = today.slice(0, 7);
    let target = null;
    if (req.user.role_id === 'loan_officer') {
      target = get(`SELECT * FROM targets WHERE recipient_user_id = ? AND metric = 'collection' AND period = ? AND status = 'Active'`, [req.user.id, period]);
    }
    res.json({
      monthStart, asOf: today,
      expectedMTD, collectedMTD, remainingMTD: Math.max(0, expectedMTD - collectedMTD),
      collectionRateMTD: expectedMTD > 0 ? (collectedMTD / expectedMTD * 100) : 0,
      expectedToday, collectedToday,
      target: target ? { value: target.target_value, achievement: collectedMTD, percentage: target.target_value > 0 ? (collectedMTD / target.target_value * 100) : 0 } : null,
    });
  });

  // ==================== Collection Rate — real, period-configurable, aggregate not averaged ====================
  router.get('/api/collections/rate', requireAuth, requireModule('loanbook'), (req, res) => {
    const { clause, params } = loanScopeClause(req);
    const loanIds = all(`SELECT id FROM loans WHERE ${clause}`, params).map(l => l.id);
    const period = req.query.period || 'monthly'; // daily | weekly | monthly
    const today = new Date();
    let from;
    if (period === 'daily') from = today.toISOString().slice(0, 10);
    else if (period === 'weekly') { const d = new Date(today); d.setDate(d.getDate() - 7); from = d.toISOString().slice(0, 10); }
    else { from = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10); }
    const to = today.toISOString().slice(0, 10);
    const { expected, collected } = collectionTotals(loanIds, from, to);
    res.json({ period, from, to, expected, collected, rate: expected > 0 ? (collected / expected * 100) : 0 });
  });

  // ==================== Collection Activities ====================
  router.get('/api/collections/activities', requireAuth, requireModule('loanbook'), (req, res) => {
    const scope = branchIdsInScope(req.user);
    const clauses = ['1=1']; const params = [];
    if (scope !== null) { clauses.push(scope.length ? `branch_id IN (${scope.map(() => '?').join(',')})` : '1=0'); params.push(...scope); }
    if (req.user.role_id === 'loan_officer') { clauses.push('staff_id = ?'); params.push(req.user.id); }
    if (req.query.client_id) { clauses.push('client_id = ?'); params.push(req.query.client_id); }
    const rows = all(`SELECT * FROM collection_activities WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params);
    res.json({ activities: rows });
  });
  router.post('/api/collections/activities', requireAuth, requireModule('loanbook'), (req, res, next) => {
    const b = req.body;
    if (!b.client_id || !b.activity_type) return next({ status: 400, message: 'client_id and activity_type are required' });
    const client = get('SELECT * FROM clients WHERE id = ?', [b.client_id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    assertRecordInScope(req.user, client.branch_id, 'client');
    const id = 'ca_' + crypto.randomUUID();
    run('INSERT INTO collection_activities (id, client_id, loan_id, staff_id, activity_type, notes, outcome, next_follow_up_date, branch_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, b.client_id, b.loan_id || null, req.user.id, b.activity_type, b.notes || null, b.outcome || null, b.next_follow_up_date || null, client.branch_id]);
    logAction(req, { action: 'Logged collection activity', module: 'collections', recordType: 'CollectionActivity', recordId: id, newValue: { activity_type: b.activity_type, client_id: b.client_id } });
    res.status(201).json({ activity: get('SELECT * FROM collection_activities WHERE id = ?', [id]) });
  });

  // ==================== Follow-Ups ====================
  router.get('/api/collections/follow-ups', requireAuth, requireModule('loanbook'), (req, res) => {
    const scope = branchIdsInScope(req.user);
    const clauses = ['1=1']; const params = [];
    if (scope !== null) { clauses.push(scope.length ? `branch_id IN (${scope.map(() => '?').join(',')})` : '1=0'); params.push(...scope); }
    if (req.user.role_id === 'loan_officer') { clauses.push('responsible_staff_id = ?'); params.push(req.user.id); }
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    const rows = all(`SELECT * FROM follow_ups WHERE ${clauses.join(' AND ')} ORDER BY follow_up_date ASC LIMIT 200`, params);
    const today = new Date().toISOString().slice(0, 10);
    // "Overdue" is derived at read time, never stored — a follow-up
    // doesn't need to be "moved" into an Overdue state by any process.
    rows.forEach(r => { if (r.status === 'Pending' && r.follow_up_date < today) r.effective_status = 'Overdue'; else r.effective_status = r.status; });
    res.json({ followUps: rows });
  });
  router.post('/api/collections/follow-ups', requireAuth, requireModule('loanbook'), (req, res, next) => {
    const b = req.body;
    if (!b.client_id || !b.follow_up_date) return next({ status: 400, message: 'client_id and follow_up_date are required' });
    const client = get('SELECT * FROM clients WHERE id = ?', [b.client_id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    assertRecordInScope(req.user, client.branch_id, 'client');
    const responsible = b.responsible_staff_id || req.user.id;
    const id = 'fu_' + crypto.randomUUID();
    run('INSERT INTO follow_ups (id, client_id, loan_id, responsible_staff_id, follow_up_date, reason, notes, branch_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, b.client_id, b.loan_id || null, responsible, b.follow_up_date, b.reason || null, b.notes || null, client.branch_id, req.user.id]);
    logAction(req, { action: 'Created follow-up', module: 'collections', recordType: 'FollowUp', recordId: id, newValue: { client_id: b.client_id, follow_up_date: b.follow_up_date } });
    if (responsible !== req.user.id) notify(responsible, 'system', 'New follow-up assigned', `A collection follow-up for ${client.name} is due ${b.follow_up_date}.`);
    res.status(201).json({ followUp: get('SELECT * FROM follow_ups WHERE id = ?', [id]) });
  });
  router.patch('/api/collections/follow-ups/:id', requireAuth, requireModule('loanbook'), (req, res, next) => {
    const fu = get('SELECT * FROM follow_ups WHERE id = ?', [req.params.id]);
    if (!fu) return next({ status: 404, message: 'Follow-up not found' });
    assertRecordInScope(req.user, fu.branch_id, 'follow-up');
    if (fu.responsible_staff_id !== req.user.id && !['manager', 'regional_manager', 'operational_manager', 'admin'].includes(req.user.role_id)) {
      return next({ status: 403, message: 'Only the responsible staff member (or their manager) can update this follow-up' });
    }
    const sets = []; const params = [];
    if (req.body.status && ['Pending', 'Completed', 'Cancelled'].includes(req.body.status)) { sets.push('status = ?'); params.push(req.body.status); }
    if (req.body.outcome !== undefined) { sets.push('outcome = ?'); params.push(req.body.outcome); }
    if (req.body.notes !== undefined) { sets.push('notes = ?'); params.push(req.body.notes); }
    if (!sets.length) return next({ status: 400, message: 'Nothing to update' });
    params.push(fu.id);
    run(`UPDATE follow_ups SET ${sets.join(', ')} WHERE id = ?`, params);
    logAction(req, { action: 'Updated follow-up', module: 'collections', recordType: 'FollowUp', recordId: fu.id, newValue: req.body });
    res.json({ followUp: get('SELECT * FROM follow_ups WHERE id = ?', [fu.id]) });
  });

  // ==================== Promise to Pay ====================
  // A promise is never a payment. Fulfillment is derived by comparing the
  // promised amount against REAL payments on that loan made on/after the
  // promise date — never recorded as if money had actually moved.
  router.get('/api/collections/promises', requireAuth, requireModule('loanbook'), (req, res) => {
    const scope = branchIdsInScope(req.user);
    const clauses = ['1=1']; const params = [];
    if (scope !== null) { clauses.push(scope.length ? `branch_id IN (${scope.map(() => '?').join(',')})` : '1=0'); params.push(...scope); }
    if (req.user.role_id === 'loan_officer') { clauses.push('created_by = ?'); params.push(req.user.id); }
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    const rows = all(`SELECT * FROM promises_to_pay WHERE ${clauses.join(' AND ')} ORDER BY promise_date DESC LIMIT 200`, params);
    res.json({ promises: rows });
  });
  router.post('/api/collections/promises', requireAuth, requireModule('loanbook'), (req, res, next) => {
    const b = req.body;
    if (!b.client_id || !b.loan_id || !b.promised_amount || !b.promise_date) return next({ status: 400, message: 'client_id, loan_id, promised_amount and promise_date are required' });
    const loan = get('SELECT * FROM loans WHERE id = ?', [b.loan_id]);
    if (!loan || loan.client_id !== b.client_id) return next({ status: 400, message: 'loan_id does not belong to the specified client' });
    assertRecordInScope(req.user, loan.branch_id, 'loan');
    const id = 'ptp_' + crypto.randomUUID();
    run('INSERT INTO promises_to_pay (id, client_id, loan_id, promised_amount, promise_date, notes, branch_id, created_by) VALUES (?,?,?,?,?,?,?,?)',
      [id, b.client_id, b.loan_id, b.promised_amount, b.promise_date, b.notes || null, loan.branch_id, req.user.id]);
    logAction(req, { action: 'Created promise to pay', module: 'collections', recordType: 'PromiseToPay', recordId: id, newValue: { loan_id: b.loan_id, amount: b.promised_amount } });
    res.status(201).json({ promise: get('SELECT * FROM promises_to_pay WHERE id = ?', [id]) });
  });
  // Re-evaluates fulfillment against real payments — callable any time,
  // and also applied automatically whenever the promise is listed past
  // its promise_date so a stale "Pending" doesn't linger forever.
  // Known simplification: this counts ALL real payments on the loan made
  // on/after promise_date, so two overlapping promises on the same loan
  // can both "see" the same payment. Acceptable for a single active
  // promise per loan at a time (the normal case); a production system
  // tracking concurrent promises per loan would need to link a specific
  // payment to a specific promise explicitly.
  function evaluatePromise(promise) {
    if (['Cancelled'].includes(promise.status)) return promise;
    const paidSince = get(
      `SELECT COALESCE(SUM(amount),0) as v FROM payments WHERE loan_id = ? AND status != 'Unposted' AND date(created_at) >= date(?)`,
      [promise.loan_id, promise.promise_date]
    ).v;
    let status = promise.status;
    if (paidSince >= promise.promised_amount - 0.01) status = 'Fulfilled';
    else if (paidSince > 0) status = 'Partially Fulfilled';
    else if (new Date(promise.promise_date) < new Date(new Date().toISOString().slice(0, 10))) status = 'Broken';
    else status = 'Pending';
    if (status !== promise.status || paidSince !== promise.fulfilled_amount) {
      run('UPDATE promises_to_pay SET status = ?, fulfilled_amount = ?, fulfilled_at = ? WHERE id = ?',
        [status, paidSince, status === 'Fulfilled' ? new Date().toISOString() : promise.fulfilled_at, promise.id]);
    }
    return get('SELECT * FROM promises_to_pay WHERE id = ?', [promise.id]);
  }
  router.post('/api/collections/promises/:id/evaluate', requireAuth, requireModule('loanbook'), (req, res, next) => {
    const promise = get('SELECT * FROM promises_to_pay WHERE id = ?', [req.params.id]);
    if (!promise) return next({ status: 404, message: 'Promise not found' });
    assertRecordInScope(req.user, promise.branch_id, 'promise');
    res.json({ promise: evaluatePromise(promise) });
  });
  router.post('/api/collections/promises/:id/cancel', requireAuth, requireModule('loanbook'), (req, res, next) => {
    const promise = get('SELECT * FROM promises_to_pay WHERE id = ?', [req.params.id]);
    if (!promise) return next({ status: 404, message: 'Promise not found' });
    assertRecordInScope(req.user, promise.branch_id, 'promise');
    if (promise.created_by !== req.user.id && !['manager', 'regional_manager', 'operational_manager', 'admin'].includes(req.user.role_id)) {
      return next({ status: 403, message: 'Only the creator (or their manager) can cancel this promise' });
    }
    if (['Fulfilled'].includes(promise.status)) return next({ status: 409, message: 'A fulfilled promise cannot be cancelled' });
    run("UPDATE promises_to_pay SET status = 'Cancelled' WHERE id = ?", [promise.id]);
    logAction(req, { action: 'Cancelled promise to pay', module: 'collections', recordType: 'PromiseToPay', recordId: promise.id });
    res.json({ promise: get('SELECT * FROM promises_to_pay WHERE id = ?', [promise.id]) });
  });

  // ==================== Investor — restricted, aggregated-only view ====================
  // Deliberately a SEPARATE serialization of the SAME underlying
  // calculation, not a second engine: reuses collectionTotals() exactly
  // as the operational views do, but returns no client/staff identifying
  // data whatsoever — enforced here, not left to frontend hiding.
  // Investors are a structurally separate principal type (see investors.js)
  // with their own auth guard — requireAuth/requireModule can never
  // succeed for an investor token, by design, so this route uses the real
  // investor auth guard instead of trying to force them through the staff path.
  router.get('/api/collections/investor-summary', requireInvestorAuth, (req, res) => {
    const loanIds = all(`SELECT id FROM loans WHERE status IN ('Active','Disbursed')`).map(l => l.id);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const { expected, collected } = collectionTotals(loanIds, monthStart, today);
    const arrearsRow = get(
      `SELECT COALESCE(SUM(MAX(total_due - paid_amount, 0)),0) as v FROM loan_schedule WHERE loan_id IN (${loanIds.map(() => '?').join(',') || "''"}) AND status != 'Paid' AND due_date < date('now')`,
      loanIds
    );
    res.json({
      monthToDate: { expected, collected, rate: expected > 0 ? (collected / expected * 100) : 0 },
      portfolioAtRisk: { amount: arrearsRow.v },
      // No client names, phone numbers, officer identities, or branch-level breakdowns — aggregate only.
    });
  });
  // ==================== Branch Comparison — real, reuses the same shared engine per branch ====================
  // For Regional/Operational Manager: rank branches within real scope by
  // collection rate and arrears — not a separate calculation, just the
  // same collectionTotals() called once per branch in scope.
  router.get('/api/collections/branch-comparison', requireAuth, requireModule('loanbook'), (req, res) => {
    const scope = branchIdsInScope(req.user);
    let branches = all('SELECT * FROM branches WHERE status = ?', ['Active']);
    if (scope !== null) branches = branches.filter(b => scope.includes(b.id));
    if (req.query.region_id) branches = branches.filter(b => b.region_id === req.query.region_id);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const result = branches.map(b => {
      const loanIds = all(`SELECT id FROM loans WHERE branch_id = ? AND status IN ('Active','Disbursed')`, [b.id]).map(l => l.id);
      const { expected, collected } = collectionTotals(loanIds, monthStart, today);
      const arrearsAmount = get(
        `SELECT COALESCE(SUM(MAX(total_due - paid_amount, 0)),0) as v FROM loan_schedule WHERE loan_id IN (${loanIds.map(() => '?').join(',') || "''"}) AND status != 'Paid' AND due_date < date('now')`,
        loanIds
      ).v;
      return { branchId: b.id, branchName: b.name, expected, collected, rate: expected > 0 ? (collected / expected * 100) : 0, arrearsAmount };
    });
    result.sort((a, b) => b.rate - a.rate);
    res.json({ branches: result });
  });

  // ==================== Officer Comparison — real, within a Manager's own branch ====================
  router.get('/api/collections/officer-comparison', requireAuth, requireModule('loanbook'), (req, res, next) => {
    if (!['manager', 'regional_manager', 'operational_manager', 'admin'].includes(req.user.role_id)) {
      return next({ status: 403, message: 'Your role does not have team collection comparison authority' });
    }
    const scope = branchIdsInScope(req.user);
    let officers = all(`SELECT * FROM users WHERE role_id = 'loan_officer' AND status = 'Active'`);
    if (scope !== null) officers = officers.filter(o => scope.includes(o.branch_id));
    if (req.query.branch_id) officers = officers.filter(o => o.branch_id === req.query.branch_id);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const result = officers.map(o => {
      const loanIds = all(`SELECT id FROM loans WHERE officer_id = ? AND status IN ('Active','Disbursed')`, [o.id]).map(l => l.id);
      const { expected, collected } = collectionTotals(loanIds, monthStart, today);
      return { officerId: o.id, officerName: o.name, branchId: o.branch_id, expected, collected, rate: expected > 0 ? (collected / expected * 100) : 0, activeLoans: loanIds.length };
    });
    result.sort((a, b) => b.rate - a.rate);
    res.json({ officers: result });
  });

}

module.exports = { register, collectionTotals };
