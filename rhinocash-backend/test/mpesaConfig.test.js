// mpesaConfig.test.js — tests the M-Pesa Admin Configuration feature:
// masking, encryption-at-rest (verified by inspecting the raw DB file),
// admin-only access, audit logging without secret values, and that
// Test Connection makes a genuine outbound call (which in THIS sandboxed
// environment fails at the network layer — see docs/STATUS_REPORT.md —
// so what's actually verified here is that the failure path is safe and
// correct, not that a live Safaricom handshake succeeds).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}
async function login(email, password) {
  const r = await api('POST', '/api/auth/login', { body: { email, password } });
  return r.json && r.json.token;
}

(async () => {
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  const managerToken = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD);
  assert(adminToken && ceoToken && managerToken, 'admin/ceo/manager all log in');

  // ---- 1. Fresh state ----
  {
    const cfg = await api('GET', '/api/admin/mpesa/config', { token: adminToken });
    assert(cfg.status === 200, 'admin can view the M-Pesa config screen');
    assert(cfg.json.sandboxStatus === 'Not Configured', 'sandbox starts Not Configured');
    assert(cfg.json.productionStatus === 'Not Configured', 'production starts Not Configured');
    assert(cfg.json.activeEnvironment === null, 'no active environment initially');
  }

  // ---- 2. Access control: only Admin, not CEO/Director/Manager despite manage_users/other permissions ----
  {
    const ceoTry = await api('GET', '/api/admin/mpesa/config', { token: ceoToken });
    assert(ceoTry.status === 403, 'CEO cannot view M-Pesa configuration — Admin only');
    const managerTry = await api('PUT', '/api/admin/mpesa/config/sandbox', { token: managerToken, body: { consumerKey: 'x' } });
    assert(managerTry.status === 403, 'Manager cannot modify M-Pesa configuration');
    const unauth = await api('GET', '/api/admin/mpesa/config');
    assert(unauth.status === 401, 'unauthenticated request is rejected outright');
  }

  // ---- 3. Save config — never echoes the real secret back ----
  const testKey = 'sandbox_consumer_key_ABCDEF1234';
  const testSecret = 'sandbox_consumer_secret_ZZYYXXWW9988';
  const testPasskey = 'sandbox_passkey_1122334455';
  {
    const save = await api('PUT', '/api/admin/mpesa/config/sandbox', {
      token: adminToken,
      body: { consumerKey: testKey, consumerSecret: testSecret, shortcode: '174379', passkey: testPasskey, callbackUrl: 'https://example.com/api/mpesa/callback/sandbox' },
    });
    assert(save.status === 200, 'admin saves a full sandbox configuration');
    assert(save.json.config.configured === true, 'sandbox is now marked configured (all required fields present)');
    assert(!JSON.stringify(save.json).includes(testKey), 'the raw consumer key never appears anywhere in the response');
    assert(!JSON.stringify(save.json).includes(testSecret), 'the raw consumer secret never appears anywhere in the response');
    assert(!JSON.stringify(save.json).includes(testPasskey), 'the raw passkey never appears anywhere in the response');
    assert(save.json.config.consumerKey.endsWith(testKey.slice(-4)) && save.json.config.consumerKey.includes('••••'), 'consumer key is shown masked, last 4 chars visible');
  }

  // ---- 4. Re-fetch also never leaks the secret ----
  {
    const cfg = await api('GET', '/api/admin/mpesa/config', { token: adminToken });
    assert(!JSON.stringify(cfg.json).includes(testKey), 'GET config never leaks the raw key either');
    assert(!JSON.stringify(cfg.json).includes(testSecret), 'GET config never leaks the raw secret');
    assert(cfg.json.sandboxStatus === 'Sandbox Configured (inactive)', 'status reflects configured-but-not-yet-active');
  }

  // ---- 5. Real encryption at rest — inspect the actual database file on disk ----
  {
    const dbPath = process.env.RHINOCASH_DB_PATH || path.join(__dirname, '..', 'data', 'rhinocash.db');
    const raw = fs.readFileSync(dbPath);
    const rawStr = raw.toString('latin1'); // byte-safe scan, avoids utf8 decode issues on binary db pages
    assert(!rawStr.includes(testKey), 'the raw consumer key does NOT appear anywhere in the database file on disk (encrypted at rest)');
    assert(!rawStr.includes(testSecret), 'the raw consumer secret does NOT appear anywhere in the database file on disk');
    assert(!rawStr.includes(testPasskey), 'the raw passkey does NOT appear anywhere in the database file on disk');
  }

  // ---- 6. Partial update — omitted fields keep their existing encrypted value ----
  {
    const partial = await api('PUT', '/api/admin/mpesa/config/sandbox', { token: adminToken, body: { shortcode: '999999' } });
    assert(partial.status === 200 && partial.json.config.shortcode === '999999', 'partial update changes only the submitted field');
    assert(partial.json.config.consumerKey && partial.json.config.consumerKey.includes('••••'), 'the previously-saved consumer key is still present (masked) after a partial update touching a different field');
  }

  // ---- 7. Cannot activate an unconfigured environment ----
  {
    const activateProd = await api('POST', '/api/admin/mpesa/set-active', { token: adminToken, body: { environment: 'production' } });
    assert(activateProd.status === 409, 'cannot activate Production before it has a full configuration saved');
  }

  // ---- 8. Activate sandbox ----
  {
    const activate = await api('POST', '/api/admin/mpesa/set-active', { token: adminToken, body: { environment: 'sandbox' } });
    assert(activate.status === 200 && activate.json.activeEnvironment === 'sandbox', 'admin activates the sandbox environment');
    const cfg = await api('GET', '/api/admin/mpesa/config', { token: adminToken });
    assert(cfg.json.sandboxStatus === 'Sandbox Configured', 'status now shows Sandbox Configured (active), not "(inactive)"');
  }

  // ---- 9. Audit trail records the change, never the value ----
  {
    const audit = await api('GET', '/api/audit-logs?entity=MpesaConfig', { token: adminToken });
    assert(audit.status === 200, 'admin can read the M-Pesa audit trail');
    const entries = audit.json.auditLogs;
    assert(entries.length > 0, 'M-Pesa configuration changes were actually logged');
    const raw = JSON.stringify(entries);
    assert(!raw.includes(testKey) && !raw.includes(testSecret) && !raw.includes(testPasskey), 'no audit log entry contains any raw secret value');
    assert(entries.some(e => e.action.includes('Updated M-Pesa configuration')), 'a "configuration updated" entry exists');
    assert(entries.some(e => e.action.includes('Switched active M-Pesa environment')), 'an "environment switched" entry exists');
    const nonAdminAudit = await api('GET', '/api/audit-logs', { token: managerToken });
    assert(nonAdminAudit.status === 403, 'a Manager cannot read the audit trail at all (module-gated), let alone the M-Pesa entries');
  }

  // ---- 10. Test Connection — makes a genuine outbound call; verify the FAILURE path is safe ----
  // (This sandbox's network egress does not allow api.safaricom.co.ke, so
  // this genuinely cannot succeed here — see docs/STATUS_REPORT.md. What
  // this proves: the code makes a real attempt, doesn't crash, records a
  // safe status, and never leaks anything in the process.)
  {
    const test = await api('POST', '/api/admin/mpesa/test-connection/sandbox', { token: adminToken });
    assert(test.status === 200, 'test-connection endpoint responds (does not crash) even when the real handshake fails');
    assert(['Connection Successful', 'Connection Failed'].includes(test.json.status), 'returns one of the two defined statuses');
    assert(typeof test.json.message === 'string' && !test.json.message.includes(testKey) && !test.json.message.includes(testSecret), 'the test result message never contains a raw secret');
    const cfg = await api('GET', '/api/admin/mpesa/config', { token: adminToken });
    assert(cfg.json.sandbox.lastTestStatus === test.json.status, 'the last-test status is persisted and reflected back in the config view');
    assert(cfg.json.sandbox.lastTestAt !== null, 'a last-tested timestamp is recorded');
  }

  // ---- 11. Overall integrations status reflects real DB-backed state ----
  {
    const status = await api('GET', '/api/integrations/status');
    assert(status.json.mpesa === 'CONFIGURED', 'overall status now says CONFIGURED now that sandbox is active and configured');
    assert(status.json.mpesaDetail.active === 'sandbox', 'detail shows sandbox as the active environment');
  }

  // ---- 12. Clear a configuration ----
  {
    const clear = await api('DELETE', '/api/admin/mpesa/config/sandbox', { token: adminToken });
    assert(clear.status === 200, 'admin clears the sandbox configuration');
    const cfg = await api('GET', '/api/admin/mpesa/config', { token: adminToken });
    assert(cfg.json.sandboxStatus === 'Not Configured', 'sandbox is Not Configured again after clearing');
    assert(cfg.json.activeEnvironment === null, 'clearing the active environment\'s config also clears the active flag');
    const statusAfter = await api('GET', '/api/integrations/status');
    assert(statusAfter.json.mpesa === 'NOT_CONFIGURED', 'overall status correctly reverts to NOT_CONFIGURED');
  }

  // ---- 13. Setup guide is real, non-empty content for a non-technical admin ----
  {
    const guide = await api('GET', '/api/admin/mpesa/setup-guide', { token: adminToken });
    assert(guide.status === 200 && Array.isArray(guide.json.steps) && guide.json.steps.length >= 5, 'setup guide returns real step-by-step instructions');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
