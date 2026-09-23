// mpesaAdmin.js — Admin-only M-Pesa configuration endpoints. Every route
// here is reachable ONLY by role_id === 'admin', deliberately not even
// CEO/Director (who hold manage_users but not system-credential
// authority) — this is squarely "Master System Administrator" territory,
// same principle as password-reset/session-revocation in users.js.
'use strict';
const { requireAuth, requirePermission, requireModule } = require('./../middleware');
const { logAction } = require('./../audit');
const { branchScopeSQL, hasModuleAccess, hasPermission } = require('./../rbac');
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
async function requireMpesaViewAuth(req, res, next) {
  if ((await hasModuleAccess(req.user, 'payments')) || (await hasModuleAccess(req.user, 'accounting'))) return next();
  return next({ status: 403, message: 'Your role does not have M-Pesa operational visibility' });
}

// Manually matching an unmatched C2B payment to a loan was Admin/Accountant
// only (post_accounting_entries). A Manager resolving a mis-typed account
// reference for their own branch's payment is a distinct, narrower real
// need — deliberately checked here rather than granting Manager the
// broader post_accounting_entries permission itself, which also gates
// unrelated accounting actions (expenses, adjustments, journal entries)
// a Manager should not gain as a side effect of this one real ask.
async function requireCanAssignC2bPayment(req, res, next) {
  if (req.user.role_id === 'manager') return next();
  if (await hasPermission(req.user, 'post_accounting_entries')) return next();
  return next({ status: 403, message: 'Your role cannot assign M-Pesa payments to a loan' });
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
  router.get('/api/mpesa/status', requireAuth, requireMpesaViewAuth, async (req, res) => {
    const activeEnv = await mpesa.getActiveEnvironment();
    const activeConfig = activeEnv ? await mpesa.getMaskedConfig(activeEnv) : null;
    res.json({
      activeEnvironment: activeEnv,
      configured: await mpesa.isConfigured(),
      sandboxStatus: await mpesa.statusFor('sandbox'),
      productionStatus: await mpesa.statusFor('production'),
      b2cConfigured: activeConfig ? activeConfig.b2cConfigured : false,
      // No secrets, no masked-key material — just real, safe operational facts.
    });
  });

  // Real B2C requests list, branch-scoped via the real loan each request belongs to.
  router.get('/api/mpesa/b2c/requests', requireAuth, requireMpesaViewAuth, async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = '1=1'; const params = [];
    if (req.query.status) { clause += ' AND b.status = ?'; params.push(req.query.status); }
    const rows = await all(
      `SELECT b.* FROM mpesa_b2c_requests b JOIN loans l ON l.id = b.loan_id
       WHERE ${clause} AND l.id IN (SELECT id FROM loans WHERE ${scope.clause})
       ORDER BY b.created_at DESC LIMIT 200`,
      params.concat(scope.params)
    );
    res.json({ requests: rows });
  });

  router.get('/api/mpesa/transactions', requireAuth, requireMpesaViewAuth, async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    // Real transactions are the real callbacks — joined against real loans
    // for branch scope, since the callback row itself carries no branch.
    let clause = '1=1'; const params = [];
    if (req.query.status) {
      if (req.query.status === 'Success') { clause += " AND CAST(c.result_code AS REAL) = 0"; }
      else if (req.query.status === 'Failed') { clause += " AND CAST(c.result_code AS REAL) != 0"; }
      else if (req.query.status === 'Unprocessed') { clause += ' AND c.processed = 0'; }
    }
    const rows = await all(
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
  router.get('/api/mpesa/transactions/:id', requireAuth, requireMpesaViewAuth, async (req, res, next) => {
    const { get } = require('./../db');
    const cb = await get('SELECT * FROM mpesa_callbacks WHERE id = ?', [req.params.id]);
    if (!cb) return next({ status: 404, message: 'Transaction not found' });
    const stkRequest = await get('SELECT * FROM mpesa_stk_requests WHERE checkout_request_id = ?', [cb.checkout_request_id]);
    const payment = cb.payment_id ? await get('SELECT * FROM payments WHERE id = ?', [cb.payment_id]) : null;
    const journal = cb.payment_id ? await all(`SELECT * FROM journal_entries WHERE ref_type = 'payment' AND ref_id = ?`, [cb.payment_id]) : [];
    const loan = cb.loan_id ? await get('SELECT * FROM loans WHERE id = ?', [cb.loan_id]) : null;
    const client = loan ? await get('SELECT id, name, phone FROM clients WHERE id = ?', [loan.client_id]) : null;
    res.json({ callback: cb, stkRequest, payment, journal, loan, client });
  });

  // Real reconciliation summary — Matched/Unmatched/Pending/Exception
  // counts across BOTH STK callbacks and C2B transactions, the two real
  // sources of M-Pesa money in this system. "Duplicate" is not a real
  // category here because recordCallback()/recordC2bTransaction() never
  // let a second row for the same real Safaricom id exist in the first
  // place — reported honestly rather than inventing a count for a
  // category that structurally cannot occur.
  router.get('/api/mpesa/reconciliation/summary', requireAuth, requireMpesaViewAuth, async (req, res) => {
    const { get } = require('./../db');
    const stkMatched = await get(`SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as amt FROM mpesa_callbacks WHERE processed = 1 AND payment_id IS NOT NULL`);
    const stkException = await get(`SELECT COUNT(*) as c FROM mpesa_callbacks WHERE CAST(result_code AS REAL) != 0`);
    const stkUnmatched = await get(`SELECT COUNT(*) as c FROM mpesa_callbacks WHERE CAST(result_code AS REAL) = 0 AND (loan_id IS NULL OR processed = 0) AND payment_id IS NULL`);
    const c2bMatched = await get(`SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as amt FROM mpesa_c2b_transactions WHERE processed = 1 AND payment_id IS NOT NULL`);
    const c2bUnmatched = await get(`SELECT COUNT(*) as c FROM mpesa_c2b_transactions WHERE match_method = 'unmatched' AND processed = 0`);
    res.json({
      matched: { count: stkMatched.c + c2bMatched.c, amount: stkMatched.amt + c2bMatched.amt },
      unmatched: { count: stkUnmatched.c + c2bUnmatched.c },
      exception: { count: stkException.c },
      stk: { matched: stkMatched.c, unmatched: stkUnmatched.c, exception: stkException.c },
      c2b: { matched: c2bMatched.c, unmatched: c2bUnmatched.c },
    });
  });

  router.post('/api/mpesa/callbacks/:id/process', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const result = await mpesa.processCallback(req.params.id, req.user.id);
    if (!result.ok) return next({ status: 409, message: result.message });
    await logAction(req, { action: 'Manually processed M-Pesa callback', module: 'mpesa', recordType: 'MpesaCallback', recordId: req.params.id, newValue: { created: result.created, paymentId: result.paymentId } });
    res.json(result);
  });

  // ==================== C2B / Paybill — staff-facing review ====================
  router.get('/api/mpesa/c2b/unmatched', requireAuth, requirePermission('post_accounting_entries'), async (req, res) => {
    res.json({ transactions: await mpesa.unmatchedC2bTransactions() });
  });

  // Real, broader-visibility list (matched AND unmatched together) for the
  // topbar Payments icon — every C2B/Paybill transaction, searchable and
  // date-filterable, is what lets a wrongly-referenced payment ("wrong ID
  // used") actually be *seen* by whoever can then fix it, not just by the
  // Admin/Accountant-only reconciliation screen above.
  router.get('/api/mpesa/c2b/transactions', requireAuth, requireMpesaViewAuth, async (req, res) => {
    const { get } = require('./../db');
    const clauses = ['1=1']; const params = [];
    if (req.query.from) { clauses.push('(created_at)::date >= ?'); params.push(req.query.from); }
    if (req.query.to) { clauses.push('(created_at)::date <= ?'); params.push(req.query.to); }
    if (req.query.q) {
      clauses.push('(msisdn LIKE ? OR bill_ref_number LIKE ? OR trans_id LIKE ?)');
      const like = `%${req.query.q}%`; params.push(like, like, like);
    }
    const where = clauses.join(' AND ');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const totalsRow = await get(`SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as amt FROM mpesa_c2b_transactions WHERE ${where}`, params);
    const rows = await all(
      `SELECT * FROM mpesa_c2b_transactions WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );

    // Real client name, only for rows that are actually matched to a real loan.
    const loanIds = [...new Set(rows.filter(r => r.matched_loan_id).map(r => r.matched_loan_id))];
    const clientNameByLoanId = {};
    if (loanIds.length) {
      const lPh = loanIds.map(() => '?').join(',');
      const loans = await all(`SELECT id, client_id FROM loans WHERE id IN (${lPh})`, loanIds);
      const clientIds = [...new Set(loans.map(l => l.client_id))];
      const clientNameById = {};
      if (clientIds.length) {
        const cPh = clientIds.map(() => '?').join(',');
        (await all(`SELECT id, name FROM clients WHERE id IN (${cPh})`, clientIds)).forEach(c => { clientNameById[c.id] = c.name; });
      }
      loans.forEach(l => { clientNameByLoanId[l.id] = clientNameById[l.client_id]; });
    }

    const activeEnv = await mpesa.getActiveEnvironment();
    const activeConfig = activeEnv ? await mpesa.getMaskedConfig(activeEnv) : null;
    // Deliberately NOT scoped by the from/to filter above — this is what
    // backs the topbar badge, which should always mean "needing attention
    // right now", not "needing attention within whatever date range is
    // currently selected in the panel".
    const unmatchedRow = await get(`SELECT COUNT(*) as cnt FROM mpesa_c2b_transactions WHERE match_method = 'unmatched' AND processed = 0`);

    res.json({
      transactions: rows.map(r => ({
        id: r.id, transId: r.trans_id, amount: r.amount, phone: r.msisdn, accountRef: r.bill_ref_number,
        matched: !!r.matched_loan_id, matchedLoanId: r.matched_loan_id,
        clientName: r.matched_loan_id ? (clientNameByLoanId[r.matched_loan_id] || null) : null,
        createdAt: r.created_at,
      })),
      shortcode: activeConfig ? activeConfig.shortcode : null,
      pagination: { page, limit, total: totalsRow.cnt, totalPages: Math.max(1, Math.ceil(totalsRow.cnt / limit)) },
      totals: { count: totalsRow.cnt, amount: totalsRow.amt, unmatchedCount: unmatchedRow.cnt },
    });
  });

  // Real, per-day totals over a date range — backs the "Daily Paybill
  // Collection" calendar view. A lightweight GROUP BY rather than paging
  // through every individual transaction just to sum them client-side,
  // since a full month can genuinely exceed the /transactions endpoint's
  // own page-size ceiling.
  router.get('/api/mpesa/c2b/daily-summary', requireAuth, requireMpesaViewAuth, async (req, res) => {
    const clauses = ['1=1']; const params = [];
    if (req.query.from) { clauses.push('(created_at)::date >= ?'); params.push(req.query.from); }
    if (req.query.to) { clauses.push('(created_at)::date <= ?'); params.push(req.query.to); }
    const where = clauses.join(' AND ');
    const rows = await all(
      `SELECT (created_at)::date::text as day, COUNT(*) as cnt, COALESCE(SUM(amount),0) as amt
       FROM mpesa_c2b_transactions WHERE ${where} GROUP BY (created_at)::date ORDER BY day`,
      params
    );
    const activeEnv = await mpesa.getActiveEnvironment();
    const activeConfig = activeEnv ? await mpesa.getMaskedConfig(activeEnv) : null;
    res.json({
      days: rows.map(r => ({ date: r.day, count: r.cnt, amount: r.amt })),
      shortcode: activeConfig ? activeConfig.shortcode : null,
    });
  });

  // Manual match + post — resolving a real unmatched Paybill payment (most
  // often one where the client typed the wrong account reference) by
  // pointing it at the correct real loan, then posting it through the
  // exact same real bridge as an automatic match.
  router.post('/api/mpesa/c2b/:id/match', requireAuth, requireCanAssignC2bPayment, async (req, res, next) => {
    const { get, run } = require('./../db');
    const tx = await get('SELECT * FROM mpesa_c2b_transactions WHERE id = ?', [req.params.id]);
    if (!tx) return next({ status: 404, message: 'Transaction not found' });
    if (tx.processed) return next({ status: 409, message: 'Already processed' });
    if (!req.body.loan_id) return next({ status: 400, message: 'loan_id is required' });
    const loan = await get('SELECT * FROM loans WHERE id = ?', [req.body.loan_id]);
    if (!loan) return next({ status: 404, message: 'Loan not found' });
    await run(`UPDATE mpesa_c2b_transactions SET matched_loan_id = ?, match_method = 'manual' WHERE id = ?`, [loan.id, tx.id]);
    await logAction(req, { action: 'Manually matched M-Pesa C2B transaction', module: 'mpesa', recordType: 'MpesaC2b', recordId: tx.id, newValue: { loanId: loan.id } });
    const result = await mpesa.processC2bTransaction(tx.id, req.user.id);
    if (!result.ok) return next({ status: 409, message: result.message });
    res.json(result);
  });


  // Full picture for the admin screen: both environments, masked, plus
  // which one (if any) is currently active.
  router.get('/api/admin/mpesa/config', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, async (req, res) => {
    res.json({
      sandbox: await mpesa.getMaskedConfig('sandbox'),
      production: await mpesa.getMaskedConfig('production'),
      activeEnvironment: await mpesa.getActiveEnvironment(),
      sandboxStatus: await mpesa.statusFor('sandbox'),
      productionStatus: await mpesa.statusFor('production'),
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

  router.put('/api/admin/mpesa/config/:environment', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, validEnv, async (req, res, next) => {
    const { environment } = req.params;
    const { consumerKey, consumerSecret, shortcode, passkey, callbackUrl, initiatorName, securityCredential, b2cShortcode } = req.body;
    const result = await mpesa.saveConfig(environment, { consumerKey, consumerSecret, shortcode, passkey, callbackUrl, initiatorName, securityCredential, b2cShortcode }, req.user.id);
    // Audit the CHANGE, never the VALUE — field names only.
    await logAction(req, {
      action: 'Updated M-Pesa configuration', module: 'mpesa', recordType: 'MpesaConfig', recordId: environment,
      newValue: { fieldsChanged: result.changedFields, nowConfigured: result.configured, nowB2cConfigured: result.b2cConfigured },
    });
    res.json({ ok: true, config: await mpesa.getMaskedConfig(environment) });
  });

  router.delete('/api/admin/mpesa/config/:environment', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, validEnv, async (req, res) => {
    await mpesa.clearConfig(req.params.environment);
    await logAction(req, { action: 'Cleared M-Pesa configuration', module: 'mpesa', recordType: 'MpesaConfig', recordId: req.params.environment });
    res.json({ ok: true });
  });

  router.post('/api/admin/mpesa/set-active', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, async (req, res, next) => {
    const { environment } = req.body;
    if (!VALID_ENVIRONMENTS.includes(environment)) return next({ status: 400, message: 'environment must be "sandbox" or "production"' });
    // Real, deliberate confirmation required to switch TO production —
    // never an accidental one-click activation of real-money transactions.
    // Checked only once we know it's genuinely configured (an unconfigured
    // environment is rejected on its own real terms below, not masked by
    // a confirmation prompt for something that can't be activated anyway).
    const prodStatus = await mpesa.statusFor('production');
    if (environment === 'production' && !prodStatus.includes('Not Configured') && req.body.confirmProduction !== true) {
      return next({ status: 400, message: 'Switching to Production enables real M-Pesa transactions. Resubmit with confirmProduction: true to proceed.', code: 'PRODUCTION_CONFIRMATION_REQUIRED' });
    }
    const before = await mpesa.getActiveEnvironment();
    try {
      await mpesa.setActiveEnvironment(environment);
    } catch (e) { return next(e); }
    await logAction(req, { action: 'Switched active M-Pesa environment', module: 'mpesa', recordType: 'MpesaConfig', recordId: environment, previousValue: before, newValue: environment });
    res.json({ ok: true, activeEnvironment: environment });
  });

  router.post('/api/admin/mpesa/test-connection/:environment', requireAuth, requirePermission('manage_system_settings'), requireAdminRole, validEnv, async (req, res, next) => {
    try {
      const result = await mpesa.testConnection(req.params.environment, req.user.id);
      await logAction(req, { action: 'Tested M-Pesa connection', module: 'mpesa', recordType: 'MpesaConfig', recordId: req.params.environment, newValue: result.status });
      res.json(result);
    } catch (e) { next(e); }
  });
}

module.exports = { register };
