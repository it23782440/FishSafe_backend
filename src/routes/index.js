const express = require('express');
const router = express.Router();

const sensorRoutes = require('./sensorRoutes');
const alertRoutes = require('./alertRoutes');
const deviceRoutes = require('./deviceRoutes');
const mongoose = require('mongoose');
const { getThresholds } = require('../controllers/deviceController');
const speciesRoutes = require('./speciesRoutes');
const feasibilityRoutes = require('./feasibilityRoutes');

// Health check (used by Render + dashboard "backend status").
// Returns 503 while MongoDB is not connected so Render can restart/hold traffic.
router.get('/health', (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.status(dbConnected ? 200 : 503).json({
    status: dbConnected ? 'ok' : 'degraded',
    service: 'fishsafe-backend',
    database: dbConnected ? 'connected' : 'disconnected',
    time: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

router.use('/sensors', sensorRoutes);
router.use('/alerts', alertRoutes);
router.use('/device', deviceRoutes);
router.use('/species', speciesRoutes);
router.use('/feasibility', feasibilityRoutes);
router.get('/config/thresholds', getThresholds);

module.exports = router;
