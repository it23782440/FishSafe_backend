const Device = require('../models/Device');
const Alert = require('../models/Alert');
const SensorReading = require('../models/SensorReading');
const registry = require('./speciesRegistry');
const { computeStatuses } = require('./statusService');
const { processAlerts } = require('./alertService');
const { humanAge } = require('./assessmentService');

const offlineSeconds = () => parseInt(process.env.DEVICE_OFFLINE_SECONDS, 10) || 180;

/**
 * Re-evaluate a device's newest reading (and its alerts) against its CURRENT
 * species limits. Call after the species or its thresholds change.
 */
async function reevaluate(deviceId) {
  const device = await Device.findOne({ deviceId }).select('species').lean();
  const species = device && registry.has(device.species) ? device.species : registry.defaultId();
  const latest = await SensorReading.findOne({ deviceId }).sort({ timestamp: -1 }).lean();
  if (!latest) return { species, overallStatus: 'UNKNOWN', statuses: null };
  const { statuses, overallStatus } = computeStatuses(latest, species);
  try {
    await processAlerts(deviceId, latest, statuses, null, species);
  } catch (e) {
    console.error('[ALERT] re-evaluation failed:', e.message);
  }
  await Device.updateOne({ deviceId }, { $set: { lastStatus: overallStatus } });
  return { species, overallStatus, statuses };
}

/** Called on every ingest: if the device had been reported offline, close that alert and log recovery. */
async function onDeviceSeen(deviceId) {
  const open = await Alert.find({ deviceId, kind: 'device_offline', active: true });
  for (const a of open) {
    a.active = false;
    a.resolvedAt = new Date();
    await a.save();
    await Alert.create({
      deviceId, sensor: 'device', kind: 'device_online', severity: 'INFO', active: false, resolvedAt: new Date(),
      title: 'Device back online',
      reason: `The device is sending data again after being offline for ${humanAge(Math.round((Date.now() - a.createdAt) / 1000))}.`,
      message: 'Device back online',
    });
  }
}

module.exports = { reevaluate, onDeviceSeen, offlineSeconds };
