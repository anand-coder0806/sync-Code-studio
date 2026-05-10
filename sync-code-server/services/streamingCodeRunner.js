const { executeCode } = require('./codeRunner');

/**
 * Execute code with real-time streaming output via Socket.io
 * @param {Object} io - Socket.io instance
 * @param {Object} socket - Socket connection
 * @param {Object} payload - { language, code, input, fileName }
 */
async function runCodeWithStreaming(io, socket, payload) {
  const { language, code, input, fileName, executionId, roomId } = payload;

  const emitScoped = (eventName, data) => {
    const meta = {
      ...data,
      roomId: roomId || null,
      socketId: socket.id,
      userId: socket.userId,
      userName: socket.userName,
      timestamp: Date.now(),
    };

    console.log('[socket emit][code]', eventName, {
      executionId: meta.executionId || null,
      roomId: meta.roomId,
      socketId: meta.socketId,
      userId: meta.userId,
      type: meta.type || null,
    });

    if (roomId) {
      io.to(roomId).emit(eventName, meta);
      return;
    }

    socket.emit(eventName, meta);
  };

  try {
    // Send start event
    emitScoped('code-execution-start', {
      executionId,
      message: 'Execution started...',
    });

    // Define the onData callback for streaming output
    const onData = (type, data) => {
      // Emit output line-by-line with type (stdout/stderr)
      emitScoped('output-update', {
        executionId,
        type,
        data,
      });
    };

    // Execute code with streaming
    const result = await executeCode({
      language,
      code,
      input: input || '',
      fileName,
      onData, // Pass the streaming callback
    });

    // Send final result
    emitScoped('code-execution-done', {
      executionId,
      result,
      success: result.status === 'success',
    });
  } catch (error) {
    // Send error event
    emitScoped('code-execution-error', {
      executionId,
      error: error.message,
      errorType: error.errorType || 'ERROR',
      status: error.status || 500,
    });
  }
}

module.exports = {
  runCodeWithStreaming,
};
