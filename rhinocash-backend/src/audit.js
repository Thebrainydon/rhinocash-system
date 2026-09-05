// audit.js — single, consistent place every route logs through. Prevents
// the "recalculated/duplicated in every page" problem the spec explicitly
// warns against, applied to logging instead of business math.
'use strict';
const { run } = require('./db');

function logAction(req, { action, module, recordType, recordId, previousValue, newValue, reason }) {
  const user = req.user || null;
  run(
    `INSERT INTO audit_logs (user_id, user_name, role_id, action, module, record_type, record_id, previous_value, new_value, reason, ip, user_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      user ? user.id : null,
      user ? user.name : 'system',
      user ? user.role_id : null,
      action,
      module || null,
      recordType || null,
      recordId || null,
      previousValue != null ? JSON.stringify(previousValue) : null,
      newValue != null ? JSON.stringify(newValue) : null,
      reason || null,
      req.socket ? req.socket.remoteAddress : null,
      req.headers ? req.headers['user-agent'] || null : null,
    ]
  );
}

// Real in-app notifications, created at the business events that should
// actually produce one — this was a real gap (the notifications table
// and API existed but nothing ever inserted into it). `userId: null`
// means a broadcast notification visible to everyone (see misc.js's
// `user_id = ? OR user_id IS NULL` read query).
function notify(userId, type, title, message) {
  run(
    'INSERT INTO notifications (user_id, type, title, message, read) VALUES (?,?,?,?,0)',
    [userId, type, title, message]
  );
}

module.exports = { logAction, notify };
