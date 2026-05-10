const READ_ONLY_BLOCK_MESSAGE = 'Read-only mode enabled. Modification not allowed.';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const parseBoolean = (value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }

  return false;
};

let currentReadOnlyMode = parseBoolean(process.env.READ_ONLY_MODE);

const isReadOnlyModeEnabled = () => currentReadOnlyMode;

const setReadOnlyModeEnabled = (nextValue) => {
  currentReadOnlyMode = parseBoolean(nextValue);
  return currentReadOnlyMode;
};

const readOnlyStatusHandler = (req, res) => {
  res.status(200).json({
    success: true,
    readOnlyMode: isReadOnlyModeEnabled(),
    canToggleReadOnly: req.user?.role === 'admin',
  });
};

const updateReadOnlyModeHandler = (req, res) => {
  const { readOnlyMode } = req.body || {};
  if (typeof readOnlyMode !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'readOnlyMode must be a boolean value.',
    });
  }

  const updatedValue = setReadOnlyModeEnabled(readOnlyMode);
  return res.status(200).json({
    success: true,
    readOnlyMode: updatedValue,
    message: updatedValue ? 'Read-only mode is now active.' : 'Write mode is now active.',
  });
};

const blockWriteOperationsInReadOnlyMode = (req, res, next) => {
  if (req.path === '/system/read-only') {
    return next();
  }

  if (!isReadOnlyModeEnabled() || !WRITE_METHODS.has(req.method)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: READ_ONLY_BLOCK_MESSAGE,
  });
};

module.exports = {
  READ_ONLY_BLOCK_MESSAGE,
  isReadOnlyModeEnabled,
  setReadOnlyModeEnabled,
  readOnlyStatusHandler,
  updateReadOnlyModeHandler,
  blockWriteOperationsInReadOnlyMode,
};
