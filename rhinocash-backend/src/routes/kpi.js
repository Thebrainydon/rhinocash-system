// kpi.js — Performance (Business Quality) KPIs for the caller's scope; see
// businessQuality.js for the formulas and terms.
'use strict';
const { requireAuth } = require('./../middleware');
const { businessQualityFor, FORMULAS } = require('./../businessQuality');

function register(router) {
  router.get('/api/kpi/business-quality', requireAuth, async (req, res, next) => {
    try {
      const data = await businessQualityFor(req.user, { month: req.query.month, branchId: req.query.branchId || null, officerId: req.query.officerId || null });
      res.json({ formulas: FORMULAS, ...data });
    } catch (e) { next(e.status ? { status: e.status, message: e.message } : e); }
  });
}

module.exports = { register };
