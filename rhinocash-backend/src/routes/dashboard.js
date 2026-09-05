'use strict';
const { all, get } = require('./../db');
const { requireAuth } = require('./../middleware');
const { branchScopeSQL } = require('./../rbac');

function register(router) {
  router.get('/api/dashboard/summary', requireAuth, (req, res) => {
    const scope = branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.user.role_id === 'loan_officer') { clause += ' AND officer_id = ?'; params.push(req.user.id); }

    const loans = all(`SELECT * FROM loans WHERE ${clause} AND status IN ('Active','Disbursed')`, params);
    let outstanding = 0, arrears = 0;
    const today = new Date();
    loans.forEach(l => {
      const rows = all('SELECT * FROM loan_schedule WHERE loan_id = ?', [l.id]);
      const bal = rows.reduce((s, r) => s + Math.max(0, r.total_due - r.paid_amount), 0);
      outstanding += bal;
      const overdue = rows.some(r => r.status !== 'Paid' && new Date(r.due_date) < today);
      if (overdue) arrears += bal;
    });
    const par = outstanding > 0 ? (arrears / outstanding) * 100 : 0;

    const disbursedMTD = get(
      `SELECT COALESCE(SUM(principal),0) as v FROM loans WHERE ${clause} AND disbursed_at IS NOT NULL AND strftime('%Y-%m', disbursed_at) = strftime('%Y-%m','now')`,
      params
    ).v;

    const loanIds = loans.map(l => l.id);
    let collectionsMTD = 0;
    if (loanIds.length) {
      const placeholders = loanIds.map(() => '?').join(',');
      collectionsMTD = get(
        `SELECT COALESCE(SUM(amount),0) as v FROM payments WHERE loan_id IN (${placeholders}) AND status != 'Unposted' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')`,
        loanIds
      ).v;
    }

    const activeClientCount = new Set(loans.map(l => l.client_id)).size;

    res.json({
      scope: req.user.role_id,
      outstandingPortfolio: outstanding,
      arrearsAmount: arrears,
      par,
      disbursedMTD,
      collectionsMTD,
      activeLoans: loans.length,
      activeClients: activeClientCount,
    });
  });
}

module.exports = { register };
