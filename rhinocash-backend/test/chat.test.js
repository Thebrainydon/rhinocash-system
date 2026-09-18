// chat.test.js — real internal staff-to-staff direct messaging: contacts
// list, get-or-create conversation (never duplicated), sending/receiving
// real messages, real unread counts, real read-receipts, and that a
// non-participant genuinely cannot read or act on someone else's
// conversation.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}
async function login(email, password) { const r = await api('POST', '/api/auth/login', { body: { email, password } }); return r.json && r.json.token; }

(async () => {
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const accountantToken = await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD);
  assert(officerToken && managerToken && accountantToken, 'all needed accounts log in');

  const officerMe = (await api('GET', '/api/auth/me', { token: officerToken })).json.user;
  const managerMe = (await api('GET', '/api/auth/me', { token: managerToken })).json.user;

  // =========================================================
  // 1. CONTACTS — every active staff member, never the caller themselves
  // =========================================================
  {
    const contacts = await api('GET', '/api/chat/contacts', { token: officerToken });
    assert(contacts.status === 200 && Array.isArray(contacts.json.contacts), 'a real contacts list comes back');
    assert(!contacts.json.contacts.some(c => c.id === officerMe.id), 'the caller never appears in their own contacts list');
    assert(contacts.json.contacts.some(c => c.id === managerMe.id), 'a real colleague (the Kisumu manager) genuinely appears in the contacts list');
  }

  // =========================================================
  // 2. GET-OR-CREATE CONVERSATION — never duplicated, symmetric for both sides
  // =========================================================
  let conversationId;
  {
    const unauth = await api('GET', '/api/chat/contacts');
    assert(unauth.status === 401, 'an unauthenticated request for the contacts list is genuinely rejected');

    const self = await api('POST', '/api/chat/conversations', { token: officerToken, body: { userId: officerMe.id } });
    assert(self.status === 400, 'a real attempt to start a conversation with yourself is genuinely rejected');

    const bogus = await api('POST', '/api/chat/conversations', { token: officerToken, body: { userId: 'not-a-real-user-id' } });
    assert(bogus.status === 404, 'starting a conversation with a nonexistent user id is genuinely rejected');

    const first = await api('POST', '/api/chat/conversations', { token: officerToken, body: { userId: managerMe.id } });
    assert(first.status === 201 && first.json.conversation.id, 'a real conversation is created between the officer and the manager');
    conversationId = first.json.conversation.id;

    const again = await api('POST', '/api/chat/conversations', { token: officerToken, body: { userId: managerMe.id } });
    assert(again.json.conversation.id === conversationId, 'starting a conversation with the same colleague again returns the SAME conversation, never a duplicate');

    const fromOtherSide = await api('POST', '/api/chat/conversations', { token: managerToken, body: { userId: officerMe.id } });
    assert(fromOtherSide.json.conversation.id === conversationId, 'the same conversation is returned from either side of the pair, regardless of who started it');
  }

  // =========================================================
  // 3. SENDING / RECEIVING REAL MESSAGES
  // =========================================================
  {
    const empty = await api('POST', `/api/chat/conversations/${conversationId}/messages`, { token: officerToken, body: { body: '   ' } });
    assert(empty.status === 400, 'a real empty (whitespace-only) message body is genuinely rejected');

    const sent = await api('POST', `/api/chat/conversations/${conversationId}/messages`, { token: officerToken, body: { body: 'Hi, do you have a moment to review the Otieno file?' } });
    assert(sent.status === 201 && sent.json.message.sender_id === officerMe.id, 'a real message is sent, correctly attributed to the real sender');

    const asManager = await api('GET', `/api/chat/conversations/${conversationId}/messages`, { token: managerToken });
    assert(asManager.status === 200 && asManager.json.messages.some(m => m.body.includes('Otieno file')), 'the real recipient genuinely receives the real message content');

    const asAccountant = await api('GET', `/api/chat/conversations/${conversationId}/messages`, { token: accountantToken });
    assert(asAccountant.status === 403, 'a real THIRD staff member who is not a participant genuinely cannot read this conversation');

    const readAttempt = await api('POST', `/api/chat/conversations/${conversationId}/read`, { token: accountantToken });
    assert(readAttempt.status === 403, 'a real non-participant genuinely cannot mark this conversation as read either');
  }

  // =========================================================
  // 4. REAL UNREAD COUNTS AND READ-RECEIPTS
  // =========================================================
  {
    const managerList = await api('GET', '/api/chat/conversations', { token: managerToken });
    const convForManager = managerList.json.conversations.find(c => c.id === conversationId);
    assert(!!convForManager && convForManager.unreadCount === 1 && convForManager.lastMessage.includes('Otieno file'), 'the real unread count and last-message preview are correct for the recipient before reading');

    const officerList = await api('GET', '/api/chat/conversations', { token: officerToken });
    const convForOfficer = officerList.json.conversations.find(c => c.id === conversationId);
    assert(!!convForOfficer && convForOfficer.unreadCount === 0, 'the real sender never sees their own message counted as unread');
    assert(convForOfficer.otherUserName === managerMe.name, 'the conversation list correctly names the real other participant, not the caller');

    await api('POST', `/api/chat/conversations/${conversationId}/read`, { token: managerToken });
    const afterRead = await api('GET', '/api/chat/conversations', { token: managerToken });
    const convAfterRead = afterRead.json.conversations.find(c => c.id === conversationId);
    assert(convAfterRead.unreadCount === 0, 'the real unread count genuinely drops to zero once the recipient marks the conversation read');

    const reply = await api('POST', `/api/chat/conversations/${conversationId}/messages`, { token: managerToken, body: { body: 'Yes, sending feedback shortly.' } });
    assert(reply.status === 201, 'the real recipient can reply in the same real conversation');
    const officerListAfterReply = await api('GET', '/api/chat/conversations', { token: officerToken });
    const convAfterReply = officerListAfterReply.json.conversations.find(c => c.id === conversationId);
    assert(convAfterReply.unreadCount === 1, 'the real reply now shows as unread for the original sender, symmetrically');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
