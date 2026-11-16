const Alert = require('../models/Alert');

/**
 * GET /api/alerts?deviceId=&severity=&active=&kind=&read=&from=&to=&limit=
 * Newest first. Also returns `unreadCount` for the device (ignoring other filters)
 * so the sidebar badge stays correct while the list is filtered.
 */
async function listAlerts(req, res, next) {
  try {
    const { deviceId, severity, active, kind, read, from, to } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);

    const filter = {};
    if (deviceId) filter.deviceId = deviceId;
    if (['INFO', 'WARNING', 'DANGER'].includes(severity)) filter.severity = severity;
    if (active === 'true') filter.active = true;
    if (active === 'false') filter.active = false;
    if (kind) filter.kind = kind === 'threshold' ? { $in: ['threshold', null] } : kind;
    // Optional created-at window (used by the Reports page). Both ends are optional.
    if (from || to) {
      const f = from ? new Date(from) : null;
      const t = to ? new Date(to) : null;
      if ((f && Number.isNaN(f.getTime())) || (t && Number.isNaN(t.getTime()))) {
        return res.status(400).json({ error: '`from` and `to` must be valid dates' });
      }
      filter.createdAt = { ...(f ? { $gte: f } : {}), ...(t ? { $lte: t } : {}) };
    }
    if (read === 'true') filter.read = true;
    if (read === 'false') filter.read = { $ne: true };

    const [alerts, unreadCount] = await Promise.all([
      Alert.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      Alert.countDocuments({ ...(deviceId ? { deviceId } : {}), read: { $ne: true } }),
    ]);
    res.json({ count: alerts.length, unreadCount, alerts });
  } catch (err) { next(err); }
}

/** PATCH /api/alerts/:id/read   body: { read: true|false } (default true) */
async function markRead(req, res, next) {
  try {
    const read = req.body?.read !== false;
    const alert = await Alert.findByIdAndUpdate(
      req.params.id, { $set: { read, readAt: read ? new Date() : null } }, { new: true }
    ).lean();
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json(alert);
  } catch (err) { next(err); }
}

/** POST /api/alerts/read-all?deviceId= */
async function markAllRead(req, res, next) {
  try {
    const filter = { read: { $ne: true } };
    if (req.query.deviceId) filter.deviceId = req.query.deviceId;
    const r = await Alert.updateMany(filter, { $set: { read: true, readAt: new Date() } });
    res.json({ ok: true, updated: r.modifiedCount });
  } catch (err) { next(err); }
}

module.exports = { listAlerts, markRead, markAllRead };
