/*
 * DEFAULT fish species profiles. They are only used to SEED the `species`
 * collection (first start) and as an in-memory fallback if the database has
 * none. After seeding, MongoDB is the source of truth and thresholds can be
 * edited from the Settings page (PUT /api/species/:id).
 *
 * Band model per parameter (null = unbounded):
 *   value < warnLow  or value > warnHigh      -> DANGER   (outside tolerable limits)
 *   value < safeLow  or value > safeHigh      -> WARNING  (outside recommended range)
 *   within `warnMargin` of safeLow / safeHigh -> WARNING  (approaching a limit)
 *   otherwise                                 -> SAFE
 *
 * Tilapia temperature/pH follow the examples in the project brief
 * (25-30 C, pH 6.5-8.5). The other values are engineering approximations from
 * typical aquaculture guidance - validate them for your pond and climate.
 */
const DEFAULT_SPECIES = 'tilapia';

const DEFAULT_PROFILES = [
  {
    slug: 'tilapia',
    name: 'Nile Tilapia',
    scientific: 'Oreochromis niloticus',
    description: 'Hardy warm-water fish. Prefers 25–30 °C and near-neutral pH.',
    thresholds: {
      temperature: { warnLow: 23, safeLow: 25, safeHigh: 30, warnHigh: 32, warnMargin: 1, source: 'brief' },
      ph: { warnLow: 6.0, safeLow: 6.5, safeHigh: 8.5, warnHigh: 8.8, warnMargin: 0.3, source: 'brief' },
    },
  },
  {
    slug: 'carp',
    name: 'Common Carp',
    scientific: 'Cyprinus carpio',
    description: 'Tolerates cooler water and more turbidity. Comfortable at 20–28 °C.',
    thresholds: {
      temperature: { warnLow: 16, safeLow: 20, safeHigh: 28, warnHigh: 32, warnMargin: 1, source: 'assumption' },
      ph: { warnLow: 6.0, safeLow: 6.5, safeHigh: 9.0, warnHigh: 9.5, warnMargin: 0.3, source: 'assumption' },
      turbidity: { warnLow: null, safeLow: null, safeHigh: 50, warnHigh: 80, source: 'assumption' },
      conductivity: { warnLow: 50, safeLow: 100, safeHigh: 1000, warnHigh: 1500, source: 'assumption' },
    },
  },
  {
    slug: 'catfish',
    name: 'African Catfish',
    scientific: 'Clarias gariepinus',
    description: 'Warm-water, air-breathing fish. Thrives at 26–32 °C and tolerates turbid water.',
    thresholds: {
      temperature: { warnLow: 22, safeLow: 26, safeHigh: 32, warnHigh: 35, warnMargin: 1, source: 'assumption' },
      ph: { warnLow: 6.0, safeLow: 6.5, safeHigh: 8.5, warnHigh: 9.0, warnMargin: 0.3, source: 'assumption' },
      turbidity: { warnLow: null, safeLow: null, safeHigh: 40, warnHigh: 70, source: 'assumption' },
      conductivity: { warnLow: 50, safeLow: 100, safeHigh: 1000, warnHigh: 1500, source: 'assumption' },
    },
  },
];

module.exports = { DEFAULT_SPECIES, DEFAULT_PROFILES };
