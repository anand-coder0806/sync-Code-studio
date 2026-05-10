const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const requireAdmin = (req, res, next) => {
  if (req.user?.role === 'admin') {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: 'Admin permission is required for this action.',
  });
};

const requireWritePermissionForWriteMethods = (req, res, next) => {
  if (!WRITE_METHODS.has(req.method)) {
    return next();
  }

  if (req.user?.role === 'reader') {
    console.warn('[authz] write blocked', {
      method: req.method,
      path: req.originalUrl,
      userId: req.user?.userId,
      role: req.user?.role,
    });
    return res.status(403).json({
      success: false,
      message: 'This account has read-only access. Write operation is not allowed.',
    });
  }

  return next();
};

module.exports = {
  requireAdmin,
  requireWritePermissionForWriteMethods,
};
