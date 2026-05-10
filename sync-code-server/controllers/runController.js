const { executeCode } = require('../services/codeRunner');

exports.runCode = async (req, res, next) => {
  try {
    const result = await executeCode(req.body);
    return res.status(200).json(result);
  } catch (error) {
    if (error.isExecutionError) {
      return res.status(error.status || 500).json({
        status: 'error',
        errorType: error.errorType || 'RUNTIME_ERROR',
        message: error.message || 'Code execution failed.',
        ...(error.details ? { details: error.details } : {}),
      });
    }

    return next(error);
  }
};
