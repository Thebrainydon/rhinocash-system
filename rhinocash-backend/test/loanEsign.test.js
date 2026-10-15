// loanEsign.test.js — loan application forms signed digitally by the
// borrower and guarantors, each confirmed with a code sent to their phone.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
const __activeLoginToken = new Map();
async function api(method, path, { token, body } = {}) {
  const isLogin = method === 'POST' && path === '/api/auth/login';
  const doFetch = async () => {
    const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  let result = await doFetch();
  if (isLogin && result.status === 409 && result.json && result.json.code === 'ALREADY_LOGGED_IN') {
    const prior = __activeLoginToken.get(body.email);
    if (prior) { await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${prior}` } }).catch(() => {}); result = await doFetch(); }
  }
  if (isLogin && result.status === 200) __activeLoginToken.set(body.email, result.json.token);
  return result;
}
const login = async (email, password) => (await api('POST', '/api/auth/login', { body: { email, password } })).json.token;
const SIG = 'data:image/png;base64,' + Buffer.alloc(400, 7).toString('base64');

(async () => {
  const t = { officer: await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD), manager: await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD) };
  assert(t.officer && t.manager, 'setup: officer and manager sign in');
  const products = (await api('GET', '/api/loan-products', { token: t.officer })).json.products;
  const product = products.find(p => p.processing_fee_amount == null && !p.term_weeks) || products[0];
  const mkClient = async phone => (await api('POST', '/api/clients', { token: t.officer, body: { name: 'Esign ' + Math.random().toString(36).slice(2, 8), national_id: String(Math.floor(Math.random() * 9e7 + 1e7)), ...(phone ? { phone } : {}) } })).json.client;
  const client = await mkClient('0712' + Math.floor(Math.random() * 900000 + 100000));
  const base = { client_id: client.id, product_id: product.id, principal: product.min_amount, term_months: product.min_term || 3, business_type: 'fish seller',
    guarantor: 'Sidi Bomubomu', guarantor_contact: '0113665730', guarantor_id_number: '26215825', guarantor_relationship: 'SISTER', esign: true,
    collaterals: [{ category: 'Household Items', security_type: 'bed', details: 'wooden bed' }] };

  // 1. Saving from the app starts the form and waits for signatures
  const created = await api('POST', '/api/loans', { token: t.officer, body: base });
  const loan = created.json && created.json.loan;
  assert(created.status === 201 && loan.status === 'Pending signatures' && Number(loan.esign_required) === 1 && Number(loan.application_no) >= 100001, '1: the application is saved as Pending signatures with an application number');
  assert(loan.guarantor_id_number === '26215825' && loan.guarantor_relationship === 'SISTER', '1: the guarantor ID and relationship are stored');
  const ap0 = await api('POST', `/api/loans/${loan.id}/approve`, { token: t.manager, body: {} });
  if (ap0.status !== 409) console.log('ap0', ap0.status, ap0.json);
  assert(ap0.status === 409 && /sign/.test(ap0.json.error), '1: nobody can approve before everyone has signed');
  const es = await api('GET', `/api/loans/${loan.id}/esign`, { token: t.officer });
  const borrower = es.json.signers.find(s => s.role === 'borrower'), guar = es.json.signers.find(s => s.role === 'guarantor');
  assert(es.status === 200 && es.json.form && es.json.form.client.name === client.name && es.json.form.guarantors[0].relationship === 'SISTER' && es.json.form.collateral[0].type === 'bed', '1: the generated form holds the client, guarantor and collateral');
  assert(borrower && guar && borrower.token && guar.token && borrower.status === 'Pending', '1: the borrower and the guarantor each have a signing link');
  assert(es.json.form.schedule.length > 0 && es.json.form.loan.amount === Number(product.min_amount), '1: the form includes the repayment schedule and amount');

  // 2. Public signing page for the borrower
  assert((await api('GET', '/api/esign/not-a-real-token-1234567890')).status === 404, '2: an unknown link is refused');
  const gEarly = await api('GET', `/api/esign/${guar.token}`);
  assert(gEarly.status === 409, '2: the guarantor link waits until the borrower has signed');
  const page = await api('GET', `/api/esign/${borrower.token}`);
  assert(page.status === 200 && page.json.signer.role === 'borrower' && page.json.form.applicationNo && !String(page.json.signer.phone).includes(client.phone.slice(4, 7)) , '2: the borrower sees the form; the phone number is masked');
  const noOtp = await api('POST', `/api/esign/${borrower.token}/sign`, { body: { signature: SIG, otp: '123456' } });
  assert(noOtp.status === 400, '2: signing needs a code that was requested');
  const o1 = await api('POST', `/api/esign/${borrower.token}/otp`);
  assert(o1.status === 200 && /^\d{6}$/.test(o1.json.otpForTesting || ''), '2: a code is issued (shown here only because SMS is off in tests)');
  assert((await api('POST', `/api/esign/${borrower.token}/otp`)).status === 429, '2: codes cannot be requested again within a minute');
  const wrong = await api('POST', `/api/esign/${borrower.token}/sign`, { body: { signature: SIG, otp: o1.json.otpForTesting === '111111' ? '222222' : '111111' } });
  assert(wrong.status === 400 && wrong.json.code === 'INVALID_OTP', '2: a wrong code is refused');
  const empty = await api('POST', `/api/esign/${borrower.token}/sign`, { body: { signature: 'data:image/png;base64,AAAA', otp: o1.json.otpForTesting } });
  assert(empty.status === 400, '2: an empty signature is refused');
  const s1 = await api('POST', `/api/esign/${borrower.token}/sign`, { body: { signature: SIG, otp: o1.json.otpForTesting } });
  assert(s1.status === 200 && s1.json.signed && !s1.json.allSigned && s1.json.remaining === 1, '2: the borrower signs; one guarantor remains');
  assert((await api('POST', `/api/esign/${borrower.token}/sign`, { body: { signature: SIG, otp: o1.json.otpForTesting } })).status === 409, '2: the link cannot be used to sign twice');

  // 3. Guarantor links are sent after the borrower signs
  const sendG = await api('POST', `/api/loans/${loan.id}/esign/send-guarantors`, { token: t.officer });
  assert(sendG.status === 200 && sendG.json.total === 1, '3: Send / Remind Guarantor Sign Links works once the borrower has signed');
  const es2 = await api('GET', `/api/loans/${loan.id}/esign`, { token: t.officer });
  const g2 = es2.json.signers.find(s => s.role === 'guarantor'), b2 = es2.json.signers.find(s => s.role === 'borrower');
  assert(g2.status === 'Link sent' && b2.status === 'Signed' && /^data:image\/png;base64,/.test(b2.signature || '') && b2.token === null, '3: the guarantor shows Link sent; the borrower\'s signature is on record');
  const o2 = await api('POST', `/api/esign/${guar.token}/otp`);
  const s2 = await api('POST', `/api/esign/${guar.token}/sign`, { body: { signature: SIG, otp: o2.json.otpForTesting } });
  assert(s2.status === 200 && s2.json.allSigned === true, '3: the guarantor signs and the form is complete');
  const after = (await api('GET', `/api/loans/${loan.id}`, { token: t.officer })).json.loan;
  assert(after.status === 'Waiting for Manager', '3: the application moves to its first approval step');
  const ap1 = await api('POST', `/api/loans/${loan.id}/approve`, { token: t.manager, body: {} });
  if (ap1.status !== 200) console.log('ap1', ap1.status, ap1.json);
  assert(ap1.status === 200, '3: the manager can now approve it');

  // 4. Rules around the flow
  const plain = await api('POST', '/api/loans', { token: t.officer, body: { ...base, esign: undefined } });
  assert(plain.status === 201 && plain.json.loan.status === 'Waiting for Manager', '4: an application created without e-signing (API) keeps the old behaviour');
  const noPhone = await mkClient('0713' + Math.floor(Math.random() * 900000 + 100000));
  await require('../src/db').run('UPDATE clients SET phone = NULL WHERE id = ?', [noPhone.id]); // older records may have no phone
  assert((await api('POST', '/api/loans', { token: t.officer, body: { ...base, client_id: noPhone.id } })).status === 400, '4: e-signing needs the client\'s phone number');
  assert((await api('POST', '/api/loans', { token: t.officer, body: { ...base, guarantor_contact: '' } })).status === 400, '4: e-signing needs the guarantor\'s phone number');

  const l2 = (await api('POST', '/api/loans', { token: t.officer, body: base })).json.loan;
  const tok2 = (await api('GET', `/api/loans/${l2.id}/esign`, { token: t.officer })).json.signers[0].token;
  assert((await api('POST', `/api/loans/${l2.id}/esign/send-guarantors`, { token: t.officer })).status === 409, '4: guarantor links wait for the borrower');
  const sb = await api('POST', `/api/loans/${l2.id}/esign/send-borrower`, { token: t.officer });
  assert(sb.status === 200 && /SMS is not switched on/.test(sb.json.message), '4: sending the borrower link says honestly when SMS is off');
  const ed = await api('PATCH', `/api/loans/${l2.id}`, { token: t.officer, body: { principal: Number(product.min_amount) + 1 } });
  const tok2b = (await api('GET', `/api/loans/${l2.id}/esign`, { token: t.officer })).json.signers[0].token;
  assert(ed.status === 200 && tok2b !== tok2 && (await api('GET', `/api/esign/${tok2}`)).status === 404, '4: editing the application issues a fresh form; the old link stops working');
  const o3 = await api('POST', `/api/esign/${tok2b}/otp`);
  await api('POST', `/api/esign/${tok2b}/sign`, { body: { signature: SIG, otp: o3.json.otpForTesting } });
  const regen = await api('POST', `/api/loans/${l2.id}/esign/generate`, { token: t.officer, body: {} });
  assert(regen.status === 409 && regen.json.code === 'SIGNED_ALREADY', '4: regenerating after someone signed asks for confirmation first');
  assert((await api('DELETE', `/api/loans/${l2.id}`, { token: t.officer, body: {} })).status === 403, '4: a Loan Officer cannot delete an application, even their own');
  assert((await api('DELETE', `/api/loans/${l2.id}`, { token: t.manager, body: {} })).status === 200, '4: an approver can delete an application that has not been approved');
  assert((await api('GET', `/api/loans/${l2.id}`, { token: t.officer })).json.loan.status === 'Cancelled' && (await api('GET', `/api/esign/${tok2b}`)).status === 410, '4: a deleted application is Cancelled and its links are withdrawn');
  assert((await api('DELETE', `/api/loans/${loan.id}`, { token: t.officer, body: {} })).status === 409, '4: an application already approved by someone cannot be deleted');
  assert((await api('GET', `/api/loans/${loan.id}/esign`)).status === 401, '4: the staff form view needs sign-in');

  const l3 = (await api('POST', '/api/loans', { token: t.officer, body: base })).json.loan;
  const tok3 = (await api('GET', `/api/loans/${l3.id}/esign`, { token: t.officer })).json.signers[0].token;
  const { run } = require('../src/db');
  await run(`UPDATE loan_esign_signers SET token_expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?`, [tok3]);
  assert((await api('GET', `/api/esign/${tok3}`)).status === 410, '4: an expired link is refused');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
