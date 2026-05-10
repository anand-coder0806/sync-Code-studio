const {
  buildTerminalSessionKey,
  executeTerminalCommandInSession,
  addTerminalParticipant,
  createTerminalError,
} = require('../services/terminalSessionService');

exports.executeCommand = async (req, res, next) => {
  try {
    const command = String(req.body?.command || '').trim();
    if (!command) {
      throw createTerminalError(400, 'Command is required.');
    }

    const sessionKey = buildTerminalSessionKey({
      userId: req.user?.userId,
      socketId: req.ip,
    });
    addTerminalParticipant(sessionKey, `http:${req.user?.userId || req.ip}`);

    const outputChunks = [];
    const result = await executeTerminalCommandInSession({
      sessionKey,
      requestId: `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      command,
      onStart: () => {},
      onOutput: (_type, chunk) => {
        outputChunks.push(chunk);
      },
    });

    return res.status(200).json({
      success: true,
      output: outputChunks.join(''),
      cwd: result.cwd,
      exitCode: result.exitCode,
    });
  } catch (error) {
    if (error?.isTerminalCommandError) {
      return res.status(error.status || 400).json({
        success: false,
        error: error.message,
      });
    }
    return next(error);
  }
};
