/*
 * Unit tests for the Harvest Feasibility formulas (no database needed):
 *   node --test test/feasibility.test.js      (or: npm run test:unit)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const m = require('../src/services/growthModel');
const f = require('../src/services/feasibilityService');
const { SPECIES, SPECIES_ORDER, GENERAL } = require('../src/config/aquaculture');

const NOW = new Date('2026-11-17T06:00:00Z');
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const days14 = (over = {}) => Array.from({ length: 14 }, (_, i) => ({
  date: `d${i}`, temperature: 29, ph: 7.6, turbidity: 12, tds: 400, rainMax: 10, ...over,
}));
const latestAt = (over = {}) => ({ temperature: 29, ph: 7.6, turbidity: 12, rain: 5, conductivity: 400, timestamp: NOW, ...over });
const run = (body, env = { daily: days14(), latest: latestAt() }) => f.calculate(f.parseInput(body, NOW), env, NOW);
const expect400 = (body, field, pattern) => {
  assert.throws(() => f.parseInput(body, NOW), (err) => {
    assert.equal(err.statusCode, 400);
    if (field) assert.equal(err.field, field);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
};

const PRAWN = { species: 'prawn', stock: 40, avgWeightG: 15, mealsPerDay: 2, feedKgPerDay: 1.5, targetKg: 100, months: 3 };
const TILAPIA = { species: 'tilapia', stock: 2000, avgWeightG: 50, mealsPerDay: 3, feedKgPerDay: 4.5, targetKg: 600, months: 4 };
const BASE_FOR = {
  tilapia: TILAPIA,
  prawn: PRAWN,
  carp: { species: 'carp', stock: 500, avgWeightG: 200, mealsPerDay: 2, feedKgPerDay: 3, targetKg: 300, months: 6 },
  catfish: { species: 'catfish', stock: 1000, avgWeightG: 100, mealsPerDay: 2, feedKgPerDay: 3.5, targetKg: 600, months: 4 },
};

/* ============================== temperature ============================== */

test('temperature factor: trapezoid per species (0 outside, 1 in optimum, linear ramps)', () => {
  for (const id of SPECIES_ORDER) {
    const c = SPECIES[id].temperature;
    assert.equal(m.temperatureFactor(c.min - 1, c), 0, `${id} below min`);
    assert.equal(m.temperatureFactor(c.max + 1, c), 0, `${id} above max`);
    assert.equal(m.temperatureFactor((c.optLow + c.optHigh) / 2, c), 1, `${id} optimum`);
    near(m.temperatureFactor((c.min + c.optLow) / 2, c), 0.5); // halfway up the cold ramp
    near(m.temperatureFactor((c.optHigh + c.max) / 2, c), 0.5); // halfway down the hot ramp
  }
  assert.equal(m.temperatureFactor(null, SPECIES.tilapia.temperature), null);
  // prawns: 24 C is clearly slower than the 28-31 C optimum
  const pr = m.temperatureFactor(24, SPECIES.prawn.temperature);
  assert.ok(pr > 0.4 && pr < 0.8, `prawn at 24 C = ${pr}`);
});

/* ============================== water stress ============================== */

test('stress factor: 1 inside safe range, 0.8 at the danger limit, 0.5 beyond, unknown = 1', () => {
  const band = { warnLow: 6, safeLow: 6.5, safeHigh: 8.5, warnHigh: 9 };
  assert.equal(m.stressFactor(7.5, band), 1);
  near(m.stressFactor(9, band), GENERAL.STRESS.FACTOR_AT_WARN_LIMIT);
  near(m.stressFactor(8.75, band), 0.9); // halfway between safe and danger limit
  near(m.stressFactor(6.25, band), 0.9);
  assert.equal(m.stressFactor(9.5, band), GENERAL.STRESS.FACTOR_IN_DANGER);
  assert.equal(m.stressFactor(null, band), 1);
  // turbidity has no lower bound (null / -Infinity)
  const turb = { warnLow: null, safeLow: -Infinity, safeHigh: 25, warnHigh: 40 };
  assert.equal(m.stressFactor(0, turb), 1);
  assert.equal(m.stressFactor(50, turb), GENERAL.STRESS.FACTOR_IN_DANGER);
});

test('band status matches the dashboard band model', () => {
  const band = { warnLow: 23, safeLow: 25, safeHigh: 30, warnHigh: 32, warnMargin: 1 };
  assert.equal(m.bandStatus(27, band), 'SAFE');
  assert.equal(m.bandStatus(29.5, band), 'WARNING'); // within the margin
  assert.equal(m.bandStatus(29.5, band, { margin: false }), 'SAFE');
  assert.equal(m.bandStatus(31, band), 'WARNING');
  assert.equal(m.bandStatus(33, band), 'DANGER');
  assert.equal(m.bandStatus(null, band), 'UNKNOWN');
});

/* ============================== feeding ============================== */

test('feeding tables: % body weight falls with size; meals 1-4 and fewer for big animals', () => {
  for (const id of SPECIES_ORDER) {
    const sp = SPECIES[id];
    const rates = [1, 10, 40, 150, 400, 2000].map((w) => m.feedingRatePct(w, sp));
    for (let i = 1; i < rates.length; i += 1) assert.ok(rates[i] <= rates[i - 1], `${id} feeding rate not decreasing`);
    const small = m.recommendedMeals(1, sp);
    const big = m.recommendedMeals(sp.growth.wInfG * 0.8, sp);
    assert.ok(small >= big && small <= 4 && big >= 1, `${id} meals ${small}/${big}`);
  }
});

test('daily ration = biomass x %BW x temperature factor', () => {
  const sp = SPECIES.tilapia;
  near(m.dailyRationKg(100, 100, sp), 100 * 0.035); // 100 g tilapia: 3.5 %
  near(m.dailyRationKg(100, 100, sp, 0.5), 100 * 0.035 * 0.5);
  assert.equal(m.dailyRationKg(0, 100, sp), 0);
  assert.equal(m.dailyRationKg(-5, 100, sp), 0);
});

test('meal schedule splits the daily feed; prawns get the bigger meal in the evening', () => {
  const t = m.mealSchedule(3, 6, SPECIES.tilapia);
  assert.deepEqual(t.map((x) => x.time), ['08:30', '12:30', '16:30']);
  near(t.reduce((a, x) => a + x.kg, 0), 6);
  const p = m.mealSchedule(2, 2, SPECIES.prawn);
  assert.ok(p[1].kg > p[0].kg);
  assert.equal(p[1].time, '18:30');
  assert.equal(m.mealFactor(1, 3), 0.9);
  assert.equal(m.mealFactor(4, 3), 1);
});

/* ============================== growth / survival ============================== */

test('SGR = 100 * (ln Wf - ln Wi) / days', () => {
  near(m.sgr(10, 20, 10), (100 * Math.log(2)) / 10);
  assert.equal(m.sgr(0, 20, 10), null);
  assert.equal(m.sgr(10, 20, 0), null);
});

test('von Bertalanffy growth: grows, slows near max size, never exceeds it, no growth at factor 0', () => {
  const { kPerDay, wInfG } = SPECIES.tilapia.growth;
  const small = m.vbGrow(50, 7, kPerDay, wInfG) - 50;
  const big = m.vbGrow(900, 7, kPerDay, wInfG) - 900;
  assert.ok(small > 0 && big > 0);
  assert.ok(m.sgr(50, 50 + small, 7) > m.sgr(900, 900 + big, 7), 'relative growth slows with size');
  assert.ok(m.vbGrow(990, 3650, kPerDay, wInfG) <= wInfG);
  assert.equal(m.vbGrow(100, 7, kPerDay, wInfG, 0), 100);
  assert.equal(m.vbGrow(100, 0, kPerDay, wInfG), 100);
});

test('mortality: daily rate round-trips to the survival it came from', () => {
  const md = m.dailyMortality(0.6, 150);
  near(m.survivalOver(md, 150), 0.6, 1e-9);
  assert.equal(m.dailyMortality(1, 100), 0);
  assert.equal(m.dailyMortality(0, 100), 0);
  assert.equal(m.survivalOver(md, 0), 1);
});

test('typical grow-out durations are reproduced (calibration check)', () => {
  const cases = [['tilapia', 10, 180, 300, 500], ['prawn', 2, 140, 30, 55], ['carp', 30, 260, 700, 1200], ['catfish', 10, 180, 600, 1000]];
  for (const [id, w0, days, min, max] of cases) {
    const sp = SPECIES[id];
    const r = m.simulate({ sp, w0, n0: 1000, days, feed: { mode: 'ration' }, fcr: sp.fcr.typical });
    assert.ok(r.final.weightG >= min && r.final.weightG <= max, `${id}: ${w0} g -> ${r.final.weightG.toFixed(0)} g in ${days} d`);
    const fcr = r.feedKg / (r.final.biomassKg - (w0 * 1000) / 1000);
    assert.ok(fcr >= sp.fcr.range[0] - 0.1 && fcr <= sp.fcr.range[1] + 0.15, `${id} implied FCR ${fcr.toFixed(2)}`);
  }
});

test('simulation: no feed -> no growth; overfeeding adds no growth; mortality lowers the count; weekly points', () => {
  const sp = SPECIES.tilapia;
  const base = { sp, w0: 50, n0: 1000, days: 30, fcr: sp.fcr.typical };
  const none = m.simulate({ ...base, feed: { mode: 'fixed', kgPerDay: 0 } });
  assert.equal(none.final.weightG, 50);
  const ration = m.simulate({ ...base, feed: { mode: 'ration' } });
  const over = m.simulate({ ...base, feed: { mode: 'ratio', ratio: 2 } });
  near(over.final.weightG, ration.final.weightG);
  near(over.feedKg, ration.feedKg * 2, 1e-6);
  const under = m.simulate({ ...base, feed: { mode: 'ratio', ratio: 0.5 } });
  assert.ok(under.final.weightG < ration.final.weightG);
  const dying = m.simulate({ ...base, feed: { mode: 'ration' }, mortalityPerDay: 0.01 });
  near(dying.final.count, 1000 * Math.exp(-0.3), 1e-6);
  assert.equal(ration.points.length, Math.ceil(30 / 7) + 1);
  assert.equal(ration.points[ration.points.length - 1].day, 30);
});

test('recommended feeding never exceeds what the animals can convert (FCR stays at the species value)', () => {
  for (const id of SPECIES_ORDER) {
    const sp = SPECIES[id];
    // a late stage where the feeding table alone would overshoot the growth curve
    const w0 = sp.growth.wInfG * 0.3;
    const r = m.simulate({ sp, w0, n0: 1000, days: 90, tempFactor: 0.9, feed: { mode: 'ration' }, fcr: sp.fcr.typical });
    const gain = r.final.biomassKg - w0;
    near(r.feedKg / gain, sp.fcr.typical, 0.01);
    assert.ok(m.usefulRationKg(100, w0, sp) <= m.dailyRationKg(100, w0, sp) + 1e-9);
  }
  // Economic FCR (feed / net harvest gain, deaths included) of the recommended plan is never worse
  // than the current plan's, for under- and over-feeding farmers alike.
  for (const feedKgPerDay of [1.0, 1.5, 3.0]) {
    const b = run({ ...PRAWN, feedKgPerDay, feedPricePerKg: 320, salePricePerKg: 2200 }).business;
    assert.ok(b.recommended.fcr <= b.current.fcr + 0.01, `feed ${feedKgPerDay}: recommended FCR ${b.recommended.fcr} vs current ${b.current.fcr}`);
  }
});

test('size estimate from pond age grows with age', () => {
  const sp = SPECIES.carp;
  assert.equal(m.estimateWeightFromAge(sp, 0), sp.growth.stockingG);
  assert.ok(m.estimateWeightFromAge(sp, 90) > m.estimateWeightFromAge(sp, 30));
});

/* ============================== water summary ============================== */

test('water summary: no history -> default temperature; temperature factor is the mean of DAILY factors', () => {
  const sp = SPECIES.tilapia;
  const bands = f.waterBands(sp);
  const none = m.summarizeWater([], { sp, bands });
  assert.equal(none.temperature.measured, false);
  near(none.temperature.mean, GENERAL.DEFAULT_TEMP_C);
  assert.equal(none.stress, 1);
  assert.equal(none.extraMortalityPerDay, 0);

  // 20 C and 30 C average 25 C, but the curve is non-linear: mean(f(20), f(30)) != f(25)
  const s = m.summarizeWater([{ temperature: 20 }, { temperature: 30 }], { sp, bands });
  near(s.temperature.factor, (m.temperatureFactor(20, sp.temperature) + 1) / 2);
  assert.notEqual(s.temperature.factor, m.temperatureFactor(25, sp.temperature));
  assert.ok(s.extraMortalityPerDay > 0, '20 C is in the danger zone for tilapia');

  const acid = m.summarizeWater(days14({ ph: 5.5 }), { sp, bands });
  assert.equal(acid.stress, GENERAL.STRESS.FACTOR_IN_DANGER);
  assert.equal(acid.ph.shares.DANGER, 1);
});

test('limits come from Settings for monitored species and from config for prawns', () => {
  assert.equal(f.waterBands(SPECIES.tilapia).fromSettings, true);
  assert.equal(f.waterBands(SPECIES.carp).turbidity.safeHigh, 50); // carp-specific Settings limit
  const pr = f.waterBands(SPECIES.prawn);
  assert.equal(pr.fromSettings, false);
  assert.equal(pr.ph.safeLow, SPECIES.prawn.limits.ph.safeLow);
});

/* ============================== verdict ============================== */

test('verdict thresholds: 90 % of current, 100 % / 115 % of best case', () => {
  const v = (requiredRate, currentRate = 10, bestRate = 20) =>
    m.verdictFor({ requiredRate, currentRate, bestRate, requiredWeightG: 100, wInfG: 1000 });
  assert.equal(v(9), 'ACHIEVABLE');
  assert.equal(v(9.01), 'ACHIEVABLE_WITH_CHANGES');
  assert.equal(v(20), 'ACHIEVABLE_WITH_CHANGES');
  assert.equal(v(20.01), 'UNLIKELY');
  assert.equal(v(23), 'UNLIKELY');
  assert.equal(v(23.01), 'NOT_POSSIBLE');
  assert.equal(v(0), 'ACHIEVABLE'); // already there
  assert.equal(v(-5), 'ACHIEVABLE');
  assert.equal(v(5, 0, 20), 'ACHIEVABLE_WITH_CHANGES'); // nothing grows on the current plan
  assert.equal(m.verdictFor({ requiredRate: 1, currentRate: 10, bestRate: 20, requiredWeightG: 990, wInfG: 1000 }), 'NOT_POSSIBLE');
});

/* ============================== input validation ============================== */

test('input validation: clear messages and the field that is wrong', () => {
  expect400({ ...TILAPIA, species: 'shark' }, 'species', /Choose a species/);
  expect400({ ...TILAPIA, stock: 0 }, 'stock', /more than 0/);
  expect400({ ...TILAPIA, stock: -10 }, 'stock');
  expect400({ ...TILAPIA, stock: 10.5 }, 'stock', /whole number/);
  expect400({ ...TILAPIA, stock: 'abc' }, 'stock', /must be a number/);
  expect400({ ...TILAPIA, targetKg: 0 }, 'targetKg');
  expect400({ ...TILAPIA, targetKg: undefined }, 'targetKg', /required/);
  expect400({ ...TILAPIA, mealsPerDay: 5 }, 'mealsPerDay', /at most 4/);
  expect400({ ...TILAPIA, mealsPerDay: 0 }, 'mealsPerDay');
  expect400({ ...TILAPIA, feedKgPerDay: -1 }, 'feedKgPerDay');
  expect400({ ...TILAPIA, avgWeightG: 1500 }, 'avgWeightG', /below 1000 g/);
  expect400({ ...TILAPIA, avgWeightG: undefined }, 'avgWeightG', /stocking date/);
  expect400({ ...TILAPIA, avgWeightG: undefined, stockingDate: '2027-01-01' }, 'stockingDate', /future/);
  expect400({ ...TILAPIA, survivalPct: 120 }, 'survivalPct');
  expect400({ ...TILAPIA, feedPricePerKg: -3 }, 'feedPricePerKg');
  expect400({ ...TILAPIA, months: undefined }, 'deadline', /deadline/);
  expect400({ ...TILAPIA, months: 30 }, 'months');
  expect400({ ...TILAPIA, months: undefined, deadline: '2026-10-01' }, 'deadline', /past/);
  expect400({ ...TILAPIA, months: undefined, deadline: '2026-11-17' }, 'deadline', /past/);
  expect400({ ...TILAPIA, months: undefined, deadline: '2026-11-20' }, 'deadline', /at least 7 days/);
  expect400({ ...TILAPIA, months: undefined, deadline: '2029-01-01' }, 'deadline', /2 years/);
  expect400({ ...TILAPIA, months: undefined, deadline: 'next year' }, 'deadline', /not a valid date/);
  expect400(null, undefined, /body/);
  // prawn stock is kg, so decimals are fine
  assert.equal(f.parseInput({ ...PRAWN, stock: 40.5 }, NOW).stock, 40.5);
});

/* ============================== full calculation ============================== */

test('every species produces a complete, consistent result', () => {
  const codes = ['ACHIEVABLE', 'ACHIEVABLE_WITH_CHANGES', 'UNLIKELY', 'NOT_POSSIBLE'];
  for (const id of SPECIES_ORDER) {
    const r = run(BASE_FOR[id]);
    assert.ok(codes.includes(r.verdict.code), `${id} verdict ${r.verdict.code}`);
    assert.ok(r.verdict.reason.length > 20);
    assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(r.verdict.confidence.level));
    assert.equal(r.estimate, true);
    assert.ok(r.projection.points.length >= 2);
    assert.ok(r.projection.recommended.harvestKg >= r.projection.current.harvestKg - 0.1, `${id}: recommended >= current`);
    assert.ok(r.projection.bestCase.harvestKg >= r.projection.recommended.harvestKg - 0.1, `${id}: best >= recommended`);
    assert.equal(r.environment.rows.length, 4); // temperature, pH, turbidity, TDS
    assert.ok(r.environment.rain.instruction);
    assert.ok(r.feeding.recommended.meals.length === r.feeding.recommended.mealsPerDay);
    assert.ok(r.assumptions.length >= 10);
    assert.equal(r.business, null); // no prices given
    assert.equal(r.density, null); // no pond size given
  }
});

test('worked example: prawns, 40 kg of 15 g -> 100 kg in 3 months', () => {
  const r = run(PRAWN);
  assert.equal(r.stock.count, 2667); // 40 kg / 15 g
  assert.equal(r.species.stockUnit, 'kg');
  assert.equal(r.days, 91);
  // Underfed today (1.5 kg vs a 2 kg ration): current plan falls short, recommended plan reaches it.
  assert.equal(r.feeding.status, 'UNDERFEEDING');
  assert.equal(r.feeding.recommended.feedKgPerDay, 2);
  assert.match(r.feeding.summary, /Keep 2 meals a day, increase daily feed by 33%/);
  assert.ok(r.projection.current.harvestKg < 100);
  assert.ok(r.projection.recommended.harvestKg >= 100);
  assert.equal(r.verdict.code, 'ACHIEVABLE_WITH_CHANGES');
  assert.match(r.verdict.reason, /You need 100 kg but your current plan reaches only about \d\d(\.\d)? kg/);
  assert.ok(r.gap.requiredFinalWeightG > 45 && r.gap.requiredFinalWeightG < 55);
  assert.ok(r.gap.requiredRateGPerWeek > r.gap.currentRateGPerWeek);
  assert.ok(r.gap.requiredRateGPerWeek <= r.gap.bestRateGPerWeek);
  assert.equal(r.gap.shortfallRecommendedKg, 0);
  assert.equal(r.feeding.targetFeed.totalKg, Math.round(60 * 1.8)); // (100 - 40) kg x FCR 1.8
  assert.equal(r.alternative, null);
});

test('prawns, 150 kg in 3 months is NOT POSSIBLE and offers the closest alternative', () => {
  const r = run({ ...PRAWN, targetKg: 150 });
  assert.equal(r.verdict.code, 'NOT_POSSIBLE');
  assert.ok(r.alternative);
  assert.ok(r.alternative.maxHarvestKg > 90 && r.alternative.maxHarvestKg < 150);
  assert.match(r.alternative.message, /Closest alternative/);
  assert.equal(r.environment.limiting.waterBlocksTarget, false);
});

test('a target reachable later gets an earliest harvest date', () => {
  const r = run({ ...TILAPIA, targetKg: 900, months: 3 });
  assert.notEqual(r.verdict.code, 'ACHIEVABLE');
  assert.ok(r.alternative.earliestDate, 'earliest date expected');
  assert.ok(new Date(r.alternative.earliestDate) > new Date(r.deadline));
});

test('target already in the pond -> ACHIEVABLE', () => {
  const r = run({ ...TILAPIA, targetKg: 50 });
  assert.equal(r.verdict.code, 'ACHIEVABLE');
  assert.match(r.verdict.reason, /already holds/);
});

test('cold water: water temperature is flagged as what blocks the target', () => {
  const cold = { daily: days14({ temperature: 24 }), latest: latestAt({ temperature: 24 }) };
  const warm = run({ ...PRAWN, targetKg: 95 });
  const r = run({ ...PRAWN, targetKg: 95 }, cold);
  assert.ok(r.projection.recommended.harvestKg < warm.projection.recommended.harvestKg);
  assert.equal(r.environment.limiting.waterBlocksTarget, true);
  const t = r.environment.rows.find((x) => x.key === 'temperature');
  assert.match(t.instruction, /Temperature is 24 °C\. Giant Freshwater Prawn grow fastest at 28–31 °C, so growth is about \d+% slower/);
  assert.ok(t.growthEffectPct < 0);
});

test('missing sensor history: runs on default temperature, says so, LOW confidence', () => {
  const r = run(TILAPIA, {});
  assert.equal(r.environment.source, 'default');
  assert.match(r.environment.note, /default temperature of 28 °C/);
  assert.equal(r.verdict.confidence.level, 'LOW');
  assert.ok(r.environment.rows.every((x) => x.latest === null));
});

test('overfeeding: same growth, worse FCR and cost; flagged with an explanation', () => {
  const body = { ...TILAPIA, mealsPerDay: 4, feedKgPerDay: 9, feedPricePerKg: 300, salePricePerKg: 900 };
  const r = run(body);
  assert.equal(r.feeding.status, 'OVERFEEDING');
  assert.match(r.feeding.summary, /Reduce from 4 meals to 3, cut daily feed by 50%/);
  assert.match(r.feeding.notes[0], /wasted money.*polluting/);
  assert.ok(r.business.current.fcr > r.business.recommended.fcr * 1.8);
  assert.ok(r.business.recommended.profit > r.business.current.profit);
  assert.ok(r.business.recommended.costPerKgProduced < r.business.current.costPerKgProduced);
});

test('zero feed: no growth on the current plan', () => {
  const r = run({ ...TILAPIA, feedKgPerDay: 0, targetKg: 300 });
  assert.equal(r.feeding.status, 'UNDERFEEDING');
  assert.ok(r.projection.current.finalWeightG <= 50);
  assert.match(r.feeding.summary, /start feeding about/);
});

test('low oxygen signs (hot water + heavy rain) cut today\'s feed and skip a meal', () => {
  const r = run(TILAPIA, { daily: days14(), latest: latestAt({ temperature: 33.5, rain: 95 }) });
  assert.equal(r.feeding.lowOxygen.active, true);
  assert.ok(r.feeding.today.feedKg < r.feeding.recommended.feedKgPerDay);
  assert.equal(r.feeding.today.meals, r.feeding.recommended.mealsPerDay - 1);
  assert.equal(r.environment.rain.status, 'DANGER');
});

test('pond density check warns above the species limit; volume converts to area', () => {
  const r = run({ ...PRAWN, pondAreaM2: 300 }); // 100 kg / 300 m2 = 0.33 kg/m2 > 0.3
  assert.equal(r.density.status, 'WARNING');
  assert.match(r.density.message, /aeration/);
  assert.equal(run({ ...PRAWN, pondAreaM2: 150 }).density.status, 'DANGER'); // 0.67 kg/m2 > 1.5 x 0.3
  const v = run({ ...TILAPIA, pondVolumeM3: 1200 });
  assert.equal(v.density.areaM2, 1000); // 1200 m3 / 1.2 m
  assert.equal(v.density.status, 'SAFE');
});

test('size estimated from the stocking date is marked as an estimate', () => {
  const r = run({ ...BASE_FOR.carp, avgWeightG: undefined, stockingDate: '2026-08-19' });
  assert.equal(r.stock.sizeEstimated, true);
  assert.ok(r.stock.avgWeightG > SPECIES.carp.growth.stockingG);
  assert.ok(r.assumptions.some((a) => a.label === 'Current average size' && a.source === 'estimate'));
});

test('a past deadline is rejected even through calculate()', () => {
  assert.throws(() => run({ ...TILAPIA, months: undefined, deadline: '2026-01-01' }), /past/);
});
