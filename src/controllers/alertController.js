const Alert = require('../models/Alert');

const RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * GET /api/alerts?deviceId=&active=true&severity=DANGER&range=24h&since=&limit=100
 * Returns alert history (newest first). Use active=true for the live panel.
 */
async function listAlerts(req, res, next) {
  try {
    const { deviceId, active, severity, range, since } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);

    const filter = {};
    if (deviceId) filter.deviceId = deviceId;
    if (active === 'true') filter.active = true;
    if (active === 'false') filter.active = false;
    if (severity) filter.severity = severity.toUpperCase();
    const createdAt = {};
    if (range) {
      if (!RANGE_MS[range]) {
        return res.status(400).json({ error: 'Invalid range' });
      }
      createdAt.$gte = new Date(Date.now() - RANGE_MS[range]);
    }
    if (since) {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        return res.status(400).json({ error: 'Invalid since date' });
      }
      if (!createdAt.$gte || sinceDate > createdAt.$gte) {
        createdAt.$gte = sinceDate;
      }
    }
    if (Object.keys(createdAt).length) filter.createdAt = createdAt;

    const alerts = await Alert.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ count: alerts.length, alerts });
  } catch (err) {
    next(err);
  }
}

module.exports = { listAlerts };
