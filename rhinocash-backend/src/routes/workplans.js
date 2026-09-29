// workplans.js — a staff member's own real Daily Workplan (My Account ->
// My Work Plan): a real per-day target + planned visiting locations for
// each of 4 real visitation categories, plus a real, freshly-computed
// "Achieved"/"Clients Visited" for the categories that have an honest,
// unambiguous real activity signal in this codebase (Onboarding ->
// clients this officer created that day, Prospect -> leads this officer
// created that day, Collection -> distinct clients this officer
// genuinely collected a real posted payment from that day). Re-Appraisal
// has no real tracked activity anywhere in this app yet, so it always
// honestly reports 0/None rather than fabricating one.
'use strict';
const { requireAuth } = require('./../middleware');
const { all, get, run } = require('./../db');
const { hasPermission } = require('./../rbac');
const crypto = require('node:crypto');

async function computeAchieved(userId, date) {
  const onboarding = await all(
    `SELECT name FROM clients WHERE created_by = ? AND (created_at)::date = (?)::date ORDER BY created_at`,
    [userId, date]
  );
  const prospect = await all(
    `SELECT name FROM client_leads WHERE created_by = ? AND (created_at)::date = (?)::date ORDER BY created_at`,
    [userId, date]
  );
  const collection = await all(
    `SELECT DISTINCT c.name FROM payments p JOIN loans l ON l.id = p.loan_id JOIN clients c ON c.id = p.client_id
     WHERE l.officer_id = ? AND p.status IN ('Posted','Overpayment') AND (p.created_at)::date = (?)::date ORDER BY c.name`,
    [userId, date]
  );
  return {
    reAppraisal: { achieved: 0, clientsVisited: [] },
    collection: { achieved: collection.length, clientsVisited: collection.map(r => r.name) },
    onboarding: { achieved: onboarding.length, clientsVisited: onboarding.map(r => r.name) },
    prospect: { achieved: prospect.length, clientsVisited: prospect.map(r => r.name) },
  };
}

function shapePlan(row) {
  return {
    reAppraisal: { target: row ? row.re_appraisal_target : 0, locations: row ? row.re_appraisal_locations : null },
    collection: { target: row ? row.collection_target : 0, locations: row ? row.collection_locations : null },
    onboarding: { target: row ? row.onboarding_target : 0, locations: row ? row.onboarding_locations : null },
    prospect: { target: row ? row.prospect_target : 0, locations: row ? row.prospect_locations : null },
  };
}

function register(router) {
  router.get('/api/workplans/me', requireAuth, async (req, res, next) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return next({ status: 400, message: 'date must look like "2026-09-23"' });
    const row = await get('SELECT * FROM daily_workplans WHERE user_id = ? AND plan_date = ?', [req.user.id, date]);
    const plan = shapePlan(row);
    const achieved = await computeAchieved(req.user.id, date);
    res.json({
      date,
      reAppraisal: { ...plan.reAppraisal, ...achieved.reAppraisal },
      collection: { ...plan.collection, ...achieved.collection },
      onboarding: { ...plan.onboarding, ...achieved.onboarding },
      prospect: { ...plan.prospect, ...achieved.prospect },
    });
  });

  async function upsertWorkplan(userId, b) {
    const date = b.date || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { const e = new Error('date must look like "2026-09-23"'); e.status = 400; throw e; }
    const num = (v) => Math.max(0, parseInt(v, 10) || 0);
    const existing = await get('SELECT id FROM daily_workplans WHERE user_id = ? AND plan_date = ?', [userId, date]);
    const fields = [
      num(b.reAppraisalTarget), (b.reAppraisalLocations || null),
      num(b.collectionTarget), (b.collectionLocations || null),
      num(b.onboardingTarget), (b.onboardingLocations || null),
      num(b.prospectTarget), (b.prospectLocations || null),
    ];
    if (existing) {
      await run(
        `UPDATE daily_workplans SET re_appraisal_target=?, re_appraisal_locations=?, collection_target=?, collection_locations=?,
           onboarding_target=?, onboarding_locations=?, prospect_target=?, prospect_locations=?, updated_at = iso_now() WHERE id = ?`,
        [...fields, existing.id]
      );
    } else {
      await run(
        `INSERT INTO daily_workplans (id, user_id, plan_date, re_appraisal_target, re_appraisal_locations, collection_target, collection_locations,
           onboarding_target, onboarding_locations, prospect_target, prospect_locations) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ['wp_' + crypto.randomUUID(), userId, date, ...fields]
      );
    }
    const row = await get('SELECT * FROM daily_workplans WHERE user_id = ? AND plan_date = ?', [userId, date]);
    return { plan: shapePlan(row), date };
  }

  router.post('/api/workplans/me', requireAuth, async (req, res, next) => {
    try { res.status(201).json(await upsertWorkplan(req.user.id, req.body)); }
    catch (e) { next(e); }
  });

  // Employees > Daily Workplan's own real "+ Create" — a Manager (or
  // Admin/manage_users holder) setting a real workplan on behalf of one
  // of their own real team members, not just themselves. Same real
  // reporting-line authorization already established for leave-request
  // decisions (canDecideOn in misc.js): only that user's real reporting
  // manager, or a manage_users holder, may write it.
  router.post('/api/workplans/:userId', requireAuth, async (req, res, next) => {
    const target = await get('SELECT id, reporting_manager_id FROM users WHERE id = ?', [req.params.userId]);
    if (!target) return next({ status: 404, message: 'Staff member not found' });
    const allowed = target.id === req.user.id
      || target.reporting_manager_id === req.user.id
      || (await hasPermission(req.user, 'manage_users'));
    if (!allowed) return next({ status: 403, message: 'You are not authorized to set this staff member\'s workplan — only their reporting manager or an authorized administrator can' });
    try { res.status(201).json(await upsertWorkplan(target.id, req.body)); }
    catch (e) { next(e); }
  });

  // Employees > Daily Workplan (Manager's team view) — same real
  // per-day target/achieved shape as /api/workplans/me, for every direct
  // report (or, for an Admin/manage_users holder, every real staff
  // member) rather than just the caller's own. Same team-scoping rule
  // already established for GET /api/leave-requests (non-"mine" view).
  router.get('/api/workplans', requireAuth, async (req, res, next) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return next({ status: 400, message: 'date must look like "2026-09-23"' });
    const team = (await hasPermission(req.user, 'manage_users'))
      ? await all("SELECT id, name FROM users WHERE status = 'Active' ORDER BY name")
      : await all("SELECT id, name FROM users WHERE reporting_manager_id = ? AND status = 'Active' ORDER BY name", [req.user.id]);
    const rows = await Promise.all(team.map(async (u) => {
      const row = await get('SELECT * FROM daily_workplans WHERE user_id = ? AND plan_date = ?', [u.id, date]);
      const plan = shapePlan(row);
      const achieved = await computeAchieved(u.id, date);
      return {
        userId: u.id, userName: u.name,
        reAppraisal: { ...plan.reAppraisal, ...achieved.reAppraisal },
        collection: { ...plan.collection, ...achieved.collection },
        onboarding: { ...plan.onboarding, ...achieved.onboarding },
        prospect: { ...plan.prospect, ...achieved.prospect },
      };
    }));
    res.json({ date, staff: rows });
  });
}

module.exports = { register };
