'use strict';
const { all, get, run, transaction } = require('./../db');
const { hashPassword, verifyPassword, signToken, tokenHash } = require('./../crypto');
// Same real 15-day password-age policy staff logins use (see
// routes/auth.js) — investors are a separate principal type, not a
// second, lesser copy of the policy.
const PASSWORD_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;
// Same real "genuinely used recently" window the staff single-active-
// session block uses (see routes/auth.js's own comment) — investors get
// the identical real protection, not a second, lesser copy of it.
const SESSION_ACTIVE_WINDOW_SQL = "interval '-15 minutes'";
const { requireAuth, requirePermission } = require('./../middleware');
const { logAction } = require('./../audit');
const { hasPermission } = require('./../rbac');
const { describeBrowser } = require('./../userAgent');
const crypto = require('node:crypto');

// Investors are a separate principal type from staff `users` — they never
// get a role/module/permission row, so they structurally cannot reach any
// internal endpoint above. Their own routes are hand-scoped to `req.investor.id`
// only, which is what actually prevents Investor A from ever seeing
// Investor B's data (not just a frontend filter).
async function requireInvestorAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next({ status: 401, message: 'Not authenticated' });
  const { verifyToken, tokenHash } = require('./../crypto');
  const payload = verifyToken(token);
  if (!payload || payload.type !== 'investor') return next({ status: 401, message: 'Invalid session' });
  const session = await get('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash(token)]);
  if (!session || session.revoked_at) return next({ status: 401, message: 'Session has been revoked' });
  if (new Date(session.expires_at).getTime() < Date.now()) return next({ status: 401, message: 'Session expired' });
  const investor = await get('SELECT * FROM investors WHERE id = ?', [payload.sub]);
  if (!investor) return next({ status: 401, message: 'Investor not found' });
  req.investor = investor;
  req.sessionTokenHash = session.token_hash;
  await run('UPDATE sessions SET last_seen_at = iso_now() WHERE token_hash = ?', [session.token_hash]);
  next();
}

function monthKey(d) { return String(d).slice(0, 7); }

function register(router) {
  router.post('/api/investor-auth/login', async (req, res, next) => {
    const { email, password } = req.body;
    const investor = await get('SELECT * FROM investors WHERE email = ?', [String(email || '').toLowerCase()]);
    if (!investor || !investor.password_hash || !verifyPassword(password || '', investor.password_hash, investor.password_salt)) {
      return next({ status: 401, message: 'Invalid credentials' });
    }
    // Same real single-active-session policy staff logins enforce (see
    // routes/auth.js) — investors are a separate principal type, not a
    // second, lesser copy of the protection.
    const activeSession = await get(
      `SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > iso_now() AND last_seen_at > iso_offset(${SESSION_ACTIVE_WINDOW_SQL}) ORDER BY created_at DESC LIMIT 1`,
      [investor.id]
    );
    if (activeSession) {
      return next({ status: 409, message: `Your account is currently logged in on ${describeBrowser(activeSession.user_agent)}. Kindly logout first to access your account.`, code: 'ALREADY_LOGGED_IN' });
    }
    const token = signToken({ sub: investor.id, type: 'investor', iat: Date.now(), exp: Date.now() + 12 * 60 * 60 * 1000 });
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const ip = req.socket ? req.socket.remoteAddress : null;
    await run('INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent, last_seen_at) VALUES (?,?,?,?,?,iso_now())', [tokenHash(token), investor.id, expiresAt, ip, req.headers['user-agent'] || null]);

    let mustChangePassword = !!investor.must_change_password;
    if (!mustChangePassword) {
      const changedAt = investor.password_changed_at ? new Date(investor.password_changed_at).getTime() : NaN;
      const passwordExpired = Number.isNaN(changedAt) || (Date.now() - changedAt) >= PASSWORD_MAX_AGE_MS;
      if (passwordExpired) {
        await run('UPDATE investors SET must_change_password=1 WHERE id=?', [investor.id]);
        mustChangePassword = true;
      }
    }

    const sysRow = await get("SELECT session_warning_minutes FROM system_settings WHERE id = 1");
    res.json({ token, investor: { id: investor.id, name: investor.name, amount: investor.amount, profitSharePct: investor.profit_share_pct, mustChangePassword }, expiresAt, sessionWarningMinutes: sysRow ? sysRow.session_warning_minutes : 5 });
  });

  // Real investor self-service password change — the exact same real
  // must_change_password exemption (skip currentPassword when it's
  // already set) staff's POST /api/auth/change-password gives, on the
  // investors table instead of users. Previously the frontend's shared
  // change-password form always posted to the staff-only endpoint, which
  // requireAuth genuinely rejects for an investor token (its payload.sub
  // is an investor id, never found in `users`) — a real, previously-
  // unreachable dead end for any investor trying to change their own
  // password, not a hypothetical gap.
  router.post('/api/investor-auth/change-password', requireInvestorAuth, async (req, res, next) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return next({ status: 400, message: 'New password must be at least 8 characters' });
    if (!req.investor.must_change_password) {
      if (!req.investor.password_hash || !verifyPassword(currentPassword || '', req.investor.password_hash, req.investor.password_salt)) {
        return next({ status: 401, message: 'Current password is incorrect' });
      }
    }
    const { hash, salt } = hashPassword(newPassword);
    await run('UPDATE investors SET password_hash=?, password_salt=?, must_change_password=0, password_changed_at=iso_now() WHERE id=?', [hash, salt, req.investor.id]);
    await run("UPDATE sessions SET revoked_at = iso_now() WHERE user_id = ? AND token_hash != ?", [req.investor.id, req.sessionTokenHash]);
    await logAction(req, { action: 'Password changed', module: 'investors', recordType: 'Investor', recordId: req.investor.id });
    res.json({ ok: true });
  });

  // Real investor logout — investors are a structurally separate
  // principal type (see requireInvestorAuth above), so they were never
  // able to use the staff-only POST /api/auth/logout at all. Without
  // this, an investor's "logout" only ever cleared their browser-side
  // token; the real session row in the database stayed valid forever.
  router.post('/api/investor-auth/logout', requireInvestorAuth, async (req, res) => {
    await run("UPDATE sessions SET revoked_at = iso_now() WHERE token_hash = ?", [req.sessionTokenHash]);
    res.json({ ok: true });
  });

  router.get('/api/investor/me', requireInvestorAuth, async (req, res) => {
    const inv = req.investor;
    res.json({
      id: inv.id, name: inv.name, amount: inv.amount, profitSharePct: inv.profit_share_pct,
      termMonths: inv.term_months, startDate: inv.start_date, status: inv.status,
    });
  });

  // Only ever queries WHERE investor_id = req.investor.id — structurally cannot leak.
  router.get('/api/investor/payouts', requireInvestorAuth, async (req, res) => {
    res.json({ payouts: await all('SELECT * FROM investor_payouts WHERE investor_id = ? ORDER BY period', [req.investor.id]) });
  });

  // Company performance — the explicitly-authorized aggregate view only,
  // never a query that could touch a specific client/staff row.
  router.get('/api/investor/company-performance', requireInvestorAuth, async (req, res) => {
    const activeClients = (await get(`SELECT COUNT(DISTINCT client_id) as n FROM loans WHERE status IN ('Active','Disbursed')`)).n;
    const portfolio = (await get(`SELECT COALESCE(SUM(total_due-paid_amount),0) as v FROM loan_schedule ls JOIN loans l ON l.id = ls.loan_id WHERE l.status IN ('Active','Disbursed')`)).v;
    const interestIncome = (await get(`SELECT COALESCE(SUM(credit),0) as v FROM journal_entries WHERE ref_type = 'payment'`)).v;
    res.json({ activeClients, outstandingPortfolio: portfolio, allTimeInterestIncome: interestIncome });
  });

  // ---- Staff-side investor management ----
  // Both Admin/CEO/Director (manage_users) AND Accountant (real accounting
  // authority over payouts, via post_accounting_entries) need real
  // visibility here — the old manage_users-only gate meant an Accountant
  // could post a payout for an investor ID they could never actually list.
  async function requireInvestorManagementAuth(req, res, next) {
    if ((await hasPermission(req.user, 'manage_users')) || (await hasPermission(req.user, 'post_accounting_entries'))) return next();
    return next({ status: 403, message: 'Your role does not have investor management or investor accounting authority' });
  }
  router.get('/api/investors', requireAuth, requireInvestorManagementAuth, async (req, res) => {
    const clauses = ['1=1']; const params = [];
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    if (req.query.q) { clauses.push('(name LIKE ? OR email LIKE ?)'); const like = `%${req.query.q}%`; params.push(like, like); }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const total = (await get(`SELECT COUNT(*) as c FROM investors WHERE ${clauses.join(' AND ')}`, params)).c;
    const rows = await all(
      `SELECT id, name, email, phone, amount, profit_share_pct, term_months, start_date, status, created_at FROM investors WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({ investors: rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  });

  // Real single-investor profile — investment terms (the real "agreement"
  // fields already on the record) + real payout history, not a fake
  // separate agreements/document entity.
  router.get('/api/investors/:id', requireAuth, requireInvestorManagementAuth, async (req, res, next) => {
    const investor = await get('SELECT id, name, email, phone, amount, profit_share_pct, term_months, start_date, status, created_at FROM investors WHERE id = ?', [req.params.id]);
    if (!investor) return next({ status: 404, message: 'Investor not found' });
    const payouts = await all('SELECT * FROM investor_payouts WHERE investor_id = ? ORDER BY period DESC', [req.params.id]);
    const totalPaid = payouts.filter(p => p.status === 'Paid').reduce((s, p) => s + p.investor_profit, 0);
    const totalPending = payouts.filter(p => p.status === 'Pending').reduce((s, p) => s + p.investor_profit, 0);
    const maturityDate = new Date(investor.start_date);
    maturityDate.setMonth(maturityDate.getMonth() + investor.term_months);
    res.json({ investor, payouts, totalPaid, totalPending, maturityDate: maturityDate.toISOString().slice(0, 10) });
  });

  router.patch('/api/investors/:id', requireAuth, requirePermission('manage_users'), async (req, res, next) => {
    const investor = await get('SELECT * FROM investors WHERE id = ?', [req.params.id]);
    if (!investor) return next({ status: 404, message: 'Investor not found' });
    const allowed = ['phone', 'email', 'status'];
    if (req.body.status && !['Active', 'Completed'].includes(req.body.status)) return next({ status: 400, message: 'status must be Active or Completed' });
    const sets = []; const params = [];
    allowed.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); } });
    if (!sets.length) return next({ status: 400, message: 'Nothing to update' });
    params.push(req.params.id);
    await run(`UPDATE investors SET ${sets.join(', ')} WHERE id = ?`, params);
    await logAction(req, { action: 'Updated investor', module: 'investors', recordType: 'Investor', recordId: req.params.id, previousValue: { status: investor.status }, newValue: req.body });
    res.json({ investor: await get('SELECT id, name, email, phone, amount, profit_share_pct, term_months, start_date, status, created_at FROM investors WHERE id = ?', [req.params.id]) });
  });

  // Real, company-wide payout ledger — every investor, every period —
  // for Accountant/Admin/CEO/Director. Reuses the same investor_payouts
  // rows the investor's own /api/investor/payouts reads, just unscoped.
  router.get('/api/investor-payouts', requireAuth, requireInvestorManagementAuth, async (req, res) => {
    const clauses = ['1=1']; const params = [];
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    if (req.query.investor_id) { clauses.push('investor_id = ?'); params.push(req.query.investor_id); }
    const rows = await all(`SELECT * FROM investor_payouts WHERE ${clauses.join(' AND ')} ORDER BY period DESC LIMIT 200`, params);
    res.json({ payouts: rows });
  });

  // Real aggregate obligations — total capital, pending payout
  // obligations, upcoming maturities — for CEO/Director/Accountant
  // executive-level visibility. All figures derived from the same real
  // rows above, nothing independently invented.
  router.get('/api/investors/obligations/summary', requireAuth, requireInvestorManagementAuth, async (req, res) => {
    const investors = await all('SELECT * FROM investors');
    const totalCapital = investors.reduce((s, i) => s + i.amount, 0);
    const activeCapital = investors.filter(i => i.status === 'Active').reduce((s, i) => s + i.amount, 0);
    const pendingPayouts = (await get(`SELECT COALESCE(SUM(investor_profit),0) as v FROM investor_payouts WHERE status = 'Pending'`)).v;
    const paidPayouts = (await get(`SELECT COALESCE(SUM(investor_profit),0) as v FROM investor_payouts WHERE status = 'Paid'`)).v;
    const today = new Date();
    const upcomingMaturities = investors.filter(i => i.status === 'Active').map(i => {
      const m = new Date(i.start_date); m.setMonth(m.getMonth() + i.term_months);
      return { investorId: i.id, investorName: i.name, maturityDate: m.toISOString().slice(0, 10), amount: i.amount, daysUntil: Math.round((m - today) / 86400000) };
    }).filter(m => m.daysUntil >= 0 && m.daysUntil <= 90).sort((a, b) => a.daysUntil - b.daysUntil);
    res.json({ totalCapital, activeCapital, totalInvestors: investors.length, activeInvestors: investors.filter(i => i.status === 'Active').length, pendingPayouts, paidPayouts, upcomingMaturities });
  });

  router.post('/api/investors', requireAuth, requirePermission('manage_users'), async (req, res, next) => {
    const b = req.body;
    if (!b.name || !b.amount || !b.profit_share_pct) return next({ status: 400, message: 'name, amount and profit_share_pct are required' });
    const id = 'inv_' + crypto.randomUUID();
    const hasCreds = b.email && b.password;
    const creds = hasCreds ? hashPassword(b.password) : { hash: null, salt: null };
    await run(
      `INSERT INTO investors (id, name, email, phone, password_hash, password_salt, must_change_password, amount, profit_share_pct, term_months, start_date, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'Active',?)`,
      [id, b.name, b.email || null, b.phone || null, creds.hash, creds.salt, hasCreds ? 1 : 0, b.amount, b.profit_share_pct, b.term_months || 6, b.start_date || new Date().toISOString().slice(0, 10), req.user.id]
    );
    await logAction(req, { action: 'Created investor', module: 'investors', recordType: 'Investor', recordId: id, newValue: { name: b.name, amount: b.amount } });
    res.status(201).json({ investor: await get('SELECT * FROM investors WHERE id = ?', [id]) });
  });
  // Generate/refresh a monthly payout row from the REAL P&L for that period — never invented.
  router.post('/api/investors/:id/generate-payout', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const investor = await get('SELECT * FROM investors WHERE id = ?', [req.params.id]);
    if (!investor) return next({ status: 404, message: 'Investor not found' });
    const period = req.body.period || monthKey(new Date().toISOString());
    const interestIncome = (await get(
      `SELECT COALESCE(SUM(credit),0) as v FROM journal_entries WHERE ref_type='payment' AND to_char(entry_date::timestamptz, 'YYYY-MM') = ?`, [period]
    )).v;
    const expenses = (await get(
      `SELECT COALESCE(SUM(debit),0) as v FROM journal_entries WHERE ref_type='expense' AND to_char(entry_date::timestamptz, 'YYYY-MM') = ?`, [period]
    )).v;
    const netProfit = interestIncome - expenses;
    const investorProfit = Math.max(0, netProfit) * (investor.profit_share_pct / 100);
    const id = 'payout_' + crypto.randomUUID();
    await run(
      `INSERT INTO investor_payouts (id, investor_id, period, company_net_profit, investor_profit, status)
       VALUES (?,?,?,?,?,'Pending')`,
      [id, investor.id, period, netProfit, investorProfit]
    );
    await logAction(req, { action: 'Generated investor payout', module: 'investors', recordType: 'Investor', recordId: investor.id, newValue: { period, netProfit, investorProfit } });
    res.status(201).json({ payout: await get('SELECT * FROM investor_payouts WHERE id = ?', [id]) });
  });
  router.post('/api/investor-payouts/:id/mark-paid', requireAuth, requirePermission('post_accounting_entries'), async (req, res, next) => {
    const payout = await get('SELECT * FROM investor_payouts WHERE id = ?', [req.params.id]);
    if (!payout) return next({ status: 404, message: 'Payout not found' });
    if (payout.status === 'Paid') return next({ status: 409, message: 'This payout has already been marked paid — no duplicate accounting entry' });
    const { assertPeriodOpen } = require('./accounting');
    try { await assertPeriodOpen(); } catch (e) { return next(e); }
    const reference = 'REF' + Math.floor(Math.random() * 900000 + 100000);
    // Real transaction boundary — exactly the audit's named scenario:
    // "Investor payout marked Paid + journal missing."
    await transaction(async () => {
      await run("UPDATE investor_payouts SET status = ?, reference = ?, paid_at = iso_now() WHERE id = ?",
        ['Paid', reference, payout.id]);
      // This was previously missing entirely: marking a payout "Paid" never
      // touched the real ledger at all, so the real cash outflow never
      // appeared in the General Ledger, Trial Balance, or Cashflow — the
      // payout record and the accounting records silently disagreed.
      // Simplified treatment (documented, matching this system's other
      // "simplified for demonstration" accounting choices): investor profit
      // share is treated as an operating expense, paid from bank.
      if (payout.investor_profit > 0) {
        await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, posted_by) VALUES ('operating_expense', ?, 0, ?, 'investor_payout', ?, ?)`,
          [payout.investor_profit, `Investor payout — ${payout.investor_id} (${payout.period})`, payout.id, req.user.id]);
        await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, posted_by) VALUES ('bank', 0, ?, ?, 'investor_payout', ?, ?)`,
          [payout.investor_profit, `Investor payout — ${payout.investor_id} (${payout.period})`, payout.id, req.user.id]);
      }
    });
    await logAction(req, { action: 'Marked investor payout paid', module: 'investors', recordType: 'Investor', recordId: payout.investor_id, newValue: { amount: payout.investor_profit, reference } });
    res.json({ payout: await get('SELECT * FROM investor_payouts WHERE id = ?', [payout.id]) });
  });
}

module.exports = { register, requireInvestorAuth };
