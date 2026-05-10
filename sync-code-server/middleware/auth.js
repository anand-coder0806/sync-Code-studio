const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authorization token missing or malformed' });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ success: false, error: 'JWT secret is not configured' });
  }

  try {
    const token = authHeader.split(' ')[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('_id role name email');
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid user for token' });
    }

    req.user = {
      userId: String(user._id),
      role: user.role || 'writer',
      name: user.name,
      email: user.email,
    };
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

module.exports = auth;
