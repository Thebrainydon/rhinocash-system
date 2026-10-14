// geo.js — dashboard map, weather and live location sharing.
//
// Map & weather: every branch the signed-in user can see (Loan Officer and
// Manager: their branch; Regional Manager: their region; head office:
// all) is placed on the map with today's weather and a 3-day forecast
// (Open-Meteo, no key needed; fetched by the server and cached 30 minutes).
// Branch positions come from a built-in list of Kenyan towns until an
// Admin sets the exact spot.
//
// Live location, like WhatsApp: a staff member chooses to share their live
// location for 15 minutes, 1 hour or 8 hours. While it is on, their phone
// sends its position; supervisors who have that person's branch in scope
// see it on the map, with the recent trail. It stops by itself when the
// time is up, or when they press Stop. A supervisor can ask an officer to
// share (a notification); nobody's location is ever taken without them
// switching sharing on.
'use strict';
const { all, get, run } = require('./../db');
const { requireAuth } = require('./../middleware');
const { logAction, notify } = require('./../audit');
const { branchIdsInScope } = require('./../rbac');

// Approximate town centres (lat, lng) for branch locations.
const TOWNS = {
  changamwe: [-4.026, 39.630], kinango: [-4.137, 39.316], kwale: [-4.174, 39.452], lungalunga: [-4.556, 39.123],
  minjila: [-2.270, 40.110], mombasa: [-4.043, 39.668], msambweni: [-4.469, 39.480], ukunda: [-4.287, 39.566],
  diani: [-4.318, 39.574], chuka: [-0.333, 37.646], embakasi: [-1.317, 36.906], kagio: [-0.619, 37.267],
  kangari: [-0.802, 36.913], karatina: [-0.483, 37.128], kitui: [-1.367, 38.011], maua: [0.233, 37.940],
  nkubu: [0.067, 37.665], nyahururu: [0.038, 36.364], nyeri: [-0.420, 36.951], ruiru: [-1.146, 36.961],
  runyenjes: [-0.420, 37.574], wote: [-1.780, 37.630], bamba: [-3.553, 39.537], gongoni: [-3.031, 40.142],
  kaloleni: [-3.817, 39.633], kibwezi: [-2.416, 37.966], kilifi: [-3.631, 39.849], likoni: [-4.087, 39.661],
  loitoktok: [-2.928, 37.512], malindi: [-3.219, 40.117], mariakani: [-3.864, 39.474], mpeketoni: [-2.392, 40.693],
  mtwapa: [-3.940, 39.743], taveta: [-3.398, 37.676], voi: [-3.396, 38.556], wudanyi: [-3.398, 38.364],
  nairobi: [-1.286, 36.817], kisumu: [-0.092, 34.768], nakuru: [-0.303, 36.080], eldoret: [0.514, 35.270],
  thika: [-1.033, 37.069], machakos: [-1.517, 37.263], meru: [0.047, 37.649], embu: [-0.531, 37.450],
  lamu: [-2.271, 40.902], garissa: [-0.453, 39.646], narok: [-1.078, 35.860], kakamega: [0.282, 34.752],
  kisii: [-0.677, 34.780], nanyuki: [0.017, 37.074], naivasha: [-0.717, 36.433], kitale: [1.016, 35.006],
  kericho: [-0.368, 35.284], bungoma: [0.564, 34.561], muranga: [-0.721, 37.153], kerugoya: [-0.499, 37.280],
  kiambu: [-1.171, 36.835], kajiado: [-1.852, 36.776], mwingi: [-0.932, 38.060], isiolo: [0.354, 37.582],
};
const townKey = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
function guessCoords(b) {
  for (const s of [b.location, b.name]) {
    const k = townKey(s); if (TOWNS[k]) return TOWNS[k];
    const hit = Object.keys(TOWNS).find(t => k.includes(t)); if (hit) return TOWNS[hit];
  }
  return null;
}

// WMO weather codes → words and an icon.
const WMO = { 0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'], 45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'], 61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'], 71: ['Snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Snow', '🌨️'], 80: ['Rain showers', '🌦️'],
  81: ['Rain showers', '🌧️'], 82: ['Violent showers', '⛈️'], 95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm', '⛈️'], 99: ['Thunderstorm', '⛈️'] };
const wmo = c => WMO[c] || ['—', '🌡️'];
// A short tip for field work from the next days' forecast.
function fieldAdvice(days) {
  const d0 = days[0]; if (!d0) return null;
  if (d0.rainChance >= 70 || [65, 82, 95, 96, 99].includes(d0.code)) return 'Heavy rain likely today — do field visits and collections early.';
  if (days.slice(1).some(d => d.rainChance >= 70)) return 'Rain expected in the next days — plan field visits around it.';
  if (d0.tmax >= 33) return 'Very hot today — carry water on field visits.';
  return 'Good weather for field visits.';
}

const cache = new Map(); // "lat,lng" → { at, data }
const CACHE_MS = 30 * 60 * 1000;
async function forecastFor(points) {
  const need = points.filter(p => { const c = cache.get(p.key); return !c || Date.now() - c.at > CACHE_MS; });
  for (let i = 0; i < need.length; i += 40) {
    const chunk = need.slice(i, i + 40);
    const base = String(process.env.WEATHER_API_BASE || 'https://api.open-meteo.com').replace(/\/+$/, '');
    const url = `${base}/v1/forecast?latitude=${chunk.map(p => p.lat).join(',')}&longitude=${chunk.map(p => p.lng).join(',')}`
      + '&current=temperature_2m,weather_code,wind_speed_10m,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=4&timezone=Africa%2FNairobi';
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Weather service answered ${res.status}`);
    let body = await res.json(); if (!Array.isArray(body)) body = [body];
    chunk.forEach((p, j) => {
      const w = body[j] || {}; const c = w.current || {}; const d = w.daily || {};
      const days = (d.time || []).map((date, k) => ({ date, code: d.weather_code[k], text: wmo(d.weather_code[k])[0], icon: wmo(d.weather_code[k])[1],
        tmax: Math.round(d.temperature_2m_max[k]), tmin: Math.round(d.temperature_2m_min[k]), rainChance: d.precipitation_probability_max ? d.precipitation_probability_max[k] : null }));
      cache.set(p.key, { at: Date.now(), data: { current: { temp: Math.round(c.temperature_2m), code: c.weather_code, text: wmo(c.weather_code)[0], icon: wmo(c.weather_code)[1], wind: Math.round(c.wind_speed_10m || 0), rain: c.precipitation || 0 }, days, advice: fieldAdvice(days) } });
    });
  }
  return points.map(p => (cache.get(p.key) || {}).data || null);
}

async function branchesInScope(user) {
  const scope = await branchIdsInScope(user);
  const rows = await all(`SELECT b.id, b.name, b.location, b.lat, b.lng, b.region_id, r.name AS region FROM branches b LEFT JOIN regions r ON r.id = b.region_id
    WHERE COALESCE(b.status, 'Active') <> 'Closed' ORDER BY b.name`);
  const own = user.branch_id;
  return rows.filter(b => (['loan_officer', 'manager'].includes(user.role_id) ? b.id === own : scope === null || scope.includes(b.id)));
}

const SHARE_MINUTES = [15, 60, 480];
const validPos = b => b && isFinite(b.lat) && isFinite(b.lng) && Math.abs(b.lat) <= 90 && Math.abs(b.lng) <= 180;

function register(router) {
  // ---- Map & weather ----
  router.get('/api/geo/overview', requireAuth, async (req, res) => {
    const branches = await branchesInScope(req.user);
    const points = branches.map(b => {
      const g = b.lat != null && b.lng != null ? [Number(b.lat), Number(b.lng)] : guessCoords(b);
      return { ...b, lat: g ? g[0] : null, lng: g ? g[1] : null, approximate: b.lat == null && !!g };
    });
    const located = points.filter(p => p.lat != null);
    let weather = [], weatherError = null;
    try {
      weather = await forecastFor(located.map(p => ({ key: `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`, lat: p.lat.toFixed(3), lng: p.lng.toFixed(3) })));
    } catch (e) { weatherError = 'Weather is not available right now'; }
    res.json({
      branches: points.map(p => ({ id: p.id, name: p.name, region: p.region, lat: p.lat, lng: p.lng, approximate: p.approximate,
        weather: p.lat != null ? weather[located.indexOf(p)] || null : null })),
      weatherError, weatherSource: 'Open-Meteo',
    });
  });

  // An Admin (or Operational Manager) fixes a branch's exact position.
  router.put('/api/geo/branches/:id', requireAuth, async (req, res, next) => {
    if (!['admin', 'operational_manager'].includes(req.user.role_id)) return next({ status: 403, message: 'Only the Admin or Operational Manager can move a branch on the map' });
    const b = await get('SELECT id, name FROM branches WHERE id = ?', [req.params.id]);
    if (!b) return next({ status: 404, message: 'Branch not found' });
    if (!validPos(req.body)) return next({ status: 400, message: 'Send a valid lat and lng' });
    await run('UPDATE branches SET lat = ?, lng = ? WHERE id = ?', [Number(req.body.lat), Number(req.body.lng), b.id]);
    await logAction(req, { action: 'Set branch location', module: 'branches', recordType: 'Branch', recordId: b.id, newValue: { lat: Number(req.body.lat), lng: Number(req.body.lng) } });
    res.json({ ok: true });
  });

  // ---- Live location ----
  const active = row => row && row.share_until && String(row.share_until) > new Date().toISOString();
  router.post('/api/live-location/start', requireAuth, async (req, res, next) => {
    const minutes = Number(req.body.minutes);
    if (!SHARE_MINUTES.includes(minutes)) return next({ status: 400, message: 'Share for 15 minutes, 1 hour or 8 hours' });
    if (!validPos(req.body)) return next({ status: 400, message: 'Your phone did not give a location — allow location access and try again' });
    const until = new Date(Date.now() + minutes * 60000).toISOString();
    const now = new Date().toISOString();
    await run(`INSERT INTO staff_live_locations (user_id, lat, lng, accuracy, share_until, started_at, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (user_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, accuracy = EXCLUDED.accuracy, share_until = EXCLUDED.share_until, started_at = EXCLUDED.started_at, updated_at = EXCLUDED.updated_at`,
    [req.user.id, Number(req.body.lat), Number(req.body.lng), Number(req.body.accuracy) || null, until, now, now]);
    await run('INSERT INTO staff_location_pings (user_id, lat, lng, accuracy) VALUES (?,?,?,?)', [req.user.id, Number(req.body.lat), Number(req.body.lng), Number(req.body.accuracy) || null]);
    await logAction(req, { action: 'Started sharing live location', module: 'staff', recordType: 'User', recordId: req.user.id, newValue: { minutes } });
    res.json({ sharing: true, until });
  });
  router.post('/api/live-location/ping', requireAuth, async (req, res, next) => {
    const row = await get('SELECT * FROM staff_live_locations WHERE user_id = ?', [req.user.id]);
    if (!active(row)) return next({ status: 409, message: 'Live location sharing is not on', code: 'NOT_SHARING' });
    if (!validPos(req.body)) return next({ status: 400, message: 'Send a valid lat and lng' });
    if (row.updated_at && Date.now() - new Date(row.updated_at).getTime() < 10000) return res.json({ sharing: true, until: row.share_until, skipped: true });
    await run('UPDATE staff_live_locations SET lat = ?, lng = ?, accuracy = ?, updated_at = ? WHERE user_id = ?', [Number(req.body.lat), Number(req.body.lng), Number(req.body.accuracy) || null, new Date().toISOString(), req.user.id]);
    await run('INSERT INTO staff_location_pings (user_id, lat, lng, accuracy) VALUES (?,?,?,?)', [req.user.id, Number(req.body.lat), Number(req.body.lng), Number(req.body.accuracy) || null]);
    if (Math.random() < 0.02) await run(`DELETE FROM staff_location_pings WHERE at < iso_offset(interval '-7 days')`);
    res.json({ sharing: true, until: row.share_until });
  });
  router.post('/api/live-location/stop', requireAuth, async (req, res) => {
    await run('UPDATE staff_live_locations SET share_until = ? WHERE user_id = ?', [new Date().toISOString(), req.user.id]);
    await logAction(req, { action: 'Stopped sharing live location', module: 'staff', recordType: 'User', recordId: req.user.id });
    res.json({ sharing: false });
  });
  // Who is sharing now, within the caller's scope (a Loan Officer only sees themself).
  router.get('/api/live-location', requireAuth, async (req, res) => {
    const mine = await get('SELECT * FROM staff_live_locations WHERE user_id = ?', [req.user.id]);
    const rows = await all(`SELECT l.*, u.name, u.role_id, u.branch_id FROM staff_live_locations l JOIN users u ON u.id = l.user_id WHERE l.share_until > ? ORDER BY u.name`, [new Date().toISOString()]);
    let people = [];
    if (req.user.role_id === 'loan_officer') people = rows.filter(r => r.user_id === req.user.id);
    else {
      const scope = await branchIdsInScope(req.user);
      people = rows.filter(r => r.user_id === req.user.id || scope === null || scope.includes(r.branch_id));
      if (req.user.role_id === 'manager') people = people.filter(r => r.user_id === req.user.id || r.branch_id === req.user.branch_id);
    }
    const out = [];
    for (const p of people) {
      const trail = await all(`SELECT lat, lng, at FROM staff_location_pings WHERE user_id = ? AND at > ? ORDER BY at DESC LIMIT 40`, [p.user_id, p.started_at]);
      out.push({ userId: p.user_id, name: p.name, roleId: p.role_id, branchId: p.branch_id, lat: Number(p.lat), lng: Number(p.lng), accuracy: p.accuracy != null ? Number(p.accuracy) : null,
        updatedAt: p.updated_at, until: p.share_until, trail: trail.reverse().map(t => [Number(t.lat), Number(t.lng)]) });
    }
    res.json({ me: active(mine) ? { sharing: true, until: mine.share_until, updatedAt: mine.updated_at } : { sharing: false }, people: out });
  });
  // A supervisor asks someone in their scope to share their live location.
  router.post('/api/live-location/request', requireAuth, async (req, res, next) => {
    if (req.user.role_id === 'loan_officer') return next({ status: 403, message: 'Only supervisors can ask for a live location' });
    const target = await get('SELECT id, name, branch_id FROM users WHERE id = ?', [String(req.body.userId || '')]);
    if (!target || target.id === req.user.id) return next({ status: 400, message: 'Choose a staff member' });
    const scope = await branchIdsInScope(req.user);
    if (scope !== null && !scope.includes(target.branch_id)) return next({ status: 403, message: 'That staff member is outside your branches' });
    await notify(target.id, 'location', 'Please share your live location', `${req.user.name} asked you to share your live location. Open the dashboard and choose Share live location.`);
    await logAction(req, { action: 'Requested live location', module: 'staff', recordType: 'User', recordId: target.id });
    res.json({ ok: true, message: `Request sent to ${target.name}` });
  });
}

module.exports = { register, guessCoords, fieldAdvice };
