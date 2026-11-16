const SensorReading = require('../models/SensorReading');
const Device = require('../models/Device');
const { computeStatuses, SENSOR_KEYS } = require('../services/statusService');
const { processAlerts } = require('../services/alertService');
const readings = require('../services/readingService');
const { onDeviceSeen } = require('../services/deviceService');

/**
 * POST /api/sensors/data   (device-only, requires x-api-key)
 * Ingest one reading, recompute statuses server-side (using the device's
 * configured fish species), store it, update the device and generate
 * de-duplicated alerts.
 */
async function ingest(req, res, next) {
  try {
    const body = req.body;
    const deviceId = body.deviceId;

    // Extract only known sensor fields (ignore anything extra).
    const values = {};
    for (const key of SENSOR_KEYS) {
      values[key] = body[key] === undefined || body[key] === null ? null : Number(body[key]);
    }

    const species = await readings.speciesForDevice(deviceId);
    const { statuses, overallStatus } = computeStatuses(values, species);

    // Previous reading (for alert "previousValue" context).
    const previous = await SensorReading.findOne({ deviceId }).sort({ timestamp: -1 }).lean();

    const doc = await SensorReading.create({
      deviceId,
      ...values,
      statuses,
      overallStatus,
      species,
      signal: body.signal === undefined ? null : Number(body.signal),
      timestamp: new Date(),
    });

    // Upsert device record (species is only set on first insert; never overwritten here).
    await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: { lastSeen: doc.timestamp, lastSignal: doc.signal, lastStatus: overallStatus },
        $inc: { totalReadings: 1 },
        $setOnInsert: { deviceId, name: `FishSafe ${deviceId}`, createdAt: new Date() },
      },
      { upsert: true, new: true }
    );

    // Close any open "device offline" alert now that data is flowing again (non-fatal).
    try {
      await onDeviceSeen(deviceId);
    } catch (e) {
      console.error('[ALERT] recovery handling failed:', e.message);
    }

    // Alert generation (non-fatal if it fails).
    let alerts = [];
    try {
      alerts = await processAlerts(deviceId, values, statuses, previous, species);
    } catch (e) {
      console.error('[ALERT] processing failed:', e.message);
    }

    res.status(201).json({
      ok: true,
      id: doc._id,
      species,
      overallStatus,
      statuses,
      alertsCreated: alerts.length,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/sensors/latest?deviceId=...  -> most recent reading (statuses for the CURRENT species). */
async function latest(req, res, next) {
  try {
    const { deviceId } = req.query;
    const filter = deviceId ? { deviceId } : {};
    const doc = await SensorReading.findOne(filter).sort({ timestamp: -1 }).lean();
    if (!doc) return res.status(404).json({ error: 'No readings yet' });
    const species = await readings.speciesForDevice(doc.deviceId);
    res.json(readings.withCurrentStatus(doc, species));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/sensors/history?deviceId=&range=24h&limit=  -> array (oldest->newest).
 * If the range holds more rows than `limit` the whole range is averaged into
 * `limit` evenly spaced buckets instead of returning only the newest rows.
 */
async function history(req, res, next) {
  try {
    const { deviceId, range, from, to, limit } = req.query;
    res.json(await readings.getHistory({ deviceId, range, from, to, limit }));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/sensors/:sensor?deviceId=&range=  -> time series for ONE sensor.
 * :sensor in {temperature, ph, turbidity, rain, conductivity}
 */
async function oneSensor(req, res, next) {
  try {
    const sensor = req.params.sensor;
    if (!SENSOR_KEYS.includes(sensor)) {
      return res.status(400).json({ error: `Unknown sensor: ${sensor}` });
    }
    const { deviceId, range, from, to, limit } = req.query;
    const out = await readings.getSensorSeries({ deviceId, sensor, range, from, to, limit });
    res.json({ sensor, species: out.species, bucketed: out.bucketed, count: out.series.length, series: out.series });
  } catch (err) {
    next(err);
  }
}

/** GET /api/sensors/summary?deviceId=&range=24h -> min/avg/max/safePct per sensor over the full range. */
async function summary(req, res, next) {
  try {
    const { deviceId, range, from, to } = req.query;
    res.json(await readings.getSummary({ deviceId, range, from, to }));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/sensors/records?deviceId=&from=&to=&page=1&pageSize=50[&format=csv]
 * Paginated raw readings (newest first) for the Historical Records page.
 * format=csv downloads up to 10 000 rows for the same filter.
 */
async function records(req, res, next) {
  try {
    const { deviceId, range, from, to, format } = req.query;
    const win = readings.resolveWindow({ range: range || '30d', from, to });
    const filter = readings.buildFilter(deviceId, win.since, win.until);
    const species = await readings.speciesForDevice(deviceId);

    if (format === 'csv') {
      const docs = await SensorReading.find(filter).sort({ timestamp: -1 }).limit(10000).lean();
      const cols = ['timestamp', 'temperature', 'ph', 'turbidity', 'rain', 'conductivity', 'signal', 'overallStatus'];
      const lines = [cols.join(',')];
      for (const d of docs) {
        const row = readings.withCurrentStatus(d, species);
        lines.push(cols.map((c) => (c === 'timestamp' ? new Date(row[c]).toISOString() : row[c] ?? '')).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="fishsafe-${deviceId || 'all'}-records.csv"`);
      return res.send(lines.join('\n'));
    }

    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 200);
    const total = await SensorReading.countDocuments(filter);
    const pages = Math.max(Math.ceil(total / pageSize), 1);
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
    const docs = await SensorReading.find(filter).sort({ timestamp: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean();
    res.json({
      species, total, page, pageSize, pages,
      window: { from: win.since, to: win.until, range: win.range },
      rows: docs.map((d) => readings.withCurrentStatus(d, species)),
    });
  } catch (err) { next(err); }
}

module.exports = { ingest, latest, history, oneSensor, summary, records };
