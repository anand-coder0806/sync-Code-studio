const express = require('express');
const User = require('../models/User');

const router = express.Router();

// Triggers a Mongoose ValidationError to test global error formatting.
router.get('/validation-error', (req, res, next) => {
  const invalidUser = new User({});
  const validationError = invalidUser.validateSync();
  return next(validationError);
});

module.exports = router;
