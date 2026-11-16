const express = require('express');
const c = require('../controllers/feasibilityController');
const router = express.Router();

// Harvest Feasibility calculator. POST only computes (nothing is stored);
// it falls under the general write rate limit in app.js.
router.get('/species', c.species);
router.post('/calculate', c.calculate);

module.exports = router;
