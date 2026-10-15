// audit.js — single, consistent place every route logs through. Prevents
// the "recalculated/duplicated in every page" problem the spec explicitly
// warns against, applied to logging instead of business math.
'use strict';
const { run } = require('./db');

async function logAction(req, { action, module, recordType, recordId, previousValue, newValue, reason }) {
  const user = req.user || null;
  // An investor is a structurally separate principal type with no row in
  // `users` — audit_logs.user_id is a real FK to users(id), so an
  // investor's id can never go there (it would violate the constraint,
  // not just be semantically wrong). Their real name/a readable role
  // marker still go in user_name/role_id so the trail correctly
  // attributes the action to them instead of silently falling back to
  // 'system', which every route calling logAction from a requireAuth
  // (staff) context is completely unaffected by.
  const investor = !user && req.investor ? req.investor : null;
  await run(
    `INSERT INTO audit_logs (user_id, user_name, role_id, action, module, record_type, record_id, previous_value, new_value, reason, ip, user_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      user ? user.id : null,
      user ? user.name : (investor ? investor.name : 'system'),
      user ? user.role_id : (investor ? 'investor' : null),
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
// extra (optional): what the notification is about and what to do —
//   relatedType/relatedId: the record (e.g. 'loan', 'ln_…')
//   link: where to open it, { label } (a sidebar item) or { section, subtab }
//   action: what the recipient is asked to do (e.g. 'approve'); such a
//   notification is marked done (markActed) when someone acts on the record.
async function notify(userId, type, title, message, extra = {}) {
  await run(
    'INSERT INTO notifications (user_id, type, title, message, read, related_type, related_id, link, action) VALUES (?,?,?,?,0,?,?,?,?)',
    [userId, type, title, message, extra.relatedType || null, extra.relatedId != null ? String(extra.relatedId) : null,
      extra.link ? JSON.stringify(extra.link) : null, extra.action || null]
  );
}
// Someone acted on a record: every notification still asking for an action
// on it records what was done, by whom and when.
async function markActed(relatedType, relatedId, actionTaken) {
  await run(`UPDATE notifications SET acted_at = iso_now(), action_taken = ? WHERE related_type = ? AND related_id = ? AND action IS NOT NULL AND acted_at IS NULL`,
    [String(actionTaken).slice(0, 200), relatedType, String(relatedId)]);
}

module.exports = { logAction, notify, markActed };
