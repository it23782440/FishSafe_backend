/*
 * Connectivity watchdog. A device that stops transmitting cannot report its own
 * absence, so the server checks `lastSeen` periodically and raises ONE
 * "device_offline" alert per outage (de-duplicated; closed by deviceService.onDeviceSeen).
 */
const Device = require('../models/Device');
const Alert = require('../models/Alert');
const { humanAge } = require('./assessmentService');
const { offlineSeconds } = require('./deviceService');

async function checkDevices(now = Date.now()) {
  const limit = offlineSeconds();
  const cutoff = new Date(now - limit * 1000);
  const silent = await Device.find({ lastSeen: { $ne: null, $lt: cutoff } }).lean();
  const created = [];
  for (const d of silent) {
    const exists = await Alert.findOne({ deviceId: d.deviceId, kind: 'device_offline', active: true });
    if (exists) continue;
    const age = Math.round((now - new Date(d.lastSeen).getTime()) / 1000);
    created.push(
      await Alert.create({
        deviceId: d.deviceId, sensor: 'device', kind: 'device_offline', severity: 'WARNING',
        title: 'Device offline',
        reason: `No data has been received for ${humanAge(age)} (expected at least every ${humanAge(limit)}). Readings shown may be out of date.`,
        recommendation: 'Check ESP32 power, SIM800L signal/credit, antenna and wiring at the pond.',
        threshold: `A reading at least every ${humanAge(limit)}`,
        message: 'Device offline',
      })
    );
  }
  return created;
}

function start(intervalMs = 60000) {
  const timer = setInterval(() => checkDevices().catch((e) => console.error('[WATCHDOG]', e.message)), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { checkDevices, start };
