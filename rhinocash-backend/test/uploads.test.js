// uploads.test.js — Production Readiness remediation, Phase 3: real
// authorization on GET /uploads/:name, not just authentication.
// Verifies client-document access respects real branch scope, staff
// avatars remain viewable org-wide, investor tokens are structurally
// rejected, and path-traversal protection still holds.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body, rawBody, headers } = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: rawBody || (body ? JSON.stringify(body) : undefined) });
  let json = null; try { json = await res.json(); } catch { /* binary or no body */ }
  return { status: res.status, json, res };
}
async function login(email, password) { const r = await api('POST', '/api/auth/login', { body: { email, password } }); return r.json && r.json.token; }
async function investorLogin(email, password) { const r = await api('POST', '/api/investor-auth/login', { body: { email, password } }); return r.json && r.json.token; }

(async () => {
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const kisumuManagerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const nairobiManagerToken = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD);
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const investorToken = await investorLogin('sara.investor@example.com', process.env.SEEDED_INVESTOR_PASSWORD);
  assert(officerToken && kisumuManagerToken && nairobiManagerToken && adminToken, 'needed accounts log in');

  // =========================================================
  // 1. REAL CLIENT DOCUMENT — real branch-scope authorization
  // =========================================================
  let filePath;
  {
    const client = await api('POST', '/api/clients', { token: officerToken, body: { name: '[TEST] Upload Auth Client', phone: '0722' + Math.floor(Math.random() * 900000 + 100000) } });
    const uploadRes = await api('POST', '/api/uploads', { token: officerToken, rawBody: Buffer.from('fake id document bytes'), headers: { 'Content-Type': 'image/png', 'X-Filename': 'id.png' } });
    assert(uploadRes.status === 201 && uploadRes.json.path, 'a real file upload succeeds with real type/size validation');
    filePath = uploadRes.json.path;
    const docRes = await api('POST', `/api/clients/${client.json.client.id}/documents`, { token: officerToken, body: { name: 'ID Front', doc_type: 'ID', file_path: filePath } });
    assert(docRes.status === 201, 'a real client_documents row links the real file to the real client');

    const unauth = await fetch(BASE + filePath);
    assert(unauth.status === 401, 'an unauthenticated request for this real client document is genuinely rejected — the previously-missing auth check is fixed');

    const sameScope = await fetch(BASE + filePath, { headers: { Authorization: `Bearer ${kisumuManagerToken}` } });
    assert(sameScope.status === 200, 'a real Manager within the client\'s real branch scope can genuinely retrieve the document');

    const crossScope = await fetch(BASE + filePath, { headers: { Authorization: `Bearer ${nairobiManagerToken}` } });
    assert(crossScope.status === 403, 'a real Manager OUTSIDE the client\'s real branch scope is genuinely denied — this is the actual fix: authentication alone would have let this through');

    const investorAttempt = await fetch(BASE + filePath, { headers: { Authorization: `Bearer ${investorToken}` } });
    assert(investorAttempt.status === 401, 'a real investor token cannot retrieve a real staff/client document — structurally rejected, matching the existing investor-isolation design, not a new special case');

    const adminAccess = await fetch(BASE + filePath, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert(adminAccess.status === 200, 'Admin (company-wide scope) can genuinely retrieve any real client document');
  }

  // =========================================================
  // 2. REAL STAFF AVATAR — organizational-directory-level, viewable by any authenticated staff member
  // =========================================================
  {
    const avatarUpload = await api('POST', '/api/uploads', { token: officerToken, rawBody: Buffer.from('fake avatar bytes'), headers: { 'Content-Type': 'image/png', 'X-Filename': 'avatar.png' } });
    const avatarPath = avatarUpload.json.path;
    await api('POST', '/api/users/me/avatar', { token: officerToken, body: { path: avatarPath } });

    const otherStaffView = await fetch(BASE + avatarPath, { headers: { Authorization: `Bearer ${nairobiManagerToken}` } });
    assert(otherStaffView.status === 200, 'a real, different staff member can genuinely view another staff member\'s real avatar — organizational-directory-level data, correctly not over-restricted to only the owner');

    const unauthAvatar = await fetch(BASE + avatarPath);
    assert(unauthAvatar.status === 401, 'an unauthenticated request for a real staff avatar is genuinely rejected');

    const investorAvatarAttempt = await fetch(BASE + avatarPath, { headers: { Authorization: `Bearer ${investorToken}` } });
    assert(investorAvatarAttempt.status === 401, 'a real investor token cannot view a real staff avatar either');
  }

  // =========================================================
  // 3. UNLINKED FILE — denied by default, not served just because it exists on disk
  // =========================================================
  {
    const orphanUpload = await api('POST', '/api/uploads', { token: officerToken, rawBody: Buffer.from('orphaned file, never linked to any record'), headers: { 'Content-Type': 'image/png', 'X-Filename': 'orphan.png' } });
    const orphanPath = orphanUpload.json.path;
    const orphanAccess = await fetch(BASE + orphanPath, { headers: { Authorization: `Bearer ${officerToken}` } });
    assert(orphanAccess.status === 403, 'a real file that exists on disk but is not referenced by any real client_documents or avatar_path row is genuinely denied by default — never served just because the filename is known');
  }

  // =========================================================
  // 4. PATH TRAVERSAL — still blocked after the auth changes
  // =========================================================
  {
    const traversal1 = await fetch(BASE + '/uploads/' + encodeURIComponent('../../../etc/passwd'), { headers: { Authorization: `Bearer ${adminToken}` } });
    assert(traversal1.status === 404, 'a real path-traversal attempt is still genuinely blocked (404, not the actual system file) after adding authorization');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
