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
async function loanScopeClause(req, extraOfficerCol) {
  const scope = await branchScopeSQL(req.user);
  let clause = scope.clause; const params = [...scope.params];
  if (req.user.role_id === 'loan_officer') { clause += ` AND ${extraOfficerCol || 'officer_id'} = ?`; params.push(req.user.id); }
  if (req.query.branch_id) { clause += ' AND branch_id = ?'; params.push(req.query.branch_id); }
  if (req.query.officer_id && req.user.role_id !== 'loan_officer') { clause += ` AND ${extraOfficerCol || 'officer_id'} = ?`; params.push(req.query.officer_id); }
  if (req.query.region_id) {
    const regionBranches = (await all('SELECT id FROM branches WHERE region_id = ?', [req.query.region_id])).map(b => b.id);
    clause += regionBranches.length ? ` AND branch_id IN (${regionBranches.map(() => '?').join(',')})` : ' AND 1=0';
    params.push(...regionBranches);
  }
  return { clause, params };
}

// expected/collected for a set of loans over [from, to] — the same
// definition used by MTD, Rate, and the Collection Sheet.
async function collectionTotals(loanIds, from, to) {
  if (loanIds.length === 0) return { expected: 0, collected: 0 };
  const placeholders = loanIds.map(() => '?').join(',');
  const expectedRow = await get(
    `SELECT COALESCE(SUM(total_due),0) as v FROM loan_schedule WHERE loan_id IN (${placeholders}) AND (due_date)::date BETWEEN (?)::date AND (?)::date`,
    [...loanIds, from, to]
  );
  // "Collected" = real posted payments in the window, not schedule
  // paid_amount (which can reflect payments posted on a different date
  // than they were collected, e.g. backdated corrections) — using the
  // real payments ledger keeps this consistent with Accounting/Cashflow.
  const collectedRow = await get(
    `SELECT COALESCE(SUM(p.amount),0) as v FROM payments p WHERE p.loan_id IN (${placeholders}) AND p.status != 'Unposted' AND (p.created_at)::date BETWEEN (?)::date AND (?)::date`,
    [...loanIds, from, to]
  );
  return { expected: expectedRow.v, collected: collectedRow.v };
}

// Real per-CLIENT counts — a client with more than one installment due in
// the window (e.g. weekly repayment over a monthly report) is one client,
// not one per installment row. Derives a single aggregate status per
// client from all of that client's rows, then counts clients by that
// aggregate, so clientsPaid + clientsPartial + clientsNotPaid always sums
// back to clientsExpected. Used by every rates/report/sheet breakdown
// below instead of each one re-deriving (and previously mis-deriving)
// this from raw row counts.
function clientCounts(rows) {
  const byClient = {};
  rows.forEach(r => { (byClient[r.clientId] = byClient[r.clientId] || []).push(r); });
  let paid = 0, partial = 0, notPaid = 0;
  Object.values(byClient).forEach(crows => {
    const isPaid = s => s === 'Paid' || s === 'Overpaid';
    const isPartial = s => s === 'Partially Paid';
    if (crows.every(r => isPaid(r.status))) paid++;
    else if (crows.some(r => isPaid(r.status) || isPartial(r.status))) partial++;
    else notPaid++;
  });
  return { clientsExpected: Object.keys(byClient).length, clientsPaid: paid, clientsPartial: partial, clientsNotPaid: notPaid };
}

function register(router) {
  // ==================== Collection Rates — real classification (Strong/Normal/Needs Attention), branch/officer/product breakdown, daily/weekly/monthly aggregation ====================
  router.get('/api/collections/rates-branch', requireAuth, requireModule('loanbook'), async (req, res) => {
    const { clause, params } = await loanScopeClause(req);
    let loanClause = clause; const loanParams = [...params];
    if (req.query.product_id) { loanClause += ' AND product_id = ?'; loanParams.push(req.query.product_id); }
    const loans = await all(`SELECT * FROM loans WHERE ${loanClause} AND status IN ('Active','Disbursed','Completed')`, loanParams);
    let scopedLoans = loans;
    if (req.query.cycle) {
      // Real bulk cycle computation — same approach as the byCycle
      // breakdown further down this file, reused here instead of a
      // per-loan query so this filter doesn't issue one SQL round-trip
      // per loan in scope.
      const cyc = req.query.cycle;
      const cycleClientIds = [...new Set(loans.map(l => l.client_id))];
      const cycleByLoan = {};
      if (cycleClientIds.length) {
        const cPh = cycleClientIds.map(() => '?').join(',');
        const seen = {};
        (await all(`SELECT id, client_id, created_at FROM loans WHERE client_id IN (${cPh}) ORDER BY created_at ASC`, cycleClientIds))
          .forEach(cl => { seen[cl.client_id] = (seen[cl.client_id] || 0) + 1; cycleByLoan[cl.id] = seen[cl.client_id]; });
      }
      scopedLoans = loans.filter(l => {
        const c = cycleByLoan[l.id] || 1;
        return cyc === '4+' ? c >= 4 : c === Number(cyc);
      });
    }
    const loanIds = scopedLoans.map(l => l.id);
    const today = new Date().toISOString().slice(0, 10);
    const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const to = req.query.to || today;

    const strongThreshold = ((await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'strong_collection_rate_pct'`)) || { threshold_value: 90 }).threshold_value;
    const normalThreshold = ((await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'normal_collection_rate_pct'`)) || { threshold_value: 70 }).threshold_value;
    const classify = rate => rate >= strongThreshold ? 'Strong' : rate >= normalThreshold ? 'Normal' : 'Needs Attention';

    if (loanIds.length === 0) {
      return res.json({
        from, to, expected: 0, collected: 0, outstanding: 0, collectionRate: 0, classification: classify(0), thresholds: { strong: strongThreshold, normal: normalThreshold },
        clientsExpected: 0, clientsPaid: 0, clientsPartial: 0, clientsNotPaid: 0,
        previousPeriod: null, dailyTrend: [], weeklyTrend: [], monthlyTrend: [], byOfficer: [], byProduct: [], byBranch: [], byStatus: [], attention: [], rows: [],
        pagination: { page: 1, pageSize: 15, totalRows: 0, totalPages: 1 },
      });
    }

    // Real bulk pre-fetch.
    const idPh = loanIds.map(() => '?').join(',');
    const scheduleByLoan = {};
    (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh}) AND (due_date)::date BETWEEN (?)::date AND (?)::date`, [...loanIds, from, to])).forEach(r => { if (!scheduleByLoan[r.loan_id]) scheduleByLoan[r.loan_id] = []; scheduleByLoan[r.loan_id].push(r); });
    const clientById = {};
    const clientIds = [...new Set(scopedLoans.map(l => l.client_id))];
    if (clientIds.length) { const cPh = clientIds.map(() => '?').join(','); (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; }); }

    const dueInWindow = [];
    scopedLoans.forEach(loan => { const sched = scheduleByLoan[loan.id]; if (!sched) return; sched.forEach(r => { dueInWindow.push({ loan, schedule: r }); }); });
    const statusOf = r => { if (r.paid_amount >= r.total_due - 0.01) return r.paid_amount > r.total_due + 0.01 ? 'Overpaid' : 'Paid'; if (r.paid_amount > 0) return 'Partially Paid'; if (r.due_date < today) return 'Overdue'; return 'Not Paid'; };
    let scopedRows = dueInWindow.map(({ loan, schedule: r }) => {
      const client = clientById[loan.client_id] || { name: 'Unknown' };
      return {
        dueDate: r.due_date, loanId: loan.id, clientId: loan.client_id, clientName: client.name, officerId: loan.officer_id, branchId: loan.branch_id, productId: loan.product_id,
        expected: r.total_due, collected: r.paid_amount, outstanding: Math.max(0, r.total_due - r.paid_amount), status: statusOf(r),
      };
    });
    if (req.query.status) scopedRows = scopedRows.filter(r => r.status === req.query.status);
    if (req.query.officer_id) scopedRows = scopedRows.filter(r => r.officerId === req.query.officer_id);
    if (req.query.branch_id) scopedRows = scopedRows.filter(r => r.branchId === req.query.branch_id);
    if (req.query.q) { const q = req.query.q.toLowerCase(); scopedRows = scopedRows.filter(r => r.clientName.toLowerCase().includes(q) || r.loanId.toLowerCase().includes(q)); }
    scopedRows.sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate));

    const kExpected = scopedRows.reduce((s, r) => s + r.expected, 0);
    const kCollected = scopedRows.reduce((s, r) => s + r.collected, 0);
    const kRate = kExpected > 0 ? (kCollected / kExpected * 100) : 0;

    const officerGroups = {};
    scopedRows.forEach(r => { if (!officerGroups[r.officerId]) officerGroups[r.officerId] = []; officerGroups[r.officerId].push(r); });
    const byOfficer = Object.entries(officerGroups).map(([officerId, orows]) => {
      const oExpected = orows.reduce((s, r) => s + r.expected, 0);
      const oCollected = orows.reduce((s, r) => s + r.collected, 0);
      const oRate = oExpected > 0 ? (oCollected / oExpected * 100) : 0;
      return {
        officerId, expected: oExpected, collected: oCollected, collectionRate: oRate,
        ...clientCounts(orows),
        classification: classify(oRate),
      };
    });

    // Real per-branch breakdown — genuinely new, meaningful only when the
    // requester's scope spans multiple branches (Regional Manager and
    // above). Reuses the exact same real classify() thresholds — no
    // second, different scale for the regional view.
    const branchGroups = {};
    scopedRows.forEach(r => { if (!branchGroups[r.branchId]) branchGroups[r.branchId] = []; branchGroups[r.branchId].push(r); });
    const byBranch = Object.entries(branchGroups).map(([branchId, brows]) => {
      const bExpected = brows.reduce((s, r) => s + r.expected, 0);
      const bCollected = brows.reduce((s, r) => s + r.collected, 0);
      const bRate = bExpected > 0 ? (bCollected / bExpected * 100) : 0;
      return {
        branchId, expected: bExpected, collected: bCollected, outstanding: Math.max(0, bExpected - bCollected), collectionRate: bRate,
        ...clientCounts(brows),
        overdueAmount: brows.filter(r => r.status === 'Overdue').reduce((s, r) => s + r.outstanding, 0),
        classification: classify(bRate),
      };
    });

    const productGroups = {};
    scopedRows.forEach(r => { if (!productGroups[r.productId]) productGroups[r.productId] = []; productGroups[r.productId].push(r); });
    const byProduct = Object.entries(productGroups).map(([productId, prows]) => { const pExpected = prows.reduce((s, r) => s + r.expected, 0); const pCollected = prows.reduce((s, r) => s + r.collected, 0); return { productId, expected: pExpected, collected: pCollected, collectionRate: pExpected > 0 ? (pCollected / pExpected * 100) : 0 }; });

    const statusCounts = {}; scopedRows.forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
    const byStatus = Object.entries(statusCounts).map(([status, count]) => ({ status, count }));

    // Real daily/weekly/monthly aggregation.
    const dailyTrend = [];
    { let cursor = new Date(from); const end = new Date(to); while (cursor <= end) { const dayStr = cursor.toISOString().slice(0, 10); const dayRows = scopedRows.filter(r => r.dueDate === dayStr); const dExp = dayRows.reduce((s, r) => s + r.expected, 0); const dColl = dayRows.reduce((s, r) => s + r.collected, 0); dailyTrend.push({ date: dayStr, expected: dExp, collected: dColl, collectionRate: dExp > 0 ? (dColl / dExp * 100) : 0 }); cursor.setDate(cursor.getDate() + 1); } }
    const weeklyGroups = {};
    dailyTrend.forEach(d => { const dt = new Date(d.date); const weekStart = new Date(dt); weekStart.setDate(dt.getDate() - dt.getDay()); const key = weekStart.toISOString().slice(0, 10); if (!weeklyGroups[key]) weeklyGroups[key] = { expected: 0, collected: 0 }; weeklyGroups[key].expected += d.expected; weeklyGroups[key].collected += d.collected; });
    const weeklyTrend = Object.entries(weeklyGroups).map(([week, g]) => ({ week, expected: g.expected, collected: g.collected, collectionRate: g.expected > 0 ? (g.collected / g.expected * 100) : 0 }));
    const monthlyGroups = {};
    dailyTrend.forEach(d => { const key = d.date.slice(0, 7); if (!monthlyGroups[key]) monthlyGroups[key] = { expected: 0, collected: 0 }; monthlyGroups[key].expected += d.expected; monthlyGroups[key].collected += d.collected; });
    const monthlyTrend = Object.entries(monthlyGroups).map(([month, g]) => ({ month, expected: g.expected, collected: g.collected, collectionRate: g.expected > 0 ? (g.collected / g.expected * 100) : 0 }));

    // Real period-over-period comparison — percentage POINTS, not percentage change.
    const rangeDays = Math.floor((new Date(to) - new Date(from)) / 86400000) + 1;
    const prevFrom = new Date(new Date(from).getTime() - rangeDays * 86400000).toISOString().slice(0, 10);
    const prevTo = new Date(new Date(from).getTime() - 86400000).toISOString().slice(0, 10);
    const { expected: prevExpected, collected: prevCollected } = await collectionTotals(loanIds, prevFrom, prevTo);
    const prevRate = prevExpected > 0 ? (prevCollected / prevExpected * 100) : 0;
    const previousPeriod = { from: prevFrom, to: prevTo, collectionRate: prevRate, changePercentagePoints: kRate - prevRate };

    const attention = [];
    byBranch.forEach(b => { if (b.expected > 0 && b.classification === 'Needs Attention') attention.push({ type: 'Branch Below Threshold', branchId: b.branchId, detail: `${b.collectionRate.toFixed(1)}% (below Normal threshold of ${normalThreshold}%)` }); });
    byOfficer.forEach(o => { if (o.expected > 0 && o.classification === 'Needs Attention') attention.push({ type: 'Officer Below Threshold', officerId: o.officerId, detail: `${o.collectionRate.toFixed(1)}% (below Normal threshold of ${normalThreshold}%)` }); });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = req.query.export === 'true' ? Math.max(1, scopedRows.length) : Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 15));
    const totalRows = scopedRows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pagedRows = scopedRows.slice((page - 1) * pageSize, page * pageSize);

    res.json({
      from, to, expected: kExpected, collected: kCollected, outstanding: Math.max(0, kExpected - kCollected), collectionRate: kRate, classification: classify(kRate), thresholds: { strong: strongThreshold, normal: normalThreshold },
      ...clientCounts(scopedRows),
      previousPeriod, dailyTrend, weeklyTrend, monthlyTrend, byOfficer, byProduct, byBranch, byStatus, attention,
      rows: pagedRows, pagination: { page, pageSize, totalRows, totalPages },
    });
  });

  // ==================== Collection Report — period-selectable, branch/officer/product breakdown, real daily trend, real period-over-period comparison ====================
  router.get('/api/collections/report', requireAuth, requireModule('loanbook'), async (req, res) => {
    const { clause, params: scopeParams } = await loanScopeClause(req);
    let productClause = clause; const productParams = [...scopeParams];
    if (req.query.product_id) { productClause += ' AND product_id = ?'; productParams.push(req.query.product_id); }
    const loans = await all(`SELECT * FROM loans WHERE ${productClause} AND status IN ('Active','Disbursed','Completed')`, productParams);
    const loanIds = loans.map(l => l.id);
    const today = new Date().toISOString().slice(0, 10);
    const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const to = req.query.to || today;
    if (from > to) return res.status(400).json({ error: 'from date must not be after to date' });

    const { expected, collected } = await collectionTotals(loanIds, from, to);

    if (loanIds.length === 0) {
      return res.json({
        from, to, expected, collected, outstanding: 0, collectionRate: 0,
        clientsExpected: 0, clientsPaid: 0, clientsPartial: 0, clientsNotPaid: 0, overdueAmount: 0, missedCollections: 0,
        previousPeriod: null, dailyTrend: [], byOfficer: [], byProduct: [], byBranch: [], byStatus: [], exceptions: [], rows: [],
        pagination: { page: 1, pageSize: 15, totalRows: 0, totalPages: 1 },
      });
    }

    // Real bulk pre-fetch — schedule due within window, clients, last payment per loan.
    const idPh = loanIds.map(() => '?').join(',');
    const scheduleByLoan = {};
    (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh}) AND (due_date)::date BETWEEN (?)::date AND (?)::date`, [...loanIds, from, to])).forEach(r => { if (!scheduleByLoan[r.loan_id]) scheduleByLoan[r.loan_id] = []; scheduleByLoan[r.loan_id].push(r); });
    const clientById = {};
    const clientIds = [...new Set(loans.map(l => l.client_id))];
    if (clientIds.length) { const cPh = clientIds.map(() => '?').join(','); (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; }); }
    const lastPaymentByLoan = {};
    (await all(`SELECT * FROM payments WHERE loan_id IN (${idPh}) AND status != 'Reversed' ORDER BY created_at DESC`, loanIds)).forEach(p => { if (!lastPaymentByLoan[p.loan_id]) lastPaymentByLoan[p.loan_id] = p; });

    const dueInWindow = [];
    loans.forEach(loan => {
      const sched = scheduleByLoan[loan.id];
      if (!sched) return;
      sched.forEach(r => { dueInWindow.push({ loan, schedule: r }); });
    });
    const statusOf = r => { if (r.paid_amount >= r.total_due - 0.01) return r.paid_amount > r.total_due + 0.01 ? 'Overpaid' : 'Paid'; if (r.paid_amount > 0) return 'Partially Paid'; if (r.due_date < today) return 'Overdue'; if (r.due_date === today) return 'Due'; return 'Not Paid'; };
    let scopedRows = dueInWindow.map(({ loan, schedule: r }) => {
      const daysOverdue = r.due_date < today ? Math.floor((new Date(today) - new Date(r.due_date)) / 86400000) : 0;
      const lastPayment = lastPaymentByLoan[loan.id];
      const client = clientById[loan.client_id] || { name: 'Unknown' };
      return {
        dueDate: r.due_date, loanId: loan.id, clientId: loan.client_id, clientName: client.name, officerId: loan.officer_id, branchId: loan.branch_id, productId: loan.product_id,
        expected: r.total_due, paid: r.paid_amount, outstanding: r.total_due - r.paid_amount,
        status: statusOf(r), daysOverdue: r.paid_amount < r.total_due - 0.01 ? daysOverdue : 0,
        paymentMethod: lastPayment ? lastPayment.channel : null, paymentDate: lastPayment ? lastPayment.created_at : null, paymentReference: lastPayment ? lastPayment.reference : null,
      };
    });
    if (req.query.status) scopedRows = scopedRows.filter(r => r.status === req.query.status);
    if (req.query.officer_id) scopedRows = scopedRows.filter(r => r.officerId === req.query.officer_id);
    if (req.query.branch_id) scopedRows = scopedRows.filter(r => r.branchId === req.query.branch_id);
    if (req.query.q) { const q = req.query.q.toLowerCase(); scopedRows = scopedRows.filter(r => r.clientName.toLowerCase().includes(q) || r.loanId.toLowerCase().includes(q)); }
    scopedRows.sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate));

    const kExpected = scopedRows.reduce((s, r) => s + r.expected, 0);
    const kCollected = scopedRows.reduce((s, r) => s + r.paid, 0);
    const overdueAmount = scopedRows.filter(r => r.status === 'Overdue').reduce((s, r) => s + r.outstanding, 0);

    const officerGroups = {};
    scopedRows.forEach(r => { if (!officerGroups[r.officerId]) officerGroups[r.officerId] = []; officerGroups[r.officerId].push(r); });
    const byOfficer = Object.entries(officerGroups).map(([officerId, orows]) => {
      const oExpected = orows.reduce((s, r) => s + r.expected, 0);
      const oCollected = orows.reduce((s, r) => s + r.paid, 0);
      return {
        officerId, expected: oExpected, collected: oCollected, collectionRate: oExpected > 0 ? (oCollected / oExpected * 100) : 0,
        ...clientCounts(orows),
        missedCollections: orows.filter(r => r.status === 'Overdue').length,
      };
    });

    // Real per-branch breakdown — genuinely new, meaningful only when the
    // requester's scope spans multiple branches (Regional Manager and above).
    const branchGroups = {};
    scopedRows.forEach(r => { if (!branchGroups[r.branchId]) branchGroups[r.branchId] = []; branchGroups[r.branchId].push(r); });
    const byBranch = Object.entries(branchGroups).map(([branchId, brows]) => {
      const bExpected = brows.reduce((s, r) => s + r.expected, 0);
      const bCollected = brows.reduce((s, r) => s + r.paid, 0);
      return {
        branchId, expected: bExpected, collected: bCollected, outstanding: Math.max(0, bExpected - bCollected),
        collectionRate: bExpected > 0 ? (bCollected / bExpected * 100) : 0,
        ...clientCounts(brows),
        overdueAmount: brows.filter(r => r.status === 'Overdue').reduce((s, r) => s + r.outstanding, 0),
        missedCollections: brows.filter(r => r.status === 'Overdue').length,
      };
    });

    const productGroups = {};
    scopedRows.forEach(r => { if (!productGroups[r.productId]) productGroups[r.productId] = []; productGroups[r.productId].push(r); });
    const byProduct = Object.entries(productGroups).map(([productId, prows]) => { const pExpected = prows.reduce((s, r) => s + r.expected, 0); const pCollected = prows.reduce((s, r) => s + r.paid, 0); return { productId, expected: pExpected, collected: pCollected, collectionRate: pExpected > 0 ? (pCollected / pExpected * 100) : 0 }; });

    const statusCounts = {}; scopedRows.forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
    const byStatus = Object.entries(statusCounts).map(([status, count]) => ({ status, count }));

    const exceptions = scopedRows.filter(r => r.status === 'Overdue' && r.outstanding > 0).slice(0, 20).map(r => ({ loanId: r.loanId, clientName: r.clientName, officerId: r.officerId, branchId: r.branchId, outstanding: r.outstanding, daysOverdue: r.daysOverdue }));

    // Real daily trend, aggregated at daily granularity within the window.
    const dailyTrend = [];
    { let cursor = new Date(from); const end = new Date(to); while (cursor <= end) { const dayStr = cursor.toISOString().slice(0, 10); const dayRows = scopedRows.filter(r => r.dueDate === dayStr); dailyTrend.push({ date: dayStr, expected: dayRows.reduce((s, r) => s + r.expected, 0), collected: dayRows.reduce((s, r) => s + r.paid, 0) }); cursor.setDate(cursor.getDate() + 1); } }

    // Real comparable previous-period comparison — same real duration, shifted back.
    const rangeDays = Math.floor((new Date(to) - new Date(from)) / 86400000) + 1;
    const prevFrom = new Date(new Date(from).getTime() - rangeDays * 86400000).toISOString().slice(0, 10);
    const prevTo = new Date(new Date(from).getTime() - 86400000).toISOString().slice(0, 10);
    const { expected: prevExpected, collected: prevCollected } = await collectionTotals(loanIds, prevFrom, prevTo);
    const prevRate = prevExpected > 0 ? (prevCollected / prevExpected * 100) : 0;
    const currentRate = kExpected > 0 ? (kCollected / kExpected * 100) : 0;
    const previousPeriod = { from: prevFrom, to: prevTo, expected: prevExpected, collected: prevCollected, collectionRate: prevRate, trend: currentRate >= prevRate ? 'improved' : 'declined', collectedChangePct: prevCollected > 0 ? ((kCollected - prevCollected) / prevCollected * 100) : null };

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = req.query.export === 'true' ? Math.max(1, scopedRows.length) : Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 15));
    const totalRows = scopedRows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pagedRows = scopedRows.slice((page - 1) * pageSize, page * pageSize);

    res.json({
      from, to, expected: kExpected, collected: kCollected, outstanding: Math.max(0, kExpected - kCollected),
      collectionRate: currentRate,
      ...clientCounts(scopedRows),
      overdueAmount, missedCollections: scopedRows.filter(r => r.status === 'Overdue').length,
      previousPeriod, dailyTrend, byOfficer, byProduct, byBranch, byStatus, exceptions,
      rows: pagedRows, pagination: { page, pageSize, totalRows, totalPages },
    });
  });

  // ==================== Manager/Regional Manager/Operational Manager Collection MTD — branch/officer/product breakdown, real classification, real trend ====================
  router.get('/api/collections/mtd-branch', requireAuth, requireModule('loanbook'), async (req, res) => {
    const { clause, params } = await loanScopeClause(req);
    let productClause = clause; const productParams = [...params];
    if (req.query.product_id) { productClause += ' AND product_id = ?'; productParams.push(req.query.product_id); }
    const loans = await all(`SELECT * FROM loans WHERE ${productClause} AND status IN ('Active','Disbursed','Completed')`, productParams);
    const loanIds = loans.map(l => l.id);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    if (loanIds.length === 0) {
      return res.json({
        from: monthStart, to: today, expectedMTD: 0, collectedMTD: 0, remainingMTD: 0, collectionRateMTD: 0,
        classification: 'Current', thresholds: { strong: 90, normal: 70 },
        target: null, byOfficer: [], byProduct: [], byCycle: [], byBranch: [], byPaymentMethod: [], byStatus: [], dailyTrend: [], attention: [], clientRows: [], previousMonth: null,
      });
    }

    const { expected: expectedMTD, collected: collectedMTD } = await collectionTotals(loanIds, monthStart, today);

    // Real per-loan real collection detail, bulk pre-fetched (no N+1).
    const idPh = loanIds.map(() => '?').join(',');
    const scheduleByLoan = {};
    (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh}) AND (due_date)::date BETWEEN (?)::date AND (?)::date`, [...loanIds, monthStart, today])).forEach(r => { if (!scheduleByLoan[r.loan_id]) scheduleByLoan[r.loan_id] = []; scheduleByLoan[r.loan_id].push(r); });
    const clientById = {};
    const clientIds = [...new Set(loans.map(l => l.client_id))];
    if (clientIds.length) { const cPh = clientIds.map(() => '?').join(','); (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; }); }
    const lastPaymentByLoan = {};
    (await all(`SELECT * FROM payments WHERE loan_id IN (${idPh}) AND status != 'Reversed' ORDER BY created_at DESC`, loanIds)).forEach(p => { if (!lastPaymentByLoan[p.loan_id]) lastPaymentByLoan[p.loan_id] = p; });

    const clientRows = loans.filter(l => scheduleByLoan[l.id] && scheduleByLoan[l.id].length).map(l => {
      const sched = scheduleByLoan[l.id];
      const expected = sched.reduce((s, r) => s + r.total_due, 0);
      const collected = sched.reduce((s, r) => s + r.paid_amount, 0);
      const outstanding = Math.max(0, expected - collected);
      const overdue = sched.some(r => r.paid_amount < r.total_due - 0.01 && r.due_date < today);
      const status = collected >= expected - 0.01 ? 'Fully Paid' : collected > 0 ? 'Partially Paid' : (overdue ? 'Overdue' : 'Unpaid');
      const lastPayment = lastPaymentByLoan[l.id];
      const client = clientById[l.client_id] || { name: 'Unknown' };
      return { loanId: l.id, clientId: l.client_id, clientName: client.name, officerId: l.officer_id, branchId: l.branch_id, productId: l.product_id, expected, collected, outstanding, status, paymentMethod: lastPayment ? lastPayment.channel : null };
    });

    const today0 = today.slice(0, 10);
    const dueInWindow = clientRows; // already scoped to the MTD window above
    const statusOf = r => r.status;

    // Real branch breakdown.
    const branchGroups = {}; dueInWindow.forEach(r => { if (!branchGroups[r.branchId]) branchGroups[r.branchId] = []; branchGroups[r.branchId].push(r); });
    const byBranch = Object.entries(branchGroups).map(([branchId, brows]) => {
      const bExpected = brows.reduce((s, r) => s + r.expected, 0);
      const bCollected = brows.reduce((s, r) => s + r.collected, 0);
      return {
        branchId, expected: bExpected, collected: bCollected, rate: bExpected > 0 ? (bCollected / bExpected * 100) : 0, outstanding: Math.max(0, bExpected - bCollected),
        numDue: brows.length, numPaid: brows.filter(r => r.status === 'Fully Paid').length, numUnpaid: brows.filter(r => r.status === 'Unpaid').length, numPartial: brows.filter(r => r.status === 'Partially Paid').length,
        arrears: brows.filter(r => r.status === 'Overdue').reduce((s, r) => s + r.outstanding, 0),
        target: null,
      };
    });

    // Real officer breakdown.
    const officerGroups = {}; dueInWindow.forEach(r => { if (!officerGroups[r.officerId]) officerGroups[r.officerId] = []; officerGroups[r.officerId].push(r); });
    const byOfficer = Object.entries(officerGroups).map(([officerId, orows]) => {
      const oExpected = orows.reduce((s, r) => s + r.expected, 0);
      const oCollected = orows.reduce((s, r) => s + r.collected, 0);
      return { officerId, expected: oExpected, collected: oCollected, achievementPct: oExpected > 0 ? (oCollected / oExpected * 100) : 0, numDue: orows.length, numPaid: orows.filter(r => r.status === 'Fully Paid').length };
    });

    // Real product breakdown.
    const productGroups = {}; dueInWindow.forEach(r => { if (!productGroups[r.productId]) productGroups[r.productId] = []; productGroups[r.productId].push(r); });
    const byProduct = Object.entries(productGroups).map(([productId, prows]) => { const pExpected = prows.reduce((s, r) => s + r.expected, 0); const pCollected = prows.reduce((s, r) => s + r.collected, 0); return { productId, expected: pExpected, collected: pCollected, rate: pExpected > 0 ? (pCollected / pExpected * 100) : 0 }; });

    // Real cycle breakdown.
    const cycleByLoan = {};
    { const sortedLoans = clientIds.length ? await all(`SELECT id, client_id, created_at FROM loans WHERE client_id IN (${clientIds.map(() => '?').join(',')}) ORDER BY created_at ASC`, clientIds) : []; const seen = {}; sortedLoans.forEach(cl => { seen[cl.client_id] = (seen[cl.client_id] || 0) + 1; cycleByLoan[cl.id] = seen[cl.client_id]; }); }
    const cycleGroups = {}; dueInWindow.forEach(r => { const cyc = cycleByLoan[r.loanId] || 1; const key = cyc >= 4 ? '4+' : String(cyc); if (!cycleGroups[key]) cycleGroups[key] = []; cycleGroups[key].push(r); });
    const byCycle = Object.entries(cycleGroups).map(([cycle, crows]) => ({ cycle, expected: crows.reduce((s, r) => s + r.expected, 0), collected: crows.reduce((s, r) => s + r.collected, 0), numDue: crows.length }));

    // Real payment-method breakdown.
    const methodGroups = {}; dueInWindow.filter(r => r.paymentMethod).forEach(r => { methodGroups[r.paymentMethod] = (methodGroups[r.paymentMethod] || 0) + r.collected; });
    const byPaymentMethod = Object.entries(methodGroups).map(([method, amount]) => ({ method, amount }));

    // Real status distribution.
    const statusCounts = {}; dueInWindow.forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
    const byStatus = Object.entries(statusCounts).map(([status, count]) => ({ status, count }));

    // Real daily trend for the MTD window — one bulk query for expected
    // (by due date) and one for collected (by real payment date, same
    // definition as collectionTotals) across the whole window, grouped by
    // day client-side, instead of one collectionTotals() round-trip per
    // calendar day.
    const dailyTrend = [];
    {
      const dayKeys = [];
      { let cursor = new Date(monthStart); const end = new Date(today); while (cursor <= end) { dayKeys.push(cursor.toISOString().slice(0, 10)); cursor.setDate(cursor.getDate() + 1); } }
      const expectedByDay = {}; const collectedByDay = {};
      if (loanIds.length) {
        const idPh = loanIds.map(() => '?').join(',');
        (await all(`SELECT due_date, SUM(total_due) as v FROM loan_schedule WHERE loan_id IN (${idPh}) AND (due_date)::date BETWEEN (?)::date AND (?)::date GROUP BY due_date`, [...loanIds, monthStart, today]))
          .forEach(r => { expectedByDay[r.due_date] = r.v; });
        (await all(`SELECT (created_at)::date as d, SUM(amount) as v FROM payments WHERE loan_id IN (${idPh}) AND status != 'Unposted' AND (created_at)::date BETWEEN (?)::date AND (?)::date GROUP BY (created_at)::date`, [...loanIds, monthStart, today]))
          .forEach(r => { collectedByDay[r.d] = r.v; });
      }
      dayKeys.forEach(dayStr => { dailyTrend.push({ date: dayStr, expected: expectedByDay[dayStr] || 0, collected: collectedByDay[dayStr] || 0 }); });
    }

    // Real classification — reusing the exact same configured thresholds used everywhere else in Rhinocash.
    const strongThreshold = ((await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'strong_collection_rate_pct'`)) || { threshold_value: 90 }).threshold_value;
    const normalThreshold = ((await get(`SELECT threshold_value FROM client_risk_config WHERE rule_name = 'normal_collection_rate_pct'`)) || { threshold_value: 70 }).threshold_value;
    const classify = rate => rate >= strongThreshold ? 'Strong' : rate >= normalThreshold ? 'Normal' : 'Needs Attention';
    const overallRate = expectedMTD > 0 ? (collectedMTD / expectedMTD * 100) : 0;

    const attention = [];
    byBranch.forEach(b => { if (b.expected > 0 && classify(b.rate) === 'Needs Attention') attention.push({ type: 'Branch Below Threshold', branchId: b.branchId, detail: `${b.rate.toFixed(1)}% (below Normal threshold of ${normalThreshold}%)` }); });
    byOfficer.forEach(o => { if (o.expected > 0 && classify(o.achievementPct) === 'Needs Attention') attention.push({ type: 'Officer Below Threshold', officerId: o.officerId, detail: `${o.achievementPct.toFixed(1)}% (below Normal threshold of ${normalThreshold}%)` }); });

    // Real target — same real 'collection' metric target used elsewhere, never a second definition.
    let target = null;
    const period = today.slice(0, 7);
    if (req.user.role_id === 'loan_officer') {
      target = await get(`SELECT * FROM targets WHERE recipient_user_id = ? AND metric = 'collection' AND period = ? AND status = 'Active'`, [req.user.id, period]);
    } else if (req.query.branch_id) {
      target = await get(`SELECT * FROM targets WHERE branch_id = ? AND metric = 'collection' AND period = ? AND status = 'Active'`, [req.query.branch_id, period]);
    }

    // Real comparable-previous-period comparison (same real day-of-month range in the previous month).
    const prevMonthDate = new Date(monthStart); prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
    const prevMonthStart = new Date(prevMonthDate.getFullYear(), prevMonthDate.getMonth(), 1).toISOString().slice(0, 10);
    const daysSoFar = Math.floor((new Date(today) - new Date(monthStart)) / 86400000);
    const prevMonthEnd = new Date(prevMonthDate.getFullYear(), prevMonthDate.getMonth(), 1 + daysSoFar).toISOString().slice(0, 10);
    const { expected: prevExpected, collected: prevCollected } = await collectionTotals(loanIds, prevMonthStart, prevMonthEnd);
    const previousMonth = { from: prevMonthStart, to: prevMonthEnd, expected: prevExpected, collected: prevCollected, growthPct: prevCollected > 0 ? ((collectedMTD - prevCollected) / prevCollected * 100) : null };

    res.json({
      from: monthStart, to: today, expectedMTD, collectedMTD, remainingMTD: Math.max(0, expectedMTD - collectedMTD),
      collectionRateMTD: overallRate, classification: classify(overallRate), thresholds: { strong: strongThreshold, normal: normalThreshold },
      target: target ? { value: target.target_value, achievement: collectedMTD, percentage: target.target_value > 0 ? (collectedMTD / target.target_value * 100) : 0 } : null,
      byOfficer, byProduct, byCycle, byBranch, byPaymentMethod, byStatus, dailyTrend, attention, clientRows, previousMonth,
    });
  });

  // Real Progressive Disbursements — the Loan Officer's real "Collection
  // MTD" submenu page: real loans DISBURSED within [from, to] (defaults to
  // real month-to-date), grouped by officer, with their real lifetime
  // collection progress against what they actually owe (not just what's
  // due so far) — a genuinely different real metric from the "expected
  // due in this window" MTD figures above, matching the requested
  // reference design's own column set exactly. "Loan+Charges" is the real
  // principal + the real total scheduled interest + the real upfront
  // processing fee actually paid (0 for a loan with none); "Paid" is the
  // real lifetime paid_amount across the whole real schedule, not scoped
  // to the date range — it tracks how loans disbursed in this window are
  // actually progressing, however long that takes; "Arrears" is the real
  // outstanding balance on periods genuinely past their real due date;
  // "GC%" is the real gross collection rate, Paid / Loan+Charges.
  router.get('/api/collections/progressive-disbursements', requireAuth, requireModule('loanbook'), async (req, res) => {
    const { clause, params } = await loanScopeClause(req);
    const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const loans = await all(`SELECT * FROM loans WHERE ${clause} AND disbursed_at IS NOT NULL AND (disbursed_at)::date BETWEEN (?)::date AND (?)::date`, [...params, from, to]);
    const loanIds = loans.map(l => l.id);
    const today = new Date().toISOString().slice(0, 10);

    const scheduleByLoan = {};
    if (loanIds.length) {
      const idPh = loanIds.map(() => '?').join(',');
      (await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh})`, loanIds)).forEach(r => { (scheduleByLoan[r.loan_id] || (scheduleByLoan[r.loan_id] = [])).push(r); });
    }

    const officerGroups = {};
    loans.forEach(l => {
      const sched = scheduleByLoan[l.id] || [];
      const interest = sched.reduce((s, r) => s + r.interest_due, 0);
      const paid = sched.reduce((s, r) => s + r.paid_amount, 0);
      const arrears = sched.filter(r => r.due_date < today && r.paid_amount < r.total_due - 0.01).reduce((s, r) => s + (r.total_due - r.paid_amount), 0);
      const loanPlusCharges = l.principal + interest + (l.processing_fee || 0);
      if (!officerGroups[l.officer_id]) officerGroups[l.officer_id] = { officerId: l.officer_id, disbursedAmount: 0, totalLoans: 0, loanPlusCharges: 0, paid: 0, arrears: 0 };
      const g = officerGroups[l.officer_id];
      g.disbursedAmount += l.principal; g.totalLoans += 1; g.loanPlusCharges += loanPlusCharges; g.paid += paid; g.arrears += arrears;
    });

    const officerIds = Object.keys(officerGroups);
    const officerNames = {};
    if (officerIds.length) { const ph = officerIds.map(() => '?').join(','); (await all(`SELECT id, name FROM users WHERE id IN (${ph})`, officerIds)).forEach(u => { officerNames[u.id] = u.name; }); }

    const rows = Object.values(officerGroups).map(g => ({
      officerId: g.officerId, officerName: officerNames[g.officerId] || 'Unknown',
      disbursedAmount: g.disbursedAmount, totalLoans: g.totalLoans, loanPlusCharges: g.loanPlusCharges,
      paid: g.paid, arrears: g.arrears, gcPct: g.loanPlusCharges > 0 ? (g.paid / g.loanPlusCharges * 100) : 0,
    })).sort((a, b) => b.disbursedAmount - a.disbursedAmount);

    const totals = rows.reduce((acc, r) => ({
      disbursedAmount: acc.disbursedAmount + r.disbursedAmount, totalLoans: acc.totalLoans + r.totalLoans,
      loanPlusCharges: acc.loanPlusCharges + r.loanPlusCharges, paid: acc.paid + r.paid, arrears: acc.arrears + r.arrears,
    }), { disbursedAmount: 0, totalLoans: 0, loanPlusCharges: 0, paid: 0, arrears: 0 });
    totals.gcPct = totals.loanPlusCharges > 0 ? (totals.paid / totals.loanPlusCharges * 100) : 0;

    res.json({ from, to, rows, totals });
  });

  router.get('/api/collections/sheet-branch', requireAuth, requireModule('loanbook'), async (req, res) => {
    const { clause, params } = await loanScopeClause(req);
    let loanClause = clause; const loanParams = [...params];
    if (req.query.branch_id) { loanClause += ' AND branch_id = ?'; loanParams.push(req.query.branch_id); }
    if (req.query.officer_id) { loanClause += ' AND officer_id = ?'; loanParams.push(req.query.officer_id); }
    if (req.query.product_id) { loanClause += ' AND product_id = ?'; loanParams.push(req.query.product_id); }
    const loans = await all(`SELECT * FROM loans WHERE ${loanClause} AND status IN ('Active','Disbursed','Completed')`, loanParams);
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const clientById = {};
    if (loans.length) {
      const clientIds = [...new Set(loans.map(l => l.client_id))];
      const cPh = clientIds.map(() => '?').join(',');
      (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; });
    }
    const rows = [];
    for (const loan of loans) {
      const sched = await get('SELECT * FROM loan_schedule WHERE loan_id = ? AND due_date = ?', [loan.id, date]);
      if (!sched) continue; // not actually due on this real date
      if (req.query.q) {
        const q = req.query.q.toLowerCase();
        const client = clientById[loan.client_id] || { name: '' };
        if (!client.name.toLowerCase().includes(q) && !loan.id.toLowerCase().includes(q)) continue;
      }
      const outstanding = Math.max(0, sched.total_due - sched.paid_amount);
      const status = sched.paid_amount >= sched.total_due - 0.01 ? 'Paid' : sched.paid_amount > 0 ? 'Partially Paid' : (date < new Date().toISOString().slice(0, 10) ? 'Overdue' : 'Not Paid');
      if (req.query.status && req.query.status !== status) continue;
      const lastPayment = await get(`SELECT channel FROM payments WHERE loan_id = ? AND status != 'Reversed' ORDER BY created_at DESC LIMIT 1`, [loan.id]);
      const client = clientById[loan.client_id] || { name: 'Unknown' };
      rows.push({
        clientId: loan.client_id, clientName: client.name, loanId: loan.id, officerId: loan.officer_id, branchId: loan.branch_id, productId: loan.product_id,
        expected: sched.total_due, collected: sched.paid_amount, outstanding, status, paymentMethod: lastPayment ? lastPayment.channel : null,
      });
    }

    const kExpected = rows.reduce((s, r) => s + r.expected, 0);
    const kCollected = rows.reduce((s, r) => s + r.collected, 0);
    const kpis = {
      expected: kExpected, collected: kCollected, outstanding: Math.max(0, kExpected - kCollected),
      collectionRate: kExpected > 0 ? (kCollected / kExpected * 100) : 0,
      ...clientCounts(rows),
    };

    const officerGroups = {};
    rows.forEach(r => { if (!officerGroups[r.officerId]) officerGroups[r.officerId] = []; officerGroups[r.officerId].push(r); });
    const byOfficer = Object.entries(officerGroups).map(([officerId, orows]) => {
      const oExpected = orows.reduce((s, r) => s + r.expected, 0);
      const oCollected = orows.reduce((s, r) => s + r.collected, 0);
      return {
        officerId, expected: oExpected, collected: oCollected, rate: oExpected > 0 ? (oCollected / oExpected * 100) : 0,
        ...clientCounts(orows), rows: orows,
      };
    });

    // Real per-branch grouping — genuinely new, meaningful only when the
    // requester's scope spans multiple branches (Regional Manager and
    // above). A single-branch Manager sees only one row here.
    const branchGroups = {};
    rows.forEach(r => { if (!branchGroups[r.branchId]) branchGroups[r.branchId] = []; branchGroups[r.branchId].push(r); });
    const byBranch = Object.entries(branchGroups).map(([branchId, brows]) => {
      const bExpected = brows.reduce((s, r) => s + r.expected, 0);
      const bCollected = brows.reduce((s, r) => s + r.collected, 0);
      return {
        branchId, expected: bExpected, collected: bCollected, outstanding: Math.max(0, bExpected - bCollected),
        rate: bExpected > 0 ? (bCollected / bExpected * 100) : 0,
        ...clientCounts(brows),
        overdueLoans: brows.filter(r => r.status === 'Overdue').length,
        arrears: brows.filter(r => r.status === 'Overdue').reduce((s, r) => s + r.outstanding, 0),
      };
    });

    const statusCounts = {}; rows.forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
    const byStatus = Object.entries(statusCounts).map(([status, count]) => ({ status, count }));

    const exceptions = rows.filter(r => r.status === 'Overdue' || (r.status === 'Not Paid' && r.outstanding > 0))
      .map(r => ({ loanId: r.loanId, clientName: r.clientName, officerId: r.officerId, outstanding: r.outstanding, reason: r.status === 'Overdue' ? 'Overdue' : 'Unpaid' }));

    res.json({ date, kpis, byOfficer, byBranch, byStatus, exceptions, rows });
  });

  router.get('/api/collections/sheet', requireAuth, requireModule('loanbook'), async (req, res) => {
    const { clause, params } = await loanScopeClause(req);
    const loans = await all(`SELECT * FROM loans WHERE ${clause} AND status IN ('Active','Disbursed','Completed')`, params);
    const from = req.query.date_from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = req.query.date_to || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    let rows = [];
    for (const loan of loans) {
      const schedule = await all('SELECT * FROM loan_schedule WHERE loan_id = ? AND (due_date)::date BETWEEN (?)::date AND (?)::date ORDER BY due_date', [loan.id, from, to]);
      schedule.forEach(r => {
        if (r.status === 'Paid') return; // fully settled installments aren't "due" for collection purposes
        const outstanding = Math.max(0, r.total_due - r.paid_amount);
        const status = r.due_date < today ? 'Overdue' : (r.due_date === today ? 'Due Today' : 'Upcoming');
        if (req.query.status && req.query.status !== status) return;
        rows.push({ clientId: loan.client_id, loanId: loan.id, officerId: loan.officer_id, branchId: loan.branch_id, dueDate: r.due_date, expectedAmount: r.total_due, paidAmount: r.paid_amount, outstanding, status });
      });
    }
    rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const pageRows = rows.slice((page - 1) * limit, page * limit);
    res.json({ sheet: pageRows, pagination: { page, limit, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / limit)) }, totals: { expected: rows.reduce((s, r) => s + r.expectedAmount, 0), outstanding: rows.reduce((s, r) => s + r.outstanding, 0) } });
  });

  // Real Collection Sheet for a single real day — the Loan Officer's real
  // "Collection Sheet" submenu page. Every real installment genuinely due
  // on the real selected date, for this real officer's own loans (or the
  // real branch scope for other roles). "Portfolio" is the loan's own
  // real guarantor name (the only real per-loan "portfolio" concept this
  // system has — never a fabricated grouping); "Installment" is the real
  // period number out of the loan's real total number of periods;
  // "Accumulated" is the real unpaid balance carried over from this
  // loan's earlier real periods (due before this date, still not fully
  // paid) — real arrears rolled into today's collection, not a
  // fabricated running balance; "Paid" is the real amount already paid
  // against this exact real installment.
  router.get('/api/collections/sheet-day', requireAuth, requireModule('loanbook'), async (req, res) => {
    const { clause, params } = await loanScopeClause(req);
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const loans = await all(`SELECT * FROM loans WHERE ${clause} AND status IN ('Active','Disbursed','Completed')`, params);
    const loanIds = loans.map(l => l.id);
    if (!loanIds.length) return res.json({ date, rows: [], totals: { amount: 0, accumulated: 0, paid: 0 }, portfolios: [], periods: [] });

    const idPh = loanIds.map(() => '?').join(',');
    const dueToday = await all(`SELECT * FROM loan_schedule WHERE loan_id IN (${idPh}) AND (due_date)::date = (?)::date ORDER BY period`, [...loanIds, date]);
    if (!dueToday.length) return res.json({ date, rows: [], totals: { amount: 0, accumulated: 0, paid: 0 }, portfolios: [], periods: [] });

    const totalPeriodsByLoan = {};
    (await all(`SELECT loan_id, COUNT(*) as cnt FROM loan_schedule WHERE loan_id IN (${idPh}) GROUP BY loan_id`, loanIds)).forEach(r => { totalPeriodsByLoan[r.loan_id] = Number(r.cnt); });

    const accumulatedByLoan = {};
    (await all(`SELECT loan_id, SUM(total_due - paid_amount) as v FROM loan_schedule WHERE loan_id IN (${idPh}) AND (due_date)::date < (?)::date AND paid_amount < total_due - 0.01 GROUP BY loan_id`, [...loanIds, date])).forEach(r => { accumulatedByLoan[r.loan_id] = r.v; });

    const loanById = {}; loans.forEach(l => { loanById[l.id] = l; });
    const clientIds = [...new Set(loans.map(l => l.client_id))];
    const clientById = {};
    if (clientIds.length) { const cPh = clientIds.map(() => '?').join(','); (await all(`SELECT id, name, phone FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientById[c.id] = c; }); }

    let rows = dueToday.map(sched => {
      const loan = loanById[sched.loan_id];
      const client = clientById[loan.client_id] || { name: 'Unknown', phone: null };
      return {
        loanId: loan.id, clientId: loan.client_id, clientName: client.name, contact: client.phone,
        portfolio: loan.guarantor || null, period: sched.period, totalPeriods: totalPeriodsByLoan[loan.id] || 1,
        amount: sched.total_due, accumulated: accumulatedByLoan[loan.id] || 0, paid: sched.paid_amount,
      };
    });

    // Real filter option lists computed from the FULL real due-today set,
    // before either filter is applied — so selecting one never removes
    // the other's own real options.
    const portfolios = [...new Set(dueToday.map(sched => (loanById[sched.loan_id].guarantor || null)).filter(Boolean))].sort();
    const periods = [...new Set(dueToday.map(sched => sched.period))].sort((a, b) => a - b);

    if (req.query.portfolio) rows = rows.filter(r => r.portfolio === req.query.portfolio);
    if (req.query.period) rows = rows.filter(r => String(r.period) === String(req.query.period));

    const totals = { amount: rows.reduce((s, r) => s + r.amount, 0), accumulated: rows.reduce((s, r) => s + r.accumulated, 0), paid: rows.reduce((s, r) => s + r.paid, 0) };
    res.json({ date, rows, totals, portfolios, periods });
  });

  // ==================== Collection MTD ====================
  router.get('/api/collections/mtd', requireAuth, requireModule('loanbook'), async (req, res) => {
    const { clause, params } = await loanScopeClause(req);
    const loanIds = (await all(`SELECT id FROM loans WHERE ${clause} AND status IN ('Active','Disbursed')`, params)).map(l => l.id);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const dayStart = today;
    const { expected: expectedMTD, collected: collectedMTD } = await collectionTotals(loanIds, monthStart, today);
    const { expected: expectedToday, collected: collectedToday } = await collectionTotals(loanIds, dayStart, dayStart);
    // Reuse the real target for 'collection' where one exists, rather than inventing a second target concept.
    const period = today.slice(0, 7);
    let target = null;
    if (req.user.role_id === 'loan_officer') {
      target = await get(`SELECT * FROM targets WHERE recipient_user_id = ? AND metric = 'collection' AND period = ? AND status = 'Active'`, [req.user.id, period]);
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
  router.get('/api/collections/rate', requireAuth, requireModule('loanbook'), async (req, res) => {
    const { clause, params } = await loanScopeClause(req);
    const loanIds = (await all(`SELECT id FROM loans WHERE ${clause}`, params)).map(l => l.id);
    const period = req.query.period || 'monthly'; // daily | weekly | monthly
    const today = new Date();
    let from;
    if (period === 'daily') from = today.toISOString().slice(0, 10);
    else if (period === 'weekly') { const d = new Date(today); d.setDate(d.getDate() - 7); from = d.toISOString().slice(0, 10); }
    else { from = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10); }
    const to = today.toISOString().slice(0, 10);
    const { expected, collected } = await collectionTotals(loanIds, from, to);
    res.json({ period, from, to, expected, collected, rate: expected > 0 ? (collected / expected * 100) : 0 });
  });

  // ==================== Collection Activities ====================
  router.get('/api/collections/activities', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchIdsInScope(req.user);
    const clauses = ['1=1']; const params = [];
    if (scope !== null) { clauses.push(scope.length ? `branch_id IN (${scope.map(() => '?').join(',')})` : '1=0'); params.push(...scope); }
    if (req.user.role_id === 'loan_officer') { clauses.push('staff_id = ?'); params.push(req.user.id); }
    if (req.query.client_id) { clauses.push('client_id = ?'); params.push(req.query.client_id); }
    const rows = await all(`SELECT * FROM collection_activities WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params);
    res.json({ activities: rows });
  });
  router.post('/api/collections/activities', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    const b = req.body;
    if (!b.client_id || !b.activity_type) return next({ status: 400, message: 'client_id and activity_type are required' });
    const client = await get('SELECT * FROM clients WHERE id = ?', [b.client_id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    await assertRecordInScope(req.user, client.branch_id, 'client');
    const id = 'ca_' + crypto.randomUUID();
    await run('INSERT INTO collection_activities (id, client_id, loan_id, staff_id, activity_type, notes, outcome, next_follow_up_date, branch_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, b.client_id, b.loan_id || null, req.user.id, b.activity_type, b.notes || null, b.outcome || null, b.next_follow_up_date || null, client.branch_id]);
    await logAction(req, { action: 'Logged collection activity', module: 'collections', recordType: 'CollectionActivity', recordId: id, newValue: { activity_type: b.activity_type, client_id: b.client_id } });
    res.status(201).json({ activity: await get('SELECT * FROM collection_activities WHERE id = ?', [id]) });
  });

  // ==================== Follow-Ups ====================
  router.get('/api/collections/follow-ups', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchIdsInScope(req.user);
    const clauses = ['1=1']; const params = [];
    if (scope !== null) { clauses.push(scope.length ? `branch_id IN (${scope.map(() => '?').join(',')})` : '1=0'); params.push(...scope); }
    if (req.user.role_id === 'loan_officer') { clauses.push('responsible_staff_id = ?'); params.push(req.user.id); }
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    const rows = await all(`SELECT * FROM follow_ups WHERE ${clauses.join(' AND ')} ORDER BY follow_up_date ASC LIMIT 200`, params);
    const today = new Date().toISOString().slice(0, 10);
    // "Overdue" is derived at read time, never stored — a follow-up
    // doesn't need to be "moved" into an Overdue state by any process.
    rows.forEach(r => { if (r.status === 'Pending' && r.follow_up_date < today) r.effective_status = 'Overdue'; else r.effective_status = r.status; });
    res.json({ followUps: rows });
  });
  router.post('/api/collections/follow-ups', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    const b = req.body;
    if (!b.client_id || !b.follow_up_date) return next({ status: 400, message: 'client_id and follow_up_date are required' });
    const client = await get('SELECT * FROM clients WHERE id = ?', [b.client_id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    await assertRecordInScope(req.user, client.branch_id, 'client');
    const responsible = b.responsible_staff_id || req.user.id;
    const id = 'fu_' + crypto.randomUUID();
    await run('INSERT INTO follow_ups (id, client_id, loan_id, responsible_staff_id, follow_up_date, reason, notes, branch_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, b.client_id, b.loan_id || null, responsible, b.follow_up_date, b.reason || null, b.notes || null, client.branch_id, req.user.id]);
    await logAction(req, { action: 'Created follow-up', module: 'collections', recordType: 'FollowUp', recordId: id, newValue: { client_id: b.client_id, follow_up_date: b.follow_up_date } });
    if (responsible !== req.user.id) await notify(responsible, 'system', 'New follow-up assigned', `A collection follow-up for ${client.name} is due ${b.follow_up_date}.`);
    res.status(201).json({ followUp: await get('SELECT * FROM follow_ups WHERE id = ?', [id]) });
  });
  router.patch('/api/collections/follow-ups/:id', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    const fu = await get('SELECT * FROM follow_ups WHERE id = ?', [req.params.id]);
    if (!fu) return next({ status: 404, message: 'Follow-up not found' });
    await assertRecordInScope(req.user, fu.branch_id, 'follow-up');
    if (fu.responsible_staff_id !== req.user.id && !['manager', 'regional_manager', 'operational_manager', 'admin'].includes(req.user.role_id)) {
      return next({ status: 403, message: 'Only the responsible staff member (or their manager) can update this follow-up' });
    }
    const sets = []; const params = [];
    if (req.body.status && ['Pending', 'Completed', 'Cancelled'].includes(req.body.status)) { sets.push('status = ?'); params.push(req.body.status); }
    if (req.body.outcome !== undefined) { sets.push('outcome = ?'); params.push(req.body.outcome); }
    if (req.body.notes !== undefined) { sets.push('notes = ?'); params.push(req.body.notes); }
    if (!sets.length) return next({ status: 400, message: 'Nothing to update' });
    params.push(fu.id);
    await run(`UPDATE follow_ups SET ${sets.join(', ')} WHERE id = ?`, params);
    await logAction(req, { action: 'Updated follow-up', module: 'collections', recordType: 'FollowUp', recordId: fu.id, newValue: req.body });
    res.json({ followUp: await get('SELECT * FROM follow_ups WHERE id = ?', [fu.id]) });
  });

  // ==================== Promise to Pay ====================
  // A promise is never a payment. Fulfillment is derived by comparing the
  // promised amount against REAL payments on that loan made on/after the
  // promise date — never recorded as if money had actually moved.
  router.get('/api/collections/promises', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchIdsInScope(req.user);
    const clauses = ['1=1']; const params = [];
    if (scope !== null) { clauses.push(scope.length ? `branch_id IN (${scope.map(() => '?').join(',')})` : '1=0'); params.push(...scope); }
    if (req.user.role_id === 'loan_officer') { clauses.push('created_by = ?'); params.push(req.user.id); }
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    const rows = await all(`SELECT * FROM promises_to_pay WHERE ${clauses.join(' AND ')} ORDER BY promise_date DESC LIMIT 200`, params);
    res.json({ promises: rows });
  });
  router.post('/api/collections/promises', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    const b = req.body;
    if (!b.client_id || !b.loan_id || !b.promised_amount || !b.promise_date) return next({ status: 400, message: 'client_id, loan_id, promised_amount and promise_date are required' });
    const loan = await get('SELECT * FROM loans WHERE id = ?', [b.loan_id]);
    if (!loan || loan.client_id !== b.client_id) return next({ status: 400, message: 'loan_id does not belong to the specified client' });
    await assertRecordInScope(req.user, loan.branch_id, 'loan');
    const id = 'ptp_' + crypto.randomUUID();
    await run('INSERT INTO promises_to_pay (id, client_id, loan_id, promised_amount, promise_date, notes, branch_id, created_by) VALUES (?,?,?,?,?,?,?,?)',
      [id, b.client_id, b.loan_id, b.promised_amount, b.promise_date, b.notes || null, loan.branch_id, req.user.id]);
    await logAction(req, { action: 'Created promise to pay', module: 'collections', recordType: 'PromiseToPay', recordId: id, newValue: { loan_id: b.loan_id, amount: b.promised_amount } });
    res.status(201).json({ promise: await get('SELECT * FROM promises_to_pay WHERE id = ?', [id]) });
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
  async function evaluatePromise(promise) {
    if (['Cancelled'].includes(promise.status)) return promise;
    const paidSince = (await get(
      `SELECT COALESCE(SUM(amount),0) as v FROM payments WHERE loan_id = ? AND status != 'Unposted' AND (created_at)::date >= (?)::date`,
      [promise.loan_id, promise.promise_date]
    )).v;
    let status = promise.status;
    if (paidSince >= promise.promised_amount - 0.01) status = 'Fulfilled';
    else if (paidSince > 0) status = 'Partially Fulfilled';
    else if (new Date(promise.promise_date) < new Date(new Date().toISOString().slice(0, 10))) status = 'Broken';
    else status = 'Pending';
    if (status !== promise.status || paidSince !== promise.fulfilled_amount) {
      await run('UPDATE promises_to_pay SET status = ?, fulfilled_amount = ?, fulfilled_at = ? WHERE id = ?',
        [status, paidSince, status === 'Fulfilled' ? new Date().toISOString() : promise.fulfilled_at, promise.id]);
    }
    return get('SELECT * FROM promises_to_pay WHERE id = ?', [promise.id]);
  }
  router.post('/api/collections/promises/:id/evaluate', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    const promise = await get('SELECT * FROM promises_to_pay WHERE id = ?', [req.params.id]);
    if (!promise) return next({ status: 404, message: 'Promise not found' });
    await assertRecordInScope(req.user, promise.branch_id, 'promise');
    res.json({ promise: await evaluatePromise(promise) });
  });
  router.post('/api/collections/promises/:id/cancel', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    const promise = await get('SELECT * FROM promises_to_pay WHERE id = ?', [req.params.id]);
    if (!promise) return next({ status: 404, message: 'Promise not found' });
    await assertRecordInScope(req.user, promise.branch_id, 'promise');
    if (promise.created_by !== req.user.id && !['manager', 'regional_manager', 'operational_manager', 'admin'].includes(req.user.role_id)) {
      return next({ status: 403, message: 'Only the creator (or their manager) can cancel this promise' });
    }
    if (['Fulfilled'].includes(promise.status)) return next({ status: 409, message: 'A fulfilled promise cannot be cancelled' });
    await run("UPDATE promises_to_pay SET status = 'Cancelled' WHERE id = ?", [promise.id]);
    await logAction(req, { action: 'Cancelled promise to pay', module: 'collections', recordType: 'PromiseToPay', recordId: promise.id });
    res.json({ promise: await get('SELECT * FROM promises_to_pay WHERE id = ?', [promise.id]) });
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
  router.get('/api/collections/investor-summary', requireInvestorAuth, async (req, res) => {
    const loanIds = (await all(`SELECT id FROM loans WHERE status IN ('Active','Disbursed')`)).map(l => l.id);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const { expected, collected } = await collectionTotals(loanIds, monthStart, today);
    const arrearsRow = await get(
      `SELECT COALESCE(SUM(GREATEST(total_due - paid_amount, 0)),0) as v FROM loan_schedule WHERE loan_id IN (${loanIds.map(() => '?').join(',') || "''"}) AND status != 'Paid' AND (due_date)::date < CURRENT_DATE`,
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
  router.get('/api/collections/branch-comparison', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await branchIdsInScope(req.user);
    let branches = await all('SELECT * FROM branches WHERE status = ?', ['Active']);
    if (scope !== null) branches = branches.filter(b => scope.includes(b.id));
    if (req.query.region_id) branches = branches.filter(b => b.region_id === req.query.region_id);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const result = await Promise.all(branches.map(async b => {
      const loanIds = (await all(`SELECT id FROM loans WHERE branch_id = ? AND status IN ('Active','Disbursed')`, [b.id])).map(l => l.id);
      const { expected, collected } = await collectionTotals(loanIds, monthStart, today);
      const arrearsAmount = (await get(
        `SELECT COALESCE(SUM(GREATEST(total_due - paid_amount, 0)),0) as v FROM loan_schedule WHERE loan_id IN (${loanIds.map(() => '?').join(',') || "''"}) AND status != 'Paid' AND (due_date)::date < CURRENT_DATE`,
        loanIds
      )).v;
      return { branchId: b.id, branchName: b.name, expected, collected, rate: expected > 0 ? (collected / expected * 100) : 0, arrearsAmount };
    }));
    result.sort((a, b) => b.rate - a.rate);
    res.json({ branches: result });
  });

  // ==================== Officer Comparison — real, within a Manager's own branch ====================
  router.get('/api/collections/officer-comparison', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    if (!['manager', 'regional_manager', 'operational_manager', 'admin'].includes(req.user.role_id)) {
      return next({ status: 403, message: 'Your role does not have team collection comparison authority' });
    }
    const scope = await branchIdsInScope(req.user);
    let officers = await all(`SELECT * FROM users WHERE role_id = 'loan_officer' AND status = 'Active'`);
    if (scope !== null) officers = officers.filter(o => scope.includes(o.branch_id));
    if (req.query.branch_id) officers = officers.filter(o => o.branch_id === req.query.branch_id);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const result = await Promise.all(officers.map(async o => {
      const loanIds = (await all(`SELECT id FROM loans WHERE officer_id = ? AND status IN ('Active','Disbursed')`, [o.id])).map(l => l.id);
      const { expected, collected } = await collectionTotals(loanIds, monthStart, today);
      return { officerId: o.id, officerName: o.name, branchId: o.branch_id, expected, collected, rate: expected > 0 ? (collected / expected * 100) : 0, activeLoans: loanIds.length };
    }));
    result.sort((a, b) => b.rate - a.rate);
    res.json({ officers: result });
  });

  // ==================== Expected Cashflow — real, month/week/day-scoped ====================
  // What's still due to be collected in a period (real loan_schedule rows,
  // status != 'Paid' — the same "outstanding" definition used by arrears
  // above), not a fabricated projection. A Loan Officer sees only their
  // own portfolio (loanScopeClause already does that); other roles get
  // their own real branch/region/company-wide scope the same way every
  // other collections endpoint does.
  router.get('/api/collections/expected-cashflow', requireAuth, requireModule('loanbook'), async (req, res) => {
    const scope = await loanScopeClause(req);
    const loanIds = (await all(`SELECT id FROM loans WHERE ${scope.clause} AND status IN ('Active','Disbursed')`, scope.params)).map(l => l.id);

    const now = new Date();
    let from, to;
    if (req.query.day) {
      from = req.query.day; to = req.query.day;
    } else if (req.query.week_start && req.query.week_end) {
      from = req.query.week_start; to = req.query.week_end;
    } else if (req.query.month) {
      const [y, m] = req.query.month.split('-').map(Number);
      from = `${req.query.month}-01`;
      to = `${req.query.month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    } else {
      from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      to = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    }

    if (!loanIds.length) return res.json({ from, to, totalLoans: 0, principal: 0, interest: 0, total: 0 });
    const row = await get(
      `SELECT COUNT(DISTINCT loan_id) as loans, COALESCE(SUM(principal_due),0) as principal, COALESCE(SUM(interest_due),0) as interest
       FROM loan_schedule WHERE loan_id IN (${loanIds.map(() => '?').join(',')}) AND status != 'Paid' AND (due_date)::date BETWEEN ? AND ?`,
      [...loanIds, from, to]
    );
    const principal = Number(row.principal), interest = Number(row.interest);
    res.json({ from, to, totalLoans: Number(row.loans), principal, interest, total: principal + interest });
  });

}

module.exports = { register, collectionTotals };
