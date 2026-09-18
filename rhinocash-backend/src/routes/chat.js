// chat.js — internal staff-to-staff direct messaging. requireAuth alone is
// enough here (no requireModule gate): every authenticated staff member can
// message every other, the same way any staff member can raise a support
// ticket. Investors never reach these routes at all — requireAuth only ever
// authenticates a row from `users` (see middleware.js), and investors are
// never rows in that table, so there is no separate exclusion check needed.
'use strict';
const { all, get, run } = require('./../db');
const { requireAuth } = require('./../middleware');
const crypto = require('node:crypto');

// Canonical ordering so the same pair of users always maps to the same
// conversation regardless of who started it — this is what the UNIQUE
// (user_a, user_b) constraint in the schema relies on.
function orderPair(a, b) { return a < b ? [a, b] : [b, a]; }

function register(router) {
  router.get('/api/chat/contacts', requireAuth, async (req, res) => {
    const rows = await all(
      `SELECT id, name, role_id, branch_id FROM users WHERE status = 'Active' AND id != ? ORDER BY name`,
      [req.user.id]
    );
    res.json({ contacts: rows });
  });

  router.get('/api/chat/conversations', requireAuth, async (req, res) => {
    const rows = await all(
      `SELECT c.id, c.created_at, c.last_message_at,
              (CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END) AS other_user_id,
              u.name AS other_name, u.role_id AS other_role_id, u.branch_id AS other_branch_id,
              (SELECT body FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender_id != ? AND m.read_at IS NULL) AS unread_count
         FROM chat_conversations c
         JOIN users u ON u.id = (CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END)
        WHERE c.user_a = ? OR c.user_b = ?
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
      [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]
    );
    res.json({
      conversations: rows.map(r => ({
        id: r.id,
        otherUserId: r.other_user_id,
        otherUserName: r.other_name,
        otherUserRole: r.other_role_id,
        otherUserBranch: r.other_branch_id,
        lastMessage: r.last_message,
        lastMessageAt: r.last_message_at,
        unreadCount: Number(r.unread_count) || 0,
      })),
    });
  });

  router.post('/api/chat/conversations', requireAuth, async (req, res, next) => {
    const targetId = req.body.userId;
    if (!targetId) return next({ status: 400, message: 'userId is required' });
    if (targetId === req.user.id) return next({ status: 400, message: 'You cannot start a conversation with yourself' });
    const target = await get(`SELECT id FROM users WHERE id = ? AND status = 'Active'`, [targetId]);
    if (!target) return next({ status: 404, message: 'That user was not found' });
    const [userA, userB] = orderPair(req.user.id, targetId);
    await run(
      `INSERT INTO chat_conversations (id, user_a, user_b) VALUES (?,?,?) ON CONFLICT (user_a, user_b) DO NOTHING`,
      ['conv_' + crypto.randomUUID(), userA, userB]
    );
    const conv = await get(`SELECT * FROM chat_conversations WHERE user_a = ? AND user_b = ?`, [userA, userB]);
    res.status(201).json({ conversation: { id: conv.id, otherUserId: targetId } });
  });

  async function assertParticipant(req, next, conversationId) {
    const conv = await get('SELECT * FROM chat_conversations WHERE id = ?', [conversationId]);
    if (!conv) { next({ status: 404, message: 'Conversation not found' }); return null; }
    if (conv.user_a !== req.user.id && conv.user_b !== req.user.id) {
      next({ status: 403, message: 'This conversation does not belong to you' });
      return null;
    }
    return conv;
  }

  router.get('/api/chat/conversations/:id/messages', requireAuth, async (req, res, next) => {
    const conv = await assertParticipant(req, next, req.params.id);
    if (!conv) return;
    const rows = await all(
      'SELECT id, sender_id, body, created_at, read_at FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200',
      [req.params.id]
    );
    res.json({ messages: rows });
  });

  router.post('/api/chat/conversations/:id/messages', requireAuth, async (req, res, next) => {
    const conv = await assertParticipant(req, next, req.params.id);
    if (!conv) return;
    const body = (req.body.body || '').trim();
    if (!body) return next({ status: 400, message: 'Message body is required' });
    if (body.length > 4000) return next({ status: 400, message: 'Message is too long (4000 characters max)' });
    const id = 'msg_' + crypto.randomUUID();
    await run('INSERT INTO chat_messages (id, conversation_id, sender_id, body) VALUES (?,?,?,?)', [id, req.params.id, req.user.id, body]);
    await run('UPDATE chat_conversations SET last_message_at = iso_now() WHERE id = ?', [req.params.id]);
    const message = await get('SELECT id, sender_id, body, created_at, read_at FROM chat_messages WHERE id = ?', [id]);
    res.status(201).json({ message });
  });

  router.post('/api/chat/conversations/:id/read', requireAuth, async (req, res, next) => {
    const conv = await assertParticipant(req, next, req.params.id);
    if (!conv) return;
    await run(
      'UPDATE chat_messages SET read_at = iso_now() WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  });
}

module.exports = { register };
