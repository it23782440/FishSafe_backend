/*
 * Integration tests: run the real Express app against a real MongoDB.
 *   MONGODB_URI_TEST=mongodb://127.0.0.1:27017/fishsafe_test npm test
 * The test database is wiped before the run - never point this at production data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

process.env.DEVICE_API_KEY = 'test-key';
process.env.DEVICE_OFFLINE_SECONDS = '180';
process.env.NODE_ENV = 'test';
const URI = process.env.MONGODB_URI_TEST;
if (!URI) throw new Error('Set MONGODB_URI_TEST to a throwaway MongoDB database');

const app = require('../src/app');
const registry = require('../src/services/speciesRegistry');
const watchdog = require('../src/services/watchdog');
const SensorReading = require('../src/models/SensorReading');
const Device = require('../src/models/Device');
const Alert = require('../src/models/Alert');
const { classify } = require('../src/services/statusService');
const { assessSpecies } = require('../src/services/assessmentService');

let server;
let base;
const api = (path, opts = {}) =>
  fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
const json = async (path, opts) => (await api(path, opts)).json();
const post = (body) =>
  api('/api/sensors/data', { method: 'POST', headers: { 'x-api-key': 'test-key' }, body: JSON.stringify(body) });
const reading = (deviceId, temperature, ph, extra = {}) => ({ deviceId, temperature, ph, turbidity: 10, rain: 5, conductivity: 400, ...extra });
const putSpecies = (species, deviceId) =>
  api('/api/device/species', { method: 'PUT', body: JSON.stringify({ deviceId, species }) });
const activeAlerts = async (deviceId, q = '') => (await json(`/api/alerts?deviceId=${deviceId}&active=true${q}`)).alerts;

test.before(async () => {
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  await registry.seedDefaults();
  await registry.load();
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
});

/* =========================== classification rules =========================== */

test('brief examples: Tilapia SAFE / WARNING / DANGER (temp) / DANGER (pH)', () => {
  const at = (temperature, ph) => assessSpecies('tilapia', { timestamp: new Date(), temperature, ph });
  assert.equal(at(28, 7.2).status, 'SAFE');
  assert.equal(at(29.5, 7.2).status, 'WARNING'); // approaching the 30 °C maximum
  const hot = at(33, 7.2);
  assert.equal(hot.status, 'DANGER');
  assert.match(hot.parameters.temperature.reason, /exceeds the recommended maximum of 30 °C for Nile Tilapia/);
  const alk = at(28, 9.0);
  assert.equal(alk.status, 'DANGER');
  assert.equal(alk.parameters.temperature.status, 'SAFE');
  assert.equal(alk.parameters.ph.status, 'DANGER');
});

test('overall = worst parameter; missing/stale/implausible data is never SAFE', () => {
  const now = new Date();
  assert.equal(assessSpecies('tilapia', { timestamp: now, temperature: 33, ph: null }).status, 'DANGER'); // known danger wins
  assert.equal(assessSpecies('tilapia', { timestamp: now, temperature: 28, ph: null }).status, 'UNKNOWN'); // safe + missing != safe
  assert.equal(assessSpecies('tilapia', { timestamp: now, temperature: 28, ph: 19 }).status, 'UNKNOWN'); // pH 19 is a sensor fault
  assert.equal(assessSpecies('tilapia', null).status, 'UNKNOWN');
  const old = assessSpecies('tilapia', { timestamp: new Date(Date.now() - 10 * 60000), temperature: 28, ph: 7.2 });
  assert.equal(old.status, 'UNKNOWN');
  assert.equal(old.stale, true);
  assert.equal(old.lastKnownStatus, 'SAFE');
});

test('species classify the same value differently', () => {
  assert.equal(classify('temperature', 33, 'tilapia'), 'DANGER');
  assert.equal(classify('temperature', 33, 'carp'), 'DANGER');
  assert.equal(classify('temperature', 33, 'catfish'), 'WARNING');
  assert.equal(classify('temperature', 22, 'carp'), 'SAFE');
  assert.equal(classify('temperature', 22, 'tilapia'), 'DANGER');
  assert.equal(classify('temperature', 22, 'catfish'), 'WARNING');
  assert.equal(classify('temperature', 22, 'no-such-species'), 'DANGER', 'falls back to the default species');
});

/* ================================ basics ==================================== */

test('health reports database connected', async () => {
  const res = await api('/api/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).database, 'connected');
});

test('ingest still requires the device API key', async () => {
  const res = await api('/api/sensors/data', { method: 'POST', body: JSON.stringify({ deviceId: 'X', ph: 7 }) });
  assert.equal(res.status, 401);
});

test('GET /api/species lists registered species with limits (DB-backed)', async () => {
  const body = await json('/api/species');
  assert.equal(body.default, 'tilapia');
  assert.deepEqual(body.species.map((s) => s.id).sort(), ['carp', 'catfish', 'tilapia']);
  const carp = body.species.find((s) => s.id === 'carp');
  assert.equal(carp.thresholds.temperature.safeLow, 20);
  assert.equal(carp.thresholds.turbidity.safeLow, null, '-Infinity serialises to null');
  assert.equal(carp.builtIn, true);
});

/* ================= species-specific data (the key requirement) ============== */

test('same water, different fish: species list, counts and assessments differ per species', async () => {
  const D = 'SPEC-001';
  await post(reading(D, 31, 7.2));
  const body = await json(`/api/species?deviceId=${D}`);
  const by = Object.fromEntries(body.species.map((s) => [s.id, s.assessment]));
  assert.equal(by.tilapia.status, 'WARNING'); // above its 30 °C recommended max
  assert.equal(by.carp.status, 'WARNING'); // above its 28 °C recommended max
  assert.equal(by.catfish.status, 'SAFE'); // inside 26-32 °C and clear of the margin
  assert.deepEqual(body.summary, { total: 3, safe: 1, warning: 2, danger: 0, unknown: 0 });
  assert.equal(body.pondSpecies, 'tilapia');
  // Each assessment quotes ITS OWN limits.
  assert.match(by.tilapia.parameters.temperature.reason, /Nile Tilapia/);
  assert.match(by.carp.parameters.temperature.reason, /Common Carp/);
  assert.equal(by.carp.parameters.temperature.expected, '20 – 28 °C');
  assert.equal(by.tilapia.parameters.temperature.expected, '25 – 30 °C');

  const one = await json(`/api/species/catfish/assessment?deviceId=${D}`);
  assert.equal(one.status, 'SAFE');
  assert.equal(one.message, 'Both environmental parameters are within the configured recommended ranges.');
});

test('assessment endpoint validates input and reports stale data as UNKNOWN', async () => {
  assert.equal((await api('/api/species/tilapia/assessment')).status, 400, 'deviceId required');
  assert.equal((await api('/api/species/shark/assessment?deviceId=X')).status, 404);
  // No readings at all
  const none = await json('/api/species/tilapia/assessment?deviceId=NOBODY');
  assert.equal(none.status, 'UNKNOWN');
  assert.equal(none.noData, true);
  // Old reading (inserted directly, so it is genuinely old)
  await SensorReading.create({ deviceId: 'STALE-001', temperature: 28, ph: 7.2, timestamp: new Date(Date.now() - 20 * 60000) });
  const st = await json('/api/species/tilapia/assessment?deviceId=STALE-001');
  assert.equal(st.status, 'UNKNOWN');
  assert.equal(st.stale, true);
  assert.equal(st.lastKnownStatus, 'SAFE');
  assert.match(st.reasons[0], /last reading is 20 minutes old/);
});

test('species history: per-species zones/excursions from the same stored readings; custom ranges', async () => {
  const D = 'HIST-001';
  const now = Date.now();
  const docs = [];
  // 180 readings over the last 3 h, one per minute: temperature ramps 24 -> 34, pH constant 7.2
  for (let i = 0; i < 180; i++) {
    docs.push({ deviceId: D, temperature: 24 + (i / 179) * 10, ph: 7.2, timestamp: new Date(now - (180 - i) * 60000) });
  }
  await SensorReading.insertMany(docs);

  const h = async (id) => json(`/api/species/${id}/history?deviceId=${D}&range=24h`);
  const [t, c, f] = await Promise.all([h('tilapia'), h('carp'), h('catfish')]);

  assert.equal(t.count, 180);
  assert.equal(t.bucketed, false);
  assert.equal(t.series[0].temperatureStatus, 'WARNING'); // 24 C is below tilapia's 25 C minimum
  assert.equal(t.series.at(-1).status, 'DANGER'); // 34 C
  // Zones differ between fish for identical readings. Expected values were computed
  // independently of the server (ramp 24->34 C, 180 points, each species' limits + margin).
  const near = (a, b) => Math.abs(a - b) <= 1;
  for (const [res, exp] of [[t, [30, 50, 20]], [c, [30, 50, 20]], [f, [40, 60, 0]]]) {
    const z = res.summary.zones;
    assert.ok(near(z.SAFE, exp[0]) && near(z.WARNING, exp[1]) && near(z.DANGER, exp[2]), `${res.species.id} zones ${JSON.stringify(z)}`);
  }
  assert.notDeepEqual(t.summary.zones, f.summary.zones, 'catfish judges the same water differently');
  for (const r of [t, c, f]) {
    const z = r.summary.zones;
    assert.ok(Math.abs(z.SAFE + z.WARNING + z.DANGER - 100) <= 2, 'zone percentages add up');
  }
  // Excursions: tilapia & carp hit DANGER (>32); catfish only ever WARNING (max 34 < 35)
  assert.ok(t.excursions.some((e) => e.status === 'DANGER'));
  assert.ok(c.excursions.some((e) => e.status === 'DANGER'));
  assert.ok(f.excursions.length > 0 && f.excursions.every((e) => e.status === 'WARNING'));
  assert.match(t.excursions[0].reason, /Nile Tilapia/);
  assert.equal(t.excursions[0].parameter, 'temperature');
  // exact stats + trend from the DB
  assert.equal(t.summary.temperature.min, 24);
  assert.equal(t.summary.temperature.max, 34);
  assert.equal(t.summary.temperature.trend.direction, 'rising');
  assert.equal(t.summary.ph.trend.direction, 'stable');
  assert.equal(t.thresholds.temperature.safeHigh, 30);

  // Custom range: only the first hour of data
  const from = new Date(now - 180 * 60000 - 1000).toISOString();
  const to = new Date(now - 120 * 60000).toISOString();
  const part = await json(`/api/species/tilapia/history?deviceId=${D}&from=${from}&to=${to}`);
  assert.equal(part.window.range, 'custom');
  assert.ok(part.count >= 58 && part.count <= 62, `custom window count ${part.count}`);
  assert.ok(part.summary.temperature.max < 28);
  // Validation
  assert.equal((await api(`/api/species/tilapia/history?deviceId=${D}&from=${to}&to=${from}`)).status, 400);
  assert.equal((await api(`/api/species/tilapia/history?deviceId=${D}&from=nonsense`)).status, 400);
  assert.equal((await api(`/api/species/tilapia/history?deviceId=${D}&from=2020-01-01&to=2026-01-01`)).status, 400, '>366 days');
  assert.equal((await api('/api/species/tilapia/history')).status, 400, 'deviceId required');
});

test('records: pagination and CSV export', async () => {
  const D = 'HIST-001';
  const p2 = await json(`/api/sensors/records?deviceId=${D}&range=24h&pageSize=50&page=2`);
  assert.equal(p2.total, 180);
  assert.equal(p2.pages, 4);
  assert.equal(p2.rows.length, 50);
  assert.ok(new Date(p2.rows[0].timestamp) < new Date(), 'newest first');
  assert.ok(p2.rows[0].overallStatus);
  const res = await api(`/api/sensors/records?deviceId=${D}&range=24h&format=csv`);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const lines = (await res.text()).split('\n');
  assert.equal(lines[0], 'timestamp,temperature,ph,turbidity,rain,conductivity,signal,overallStatus');
  assert.equal(lines.length, 181);
});

/* ============================ species management ============================ */

const rohu = () => ({
  name: 'Rohu',
  scientific: 'Labeo rohita',
  description: 'Indian major carp.',
  thresholds: {
    temperature: { warnLow: 20, safeLow: 24, safeHigh: 31, warnHigh: 34, warnMargin: 1 },
    ph: { warnLow: 6.0, safeLow: 6.5, safeHigh: 8.5, warnHigh: 9.0, warnMargin: 0.3 },
  },
});
const send = (method, path, body) => api(path, { method, body: JSON.stringify(body) });

test('species CRUD: create, validate, edit (re-evaluates devices), delete-guard', async () => {
  const created = await send('POST', '/api/species', rohu());
  assert.equal(created.status, 201);
  assert.equal((await created.json()).id, 'rohu');
  assert.equal((await json('/api/species')).count, 4);
  assert.equal((await send('POST', '/api/species', rohu())).status, 409, 'duplicate id');

  // validation
  const bad = (mutate) => { const b = rohu(); mutate(b); return send('POST', '/api/species', { ...b, name: `Bad ${Math.random()}` }); };
  assert.equal((await bad((b) => { b.thresholds.temperature.safeLow = 40; })).status, 400, 'min >= max');
  assert.equal((await bad((b) => { b.thresholds.ph.warnMargin = 5; })).status, 400, 'margin too large');
  assert.equal((await bad((b) => { b.thresholds.ph.safeHigh = 20; b.thresholds.ph.warnHigh = 21; })).status, 400, 'pH > 14');
  assert.equal((await bad((b) => { b.imageUrl = 'javascript:alert(1)'; })).status, 400, 'unsafe image url');
  assert.equal((await bad((b) => { delete b.thresholds.ph; })).status, 400, 'ph limits required');
  assert.equal((await send('POST', '/api/species', { ...rohu(), name: 'X' })).status, 400, 'name too short');

  // Editing thresholds of a species in use re-evaluates that device's alerts immediately
  const D = 'EDIT-001';
  await post(reading(D, 27, 7.2));
  await putSpecies('carp', D);
  assert.equal((await activeAlerts(D)).length, 0, '27 C is safe for carp (20-28, margin 1)');
  const carp = await json('/api/species/carp');
  const edit = { ...carp, thresholds: { temperature: { ...carp.thresholds.temperature, safeHigh: 26 }, ph: carp.thresholds.ph } };
  assert.equal((await send('PUT', '/api/species/carp', edit)).status, 200);
  const alerts = await activeAlerts(D);
  assert.equal(alerts.length, 1, 'new limit makes 27 C a warning');
  assert.equal(alerts[0].severity, 'WARNING');
  assert.match(alerts[0].reason, /above the recommended maximum of 26 °C for Common Carp/);
  // the editor sent only temperature + pH: carp's turbidity override must survive
  assert.equal((await json('/api/species/carp')).thresholds.turbidity.safeHigh, 50);
  // restore
  await send('PUT', '/api/species/carp', carp);
  assert.equal((await activeAlerts(D)).length, 0);

  // Deleting: blocked while a device uses it
  await putSpecies('rohu', 'DEL-001');
  const blocked = await send('DELETE', '/api/species/rohu');
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /DEL-001/);
  await putSpecies('tilapia', 'DEL-001');
  assert.equal((await send('DELETE', '/api/species/rohu')).status, 200);
  assert.equal((await api('/api/species/rohu')).status, 404);
  assert.equal((await json('/api/species')).count, 3);
});

test('thresholds endpoint follows the device species and accepts ?species=', async () => {
  const D = 'EDIT-001';
  await putSpecies('catfish', D);
  assert.equal((await json(`/api/config/thresholds?deviceId=${D}`)).temperature.safeLow, 26);
  assert.equal((await json('/api/config/thresholds?species=carp')).temperature.safeLow, 20);
  assert.equal((await api('/api/config/thresholds?species=shark')).status, 400);
});

/* ================================== alerts ================================== */

test('pond species switch: alerts escalate/ease in place, resolve, and carry reason + action', async () => {
  const D = 'SW-001';
  assert.equal((await (await post(reading(D, 31, 7.2))).json()).statuses.temperature, 'WARNING');
  let a = await activeAlerts(D);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'WARNING');
  assert.equal(a[0].kind, 'threshold');
  assert.equal(a[0].title, 'High water temperature');
  assert.equal(a[0].species, 'tilapia');
  assert.match(a[0].reason, /above the recommended maximum of 30 °C/);
  assert.ok(a[0].recommendation.length > 20);
  assert.equal(a[0].direction, 'high');

  await putSpecies('catfish', D); // 31 C is SAFE for catfish -> resolved
  assert.equal((await activeAlerts(D)).length, 0);
  await putSpecies('carp', D); // WARNING again, limits text is carp's
  a = await activeAlerts(D);
  assert.equal(a.length, 1);
  assert.match(a[0].threshold, /20 - 28/);
  await post(reading(D, 33, 7.2)); // DANGER for carp: same alert escalates, no duplicate
  a = await activeAlerts(D);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'DANGER');
  await putSpecies('catfish', D); // 33 C is only a WARNING for catfish: eases in place
  a = await activeAlerts(D);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'WARNING');
  const info = (await json(`/api/alerts?deviceId=${D}&kind=species_changed`)).alerts;
  assert.ok(info.length >= 3 && info.every((x) => x.severity === 'INFO' && x.active === false));
});

test('repeated readings in the same condition do not create duplicate alerts', async () => {
  const D = 'DEDUP-001';
  for (let i = 0; i < 5; i++) await post(reading(D, 33.5, 7.2));
  const all = (await json(`/api/alerts?deviceId=${D}&kind=threshold`)).alerts;
  assert.equal(all.length, 1);
});

test('read / unread: unreadCount, mark one, filter, mark all', async () => {
  const D = 'READ-001';
  await post(reading(D, 33, 9.2)); // two alerts: temperature + pH
  let r = await json(`/api/alerts?deviceId=${D}`);
  assert.equal(r.alerts.length, 2);
  assert.equal(r.unreadCount, 2);
  const id = r.alerts[0]._id;
  const marked = await (await send('PATCH', `/api/alerts/${id}/read`, { read: true })).json();
  assert.equal(marked.read, true);
  assert.ok(marked.readAt);
  r = await json(`/api/alerts?deviceId=${D}`);
  assert.equal(r.unreadCount, 1);
  assert.equal((await json(`/api/alerts?deviceId=${D}&read=false`)).alerts.length, 1);
  assert.equal((await json(`/api/alerts?deviceId=${D}&read=true`)).alerts.length, 1);
  assert.equal((await send('PATCH', `/api/alerts/${id}/read`, { read: false })).status, 200);
  assert.equal((await json(`/api/alerts?deviceId=${D}`)).unreadCount, 2);
  assert.equal((await api(`/api/alerts/read-all?deviceId=${D}`, { method: 'POST' })).status, 200);
  assert.equal((await json(`/api/alerts?deviceId=${D}`)).unreadCount, 0);
  assert.equal((await send('PATCH', '/api/alerts/not-an-id/read', {})).status, 400);
  assert.equal((await send('PATCH', '/api/alerts/507f1f77bcf86cd799439011/read', {})).status, 404);
});

test('alerts can be listed for a date window (used by Reports)', async () => {
  const D = 'WIN-001';
  const ago = (ms) => new Date(Date.now() - ms);
  for (const [i, ms] of [[1, 10 * 86400000], [2, 3 * 86400000], [3, 3600000]]) {
    await Alert.create({ deviceId: D, sensor: 'temperature', kind: 'threshold', severity: 'WARNING', title: `A${i}`, message: `m${i}`, createdAt: ago(ms) });
  }
  const list = async (q) => (await json(`/api/alerts?deviceId=${D}&${q}`)).alerts.map((a) => a.title).sort();
  assert.deepEqual(await list(`from=${ago(5 * 86400000).toISOString()}`), ['A2', 'A3']);
  assert.deepEqual(await list(`from=${ago(5 * 86400000).toISOString()}&to=${ago(2 * 86400000).toISOString()}`), ['A2']);
  assert.deepEqual(await list(''), ['A1', 'A2', 'A3']);
  assert.equal((await api(`/api/alerts?deviceId=${D}&from=nonsense`)).status, 400);
});

test('missing temperature data raises ONE alert and resolves when it returns', async () => {
  const D = 'MISS-001';
  await post(reading(D, 28, 7.2));
  await post({ deviceId: D, ph: 7.2 }); // temperature absent
  await post({ deviceId: D, ph: 7.2 });
  const miss = (await json(`/api/alerts?deviceId=${D}&kind=sensor_missing`)).alerts;
  assert.equal(miss.length, 1);
  assert.equal(miss[0].active, true);
  assert.equal(miss[0].sensor, 'temperature');
  await post(reading(D, 28, 7.2));
  assert.equal((await json(`/api/alerts?deviceId=${D}&kind=sensor_missing&active=true`)).alerts.length, 0);
});

test('a sensor that never existed (e.g. no turbidity probe) does NOT raise missing-data alerts', async () => {
  const D = 'TWO-001';
  await post({ deviceId: D, temperature: 28, ph: 7.2 });
  await post({ deviceId: D, temperature: 28, ph: 7.2 });
  assert.equal((await json(`/api/alerts?deviceId=${D}&kind=sensor_missing`)).alerts.length, 0);
});

test('device offline: watchdog raises one alert; the next transmission resolves it and logs recovery', async () => {
  const D = 'OFF-001';
  await post(reading(D, 28, 7.2));
  assert.equal((await watchdog.checkDevices()).filter((a) => a.deviceId === D).length, 0, 'fresh device is not offline');

  await Device.updateOne({ deviceId: D }, { $set: { lastSeen: new Date(Date.now() - 15 * 60000) } });
  const first = (await watchdog.checkDevices()).filter((a) => a.deviceId === D);
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'device_offline');
  assert.equal(first[0].severity, 'WARNING');
  assert.match(first[0].reason, /No data has been received for 15 minutes/);
  assert.equal((await watchdog.checkDevices()).filter((a) => a.deviceId === D).length, 0, 'de-duplicated');

  const st = await json(`/api/device/status?deviceId=${D}`);
  assert.equal(st.online, false);
  assert.equal(st.sensors.temperature, 'ok');

  await post(reading(D, 28, 7.2));
  assert.equal((await json(`/api/alerts?deviceId=${D}&kind=device_offline&active=true`)).alerts.length, 0);
  const back = (await json(`/api/alerts?deviceId=${D}&kind=device_online`)).alerts;
  assert.equal(back.length, 1);
  assert.equal(back[0].severity, 'INFO');
  assert.equal((await json(`/api/device/status?deviceId=${D}`)).online, true);
});

/* ============================ data ranges / misc ============================ */

test('history covers the WHOLE range when it exceeds the limit (bucketing)', async () => {
  const D2 = 'BUCKET-001';
  const now = Date.now();
  const docs = [];
  for (let i = 0; i < 720; i++) {
    docs.push({ deviceId: D2, temperature: 20 + i / 100, ph: 7, turbidity: 10, rain: 0, conductivity: 400, timestamp: new Date(now - (720 - i) * 3600 * 1000 + 1000) });
  }
  await SensorReading.insertMany(docs);
  const res = await json(`/api/sensors/temperature?deviceId=${D2}&range=30d&limit=60`);
  assert.equal(res.bucketed, true);
  assert.ok(res.count <= 60 && res.count >= 55, `bucket count ${res.count}`);
  assert.ok(now - new Date(res.series[0].timestamp).getTime() > 29 * 24 * 3600 * 1000, 'starts near the START of the range');
  for (let i = 1; i < res.series.length; i++) assert.ok(res.series[i].value >= res.series[i - 1].value);
  const raw = await json(`/api/sensors/temperature?deviceId=${D2}&range=30d&limit=1000`);
  assert.equal(raw.bucketed, false);
  assert.equal(raw.count, 720);
  const hist = await json(`/api/sensors/history?deviceId=${D2}&range=30d&limit=50`);
  assert.ok(Array.isArray(hist) && hist.length <= 50 && hist.length >= 45);
  // species history on bucketed data still reports a rising trend and the true min/max
  const sh = await json(`/api/species/tilapia/history?deviceId=${D2}&range=30d&limit=100`);
  assert.equal(sh.bucketed, true);
  assert.ok(sh.count <= 100);
  assert.equal(sh.summary.temperature.min, 20);
  assert.equal(sh.summary.temperature.max, 27.19);
});

test('summary gives exact min/avg/max and time-in-SAFE over the full range (margin aware)', async () => {
  const D3 = 'SUMMARY-001';
  const now = Date.now();
  // tilapia: safe means 26-29 C (25-30 with a 1 C margin) -> 26, 28 are safe; 24, 30, 33 are not
  const temps = [24, 26, 28, 30, 33];
  await SensorReading.insertMany(
    temps.map((t, i) => ({ deviceId: D3, temperature: t, ph: 7, turbidity: 10, rain: 0, conductivity: 400, timestamp: new Date(now - (i + 1) * 60000) }))
  );
  const s = await json(`/api/sensors/summary?deviceId=${D3}&range=24h`);
  assert.equal(s.count, 5);
  assert.equal(s.sensors.temperature.min, 24);
  assert.equal(s.sensors.temperature.max, 33);
  assert.equal(s.sensors.temperature.avg, 28.2);
  assert.equal(s.sensors.temperature.safePct, 40);
  assert.equal(s.sensors.turbidity.safePct, 100, 'one-sided sensors work');
  await putSpecies('carp', D3); // carp safe = 21-27: 24, 26 safe
  assert.equal((await json(`/api/sensors/summary?deviceId=${D3}&range=24h`)).sensors.temperature.safePct, 40);
  const empty = await json('/api/sensors/summary?deviceId=NOPE&range=1h');
  assert.equal(empty.count, 0);
  assert.equal(empty.sensors.temperature.avg, null);
});

test('/summary and /records are not swallowed by /:sensor; unknown sensors 400', async () => {
  assert.equal((await api('/api/sensors/summary')).status, 200);
  assert.equal((await api('/api/sensors/records')).status, 200);
  assert.equal((await api('/api/sensors/banana')).status, 400);
});

test('device status exposes heartbeat and per-sensor health', async () => {
  const st = await json('/api/device/status?deviceId=SPEC-001');
  assert.equal(st.online, true);
  assert.equal(st.offlineAfterSeconds, 180);
  assert.deepEqual(st.sensors, { temperature: 'ok', ph: 'ok' });
  await SensorReading.create({ deviceId: 'SPEC-001', temperature: null, ph: 7.1, timestamp: new Date(Date.now() + 1000) });
  assert.equal((await json('/api/device/status?deviceId=SPEC-001')).sensors.temperature, 'no_data');
  assert.equal((await api('/api/device/status?deviceId=NOPE')).status, 404);
});

test('PUT device species validates input', async () => {
  assert.equal((await putSpecies('shark', 'V-001')).status, 400);
  assert.equal((await send('PUT', '/api/device/species', { species: 'carp' })).status, 400);
  assert.equal((await api('/api/device/species', { method: 'PUT', body: '{not json' })).status, 400);
});

test('dashboard polling is not rate-limited at the old 120/min (reads allow 600/min)', async () => {
  const codes = await Promise.all(Array.from({ length: 200 }, () => api('/api/health').then((r) => r.status)));
  assert.equal(codes.filter((c) => c === 429).length, 0, 'no 429 for 200 reads in a burst');
});

test('CORS preflight allows every method the dashboard uses (PUT, PATCH, DELETE, POST)', async () => {
  for (const method of ['PUT', 'PATCH', 'DELETE', 'POST']) {
    const res = await api('/api/alerts/507f1f77bcf86cd799439011/read', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'content-type' },
    });
    const allowed = res.headers.get('access-control-allow-methods') || '';
    assert.ok(allowed.split(',').map((m) => m.trim()).includes(method), `${method} missing from: ${allowed}`);
  }
});

test('CORS: localhost and listed origins allowed, look-alikes blocked', async () => {
  const get = (origin) => api('/api/health', { headers: { Origin: origin } });
  assert.equal((await get('http://localhost:3000')).headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal((await get('https://my-app.vercel.app')).headers.get('access-control-allow-origin'), 'https://my-app.vercel.app');
  assert.equal((await get('https://evil-localhost.com')).headers.get('access-control-allow-origin'), null);
});
