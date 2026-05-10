const User = require('../models/User');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sendVerificationEmail } = require('../services/emailService');

const getJwtSecret = () => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined in environment variables');
  }

  return process.env.JWT_SECRET;
};

const hashVerificationToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

const isSmtpConfigured = () => {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS);
};

const VALID_ROLES = new Set(['admin', 'writer', 'reader']);

exports.register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    const normalizedEmail = email.toLowerCase();
    const shouldAutoVerifyForDev = process.env.NODE_ENV !== 'production' && !isSmtpConfigured();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({ success: false, error: 'Email already in use' });
    }

    const verificationToken = shouldAutoVerifyForDev ? null : crypto.randomBytes(32).toString('hex');
    const verificationTokenHash = verificationToken ? hashVerificationToken(verificationToken) : null;
    const verificationTokenExpires = verificationToken
      ? new Date(Date.now() + 1000 * 60 * 60 * 24)
      : null;

    const existingUserCount = await User.countDocuments({});
    const assignedRole = existingUserCount === 0 ? 'admin' : 'writer';

    const user = new User({
      name,
      email: normalizedEmail,
      password,
      isVerified: shouldAutoVerifyForDev,
      verificationTokenHash,
      verificationTokenExpires,
      role: assignedRole,
    });
    await user.save();

    if (verificationToken) {
      const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
      const verificationUrl = `${baseUrl}/api/auth/verify-email?token=${verificationToken}`;
      await sendVerificationEmail(user.email, verificationUrl);
    }

    res.status(201).json({
      success: true,
      message: shouldAutoVerifyForDev
        ? 'User registered successfully. Email verification is skipped in local development.'
        : 'User registered. Please verify your email before logging in.',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isVerified: user.isVerified,
        role: user.role,
        canWrite: user.role !== 'reader',
        canToggleReadOnly: user.role === 'admin',
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = email.toLowerCase();
    const allowDevAutoVerify = process.env.NODE_ENV !== 'production' && !isSmtpConfigured();

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    if (!user.isVerified) {
      if (allowDevAutoVerify) {
        user.isVerified = true;
        user.verificationTokenHash = null;
        user.verificationTokenExpires = null;
        await user.save();
      } else {
        return res.status(403).json({ success: false, error: 'Email not verified. Please verify your email first.' });
      }
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const token = jwt.sign({ userId: user._id }, getJwtSecret(), {
      expiresIn: '7d',
    });

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isVerified: user.isVerified,
        role: user.role || 'writer',
        canWrite: (user.role || 'writer') !== 'reader',
        canToggleReadOnly: (user.role || 'writer') === 'admin',
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(200).json({
      ...user.toObject(),
      role: user.role || 'writer',
      canWrite: (user.role || 'writer') !== 'reader',
      canToggleReadOnly: (user.role || 'writer') === 'admin',
    });
  } catch (error) {
    next(error);
  }
};

exports.verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ success: false, error: 'Verification token is required' });
    }

    const verificationTokenHash = hashVerificationToken(token);

    const user = await User.findOne({
      verificationTokenHash,
      verificationTokenExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ success: false, error: 'Invalid or expired verification token' });
    }

    user.isVerified = true;
    user.verificationTokenHash = null;
    user.verificationTokenExpires = null;
    await user.save();

    return res.status(200).json({ success: true, message: 'Email verified successfully' });
  } catch (error) {
    return next(error);
  }
};

exports.bootstrapAdmin = async (req, res, next) => {
  try {
    const { email, token } = req.body || {};

    if (!email || !token) {
      return res.status(400).json({ success: false, error: 'Email and token are required' });
    }

    const expectedToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
    if (!expectedToken || token !== expectedToken) {
      return res.status(403).json({ success: false, error: 'Invalid bootstrap token' });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    user.role = 'admin';
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'User promoted to admin successfully.',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.updateUserRole = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { role } = req.body || {};

    if (!VALID_ROLES.has(role)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid role. Allowed roles: admin, writer, reader.',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (user.role === 'admin' && role !== 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          error: 'Cannot remove the last admin user.',
        });
      }
    }

    user.role = role;
    await user.save();

    return res.status(200).json({
      success: true,
      message: `User role updated to ${role}.`,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.listUsers = async (req, res, next) => {
  try {
    const users = await User.find({})
      .select('_id name email role isVerified createdAt updatedAt')
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      users: users.map((user) => ({
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role || 'writer',
        isVerified: Boolean(user.isVerified),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })),
    });
  } catch (error) {
    return next(error);
  }
};
