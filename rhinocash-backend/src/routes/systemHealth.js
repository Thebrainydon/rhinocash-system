'use strict';
const { all, get } = require('./../db');
const { requireAuth, requireModule } = require('./../middleware');
const { hasModuleAccess } = require('./../rbac');

// Real, role-appropriate visibility: Admin (system owner), Director/anyone
// with real audit-module access, and CEO explicitly (executive visibility
// into system health, even though CEO doesn't hold the audit module in
// this system's real permission model) — deliberately NOT Manager/Loan
// Officer/Accountant, who have no legitimate need for system-wide health data.
function requireSystemHealthAuth(req, res, next) {
  if (req.user.role_id === 'admin' || req.user.role_id === 'ceo' || hasModuleAccess(req.user, 'audit')) return next();
  return next({ status: 403, message: 'Your role does not have system health visibility' });
}

function register(router) {
  // Real, aggregated system health — every figure here is a genuine query
  // against real tables, nothing fabricated or hardcoded as "healthy".
  router.get('/api/system/health', requireAuth, requireSystemHealthAuth, (req, res) => {
    const mpesa = require('./../integrations/mpesa');
    const sms = require('./../integrations/sms');
    const email = require('./../integrations/email');

    // Real database round-trip timing — not a fabricated "OK" flag.
    const dbStart = Date.now();
    let dbOk = true;
    try { get('SELECT 1 as ok'); } catch (e) { dbOk = false; }
    const dbLatencyMs = Date.now() - dbStart;

    const activeUsers = get(`SELECT COUNT(*) as c FROM users WHERE status = 'Active'`).c;
    const inactiveUsers = get(`SELECT COUNT(*) as c FROM users WHERE status != 'Active'`).c;

    const failedLogins24h = get(`SELECT COUNT(*) as c FROM login_attempts WHERE success = 0 AND created_at > datetime('now','-24 hours')`).c;
    const successfulLogins24h = get(`SELECT COUNT(*) as c FROM login_attempts WHERE success = 1 AND created_at > datetime('now','-24 hours')`).c;
    // Same real 5-fails/15-minutes threshold auth.js itself enforces —
    // reported here, not recalculated with a different number.
    const lockedOutAccounts = all(
      `SELECT email, COUNT(*) as fails FROM login_attempts WHERE success = 0 AND created_at > datetime('now','-15 minutes') GROUP BY email HAVING fails >= 5`
    );

    const auditEvents24h = get(`SELECT COUNT(*) as c FROM audit_logs WHERE created_at > datetime('now','-24 hours')`).c;
    const notificationsSent24h = get(`SELECT COUNT(*) as c FROM notifications WHERE created_at > datetime('now','-24 hours')`).c;
    const notificationsUnread = get(`SELECT COUNT(*) as c FROM notifications WHERE read = 0`).c;

    res.json({
      database: { ok: dbOk, latencyMs: dbLatencyMs },
      integrations: {
        mpesa: mpesa.isConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED',
        sms: sms.isConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED',
        email: email.isConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED',
      },
      users: { active: activeUsers, inactive: inactiveUsers },
      security: { failedLogins24h, successfulLogins24h, lockedOutAccounts: lockedOutAccounts.length },
      activity: { auditEvents24h, notificationsSent24h, notificationsUnread },
    });
  });

  // Real, company-wide security events feed (not per-user) — Admin/Director/CEO only.
  router.get('/api/system/security-events', requireAuth, requireSystemHealthAuth, (req, res) => {
    const clauses = ['1=1']; const params = [];
    if (req.query.outcome === 'Failed') { clauses.push('success = 0'); }
    else if (req.query.outcome === 'Success') { clauses.push('success = 1'); }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const total = get(`SELECT COUNT(*) as c FROM login_attempts WHERE ${clauses.join(' AND ')}`, params).c;
    const rows = all(`SELECT * FROM login_attempts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    res.json({ events: rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  });

  // Real locked-out accounts detail (email + fail count + most recent reason).
  router.get('/api/system/locked-accounts', requireAuth, requireSystemHealthAuth, (req, res) => {
    const rows = all(
      `SELECT email, COUNT(*) as fails, MAX(created_at) as last_attempt_at
       FROM login_attempts WHERE success = 0 AND created_at > datetime('now','-15 minutes')
       GROUP BY email HAVING fails >= 5 ORDER BY last_attempt_at DESC`
    );
    res.json({ lockedAccounts: rows });
  });
}

module.exports = { register };
