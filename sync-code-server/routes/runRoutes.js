const express = require('express');
const auth = require('../middleware/auth');
const { requireWritePermissionForWriteMethods } = require('../middleware/authorization');
const { runCode } = require('../controllers/runController');

const router = express.Router();

router.use(auth);
router.use(requireWritePermissionForWriteMethods);
router.post('/', runCode);

module.exports = router;