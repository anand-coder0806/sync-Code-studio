const express = require('express');
const auth = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');
const { requireAdmin } = require('../middleware/authorization');
const { readOnlyStatusHandler, updateReadOnlyModeHandler } = require('../middleware/readOnlyMode');

const router = express.Router();

router.get('/read-only', optionalAuth, readOnlyStatusHandler);
router.patch('/read-only', auth, requireAdmin, updateReadOnlyModeHandler);

module.exports = router;
