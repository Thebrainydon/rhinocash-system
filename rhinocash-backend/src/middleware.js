// middleware.js — authentication (who are you?) and authorization
// (are you allowed to do this?) as composable route guards. This is the
// piece the spec calls out specifically: "Do NOT rely only on hiding
// sidebar items" — every one of these runs on the server, not the client.
'use strict';
const { get, run } = require('./db');
const { verifyToken, tokenHash } = require('./crypto');
const { hasModuleAccess, hasPermission, hasIntelligenceAccess, hasInvestorIntelligenceAccess } = require('./rbac');

function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next({ status: 401, message: 'Not authenticated' });
  const payload = verifyToken(token);
  if (!payload) return next({ status: 401, message: 'Invalid or expired session' });
  const session = await get('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash(token)]);
  if (!session || session.revoked_at) return next({ status: 401, message: 'Session has been revoked' });
  if (new Date(session.expires_at).getTime() < Date.now()) return next({ status: 401, message: 'Session expired' });
  // One real row, merged from Employee (users) + System Account
  // (user_accounts) — every existing req.user.X consumer across the rest
  // of the app keeps reading the exact same flat field names it always
  // has; account.status (not users.status) is the real login/session
  // gate now — an Employee's own employment status is a separate,
  // independent concept (see users.js / Employee ↔ User Account split).
  const user = await get(
    `SELECT u.*, ua.status AS account_status, ua.login_email, ua.last_login_at AS account_last_login_at
     FROM users u LEFT JOIN user_accounts ua ON ua.employee_id = u.id WHERE u.id = ?`,
    [payload.sub]
  );
  if (!user) return next({ status: 401, message: 'User no longer exists' });
  if (!user.account_status) return next({ status: 403, message: 'This employee has no System Account' });
  if (user.account_status !== 'Active') return next({ status: 403, message: `Account is ${user.account_status.toLowerCase()}` });
  req.user = user;
  req.sessionTokenHash = session.token_hash;
  // Backs the single-active-session login block (routes/auth.js) — a
  // session only counts as blocking a second login while it's genuinely
  // still being used, not merely un-expired. See that file's own comment.
  await run('UPDATE sessions SET last_seen_at = iso_now() WHERE token_hash = ?', [session.token_hash]);
  next();
}

function requireModule(moduleId) {
  return async (req, res, next) => {
    if (!(await hasModuleAccess(req.user, moduleId))) {
      const { logAction } = require('./audit');
      await logAction(req, { action: 'Blocked unauthorized module access', module: moduleId, recordType: 'Module', recordId: moduleId });
      return next({ status: 403, message: `You do not have access to the "${moduleId}" module` });
    }
    next();
  };
}

// For real, genuinely read-only aggregate endpoints that legitimately
// serve more than one module's audience (e.g. a client-count summary
// that both Clients-module staff AND Investor-only roles may safely see)
// — never used for a write action.
function requireAnyModule(...moduleIds) {
  return async (req, res, next) => {
    const checks = await Promise.all(moduleIds.map(m => hasModuleAccess(req.user, m)));
    if (!checks.some(Boolean)) {
      const { logAction } = require('./audit');
      await logAction(req, { action: 'Blocked unauthorized module access', module: moduleIds.join('|'), recordType: 'Module', recordId: moduleIds.join('|') });
      return next({ status: 403, message: `You do not have access to any of: ${moduleIds.join(', ')}` });
    }
    next();
  };
}

// Real, server-side protection for direct URL/API access to an
// Intelligence feature — the same chokepoint requireModule() is for
// ordinary sections, just at individual-submenu-item granularity. A
// custom role with no row in role_intelligence_access for this feature_id
// is blocked exactly like any of the 9 structural roles would be.
function requireIntelligenceFeature(featureId) {
  return async (req, res, next) => {
    if (!(await hasIntelligenceAccess(req.user, featureId))) {
      const { logAction } = require('./audit');
      await logAction(req, { action: 'Blocked unauthorized Intelligence feature access', module: 'intelligence', recordType: 'IntelligenceFeature', recordId: featureId });
      return next({ status: 403, message: `You do not have access to the "${featureId}" Intelligence feature` });
    }
    next();
  };
}

// Investor's counterpart to requireIntelligenceFeature — req.investor (set
// by requireInvestorAuth), not req.user, and checked against the small
// hardcoded INVESTOR_INTELLIGENCE_FEATURES list (see rbac.js) since
// Investor has no role_intelligence_access row to query.
function requireInvestorIntelligenceFeature(featureId) {
  return (req, res, next) => {
    if (!hasInvestorIntelligenceAccess(featureId)) {
      return next({ status: 403, message: `You do not have access to the "${featureId}" Intelligence feature` });
    }
    next();
  };
}

function requirePermission(permissionId) {
  return async (req, res, next) => {
    if (!(await hasPermission(req.user, permissionId))) {
      const { logAction } = require('./audit');
      await logAction(req, { action: 'Blocked unauthorized action', module: permissionId, recordType: 'Permission', recordId: permissionId });
      return next({ status: 403, message: `You do not have permission to "${permissionId}"` });
    }
    next();
  };
}

module.exports = { requireAuth, requireModule, requireAnyModule, requirePermission, requireIntelligenceFeature, requireInvestorIntelligenceFeature, extractToken };
