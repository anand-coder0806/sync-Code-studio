const errorHandler = (err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message || 'Internal Server Error';
  let details = undefined;

  // Mongoose schema validation errors
  if (err.name === 'ValidationError') {
    status = 400;
    message = 'Validation failed';
    details = Object.values(err.errors).map((validationErr) => ({
      field: validationErr.path,
      message: validationErr.message,
    }));
  }

  // Mongo duplicate key errors (for example unique email)
  if (err.code === 11000) {
    status = 409;
    const duplicateField = Object.keys(err.keyValue || {})[0] || 'field';
    message = `${duplicateField} already exists`;
    details = [{ field: duplicateField, message }];
  }

  // Invalid Mongo object id in params
  if (err.name === 'CastError') {
    status = 400;
    message = `Invalid ${err.path}`;
    details = [{ field: err.path, message: err.message }];
  }

  console.error(`[Error] ${status}: ${message}`);

  res.status(status).json({
    success: false,
    error: {
      status,
      message,
      ...(details && { details }),
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  });
};

module.exports = errorHandler;
