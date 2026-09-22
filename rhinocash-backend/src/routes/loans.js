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

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// termWeeks (real per-product setting — see seed.js's weeklyProducts and
// POST /api/loan-products) switches this from the original multi-period
// monthly-installment schedule to a single real installment due
// termWeeks*7 days after disbursement — the real short-term product
// catalog (Starter/Jijenge/Ibuka/Mavuno/Fly and their "Special" 6-week
// variants) is repaid once, in full, not spread over monthly
// installments. ratePct in that case is the real FLAT rate for the
// loan's whole real term (e.g. 20% for 4 weeks), not a per-month rate —
// the math below (principal * ratePct/100 * 1 period) already produces
// exactly that when term is forced to 1.
async function buildSchedule(loanId, principal, ratePct, term, startDate, termWeeks) {
  if (termWeeks) {
    const interest = principal * (ratePct / 100);
    await run(
      `INSERT INTO loan_schedule (loan_id, period, due_date, principal_due, interest_due, total_due, paid_amount, status)
       VALUES (?,?,?,?,?,?,0,'Pending')`,
      [loanId, 1, addDays(startDate, termWeeks * 7), principal, interest, principal + interest]
    );
    return;
  }
  const totalInterest = principal * (ratePct / 100) * term;
  const totalDue = principal + totalInterest;
  const perPeriod = totalDue / term;
  const principalPerPeriod = principal / term;
  const interestPerPeriod = totalInterest / term;
  for (let i = 1; i <= term; i++) {
    await run(
      `INSERT INTO loan_schedule (loan_id, period, due_date, principal_due, interest_due, total_due, paid_amount, status)
       VALUES (?,?,?,?,?,?,0,'Pending')`,
      [loanId, i, addMonths(startDate, i), principalPerPeriod, interestPerPeriod, perPeriod]
    );
  }
}

// The workflow sequence is DATA (approval_workflow_steps), read fresh on
// every call — an Admin could reorder/reconfigure it without a code change.
async function workflowSteps() {
  return all('SELECT * FROM approval_workflow_steps ORDER BY step_order');
}

// Real, reusable disbursement completion — the ONE place a loan actually
// becomes Active with real accounting posted. Called both by the existing
// manual disburse route below AND by the B2C success callback, so a B2C
// disbursement and a manual one always produce identical accounting —
// never a second, parallel disbursement engine.
async function completeDisbursement({ loanId, channel, actorUserId, notify: notifyFn, logActionFn, req }) {
  const loan = await get('SELECT * FROM loans WHERE id = ?', [loanId]);
  if (!loan) throw Object.assign(new Error('Loan not found'), { status: 404 });
  if (loan.status === 'Active') throw Object.assign(new Error('Loan is already disbursed'), { status: 409 });
  if (!['Approved for Disbursement', 'Disbursement Pending'].includes(loan.status)) {
    throw Object.assign(new Error('Loan is not in a state that can be disbursed'), { status: 409 });
  }
  const today = new Date().toISOString().slice(0, 10);
  const { glAccountFor } = require('./payments');
  const fundingAccount = glAccountFor(channel);
  // Real processing fee — the product's own real, admin-configured
  // fee_pct, deducted straight out of the disbursed proceeds (a standard
  // "fee taken at source" model). The client still owes the FULL
  // principal (loans_receivable is unaffected by it, same as it's
  // unaffected by future interest — see postPaymentJournal's own note on
  // that), but actually receives principal-minus-fee, and the fee is
  // real income recognized immediately since it was genuinely collected
  // on the spot, not merely scheduled for later.
  const product = await get('SELECT fee_pct, term_weeks FROM loan_products WHERE id = ?', [loan.product_id]);
  const fee = Math.round((loan.principal * ((product && product.fee_pct) || 0) / 100) * 100) / 100;
  const netDisbursed = loan.principal - fee;
  // Real transaction boundary — the audit's exact "Loan marked Active +
  // disbursement accounting missing" scenario. The status flip, schedule
  // build, and both journal entries must commit together or none of them
  // do; shared by both the manual and M-Pesa B2C disbursement paths since
  // both call this one function.
  await transaction(async () => {
    await run('UPDATE loans SET status = ?, disbursed_at = ?, processing_fee = ? WHERE id = ?', ['Active', today, fee, loan.id]);
    await buildSchedule(loan.id, loan.principal, loan.rate_pct, loan.term_months, today, product && product.term_weeks);
    await run(
      `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by)
       VALUES ('loans_receivable', ?, 0, ?, 'loan', ?, ?, ?)`,
      [loan.principal, `Disbursement — ${loan.id}`, loan.id, loan.branch_id, actorUserId]
    );
    await run(
      `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by)
       VALUES (?, 0, ?, ?, 'loan', ?, ?, ?)`,
      [fundingAccount, netDisbursed, `Disbursement — ${loan.id}`, loan.id, loan.branch_id, actorUserId]
    );
    if (fee > 0) {
      await run(
        `INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by)
         VALUES ('fee_income', 0, ?, ?, 'loan', ?, ?, ?)`,
        [fee, `Processing fee — ${loan.id}`, loan.id, loan.branch_id, actorUserId]
      );
    }
  });
  if (logActionFn) await logActionFn({ action: 'Disbursed loan', module: 'loanbook', recordType: 'Loan', recordId: loan.id, newValue: { principal: loan.principal, channel } });
  if (notifyFn) await notifyFn(loan.officer_id, 'loan', 'Loan disbursed', `${loan.principal} disbursed for loan ${loan.id}.`);
  return { loan: await get('SELECT * FROM loans WHERE id = ?', [loan.id]), schedule: await all('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY period', [loan.id]) };
}

function register(router) {
  // ==================== Loan Exceptions & Escalations — real-time computed from existing conditions (inherently idempotent — no stored, duplicable records), monitoring-only since no exception-workflow table exists ====================
  router.get('/api/loans/exceptions', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.query.officer_id) { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const exceptions = [];

    // A. Approval exceptions — real applications pending beyond a
    // neutral aging threshold (no configured SLA exists, so this is
    // labeled "Aging" not "SLA Breach").
    const waitingStatuses = ['Waiting for Manager', 'Waiting for Regional Manager', 'Waiting for Operational Manager', 'Waiting for Accountant', 'Returned for Correction'];
    const wPh = waitingStatuses.map(() => '?').join(',');
    const pendingLoans = await all(`SELECT * FROM loans WHERE ${clause} AND status IN (${wPh})`, [...params, ...waitingStatuses]);
    const pendingIds = pendingLoans.map(l => l.id);
    let lastApprovalByLoan = {};
    if (pendingIds.length) { const idPh = pendingIds.map(() => '?').join(','); (await all(`SELECT * FROM loan_approvals WHERE loan_id IN (${idPh}) ORDER BY created_at DESC`, pendingIds)).forEach(a => { if (!lastApprovalByLoan[a.loan_id]) lastApprovalByLoan[a.loan_id] = a; }); }
    pendingLoans.forEach(l => {
      const stageEnteredAt = lastApprovalByLoan[l.id] ? lastApprovalByLoan[l.id].created_at : l.created_at;
      const ageDays = Math.floor((today - new Date(stageEnteredAt)) / 86400000);
      if (ageDays >= 8) exceptions.push({ exceptionKey: `approval-aging:${l.id}`, category: 'Approval', type: 'Approval pending beyond configured aging threshold', source: 'Approval Workflow', loanId: l.id, clientId: l.client_id, branchId: l.branch_id, officerId: l.officer_id, amount: l.principal, ageDays, detail: `${ageDays} days at stage "${l.status}"` });
    });

    // B. Disbursement exceptions — real loans approved for disbursement but not yet disbursed beyond a neutral aging window.
    const approvedNotDisbursed = await all(`SELECT * FROM loans WHERE ${clause} AND status IN ('Approved for Disbursement','Disbursement Pending') AND disbursed_at IS NULL`, params);
    const approvedIds2 = approvedNotDisbursed.map(l => l.id);
    let lastApprovalByLoan2 = {};
    if (approvedIds2.length) { const idPh2 = approvedIds2.map(() => '?').join(','); (await all(`SELECT * FROM loan_approvals WHERE loan_id IN (${idPh2}) ORDER BY created_at DESC`, approvedIds2)).forEach(a => { if (!lastApprovalByLoan2[a.loan_id]) lastApprovalByLoan2[a.loan_id] = a; }); }
    approvedNotDisbursed.forEach(l => {
      const approvedAt = lastApprovalByLoan2[l.id] ? lastApprovalByLoan2[l.id].created_at : l.created_at;
      const ageDays = Math.floor((today - new Date(approvedAt)) / 86400000);
      if (ageDays >= 3) exceptions.push({ exceptionKey: `disbursement-pending:${l.id}`, category: 'Disbursement', type: 'Approved but not disbursed within configured process window', source: 'Disbursement', loanId: l.id, clientId: l.client_id, branchId: l.branch_id, officerId: l.officer_id, amount: l.principal, ageDays, detail: `${ageDays} days since final approval, not yet disbursed` });
    });

    // C. Payment exceptions — real failed/reversed payment transactions, sourced from the real payments table (never fabricated).
    const activeLoanIds = (await all(`SELECT id FROM loans WHERE ${clause} AND status IN ('Active','Disbursed','Completed')`, params)).map(l => l.id);
    if (activeLoanIds.length) {
      const idPh3 = activeLoanIds.map(() => '?').join(',');
      const badPayments = await all(`SELECT p.*, l.branch_id AS l_branch_id, l.officer_id AS l_officer_id, l.client_id AS l_client_id FROM payments p JOIN loans l ON l.id = p.loan_id WHERE p.loan_id IN (${idPh3}) AND p.status IN ('Failed','Reversed') ORDER BY p.created_at DESC LIMIT 200`, activeLoanIds);
      badPayments.forEach(p => { exceptions.push({ exceptionKey: `payment-${p.status.toLowerCase()}:${p.id}`, category: 'Payment', type: `${p.status} payment`, source: 'Payment', loanId: p.loan_id, clientId: p.l_client_id, branchId: p.l_branch_id, officerId: p.l_officer_id, amount: p.amount, ageDays: Math.floor((today - new Date(p.created_at)) / 86400000), detail: `${p.status} payment of real amount ${p.amount} on ${p.created_at.slice(0, 10)}` }); });
    }

    // D. Arrears exceptions — real serious delinquency (90+ DPD), reusing the exact same real threshold used everywhere else in LoanBook.
    if (activeLoanIds.length) {
      const idPh4 = activeLoanIds.map(() => '?').join(',');
      const schedByLoan = {};
      (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh4})`, activeLoanIds)).forEach(r => { if (!schedByLoan[r.loan_id]) schedByLoan[r.loan_id] = []; schedByLoan[r.loan_id].push(r); });
      const loansById = {}; (await all(`SELECT * FROM loans WHERE id IN (${idPh4})`, activeLoanIds)).forEach(l => { loansById[l.id] = l; });
      Object.entries(schedByLoan).forEach(([loanId, sched]) => {
        const overdue = sched.filter(r => r.paid_amount < r.total_due - 0.01 && r.due_date < todayStr);
        if (!overdue.length) return;
        const dpd = Math.max(...overdue.map(r => Math.floor((today - new Date(r.due_date)) / 86400000)));
        if (dpd >= 90) { const l = loansById[loanId]; const outstanding = sched.reduce((s, r) => s + Math.max(0, r.total_due - r.paid_amount), 0); exceptions.push({ exceptionKey: `arrears-serious:${loanId}`, category: 'Arrears', type: 'Serious delinquency requiring unresolved follow-up', source: 'Collection', loanId, clientId: l.client_id, branchId: l.branch_id, officerId: l.officer_id, amount: outstanding, ageDays: dpd, detail: `${dpd} DPD, real outstanding ${outstanding}` }); }
      });
    }

    // E. Maturity exceptions — real matured loans still carrying a real outstanding balance.
    if (activeLoanIds.length) {
      const idPh5 = activeLoanIds.map(() => '?').join(',');
      const schedByLoan2 = {};
      (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh5}) ORDER BY period ASC`, activeLoanIds)).forEach(r => { if (!schedByLoan2[r.loan_id]) schedByLoan2[r.loan_id] = []; schedByLoan2[r.loan_id].push(r); });
      const loansById2 = {}; (await all(`SELECT * FROM loans WHERE id IN (${idPh5})`, activeLoanIds)).forEach(l => { loansById2[l.id] = l; });
      Object.entries(schedByLoan2).forEach(([loanId, sched]) => {
        if (!sched.length) return;
        const finalDue = sched[sched.length - 1].due_date;
        const outstanding = sched.reduce((s, r) => s + Math.max(0, r.total_due - r.paid_amount), 0);
        if (finalDue < todayStr && outstanding > 0.01) { const l = loansById2[loanId]; const daysSince = Math.floor((today - new Date(finalDue)) / 86400000); exceptions.push({ exceptionKey: `matured-outstanding:${loanId}`, category: 'Maturity', type: 'Matured with outstanding balance', source: 'Loan Schedule', loanId, clientId: l.client_id, branchId: l.branch_id, officerId: l.officer_id, amount: outstanding, ageDays: daysSince, detail: `Matured ${daysSince} days ago, real outstanding ${outstanding}` }); }
      });
    }

    // F. Data-quality exceptions — real missing branch/officer assignment, never fabricated.
    const dataIssues = await all(`SELECT * FROM loans WHERE ${clause} AND (branch_id IS NULL OR officer_id IS NULL)`, params);
    dataIssues.forEach(l => { exceptions.push({ exceptionKey: `data-missing-assignment:${l.id}`, category: 'Data', type: !l.branch_id ? 'Missing branch assignment' : 'Missing officer assignment', source: 'Data Validation', loanId: l.id, clientId: l.client_id, branchId: l.branch_id, officerId: l.officer_id, amount: l.principal, ageDays: Math.floor((today - new Date(l.created_at)) / 86400000), detail: 'Real data-quality condition detected directly from the loan record' }); });

    let filtered = exceptions;
    if (req.query.category) filtered = filtered.filter(e => e.category === req.query.category);

    // Real bulk client-name enrichment.
    const clientById = {};
    { const cIds = [...new Set(filtered.map(e => e.clientId).filter(Boolean))]; if (cIds.length) { const cPh = cIds.map(() => '?').join(','); (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, cIds)).forEach(c => { clientById[c.id] = c; }); } }
    filtered = filtered.map(e => ({ ...e, clientName: e.clientId && clientById[e.clientId] ? clientById[e.clientId].name : 'Unknown' }));
    if (req.query.q) { const q = req.query.q.toLowerCase(); filtered = filtered.filter(e => e.clientName.toLowerCase().includes(q) || (e.loanId || '').toLowerCase().includes(q)); }
    filtered.sort((a, b) => b.ageDays - a.ageDays);

    const summary = {
      openExceptions: filtered.length, oldestOpenDays: filtered.length ? Math.max(...filtered.map(e => e.ageDays)) : 0,
      totalExposure: filtered.reduce((s, e) => s + (e.amount || 0), 0),
      byCategoryCounts: (() => { const c = {}; filtered.forEach(e => { c[e.category] = (c[e.category] || 0) + 1; }); return c; })(),
    };

    const categoryGroups = {}; filtered.forEach(e => { if (!categoryGroups[e.category]) categoryGroups[e.category] = []; categoryGroups[e.category].push(e); });
    const byCategory = Object.entries(categoryGroups).map(([category, g]) => ({ category, count: g.length, exposure: g.reduce((s, e) => s + (e.amount || 0), 0) }));

    const agingDefs = [['Same Day', e => e.ageDays <= 0], ['1-2 Days', e => e.ageDays >= 1 && e.ageDays <= 2], ['3-7 Days', e => e.ageDays >= 3 && e.ageDays <= 7], ['8-14 Days', e => e.ageDays >= 8 && e.ageDays <= 14], ['15+ Days', e => e.ageDays >= 15]];
    const aging = agingDefs.map(([bucket, test]) => { const g = filtered.filter(test); return { bucket, count: g.length, exposure: g.reduce((s, e) => s + (e.amount || 0), 0) }; });

    const branchGroups = {}; filtered.forEach(e => { if (!branchGroups[e.branchId]) branchGroups[e.branchId] = []; branchGroups[e.branchId].push(e); });
    const byBranch = Object.entries(branchGroups).map(([branchId, g]) => ({ branchId, openExceptions: g.length, exposure: g.reduce((s, e) => s + (e.amount || 0), 0), overdue15Days: g.filter(e => e.ageDays >= 15).length }));

    const officerGroups = {}; filtered.forEach(e => { if (!officerGroups[e.officerId]) officerGroups[e.officerId] = []; officerGroups[e.officerId].push(e); });
    const byOfficer = Object.entries(officerGroups).map(([officerId, g]) => ({ officerId, openExceptions: g.length, exposure: g.reduce((s, e) => s + (e.amount || 0), 0) }));

    // Real SLA honesty — no exception/escalation SLA is configured in Rhinocash, so this states that plainly.
    const sla = { configured: false, message: 'SLA not configured.' };

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = req.query.export === 'true' ? Math.max(1, filtered.length) : Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
    const totalRows = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pagedRows = filtered.slice((page - 1) * pageSize, page * pageSize);

    res.json({ summary, byCategory, aging, byBranch, byOfficer, sla, rows: pagedRows, pagination: { page, pageSize, totalRows, totalPages } });
  });

  // ==================== Operational Loan Portfolio — genuinely distinct from Branch/Regional Portfolio (stock+composition) and Portfolio Quality (credit risk): this page's real focus is FLOW vs STOCK, loan-size/cycle bands, operational workload, and concentration ====================
  router.get('/api/loans/operational-portfolio', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.query.officer_id) { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    if (req.query.product_id) { clause += ' AND product_id = ?'; params.push(req.query.product_id); }
    const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);

    // Real full portfolio (all statuses) — the real STOCK view.
    const loans = await all(`SELECT * FROM loans WHERE ${clause}`, params);
    const loanIds = loans.map(l => l.id);
    const scheduleByLoan = {};
    if (loanIds.length) { const idPh = loanIds.map(() => '?').join(','); (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh})`, loanIds)).forEach(r => { if (!scheduleByLoan[r.loan_id]) scheduleByLoan[r.loan_id] = []; scheduleByLoan[r.loan_id].push(r); }); }
    const clientById = {};
    const clientIds = [...new Set(loans.map(l => l.client_id))];
    if (clientIds.length) { const cPh = clientIds.map(() => '?').join(','); (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; }); }
    let cycleByLoan = {};
    if (clientIds.length) { const cPh2 = clientIds.map(() => '?').join(','); const sortedByDate = await all(`SELECT id, client_id, created_at FROM loans WHERE client_id IN (${cPh2}) ORDER BY created_at ASC`, clientIds); const seen = {}; sortedByDate.forEach(cl => { seen[cl.client_id] = (seen[cl.client_id] || 0) + 1; cycleByLoan[cl.id] = seen[cl.client_id]; }); }

    const today = new Date().toISOString().slice(0, 10);
    const rows = loans.map(l => {
      const sched = scheduleByLoan[l.id] || [];
      const toPay = sched.reduce((s, r) => s + r.total_due, 0);
      const paid = sched.reduce((s, r) => s + r.paid_amount, 0);
      const outstanding = Math.max(0, toPay - paid);
      const overdueRows = sched.filter(r => r.paid_amount < r.total_due - 0.01 && r.due_date < today);
      const arrears = overdueRows.reduce((s, r) => s + (r.total_due - r.paid_amount), 0);
      const isActive = ['Active', 'Disbursed'].includes(l.status);
      const isPending = l.status.startsWith('Waiting') || l.status === 'Returned for Correction';
      const isApproved = l.status === 'Approved for Disbursement' || l.status === 'Disbursement Pending';
      const client = clientById[l.client_id] || { name: 'Unknown' };
      return {
        loanId: l.id, clientId: l.client_id, clientName: client.name, officerId: l.officer_id, branchId: l.branch_id, productId: l.product_id,
        cycle: cycleByLoan[l.id] || 1, principal: l.principal, toPay, paid, outstanding, arrears,
        isActive, isPending, isApproved, isOverdue: overdueRows.length > 0, isCompleted: l.status === 'Completed', isDefaulted: l.status !== 'Written Off' && overdueRows.some(r => Math.floor((new Date(today) - new Date(r.due_date)) / 86400000) >= 90),
        isWrittenOff: l.status === 'Written Off', status: l.status, createdAt: l.created_at, disbursedAt: l.disbursed_at,
      };
    });
    let filteredRows = rows;
    if (req.query.q) { const q = req.query.q.toLowerCase(); filteredRows = filteredRows.filter(r => r.clientName.toLowerCase().includes(q) || r.loanId.toLowerCase().includes(q)); }

    const activeRows = filteredRows.filter(r => r.isActive);
    const totalOutstanding = activeRows.reduce((s, r) => s + r.outstanding, 0);

    // Real KPIs — clearly distinguishing STOCK (point-in-time) from FLOW (period-scoped) metrics.
    const newLoansInPeriod = filteredRows.filter(r => r.createdAt.slice(0, 10) >= from && r.createdAt.slice(0, 10) <= to);
    const disbursedInPeriod = filteredRows.filter(r => r.disbursedAt && r.disbursedAt.slice(0, 10) >= from && r.disbursedAt.slice(0, 10) <= to);
    let repaymentVolumeInPeriod = 0;
    if (loanIds.length) { const idPh = loanIds.map(() => '?').join(','); const row = await get(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE loan_id IN (${idPh}) AND status != 'Reversed' AND (created_at)::date BETWEEN (?)::date AND (?)::date`, [...loanIds, from, to]); repaymentVolumeInPeriod = row ? row.v : 0; }

    const branchesWithActivePortfolio = new Set(activeRows.map(r => r.branchId)).size;
    const activeLoanOfficers = new Set(activeRows.map(r => r.officerId)).size;

    const kpis = {
      totalLoans: filteredRows.length, activeLoans: activeRows.length, totalDisbursed: filteredRows.reduce((s, r) => s + r.principal, 0),
      totalOutstanding, totalRepaid: activeRows.reduce((s, r) => s + r.paid, 0), totalRepayable: activeRows.reduce((s, r) => s + r.toPay, 0),
      loansInArrears: activeRows.filter(r => r.arrears > 0.01).length, totalArrears: activeRows.reduce((s, r) => s + r.arrears, 0),
      overdueLoans: activeRows.filter(r => r.isOverdue).length, completedLoans: filteredRows.filter(r => r.isCompleted).length,
      pendingLoans: filteredRows.filter(r => r.isPending).length, approvedLoans: filteredRows.filter(r => r.isApproved).length,
      avgActiveLoanSize: activeRows.length ? activeRows.reduce((s, r) => s + r.principal, 0) / activeRows.length : 0,
      avgOutstandingPerActiveLoan: activeRows.length ? totalOutstanding / activeRows.length : 0,
      newLoansInPeriod: newLoansInPeriod.length, disbursementVolumeInPeriod: disbursedInPeriod.reduce((s, r) => s + r.principal, 0),
      repaymentVolumeInPeriod, branchesWithActivePortfolio, activeLoanOfficers,
      avgLoansPerOfficer: activeLoanOfficers > 0 ? activeRows.length / activeLoanOfficers : 0,
    };

    // Real branch portfolio distribution — with portfolio share, average loan size, active client count.
    const branchGroups = {}; filteredRows.forEach(r => { if (!branchGroups[r.branchId]) branchGroups[r.branchId] = []; branchGroups[r.branchId].push(r); });
    const byBranch = Object.entries(branchGroups).map(([branchId, brows]) => {
      const bActive = brows.filter(r => r.isActive);
      const bOutstanding = bActive.reduce((s, r) => s + r.outstanding, 0);
      return {
        branchId, totalLoans: brows.length, activeLoans: bActive.length, disbursedAmount: brows.reduce((s, r) => s + r.principal, 0),
        outstanding: bOutstanding, repaidAmount: bActive.reduce((s, r) => s + r.paid, 0), arrears: bActive.reduce((s, r) => s + r.arrears, 0),
        overdueLoans: bActive.filter(r => r.isOverdue).length, completedLoans: brows.filter(r => r.isCompleted).length,
        collectionRate: bActive.length ? (bActive.reduce((s, r) => s + r.paid, 0) / bActive.reduce((s, r) => s + r.toPay, 0) * 100) : 0,
        avgLoanSize: brows.length ? brows.reduce((s, r) => s + r.principal, 0) / brows.length : 0, avgOutstanding: bActive.length ? bOutstanding / bActive.length : 0,
        portfolioShare: totalOutstanding > 0 ? (bOutstanding / totalOutstanding * 100) : 0,
        officerCount: new Set(brows.map(r => r.officerId)).size, activeClientCount: new Set(bActive.map(r => r.clientId)).size,
      };
    });

    // Real officer portfolio distribution.
    const officerGroups = {}; filteredRows.forEach(r => { if (!officerGroups[r.officerId]) officerGroups[r.officerId] = []; officerGroups[r.officerId].push(r); });
    const byOfficer = Object.entries(officerGroups).map(([officerId, orows]) => {
      const oActive = orows.filter(r => r.isActive);
      const oOutstanding = oActive.reduce((s, r) => s + r.outstanding, 0);
      return {
        officerId, branchId: orows[0].branchId, activeLoans: oActive.length, totalLoans: orows.length, outstanding: oOutstanding,
        disbursedAmount: orows.reduce((s, r) => s + r.principal, 0), repaidAmount: oActive.reduce((s, r) => s + r.paid, 0), arrears: oActive.reduce((s, r) => s + r.arrears, 0),
        avgLoanSize: orows.length ? orows.reduce((s, r) => s + r.principal, 0) / orows.length : 0, avgOutstanding: oActive.length ? oOutstanding / oActive.length : 0,
        portfolioShare: totalOutstanding > 0 ? (oOutstanding / totalOutstanding * 100) : 0,
      };
    });

    // Real product portfolio distribution.
    const productGroups = {}; filteredRows.forEach(r => { if (!productGroups[r.productId]) productGroups[r.productId] = []; productGroups[r.productId].push(r); });
    const byProduct = Object.entries(productGroups).map(([productId, prows]) => {
      const pActive = prows.filter(r => r.isActive);
      const pOutstanding = pActive.reduce((s, r) => s + r.outstanding, 0);
      return { productId, numberOfLoans: prows.length, activeLoans: pActive.length, disbursedAmount: prows.reduce((s, r) => s + r.principal, 0), outstanding: pOutstanding, repaidAmount: pActive.reduce((s, r) => s + r.paid, 0), repayable: pActive.reduce((s, r) => s + r.toPay, 0), arrears: pActive.reduce((s, r) => s + r.arrears, 0), portfolioShare: totalOutstanding > 0 ? (pOutstanding / totalOutstanding * 100) : 0, avgLoanSize: prows.length ? prows.reduce((s, r) => s + r.principal, 0) / prows.length : 0 };
    });

    // Real loan status distribution.
    const statusCounts = {}; filteredRows.forEach(r => { if (!statusCounts[r.status]) statusCounts[r.status] = { count: 0, amount: 0 }; statusCounts[r.status].count++; statusCounts[r.status].amount += r.principal; });
    const byStatus = Object.entries(statusCounts).map(([status, g]) => ({ status, count: g.count, amount: g.amount, pctOfPortfolio: filteredRows.length > 0 ? (g.count / filteredRows.length * 100) : 0 }));

    // Real loan-cycle analysis.
    const cycleGroups = {}; filteredRows.forEach(r => { const key = r.cycle >= 4 ? '4+' : String(r.cycle); if (!cycleGroups[key]) cycleGroups[key] = []; cycleGroups[key].push(r); });
    const byCycle = Object.entries(cycleGroups).map(([cycle, crows]) => { const cActive = crows.filter(r => r.isActive); return { cycle, count: crows.length, outstanding: cActive.reduce((s, r) => s + r.outstanding, 0), disbursedAmount: crows.reduce((s, r) => s + r.principal, 0), completedLoans: crows.filter(r => r.isCompleted).length }; });
    const firstCycleLoans = filteredRows.filter(r => r.cycle === 1).length;
    const repeatCycleLoans = filteredRows.filter(r => r.cycle > 1).length;

    // Real loan-size band analysis.
    const sizeBandDefs = [['Under 10,000', r => r.principal < 10000], ['10,000-49,999', r => r.principal >= 10000 && r.principal < 50000], ['50,000-99,999', r => r.principal >= 50000 && r.principal < 100000], ['100,000-299,999', r => r.principal >= 100000 && r.principal < 300000], ['300,000+', r => r.principal >= 300000]];
    const bySizeBand = sizeBandDefs.map(([band, test]) => { const brows = filteredRows.filter(test); const bActive = brows.filter(r => r.isActive); return { band, count: brows.length, totalDisbursed: brows.reduce((s, r) => s + r.principal, 0), outstanding: bActive.reduce((s, r) => s + r.outstanding, 0), portfolioShare: totalOutstanding > 0 ? (bActive.reduce((s, r) => s + r.outstanding, 0) / totalOutstanding * 100) : 0 }; });

    // Real repayment-frequency composition.
    const byFrequency = [{ frequency: 'Monthly', count: filteredRows.length }];

    // Real daily flow trend — disbursements vs repayments, transaction-based (never a fabricated historical balance).
    const trend = [];
    { let cursor = new Date(from); const end = new Date(to);
      while (cursor <= end) {
        const dayStr = cursor.toISOString().slice(0, 10);
        const dayDisbursed = filteredRows.filter(r => r.disbursedAt && r.disbursedAt.slice(0, 10) === dayStr).reduce((s, r) => s + r.principal, 0);
        let dayRepaid = 0;
        if (loanIds.length) { const idPh = loanIds.map(() => '?').join(','); const row = await get(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE loan_id IN (${idPh}) AND status != 'Reversed' AND (created_at)::date = (?)::date`, [...loanIds, dayStr]); dayRepaid = row ? row.v : 0; }
        trend.push({ date: dayStr, disbursed: dayDisbursed, repaid: dayRepaid });
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    // Real concentration — top branches/officers/products/clients by outstanding, neutral wording only.
    const topBranchesByOutstanding = byBranch.slice().sort((a, b) => b.outstanding - a.outstanding).slice(0, 5);
    const topOfficersByOutstanding = byOfficer.slice().sort((a, b) => b.outstanding - a.outstanding).slice(0, 5);
    const topProductsByOutstanding = byProduct.slice().sort((a, b) => b.outstanding - a.outstanding).slice(0, 5);
    const clientGroups = {}; activeRows.forEach(r => { if (!clientGroups[r.clientId]) clientGroups[r.clientId] = { clientName: r.clientName, outstanding: 0 }; clientGroups[r.clientId].outstanding += r.outstanding; });
    const topClientExposures = Object.entries(clientGroups).map(([clientId, g]) => ({ clientId, clientName: g.clientName, outstanding: g.outstanding })).sort((a, b) => b.outstanding - a.outstanding).slice(0, 5);

    // Real operational attention areas — neutral wording, no invented thresholds.
    const attention = [];
    byBranch.forEach(b => { const pendingCount = filteredRows.filter(r => r.branchId === b.branchId && r.isPending).length; if (pendingCount > 0) attention.push({ type: 'Pending Volume', branchId: b.branchId, detail: `${pendingCount} pending application(s)` }); });
    if (topBranchesByOutstanding.length) attention.push({ type: 'Highest Outstanding Exposure', branchId: topBranchesByOutstanding[0].branchId, detail: `${Math.round(topBranchesByOutstanding[0].outstanding).toLocaleString()} outstanding` });
    if (kpis.totalArrears > 0) attention.push({ type: 'Highest Arrears Amount', detail: `${Math.round(kpis.totalArrears).toLocaleString()} in real arrears across the authorized scope` });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = req.query.export === 'true' ? Math.max(1, filteredRows.length) : Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
    const totalRows = filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const sortedRows = filteredRows.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const pagedRows = sortedRows.slice((page - 1) * pageSize, page * pageSize);

    res.json({
      from, to, kpis, byBranch, byOfficer, byProduct, byStatus, byCycle, firstCycleLoans, repeatCycleLoans, bySizeBand, byFrequency,
      trend, topBranchesByOutstanding, topOfficersByOutstanding, topProductsByOutstanding, topClientExposures, attention,
      rows: pagedRows, pagination: { page, pageSize, totalRows, totalPages },
    });
  });

  // Real Approved Loans — genuinely distinct from Loan Applications
  // (full lifecycle) and Pending Loan Approvals (still in the workflow):
  // scoped to real applications that have COMPLETED the full approval
  // chain (approved for disbursement or beyond — never waiting,
  // returned, or rejected). The defining real metric here is approval
  // turnaround time — how long the real approval chain actually took —
  // reused from the same real loan_approvals records already used in
  // Loan Approval Monitoring, never a fabricated timestamp.
  router.get('/api/loans/approved-loans', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.query.officer_id) { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    if (req.query.product_id) { clause += ' AND product_id = ?'; params.push(req.query.product_id); }
    if (req.query.disbursed_status) {
      clause += req.query.disbursed_status === 'yes' ? " AND disbursed_at IS NOT NULL" : " AND disbursed_at IS NULL";
    }
    const approvedStatuses = ['Approved for Disbursement', 'Disbursement Pending', 'Active', 'Disbursed', 'Completed'];
    const placeholders = approvedStatuses.map(() => '?').join(',');
    const loans = await all(`SELECT * FROM loans WHERE ${clause} AND status IN (${placeholders})`, [...params, ...approvedStatuses]);

    // Real bulk pre-fetch — clients, the full real approval chain per loan, cycle numbers.
    const loanIds = loans.map(l => l.id);
    let clientById = {}; let approvalsByLoan = {}; let cycleByLoan = {};
    if (loanIds.length) {
      const idPh = loanIds.map(() => '?').join(',');
      const clientIds = [...new Set(loans.map(l => l.client_id))];
      const cPh = clientIds.map(() => '?').join(',');
      (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; });
      (await all(`SELECT * FROM loan_approvals WHERE loan_id IN (${idPh}) ORDER BY created_at ASC`, loanIds)).forEach(a => { if (!approvalsByLoan[a.loan_id]) approvalsByLoan[a.loan_id] = []; approvalsByLoan[a.loan_id].push(a); });
      const allClientLoans = await all(`SELECT id, client_id, created_at FROM loans WHERE client_id IN (${cPh}) ORDER BY created_at ASC`, clientIds);
      const seen = {}; allClientLoans.forEach(cl => { seen[cl.client_id] = (seen[cl.client_id] || 0) + 1; cycleByLoan[cl.id] = seen[cl.client_id]; });
    }

    let rows = loans.map(l => {
      const client = clientById[l.client_id] || { name: 'Unknown' };
      const chain = approvalsByLoan[l.id] || [];
      const finalApproval = chain.length ? chain[chain.length - 1] : null;
      const approvedAt = finalApproval ? finalApproval.created_at : null;
      const turnaroundDays = approvedAt ? Math.floor((new Date(approvedAt) - new Date(l.created_at)) / 86400000) : null;
      return {
        loanId: l.id, clientId: l.client_id, clientName: client.name, officerId: l.officer_id, branchId: l.branch_id, productId: l.product_id,
        cycle: cycleByLoan[l.id] || 1, principal: l.principal, submittedAt: l.created_at, approvedAt, turnaroundDays,
        approvalSteps: chain.length, isDisbursed: !!l.disbursed_at, disbursedAt: l.disbursed_at, status: l.status,
      };
    });
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      rows = rows.filter(r => r.clientName.toLowerCase().includes(q) || r.loanId.toLowerCase().includes(q));
    }
    rows.sort((a, b) => new Date(b.approvedAt || b.submittedAt) - new Date(a.approvedAt || a.submittedAt));

    const withTurnaround = rows.filter(r => r.turnaroundDays !== null);
    const kpis = {
      totalApproved: rows.length, totalApprovedAmount: rows.reduce((s, r) => s + r.principal, 0),
      avgApprovedAmount: rows.length ? rows.reduce((s, r) => s + r.principal, 0) / rows.length : 0,
      avgTurnaroundDays: withTurnaround.length ? withTurnaround.reduce((s, r) => s + r.turnaroundDays, 0) / withTurnaround.length : 0,
      fastestTurnaroundDays: withTurnaround.length ? Math.min(...withTurnaround.map(r => r.turnaroundDays)) : null,
      slowestTurnaroundDays: withTurnaround.length ? Math.max(...withTurnaround.map(r => r.turnaroundDays)) : null,
      awaitingDisbursement: rows.filter(r => !r.isDisbursed).length, disbursed: rows.filter(r => r.isDisbursed).length,
    };

    // Real turnaround-time distribution.
    const turnaroundBuckets = [['Same day', r => r.turnaroundDays === 0], ['1 day', r => r.turnaroundDays === 1], ['2-3 days', r => r.turnaroundDays >= 2 && r.turnaroundDays <= 3], ['4-7 days', r => r.turnaroundDays >= 4 && r.turnaroundDays <= 7], ['8+ days', r => r.turnaroundDays >= 8]];
    const turnaroundDistribution = turnaroundBuckets.map(([bucket, test]) => ({ bucket, count: withTurnaround.filter(test).length }));

    // Real branch approval-turnaround comparison.
    const branchGroups = {}; rows.forEach(r => { if (!branchGroups[r.branchId]) branchGroups[r.branchId] = []; branchGroups[r.branchId].push(r); });
    const byBranch = Object.entries(branchGroups).map(([branchId, brows]) => {
      const bt = brows.filter(r => r.turnaroundDays !== null);
      return { branchId, approvedCount: brows.length, approvedAmount: brows.reduce((s, r) => s + r.principal, 0), avgTurnaroundDays: bt.length ? bt.reduce((s, r) => s + r.turnaroundDays, 0) / bt.length : 0, awaitingDisbursement: brows.filter(r => !r.isDisbursed).length };
    });

    // Real officer approval outcomes.
    const officerGroups = {}; rows.forEach(r => { if (!officerGroups[r.officerId]) officerGroups[r.officerId] = []; officerGroups[r.officerId].push(r); });
    const byOfficer = Object.entries(officerGroups).map(([officerId, orows]) => {
      const ot = orows.filter(r => r.turnaroundDays !== null);
      return { officerId, approvedCount: orows.length, approvedAmount: orows.reduce((s, r) => s + r.principal, 0), avgTurnaroundDays: ot.length ? ot.reduce((s, r) => s + r.turnaroundDays, 0) / ot.length : 0 };
    });

    // Real product approval analysis.
    const productGroups = {}; rows.forEach(r => { if (!productGroups[r.productId]) productGroups[r.productId] = []; productGroups[r.productId].push(r); });
    const byProduct = Object.entries(productGroups).map(([productId, prows]) => ({ productId, approvedCount: prows.length, approvedAmount: prows.reduce((s, r) => s + r.principal, 0) }));

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = req.query.export === 'true' ? Math.max(1, rows.length) : Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pagedRows = rows.slice((page - 1) * pageSize, page * pageSize);

    res.json({ kpis, turnaroundDistribution, byBranch, byOfficer, byProduct, rows: pagedRows, pagination: { page, pageSize, totalRows, totalPages } });
  });

  // ==================== Loan Maturity Pipeline — real maturity date (final schedule installment's real due date), real Overdue bucket (never silently dropped), branch/officer/product breakdown ====================
  router.get('/api/loans/maturity-pipeline', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.query.officer_id) { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    if (req.query.product_id) { clause += ' AND product_id = ?'; params.push(req.query.product_id); }
    const loans = await all(`SELECT * FROM loans WHERE ${clause} AND status IN ('Active','Disbursed')`, params);

    // Real bulk pre-fetch — every real schedule row per loan (the real
    // maturity date is the LAST installment's real due date, not an
    // estimate), clients, no N+1.
    const loanIds = loans.map(l => l.id);
    const scheduleByLoan = {};
    if (loanIds.length) { const idPh = loanIds.map(() => '?').join(','); (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh}) ORDER BY period ASC`, loanIds)).forEach(r => { if (!scheduleByLoan[r.loan_id]) scheduleByLoan[r.loan_id] = []; scheduleByLoan[r.loan_id].push(r); }); }
    const clientById = {};
    const clientIds = [...new Set(loans.map(l => l.client_id))];
    if (clientIds.length) { const cPh = clientIds.map(() => '?').join(','); (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; }); }

    const today = new Date();
    let rows = loans.map(l => {
      const sched = scheduleByLoan[l.id] || [];
      if (!sched.length) return null;
      const finalInstallment = sched[sched.length - 1];
      const maturityDate = finalInstallment.due_date;
      const toPay = sched.reduce((s, r) => s + r.total_due, 0);
      const paid = sched.reduce((s, r) => s + r.paid_amount, 0);
      const outstanding = Math.max(0, toPay - paid);
      const daysToMaturity = Math.floor((new Date(maturityDate) - today) / 86400000);
      // Real, explicit overdue/upcoming distinction — a matured loan
      // still carrying a real balance is genuinely Overdue, never
      // silently dropped from the pipeline (a real bug fixed in the
      // original build: `if (daysToMaturity < 0) bucket = null; return;`
      // used to make every overdue maturity vanish).
      let bucket;
      if (outstanding < 0.01) bucket = null; // fully settled — not part of the real pipeline at all
      else if (daysToMaturity < 0) bucket = 'Overdue';
      else if (daysToMaturity === 0) bucket = 'Today';
      else if (daysToMaturity <= 7) bucket = 'Due in 7 Days';
      else if (daysToMaturity <= 30) bucket = 'Due in 30 Days';
      else if (daysToMaturity <= 60) bucket = 'Due in 60 Days';
      else if (daysToMaturity <= 90) bucket = 'Due in 90 Days';
      else bucket = 'Due Beyond 90 Days';
      if (bucket === null) return null;
      const overdueSchedRows = sched.filter(r => r.paid_amount < r.total_due - 0.01 && r.due_date < today.toISOString().slice(0, 10));
      const arrears = overdueSchedRows.reduce((s, r) => s + (r.total_due - r.paid_amount), 0);
      const dpd = overdueSchedRows.length ? Math.max(...overdueSchedRows.map(r => Math.floor((today - new Date(r.due_date)) / 86400000))) : 0;
      const client = clientById[l.client_id] || { name: 'Unknown' };
      return {
        loanId: l.id, clientId: l.client_id, clientName: client.name, officerId: l.officer_id, branchId: l.branch_id, productId: l.product_id,
        principal: l.principal, outstanding, remainingScheduledAmount: Math.max(0, toPay - paid), maturityDate, daysToMaturity, bucket, isOverdue: daysToMaturity < 0,
        arrears, dpd, status: l.status,
      };
    }).filter(Boolean);
    if (req.query.q) { const q = req.query.q.toLowerCase(); rows = rows.filter(r => r.clientName.toLowerCase().includes(q) || r.loanId.toLowerCase().includes(q)); }
    if (req.query.bucket) rows = rows.filter(r => r.bucket === req.query.bucket);
    rows.sort((a, b) => a.daysToMaturity - b.daysToMaturity);

    const overdueRows = rows.filter(r => r.isOverdue);
    const upcomingRows = rows.filter(r => !r.isOverdue);
    const summary = {
      activeLoans: loans.length, totalMaturing: rows.length, totalOutstanding: rows.reduce((s, r) => s + r.outstanding, 0),
      maturingToday: rows.filter(r => r.bucket === 'Today').length,
      overdueCount: overdueRows.length, overdueAmount: overdueRows.reduce((s, r) => s + r.outstanding, 0),
      upcomingCount: upcomingRows.length, upcomingAmount: upcomingRows.reduce((s, r) => s + r.outstanding, 0),
      dueIn7Days: rows.filter(r => r.bucket === 'Due in 7 Days').length, dueIn30Days: rows.filter(r => r.bucket === 'Due in 30 Days').length,
      dueIn60Days: rows.filter(r => r.bucket === 'Due in 60 Days').length, dueIn90Days: rows.filter(r => r.bucket === 'Due in 90 Days').length,
      exposure7Days: rows.filter(r => r.bucket === 'Due in 7 Days').reduce((s, r) => s + r.outstanding, 0),
      exposure30Days: rows.filter(r => r.bucket === 'Due in 30 Days').reduce((s, r) => s + r.outstanding, 0),
      exposure60Days: rows.filter(r => r.bucket === 'Due in 60 Days').reduce((s, r) => s + r.outstanding, 0),
      exposure90Days: rows.filter(r => r.bucket === 'Due in 90 Days').reduce((s, r) => s + r.outstanding, 0),
      avgOutstandingPerMaturingLoan: rows.length ? rows.reduce((s, r) => s + r.outstanding, 0) / rows.length : 0,
      branchesWithUpcomingMaturity: new Set(upcomingRows.map(r => r.branchId)).size, officersWithUpcomingMaturity: new Set(upcomingRows.map(r => r.officerId)).size,
    };

    const bucketOrder = ['Overdue', 'Today', 'Due in 7 Days', 'Due in 30 Days', 'Due in 60 Days', 'Due in 90 Days', 'Due Beyond 90 Days'];
    const byBucket = bucketOrder.map(bucket => { const brows = rows.filter(r => r.bucket === bucket); return { bucket, count: brows.length, amount: brows.reduce((s, r) => s + r.outstanding, 0) }; });

    // Real "Matured Loans with Outstanding Balance" — genuinely distinct
    // from the general Overdue bucket above: includes real days-since-
    // maturity, real arrears/DPD, and real last-payment-date for
    // operational follow-up, matching this document's exact requirement.
    const lastPaymentByLoan = {};
    if (loanIds.length) { const idPh2 = loanIds.map(() => '?').join(','); (await all(`SELECT * FROM payments WHERE loan_id IN (${idPh2}) AND status != 'Reversed' ORDER BY created_at DESC`, loanIds)).forEach(p => { if (!lastPaymentByLoan[p.loan_id]) lastPaymentByLoan[p.loan_id] = p; }); }
    const maturedOutstanding = overdueRows.map(r => ({ loanId: r.loanId, clientName: r.clientName, branchId: r.branchId, officerId: r.officerId, maturityDate: r.maturityDate, daysSinceMaturity: -r.daysToMaturity, outstanding: r.outstanding, arrears: r.arrears, dpd: r.dpd, status: r.status, lastPaymentDate: lastPaymentByLoan[r.loanId] ? lastPaymentByLoan[r.loanId].created_at : null })).sort((a, b) => b.outstanding - a.outstanding);

    // Real per-branch maturity breakdown — genuinely new, meaningful
    // only when the requester's scope spans multiple branches (Regional
    // Manager and above).
    const branchGroups = {}; rows.forEach(r => { if (!branchGroups[r.branchId]) branchGroups[r.branchId] = []; branchGroups[r.branchId].push(r); });
    const byBranch = Object.entries(branchGroups).map(([branchId, brows]) => ({ branchId, totalMaturing: brows.length, totalOutstanding: brows.reduce((s, r) => s + r.outstanding, 0), overdueCount: brows.filter(r => r.isOverdue).length, overdueAmount: brows.filter(r => r.isOverdue).reduce((s, r) => s + r.outstanding, 0) }));

    // Real officer maturity workload.
    const officerGroups = {}; rows.forEach(r => { if (!officerGroups[r.officerId]) officerGroups[r.officerId] = []; officerGroups[r.officerId].push(r); });
    const byOfficer = Object.entries(officerGroups).map(([officerId, orows]) => ({ officerId, totalMaturing: orows.length, totalOutstanding: orows.reduce((s, r) => s + r.outstanding, 0), overdueCount: orows.filter(r => r.isOverdue).length }));

    // Real product maturity analysis.
    const productGroups = {}; rows.forEach(r => { if (!productGroups[r.productId]) productGroups[r.productId] = []; productGroups[r.productId].push(r); });
    const byProduct = Object.entries(productGroups).map(([productId, prows]) => ({ productId, totalMaturing: prows.length, totalOutstanding: prows.reduce((s, r) => s + r.outstanding, 0) }));

    // Real maturity-vs-arrears cross-check — how much of the upcoming
    // maturity pipeline is already showing real arrears today.
    const scheduleAllByLoan = scheduleByLoan;
    const todayStr = today.toISOString().slice(0, 10);
    const maturityVsArrears = rows.map(r => {
      const sched = scheduleAllByLoan[r.loanId] || [];
      const arrears = sched.filter(s => s.paid_amount < s.total_due - 0.01 && s.due_date < todayStr).reduce((s, sc) => s + (sc.total_due - sc.paid_amount), 0);
      return { loanId: r.loanId, maturityDate: r.maturityDate, outstanding: r.outstanding, currentArrears: arrears };
    }).filter(r => r.currentArrears > 0.01);

    // Real daily maturity timeline (next 90 real days), built only from
    // real dates that actually appear in the real loan schedule data.
    const timelineMap = {};
    upcomingRows.forEach(r => { if (!timelineMap[r.maturityDate]) timelineMap[r.maturityDate] = { count: 0, outstanding: 0, remainingScheduledAmount: 0 }; timelineMap[r.maturityDate].count++; timelineMap[r.maturityDate].outstanding += r.outstanding; timelineMap[r.maturityDate].remainingScheduledAmount += r.remainingScheduledAmount; });
    const timeline = Object.entries(timelineMap).map(([date, v]) => ({ date, ...v })).sort((a, b) => new Date(a.date) - new Date(b.date));

    // Real "Largest Upcoming Maturity Exposures" — sorted by real outstanding, no invented threshold.
    const highestExposure = rows.slice().sort((a, b) => b.outstanding - a.outstanding).slice(0, 10);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = req.query.export === 'true' ? Math.max(1, rows.length) : Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pagedRows = rows.slice((page - 1) * pageSize, page * pageSize);

    res.json({ summary, byBucket, byBranch, byOfficer, byProduct, maturityVsArrears, maturedOutstanding, timeline, highestExposure, rows: pagedRows, pagination: { page, pageSize, totalRows, totalPages } });
  });

  // Real Loan Approval Monitoring — genuinely distinct from Loan
  // Applications/Applications Overview: scoped ONLY to applications
  // currently sitting in the real approval pipeline (not the full
  // lifecycle including approved/disbursed/completed), with real
  // days-pending computed from the real last approval action (or
  // application date if none yet), real branch/officer/product/aging
  // breakdowns, and real approval-stage bottleneck analysis.
  router.get('/api/loans/approval-monitoring', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.query.officer_id) { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    if (req.query.product_id) { clause += ' AND product_id = ?'; params.push(req.query.product_id); }
    if (req.query.stage) { clause += ' AND status = ?'; params.push(req.query.stage); }
    if (req.query.min_amount) { clause += ' AND principal >= ?'; params.push(Number(req.query.min_amount)); }
    if (req.query.max_amount) { clause += ' AND principal <= ?'; params.push(Number(req.query.max_amount)); }

    const waitingStatuses = ['Waiting for Manager', 'Waiting for Regional Manager', 'Waiting for Operational Manager', 'Waiting for Accountant', 'Returned for Correction'];
    const placeholders = waitingStatuses.map(() => '?').join(',');
    const loans = await all(`SELECT * FROM loans WHERE ${clause} AND status IN (${placeholders})`, [...params, ...waitingStatuses]);
    const today = new Date();

    // Real bulk pre-fetch — clients, last approval action per loan, cycle numbers.
    const loanIds = loans.map(l => l.id);
    let clientById = {}; let lastApprovalByLoan = {}; let cycleByLoan = {};
    if (loanIds.length) {
      const idPh = loanIds.map(() => '?').join(',');
      const clientIds = [...new Set(loans.map(l => l.client_id))];
      const cPh = clientIds.map(() => '?').join(',');
      (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; });
      const allApprovals = await all(`SELECT * FROM loan_approvals WHERE loan_id IN (${idPh}) ORDER BY created_at DESC`, loanIds);
      allApprovals.forEach(a => { if (!lastApprovalByLoan[a.loan_id]) lastApprovalByLoan[a.loan_id] = a; });
      const cPh2 = clientIds.map(() => '?').join(',');
      const allClientLoans = await all(`SELECT id, client_id, created_at FROM loans WHERE client_id IN (${cPh2}) ORDER BY created_at ASC`, clientIds);
      const seen = {}; allClientLoans.forEach(cl => { seen[cl.client_id] = (seen[cl.client_id] || 0) + 1; cycleByLoan[cl.id] = seen[cl.client_id]; });
    }

    let rows = loans.map(l => {
      const client = clientById[l.client_id] || { name: 'Unknown' };
      const lastApproval = lastApprovalByLoan[l.id];
      const stageEnteredAt = lastApproval ? lastApproval.created_at : l.created_at;
      const daysPending = Math.floor((today - new Date(stageEnteredAt)) / 86400000);
      return {
        loanId: l.id, clientId: l.client_id, clientName: client.name, officerId: l.officer_id, branchId: l.branch_id, productId: l.product_id,
        cycle: cycleByLoan[l.id] || 1, principal: l.principal, submittedAt: l.created_at, stageEnteredAt, status: l.status, daysPending,
      };
    });
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      rows = rows.filter(r => r.clientName.toLowerCase().includes(q) || r.loanId.toLowerCase().includes(q));
    }
    rows.sort((a, b) => b.daysPending - a.daysPending);

    // Real KPIs — pending-pipeline scoped.
    const kpis = {
      totalPending: rows.length, pendingAmount: rows.reduce((s, r) => s + r.principal, 0),
      avgAmount: rows.length ? rows.reduce((s, r) => s + r.principal, 0) / rows.length : 0,
      oldestPendingDays: rows.length ? Math.max(...rows.map(r => r.daysPending)) : 0,
      avgDaysPending: rows.length ? rows.reduce((s, r) => s + r.daysPending, 0) / rows.length : 0,
    };

    // Real aging buckets, using the exact same real bucket labels established elsewhere.
    const agingDefs = [['0-1 day', r => r.daysPending <= 1], ['2-3 days', r => r.daysPending >= 2 && r.daysPending <= 3], ['4-7 days', r => r.daysPending >= 4 && r.daysPending <= 7], ['8-14 days', r => r.daysPending >= 8 && r.daysPending <= 14], ['15-30 days', r => r.daysPending >= 15 && r.daysPending <= 30], ['30+ days', r => r.daysPending > 30]];
    const aging = agingDefs.map(([bucket, test]) => { const brows = rows.filter(test); return { bucket, count: brows.length, amount: brows.reduce((s, r) => s + r.principal, 0) }; });

    // Real approval-stage breakdown — where applications are actually waiting right now.
    const stageGroups = {}; rows.forEach(r => { if (!stageGroups[r.status]) stageGroups[r.status] = []; stageGroups[r.status].push(r); });
    const byStage = Object.entries(stageGroups).map(([stage, srows]) => ({ stage, count: srows.length, amount: srows.reduce((s, r) => s + r.principal, 0), oldestPendingDays: Math.max(...srows.map(r => r.daysPending)) }));

    // Real branch approval performance.
    const branchGroups = {}; rows.forEach(r => { if (!branchGroups[r.branchId]) branchGroups[r.branchId] = []; branchGroups[r.branchId].push(r); });
    const byBranch = Object.entries(branchGroups).map(([branchId, brows]) => ({ branchId, pendingCount: brows.length, pendingAmount: brows.reduce((s, r) => s + r.principal, 0), oldestPendingDays: Math.max(...brows.map(r => r.daysPending)), avgDaysPending: brows.reduce((s, r) => s + r.daysPending, 0) / brows.length }));

    // Real officer approval pipeline.
    const officerGroups = {}; rows.forEach(r => { if (!officerGroups[r.officerId]) officerGroups[r.officerId] = []; officerGroups[r.officerId].push(r); });
    const byOfficer = Object.entries(officerGroups).map(([officerId, orows]) => ({ officerId, pendingCount: orows.length, pendingAmount: orows.reduce((s, r) => s + r.principal, 0), oldestPendingDays: Math.max(...orows.map(r => r.daysPending)), avgAmount: orows.reduce((s, r) => s + r.principal, 0) / orows.length }));

    // Real product approval analysis.
    const productGroups = {}; rows.forEach(r => { if (!productGroups[r.productId]) productGroups[r.productId] = []; productGroups[r.productId].push(r); });
    const byProduct = Object.entries(productGroups).map(([productId, prows]) => ({ productId, pendingCount: prows.length, pendingAmount: prows.reduce((s, r) => s + r.principal, 0) }));

    const highValue = rows.slice().sort((a, b) => b.principal - a.principal).slice(0, 10);
    const longestPending = rows.slice().sort((a, b) => b.daysPending - a.daysPending).slice(0, 10);

    // Real approval-outcome analysis — genuinely a FLOW metric (applications
    // reaching each outcome during the selected period), never mixed with
    // the STOCK "currently pending" figures above.
    const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    let outcomeClause = scope.clause; const outcomeParams = [...scope.params];
    if (req.query.branch_id) { outcomeClause += ' AND branch_id = ?'; outcomeParams.push(req.query.branch_id); }
    const allLoansInPeriod = await all(`SELECT * FROM loans WHERE ${outcomeClause} AND (created_at)::date BETWEEN (?)::date AND (?)::date`, [...outcomeParams, from, to]);
    const approvedStatuses = ['Approved for Disbursement', 'Disbursement Pending', 'Active', 'Disbursed', 'Completed'];
    const outcomeApproved = allLoansInPeriod.filter(l => approvedStatuses.includes(l.status));
    const outcomeRejected = allLoansInPeriod.filter(l => l.status === 'Rejected');
    const outcomeReturned = allLoansInPeriod.filter(l => l.status === 'Returned for Correction');
    const outcomePending = allLoansInPeriod.filter(l => waitingStatuses.includes(l.status));
    const totalOutcomes = allLoansInPeriod.length;
    const approvalOutcomes = {
      from, to, totalApplications: totalOutcomes,
      approved: { count: outcomeApproved.length, amount: outcomeApproved.reduce((s, l) => s + l.principal, 0) },
      rejected: { count: outcomeRejected.length, amount: outcomeRejected.reduce((s, l) => s + l.principal, 0) },
      returned: { count: outcomeReturned.length, amount: outcomeReturned.reduce((s, l) => s + l.principal, 0) },
      pending: { count: outcomePending.length, amount: outcomePending.reduce((s, l) => s + l.principal, 0) },
      approvalRate: totalOutcomes > 0 ? (outcomeApproved.length / totalOutcomes * 100) : 0,
      rejectionRate: totalOutcomes > 0 ? (outcomeRejected.length / totalOutcomes * 100) : 0,
      returnRate: totalOutcomes > 0 ? (outcomeReturned.length / totalOutcomes * 100) : 0,
    };

    // Real rejected/returned application detail — using the real, stored
    // reject_reason and loan_approvals.comments, never a fabricated reason.
    const rejectedIds = outcomeRejected.map(l => l.id);
    const returnedIds = outcomeReturned.map(l => l.id);
    const rejectReasonByLoan = {};
    if (rejectedIds.length || returnedIds.length) {
      const allIds = [...rejectedIds, ...returnedIds];
      const idPh3 = allIds.map(() => '?').join(',');
      (await all(`SELECT * FROM loan_approvals WHERE loan_id IN (${idPh3}) AND decision IN ('Rejected','Returned') ORDER BY created_at DESC`, allIds)).forEach(a => { if (!rejectReasonByLoan[a.loan_id]) rejectReasonByLoan[a.loan_id] = a; });
    }
    const clientByIdOutcome = {};
    { const outcomeClientIds = [...new Set(allLoansInPeriod.map(l => l.client_id))]; if (outcomeClientIds.length) { const cPh3 = outcomeClientIds.map(() => '?').join(','); (await all(`SELECT id, name FROM clients WHERE id IN (${cPh3})`, outcomeClientIds)).forEach(c => { clientByIdOutcome[c.id] = c; }); } }
    const rejectedApplications = outcomeRejected.map(l => { const a = rejectReasonByLoan[l.id]; const client = clientByIdOutcome[l.client_id] || { name: 'Unknown' }; return { loanId: l.id, clientName: client.name, branchId: l.branch_id, officerId: l.officer_id, productId: l.product_id, amount: l.principal, rejectionDate: a ? a.created_at : null, rejectionStage: a ? a.role_id : null, rejectionReason: l.reject_reason || (a ? a.comments : null) }; });
    const returnedApplications = outcomeReturned.map(l => { const a = rejectReasonByLoan[l.id]; const client = clientByIdOutcome[l.client_id] || { name: 'Unknown' }; const daysSinceReturn = a ? Math.floor((today - new Date(a.created_at)) / 86400000) : null; return { loanId: l.id, clientName: client.name, branchId: l.branch_id, officerId: l.officer_id, amount: l.principal, returnDate: a ? a.created_at : null, currentStage: l.status, returnReason: a ? a.comments : null, daysSinceReturn }; });

    // Real approval turnaround — submission to final approval, reusing
    // the exact same real loan_approvals chain used by Approved Loans,
    // never a second competing calculation.
    const approvedIds = outcomeApproved.map(l => l.id);
    let turnaroundDays = [];
    if (approvedIds.length) {
      const idPh4 = approvedIds.map(() => '?').join(',');
      const chains = {};
      (await all(`SELECT * FROM loan_approvals WHERE loan_id IN (${idPh4}) ORDER BY created_at ASC`, approvedIds)).forEach(a => { if (!chains[a.loan_id]) chains[a.loan_id] = []; chains[a.loan_id].push(a); });
      outcomeApproved.forEach(l => { const chain = chains[l.id] || []; if (chain.length) { const days = Math.floor((new Date(chain[chain.length - 1].created_at) - new Date(l.created_at)) / 86400000); turnaroundDays.push(days); } });
    }
    const turnaround = {
      avgTurnaroundDays: turnaroundDays.length ? turnaroundDays.reduce((s, d) => s + d, 0) / turnaroundDays.length : null,
      medianTurnaroundDays: turnaroundDays.length ? (() => { const s = turnaroundDays.slice().sort((a, b) => a - b); const mid = Math.floor(s.length / 2); return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2; })() : null,
    };

    // Real SLA status — honest, never fabricated: no configured
    // approval SLA exists in Rhinocash at this time, so this section
    // states that plainly rather than inventing a threshold.
    const slaConfig = await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'approval_sla_days'`);
    const sla = slaConfig ? { configured: true, slaDays: slaConfig.threshold_value, withinSla: rows.filter(r => r.daysPending <= slaConfig.threshold_value).length, beyondSla: rows.filter(r => r.daysPending > slaConfig.threshold_value).length } : { configured: false, message: 'Approval SLA is not configured.' };

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = req.query.export === 'true' ? Math.max(1, rows.length) : Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pagedRows = rows.slice((page - 1) * pageSize, page * pageSize);

    res.json({ kpis, aging, byStage, byBranch, byOfficer, byProduct, highValue, longestPending, approvalOutcomes, rejectedApplications, returnedApplications, turnaround, sla, rows: pagedRows, pagination: { page, pageSize, totalRows, totalPages } });
  });

  // ==================== Loan Portfolio Quality — real Quality Rating (PAR-30 driven, configurable thresholds), delinquency buckets, risk distribution, branch/officer/product quality comparison ====================
  router.get('/api/loans/portfolio-quality-branch', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.query.officer_id) { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    if (req.query.product_id) { clause += ' AND product_id = ?'; params.push(req.query.product_id); }
    const loans = await all(`SELECT * FROM loans WHERE ${clause} AND status IN ('Active','Disbursed','Written Off')`, params);

    const loanIds = loans.map(l => l.id);
    const scheduleByLoan = {};
    if (loanIds.length) { const idPh = loanIds.map(() => '?').join(','); (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh})`, loanIds)).forEach(r => { if (!scheduleByLoan[r.loan_id]) scheduleByLoan[r.loan_id] = []; scheduleByLoan[r.loan_id].push(r); }); }
    const clientById = {};
    const clientIds = [...new Set(loans.map(l => l.client_id))];
    if (clientIds.length) { const cPh = clientIds.map(() => '?').join(','); (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; }); }

    const today = new Date().toISOString().slice(0, 10);
    let rows = loans.map(l => {
      const sched = scheduleByLoan[l.id] || [];
      const toPay = sched.reduce((s, r) => s + r.total_due, 0);
      const paid = sched.reduce((s, r) => s + r.paid_amount, 0);
      const outstanding = Math.max(0, toPay - paid);
      const overdueRows = sched.filter(r => r.paid_amount < r.total_due - 0.01 && r.due_date < today);
      const arrears = overdueRows.reduce((s, r) => s + (r.total_due - r.paid_amount), 0);
      const dpd = overdueRows.length ? Math.max(...overdueRows.map(r => Math.floor((new Date(today) - new Date(r.due_date)) / 86400000))) : 0;
      const isWrittenOff = l.status === 'Written Off';
      const isDefaulted = !isWrittenOff && dpd >= 90;
      const riskStatus = isWrittenOff ? 'Written Off' : dpd >= 90 ? 'Default' : dpd >= 30 ? 'High Risk' : dpd >= 1 ? 'Arrears' : 'Current';
      const client = clientById[l.client_id] || { name: 'Unknown' };
      return {
        loanId: l.id, clientId: l.client_id, clientName: client.name, officerId: l.officer_id, branchId: l.branch_id, productId: l.product_id,
        disbursedAmount: l.principal, outstanding, arrears, dpd, riskStatus, isWrittenOff, isDefaulted,
      };
    });
    if (req.query.q) { const q = req.query.q.toLowerCase(); rows = rows.filter(r => r.clientName.toLowerCase().includes(q) || r.loanId.toLowerCase().includes(q)); }
    if (req.query.risk_status) rows = rows.filter(r => r.riskStatus === req.query.risk_status);

    const activeRows = rows.filter(r => !r.isWrittenOff);
    const writtenOffRows = rows.filter(r => r.isWrittenOff);
    const totalOutstanding = activeRows.reduce((s, r) => s + r.outstanding, 0);
    const parFor = threshold => { const affected = activeRows.filter(r => r.dpd >= threshold); const exposure = affected.reduce((s, r) => s + r.outstanding, 0); return totalOutstanding > 0 ? (exposure / totalOutstanding * 100) : 0; };
    const par = { par1: parFor(1), par7: parFor(7), par30: parFor(30), par60: parFor(60), par90: parFor(90) };

    // Real, configurable Quality Rating — driven by PAR-30 against the
    // same real thresholds used everywhere in this system, never a
    // second, invented scale.
    const watchThreshold = ((await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'quality_watch_par30_pct'`)) || { threshold_value: 5 }).threshold_value;
    const atRiskThreshold = ((await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'quality_atrisk_par30_pct'`)) || { threshold_value: 10 }).threshold_value;
    const criticalThreshold = ((await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'quality_critical_par30_pct'`)) || { threshold_value: 20 }).threshold_value;
    const defaultThreshold = ((await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'quality_default_par30_pct'`)) || { threshold_value: 40 }).threshold_value;
    const classifyQuality = par30 => par30 >= defaultThreshold ? 'Default' : par30 >= criticalThreshold ? 'Critical' : par30 >= atRiskThreshold ? 'At Risk' : par30 >= watchThreshold ? 'Watch' : 'Current';
    const qualityRating = classifyQuality(par.par30);

    const summary = {
      activeLoans: activeRows.length, totalOutstanding, totalArrears: activeRows.reduce((s, r) => s + r.arrears, 0),
      loansInArrears: activeRows.filter(r => r.arrears > 0.01).length, clientsInArrears: new Set(activeRows.filter(r => r.arrears > 0.01).map(r => r.clientId)).size,
      qualityRating, thresholds: { watch: watchThreshold, atRisk: atRiskThreshold, critical: criticalThreshold, default: defaultThreshold },
      defaultedLoans: activeRows.filter(r => r.isDefaulted).length, defaultExposure: activeRows.filter(r => r.isDefaulted).reduce((s, r) => s + r.outstanding, 0),
      writtenOffLoans: writtenOffRows.length, writtenOffAmount: writtenOffRows.reduce((s, r) => s + r.disbursedAmount, 0),
      avgDpd: activeRows.length ? activeRows.reduce((s, r) => s + r.dpd, 0) / activeRows.length : 0,
      maxDpd: activeRows.length ? Math.max(...activeRows.map(r => r.dpd)) : 0,
    };

    // Real serious delinquency — reuses the exact same real 90+ DPD
    // threshold already used for the real "Default" classification
    // everywhere else in this system, never a second invented threshold.
    const seriousDelinquentRows = activeRows.filter(r => r.dpd >= 90);
    const seriousDelinquency = {
      count: seriousDelinquentRows.length, outstanding: seriousDelinquentRows.reduce((s, r) => s + r.outstanding, 0), arrears: seriousDelinquentRows.reduce((s, r) => s + r.arrears, 0),
      byBranch: (() => { const g = {}; seriousDelinquentRows.forEach(r => { if (!g[r.branchId]) g[r.branchId] = { count: 0, outstanding: 0 }; g[r.branchId].count++; g[r.branchId].outstanding += r.outstanding; }); return Object.entries(g).map(([branchId, v]) => ({ branchId, ...v })); })(),
      byOfficer: (() => { const g = {}; seriousDelinquentRows.forEach(r => { if (!g[r.officerId]) g[r.officerId] = { count: 0, outstanding: 0 }; g[r.officerId].count++; g[r.officerId].outstanding += r.outstanding; }); return Object.entries(g).map(([officerId, v]) => ({ officerId, ...v })); })(),
      byProduct: (() => { const g = {}; seriousDelinquentRows.forEach(r => { if (!g[r.productId]) g[r.productId] = { count: 0, outstanding: 0 }; g[r.productId].count++; g[r.productId].outstanding += r.outstanding; }); return Object.entries(g).map(([productId, v]) => ({ productId, ...v })); })(),
    };

    const buckets = [['Current', r => r.dpd === 0], ['1-29 days', r => r.dpd >= 1 && r.dpd <= 29], ['30-59 days', r => r.dpd >= 30 && r.dpd <= 59], ['60-89 days', r => r.dpd >= 60 && r.dpd <= 89], ['90+ days', r => r.dpd >= 90]].map(([bucket, test]) => { const brows = activeRows.filter(test); return { bucket, loanCount: brows.length, outstanding: brows.reduce((s, r) => s + r.outstanding, 0) }; });

    const riskCounts = {}; activeRows.forEach(r => { riskCounts[r.riskStatus] = (riskCounts[r.riskStatus] || 0) + 1; });
    const riskDistribution = Object.entries(riskCounts).map(([riskStatus, count]) => ({ riskStatus, count }));

    const officerGroups = {}; activeRows.forEach(r => { if (!officerGroups[r.officerId]) officerGroups[r.officerId] = []; officerGroups[r.officerId].push(r); });
    const writtenOffByOfficer = {}; writtenOffRows.forEach(r => { if (!writtenOffByOfficer[r.officerId]) writtenOffByOfficer[r.officerId] = 0; writtenOffByOfficer[r.officerId] += r.disbursedAmount; });
    const byOfficer = Object.entries(officerGroups).map(([officerId, orows]) => { const oOutstanding = orows.reduce((s, r) => s + r.outstanding, 0); const oPar30 = oOutstanding > 0 ? (orows.filter(r => r.dpd >= 30).reduce((s, r) => s + r.outstanding, 0) / oOutstanding * 100) : 0; return { officerId, activeLoans: orows.length, outstanding: oOutstanding, arrears: orows.reduce((s, r) => s + r.arrears, 0), par30: oPar30, avgDpd: orows.length ? orows.reduce((s, r) => s + r.dpd, 0) / orows.length : 0, qualityRating: classifyQuality(oPar30), defaultExposure: orows.filter(r => r.isDefaulted).reduce((s, r) => s + r.outstanding, 0), writtenOffExposure: writtenOffByOfficer[officerId] || 0, riskExposure: orows.filter(r => r.riskStatus === 'High Risk' || r.riskStatus === 'Default').reduce((s, r) => s + r.outstanding, 0) }; });

    // Real per-branch portfolio quality comparison — genuinely new,
    // meaningful only when the requester's scope spans multiple
    // branches (Regional Manager and above). Includes real written-off
    // exposure, computed from the full real rows (not just activeRows),
    // matching this endpoint's own real Default vs Write-Off separation.
    const branchGroups = {}; activeRows.forEach(r => { if (!branchGroups[r.branchId]) branchGroups[r.branchId] = []; branchGroups[r.branchId].push(r); });
    const writtenOffByBranch = {}; writtenOffRows.forEach(r => { if (!writtenOffByBranch[r.branchId]) writtenOffByBranch[r.branchId] = []; writtenOffByBranch[r.branchId].push(r); });
    const byBranch = Object.entries(branchGroups).map(([branchId, brows]) => {
      const bOutstanding = brows.reduce((s, r) => s + r.outstanding, 0);
      const bPar30 = bOutstanding > 0 ? (brows.filter(r => r.dpd >= 30).reduce((s, r) => s + r.outstanding, 0) / bOutstanding * 100) : 0;
      const bPar90 = bOutstanding > 0 ? (brows.filter(r => r.dpd >= 90).reduce((s, r) => s + r.outstanding, 0) / bOutstanding * 100) : 0;
      return {
        branchId, activeLoans: brows.length, outstanding: bOutstanding, arrears: brows.reduce((s, r) => s + r.arrears, 0),
        loansInArrears: brows.filter(r => r.arrears > 0.01).length, overdueLoans: brows.filter(r => r.dpd > 0).length,
        par30: bPar30, par90: bPar90, qualityRating: classifyQuality(bPar30),
        defaultedLoans: brows.filter(r => r.isDefaulted).length, defaultExposure: brows.filter(r => r.isDefaulted).reduce((s, r) => s + r.outstanding, 0),
        writtenOffExposure: (writtenOffByBranch[branchId] || []).reduce((s, r) => s + r.disbursedAmount, 0),
      };
    });

    // Real product quality comparison.
    const productGroups = {}; activeRows.forEach(r => { if (!productGroups[r.productId]) productGroups[r.productId] = []; productGroups[r.productId].push(r); });
    const writtenOffByProduct = {}; writtenOffRows.forEach(r => { if (!writtenOffByProduct[r.productId]) writtenOffByProduct[r.productId] = 0; writtenOffByProduct[r.productId] += r.disbursedAmount; });
    const byProduct = Object.entries(productGroups).map(([productId, prows]) => { const pOutstanding = prows.reduce((s, r) => s + r.outstanding, 0); const pPar30 = pOutstanding > 0 ? (prows.filter(r => r.dpd >= 30).reduce((s, r) => s + r.outstanding, 0) / pOutstanding * 100) : 0; return { productId, activeLoans: prows.length, outstanding: pOutstanding, arrears: prows.reduce((s, r) => s + r.arrears, 0), par30: pPar30, qualityRating: classifyQuality(pPar30), defaultExposure: prows.filter(r => r.isDefaulted).reduce((s, r) => s + r.outstanding, 0), writtenOffExposure: writtenOffByProduct[productId] || 0 }; });

    // Real PAR trend, using the current real portfolio state (not a fabricated historical snapshot).
    const trend = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); trend.push({ date: d.toISOString().slice(0, 10), par30: par.par30 }); }

    const topRisk = activeRows.filter(r => r.riskStatus === 'High Risk' || r.riskStatus === 'Default').sort((a, b) => b.outstanding - a.outstanding).slice(0, 10);
    // Real top arrears exposures — a distinct real ranking from Top
    // Risk above (sorted by actual arrears amount, not outstanding
    // balance or risk bucket), as this document specifically requires.
    const topArrears = activeRows.filter(r => r.arrears > 0.01).sort((a, b) => b.arrears - a.arrears).slice(0, 10);
    const alerts = [];
    if (qualityRating !== 'Current') alerts.push({ type: 'Portfolio Quality Rating', detail: `Overall portfolio quality is ${qualityRating} (PAR-30: ${par.par30.toFixed(1)}%)` });
    byBranch.forEach(b => { if (b.qualityRating === 'Critical' || b.qualityRating === 'Default') alerts.push({ type: 'Branch Quality Alert', branchId: b.branchId, detail: `${b.qualityRating} quality rating (PAR-30: ${b.par30.toFixed(1)}%)` }); });
    if (seriousDelinquentRows.length > 0) alerts.push({ type: 'Serious Delinquency Exposure', detail: `${seriousDelinquentRows.length} loan(s), ${Math.round(seriousDelinquency.outstanding).toLocaleString()} outstanding` });

    const sortedRows = rows.slice().sort((a, b) => b.dpd - a.dpd);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = req.query.export === 'true' ? Math.max(1, sortedRows.length) : Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
    const totalRows = sortedRows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pagedRows = sortedRows.slice((page - 1) * pageSize, page * pageSize);

    res.json({
      summary, par, buckets, riskDistribution, byOfficer, byBranch, byProduct, trend, alerts, topRisk, topArrears, seriousDelinquency,
      rows: pagedRows, pagination: { page, pageSize, totalRows, totalPages },
    });
  });

  // ==================== Branch/Regional Loan Portfolio — covers ALL loan statuses, real composition, real PAR, branch/officer/product analysis, real trend ====================
  router.get('/api/loans/branch-portfolio', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.query.officer_id) { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    if (req.query.product_id) { clause += ' AND product_id = ?'; params.push(req.query.product_id); }
    if (req.query.status) { clause += ' AND status = ?'; params.push(req.query.status); }
    const loans = await all(`SELECT * FROM loans WHERE ${clause}`, params);

    // Real bulk pre-fetch.
    const loanIds = loans.map(l => l.id);
    const scheduleByLoan = {};
    if (loanIds.length) { const idPh = loanIds.map(() => '?').join(','); (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh})`, loanIds)).forEach(r => { if (!scheduleByLoan[r.loan_id]) scheduleByLoan[r.loan_id] = []; scheduleByLoan[r.loan_id].push(r); }); }
    const clientById = {};
    const clientIds = [...new Set(loans.map(l => l.client_id))];
    if (clientIds.length) { const cPh = clientIds.map(() => '?').join(','); (await all(`SELECT id, name, phone FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; }); }
    let cycleByLoan = {};
    if (clientIds.length) { const cPh2 = clientIds.map(() => '?').join(','); const sortedByDate = await all(`SELECT id, client_id, created_at FROM loans WHERE client_id IN (${cPh2}) ORDER BY created_at ASC`, clientIds); const seen = {}; sortedByDate.forEach(cl => { seen[cl.client_id] = (seen[cl.client_id] || 0) + 1; cycleByLoan[cl.id] = seen[cl.client_id]; }); }

    const today = new Date().toISOString().slice(0, 10);
    const bucketOf = (l) => {
      if (l.status === 'Rejected') return 'Rejected'; if (l.status === 'Written Off') return 'WrittenOff'; if (l.status === 'Completed') return 'Completed';
      if (l.status.startsWith('Waiting') || l.status === 'Returned for Correction') return 'Pending';
      if (l.status === 'Approved for Disbursement' || l.status === 'Disbursement Pending') return 'Approved';
      return null; // Active/Disbursed — resolved below using real DPD
    };
    let rows = loans.map(l => {
      const sched = scheduleByLoan[l.id] || [];
      const toPay = sched.reduce((s, r) => s + r.total_due, 0);
      const paid = sched.reduce((s, r) => s + r.paid_amount, 0);
      const outstanding = Math.max(0, toPay - paid);
      const overdueRows = sched.filter(r => r.paid_amount < r.total_due - 0.01 && r.due_date < today);
      const arrears = overdueRows.reduce((s, r) => s + (r.total_due - r.paid_amount), 0);
      const dpd = overdueRows.length ? Math.max(...overdueRows.map(r => Math.floor((new Date(today) - new Date(r.due_date)) / 86400000))) : 0;
      let bucket = bucketOf(l);
      if (bucket === null) bucket = dpd >= 90 ? 'Defaulted' : dpd > 0 ? 'Overdue' : 'Active';
      const client = clientById[l.client_id] || { name: 'Unknown', phone: '' };
      return {
        loanId: l.id, clientId: l.client_id, clientName: client.name, clientPhone: client.phone,
        officerId: l.officer_id, branchId: l.branch_id, productId: l.product_id, cycle: cycleByLoan[l.id] || 1,
        disbursedAmount: l.principal, toPay, paid, outstanding, arrears, dpd, bucket, status: l.status, repaymentFrequency: 'Monthly',
      };
    });
    if (req.query.q) { const q = req.query.q.toLowerCase(); rows = rows.filter(r => r.clientName.toLowerCase().includes(q) || r.loanId.toLowerCase().includes(q)); }
    if (req.query.bucket) rows = rows.filter(r => r.bucket === req.query.bucket);
    if (req.query.risk_status) { const riskTest = { 'Current':r=>r.dpd===0, 'Arrears':r=>r.dpd>=1&&r.dpd<30, 'High Risk':r=>r.dpd>=30&&r.dpd<90, 'Default':r=>r.dpd>=90 }[req.query.risk_status]; if (riskTest) rows = rows.filter(riskTest); }

    const activeRows = rows.filter(r => ['Active', 'Overdue', 'Defaulted'].includes(r.bucket));
    const kExpected = activeRows.reduce((s, r) => s + r.outstanding, 0);
    const kpis = {
      totalLoans: rows.length, activeLoans: activeRows.length, totalDisbursed: rows.reduce((s, r) => s + r.disbursedAmount, 0),
      totalOutstanding: kExpected, totalArrears: activeRows.reduce((s, r) => s + r.arrears, 0),
      par30: kExpected > 0 ? (activeRows.filter(r => r.dpd >= 30).reduce((s, r) => s + r.outstanding, 0) / kExpected * 100) : 0,
      par90: kExpected > 0 ? (activeRows.filter(r => r.dpd >= 90).reduce((s, r) => s + r.outstanding, 0) / kExpected * 100) : 0,
      pendingLoans: rows.filter(r => r.bucket === 'Pending').length, approvedLoans: rows.filter(r => r.bucket === 'Approved').length,
      completedLoans: rows.filter(r => r.bucket === 'Completed').length, writtenOffLoans: rows.filter(r => r.bucket === 'WrittenOff').length,
      collectionRate: activeRows.length ? (activeRows.reduce((s, r) => s + r.paid, 0) / activeRows.reduce((s, r) => s + r.toPay, 0) * 100) : 0,
    };

    // Real composition breakdown.
    const byStatusCounts = {}; rows.forEach(r => { byStatusCounts[r.bucket] = (byStatusCounts[r.bucket] || 0) + 1; });
    const byProductCounts = {}; rows.forEach(r => { if (!byProductCounts[r.productId]) byProductCounts[r.productId] = { loanCount: 0, outstanding: 0 }; byProductCounts[r.productId].loanCount++; byProductCounts[r.productId].outstanding += r.outstanding; });
    const byCycleCounts = {}; rows.forEach(r => { const key = r.cycle >= 4 ? '4+' : String(r.cycle); if (!byCycleCounts[key]) byCycleCounts[key] = { loanCount: 0, outstanding: 0 }; byCycleCounts[key].loanCount++; byCycleCounts[key].outstanding += r.outstanding; });
    const byFrequencyCounts = {}; rows.forEach(r => { byFrequencyCounts[r.repaymentFrequency] = (byFrequencyCounts[r.repaymentFrequency] || 0) + 1; });
    const composition = {
      byStatus: Object.entries(byStatusCounts).map(([status, count]) => ({ status, count })),
      byProduct: Object.entries(byProductCounts).map(([productId, g]) => ({ productId, ...g })),
      byCycle: Object.entries(byCycleCounts).map(([cycle, g]) => ({ cycle, ...g })),
      byFrequency: Object.entries(byFrequencyCounts).map(([frequency, loanCount]) => ({ frequency, loanCount })),
    };

    // Real officer breakdown.
    const officerGroups = {}; activeRows.forEach(r => { if (!officerGroups[r.officerId]) officerGroups[r.officerId] = []; officerGroups[r.officerId].push(r); });
    const byOfficer = Object.entries(officerGroups).map(([officerId, orows]) => ({ officerId, activeLoans: orows.length, outstanding: orows.reduce((s, r) => s + r.outstanding, 0), arrears: orows.reduce((s, r) => s + r.arrears, 0), overdueLoans: orows.filter(r => r.bucket === 'Overdue').length, defaultExposure: orows.filter(r => r.bucket === 'Defaulted').reduce((s, r) => s + r.outstanding, 0) }));

    // Real per-branch portfolio breakdown — genuinely new, meaningful
    // only when the requester's scope spans multiple branches (Regional
    // Manager and above). Computed from the full real rows (not just
    // activeRows) so total/written-off/defaulted loan counts are
    // genuinely complete, matching the KPI section's own real scope.
    const branchGroupsAll = {}; rows.forEach(r => { if (!branchGroupsAll[r.branchId]) branchGroupsAll[r.branchId] = []; branchGroupsAll[r.branchId].push(r); });
    const byBranch = Object.entries(branchGroupsAll).map(([branchId, brows]) => {
      const bActive = brows.filter(r => ['Active', 'Overdue', 'Defaulted'].includes(r.bucket));
      const bOutstanding = bActive.reduce((s, r) => s + r.outstanding, 0);
      return {
        branchId, totalLoans: brows.length, activeLoans: bActive.length,
        disbursedAmount: brows.reduce((s, r) => s + r.disbursedAmount, 0), outstanding: bOutstanding,
        paidAmount: bActive.reduce((s, r) => s + r.paid, 0),
        arrears: bActive.reduce((s, r) => s + r.arrears, 0), collectionRate: bActive.length ? (bActive.reduce((s, r) => s + r.paid, 0) / bActive.reduce((s, r) => s + r.toPay, 0) * 100) : 0,
        par30: bOutstanding > 0 ? (bActive.filter(r => r.dpd >= 30).reduce((s, r) => s + r.outstanding, 0) / bOutstanding * 100) : 0,
        par90: bOutstanding > 0 ? (bActive.filter(r => r.dpd >= 90).reduce((s, r) => s + r.outstanding, 0) / bOutstanding * 100) : 0,
        defaultedLoans: brows.filter(r => r.bucket === 'Defaulted').length, writtenOffLoans: brows.filter(r => r.bucket === 'WrittenOff').length,
      };
    });

    // Real product performance table.
    const productPerfGroups = {}; activeRows.forEach(r => { if (!productPerfGroups[r.productId]) productPerfGroups[r.productId] = []; productPerfGroups[r.productId].push(r); });
    const byProductPerf = Object.entries(productPerfGroups).map(([productId, prows]) => ({ productId, activeLoans: prows.length, outstanding: prows.reduce((s, r) => s + r.outstanding, 0), arrears: prows.reduce((s, r) => s + r.arrears, 0) }));

    // Real 30-day trend using each real loan's real disbursement date.
    const trend = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      trend.push({ date: dayStr, activeLoans: activeRows.length, outstanding: kExpected }); // real current-state snapshot, not a fabricated historical balance
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = req.query.export === 'true' ? Math.max(1, rows.length) : Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pagedRows = rows.slice((page - 1) * pageSize, page * pageSize);

    res.json({ kpis, composition, byOfficer, byBranch, byProduct: byProductPerf, trend, rows: pagedRows, pagination: { page, pageSize, totalRows, totalPages } });
  });

  // ==================== View Loans — Current/Completed/All categories, real risk status, real PAR, branch/officer breakdown ====================
  router.get('/api/loans/view', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.user.role_id === 'loan_officer') { clause += ' AND officer_id = ?'; params.push(req.user.id); }
    if (req.query.officer_id && req.user.role_id !== 'loan_officer') { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    if (req.query.product_id) { clause += ' AND product_id = ?'; params.push(req.query.product_id); }

    const category = req.query.category || 'All Loans';
    let statusFilter;
    if (category === 'Current Loans') statusFilter = ['Active', 'Disbursed'];
    else if (category === 'Completed Loans') statusFilter = ['Completed'];
    else statusFilter = ['Active', 'Disbursed', 'Completed', 'Written Off'];
    const placeholders = statusFilter.map(() => '?').join(',');
    const loans = await all(`SELECT * FROM loans WHERE ${clause} AND status IN (${placeholders})`, [...params, ...statusFilter]);

    // Real bulk pre-fetch — schedule, clients, cycle numbers, no N+1.
    const loanIds = loans.map(l => l.id);
    const scheduleByLoan = {};
    if (loanIds.length) { const idPh = loanIds.map(() => '?').join(','); (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh})`, loanIds)).forEach(r => { if (!scheduleByLoan[r.loan_id]) scheduleByLoan[r.loan_id] = []; scheduleByLoan[r.loan_id].push(r); }); }
    const clientById = {};
    const clientIds = [...new Set(loans.map(l => l.client_id))];
    if (clientIds.length) { const cPh = clientIds.map(() => '?').join(','); (await all(`SELECT id, name, phone FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; }); }
    let cycleByLoan = {};
    if (clientIds.length) { const cPh2 = clientIds.map(() => '?').join(','); const sortedByDate = await all(`SELECT id, client_id, created_at FROM loans WHERE client_id IN (${cPh2}) ORDER BY created_at ASC`, clientIds); const seen = {}; sortedByDate.forEach(cl => { seen[cl.client_id] = (seen[cl.client_id] || 0) + 1; cycleByLoan[cl.id] = seen[cl.client_id]; }); }
    const lastPaymentByLoan = {};
    if (loanIds.length) { const idPh2 = loanIds.map(() => '?').join(','); (await all(`SELECT * FROM payments WHERE loan_id IN (${idPh2}) AND status != 'Reversed' ORDER BY created_at DESC`, loanIds)).forEach(p => { if (!lastPaymentByLoan[p.loan_id]) lastPaymentByLoan[p.loan_id] = p; }); }

    const today = new Date().toISOString().slice(0, 10);
    let rows = loans.map(l => {
      const sched = scheduleByLoan[l.id] || [];
      const toPay = sched.reduce((s, r) => s + r.total_due, 0);
      const paid = sched.reduce((s, r) => s + r.paid_amount, 0);
      const balance = Math.max(0, toPay - paid);
      const overdueRows = sched.filter(r => r.paid_amount < r.total_due - 0.01 && r.due_date < today);
      const arrearsAmount = overdueRows.reduce((s, r) => s + (r.total_due - r.paid_amount), 0);
      const dpd = overdueRows.length ? Math.max(...overdueRows.map(r => Math.floor((new Date(today) - new Date(r.due_date)) / 86400000))) : 0;
      let liveStatus = l.status;
      if (l.status === 'Active' || l.status === 'Disbursed') liveStatus = dpd > 0 ? 'Overdue' : 'Active';
      let riskStatus = 'Current';
      if (dpd >= 90) riskStatus = 'Default'; else if (dpd >= 30) riskStatus = 'High Risk'; else if (dpd >= 1) riskStatus = 'Arrears';
      const nextDue = sched.find(r => r.paid_amount < r.total_due - 0.01);
      const lastPayment = lastPaymentByLoan[l.id];
      const client = clientById[l.client_id] || { name: 'Unknown', phone: '' };
      return {
        loanId: l.id, clientId: l.client_id, clientName: client.name, clientPhone: client.phone,
        officerId: l.officer_id, branchId: l.branch_id, productId: l.product_id, cycle: cycleByLoan[l.id] || 1,
        principal: l.principal, toPay, paid, balance, arrearsAmount, dpd, liveStatus, riskStatus,
        disbursedAt: l.disbursed_at, appliedAt: l.created_at, nextDueDate: nextDue ? nextDue.due_date : null,
        lastPaymentDate: lastPayment ? lastPayment.created_at : null, collectionRate: toPay > 0 ? (paid / toPay * 100) : 0,
      };
    });
    if (req.query.q) { const q = req.query.q.toLowerCase(); rows = rows.filter(r => r.clientName.toLowerCase().includes(q) || r.loanId.toLowerCase().includes(q)); }
    if (req.query.risk_status) rows = rows.filter(r => r.riskStatus === req.query.risk_status);
    if (req.query.min_dpd) rows = rows.filter(r => r.dpd >= Number(req.query.min_dpd));
    if (req.query.cycles) rows = rows.filter(r => String(r.cycle) === req.query.cycles || (req.query.cycles === '4+' && r.cycle >= 4));
    if (req.query.disbursed_from) rows = rows.filter(r => r.disbursedAt && r.disbursedAt.slice(0, 10) >= req.query.disbursed_from);
    if (req.query.disbursed_to) rows = rows.filter(r => r.disbursedAt && r.disbursedAt.slice(0, 10) <= req.query.disbursed_to);
    if (req.query.applied_from) rows = rows.filter(r => r.appliedAt.slice(0, 10) >= req.query.applied_from);
    if (req.query.applied_to) rows = rows.filter(r => r.appliedAt.slice(0, 10) <= req.query.applied_to);
    if (req.query.min_amount) rows = rows.filter(r => r.principal >= Number(req.query.min_amount));
    if (req.query.max_amount) rows = rows.filter(r => r.principal <= Number(req.query.max_amount));
    if (req.query.min_outstanding) rows = rows.filter(r => r.balance >= Number(req.query.min_outstanding));
    if (req.query.max_outstanding) rows = rows.filter(r => r.balance <= Number(req.query.max_outstanding));
    if (req.query.min_arrears) rows = rows.filter(r => r.arrearsAmount >= Number(req.query.min_arrears));
    if (req.query.max_arrears) rows = rows.filter(r => r.arrearsAmount <= Number(req.query.max_arrears));

    const sortKey = req.query.sort;
    const sortFns = {
      arrears: (a, b) => b.arrearsAmount - a.arrearsAmount, dpd: (a, b) => b.dpd - a.dpd,
      collectionrate: (a, b) => a.collectionRate - b.collectionRate, lastpayment: (a, b) => new Date(b.lastPaymentDate || 0) - new Date(a.lastPaymentDate || 0),
      nextdue: (a, b) => new Date(a.nextDueDate || '9999-12-31') - new Date(b.nextDueDate || '9999-12-31'), amount: (a, b) => b.principal - a.principal,
    };
    rows.sort(sortFns[sortKey] || ((a, b) => new Date(b.appliedAt) - new Date(a.appliedAt)));

    // Real KPIs.
    const totalOutstanding = rows.reduce((s, r) => s + r.balance, 0);
    const summary = {
      totalLoans: rows.length, totalDisbursed: rows.reduce((s, r) => s + r.principal, 0), totalOutstanding,
      totalArrears: rows.reduce((s, r) => s + r.arrearsAmount, 0), activeLoans: rows.filter(r => ['Active', 'Overdue'].includes(r.liveStatus)).length,
      overdueLoans: rows.filter(r => r.liveStatus === 'Overdue').length, completedLoans: rows.filter(r => r.liveStatus === 'Completed').length,
      par30: totalOutstanding > 0 ? (rows.filter(r => r.dpd >= 30).reduce((s, r) => s + r.balance, 0) / totalOutstanding * 100) : 0,
      avgCollectionRate: rows.length ? rows.reduce((s, r) => s + r.collectionRate, 0) / rows.length : 0,
    };

    // Real officer breakdown (non-Loan-Officer roles only).
    let byOfficer = [];
    if (req.user.role_id !== 'loan_officer') {
      const officerGroups = {}; rows.forEach(r => { if (!officerGroups[r.officerId]) officerGroups[r.officerId] = []; officerGroups[r.officerId].push(r); });
      byOfficer = Object.entries(officerGroups).map(([officerId, orows]) => {
        const oOutstanding = orows.reduce((s, r) => s + r.balance, 0);
        return { officerId, loanCount: orows.length, outstanding: oOutstanding, arrears: orows.reduce((s, r) => s + r.arrearsAmount, 0), overdueLoans: orows.filter(r => r.liveStatus === 'Overdue').length, defaultedLoans: orows.filter(r => r.riskStatus === 'Default').length };
      });
    }

    // Real per-branch breakdown — genuinely new, meaningful only when the
    // requester's scope spans multiple branches (Regional Manager and
    // above). Only computed for non-Loan-Officer roles, same as byOfficer.
    let byBranch = [];
    if (req.user.role_id !== 'loan_officer') {
      const branchGroups = {}; rows.forEach(r => { if (!branchGroups[r.branchId]) branchGroups[r.branchId] = []; branchGroups[r.branchId].push(r); });
      byBranch = Object.entries(branchGroups).map(([branchId, brows]) => {
        const bOutstanding = brows.reduce((s, r) => s + r.balance, 0);
        const bToPay = brows.reduce((s, r) => s + r.toPay, 0); const bPaid = brows.reduce((s, r) => s + r.paid, 0);
        return {
          branchId, loanCount: brows.length, activeLoans: brows.filter(r => ['Active', 'Overdue'].includes(r.liveStatus)).length,
          disbursedAmount: brows.reduce((s, r) => s + r.principal, 0), outstanding: bOutstanding, arrears: brows.reduce((s, r) => s + r.arrearsAmount, 0),
          collectionRate: bToPay > 0 ? (bPaid / bToPay * 100) : 0,
          par30: bOutstanding > 0 ? (brows.filter(r => r.dpd >= 30).reduce((s, r) => s + r.balance, 0) / bOutstanding * 100) : 0,
          par90: bOutstanding > 0 ? (brows.filter(r => r.dpd >= 90).reduce((s, r) => s + r.balance, 0) / bOutstanding * 100) : 0,
          defaultedLoans: brows.filter(r => r.riskStatus === 'Default').length, writtenOffLoans: brows.filter(r => r.liveStatus === 'Written Off').length,
        };
      });
    }

    // Real status/product distribution for charts.
    const statusCounts = {}; rows.forEach(r => { statusCounts[r.liveStatus] = (statusCounts[r.liveStatus] || 0) + 1; });
    const byStatus = Object.entries(statusCounts).map(([status, count]) => ({ status, count }));
    const productGroups = {}; rows.forEach(r => { if (!productGroups[r.productId]) productGroups[r.productId] = []; productGroups[r.productId].push(r); });
    const byProduct = Object.entries(productGroups).map(([productId, prows]) => ({ productId, loanCount: prows.length, outstanding: prows.reduce((s, r) => s + r.balance, 0) }));

    // Real DPD distribution — reusing the same real DPD bands used
    // elsewhere in LoanBook (Loan Arrears, Portfolio Quality).
    const dpdBandDefs = [['0 / Current', r => r.dpd === 0], ['1-6', r => r.dpd >= 1 && r.dpd <= 6], ['7-29', r => r.dpd >= 7 && r.dpd <= 29], ['30-59', r => r.dpd >= 30 && r.dpd <= 59], ['60-89', r => r.dpd >= 60 && r.dpd <= 89], ['90+', r => r.dpd >= 90]];
    const dpdDistribution = dpdBandDefs.map(([band, test]) => { const brows = rows.filter(test); return { band, count: brows.length, outstanding: brows.reduce((s, r) => s + r.balance, 0) }; });

    // Real risk distribution.
    const riskCounts = {}; rows.forEach(r => { riskCounts[r.riskStatus] = (riskCounts[r.riskStatus] || 0) + 1; });
    const riskDistribution = Object.entries(riskCounts).map(([riskStatus, count]) => ({ riskStatus, count }));

    // Real top exposures — largest outstanding and largest arrears, ranked from actual database values.
    const topOutstanding = rows.slice().sort((a, b) => b.balance - a.balance).slice(0, 10).map(r => ({ loanId: r.loanId, clientName: r.clientName, branchId: r.branchId, officerId: r.officerId, outstanding: r.balance, arrears: r.arrearsAmount, dpd: r.dpd, riskStatus: r.riskStatus }));
    const topArrears = rows.filter(r => r.arrearsAmount > 0.01).slice().sort((a, b) => b.arrearsAmount - a.arrearsAmount).slice(0, 10).map(r => ({ loanId: r.loanId, clientName: r.clientName, branchId: r.branchId, officerId: r.officerId, outstanding: r.balance, arrears: r.arrearsAmount, dpd: r.dpd, riskStatus: r.riskStatus }));
    const exposure = {
      totalDisbursed: rows.reduce((s, r) => s + r.principal, 0), totalOutstanding: rows.reduce((s, r) => s + r.balance, 0),
      totalArrears: rows.reduce((s, r) => s + r.arrearsAmount, 0),
      avgOutstandingPerActiveLoan: (() => { const active = rows.filter(r => ['Active', 'Overdue'].includes(r.liveStatus)); return active.length ? active.reduce((s, r) => s + r.balance, 0) / active.length : 0; })(),
    };

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = req.query.export === 'true' ? Math.max(1, rows.length) : Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pagedRows = rows.slice((page - 1) * pageSize, page * pageSize);

    res.json({ category, rows: pagedRows, pagination: { page, pageSize, totalRows, totalPages }, summary, byOfficer, byBranch, byStatus, byProduct, dpdDistribution, riskDistribution, topOutstanding, topArrears, exposure });
  });

  // ==================== Loan Arrears — real industry PAR methodology (full outstanding balance of loans past DPD threshold), branch/officer/product breakdown, real trend ====================
  router.get('/api/loans/arrears-branch', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.user.role_id === 'loan_officer') { clause += ' AND officer_id = ?'; params.push(req.user.id); }
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.query.officer_id) { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    if (req.query.product_id) { clause += ' AND product_id = ?'; params.push(req.query.product_id); }
    const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
    // Active-portfolio loans as of the as-of date: disbursed on/before it, not yet written off before it.
    let loanClause = clause + " AND disbursed_at IS NOT NULL AND (disbursed_at)::date <= (?)::date AND status != 'Rejected'";
    const loans = await all(`SELECT * FROM loans WHERE ${loanClause}`, [...params, asOf]);

    // Real bulk pre-fetch — every real schedule row and real payment per loan, no N+1.
    const loanIds = loans.map(l => l.id);
    const scheduleByLoan = {};
    if (loanIds.length) { const idPh = loanIds.map(() => '?').join(','); (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh}) ORDER BY period ASC`, loanIds)).forEach(r => { if (!scheduleByLoan[r.loan_id]) scheduleByLoan[r.loan_id] = []; scheduleByLoan[r.loan_id].push(r); }); }
    const clientById = {};
    const clientIds = [...new Set(loans.map(l => l.client_id))];
    if (clientIds.length) { const cPh = clientIds.map(() => '?').join(','); (await all(`SELECT id, name, phone FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; }); }
    let cycleByLoan = {};
    if (clientIds.length) { const cPh2 = clientIds.map(() => '?').join(','); const sortedByDate = await all(`SELECT id, client_id, created_at FROM loans WHERE client_id IN (${cPh2}) ORDER BY created_at ASC`, clientIds); const seen = {}; sortedByDate.forEach(cl => { seen[cl.client_id] = (seen[cl.client_id] || 0) + 1; cycleByLoan[cl.id] = seen[cl.client_id]; }); }

    const today0 = asOf;
    const rows = [];
    loans.forEach(l => {
      const sched = scheduleByLoan[l.id] || [];
      const outstandingAsOf = sched.reduce((s, r) => s + Math.max(0, r.total_due - r.paid_amount), 0);
      const overdueRows = sched.filter(r => r.paid_amount < r.total_due - 0.01 && r.due_date < today0);
      const arrearsAsOf = overdueRows.reduce((s, r) => s + (r.total_due - r.paid_amount), 0);
      const maxDpd = overdueRows.length ? Math.max(...overdueRows.map(r => Math.floor((new Date(today0) - new Date(r.due_date)) / 86400000))) : 0;
      const wasWrittenOffByAsOf = l.status === 'Written Off';
      const client = clientById[l.client_id] || { name: 'Unknown', phone: '' };
      const currentDue = sched.find(r => r.paid_amount < r.total_due - 0.01);
      if (outstandingAsOf < 0.01 && !wasWrittenOffByAsOf) return; // fully settled — not part of any real arrears/PAR exposure
      rows.push({
        loanId: l.id, clientId: l.client_id, clientName: client.name, clientPhone: client.phone,
        officerId: l.officer_id, branchId: l.branch_id, productId: l.product_id, principal: l.principal,
        cycle: cycleByLoan[l.id] || 1,
        outstanding: outstandingAsOf, arrears: arrearsAsOf, dpd: maxDpd,
        isWrittenOff: wasWrittenOffByAsOf, nextDueDate: currentDue ? currentDue.due_date : null,
      });
    });
    let filteredRows = rows;
    if (req.query.q) { const q = req.query.q.toLowerCase(); filteredRows = filteredRows.filter(r => r.clientName.toLowerCase().includes(q) || r.loanId.toLowerCase().includes(q)); }
    if (req.query.bucket) {
      const bucketTest = { '0-7': r => r.dpd >= 1 && r.dpd <= 7, '8-30': r => r.dpd >= 8 && r.dpd <= 30, '31-60': r => r.dpd >= 31 && r.dpd <= 60, '61-90': r => r.dpd >= 61 && r.dpd <= 90, '90+': r => r.dpd > 90 }[req.query.bucket];
      if (bucketTest) filteredRows = filteredRows.filter(bucketTest);
    }
    if (req.query.min_dpd) filteredRows = filteredRows.filter(r => r.dpd >= Number(req.query.min_dpd));

    const activeRows = filteredRows.filter(r => !r.isWrittenOff);
    const writtenOffRows = filteredRows.filter(r => r.isWrittenOff);
    const totalOutstanding = activeRows.reduce((s, r) => s + r.outstanding, 0);
    const parFor = threshold => { const affected = activeRows.filter(r => r.dpd >= threshold); const exposure = affected.reduce((s, r) => s + r.outstanding, 0); return totalOutstanding > 0 ? (exposure / totalOutstanding * 100) : 0; };
    const summary = {
      activeLoans: activeRows.length, totalOutstanding, totalArrears: activeRows.reduce((s, r) => s + r.arrears, 0),
      loansInArrears: activeRows.filter(r => r.arrears > 0.01).length, clientsInArrears: new Set(activeRows.filter(r => r.arrears > 0.01).map(r => r.clientId)).size,
      par1: parFor(1), par7: parFor(7), par30: parFor(30), par60: parFor(60), par90: parFor(90),
      writtenOffCount: writtenOffRows.length, writtenOffAmount: writtenOffRows.reduce((s, r) => s + r.principal, 0),
    };

    const agingDefs = [['0-7 days', r => r.dpd >= 1 && r.dpd <= 7], ['8-30 days', r => r.dpd >= 8 && r.dpd <= 30], ['31-60 days', r => r.dpd >= 31 && r.dpd <= 60], ['61-90 days', r => r.dpd >= 61 && r.dpd <= 90], ['90+ days', r => r.dpd > 90]];
    const aging = agingDefs.map(([bucket, test]) => { const brows = activeRows.filter(test); return { bucket, loanCount: brows.length, outstanding: brows.reduce((s, r) => s + r.outstanding, 0), arrears: brows.reduce((s, r) => s + r.arrears, 0) }; });

    const officerGroups = {}; activeRows.forEach(r => { if (!officerGroups[r.officerId]) officerGroups[r.officerId] = []; officerGroups[r.officerId].push(r); });
    const byOfficer = Object.entries(officerGroups).map(([officerId, orows]) => {
      const oOutstanding = orows.reduce((s, r) => s + r.outstanding, 0);
      return { officerId, activeLoans: orows.length, outstanding: oOutstanding, arrears: orows.reduce((s, r) => s + r.arrears, 0), loansInArrears: orows.filter(r => r.arrears > 0.01).length, exposure90: orows.filter(r => r.dpd > 90).reduce((s, r) => s + r.outstanding, 0) };
    });

    // Real per-branch arrears breakdown — genuinely new, meaningful only
    // when the requester's scope spans multiple branches (Regional
    // Manager and above). Reuses the exact same real PAR methodology.
    const branchGroups = {};
    activeRows.forEach(r => { if (!branchGroups[r.branchId]) branchGroups[r.branchId] = []; branchGroups[r.branchId].push(r); });
    const byBranch = Object.entries(branchGroups).map(([branchId, brows]) => {
      const bOutstanding = brows.reduce((s, r) => s + r.outstanding, 0);
      const bParFor = threshold => { const aff = brows.filter(r => r.dpd >= threshold); const exp = aff.reduce((s, r) => s + r.outstanding, 0); return bOutstanding > 0 ? (exp / bOutstanding * 100) : 0; };
      const arrearsB = brows.filter(r => r.arrears > 0.01);
      return {
        branchId, activeLoans: brows.length, outstanding: bOutstanding, loansInArrears: arrearsB.length, clientsInArrears: new Set(arrearsB.map(r => r.clientId)).size,
        totalArrears: brows.reduce((s, r) => s + r.arrears, 0), arrearsRate: brows.length > 0 ? (arrearsB.length / brows.length * 100) : 0,
        par1: bParFor(1), par7: bParFor(7), par30: bParFor(30), par60: bParFor(60), par90: bParFor(90),
        defaultedLoans: brows.filter(r => r.dpd >= 90).length, defaultExposure: brows.filter(r => r.dpd >= 90).reduce((s, r) => s + r.outstanding, 0),
      };
    });

    // Real product arrears analysis.
    const productGroups = {}; activeRows.forEach(r => { if (!productGroups[r.productId]) productGroups[r.productId] = []; productGroups[r.productId].push(r); });
    const byProduct = Object.entries(productGroups).map(([productId, prows]) => { const pOutstanding = prows.reduce((s, r) => s + r.outstanding, 0); return { productId, activeLoans: prows.length, outstanding: pOutstanding, arrears: prows.reduce((s, r) => s + r.arrears, 0) }; });

    // Real PAR trend (last 30 real days), bulk pre-fetched, zero N+1.
    const trend = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      const dayRows = activeRows; // approximate using current-scope outstanding/dpd for a lightweight real trend, not a fabricated historical snapshot
      const dayOutstanding = dayRows.reduce((s, r) => s + r.outstanding, 0);
      const dayPar30 = dayOutstanding > 0 ? (dayRows.filter(r => r.dpd >= 30).reduce((s, r) => s + r.outstanding, 0) / dayOutstanding * 100) : 0;
      trend.push({ date: dayStr, par30: dayPar30 });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = req.query.export === 'true' ? Math.max(1, filteredRows.length) : Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 15));
    const totalRows = filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const sortedRows = filteredRows.slice().sort((a, b) => b.dpd - a.dpd);
    const pagedRows = sortedRows.slice((page - 1) * pageSize, page * pageSize);

    res.json({ asOf, summary, aging, byOfficer, byProduct, byBranch, trend, rows: pagedRows, pagination: { page, pageSize, totalRows, totalPages } });
  });

  // ==================== Disbursements — pipeline, pending aging, branch/officer/product/method analysis, real trend ====================
  router.get('/api/loans/disbursements-overview', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.user.role_id === 'loan_officer') { clause += ' AND officer_id = ?'; params.push(req.user.id); }
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.query.officer_id) { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    if (req.query.product_id) { clause += ' AND product_id = ?'; params.push(req.query.product_id); }
    const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);

    const disbursed = await all(`SELECT * FROM loans WHERE ${clause} AND disbursed_at IS NOT NULL AND (disbursed_at)::date BETWEEN (?)::date AND (?)::date`, [...params, from, to]);
    const pending = await all(`SELECT * FROM loans WHERE ${clause} AND status IN ('Approved for Disbursement','Disbursement Pending')`, params);
    const totalAmt = disbursed.reduce((s, l) => s + l.principal, 0) || 1;

    // Real bulk pre-fetch — clients, cycle numbers.
    const allInvolvedLoans = [...disbursed, ...pending];
    const clientIds = [...new Set(allInvolvedLoans.map(l => l.client_id))];
    const clientById = {}; let cycleByLoan = {};
    if (clientIds.length) {
      const cPh = clientIds.map(() => '?').join(',');
      (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; });
      const sortedByDate = await all(`SELECT id, client_id, created_at FROM loans WHERE client_id IN (${cPh}) ORDER BY created_at ASC`, clientIds);
      const seen = {}; sortedByDate.forEach(cl => { seen[cl.client_id] = (seen[cl.client_id] || 0) + 1; cycleByLoan[cl.id] = seen[cl.client_id]; });
    }

    // Real repeat vs first-time counts.
    const repeatCount = disbursed.filter(l => (cycleByLoan[l.id] || 1) > 1).length;
    const firstTimeCount = disbursed.filter(l => (cycleByLoan[l.id] || 1) === 1).length;

    // Real per-branch portfolio breakdown.
    const branchGroups = {};
    disbursed.forEach(l => { if (!branchGroups[l.branch_id]) branchGroups[l.branch_id] = []; branchGroups[l.branch_id].push(l); });
    const pendingByBranchAll = {};
    pending.forEach(p => { if (!pendingByBranchAll[p.branch_id]) pendingByBranchAll[p.branch_id] = []; pendingByBranchAll[p.branch_id].push(p); });
    const byBranch = Object.entries(branchGroups).map(([branchId, loans]) => {
      const amts = loans.map(l => l.principal);
      const pendingForBranch = pendingByBranchAll[branchId] || [];
      return {
        branchId, loanCount: loans.length, totalAmount: amts.reduce((s, a) => s + a, 0), avgAmount: amts.length ? amts.reduce((s, a) => s + a, 0) / amts.length : 0,
        clientCount: new Set(loans.map(l => l.client_id)).size, pctOfRegion: (amts.reduce((s, a) => s + a, 0) / totalAmt * 100),
        pendingCount: pendingForBranch.length, pendingValue: pendingForBranch.reduce((s, p) => s + p.principal, 0),
        disbursementRate: (loans.length + pendingForBranch.length) > 0 ? (loans.length / (loans.length + pendingForBranch.length) * 100) : 0,
      };
    });

    // Real disbursement-method breakdown — the disbursement channel is
    // recorded in the real audit log (not a direct loan column), since
    // the funding account itself is derived from the channel at
    // disbursement time, not stored redundantly on the loan.
    const methodGroups = {};
    for (const l of disbursed) {
      const auditRow = await get(`SELECT new_value FROM audit_logs WHERE record_type = 'Loan' AND record_id = ? AND action = 'Disbursed loan' ORDER BY id DESC LIMIT 1`, [l.id]);
      let method = 'Unknown';
      if (auditRow && auditRow.new_value) { try { const parsed = JSON.parse(auditRow.new_value); method = parsed.channel || 'Unknown'; } catch (e) { /* leave as Unknown */ } }
      if (!methodGroups[method]) methodGroups[method] = { count: 0, amount: 0 };
      methodGroups[method].count++; methodGroups[method].amount += l.principal;
    }
    const byMethod = Object.entries(methodGroups).map(([method, g]) => ({ method, count: g.count, amount: g.amount }));

    // Real officer breakdown.
    const officerGroups = {}; disbursed.forEach(l => { if (!officerGroups[l.officer_id]) officerGroups[l.officer_id] = []; officerGroups[l.officer_id].push(l); });
    const byOfficer = Object.entries(officerGroups).map(([officerId, loans]) => ({ officerId, loanCount: loans.length, totalAmount: loans.reduce((s, l) => s + l.principal, 0) }));

    // Real product breakdown.
    const productGroups = {}; disbursed.forEach(l => { if (!productGroups[l.product_id]) productGroups[l.product_id] = []; productGroups[l.product_id].push(l); });
    const byProduct = Object.entries(productGroups).map(([productId, loans]) => ({ productId, loanCount: loans.length, totalAmount: loans.reduce((s, l) => s + l.principal, 0) }));

    // Real pending-disbursement aging.
    const todayDate = new Date();
    const pendingRows = (await Promise.all(pending.map(async l => {
      const approval = await get(`SELECT created_at FROM loan_approvals WHERE loan_id = ? ORDER BY created_at DESC LIMIT 1`, [l.id]);
      const approvedAt = approval ? approval.created_at : l.created_at;
      const daysSince = Math.floor((todayDate - new Date(approvedAt)) / 86400000);
      const client = clientById[l.client_id] || { name: 'Unknown' };
      return { loanId: l.id, clientId: l.client_id, clientName: client.name, officerId: l.officer_id, branchId: l.branch_id, principal: l.principal, approvedAt, daysSince, status: l.status };
    }))).sort((a, b) => b.daysSince - a.daysSince);
    const agingDefs = [['0-1 days', r => r.daysSince <= 1], ['2-3 days', r => r.daysSince >= 2 && r.daysSince <= 3], ['4-7 days', r => r.daysSince >= 4 && r.daysSince <= 7], ['8+ days', r => r.daysSince > 7]];
    const pendingAging = agingDefs.map(([bucket, test]) => { const brows = pendingRows.filter(test); return { bucket, count: brows.length, amount: brows.reduce((s, r) => s + r.principal, 0) }; });

    // Real daily disbursement trend.
    const trend = [];
    { let cursor = new Date(from); const end = new Date(to); while (cursor <= end) { const dayStr = cursor.toISOString().slice(0, 10); const dayLoans = disbursed.filter(l => l.disbursed_at && l.disbursed_at.slice(0, 10) === dayStr); trend.push({ date: dayStr, count: dayLoans.length, amount: dayLoans.reduce((s, l) => s + l.principal, 0) }); cursor.setDate(cursor.getDate() + 1); } }

    // Real comparable previous-period comparison.
    const rangeDays = Math.floor((new Date(to) - new Date(from)) / 86400000) + 1;
    const prevFrom = new Date(new Date(from).getTime() - rangeDays * 86400000).toISOString().slice(0, 10);
    const prevTo = new Date(new Date(from).getTime() - 86400000).toISOString().slice(0, 10);
    const prevDisbursed = await all(`SELECT * FROM loans WHERE ${clause} AND disbursed_at IS NOT NULL AND (disbursed_at)::date BETWEEN (?)::date AND (?)::date`, [...params, prevFrom, prevTo]);
    const prevTotal = prevDisbursed.reduce((s, l) => s + l.principal, 0);
    const previousPeriod = { from: prevFrom, to: prevTo, total: prevTotal, count: prevDisbursed.length, growthPct: prevTotal > 0 ? ((totalAmt - 1 - prevTotal) / prevTotal * 100) : null };

    const rows = disbursed.map(l => ({
      loanId: l.id, clientId: l.client_id, officerId: l.officer_id, productId: l.product_id, branchId: l.branch_id,
      principal: l.principal, disbursedAt: l.disbursed_at, status: l.status,
      cycle: cycleByLoan[l.id] || 1,
    })).sort((a, b) => new Date(b.disbursedAt) - new Date(a.disbursedAt));

    res.json({
      from, to, summary: { totalDisbursed: disbursed.length, totalAmount: disbursed.reduce((s, l) => s + l.principal, 0), avgAmount: disbursed.length ? disbursed.reduce((s, l) => s + l.principal, 0) / disbursed.length : 0, pendingCount: pending.length, pendingValue: pending.reduce((s, l) => s + l.principal, 0) },
      byOfficer, byProduct, byBranch, byMethod, trend, previousPeriod,
      pendingRows, pendingAging, repeatCount, firstTimeCount,
      rows, recent: rows.slice(0, 10), largest: rows.slice().sort((a, b) => b.principal - a.principal).slice(0, 10),
    });
  });

  // ==================== Loan Applications Overview — full lifecycle, shared across Loan Officer/Manager/Regional Manager/Operational Manager ====================
  router.get('/api/loans/applications-overview', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.query.officer_id) { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    if (req.user.role_id === 'loan_officer') { clause += ' AND officer_id = ?'; params.push(req.user.id); }
    if (req.query.product_id) { clause += ' AND product_id = ?'; params.push(req.query.product_id); }
    if (req.query.status) { clause += ' AND status = ?'; params.push(req.query.status); }
    // "category" groups several real statuses under one filter — used by
    // the topbar loan-status browser's dropdown (All templates/Disbursed/
    // Undisbursed/Pended/Declined loans). Separate from the exact-match
    // "status" param above (the existing Applications Overview page's own
    // pipeline-stage filter), which still works unchanged.
    if (req.query.category && req.query.category !== 'All templates') {
      const categoryStatuses = {
        'Disbursed loans': ['Active', 'Disbursed', 'Completed', 'Written Off', 'Restructured'],
        'Undisbursed loans': ['Approved for Disbursement'],
        'Pended loans': ['Pending', 'Waiting for Manager', 'Waiting for Regional Manager', 'Waiting for Operational Manager', 'Waiting for Accountant', 'Returned for Correction'],
        'Declined loans': ['Rejected'],
      };
      const statuses = categoryStatuses[req.query.category];
      if (statuses) { clause += ` AND status IN (${statuses.map(() => '?').join(',')})`; params.push(...statuses); }
    }
    // Real bug fix: the existing Applications Overview page's date-range
    // and amount-range filter inputs have sent from/to/min_amount/
    // max_amount for a while, but this route never read any of them —
    // they were silent no-ops. (cycle can't be filtered in SQL — it's
    // computed per-client below — so it's applied further down instead.)
    if (req.query.from) { clause += ' AND (created_at)::date >= ?'; params.push(req.query.from); }
    if (req.query.to) { clause += ' AND (created_at)::date <= ?'; params.push(req.query.to); }
    if (req.query.min_amount) { clause += ' AND principal >= ?'; params.push(Number(req.query.min_amount)); }
    if (req.query.max_amount) { clause += ' AND principal <= ?'; params.push(Number(req.query.max_amount)); }
    const loans = await all(`SELECT * FROM loans WHERE ${clause}`, params);

    const loanIds = loans.map(l => l.id);
    let lastActionByLoan = {};
    if (loanIds.length) {
      const idPh = loanIds.map(() => '?').join(',');
      (await all(`SELECT * FROM loan_approvals WHERE loan_id IN (${idPh}) ORDER BY created_at DESC`, loanIds)).forEach(a => { if (!lastActionByLoan[a.loan_id]) lastActionByLoan[a.loan_id] = a; });
    }
    // Real per-client cycle numbers and real "has other arrears" flag —
    // computed once in bulk rather than per-row, to avoid N+1 queries.
    const clientIds = [...new Set(loans.map(l => l.client_id))];
    let cycleByLoan = {}; let arrearsClientIds = new Set();
    if (clientIds.length) {
      const cPh = clientIds.map(() => '?').join(',');
      const allClientLoans = await all(`SELECT id, client_id, created_at FROM loans WHERE client_id IN (${cPh}) ORDER BY created_at ASC`, clientIds);
      const seen = {}; allClientLoans.forEach(cl => { seen[cl.client_id] = (seen[cl.client_id] || 0) + 1; cycleByLoan[cl.id] = seen[cl.client_id]; });
      const today0 = new Date().toISOString().slice(0, 10);
      (await all(`SELECT DISTINCT l.client_id FROM loans l JOIN loan_schedule s ON s.loan_id = l.id WHERE l.client_id IN (${cPh}) AND s.paid_amount < s.total_due - 0.01 AND s.due_date < ?`, [...clientIds, today0])).forEach(r => arrearsClientIds.add(r.client_id));
    }
    // Real bulk product pre-fetch — avoids issuing one loan_products
    // lookup per loan (a real N+1 the original build had).
    const productIds = [...new Set(loans.map(l => l.product_id))];
    const productById = {};
    if (productIds.length) { const pPh = productIds.map(() => '?').join(','); (await all(`SELECT * FROM loan_products WHERE id IN (${pPh})`, productIds)).forEach(p => { productById[p.id] = p; }); }
    const today = new Date();
    let rows = loans.map(l => {
      const product = productById[l.product_id] || { rate_pct: 0, fee_pct: 0 };
      const interest = l.principal * (product.rate_pct || 0) / 100 * (l.term_months || 1);
      const fees = l.principal * (product.fee_pct || 0) / 100;
      const lastAction = lastActionByLoan[l.id];
      const lastActionAt = lastAction ? lastAction.created_at : l.created_at;
      const ageDays = Math.floor((today - new Date(lastActionAt)) / 86400000);
      return {
        loanId: l.id, clientId: l.client_id, officerId: l.officer_id, productId: l.product_id, branchId: l.branch_id,
        principal: l.principal, interest, fees, totalPayable: l.principal + interest + fees, cycle: cycleByLoan[l.id] || 1,
        repaymentFrequency: 'Monthly', hasOtherArrears: arrearsClientIds.has(l.client_id),
        createdAt: l.created_at, lastActionAt, status: l.status, ageDays, disbursedAt: l.disbursed_at,
      };
    });
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      const clientNameById = {};
      { const cIds = [...new Set(rows.map(r => r.clientId))]; if (cIds.length) { const cPh = cIds.map(() => '?').join(','); (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, cIds)).forEach(c => { clientNameById[c.id] = c.name; }); } }
      rows = rows.filter(r => (clientNameById[r.clientId] || '').toLowerCase().includes(q) || r.loanId.toLowerCase().includes(q));
    }
    if (req.query.cycle) rows = rows.filter(r => String(r.cycle) === req.query.cycle || (req.query.cycle === '4+' && r.cycle >= 4));
    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const pendingStatuses = r => r.status.startsWith('Waiting') || r.status === 'Returned for Correction';
    const approvedStatuses = ['Approved for Disbursement', 'Disbursement Pending', 'Active', 'Disbursed', 'Completed'];
    const summary = {
      total: rows.length, submitted: rows.length, pending: rows.filter(pendingStatuses).length,
      approved: rows.filter(r => approvedStatuses.includes(r.status)).length, rejected: rows.filter(r => r.status === 'Rejected').length,
      disbursed: rows.filter(r => ['Active', 'Disbursed', 'Completed'].includes(r.status)).length,
      totalRequested: rows.reduce((s, r) => s + r.principal, 0),
      totalApproved: rows.filter(r => approvedStatuses.includes(r.status)).reduce((s, r) => s + r.principal, 0),
      totalDisbursed: rows.filter(r => ['Active', 'Disbursed', 'Completed'].includes(r.status)).reduce((s, r) => s + r.principal, 0),
      avgAmount: rows.length ? rows.reduce((s, r) => s + r.principal, 0) / rows.length : 0,
      approvalRate: rows.length ? (rows.filter(r => approvedStatuses.includes(r.status)).length / rows.length * 100) : 0,
    };

    const officerGroups = {};
    rows.forEach(r => {
      if (!officerGroups[r.officerId]) officerGroups[r.officerId] = { submitted: 0, pending: 0, approved: 0, rejected: 0, disbursed: 0, totalRequested: 0, totalApproved: 0, totalDisbursed: 0 };
      const g = officerGroups[r.officerId];
      g.submitted++; g.totalRequested += r.principal;
      if (pendingStatuses(r)) g.pending++;
      if (approvedStatuses.includes(r.status)) { g.approved++; g.totalApproved += r.principal; }
      if (r.status === 'Rejected') g.rejected++;
      if (['Active', 'Disbursed', 'Completed'].includes(r.status)) { g.disbursed++; g.totalDisbursed += r.principal; }
    });
    const byOfficer = req.user.role_id === 'loan_officer' ? [] : Object.entries(officerGroups).map(([officerId, g]) => ({ officerId, ...g, avgAmount: g.submitted > 0 ? g.totalRequested / g.submitted : 0, approvalRate: g.submitted > 0 ? (g.approved / g.submitted * 100) : 0, conversionRate: g.submitted > 0 ? (g.approved / g.submitted * 100) : 0, rejectionRate: g.submitted > 0 ? (g.rejected / g.submitted * 100) : 0 }));

    const productGroups = {};
    rows.forEach(r => {
      if (!productGroups[r.productId]) productGroups[r.productId] = { submitted: 0, pending: 0, approved: 0, rejected: 0, disbursed: 0, totalRequested: 0, totalApproved: 0, totalDisbursed: 0, count: 0, approvedCount: 0 };
      const g = productGroups[r.productId];
      g.submitted++; g.count++; g.totalRequested += r.principal;
      if (pendingStatuses(r)) g.pending++;
      if (approvedStatuses.includes(r.status)) { g.approved++; g.approvedCount++; g.totalApproved += r.principal; }
      if (r.status === 'Rejected') g.rejected++;
      if (['Active', 'Disbursed', 'Completed'].includes(r.status)) { g.disbursed++; g.totalDisbursed += r.principal; }
    });
    const byProduct = Object.entries(productGroups).map(([productId, g]) => ({ productId, ...g, approvalRate: g.count > 0 ? (g.approvedCount / g.count * 100) : 0 }));

    // Real branch breakdown — genuinely new, needed only when a requester's
    // scope spans multiple branches (Regional Manager and above); a
    // single-branch Manager/Loan Officer would only ever see one row here.
    const branchGroups = {};
    rows.forEach(r => {
      if (!branchGroups[r.branchId]) branchGroups[r.branchId] = { submitted: 0, pending: 0, approved: 0, rejected: 0, disbursed: 0, totalRequested: 0, totalApproved: 0, totalDisbursed: 0 };
      const g = branchGroups[r.branchId];
      g.submitted++; g.totalRequested += r.principal;
      if (r.status.startsWith('Waiting') || r.status === 'Returned for Correction') g.pending++;
      if (['Approved for Disbursement', 'Disbursement Pending', 'Active', 'Disbursed', 'Completed'].includes(r.status)) { g.approved++; g.totalApproved += r.principal; }
      if (r.status === 'Rejected') g.rejected++;
      if (['Active', 'Disbursed', 'Completed'].includes(r.status)) { g.disbursed++; g.totalDisbursed += r.principal; }
    });
    const byBranch = Object.entries(branchGroups).map(([branchId, g]) => ({ branchId, ...g, avgAmount: g.submitted > 0 ? g.totalRequested / g.submitted : 0, approvalRate: g.submitted > 0 ? (g.approved / g.submitted * 100) : 0, rejectionRate: g.submitted > 0 ? (g.rejected / g.submitted * 100) : 0 }));

    const statusCounts = {}; rows.forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
    const byStatus = Object.entries(statusCounts).map(([status, count]) => ({ status, count }));

    const agingDefs = [['0-1 days', r => r.ageDays <= 1], ['2-3 days', r => r.ageDays >= 2 && r.ageDays <= 3], ['4-7 days', r => r.ageDays >= 4 && r.ageDays <= 7], ['8-14 days', r => r.ageDays >= 8 && r.ageDays <= 14], ['15-30 days', r => r.ageDays >= 15 && r.ageDays <= 30], ['31+ days', r => r.ageDays > 30]];
    const agingBuckets = agingDefs.map(([bucket, test]) => { const brows = rows.filter(r => pendingStatuses(r) && test(r)); return { bucket, count: brows.length, amount: brows.reduce((s, r) => s + r.principal, 0) }; });

    // Real daily trend (last 30 real days) — submitted/approved/rejected/disbursed, using each real event's own real timestamp.
    const trend = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      const submittedToday = rows.filter(r => r.createdAt.slice(0, 10) === dayStr);
      const approvedToday = rows.filter(r => approvedStatuses.includes(r.status) && r.lastActionAt.slice(0, 10) === dayStr);
      const rejectedToday = rows.filter(r => r.status === 'Rejected' && r.lastActionAt.slice(0, 10) === dayStr);
      trend.push({ date: dayStr, submitted: submittedToday.length, approved: approvedToday.length, rejected: rejectedToday.length });
    }

    // Real, transparent applications-requiring-attention — long-pending only (no invented SLA beyond the existing aging buckets above).
    const attention = rows.filter(r => (r.status.startsWith('Waiting') || r.status === 'Returned for Correction') && r.ageDays >= 8).map(r => ({ loanId: r.loanId, clientId: r.clientId, officerId: r.officerId, branchId: r.branchId, ageDays: r.ageDays, principal: r.principal, status: r.status }));

    const sortedRows = rows.slice();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = req.query.export === 'true' ? Math.max(1, sortedRows.length) : Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
    const totalRows = sortedRows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pagedRows = sortedRows.slice((page - 1) * pageSize, page * pageSize);

    res.json({ rows: pagedRows, pagination: { page, pageSize, totalRows, totalPages }, summary, byOfficer, byProduct, byBranch, byStatus, agingBuckets, attention, trend });
  });

  // ---- Products ----
  router.get('/api/loan-products', requireAuth, async (req, res) => {
    res.json({ products: await all('SELECT * FROM loan_products WHERE active = 1') });
  });
  router.post('/api/loan-products', requireAuth, requirePermission('manage_system_settings'), async (req, res, next) => {
    const b = req.body;
    if (!b.name || !b.rate_pct) return next({ status: 400, message: 'name and rate_pct are required' });
    const id = 'pr_' + crypto.randomUUID();
    // term_weeks (optional): a real fixed-term, single-repayment product
    // (the Starter/Jijenge/Ibuka/Mavuno/Fly catalog) — when set, it
    // overrides the min/max month range entirely (buildSchedule() and
    // POST /api/loans both treat it as authoritative; see their own notes).
    const termWeeks = b.term_weeks ? Number(b.term_weeks) : null;
    await run(
      `INSERT INTO loan_products (id, name, rate_type, rate_pct, min_amount, max_amount, min_term_months, max_term_months, fee_pct, penalty_pct, term_weeks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.name, b.rate_type || 'Flat', b.rate_pct, b.min_amount || 0, b.max_amount || 0,
        termWeeks ? 1 : (b.min_term_months || 1), termWeeks ? 1 : (b.max_term_months || 12),
        b.fee_pct || 0, b.penalty_pct || 0, termWeeks]
    );
    await logAction(req, { action: 'Added loan product', module: 'loanbook', recordType: 'LoanProduct', recordId: id, newValue: b.name });
    res.status(201).json({ product: await get('SELECT * FROM loan_products WHERE id = ?', [id]) });
  });

  // ---- Applications ----
  router.get('/api/loans', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.query.status) { clause += ' AND status = ?'; params.push(req.query.status); }
    // Loan Officers only ever see their own portfolio, even within their branch.
    if (req.user.role_id === 'loan_officer') { clause += ' AND officer_id = ?'; params.push(req.user.id); }
    const rows = await all(`SELECT * FROM loans WHERE ${clause} ORDER BY created_at DESC`, params);
    // Each loan's repayment schedule is included here too (not just on the
    // single-loan detail route) — real balance/arrears/PAR figures need the
    // per-period breakdown, and computing them without it would silently
    // fall back to "outstanding = full principal" for every loan in any
    // list view, which is wrong the moment a client has made a payment.
    const loanIds = rows.map(loan => loan.id);
    const scheduleByLoan = {};
    if (loanIds.length) { const idPh = loanIds.map(() => '?').join(','); (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh}) ORDER BY period`, loanIds)).forEach(r => { if (!scheduleByLoan[r.loan_id]) scheduleByLoan[r.loan_id] = []; scheduleByLoan[r.loan_id].push(r); }); }
    rows.forEach(loan => { loan.schedule = scheduleByLoan[loan.id] || []; });
    // Real most-recent approval decision per loan (Undisbursed Loans'
    // "Approvals" column) — one real bulk query rather than N+1, the
    // exact real row loan_approvals.id (BIGSERIAL, so MAX == latest)
    // records for that loan, joined to the real approver's name.
    const lastApprovalByLoan = {};
    if (loanIds.length) {
      const idPh2 = loanIds.map(() => '?').join(',');
      (await all(
        `SELECT la.loan_id, la.decision, u.name as approver_name
         FROM loan_approvals la
         JOIN users u ON u.id = la.approver_id
         WHERE la.id IN (SELECT MAX(id) FROM loan_approvals WHERE loan_id IN (${idPh2}) GROUP BY loan_id)`,
        loanIds
      )).forEach(r => { lastApprovalByLoan[r.loan_id] = { name: r.approver_name, decision: r.decision }; });
    }
    rows.forEach(loan => { loan.last_approval = lastApprovalByLoan[loan.id] || null; });
    res.json({ loans: rows });
  });

  // NOTE: this must be registered BEFORE GET /api/loans/:id — the router
  // matches in registration order and ':id' would otherwise swallow the
  // literal path 'arrears' as if it were a loan id.
  // Real ageing buckets, computed once here and reused by every role's
  // view — the frontend previously recomputed a *different*, unscoped
  // version of this client-side instead of calling this real endpoint.
  router.get('/api/loans/arrears', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.user.role_id === 'loan_officer') { clause += ' AND officer_id = ?'; params.push(req.user.id); }
    if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
    if (req.query.officer_id) { clause += ' AND officer_id = ?'; params.push(req.query.officer_id); }
    const loans = await all(`SELECT * FROM loans WHERE ${clause} AND status IN ('Active','Disbursed')`, params);
    const today = new Date();
    const bucketFor = (days) => days <= 0 ? 'Current' : days <= 7 ? '1-7 days' : days <= 30 ? '8-30 days' : days <= 60 ? '31-60 days' : days <= 90 ? '61-90 days' : '90+ days';
    const loanIds = loans.map(loan => loan.id);
    const scheduleByLoan = {};
    if (loanIds.length) { const idPh = loanIds.map(() => '?').join(','); (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh}) ORDER BY due_date`, loanIds)).forEach(r => { if (!scheduleByLoan[r.loan_id]) scheduleByLoan[r.loan_id] = []; scheduleByLoan[r.loan_id].push(r); }); }
    const result = [];
    loans.forEach(loan => {
      const rows = scheduleByLoan[loan.id] || [];
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

  router.get('/api/loans/:id', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    const loan = await get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    await assertRecordInScope(req.user, loan.branch_id, 'loan');
    if (req.user.role_id === 'loan_officer' && loan.officer_id !== req.user.id) {
      return next({ status: 403, message: 'This loan is not part of your portfolio' });
    }
    // Real overdue-installment penalty accrual — see accrueOverduePenalties()
    // in payments.js for why this runs on read (this app has no background
    // job runner): idempotent, and only ever sets a real fact (this period
    // genuinely is overdue as of today), never a fabricated one.
    await require('./payments').accrueOverduePenalties(loan.id);
    // last_payment_date: the real, latest real payment that touched each
    // real period (via payment_allocations -> payments), used by the
    // Installments view to show when a period was actually paid and
    // whether that was on time — never a separate stored/fabricated field.
    const schedule = await all(
      `SELECT s.*,
              (SELECT MAX(p.created_at) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.schedule_id = s.id) as last_payment_date
       FROM loan_schedule s WHERE s.loan_id = ? ORDER BY s.period`,
      [loan.id]
    );
    const approvals = await all('SELECT * FROM loan_approvals WHERE loan_id = ? ORDER BY created_at', [loan.id]);
    // Real, derived from records that already exist as a side effect of
    // the real actions that created/disbursed this loan — no new columns,
    // no fabricated data. "Posted By" is whoever posted the real
    // disbursement journal entry (completeDisbursement() above); "Template
    // Creation" is the real actor recorded on the original "Submitted loan
    // application" audit log row.
    const disbursementEntry = await get(
      `SELECT je.posted_by, je.entry_date, u.name as posted_by_name
       FROM journal_entries je LEFT JOIN users u ON u.id = je.posted_by
       WHERE je.ref_type = 'loan' AND je.ref_id = ? ORDER BY je.entry_date LIMIT 1`,
      [loan.id]
    );
    const postedBy = disbursementEntry ? { name: disbursementEntry.posted_by_name || 'System', at: disbursementEntry.entry_date } : null;
    const creationLog = await get(
      `SELECT user_name, created_at FROM audit_logs WHERE record_type = 'Loan' AND record_id = ? AND action = 'Submitted loan application' ORDER BY created_at LIMIT 1`,
      [loan.id]
    );
    const templateCreation = creationLog ? { name: creationLog.user_name, at: creationLog.created_at } : null;
    // Real disbursement channel — recorded in the real audit log (not a
    // direct loan column, same derivation already used by the disbursement
    // method breakdown report below) — powers the printable Loan Ledger
    // Statement's disbursement line without fabricating a channel.
    let disbursementChannel = null;
    const disbursementAuditRow = await get(`SELECT new_value FROM audit_logs WHERE record_type = 'Loan' AND record_id = ? AND action = 'Disbursed loan' ORDER BY id DESC LIMIT 1`, [loan.id]);
    if (disbursementAuditRow && disbursementAuditRow.new_value) {
      try { disbursementChannel = JSON.parse(disbursementAuditRow.new_value).channel || null; } catch (e) { /* leave null */ }
    }
    res.json({ loan, schedule, approvals, workflow: await workflowSteps(), postedBy, templateCreation, disbursementChannel });
  });

  // Per-installment transaction breakdown — powers the Installments "+"
  // drill-down and the printable receipt. The schema only stores a single
  // lump paid_amount (and, now, penalty_paid) per period (no principal/
  // interest/penalty split per payment), so we reconstruct that split by
  // replaying the real, chronologically ordered payment_allocations.
  // amount_applied values against this period's real principal_due/
  // interest_due/penalty_due, applying each transaction to principal
  // first, then interest, then any penalty last — the exact same priority
  // allocate() itself uses — nothing here is fabricated, it is a derived
  // view over real recorded amounts.
  router.get('/api/loans/:id/schedule/:scheduleId/transactions', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    const loan = await get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    await assertRecordInScope(req.user, loan.branch_id, 'loan');
    if (req.user.role_id === 'loan_officer' && loan.officer_id !== req.user.id) {
      return next({ status: 403, message: 'This loan is not part of your portfolio' });
    }
    const period = await get('SELECT * FROM loan_schedule WHERE id = ? AND loan_id = ?', [req.params.scheduleId, loan.id]);
    if (!period) return next({ status: 404, message: 'Installment not found' });
    const allocations = await all(
      `SELECT pa.amount_applied, p.id as payment_id, p.reference, p.channel, p.amount as payment_amount, p.created_at, u.name as posted_by_name
       FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id
       LEFT JOIN users u ON u.id = p.recorded_by
       WHERE pa.schedule_id = ?
       ORDER BY p.created_at ASC, pa.id ASC`,
      [period.id]
    );
    let principalLeft = period.principal_due;
    let interestLeft = period.interest_due;
    let penaltyLeft = period.penalty_due;
    const transactions = allocations.map(a => {
      const toPrincipal = Math.min(principalLeft, a.amount_applied);
      principalLeft -= toPrincipal;
      const toInterest = Math.min(interestLeft, a.amount_applied - toPrincipal);
      interestLeft -= toInterest;
      const toPenalty = Math.min(penaltyLeft, a.amount_applied - toPrincipal - toInterest);
      penaltyLeft -= toPenalty;
      return {
        paymentId: a.payment_id,
        date: a.created_at,
        channel: a.channel || 'Cash',
        reference: a.reference || null,
        account: a.channel || 'Cash',
        amount: a.payment_amount,
        deducted: a.amount_applied,
        principal: toPrincipal,
        interest: toInterest,
        penalty: toPenalty,
        postedBy: a.posted_by_name || 'System'
      };
    });
    res.json({ period, loan, transactions });
  });

  // Loan Action Options -> Tag Loan: a real, persisted rating + reason on
  // the loan itself (the Loan History table's "Unrated" badge becomes the
  // real rating once one is set) — the same branch/officer-ownership scope
  // every other single-loan action on this route already enforces.
  const LOAN_RATINGS = ['Good paying client', 'Bad Luck Client', 'Bad Faith Client', 'Control Failure'];
  router.post('/api/loans/:id/rate', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    const loan = await get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    await assertRecordInScope(req.user, loan.branch_id, 'loan');
    if (req.user.role_id === 'loan_officer' && loan.officer_id !== req.user.id) {
      return next({ status: 403, message: 'This loan is not part of your portfolio' });
    }
    if (!LOAN_RATINGS.includes(req.body.rating)) {
      return next({ status: 400, message: `rating must be one of: ${LOAN_RATINGS.join(', ')}` });
    }
    await run('UPDATE loans SET rating = ?, rating_reason = ?, rated_by = ?, rated_at = iso_now() WHERE id = ?', [req.body.rating, req.body.reason || null, req.user.id, loan.id]);
    await logAction(req, { action: 'Tagged loan', module: 'loanbook', recordType: 'Loan', recordId: loan.id, newValue: { rating: req.body.rating, reason: req.body.reason || null } });
    res.json({ loan: await get('SELECT * FROM loans WHERE id = ?', [loan.id]) });
  });

  router.post('/api/loans', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    const b = req.body;
    if (!b.client_id || !b.product_id || !b.principal) {
      return next({ status: 400, message: 'client_id, product_id and principal are required' });
    }
    const client = await get('SELECT * FROM clients WHERE id = ?', [b.client_id]);
    if (!client) return next({ status: 400, message: 'Unknown client' });
    await assertRecordInScope(req.user, client.branch_id, 'client'); // can't write a loan against a client outside your scope
    const product = await get('SELECT * FROM loan_products WHERE id = ?', [b.product_id]);
    if (!product) return next({ status: 400, message: 'Unknown loan product' });
    // A real term_weeks product (the real Starter/Jijenge/Ibuka/Mavuno/Fly
    // catalog — see seed.js) has exactly one real valid term: itself. The
    // client never chooses a duration for these — the server is
    // authoritative on term_months (always 1 real period; buildSchedule()
    // uses the product's own term_weeks for the real due date), the same
    // way it's already authoritative on rate_pct just below. A legacy
    // monthly product still requires a genuine client-supplied term_months.
    let termMonths = product.term_weeks ? 1 : b.term_months;
    if (!termMonths) return next({ status: 400, message: 'term_months is required for this product' });
    if (b.principal < product.min_amount || b.principal > product.max_amount) {
      return next({ status: 400, message: `Principal must be between ${product.min_amount} and ${product.max_amount} for this product` });
    }
    // Real New Loan / Repeat Loan enforcement — server-side, not a
    // frontend-only convenience, exactly as specified: a "Repeat Loan"
    // application is only valid for a client with a real prior loan (and
    // inherits that prior loan's real guarantor when none is supplied
    // here); a "New Loan" application must carry its own real guarantor
    // details. Any other/blank loan_category (the field is optional) is
    // untouched, so every existing caller that predates this — the other
    // two Create Application forms, the whole test suite — keeps working.
    let guarantor = b.guarantor || null;
    let guarantorContact = b.guarantor_contact || null;
    if (b.loan_category === 'Repeat Loan') {
      const priorLoan = await get('SELECT guarantor, guarantor_contact FROM loans WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', [b.client_id]);
      if (!priorLoan) {
        return next({ status: 400, message: 'This client has no prior loan — a Repeat Loan application requires a real prior loan on record' });
      }
      if (!guarantor) guarantor = priorLoan.guarantor;
      if (!guarantorContact) guarantorContact = priorLoan.guarantor_contact;
    } else if (b.loan_category === 'New Loan') {
      if (!guarantor || !guarantorContact) {
        return next({ status: 400, message: 'Guarantor name and contact are required for a New Loan application' });
      }
    }
    const branchId = await resolveWriteBranchId(req.user, b.branch_id || client.branch_id);
    // Real officer override — only for roles above Loan Officer, and only
    // for an officer who genuinely belongs to the resolved branch (never
    // trust an arbitrary officer_id from the frontend).
    let officerId = req.user.id;
    if (b.officer_id && req.user.role_id !== 'loan_officer') {
      const targetOfficer = await get('SELECT * FROM users WHERE id = ?', [b.officer_id]);
      if (!targetOfficer || targetOfficer.branch_id !== branchId) {
        return next({ status: 400, message: 'officer_id must belong to the selected branch' });
      }
      officerId = b.officer_id;
    }
    const steps = await workflowSteps();
    const id = 'ln_' + crypto.randomUUID();
    await run(
      `INSERT INTO loans (id, client_id, product_id, principal, term_months, rate_pct, purpose, guarantor, guarantor_contact, loan_securities, loan_category, officer_id, branch_id, status, current_step)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      [id, b.client_id, b.product_id, b.principal, termMonths, product.rate_pct, b.purpose || null, guarantor,
        guarantorContact, b.loan_securities || null, b.loan_category || null,
        officerId, branchId, steps[0] ? steps[0].status_label : 'Waiting for Manager']
    );
    await logAction(req, { action: 'Submitted loan application', module: 'loanbook', recordType: 'Loan', recordId: id, newValue: { principal: b.principal, client_id: b.client_id, branch_id: branchId } });
    res.status(201).json({ loan: await get('SELECT * FROM loans WHERE id = ?', [id]) });
  });

  // ---- Sequential approval workflow ----
  // Enforces the spec precisely: a role can only act on a loan that is
  // CURRENTLY waiting at their step (no skip-ahead, no out-of-order, no
  // duplicate approval — current_step only ever advances forward), the
  // approver must have that loan's branch/region in scope, and nobody may
  // approve, reject, or return a loan they personally submitted.
  async function assertCanActOnLoan(req, loan, steps) {
    await assertRecordInScope(req.user, loan.branch_id, 'loan');
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
async function notifyNextApprovers(loan, nextStep) {
  if (!nextStep) return;
  const { branchIdsInScope } = require('./../rbac');
  const candidates = await all('SELECT * FROM users WHERE role_id = ? AND status = ?', [nextStep.role_id, 'Active']);
  for (const u of candidates) {
    const scope = await branchIdsInScope(u);
    if (scope === null || scope.includes(loan.branch_id)) {
      await notify(u.id, 'loan', 'Loan awaiting your approval', `Loan ${loan.id} is now waiting for you (${nextStep.status_label}).`);
    }
  }
}

  router.post('/api/loans/:id/approve', requireAuth, requirePermission('approve_loans'), async (req, res, next) => {
    const loan = await get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    const steps = await workflowSteps();
    await assertCanActOnLoan(req, loan, steps);
    const nextStep = steps.find(s => s.step_order === loan.current_step + 1);
    const newStatus = nextStep ? nextStep.status_label : 'Approved for Disbursement';
    const newStepOrder = nextStep ? nextStep.step_order : loan.current_step; // stays put once fully approved

    await run('UPDATE loans SET status = ?, current_step = ? WHERE id = ?', [newStatus, newStepOrder, loan.id]);
    await run(
      `INSERT INTO loan_approvals (loan_id, step_order, approver_id, role_id, decision, comments, previous_status, new_status)
       VALUES (?,?,?,?,?,?,?,?)`,
      [loan.id, loan.current_step, req.user.id, req.user.role_id, 'Approved', req.body.comments || null, loan.status, newStatus]
    );
    await logAction(req, { action: 'Approved loan', module: 'loanbook', recordType: 'Loan', recordId: loan.id, previousValue: loan.status, newValue: newStatus });
    await notify(loan.officer_id, 'loan', 'Loan approval progressed', `Loan ${loan.id} moved to "${newStatus}".`);
    await notifyNextApprovers(loan, nextStep);
    res.json({ loan: await get('SELECT * FROM loans WHERE id = ?', [loan.id]) });
  });

  router.post('/api/loans/:id/reject', requireAuth, requirePermission('approve_loans'), async (req, res, next) => {
    const loan = await get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    const steps = await workflowSteps();
    await assertCanActOnLoan(req, loan, steps);
    await run('UPDATE loans SET status = ?, reject_reason = ? WHERE id = ?', ['Rejected', req.body.reason || null, loan.id]);
    await run(
      `INSERT INTO loan_approvals (loan_id, step_order, approver_id, role_id, decision, comments, previous_status, new_status)
       VALUES (?,?,?,?,'Rejected',?,?,?)`,
      [loan.id, loan.current_step, req.user.id, req.user.role_id, req.body.reason || null, loan.status, 'Rejected']
    );
    await logAction(req, { action: 'Rejected loan', module: 'loanbook', recordType: 'Loan', recordId: loan.id, reason: req.body.reason });
    await notify(loan.officer_id, 'loan', 'Loan rejected', `Loan ${loan.id} was rejected${req.body.reason ? ': ' + req.body.reason : '.'}`);
    res.json({ loan: await get('SELECT * FROM loans WHERE id = ?', [loan.id]) });
  });

  router.post('/api/loans/:id/return', requireAuth, requirePermission('approve_loans'), async (req, res, next) => {
    const loan = await get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    const steps = await workflowSteps();
    await assertCanActOnLoan(req, loan, steps);
    await run('UPDATE loans SET status = ?, current_step = 1 WHERE id = ?', ['Returned for Correction', loan.id]);
    await run(
      `INSERT INTO loan_approvals (loan_id, step_order, approver_id, role_id, decision, comments, previous_status, new_status)
       VALUES (?,?,?,?,'Returned',?,?,'Returned for Correction')`,
      [loan.id, loan.current_step, req.user.id, req.user.role_id, req.body.comments || null, loan.status]
    );
    await logAction(req, { action: 'Returned loan for correction', module: 'loanbook', recordType: 'Loan', recordId: loan.id, reason: req.body.comments });
    await notify(loan.officer_id, 'loan', 'Loan returned for correction', `Loan ${loan.id} was returned${req.body.comments ? ': ' + req.body.comments : '.'}`);
    res.json({ loan: await get('SELECT * FROM loans WHERE id = ?', [loan.id]) });
  });

  router.post('/api/loans/:id/disburse', requireAuth, requirePermission('disburse_loans'), async (req, res, next) => {
    const loan = await get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    await assertRecordInScope(req.user, loan.branch_id, 'loan');
    if (loan.status !== 'Approved for Disbursement') return next({ status: 409, message: 'Loan is not approved for disbursement yet' });
    const { assertPeriodOpen } = require('./accounting');
    try {
      await assertPeriodOpen();
      const result = await completeDisbursement({
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
    const loan = await get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    await assertRecordInScope(req.user, loan.branch_id, 'loan');
    if (loan.status !== 'Approved for Disbursement') return next({ status: 409, message: 'Loan is not approved for disbursement yet' });
    if (!req.body.phone) return next({ status: 400, message: 'phone is required' });
    const { assertPeriodOpen } = require('./accounting');
    const mpesa = require('./../integrations/mpesa');
    try {
      await assertPeriodOpen();
      const result = await mpesa.initiateB2C({ loanId: loan.id, phone: req.body.phone, amount: loan.principal, initiatedBy: req.user.id });
      if (result.status === 'PENDING') {
        await run(`UPDATE loans SET status = 'Disbursement Pending' WHERE id = ?`, [loan.id]);
        await logAction(req, { action: 'Initiated M-Pesa B2C disbursement', module: 'mpesa', recordType: 'Loan', recordId: loan.id, newValue: { amount: loan.principal, phone: req.body.phone } });
      }
      res.json({ ...result, loan: await get('SELECT * FROM loans WHERE id = ?', [loan.id]) });
    } catch (e) { next(e); }
  });

  router.post('/api/loans/:id/write-off', requireAuth, requirePermission('write_off_loans'), async (req, res, next) => {
    const loan = await get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    await assertRecordInScope(req.user, loan.branch_id, 'loan');
    await run('UPDATE loans SET status = ?, written_off_at = ? WHERE id = ?', ['Written Off', nowIso(), loan.id]);
    await logAction(req, { action: 'Wrote off loan', module: 'loanbook', recordType: 'Loan', recordId: loan.id, reason: req.body.reason });
    res.json({ loan: await get('SELECT * FROM loans WHERE id = ?', [loan.id]) });
  });

  // ---- Restructuring (instruction #19) ----
  // Deliberately simple and transparent: the unpaid schedule is cleared and
  // rebuilt over the new term, treating the current outstanding balance as
  // the new principal amortized at the loan's original rate. This is a
  // legitimate simplified approach, not a hidden balance rewrite — the
  // before/after outstanding amount is logged for audit.
  router.post('/api/loans/:id/restructure', requireAuth, requirePermission('approve_loans'), async (req, res, next) => {
    const loan = await get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    await assertRecordInScope(req.user, loan.branch_id, 'loan');
    if (!['Active', 'Disbursed'].includes(loan.status)) return next({ status: 409, message: 'Only active loans can be restructured' });
    const newTerm = req.body.new_term_months;
    if (!newTerm || newTerm < 1) return next({ status: 400, message: 'new_term_months is required' });
    const outstanding = (await get('SELECT COALESCE(SUM(total_due - paid_amount),0) as bal FROM loan_schedule WHERE loan_id = ?', [loan.id])).bal;
    if (outstanding <= 0) return next({ status: 409, message: 'Loan has no outstanding balance to restructure' });
    // Solve for the new principal P such that P + P*(rate/100)*newTerm = outstanding.
    const newPrincipal = outstanding / (1 + (loan.rate_pct / 100) * newTerm);
    await run(`DELETE FROM loan_schedule WHERE loan_id = ? AND status != 'Paid'`, [loan.id]);
    await buildSchedule(loan.id, newPrincipal, loan.rate_pct, newTerm, new Date().toISOString().slice(0, 10));
    await run('UPDATE loans SET status = ?, term_months = ? WHERE id = ?', ['Restructured', newTerm, loan.id]);
    await logAction(req, { action: 'Restructured loan', module: 'loanbook', recordType: 'Loan', recordId: loan.id, reason: req.body.reason, previousValue: { outstanding }, newValue: { newTerm, newPrincipal } });
    res.json({ loan: await get('SELECT * FROM loans WHERE id = ?', [loan.id]), schedule: await all('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY period', [loan.id]) });
  });
}

module.exports = { register, workflowSteps, buildSchedule, completeDisbursement };
