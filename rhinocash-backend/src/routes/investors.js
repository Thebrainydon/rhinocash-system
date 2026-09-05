'use strict';
const { all, get, run, transaction } = require('./../db');
const { hashPassword, verifyPassword, signToken, tokenHash } = require('./../crypto');
const { requireAuth, requirePermission } = require('./../middleware');
const { logAction } = require('./../audit');
const { hasPermission } = require('./../rbac');
const crypto = require('node:crypto');

// Investors are a separate principal type from staff `users` — they never
// get a role/module/permission row, so they structurally cannot reach any
// internal endpoint above. Their own routes are hand-scoped to `req.investor.id`
// only, which is what actually prevents Investor A from ever seeing
// Investor B's data (not just a frontend filter).
function requireInvestorAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next({ status: 401, message: 'Not authenticated' });
  const { verifyToken, tokenHash } = require('./../crypto');
  const payload = verifyToken(token);
  if (!payload || payload.type !== 'investor') return next({ status: 401, message: 'Invalid session' });
  const session = get('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash(token)]);
  if (!session || session.revoked_at) return next({ status: 401, message: 'Session has been revoked' });
  if (new Date(session.expires_at).getTime() < Date.now()) return next({ status: 401, message: 'Session expired' });
  const investor = get('SELECT * FROM investors WHERE id = ?', [payload.sub]);
  if (!investor) return next({ status: 401, message: 'Investor not found' });
  req.investor = investor;
  req.sessionTokenHash = session.token_hash;
  next();
}

function monthKey(d) { return String(d).slice(0, 7); }

function register(router) {
  router.post('/api/investor-auth/login', (req, res, next) => {
    const { email, password } = req.body;
    const investor = get('SELECT * FROM investors WHERE email = ?', [String(email || '').toLowerCase()]);
    if (!investor || !investor.password_hash || !verifyPassword(password || '', investor.password_hash, investor.password_salt)) {
      return next({ status: 401, message: 'Invalid credentials' });
    }
    const token = signToken({ sub: investor.id, type: 'investor', iat: Date.now(), exp: Date.now() + 12 * 60 * 60 * 1000 });
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', [tokenHash(token), investor.id, expiresAt]);
    const sysRow = get("SELECT session_warning_minutes FROM system_settings WHERE id = 1");
    res.json({ token, investor: { id: investor.id, name: investor.name, amount: investor.amount, profitSharePct: investor.profit_share_pct }, expiresAt, sessionWarningMinutes: sysRow ? sysRow.session_warning_minutes : 5 });
  });

  // Real investor logout — investors are a structurally separate
  // principal type (see requireInvestorAuth above), so they were never
  // able to use the staff-only POST /api/auth/logout at all. Without
  // this, an investor's "logout" only ever cleared their browser-side
  // token; the real session row in the database stayed valid forever.
  router.post('/api/investor-auth/logout', requireInvestorAuth, (req, res) => {
    run("UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?", [req.sessionTokenHash]);
    res.json({ ok: true });
  });

  router.get('/api/investor/me', requireInvestorAuth, (req, res) => {
    const inv = req.investor;
    res.json({
      id: inv.id, name: inv.name, amount: inv.amount, profitSharePct: inv.profit_share_pct,
      termMonths: inv.term_months, startDate: inv.start_date, status: inv.status,
    });
  });

  // Only ever queries WHERE investor_id = req.investor.id — structurally cannot leak.
  router.get('/api/investor/payouts', requireInvestorAuth, (req, res) => {
    res.json({ payouts: all('SELECT * FROM investor_payouts WHERE investor_id = ? ORDER BY period', [req.investor.id]) });
  });

  // Company performance — the explicitly-authorized aggregate view only,
  // never a query that could touch a specific client/staff row.
  router.get('/api/investor/company-performance', requireInvestorAuth, (req, res) => {
    const activeClients = get(`SELECT COUNT(DISTINCT client_id) as n FROM loans WHERE status IN ('Active','Disbursed')`).n;
    const portfolio = get(`SELECT COALESCE(SUM(total_due-paid_amount),0) as v FROM loan_schedule ls JOIN loans l ON l.id = ls.loan_id WHERE l.status IN ('Active','Disbursed')`).v;
    const interestIncome = get(`SELECT COALESCE(SUM(credit),0) as v FROM journal_entries WHERE ref_type = 'payment'`).v;
    res.json({ activeClients, outstandingPortfolio: portfolio, allTimeInterestIncome: interestIncome });
  });

  // ---- Staff-side investor management ----
  // Both Admin/CEO/Director (manage_users) AND Accountant (real accounting
  // authority over payouts, via post_accounting_entries) need real
  // visibility here — the old manage_users-only gate meant an Accountant
  // could post a payout for an investor ID they could never actually list.
  function requireInvestorManagementAuth(req, res, next) {
    if (hasPermission(req.user, 'manage_users') || hasPermission(req.user, 'post_accounting_entries')) return next();
    return next({ status: 403, message: 'Your role does not have investor management or investor accounting authority' });
  }
  router.get('/api/investors', requireAuth, requireInvestorManagementAuth, (req, res) => {
    const clauses = ['1=1']; const params = [];
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    if (req.query.q) { clauses.push('(name LIKE ? OR email LIKE ?)'); const like = `%${req.query.q}%`; params.push(like, like); }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const total = get(`SELECT COUNT(*) as c FROM investors WHERE ${clauses.join(' AND ')}`, params).c;
    const rows = all(
      `SELECT id, name, email, phone, amount, profit_share_pct, term_months, start_date, status, created_at FROM investors WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({ investors: rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  });

  // Real single-investor profile — investment terms (the real "agreement"
  // fields already on the record) + real payout history, not a fake
  // separate agreements/document entity.
  router.get('/api/investors/:id', requireAuth, requireInvestorManagementAuth, (req, res, next) => {
    const investor = get('SELECT id, name, email, phone, amount, profit_share_pct, term_months, start_date, status, created_at FROM investors WHERE id = ?', [req.params.id]);
    if (!investor) return next({ status: 404, message: 'Investor not found' });
    const payouts = all('SELECT * FROM investor_payouts WHERE investor_id = ? ORDER BY period DESC', [req.params.id]);
    const totalPaid = payouts.filter(p => p.status === 'Paid').reduce((s, p) => s + p.investor_profit, 0);
    const totalPending = payouts.filter(p => p.status === 'Pending').reduce((s, p) => s + p.investor_profit, 0);
    const maturityDate = new Date(investor.start_date);
    maturityDate.setMonth(maturityDate.getMonth() + investor.term_months);
    res.json({ investor, payouts, totalPaid, totalPending, maturityDate: maturityDate.toISOString().slice(0, 10) });
  });

  router.patch('/api/investors/:id', requireAuth, requirePermission('manage_users'), (req, res, next) => {
    const investor = get('SELECT * FROM investors WHERE id = ?', [req.params.id]);
    if (!investor) return next({ status: 404, message: 'Investor not found' });
    const allowed = ['phone', 'email', 'status'];
    if (req.body.status && !['Active', 'Completed'].includes(req.body.status)) return next({ status: 400, message: 'status must be Active or Completed' });
    const sets = []; const params = [];
    allowed.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); } });
    if (!sets.length) return next({ status: 400, message: 'Nothing to update' });
    params.push(req.params.id);
    run(`UPDATE investors SET ${sets.join(', ')} WHERE id = ?`, params);
    logAction(req, { action: 'Updated investor', module: 'investors', recordType: 'Investor', recordId: req.params.id, previousValue: { status: investor.status }, newValue: req.body });
    res.json({ investor: get('SELECT id, name, email, phone, amount, profit_share_pct, term_months, start_date, status, created_at FROM investors WHERE id = ?', [req.params.id]) });
  });

  // Real, company-wide payout ledger — every investor, every period —
  // for Accountant/Admin/CEO/Director. Reuses the same investor_payouts
  // rows the investor's own /api/investor/payouts reads, just unscoped.
  router.get('/api/investor-payouts', requireAuth, requireInvestorManagementAuth, (req, res) => {
    const clauses = ['1=1']; const params = [];
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    if (req.query.investor_id) { clauses.push('investor_id = ?'); params.push(req.query.investor_id); }
    const rows = all(`SELECT * FROM investor_payouts WHERE ${clauses.join(' AND ')} ORDER BY period DESC LIMIT 200`, params);
    res.json({ payouts: rows });
  });

  // Real aggregate obligations — total capital, pending payout
  // obligations, upcoming maturities — for CEO/Director/Accountant
  // executive-level visibility. All figures derived from the same real
  // rows above, nothing independently invented.
  router.get('/api/investors/obligations/summary', requireAuth, requireInvestorManagementAuth, (req, res) => {
    const investors = all('SELECT * FROM investors');
    const totalCapital = investors.reduce((s, i) => s + i.amount, 0);
    const activeCapital = investors.filter(i => i.status === 'Active').reduce((s, i) => s + i.amount, 0);
    const pendingPayouts = get(`SELECT COALESCE(SUM(investor_profit),0) as v FROM investor_payouts WHERE status = 'Pending'`).v;
    const paidPayouts = get(`SELECT COALESCE(SUM(investor_profit),0) as v FROM investor_payouts WHERE status = 'Paid'`).v;
    const today = new Date();
    const upcomingMaturities = investors.filter(i => i.status === 'Active').map(i => {
      const m = new Date(i.start_date); m.setMonth(m.getMonth() + i.term_months);
      return { investorId: i.id, investorName: i.name, maturityDate: m.toISOString().slice(0, 10), amount: i.amount, daysUntil: Math.round((m - today) / 86400000) };
    }).filter(m => m.daysUntil >= 0 && m.daysUntil <= 90).sort((a, b) => a.daysUntil - b.daysUntil);
    res.json({ totalCapital, activeCapital, totalInvestors: investors.length, activeInvestors: investors.filter(i => i.status === 'Active').length, pendingPayouts, paidPayouts, upcomingMaturities });
  });

  router.post('/api/investors', requireAuth, requirePermission('manage_users'), (req, res, next) => {
    const b = req.body;
    if (!b.name || !b.amount || !b.profit_share_pct) return next({ status: 400, message: 'name, amount and profit_share_pct are required' });
    const id = 'inv_' + crypto.randomUUID();
    const creds = b.email && b.password ? hashPassword(b.password) : { hash: null, salt: null };
    run(
      `INSERT INTO investors (id, name, email, phone, password_hash, password_salt, amount, profit_share_pct, term_months, start_date, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,'Active',?)`,
      [id, b.name, b.email || null, b.phone || null, creds.hash, creds.salt, b.amount, b.profit_share_pct, b.term_months || 6, b.start_date || new Date().toISOString().slice(0, 10), req.user.id]
    );
    logAction(req, { action: 'Created investor', module: 'investors', recordType: 'Investor', recordId: id, newValue: { name: b.name, amount: b.amount } });
    res.status(201).json({ investor: get('SELECT * FROM investors WHERE id = ?', [id]) });
  });
  // Generate/refresh a monthly payout row from the REAL P&L for that period — never invented.
  router.post('/api/investors/:id/generate-payout', requireAuth, requirePermission('post_accounting_entries'), (req, res, next) => {
    const investor = get('SELECT * FROM investors WHERE id = ?', [req.params.id]);
    if (!investor) return next({ status: 404, message: 'Investor not found' });
    const period = req.body.period || monthKey(new Date().toISOString());
    const interestIncome = get(
      `SELECT COALESCE(SUM(credit),0) as v FROM journal_entries WHERE ref_type='payment' AND strftime('%Y-%m', entry_date) = ?`, [period]
    ).v;
    const expenses = get(
      `SELECT COALESCE(SUM(debit),0) as v FROM journal_entries WHERE ref_type='expense' AND strftime('%Y-%m', entry_date) = ?`, [period]
    ).v;
    const netProfit = interestIncome - expenses;
    const investorProfit = Math.max(0, netProfit) * (investor.profit_share_pct / 100);
    const id = 'payout_' + crypto.randomUUID();
    run(
      `INSERT INTO investor_payouts (id, investor_id, period, company_net_profit, investor_profit, status)
       VALUES (?,?,?,?,?,'Pending')`,
      [id, investor.id, period, netProfit, investorProfit]
    );
    logAction(req, { action: 'Generated investor payout', module: 'investors', recordType: 'Investor', recordId: investor.id, newValue: { period, netProfit, investorProfit } });
    res.status(201).json({ payout: get('SELECT * FROM investor_payouts WHERE id = ?', [id]) });
  });
  router.post('/api/investor-payouts/:id/mark-paid', requireAuth, requirePermission('post_accounting_entries'), (req, res, next) => {
    const payout = get('SELECT * FROM investor_payouts WHERE id = ?', [req.params.id]);
    if (!payout) return next({ status: 404, message: 'Payout not found' });
    if (payout.status === 'Paid') return next({ status: 409, message: 'This payout has already been marked paid — no duplicate accounting entry' });
    const { assertPeriodOpen } = require('./accounting');
    assertPeriodOpen();
    const reference = 'REF' + Math.floor(Math.random() * 900000 + 100000);
    // Real transaction boundary — exactly the audit's named scenario:
    // "Investor payout marked Paid + journal missing."
    transaction(() => {
      run('UPDATE investor_payouts SET status = ?, reference = ?, paid_at = datetime(\'now\') WHERE id = ?',
        ['Paid', reference, payout.id]);
      // This was previously missing entirely: marking a payout "Paid" never
      // touched the real ledger at all, so the real cash outflow never
      // appeared in the General Ledger, Trial Balance, or Cashflow — the
      // payout record and the accounting records silently disagreed.
      // Simplified treatment (documented, matching this system's other
      // "simplified for demonstration" accounting choices): investor profit
      // share is treated as an operating expense, paid from bank.
      if (payout.investor_profit > 0) {
        run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, posted_by) VALUES ('operating_expense', ?, 0, ?, 'investor_payout', ?, ?)`,
          [payout.investor_profit, `Investor payout — ${payout.investor_id} (${payout.period})`, payout.id, req.user.id]);
        run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, posted_by) VALUES ('bank', 0, ?, ?, 'investor_payout', ?, ?)`,
          [payout.investor_profit, `Investor payout — ${payout.investor_id} (${payout.period})`, payout.id, req.user.id]);
      }
    });
    logAction(req, { action: 'Marked investor payout paid', module: 'investors', recordType: 'Investor', recordId: payout.investor_id, newValue: { amount: payout.investor_profit, reference } });
    res.json({ payout: get('SELECT * FROM investor_payouts WHERE id = ?', [payout.id]) });
  });
}

module.exports = { register, requireInvestorAuth };
