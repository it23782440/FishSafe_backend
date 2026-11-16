/*
 * Harvest Feasibility: "Can I reach this harvest by this date, and what must I do?"
 *
 * parseInput()  validates the farmer's form (400 with a plain message + field name)
 * calculate()   runs three week-by-week scenarios with the formulas in growthModel.js:
 *   current      farmer's feed + meals, water as measured (temperature AND pH/turbidity/TDS stress)
 *   recommended  feeding-table ration and meals, pH/turbidity/TDS corrected, temperature as measured
 *   best case    optimal temperature, ideal water, full ration at the best FCR
 * and turns them into a verdict, gap analysis, feeding/environment actions,
 * an optional business view and the list of assumptions used.
 *
 * Pure apart from reading the Settings limits from the in-memory species registry.
 */
const { SPECIES, SPECIES_ORDER, GENERAL, VERDICT } = require('../config/aquaculture');
const { THRESHOLDS } = require('../config/thresholds');
const registry = require('./speciesRegistry');
const { thresholdsFor } = require('./statusService');
const m = require('./growthModel');

const DAY_MS = 86400000;
const httpError = (status, message, field) => Object.assign(new Error(message), { statusCode: status, field });
const r1 = (x) => (m.isNum(x) ? Math.round(x * 10) / 10 : null);
const r2 = (x) => (m.isNum(x) ? Math.round(x * 100) / 100 : null);
const r0 = (x) => (m.isNum(x) ? Math.round(x) : null);
const pct = (x) => (m.isNum(x) ? Math.round(x * 100) : null);
const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const kg = (x) => `${x >= 100 ? Math.round(x) : r1(x)} kg`;

const VERDICT_TITLE = {
  ACHIEVABLE: 'Achievable',
  ACHIEVABLE_WITH_CHANGES: 'Achievable with changes',
  UNLIKELY: 'Unlikely',
  NOT_POSSIBLE: 'Not possible',
};

/* ------------------------------------------------------------------ species */

function listSpecies() {
  return SPECIES_ORDER.filter((id) => SPECIES[id]).map((id) => {
    const s = SPECIES[id];
    return {
      id: s.id, name: s.name, scientific: s.scientific, stockUnit: s.stockUnit,
      maxWeightG: s.growth.wInfG, stockingWeightG: s.growth.stockingG,
      optimumTemp: [s.temperature.optLow, s.temperature.optHigh],
    };
  });
}

/* Welfare limits: from Settings when the species is monitored there, else the config defaults. */
function waterBands(sp) {
  if (sp.settingsId && registry.has(sp.settingsId)) {
    const th = thresholdsFor(sp.settingsId);
    return { temperature: th.temperature, ph: th.ph, turbidity: th.turbidity, tds: th.conductivity, fromSettings: true };
  }
  const own = sp.limits || {};
  return {
    temperature: { ...THRESHOLDS.temperature, ...(own.temperature || {}) },
    ph: { ...THRESHOLDS.ph, ...(own.ph || {}) },
    turbidity: { ...THRESHOLDS.turbidity, ...(own.turbidity || {}) },
    tds: { ...THRESHOLDS.conductivity, ...(own.tds || {}) },
    fromSettings: false,
  };
}

/* ------------------------------------------------------------------ input */

function num(body, key, { required = false, min, max, integer = false, label, gt } = {}) {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw httpError(400, `${label} is required.`, key);
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw httpError(400, `${label} must be a number.`, key);
  if (integer && !Number.isInteger(n)) throw httpError(400, `${label} must be a whole number.`, key);
  if (gt !== undefined && !(n > gt)) throw httpError(400, `${label} must be more than ${gt}.`, key);
  if (min !== undefined && n < min) throw httpError(400, `${label} must be at least ${min}.`, key);
  if (max !== undefined && n > max) throw httpError(400, `${label} must be at most ${max}.`, key);
  return n;
}

function parseInput(body, now = new Date()) {
  if (!body || typeof body !== 'object') throw httpError(400, 'Request body is required.');
  const sp = SPECIES[body.species];
  if (!sp) throw httpError(400, `Choose a species (${SPECIES_ORDER.map((id) => SPECIES[id].name).join(', ')}).`, 'species');

  const counted = sp.stockUnit === 'count';
  const stock = num(body, 'stock', {
    required: true, gt: 0, max: counted ? 10000000 : 1000000, integer: counted,
    label: counted ? 'Number of fish' : 'Current stock weight (kg)',
  });
  const avgWeightG = num(body, 'avgWeightG', { gt: 0, label: 'Average size (g)' });
  if (avgWeightG !== null && avgWeightG >= sp.growth.wInfG) {
    throw httpError(400, `Average size must be below ${sp.growth.wInfG} g – about the largest ${sp.name} reach in ponds.`, 'avgWeightG');
  }

  let stockingDate = null;
  if (body.stockingDate) {
    stockingDate = new Date(body.stockingDate);
    if (Number.isNaN(stockingDate.getTime())) throw httpError(400, 'Stocking date is not a valid date.', 'stockingDate');
    if (stockingDate > now) throw httpError(400, 'Stocking date cannot be in the future.', 'stockingDate');
    if (now - stockingDate > 3 * 365 * DAY_MS) throw httpError(400, 'Stocking date must be within the last 3 years.', 'stockingDate');
  }
  if (avgWeightG === null && !stockingDate) {
    throw httpError(400, 'Enter the current average size, or the stocking date so the size can be estimated.', 'avgWeightG');
  }
  const pondAreaM2 = num(body, 'pondAreaM2', { gt: 0, max: 10000000, label: 'Pond area (m²)' });
  const pondVolumeM3 = num(body, 'pondVolumeM3', { gt: 0, max: 50000000, label: 'Pond volume (m³)' });
  const mealsPerDay = num(body, 'mealsPerDay', { required: true, min: 1, max: 4, integer: true, label: 'Meals per day' });
  const feedKgPerDay = num(body, 'feedKgPerDay', { required: true, min: 0, max: 100000, label: 'Feed per day (kg)' });
  const targetKg = num(body, 'targetKg', { required: true, gt: 0, max: 10000000, label: 'Target harvest (kg)' });

  let deadline;
  if (body.deadline) {
    deadline = new Date(body.deadline);
    if (Number.isNaN(deadline.getTime())) throw httpError(400, 'Deadline is not a valid date.', 'deadline');
  } else {
    const months = num(body, 'months', { gt: 0, max: 24, label: 'Months until harvest' });
    if (months === null) throw httpError(400, 'Enter a harvest deadline (a date, or a number of months).', 'deadline');
    deadline = new Date(now.getTime() + months * GENERAL.DAYS_PER_MONTH * DAY_MS);
  }
  const days = Math.round((deadline - now) / DAY_MS);
  if (days <= 0) throw httpError(400, 'The deadline is in the past (or today). Choose a future date.', 'deadline');
  if (days < GENERAL.MIN_HORIZON_DAYS) throw httpError(400, `The deadline must be at least ${GENERAL.MIN_HORIZON_DAYS} days away.`, 'deadline');
  if (days > GENERAL.MAX_HORIZON_DAYS) throw httpError(400, 'The deadline must be within 2 years.', 'deadline');

  const survivalPct = num(body, 'survivalPct', { gt: 0, max: 100, label: 'Expected survival (%)' });
  const feedPricePerKg = num(body, 'feedPricePerKg', { min: 0, label: 'Feed price per kg' });
  const salePricePerKg = num(body, 'salePricePerKg', { min: 0, label: 'Sale price per kg' });

  return {
    deviceId: typeof body.deviceId === 'string' && body.deviceId.trim() ? body.deviceId.trim() : null,
    species: sp.id, stock, avgWeightG, stockingDate, pondAreaM2, pondVolumeM3,
    mealsPerDay, feedKgPerDay, targetKg, deadline, days, survivalPct, feedPricePerKg, salePricePerKg,
  };
}

/* ------------------------------------------------------------------ helpers */

function lowOxygenRisk(sp, bands, latest, water, g = GENERAL) {
  const reasons = [];
  const t = latest && m.isNum(latest.temperature) ? latest.temperature : null;
  if ((t !== null && t > sp.temperature.optHigh + g.LOW_OXYGEN.TEMP_ABOVE_OPT_C)
    || (water.temperature.measured && water.temperature.mean > sp.temperature.optHigh + g.LOW_OXYGEN.TEMP_ABOVE_OPT_C)) {
    reasons.push('the water is hot (warm water holds less oxygen)');
  }
  const turb = latest && m.isNum(latest.turbidity) ? latest.turbidity : null;
  if (turb !== null && m.isNum(bands.turbidity.safeHigh) && turb > bands.turbidity.safeHigh) {
    reasons.push('the water is very cloudy (algae and waste use oxygen at night)');
  }
  const rain = latest && m.isNum(latest.rain) ? latest.rain : null;
  if ((rain !== null && rain >= g.LOW_OXYGEN.HEAVY_RAIN_PCT) || water.rain.heavyShare >= g.LOW_OXYGEN.RAINY_DAY_SHARE) {
    reasons.push('there has been heavy rain (cloudy days mean less oxygen from algae)');
  }
  return { active: reasons.length > 0, reasons };
}

function feedingActions({ sp, input, w0, biomassKg, water, oxygen, recFinalW, recFinalBiomass, targetKg, currentPlanFeedKg }) {
  const g = GENERAL;
  const tf = water.temperature.factor;
  const recKg = m.usefulRationKg(biomassKg, w0, sp, { tempFactor: tf });
  const recMeals = m.recommendedMeals(w0, sp);
  const cur = input.feedKgPerDay;
  const ratio = recKg > 0 ? cur / recKg : null;
  const status = recKg <= 0 ? 'NO_FEEDING' : ratio > g.OVERFEED_RATIO ? 'OVERFEEDING' : ratio < g.UNDERFEED_RATIO ? 'UNDERFEEDING' : 'OK';
  const changePct = cur > 0 && recKg > 0 ? ((recKg - cur) / cur) * 100 : null;

  const mealsText = recMeals < input.mealsPerDay ? `Reduce from ${input.mealsPerDay} meals to ${recMeals}`
    : recMeals > input.mealsPerDay ? `Increase to ${recMeals} meals` : `Keep ${recMeals} meals a day`;
  let feedText;
  if (recKg <= 0) feedText = 'stop feeding until the water temperature recovers';
  else if (cur <= 0) feedText = `start feeding about ${r1(recKg)} kg a day`;
  else if (Math.abs(changePct) < 5) feedText = 'keep about the same daily feed';
  else if (changePct < 0) feedText = `cut daily feed by ${Math.round(-changePct)}%`;
  else feedText = `increase daily feed by ${Math.round(changePct)}%`;

  const notes = [];
  if (status === 'OVERFEEDING') {
    notes.push(`You feed about ${Math.round(ratio * 100)}% of what ${sp.name} of this size can use. Uneaten feed is wasted money (poorer FCR), and it rots on the bottom, using oxygen and polluting the water with ammonia and cloudiness.`);
  } else if (status === 'UNDERFEEDING') {
    notes.push(`You feed about ${Math.round(ratio * 100)}% of the recommended amount. Under-fed animals grow slowly, and the size difference between them increases${sp.id === 'prawn' ? ' (hungry prawns also eat each other while moulting)' : ''}.`);
  } else if (status === 'OK') {
    notes.push('Your daily feed is close to the recommended amount for this size.');
  }
  if (tf < 0.9) notes.push(`The ration is already reduced by ${Math.round((1 - tf) * 100)}% because the water temperature slows feeding.`);
  notes.push('Watch the first meal: if feed is left after 15–20 minutes, feed less next time.');
  const finalRation = m.usefulRationKg(recFinalBiomass, recFinalW, sp, { tempFactor: tf });
  if (finalRation > 0) notes.push(`As the animals grow, the ration rises to about ${r1(finalRation)} kg/day near harvest. Re-run this calculation every 2 weeks.`);

  const today = oxygen.active
    ? { feedKg: r2(recKg * (1 - g.LOW_OXYGEN.FEED_CUT)), meals: Math.max(1, recMeals - 1),
      message: `Today oxygen is probably low because ${oxygen.reasons.join(', and ')}. Feed about ${Math.round(g.LOW_OXYGEN.FEED_CUT * 100)}% less, skip the early-morning meal, and run aeration if you have it.` }
    : null;

  return {
    status,
    summary: `${mealsText}, ${feedText}.`,
    current: {
      mealsPerDay: input.mealsPerDay, feedKgPerDay: r2(cur),
      kgPerMeal: r2(cur / input.mealsPerDay), pctBodyWeight: biomassKg > 0 ? r2((cur / biomassKg) * 100) : null,
      ratioToRecommended: r2(ratio),
    },
    recommended: {
      mealsPerDay: recMeals, feedKgPerDay: r2(recKg),
      pctBodyWeight: biomassKg > 0 ? r2((recKg / biomassKg) * 100) : null,
      meals: m.mealSchedule(recMeals, recKg, sp).map((x) => ({ time: x.time, kg: r2(x.kg), sharePct: pct(x.share) })),
      changePct: r0(changePct),
    },
    targetFeed: {
      // Feed needed for the target gain = gain x FCR.
      gainKg: r1(Math.max(0, targetKg - biomassKg)),
      fcr: sp.fcr.typical,
      totalKg: r0(Math.max(0, targetKg - biomassKg) * sp.fcr.typical),
      perDayKg: r2((Math.max(0, targetKg - biomassKg) * sp.fcr.typical) / input.days),
      currentPlanTotalKg: r0(currentPlanFeedKg),
    },
    lowOxygen: oxygen,
    today,
    notes,
  };
}

function environmentRows({ sp, bands, water, latest, oxygen }) {
  const L = (k) => (latest && m.isNum(latest[k]) ? latest[k] : null);
  const rows = [];
  const tc = sp.temperature;

  // Temperature
  {
    const now = L('temperature');
    const ref = now ?? (water.temperature.measured ? water.temperature.mean : null);
    const f = m.temperatureFactor(ref, tc);
    const slower = f === null ? null : Math.round((1 - f) * 100);
    let instruction;
    if (ref === null) instruction = `No temperature reading. ${sp.name} grow fastest at ${tc.optLow}–${tc.optHigh} °C.`;
    else if (ref < tc.optLow) {
      instruction = `Temperature is ${r1(ref)} °C. ${sp.name} grow fastest at ${tc.optLow}–${tc.optHigh} °C, so growth is about ${slower}% slower now. A pond cannot easily be heated: keep the water deep (it cools less at night), avoid large exchanges with cold water after rain, and feed less on cold days.`;
    } else if (ref > tc.optHigh) {
      instruction = `Temperature is ${r1(ref)} °C. ${sp.name} grow fastest at ${tc.optLow}–${tc.optHigh} °C, so growth is about ${slower}% slower and oxygen is lower. Shade part of the pond, add cooler water if you can, aerate at night and early morning, and feed in the cooler part of the day.`;
    } else instruction = `Temperature is ${r1(ref)} °C – inside the best growth range (${tc.optLow}–${tc.optHigh} °C).`;
    rows.push({
      key: 'temperature', label: 'Temperature', unit: '°C',
      target: { low: tc.optLow, high: tc.optHigh, note: 'best growth' },
      limits: bands.temperature,
      latest: r2(now), recentMean: water.temperature.measured ? r2(water.temperature.mean) : null,
      status: m.bandStatus(ref, bands.temperature),
      growthEffectPct: slower === null ? null : -slower,
      recentGrowthEffectPct: water.temperature.measured ? -Math.round((1 - water.temperature.factor) * 100) : null,
      instruction,
    });
  }

  const stressRow = (key, label, unit, band, tips) => {
    const now = L(key === 'tds' ? GENERAL.TDS_FIELD : key);
    const w = water[key];
    const ref = now ?? (w.measured ? w.mean : null);
    const f = m.stressFactor(ref, band);
    const lowB = m.isNum(band.safeLow) ? band.safeLow : null;
    const highB = m.isNum(band.safeHigh) ? band.safeHigh : null;
    const range = lowB !== null && highB !== null ? `${lowB}–${highB}${unit ? ` ${unit}` : ''}` : highB !== null ? `≤ ${highB}${unit ? ` ${unit}` : ''}` : `≥ ${lowB}${unit ? ` ${unit}` : ''}`;
    let instruction;
    if (ref === null) instruction = `No ${label} reading. Keep it at ${range}.`;
    else if (lowB !== null && ref < lowB) instruction = `${label} is ${r2(ref)}${unit ? ` ${unit}` : ''}, below the safe ${range}. ${tips.low}`;
    else if (highB !== null && ref > highB) instruction = `${label} is ${r2(ref)}${unit ? ` ${unit}` : ''}, above the safe ${range}. ${tips.high}`;
    else instruction = `${label} is ${r2(ref)}${unit ? ` ${unit}` : ''} – inside the safe range (${range}).`;
    if (f < 1) instruction += ` Growth is about ${Math.round((1 - f) * 100)}% slower while it stays there.`;
    rows.push({
      key, label, unit, target: { low: lowB, high: highB, note: 'safe range' }, limits: band,
      latest: r2(now), recentMean: w.measured ? r2(w.mean) : null,
      status: m.bandStatus(ref, band), growthEffectPct: -Math.round((1 - f) * 100),
      recentGrowthEffectPct: w.measured ? -Math.round((1 - w.factor) * 100) : null,
      instruction,
    });
  };
  stressRow('ph', 'pH', '', bands.ph, {
    low: 'Spread agricultural lime (about 100–200 kg per 1,000 m² on bottom soil, less in water) and re-check after 2–3 days.',
    high: 'High afternoon pH usually means a strong algae bloom: exchange 10–20% of the water, stop fertilising and feed less until it settles.',
  });
  stressRow('turbidity', 'Turbidity', 'NTU', bands.turbidity, {
    low: '',
    high: 'Exchange 10–20% of the water, reduce feeding (uneaten feed and waste cloud the water), stop muddy runoff entering, and aerate at night.',
  });
  stressRow('tds', 'TDS', 'ppm', bands.tds, {
    low: 'Very soft water: liming helps, and check the source water.',
    high: 'Exchange part of the water with fresh, low-salt water and check for runoff or contamination.',
  });

  // Rain risk guidance
  const rainNow = L('rain');
  const rain = water.rain;
  let rainText;
  if (rainNow === null && !rain.days) rainText = 'No rain data. Before heavy rain, reduce feeding and check overflow screens so animals cannot escape.';
  else {
    const parts = [];
    if (rainNow !== null) parts.push(`rain sensor now ${r0(rainNow)}%`);
    if (rain.days) parts.push(`heavy rain on ${rain.heavyDays} of the last ${rain.days} days`);
    rainText = `${parts.join('; ')}. `;
    rainText += oxygen.active || rain.heavyShare >= GENERAL.LOW_OXYGEN.RAINY_DAY_SHARE
      ? 'Heavy rain cools the pond, lowers pH and oxygen and can wash mud in: feed less on rainy days, aerate at night, check overflow screens, and test pH after the rain.'
      : 'Rain is not a concern right now. Before heavy rain, reduce feeding and check overflow screens.';
  }
  return {
    rows,
    rain: { latest: r0(rainNow), heavyDays: rain.heavyDays, days: rain.days, status: rainNow === null ? 'UNKNOWN' : rainNow >= GENERAL.LOW_OXYGEN.HEAVY_RAIN_PCT ? 'DANGER' : rainNow > 50 ? 'WARNING' : 'SAFE', instruction: rainText },
  };
}

/* ------------------------------------------------------------------ main */

function calculate(input, env = {}, now = new Date()) {
  const sp = SPECIES[input.species];
  const bands = waterBands(sp);
  const daily = Array.isArray(env.daily) ? env.daily : [];
  const latest = env.latest || null;
  const water = m.summarizeWater(daily, { sp, bands });
  const days = input.days;
  const weeks = days / 7;
  const deadline = new Date(now.getTime() + days * DAY_MS);
  const assumptions = [];
  const A = (label, value, source = 'assumption') => assumptions.push({ label, value, source });

  // ---- current size, count and biomass
  let w0 = input.avgWeightG;
  let sizeEstimated = false;
  let ageDays = null;
  if (w0 === null) {
    ageDays = Math.max(0, Math.round((now - input.stockingDate) / DAY_MS));
    w0 = m.estimateWeightFromAge(sp, ageDays, water.temperature.factor);
    sizeEstimated = true;
    A('Current average size', `${r1(w0)} g, estimated from ${ageDays} days since stocking at ${sp.growth.stockingG} g`, 'estimate');
  }
  const counted = sp.stockUnit === 'count';
  const n0 = counted ? input.stock : (input.stock * 1000) / w0;
  const biomass0 = counted ? (input.stock * w0) / 1000 : input.stock;
  if (!counted) A('Number of prawns', `${r0(n0)} = ${input.stock} kg ÷ ${r1(w0)} g average size`, 'calculation');

  // ---- survival
  const mBase = input.survivalPct
    ? m.dailyMortality(input.survivalPct / 100, days)
    : m.dailyMortality(sp.survival.cycle, sp.survival.cycleDays);
  A('Expected survival', input.survivalPct
    ? `${input.survivalPct}% from now to harvest (your value)`
    : `${pct(sp.survival.cycle)}% over a typical ${sp.survival.cycleDays}-day cycle → ${pct(m.survivalOver(mBase, days))}% until your deadline`,
  input.survivalPct ? 'your input' : 'literature (approx.)');

  // ---- scenarios
  const base = { sp, w0, n0, days };
  const fcr = sp.fcr.typical;
  // Current plan: the farmer keeps feeding the same share of what the animals need today
  // (so the kg/day grows with the animals), with the same number of meals.
  const ration0 = m.usefulRationKg(biomass0, w0, sp, { tempFactor: water.temperature.factor, fcr });
  const currentFeed = ration0 > 0
    ? { mode: 'ratio', ratio: input.feedKgPerDay / ration0 }
    : { mode: 'fixed', kgPerDay: input.feedKgPerDay };
  const current = m.simulate({
    ...base, tempFactor: water.temperature.factor, stress: water.stress,
    mortalityPerDay: mBase + water.extraMortalityPerDay,
    feed: currentFeed, meals: input.mealsPerDay, fcr,
  });
  const recommended = m.simulate({
    ...base, tempFactor: water.temperature.factor, stress: 1,
    mortalityPerDay: mBase + water.extraMortalityTempOnly, feed: { mode: 'ration' }, fcr,
  });
  const best = m.simulate({ ...base, tempFactor: 1, stress: 1, mortalityPerDay: mBase, feed: { mode: 'ration' }, fcr: sp.fcr.best });

  // ---- gap analysis (rates in g per animal per week)
  const expectedSurvivors = n0 * m.survivalOver(mBase, days);
  const requiredWeightG = (input.targetKg * 1000) / expectedSurvivors;
  const requiredRate = (requiredWeightG - w0) / weeks;
  // Mortality from poor water is folded into an "effective" rate: the growth that would give the same harvest.
  const effRate = (s) => ((s.final.biomassKg * 1000) / expectedSurvivors - w0) / weeks;
  const currentRate = effRate(current);
  const recommendedRate = effRate(recommended);
  const bestRate = effRate(best);
  const code = m.verdictFor({ requiredRate, currentRate, bestRate, requiredWeightG, wInfG: sp.growth.wInfG });
  const alreadyThere = !(requiredRate > 0);
  const tooBig = !alreadyThere && requiredWeightG > sp.growth.wInfG * VERDICT.MAX_WEIGHT_OF_ASYMPTOTE;

  const H = { cur: current.final.biomassKg, rec: recommended.final.biomassKg, best: best.final.biomassKg };
  const when = fmtDate(deadline);
  let reason;
  if (alreadyThere) reason = `Your pond already holds about ${kg(biomass0)} after expected losses — enough for the ${kg(input.targetKg)} target.`;
  else if (tooBig) reason = `Each ${sp.id === 'prawn' ? 'prawn' : 'fish'} would need to reach about ${r0(requiredWeightG)} g, more than ${sp.name} normally grow in ponds (about ${sp.growth.wInfG} g).`;
  else if (code === 'ACHIEVABLE') reason = `You need ${kg(input.targetKg)} and the pond is projected to reach about ${kg(H.cur)} by ${when} with your current plan.`;
  else if (code === 'ACHIEVABLE_WITH_CHANGES') {
    reason = H.rec >= input.targetKg
      ? `You need ${kg(input.targetKg)} but your current plan reaches only about ${kg(H.cur)} by ${when}; with the recommended changes about ${kg(H.rec)}.`
      : `You need ${kg(input.targetKg)}; your current plan reaches about ${kg(H.cur)} by ${when}. It is only reachable if the water is also kept near ${sp.temperature.optLow}–${sp.temperature.optHigh} °C (best case about ${kg(H.best)}).`;
  } else if (code === 'UNLIKELY') reason = `You need ${kg(input.targetKg)} but even in near-perfect conditions the pond is projected to reach about ${kg(H.best)} by ${when} (recommended plan: about ${kg(H.rec)}).`;
  else reason = `You need ${kg(input.targetKg)} but the pond is projected to reach at most about ${kg(H.best)} by ${when}.`;

  // ---- closest alternative when the realistic (recommended) plan falls short
  let alternative = null;
  if (!alreadyThere && H.rec < input.targetKg) {
    const long = m.simulate({
      ...base, days: GENERAL.MAX_HORIZON_DAYS, tempFactor: water.temperature.factor, stress: 1,
      mortalityPerDay: mBase + water.extraMortalityTempOnly, feed: { mode: 'ration' }, fcr,
    });
    const day = m.firstDayReaching(long.points, input.targetKg);
    const earliest = day === null ? null : new Date(now.getTime() + day * DAY_MS);
    alternative = {
      maxHarvestKg: r1(H.rec),
      bestCaseHarvestKg: r1(H.best),
      earliestDate: earliest ? earliest.toISOString() : null,
      earliestDays: day,
      message: earliest
        ? `Closest alternative: plan for about ${kg(H.rec)} by ${when}, or keep the ${kg(input.targetKg)} target and harvest around ${fmtDate(earliest)} (about ${Math.round(day / 7)} weeks from now) with the recommended plan.`
        : `Closest alternative: plan for about ${kg(H.rec)} by ${when}. With the current number of animals the ${kg(input.targetKg)} target is not reached within 2 years — it needs more animals in the pond.`,
    };
  }

  // ---- confidence
  const confNotes = [];
  let score = 3;
  if (!water.temperature.measured) { score -= 2; confNotes.push(`No sensor history: a default water temperature of ${GENERAL.DEFAULT_TEMP_C} °C was used.`); }
  else if (water.temperature.days < 7) { score -= 1; confNotes.push(`Only ${water.temperature.days} day(s) of sensor history were available.`); }
  else confNotes.push(`Based on ${water.temperature.days} days of your pond's sensor readings.`);
  if (sizeEstimated) { score -= 1; confNotes.push('Average size was estimated from the stocking date — weigh a sample of 20–30 animals for a better result.'); }
  if (days > 180) { score -= 1; confNotes.push('Long projections (over 6 months) are less certain.'); }
  const near = [VERDICT.ACHIEVABLE_MAX_OF_CURRENT * currentRate, bestRate, VERDICT.UNLIKELY_MAX_OF_BEST * bestRate]
    .some((x) => x > 0 && Math.abs(requiredRate - x) / x < 0.1);
  if (!alreadyThere && near) { score -= 1; confNotes.push('The result is close to the boundary between two verdicts.'); }
  const level = score >= 3 ? 'HIGH' : score === 2 ? 'MEDIUM' : 'LOW';
  confNotes.push('This is an estimate from typical growth figures, not a guarantee.');

  // ---- feeding + environment
  const oxygen = lowOxygenRisk(sp, bands, latest, water);
  const feeding = feedingActions({
    sp, input, w0, biomassKg: biomass0, water, oxygen,
    recFinalW: recommended.final.weightG, recFinalBiomass: recommended.final.biomassKg, targetKg: input.targetKg,
    currentPlanFeedKg: current.feedKg,
  });
  const envOut = environmentRows({ sp, bands, water, latest, oxygen });

  const fixes = [];
  envOut.rows.forEach((row) => { if (row.status === 'WARNING' || row.status === 'DANGER') fixes.push(row.instruction); });
  if (oxygen.active) fixes.push('Oxygen is probably low: aerate at night/early morning and feed less until conditions improve.');
  let limiting;
  if (alreadyThere) limiting = { waterBlocksTarget: false, message: 'Water conditions do not stop you reaching this target.' };
  else if (requiredRate > recommendedRate && requiredRate <= bestRate) {
    limiting = { waterBlocksTarget: true, message: `With the recent water temperature (about ${r1(water.temperature.mean)} °C) the target cannot be reached by the deadline; it would be reachable if the water stayed near ${sp.temperature.optLow}–${sp.temperature.optHigh} °C.` };
  } else if (requiredRate > currentRate && water.stress < 0.999 && requiredRate <= recommendedRate) {
    limiting = { waterBlocksTarget: true, message: 'Water quality (pH / turbidity / TDS) is holding growth back. Fixing it is part of reaching the target.' };
  } else if (requiredRate > bestRate) {
    limiting = { waterBlocksTarget: false, message: 'Even perfect water would not be enough: the target is too large for this deadline and stock.' };
  } else limiting = { waterBlocksTarget: false, message: 'Water conditions are not the main limit for this target.' };
  // Recent averages can be fine while the latest reading is not: say so instead of looking contradictory.
  if (!limiting.waterBlocksTarget && envOut.rows.some((x) => x.status === 'DANGER' || x.status === 'WARNING')) {
    limiting.message += ' But the latest readings need attention – if they stay like this, growth slows and the result gets worse (see below).';
  }

  // ---- density
  let density = null;
  const area = input.pondAreaM2 ?? (input.pondVolumeM3 ? input.pondVolumeM3 / GENERAL.DEFAULT_POND_DEPTH_M : null);
  if (area) {
    const max = sp.density.maxKgM2;
    const dTarget = input.targetKg / area;
    const status = dTarget > max * 1.5 ? 'DANGER' : dTarget > max ? 'WARNING' : 'SAFE';
    density = {
      areaM2: r1(area), areaFromVolume: !input.pondAreaM2,
      currentKgM2: r2(biomass0 / area), targetKgM2: r2(dTarget), projectedKgM2: r2(H.rec / area),
      animalsPerM2: r1(n0 / area), maxKgM2: max, status,
      message: status === 'SAFE'
        ? `About ${r2(dTarget)} kg/m² at harvest – within what a pond without strong aeration can carry (≈${max} kg/m²).`
        : `About ${r2(dTarget)} kg/m² at harvest is above ≈${max} kg/m², the usual limit for ${sp.name} without strong aeration. Add aeration and regular water exchange, or harvest part of the stock early.`,
    };
    if (!input.pondAreaM2) A('Pond area', `${r1(area)} m² = volume ÷ assumed ${GENERAL.DEFAULT_POND_DEPTH_M} m depth`);
    A(`Maximum density (${sp.name})`, `≈${max} kg/m² without strong aeration`, 'literature (approx.)');
  }

  // ---- business view (only when a price was given)
  let business = null;
  if (input.feedPricePerKg !== null || input.salePricePerKg !== null) {
    const view = (s, label) => {
      const gain = s.final.biomassKg - biomass0;
      const feedCost = input.feedPricePerKg !== null ? s.feedKg * input.feedPricePerKg : null;
      const revenue = input.salePricePerKg !== null ? s.final.biomassKg * input.salePricePerKg : null;
      return {
        label, harvestKg: r1(s.final.biomassKg), gainKg: r1(gain), feedKg: r0(s.feedKg),
        fcr: gain > 0 ? r2(s.feedKg / gain) : null,
        feedCost: r0(feedCost), revenue: r0(revenue),
        profit: feedCost !== null && revenue !== null ? r0(revenue - feedCost) : null,
        costPerKgProduced: feedCost !== null && gain > 0 ? r2(feedCost / gain) : null,
      };
    };
    business = {
      feedPricePerKg: input.feedPricePerKg, salePricePerKg: input.salePricePerKg,
      current: view(current, 'Current plan'), recommended: view(recommended, 'Recommended plan'),
      note: 'Revenue is the whole harvest at your sale price. Profit here = revenue − feed cost only (no fingerlings, labour, electricity or other costs).',
    };
  }

  // ---- chart series (weekly)
  const points = current.points.map((p, i) => ({
    day: p.day,
    date: new Date(now.getTime() + p.day * DAY_MS).toISOString(),
    currentKg: r1(p.biomassKg),
    recommendedKg: r1(recommended.points[i].biomassKg),
    currentWeightG: r1(p.weightG),
    recommendedWeightG: r1(recommended.points[i].weightG),
  }));

  // ---- assumptions (every constant used)
  const tc = sp.temperature;
  A('Current plan', ration0 > 0
    ? `you keep feeding the same share of the animals' needs as today (${r1((input.feedKgPerDay / ration0) * 100)}% of the table ration), increasing the kg as they grow, with ${input.mealsPerDay} meal(s) a day; water as measured`
    : `you keep feeding ${input.feedKgPerDay} kg a day with ${input.mealsPerDay} meal(s); water as measured`);
  A('Recommended plan', 'feeding-table ration and meals; pH / turbidity / TDS brought into the safe range; temperature as measured');
  A('Best case', `optimal temperature (${sp.temperature.optLow}–${sp.temperature.optHigh} °C), ideal water, full ration at the best FCR (${sp.fcr.best})`);
  A('Feed that is not eaten', 'animals eat at most the temperature-adjusted table ration; anything above it is wasted (raises FCR, pollutes water)');
  A('Growth model', `von Bertalanffy curve, max size ≈${sp.growth.wInfG} g, rate k = ${sp.growth.kPerDay}/day at optimal temperature, limited by feed ÷ FCR`, 'calibrated to typical grow-out times');
  A('Temperature growth curve', `0 at ≤${tc.min} °C, full growth ${tc.optLow}–${tc.optHigh} °C, 0 at ≥${tc.max} °C (straight lines between)`, 'literature (approx.)');
  A('Water temperature used', water.temperature.measured
    ? `daily means of the last ${water.temperature.days} days (average ${r1(water.temperature.mean)} °C → growth factor ${r2(water.temperature.factor)}), assumed to continue until harvest`
    : `${GENERAL.DEFAULT_TEMP_C} °C (no sensor history) → growth factor ${r2(water.temperature.factor)}`,
  water.temperature.measured ? 'your sensors' : 'assumption');
  A('pH / turbidity / TDS limits', bands.fromSettings ? `from Settings for ${sp.name}` : `FishSafe defaults for ${sp.name}`, bands.fromSettings ? 'Settings' : 'literature (approx.)');
  A('Water-quality stress', `growth × 1 inside the safe range, falling to × ${GENERAL.STRESS.FACTOR_AT_WARN_LIMIT} at a danger limit and × ${GENERAL.STRESS.FACTOR_IN_DANGER} beyond it; the worst of pH/turbidity/TDS counts (now × ${r2(water.stress)})`);
  A('TDS', 'the conductivity probe value (ppm) is used directly as TDS');
  A('Extra mortality in poor water', `+${GENERAL.EXTRA_MORTALITY_PER_DAY.WARNING * 100}%/day for days in the warning zone, +${GENERAL.EXTRA_MORTALITY_PER_DAY.DANGER * 100}%/day in the danger zone`);
  A('Feeding table', sp.feeding.table.map(([w, p]) => `${w === Infinity ? 'larger' : `≤${w} g`}: ${p}%`).join(', ') + ' of body weight per day, reduced with the temperature factor', 'feeding charts (approx.)');
  A('FCR', `${sp.fcr.typical} typical (range ${sp.fcr.range[0]}–${sp.fcr.range[1]}); best case ${sp.fcr.best}`, 'literature (approx.)');
  A('Meals', `${GENERAL.MISSING_MEAL_PENALTY * 100}% less growth for each meal/day fewer than recommended`);
  A('Low-oxygen signs', `dissolved oxygen is not measured; "probably low" = water >${GENERAL.LOW_OXYGEN.TEMP_ABOVE_OPT_C} °C above the optimum, turbidity above the safe limit, or heavy rain`);
  A('Verdict rules', `required growth ≤ ${VERDICT.ACHIEVABLE_MAX_OF_CURRENT * 100}% of the current-plan rate → Achievable; ≤ ${VERDICT.WITH_CHANGES_MAX_OF_BEST * 100}% of the best-case rate → Achievable with changes; ≤ ${VERDICT.UNLIKELY_MAX_OF_BEST * 100}% → Unlikely; otherwise Not possible`);

  const envSource = water.temperature.measured ? 'history' : 'default';
  return {
    generatedAt: now.toISOString(),
    estimate: true,
    species: { id: sp.id, name: sp.name, scientific: sp.scientific, stockUnit: sp.stockUnit },
    input: {
      stock: input.stock, avgWeightG: input.avgWeightG, mealsPerDay: input.mealsPerDay, feedKgPerDay: input.feedKgPerDay,
      targetKg: input.targetKg, survivalPct: input.survivalPct, pondAreaM2: input.pondAreaM2, pondVolumeM3: input.pondVolumeM3,
    },
    deadline: deadline.toISOString(),
    days,
    weeks: r1(weeks),
    verdict: {
      code, title: VERDICT_TITLE[code], reason,
      confidence: { level, notes: confNotes },
    },
    stock: {
      count: r0(n0), avgWeightG: r1(w0), biomassKg: r1(biomass0), sizeEstimated, ageDays,
      expectedSurvivors: r0(expectedSurvivors),
    },
    projection: {
      targetKg: input.targetKg,
      points,
      current: { harvestKg: r1(H.cur), finalWeightG: r1(current.final.weightG), survivors: r0(current.final.count), feedKg: r0(current.feedKg) },
      recommended: { harvestKg: r1(H.rec), finalWeightG: r1(recommended.final.weightG), survivors: r0(recommended.final.count), feedKg: r0(recommended.feedKg) },
      bestCase: { harvestKg: r1(H.best), finalWeightG: r1(best.final.weightG), survivors: r0(best.final.count) },
    },
    gap: {
      requiredFinalWeightG: r1(requiredWeightG),
      requiredRateGPerWeek: r2(requiredRate),
      currentRateGPerWeek: r2(currentRate),
      recommendedRateGPerWeek: r2(recommendedRate),
      bestRateGPerWeek: r2(bestRate),
      requiredSgr: r2(m.sgr(w0, Math.max(requiredWeightG, w0), days)),
      currentSgr: r2(m.sgr(w0, current.final.weightG, days)),
      shortfallKg: r1(Math.max(0, input.targetKg - H.cur)),
      shortfallRecommendedKg: r1(Math.max(0, input.targetKg - H.rec)),
    },
    feeding,
    environment: {
      source: envSource,
      historyDays: water.temperature.days,
      readingsDays: daily.length,
      latestAt: latest ? latest.timestamp : null,
      note: envSource === 'default'
        ? `Using a default temperature of ${GENERAL.DEFAULT_TEMP_C} °C – no sensor history for the last ${GENERAL.HISTORY_DAYS} days.`
        : `Using daily averages from the last ${water.temperature.days} days of sensor readings.`,
      waterFactor: { temperature: r2(water.temperature.factor), stress: r2(water.stress), combined: r2(water.combined) },
      rows: envOut.rows,
      rain: envOut.rain,
      limiting,
      fixes,
    },
    density,
    business,
    alternative,
    assumptions,
    disclaimer: 'Estimate only. Built from typical growth, feeding and survival figures and your recent sensor data – real results depend on feed quality, stock health, weather and management. Check important decisions with an aquaculture extension officer.',
  };
}

module.exports = { listSpecies, parseInput, calculate, waterBands, VERDICT_TITLE };
