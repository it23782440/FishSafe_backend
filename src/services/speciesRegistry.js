/*
 * Fish species registry.
 *
 * MongoDB (`species` collection) is the source of truth, but threshold checks
 * happen in hot synchronous paths (every ingest, every API read). The registry
 * keeps an in-memory copy that is refreshed after each create/edit/delete, and
 * starts out populated with the built-in defaults so everything also works
 * before the database has been loaded (e.g. in unit tests).
 */
const { DEFAULT_PROFILES, DEFAULT_SPECIES } = require('../config/species');

const listeners = [];
let map = new Map();

const unbound = (v, inf) => (v === null || v === undefined ? inf : v);

function normalizeThresholds(th = {}) {
  const out = {};
  for (const [key, r] of Object.entries(th)) {
    if (!r) continue;
    out[key] = {
      warnLow: unbound(r.warnLow, -Infinity),
      safeLow: unbound(r.safeLow, -Infinity),
      safeHigh: unbound(r.safeHigh, Infinity),
      warnHigh: unbound(r.warnHigh, Infinity),
      warnMargin: r.warnMargin || 0,
      source: r.source || 'custom',
    };
  }
  return out;
}

function toProfile(doc, builtIn = false) {
  return {
    id: doc.slug,
    name: doc.name,
    scientific: doc.scientific || '',
    description: doc.description || '',
    imageUrl: doc.imageUrl || '',
    builtIn: doc.builtIn ?? builtIn,
    thresholds: normalizeThresholds(doc.thresholds),
  };
}

function setAll(profiles) {
  map = new Map(profiles.map((p) => [p.id, p]));
  listeners.forEach((fn) => fn());
}

// Start with the built-in defaults.
setAll(DEFAULT_PROFILES.map((d) => toProfile(d, true)));

const registry = {
  get: (id) => map.get(id),
  has: (id) => typeof id === 'string' && map.has(id),
  list: () => [...map.values()],
  ids: () => [...map.keys()],
  /** The species used when none is configured; falls back if the default was deleted. */
  defaultId: () => (map.has(DEFAULT_SPECIES) ? DEFAULT_SPECIES : map.keys().next().value),
  onChange: (fn) => listeners.push(fn),

  /** Insert any missing built-in species. Never overwrites edits made by the user. */
  async seedDefaults() {
    const Species = require('../models/Species');
    for (const d of DEFAULT_PROFILES) {
      await Species.updateOne({ slug: d.slug }, { $setOnInsert: { ...d, builtIn: true } }, { upsert: true });
    }
  },

  /** Reload from MongoDB (call after any change). */
  async load() {
    const Species = require('../models/Species');
    const docs = await Species.find().sort({ createdAt: 1, slug: 1 }).lean();
    if (docs.length) setAll(docs.map((d) => toProfile(d)));
    return registry.list();
  },
};

module.exports = registry;
