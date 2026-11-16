const SensorReading = require('../models/SensorReading');
const { getDailyMeans } = require('../services/readingService');
const { listSpecies, parseInput, calculate: runCalculation } = require('../services/feasibilityService');
const { GENERAL } = require('../config/aquaculture');

/** GET /api/feasibility/species — species the calculator supports (from config/aquaculture.js). */
function species(req, res) {
  res.json({ species: listSpecies() });
}

/**
 * POST /api/feasibility/calculate
 * Body: { deviceId, species, stock, avgWeightG?, stockingDate?, pondAreaM2?, pondVolumeM3?,
 *         mealsPerDay, feedKgPerDay, targetKg, deadline? | months?, survivalPct?,
 *         feedPricePerKg?, salePricePerKg? }
 * Sensor data is read automatically for `deviceId`; with no history the calculation
 * still runs on default conditions (and says so).
 */
async function calculate(req, res, next) {
  try {
    const now = new Date();
    const input = parseInput(req.body, now);
    let daily = [];
    let latest = null;
    if (input.deviceId) {
      [daily, latest] = await Promise.all([
        getDailyMeans({ deviceId: input.deviceId, days: GENERAL.HISTORY_DAYS, until: now }),
        SensorReading.findOne({ deviceId: input.deviceId }).sort({ timestamp: -1 }).lean(),
      ]);
      // A last reading older than the history window is not "current water": don't use it.
      if (latest && now - new Date(latest.timestamp) > GENERAL.HISTORY_DAYS * 86400000) latest = null;
    }
    res.json(runCalculation(input, { daily, latest }, now));
  } catch (err) {
    next(err);
  }
}

module.exports = { species, calculate };
