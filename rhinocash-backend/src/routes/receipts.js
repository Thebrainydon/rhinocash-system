'use strict';
// Payment receipts, merged M-Pesa payments and overpayment transfers.
//
// A receipt exists for every confirmed collection: a posted (or overpaid)
// loan payment, or a confirmed processing-fee payment. Each carries a
// sequential receipt number (shown offset by the Admin's "Receipt Settings"
// start number) and a printed timestamp, so a branch can print each day's
// new receipts once and reprint any day in full.
//
// Merging combines several unassigned M-Pesa paybill transactions from the
// same client into one payment on a chosen loan (reference MERGED<n>).
// Assigning an overpayment moves the amount a payment left over onto another
// of the same client's loans (reference OVERPAY<n>), through the overpayment
// suspense account.
const crypto = require('node:crypto');
const { all, get, run, transaction } = require('./../db');
const { requireAuth, requireModule } = require('./../middleware');
const { branchIdsInScope, hasPermission } = require('./../rbac');
const { logAction } = require('./../audit');
const { allocate, postPaymentJournal } = require('./payments');

const RECEIPT_DEFAULTS = {
  header: 'RHINOCASH LTD', showHeader: false, watermark: true, perPage: 6, startNumber: 872000,
  numberColor: '#E8692C', accent: '#8DB23A', showOfficer: true, showSignatures: true, footer: 'Payment Receipts',
};

async function receiptSettings() {
  const row = await get(`SELECT value_json FROM admin_settings WHERE key = 'payments.receipts'`);
  let v = {};
  try { v = JSON.parse((row && row.value_json) || '{}') || {}; } catch (e) { v = {}; }
  const out = { ...RECEIPT_DEFAULTS, ...v };
  out.perPage = [4, 6, 8].includes(Number(out.perPage)) ? Number(out.perPage) : 6;
  out.startNumber = Number.isFinite(Number(out.startNumber)) ? Number(out.startNumber) : RECEIPT_DEFAULTS.startNumber;
  return out;
}

// Numbers are handed out in the order collections were confirmed.
async function assignReceiptNumbers() {
  const rows = await all(`SELECT 'p' AS k, id, created_at AS at FROM payments WHERE status IN ('Posted','Overpayment') AND receipt_no IS NULL
    UNION ALL SELECT 'f' AS k, id, confirmed_at AS at FROM loan_fee_payments WHERE status = 'Confirmed' AND receipt_no IS NULL ORDER BY at`);
  for (const r of rows) {
    await run(`UPDATE ${r.k === 'p' ? 'payments' : 'loan_fee_payments'} SET receipt_no = nextval('receipt_no_seq') WHERE id = ? AND receipt_no IS NULL`, [r.id]);
  }
}

async function scope(user) {
  const ids = await branchIdsInScope(user);
  const pay = []; const payParams = []; const fee = []; const feeParams = [];
  if (ids !== null) {
    if (!ids.length) { pay.push('1=0'); fee.push('1=0'); }
    else {
      const ph = ids.map(() => '?').join(',');
      pay.push(`l.branch_id IN (${ph})`); payParams.push(...ids);
      fee.push(`c.branch_id IN (${ph})`); feeParams.push(...ids);
    }
  }
  if (user.role_id === 'loan_officer') {
    pay.push('l.officer_id = ?'); payParams.push(user.id);
    fee.push('f.initiated_by = ?'); feeParams.push(user.id);
  }
  return { pay, payParams, fee, feeParams };
}

async function loadReceipts(user, { from, to, unprinted, ids }) {
  await assignReceiptNumbers();
  const sc = await scope(user);
  const settings = await receiptSettings();
  const pc = ["p.status IN ('Posted','Overpayment')", ...sc.pay]; const pp = [...sc.payParams];
  const fc = ["f.status = 'Confirmed'", ...sc.fee]; const fp = [...sc.feeParams];
  if (from) { pc.push('(p.created_at)::date >= (?)::date'); pp.push(from); fc.push('(f.confirmed_at)::date >= (?)::date'); fp.push(from); }
  if (to) { pc.push('(p.created_at)::date <= (?)::date'); pp.push(to); fc.push('(f.confirmed_at)::date <= (?)::date'); fp.push(to); }
  if (unprinted) { pc.push('p.printed_at IS NULL'); fc.push('f.printed_at IS NULL'); }
  if (ids) {
    const pIds = ids.filter(x => x.kind === 'payment').map(x => String(x.id));
    const fIds = ids.filter(x => x.kind === 'fee').map(x => String(x.id));
    pc.push(pIds.length ? `p.id IN (${pIds.map(() => '?').join(',')})` : '1=0'); pp.push(...pIds);
    fc.push(fIds.length ? `f.id IN (${fIds.map(() => '?').join(',')})` : '1=0'); fp.push(...fIds);
  }
  const payRows = await all(`SELECT p.id, p.receipt_no, p.printed_at, p.reference, p.amount, p.allocated_principal, p.allocated_interest, p.allocated_penalty,
      p.status, p.created_at AS at, c.name AS client_name, c.national_id, o.name AS officer_name, u.name AS recorded_by_name
    FROM payments p JOIN loans l ON l.id = p.loan_id LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN users o ON o.id = l.officer_id LEFT JOIN users u ON u.id = p.recorded_by
    WHERE ${pc.join(' AND ')}`, pp);
  const feeRows = await all(`SELECT f.id, f.receipt_no, f.printed_at, f.mpesa_receipt_number AS reference, f.amount, f.confirmed_at AS at,
      c.name AS client_name, c.national_id, o.name AS officer_name, cb.name AS confirmed_by_name
    FROM loan_fee_payments f JOIN clients c ON c.id = f.client_id
    LEFT JOIN users o ON o.id = c.officer_id LEFT JOIN users cb ON cb.id = f.confirmed_by
    WHERE ${fc.join(' AND ')}`, fp);
  const num = v => Number(v) || 0;
  const receipts = payRows.map(r => {
    const principal = num(r.allocated_principal), interest = num(r.allocated_interest), penalty = num(r.allocated_penalty);
    return {
      kind: 'payment', id: r.id, receiptNo: settings.startNumber + num(r.receipt_no), date: r.at, clientName: r.client_name, clientIdNo: r.national_id,
      officerName: r.officer_name, transaction: r.reference, interest, principal, penalty, fee: 0,
      overpay: Math.max(0, Math.round((num(r.amount) - principal - interest - penalty) * 100) / 100), total: num(r.amount),
      postingStatus: r.status, confirmedBy: r.recorded_by_name || 'System', printed: !!r.printed_at,
    };
  }).concat(feeRows.map(r => ({
    kind: 'fee', id: r.id, receiptNo: settings.startNumber + num(r.receipt_no), date: r.at, clientName: r.client_name, clientIdNo: r.national_id,
    officerName: r.officer_name, transaction: r.reference || '—', interest: 0, principal: 0, penalty: 0, fee: num(r.amount), overpay: 0,
    total: num(r.amount), postingStatus: 'Posted', confirmedBy: r.confirmed_by_name || 'System', printed: !!r.printed_at,
  })));
  receipts.sort((a, b) => (a.receiptNo - b.receiptNo));
  return { receipts, settings };
}

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
function notInvestor(req, res, next) { return req.user.role_id === 'investor' ? next({ status: 403, message: 'Not available for this role' }) : next(); }
async function canAssign(user) {
  if (['manager', 'regional_manager', 'operational_manager'].includes(user.role_id)) return true;
  return hasPermission(user, 'post_accounting_entries');
}
async function loanInScope(user, loan) {
  if (!loan) return false;
  const ids = await branchIdsInScope(user);
  if (ids !== null && !ids.includes(loan.branch_id)) return false;
  if (user.role_id === 'loan_officer' && loan.officer_id !== user.id) return false;
  return true;
}

function register(router) {
  // ---------- receipts ----------
  router.get('/api/receipts/settings', requireAuth, notInvestor, async (req, res) => {
    res.json({ settings: await receiptSettings() });
  });

  router.get('/api/receipts/days', requireAuth, notInvestor, requireModule('payments'), async (req, res, next) => {
    const year = parseInt(req.query.year, 10), month = parseInt(req.query.month, 10);
    if (!(year > 2000 && month >= 1 && month <= 12)) return next({ status: 400, message: 'Choose the year and month' });
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const to = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
    const { receipts } = await loadReceipts(req.user, { from, to });
    const byDay = {};
    receipts.forEach(r => { const d = String(r.date || '').slice(0, 10); if (!d) return; const x = byDay[d] || (byDay[d] = { date: d, receipts: 0, unprinted: 0, amount: 0 }); x.receipts++; x.amount += r.total; if (!r.printed) x.unprinted++; });
    res.json({ days: Object.values(byDay).sort((a, b) => (a.date < b.date ? 1 : -1)) });
  });

  router.get('/api/receipts', requireAuth, notInvestor, requireModule('payments'), async (req, res, next) => {
    const date = req.query.date;
    if (!isDate(date)) return next({ status: 400, message: 'Choose the day' });
    res.json(await loadReceipts(req.user, { from: date, to: date, unprinted: req.query.unprinted === '1' }));
  });

  router.post('/api/receipts/mark-printed', requireAuth, notInvestor, requireModule('payments'), async (req, res, next) => {
    const items = Array.isArray((req.body || {}).receipts) ? req.body.receipts.filter(x => x && ['payment', 'fee'].includes(x.kind) && x.id).slice(0, 2000) : [];
    if (!items.length) return next({ status: 400, message: 'No receipts to mark' });
    const { receipts } = await loadReceipts(req.user, { ids: items }); // only receipts this user may see
    let marked = 0;
    for (const r of receipts) {
      if (r.printed) continue;
      await run(`UPDATE ${r.kind === 'payment' ? 'payments' : 'loan_fee_payments'} SET printed_at = iso_now() WHERE id = ? AND printed_at IS NULL`, [r.id]);
      marked++;
    }
    await logAction(req, { action: 'Printed receipts', module: 'payments', recordType: 'Receipts', recordId: String(marked), newValue: { count: marked } });
    res.json({ marked });
  });

  // ---------- payments report (per loan officer, per month) ----------
  // Principal / interest / penalties come from posted payments on the
  // officer's loans; processing fees from confirmed fee payments of the
  // officer's clients; checkoff is money received through the Checkoff
  // channel. Total income = interest + processing fees + penalties.
  const monthRange = (req, next) => {
    const year = parseInt(req.query.year, 10), month = parseInt(req.query.month, 10);
    if (!(year > 2000 && month >= 1 && month <= 12)) { next({ status: 400, message: 'Choose the year and month' }); return null; }
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const to = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
    return { from, to };
  };
  router.get('/api/payments/staff-report', requireAuth, notInvestor, requireModule('payments'), async (req, res, next) => {
    const r = monthRange(req, next); if (!r) return;
    const sc = await scope(req.user);
    const pay = await all(`SELECT l.officer_id AS officer, COALESCE(SUM(p.allocated_principal),0) AS principal, COALESCE(SUM(p.allocated_interest),0) AS interest,
        COALESCE(SUM(p.allocated_penalty),0) AS penalty, COALESCE(SUM(CASE WHEN LOWER(p.channel) LIKE 'check%' THEN p.amount ELSE 0 END),0) AS checkoff, COUNT(*) AS n
      FROM payments p JOIN loans l ON l.id = p.loan_id
      WHERE p.status IN ('Posted','Overpayment') AND (p.created_at)::date >= (?)::date AND (p.created_at)::date <= (?)::date ${sc.pay.length ? 'AND ' + sc.pay.join(' AND ') : ''}
      GROUP BY l.officer_id`, [r.from, r.to, ...sc.payParams]);
    const fees = await all(`SELECT COALESCE(c.officer_id, f.initiated_by) AS officer, COALESCE(SUM(f.amount),0) AS fee
      FROM loan_fee_payments f JOIN clients c ON c.id = f.client_id
      WHERE f.status = 'Confirmed' AND (f.confirmed_at)::date >= (?)::date AND (f.confirmed_at)::date <= (?)::date ${sc.fee.length ? 'AND ' + sc.fee.join(' AND ') : ''}
      GROUP BY COALESCE(c.officer_id, f.initiated_by)`, [r.from, r.to, ...sc.feeParams]);
    const by = {};
    const row = id => by[id || ''] || (by[id || ''] = { officerId: id || null, principal: 0, interest: 0, checkoff: 0, fee: 0, penalty: 0 });
    pay.forEach(x => { const o = row(x.officer); o.principal += Number(x.principal) || 0; o.interest += Number(x.interest) || 0; o.penalty += Number(x.penalty) || 0; o.checkoff += Number(x.checkoff) || 0; });
    fees.forEach(x => { row(x.officer).fee += Number(x.fee) || 0; });
    const ids = Object.keys(by).filter(Boolean);
    const names = {};
    if (ids.length) (await all(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids)).forEach(u => { names[u.id] = u.name; });
    const round = v => Math.round(v * 100) / 100;
    const staff = Object.values(by).map(o => {
      const totalIncome = o.interest + o.fee + o.penalty;
      return { ...o, name: o.officerId ? (names[o.officerId] || 'Unknown staff') : 'Unassigned', principal: round(o.principal), interest: round(o.interest), fee: round(o.fee), penalty: round(o.penalty), checkoff: round(o.checkoff), totalIncome: round(totalIncome), totals: round(o.principal + totalIncome) };
    }).sort((a, b) => b.totals - a.totals);
    const totals = staff.reduce((t, o) => { ['principal', 'interest', 'checkoff', 'fee', 'penalty', 'totalIncome', 'totals'].forEach(k => { t[k] = round((t[k] || 0) + o[k]); }); return t; }, {});
    res.json({ from: r.from, to: r.to, staff, totals });
  });

  router.get('/api/payments/staff-report/detail', requireAuth, notInvestor, requireModule('payments'), async (req, res, next) => {
    const r = monthRange(req, next); if (!r) return;
    const bucket = String(req.query.bucket || '');
    if (!['principal', 'interest', 'penalty', 'checkoff', 'fee'].includes(bucket)) return next({ status: 400, message: 'Unknown column' });
    const officer = req.query.officer_id ? String(req.query.officer_id) : null;
    await assignReceiptNumbers();
    const settings = await receiptSettings();
    const sc = await scope(req.user);
    let rows;
    if (bucket === 'fee') {
      const w = [`f.status = 'Confirmed'`, '(f.confirmed_at)::date >= (?)::date', '(f.confirmed_at)::date <= (?)::date', ...sc.fee]; const ps = [r.from, r.to, ...sc.feeParams];
      if (officer) { w.push('COALESCE(c.officer_id, f.initiated_by) = ?'); ps.push(officer); }
      rows = (await all(`SELECT f.id, f.confirmed_at AS at, f.mpesa_receipt_number AS reference, f.amount, f.receipt_no, c.name AS client_name, c.national_id, b.name AS branch_name,
          ln.disbursed_at, u.name AS approved_by
        FROM loan_fee_payments f JOIN clients c ON c.id = f.client_id LEFT JOIN branches b ON b.id = c.branch_id
        LEFT JOIN loans ln ON ln.id = f.loan_id LEFT JOIN users u ON u.id = f.confirmed_by
        WHERE ${w.join(' AND ')} ORDER BY f.confirmed_at`, ps)).map(x => ({ ...x, amount: Number(x.amount) || 0 }));
    } else {
      const amountExpr = bucket === 'checkoff' ? 'p.amount' : `p.allocated_${bucket}`;
      const w = [`p.status IN ('Posted','Overpayment')`, '(p.created_at)::date >= (?)::date', '(p.created_at)::date <= (?)::date', ...sc.pay]; const ps = [r.from, r.to, ...sc.payParams];
      w.push(bucket === 'checkoff' ? `LOWER(p.channel) LIKE 'check%'` : `${amountExpr} > 0`);
      if (officer) { w.push('l.officer_id = ?'); ps.push(officer); }
      rows = (await all(`SELECT p.id, p.created_at AS at, p.reference, ${amountExpr} AS amount, p.receipt_no, c.name AS client_name, c.national_id, b.name AS branch_name,
          l.disbursed_at, u.name AS approved_by
        FROM payments p JOIN loans l ON l.id = p.loan_id LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN branches b ON b.id = l.branch_id
        LEFT JOIN users u ON u.id = p.recorded_by
        WHERE ${w.join(' AND ')} ORDER BY p.created_at`, ps)).map(x => ({ ...x, amount: Number(x.amount) || 0 }));
    }
    let officerName = null;
    if (officer) { const u = await get('SELECT name FROM users WHERE id = ?', [officer]); officerName = u ? u.name : null; }
    res.json({
      bucket, officerName, total: Math.round(rows.reduce((t, x) => t + x.amount, 0) * 100) / 100,
      rows: rows.map(x => ({ id: x.id, date: x.at, transaction: x.reference || '—', amount: x.amount, disbursedAt: x.disbursed_at || null, clientName: x.client_name, clientIdNo: x.national_id,
        branch: x.branch_name, receiptNo: x.receipt_no != null ? settings.startNumber + Number(x.receipt_no) : null, approval: x.approved_by || 'System' })),
    });
  });

  // ---------- merged payments ----------
  // Unassigned M-Pesa paybill transactions that can still be merged.
  router.get('/api/payments/mergeable', requireAuth, notInvestor, requireModule('payments'), async (req, res) => {
    const clauses = ['t.processed = 0', 't.payment_id IS NULL']; const params = [];
    if (req.query.q) { clauses.push('(t.msisdn LIKE ? OR t.bill_ref_number LIKE ? OR t.trans_id LIKE ?)'); const like = `%${req.query.q}%`; params.push(like, like, like); }
    const rows = await all(`SELECT t.* FROM mpesa_c2b_transactions t WHERE ${clauses.join(' AND ')} ORDER BY t.created_at DESC LIMIT 300`, params);
    const out = [];
    for (const t of rows) {
      const client = await get(`SELECT id, name, national_id, branch_id FROM clients
        WHERE (length(?) >= 9 AND RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 9) = RIGHT(?, 9)) OR national_id = ? OR client_code = ? OR id = ? LIMIT 1`,
        [String(t.msisdn || ''), String(t.msisdn || ''), t.bill_ref_number, t.bill_ref_number, t.bill_ref_number]);
      out.push({ id: t.id, transId: t.trans_id, amount: Number(t.amount) || 0, phone: t.msisdn, accountRef: t.bill_ref_number, createdAt: t.created_at,
        suggestedClient: client ? { id: client.id, name: client.name, idNo: client.national_id } : null });
    }
    res.json({ transactions: out });
  });

  router.post('/api/payments/merge', requireAuth, notInvestor, requireModule('payments'), async (req, res, next) => {
    if (!(await canAssign(req.user))) return next({ status: 403, message: 'Your role cannot merge payments' });
    const b = req.body || {};
    const ids = [...new Set((Array.isArray(b.transaction_ids) ? b.transaction_ids : []).map(String))];
    if (ids.length < 2) return next({ status: 400, message: 'Choose at least two transactions to merge' });
    const loan = b.loan_id ? await get('SELECT * FROM loans WHERE id = ?', [b.loan_id]) : null;
    if (!loan) return next({ status: 400, message: 'Choose the loan to post the merged payment to' });
    if (!(await loanInScope(req.user, loan))) return next({ status: 403, message: 'That loan is outside your branches' });
    if (!['Active', 'Disbursed'].includes(loan.status)) return next({ status: 409, message: 'Payments can only be posted to a running loan' });
    const txs = await all(`SELECT * FROM mpesa_c2b_transactions WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    if (txs.length !== ids.length) return next({ status: 404, message: 'One of the transactions was not found' });
    if (txs.some(t => t.processed || t.payment_id)) return next({ status: 409, message: 'One of the transactions has already been posted' });
    const total = Math.round(txs.reduce((s, t) => s + (Number(t.amount) || 0), 0) * 100) / 100;
    if (!(total > 0)) return next({ status: 400, message: 'The merged amount must be more than zero' });
    const paymentId = 'pm_' + crypto.randomUUID();
    const mergeId = 'pmg_' + crypto.randomUUID();
    let status, mergeNo;
    await transaction(async () => {
      mergeNo = Number((await get(`SELECT nextval('payment_merge_seq') AS n`)).n);
      const reference = 'MERGED' + mergeNo;
      await run(`INSERT INTO payments (id, loan_id, client_id, amount, channel, reference, status, allocated_principal, allocated_interest, recorded_by)
        VALUES (?,?,?,?,'M-Pesa',?,'Unposted',0,0,?)`, [paymentId, loan.id, loan.client_id, total, reference, req.user.id]);
      const result = await allocate(loan.id, total, paymentId);
      status = result.remaining > 0 ? 'Overpayment' : 'Posted';
      await run('UPDATE payments SET status = ?, allocated_principal = ?, allocated_interest = ?, allocated_penalty = ? WHERE id = ?',
        [status, result.allocPrincipal, result.allocInterest, result.allocPenalty || 0, paymentId]);
      await postPaymentJournal({ paymentId, loanId: loan.id, amount: total, channel: 'M-Pesa', allocPrincipal: result.allocPrincipal, allocInterest: result.allocInterest,
        allocPenalty: result.allocPenalty || 0, overpay: result.remaining, userId: req.user.id, branchId: loan.branch_id });
      for (const t of txs) await run(`UPDATE mpesa_c2b_transactions SET processed = 1, payment_id = ?, matched_loan_id = ?, match_method = 'merged' WHERE id = ?`, [paymentId, loan.id, t.id]);
      await run(`INSERT INTO payment_merges (id, merge_no, client_id, loan_id, payment_id, total, transactions_json, created_by) VALUES (?,?,?,?,?,?,?,?)`,
        [mergeId, mergeNo, loan.client_id, loan.id, paymentId, total, JSON.stringify(txs.map(t => ({ id: t.id, transId: t.trans_id, amount: Number(t.amount) || 0, phone: t.msisdn, at: t.created_at }))), req.user.id]);
    });
    await logAction(req, { action: 'Merged M-Pesa payments', module: 'payments', recordType: 'Payment', recordId: paymentId, newValue: { reference: 'MERGED' + mergeNo, total, transactions: txs.map(t => t.trans_id), loanId: loan.id } });
    res.status(201).json({ merge: { id: mergeId, mergeNo, reference: 'MERGED' + mergeNo, paymentId, total, status } });
  });

  router.get('/api/payments/merges', requireAuth, notInvestor, requireModule('payments'), async (req, res) => {
    const sc = await scope(req.user);
    const where = ['1=1', ...sc.pay];
    if (req.query.q) { where.push('(c.name LIKE ? OR c.national_id LIKE ?)'); sc.payParams.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const rows = await all(`SELECT m.*, c.name AS client_name, c.national_id, p.reference, p.status AS payment_status, u.name AS created_by_name
      FROM payment_merges m JOIN loans l ON l.id = m.loan_id LEFT JOIN clients c ON c.id = m.client_id
      LEFT JOIN payments p ON p.id = m.payment_id LEFT JOIN users u ON u.id = m.created_by
      WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT 500`, sc.payParams);
    res.json({ merges: rows.map(r => {
      let txs = []; try { txs = JSON.parse(r.transactions_json || '[]'); } catch (e) { txs = []; }
      return { id: r.id, mergeNo: Number(r.merge_no), reference: r.reference, paymentId: r.payment_id, paymentStatus: r.payment_status, loanId: r.loan_id,
        clientId: r.client_id, clientName: r.client_name, clientIdNo: r.national_id, total: Number(r.total) || 0, transactions: txs, createdAt: r.created_at, createdBy: r.created_by_name || 'System' };
    }) });
  });

  // ---------- overpayment transfer ----------
  router.post('/api/payments/:id/assign-overpay', requireAuth, notInvestor, requireModule('payments'), async (req, res, next) => {
    if (!(await canAssign(req.user))) return next({ status: 403, message: 'Your role cannot assign overpayments' });
    const p = await get('SELECT * FROM payments WHERE id = ?', [req.params.id]);
    if (!p) return next({ status: 404, message: 'Payment not found' });
    const source = await get('SELECT * FROM loans WHERE id = ?', [p.loan_id]);
    if (!(await loanInScope(req.user, source))) return next({ status: 404, message: 'Payment not found' });
    if (p.status !== 'Overpayment' || p.overpay_assigned_to) return next({ status: 409, message: 'This payment has no overpayment left to assign' });
    const residual = Math.round((Number(p.amount) - Number(p.allocated_principal || 0) - Number(p.allocated_interest || 0) - Number(p.allocated_penalty || 0)) * 100) / 100;
    if (!(residual > 0)) return next({ status: 409, message: 'This payment has no overpayment left to assign' });
    const loan = (req.body || {}).loan_id ? await get('SELECT * FROM loans WHERE id = ?', [req.body.loan_id]) : null;
    if (!loan) return next({ status: 400, message: 'Choose the loan to move the overpayment to' });
    if (loan.id === p.loan_id) return next({ status: 400, message: 'Choose a different loan' });
    if (loan.client_id !== p.client_id) return next({ status: 400, message: "An overpayment can only move to the same client's loan" });
    if (!(await loanInScope(req.user, loan))) return next({ status: 403, message: 'That loan is outside your branches' });
    if (!['Active', 'Disbursed'].includes(loan.status)) return next({ status: 409, message: 'Payments can only be posted to a running loan' });
    const newId = 'pm_' + crypto.randomUUID();
    let status, reference;
    await transaction(async () => {
      reference = 'OVERPAY' + Number((await get(`SELECT nextval('overpay_transfer_seq') AS n`)).n);
      await run(`INSERT INTO payments (id, loan_id, client_id, amount, channel, reference, status, allocated_principal, allocated_interest, recorded_by)
        VALUES (?,?,?,?,'Overpayment',?,'Unposted',0,0,?)`, [newId, loan.id, loan.client_id, residual, reference, req.user.id]);
      const result = await allocate(loan.id, residual, newId);
      status = result.remaining > 0 ? 'Overpayment' : 'Posted';
      await run('UPDATE payments SET status = ?, allocated_principal = ?, allocated_interest = ?, allocated_penalty = ? WHERE id = ?',
        [status, result.allocPrincipal, result.allocInterest, result.allocPenalty || 0, newId]);
      await postPaymentJournal({ paymentId: newId, loanId: loan.id, amount: residual, channel: 'Overpayment', allocPrincipal: result.allocPrincipal, allocInterest: result.allocInterest,
        allocPenalty: result.allocPenalty || 0, overpay: result.remaining, userId: req.user.id, branchId: loan.branch_id });
      await run(`UPDATE payments SET status = 'Posted', overpay_assigned_to = ? WHERE id = ?`, [newId, p.id]);
    });
    await logAction(req, { action: 'Assigned overpayment to loan', module: 'payments', recordType: 'Payment', recordId: p.id, newValue: { amount: residual, toLoan: loan.id, reference } });
    res.status(201).json({ payment: { id: newId, reference, amount: residual, status } });
  });
}

module.exports = { register, receiptSettings, assignReceiptNumbers, RECEIPT_DEFAULTS };
