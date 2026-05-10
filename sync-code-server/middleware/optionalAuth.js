const jwt = require('jsonwebtoken');
const User = require('../models/User');

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !process.env.JWT_SECRET) {
      return next();
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('_id role name email');

    if (user) {
      req.user = {
        userId: String(user._id),
        role: user.role || 'writer',
        name: user.name,
        email: user.email,
      };
    }

    return next();
  } catch (error) {
    return next();
  }
};

module.exports = optionalAuth;
