const SensorReading = require('../models/SensorReading');
const Device = require('../models/Device');
const registry = require('./speciesRegistry');
const { SENSOR_KEYS, classify, computeStatuses, thresholdsFor, worstOf } = require('./statusService');

const RANGE_HOURS = { '1h': 1, '6h': 6, '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
const MAX_LIMIT = 5000;
const MAX_CUSTOM_DAYS = 366;

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });
const parseLimit = (v, dflt = 500) => Math.min(Math.max(parseInt(v, 10) || dflt, 1), MAX_LIMIT);
const rangeToSince = (range) => new Date(Date.now() - (RANGE_HOURS[range] || 24) * 3600 * 1000);
const round = (n, d = 3) => (n === null || n === undefined ? null : +Number(n).toFixed(d));

/**
 * Resolve a time window from either a preset `range` (1h/6h/24h/7d/30d) or a
 * custom `from` / `to` pair of ISO dates. Throws a 400 for invalid input.
 */
function resolveWindow({ range, from, to } = {}) {
  if (from || to) {
    const since = new Date(from || 0);
    const until = to ? new Date(to) : new Date();
    if (!from || Number.isNaN(since.getTime())) throw httpError(400, '`from` must be a valid date');
    if (Number.isNaN(until.getTime())) throw httpError(400, '`to` must be a valid date');
    if (since >= until) throw httpError(400, '`from` must be before `to`');
    if (until - since > MAX_CUSTOM_DAYS * 86400000) throw httpError(400, `Custom range is limited to ${MAX_CUSTOM_DAYS} days`);
    return { since, until, range: 'custom', custom: true };
  }
  const key = RANGE_HOURS[range] ? range : '24h';
  return { since: rangeToSince(key), until: new Date(), range: key, custom: false };
}

/** Species currently configured for a device (default when unknown / no deviceId). */
async function speciesForDevice(deviceId) {
  if (!deviceId) return registry.defaultId();
  const d = await Device.findOne({ deviceId }).select('species').lean();
  return d && registry.has(d.species) ? d.species : registry.defaultId();
}

/** Re-evaluate a stored reading against a species so switching/editing is instant. */
function withCurrentStatus(doc, species) {
  const { statuses, overallStatus } = computeStatuses(doc, species);
  return { ...doc, statuses, overallStatus, species };
}

function buildFilter(deviceId, since, until) {
  const filter = { timestamp: { $gte: since, ...(until ? { $lte: until } : {}) } };
  if (deviceId) filter.deviceId = deviceId;
  return filter;
}

/*
 * Time-bucketed aggregation. When a window holds more readings than `limit`
 * the whole window is split into equal buckets and averaged (min/max kept so
 * short spikes are not hidden) instead of returning only the newest rows.
 */
async function bucketAggregate(filter, win, limit, keys) {
  // (limit - 1): buckets are not aligned to the window start, so one extra bucket may be straddled.
  const bucketMs = Math.max(1000, Math.ceil((win.until - win.since) / Math.max(limit - 1, 1)));
  const group = {
    _id: { $floor: { $divide: [{ $toLong: '$timestamp' }, bucketMs] } },
    t: { $avg: { $toLong: '$timestamp' } },
    n: { $sum: 1 },
  };
  for (const k of keys) {
    group[`avg_${k}`] = { $avg: `$${k}` };
    group[`min_${k}`] = { $min: `$${k}` };
    group[`max_${k}`] = { $max: `$${k}` };
  }
  return SensorReading.aggregate([{ $match: filter }, { $group: group }, { $sort: { _id: 1 } }]);
}

/** All-sensor history (chronological array). Used for sparklines. */
async function getHistory({ deviceId, range = '24h', from, to, limit, species: speciesOverride }) {
  const lim = parseLimit(limit);
  const win = resolveWindow({ range, from, to });
  const filter = buildFilter(deviceId, win.since, win.until);
  const species = speciesOverride || (await speciesForDevice(deviceId));

  const count = await SensorReading.countDocuments(filter);
  if (count <= lim) {
    const docs = await SensorReading.find(filter).sort({ timestamp: -1 }).limit(lim).lean();
    return docs.reverse().map((d) => withCurrentStatus(d, species));
  }
  const rows = await bucketAggregate(filter, win, lim, SENSOR_KEYS);
  return rows.map((r) => {
    const reading = { deviceId: deviceId || null, timestamp: new Date(Math.round(r.t)), samples: r.n };
    for (const k of SENSOR_KEYS) reading[k] = round(r[`avg_${k}`]);
    return withCurrentStatus(reading, species);
  });
}

/** One sensor's series: [{ timestamp, value, status, min?, max? }]. */
async function getSensorSeries({ deviceId, sensor, range = '24h', from, to, limit, species: speciesOverride }) {
  const lim = parseLimit(limit);
  const win = resolveWindow({ range, from, to });
  const filter = buildFilter(deviceId, win.since, win.until);
  const species = speciesOverride || (await speciesForDevice(deviceId));

  const count = await SensorReading.countDocuments(filter);
  if (count <= lim) {
    const docs = await SensorReading.find(filter).sort({ timestamp: -1 }).limit(lim).select(`timestamp ${sensor}`).lean();
    return {
      species,
      bucketed: false,
      window: win,
      series: docs.reverse().map((d) => ({
        timestamp: d.timestamp,
        value: d[sensor],
        status: classify(sensor, d[sensor], species),
      })),
    };
  }
  const rows = await bucketAggregate(filter, win, lim, [sensor]);
  return {
    species,
    bucketed: true,
    window: win,
    series: rows.map((r) => {
      const min = round(r[`min_${sensor}`]);
      const max = round(r[`max_${sensor}`]);
      return {
        timestamp: new Date(Math.round(r.t)),
        value: round(r[`avg_${sensor}`]),
        min,
        max,
        samples: r.n,
        status: worstOf(classify(sensor, min, species), classify(sensor, max, species)),
      };
    }),
  };
}

/**
 * Temperature + pH series for the species pages/analytics. Every point carries
 * the min/max of its bucket (equal to the value for raw rows) so excursions
 * are detected even when the chart is downsampled.
 */
async function getCoreSeries({ deviceId, range = '24h', from, to, limit }) {
  const lim = parseLimit(limit, 600);
  const win = resolveWindow({ range, from, to });
  const filter = buildFilter(deviceId, win.since, win.until);
  const count = await SensorReading.countDocuments(filter);

  if (count <= lim) {
    const docs = await SensorReading.find(filter).sort({ timestamp: 1 }).select('timestamp temperature ph').lean();
    return {
      bucketed: false,
      window: win,
      points: docs.map((d) => ({
        timestamp: d.timestamp,
        temperature: d.temperature, temperatureMin: d.temperature, temperatureMax: d.temperature,
        ph: d.ph, phMin: d.ph, phMax: d.ph,
        samples: 1,
      })),
    };
  }
  const rows = await bucketAggregate(filter, win, lim, ['temperature', 'ph']);
  return {
    bucketed: true,
    window: win,
    points: rows.map((r) => ({
      timestamp: new Date(Math.round(r.t)),
      temperature: round(r.avg_temperature), temperatureMin: round(r.min_temperature), temperatureMax: round(r.max_temperature),
      ph: round(r.avg_ph), phMin: round(r.min_ph), phMax: round(r.max_ph),
      samples: r.n,
    })),
  };
}

/**
 * Exact per-sensor stats over the WHOLE window (min / avg / max and the share
 * of readings that are SAFE for the species), computed in MongoDB so they stay
 * correct even when charts are downsampled. "Safe" excludes the warning margin.
 */
async function getSummary({ deviceId, range = '24h', from, to, species: speciesOverride }) {
  const win = resolveWindow({ range, from, to });
  const species = speciesOverride || (await speciesForDevice(deviceId));
  const th = thresholdsFor(species);

  const group = { _id: null, count: { $sum: 1 } };
  for (const k of SENSOR_KEYS) {
    const f = `$${k}`;
    const t = th[k];
    const m = t.warnMargin || 0;
    const safeConds = [{ $gt: [f, null] }];
    if (Number.isFinite(t.safeLow)) safeConds.push({ $gte: [f, t.safeLow + m] });
    if (Number.isFinite(t.safeHigh)) safeConds.push({ $lte: [f, t.safeHigh - m] });
    group[`min_${k}`] = { $min: f };
    group[`max_${k}`] = { $max: f };
    group[`avg_${k}`] = { $avg: f };
    group[`n_${k}`] = { $sum: { $cond: [{ $gt: [f, null] }, 1, 0] } };
    group[`safe_${k}`] = { $sum: { $cond: [{ $and: safeConds }, 1, 0] } };
  }

  const [r] = await SensorReading.aggregate([{ $match: buildFilter(deviceId, win.since, win.until) }, { $group: group }]);
  const sensors = {};
  for (const k of SENSOR_KEYS) {
    const n = r ? r[`n_${k}`] : 0;
    sensors[k] = {
      count: n,
      min: n ? round(r[`min_${k}`]) : null,
      avg: n ? round(r[`avg_${k}`]) : null,
      max: n ? round(r[`max_${k}`]) : null,
      safePct: n ? Math.round((r[`safe_${k}`] / n) * 100) : null,
    };
  }
  return { range: win.range, species, since: win.since, until: win.until, count: r ? r.count : 0, sensors };
}

module.exports = {
  RANGE_HOURS, httpError, parseLimit, rangeToSince, resolveWindow, speciesForDevice, withCurrentStatus,
  buildFilter, getHistory, getSensorSeries, getCoreSeries, getSummary,
};
