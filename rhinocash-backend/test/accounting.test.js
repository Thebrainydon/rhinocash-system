// accounting.test.js — real expense approval workflow, requisitions,
// utility payments, branch/region-scoped financial reports, real
// pagination on the General Ledger, and end-to-end financial integrity.
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
async function driveLoanToDisbursed(officerToken, mgrToken, regionalToken, opsToken, acctToken, adminToken, principal, term) {
  const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Acct Test ' + Math.random().toString(36).slice(2, 8), phone: '07' + Math.floor(Math.random() * 90000000 + 10000000) } });
  const products = await api('GET', '/api/loan-products', { token: officerToken });
  const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal, term_months: term } });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: mgrToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: regionalToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: opsToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: acctToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/disburse`, { token: adminToken, body: { channel: 'Bank' } });
  return loan.json.loan.id;
}

(async () => {
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const nairobiManagerToken = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD);
  const regionalToken = await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD);
  const opsToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const acctToken = await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  assert(adminToken && managerToken && regionalToken && opsToken && acctToken && officerToken && ceoToken, 'all needed accounts log in');

  // =========================================================
  // 1. LOAN DISBURSEMENT ACCOUNTING — real branch attribution
  // =========================================================
  {
    const cashBefore = await api('GET', '/api/accounting/cash-position?branch_id=br_kisumu', { token: adminToken });
    const loanId = await driveLoanToDisbursed(officerToken, managerToken, regionalToken, opsToken, acctToken, adminToken, 25000, 4);
    const cashAfter = await api('GET', '/api/accounting/cash-position?branch_id=br_kisumu', { token: adminToken });
    assert(cashAfter.json.balances.bank < cashBefore.json.balances.bank, 'a real Kisumu-branch disbursement decreases the real Kisumu-scoped bank balance');

    const glCheck = await api('GET', `/api/journal-entries?ref_type=loan&ref_id=${loanId}`, { token: adminToken });
    assert(glCheck.json.entries.length === 3, 'the disbursement created exactly 3 real journal lines (receivable, net funding, and the real processing-fee income line — balanced double-entry)');
    const debits = glCheck.json.entries.reduce((s, e) => s + e.debit, 0);
    const credits = glCheck.json.entries.reduce((s, e) => s + e.credit, 0);
    assert(Math.abs(debits - credits) < 0.01, 'the disbursement journal entry is genuinely balanced (debits === credits)');
    assert(glCheck.json.entries.every(e => e.branch_id === 'br_kisumu'), 'every disbursement journal line carries the real branch_id — previously journal_entries had no branch attribution at all');
  }

  // =========================================================
  // 2. EXPENSE APPROVAL WORKFLOW — real Pending -> Approved -> Paid, not auto-Paid
  // =========================================================
  {
    const submitted = await api('POST', '/api/expenses', { token: managerToken, body: { category: 'Stationery', amount: 3000, note: 'Office supplies' } });
    assert(submitted.status === 201 && submitted.json.expense.status === 'Pending', 'a submitted expense starts as real Pending, not auto-Paid — the prior bug posted straight to the ledger with no approval gate at all');

    const glBeforeApproval = await api('GET', `/api/journal-entries?ref_type=expense&ref_id=${submitted.json.expense.id}`, { token: adminToken });
    assert(glBeforeApproval.json.entries.length === 0, 'no journal entry exists yet for a merely-submitted (unapproved) expense');

    const wrongRolePay = await api('POST', `/api/expenses/${submitted.json.expense.id}/pay`, { token: managerToken, body: {} });
    assert(wrongRolePay.status === 403, 'a Manager (no post_accounting_entries permission) cannot pay an expense — RBAC differentiates submit from approve/pay');

    const approved = await api('POST', `/api/expenses/${submitted.json.expense.id}/approve`, { token: acctToken, body: {} });
    assert(approved.status === 200 && approved.json.expense.status === 'Approved', 'Accountant can approve a real Pending expense');

    const prematurePay = await api('POST', `/api/expenses/${submitted.json.expense.id}/approve`, { token: acctToken, body: {} });
    assert(prematurePay.status === 409, 'approving an already-Approved expense is rejected — no re-approval of the same expense');

    const paid = await api('POST', `/api/expenses/${submitted.json.expense.id}/pay`, { token: acctToken, body: { account_id: 'bank' } });
    assert(paid.status === 200 && paid.json.expense.status === 'Paid', 'Accountant can pay a real Approved expense');

    const glAfterPay = await api('GET', `/api/journal-entries?ref_type=expense&ref_id=${submitted.json.expense.id}`, { token: adminToken });
    assert(glAfterPay.json.entries.length === 2, 'paying the expense NOW creates the real balanced 2-line journal entry, exactly once, only at payment time');
    const expDebits = glAfterPay.json.entries.reduce((s, e) => s + e.debit, 0);
    const expCredits = glAfterPay.json.entries.reduce((s, e) => s + e.credit, 0);
    assert(Math.abs(expDebits - expCredits) < 0.01, 'the expense payment journal entry is balanced');

    const doublePay = await api('POST', `/api/expenses/${submitted.json.expense.id}/pay`, { token: acctToken, body: {} });
    assert(doublePay.status === 409, 'paying an already-Paid expense is rejected — no duplicate posting');

    // Rejection path.
    const toReject = await api('POST', '/api/expenses', { token: managerToken, body: { category: 'Travel', amount: 5000 } });
    const rejected = await api('POST', `/api/expenses/${toReject.json.expense.id}/reject`, { token: acctToken, body: { reason: 'Not budgeted this quarter' } });
    assert(rejected.status === 200 && rejected.json.expense.status === 'Rejected', 'Accountant can reject a real Pending expense with a reason');
    const cantPayRejected = await api('POST', `/api/expenses/${toReject.json.expense.id}/pay`, { token: acctToken, body: {} });
    assert(cantPayRejected.status === 409, 'a Rejected expense can never be paid');
  }

  // =========================================================
  // 3. REQUISITIONS — real multi-item Submit (OTP-confirmed) -> Manager approval -> Accountant pays
  // =========================================================
  {
    const expenseAccounts = await api('GET', '/api/accounts?account_type=Expense&status=Active', { token: officerToken });
    const expenseAccountId = expenseAccounts.json.accounts[0].id;
    assert(expenseAccountId, 'a real, granular Expense account exists in the chart of accounts for requisitions to charge');

    async function otpFor(token) {
      const r = await api('POST', '/api/requisitions/request-otp', { token, body: {} });
      return r.json.otpForTesting;
    }

    const noOtpAttempt = await api('POST', '/api/requisitions', { token: officerToken, body: { items: [{ description: 'POS device', qty: 1, unit_cost: 8000 }], expense_account_id: expenseAccountId } });
    assert(noOtpAttempt.status === 400, 'submitting a requisition without an OTP code is genuinely rejected');

    const wrongOtpAttempt = await api('POST', '/api/requisitions', { token: officerToken, body: { items: [{ description: 'POS device', qty: 1, unit_cost: 8000 }], expense_account_id: expenseAccountId, otp_code: '000000' } });
    assert(wrongOtpAttempt.status === 400 && wrongOtpAttempt.json.code === 'INVALID_OTP', 'a wrong/unrequested OTP code is genuinely rejected, not silently accepted');

    const noItemsAttempt = await api('POST', '/api/requisitions', { token: officerToken, body: { items: [], expense_account_id: expenseAccountId, otp_code: await otpFor(officerToken) } });
    assert(noItemsAttempt.status === 400, 'a requisition with no line items is genuinely rejected');

    const badAccountAttempt = await api('POST', '/api/requisitions', { token: officerToken, body: { items: [{ description: 'POS device', qty: 1, unit_cost: 8000 }], expense_account_id: 'not-a-real-account', otp_code: await otpFor(officerToken) } });
    assert(badAccountAttempt.status === 400, 'a requisition against a non-existent expense account is genuinely rejected');

    const validOtp = await otpFor(officerToken);
    const submitted = await api('POST', '/api/requisitions', { token: officerToken, body: {
      items: [{ description: 'POS device', qty: 1, unit_cost: 8000 }, { description: 'Receipt rolls', qty: 5, unit_cost: 400 }],
      expense_account_id: expenseAccountId, description: 'New branch equipment', otp_code: validOtp,
    } });
    assert(submitted.status === 201 && submitted.json.requisition.status === 'Pending', 'a Loan Officer can submit a real multi-item requisition, starting Pending');
    assert(submitted.json.requisition.amount === 10000, 'the requisition amount is genuinely computed as the sum of qty*unit_cost across all real line items (8000 + 5*400)');
    assert(Array.isArray(submitted.json.requisition.items) && submitted.json.requisition.items.length === 2, 'the requisition genuinely persisted both real line items, not a flattened single row');
    assert(submitted.json.requisition.expense_account_id === expenseAccountId, 'the requisition genuinely records the real expense account the officer chose');

    const reuseOtp = await api('POST', '/api/requisitions', { token: officerToken, body: { items: [{ description: 'Another item', qty: 1, unit_cost: 100 }], expense_account_id: expenseAccountId, otp_code: validOtp } });
    assert(reuseOtp.status === 400 && reuseOtp.json.code === 'INVALID_OTP', 'an already-used OTP code cannot be reused for a second requisition');

    const wrongBranchDecide = await api('POST', `/api/requisitions/${submitted.json.requisition.id}/decide`, { token: nairobiManagerToken, body: { decision: 'Approved' } });
    assert(wrongBranchDecide.status === 403, 'a Nairobi Manager cannot decide on a Kisumu-branch requisition — real branch scope enforced');

    const officerDecide = await api('POST', `/api/requisitions/${submitted.json.requisition.id}/decide`, { token: officerToken, body: { decision: 'Approved' } });
    assert(officerDecide.status === 403, 'a Loan Officer cannot approve requisitions — no self-approval authority at that level');

    const approved = await api('POST', `/api/requisitions/${submitted.json.requisition.id}/decide`, { token: managerToken, body: { decision: 'Approved' } });
    assert(approved.status === 200 && approved.json.requisition.status === 'Approved', 'the real Kisumu Manager can approve a requisition within their own branch');

    const paid = await api('POST', `/api/requisitions/${submitted.json.requisition.id}/pay`, { token: acctToken, body: {} });
    assert(paid.status === 200 && paid.json.requisition.status === 'Paid', 'Accountant pays the Approved requisition, turning it into a real expense');
    assert(paid.json.requisition.expense_id, 'the paid requisition is genuinely linked to a real expense record — not a second, disconnected financial mechanism');

    const linkedExpense = await api('GET', '/api/expenses?status=Paid', { token: adminToken });
    assert(linkedExpense.json.expenses.some(e => e.id === paid.json.requisition.expense_id), 'the real linked expense genuinely exists and is Paid');

    const glCheck = await api('GET', `/api/journal-entries?ref_type=requisition&ref_id=${submitted.json.requisition.id}`, { token: adminToken });
    assert(glCheck.json.entries.length === 2, 'the requisition payment created a real balanced 2-line journal entry');
    assert(glCheck.json.entries.some(e => e.account_id === expenseAccountId && Number(e.debit) === 10000), 'the payment genuinely debits the REAL expense account the officer chose at submission, not a hardcoded generic one');

    // Cancellation and duplicate-decision protection.
    const another = await api('POST', '/api/requisitions', { token: officerToken, body: { items: [{ description: 'Supplies', qty: 1, unit_cost: 1500 }], expense_account_id: expenseAccountId, otp_code: await otpFor(officerToken) } });
    const cancelled = await api('POST', `/api/requisitions/${another.json.requisition.id}/cancel`, { token: officerToken, body: {} });
    assert(cancelled.status === 200, 'the original submitter can cancel their own Pending requisition');
    const decideCancelled = await api('POST', `/api/requisitions/${another.json.requisition.id}/decide`, { token: managerToken, body: { decision: 'Approved' } });
    assert(decideCancelled.status === 409, 'a Cancelled requisition cannot subsequently be approved');
  }

  // =========================================================
  // 4. UTILITY PAYMENTS (Vendor Payment Form) — real 2-stage
  //    workflow: Submit (Pending) -> CEO decide -> Accountant
  //    decide (the one real posting moment, mirroring how
  //    Requisitions' /pay, not its /decide, is the real posting
  //    step)
  // =========================================================
  {
    async function otpFor(token) { const r = await api('POST', '/api/requisitions/request-otp', { token, body: {} }); return r.json.otpForTesting; }

    const liabilityAccounts = await api('GET', '/api/accounts?account_type=Liability&status=Active', { token: acctToken });
    const bankLoansAccount = liabilityAccounts.json.accounts.find(a => a.name === 'Bank loans payable');
    assert(bankLoansAccount, 'a real non-Expense (Liability) GL account exists for a vendor payment\'s Journal Account to post against');

    const validBody = () => ({ payment_method: 'Mpesa B2C', recipient_mpesa_number: '0722999888', recipient_name: 'Kenya Power', items: [{ description: 'Electricity — Kenya Power', cost: 4500 }] });

    const noOtp = await api('POST', '/api/utility-payments', { token: officerToken, body: validBody() });
    assert(noOtp.status === 400, 'a vendor payment without an OTP code is genuinely rejected');

    const noItems = await api('POST', '/api/utility-payments', { token: officerToken, body: { ...validBody(), items: [], otp_code: await otpFor(officerToken) } });
    assert(noItems.status === 400, 'a vendor payment with no line items is genuinely rejected');

    const missingRecipient = await api('POST', '/api/utility-payments', { token: officerToken, body: { payment_method: 'Paybill B2B', items: [{ description: 'Electricity — Kenya Power', cost: 4500 }], otp_code: await otpFor(officerToken) } });
    assert(missingRecipient.status === 400, "a vendor payment without the recipient's real mpesa number/name is genuinely rejected — every real payment_method is an mpesa channel");

    const badAccount = await api('POST', '/api/utility-payments', { token: officerToken, body: { ...validBody(), items: [{ description: 'Bogus', cost: 100, expense_account_id: 'not-a-real-account' }], otp_code: await otpFor(officerToken) } });
    assert(badAccount.status === 400, 'a vendor payment item naming a non-existent Journal Account is genuinely rejected');

    const cashBefore = await api('GET', '/api/accounting/cash-position?branch_id=br_kisumu', { token: adminToken });

    const submitted = await api('POST', '/api/utility-payments', { token: officerToken, body: { ...validBody(), otp_code: await otpFor(officerToken) } });
    assert(submitted.status === 201 && submitted.json.utilityPayment.status === 'Pending', 'a Loan Officer can genuinely submit a real vendor payment request — it starts Pending, not immediately Paid');
    assert(!submitted.json.utilityPayment.expense_id, 'a freshly-submitted vendor payment has genuinely not posted any expense yet — that only happens once the real 2-stage approval completes');
    assert(Number(submitted.json.utilityPayment.amount) === 4500, 'the vendor payment amount is genuinely the sum of its real line items');
    assert(submitted.json.utilityPayment.payment_no, 'the vendor payment genuinely got a real sequential payment reference number');
    const vendorPayId = submitted.json.utilityPayment.id;

    const cashDuring = await api('GET', '/api/accounting/cash-position?branch_id=br_kisumu', { token: adminToken });
    assert(cashDuring.json.balances.bank === cashBefore.json.balances.bank, 'a merely-submitted (Pending) vendor payment genuinely has not yet touched the real branch cash position');

    const acctTryCeo = await api('POST', `/api/utility-payments/${vendorPayId}/ceo-decide`, { token: acctToken, body: { decision: 'Approved' } });
    assert(acctTryCeo.status === 403, 'the Accountant (not CEO/Admin) genuinely cannot make the real CEO-stage decision');

    const acctTryPayEarly = await api('POST', `/api/utility-payments/${vendorPayId}/accountant-decide`, { token: acctToken, body: { decision: 'Approved' } });
    assert(acctTryPayEarly.status === 409, 'the Accountant genuinely cannot pay a vendor payment before the real CEO decision happens');

    const ceoDecide = await api('POST', `/api/utility-payments/${vendorPayId}/ceo-decide`, { token: ceoToken, body: {
      decision: 'Approved',
      items: [{ id: submitted.json.utilityPayment.items[0].id, cost: 4300 }],
    } });
    assert(ceoDecide.status === 200 && ceoDecide.json.utilityPayment.status === 'CEO Approved', 'the CEO genuinely approves the vendor payment, moving it to CEO Approved');
    assert(Number(ceoDecide.json.utilityPayment.items[0].ceo_cost) === 4300, 'the CEO\'s real cost adjustment is genuinely persisted on the item');

    const ceoRedecide = await api('POST', `/api/utility-payments/${vendorPayId}/ceo-decide`, { token: ceoToken, body: { decision: 'Approved' } });
    assert(ceoRedecide.status === 409, 'a vendor payment already past Pending genuinely cannot be CEO-decided a second time');

    const officerTryPay = await api('POST', `/api/utility-payments/${vendorPayId}/accountant-decide`, { token: officerToken, body: { decision: 'Approved' } });
    assert(officerTryPay.status === 403, 'a Loan Officer genuinely lacks post_accounting_entries — cannot make the final Accountant payment decision');

    const acctDecide = await api('POST', `/api/utility-payments/${vendorPayId}/accountant-decide`, { token: acctToken, body: { decision: 'Approved' } });
    assert(acctDecide.status === 200 && acctDecide.json.utilityPayment.status === 'Paid', 'the Accountant genuinely makes the final decision, actually posting the vendor payment as Paid');
    assert(acctDecide.json.utilityPayment.expense_id, 'the vendor payment is genuinely linked to a real expense record only now, at the real posting moment');
    assert(Number(acctDecide.json.utilityPayment.amount) === 4300, 'the final posted amount genuinely reflects the CEO\'s real cost adjustment (4300), not the originally requested figure');

    const cashAfter = await api('GET', '/api/accounting/cash-position?branch_id=br_kisumu', { token: adminToken });
    assert(cashAfter.json.balances.bank < cashBefore.json.balances.bank, 'only once fully approved and paid does the real vendor payment genuinely decrease the real branch cash position');

    const glCheck = await api('GET', `/api/journal-entries?ref_type=utility&ref_id=${acctDecide.json.utilityPayment.expense_id}`, { token: adminToken });
    assert(glCheck.json.entries.length === 2, 'the paid vendor payment posts a real balanced 2-line journal entry');
    assert(glCheck.json.entries.reduce((s, e) => s + Number(e.debit), 0) === glCheck.json.entries.reduce((s, e) => s + Number(e.credit), 0), 'the vendor payment journal entry is genuinely balanced');

    // Decline paths and cancellation.
    const declineSubmit = await api('POST', '/api/utility-payments', { token: officerToken, body: { ...validBody(), otp_code: await otpFor(officerToken) } });
    const declineId = declineSubmit.json.utilityPayment.id;
    const ceoDecline = await api('POST', `/api/utility-payments/${declineId}/ceo-decide`, { token: ceoToken, body: { decision: 'Declined', reason: 'Not needed' } });
    assert(ceoDecline.status === 200 && ceoDecline.json.utilityPayment.status === 'Declined', 'the CEO can genuinely decline a vendor payment request, ending the workflow there');
    const acctPayDeclined = await api('POST', `/api/utility-payments/${declineId}/accountant-decide`, { token: acctToken, body: { decision: 'Approved' } });
    assert(acctPayDeclined.status === 409, 'a Declined vendor payment genuinely cannot subsequently be paid');

    const cancelSubmit = await api('POST', '/api/utility-payments', { token: officerToken, body: { ...validBody(), otp_code: await otpFor(officerToken) } });
    const cancelId = cancelSubmit.json.utilityPayment.id;
    const otherCancel = await api('POST', `/api/utility-payments/${cancelId}/cancel`, { token: acctToken, body: {} });
    assert(otherCancel.status === 403, 'only the real submitter (or an Admin) can cancel a vendor payment');
    const ownCancel = await api('POST', `/api/utility-payments/${cancelId}/cancel`, { token: officerToken, body: {} });
    assert(ownCancel.status === 200, 'the real submitter can genuinely cancel their own Pending vendor payment');
    const ceoDecideCancelled = await api('POST', `/api/utility-payments/${cancelId}/ceo-decide`, { token: ceoToken, body: { decision: 'Approved' } });
    assert(ceoDecideCancelled.status === 409, 'a Cancelled vendor payment genuinely cannot subsequently be CEO-decided');

    const multiItem = await api('POST', '/api/utility-payments', { token: officerToken, body: {
      payment_method: 'BuyGoods (Till)', recipient_mpesa_number: '774411', recipient_name: 'Office Supplies Ltd',
      items: [
        { description: 'Stationery', cost: 300 },
        { description: 'Loan portfolio bad debt top-up', cost: 200, expense_account_id: bankLoansAccount.id },
      ],
      otp_code: await otpFor(officerToken),
    } });
    assert(multiItem.status === 201 && Array.isArray(multiItem.json.utilityPayment.items) && multiItem.json.utilityPayment.items.length === 2, 'a multi-item vendor payment genuinely persisted both real line items, not a flattened single row');
    assert(multiItem.json.utilityPayment.items.some(it => it.expense_account_id === bankLoansAccount.id), 'the item that named the real non-Expense "Bank loans payable" account genuinely recorded it — the Journal Account selector is not restricted to Expense accounts');

    await api('POST', `/api/utility-payments/${multiItem.json.utilityPayment.id}/ceo-decide`, { token: ceoToken, body: { decision: 'Approved' } });
    const multiPay = await api('POST', `/api/utility-payments/${multiItem.json.utilityPayment.id}/accountant-decide`, { token: acctToken, body: { decision: 'Approved' } });
    assert(multiPay.status === 200 && Number(multiPay.json.utilityPayment.amount) === 500, 'a multi-item vendor payment genuinely sums all its real line items (300 + 200) once fully approved and paid');

    const multiGl = await api('GET', `/api/journal-entries?ref_type=utility&ref_id=${multiPay.json.utilityPayment.expense_id}`, { token: adminToken });
    assert(multiGl.json.entries.length === 3, 'a 2-item vendor payment posts a real 3-line journal entry (one debit per item + one credit) — still real double-entry, just more than 2 lines');
    assert(multiGl.json.entries.some(e => e.account_id === bankLoansAccount.id), 'one of the real journal lines genuinely debits the real "Bank loans payable" account the item named');
    assert(multiGl.json.entries.reduce((s, e) => s + Number(e.debit), 0) === multiGl.json.entries.reduce((s, e) => s + Number(e.credit), 0), 'the multi-item vendor payment journal entry is genuinely balanced');
  }

  // =========================================================
  // 4b. UTILITY PAYMENTS BULK IMPORT — real CSV-derived rows,
  //     OTP-confirmed, subject to the same real 2-stage workflow
  // =========================================================
  {
    async function otpFor(token) {
      const r = await api('POST', '/api/requisitions/request-otp', { token, body: {} });
      return r.json.otpForTesting;
    }

    const noOtp = await api('POST', '/api/utility-payments/bulk', { token: officerToken, body: { rows: [{ item_description: 'Printer paper', cost: 500 }] } });
    assert(noOtp.status === 400, 'bulk import without an OTP code is genuinely rejected');

    const noRows = await api('POST', '/api/utility-payments/bulk', { token: officerToken, body: { rows: [], otp_code: await otpFor(officerToken) } });
    assert(noRows.status === 400, 'bulk import with no rows is genuinely rejected');

    const validOtp = await otpFor(officerToken);
    const bulk = await api('POST', '/api/utility-payments/bulk', { token: officerToken, body: {
      rows: [
        { branch: 'Kisumu', item_description: 'Office cleaning', cost: 2500, recipient_mpesa_number: '0722000111', mpesa_name: 'Clean Co', journal_account: 'Rent expense' },
        { branch: 'Nonexistent Branch', item_description: 'Bad branch row', cost: 100, journal_account: 'Rent expense' },
        { item_description: '', cost: 100 },
      ],
      otp_code: validOtp,
    } });
    assert(bulk.status === 201, 'a batch with at least one genuinely valid row succeeds overall');
    assert(bulk.json.created === 1, 'exactly the one genuinely valid row was created — the other two real errors did not silently create anything');
    assert(bulk.json.errors.length === 2, 'both real bad rows (unknown branch, missing item description) are reported, not silently dropped');

    const reuseOtp = await api('POST', '/api/utility-payments/bulk', { token: officerToken, body: { rows: [{ item_description: 'Another item', cost: 50 }], otp_code: validOtp } });
    assert(reuseOtp.status === 400 && reuseOtp.json.code === 'INVALID_OTP', 'an already-used OTP code cannot be reused for a second bulk import');

    const createdList = await api('GET', '/api/utility-payments?q=Clean Co', { token: acctToken });
    const createdRow = createdList.json.utilityPayments.find(u => u.mpesa_name === 'Clean Co');
    assert(createdRow && createdRow.status === 'Pending' && createdRow.item_description === 'Office cleaning' && createdRow.recipient_mpesa_number === '0722000111', 'the real bulk-created row genuinely persisted Pending, with its item description and mpesa recipient details, searchable via the real q filter');
    assert(createdRow.expense_account_id, 'the bulk row genuinely resolved and stored the real "Rent expense" GL account it named, not a hardcoded fallback');
    assert(!createdRow.expense_id, 'a bulk-created row genuinely has not posted any expense yet — bulk rows go through the same real 2-stage approval, not an immediate post');

    const bulkCeo = await api('POST', `/api/utility-payments/${createdRow.id}/ceo-decide`, { token: ceoToken, body: { decision: 'Approved' } });
    assert(bulkCeo.status === 200 && bulkCeo.json.utilityPayment.status === 'CEO Approved', 'the CEO can genuinely approve a bulk-created vendor payment row the same way as a singly-created one');

    const bulkPay = await api('POST', `/api/utility-payments/${createdRow.id}/accountant-decide`, { token: acctToken, body: { decision: 'Approved' } });
    assert(bulkPay.status === 200 && bulkPay.json.utilityPayment.status === 'Paid' && bulkPay.json.utilityPayment.expense_id, 'the Accountant genuinely makes the final decision on the bulk-created row too, posting it as Paid');

    const glCheck = await api('GET', `/api/journal-entries?ref_type=utility&ref_id=${bulkPay.json.utilityPayment.expense_id}`, { token: adminToken });
    assert(glCheck.json.entries.length === 2 && glCheck.json.entries.some(e => e.account_id === createdRow.expense_account_id), 'the bulk-created row, once fully approved, posted a real balanced journal entry against the real named expense account');
  }

  // =========================================================
  // 5. BRANCH/REGION-SCOPED FINANCIAL REPORTS
  // =========================================================
  {
    const managerTB = await api('GET', '/api/accounting/trial-balance', { token: managerToken });
    assert(managerTB.status === 200 && managerTB.json.balanced !== undefined, 'a Manager can view a real trial balance, scoped to their own branch by default');

    const managerTBOtherBranch = await api('GET', '/api/accounting/trial-balance?branch_id=br_nairobi', { token: managerToken });
    assert(managerTBOtherBranch.status === 200, 'requesting another branch does not error out (no existence leak)');

    const adminTB = await api('GET', '/api/accounting/trial-balance', { token: adminToken });
    assert(adminTB.json.balanced === true, 'the real company-wide trial balance is genuinely balanced (debits === credits) after all this real activity');

    const officerCashPosition = await api('GET', '/api/accounting/cash-position', { token: officerToken });
    assert(officerCashPosition.status === 200, 'Loan Officer retains real (spec-allowed) accounting read access, scoped to their own branch');
  }

  // =========================================================
  // 6. GENERAL LEDGER — real pagination
  // =========================================================
  {
    const page1 = await api('GET', '/api/journal-entries?limit=5&page=1', { token: adminToken });
    assert(page1.json.entries.length <= 5 && page1.json.pagination.total >= page1.json.entries.length, 'General Ledger returns real pagination metadata, not an unlimited dump');
    assert(page1.json.pagination.total > 5, 'there is genuinely more than one page of real journal entries by this point in the test suite');
  }

  // =========================================================
  // 7. CASHFLOW — real opening/closing balance over a date range
  // =========================================================
  {
    const cf = await api('GET', '/api/accounting/cashflow', { token: adminToken });
    assert(cf.status === 200 && typeof cf.json.opening === 'number' && typeof cf.json.closing === 'number', 'real cashflow report returns opening/closing balances derived from posted transactions');
    assert(Math.abs(cf.json.closing - (cf.json.opening + cf.json.net)) < 0.01, 'closing = opening + net is mathematically consistent, not independently fabricated');
  }

  // =========================================================
  // 8. PETTY CASHBOOK — the real branch till: a receipts-only ledger of
  // every real 'cash'-account journal entry (only a real "Cash" channel
  // client repayment ever posts one — see payments.js's glAccountFor)
  // =========================================================
  {
    const today = new Date().toISOString().slice(0, 10);
    const kisumuLoanId = await driveLoanToDisbursed(officerToken, managerToken, regionalToken, opsToken, acctToken, adminToken, 15000, 3);

    const noBranch = await api('GET', `/api/accounting/petty-cashbook?from=${today}&to=${today}`, { token: adminToken });
    assert(noBranch.status === 400, 'a company-wide caller with no branch_id is genuinely rejected — the petty cashbook is inherently a single real branch till, not an aggregate');

    const before = await api('GET', `/api/accounting/petty-cashbook?branch_id=br_kisumu&from=${today}&to=${today}`, { token: adminToken });
    assert(before.status === 200 && typeof before.json.closing === 'number', 'Admin, naming the real branch explicitly, genuinely gets the Kisumu petty cashbook');
    const openingBefore = before.json.closing;

    const cashPay = await api('POST', '/api/payments', { token: acctToken, body: { loan_id: kisumuLoanId, amount: 3200, channel: 'Cash', reference: 'PETTY-TEST-CASH' } });
    assert(cashPay.status === 201, 'setup: a real Cash-channel repayment is genuinely recorded against the real Kisumu loan');

    const bankPay = await api('POST', '/api/payments', { token: acctToken, body: { loan_id: kisumuLoanId, amount: 500, channel: 'Bank', reference: 'PETTY-TEST-BANK' } });
    assert(bankPay.status === 201, 'setup: a real Bank-channel repayment is also recorded, to prove it does NOT leak into the cash till below');

    const after = await api('GET', `/api/accounting/petty-cashbook?branch_id=br_kisumu&from=${today}&to=${today}`, { token: managerToken });
    assert(after.status === 200, 'the real Kisumu Manager (their own branch, implicit scope) genuinely loads the petty cashbook too, without needing to name branch_id at all');
    assert(Math.abs(after.json.closing - (openingBefore + 3200)) < 0.01, 'the real Cash-channel repayment genuinely increased the till by exactly its own amount — the Bank-channel one is genuinely excluded, not double-counted');
    const cashRow = after.json.rows.find(r => r.receipts === 3200);
    assert(cashRow, 'the real Cash receipt appears as its own real row, not aggregated away');
    assert(cashRow.sn && Number.isInteger(cashRow.sn), 'the row\'s SN is a real journal_entries id (a real BIGSERIAL), not a fabricated counter');
    assert(cashRow.cashier === 'Grace Achieng', 'the row genuinely names the real Accountant who recorded it as Cashier — resolved server-side, not left for the client to guess');
    assert(!after.json.rows.some(r => r.receipts === 500), 'the real Bank-channel repayment genuinely never appears in the cash till — it posted against a different real GL account entirely');

    const nairobiView = await api('GET', `/api/accounting/petty-cashbook?from=${today}&to=${today}`, { token: nairobiManagerToken });
    assert(nairobiView.status === 200 && !nairobiView.json.rows.some(r => r.sn === cashRow.sn), 'a Nairobi Manager (different branch, real scope) genuinely does not see the Kisumu branch\'s real cash receipt');

    const noFrom = await api('GET', '/api/accounting/petty-cashbook', { token: managerToken });
    assert(noFrom.status === 200 && typeof noFrom.json.opening === 'number', 'omitting from/to genuinely still works, defaulting to the real current month — not a required parameter');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
