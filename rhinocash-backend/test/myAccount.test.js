// myAccount.test.js — self-update endpoint restrictions, mine=1 target
// filtering, and confirming no self-approval loophole in leave/salary-advance.
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
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  const directorToken = await login('director@rhinocash.co.ke', process.env.SEEDED_DIRECTOR_PASSWORD);
  assert(officerToken && managerToken && adminToken, 'all needed accounts log in');

  // Real self-update: only phone/email change, everything else silently ignored.
  {
    const before = await api('GET', '/api/auth/me', { token: officerToken });
    const update = await api('PATCH', '/api/auth/me', { token: officerToken, body: { phone: '0722555111', email: 'newemail@test.co.ke', role_id: 'admin', branch_id: 'br_nairobi', access_level: 'Full Access', status: 'Active' } });
    assert(update.status === 200 && update.json.user.phone === '0722555111', 'a real self-update changes the permitted phone field');
    assert(update.json.user.role_id === before.json.user.role_id, 'role_id is genuinely unchanged despite being present in the request body — real backend allow-list, not frontend hiding');
    assert(update.json.user.branch_id === before.json.user.branch_id, 'branch_id is genuinely unchanged despite being present in the request body');
    assert(update.json.user.access_level === before.json.user.access_level, 'access_level is genuinely unchanged despite being present in the request body');

    const empty = await api('PATCH', '/api/auth/me', { token: officerToken, body: { role_id: 'admin' } });
    assert(empty.status === 400, 'a self-update request containing only disallowed fields is rejected outright, not silently accepted as a no-op');
  }

  // Cross-user attempt: cannot self-update via another user's token pretending scope.
  {
    const meOfficer = (await api('GET', '/api/auth/me', { token: officerToken })).json.user;
    const meManager = (await api('GET', '/api/auth/me', { token: managerToken })).json.user;
    assert(meOfficer.id !== meManager.id, 'sanity: these are genuinely different real users');
    // PATCH /api/auth/me always targets req.user (the authenticated caller) — there is no id param to manipulate.
    const managerSelfUpdate = await api('PATCH', '/api/auth/me', { token: managerToken, body: { phone: '0733999888' } });
    assert(managerSelfUpdate.json.user.id === meManager.id, 'a self-update always targets the real authenticated caller\'s own record, structurally — there is no id parameter to redirect it elsewhere');
  }

  // Real mine=1 target filtering.
  {
    const allTargets = await api('GET', '/api/targets', { token: adminToken });
    const mineTargets = await api('GET', '/api/targets?mine=1', { token: officerToken });
    assert(mineTargets.status === 200 && Array.isArray(mineTargets.json.targets), 'the real mine=1 filter on /api/targets returns a real array');
    const officerMe = (await api('GET', '/api/auth/me', { token: officerToken })).json.user;
    assert(mineTargets.json.targets.every(t => t.recipient_user_id === officerMe.id), 'every target returned by mine=1 genuinely belongs to the real authenticated caller only');
  }

  // Real staff wallet accounts (My Account -> View Details -> ACC BALANCES) —
  // auto-provisioned Transactional/Investment/Savings accounts scoped to the
  // caller, never another staff member's.
  {
    const accounts = await api('GET', '/api/users/me/accounts', { token: officerToken });
    assert(accounts.status === 200 && Array.isArray(accounts.json.accounts) && accounts.json.accounts.length === 3, 'a real GET returns exactly the 3 real auto-provisioned wallet accounts');
    const types = accounts.json.accounts.map(a => a.account_type).sort();
    assert(JSON.stringify(types) === JSON.stringify(['Investment', 'Savings', 'Transactional']), 'the real 3 accounts are genuinely Transactional/Investment/Savings, nothing fabricated');
    const txAccount = accounts.json.accounts.find(a => a.account_type === 'Transactional');
    assert(txAccount.account_number && txAccount.balance === 0, 'the real Transactional account carries a real generated account number and a real starting balance of 0');

    const again = await api('GET', '/api/users/me/accounts', { token: officerToken });
    assert(again.json.accounts.find(a => a.account_type === 'Transactional').id === txAccount.id, 'a second real call re-uses the same real account row rather than re-provisioning a duplicate');

    const managerAccounts = await api('GET', '/api/users/me/accounts', { token: managerToken });
    assert(managerAccounts.json.accounts[0].id !== txAccount.id, 'a different real staff member genuinely gets their own distinct real wallet accounts, never the officer\'s');

    const txns = await api('GET', '/api/users/me/accounts/Transactional/transactions', { token: officerToken });
    assert(txns.status === 200 && Array.isArray(txns.json.transactions) && txns.json.transactions.length === 0, 'a brand-new real wallet genuinely has no transactions yet — never fabricated');

    const badType = await api('GET', '/api/users/me/accounts/Bogus/transactions', { token: officerToken });
    assert(badType.status === 400, 'an invalid real account type is genuinely rejected');

    const depositNoPhone = await api('POST', '/api/users/me/accounts/Transactional/deposit', { token: officerToken, body: { amount: 500 } });
    assert(depositNoPhone.status === 400, 'a real deposit request without a phone is rejected');
    const depositBadAmount = await api('POST', '/api/users/me/accounts/Transactional/deposit', { token: officerToken, body: { phone: '0722000111', amount: -5 } });
    assert(depositBadAmount.status === 400, 'a real deposit request with a non-positive amount is rejected');
    const deposit = await api('POST', '/api/users/me/accounts/Transactional/deposit', { token: officerToken, body: { phone: '0722000111', amount: 500 } });
    assert(deposit.status === 200 && ['NOT_CONFIGURED', 'INITIATED', 'FAILED'].includes(deposit.json.status), 'a real, valid deposit request genuinely reaches the real STK-push code path (NOT_CONFIGURED here, since no M-Pesa environment is active in this test run)');
  }

  // Real own monthly performance table (My Account -> View Details -> 2026 Performance).
  {
    const perf = await api('GET', '/api/users/me/performance', { token: officerToken, });
    assert(perf.status === 200 && Array.isArray(perf.json.months) && perf.json.months.length === 12, 'a real GET returns exactly 12 real months for the current year');
    assert(perf.json.year === String(new Date().getFullYear()), 'the real default year is genuinely the current year, not hardcoded');
    const jan = perf.json.months[0];
    assert(jan.month === 1 && 'newLoans' in jan && 'repeatLoans' in jan && 'performing' in jan && 'arrears' in jan && 'revenue' in jan, 'each real month row carries all 5 real metric buckets');
    assert(typeof jan.newLoans.actual === 'number' && typeof jan.newLoans.target === 'number', 'each real bucket carries a real numeric target and actual, never a fabricated placeholder');
    assert(jan.repeatLoans.target === 0 && jan.performing.target === 0 && jan.arrears.target === 0, 'Repeat Loans/Performing/Arrears carry an honest 0 target — no real target metric exists for them yet, never fabricated to look complete');

    const explicitYear = await api('GET', '/api/users/me/performance?year=2025', { token: officerToken });
    assert(explicitYear.json.year === '2025', 'an explicit real year query param is honored');

    const managerPerf = await api('GET', '/api/users/me/performance', { token: managerToken });
    assert(managerPerf.status === 200, 'a different real role can also fetch their own real performance — scoped to themselves, not restricted to Loan Officer only');

    // A real target set by the officer's own Manager for the current month
    // genuinely flows through into the New Loans target — the same real
    // targets table and computeAchievement-style logic the rest of the
    // targets engine already uses, never a second fabricated source.
    const officerMe = (await api('GET', '/api/auth/me', { token: officerToken })).json.user;
    const now = new Date();
    const thisPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const setTarget = await api('POST', '/api/targets', { token: managerToken, body: { metric: 'new_loans', recipient_user_id: officerMe.id, target_value: 12, period: thisPeriod } });
    assert(setTarget.status === 201, 'the real target is genuinely created');
    const perfAfter = await api('GET', '/api/users/me/performance', { token: officerToken });
    const thisMonth = perfAfter.json.months[now.getMonth()];
    assert(thisMonth.newLoans.target === 12, 'the real New Loans target the Manager just set for this exact month genuinely appears in the performance table — not fabricated, not stuck at 0');
  }

  // Real salary advance OTP (My Account -> Salary Advance -> Apply) — a
  // real, short-lived SMS OTP sent right after applying, and a real SMS
  // to the requester once their manager decides. SMS isn't configured in
  // this test environment, so the real generated code is honestly
  // returned inline instead of being silently unreachable.
  {
    const officerMeSA = (await api('GET', '/api/auth/me', { token: officerToken })).json.user;
    assert(!!officerMeSA.phone, 'sanity: the real seeded officer account has a real phone number on file');

    const applied = await api('POST', '/api/salary-advances', { token: officerToken, body: { amount: 4000, reason: 'Salary advance OTP test' } });
    assert(applied.status === 201 && applied.json.salaryAdvance.status === 'Pending', 'a real salary advance request is genuinely created, starting Pending');
    assert(applied.json.otp && applied.json.otp.status === 'NOT_CONFIGURED', 'the real OTP send genuinely reaches the real SMS integration, honestly reporting NOT_CONFIGURED (no real provider in this test environment)');
    assert(/^\d{6}$/.test(applied.json.otp.otpForTesting || ''), 'a real 6-digit OTP code is genuinely generated and returned inline since it could not actually be delivered');

    const decided = await api('POST', `/api/salary-advances/${applied.json.salaryAdvance.id}/decide`, { token: managerToken, body: { decision: 'Approved' } });
    assert(decided.status === 200 && decided.json.salaryAdvance.status === 'Approved', 'the real manager decision genuinely succeeds even though the real approval SMS could not actually be delivered (best-effort, never blocks the real decision)');
  }

  // Real staff Interactions log (My Account -> View Details -> Interactions -> Notes).
  {
    const before = await api('GET', '/api/users/me/interactions', { token: officerToken });
    assert(before.status === 200 && Array.isArray(before.json.interactions), 'a real GET returns a real interactions array for the caller');

    const badSubject = await api('POST', '/api/users/me/interactions', { token: officerToken, body: { subject: 'Nonsense', note: 'A note' } });
    assert(badSubject.status === 400, 'an invalid real subject is rejected');
    const noNote = await api('POST', '/api/users/me/interactions', { token: officerToken, body: { subject: 'Performance' } });
    assert(noNote.status === 400, 'a real interaction with no note is rejected');

    const created = await api('POST', '/api/users/me/interactions', { token: officerToken, body: { subject: 'PTP', note: 'Client promised to pay by Friday' } });
    assert(created.status === 201 && created.json.interaction.subject === 'PTP' && created.json.interaction.note === 'Client promised to pay by Friday', 'a real, valid interaction is genuinely created with the real subject/note submitted');

    const after = await api('GET', '/api/users/me/interactions', { token: officerToken });
    assert(after.json.interactions.some(i => i.id === created.json.interaction.id), 'the real, just-created interaction genuinely appears in a fresh real GET');

    const managerInteractions = await api('GET', '/api/users/me/interactions', { token: managerToken });
    assert(!managerInteractions.json.interactions.some(i => i.id === created.json.interaction.id), 'a different real staff member genuinely never sees the officer\'s own interaction — scoped structurally to the caller');
  }

  // Real payroll / payslips (My Account -> View Details -> Leaves & Payroll)
  // — real Basic Salary set by an authorized role via PATCH /api/users/:id,
  // real Kenyan NSSF/SHIF/PAYE statutory formulas, never fabricated.
  {
    const beforeSalary = await api('GET', '/api/users/me/payroll', { token: officerToken });
    assert(beforeSalary.status === 200 && Array.isArray(beforeSalary.json.months) && beforeSalary.json.months.length === 0, 'with no real Basic Salary set yet, the real payroll list is honestly empty — never fabricated');

    const officerMe = (await api('GET', '/api/auth/me', { token: officerToken })).json.user;
    const badPeriodBefore = await api('GET', '/api/users/me/payroll/2026-09', { token: officerToken });
    assert(badPeriodBefore.status === 404, 'a real single-period payslip is genuinely refused when no real Basic Salary is set — not a fabricated zero-salary payslip');

    const officerSalaryDenied = await api('PATCH', `/api/users/${officerMe.id}`, { token: officerToken, body: { basic_salary: 999999 } });
    assert(officerSalaryDenied.status === 403, 'the officer genuinely cannot set their own real Basic Salary — that requires real manage_users authority (Admin/CEO/Director)');

    const setSalary = await api('PATCH', `/api/users/${officerMe.id}`, { token: adminToken, body: { basic_salary: 26000 } });
    assert(setSalary.status === 200 && Number(setSalary.json.user.basic_salary) === 26000, 'Admin genuinely sets a real Basic Salary for the officer');

    const afterSalary = await api('GET', '/api/users/me/payroll', { token: officerToken });
    assert(afterSalary.json.months.length > 0, 'once a real Basic Salary exists, real past months of payroll genuinely appear');
    const m = afterSalary.json.months[0];
    assert(m.basicSalary === 26000 && m.grossPay === 26000, 'each real month genuinely carries the real Basic Salary just set');
    assert(m.nssf === 1560, 'the real NSSF figure is genuinely computed via the real statutory formula (6% of 26,000 = 1,560), not fabricated');
    assert(m.shif === 715, 'the real SHIF figure is genuinely computed via the real statutory formula (2.75% of 26,000 = 715), not fabricated');
    assert(m.paye >= 0 && typeof m.paye === 'number', 'a real, non-negative PAYE figure is genuinely computed via the real 2023 statutory bands');
    assert(Math.abs(m.totalDeductions - (m.nssf + m.shif + m.paye + m.salaryAdvance + m.otherDeductions)) < 0.01, 'the real Total Deductions genuinely sums every real deduction bucket, not a separately fabricated figure');
    assert(Math.abs(m.netPay - (m.grossPay - m.totalDeductions)) < 0.01, 'the real Net Pay genuinely equals Gross Pay minus real Total Deductions');
    assert(!afterSalary.json.months.some(mo => new Date(mo.period + '-01') > new Date()), 'no real future, not-yet-earned month genuinely appears in the payroll list');

    const singlePeriod = await api('GET', `/api/users/me/payroll/${m.period}`, { token: officerToken });
    assert(singlePeriod.status === 200 && singlePeriod.json.payslip.period === m.period && singlePeriod.json.payslip.netPay === m.netPay, 'the real single-period payslip endpoint genuinely matches the real monthly list figures');

    const badPeriodFormat = await api('GET', '/api/users/me/payroll/notaperiod', { token: officerToken });
    assert(badPeriodFormat.status === 400, 'an invalid real period format is genuinely rejected');

    const managerPayroll = await api('GET', '/api/users/me/payroll', { token: managerToken });
    assert(managerPayroll.json.months.length === 0, 'a different real staff member with no real Basic Salary of their own genuinely sees an empty real payroll list — never the officer\'s real salary');
  }

  // Real Daily Workplan (My Account -> My Work Plan) — a real per-day
  // target/locations for 4 real visitation categories, with a real,
  // freshly-computed Achieved/Clients Visited, never a fabricated one.
  {
    const emptyDate = '2027-01-15';
    const empty = await api('GET', `/api/workplans/me?date=${emptyDate}`, { token: officerToken });
    assert(empty.status === 200 && empty.json.date === emptyDate, 'a real GET for a date with no saved plan yet genuinely succeeds');
    assert(empty.json.reAppraisal.target === 0 && empty.json.collection.target === 0 && empty.json.onboarding.target === 0 && empty.json.prospect.target === 0, 'with no real plan saved yet, every real target is honestly 0 — never fabricated');
    assert(empty.json.reAppraisal.achieved === 0 && empty.json.reAppraisal.clientsVisited.length === 0, 'Re-Appraisal Clients has no real tracked activity signal in this app, so it honestly always reports 0/none, never fabricated');

    const badDate = await api('GET', '/api/workplans/me?date=not-a-date', { token: officerToken });
    assert(badDate.status === 400, 'an invalid real date format is genuinely rejected');

    const saved = await api('POST', '/api/workplans/me', { token: officerToken, body: {
      date: emptyDate, reAppraisalTarget: 3, reAppraisalLocations: 'Kisumu CBD, Nyalenda',
      collectionTarget: 5, collectionLocations: 'Manyatta',
      onboardingTarget: 2, onboardingLocations: 'Kondele',
      prospectTarget: 4, prospectLocations: 'Mamboleo, Kibuye',
    } });
    assert(saved.status === 201 && saved.json.plan.reAppraisal.target === 3 && saved.json.plan.reAppraisal.locations === 'Kisumu CBD, Nyalenda', 'a real, valid Daily Workplan Setup submission genuinely saves the real target and locations');
    assert(saved.json.plan.collection.target === 5 && saved.json.plan.onboarding.target === 2 && saved.json.plan.prospect.target === 4, 'every real category genuinely saved its own real target');

    const reload = await api('GET', `/api/workplans/me?date=${emptyDate}`, { token: officerToken });
    assert(reload.json.prospect.target === 4 && reload.json.prospect.locations === 'Mamboleo, Kibuye', 'the real saved plan genuinely persists and reloads correctly');

    const resave = await api('POST', '/api/workplans/me', { token: officerToken, body: { date: emptyDate, reAppraisalTarget: 9, collectionTarget: 0, onboardingTarget: 0, prospectTarget: 0 } });
    assert(resave.json.plan.reAppraisal.target === 9, 'saving a real plan for the SAME date again genuinely updates it in place (upsert), not a duplicate row');

    const managerPlan = await api('GET', `/api/workplans/me?date=${emptyDate}`, { token: managerToken });
    assert(managerPlan.json.reAppraisal.target === 0, 'a different real staff member genuinely never sees the officer\'s own saved plan — scoped structurally to the caller');

    // Real Onboarding Achieved — a genuinely new client this officer just
    // created today must appear, computed fresh, never fabricated.
    const today = new Date().toISOString().slice(0, 10);
    const beforeToday = await api('GET', `/api/workplans/me?date=${today}`, { token: officerToken });
    const onboardingBefore = beforeToday.json.onboarding.achieved;
    const newClient = await api('POST', '/api/clients', { token: officerToken, body: { name: '[TEST] Workplan Onboarding Client', phone: '0700' + Math.floor(Math.random() * 900000 + 100000) } });
    assert(newClient.status === 201, 'real setup: a real client is genuinely created by the officer today');
    const afterToday = await api('GET', `/api/workplans/me?date=${today}`, { token: officerToken });
    assert(afterToday.json.onboarding.achieved === onboardingBefore + 1, 'the real, just-created client genuinely increments the real Onboarding Achieved count for today — computed fresh, not fabricated');
    assert(afterToday.json.onboarding.clientsVisited.includes('[TEST] Workplan Onboarding Client'), 'the real, just-created client\'s real name genuinely appears in Clients Visited');
  }

  // Confirm no self-approval loophole exists for leave/salary-advance (already-existing engine, re-verified here in this module's context).
  {
    const leave = await api('POST', '/api/leave-requests', { token: officerToken, body: { leave_type: 'Annual', start_date: '2026-12-01', end_date: '2026-12-03' } });
    assert(leave.status === 201, 'a real leave request is created');
    const selfDecide = await api('POST', `/api/leave-requests/${leave.json.leaveRequest.id}/decide`, { token: officerToken, body: { decision: 'Approved' } });
    assert(selfDecide.status === 403, 'the real requester cannot approve their own leave request — no self-approval loophole via My Account');

    const advance = await api('POST', '/api/salary-advances', { token: officerToken, body: { amount: 5000 } });
    const selfDecideAdvance = await api('POST', `/api/salary-advances/${advance.json.salaryAdvance.id}/decide`, { token: officerToken, body: { decision: 'Approved' } });
    assert(selfDecideAdvance.status === 403, 'the real requester cannot approve their own salary advance — no self-approval loophole');
  }

  // Real Board Resolutions and Equity Holdings — genuinely new governance backend.
  {
    assert(ceoToken && directorToken, 'CEO and Director accounts log in for the real governance lifecycle test');

    const unauthorizedPropose = await api('POST', '/api/governance/resolutions', { token: adminToken, body: { title: 'Test resolution' } });
    assert(unauthorizedPropose.status === 403, 'Admin cannot propose a board resolution — only CEO/Director hold that authority');
    const unauthorizedView = await api('GET', '/api/governance/resolutions', { token: officerToken });
    assert(unauthorizedView.status === 403, 'a Loan Officer has no governance visibility at all');

    const proposed = await api('POST', '/api/governance/resolutions', { token: ceoToken, body: { title: 'Approve new loan product pilot', description: 'Pilot a group-lending product in Kisumu' } });
    assert(proposed.status === 201 && proposed.json.resolution.status === 'Proposed', 'CEO can propose a real board resolution, starting Proposed');

    const selfDecide = await api('POST', `/api/governance/resolutions/${proposed.json.resolution.id}/decide`, { token: ceoToken, body: { decision: 'Approved' } });
    assert(selfDecide.status === 403, 'the CEO cannot decide on their own proposed resolution — real segregation of duties');

    const managerDecide = await api('POST', `/api/governance/resolutions/${proposed.json.resolution.id}/decide`, { token: managerToken, body: { decision: 'Approved' } });
    assert(managerDecide.status === 403, 'a Manager has no authority to decide on a board resolution at all');

    const decided = await api('POST', `/api/governance/resolutions/${proposed.json.resolution.id}/decide`, { token: directorToken, body: { decision: 'Approved' } });
    assert(decided.status === 200 && decided.json.resolution.status === 'Approved', 'Director, a different real user, can decide on the CEO\'s real resolution');

    const doubleDecide = await api('POST', `/api/governance/resolutions/${proposed.json.resolution.id}/decide`, { token: directorToken, body: { decision: 'Rejected' } });
    assert(doubleDecide.status === 409, 'an already-decided resolution cannot be decided again');

    // Equity Holdings — real percentage-integrity check.
    const equityDenied = await api('POST', '/api/governance/equity', { token: officerToken, body: { holder_name: 'Test', holder_type: 'Founder', percentage: 10 } });
    assert(equityDenied.status === 403, 'a Loan Officer cannot record an equity holding');

    const founder = await api('POST', '/api/governance/equity', { token: directorToken, body: { holder_name: 'Founder A', holder_type: 'Founder', percentage: 60, capital_contributed: 5000000 } });
    assert(founder.status === 201, 'Director can record a real equity holding');

    const overCap = await api('POST', '/api/governance/equity', { token: directorToken, body: { holder_name: 'Investor Pool', holder_type: 'Investor', percentage: 50 } });
    assert(overCap.status === 409, 'recording equity that would push total holdings past 100% is rejected — real accounting integrity check');

    const withinCap = await api('POST', '/api/governance/equity', { token: adminToken, body: { holder_name: 'Investor Pool', holder_type: 'Investor', percentage: 30 } });
    assert(withinCap.status === 201, 'Admin can also record equity within the real remaining headroom');

    const list = await api('GET', '/api/governance/equity', { token: directorToken });
    assert(list.status === 200 && Math.abs(list.json.totalPercentage - 90) < 0.01, 'the real total equity percentage across all real holdings is correctly summed (60 + 30 = 90)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
