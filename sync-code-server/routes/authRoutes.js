const express = require('express');
const router = express.Router();
const { register, login, getProfile, verifyEmail, bootstrapAdmin, updateUserRole, listUsers } = require('../controllers/authController');
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/authorization');
const validateRequest = require('../middleware/validateRequest');
const { registerValidator, loginValidator } = require('../middleware/validators/authValidators');

// Public routes
router.post('/register', registerValidator, validateRequest, register);
router.post('/login', loginValidator, validateRequest, login);
router.get('/verify-email', verifyEmail);
router.post('/bootstrap-admin', bootstrapAdmin);

// Protected routes
router.get('/profile', auth, getProfile);
router.get('/users', auth, requireAdmin, listUsers);
router.patch('/users/:userId/role', auth, requireAdmin, updateUserRole);

module.exports = router;
