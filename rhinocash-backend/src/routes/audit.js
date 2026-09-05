'use strict';
const { all } = require('./../db');
const { requireAuth, requireModule } = require('./../middleware');

function register(router) {
  router.get('/api/audit-logs', requireAuth, requireModule('audit'), (req, res) => {
    let clause = '1=1'; const params = [];
    if (req.query.entity) { clause += ' AND record_type = ?'; params.push(req.query.entity); }
    if (req.query.user_id) { clause += ' AND user_id = ?'; params.push(req.query.user_id); }
    if (req.query.module) { clause += ' AND module = ?'; params.push(req.query.module); }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const rows = all(`SELECT * FROM audit_logs WHERE ${clause} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    res.json({ auditLogs: rows });
  });
}

module.exports = { register };
