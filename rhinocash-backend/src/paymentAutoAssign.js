// paymentAutoAssign.js — payments nobody assigned or posted in time.
//
// Managers and above are notified of every unassigned Paybill payment and
// every payment recorded as Unposted (the 💵 icon and the bell). If a
// payment is still waiting after the wait set on Admin › Payment
// Auto-Assignment (60 minutes unless changed), the system:
//   - assigns an unassigned Paybill payment to a loan, but only when exactly
//     ONE running loan matches its account number (loan number, application
//     number or client ID number) or the payer's phone — anything ambiguous
//     stays for a person to assign;
//   - posts a payment recorded as Unposted to the loan it was recorded for.
// Every automatic action is written to the audit trail and closes the
// notifications that asked for it.
'use strict';
const { all, get, run } = require('./db');
const { logAction, markActed } = require('./audit');

const DEFAULTS = { enabled: true, waitMinutes: 60, postUnposted: true };
const SYSTEM = { headers: {} }; // audit entries made by the system itself

async function settings() {
  const row = await get(`SELECT value_json FROM admin_settings WHERE key = 'payments.auto-assign'`).catch(() => null);
  let v = {}; try { v = row ? JSON.parse(row.value_json) || {} : {}; } catch { v = {}; }
  const out = Object.assign({}, DEFAULTS, v);
  out.waitMinutes = Math.max(5, Number(out.waitMinutes) || DEFAULTS.waitMinutes);
  return out;
}

const RUNNING = `status IN ('Active','Disbursed')`;
// Every running loan the payment could belong to.
async function candidateLoans(tx) {
  const ids = new Set();
  const ref = String(tx.bill_ref_number || '').trim();
  const refDigits = ref.replace(/\D/g, '');
  if (ref) {
    for (const l of await all(`SELECT id FROM loans WHERE ${RUNNING} AND (id = ? OR CAST(application_no AS TEXT) = ?)`, [ref, ref.replace(/^#/, '')])) ids.add(l.id);
    for (const l of await all(`SELECT l.id FROM loans l JOIN clients c ON c.id = l.client_id WHERE l.status IN ('Active','Disbursed') AND (c.national_id = ? OR c.client_code = ?)`, [ref, ref])) ids.add(l.id);
    if (refDigits.length >= 9) for (const l of await all(`SELECT l.id FROM loans l JOIN clients c ON c.id = l.client_id WHERE l.status IN ('Active','Disbursed') AND c.phone LIKE ?`, ['%' + refDigits.slice(-9)])) ids.add(l.id);
  }
  const last9 = String(tx.msisdn || '').replace(/\D/g, '').slice(-9);
  if (last9.length === 9) for (const l of await all(`SELECT l.id FROM loans l JOIN clients c ON c.id = l.client_id WHERE l.status IN ('Active','Disbursed') AND c.phone LIKE ?`, ['%' + last9])) ids.add(l.id);
  return [...ids];
}

async function runOnce({ force = false } = {}) {
  const s = await settings();
  const out = { assigned: [], posted: [], leftForPeople: 0, skipped: !s.enabled && !force };
  if (out.skipped) return out;
  const cutoff = new Date(Date.now() - (force ? 0 : s.waitMinutes) * 60000).toISOString();
  const mpesa = require('./integrations/mpesa');
  const txs = await all(`SELECT * FROM mpesa_c2b_transactions WHERE processed = 0 AND matched_loan_id IS NULL AND created_at < ? ORDER BY created_at LIMIT 200`, [cutoff]);
  for (const tx of txs) {
    const loans = await candidateLoans(tx);
    if (loans.length !== 1) { out.leftForPeople++; continue; }
    await run(`UPDATE mpesa_c2b_transactions SET matched_loan_id = ?, match_method = 'auto' WHERE id = ? AND processed = 0`, [loans[0], tx.id]);
    const r = await mpesa.processC2bTransaction(tx.id, null);
    if (r && r.ok) {
      out.assigned.push({ transaction: tx.trans_id, loanId: loans[0], paymentId: r.paymentId });
      await logAction(SYSTEM, { action: 'Assigned M-Pesa payment automatically', module: 'payments', recordType: 'MpesaC2b', recordId: tx.id, newValue: { loanId: loans[0], waitedMinutes: s.waitMinutes } });
      await markActed('c2b', tx.id, 'Assigned automatically');
    }
  }
  if (s.postUnposted) {
    const { postUnpostedPayment } = require('./routes/payments');
    const pays = await all(`SELECT * FROM payments WHERE status = 'Unposted' AND loan_id IS NOT NULL AND created_at < ? ORDER BY created_at LIMIT 200`, [cutoff]);
    for (const p of pays) {
      const loan = await get('SELECT * FROM loans WHERE id = ?', [p.loan_id]);
      if (!loan) continue;
      try {
        await postUnpostedPayment(p, loan, null);
        out.posted.push({ paymentId: p.id, loanId: loan.id });
        await logAction(SYSTEM, { action: 'Posted payment automatically', module: 'payments', recordType: 'Payment', recordId: p.id, newValue: { waitedMinutes: s.waitMinutes } });
        await markActed('payment', p.id, 'Posted automatically');
      } catch (e) { console.warn('[auto-post] payment', p.id, e.message); }
    }
  }
  return out;
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { runOnce().catch(e => console.warn('[payment auto-assign]', e.message)); }, 5 * 60000);
  if (timer.unref) timer.unref();
}

module.exports = { runOnce, start, settings, DEFAULTS };
