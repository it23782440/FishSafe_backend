const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/speciesController');
const router = express.Router();

// Configuration writes get a much tighter limit than reads.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test', // tests make many config calls
  message: { error: 'Too many configuration changes, try again in a minute' },
});

router.get('/', c.list);
router.post('/', writeLimiter, c.create);
router.get('/:id', c.get);
router.get('/:id/assessment', c.assessment);
router.get('/:id/history', c.history);
router.put('/:id', writeLimiter, c.update);
router.delete('/:id', writeLimiter, c.remove);

module.exports = router;
