// middleware.js — authentication (who are you?) and authorization
// (are you allowed to do this?) as composable route guards. This is the
// piece the spec calls out specifically: "Do NOT rely only on hiding
// sidebar items" — every one of these runs on the server, not the client.
'use strict';
const { get } = require('./db');
const { verifyToken, tokenHash } = require('./crypto');
const { hasModuleAccess, hasPermission } = require('./rbac');

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
  const user = await get('SELECT * FROM users WHERE id = ?', [payload.sub]);
  if (!user) return next({ status: 401, message: 'User no longer exists' });
  if (user.status !== 'Active') return next({ status: 403, message: `Account is ${user.status.toLowerCase()}` });
  req.user = user;
  req.sessionTokenHash = session.token_hash;
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

module.exports = { requireAuth, requireModule, requireAnyModule, requirePermission, extractToken };
