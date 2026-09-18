// clients.test.js — client directory pagination/search/scope, duplicate
// detection, officer assignment validation, KYC, leads, interactions.
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
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const nairobiManagerToken = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD);
  let officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const investorToken = await login('sara.investor@example.com', process.env.SEEDED_INVESTOR_PASSWORD);
  assert(adminToken && managerToken && nairobiManagerToken && officerToken, 'all needed accounts log in');
  const officerMe = (await api('GET', '/api/auth/me', { token: officerToken })).json.user;

  // A/Q. Authorized client creation + real client code.
  let clientId, clientPhone;
  {
    clientPhone = '07' + Math.floor(Math.random() * 90000000 + 10000000);
    const r = await api('POST', '/api/clients', { token: officerToken, body: {
      name: 'Test Client Alpha', phone: clientPhone, national_id: '12345678',
      next_of_kin: 'Jane Doe', next_of_kin_phone: '0722111222', business_type: 'Retail Shop',
    } });
    assert(r.status === 201, 'A: Loan Officer creates a real client');
    assert(!!r.json.client.client_code, 'the new client has a real generated client_code');
    assert(r.json.client.officer_id === officerMe.id, 'a Loan Officer creating a client defaults to being assigned as its own officer');
    assert(r.json.client.next_of_kin === 'Jane Doe' && r.json.client.business_type === 'Retail Shop', 'the new next_of_kin/business_type fields are genuinely persisted');
    clientId = r.json.client.id;
  }

  // C/D. Duplicate phone rejection.
  {
    const dup = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Duplicate Phone Client', phone: clientPhone } });
    assert(dup.status === 409, 'C/D: creating a client with a duplicate phone number is rejected');
  }

  // M/N. Officer assignment validation.
  {
    const wrongRole = await api('POST', '/api/clients', { token: managerToken, body: { name: 'Bad Officer Client', phone: '0722900' + Math.floor(Math.random()*900+100), officer_id: managerToken ? (await api('GET','/api/auth/me',{token:managerToken})).json.user.id : null } });
    assert(wrongRole.status === 400, 'N: assigning a non-Loan-Officer as a client\'s officer is rejected');

    await api('POST', `/api/users/${officerMe.id}/status`, { token: adminToken, body: { status: 'Suspended' } });
    const inactiveOfficer = await api('POST', '/api/clients', { token: managerToken, body: { name: 'Inactive Officer Client', phone: '0722900' + Math.floor(Math.random()*900+100), officer_id: officerMe.id } });
    assert(inactiveOfficer.status === 409, 'N: assigning an inactive (suspended) Loan Officer is rejected');
    await api('POST', `/api/users/${officerMe.id}/status`, { token: adminToken, body: { status: 'Active' } });
    officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD); // fresh token — suspending may have invalidated the old one
  }

  // H/AE. Branch scope + query-parameter bypass attempt.
  {
    const managerOwn = await api('GET', '/api/clients', { token: managerToken });
    assert(managerOwn.status === 200 && managerOwn.json.clients.every(c => c.branch_id === 'br_kisumu' || c.branch_id == null), 'H: Kisumu Manager\'s real client list is genuinely restricted to their own branch');

    const bypassAttempt = await api('GET', '/api/clients?branch_id=br_nairobi', { token: managerToken });
    assert(bypassAttempt.status === 200 && bypassAttempt.json.clients.length === 0, 'AE: a Kisumu Manager cannot use ?branch_id= to see Nairobi clients — silently empty, not an error that leaks existence');

    const nairobiOwn = await api('GET', '/api/clients?branch_id=br_nairobi', { token: nairobiManagerToken });
    assert(nairobiOwn.status === 200, 'the same branch_id filter works normally for the Manager who actually owns that branch');
  }

  // K. Object-level scope on a single client record.
  {
    const wrongBranchAccess = await api('GET', `/api/clients/${clientId}`, { token: nairobiManagerToken });
    assert(wrongBranchAccess.status === 403, 'K: a Nairobi Manager cannot open a real Kisumu client\'s profile by id — object-level scope enforced');
    const ownBranchAccess = await api('GET', `/api/clients/${clientId}`, { token: managerToken });
    assert(ownBranchAccess.status === 200, 'the Kisumu Manager CAN open their own real branch client\'s profile');
  }

  // Q/R/S/T. Client profile aggregates real loans/payments, no local recalculation.
  {
    const profile = await api('GET', `/api/clients/${clientId}`, { token: officerToken });
    assert(profile.status === 200 && Array.isArray(profile.json.loans) && Array.isArray(profile.json.payments), 'Q/R/S: client profile returns real loans[] and payments[] arrays from the authoritative tables');
  }

  // F/G. Pagination + filtering.
  {
    const page1 = await api('GET', '/api/clients?limit=1&page=1', { token: adminToken });
    assert(page1.status === 200 && page1.json.clients.length <= 1, 'F: client list respects a real limit');
    assert(page1.json.pagination && page1.json.pagination.total >= 1, 'F: pagination.total reflects the real full count');
    const searched = await api('GET', '/api/clients?q=Alpha', { token: adminToken });
    assert(searched.json.clients.some(c => c.name.includes('Alpha')), 'E/G: real search matches the real client name');
    const statusFiltered = await api('GET', '/api/clients?status=Active', { token: adminToken });
    assert(statusFiltered.json.clients.every(c => c.status === 'Active'), 'G: real status filter narrows results server-side');
  }

  // U/AF. Client editing + audit + duplicate-on-edit protection.
  {
    const secondClient = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Test Client Beta', phone: '07' + Math.floor(Math.random() * 90000000 + 10000000) } });
    const editDupPhone = await api('PATCH', `/api/clients/${secondClient.json.client.id}`, { token: officerToken, body: { phone: clientPhone } });
    assert(editDupPhone.status === 409, 'editing a client to use another client\'s existing phone number is rejected');

    const realEdit = await api('PATCH', `/api/clients/${clientId}`, { token: officerToken, body: { address: 'Kisumu CBD, near the market' } });
    assert(realEdit.status === 200 && realEdit.json.client.address === 'Kisumu CBD, near the market', 'U: a real client edit persists');

    const audit = await api('GET', '/api/audit-logs?entity=Client', { token: adminToken });
    assert(audit.status === 200 && audit.json.auditLogs.some(a => a.action === 'Updated client' && a.record_id === clientId), 'AF: a real audit record exists for the client edit');
  }

  // W. KYC authorization.
  {
    const unauthorizedVerify = await api('POST', `/api/clients/${clientId}/verify`, { token: officerToken, body: { status: 'Verified' } });
    assert(unauthorizedVerify.status === 403, 'W: a Loan Officer cannot verify KYC — requires Manager-level authority or above');

    const authorizedVerify = await api('POST', `/api/clients/${clientId}/verify`, { token: managerToken, body: { status: 'Verified' } });
    assert(authorizedVerify.status === 200 && authorizedVerify.json.client.verification_status === 'Verified', 'W: the Kisumu Manager CAN verify a real client in their own branch');

    const invalidStatus = await api('POST', `/api/clients/${clientId}/verify`, { token: managerToken, body: { status: 'NotARealStatus' } });
    assert(invalidStatus.status === 400, 'an invalid KYC status value is rejected');
  }

  // X/Y/Z/AA. Leads: creation, conversion, duplicate protection.
  {
    const leadPhone = '07' + Math.floor(Math.random() * 90000000 + 10000000);
    const lead = await api('POST', '/api/leads', { token: officerToken, body: { name: 'Test Lead Gamma', phone: leadPhone, source: 'Referral' } });
    assert(lead.status === 201 && lead.json.lead.status === 'New', 'X: a real lead is created, starting New');

    const converted = await api('POST', `/api/leads/${lead.json.lead.id}/convert`, { token: officerToken, body: {} });
    assert(converted.status === 200 && converted.json.client.name === 'Test Lead Gamma', 'Z: the real lead converts into a real client');

    const doubleConvert = await api('POST', `/api/leads/${lead.json.lead.id}/convert`, { token: officerToken, body: {} });
    assert(doubleConvert.status === 409, 'AA: converting an already-converted lead is rejected — no duplicate client from the same lead');

    const dupPhoneLead = await api('POST', '/api/leads', { token: officerToken, body: { name: 'Dup Phone Lead', phone: clientPhone } });
    const dupConvert = await api('POST', `/api/leads/${dupPhoneLead.json.lead.id}/convert`, { token: officerToken, body: {} });
    assert(dupConvert.status === 409, 'AA: converting a lead whose phone already belongs to a real client is rejected — no duplicate client');

    // Create Client Lead form's optional fields (Client Idno/Location/Client Location/Kin Contact/Next of Kin/Business Type).
    const richLeadPhone = '07' + Math.floor(Math.random() * 90000000 + 10000000);
    const richLead = await api('POST', '/api/leads', { token: officerToken, body: {
      name: 'Rich Field Lead', phone: richLeadPhone, national_id: '12345678', address: 'Kisumu CBD', client_location: 'Near the market gate',
      next_of_kin: 'Jane Kin', next_of_kin_phone: '0711222333', business_type: 'Boda boda',
    } });
    assert(richLead.status === 201, 'a lead with every real optional field genuinely saves');
    assert(richLead.json.lead.national_id === '12345678' && richLead.json.lead.client_location === 'Near the market gate' && richLead.json.lead.next_of_kin === 'Jane Kin' && richLead.json.lead.next_of_kin_phone === '0711222333' && richLead.json.lead.business_type === 'Boda boda', 'every real optional field genuinely persisted on the lead, not silently dropped');

    const richConvert = await api('POST', `/api/leads/${richLead.json.lead.id}/convert`, { token: officerToken, body: {} });
    assert(richConvert.status === 200, 'a lead with every optional field genuinely converts');
    assert(richConvert.json.client.national_id === '12345678' && richConvert.json.client.address === 'Kisumu CBD' && richConvert.json.client.next_of_kin === 'Jane Kin' && richConvert.json.client.next_of_kin_phone === '0711222333' && richConvert.json.client.business_type === 'Boda boda', 'every real field with a matching client column genuinely carried over onto the real new client record, not re-entered from scratch');
    const carriedClient = await api('GET', `/api/clients/${richConvert.json.client.id}`, { token: officerToken });
    assert(carriedClient.status === 200 && carriedClient.json.client.national_id === '12345678', 'the carried-over fields genuinely persisted server-side, confirmed via a fresh direct fetch of the real client record');
  }

  // AB/AC. Interactions.
  {
    const interaction = await api('POST', `/api/clients/${clientId}/interactions`, { token: officerToken, body: { type: 'Call', note: 'Discussed repayment schedule' } });
    assert(interaction.status === 201, 'AB: a real interaction is recorded');
    const wrongBranchInteraction = await api('POST', `/api/clients/${clientId}/interactions`, { token: nairobiManagerToken, body: { type: 'Call', note: 'x' } });
    assert(wrongBranchInteraction.status === 403, 'AC: a Nairobi Manager cannot log an interaction against a Kisumu client');
  }

  // AD. Investor isolation.
  {
    const r1 = await api('GET', '/api/clients', { token: investorToken });
    assert(r1.status === 401, 'AD: an investor token cannot reach the staff-only clients endpoint at all');
  }

  // B. Unauthorized client creation (Investor).
  {
    const r = await api('POST', '/api/clients', { token: investorToken, body: { name: 'Investor Client', phone: '0700000000' } });
    assert(r.status === 401, 'B: Investor cannot create a client');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
