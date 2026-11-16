const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { deviceStatus, getThresholds, setSpecies } = require('../controllers/deviceController');

// Configuration changes get a much tighter limit than reads.
const configLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many configuration changes, try again in a minute' },
});

router.get('/status', deviceStatus);
router.get('/thresholds', getThresholds); // alias also mounted under /config
router.put('/species', configLimiter, setSpecies);

module.exports = router;
