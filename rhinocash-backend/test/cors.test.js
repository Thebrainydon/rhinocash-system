// cors.test.js — real CORS preflight handling. Routes are only ever
// registered for the real HTTP methods (GET/POST/PATCH/PUT/DELETE), never
// OPTIONS, so a browser's preflight request depends entirely on the router
// running the CORS middleware before route matching — this is exactly the
// gap that let every OPTIONS request 404 despite server.js's own CORS
// middleware already being written correctly.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }

async function preflight(path, method) {
  const res = await fetch(BASE + path, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:3000',
      'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': 'Content-Type, Authorization',
    },
  });
  return res;
}

(async () => {
  // =========================================================
  // 1. OPTIONS /api/auth/login — the exact reported repro
  // =========================================================
  {
    const res = await preflight('/api/auth/login', 'POST');
    assert(res.status === 204 || res.status === 200, `OPTIONS /api/auth/login returns a real successful status, not 404 (got ${res.status})`);
    assert(res.headers.get('access-control-allow-origin'), 'OPTIONS /api/auth/login response carries a real Access-Control-Allow-Origin header');
    assert(res.headers.get('access-control-allow-methods'), 'OPTIONS /api/auth/login response carries a real Access-Control-Allow-Methods header');
    assert(res.headers.get('access-control-allow-headers'), 'OPTIONS /api/auth/login response carries a real Access-Control-Allow-Headers header');
    const text = await res.text();
    assert(!text.includes('Not found'), 'OPTIONS /api/auth/login never falls through to the app\'s 404 handler');
  }

  // =========================================================
  // 2. OPTIONS /api/auth/me — an authenticated-in-normal-use route; the
  //    preflight itself must never require/perform authentication
  // =========================================================
  {
    const res = await preflight('/api/auth/me', 'GET');
    assert(res.status === 204 || res.status === 200, `OPTIONS /api/auth/me returns a real successful status without any Authorization header (got ${res.status})`);
    assert(res.headers.get('access-control-allow-origin'), 'OPTIONS /api/auth/me response carries a real Access-Control-Allow-Origin header');
  }

  // =========================================================
  // 3. OPTIONS on at least one other real, authenticated API route
  // =========================================================
  {
    const res = await preflight('/api/loans/view', 'GET');
    assert(res.status === 204 || res.status === 200, `OPTIONS /api/loans/view (a real authenticated LoanBook route) returns a real successful status, not 404 (got ${res.status})`);
    assert(res.headers.get('access-control-allow-methods'), 'OPTIONS /api/loans/view response carries a real Access-Control-Allow-Methods header');
  }

  // =========================================================
  // 4. The actual POST /api/auth/login still works normally after the fix —
  //    proves the OPTIONS fix never touched the real request path
  // =========================================================
  {
    const bad = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'officer@rhinocash.co.ke', password: 'definitely-wrong' }) });
    assert(bad.status === 401, 'a real POST /api/auth/login with a wrong password is still genuinely rejected (401), not silently let through by the CORS fix');

    const good = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD }) });
    const goodJson = await good.json();
    assert(good.status === 200 && goodJson.token, 'a real POST /api/auth/login with correct credentials still succeeds and returns a real token, exactly as before the CORS fix');

    const me = await fetch(BASE + '/api/auth/me', { headers: { Authorization: `Bearer ${goodJson.token}` } });
    assert(me.status === 200, 'the real token from that login still authenticates a normal GET /api/auth/me request');
  }

  // =========================================================
  // 5. Authentication is never bypassed for the actual (non-OPTIONS) request
  // =========================================================
  {
    const res = await fetch(BASE + '/api/auth/me');
    assert(res.status === 401, 'a real GET /api/auth/me with no Authorization header is still genuinely rejected — the CORS fix only ever applies to the OPTIONS preflight itself');
  }

  // =========================================================
  // 6. A genuinely unmatched (non-OPTIONS) route still 404s exactly as
  //    before — the CORS fix must not change ordinary 404 behavior
  // =========================================================
  {
    const res = await fetch(BASE + '/api/this-route-does-not-exist');
    assert(res.status === 404, 'a real nonexistent GET route still returns 404, unaffected by the OPTIONS-specific fix');
  }

  // =========================================================
  // 7. X-Filename — POST /api/uploads' real raw-binary contract reads the
  //    real filename from this custom header. A real browser's preflight
  //    for a cross-origin upload (frontend and API on different origins,
  //    the exact deployment shape this app documents) blocks the whole
  //    request unless the server explicitly allows this header — a real
  //    gap the Node-based frontend test harness's fetch() never caught,
  //    since Node's fetch doesn't enforce CORS at all.
  // =========================================================
  {
    const res = await fetch(BASE + '/api/uploads', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:8080', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type, X-Filename' },
    });
    assert(res.status === 204 || res.status === 200, 'OPTIONS /api/uploads returns a real successful status');
    const allowedHeaders = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
    assert(allowedHeaders.includes('x-filename'), 'the real Access-Control-Allow-Headers response genuinely includes X-Filename — a real browser upload would otherwise be silently blocked by its own preflight, exactly the bug this fixes');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
