// staffForms.test.js — HR › Staff Details Form: one form per employee,
// prefilled from their record, saved and edited by HR, with company
// details HR keeps up to date; other roles cannot change it.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}
const login = async (email, pw) => (await api('POST', '/api/auth/login', { body: { email, password: pw } })).json.token;

(async () => {
  // HR's work is done here by the System Administrator, who holds the same HR rights.
  const hr = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const officer = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  assert(hr && officer, 'setup: an HR operator (Admin) and a loan officer sign in');
  const officerId = (await api('GET', '/api/auth/me', { token: officer })).json.user.id;

  const list = await api('GET', '/api/hr/staff-forms', { token: hr });
  const row = list.json && list.json.forms.find(f => f.userId === officerId);
  assert(list.status === 200 && list.json.total === 20 && row && !row.saved && row.filled === 0, '1: HR lists every employee with their form status (not started yet)');
  assert((await api('GET', '/api/hr/staff-forms', { token: officer })).status === 403, '1: a loan officer cannot open HR staff forms');

  const one = await api('GET', `/api/hr/staff-forms/${officerId}`, { token: hr });
  assert(one.status === 200 && one.json.form.full_name && one.json.form.phone && one.json.company && one.json.company.name, '2: a new form comes prefilled from the employee record, with the company letterhead');
  const co0 = one.json.company;
  assert(co0.address === 'Mombasa, Rafiki Building, 3rd Floor' && co0.phone === '+254 758414779' && co0.email === 'info@rhinocash.co.ke', "2: the letterhead carries the company's Mombasa address, phone and email by default");

  const form = Object.assign({}, one.json.form, { residential_address: 'Kisumu, Milimani', em_name: 'Jane Atieno', em_relationship: 'Sister', em_phone: '0711222333',
    nok_name: 'John Otieno', nok_relationship: 'Brother', nok_phone: '0722333444', declaration_date: '2026-10-15', bogus: 'ignored' });
  const save = await api('PUT', `/api/hr/staff-forms/${officerId}`, { token: hr, body: { form } });
  assert(save.status === 200 && save.json.form.em_name === 'Jane Atieno' && save.json.form.bogus === undefined, '3: HR saves the form; unknown fields are dropped');
  assert((await api('PUT', `/api/hr/staff-forms/${officerId}`, { token: officer, body: { form } })).status === 403, '3: a loan officer cannot change the form');
  assert((await api('PUT', `/api/hr/staff-forms/${officerId}`, { token: hr, body: { form: Object.assign({}, form, { declaration_date: 'yesterday' }) } })).status === 400, '3: the declaration date must be a date');
  const again = await api('GET', `/api/hr/staff-forms/${officerId}`, { token: hr });
  assert(again.json.saved && again.json.form.nok_phone === '0722333444' && again.json.updatedBy, '3: the saved form reads back, with who saved it');
  const rowAfter = (await api('GET', '/api/hr/staff-forms', { token: hr })).json.forms.find(f => f.userId === officerId);
  assert(rowAfter.saved && rowAfter.filled >= 12, '3: the list shows how much of the form is filled in');
  const before = (await api('GET', '/api/auth/me', { token: officer })).json.user;
  assert(before.phone === one.json.form.phone, '3: saving the form never changes the employee record itself');

  const co = await api('PUT', '/api/hr/staff-forms/company', { token: hr, body: { name: 'Rhinocash Ltd', tagline: 'Your reliable lending partner', address: 'Mombasa, Nkrumah Road', phone: '+254 700 000 111', email: 'info@rhinocash.co.ke' } });
  assert(co.status === 200 && co.json.company.address === 'Mombasa, Nkrumah Road', '4: HR updates the company details on the form');
  assert((await api('GET', `/api/hr/staff-forms/${officerId}`, { token: hr })).json.company.phone === '+254 700 000 111', '4: every form shows the updated company details');
  assert((await api('PUT', '/api/hr/staff-forms/company', { token: officer, body: { name: 'X' } })).status === 403, '4: only HR changes the company details');
  assert((await api('GET', '/api/hr/staff-forms/usr_does_not_exist', { token: hr })).status === 404, '5: an unknown employee is not found');

  // 6. Employment Contract: offer letter + fixed term contract per employee.
  const cl = await api('GET', '/api/hr/staff-contracts', { token: hr });
  const crow = cl.json && cl.json.contracts.find(c => c.userId === officerId);
  assert(cl.status === 200 && crow && !crow.saved, '6: HR lists every employee with their contract status (not prepared yet)');
  assert((await api('GET', '/api/hr/staff-contracts', { token: officer })).status === 403, '6: a loan officer cannot open employment contracts');
  const c1 = await api('GET', `/api/hr/staff-contracts/${officerId}`, { token: hr });
  assert(c1.status === 200 && c1.json.form.full_name && c1.json.form.period === 'two years' && c1.json.form.reports_to && c1.json.company.address, '6: a new contract starts from the employee record and the standard terms');
  const cform = Object.assign({}, c1.json.form, { position: 'Loan Officer', start_date: '2026-11-01', salary: '35,000', place_of_employment: 'Mombasa', done_at: 'Mombasa', done_day: '15th', done_month: 'October', witness: 'Mary W', hacked: 'x' });
  const cs = await api('PUT', `/api/hr/staff-contracts/${officerId}`, { token: hr, body: { form: cform } });
  assert(cs.status === 200 && cs.json.form.salary === '35000' && cs.json.form.hacked === undefined, '6: HR saves the contract (salary kept as an amount; unknown fields dropped)');
  assert((await api('PUT', `/api/hr/staff-contracts/${officerId}`, { token: hr, body: { form: Object.assign({}, cform, { salary: 'thirty' }) } })).status === 400, '6: the salary must be an amount');
  assert((await api('PUT', `/api/hr/staff-contracts/${officerId}`, { token: hr, body: { form: Object.assign({}, cform, { start_date: 'next week' }) } })).status === 400, '6: the starting date must be a date');
  assert((await api('PUT', `/api/hr/staff-contracts/${officerId}`, { token: officer, body: { form: cform } })).status === 403, '6: a loan officer cannot change a contract');
  const crow2 = (await api('GET', '/api/hr/staff-contracts', { token: hr })).json.contracts.find(c => c.userId === officerId);
  assert(crow2.saved && crow2.startDate === '2026-11-01' && crow2.salary === '35000' && crow2.updatedBy, '6: the list shows the prepared contract, its starting date and salary');
  const cc = await api('PUT', '/api/hr/staff-forms/company', { token: hr, body: { md_name: 'Jane Director' } });
  assert(cc.status === 200 && cc.json.company.md_name === 'Jane Director' && cc.json.company.address === 'Mombasa, Nkrumah Road', "6: HR names the Managing Director without touching the other company details");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
