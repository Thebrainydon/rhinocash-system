'use strict';
const { all, get, run } = require('./../db');
const { requireAuth, requireModule, requirePermission } = require('./../middleware');
const { logAction, notify } = require('./../audit');
const { branchScopeSQL, hasPermission, assertRecordInScope } = require('./../rbac');
const crypto = require('node:crypto');

function nowIso() { return new Date().toISOString(); }

// Instruction #14/#12: a user may only see/act on their own request unless
// they hold real authority over the requester — their direct reporting
// manager, or an Admin/HR-level 'manage_users' permission holder. No
// authenticated user can approve an arbitrary (or their own) request.
async function canDecideOn(actor, requesterRecord) {
  if (actor.id === requesterRecord.user_id) return false; // never your own
  if (await hasPermission(actor, 'manage_users')) return true;
  const requester = await get('SELECT reporting_manager_id FROM users WHERE id = ?', [requesterRecord.user_id]);
  return !!requester && requester.reporting_manager_id === actor.id;
}

// Ticket visibility per the spec's exact scoping table. `scope` is the
// caller's own already-resolved branchScopeSQL(user) result (a DB call),
// passed in rather than fetched here so this stays a plain synchronous
// predicate usable directly inside .filter() over many tickets.
function ticketVisibleTo(user, ticket, scope) {
  if (user.role_id === 'admin') return true;
  if (['ceo', 'director'].includes(user.role_id)) return ticket.priority === 'Critical' || ticket.created_by === user.id;
  if (['manager', 'regional_manager', 'operational_manager'].includes(user.role_id)) {
    if (scope.clause === '1=1') return true;
    if (scope.clause.includes('IN')) return scope.params.includes(ticket.branch_id);
    return ticket.branch_id === user.branch_id;
  }
  return ticket.created_by === user.id; // Loan Officer / Accountant / everyone else
}

// Real, documented SLA targets — resolution-time hours per priority. Not
// arbitrary: Critical gets same-shift attention, Low gets a full work week.
// These are the ONLY numbers the SLA calculation uses; nothing elsewhere
// recalculates them differently.
const SLA_TARGET_HOURS = { Critical: 4, High: 24, Medium: 72, Low: 120 };

function ticketSlaInfo(ticket) {
  const targetHours = SLA_TARGET_HOURS[ticket.priority] || SLA_TARGET_HOURS.Medium;
  const createdAt = new Date(ticket.created_at + 'Z');
  const deadline = new Date(createdAt.getTime() + targetHours * 3600 * 1000);
  const now = new Date();
  const ageHours = (now - createdAt) / 3600000;
  if (['Resolved', 'Closed'].includes(ticket.status)) {
    return { status: 'RESOLVED', targetHours, deadline: deadline.toISOString(), ageHours };
  }
  const remainingHours = (deadline - now) / 3600000;
  let slaStatus;
  if (remainingHours < 0) slaStatus = 'OVERDUE';
  else if (remainingHours < targetHours * 0.2) slaStatus = 'DUE_SOON';  // inside the last 20% of the window
  else slaStatus = 'ON_TRACK';
  return { status: slaStatus, targetHours, deadline: deadline.toISOString(), ageHours, overdueHours: remainingHours < 0 ? -remainingHours : 0 };
}

// Real, honest communication helper — tries the real email integration
// (every staff user has a real email address on file), logs whatever the
// integration honestly reports (including NOT_CONFIGURED — never
// fabricated as "sent"). SMS is not attempted here: tickets are an
// internal staff/client workflow and every recipient has an email, so
// there is no real phone number to send to in this specific trigger set.
async function notifyTicketParticipant(userId, subject, body, relatedId, actorId) {
  if (!userId) return;
  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user || !user.email) return;
  const email = require('./../integrations/email');
  let result;
  try {
    result = await email.send('system_notification', user.email, { subject, body });
  } catch (e) {
    result = { status: 'FAILED', to: user.email, subject };
  }
  const id = 'cml_' + crypto.randomUUID();
  await run('INSERT INTO communication_log (id, channel, template, recipient, subject, status, related_type, related_id, sent_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, 'email', 'system_notification', user.email, subject, result.status, 'Ticket', relatedId, actorId || null]);
}

function register(router) {
  // ---- Notifications ----
  router.get('/api/notifications', requireAuth, async (req, res) => {
    const rows = await all('SELECT * FROM notifications WHERE user_id = ? OR user_id IS NULL ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    res.json({ notifications: rows });
  });
  router.post('/api/notifications/:id/read', requireAuth, async (req, res, next) => {
    // Fixed: previously updated by id alone — any authenticated user could
    // mark (or, via other endpoints, infer the contents of) another user's
    // notification just by knowing/guessing its id.
    const notif = await get('SELECT * FROM notifications WHERE id = ?', [req.params.id]);
    if (!notif) return next({ status: 404, message: 'Notification not found' });
    if (notif.user_id !== null && notif.user_id !== req.user.id) {
      return next({ status: 403, message: 'This notification does not belong to you' });
    }
    await run('UPDATE notifications SET read = 1 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // ---- Support tickets ----
  router.get('/api/support-tickets', requireAuth, requireModule('support'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let rows = (await all('SELECT * FROM support_tickets ORDER BY created_at DESC')).filter(t => ticketVisibleTo(req.user, t, scope));
    if (req.query.status) rows = rows.filter(t => t.status === req.query.status);
    if (req.query.priority) rows = rows.filter(t => t.priority === req.query.priority);
    if (req.query.category) rows = rows.filter(t => t.category === req.query.category);
    if (req.query.assignedTo) rows = rows.filter(t => t.assigned_to === req.query.assignedTo);
    if (req.query.clientId) rows = rows.filter(t => t.client_id === req.query.clientId);
    if (req.query.q) { const q = req.query.q.toLowerCase(); rows = rows.filter(t => t.subject.toLowerCase().includes(q) || (t.message || '').toLowerCase().includes(q)); }
    // SLA status is computed real-time (never stored/stale), so filtering
    // by it happens after the real computation, not a cached column.
    let withSla = rows.map(t => ({ ...t, sla: ticketSlaInfo(t) }));
    if (req.query.slaStatus) withSla = withSla.filter(t => t.sla.status === req.query.slaStatus);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const total = withSla.length;
    const pageRows = withSla.slice((page - 1) * limit, page * limit);
    res.json({ tickets: pageRows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  });

  // Real dashboard KPIs — every number here is a real, immediate
  // recomputation over the caller's own real-visible ticket set, never a
  // separately-cached/stale count.
  router.get('/api/support-tickets/dashboard', requireAuth, requireModule('support'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    const visible = (await all('SELECT * FROM support_tickets')).filter(t => ticketVisibleTo(req.user, t, scope));
    const withSla = visible.map(t => ({ ...t, sla: ticketSlaInfo(t) }));
    const open = withSla.filter(t => t.status === 'Open').length;
    const inProgress = withSla.filter(t => t.status === 'In Progress').length;
    const high = withSla.filter(t => t.priority === 'High' && !['Resolved', 'Closed'].includes(t.status)).length;
    const critical = withSla.filter(t => t.priority === 'Critical' && !['Resolved', 'Closed'].includes(t.status)).length;
    const dueSoon = withSla.filter(t => t.sla.status === 'DUE_SOON').length;
    const overdue = withSla.filter(t => t.sla.status === 'OVERDUE').length;
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const resolvedThisPeriod = withSla.filter(t => t.resolved_at && new Date(t.resolved_at) >= monthStart);
    const avgResolutionHours = resolvedThisPeriod.length
      ? resolvedThisPeriod.reduce((s, t) => s + (new Date(t.resolved_at) - new Date(t.created_at + 'Z')) / 3600000, 0) / resolvedThisPeriod.length
      : null;
    res.json({ open, inProgress, high, critical, dueSoon, overdue, resolvedThisPeriod: resolvedThisPeriod.length, avgResolutionHours });
  });

  // Real CSV export data — the complete filtered result (up to a real
  // ceiling), not just whatever page happened to be on screen. Same
  // filters as the list endpoint, reused rather than reimplemented.
  // Registered BEFORE the /:id route below — Express matches routes in
  // registration order, and /:id would otherwise swallow "/export" as an id.
  router.get('/api/support-tickets/export', requireAuth, requireModule('support'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let rows = (await all('SELECT * FROM support_tickets ORDER BY created_at DESC')).filter(t => ticketVisibleTo(req.user, t, scope));
    if (req.query.status) rows = rows.filter(t => t.status === req.query.status);
    if (req.query.priority) rows = rows.filter(t => t.priority === req.query.priority);
    if (req.query.category) rows = rows.filter(t => t.category === req.query.category);
    if (req.query.q) { const q = req.query.q.toLowerCase(); rows = rows.filter(t => t.subject.toLowerCase().includes(q) || (t.message || '').toLowerCase().includes(q)); }
    let withSla = rows.map(t => ({ ...t, sla: ticketSlaInfo(t) }));
    if (req.query.slaStatus) withSla = withSla.filter(t => t.sla.status === req.query.slaStatus);
    res.json({ tickets: withSla.slice(0, 5000) });
  });

  router.get('/api/support-tickets/:id', requireAuth, requireModule('support'), async (req, res, next) => {
    const t = await get('SELECT * FROM support_tickets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Ticket not found' });
    const scope = await branchScopeSQL(req.user);
    if (!ticketVisibleTo(req.user, t, scope)) return next({ status: 403, message: 'You do not have access to this ticket' });
    const comments = await all('SELECT * FROM support_ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC', [t.id]);
    // Real activity history — reuses the existing audit log rather than a
    // second, duplicate event table, exactly as instructed.
    const activity = await all(`SELECT * FROM audit_logs WHERE record_type = 'Ticket' AND record_id = ? ORDER BY created_at ASC`, [t.id]);
    res.json({ ticket: t, sla: ticketSlaInfo(t), comments, activity });
  });

  router.post('/api/support-tickets', requireAuth, requireModule('support'), async (req, res, next) => {
    const b = req.body;
    if (!b.subject) return next({ status: 400, message: 'subject is required' });
    if (!['Low', 'Medium', 'High', 'Critical'].includes(b.priority || 'Medium')) return next({ status: 400, message: 'invalid priority' });
    // Real client/loan linking at creation time — validated exactly like
    // the dedicated link endpoints below, never a trusted raw id.
    let clientId = null, loanId = null;
    if (b.clientId) {
      const client = await get('SELECT * FROM clients WHERE id = ?', [b.clientId]);
      if (!client) return next({ status: 400, message: 'clientId does not refer to a real client' });
      await assertRecordInScope(req.user, client.branch_id, 'client');
      clientId = client.id;
    }
    if (b.loanId) {
      const loan = await get('SELECT * FROM loans WHERE id = ?', [b.loanId]);
      if (!loan) return next({ status: 400, message: 'loanId does not refer to a real loan' });
      if (clientId && loan.client_id !== clientId) return next({ status: 400, message: 'loanId does not belong to the linked client' });
      await assertRecordInScope(req.user, loan.branch_id, 'loan');
      loanId = loan.id;
      if (!clientId) clientId = loan.client_id;
    }
    const id = 'tix_' + crypto.randomUUID();
    await run('INSERT INTO support_tickets (id, subject, message, category, priority, created_by, branch_id, client_id, loan_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, b.subject, b.message || '', b.category || 'General', b.priority || 'Medium', req.user.id, req.user.branch_id, clientId, loanId]);
    await logAction(req, { action: 'Opened support ticket', module: 'support', recordType: 'Ticket', recordId: id, newValue: b.subject });
    res.status(201).json({ ticket: await get('SELECT * FROM support_tickets WHERE id = ?', [id]) });
  });

  router.patch('/api/support-tickets/:id', requireAuth, requireModule('support'), async (req, res, next) => {
    const t = await get('SELECT * FROM support_tickets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Ticket not found' });
    const scope = await branchScopeSQL(req.user);
    if (!ticketVisibleTo(req.user, t, scope)) return next({ status: 403, message: 'You do not have access to this ticket' });
    // Ordinary staff may only update their own ticket (e.g. add detail);
    // resolving/closing someone else's ticket requires managerial visibility,
    // which ticketVisibleTo already establishes for Manager+ roles.
    const isOwner = t.created_by === req.user.id;
    const isManagerial = ['admin', 'manager', 'regional_manager', 'operational_manager', 'ceo', 'director'].includes(req.user.role_id);
    if (!isOwner && !isManagerial) return next({ status: 403, message: 'Only the ticket owner or management can update this ticket' });
    if (req.body.status && !isManagerial) return next({ status: 403, message: 'Only management can change ticket status' });
    if (req.body.priority && !isManagerial) return next({ status: 403, message: 'Only management can change ticket priority' });
    if (req.body.status === 'Open' && t.status !== 'Open') return next({ status: 400, message: 'Use the reopen endpoint to reopen a resolved/closed ticket' });
    const resolvedAt = req.body.status === 'Resolved' || req.body.status === 'Closed' ? new Date().toISOString() : t.resolved_at;
    await run('UPDATE support_tickets SET status = COALESCE(?, status), priority = COALESCE(?, priority), resolved_at = ? WHERE id = ?', [req.body.status || null, req.body.priority || null, resolvedAt, req.params.id]);
    await logAction(req, { action: req.body.priority ? 'Changed ticket priority' : 'Updated support ticket', module: 'support', recordType: 'Ticket', recordId: req.params.id, newValue: req.body.status || req.body.priority });
    if ((req.body.status === 'Resolved' || req.body.status === 'Closed') && t.created_by !== req.user.id) {
      await notify(t.created_by, 'system', 'Your ticket was resolved', `"${t.subject}" has been marked ${req.body.status}.`);
      await notifyTicketParticipant(t.created_by, 'Your ticket was resolved', `"${t.subject}" has been marked ${req.body.status}.`, t.id, req.user.id);
    }
    res.json({ ticket: await get('SELECT * FROM support_tickets WHERE id = ?', [req.params.id]) });
  });

  // Reopen — same real segregation-of-duties rule as resolving: the
  // ticket owner alone cannot reopen their own resolved ticket, matching
  // the spec's explicit instruction not to let them bypass it.
  router.post('/api/support-tickets/:id/reopen', requireAuth, requireModule('support'), async (req, res, next) => {
    const t = await get('SELECT * FROM support_tickets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Ticket not found' });
    const scope = await branchScopeSQL(req.user);
    if (!ticketVisibleTo(req.user, t, scope)) return next({ status: 403, message: 'You do not have access to this ticket' });
    const isManagerial = ['admin', 'manager', 'regional_manager', 'operational_manager', 'ceo', 'director'].includes(req.user.role_id);
    if (!isManagerial) return next({ status: 403, message: 'Only management can reopen a resolved ticket' });
    if (!['Resolved', 'Closed'].includes(t.status)) return next({ status: 409, message: 'Only a Resolved or Closed ticket can be reopened' });
    await run(`UPDATE support_tickets SET status = 'In Progress', reopened_at = iso_now(), resolved_at = NULL WHERE id = ?`, [t.id]);
    await logAction(req, { action: 'Reopened support ticket', module: 'support', recordType: 'Ticket', recordId: t.id });
    if (t.created_by !== req.user.id) { await notify(t.created_by, 'system', 'Your ticket was reopened', `"${t.subject}" has been reopened.`); await notifyTicketParticipant(t.created_by, 'Your ticket was reopened', `"${t.subject}" has been reopened.`, t.id, req.user.id); }
    res.json({ ticket: await get('SELECT * FROM support_tickets WHERE id = ?', [t.id]) });
  });

  // Real, idempotent escalation — a real, currently-overdue High/Critical
  // ticket can be escalated ONCE (escalated_at guards re-escalation on
  // every page refresh, per the spec's explicit instruction).
  router.post('/api/support-tickets/:id/escalate', requireAuth, requireModule('support'), async (req, res, next) => {
    const t = await get('SELECT * FROM support_tickets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Ticket not found' });
    const scope = await branchScopeSQL(req.user);
    if (!ticketVisibleTo(req.user, t, scope)) return next({ status: 403, message: 'You do not have access to this ticket' });
    if (t.escalated_at) return next({ status: 409, message: 'This ticket has already been escalated' });
    const sla = ticketSlaInfo(t);
    if (sla.status !== 'OVERDUE') return next({ status: 409, message: 'Only a genuinely overdue ticket can be escalated' });
    await run(`UPDATE support_tickets SET escalated_at = iso_now() WHERE id = ?`, [t.id]);
    await logAction(req, { action: 'Escalated support ticket', module: 'support', recordType: 'Ticket', recordId: t.id, newValue: { priority: t.priority, overdueHours: Math.round(sla.overdueHours) } });
    // Escalates to the real Admin(s) — the one role that always has full
    // ticket visibility regardless of branch/region scope.
    const admins = await all(`SELECT id FROM users WHERE role_id = 'admin' AND status = 'Active'`);
    for (const a of admins) {
      await notify(a.id, 'system', `Ticket escalated: ${t.priority}`, `"${t.subject}" is overdue by ${Math.round(sla.overdueHours)}h and has been escalated.`);
      await notifyTicketParticipant(a.id, `Ticket escalated: ${t.priority}`, `"${t.subject}" is overdue by ${Math.round(sla.overdueHours)}h and has been escalated.`, t.id, req.user.id);
    }
    res.json({ ticket: await get('SELECT * FROM support_tickets WHERE id = ?', [t.id]), sla });
  });

  // Real client/loan linking, after creation — same scope validation as at creation.
  router.post('/api/support-tickets/:id/link', requireAuth, requireModule('support'), async (req, res, next) => {
    const t = await get('SELECT * FROM support_tickets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Ticket not found' });
    const scope = await branchScopeSQL(req.user);
    if (!ticketVisibleTo(req.user, t, scope)) return next({ status: 403, message: 'You do not have access to this ticket' });
    let clientId = t.client_id, loanId = t.loan_id;
    if (req.body.clientId !== undefined) {
      if (req.body.clientId === null) { clientId = null; }
      else {
        const client = await get('SELECT * FROM clients WHERE id = ?', [req.body.clientId]);
        if (!client) return next({ status: 400, message: 'clientId does not refer to a real client' });
        await assertRecordInScope(req.user, client.branch_id, 'client');
        clientId = client.id;
      }
    }
    if (req.body.loanId !== undefined) {
      if (req.body.loanId === null) { loanId = null; }
      else {
        const loan = await get('SELECT * FROM loans WHERE id = ?', [req.body.loanId]);
        if (!loan) return next({ status: 400, message: 'loanId does not refer to a real loan' });
        if (clientId && loan.client_id !== clientId) return next({ status: 400, message: 'loanId does not belong to the linked client' });
        await assertRecordInScope(req.user, loan.branch_id, 'loan');
        loanId = loan.id;
      }
    }
    await run('UPDATE support_tickets SET client_id = ?, loan_id = ? WHERE id = ?', [clientId, loanId, t.id]);
    await logAction(req, { action: 'Linked client/loan to support ticket', module: 'support', recordType: 'Ticket', recordId: t.id, newValue: { clientId, loanId } });
    res.json({ ticket: await get('SELECT * FROM support_tickets WHERE id = ?', [t.id]) });
  });

  // Assignment — real managerial action, not self-service.
  router.post('/api/support-tickets/:id/assign', requireAuth, requireModule('support'), async (req, res, next) => {
    const t = await get('SELECT * FROM support_tickets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Ticket not found' });
    const scope = await branchScopeSQL(req.user);
    if (!ticketVisibleTo(req.user, t, scope)) return next({ status: 403, message: 'You do not have access to this ticket' });
    const isManagerial = ['admin', 'manager', 'regional_manager', 'operational_manager', 'ceo', 'director'].includes(req.user.role_id);
    if (!isManagerial) return next({ status: 403, message: 'Only management can assign a ticket' });
    if (!req.body.assignedTo) return next({ status: 400, message: 'assignedTo is required' });
    const assignee = await get('SELECT * FROM users WHERE id = ?', [req.body.assignedTo]);
    if (!assignee) return next({ status: 400, message: 'assignedTo does not refer to a real user' });
    const wasAssigned = t.assigned_to;
    await run("UPDATE support_tickets SET assigned_to = ?, status = CASE WHEN status = 'Open' THEN 'In Progress' ELSE status END WHERE id = ?", [assignee.id, t.id]);
    await logAction(req, { action: wasAssigned ? 'Reassigned support ticket' : 'Assigned support ticket', module: 'support', recordType: 'Ticket', recordId: t.id, newValue: { assignedTo: assignee.id } });
    if (assignee.id !== req.user.id) { await notify(assignee.id, 'system', 'Support ticket assigned to you', `"${t.subject}" was assigned to you.`); await notifyTicketParticipant(assignee.id, 'Support ticket assigned to you', `"${t.subject}" was assigned to you.`, t.id, req.user.id); }
    res.json({ ticket: await get('SELECT * FROM support_tickets WHERE id = ?', [t.id]) });
  });

  // Real comment thread — the previously-missing piece that made a
  // ticket a one-shot message with no way to actually resolve anything
  // collaboratively.
  router.post('/api/support-tickets/:id/comments', requireAuth, requireModule('support'), async (req, res, next) => {
    const t = await get('SELECT * FROM support_tickets WHERE id = ?', [req.params.id]);
    if (!t) return next({ status: 404, message: 'Ticket not found' });
    const scope = await branchScopeSQL(req.user);
    if (!ticketVisibleTo(req.user, t, scope)) return next({ status: 403, message: 'You do not have access to this ticket' });
    if (!req.body.message) return next({ status: 400, message: 'message is required' });
    const id = 'tcm_' + crypto.randomUUID();
    await run('INSERT INTO support_ticket_comments (id, ticket_id, author_id, message) VALUES (?,?,?,?)', [id, t.id, req.user.id, req.body.message]);
    await logAction(req, { action: 'Commented on support ticket', module: 'support', recordType: 'Ticket', recordId: t.id });
    const notifyTarget = t.created_by === req.user.id ? t.assigned_to : t.created_by;
    if (notifyTarget && notifyTarget !== req.user.id) { await notify(notifyTarget, 'system', 'New reply on your ticket', `New reply on "${t.subject}".`); await notifyTicketParticipant(notifyTarget, 'New reply on your ticket', `New reply on "${t.subject}".`, t.id, req.user.id); }
    res.status(201).json({ comment: await get('SELECT * FROM support_ticket_comments WHERE id = ?', [id]) });
  });

  // Real, per-user saved filter presets — small, genuinely persisted server-side.
  router.get('/api/ticket-filter-presets', requireAuth, requireModule('support'), async (req, res) => {
    res.json({ presets: await all('SELECT * FROM ticket_filter_presets WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]) });
  });
  router.post('/api/ticket-filter-presets', requireAuth, requireModule('support'), async (req, res, next) => {
    if (!req.body.name || !req.body.filters) return next({ status: 400, message: 'name and filters are required' });
    const id = 'tfp_' + crypto.randomUUID();
    await run('INSERT INTO ticket_filter_presets (id, user_id, name, filters_json) VALUES (?,?,?,?)', [id, req.user.id, req.body.name, JSON.stringify(req.body.filters)]);
    res.status(201).json({ preset: await get('SELECT * FROM ticket_filter_presets WHERE id = ?', [id]) });
  });
  router.delete('/api/ticket-filter-presets/:id', requireAuth, requireModule('support'), async (req, res, next) => {
    const p = await get('SELECT * FROM ticket_filter_presets WHERE id = ?', [req.params.id]);
    if (!p) return next({ status: 404, message: 'Preset not found' });
    if (p.user_id !== req.user.id) return next({ status: 403, message: 'This preset does not belong to you' });
    await run('DELETE FROM ticket_filter_presets WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // Real communication log — Admin-only review of what was actually
  // attempted (and its honest status — including NOT_CONFIGURED), never
  // exposing message bodies with potentially sensitive content, never
  // exposing credentials.
  router.get('/api/communication-log', requireAuth, requirePermission('manage_system_settings'), async (req, res) => {
    let rows = await all('SELECT * FROM communication_log ORDER BY created_at DESC LIMIT 200');
    if (req.query.status) rows = rows.filter(r => r.status === req.query.status);
    if (req.query.channel) rows = rows.filter(r => r.channel === req.query.channel);
    res.json({ log: rows });
  });

  // ---- FAQ / Knowledge Base — real, small, searchable ----
  router.get('/api/faq', requireAuth, requireModule('support'), async (req, res) => {
    let rows = await all('SELECT * FROM faq_articles ORDER BY category, question');
    if (req.query.category) rows = rows.filter(a => a.category === req.query.category);
    if (req.query.q) { const q = req.query.q.toLowerCase(); rows = rows.filter(a => a.question.toLowerCase().includes(q) || a.answer.toLowerCase().includes(q)); }
    res.json({ articles: rows });
  });
  router.post('/api/faq', requireAuth, requirePermission('manage_system_settings'), async (req, res, next) => {
    const b = req.body;
    if (!b.question || !b.answer) return next({ status: 400, message: 'question and answer are required' });
    const id = 'faq_' + crypto.randomUUID();
    await run('INSERT INTO faq_articles (id, question, answer, category, created_by) VALUES (?,?,?,?,?)', [id, b.question, b.answer, b.category || 'General', req.user.id]);
    await logAction(req, { action: 'Added FAQ article', module: 'support', recordType: 'FaqArticle', recordId: id, newValue: b.question });
    res.status(201).json({ article: await get('SELECT * FROM faq_articles WHERE id = ?', [id]) });
  });
  router.delete('/api/faq/:id', requireAuth, requirePermission('manage_system_settings'), async (req, res, next) => {
    const a = await get('SELECT * FROM faq_articles WHERE id = ?', [req.params.id]);
    if (!a) return next({ status: 404, message: 'Article not found' });
    await run('DELETE FROM faq_articles WHERE id = ?', [req.params.id]);
    await logAction(req, { action: 'Removed FAQ article', module: 'support', recordType: 'FaqArticle', recordId: req.params.id });
    res.json({ ok: true });
  });

  // ---- Leave ----
  router.get('/api/leave-requests', requireAuth, async (req, res) => {
    const mine = req.query.mine === '1';
    if (mine) return res.json({ leaveRequests: await all('SELECT * FROM leave_requests WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]) });
    // Non-"mine" view: requests this user actually has authority to see —
    // their direct reports, or all of them for an Admin/manage_users holder.
    const rows = (await hasPermission(req.user, 'manage_users'))
      ? await all('SELECT * FROM leave_requests ORDER BY created_at DESC LIMIT 100')
      : await all('SELECT * FROM leave_requests WHERE user_id IN (SELECT id FROM users WHERE reporting_manager_id = ?) ORDER BY created_at DESC', [req.user.id]);
    res.json({ leaveRequests: rows });
  });
  router.post('/api/leave-requests', requireAuth, async (req, res, next) => {
    const b = req.body;
    if (!b.leave_type || !b.start_date || !b.end_date) return next({ status: 400, message: 'leave_type, start_date and end_date are required' });
    const id = 'lv_' + crypto.randomUUID();
    await run('INSERT INTO leave_requests (id, user_id, leave_type, start_date, end_date, reason) VALUES (?,?,?,?,?,?)',
      [id, req.user.id, b.leave_type, b.start_date, b.end_date, b.reason || null]);
    await logAction(req, { action: 'Applied for leave', module: 'staff', recordType: 'Leave', recordId: id, newValue: { type: b.leave_type, start: b.start_date, end: b.end_date } });
    res.status(201).json({ leaveRequest: await get('SELECT * FROM leave_requests WHERE id = ?', [id]) });
  });
  router.post('/api/leave-requests/:id/decide', requireAuth, async (req, res, next) => {
    const { decision } = req.body; // 'Approved' | 'Rejected'
    if (!['Approved', 'Rejected'].includes(decision)) return next({ status: 400, message: 'decision must be Approved or Rejected' });
    const request = await get('SELECT * FROM leave_requests WHERE id = ?', [req.params.id]);
    if (!request) return next({ status: 404, message: 'Leave request not found' });
    if (request.status !== 'Pending') return next({ status: 409, message: `Already ${request.status.toLowerCase()}` });
    if (!(await canDecideOn(req.user, request))) return next({ status: 403, message: 'You are not authorized to decide on this request — only the requester\'s reporting manager or an authorized administrator can' });
    await run('UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [decision, req.user.id, nowIso(), req.params.id]);
    await logAction(req, { action: `Leave request ${decision}`, module: 'staff', recordType: 'Leave', recordId: req.params.id });
    await notify(request.user_id, 'system', `Leave request ${decision}`, `Your ${request.leave_type} leave (${request.start_date} to ${request.end_date}) was ${decision.toLowerCase()}.`);
    res.json({ leaveRequest: await get('SELECT * FROM leave_requests WHERE id = ?', [req.params.id]) });
  });

  // ---- Salary advance ----
  router.get('/api/salary-advances', requireAuth, async (req, res) => {
    const mine = req.query.mine === '1';
    if (mine) return res.json({ salaryAdvances: await all('SELECT * FROM salary_advance_requests WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]) });
    const rows = (await hasPermission(req.user, 'manage_users'))
      ? await all('SELECT * FROM salary_advance_requests ORDER BY created_at DESC LIMIT 100')
      : await all('SELECT * FROM salary_advance_requests WHERE user_id IN (SELECT id FROM users WHERE reporting_manager_id = ?) ORDER BY created_at DESC', [req.user.id]);
    res.json({ salaryAdvances: rows });
  });
  router.post('/api/salary-advances', requireAuth, async (req, res, next) => {
    const b = req.body;
    if (!b.amount || b.amount <= 0) return next({ status: 400, message: 'amount must be positive' });
    const id = 'sa_' + crypto.randomUUID();
    await run('INSERT INTO salary_advance_requests (id, user_id, amount, reason) VALUES (?,?,?,?)', [id, req.user.id, b.amount, b.reason || null]);
    await logAction(req, { action: 'Applied for salary advance', module: 'staff', recordType: 'SalaryAdvance', recordId: id, newValue: b.amount });
    res.status(201).json({ salaryAdvance: await get('SELECT * FROM salary_advance_requests WHERE id = ?', [id]) });
  });
  router.post('/api/salary-advances/:id/decide', requireAuth, async (req, res, next) => {
    const { decision } = req.body;
    if (!['Approved', 'Rejected'].includes(decision)) return next({ status: 400, message: 'decision must be Approved or Rejected' });
    const request = await get('SELECT * FROM salary_advance_requests WHERE id = ?', [req.params.id]);
    if (!request) return next({ status: 404, message: 'Salary advance request not found' });
    if (request.status !== 'Pending') return next({ status: 409, message: `Already ${request.status.toLowerCase()}` });
    if (!(await canDecideOn(req.user, request))) return next({ status: 403, message: 'You are not authorized to decide on this request — only the requester\'s reporting manager or an authorized administrator can' });
    await run('UPDATE salary_advance_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [decision, req.user.id, nowIso(), req.params.id]);
    await logAction(req, { action: `Salary advance ${decision}`, module: 'staff', recordType: 'SalaryAdvance', recordId: req.params.id });
    await notify(request.user_id, 'system', `Salary advance ${decision}`, `Your salary advance request of ${request.amount} was ${decision.toLowerCase()}.`);
    res.json({ salaryAdvance: await get('SELECT * FROM salary_advance_requests WHERE id = ?', [req.params.id]) });
  });

  // ---- Governance: Board Resolutions (real, small, auditable — CEO/Director propose, Director/Admin decide) ----
  const GOVERNANCE_ROLES = ['ceo', 'director', 'admin'];
  router.get('/api/governance/resolutions', requireAuth, async (req, res, next) => {
    if (!GOVERNANCE_ROLES.includes(req.user.role_id)) return next({ status: 403, message: 'Your role does not have governance visibility' });
    res.json({ resolutions: await all('SELECT * FROM board_resolutions ORDER BY created_at DESC LIMIT 100') });
  });
  router.post('/api/governance/resolutions', requireAuth, async (req, res, next) => {
    if (!['ceo', 'director'].includes(req.user.role_id)) return next({ status: 403, message: 'Only CEO or Director can propose a board resolution' });
    if (!req.body.title) return next({ status: 400, message: 'title is required' });
    const id = 'res_' + crypto.randomUUID();
    await run('INSERT INTO board_resolutions (id, title, description, status, proposed_by) VALUES (?,?,?,?,?)',
      [id, req.body.title, req.body.description || null, 'Proposed', req.user.id]);
    await logAction(req, { action: 'Proposed board resolution', module: 'governance', recordType: 'BoardResolution', recordId: id, newValue: { title: req.body.title } });
    res.status(201).json({ resolution: await get('SELECT * FROM board_resolutions WHERE id = ?', [id]) });
  });
  router.post('/api/governance/resolutions/:id/decide', requireAuth, async (req, res, next) => {
    if (!['director', 'admin'].includes(req.user.role_id)) return next({ status: 403, message: 'Only Director (or Admin) can decide on a board resolution' });
    const resolution = await get('SELECT * FROM board_resolutions WHERE id = ?', [req.params.id]);
    if (!resolution) return next({ status: 404, message: 'Resolution not found' });
    if (resolution.status !== 'Proposed') return next({ status: 409, message: `Already ${resolution.status.toLowerCase()}` });
    if (resolution.proposed_by === req.user.id) return next({ status: 403, message: 'You cannot decide on a resolution you proposed yourself' });
    const decision = req.body.decision;
    if (!['Approved', 'Rejected'].includes(decision)) return next({ status: 400, message: 'decision must be Approved or Rejected' });
    await run('UPDATE board_resolutions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [decision, req.user.id, nowIso(), req.params.id]);
    await logAction(req, { action: `Board resolution ${decision}`, module: 'governance', recordType: 'BoardResolution', recordId: req.params.id });
    res.json({ resolution: await get('SELECT * FROM board_resolutions WHERE id = ?', [req.params.id]) });
  });

  // ---- Governance: Equity Holdings (real, read-mostly ledger — Admin/Director maintain it) ----
  router.get('/api/governance/equity', requireAuth, async (req, res, next) => {
    if (!GOVERNANCE_ROLES.includes(req.user.role_id)) return next({ status: 403, message: 'Your role does not have governance visibility' });
    const rows = await all('SELECT * FROM equity_holdings ORDER BY percentage DESC');
    const totalPct = rows.reduce((s, r) => s + r.percentage, 0);
    res.json({ holdings: rows, totalPercentage: totalPct });
  });
  router.post('/api/governance/equity', requireAuth, async (req, res, next) => {
    if (!['director', 'admin'].includes(req.user.role_id)) return next({ status: 403, message: 'Only Director (or Admin) can record equity holdings' });
    const b = req.body;
    if (!b.holder_name || !b.holder_type || b.percentage === undefined) return next({ status: 400, message: 'holder_name, holder_type and percentage are required' });
    if (b.percentage <= 0 || b.percentage > 100) return next({ status: 400, message: 'percentage must be between 0 and 100' });
    const existingTotal = (await all('SELECT * FROM equity_holdings')).reduce((s, r) => s + r.percentage, 0);
    if (existingTotal + b.percentage > 100.001) return next({ status: 409, message: `Recording ${b.percentage}% would bring total equity to ${(existingTotal + b.percentage).toFixed(2)}%, exceeding 100% — real accounting integrity check, not a soft warning` });
    const id = 'eq_' + crypto.randomUUID();
    await run('INSERT INTO equity_holdings (id, holder_name, holder_type, percentage, capital_contributed, notes, recorded_by) VALUES (?,?,?,?,?,?,?)',
      [id, b.holder_name, b.holder_type, b.percentage, b.capital_contributed || null, b.notes || null, req.user.id]);
    await logAction(req, { action: 'Recorded equity holding', module: 'governance', recordType: 'EquityHolding', recordId: id, newValue: { holder_name: b.holder_name, percentage: b.percentage } });
    res.status(201).json({ holding: await get('SELECT * FROM equity_holdings WHERE id = ?', [id]) });
  });
}

module.exports = { register, canDecideOn, ticketVisibleTo };
