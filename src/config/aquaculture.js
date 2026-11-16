/*
 * Biological constants for the Harvest Feasibility calculator.
 *
 * EVERY NUMBER HERE IS AN APPROXIMATION for planning, not a guarantee. The values
 * are typical figures for semi-intensive freshwater pond culture in the tropics,
 * taken from general aquaculture guidance (FAO Cultured Aquatic Species
 * Information Programme fact sheets, common feed-manufacturer feeding charts)
 * and then rounded. Comments mark each value as:
 *   [lit]    typical literature/extension figure (rounded) - still verify locally
 *   [calib]  calibrated so the model reproduces typical grow-out durations
 *   [assume] engineering assumption with no single source - verify before relying on it
 * Have them checked by a fisheries / aquaculture extension officer for your farm.
 *
 * To add a species: add an entry to SPECIES below (same shape). If the species
 * also exists in Settings (MongoDB `species` collection) put its id in
 * `settingsId`, and its pH / turbidity / TDS limits are taken from Settings.
 */

/* ---------- verdict thresholds (ratio of REQUIRED growth rate to a scenario's rate) ---------- */
const VERDICT = {
  ACHIEVABLE_MAX_OF_CURRENT: 0.9, // required <= 90 % of the current-plan rate -> ACHIEVABLE (10 % safety buffer) [assume]
  WITH_CHANGES_MAX_OF_BEST: 1.0, // required <= 100 % of the best-case rate     -> ACHIEVABLE WITH CHANGES     [assume]
  UNLIKELY_MAX_OF_BEST: 1.15, //    required <= 115 % of the best-case rate     -> UNLIKELY, else NOT POSSIBLE [assume]
  MAX_WEIGHT_OF_ASYMPTOTE: 0.95, // a required final size above 95 % of the max size is treated as NOT POSSIBLE [assume]
};

/* ---------- general model constants ---------- */
const GENERAL = {
  HISTORY_DAYS: 14, // recent sensor history used as "typical conditions until harvest" [assume]
  DAYS_PER_MONTH: 30.44, // average month length
  MIN_HORIZON_DAYS: 7, // a deadline must be at least a week away
  MAX_HORIZON_DAYS: 730, // projections beyond 2 years are not meaningful
  DEFAULT_TEMP_C: 28, // used when there is no sensor history: typical lowland Sri Lankan pond water [assume]
  DEFAULT_POND_DEPTH_M: 1.2, // converts a volume (m3) to an area (m2) when only volume is given [assume]
  MISSING_MEAL_PENALTY: 0.05, // growth lost per meal/day fewer than recommended (larger meals are wasted more) [assume]
  OVERFEED_RATIO: 1.15, // feeding >15 % above the table ration counts as overfeeding [assume]
  UNDERFEED_RATIO: 0.85, // feeding <85 % of the table ration counts as underfeeding [assume]
  STRESS: {
    FACTOR_AT_WARN_LIMIT: 0.8, // growth multiplier exactly at a danger limit (falls linearly from 1 at the safe limit) [assume]
    FACTOR_IN_DANGER: 0.5, // growth multiplier beyond a danger limit [assume]
  },
  EXTRA_MORTALITY_PER_DAY: {
    // Added daily mortality for the share of days a parameter is outside its safe range [assume]
    WARNING: 0.0005, // +0.05 %/day
    DANGER: 0.003, //   +0.3 %/day
  },
  LOW_OXYGEN: {
    // Dissolved oxygen is NOT measured; these are proxies for "oxygen is probably low" [assume]
    TEMP_ABOVE_OPT_C: 2, // water this many degrees above the optimum range
    HEAVY_RAIN_PCT: 80, // rain sensor reading (matches the rain danger limit in config/thresholds.js)
    RAINY_DAY_SHARE: 0.3, // or heavy rain on 30 % of recent days
    FEED_CUT: 0.25, // cut daily feed by 25 % while oxygen is probably low [lit: common extension advice 20-50 %]
  },
  // TDS: the FishSafe conductivity probe reports TDS in ppm (see config/thresholds.js), used directly as mg/L.
  TDS_FIELD: 'conductivity',
};

/* ---------- default meal times (24 h clock) ---------- */
// Avoid feeding at dawn, when dissolved oxygen is lowest [lit]. `split` = share of the daily feed per meal.
const MEAL_TIMES = {
  1: { times: ['16:00'], split: [1] },
  2: { times: ['08:30', '16:30'], split: [0.5, 0.5] },
  3: { times: ['08:30', '12:30', '16:30'], split: [1 / 3, 1 / 3, 1 / 3] },
  4: { times: ['08:00', '11:00', '14:00', '17:00'], split: [0.25, 0.25, 0.25, 0.25] },
};

/*
 * Per species:
 *  growth.wInfG      maximum (asymptotic) average weight under pond culture, g
 *  growth.kPerDay    von Bertalanffy rate in cube-root weight space at optimal temperature, 1/day [calib]
 *  growth.stockingG  typical size at stocking - used to estimate size from pond age
 *  temperature       trapezoid growth curve: 0 below min, rises to 1 at optLow, 1 until optHigh, 0 at max
 *  feeding.table     [[upToWeightG, % body weight per day], ...] at optimal temperature
 *  feeding.meals     [[upToWeightG, meals per day], ...]
 *  fcr               feed conversion ratio (kg feed per kg gain)
 *  survival          expected survival over a typical cycle (converted to a daily rate)
 *  density.maxKgM2   biomass a still-water pond can carry without strong aeration
 */
const SPECIES = {
  tilapia: {
    id: 'tilapia',
    name: 'Nile Tilapia',
    scientific: 'Oreochromis niloticus',
    settingsId: 'tilapia',
    stockUnit: 'count',
    growth: { wInfG: 1000, kPerDay: 0.009, stockingG: 10 }, // [calib] 10 g -> ~450 g in ~6 months at 28 C [lit]
    temperature: { min: 16, optLow: 27, optHigh: 30, max: 38 }, // [lit] feeding stops < ~16 C; optimum 27-30 C
    feeding: {
      table: [[5, 8], [20, 6], [50, 4.5], [100, 3.5], [250, 2.8], [450, 2.0], [Infinity, 1.6]], // [lit] feeding charts
      meals: [[5, 4], [50, 3], [Infinity, 2]], // [lit] fry 4+, fingerlings 3, grow-out 2
    },
    fcr: { typical: 1.6, best: 1.5, range: [1.5, 1.8] }, // [lit]
    survival: { cycle: 0.85, cycleDays: 180 }, // [lit] 80-90 % in grow-out
    density: { maxKgM2: 1.0 }, // [lit] ~10 t/ha without aeration; aerated ponds can hold more
  },

  prawn: {
    id: 'prawn',
    name: 'Giant Freshwater Prawn',
    scientific: 'Macrobrachium rosenbergii',
    settingsId: null, // not a monitored species in Settings: limits below are used
    stockUnit: 'kg',
    growth: { wInfG: 120, kPerDay: 0.009, stockingG: 2 }, // [calib] 2 g juveniles -> ~40-47 g in ~4-5 months [lit]
    temperature: { min: 18, optLow: 28, optHigh: 31, max: 35 }, // [lit] best 28-31 C, slow < 24 C, lethal < ~14 / > ~35 C
    limits: {
      // Welfare limits used for status + stress (prawns are not in Settings) [lit, rounded]
      temperature: { warnLow: 22, safeLow: 26, safeHigh: 32, warnHigh: 34, warnMargin: 0 },
      ph: { warnLow: 6.5, safeLow: 7.0, safeHigh: 8.5, warnHigh: 9.0, warnMargin: 0 },
    },
    feeding: {
      table: [[2, 10], [5, 7], [15, 5], [30, 3.5], [50, 2.5], [Infinity, 2]], // [lit] 10 % early, 2-3 % at harvest size
      meals: [[3, 3], [Infinity, 2]], // [lit] prawns feed mostly at night: give the larger meal in the evening
      times: {
        2: { times: ['07:00', '18:30'], split: [0.35, 0.65] }, // [lit] ~2/3 of the feed in the evening
        3: { times: ['07:00', '12:00', '18:30'], split: [0.3, 0.2, 0.5] },
      },
    },
    fcr: { typical: 1.8, best: 1.6, range: [1.6, 2.0] }, // [lit]
    survival: { cycle: 0.6, cycleDays: 150 }, // [lit] 50-70 % is common in grow-out (cannibalism at moulting)
    density: { maxKgM2: 0.3 }, // [lit] semi-intensive yields ~2-3 t/ha per crop
  },

  carp: {
    id: 'carp',
    name: 'Common Carp',
    scientific: 'Cyprinus carpio',
    settingsId: 'carp',
    stockUnit: 'count',
    growth: { wInfG: 3000, kPerDay: 0.005, stockingG: 20 }, // [calib] 30 g -> ~1 kg in ~8-9 months [lit]
    temperature: { min: 12, optLow: 24, optHigh: 29, max: 35 }, // [lit] grows fastest ~24-29 C in tropical ponds
    feeding: {
      table: [[10, 6], [50, 4], [200, 3], [500, 2.5], [Infinity, 2]], // [lit]
      meals: [[20, 3], [Infinity, 2]], // [lit]
    },
    fcr: { typical: 1.8, best: 1.7, range: [1.7, 2.0] }, // [lit]
    survival: { cycle: 0.85, cycleDays: 240 }, // [lit]
    density: { maxKgM2: 0.5 }, // [lit] ~3-5 t/ha in semi-intensive ponds
  },

  catfish: {
    id: 'catfish',
    name: 'African Catfish',
    scientific: 'Clarias gariepinus',
    settingsId: 'catfish',
    stockUnit: 'count',
    growth: { wInfG: 3000, kPerDay: 0.007, stockingG: 10 }, // [calib] 10 g -> ~900 g in ~6 months [lit]
    temperature: { min: 18, optLow: 26, optHigh: 30, max: 36 }, // [lit] optimum ~26-30 C
    feeding: {
      table: [[10, 8], [50, 5], [200, 3.5], [500, 2.5], [Infinity, 2]], // [lit]
      meals: [[20, 3], [Infinity, 2]], // [lit] the larger meal in the evening suits its night feeding
    },
    fcr: { typical: 1.3, best: 1.2, range: [1.2, 1.5] }, // [lit]
    survival: { cycle: 0.8, cycleDays: 180 }, // [lit]
    density: { maxKgM2: 3.0 }, // [lit] air-breathing; tolerates high density with water exchange
  },
};

const SPECIES_ORDER = ['tilapia', 'prawn', 'carp', 'catfish'];

module.exports = { VERDICT, GENERAL, MEAL_TIMES, SPECIES, SPECIES_ORDER };
