/*
 * Species-specific history: the SAME real sensor records, evaluated against the
 * selected species' limits. Different species therefore get different statuses,
 * time-in-zone figures and excursion lists from the same water.
 */
const registry = require('./speciesRegistry');
const { classify, thresholdsFor } = require('./statusService');
const { getCoreSeries, getSummary } = require('./readingService');
const { explain, worst, CORE_PARAMS } = require('./assessmentService');

const TREND_EPS = { temperature: 0.3, ph: 0.05 };

/** Worse of a bucket's min/max for one parameter, plus which value caused it. */
function judge(param, min, max, speciesId) {
  const a = { status: classify(param, min, speciesId), value: min };
  const b = { status: classify(param, max, speciesId), value: max };
  const t = thresholdsFor(speciesId)[param];
  if (a.status === 'UNKNOWN' && b.status === 'UNKNOWN') return { status: 'UNKNOWN', value: null, direction: null };
  const rank = { DANGER: 3, WARNING: 2, SAFE: 1, UNKNOWN: 0 };
  let pick = rank[a.status] > rank[b.status] ? a : rank[b.status] > rank[a.status] ? b : null;
  if (!pick) pick = max !== null && max > t.safeHigh ? b : min !== null && min < t.safeLow ? a : b;
  const direction = pick.value > t.safeHigh - (t.warnMargin || 0) ? 'high' : pick.value < t.safeLow + (t.warnMargin || 0) ? 'low' : null;
  return { status: pick.status, value: pick.value, direction };
}

function trendOf(values) {
  const v = values.filter((x) => typeof x === 'number');
  if (v.length < 4) return { direction: 'unknown', delta: null };
  const q = Math.max(1, Math.floor(v.length / 4));
  const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  return { first: avg(v.slice(0, q)), last: avg(v.slice(-q)) };
}

function detectExcursions(points, speciesId) {
  const out = [];
  let cur = null;
  const close = () => {
    if (!cur) return;
    const worstParam = CORE_PARAMS.filter((p) => cur.params[p]).sort(
      (a, b) => (cur.params[b].status === 'DANGER') - (cur.params[a].status === 'DANGER')
    )[0];
    const pk = cur.params[worstParam];
    cur.parameter = worstParam;
    cur.reason = explain(worstParam, pk.peak, speciesId).reason;
    cur.durationMinutes = Math.round((new Date(cur.end) - new Date(cur.start)) / 60000);
    out.push(cur);
    cur = null;
  };
  for (const pt of points) {
    const per = {};
    for (const p of CORE_PARAMS) per[p] = judge(p, pt[`${p}Min`], pt[`${p}Max`], speciesId);
    const status = worst(CORE_PARAMS.map((p) => per[p].status === 'UNKNOWN' ? 'SAFE' : per[p].status));
    if (status === 'SAFE') { close(); continue; }
    if (!cur) cur = { start: pt.timestamp, end: pt.timestamp, status, params: {}, readings: 0 };
    cur.end = pt.timestamp;
    cur.readings += pt.samples || 1;
    if (status === 'DANGER') cur.status = 'DANGER';
    for (const p of CORE_PARAMS) {
      const j = per[p];
      if (j.status === 'SAFE' || j.status === 'UNKNOWN') continue;
      const prev = cur.params[p];
      const more = !prev || (j.status === 'DANGER' && prev.status !== 'DANGER') ||
        (j.status === prev.status && (j.direction === 'low' ? j.value < prev.peak : j.value > prev.peak));
      if (more) cur.params[p] = { status: j.status, peak: j.value, direction: j.direction };
    }
  }
  close();
  return out.reverse(); // newest first
}

async function speciesHistory({ speciesId, deviceId, range, from, to, limit }) {
  const sp = registry.get(speciesId);
  const th = thresholdsFor(speciesId);
  const core = await getCoreSeries({ deviceId, range, from, to, limit });
  const summary = await getSummary({ deviceId, range, from, to, species: speciesId });

  const series = core.points.map((pt) => {
    const t = judge('temperature', pt.temperatureMin, pt.temperatureMax, speciesId);
    const p = judge('ph', pt.phMin, pt.phMax, speciesId);
    return {
      ...pt,
      temperatureStatus: t.status,
      phStatus: p.status,
      status: worst([t.status, p.status].map((s) => (s === 'UNKNOWN' ? 'SAFE' : s))),
    };
  });

  const zones = { SAFE: 0, WARNING: 0, DANGER: 0 };
  series.forEach((s) => { zones[s.status] += 1; });
  const total = series.length || 1;
  const pct = Object.fromEntries(Object.entries(zones).map(([k, v]) => [k, series.length ? Math.round((v / total) * 100) : null]));

  const params = {};
  for (const p of CORE_PARAMS) {
    const vals = series.map((s) => s[p]).filter((x) => typeof x === 'number');
    const tr = trendOf(vals);
    const delta = tr.first === undefined ? null : +(tr.last - tr.first).toFixed(2);
    const eps = TREND_EPS[p];
    params[p] = {
      ...summary.sensors[p],
      latest: vals.length ? vals[vals.length - 1] : null,
      trend: delta === null ? { direction: 'unknown', delta: null } : { direction: Math.abs(delta) < eps ? 'stable' : delta > 0 ? 'rising' : 'falling', delta },
    };
  }

  return {
    species: { id: sp.id, name: sp.name, scientific: sp.scientific },
    window: { from: core.window.since, to: core.window.until, range: core.window.range },
    bucketed: core.bucketed,
    count: series.length,
    readings: summary.count,
    thresholds: { temperature: th.temperature, ph: th.ph },
    summary: { temperature: params.temperature, ph: params.ph, zones: pct },
    series,
    excursions: detectExcursions(core.points, speciesId).slice(0, 50),
  };
}

module.exports = { speciesHistory, detectExcursions, judge };
