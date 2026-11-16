/*
 * Species-aware environmental assessment: the ONE place that turns raw readings
 * into a status, an exact human-readable reason and a recommended action.
 * Used by the species pages, alerts, history/excursions and the dashboard so
 * the rules are identical everywhere.
 */
const registry = require('./speciesRegistry');
const { classify, thresholdsFor } = require('./statusService');

const CORE_PARAMS = ['temperature', 'ph']; // species-specific assessment is based on these two
const LABEL = {
  temperature: 'Water temperature',
  ph: 'Water pH',
  turbidity: 'Turbidity',
  rain: 'Rain level',
  conductivity: 'Conductivity / TDS',
};
/** 'Water pH' -> 'water pH' (lower-case first letter only, so pH keeps its capital H). */
const lc = (sensor) => { const l = LABEL[sensor] || sensor; return l.charAt(0).toLowerCase() + l.slice(1); };
const DECIMALS = { temperature: 1, ph: 2, turbidity: 1, rain: 0, conductivity: 0 };
const PLAUSIBLE = { temperature: [-5, 60], ph: [0, 14] }; // outside this = sensor fault, not a measurement
const RANK = { DANGER: 3, WARNING: 2, UNKNOWN: 1, SAFE: 0 };

const staleSeconds = () =>
  parseInt(process.env.READING_STALE_SECONDS, 10) || parseInt(process.env.DEVICE_OFFLINE_SECONDS, 10) || 180;

const isValid = (sensor, v) => {
  if (v === null || v === undefined || typeof v !== 'number' || !Number.isFinite(v)) return false;
  const p = PLAUSIBLE[sensor];
  return !p || (v >= p[0] && v <= p[1]);
};

const fmt = (sensor, v, unit = '') => `${Number(v).toFixed(DECIMALS[sensor] ?? 1)}${unit ? ` ${unit}` : ''}`;

function humanAge(seconds) {
  if (seconds == null) return 'an unknown time';
  if (seconds < 90) return `${seconds} seconds`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

/* Corrective-action text. General guidance only - never a veterinary guarantee. */
const ACTIONS = {
  temperature: {
    high: {
      WARNING:
        'Monitor closely. Consider adding shade, increasing aeration or doing a partial water exchange with cooler water, then re-check the reading.',
      DANGER:
        'Act promptly: check the water temperature with a second thermometer and take cooling measures (shade, strong aeration, cooler water exchange). Reduce feeding until it recovers.',
    },
    low: {
      WARNING: 'Monitor closely. Consider reducing water exchange with colder water and protecting the pond from wind and cold inflow.',
      DANGER:
        'Act promptly: verify with a second thermometer and take warming/insulating measures where practical. Reduce feeding until temperature recovers.',
    },
  },
  ph: {
    high: {
      WARNING: 'Monitor pH fluctuations. Check for algae blooms, over-liming or source-water changes and re-test shortly.',
      DANGER:
        'Confirm with a calibrated test kit, then investigate the cause (algae bloom, liming, source water). Make only gradual corrections and consider a partial water exchange.',
    },
    low: {
      WARNING: 'Monitor pH fluctuations. Check for organic build-up or acidic inflow and re-test shortly.',
      DANGER:
        'Confirm with a calibrated test kit, then investigate the cause (acidic inflow, organic build-up). Make only gradual corrections and consider a partial water exchange.',
    },
  },
};

function recommend(sensor, status, direction) {
  if (status === 'SAFE') return '';
  if (status === 'UNKNOWN') {
    return `Check the ${lc(sensor)} sensor, its wiring and calibration, and the device's connection.`;
  }
  const byDir = ACTIONS[sensor]?.[direction]?.[status];
  if (byDir) return byDir;
  return `Check the ${lc(sensor)} source and verify the reading with a manual test if it looks abnormal.`;
}

/** "25 – 30 °C" style text for the recommended range. */
function expectedText(sensor, speciesId) {
  const t = thresholdsFor(speciesId)[sensor];
  if (!t) return '';
  const u = t.unit ? ` ${t.unit}` : '';
  const d = DECIMALS[sensor] ?? 1;
  const lo = Number.isFinite(t.safeLow) ? Number(t.safeLow.toFixed(d)) : null;
  const hi = Number.isFinite(t.safeHigh) ? Number(t.safeHigh.toFixed(d)) : null;
  if (lo !== null && hi !== null) return `${lo} – ${hi}${u}`;
  if (hi !== null) return `≤ ${hi}${u}`;
  if (lo !== null) return `≥ ${lo}${u}`;
  return '';
}

/** Explain ONE parameter for ONE species: status, direction, exact reason, action. */
function explain(sensor, value, speciesId) {
  const sp = registry.get(speciesId) || registry.get(registry.defaultId());
  const t = thresholdsFor(sp.id)[sensor];
  const label = LABEL[sensor] || sensor;
  const unit = t?.unit || '';
  const base = { sensor, label, value: null, unit, expected: expectedText(sensor, sp.id) };

  if (!t || !isValid(sensor, value)) {
    const invalid = value !== null && value !== undefined;
    return {
      ...base,
      status: 'UNKNOWN',
      direction: null,
      reason: invalid
        ? `${label} reading (${value}) is outside the physically plausible range, so it may be a sensor fault.`
        : `No ${lc(sensor)} reading is available.`,
      recommendation: recommend(sensor, 'UNKNOWN', null),
    };
  }

  const status = classify(sensor, value, sp.id);
  const v = fmt(sensor, value, unit);
  // Limits read naturally ('30 °C', not '30.0 °C').
  const u = (n) => `${Number(Number(n).toFixed(DECIMALS[sensor] ?? 1))}${unit ? ` ${unit}` : ''}`;
  const m = t.warnMargin || 0;
  let direction = null;
  let reason;

  if (value > t.warnHigh) {
    direction = 'high';
    reason = `${label} ${v} exceeds the recommended maximum of ${u(t.safeHigh)} for ${sp.name} and is above the danger limit of ${u(t.warnHigh)}.`;
  } else if (value < t.warnLow) {
    direction = 'low';
    reason = `${label} ${v} is below the recommended minimum of ${u(t.safeLow)} for ${sp.name} and under the danger limit of ${u(t.warnLow)}.`;
  } else if (value > t.safeHigh) {
    direction = 'high';
    reason = `${label} ${v} is above the recommended maximum of ${u(t.safeHigh)} for ${sp.name}. It is still below the danger limit of ${u(t.warnHigh)}.`;
  } else if (value < t.safeLow) {
    direction = 'low';
    reason = `${label} ${v} is below the recommended minimum of ${u(t.safeLow)} for ${sp.name}. It is still above the danger limit of ${u(t.warnLow)}.`;
  } else if (m > 0 && value > t.safeHigh - m) {
    direction = 'high';
    reason = `${label} ${v} is approaching the recommended maximum of ${u(t.safeHigh)} for ${sp.name}.`;
  } else if (m > 0 && value < t.safeLow + m) {
    direction = 'low';
    reason = `${label} ${v} is approaching the recommended minimum of ${u(t.safeLow)} for ${sp.name}.`;
  } else {
    reason = `${label} ${v} is within the recommended range of ${expectedText(sensor, sp.id)} for ${sp.name}.`;
  }

  return { ...base, value, status, direction, reason, recommendation: recommend(sensor, status, direction) };
}

/** Worst status wins: DANGER > WARNING > UNKNOWN > SAFE (missing data is never shown as safe). */
function worst(statuses) {
  return statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'SAFE');
}

/**
 * Assess the latest reading for a species.
 * Stale / missing readings -> UNKNOWN (the last known status is still reported
 * as `lastKnownStatus` so the UI can say "was SAFE 20 minutes ago").
 */
function assessSpecies(speciesId, reading, opts = {}) {
  const sp = registry.get(speciesId) || registry.get(registry.defaultId());
  const now = opts.now || Date.now();
  const limit = opts.staleSeconds ?? staleSeconds();
  const ts = reading?.timestamp ? new Date(reading.timestamp) : null;
  const ageSeconds = ts ? Math.max(0, Math.round((now - ts.getTime()) / 1000)) : null;
  const noData = !reading;
  const stale = !noData && ageSeconds !== null && ageSeconds > limit;

  const parameters = {};
  for (const p of CORE_PARAMS) parameters[p] = explain(p, reading ? reading[p] : null, sp.id);
  const lastKnownStatus = noData ? 'UNKNOWN' : worst(CORE_PARAMS.map((p) => parameters[p].status));
  const status = noData || stale ? 'UNKNOWN' : lastKnownStatus;

  const reasons = [];
  const recommendations = [];
  if (noData) {
    reasons.push('No sensor readings have been received yet.');
    recommendations.push('Power on the device and confirm it can reach the server.');
  } else if (stale) {
    reasons.push(
      `The last reading is ${humanAge(ageSeconds)} old, so the current condition cannot be confirmed (expected at least every ${humanAge(limit)}).`
    );
    recommendations.push('Check the ESP32 power, SIM800L signal/credit and wiring.');
  }
  for (const p of CORE_PARAMS) {
    const x = parameters[p];
    if (x.status !== 'SAFE' && !(stale && x.status === 'UNKNOWN')) {
      reasons.push(x.reason);
      if (x.recommendation && !recommendations.includes(x.recommendation)) recommendations.push(x.recommendation);
    }
  }

  const message =
    status === 'SAFE'
      ? 'Both environmental parameters are within the configured recommended ranges.'
      : status === 'UNKNOWN'
      ? 'The current condition cannot be determined reliably.'
      : status === 'WARNING'
      ? 'At least one parameter is approaching or slightly outside its recommended range.'
      : 'At least one parameter is outside the acceptable limits for this species.';

  return {
    species: { id: sp.id, name: sp.name, scientific: sp.scientific },
    status,
    lastKnownStatus,
    stale,
    noData,
    readingTimestamp: ts,
    ageSeconds,
    staleAfterSeconds: limit,
    message,
    parameters,
    reasons,
    recommendations,
  };
}

module.exports = {
  CORE_PARAMS, LABEL, lc, RANK, assessSpecies, explain, expectedText, recommend, worst, staleSeconds, humanAge, isValid,
};
