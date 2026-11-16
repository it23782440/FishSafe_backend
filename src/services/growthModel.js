/*
 * Pure growth / feeding / survival formulas for the Harvest Feasibility tool.
 * No I/O here: every function takes plain numbers/objects and returns new ones,
 * so each formula can be unit-tested on its own (test/feasibility.test.js).
 * Constants live in config/aquaculture.js.
 */
const { GENERAL, VERDICT, MEAL_TIMES } = require('../config/aquaculture');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const lo = (b, k) => (b && isNum(b[k]) ? b[k] : -Infinity);
const hi = (b, k) => (b && isNum(b[k]) ? b[k] : Infinity);

/*
 * Temperature growth multiplier (0..1), trapezoid curve:
 *   0 at/below `min`, linear up to 1 at `optLow`, 1 until `optHigh`, linear down to 0 at `max`.
 */
function temperatureFactor(t, c) {
  if (!isNum(t)) return null;
  if (t <= c.min || t >= c.max) return 0;
  if (t < c.optLow) return (t - c.min) / (c.optLow - c.min);
  if (t > c.optHigh) return (c.max - t) / (c.max - c.optHigh);
  return 1;
}

/* SAFE / WARNING / DANGER for a value against a {warnLow, safeLow, safeHigh, warnHigh, warnMargin} band. */
function bandStatus(value, band, { margin = true } = {}) {
  if (!isNum(value) || !band) return 'UNKNOWN';
  if (value < lo(band, 'warnLow') || value > hi(band, 'warnHigh')) return 'DANGER';
  if (value < lo(band, 'safeLow') || value > hi(band, 'safeHigh')) return 'WARNING';
  const m = margin && isNum(band.warnMargin) ? band.warnMargin : 0;
  if (m > 0 && (value < lo(band, 'safeLow') + m || value > hi(band, 'safeHigh') - m)) return 'WARNING';
  return 'SAFE';
}

/*
 * Growth multiplier (0..1) for a water-quality stressor (pH, turbidity, TDS):
 * 1 inside the safe range, falling linearly to FACTOR_AT_WARN_LIMIT at the
 * danger limit, and FACTOR_IN_DANGER beyond it. Unknown value -> 1 (no penalty).
 */
function stressFactor(value, band, s = GENERAL.STRESS) {
  if (!isNum(value) || !band) return 1;
  const sl = lo(band, 'safeLow'); const sh = hi(band, 'safeHigh');
  const wl = lo(band, 'warnLow'); const wh = hi(band, 'warnHigh');
  if (value >= sl && value <= sh) return 1;
  if (value < wl || value > wh) return s.FACTOR_IN_DANGER;
  const [edge, limit] = value < sl ? [sl, wl] : [sh, wh];
  if (!isNum(limit)) return s.FACTOR_AT_WARN_LIMIT;
  const frac = Math.abs(value - edge) / Math.abs(limit - edge || 1);
  return 1 - frac * (1 - s.FACTOR_AT_WARN_LIMIT);
}

/* Value for weight `w` from a step table [[upToWeight, value], ...]. */
function lookupStep(table, w) {
  for (const [upTo, v] of table) if (w <= upTo) return v;
  return table[table.length - 1][1];
}

const feedingRatePct = (w, sp) => lookupStep(sp.feeding.table, w);
const recommendedMeals = (w, sp) => clamp(lookupStep(sp.feeding.meals, w), 1, 4);

/** Daily feed ration (kg) = biomass x feeding rate (% body weight) x temperature factor. */
function dailyRationKg(biomassKg, w, sp, tempFactor = 1) {
  if (!(biomassKg > 0) || !(w > 0)) return 0;
  return biomassKg * (feedingRatePct(w, sp) / 100) * clamp(isNum(tempFactor) ? tempFactor : 1, 0, 1);
}

/*
 * Useful daily feed (kg): the table ration, but never more than the animals can turn
 * into growth (potential daily gain x FCR). Feed above this only raises the FCR.
 */
function usefulRationKg(biomassKg, w, sp, { tempFactor = 1, stress = 1, fcr = sp.fcr.typical } = {}) {
  const table = dailyRationKg(biomassKg, w, sp, tempFactor);
  if (!(table > 0)) return 0;
  const envF = clamp(isNum(tempFactor) ? tempFactor : 1, 0, 1) * clamp(stress, 0, 1);
  const potentialPerDay = (biomassKg * (vbGrow(w, 7, sp.growth.kPerDay, sp.growth.wInfG, envF) / w - 1)) / 7;
  return Math.min(table, Math.max(potentialPerDay, 0) * fcr);
}

/** Meal schedule: [{ time, share, kg }] for `meals` per day (species-specific times when defined). */
function mealSchedule(meals, dailyKg, sp) {
  const n = clamp(Math.round(meals), 1, 4);
  const plan = (sp.feeding.times && sp.feeding.times[n]) || MEAL_TIMES[n];
  return plan.times.map((time, i) => ({ time, share: plan.split[i], kg: dailyKg * plan.split[i] }));
}

/** Growth lost when fewer meals are given than recommended (bigger meals -> more waste). */
function mealFactor(meals, recMeals, penalty = GENERAL.MISSING_MEAL_PENALTY) {
  return clamp(1 - penalty * Math.max(0, recMeals - meals), 0.5, 1);
}

/*
 * Von Bertalanffy growth in cube-root weight space (standard fish growth form):
 *   W(t)^(1/3) = Winf^(1/3) - (Winf^(1/3) - W0^(1/3)) * exp(-k * f * t)
 * Growth slows automatically as the animal approaches the maximum size Winf.
 * `factor` (0..1) is the combined water-quality multiplier.
 */
function vbGrow(w, days, kPerDay, wInf, factor = 1) {
  if (!(w > 0) || !(days > 0) || !(factor > 0)) return w;
  if (w >= wInf) return w;
  const ci = Math.cbrt(w);
  const cInf = Math.cbrt(wInf);
  const c = cInf - (cInf - ci) * Math.exp(-kPerDay * clamp(factor, 0, 1) * days);
  return c ** 3;
}

/** Specific growth rate, % body weight per day: SGR = 100 * (ln Wf - ln Wi) / days. */
function sgr(wi, wf, days) {
  if (!(wi > 0) || !(wf > 0) || !(days > 0)) return null;
  return (100 * (Math.log(wf) - Math.log(wi))) / days;
}

/** Constant daily mortality rate that leaves `survival` (0..1] alive after `days`. */
function dailyMortality(survival, days) {
  if (!(survival > 0) || survival >= 1 || !(days > 0)) return 0;
  return -Math.log(survival) / days;
}
const survivalOver = (mortalityPerDay, days) => Math.exp(-Math.max(mortalityPerDay, 0) * Math.max(days, 0));

/*
 * Week-by-week projection.
 *   per step: ration (appetite) = feeding table x biomass x temperature factor
 *             eaten           = min(feed given, ration)    (extra feed is wasted)
 *             potential gain  = von Bertalanffy x (tempFactor x stressFactor)
 *             gain            = min(potential, eaten / FCR) x mealFactor
 *             count falls with the daily mortality rate
 * feed: { mode: 'ration' }               the feeding table (recommended / best case)
 *       { mode: 'ratio', ratio }         the same share of the ration as today (farmer's current plan)
 *       { mode: 'fixed', kgPerDay }      a constant amount every day
 * `meals` (when given) applies the missing-meal penalty against the recommended meals.
 */
function simulate({ sp, w0, n0, days, tempFactor = 1, stress = 1, mortalityPerDay = 0, feed, fcr, meals = null, step = 7 }) {
  const envF = clamp(tempFactor, 0, 1) * clamp(stress, 0, 1);
  const { kPerDay, wInfG } = sp.growth;
  let w = w0;
  let n = n0;
  let feedTotal = 0;
  const points = [{ day: 0, weightG: w, count: n, biomassKg: (n * w) / 1000, feedKg: 0 }];
  for (let d = 0; d < days; d += step) {
    const dt = Math.min(step, days - d);
    const biomass = (n * w) / 1000;
    const potentialKg = (n * (vbGrow(w, dt, kPerDay, wInfG, envF) - w)) / 1000;
    const rationKg = dailyRationKg(biomass, w, sp, tempFactor) * dt;
    // Recommended feeding never exceeds what can be converted into growth (no wasted feed).
    const usefulKg = Math.min(rationKg, Math.max(potentialKg, 0) * fcr);
    const feedKg = feed.mode === 'fixed' ? feed.kgPerDay * dt
      : feed.mode === 'ratio' ? usefulKg * Math.max(feed.ratio, 0)
        : usefulKg;
    const eatenKg = Math.min(feedKg, rationKg);
    const mf = meals ? mealFactor(meals, recommendedMeals(w, sp)) : 1;
    const gainKg = Math.max(0, Math.min(potentialKg, eatenKg / fcr)) * mf;
    w = Math.min(w + (n > 0 ? (gainKg * 1000) / n : 0), wInfG);
    n *= survivalOver(mortalityPerDay, dt);
    feedTotal += feedKg;
    points.push({ day: d + dt, weightG: w, count: n, biomassKg: (n * w) / 1000, feedKg: feedTotal });
  }
  const last = points[points.length - 1];
  return { points, final: last, feedKg: feedTotal };
}

/* Estimate today's average weight from the pond's age (days since stocking at the typical stocking size). */
function estimateWeightFromAge(sp, ageDays, tempFactor = 1) {
  if (!(ageDays > 0)) return sp.growth.stockingG;
  const r = simulate({ sp, w0: sp.growth.stockingG, n0: 1000, days: ageDays, tempFactor, feed: { mode: 'ration' }, fcr: sp.fcr.typical });
  return r.final.weightG;
}

/* First simulated day the biomass reaches `targetKg` (null if never within the points). */
function firstDayReaching(points, targetKg) {
  const p = points.find((x) => x.biomassKg >= targetKg);
  return p ? p.day : null;
}

/*
 * Summarise recent daily means into growth factors.
 * daily: [{ date, temperature, ph, turbidity, tds, rainMax }] (nulls allowed)
 * bands: welfare limits { temperature, ph, turbidity, tds }
 * The temperature factor is the MEAN OF DAILY FACTORS (not the factor of the mean
 * temperature) because the curve is non-linear.
 */
function summarizeWater(daily, { sp, bands, g = GENERAL }) {
  const out = { days: daily.length, extraMortalityPerDay: 0, extraMortalityTempOnly: 0 };
  const shares = (vals, band) => {
    const st = vals.map((v) => bandStatus(v, band, { margin: false }));
    const n = st.length || 1;
    return { WARNING: st.filter((s) => s === 'WARNING').length / n, DANGER: st.filter((s) => s === 'DANGER').length / n };
  };
  const mort = (sh) => sh.WARNING * g.EXTRA_MORTALITY_PER_DAY.WARNING + sh.DANGER * g.EXTRA_MORTALITY_PER_DAY.DANGER;

  const temps = daily.map((d) => d.temperature).filter(isNum);
  const tVals = temps.length ? temps : [g.DEFAULT_TEMP_C];
  const tShares = temps.length ? shares(temps, bands.temperature) : { WARNING: 0, DANGER: 0 };
  out.temperature = {
    measured: temps.length > 0,
    days: temps.length,
    mean: mean(tVals),
    factor: mean(tVals.map((t) => temperatureFactor(t, sp.temperature))),
    shares: tShares,
  };
  out.extraMortalityTempOnly = mort(tShares);
  out.extraMortalityPerDay += out.extraMortalityTempOnly;

  for (const key of ['ph', 'turbidity', 'tds']) {
    const vals = daily.map((d) => d[key]).filter(isNum);
    const sh = vals.length ? shares(vals, bands[key]) : { WARNING: 0, DANGER: 0 };
    out[key] = {
      measured: vals.length > 0,
      days: vals.length,
      mean: mean(vals),
      factor: vals.length ? mean(vals.map((v) => stressFactor(v, bands[key]))) : 1,
      shares: sh,
    };
    out.extraMortalityPerDay += mort(sh);
  }
  // Stressors act together, but the worst one dominates ("law of the minimum") [assume].
  out.stress = Math.min(out.ph.factor, out.turbidity.factor, out.tds.factor);
  out.combined = out.temperature.factor * out.stress;

  const rain = daily.map((d) => d.rainMax).filter(isNum);
  out.rain = {
    days: rain.length,
    heavyDays: rain.filter((r) => r >= g.LOW_OXYGEN.HEAVY_RAIN_PCT).length,
    heavyShare: rain.length ? rain.filter((r) => r >= g.LOW_OXYGEN.HEAVY_RAIN_PCT).length / rain.length : 0,
  };
  return out;
}

/*
 * Verdict from growth rates (g/week).
 *   required <= 90 % of current-plan rate  -> ACHIEVABLE
 *   required <= 100 % of best-case rate    -> ACHIEVABLE_WITH_CHANGES
 *   required <= 115 % of best-case rate    -> UNLIKELY
 *   otherwise (or bigger than the species can grow) -> NOT_POSSIBLE
 */
function verdictFor({ requiredRate, currentRate, bestRate, requiredWeightG, wInfG }, v = VERDICT) {
  if (!(requiredRate > 0)) return 'ACHIEVABLE'; // target already in the pond
  if (requiredWeightG > wInfG * v.MAX_WEIGHT_OF_ASYMPTOTE) return 'NOT_POSSIBLE';
  if (currentRate > 0 && requiredRate <= v.ACHIEVABLE_MAX_OF_CURRENT * currentRate) return 'ACHIEVABLE';
  if (bestRate > 0 && requiredRate <= v.WITH_CHANGES_MAX_OF_BEST * bestRate) return 'ACHIEVABLE_WITH_CHANGES';
  if (bestRate > 0 && requiredRate <= v.UNLIKELY_MAX_OF_BEST * bestRate) return 'UNLIKELY';
  return 'NOT_POSSIBLE';
}

module.exports = {
  isNum, clamp, mean,
  temperatureFactor, bandStatus, stressFactor, lookupStep,
  feedingRatePct, recommendedMeals, dailyRationKg, usefulRationKg, mealSchedule, mealFactor,
  vbGrow, sgr, dailyMortality, survivalOver,
  simulate, estimateWeightFromAge, firstDayReaching, summarizeWater, verdictFor,
};
