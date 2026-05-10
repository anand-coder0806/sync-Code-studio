const express = require('express');
const auth = require('../middleware/auth');
const { executeCommand } = require('../controllers/terminalController');

const router = express.Router();

router.use(auth);
router.post('/execute', executeCommand);

module.exports = router;
