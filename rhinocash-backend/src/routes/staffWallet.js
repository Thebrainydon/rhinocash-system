// staffWallet.js — a staff member's own real wallet accounts
// (Transactional/Investment/Savings), reached from My Account -> View
// Details -> ACC BALANCES. Exactly the same design as the client wallet
// routes in clients.js (client_accounts/client_account_transactions/
// client_account_stk_requests), just scoped to the authenticated user
// instead of a client — every route here only ever reads/writes the
// caller's own accounts, never another staff member's.
'use strict';
const { requireAuth } = require('./../middleware');
const { logAction } = require('./../audit');
const { all, get, run } = require('./../db');
const crypto = require('node:crypto');

const STAFF_ACCOUNT_TYPES = ['Transactional', 'Investment', 'Savings'];
const STAFF_ACCOUNT_TYPE_CODE = { Transactional: '1', Investment: '2', Savings: '3' };

// Auto-provisions the 3 real accounts a staff member is entitled to, the
// first time any of them is requested — never fabricated, just created
// once with a real generated account number and a real starting balance
// of 0, same as ensureClientAccounts in clients.js.
async function ensureStaffAccounts(userId) {
  for (const type of STAFF_ACCOUNT_TYPES) {
    const existing = await get('SELECT id FROM staff_accounts WHERE user_id = ? AND account_type = ?', [userId, type]);
    if (!existing) {
      const seq = (await get('SELECT COUNT(*) as n FROM staff_accounts WHERE account_type = ?', [type])).n + 1;
      const accountNumber = '01' + STAFF_ACCOUNT_TYPE_CODE[type] + String(seq).padStart(8, '0');
      await run('INSERT INTO staff_accounts (id, user_id, account_type, account_number) VALUES (?,?,?,?)',
        ['sacc_' + crypto.randomUUID(), userId, type, accountNumber]);
    }
  }
  return all('SELECT * FROM staff_accounts WHERE user_id = ? ORDER BY account_type', [userId]);
}

function register(router) {
  router.get('/api/users/me/accounts', requireAuth, async (req, res) => {
    const accounts = await ensureStaffAccounts(req.user.id);
    const withWithdrawals = await Promise.all(accounts.map(async a => {
      const w = await get(`SELECT COALESCE(SUM(amount),0) as total FROM staff_account_transactions WHERE account_id = ? AND type = 'Withdrawal' AND approval_status = 'Completed'`, [a.id]);
      return { ...a, withdrawals_total: w.total };
    }));
    res.json({ accounts: withWithdrawals });
  });

  router.get('/api/users/me/accounts/:type/transactions', requireAuth, async (req, res, next) => {
    if (!STAFF_ACCOUNT_TYPES.includes(req.params.type)) return next({ status: 400, message: 'Invalid account type' });
    const accounts = await ensureStaffAccounts(req.user.id);
    const account = accounts.find(a => a.account_type === req.params.type);
    const clauses = ['account_id = ?']; const params = [account.id];
    if (req.query.from) { clauses.push('(created_at)::date >= ?'); params.push(req.query.from); }
    if (req.query.to) { clauses.push('(created_at)::date <= ?'); params.push(req.query.to); }
    const rows = await all(`SELECT * FROM staff_account_transactions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params);
    res.json({ account, transactions: rows });
  });

  // Real STK Push initiation for a staff wallet deposit — money only ever
  // lands in the wallet once a real completed callback for this request is
  // processed, same real limitation the client wallet deposit path already
  // has (see mpesa.initiateStaffWalletStkPush's own notes).
  router.post('/api/users/me/accounts/:type/deposit', requireAuth, async (req, res, next) => {
    if (!STAFF_ACCOUNT_TYPES.includes(req.params.type)) return next({ status: 400, message: 'Invalid account type' });
    const { phone, amount } = req.body;
    if (!phone) return next({ status: 400, message: 'phone is required' });
    if (!(Number(amount) > 0)) return next({ status: 400, message: 'amount must be a positive number' });
    const accounts = await ensureStaffAccounts(req.user.id);
    const account = accounts.find(a => a.account_type === req.params.type);
    const mpesa = require('./../integrations/mpesa');
    const result = await mpesa.initiateStaffWalletStkPush({ accountId: account.id, accountNumber: account.account_number, phone, amount: Number(amount), initiatedBy: req.user.id });
    await logAction(req, { action: 'Requested staff wallet deposit STK push', module: 'staff', recordType: 'StaffAccount', recordId: account.id, newValue: { amount, phone, status: result.status } });
    res.json(result);
  });
}

module.exports = { register };
