const Device = require('../models/Device');
const SensorReading = require('../models/SensorReading');
const Alert = require('../models/Alert');
const registry = require('../services/speciesRegistry');
const { thresholdsFor } = require('../services/statusService');
const { speciesForDevice } = require('../services/readingService');
const { reevaluate, offlineSeconds } = require('../services/deviceService');
const { publicProfile } = require('./speciesController');

/**
 * GET /api/device/status?deviceId=...
 * Online/offline comes ONLY from `lastSeen` (when data last arrived) versus
 * DEVICE_OFFLINE_SECONDS - old stored readings never imply "online".
 * Also reports per-sensor health derived from the latest transmission.
 */
async function deviceStatus(req, res, next) {
  try {
    const offlineSecs = offlineSeconds();
    const now = Date.now();

    const decorate = async (d) => {
      const lastSeenMs = d.lastSeen ? new Date(d.lastSeen).getTime() : 0;
      const ageSec = lastSeenMs ? Math.round((now - lastSeenMs) / 1000) : null;
      const online = ageSec !== null && ageSec <= offlineSecs;
      const latest = await SensorReading.findOne({ deviceId: d.deviceId }).sort({ timestamp: -1 }).select('timestamp temperature ph signal').lean();
      const sensorState = (v) => (!latest ? 'unknown' : v === null || v === undefined ? 'no_data' : 'ok');
      return {
        ...d,
        species: registry.has(d.species) ? d.species : registry.defaultId(),
        online,
        secondsSinceLastSeen: ageSec,
        offlineAfterSeconds: offlineSecs,
        lastReadingAt: latest ? latest.timestamp : null,
        sensors: { temperature: sensorState(latest?.temperature), ph: sensorState(latest?.ph) },
      };
    };

    if (req.query.deviceId) {
      const d = await Device.findOne({ deviceId: req.query.deviceId }).lean();
      if (!d) return res.status(404).json({ error: 'Device not found' });
      return res.json(await decorate(d));
    }
    const devices = await Device.find().sort({ lastSeen: -1 }).lean();
    res.json({ count: devices.length, devices: await Promise.all(devices.map(decorate)) });
  } catch (err) { next(err); }
}

/** GET /api/config/thresholds[?species=carp][&deviceId=X] */
async function getThresholds(req, res, next) {
  try {
    let species = req.query.species;
    if (species !== undefined && !registry.has(species)) {
      return res.status(400).json({ error: `Unknown species. Use one of: ${registry.ids().join(', ')}` });
    }
    if (!species) species = await speciesForDevice(req.query.deviceId);
    res.json(thresholdsFor(species));
  } catch (err) { next(err); }
}

/**
 * PUT /api/device/species   body: { deviceId, species }
 * Choose which fish the pond is stocked with. Statuses are always evaluated
 * against the current species; alerts are re-evaluated immediately.
 */
async function setSpecies(req, res, next) {
  try {
    const { deviceId, species } = req.body || {};
    if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ error: 'deviceId (string) is required' });
    if (!registry.has(species)) return res.status(400).json({ error: `species must be one of: ${registry.ids().join(', ')}` });

    const before = await Device.findOne({ deviceId }).select('species').lean();
    const device = await Device.findOneAndUpdate(
      { deviceId },
      { $set: { species, speciesChangedAt: new Date() }, $setOnInsert: { deviceId, name: `FishSafe ${deviceId}`, createdAt: new Date() } },
      { upsert: true, new: true }
    ).lean();

    const result = await reevaluate(deviceId);
    if (before && before.species !== species) {
      await Alert.create({
        deviceId, sensor: 'device', kind: 'species_changed', severity: 'INFO', active: false, species,
        speciesName: registry.get(species).name, title: 'Pond species changed',
        reason: `Pond species changed from ${registry.get(before.species)?.name || before.species} to ${registry.get(species).name}. All limits now follow ${registry.get(species).name}.`,
        message: 'Pond species changed',
      });
    }
    res.json({ deviceId, species: device.species, profile: publicProfile(species), overallStatus: result.overallStatus, statuses: result.statuses });
  } catch (err) { next(err); }
}

module.exports = { deviceStatus, getThresholds, setSpecies };
