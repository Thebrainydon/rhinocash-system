// bankAdmin.js — Co-op Bank transfers: Admin-only setup, plus the
// disbursement routes Accountants (disburse_loans) use from Undisbursed
// Loans. Real money leaves Rhinocash's Co-op account here, so every send
// needs a one-time code from the sender's phone, and a loan only becomes
// Active once Co-op's own status API confirms the transfer.
'use strict';
const { requireAuth, requirePermission } = require('./../middleware');
const { logAction } = require('./../audit');
const { get, run, all } = require('./../db');
const { assertRecordInScope } = require('./../rbac');
const { issueOtp, consumeOtp, OTP_ERROR } = require('./../otp');
const bank = require('./../integrations/coopbank');

function requireAdminRole(req, res, next) {
  if (req.user.role_id !== 'admin') return next({ status: 403, message: 'Only the Master System Administrator can manage Co-op Bank settings' });
  next();
}
function validEnv(req, res, next) {
  if (!bank.ENVIRONMENTS.includes(req.params.environment)) return next({ status: 400, message: 'environment must be "sandbox" or "production"' });
  next();
}

// What the client actually receives: the principal less a processing fee
// taken at disbursement (legacy fee_pct products) — the same figure the
// disbursement journal credits to the Bank account.
async function netDisbursement(loan) {
  const product = await get('SELECT fee_pct, processing_fee_amount FROM loan_products WHERE id = ?', [loan.product_id]);
  const fee = product && product.processing_fee_amount != null ? 0 : Math.round((Number(loan.principal) * ((product && Number(product.fee_pct)) || 0) / 100) * 100) / 100;
  return Math.round((Number(loan.principal) - fee) * 100) / 100;
}

function register(router) {
  // ---- Admin setup ----
  router.get('/api/admin/bank/config', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, async (req, res, next) => {
    try {
      res.json({
        sandbox: await bank.getMaskedConfig('sandbox'),
        production: await bank.getMaskedConfig('production'),
        activeEnvironment: await bank.getActiveEnvironment(),
      });
    } catch (e) { next(e); }
  });

  router.put('/api/admin/bank/config/:environment', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, validEnv, async (req, res, next) => {
    try {
      const { consumerKey, consumerSecret, sourceAccount, baseUrl, callbackUrl } = req.body || {};
      const result = await bank.saveConfig(req.params.environment, { consumerKey, consumerSecret, sourceAccount, baseUrl, callbackUrl }, req.user.id);
      // Audit the change, never the values.
      await logAction(req, { action: 'Updated Co-op Bank settings', module: 'integrations', recordType: 'BankConfig', recordId: req.params.environment, newValue: { fieldsChanged: result.changedFields, nowConfigured: result.configured } });
      res.json({ ok: true, config: await bank.getMaskedConfig(req.params.environment) });
    } catch (e) { next(e); }
  });

  router.delete('/api/admin/bank/config/:environment', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, validEnv, async (req, res) => {
    await bank.clearConfig(req.params.environment);
    await logAction(req, { action: 'Cleared Co-op Bank settings', module: 'integrations', recordType: 'BankConfig', recordId: req.params.environment });
    res.json({ ok: true });
  });

  router.post('/api/admin/bank/test-connection/:environment', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, validEnv, async (req, res, next) => {
    try {
      const result = await bank.testConnection(req.params.environment);
      await logAction(req, { action: 'Tested Co-op Bank connection', module: 'integrations', recordType: 'BankConfig', recordId: req.params.environment, newValue: { status: result.status } });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/admin/bank/set-active', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, async (req, res, next) => {
    const env = req.body && req.body.environment;
    if (env !== null && !bank.ENVIRONMENTS.includes(env)) return next({ status: 400, message: 'environment must be "sandbox", "production" or null (off)' });
    if (env === 'production' && !(req.body && req.body.confirmProduction)) return next({ status: 400, message: 'Switching on Production sends real money. Confirm it to continue.' });
    try {
      await bank.setActiveEnvironment(env);
      await logAction(req, { action: env ? `Switched on Co-op Bank transfers (${env})` : 'Switched off Co-op Bank transfers', module: 'integrations', recordType: 'BankConfig', recordId: env || 'off' });
      res.json({ ok: true, activeEnvironment: await bank.getActiveEnvironment() });
    } catch (e) { next(e); }
  });

  // ---- Disbursing (Accountant and others with disburse_loans) ----
  router.get('/api/bank/status', requireAuth, requirePermission('disburse_loans'), async (req, res) => {
    const env = await bank.getActiveEnvironment();
    const config = env ? await bank.activeConfig().catch(() => null) : null;
    res.json({ active: !!config, environment: config ? env : null, coOpBankCode: bank.CO_OP_BANK_CODE });
  });

  router.post('/api/bank/disburse/request-otp', requireAuth, requirePermission('disburse_loans'), async (req, res) => {
    res.json(await issueOtp(req.user));
  });

  router.post('/api/loans/:id/disburse/bank', requireAuth, requirePermission('disburse_loans'), async (req, res, next) => {
    try {
      const loan = await get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
      if (!loan) return next({ status: 404, message: 'Loan not found' });
      await assertRecordInScope(req.user, loan.branch_id, 'loan');
      if (loan.status !== 'Approved for Disbursement') return next({ status: 409, message: 'Loan is not approved for disbursement yet' });
      const b = req.body || {};
      // Check everything that can be checked before the code is used up.
      if (!(await bank.activeConfig())) return res.json({ status: 'NOT_CONFIGURED', message: 'Co-op Bank transfers are not switched on. An Admin sets them up under Admin › Integrations › Co-op Bank.' });
      const invalid = bank.validateDestination({ rail: b.rail, bankCode: b.bank_code, accountNumber: b.account_number, accountName: b.account_name });
      if (invalid) return next({ status: 400, message: invalid });
      const { assertPeriodOpen } = require('./accounting');
      await assertPeriodOpen();
      if (!(await consumeOtp(req.user.id, b.otp_code))) return next(OTP_ERROR);
      const client = await get('SELECT name FROM clients WHERE id = ?', [loan.client_id]);
      const amount = await netDisbursement(loan);
      const result = await bank.initiateTransfer({
        loanId: loan.id, amount, rail: b.rail, bankCode: b.bank_code, accountNumber: b.account_number, accountName: b.account_name,
        narration: `Rhinocash loan ${client ? client.name : ''}`.trim(), initiatedBy: req.user.id,
      });
      if (result.status === 'PENDING') await run(`UPDATE loans SET status = 'Disbursement Pending' WHERE id = ? AND status = 'Approved for Disbursement'`, [loan.id]);
      await logAction(req, { action: 'Sent loan disbursement by Co-op Bank transfer', module: 'loanbook', recordType: 'Loan', recordId: loan.id,
        newValue: { status: result.status, amount, rail: b.rail, bankCode: b.rail === 'internal' ? bank.CO_OP_BANK_CODE : b.bank_code, accountEnding: String(b.account_number || '').slice(-4) } });
      res.json({ ...result, amount, loan: await get('SELECT * FROM loans WHERE id = ?', [loan.id]) });
    } catch (e) { next(e); }
  });

  // Ask Co-op whether a pending transfer went through.
  router.post('/api/bank/disbursements/:id/check', requireAuth, requirePermission('disburse_loans'), async (req, res, next) => {
    try {
      const row = await get('SELECT * FROM bank_disbursements WHERE id = ?', [req.params.id]);
      if (!row) return next({ status: 404, message: 'Bank transfer not found' });
      const loan = await get('SELECT branch_id FROM loans WHERE id = ?', [row.loan_id]);
      await assertRecordInScope(req.user, loan.branch_id, 'loan');
      const result = await bank.settle(row.id, req.user.id);
      await logAction(req, { action: 'Checked Co-op Bank transfer', module: 'loanbook', recordType: 'Loan', recordId: row.loan_id, newValue: { status: result.status } });
      res.json(result);
    } catch (e) { next(e); }
  });

  // A loan's bank transfers, and the last account a client was paid to (to prefill).
  router.get('/api/bank/disbursements', requireAuth, requirePermission('disburse_loans'), async (req, res, next) => {
    try {
      let loanIds = [];
      if (req.query.loan_id) loanIds = [String(req.query.loan_id)];
      else if (req.query.client_id) loanIds = (await all('SELECT id FROM loans WHERE client_id = ?', [String(req.query.client_id)])).map(r => r.id);
      if (loanIds.length) {
        const first = await get('SELECT branch_id FROM loans WHERE id = ?', [loanIds[0]]);
        if (first) await assertRecordInScope(req.user, first.branch_id, 'loan');
      }
      const rows = await bank.listForLoans(loanIds);
      res.json({ disbursements: rows.map(r => ({ id: r.id, loanId: r.loan_id, reference: r.message_reference, rail: r.rail, bankCode: r.bank_code, accountNumber: r.account_number, accountName: r.account_name, amount: Number(r.amount), status: r.status, resultDesc: r.result_desc, bankReference: r.bank_reference, environment: r.environment, createdAt: r.created_at, completedAt: r.completed_at })) });
    } catch (e) { next(e); }
  });
}

module.exports = { register, netDisbursement };
