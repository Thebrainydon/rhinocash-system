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

  router.post('/api/workplans/me', requireAuth, async (req, res, next) => {
    const b = req.body;
    const date = b.date || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return next({ status: 400, message: 'date must look like "2026-09-23"' });
    const num = (v) => Math.max(0, parseInt(v, 10) || 0);
    const existing = await get('SELECT id FROM daily_workplans WHERE user_id = ? AND plan_date = ?', [req.user.id, date]);
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
        ['wp_' + crypto.randomUUID(), req.user.id, date, ...fields]
      );
    }
    const row = await get('SELECT * FROM daily_workplans WHERE user_id = ? AND plan_date = ?', [req.user.id, date]);
    res.status(201).json({ plan: shapePlan(row), date });
  });
}

module.exports = { register };
