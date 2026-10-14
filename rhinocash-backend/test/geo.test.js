// geo.test.js — dashboard map & weather (by the user's branch scope) and
// WhatsApp-style live location sharing. A local stand-in answers for the
// weather service, so nothing leaves the machine.
'use strict';
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }

(async () => {
  // Stand-in weather service (same shape as Open-Meteo's forecast API).
  let calls = 0;
  const wx = http.createServer((req, res) => {
    calls++;
    const u = new URL(req.url, 'http://x'); const n = u.searchParams.get('latitude').split(',').length;
    const one = { current: { temperature_2m: 29.4, weather_code: 63, wind_speed_10m: 12, precipitation: 1.2 },
      daily: { time: ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'], weather_code: [63, 2, 0, 80], temperature_2m_max: [31, 30, 32, 29], temperature_2m_min: [23, 22, 23, 22], precipitation_probability_max: [85, 20, 5, 60] } };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(n === 1 ? one : Array.from({ length: n }, () => one)));
  });
  await new Promise(r => wx.listen(0, r));
  const PORT = 4095, BASE = `http://127.0.0.1:${PORT}`;
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), RATE_LIMIT_PER_MINUTE: '10000', WEATHER_API_BASE: `http://127.0.0.1:${wx.address().port}` } });
  const api = async (method, p, { token, body } = {}) => {
    const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* none */ } return { status: res.status, json };
  };
  const toks = [];
  const login = async (email, pw) => { const r = await api('POST', '/api/auth/login', { body: { email, password: pw } }); if (r.json && r.json.token) toks.push(r.json.token); return r.json && r.json.token; };
  try {
    let up = false; for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch { await new Promise(r => setTimeout(r, 250)); } }
    assert(up, 'setup: server with the stand-in weather service starts');
    const t = {
      officer: await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD),
      mgrK: await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD),
      mgrN: await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD),
      ops: await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD),
      admin: await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD),
    };
    assert(Object.values(t).every(Boolean), 'setup: everyone signs in');

    // 1. Map & weather by scope
    const o1 = await api('GET', '/api/geo/overview', { token: t.officer });
    const b1 = o1.json && o1.json.branches;
    assert(o1.status === 200 && b1.length === 1 && b1[0].lat != null, '1: a Loan Officer sees their own branch on the map');
    assert(b1[0].weather && b1[0].weather.current.temp === 29 && b1[0].weather.days.length === 4 && /rain/i.test(b1[0].weather.advice), '1: with current weather, a forecast and field advice (heavy rain likely)');
    const o2 = await api('GET', '/api/geo/overview', { token: t.ops });
    assert(o2.json.branches.length > 1, '1: an Operational Manager sees every branch');
    const before = calls; await api('GET', '/api/geo/overview', { token: t.ops });
    assert(calls === before, '1: forecasts are cached, not fetched again on every visit');
    assert((await api('PUT', `/api/geo/branches/${b1[0].id}`, { token: t.officer, body: { lat: -1, lng: 37 } })).status === 403, '1: a Loan Officer cannot move a branch');
    assert((await api('PUT', `/api/geo/branches/${b1[0].id}`, { token: t.admin, body: { lat: 'x', lng: 37 } })).status === 400, '1: an invalid position is refused');
    assert((await api('PUT', `/api/geo/branches/${b1[0].id}`, { token: t.admin, body: { lat: -0.0917, lng: 34.768 } })).status === 200, '1: the Admin sets the exact branch position');
    const o3 = await api('GET', '/api/geo/overview', { token: t.officer });
    assert(o3.json.branches[0].approximate === false && Math.abs(o3.json.branches[0].lat + 0.0917) < 1e-6, '1: the exact position is used from then on');

    // 2. Live location sharing
    assert((await api('POST', '/api/live-location/start', { token: t.officer, body: { minutes: 7, lat: -0.09, lng: 34.77 } })).status === 400, '2: only 15 minutes, 1 hour or 8 hours');
    assert((await api('POST', '/api/live-location/ping', { token: t.officer, body: { lat: -0.09, lng: 34.77 } })).json.code === 'NOT_SHARING', '2: nothing is sent before sharing is switched on');
    const st = await api('POST', '/api/live-location/start', { token: t.officer, body: { minutes: 60, lat: -0.0901, lng: 34.7701, accuracy: 12 } });
    assert(st.status === 200 && st.json.sharing && new Date(st.json.until) > new Date(Date.now() + 55 * 60000), '2: the officer shares their live location for 1 hour');
    const pg = await api('POST', '/api/live-location/ping', { token: t.officer, body: { lat: -0.0902, lng: 34.7702 } });
    assert(pg.status === 200 && pg.json.skipped, '2: positions closer together than 10 seconds are not stored');
    const seenK = (await api('GET', '/api/live-location', { token: t.mgrK })).json.people;
    assert(seenK.some(p => p.name && Math.abs(p.lat + 0.0901) < 1e-6 && (p.trail || []).length >= 1), '2: their branch Manager sees them on the map with a trail');
    const seenN = (await api('GET', '/api/live-location', { token: t.mgrN })).json.people;
    assert(!seenN.some(p => Math.abs(p.lat + 0.0901) < 1e-6), '2: a Manager of another branch does not');
    const seenOps = (await api('GET', '/api/live-location', { token: t.ops })).json.people;
    assert(seenOps.length >= 1, '2: head office sees everyone sharing');
    const meO = (await api('GET', '/api/live-location', { token: t.officer })).json;
    assert(meO.me.sharing && meO.people.length === 1, '2: an officer only sees themself');
    assert((await api('POST', '/api/live-location/request', { token: t.officer, body: { userId: 'usr_manager_kisumu' } })).status === 403, '2: an officer cannot ask others for their location');
    const officerId = (await api('GET', '/api/auth/me', { token: t.officer })).json.user.id;
    assert((await api('POST', '/api/live-location/request', { token: t.mgrN, body: { userId: officerId } })).status === 403, '2: a Manager cannot ask staff outside their branches');
    assert((await api('POST', '/api/live-location/request', { token: t.mgrK, body: { userId: officerId } })).status === 200, '2: their Manager can ask them to share');
    const notes = (await api('GET', '/api/notifications', { token: t.officer })).json;
    const list = (notes && (notes.notifications || notes)) || [];
    assert(Array.isArray(list) && list.some(n => /live location/i.test(n.title || '')), '2: the officer gets the request as a notification');

    // 3. Supervisors tick people who are sharing
    assert((await api('POST', '/api/live-location/check', { token: t.officer, body: { userIds: [officerId] } })).status === 403, '3: an officer cannot tick');
    assert((await api('POST', '/api/live-location/check', { token: t.mgrN, body: { userIds: [officerId] } })).status === 403, '3: a Manager of another branch cannot tick them');
    const ck = await api('POST', '/api/live-location/check', { token: t.mgrK, body: { userIds: [officerId] } });
    assert(ck.status === 200 && ck.json.updated === 1, '3: their Manager ticks them as checked');
    const kp = (await api('GET', '/api/live-location', { token: t.mgrK })).json.people.find(p => p.userId === officerId);
    assert(kp && kp.checkedBy && kp.checkedAt, '3: the tick shows who checked and when');
    const om = (await api('GET', '/api/live-location', { token: t.officer })).json.me;
    assert(om.checkedBy === kp.checkedBy, '3: the officer sees that they were checked');
    await api('POST', '/api/live-location/check', { token: t.mgrK, body: { userIds: [officerId], checked: false } });
    assert(!(await api('GET', '/api/live-location', { token: t.mgrK })).json.people.find(p => p.userId === officerId).checkedBy, '3: the tick can be cleared');
    await api('POST', '/api/live-location/check', { token: t.mgrK, body: { userIds: [officerId] } });

    // 4. Messages on the live map
    const mgrKId = (await api('GET', '/api/auth/me', { token: t.mgrK })).json.user.id;
    assert((await api('POST', '/api/live-location/messages', { token: t.officer, body: { to: [mgrKId], body: 'Hi' } })).status === 403, '4: an officer cannot start a conversation');
    assert((await api('POST', '/api/live-location/messages', { token: t.mgrN, body: { to: [officerId], body: 'Hi' } })).status === 403, '4: a Manager cannot message staff outside their branch');
    assert((await api('POST', '/api/live-location/messages', { token: t.mgrK, body: { to: [officerId], body: '   ' } })).status === 400, '4: an empty message is refused');
    const sent = await api('POST', '/api/live-location/messages', { token: t.mgrK, body: { to: [officerId], body: 'Please visit Mama Akinyi on your way back' } });
    assert(sent.status === 200 && sent.json.sent === 1, '4: their Manager messages them');
    assert((await api('POST', '/api/live-location/messages', { token: t.ops, body: { to: [officerId], body: 'Weather is turning — take care' } })).json.sent === 1, '4: head office can message them too (one or many ticked at once)');
    const lo = (await api('GET', '/api/live-location/messages', { token: t.officer })).json;
    assert(lo.conversations.length >= 2 && lo.unread >= 2, '4: the officer sees both conversations as unread');
    assert((await api('GET', '/api/live-location', { token: t.officer })).json.me.unread >= 2, '4: the unread count comes with the live map');
    const th = (await api('GET', `/api/live-location/messages?with=${mgrKId}`, { token: t.officer })).json;
    assert(th.messages.length === 1 && !th.messages[0].mine && /Mama Akinyi/.test(th.messages[0].body), '4: the officer opens the thread');
    assert((await api('GET', '/api/live-location/messages', { token: t.officer })).json.conversations.find(c => c.userId === mgrKId).unread === 0, '4: opening it marks it read');
    assert((await api('POST', '/api/live-location/messages', { token: t.officer, body: { to: [mgrKId], body: 'On my way' } })).status === 200, '4: the officer replies');
    const mt = (await api('GET', `/api/live-location/messages?with=${officerId}`, { token: t.mgrK })).json.messages;
    assert(mt.length === 2 && mt[0].mine && mt[0].read && !mt[1].mine && mt[1].body === 'On my way', '4: the Manager sees the reply and that their message was read (✓✓)');
    assert((await api('GET', `/api/live-location/messages?with=${officerId}`, { token: t.mgrN })).status === 403, '4: others cannot read the thread');
    const re = await api('POST', '/api/live-location/start', { token: t.officer, body: { minutes: 15, lat: -0.0901, lng: 34.7701 } });
    assert(re.status === 200 && !(await api('GET', '/api/live-location', { token: t.officer })).json.me.checkedBy, '3: a new share starts unticked');

    assert((await api('POST', '/api/live-location/stop', { token: t.officer })).status === 200, '2: the officer stops sharing');
    const after = (await api('GET', '/api/live-location', { token: t.mgrK })).json.people;
    assert(!after.some(p => Math.abs(p.lat + 0.0901) < 1e-6), '2: once stopped, nobody sees their location');
    assert((await api('GET', '/api/live-location')).status === 401, '2: locations need sign-in');
  } finally {
    for (const tok of toks) await api('POST', '/api/auth/logout', { token: tok }).catch(() => {});
    server.kill(); wx.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
