const express = require('express');
const router = express.Router();
const { listAlerts, markRead, markAllRead } = require('../controllers/alertController');

router.get('/', listAlerts);
router.post('/read-all', markAllRead); // above '/:id/read'
router.patch('/:id/read', markRead);

module.exports = router;
