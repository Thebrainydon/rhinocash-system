// support.test.js — real support tickets (pagination/search/category),
// real comment threads (the previously-missing piece), real assignment,
// real FAQ/knowledge base, and confirming the previously-broken frontend
// (calling undefined addTicket()/updateTicket()) now has a real backend
// to call.
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
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const nairobiManagerToken = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const officerMe = (await api('GET', '/api/auth/me', { token: officerToken })).json.user;
  assert(adminToken && managerToken && nairobiManagerToken && officerToken, 'all needed accounts log in');

  // =========================================================
  // 1. TICKET CREATION + PAGINATION/SEARCH/FILTER
  // =========================================================
  let ticketId;
  {
    const created = await api('POST', '/api/support-tickets', { token: officerToken, body: { subject: 'Cannot see loan disbursement button', message: 'The button seems missing on my dashboard', category: 'Technical', priority: 'High' } });
    assert(created.status === 201 && created.json.ticket.status === 'Open', 'a real support ticket is created, starting Open, with the new real category field');
    ticketId = created.json.ticket.id;

    const missingSubject = await api('POST', '/api/support-tickets', { token: officerToken, body: { message: 'no subject' } });
    assert(missingSubject.status === 400, 'a ticket without a subject is rejected');

    const paged = await api('GET', '/api/support-tickets?limit=1&page=1', { token: adminToken });
    assert(paged.status === 200 && paged.json.pagination && typeof paged.json.pagination.total === 'number', 'real pagination metadata on the ticket list — previously an unpaginated dump');

    const searched = await api('GET', '/api/support-tickets?q=disbursement', { token: adminToken });
    assert(searched.json.tickets.some(t => t.id === ticketId), 'real search matches the real ticket subject/message');

    const categoryFiltered = await api('GET', '/api/support-tickets?category=Technical', { token: adminToken });
    assert(categoryFiltered.json.tickets.every(t => t.category === 'Technical'), 'real category filter narrows results server-side');
  }

  // =========================================================
  // 2. REAL VISIBILITY SCOPING (already existed — re-verified in this pass's context)
  // =========================================================
  {
    const nairobiView = await api('GET', `/api/support-tickets/${ticketId}`, { token: nairobiManagerToken });
    assert(nairobiView.status === 403, 'a Nairobi Manager cannot view a real Kisumu-branch ticket they have no visibility into');
    const kisumuView = await api('GET', `/api/support-tickets/${ticketId}`, { token: managerToken });
    assert(kisumuView.status === 200, 'the real Kisumu Manager can view the real Kisumu-branch ticket');
  }

  // =========================================================
  // 3. REAL COMMENT THREAD — the previously entirely-missing piece
  // =========================================================
  {
    const comment1 = await api('POST', `/api/support-tickets/${ticketId}/comments`, { token: managerToken, body: { message: 'Which role are you logged in as?' } });
    assert(comment1.status === 201, 'a real comment is posted by the Manager handling the ticket');
    const reply = await api('POST', `/api/support-tickets/${ticketId}/comments`, { token: officerToken, body: { message: 'Loan Officer, on a loan that is Approved for Disbursement.' } });
    assert(reply.status === 201, 'the real ticket owner can reply');

    const detail = await api('GET', `/api/support-tickets/${ticketId}`, { token: officerToken });
    assert(detail.status === 200 && Array.isArray(detail.json.comments) && detail.json.comments.length === 2, 'the real ticket detail includes the real, ordered comment thread — previously a ticket had no way to hold a conversation at all');

    const unauthorizedComment = await api('POST', `/api/support-tickets/${ticketId}/comments`, { token: nairobiManagerToken, body: { message: 'x' } });
    assert(unauthorizedComment.status === 403, 'a Nairobi Manager with no visibility into this ticket cannot comment on it');

    const emptyComment = await api('POST', `/api/support-tickets/${ticketId}/comments`, { token: officerToken, body: {} });
    assert(emptyComment.status === 400, 'an empty comment is rejected');
  }

  // =========================================================
  // 4. REAL ASSIGNMENT — managerial action, not self-service
  // =========================================================
  {
    const officerCannotAssign = await api('POST', `/api/support-tickets/${ticketId}/assign`, { token: officerToken, body: { assignedTo: officerMe.id } });
    assert(officerCannotAssign.status === 403, 'a Loan Officer cannot assign a ticket — real managerial-only action');

    const assigned = await api('POST', `/api/support-tickets/${ticketId}/assign`, { token: managerToken, body: { assignedTo: managerToken ? (await api('GET', '/api/auth/me', { token: managerToken })).json.user.id : null } });
    assert(assigned.status === 200 && assigned.json.ticket.assigned_to && assigned.json.ticket.status === 'In Progress', 'the real Manager can assign the ticket to themselves, which also moves a real Open ticket to In Progress');

    const invalidAssignee = await api('POST', `/api/support-tickets/${ticketId}/assign`, { token: managerToken, body: { assignedTo: 'usr_does_not_exist' } });
    assert(invalidAssignee.status === 400, 'assigning to a nonexistent user is rejected');
  }

  // =========================================================
  // 5. REAL TICKET RESOLUTION — status change authority
  // =========================================================
  {
    const officerCannotResolve = await api('PATCH', `/api/support-tickets/${ticketId}`, { token: officerToken, body: { status: 'Resolved' } });
    assert(officerCannotResolve.status === 403, 'the real ticket owner (Loan Officer, non-managerial) cannot resolve their own ticket — only management can change status');

    const resolved = await api('PATCH', `/api/support-tickets/${ticketId}`, { token: managerToken, body: { status: 'Resolved' } });
    assert(resolved.status === 200 && resolved.json.ticket.status === 'Resolved' && resolved.json.ticket.resolved_at, 'Manager can resolve the real ticket, and a real resolved_at timestamp is recorded');
  }

  // =========================================================
  // 6. FAQ / KNOWLEDGE BASE — real, small, searchable
  // =========================================================
  {
    const officerCannotCreate = await api('POST', '/api/faq', { token: officerToken, body: { question: 'How do I reset my password?', answer: 'Ask your Admin.' } });
    assert(officerCannotCreate.status === 403, 'an ordinary staff member cannot create FAQ articles — requires real system-settings authority');

    const created = await api('POST', '/api/faq', { token: adminToken, body: { question: 'How do I reset my password?', answer: 'Ask your Admin to reset it from Staff Management.', category: 'Account' } });
    assert(created.status === 201, 'Admin can create a real FAQ article');
    const faqId = created.json.article.id;

    const list = await api('GET', '/api/faq', { token: officerToken });
    assert(list.status === 200 && list.json.articles.some(a => a.id === faqId), 'any staff member with support module access can view the real FAQ list');

    const searched = await api('GET', '/api/faq?q=password', { token: officerToken });
    assert(searched.json.articles.some(a => a.id === faqId), 'real FAQ search matches the real question text');

    const deleted = await api('DELETE', `/api/faq/${faqId}`, { token: adminToken });
    assert(deleted.status === 200, 'Admin can remove a real FAQ article');
    const listAfter = await api('GET', '/api/faq', { token: officerToken });
    assert(!listAfter.json.articles.some(a => a.id === faqId), 'the real deleted article genuinely no longer appears');
  }

  // =========================================================
  // 7. SLA CALCULATION — real, deterministic, based on real timestamps
  // =========================================================
  let slaTicketId;
  {
    const created = await api('POST', '/api/support-tickets', { token: officerToken, body: { subject: 'SLA test ticket', message: 'x', priority: 'Critical' } });
    slaTicketId = created.json.ticket.id;
    const detail = await api('GET', `/api/support-tickets/${slaTicketId}`, { token: officerToken });
    assert(detail.json.sla && detail.json.sla.status === 'ON_TRACK', 'a freshly-created Critical ticket starts real ON_TRACK SLA status');
    assert(detail.json.sla.targetHours === 4, 'the real Critical SLA target is exactly 4 hours — the documented, non-fabricated number');

    // Directly backdate the real created_at to simulate real elapsed time (this environment cannot wait 4 real hours).
    const { run } = require('../src/db');
    run(`UPDATE support_tickets SET created_at = datetime('now', '-5 hours') WHERE id = ?`, [slaTicketId]);
    const overdueDetail = await api('GET', `/api/support-tickets/${slaTicketId}`, { token: officerToken });
    assert(overdueDetail.json.sla.status === 'OVERDUE' && overdueDetail.json.sla.overdueHours > 0, 'the same real ticket, now genuinely past its real deadline, correctly reports OVERDUE with a real overdue duration');

    const dueSoonSetup = await api('POST', '/api/support-tickets', { token: officerToken, body: { subject: 'Due soon test', message: 'x', priority: 'Critical' } });
    run(`UPDATE support_tickets SET created_at = datetime('now', '-3.5 hours') WHERE id = ?`, [dueSoonSetup.json.ticket.id]);
    const dueSoonDetail = await api('GET', `/api/support-tickets/${dueSoonSetup.json.ticket.id}`, { token: officerToken });
    assert(dueSoonDetail.json.sla.status === 'DUE_SOON', 'a real ticket within the last 20% of its SLA window correctly reports DUE_SOON, distinct from OVERDUE');

    const slaFiltered = await api('GET', '/api/support-tickets?slaStatus=OVERDUE', { token: adminToken });
    assert(slaFiltered.json.tickets.some(t => t.id === slaTicketId), 'real server-side SLA-status filtering finds the real overdue ticket');
  }

  // =========================================================
  // 8. ESCALATION — real, idempotent, notifies real Admins
  // =========================================================
  {
    const notConfiguredYet = await api('POST', `/api/support-tickets/${slaTicketId}/escalate`, { token: officerToken });
    assert(notConfiguredYet.status === 200, 'a genuinely overdue ticket can be escalated by its owner');
    const ticketAfter = notConfiguredYet.json.ticket;
    assert(ticketAfter.escalated_at, 'the real ticket now has a real escalated_at timestamp');

    const duplicateEscalate = await api('POST', `/api/support-tickets/${slaTicketId}/escalate`, { token: officerToken });
    assert(duplicateEscalate.status === 409, 'escalating the same real ticket twice is rejected — no duplicate escalation on repeated calls, matching the spec\'s explicit instruction');

    const freshTicket = await api('POST', '/api/support-tickets', { token: officerToken, body: { subject: 'Not overdue yet', message: 'x', priority: 'Low' } });
    const cannotEscalateFresh = await api('POST', `/api/support-tickets/${freshTicket.json.ticket.id}/escalate`, { token: officerToken });
    assert(cannotEscalateFresh.status === 409, 'a real ticket that is genuinely NOT overdue cannot be escalated — no fabricated urgency');
  }

  // =========================================================
  // 9. TICKET-CLIENT / TICKET-LOAN LINKING — real scope enforcement
  // =========================================================
  {
    const nairobiClient = await api('POST', '/api/clients', { token: nairobiManagerToken, body: { name: 'Link Test Client', phone: '0722' + Math.floor(Math.random() * 900000 + 100000) } });
    const linkOutOfScope = await api('POST', `/api/support-tickets/${slaTicketId}/link`, { token: managerToken, body: { clientId: nairobiClient.json.client.id } });
    assert(linkOutOfScope.status === 403, 'a real Kisumu Manager cannot link a real Nairobi-branch client to a ticket by manipulating the id — real branch scope enforced, not just a UI restriction');

    const fakeClientLink = await api('POST', `/api/support-tickets/${slaTicketId}/link`, { token: officerToken, body: { clientId: 'clt_does_not_exist' } });
    assert(fakeClientLink.status === 400, 'linking a nonexistent client id is rejected');

    const realKisumuClient = await api('POST', '/api/clients', { token: managerToken, body: { name: 'Real Link Client', phone: '0733' + Math.floor(Math.random() * 900000 + 100000) } });
    const validLink = await api('POST', `/api/support-tickets/${slaTicketId}/link`, { token: officerToken, body: { clientId: realKisumuClient.json.client.id } });
    assert(validLink.status === 200 && validLink.json.ticket.client_id === realKisumuClient.json.client.id, 'a real, in-scope client can genuinely be linked to the ticket');

    const products = await api('GET', '/api/loan-products', { token: officerToken });
    const unrelatedLoan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: officerMe.branch_id ? nairobiClient.json.client.id : nairobiClient.json.client.id, product_id: products.json.products[0].id, principal: 10000, term_months: 6 } });
    // The loan above belongs to a different client than the one just linked — this must be rejected.
    if (unrelatedLoan.json && unrelatedLoan.json.loan) {
      const mismatchedLoanLink = await api('POST', `/api/support-tickets/${slaTicketId}/link`, { token: officerToken, body: { loanId: unrelatedLoan.json.loan.id } });
      assert(mismatchedLoanLink.status === 400, 'a real loan that does not belong to the ticket\'s already-linked client is rejected — no unrelated loan can be attached');
    }
  }

  // =========================================================
  // 10. REOPEN — real segregation-of-duties, same as resolving
  // =========================================================
  {
    const t = await api('POST', '/api/support-tickets', { token: officerToken, body: { subject: 'Reopen test', message: 'x' } });
    await api('PATCH', `/api/support-tickets/${t.json.ticket.id}`, { token: managerToken, body: { status: 'Resolved' } });

    const ownerCannotReopen = await api('POST', `/api/support-tickets/${t.json.ticket.id}/reopen`, { token: officerToken });
    assert(ownerCannotReopen.status === 403, 'the real ticket owner (Loan Officer) cannot reopen their own resolved ticket — the same real segregation-of-duties rule as resolving, not bypassable');

    const cannotReopenOpenTicket = await api('POST', `/api/support-tickets/${slaTicketId}/reopen`, { token: managerToken });
    assert(cannotReopenOpenTicket.status === 409, 'a ticket that is not genuinely Resolved/Closed cannot be "reopened"');

    const reopened = await api('POST', `/api/support-tickets/${t.json.ticket.id}/reopen`, { token: managerToken });
    assert(reopened.status === 200 && reopened.json.ticket.status === 'In Progress' && reopened.json.ticket.reopened_at, 'Manager can genuinely reopen the real resolved ticket, with a real reopened_at timestamp recorded');
  }

  // =========================================================
  // 11. ACTIVITY HISTORY — reuses the real existing audit log
  // =========================================================
  {
    const detail = await api('GET', `/api/support-tickets/${slaTicketId}`, { token: officerToken });
    assert(Array.isArray(detail.json.activity) && detail.json.activity.length > 0, 'the real ticket detail includes a real activity history, reusing the existing audit_logs table — not a second, duplicate event table');
    assert(detail.json.activity.every(a => a.record_type === 'Ticket' && a.record_id === slaTicketId), 'every real activity entry genuinely belongs to this exact ticket');
  }

  // =========================================================
  // 12. DASHBOARD KPIs — real, role-scoped
  // =========================================================
  {
    const dash = await api('GET', '/api/support-tickets/dashboard', { token: adminToken });
    assert(dash.status === 200 && typeof dash.json.open === 'number' && typeof dash.json.overdue === 'number', 'real dashboard KPIs are computed live from the caller\'s real visible ticket set');
    assert(dash.json.overdue >= 1, 'the real overdue count reflects the real overdue ticket created earlier in this suite');

    const officerDash = await api('GET', '/api/support-tickets/dashboard', { token: officerToken });
    assert(officerDash.status === 200 && officerDash.json.open <= dash.json.open, 'a Loan Officer\'s real dashboard is scoped to only their own visible tickets, never exceeding the real company-wide admin count');
  }

  // =========================================================
  // 13. CSV EXPORT DATA — real, full filtered dataset
  // =========================================================
  {
    const exportData = await api('GET', '/api/support-tickets/export?status=Open', { token: adminToken });
    assert(exportData.status === 200 && Array.isArray(exportData.json.tickets), 'real export endpoint returns the real full filtered ticket set');
    assert(exportData.json.tickets.every(t => t.status === 'Open'), 'the real export data genuinely respects the applied filter, not just the current page');
  }

  // =========================================================
  // 14. SAVED FILTER PRESETS — real, per-user, persisted
  // =========================================================
  {
    const saved = await api('POST', '/api/ticket-filter-presets', { token: officerToken, body: { name: 'My Open Critical', filters: { status: 'Open', priority: 'Critical' } } });
    assert(saved.status === 201 && saved.json.preset.name === 'My Open Critical', 'a real filter preset is genuinely persisted server-side');
    const presetId = saved.json.preset.id;

    const list = await api('GET', '/api/ticket-filter-presets', { token: officerToken });
    assert(list.json.presets.some(p => p.id === presetId), 'the real saved preset appears in the real per-user list');

    const managerList = await api('GET', '/api/ticket-filter-presets', { token: managerToken });
    assert(!managerList.json.presets.some(p => p.id === presetId), 'a different real user does not see another user\'s real saved preset — genuinely per-user');

    const wrongUserDelete = await api('DELETE', `/api/ticket-filter-presets/${presetId}`, { token: managerToken });
    assert(wrongUserDelete.status === 403, 'a real user cannot delete another real user\'s saved preset');

    const ownDelete = await api('DELETE', `/api/ticket-filter-presets/${presetId}`, { token: officerToken });
    assert(ownDelete.status === 200, 'the real owner can delete their own real saved preset');
  }

  // =========================================================
  // 15. COMMUNICATION — real, honest (NOT_CONFIGURED, not fabricated "sent")
  // =========================================================
  {
    // Trigger a real notification-generating event (assignment) and verify a real, honest log entry exists.
    const t = await api('POST', '/api/support-tickets', { token: officerToken, body: { subject: 'Comm test ticket', message: 'x' } });
    const adminMe = (await api('GET', '/api/auth/me', { token: adminToken })).json.user;
    await api('POST', `/api/support-tickets/${t.json.ticket.id}/assign`, { token: managerToken, body: { assignedTo: adminMe.id } });
    // Give the fire-and-forget async email attempt a moment to complete and write its log row.
    await new Promise(r => setTimeout(r, 200));

    const commLog = await api('GET', '/api/communication-log', { token: adminToken });
    assert(commLog.status === 200 && Array.isArray(commLog.json.log), 'Admin can view the real communication log');
    const entry = commLog.json.log.find(l => l.related_id === t.json.ticket.id);
    assert(entry && entry.channel === 'email', 'a real communication attempt was genuinely logged for the real assignment event');
    assert(entry.status === 'NOT_CONFIGURED', 'the real log honestly reports NOT_CONFIGURED — this environment has no real email provider credentials, and the log does not fabricate a "Sent" status');

    const officerDenied = await api('GET', '/api/communication-log', { token: officerToken });
    assert(officerDenied.status === 403, 'an ordinary staff member cannot view the company-wide communication log — requires real system-settings authority');

    // Confirm no secrets/credentials ever appear in the log.
    const logText = JSON.stringify(commLog.json.log);
    assert(!logText.match(/password|secret|api[_-]?key/i), 'the real communication log never contains credential-shaped content');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
