const { THRESHOLDS: BASE, SENSOR_KEYS } = require('../config/thresholds');
const registry = require('./speciesRegistry');

/*
 * Threshold resolution is species-aware: base thresholds (label, unit, default
 * limits) merged with the species' overrides. Results are cached per species
 * because they are static configuration.
 */
const cache = new Map();
registry.onChange(() => cache.clear()); // species edited -> recompute

function thresholdsFor(speciesId) {
  const id = registry.has(speciesId) ? speciesId : registry.defaultId();
  if (!cache.has(id)) {
    const sp = registry.get(id);
    const merged = {};
    for (const key of SENSOR_KEYS) {
      merged[key] = { warnMargin: 0, ...BASE[key], ...((sp && sp.thresholds[key]) || {}) };
    }
    cache.set(id, Object.freeze(merged));
  }
  return cache.get(id);
}

/**
 * Classify a single numeric value against a sensor's threshold band.
 * Mirrors the classify() function in the ESP32 firmware.
 * @returns {'SAFE'|'WARNING'|'DANGER'|'UNKNOWN'}
 */
function classify(sensorKey, value, speciesId) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'UNKNOWN';
  const t = thresholdsFor(speciesId)[sensorKey];
  if (!t) return 'UNKNOWN';
  if (value < t.warnLow || value > t.warnHigh) return 'DANGER';
  if (value < t.safeLow || value > t.safeHigh) return 'WARNING';
  // Inside the recommended range but close to an edge: "approaching a limit".
  const m = t.warnMargin || 0;
  if (m > 0 && (value < t.safeLow + m || value > t.safeHigh - m)) return 'WARNING';
  return 'SAFE';
}

/**
 * Given a raw readings object, compute per-sensor statuses + overall status.
 * The server is authoritative: it always recomputes, even if the device sent
 * its own statuses, so the dashboard can never disagree with the thresholds.
 */
function computeStatuses(readings, speciesId) {
  const statuses = {};
  for (const key of SENSOR_KEYS) {
    statuses[key] = classify(key, readings[key], speciesId);
  }
  return { statuses, overallStatus: overallOf(statuses) };
}

function overallOf(statuses) {
  const values = Object.values(statuses);
  if (values.includes('DANGER')) return 'DANGER';
  if (values.includes('WARNING')) return 'WARNING';
  if (values.every((s) => s === 'UNKNOWN')) return 'UNKNOWN';
  return 'SAFE';
}

/** Worst of several statuses (used when a chart bucket spans multiple readings). */
function worstOf(...statuses) {
  if (statuses.includes('DANGER')) return 'DANGER';
  if (statuses.includes('WARNING')) return 'WARNING';
  if (statuses.includes('SAFE')) return 'SAFE';
  return 'UNKNOWN';
}

/** Human-readable safe range string for alert messages, e.g. "25 - 32 °C". */
function safeRangeText(sensorKey, speciesId) {
  const t = thresholdsFor(speciesId)[sensorKey];
  if (!t) return '';
  const lo = t.safeLow === -Infinity ? '' : t.safeLow;
  const hi = t.safeHigh;
  const unit = t.unit ? ` ${t.unit}` : '';
  return lo === '' ? `<= ${hi}${unit}` : `${lo} - ${hi}${unit}`;
}

module.exports = {
  classify,
  computeStatuses,
  overallOf,
  worstOf,
  safeRangeText,
  thresholdsFor,
  THRESHOLDS: BASE, // backwards compatible export (tilapia/base values)
  SENSOR_KEYS,
};
