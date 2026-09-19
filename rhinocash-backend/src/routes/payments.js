'use strict';
const { all, get, run, transaction } = require('./../db');
const { requireAuth, requireModule, requirePermission } = require('./../middleware');
const { logAction, notify } = require('./../audit');
const { assertRecordInScope, branchIdsInScope } = require('./../rbac');
const crypto = require('node:crypto');

// Real overdue-installment penalty accrual. A loan_schedule row's penalty
// is charged ONCE — a flat percentage (the loan's product's real,
// admin-configured penalty_pct) of that installment's total_due — the
// first time it's found still unpaid past its due date, then left alone
// (never recomputed/increased on a later call, and never reduced by a
// partial payment, matching how principal_due/interest_due are likewise
// fixed once the schedule is built). Guarded by `penalty_due = 0` so
// calling this repeatedly (it runs on every loan read and before every
// payment allocation, since this dependency-free app has no background
// job runner to accrue it on a timer) can never double-charge. No journal
// entry is posted here — like interest, penalty income is only
// recognized in the ledger once actually collected (see
// postPaymentJournal), never at the moment it merely becomes due.
async function accrueOverduePenalties(loanId) {
  const loan = await get('SELECT product_id FROM loans WHERE id = ?', [loanId]);
  if (!loan) return;
  const product = await get('SELECT penalty_pct FROM loan_products WHERE id = ?', [loan.product_id]);
  const pct = (product && product.penalty_pct) || 0;
  if (pct <= 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const overdueRows = await all(
    `SELECT id, total_due FROM loan_schedule WHERE loan_id = ? AND due_date < ? AND paid_amount < total_due - 0.01 AND penalty_due = 0`,
    [loanId, today]
  );
  for (const row of overdueRows) {
    const penalty = Math.round((pct / 100) * row.total_due * 100) / 100;
    if (penalty > 0) await run('UPDATE loan_schedule SET penalty_due = ? WHERE id = ?', [penalty, row.id]);
  }
}

async function allocate(loanId, amount, paymentId) {
  await accrueOverduePenalties(loanId);
  const rows = await all('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY period', [loanId]);
  const today = new Date().toISOString().slice(0, 10);
  let remaining = amount;
  let allocPrincipal = 0, allocInterest = 0, allocPenalty = 0;
  let touchedCount = 0;
  for (const row of rows) {
    if (remaining <= 0) break;
    const piDue = row.total_due - row.paid_amount;
    const penaltyDue = row.penalty_due - row.penalty_paid;
    const rowDue = piDue + penaltyDue;
    if (rowDue <= 0) continue;
    const pay = Math.min(rowDue, remaining);
    // Principal + interest are paid off before any penalty on the same
    // installment — a standard, and here also the safer, priority (a
    // partial payment should never look like it cleared a late fee while
    // the underlying principal/interest it was actually meant for is
    // still outstanding).
    const toPI = Math.min(piDue, pay);
    const toPenalty = pay - toPI;
    const newPaid = row.paid_amount + toPI;
    const newPenaltyPaid = row.penalty_paid + toPenalty;
    const newStatus = (newPaid >= row.total_due - 0.01 && newPenaltyPaid >= row.penalty_due - 0.01) ? 'Paid' : 'Partial';
    await run('UPDATE loan_schedule SET paid_amount = ?, penalty_paid = ?, status = ? WHERE id = ?', [newPaid, newPenaltyPaid, newStatus, row.id]);
    allocPrincipal += toPI * (row.principal_due / row.total_due);
    allocInterest += toPI * (row.interest_due / row.total_due);
    allocPenalty += toPenalty;
    if (paymentId) {
      // The FIRST unpaid installment this payment reaches is, by
      // definition, the loan's current obligation — arrears if its
      // calendar due date has already passed, current otherwise. Any
      // installment this SAME payment reaches beyond that one is being
      // paid ahead of the real repayment sequence — a genuine prepayment
      // — regardless of what its own calendar due date happens to be
      // (a freshly-disbursed loan's very first installment is normally
      // due next month; comparing every row to "today" in isolation would
      // wrongly flag ordinary on-schedule payments as prepayments).
      const bucket = touchedCount === 0 ? (row.due_date < today ? 'arrears' : 'current') : 'future';
      await run(
        `INSERT INTO payment_allocations (payment_id, schedule_id, period, due_date, amount_applied, bucket) VALUES (?,?,?,?,?,?)`,
        [paymentId, row.id, row.period, row.due_date, pay, bucket]
      );
      touchedCount++;
    }
    remaining -= pay;
  }
  return { allocPrincipal, allocInterest, allocPenalty, remaining };
}

// Payment channels come from the frontend as "M-Pesa" / "Bank" / "Cash";
// the ledger's Chart of Accounts uses lowercase ids ('mpesa','bank','cash').
// This is the one place that translation happens, so every report reading
// gl_accounts sees consistent ids no matter which route posted the entry.
function glAccountFor(channel) {
  const c = String(channel || 'Cash').toLowerCase();
  if (c.includes('mpesa') || c.includes('m-pesa')) return 'mpesa';
  if (c.includes('bank')) return 'bank';
  return 'cash';
}

// Standard double-entry convention used everywhere in this codebase:
// DEBIT increases Asset/Expense accounts; CREDIT increases
// Liability/Equity/Revenue accounts. (See accounting.js ledgerBalance,
// which is the one place this sign convention is applied when reading
// balances back out — post here, read there, always the same rule.)
//
// A repayment is a 2-to-4-line balanced entry:
//   DEBIT  cash/bank/mpesa        (amount)         — asset increases
//   CREDIT loans_receivable       (principal part) — asset decreases
//   CREDIT interest_income        (interest part)  — revenue recognized
//   CREDIT penalty_income         (penalty part)   — revenue recognized
//   CREDIT overpayment_suspense   (any excess)      — held pending refund/allocation
// Penalty follows the exact same recognition timing as interest: nothing
// is posted when a penalty merely becomes due (accrueOverduePenalties()
// above only ever touches loan_schedule, never journal_entries) — it is
// only ever real, recognized income once the client actually pays it.
async function postPaymentJournal({ paymentId, loanId, amount, channel, allocPrincipal, allocInterest, allocPenalty, overpay, userId, branchId }) {
  const fundingAccount = glAccountFor(channel);
  await run(
    `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES (?,?,0,?,'payment',?,?,?)`,
    [fundingAccount, amount, `Repayment received — ${loanId}`, paymentId, branchId || null, userId]
  );
  if (allocPrincipal > 0) {
    await run(
      `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('loans_receivable',0,?,?,'payment',?,?,?)`,
      [allocPrincipal, `Principal repayment — ${loanId}`, paymentId, branchId || null, userId]
    );
  }
  if (allocInterest > 0) {
    await run(
      `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('interest_income',0,?,?,'payment',?,?,?)`,
      [allocInterest, `Interest income — ${loanId}`, paymentId, branchId || null, userId]
    );
  }
  if (allocPenalty > 0) {
    await run(
      `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('penalty_income',0,?,?,'payment',?,?,?)`,
      [allocPenalty, `Penalty income — ${loanId}`, paymentId, branchId || null, userId]
    );
  }
  if (overpay > 0) {
    await run(
      `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('overpayment_suspense',0,?,?,'payment',?,?,?)`,
      [overpay, `Overpayment held — ${loanId}`, paymentId, branchId || null, userId]
    );
  }
}

// The exact reverse of postPaymentJournal — same amounts, opposite sides,
// so the running SUM(debit)=SUM(credit) invariant holds after a reversal too.
async function reversePaymentJournal({ paymentId, loanId, amount, channel, allocPrincipal, allocInterest, allocPenalty, overpay, userId, branchId }) {
  const fundingAccount = glAccountFor(channel);
  await run(
    `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES (?,0,?,?,'payment_reversal',?,?,?)`,
    [fundingAccount, amount, `Reversal — ${loanId}`, paymentId, branchId || null, userId]
  );
  if (allocPrincipal > 0) {
    await run(
      `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('loans_receivable',?,0,?,'payment_reversal',?,?,?)`,
      [allocPrincipal, `Principal reversal — ${loanId}`, paymentId, branchId || null, userId]
    );
  }
  if (allocInterest > 0) {
    await run(
      `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('interest_income',?,0,?,'payment_reversal',?,?,?)`,
      [allocInterest, `Interest reversal — ${loanId}`, paymentId, branchId || null, userId]
    );
  }
  if (allocPenalty > 0) {
    await run(
      `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('penalty_income',?,0,?,'payment_reversal',?,?,?)`,
      [allocPenalty, `Penalty reversal — ${loanId}`, paymentId, branchId || null, userId]
    );
  }
  if (overpay > 0) {
    await run(
      `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('overpayment_suspense',?,0,?,'payment_reversal',?,?,?)`,
      [overpay, `Overpayment reversal — ${loanId}`, paymentId, branchId || null, userId]
    );
  }
}

// Real per-installment classification, from the actual allocation record —
// not a "payment > average installment" guess. A payment is a genuine
// prepayment only if some real portion of it was applied to an
// installment that was not yet due at the moment of payment.
async function classifyPayment(paymentId) {
  const rows = await all('SELECT * FROM payment_allocations WHERE payment_id = ?', [paymentId]);
  const futureAmount = rows.filter(r => r.bucket === 'future').reduce((s, r) => s + r.amount_applied, 0);
  const arrearsAmount = rows.filter(r => r.bucket === 'arrears').reduce((s, r) => s + r.amount_applied, 0);
  const currentAmount = rows.filter(r => r.bucket === 'current').reduce((s, r) => s + r.amount_applied, 0);
  return { isPrepayment: futureAmount > 0, futureAmount, arrearsAmount, currentAmount, installmentsTouched: rows.length };
}

// One shared filter/scope builder for both the paginated list and the
// full-dataset export — the two must never disagree about which rows
// match, or "export filtered results" could silently differ from what
// the screen showed.
const PAYMENT_SORT_COLUMNS = { date: 'p.created_at', amount: 'p.amount', customer: 'c.name', status: 'p.status' };
async function buildPaymentQuery(req) {
  const q = req.query;
  const clauses = ['1=1'];
  const params = [];

  // Scope — enforced here, in SQL, not filtered after the fact in JS. Same
  // real restriction loans.js already applies for a Loan Officer (their own
  // portfolio only, even within their own branch) — GET /api/payments never
  // had this before, so a Loan Officer could previously see every payment
  // in their whole branch, not just their own clients'. Fixed here.
  const scope = await branchIdsInScope(req.user);
  if (scope !== null) {
    if (scope.length === 0) clauses.push('1=0');
    else { clauses.push(`l.branch_id IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
  }
  if (req.user.role_id === 'loan_officer') { clauses.push('l.officer_id = ?'); params.push(req.user.id); }

  if (q.status) { clauses.push('p.status = ?'); params.push(q.status); }
  if (q.channel) { clauses.push('p.channel = ?'); params.push(q.channel); }
  if (q.loan_id) { clauses.push('p.loan_id = ?'); params.push(q.loan_id); }
  if (q.client_id) { clauses.push('p.client_id = ?'); params.push(q.client_id); }
  if (q.branch_id) {
    if (scope !== null && !scope.includes(q.branch_id)) { clauses.push('1=0'); } // requested branch outside real scope -> no rows, not an error leaking existence
    else { clauses.push('l.branch_id = ?'); params.push(q.branch_id); }
  }
  if (q.region_id) { clauses.push('br.region_id = ?'); params.push(q.region_id); }
  if (q.officer_id) { clauses.push('l.officer_id = ?'); params.push(q.officer_id); }
  if (q.reference) { clauses.push('p.reference LIKE ?'); params.push(`%${q.reference}%`); }
  if (q.date_from) { clauses.push('(p.created_at)::date >= (?)::date'); params.push(q.date_from); }
  if (q.date_to) { clauses.push('(p.created_at)::date <= (?)::date'); params.push(q.date_to); }
  if (q.amount_min) { clauses.push('p.amount >= ?'); params.push(Number(q.amount_min)); }
  if (q.amount_max) { clauses.push('p.amount <= ?'); params.push(Number(q.amount_max)); }
  if (q.q) {
    clauses.push('(c.name LIKE ? OR c.phone LIKE ? OR p.loan_id LIKE ? OR p.reference LIKE ?)');
    const like = `%${q.q}%`; params.push(like, like, like, like);
  }

  const from = `FROM payments p JOIN loans l ON l.id = p.loan_id LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN branches br ON br.id = l.branch_id`;
  const where = `WHERE ${clauses.join(' AND ')}`;
  let sortCol = PAYMENT_SORT_COLUMNS[q.sort_by] || 'p.created_at';
  const sortDir = q.sort_dir === 'asc' ? 'ASC' : 'DESC';
  const orderBy = `ORDER BY ${sortCol} ${sortDir}, p.id ${sortDir}`; // deterministic tiebreaker so pagination never reshuffles
  return { from, where, params, orderBy };
}

function register(router) {
  const { assertPeriodOpen } = require('./accounting');
  router.get('/api/payments', requireAuth, requireModule('payments'), async (req, res) => {
    const { from, where, params, orderBy } = await buildPaymentQuery(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    // The 100-row ceiling is for user-FACING pagination (25/50/100 page
    // sizes); this endpoint is also used once per login to prime dashboard
    // aggregate math, which needs a materially complete set to stay
    // correct — 500 is a deliberately higher internal ceiling for that,
    // not a page size anyone picks in the UI.
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;

    // Total count/amount over the FULL filtered set, independent of page —
    // a report total must never be silently just "sum of this page".)
    const aggRow = await get(`SELECT COUNT(*) as cnt, COALESCE(SUM(p.amount),0) as total FROM payments p JOIN loans l ON l.id = p.loan_id LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN branches br ON br.id = l.branch_id ${where}`, params);
    const rows = await all(`SELECT p.* ${from} ${where} ${orderBy} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const enriched = await Promise.all(rows.map(async p => ({ ...p, classification: await classifyPayment(p.id) })));

    res.json({
      payments: enriched,
      pagination: {
        page, limit, total: aggRow.cnt, totalPages: Math.max(1, Math.ceil(aggRow.cnt / limit)),
        hasNext: page * limit < aggRow.cnt, hasPrev: page > 1,
      },
      totals: { count: aggRow.cnt, amount: aggRow.total }, // full filtered dataset, not just this page
    });
  });

  // Full filtered result set for CSV export — same filters, same scope, no
  // page cap beyond a sane safety ceiling. Never a second filter
  // implementation: this calls the exact same buildPaymentQuery().
  router.get('/api/payments/export', requireAuth, requireModule('payments'), async (req, res) => {
    const { from, where, params, orderBy } = await buildPaymentQuery(req);
    const rows = await all(`SELECT p.* ${from} ${where} ${orderBy} LIMIT 5000`, params);
    const enriched = await Promise.all(rows.map(async p => ({ ...p, classification: await classifyPayment(p.id) })));
    res.json({ payments: enriched, count: enriched.length });
  });

  router.get('/api/payments/:id/allocations', requireAuth, requireModule('payments'), async (req, res, next) => {
    const payment = await get('SELECT * FROM payments WHERE id = ?', [req.params.id]);
    if (!payment) return next({ status: 404, message: 'Payment not found' });
    const loan = await get('SELECT * FROM loans WHERE id = ?', [payment.loan_id]);
    try { await assertRecordInScope(req.user, loan ? loan.branch_id : null, 'payment'); } catch (e) { return next(e); }
    const rows = await all('SELECT * FROM payment_allocations WHERE payment_id = ? ORDER BY period', [req.params.id]);
    res.json({ allocations: rows, classification: await classifyPayment(req.params.id) });
  });

  // Real STK Push initiation — the actual missing bridge: initiateStkPush()
  // has existed for a while but was never reachable from any route.
  router.post('/api/payments/mpesa/initiate', requireAuth, requirePermission('record_payments'), async (req, res, next) => {
    const b = req.body;
    const loan = await get('SELECT * FROM loans WHERE id = ?', [b.loan_id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    try { await assertRecordInScope(req.user, loan.branch_id, 'loan'); } catch (e) { return next(e); }
    if (!b.phone || !b.amount || b.amount <= 0) return next({ status: 400, message: 'phone and a positive amount are required' });
    const mpesa = require('./../integrations/mpesa');
    try {
      const result = await mpesa.initiateStkPush({ phone: b.phone, amount: b.amount, loanId: loan.id, accountRef: b.account_ref, initiatedBy: req.user.id });
      await logAction(req, { action: 'Initiated M-Pesa STK push', module: 'mpesa', recordType: 'Loan', recordId: loan.id, newValue: { status: result.status, amount: b.amount } });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/payments', requireAuth, requirePermission('record_payments'), async (req, res, next) => {
    const b = req.body;
    const loan = await get('SELECT * FROM loans WHERE id = ?', [b.loan_id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    try { await assertRecordInScope(req.user, loan.branch_id, 'loan'); } catch (e) { return next(e); }
    if (!b.amount || b.amount <= 0) return next({ status: 400, message: 'amount must be positive' });
    try { await assertPeriodOpen(); } catch (e) { return next(e); }

    // Duplicate-payment guard: the same loan/amount/channel recorded again
    // within a short window is almost always a double-submit (e.g. a
    // double-tapped "Record Payment" button), not two genuine payments.
    // A genuine second payment for the same amount is still possible — the
    // caller can pass `confirm_duplicate: true` to force it through.
    if (!b.confirm_duplicate) {
      const recentDup = await get(
        `SELECT id FROM payments WHERE loan_id = ? AND amount = ? AND channel = ? AND status != 'Reversed'
         AND created_at > iso_offset(interval '-2 minutes')`,
        [loan.id, b.amount, b.channel || 'Cash']
      );
      if (recentDup) return next({ status: 409, message: 'A matching payment was just recorded for this loan — resubmit with confirm_duplicate:true if this is genuinely a second payment', code: 'POSSIBLE_DUPLICATE' });
    }

    const id = 'pm_' + crypto.randomUUID();
    const post = b.posted !== false;
    const reference = 'RCV' + Math.floor(Math.random() * 900000 + 100000);
    // Real transaction boundary — the audit's critical finding. The
    // payment insert, its schedule allocation, its status update, and its
    // journal entries must all commit together or none of them do. Before
    // this, a crash between any two of these steps could leave a payment
    // recorded with no matching journal entry, or vice versa.
    let status = 'Unposted', allocP = 0, allocI = 0, allocPen = 0, overpay = 0;
    await transaction(async () => {
      // Insert the payment row first (Unposted, zero-allocated) so
      // payment_allocations — which references payments(id) by real foreign
      // key — has something to reference. allocate() runs second and
      // updates this same row's status/allocation once it's done.
      await run(
        `INSERT INTO payments (id, loan_id, client_id, amount, channel, reference, status, allocated_principal, allocated_interest, allocated_penalty, recorded_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, loan.id, loan.client_id, b.amount, b.channel || 'Cash', reference, 'Unposted', 0, 0, 0, req.user.id]
      );
      if (post) {
        const result = await allocate(loan.id, b.amount, id);
        status = result.remaining > 0 ? 'Overpayment' : 'Posted';
        allocP = result.allocPrincipal; allocI = result.allocInterest; allocPen = result.allocPenalty; overpay = result.remaining;
        await run('UPDATE payments SET status = ?, allocated_principal = ?, allocated_interest = ?, allocated_penalty = ? WHERE id = ?', [status, allocP, allocI, allocPen, id]);
        await postPaymentJournal({ paymentId: id, loanId: loan.id, amount: b.amount, channel: b.channel, allocPrincipal: allocP, allocInterest: allocI, allocPenalty: allocPen, overpay, userId: req.user.id, branchId: loan.branch_id });
        const stillOwed = (await get('SELECT COALESCE(SUM((total_due - paid_amount) + (penalty_due - penalty_paid)),0) as bal FROM loan_schedule WHERE loan_id = ?', [loan.id])).bal;
        if (stillOwed <= 0.01) await run('UPDATE loans SET status = ? WHERE id = ?', ['Completed', loan.id]);
      }
    });
    await logAction(req, { action: post ? 'Recorded payment' : 'Recorded unposted payment', module: 'payments', recordType: 'Payment', recordId: id, newValue: { amount: b.amount, loan_id: loan.id } });
    if (loan.officer_id) await notify(loan.officer_id, 'payment', 'Payment received', `${b.amount} received for loan ${loan.id} via ${b.channel || 'Cash'}.`);
    res.status(201).json({ payment: await get('SELECT * FROM payments WHERE id = ?', [id]) });
  });

  router.post('/api/payments/:id/post', requireAuth, requirePermission('record_payments'), async (req, res, next) => {
    const payment = await get('SELECT * FROM payments WHERE id = ?', [req.params.id]);
    if (!payment) return next({ status: 404, message: 'Payment not found' });
    const loan = await get('SELECT * FROM loans WHERE id = ?', [payment.loan_id]);
    try { await assertRecordInScope(req.user, loan ? loan.branch_id : null, 'payment'); } catch (e) { return next(e); }
    if (payment.status !== 'Unposted') return next({ status: 409, message: 'Payment is not in an unposted state' });
    try { await assertPeriodOpen(); } catch (e) { return next(e); }
    let result;
    await transaction(async () => {
      result = await allocate(payment.loan_id, payment.amount, payment.id);
      const status = result.remaining > 0 ? 'Overpayment' : 'Posted';
      await run('UPDATE payments SET status = ?, allocated_principal = ?, allocated_interest = ?, allocated_penalty = ? WHERE id = ?', [status, result.allocPrincipal, result.allocInterest, result.allocPenalty, payment.id]);
      // This was missing before: posting a previously-unposted payment must
      // hit the ledger exactly like an immediately-posted one does, or the
      // money silently never appears in cash position / P&L.
      await postPaymentJournal({ paymentId: payment.id, loanId: payment.loan_id, amount: payment.amount, channel: payment.channel, allocPrincipal: result.allocPrincipal, allocInterest: result.allocInterest, allocPenalty: result.allocPenalty, overpay: result.remaining, userId: req.user.id, branchId: loan.branch_id });
    });
    await logAction(req, { action: 'Posted payment', module: 'payments', recordType: 'Payment', recordId: payment.id });
    res.json({ payment: await get('SELECT * FROM payments WHERE id = ?', [payment.id]) });
  });

  router.post('/api/payments/:id/reverse', requireAuth, requirePermission('reverse_payment'), async (req, res, next) => {
    const payment = await get('SELECT * FROM payments WHERE id = ?', [req.params.id]);
    if (!payment) return next({ status: 404, message: 'Payment not found' });
    const loan = await get('SELECT * FROM loans WHERE id = ?', [payment.loan_id]);
    try { await assertRecordInScope(req.user, loan ? loan.branch_id : null, 'payment'); } catch (e) { return next(e); }
    if (payment.status === 'Reversed') return next({ status: 409, message: 'Already reversed — double reversal is not permitted' });
    await transaction(async () => {
      if (payment.status !== 'Unposted') {
        let toUnwind = payment.amount;
        const rows = await all('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY period DESC', [payment.loan_id]);
        for (const row of rows) {
          if (toUnwind <= 0) break;
          if (row.paid_amount <= 0 && row.penalty_paid <= 0) continue;
          // Undo in the exact reverse of allocate()'s own priority: this
          // payment paid off principal/interest first and any penalty
          // second, so unwinding it undoes the penalty portion first.
          const undoPenalty = Math.min(row.penalty_paid, toUnwind);
          const newPenaltyPaid = row.penalty_paid - undoPenalty;
          toUnwind -= undoPenalty;
          const undo = Math.min(row.paid_amount, toUnwind);
          const newPaid = row.paid_amount - undo;
          toUnwind -= undo;
          const newStatus = (newPaid <= 0 && newPenaltyPaid <= 0) ? 'Pending' : 'Partial';
          await run('UPDATE loan_schedule SET paid_amount = ?, penalty_paid = ?, status = ? WHERE id = ?', [newPaid, newPenaltyPaid, newStatus, row.id]);
        }
        await run(`UPDATE loans SET status = 'Active' WHERE id = ? AND status = 'Completed'`, [payment.loan_id]);
        const overpay = Math.max(0, payment.amount - payment.allocated_principal - payment.allocated_interest - payment.allocated_penalty);
        await reversePaymentJournal({ paymentId: payment.id, loanId: payment.loan_id, amount: payment.amount, channel: payment.channel, allocPrincipal: payment.allocated_principal, allocInterest: payment.allocated_interest, allocPenalty: payment.allocated_penalty, overpay, userId: req.user.id, branchId: loan ? loan.branch_id : null });
      }
      await run('UPDATE payments SET status = ? WHERE id = ?', ['Reversed', payment.id]);
      // Reversed money is no longer "allocated" anywhere — a reversed
      // payment must not still show up as a prepayment/arrears/current
      // classification, since the underlying schedule rows it touched were
      // just unwound above.
      await run('DELETE FROM payment_allocations WHERE payment_id = ?', [payment.id]);
    });
    await logAction(req, { action: 'Reversed payment', module: 'payments', recordType: 'Payment', recordId: payment.id, reason: req.body.reason });
    res.json({ payment: await get('SELECT * FROM payments WHERE id = ?', [payment.id]) });
  });
}

module.exports = { register, allocate, glAccountFor, postPaymentJournal, reversePaymentJournal, accrueOverduePenalties };
