'use strict';
const { all, get, run, transaction } = require('./../db');
const { requireAuth, requireModule, requirePermission } = require('./../middleware');
const { logAction, notify } = require('./../audit');
const { branchIdsInScope, assertRecordInScope, isBranchAllowed } = require('./../rbac');
const { tokenHash } = require('./../crypto');
const crypto = require('node:crypto');

// The one place the debit/credit sign convention is interpreted when
// reading balances back out. Must stay consistent with how every route
// posts entries (see payments.js / loans.js): DEBIT increases Asset and
// Expense accounts; CREDIT increases Liability, Equity and Revenue accounts.
// branchIds === null means company-wide; an array scopes the sum to those
// branches' postings only.
async function ledgerBalance(accountId, branchIds) {
  const account = await get('SELECT * FROM gl_accounts WHERE id = ?', [accountId]);
  let sql = 'SELECT COALESCE(SUM(debit),0) as d, COALESCE(SUM(credit),0) as c FROM journal_entries WHERE account_id = ?';
  const params = [accountId];
  if (branchIds !== null && branchIds !== undefined) {
    if (branchIds.length === 0) { sql += ' AND 1=0'; }
    else { sql += ` AND branch_id IN (${branchIds.map(() => '?').join(',')})`; params.push(...branchIds); }
  }
  const row = await get(sql, params);
  const increasesOnDebit = !account || ['Asset', 'Expense'].includes(account.account_type);
  return increasesOnDebit ? row.d - row.c : row.c - row.d;
}

// Resolves the real scope for the CURRENT user, honoring an explicit
// ?branch_id=/&region_id= request only when it's actually within what
// they're allowed to see — never letting a query parameter widen access.
async function resolveScopeForRequest(req) {
  const userScope = await branchIdsInScope(req.user); // null = company-wide authority
  if (req.query.branch_id) {
    if (userScope !== null && !userScope.includes(req.query.branch_id)) return [];
    return [req.query.branch_id];
  }
  if (req.query.region_id) {
    const regionBranchRows = await all('SELECT id FROM branches WHERE region_id = ?', [req.query.region_id]);
    const regionBranches = regionBranchRows.map(b => b.id);
    if (userScope === null) return regionBranches;
    return regionBranches.filter(b => userScope.includes(b));
  }
  return userScope;
}

const EXPENSE_APPROVAL_ROLES = ['accountant', 'admin', 'ceo', 'director'];

// ==================== Accounting Periods ====================
// A period with no row here is implicitly Open — most months will never
// need an explicit row, only the ones someone has deliberately closed.
function periodKeyFor(dateStr) { return (dateStr || new Date().toISOString()).slice(0, 7); }
async function assertPeriodOpen(dateStr) {
  const key = periodKeyFor(dateStr);
  const period = await get('SELECT * FROM accounting_periods WHERE id = ?', [key]);
  if (period && period.status === 'Closed') {
    const err = new Error(`Accounting period ${key} is closed — this cannot be posted without reopening it first`);
    err.status = 409;
    throw err;
  }
}

// Real, shared PAR calculation — extracted so Reports (and anything else)
// reuses this exact function rather than recalculating PAR a second way.
// `scope` is the same real branch-id array (or null for company-wide)
// resolveScopeForRequest()/branchIdsInScope() already produce elsewhere.
async function computePAR(scope) {
  const loanScope = scope === null ? '1=1' : (scope.length === 0 ? '1=0' : `l.branch_id IN (${scope.map(() => '?').join(',')})`);
  const params = scope !== null ? [...scope] : [];
  const loans = await all(
    `SELECT l.id, l.branch_id FROM loans l WHERE ${loanScope} AND l.status IN ('Active','Disbursed')`, params
  );
  const thresholds = [1, 7, 30, 60, 90];
  const today = new Date().toISOString().slice(0, 10);
  let totalOutstanding = 0;
  const parAmounts = Object.fromEntries(thresholds.map(t => [t, 0]));
  for (const loan of loans) {
    const rows = await all('SELECT * FROM loan_schedule WHERE loan_id = ?', [loan.id]);
    const outstanding = rows.reduce((s, r) => s + Math.max(0, r.total_due - r.paid_amount), 0);
    totalOutstanding += outstanding;
    const maxOverdueDays = rows.reduce((max, r) => {
      if (r.paid_amount >= r.total_due - 0.01) return max;
      const days = Math.floor((new Date(today) - new Date(r.due_date)) / 86400000);
      return Math.max(max, days);
    }, -Infinity);
    thresholds.forEach(t => { if (maxOverdueDays >= t) parAmounts[t] += outstanding; });
  }
  const par = thresholds.map(t => ({ threshold: t, amount: parAmounts[t], percentage: totalOutstanding > 0 ? (parAmounts[t] / totalOutstanding * 100) : 0 }));
  return { asOf: today, totalOutstanding, par, formula: 'PAR-N = outstanding principal of loans with any installment N+ days overdue / total outstanding principal' };
}

function register(router) {
  // ==================== Expenses — real Pending -> Approved -> Paid / Rejected workflow ====================
  router.get('/api/expenses', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await resolveScopeForRequest(req);
    const clauses = ['1=1']; const params = [];
    if (scope !== null) {
      if (scope.length === 0) clauses.push('1=0');
      else { clauses.push(`branch_id IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
    }
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    if (req.query.category) { clauses.push('category = ?'); params.push(req.query.category); }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const where = `WHERE ${clauses.join(' AND ')}`;
    const agg = await get(`SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as total FROM expenses ${where}`, params);
    const rows = await all(`SELECT * FROM expenses ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    res.json({ expenses: rows, pagination: { page, limit, total: agg.cnt, totalPages: Math.max(1, Math.ceil(agg.cnt / limit)) }, totals: { count: agg.cnt, amount: agg.total } });
  });

  // Submission is deliberately broad (any authenticated accounting-module
  // user can submit) — the real authority boundary is at approve/pay, not
  // at "can this person even ask for something."
  router.post('/api/expenses', requireAuth, requireModule('accounting'), async (req, res, next) => {
    const b = req.body;
    if (!b.category || !b.amount || b.amount <= 0) return next({ status: 400, message: 'category and a positive amount are required' });
    const scopeIsCompanyWide = (await branchIdsInScope(req.user)) === null;
    const branchId = b.branch_id && (scopeIsCompanyWide || (await isBranchAllowed(req.user, b.branch_id))) ? b.branch_id : req.user.branch_id;
    const id = 'exp_' + crypto.randomUUID();
    await run('INSERT INTO expenses (id, category, amount, note, branch_id, status, submitted_by) VALUES (?,?,?,?,?,?,?)',
      [id, b.category, b.amount, b.note || null, branchId || null, 'Pending', req.user.id]);
    await logAction(req, { action: 'Submitted expense', module: 'accounting', recordType: 'Expense', recordId: id, newValue: { category: b.category, amount: b.amount } });
    res.status(201).json({ expense: await get('SELECT * FROM expenses WHERE id = ?', [id]) });
  });

  router.post('/api/expenses/:id/approve', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const exp = await get('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
    if (!exp) return next({ status: 404, message: 'Expense not found' });
    try { await assertRecordInScope(req.user, exp.branch_id, 'expense'); } catch (e) { return next(e); }
    if (exp.status !== 'Pending') return next({ status: 409, message: `Cannot approve an expense in ${exp.status} status` });
    await run('UPDATE expenses SET status = ?, approved_by = ? WHERE id = ?', ['Approved', req.user.id, exp.id]);
    await logAction(req, { action: 'Approved expense', module: 'accounting', recordType: 'Expense', recordId: exp.id });
    if (exp.submitted_by) await notify(exp.submitted_by, 'system', 'Expense approved', `Your ${exp.category} expense (${exp.amount}) was approved.`);
    res.json({ expense: await get('SELECT * FROM expenses WHERE id = ?', [exp.id]) });
  });

  router.post('/api/expenses/:id/reject', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const exp = await get('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
    if (!exp) return next({ status: 404, message: 'Expense not found' });
    try { await assertRecordInScope(req.user, exp.branch_id, 'expense'); } catch (e) { return next(e); }
    if (!['Pending', 'Approved'].includes(exp.status)) return next({ status: 409, message: `Cannot reject an expense in ${exp.status} status` });
    await run('UPDATE expenses SET status = ?, rejection_reason = ? WHERE id = ?', ['Rejected', req.body.reason || null, exp.id]);
    await logAction(req, { action: 'Rejected expense', module: 'accounting', recordType: 'Expense', recordId: exp.id, reason: req.body.reason });
    if (exp.submitted_by) await notify(exp.submitted_by, 'system', 'Expense rejected', `Your ${exp.category} expense (${exp.amount}) was rejected.${req.body.reason ? ' Reason: ' + req.body.reason : ''}`);
    res.json({ expense: await get('SELECT * FROM expenses WHERE id = ?', [exp.id]) });
  });

  // Paying is the one moment a real, balanced journal entry is created —
  // not at submission. This also fixes a real prior bug: expenses used to
  // post to the ledger immediately on creation, with no approval gate at
  // all despite the schema already anticipating Pending/Approved/Paid.
  router.post('/api/expenses/:id/pay', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const exp = await get('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
    if (!exp) return next({ status: 404, message: 'Expense not found' });
    try { await assertRecordInScope(req.user, exp.branch_id, 'expense'); } catch (e) { return next(e); }
    if (exp.status !== 'Approved') return next({ status: 409, message: 'Only an Approved expense can be paid' });
    try { await assertPeriodOpen(); } catch (e) { return next(e); }
    const fundingAccount = (req.body.account_id && (await get('SELECT id FROM gl_accounts WHERE id = ?', [req.body.account_id]))) ? req.body.account_id : 'bank';
    await transaction(async () => {
      await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('operating_expense', ?, 0, ?, 'expense', ?, ?, ?)`,
        [exp.amount, `${exp.category} — ${exp.note || ''}`, exp.id, exp.branch_id, req.user.id]);
      await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES (?, 0, ?, ?, 'expense', ?, ?, ?)`,
        [fundingAccount, exp.amount, `${exp.category} — ${exp.note || ''}`, exp.id, exp.branch_id, req.user.id]);
      await run('UPDATE expenses SET status = ?, paid_by = ? WHERE id = ?', ['Paid', req.user.id, exp.id]);
    });
    await logAction(req, { action: 'Paid expense', module: 'accounting', recordType: 'Expense', recordId: exp.id, newValue: { account: fundingAccount } });
    res.json({ expense: await get('SELECT * FROM expenses WHERE id = ?', [exp.id]) });
  });

  // ==================== Requisitions — Submit -> Manager approval -> Accountant pays ====================
  router.get('/api/requisitions', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await resolveScopeForRequest(req);
    const clauses = ['1=1']; const params = [];
    if (scope !== null) {
      if (scope.length === 0) clauses.push('1=0');
      else { clauses.push(`branch_id IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
    }
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    if (req.query.from) { clauses.push('(created_at)::date >= ?'); params.push(req.query.from); }
    if (req.query.to) { clauses.push('(created_at)::date <= ?'); params.push(req.query.to); }
    const rows = await all(`SELECT * FROM requisitions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params);
    const reqIds = rows.map(r => r.id);
    let itemsByReq = {};
    if (reqIds.length) {
      const ph = reqIds.map(() => '?').join(',');
      (await all(`SELECT * FROM requisition_items WHERE requisition_id IN (${ph})`, reqIds)).forEach(it => {
        if (!itemsByReq[it.requisition_id]) itemsByReq[it.requisition_id] = [];
        itemsByReq[it.requisition_id].push(it);
      });
    }
    res.json({ requisitions: rows.map(r => ({ ...r, items: itemsByReq[r.id] || [] })) });
  });

  // Real, short-lived OTP requirement before a requisition can be created —
  // the submitting staff member must confirm the request via a code sent
  // to their own real phone number (see integrations/sms.js). SMS delivery
  // honestly reports NOT_CONFIGURED where no real provider is set up — in
  // that case (and only that case) the real generated code is returned
  // directly in this response instead of being silently unreachable, since
  // there is no other channel to deliver it through in that state.
  router.post('/api/requisitions/request-otp', requireAuth, requireModule('accounting'), async (req, res, next) => {
    if (!req.user.phone) return next({ status: 400, message: 'Your account has no phone number on file to send an OTP to' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const id = 'rotp_' + crypto.randomUUID();
    await run(`INSERT INTO requisition_otps (id, user_id, code_hash, expires_at) VALUES (?,?,?, iso_offset(interval '5 minutes'))`,
      [id, req.user.id, tokenHash(code)]);
    const sms = require('./../integrations/sms');
    let result;
    try { result = await sms.send('requisition_otp', req.user.phone, { code }); }
    catch (e) { result = { status: 'FAILED' }; }
    res.json({
      status: result.status,
      ...(result.status === 'NOT_CONFIGURED' ? { otpForTesting: code, note: 'SMS is not configured in this environment — the real code is returned here instead of being silently unreachable.' } : {}),
    });
  });

  router.post('/api/requisitions', requireAuth, requireModule('accounting'), async (req, res, next) => {
    const b = req.body;
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return next({ status: 400, message: 'At least one item is required' });
    for (const it of items) {
      if (!it.description || !it.qty || it.qty <= 0 || !it.unit_cost || it.unit_cost <= 0) {
        return next({ status: 400, message: 'Each item needs a description, a positive qty, and a positive unit_cost' });
      }
    }
    if (!b.expense_account_id) return next({ status: 400, message: 'expense_account_id is required' });
    const account = await get(`SELECT id FROM gl_accounts WHERE id = ? AND account_type = 'Expense'`, [b.expense_account_id]);
    if (!account) return next({ status: 400, message: 'expense_account_id must be a real Expense account' });
    if (!b.otp_code) return next({ status: 400, message: 'otp_code is required' });
    const otp = await get(
      `SELECT * FROM requisition_otps WHERE user_id = ? AND code_hash = ? AND used = 0 AND expires_at > iso_now() ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, tokenHash(String(b.otp_code))]
    );
    if (!otp) return next({ status: 400, message: 'Invalid or expired OTP code', code: 'INVALID_OTP' });

    const amount = items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_cost), 0);
    const id = 'req_' + crypto.randomUUID();
    await transaction(async () => {
      await run('UPDATE requisition_otps SET used = 1 WHERE id = ?', [otp.id]);
      await run('INSERT INTO requisitions (id, category, amount, description, branch_id, status, submitted_by, expense_account_id) VALUES (?,?,?,?,?,?,?,?)',
        [id, items[0].category || account.id, amount, b.description || null, req.user.branch_id || null, 'Pending', req.user.id, b.expense_account_id]);
      for (const it of items) {
        await run('INSERT INTO requisition_items (id, requisition_id, description, category, qty, unit_cost) VALUES (?,?,?,?,?,?)',
          ['reqi_' + crypto.randomUUID(), id, it.description, it.category || null, it.qty, it.unit_cost]);
      }
    });
    await logAction(req, { action: 'Submitted requisition', module: 'accounting', recordType: 'Requisition', recordId: id, newValue: { amount, itemCount: items.length } });
    const created = await get('SELECT * FROM requisitions WHERE id = ?', [id]);
    const createdItems = await all('SELECT * FROM requisition_items WHERE requisition_id = ?', [id]);
    res.status(201).json({ requisition: { ...created, items: createdItems } });
  });

  // Manager approves within their own branch (and Regional/Operational/
  // Accountant/Admin/CEO/Director within their own real scope) — reuses
  // the same branch/region scope check as everything else here.
  router.post('/api/requisitions/:id/decide', requireAuth, async (req, res, next) => {
    const reqn = await get('SELECT * FROM requisitions WHERE id = ?', [req.params.id]);
    if (!reqn) return next({ status: 404, message: 'Requisition not found' });
    const decision = req.body.decision;
    if (!['Approved', 'Rejected', 'Returned'].includes(decision)) return next({ status: 400, message: 'decision must be Approved, Rejected, or Returned' });
    if (reqn.status !== 'Pending') return next({ status: 409, message: `Cannot decide on a requisition in ${reqn.status} status` });
    const canDecide = ['manager', 'regional_manager', 'operational_manager', 'accountant', 'admin', 'ceo', 'director'].includes(req.user.role_id);
    if (!canDecide) return next({ status: 403, message: 'You are not authorized to decide on requisitions' });
    try { await assertRecordInScope(req.user, reqn.branch_id, 'requisition'); } catch (e) { return next(e); }
    await run("UPDATE requisitions SET status = ?, approved_by = ?, approved_at = iso_now(), decision_reason = ? WHERE id = ?",
      [decision, req.user.id, req.body.reason || null, reqn.id]);
    await logAction(req, { action: `Requisition ${decision.toLowerCase()}`, module: 'accounting', recordType: 'Requisition', recordId: reqn.id, reason: req.body.reason });
    if (reqn.submitted_by) await notify(reqn.submitted_by, 'system', `Requisition ${decision.toLowerCase()}`, `Your ${reqn.category} requisition (${reqn.amount}) was ${decision.toLowerCase()}.`);
    res.json({ requisition: await get('SELECT * FROM requisitions WHERE id = ?', [reqn.id]) });
  });

  // Accountant/Admin turns an Approved requisition into a real, paid
  // expense — one real financial-record mechanism, not two.
  router.post('/api/requisitions/:id/pay', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const reqn = await get('SELECT * FROM requisitions WHERE id = ?', [req.params.id]);
    if (!reqn) return next({ status: 404, message: 'Requisition not found' });
    try { await assertRecordInScope(req.user, reqn.branch_id, 'requisition'); } catch (e) { return next(e); }
    if (reqn.status !== 'Approved') return next({ status: 409, message: 'Only an Approved requisition can be paid' });
    try { await assertPeriodOpen(); } catch (e) { return next(e); }
    const fundingAccount = (req.body.account_id && (await get('SELECT id FROM gl_accounts WHERE id = ?', [req.body.account_id]))) ? req.body.account_id : 'bank';
    const expId = 'exp_' + crypto.randomUUID();
    await transaction(async () => {
      await run('INSERT INTO expenses (id, category, amount, note, branch_id, status, submitted_by, approved_by, paid_by) VALUES (?,?,?,?,?,?,?,?,?)',
        [expId, reqn.category, reqn.amount, `Requisition ${reqn.id}: ${reqn.description || ''}`, reqn.branch_id, 'Paid', reqn.submitted_by, reqn.approved_by, req.user.id]);
      // Charged to the real expense account the requester actually chose
      // (see POST /api/requisitions) — falls back to the generic Operating
      // Expenses account only for requisitions created before this existed.
      await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES (?, ?, 0, ?, 'requisition', ?, ?, ?)`,
        [reqn.expense_account_id || 'operating_expense', reqn.amount, `${reqn.category} (requisition) — ${reqn.description || ''}`, reqn.id, reqn.branch_id, req.user.id]);
      await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES (?, 0, ?, ?, 'requisition', ?, ?, ?)`,
        [fundingAccount, reqn.amount, `${reqn.category} (requisition) — ${reqn.description || ''}`, reqn.id, reqn.branch_id, req.user.id]);
      await run('UPDATE requisitions SET status = ?, expense_id = ? WHERE id = ?', ['Paid', expId, reqn.id]);
    });
    await logAction(req, { action: 'Paid requisition', module: 'accounting', recordType: 'Requisition', recordId: reqn.id, newValue: { expense_id: expId } });
    res.json({ requisition: await get('SELECT * FROM requisitions WHERE id = ?', [reqn.id]) });
  });

  router.post('/api/requisitions/:id/cancel', requireAuth, async (req, res, next) => {
    const reqn = await get('SELECT * FROM requisitions WHERE id = ?', [req.params.id]);
    if (!reqn) return next({ status: 404, message: 'Requisition not found' });
    if (reqn.submitted_by !== req.user.id && req.user.role_id !== 'admin') return next({ status: 403, message: 'Only the submitter (or an Admin) can cancel this requisition' });
    if (!['Pending', 'Approved'].includes(reqn.status)) return next({ status: 409, message: `Cannot cancel a requisition in ${reqn.status} status` });
    await run('UPDATE requisitions SET status = ? WHERE id = ?', ['Cancelled', reqn.id]);
    await logAction(req, { action: 'Cancelled requisition', module: 'accounting', recordType: 'Requisition', recordId: reqn.id });
    res.json({ ok: true });
  });

  // ==================== Utility Payments — a real expense with utility-specific fields, not a second engine ====================
  router.get('/api/utility-payments', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await resolveScopeForRequest(req);
    const clauses = ['1=1']; const params = [];
    if (scope !== null) {
      if (scope.length === 0) clauses.push('1=0');
      else { clauses.push(`branch_id IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
    }
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    if (req.query.from) { clauses.push('(created_at)::date >= ?'); params.push(req.query.from); }
    if (req.query.to) { clauses.push('(created_at)::date <= ?'); params.push(req.query.to); }
    let rows = await all(`SELECT * FROM utility_payments WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params);
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      rows = rows.filter(u => (u.provider || '').toLowerCase().includes(q) || (u.account_reference || '').toLowerCase().includes(q) || (u.utility_type || '').toLowerCase().includes(q));
    }
    res.json({ utilityPayments: rows });
  });

  router.post('/api/utility-payments', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const b = req.body;
    if (!b.utility_type || !b.amount || b.amount <= 0) return next({ status: 400, message: 'utility_type and a positive amount are required' });
    try { await assertPeriodOpen(); } catch (e) { return next(e); }
    const scopeIsCompanyWide = (await branchIdsInScope(req.user)) === null;
    const branchId = b.branch_id && (scopeIsCompanyWide || (await isBranchAllowed(req.user, b.branch_id))) ? b.branch_id : req.user.branch_id;
    const fundingAccount = (b.account_id && (await get('SELECT id FROM gl_accounts WHERE id = ?', [b.account_id]))) ? b.account_id : 'bank';
    const expId = 'exp_' + crypto.randomUUID();
    const id = 'util_' + crypto.randomUUID();
    await transaction(async () => {
      await run('INSERT INTO expenses (id, category, amount, note, branch_id, status, submitted_by, approved_by, paid_by) VALUES (?,?,?,?,?,?,?,?,?)',
        [expId, 'Utility — ' + b.utility_type, b.amount, `${b.provider || ''} ${b.account_reference || ''}`.trim(), branchId, 'Paid', req.user.id, req.user.id, req.user.id]);
      await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('operating_expense', ?, 0, ?, 'utility', ?, ?, ?)`,
        [b.amount, `${b.utility_type} — ${b.provider || ''}`, expId, branchId, req.user.id]);
      await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES (?, 0, ?, ?, 'utility', ?, ?, ?)`,
        [fundingAccount, b.amount, `${b.utility_type} — ${b.provider || ''}`, expId, branchId, req.user.id]);
      await run('INSERT INTO utility_payments (id, utility_type, provider, account_reference, amount, branch_id, payment_method, status, expense_id, paid_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [id, b.utility_type, b.provider || null, b.account_reference || null, b.amount, branchId, b.payment_method || fundingAccount, 'Paid', expId, req.user.id]);
    });
    await logAction(req, { action: 'Paid utility bill', module: 'accounting', recordType: 'UtilityPayment', recordId: id, newValue: { utility_type: b.utility_type, amount: b.amount } });
    res.status(201).json({ utilityPayment: await get('SELECT * FROM utility_payments WHERE id = ?', [id]) });
  });

  // Bulk import — a real Excel/CSV template (Branch/Item description/Cost/
  // Recipient mpesa number/Mpesa name/Journal account), OTP-confirmed the
  // same way a single requisition is (reusing the same generic
  // requisition_otps confirmation code — it isn't actually specific to
  // requisitions, just "prove you have your own phone" for any accounting
  // submission). Each row becomes its own real utility_payment + balanced
  // journal entry; a bad row is skipped and reported, not silently dropped
  // and not allowed to abort rows that were valid.
  router.post('/api/utility-payments/bulk', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const b = req.body;
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (!rows.length) return next({ status: 400, message: 'No rows to import' });
    if (!b.otp_code) return next({ status: 400, message: 'otp_code is required' });
    const otp = await get(
      `SELECT * FROM requisition_otps WHERE user_id = ? AND code_hash = ? AND used = 0 AND expires_at > iso_now() ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, tokenHash(String(b.otp_code))]
    );
    if (!otp) return next({ status: 400, message: 'Invalid or expired OTP code', code: 'INVALID_OTP' });
    try { await assertPeriodOpen(); } catch (e) { return next(e); }

    const scopeIsCompanyWide = (await branchIdsInScope(req.user)) === null;
    const created = [];
    const errors = [];
    await transaction(async () => {
      await run('UPDATE requisition_otps SET used = 1 WHERE id = ?', [otp.id]);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || {};
        const rowNum = i + 2; // spreadsheet row 1 is the header
        if (!r.item_description || !(Number(r.cost) > 0)) { errors.push({ row: rowNum, error: 'Item description and a positive cost are required' }); continue; }
        let branchId = req.user.branch_id;
        if (r.branch) {
          const match = await get('SELECT id FROM branches WHERE LOWER(name) = LOWER(?)', [r.branch]);
          if (!match || !(scopeIsCompanyWide || (await isBranchAllowed(req.user, match.id)))) { errors.push({ row: rowNum, error: `Branch "${r.branch}" was not found or is outside your scope` }); continue; }
          branchId = match.id;
        }
        let expenseAccountId = null;
        if (r.journal_account) {
          const acct = await get(`SELECT id FROM gl_accounts WHERE account_type = 'Expense' AND (LOWER(name) = LOWER(?) OR LOWER(code) = LOWER(?))`, [r.journal_account, r.journal_account]);
          if (!acct) { errors.push({ row: rowNum, error: `Expense account "${r.journal_account}" was not found` }); continue; }
          expenseAccountId = acct.id;
        }
        const amount = Number(r.cost);
        const expId = 'exp_' + crypto.randomUUID();
        const id = 'util_' + crypto.randomUUID();
        await run('INSERT INTO expenses (id, category, amount, note, branch_id, status, submitted_by, approved_by, paid_by) VALUES (?,?,?,?,?,?,?,?,?)',
          [expId, 'Vendor Payment — ' + r.item_description, amount, r.mpesa_name || '', branchId, 'Paid', req.user.id, req.user.id, req.user.id]);
        await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES (?, ?, 0, ?, 'utility', ?, ?, ?)`,
          [expenseAccountId || 'operating_expense', amount, r.item_description, expId, branchId, req.user.id]);
        await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('bank', 0, ?, ?, 'utility', ?, ?, ?)`,
          [amount, r.item_description, expId, branchId, req.user.id]);
        await run(`INSERT INTO utility_payments (id, utility_type, provider, account_reference, amount, branch_id, payment_method, status, expense_id, paid_by, item_description, recipient_mpesa_number, mpesa_name, expense_account_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, 'Vendor Payment', r.mpesa_name || null, r.recipient_mpesa_number || null, amount, branchId, 'bank', 'Paid', expId, req.user.id, r.item_description, r.recipient_mpesa_number || null, r.mpesa_name || null, expenseAccountId]);
        created.push(id);
      }
    });
    await logAction(req, { action: 'Bulk-imported utility payments', module: 'accounting', recordType: 'UtilityPayment', recordId: null, newValue: { created: created.length, errors: errors.length } });
    res.status(created.length ? 201 : 400).json({ created: created.length, errors });
  });

  // ==================== Accounting Periods ====================
  router.get('/api/accounting/periods', requireAuth, requireModule('accounting'), async (req, res) => {
    const rows = await all('SELECT * FROM accounting_periods ORDER BY id DESC LIMIT 24');
    const currentKey = periodKeyFor();
    const hasCurrentRow = rows.some(r => r.id === currentKey);
    res.json({ periods: hasCurrentRow ? rows : [{ id: currentKey, status: 'Open' }, ...rows] });
  });

  router.post('/api/accounting/periods/:id/close', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    if (!/^\d{4}-\d{2}$/.test(req.params.id)) return next({ status: 400, message: 'period id must look like "2026-09"' });
    const existing = await get('SELECT * FROM accounting_periods WHERE id = ?', [req.params.id]);
    if (existing && existing.status === 'Closed') return next({ status: 409, message: 'Period is already closed' });
    if (existing) await run("UPDATE accounting_periods SET status='Closed', closed_by=?, closed_at=iso_now() WHERE id = ?", [req.user.id, req.params.id]);
    else await run("INSERT INTO accounting_periods (id, status, closed_by, closed_at) VALUES (?, 'Closed', ?, iso_now())", [req.params.id, req.user.id]);
    await logAction(req, { action: 'Closed accounting period', module: 'accounting', recordType: 'AccountingPeriod', recordId: req.params.id });
    res.json({ period: await get('SELECT * FROM accounting_periods WHERE id = ?', [req.params.id]) });
  });

  // Reopening a closed period is a higher-authority action than closing
  // one — Admin only, and always requires a stated reason, which the
  // review explicitly calls for and closing does not.
  router.post('/api/accounting/periods/:id/reopen', requireAuth, requirePermission('manage_system_settings'), async (req, res, next) => {
    const existing = await get('SELECT * FROM accounting_periods WHERE id = ?', [req.params.id]);
    if (!existing || existing.status !== 'Closed') return next({ status: 409, message: 'Period is not currently closed' });
    if (!req.body.reason) return next({ status: 400, message: 'A reason is required to reopen a closed period' });
    await run("UPDATE accounting_periods SET status='Open', reopened_by=?, reopened_at=iso_now(), reopen_reason=? WHERE id = ?", [req.user.id, req.body.reason, req.params.id]);
    await logAction(req, { action: 'Reopened accounting period', module: 'accounting', recordType: 'AccountingPeriod', recordId: req.params.id, reason: req.body.reason });
    res.json({ period: await get('SELECT * FROM accounting_periods WHERE id = ?', [req.params.id]) });
  });

  // ==================== Chart of Accounts management ====================
  router.post('/api/accounts', requireAuth, requirePermission('manage_system_settings'), async (req, res, next) => {
    const b = req.body;
    if (!b.code || !b.name || !b.account_type) return next({ status: 400, message: 'code, name and account_type are required' });
    if (!['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'].includes(b.account_type)) return next({ status: 400, message: 'account_type must be Asset, Liability, Equity, Revenue, or Expense' });
    const id = b.id || b.code.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (await get('SELECT id FROM gl_accounts WHERE id = ? OR code = ?', [id, b.code])) return next({ status: 409, message: 'An account with this id/code already exists' });
    await run('INSERT INTO gl_accounts (id, code, name, account_type, status) VALUES (?,?,?,?,?)', [id, b.code, b.name, b.account_type, 'Active']);
    await logAction(req, { action: 'Created GL account', module: 'accounting', recordType: 'GLAccount', recordId: id, newValue: { code: b.code, name: b.name, account_type: b.account_type } });
    res.status(201).json({ account: await get('SELECT * FROM gl_accounts WHERE id = ?', [id]) });
  });

  router.patch('/api/accounts/:id', requireAuth, requirePermission('manage_system_settings'), async (req, res, next) => {
    const acct = await get('SELECT * FROM gl_accounts WHERE id = ?', [req.params.id]);
    if (!acct) return next({ status: 404, message: 'Account not found' });
    // account_type is deliberately NOT editable here — changing it after
    // real postings exist would silently reinterpret every historical
    // debit/credit's meaning (ledgerBalance's sign convention is keyed off
    // account_type). Only the display name and active status can change.
    const sets = []; const params = [];
    if (req.body.name) { sets.push('name = ?'); params.push(req.body.name); }
    if (req.body.status && ['Active', 'Inactive'].includes(req.body.status)) { sets.push('status = ?'); params.push(req.body.status); }
    if (!sets.length) return next({ status: 400, message: 'Nothing to update (only name/status are editable)' });
    params.push(req.params.id);
    await run(`UPDATE gl_accounts SET ${sets.join(', ')} WHERE id = ?`, params);
    await logAction(req, { action: 'Updated GL account', module: 'accounting', recordType: 'GLAccount', recordId: req.params.id, newValue: req.body });
    res.json({ account: await get('SELECT * FROM gl_accounts WHERE id = ?', [req.params.id]) });
  });

  router.get('/api/accounts/:id/usage', requireAuth, requireModule('accounting'), async (req, res) => {
    const count = (await get('SELECT COUNT(*) as c FROM journal_entries WHERE account_id = ?', [req.params.id])).c;
    const lastUsed = (await get('SELECT MAX(entry_date) as d FROM journal_entries WHERE account_id = ?', [req.params.id])).d;
    res.json({ accountId: req.params.id, transactionCount: count, lastUsed, inUse: count > 0 });
  });

  // ==================== Formal Financial Adjustments ====================
  router.get('/api/adjustments', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await resolveScopeForRequest(req);
    const clauses = ['1=1']; const params = [];
    if (scope !== null) {
      if (scope.length === 0) clauses.push('1=0');
      else { clauses.push(`branch_id IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
    }
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    const rows = await all(`SELECT * FROM adjustments WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params);
    res.json({ adjustments: rows });
  });

  router.post('/api/adjustments', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const b = req.body;
    if (!b.reason || !b.debit_account || !b.credit_account || !b.amount || b.amount <= 0) {
      return next({ status: 400, message: 'reason, debit_account, credit_account and a positive amount are required' });
    }
    if (b.debit_account === b.credit_account) return next({ status: 400, message: 'debit_account and credit_account must differ' });
    if (!(await get('SELECT id FROM gl_accounts WHERE id = ?', [b.debit_account])) || !(await get('SELECT id FROM gl_accounts WHERE id = ?', [b.credit_account]))) {
      return next({ status: 400, message: 'debit_account/credit_account must be real chart-of-accounts ids' });
    }
    const id = 'adj_' + crypto.randomUUID();
    await run('INSERT INTO adjustments (id, reference, reason, debit_account, credit_account, amount, branch_id, note, status, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, b.reference || null, b.reason, b.debit_account, b.credit_account, b.amount, b.branch_id || req.user.branch_id || null, b.note || null, 'Draft', req.user.id]);
    await logAction(req, { action: 'Drafted adjustment', module: 'accounting', recordType: 'Adjustment', recordId: id, newValue: { amount: b.amount, reason: b.reason } });
    res.status(201).json({ adjustment: await get('SELECT * FROM adjustments WHERE id = ?', [id]) });
  });

  router.post('/api/adjustments/:id/submit', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const adj = await get('SELECT * FROM adjustments WHERE id = ?', [req.params.id]);
    if (!adj) return next({ status: 404, message: 'Adjustment not found' });
    if (adj.created_by !== req.user.id && req.user.role_id !== 'admin') return next({ status: 403, message: 'Only the creator (or Admin) can submit this adjustment' });
    if (adj.status !== 'Draft') return next({ status: 409, message: `Cannot submit an adjustment in ${adj.status} status` });
    await run("UPDATE adjustments SET status = 'Submitted' WHERE id = ?", [adj.id]);
    await logAction(req, { action: 'Submitted adjustment', module: 'accounting', recordType: 'Adjustment', recordId: adj.id });
    res.json({ adjustment: await get('SELECT * FROM adjustments WHERE id = ?', [adj.id]) });
  });

  // A second, independent approver — never the same person who drafted
  // it — reviews before anything is posted to the real ledger.
  router.post('/api/adjustments/:id/decide', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const adj = await get('SELECT * FROM adjustments WHERE id = ?', [req.params.id]);
    if (!adj) return next({ status: 404, message: 'Adjustment not found' });
    if (adj.status !== 'Submitted') return next({ status: 409, message: `Cannot decide on an adjustment in ${adj.status} status` });
    if (adj.created_by === req.user.id) return next({ status: 403, message: 'You cannot approve your own adjustment' });
    try { await assertRecordInScope(req.user, adj.branch_id, 'adjustment'); } catch (e) { return next(e); }
    const decision = req.body.decision;
    if (!['Approved', 'Rejected'].includes(decision)) return next({ status: 400, message: 'decision must be Approved or Rejected' });
    await run('UPDATE adjustments SET status = ?, approved_by = ? WHERE id = ?', [decision, req.user.id, adj.id]);
    await logAction(req, { action: `Adjustment ${decision.toLowerCase()}`, module: 'accounting', recordType: 'Adjustment', recordId: adj.id, reason: req.body.reason });
    res.json({ adjustment: await get('SELECT * FROM adjustments WHERE id = ?', [adj.id]) });
  });

  router.post('/api/adjustments/:id/post', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const adj = await get('SELECT * FROM adjustments WHERE id = ?', [req.params.id]);
    if (!adj) return next({ status: 404, message: 'Adjustment not found' });
    if (adj.status !== 'Approved') return next({ status: 409, message: 'Only an Approved adjustment can be posted' });
    try { await assertPeriodOpen(); } catch (e) { return next(e); }
    await transaction(async () => {
      await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES (?, ?, 0, ?, 'adjustment', ?, ?, ?)`,
        [adj.debit_account, adj.amount, `Adjustment — ${adj.reason}`, adj.id, adj.branch_id, req.user.id]);
      await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES (?, 0, ?, ?, 'adjustment', ?, ?, ?)`,
        [adj.credit_account, adj.amount, `Adjustment — ${adj.reason}`, adj.id, adj.branch_id, req.user.id]);
      await run("UPDATE adjustments SET status = 'Posted', posted_at = iso_now() WHERE id = ?", [adj.id]);
    });
    await logAction(req, { action: 'Posted adjustment', module: 'accounting', recordType: 'Adjustment', recordId: adj.id, newValue: { debit: adj.debit_account, credit: adj.credit_account, amount: adj.amount } });
    res.json({ adjustment: await get('SELECT * FROM adjustments WHERE id = ?', [adj.id]) });
  });

  // ==================== Portfolio at Risk ====================
  // PAR-N = outstanding principal of loans with at least one installment
  // N+ days overdue, divided by total outstanding principal — the
  // standard microfinance definition. Uses the real loan_schedule, the
  // same table every other arrears calculation in this app already reads.
  router.get('/api/accounting/par', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await resolveScopeForRequest(req);
    res.json(await computePAR(scope));
  });

  // ==================== Branch Profitability ====================
  router.get('/api/accounting/branch-profitability', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await branchIdsInScope(req.user);
    let branches = await all('SELECT * FROM branches');
    if (scope !== null) branches = branches.filter(b => scope.includes(b.id));
    const result = await Promise.all(branches.map(async b => {
      const revenue = (await ledgerBalance('interest_income', [b.id])) + (await ledgerBalance('fee_income', [b.id]));
      const expenses = await ledgerBalance('operating_expense', [b.id]);
      const scheduleRows = await all(`SELECT s.total_due, s.paid_amount FROM loan_schedule s JOIN loans l ON l.id = s.loan_id WHERE l.branch_id = ? AND l.status IN ('Active','Disbursed')`, [b.id]);
      const portfolio = scheduleRows.reduce((s, r) => s + Math.max(0, r.total_due - r.paid_amount), 0);
      return { branchId: b.id, branchName: b.name, revenue, expenses, netResult: revenue - expenses, portfolio };
    }));
    res.json({ branches: result });
  });

  // ==================== Approval Aging ====================
  // Real age, in hours, for every currently-pending item across the
  // workflows that already exist — not a fabricated metric.
  router.get('/api/accounting/approval-aging', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await resolveScopeForRequest(req);
    const now = Date.now();
    const ageHours = (createdAt) => Math.round((now - new Date(createdAt).getTime()) / 3600000);
    const branchFilter = (rows) => scope === null ? rows : rows.filter(r => scope.includes(r.branch_id));

    const pendingExpensesRaw = await all("SELECT * FROM expenses WHERE status = 'Pending'");
    const pendingExpenses = branchFilter(pendingExpensesRaw)
      .map(e => ({ type: 'Expense', id: e.id, ageHours: ageHours(e.created_at), branchId: e.branch_id, awaitingRole: 'Accountant/Admin', reference: e.category }));
    const pendingRequisitionsRaw = await all("SELECT * FROM requisitions WHERE status = 'Pending'");
    const pendingRequisitions = branchFilter(pendingRequisitionsRaw)
      .map(r => ({ type: 'Requisition', id: r.id, ageHours: ageHours(r.created_at), branchId: r.branch_id, awaitingRole: 'Manager', reference: r.category }));
    const approvedRequisitionsRaw = await all("SELECT * FROM requisitions WHERE status = 'Approved'");
    const approvedRequisitions = branchFilter(approvedRequisitionsRaw)
      .map(r => ({ type: 'Requisition (awaiting payment)', id: r.id, ageHours: ageHours(r.created_at), branchId: r.branch_id, awaitingRole: 'Accountant', reference: r.category }));
    const submittedAdjustmentsRaw = await all("SELECT * FROM adjustments WHERE status = 'Submitted'");
    const submittedAdjustments = branchFilter(submittedAdjustmentsRaw)
      .map(a => ({ type: 'Adjustment', id: a.id, ageHours: ageHours(a.created_at), branchId: a.branch_id, awaitingRole: 'Accountant/Admin', reference: a.reason }));
    const loanScope = scope === null ? '1=1' : (scope.length === 0 ? '1=0' : `branch_id IN (${scope.map(() => '?').join(',')})`);
    const loanParams = scope !== null ? [...scope] : [];
    const pendingLoansRaw = await all(`SELECT id, branch_id, status, created_at FROM loans WHERE ${loanScope} AND status LIKE 'Waiting for%'`, loanParams);
    const pendingLoans = pendingLoansRaw
      .map(l => ({ type: 'Loan Approval', id: l.id, ageHours: ageHours(l.created_at), branchId: l.branch_id, awaitingRole: l.status.replace('Waiting for ', ''), reference: l.id }));

    const OVERDUE_THRESHOLD_HOURS = 48; // documented, not a silent magic number
    const items = [...pendingExpenses, ...pendingRequisitions, ...approvedRequisitions, ...submittedAdjustments, ...pendingLoans]
      .map(i => ({ ...i, overdue: i.ageHours >= OVERDUE_THRESHOLD_HOURS }))
      .sort((a, b) => b.ageHours - a.ageHours);
    res.json({ items, overdueThresholdHours: OVERDUE_THRESHOLD_HOURS, overdueCount: items.filter(i => i.overdue).length });
  });

  // ==================== Chart of Accounts ====================
  router.get('/api/accounts', requireAuth, requireModule('accounting'), async (req, res) => {
    let rows = await all('SELECT * FROM gl_accounts');
    if (req.query.account_type) rows = rows.filter(a => a.account_type === req.query.account_type);
    if (req.query.status) rows = rows.filter(a => a.status === req.query.status);
    if (req.query.q) { const q = req.query.q.toLowerCase(); rows = rows.filter(a => a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q)); }
    res.json({ accounts: rows });
  });

  // ==================== General Ledger — real pagination + filtering + branch/region scope ====================
  router.get('/api/journal-entries', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await resolveScopeForRequest(req);
    const clauses = ['1=1']; const params = [];
    if (scope !== null) {
      if (scope.length === 0) clauses.push('1=0');
      else { clauses.push(`branch_id IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
    }
    if (req.query.account_id) { clauses.push('account_id = ?'); params.push(req.query.account_id); }
    if (req.query.ref_type) { clauses.push('ref_type = ?'); params.push(req.query.ref_type); }
    if (req.query.ref_id) { clauses.push('ref_id = ?'); params.push(req.query.ref_id); }
    if (req.query.date_from) { clauses.push('(entry_date)::date >= (?)::date'); params.push(req.query.date_from); }
    if (req.query.date_to) { clauses.push('(entry_date)::date <= (?)::date'); params.push(req.query.date_to); }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const where = `WHERE ${clauses.join(' AND ')}`;
    const agg = await get(`SELECT COUNT(*) as cnt FROM journal_entries ${where}`, params);
    const rows = await all(`SELECT * FROM journal_entries ${where} ORDER BY entry_date DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    res.json({ entries: rows, pagination: { page, limit, total: agg.cnt, totalPages: Math.max(1, Math.ceil(agg.cnt / limit)) } });
  });

  // ==================== Cash position / Trial Balance / P&L / Balance Sheet — all real, all now branch/region-scoped ====================
  router.get('/api/accounting/cash-position', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await resolveScopeForRequest(req);
    const accounts = ['cash', 'bank', 'mpesa'];
    const balances = {};
    for (const a of accounts) { balances[a] = await ledgerBalance(a, scope); }
    res.json({ balances });
  });

  router.get('/api/accounting/trial-balance', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await resolveScopeForRequest(req);
    const accounts = await all('SELECT * FROM gl_accounts');
    const rows = await Promise.all(accounts.map(async a => ({ account: a.id, name: a.name, type: a.account_type, balance: await ledgerBalance(a.id, scope) })));
    let sumSql = 'SELECT COALESCE(SUM(debit),0) as d, COALESCE(SUM(credit),0) as c FROM journal_entries';
    const params = [];
    if (scope !== null) {
      sumSql += scope.length === 0 ? ' WHERE 1=0' : ` WHERE branch_id IN (${scope.map(() => '?').join(',')})`;
      params.push(...scope);
    }
    const sums = await get(sumSql, params);
    res.json({ rows, totalDebits: sums.d, totalCredits: sums.c, balanced: Math.abs(sums.d - sums.c) < 0.01 });
  });

  router.get('/api/accounting/profit-and-loss', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await resolveScopeForRequest(req);
    const interestIncome = await ledgerBalance('interest_income', scope);
    const feeIncome = await ledgerBalance('fee_income', scope);
    const expenses = await ledgerBalance('operating_expense', scope);
    res.json({ interestIncome, feeIncome, expenses, netProfit: interestIncome + feeIncome - expenses });
  });

  router.get('/api/accounting/balance-sheet', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await resolveScopeForRequest(req);
    const assets = await Promise.all(['cash', 'bank', 'mpesa', 'loans_receivable'].map(async a => ({ account: a, balance: await ledgerBalance(a, scope) })));
    const totalAssets = assets.reduce((s, a) => s + a.balance, 0);
    const liabilities = [{ account: 'overpayment_suspense', balance: await ledgerBalance('overpayment_suspense', scope) }];
    const totalLiabilities = liabilities.reduce((s, a) => s + a.balance, 0);
    res.json({ assets, totalAssets, liabilities, totalLiabilities, equity: totalAssets - totalLiabilities });
  });

  // ==================== Cashflow — opening/closing balance + inflows/outflows over a real date range ====================
  router.get('/api/accounting/cashflow', requireAuth, requireModule('accounting'), async (req, res) => {
    const scope = await resolveScopeForRequest(req);
    const cashAccounts = ['cash', 'bank', 'mpesa'];
    const from = req.query.date_from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const to = req.query.date_to || new Date().toISOString().slice(0, 10);
    const scopeClause = scope !== null ? (scope.length === 0 ? ' AND 1=0' : ` AND branch_id IN (${scope.map(() => '?').join(',')})`) : '';
    const scopeParams = scope !== null && scope.length > 0 ? scope : [];

    const acctList = cashAccounts.map(() => '?').join(',');
    const openingRow = await get(
      `SELECT COALESCE(SUM(debit),0) as d, COALESCE(SUM(credit),0) as c FROM journal_entries WHERE account_id IN (${acctList}) AND (entry_date)::date < (?)::date ${scopeClause}`,
      [...cashAccounts, from, ...scopeParams]
    );
    const opening = openingRow.d - openingRow.c;

    const periodRow = await get(
      `SELECT COALESCE(SUM(debit),0) as d, COALESCE(SUM(credit),0) as c FROM journal_entries WHERE account_id IN (${acctList}) AND (entry_date)::date BETWEEN (?)::date AND (?)::date ${scopeClause}`,
      [...cashAccounts, from, to, ...scopeParams]
    );
    const inflows = periodRow.d, outflows = periodRow.c, net = inflows - outflows;
    res.json({ from, to, opening, inflows, outflows, net, closing: opening + net });
  });
}

module.exports = { register, ledgerBalance, assertPeriodOpen, computePAR };
