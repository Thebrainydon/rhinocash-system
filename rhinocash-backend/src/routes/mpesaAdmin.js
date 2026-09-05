// mpesaAdmin.js — Admin-only M-Pesa configuration endpoints. Every route
// here is reachable ONLY by role_id === 'admin', deliberately not even
// CEO/Director (who hold manage_users but not system-credential
// authority) — this is squarely "Master System Administrator" territory,
// same principle as password-reset/session-revocation in users.js.
'use strict';
const { requireAuth, requirePermission, requireModule } = require('./../middleware');
const { logAction } = require('./../audit');
const { branchScopeSQL } = require('./../rbac');
const { all } = require('./../db');
const mpesa = require('./../integrations/mpesa');

function requireAdminRole(req, res, next) {
  if (req.user.role_id !== 'admin') {
    return next({ status: 403, message: 'Only the Master System Administrator can manage M-Pesa configuration' });
  }
  next();
}

// Operational M-Pesa visibility is real, financial visibility too — a
// Manager (payments) and a CEO (accounting, no payments module) both have
// a legitimate real reason to see this, distinct from who can touch
// credentials (Admin-only, see requireAdminRole above).
const { hasModuleAccess } = require('./../rbac');
function requireMpesaViewAuth(req, res, next) {
  if (hasModuleAccess(req.user, 'payments') || hasModuleAccess(req.user, 'accounting')) return next();
  return next({ status: 403, message: 'Your role does not have M-Pesa operational visibility' });
}

const VALID_ENVIRONMENTS = ['sandbox', 'production'];
function validEnv(req, res, next) {
  if (!VALID_ENVIRONMENTS.includes(req.params.environment)) {
    return next({ status: 400, message: 'environment must be "sandbox" or "production"' });
  }
  next();
}

function register(router) {
  // ==================== Tiered operational visibility — NOT Admin-only ====================
  // Milestone 2's core requirement: viewing operational status/transactions
  // is a genuinely different permission from managing credentials. Any
  // authenticated staff user with real accounting/payments module access
  // can see THIS; only the Master System Administrator can reach the
  // config routes below.
  router.get('/api/mpesa/status', requireAuth, requireMpesaViewAuth, (req, res) => {
    const activeEnv = mpesa.getActiveEnvironment();
    const activeConfig = activeEnv ? mpesa.getMaskedConfig(activeEnv) : null;
    res.json({
      activeEnvironment: activeEnv,
      configured: mpesa.isConfigured(),
      sandboxStatus: mpesa.statusFor('sandbox'),
      productionStatus: mpesa.statusFor('production'),
      b2cConfigured: activeConfig ? activeConfig.b2cConfigured : false,
      // No secrets, no masked-key material — just real, safe operational facts.
    });
  });

  // Real B2C requests list, branch-scoped via the real loan each request belongs to.
  router.get('/api/mpesa/b2c/requests', requireAuth, requireMpesaViewAuth, (req, res) => {
    const scope = branchScopeSQL(req.user);
    let clause = '1=1'; const params = [];
    if (req.query.status) { clause += ' AND b.status = ?'; params.push(req.query.status); }
    const rows = all(
      `SELECT b.* FROM mpesa_b2c_requests b JOIN loans l ON l.id = b.loan_id
       WHERE ${clause} AND l.id IN (SELECT id FROM loans WHERE ${scope.clause})
       ORDER BY b.created_at DESC LIMIT 200`,
      params.concat(scope.params)
    );
    res.json({ requests: rows });
  });

  router.get('/api/mpesa/transactions', requireAuth, requireMpesaViewAuth, (req, res) => {
    const scope = branchScopeSQL(req.user);
    // Real transactions are the real callbacks — joined against real loans
    // for branch scope, since the callback row itself carries no branch.
    let clause = '1=1'; const params = [];
    if (req.query.status) {
      if (req.query.status === 'Success') { clause += " AND CAST(c.result_code AS REAL) = 0"; }
      else if (req.query.status === 'Failed') { clause += " AND CAST(c.result_code AS REAL) != 0"; }
      else if (req.query.status === 'Unprocessed') { clause += ' AND c.processed = 0'; }
    }
    const rows = all(
      `SELECT c.*, 'STK' as source FROM mpesa_callbacks c LEFT JOIN loans l ON l.id = c.loan_id
       WHERE ${clause} AND (c.loan_id IS NULL OR l.id IN (SELECT id FROM loans WHERE ${scope.clause}))
       ORDER BY c.created_at DESC LIMIT 200`,
      scope.params
    );
    res.json({ transactions: rows });
  });

  // Full real chain for one transaction: the STK request that started it
  // (if any), the callback, the real payment it became (if any), the real
  // balanced journal entry for that payment. Every field here is a real
  // lookup — nothing inferred or fabricated.
  router.get('/api/mpesa/transactions/:id', requireAuth, requireMpesaViewAuth, (req, res, next) => {
    const { get } = require('./../db');
    const cb = get('SELECT * FROM mpesa_callbacks WHERE id = ?', [req.params.id]);
    if (!cb) return next({ status: 404, message: 'Transaction not found' });
    const stkRequest = get('SELECT * FROM mpesa_stk_requests WHERE checkout_request_id = ?', [cb.checkout_request_id]);
    const payment = cb.payment_id ? get('SELECT * FROM payments WHERE id = ?', [cb.payment_id]) : null;
    const journal = cb.payment_id ? all(`SELECT * FROM journal_entries WHERE ref_type = 'payment' AND ref_id = ?`, [cb.payment_id]) : [];
    const loan = cb.loan_id ? get('SELECT * FROM loans WHERE id = ?', [cb.loan_id]) : null;
    const client = loan ? get('SELECT id, name, phone FROM clients WHERE id = ?', [loan.client_id]) : null;
    res.json({ callback: cb, stkRequest, payment, journal, loan, client });
  });

  // Real reconciliation summary — Matched/Unmatched/Pending/Exception
  // counts across BOTH STK callbacks and C2B transactions, the two real
  // sources of M-Pesa money in this system. "Duplicate" is not a real
  // category here because recordCallback()/recordC2bTransaction() never
  // let a second row for the same real Safaricom id exist in the first
  // place — reported honestly rather than inventing a count for a
  // category that structurally cannot occur.
  router.get('/api/mpesa/reconciliation/summary', requireAuth, requireMpesaViewAuth, (req, res) => {
    const { get } = require('./../db');
    const stkMatched = get(`SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as amt FROM mpesa_callbacks WHERE processed = 1 AND payment_id IS NOT NULL`);
    const stkException = get(`SELECT COUNT(*) as c FROM mpesa_callbacks WHERE CAST(result_code AS REAL) != 0`);
    const stkUnmatched = get(`SELECT COUNT(*) as c FROM mpesa_callbacks WHERE CAST(result_code AS REAL) = 0 AND (loan_id IS NULL OR processed = 0) AND payment_id IS NULL`);
    const c2bMatched = get(`SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as amt FROM mpesa_c2b_transactions WHERE processed = 1 AND payment_id IS NOT NULL`);
    const c2bUnmatched = get(`SELECT COUNT(*) as c FROM mpesa_c2b_transactions WHERE match_method = 'unmatched' AND processed = 0`);
    res.json({
      matched: { count: stkMatched.c + c2bMatched.c, amount: stkMatched.amt + c2bMatched.amt },
      unmatched: { count: stkUnmatched.c + c2bUnmatched.c },
      exception: { count: stkException.c },
      stk: { matched: stkMatched.c, unmatched: stkUnmatched.c, exception: stkException.c },
      c2b: { matched: c2bMatched.c, unmatched: c2bUnmatched.c },
    });
  });

  router.post('/api/mpesa/callbacks/:id/process', requireAuth, requirePermission('post_accounting_entries'), (req, res, next) => {
    const result = mpesa.processCallback(req.params.id, req.user.id);
    if (!result.ok) return next({ status: 409, message: result.message });
    logAction(req, { action: 'Manually processed M-Pesa callback', module: 'mpesa', recordType: 'MpesaCallback', recordId: req.params.id, newValue: { created: result.created, paymentId: result.paymentId } });
    res.json(result);
  });

  // ==================== C2B / Paybill — staff-facing review ====================
  router.get('/api/mpesa/c2b/unmatched', requireAuth, requirePermission('post_accounting_entries'), (req, res) => {
    res.json({ transactions: mpesa.unmatchedC2bTransactions() });
  });

  // Manual match + post — an Accountant/Admin resolving a real unmatched
  // Paybill payment by pointing it at the correct real loan, then posting
  // it through the exact same real bridge as an automatic match.
  router.post('/api/mpesa/c2b/:id/match', requireAuth, requirePermission('post_accounting_entries'), (req, res, next) => {
    const { get, run } = require('./../db');
    const tx = get('SELECT * FROM mpesa_c2b_transactions WHERE id = ?', [req.params.id]);
    if (!tx) return next({ status: 404, message: 'Transaction not found' });
    if (tx.processed) return next({ status: 409, message: 'Already processed' });
    if (!req.body.loan_id) return next({ status: 400, message: 'loan_id is required' });
    const loan = get('SELECT * FROM loans WHERE id = ?', [req.body.loan_id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    run(`UPDATE mpesa_c2b_transactions SET matched_loan_id = ?, match_method = 'manual' WHERE id = ?`, [loan.id, tx.id]);
    logAction(req, { action: 'Manually matched M-Pesa C2B transaction', module: 'mpesa', recordType: 'MpesaC2b', recordId: tx.id, newValue: { loanId: loan.id } });
    const result = mpesa.processC2bTransaction(tx.id, req.user.id);
    if (!result.ok) return next({ status: 409, message: result.message });
    res.json(result);
  });


  // Full picture for the admin screen: both environments, masked, plus
  // which one (if any) is currently active.
  router.get('/api/admin/mpesa/config', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, (req, res) => {
    res.json({
      sandbox: mpesa.getMaskedConfig('sandbox'),
      production: mpesa.getMaskedConfig('production'),
      activeEnvironment: mpesa.getActiveEnvironment(),
      sandboxStatus: mpesa.statusFor('sandbox'),
      productionStatus: mpesa.statusFor('production'),
    });
  });

  router.get('/api/admin/mpesa/setup-guide', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, (req, res) => {
    res.json({
      title: 'How to get your M-Pesa (Safaricom Daraja) credentials',
      steps: [
        'Go to https://developer.safaricom.co.ke and create a free account (or log in if you already have one).',
        'Click "Create App" — this gives you a Sandbox app automatically, with a Consumer Key and Consumer Secret. Use these for the Sandbox fields below to test safely with fake money first.',
        'In the same app, note your test Shortcode (usually 174379 for Sandbox) and Passkey — Safaricom publishes the Sandbox passkey on the Daraja documentation page for the "Lipa na M-Pesa Online" (STK Push) product.',
        'For the Callback URL: this system will show you the exact URL to paste into Safaricom\'s portal once you save a Shortcode below — it will look like https://your-domain.example.com/api/mpesa/callback/sandbox (or /production).',
        'Test the Sandbox configuration using the "Test Connection" button below before touching Production — this makes a real request to Safaricom and tells you plainly whether the credentials work.',
        'When you are ready to go live: apply for Production (Go-Live) access for your app on the Daraja portal — Safaricom will review your app and issue Production credentials and your real Paybill/Till Shortcode.',
        'Enter the Production credentials in the Production section below, Test Connection, then use "Set Active Environment" to switch from Sandbox to Production — your Sandbox configuration stays saved and can be switched back to at any time.',
      ],
      note: 'Nothing you enter here is ever shown again in full — only the last 4 characters, so you can confirm you saved the right key without it being readable by anyone with screen access later.',
    });
  });

  router.put('/api/admin/mpesa/config/:environment', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, validEnv, (req, res, next) => {
    const { environment } = req.params;
    const { consumerKey, consumerSecret, shortcode, passkey, callbackUrl, initiatorName, securityCredential, b2cShortcode } = req.body;
    const result = mpesa.saveConfig(environment, { consumerKey, consumerSecret, shortcode, passkey, callbackUrl, initiatorName, securityCredential, b2cShortcode }, req.user.id);
    // Audit the CHANGE, never the VALUE — field names only.
    logAction(req, {
      action: 'Updated M-Pesa configuration', module: 'mpesa', recordType: 'MpesaConfig', recordId: environment,
      newValue: { fieldsChanged: result.changedFields, nowConfigured: result.configured, nowB2cConfigured: result.b2cConfigured },
    });
    res.json({ ok: true, config: mpesa.getMaskedConfig(environment) });
  });

  router.delete('/api/admin/mpesa/config/:environment', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, validEnv, (req, res) => {
    mpesa.clearConfig(req.params.environment);
    logAction(req, { action: 'Cleared M-Pesa configuration', module: 'mpesa', recordType: 'MpesaConfig', recordId: req.params.environment });
    res.json({ ok: true });
  });

  router.post('/api/admin/mpesa/set-active', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, (req, res, next) => {
    const { environment } = req.body;
    if (!VALID_ENVIRONMENTS.includes(environment)) return next({ status: 400, message: 'environment must be "sandbox" or "production"' });
    // Real, deliberate confirmation required to switch TO production —
    // never an accidental one-click activation of real-money transactions.
    // Checked only once we know it's genuinely configured (an unconfigured
    // environment is rejected on its own real terms below, not masked by
    // a confirmation prompt for something that can't be activated anyway).
    if (environment === 'production' && !mpesa.statusFor('production').includes('Not Configured') && req.body.confirmProduction !== true) {
      return next({ status: 400, message: 'Switching to Production enables real M-Pesa transactions. Resubmit with confirmProduction: true to proceed.', code: 'PRODUCTION_CONFIRMATION_REQUIRED' });
    }
    const before = mpesa.getActiveEnvironment();
    mpesa.setActiveEnvironment(environment);
    logAction(req, { action: 'Switched active M-Pesa environment', module: 'mpesa', recordType: 'MpesaConfig', recordId: environment, previousValue: before, newValue: environment });
    res.json({ ok: true, activeEnvironment: environment });
  });

  router.post('/api/admin/mpesa/test-connection/:environment', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, validEnv, async (req, res, next) => {
    try {
      const result = await mpesa.testConnection(req.params.environment, req.user.id);
      logAction(req, { action: 'Tested M-Pesa connection', module: 'mpesa', recordType: 'MpesaConfig', recordId: req.params.environment, newValue: result.status });
      res.json(result);
    } catch (e) { next(e); }
  });
}

module.exports = { register };
