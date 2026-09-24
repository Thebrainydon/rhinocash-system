'use strict';
const { all, get } = require('./../db');
const { requireAuth } = require('./../middleware');
const { branchScopeSQL } = require('./../rbac');

// NOTE: this endpoint is currently unused — the Loan Officer Dashboard is
// rendered entirely from the frontend's own computeStats() (rhinocash-app/
// index.html), which never calls this route (confirmed by grep — see
// docs/CROSS_MODULE_AUDIT.md §E.1). It is kept, registered, and now
// formula-reconciled with computeStats() rather than removed, since it is
// already branch-scope-aware (branchScopeSQL) and is the natural candidate
// for a real backend-side aggregation endpoint if a future Manager/Admin
// scope ever needs server-computed summary figures instead of shipping the
// whole company's loans/payments to the client. If it is ever wired up,
// reconcile any future drift with computeStats() again before trusting it.
function register(router) {
  router.get('/api/dashboard/summary', requireAuth, async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    let clause = scope.clause; const params = [...scope.params];
    if (req.user.role_id === 'loan_officer') { clause += ' AND officer_id = ?'; params.push(req.user.id); }

    const loans = await all(`SELECT * FROM loans WHERE ${clause} AND status IN ('Active','Disbursed')`, params);
    let outstanding = 0, arrears = 0;
    const today = new Date();
    for (const l of loans) {
      const rows = await all('SELECT * FROM loan_schedule WHERE loan_id = ?', [l.id]);
      // Same "T.Bal" formula as loanBalance() (index.html) / the Loan
      // Arrears sheet's tbalOf — principal+interest outstanding plus any
      // real accrued-but-unpaid penalty. See §E.4/F.5 in the audit report.
      const bal = rows.reduce((s, r) => s + Math.max(0, r.total_due - r.paid_amount) + Math.max(0, (r.penalty_due || 0) - (r.penalty_paid || 0)), 0);
      outstanding += bal;
      const overdue = rows.some(r => r.status !== 'Paid' && new Date(r.due_date) < today);
      if (overdue) arrears += bal;
    }
    const par = outstanding > 0 ? (arrears / outstanding) * 100 : 0;

    const disbursedMTDRow = await get(
      `SELECT COALESCE(SUM(principal),0) as v FROM loans WHERE ${clause} AND disbursed_at IS NOT NULL AND to_char(disbursed_at::timestamptz, 'YYYY-MM') = to_char(now(), 'YYYY-MM')`,
      params
    );
    const disbursedMTD = disbursedMTDRow.v;

    const loanIds = loans.map(l => l.id);
    let collectionsMTD = 0;
    if (loanIds.length) {
      const placeholders = loanIds.map(() => '?').join(',');
      // Excludes Reversed the same way computeStats() now does (§F.2) —
      // a reversed payment never counts toward collections.
      const collectionsMTDRow = await get(
        `SELECT COALESCE(SUM(amount),0) as v FROM payments WHERE loan_id IN (${placeholders}) AND status NOT IN ('Unposted', 'Reversed') AND to_char(created_at::timestamptz, 'YYYY-MM') = to_char(now(), 'YYYY-MM')`,
        loanIds
      );
      collectionsMTD = collectionsMTDRow.v;
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
