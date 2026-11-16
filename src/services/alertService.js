const Alert = require('./../models/Alert');
const registry = require('./speciesRegistry');
const { SENSOR_KEYS, safeRangeText } = require('./statusService');
const { explain, LABEL, lc } = require('./assessmentService');

const CORE = ['temperature', 'ph']; // sensors the farm actually relies on
const THRESHOLD = { $in: ['threshold', null] }; // legacy alerts have no `kind`

/*
 * Alert generation with de-duplication.
 *  - A sensor going out of range creates ONE alert (kind "threshold"); further
 *    readings in the same condition only refresh that alert's value.
 *  - Severity can change in place (WARNING <-> DANGER) - including when the fish
 *    species / limits change - without creating a duplicate.
 *  - Returning to SAFE resolves the alert.
 *  - temperature / pH that stop arriving create ONE "sensor_missing" alert.
 * Device offline / back-online alerts live in watchdog.js / deviceService.js.
 */
async function processAlerts(deviceId, readings, statuses, previousReading, species) {
  const sp = registry.get(species) || registry.get(registry.defaultId());
  const created = [];

  for (const sensor of SENSOR_KEYS) {
    const status = statuses[sensor];
    const value = readings[sensor];

    // ---- missing temperature / pH (only if it was reporting before) -----------
    if (CORE.includes(sensor)) {
      const missing = await Alert.findOne({ deviceId, sensor, kind: 'sensor_missing', active: true });
      const wasReporting = previousReading && previousReading[sensor] != null;
      if ((value === null || value === undefined) && wasReporting && !missing) {
        created.push(
          await Alert.create({
            deviceId, sensor, kind: 'sensor_missing', severity: 'WARNING', species: sp.id, speciesName: sp.name,
            title: `Missing ${lc(sensor)} data`,
            reason: `The latest transmission did not include a ${lc(sensor)} value although the previous one did.`,
            recommendation: `Check the ${lc(sensor)} sensor, its wiring and calibration.`,
            message: `${LABEL[sensor]} data is missing`,
            threshold: safeRangeText(sensor, sp.id),
          })
        );
      } else if (value !== null && value !== undefined && missing) {
        missing.active = false;
        missing.resolvedAt = new Date();
        await missing.save();
      }
    }

    // ---- threshold alerts -------------------------------------------------------
    const existing = await Alert.findOne({ deviceId, sensor, kind: THRESHOLD, active: true });
    const prevValue = previousReading ? previousReading[sensor] : null;

    if (status === 'WARNING' || status === 'DANGER') {
      const x = explain(sensor, value, sp.id);
      const fields = {
        severity: status, value, previousValue: prevValue, species: sp.id, speciesName: sp.name,
        direction: x.direction, threshold: safeRangeText(sensor, sp.id),
        reason: x.reason, recommendation: x.recommendation, message: x.reason,
        title: `${x.direction === 'low' ? 'Low' : 'High'} ${lc(sensor)}`,
      };
      if (!existing) {
        created.push(await Alert.create({ deviceId, sensor, kind: 'threshold', ...fields }));
      } else {
        // Same ongoing condition (or severity/limits changed): refresh in place, no duplicate.
        Object.assign(existing, fields);
        await existing.save();
      }
    } else if (existing) {
      existing.active = false;
      existing.resolvedAt = new Date();
      await existing.save();
    }
  }
  return created;
}

module.exports = { processAlerts };
