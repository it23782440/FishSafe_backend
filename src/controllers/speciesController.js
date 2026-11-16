const Species = require('../models/Species');
const Device = require('../models/Device');
const SensorReading = require('../models/SensorReading');
const registry = require('../services/speciesRegistry');
const { thresholdsFor } = require('../services/statusService');
const { assessSpecies } = require('../services/assessmentService');
const { speciesHistory } = require('../services/analyticsService');
const { speciesForDevice, httpError } = require('../services/readingService');
const { reevaluate } = require('../services/deviceService');

/** Public shape (limits resolved against base thresholds; -Infinity serialises to null). */
function publicProfile(id) {
  const s = registry.get(id);
  return {
    id: s.id, name: s.name, scientific: s.scientific, description: s.description,
    imageUrl: s.imageUrl, builtIn: s.builtIn, thresholds: thresholdsFor(id),
  };
}

const latestReading = (deviceId) => SensorReading.findOne({ deviceId }).sort({ timestamp: -1 }).lean();

/* ---------- validation ---------- */
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const PLAUSIBLE = { temperature: [-5, 60], ph: [0, 14] };
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}$/;

function parseRange(key, r, { required }) {
  if (!r || typeof r !== 'object') {
    if (required) throw httpError(400, `${key} limits are required`);
    return undefined;
  }
  const out = {
    warnLow: num(r.warnLow), safeLow: num(r.safeLow), safeHigh: num(r.safeHigh), warnHigh: num(r.warnHigh),
    warnMargin: num(r.warnMargin) ?? 0, source: 'custom',
  };
  const bounded = required; // temperature & pH must be bounded on both sides
  for (const f of ['warnLow', 'safeLow', 'safeHigh', 'warnHigh']) {
    if (out[f] !== null && !finite(out[f])) throw httpError(400, `${key}.${f} must be a number`);
    if (bounded && out[f] === null) throw httpError(400, `${key}.${f} is required`);
  }
  if (!finite(out.warnMargin) || out.warnMargin < 0) throw httpError(400, `${key}.warnMargin must be 0 or more`);
  const chain = ['warnLow', 'safeLow', 'safeHigh', 'warnHigh'].map((f) => out[f]).filter((x) => x !== null);
  for (let i = 1; i < chain.length; i += 1) {
    if (chain[i] < chain[i - 1]) throw httpError(400, `${key}: limits must satisfy warnLow ≤ safeLow ≤ safeHigh ≤ warnHigh`);
  }
  if (out.safeLow !== null && out.safeHigh !== null) {
    if (out.safeLow >= out.safeHigh) throw httpError(400, `${key}: safeLow must be below safeHigh`);
    if (out.warnMargin >= (out.safeHigh - out.safeLow) / 2) {
      throw httpError(400, `${key}.warnMargin must be smaller than half of the recommended range`);
    }
  }
  const p = PLAUSIBLE[key];
  if (p && chain.some((x) => x < p[0] || x > p[1])) throw httpError(400, `${key} limits must be between ${p[0]} and ${p[1]}`);
  return out;
}

function parseProfile(body, { create }) {
  if (!body || typeof body !== 'object') throw httpError(400, 'Request body is required');
  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 60) throw httpError(400, 'name must be 2–60 characters');
  const scientific = String(body.scientific || '').trim().slice(0, 80);
  const description = String(body.description || '').trim().slice(0, 400);
  const imageUrl = String(body.imageUrl || '').trim();
  if (imageUrl && !/^(https?:\/\/|\/)[^\s]{1,490}$/i.test(imageUrl)) {
    throw httpError(400, 'imageUrl must be an http(s) URL or a site-relative path');
  }
  const th = body.thresholds || {};
  const thresholds = {
    temperature: parseRange('temperature', th.temperature, { required: true }),
    ph: parseRange('ph', th.ph, { required: true }),
  };
  for (const k of ['turbidity', 'rain', 'conductivity']) {
    const r = parseRange(k, th[k], { required: false });
    if (r) thresholds[k] = r;
  }
  const out = { name, scientific, description, imageUrl, thresholds };
  if (create) {
    const slug = String(body.slug || name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!SLUG.test(slug)) throw httpError(400, 'Could not derive a valid id from the name');
    out.slug = slug;
  }
  return out;
}

/* ---------- handlers ---------- */

/** GET /api/species[?deviceId=] — every registered species; with deviceId also its current assessment + zone counts. */
async function list(req, res, next) {
  try {
    const { deviceId } = req.query;
    const profiles = registry.ids().map(publicProfile);
    const body = { default: registry.defaultId(), count: profiles.length, species: profiles };
    if (deviceId) {
      const latest = await latestReading(deviceId);
      const counts = { SAFE: 0, WARNING: 0, DANGER: 0, UNKNOWN: 0 };
      body.species = profiles.map((p) => {
        const assessment = assessSpecies(p.id, latest);
        counts[assessment.status] += 1;
        return { ...p, assessment };
      });
      body.pondSpecies = await speciesForDevice(deviceId);
      body.summary = { total: profiles.length, safe: counts.SAFE, warning: counts.WARNING, danger: counts.DANGER, unknown: counts.UNKNOWN };
      body.latestReadingAt = latest ? latest.timestamp : null;
    }
    res.json(body);
  } catch (err) { next(err); }
}

function mustExist(req) {
  if (!registry.has(req.params.id)) throw httpError(404, `Unknown species: ${req.params.id}`);
  return req.params.id;
}

async function get(req, res, next) {
  try { res.json(publicProfile(mustExist(req))); } catch (err) { next(err); }
}

/** GET /api/species/:id/assessment?deviceId= */
async function assessment(req, res, next) {
  try {
    const id = mustExist(req);
    const { deviceId } = req.query;
    if (!deviceId) throw httpError(400, 'deviceId is required');
    const out = assessSpecies(id, await latestReading(deviceId));
    res.json({ deviceId, ...out });
  } catch (err) { next(err); }
}

/** GET /api/species/:id/history?deviceId=&range=|from=&to= */
async function history(req, res, next) {
  try {
    const id = mustExist(req);
    const { deviceId, range, from, to, limit } = req.query;
    if (!deviceId) throw httpError(400, 'deviceId is required');
    res.json({ deviceId, ...(await speciesHistory({ speciesId: id, deviceId, range, from, to, limit })) });
  } catch (err) { next(err); }
}

async function devicesUsing(slug) {
  return Device.find({ species: slug }).select('deviceId').lean();
}

async function create(req, res, next) {
  try {
    const data = parseProfile(req.body, { create: true });
    if (await Species.exists({ slug: data.slug })) throw httpError(409, `A species with id "${data.slug}" already exists`);
    await Species.create({ ...data, builtIn: false });
    await registry.load();
    res.status(201).json(publicProfile(data.slug));
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const id = mustExist(req);
    const data = parseProfile(req.body, { create: false });
    // Update only the sensors that were sent; limits for other sensors (e.g. carp turbidity) are kept.
    const { thresholds, ...fields } = data;
    const set = { ...fields };
    for (const [k, v] of Object.entries(thresholds)) set[`thresholds.${k}`] = v;
    await Species.updateOne({ slug: id }, { $set: set });
    await registry.load();
    // Devices using this species get their latest reading + alerts re-evaluated with the new limits.
    for (const d of await devicesUsing(id)) await reevaluate(d.deviceId);
    res.json(publicProfile(id));
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const id = mustExist(req);
    if (registry.ids().length <= 1) throw httpError(409, 'At least one fish species must remain registered');
    const used = await devicesUsing(id);
    if (used.length) {
      throw httpError(409, `"${registry.get(id).name}" is the pond species of device ${used.map((d) => d.deviceId).join(', ')}. Choose another species for it first.`);
    }
    await Species.deleteOne({ slug: id });
    await registry.load();
    res.json({ ok: true, id });
  } catch (err) { next(err); }
}

module.exports = { publicProfile, list, get, assessment, history, create, update, remove };
