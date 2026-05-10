import { io } from 'socket.io-client';

// Keep default aligned with sync-code-server/.env (PORT=5001).
const SOCKET_SERVER_URL =
  process.env.REACT_APP_SOCKET_URL ||
  `${typeof window !== 'undefined' ? window.location.protocol : 'http:'}//${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:5001`;

let socket = null;

/**
 * Initialize Socket.io connection to the backend server
 * @returns {Object} Socket instance
 */
export const initializeSocket = () => {
  const nextToken = localStorage.getItem('token') || '';

  if (socket) {
    const currentToken = String(socket.auth?.token || '');
    socket.auth = {
      ...(socket.auth || {}),
      token: nextToken,
    };

    if (currentToken !== String(nextToken)) {
      socket.disconnect();
      socket.connect();
      return socket;
    }

    if (!socket.connected) {
      socket.connect();
    }
    return socket;
  }

  socket = io(SOCKET_SERVER_URL, {
    auth: {
      token: nextToken,
    },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5,
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => {
    console.log('✅ Socket CONNECTED:', socket.id);
  });

  socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', reason);
  });

  socket.on('connect_error', (error) => {
    console.error('⚠️ Socket connection error:', error.message);
  });

  socket.on('reconnect', () => {
    console.log('Socket reconnected');
  });

  socket.on('reconnect_attempt', () => {
    console.log('Socket reconnect attempt...');
  });

  return socket;
};

/**
 * Get the current socket instance
 * @returns {Object} Socket instance or null if not connected
 */
export const getSocket = () => {
  return socket;
};

/**
 * Check if socket is connected
 * @returns {boolean} True if socket is connected, false otherwise
 */
export const isSocketConnected = () => {
  return socket && socket.connected;
};

/**
 * Disconnect the socket
 */
export const disconnectSocket = () => {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
};

/**
 * Emit an event to the server
 * @param {string} eventName - Name of the event
 * @param {any} data - Data to send
 */
export const socketEmit = (eventName, data) => {
  if (socket && socket.connected) {
    console.log(`[socket emit] ${eventName}`, data);
    socket.emit(eventName, data);
  } else {
    console.warn('Socket is not connected');
  }
};

/**
 * Listen for an event from the server
 * @param {string} eventName - Name of the event to listen for
 * @param {Function} callback - Callback function to execute when event is received
 */
export const socketOn = (eventName, callback) => {
  if (socket) {
    console.log(`[socket on] ${eventName}`);
    socket.on(eventName, callback);
  } else {
    console.warn('Socket is not initialized');
  }
};

/**
 * Remove an event listener
 * @param {string} eventName - Name of the event
 * @param {Function} callback - Callback function to remove
 */
export const socketOff = (eventName, callback) => {
  if (socket) {
    console.log(`[socket off] ${eventName}`);
    socket.off(eventName, callback);
  }
};

/**
 * Listen for an event only once
 * @param {string} eventName - Name of the event to listen for
 * @param {Function} callback - Callback function to execute when event is received
 */
export const socketOnce = (eventName, callback) => {
  if (socket) {
    socket.once(eventName, callback);
  } else {
    console.warn('Socket is not initialized');
  }
};

/**
 * Join a room
 * @param {string} roomId - ID of the room to join
 * @param {string} userId - User ID
 * @param {string} userName - User name
 * @param {string} fileKey - Active file key
 * @param {string} code - Current editor code
 * @param {string} language - Active language
 */
export const joinRoom = (roomId, userId, userName, fileKey, code, language) => {
  if (socket && socket.connected) {
    const fileId = String(fileKey || '__default__');
    console.log('[socket emit] join_room', { roomId, userId, userName, fileId, language, socketId: socket.id });
    socket.emit('join_room', { roomId, userId, userName, fileId, fileKey: fileId, code, language, socketId: socket.id });
  } else {
    console.warn('Socket is not connected');
  }
};

/**
 * Leave a room
 * @param {string} roomId - ID of the room to leave
 */
export const leaveRoom = (roomId) => {
  if (socket && socket.connected) {
    console.log('[socket emit] leave-room', { roomId });
    socket.emit('leave-room', { roomId });
  } else {
    console.warn('Socket is not connected');
  }
};

/**
 * Get all active rooms
 * @param {Function} callback - Callback function that receives the rooms list
 */
export const getActiveRooms = (callback) => {
  if (socket && socket.connected) {
    socket.emit('get-rooms', callback);
  } else {
    console.warn('Socket is not connected');
  }
};

/**
 * Get room information
 * @param {string} roomId - ID of the room
 * @param {Function} callback - Callback function that receives the room info
 */
export const getRoomInfo = (roomId, callback) => {
  if (socket && socket.connected) {
    socket.emit('get-room-info', roomId, callback);
  } else {
    console.warn('Socket is not connected');
  }
};

/**
 * Emit code update to the server
 * @param {string} code - The updated code
 * @param {string} language - The programming language
 * @param {string} userId - ID of the user
 * @param {string} roomId - Current room id
 * @param {string} fileId - Current file key/id
 */
export const emitCodeChange = (code, language, userId, roomId, fileId) => {
  if (socket && socket.connected) {
    const normalizedFileId = String(fileId || '__default__');
    const payload = {
      code,
      language,
      userId,
      roomId: String(roomId || ''),
      fileId: normalizedFileId,
      fileKey: normalizedFileId,
      socketId: socket.id,
      timestamp: Date.now(),
    };

    console.log('[socket emit] code-change', {
      roomId: payload.roomId,
      fileId: payload.fileId,
      language: payload.language,
      userId: payload.userId,
      socketId: payload.socketId,
      codeLength: String(payload.code || '').length,
    });

    socket.emit('code-change', payload);
  } else {
    console.warn('Socket is not connected');
  }
};

export const emitCodeUpdate = (code, language, userId, fileKey, roomId = '') => {
  emitCodeChange(code, language, userId, roomId, fileKey);
};

export const emitSuggestCode = ({ code, userId, roomId, fileId, language, role, source = 'manual' }) => {
  if (socket && socket.connected) {
    const normalizedFileId = String(fileId || '__default__');
    const payload = {
      code: String(code || ''),
      language,
      userId,
      role: String(role || ''),
      roomId: String(roomId || ''),
      fileId: normalizedFileId,
      fileKey: normalizedFileId,
      source,
      socketId: socket.id,
      timestamp: Date.now(),
    };

    socket.emit('suggest-code', payload);
  } else {
    console.warn('Socket is not connected');
  }
};

export const emitConflictRequest = ({ code, userId, roomId, fileId, language }) => {
  if (socket && socket.connected) {
    const normalizedFileId = String(fileId || '__default__');
    const payload = {
      code: String(code || ''),
      language,
      userId,
      roomId: String(roomId || ''),
      fileId: normalizedFileId,
      fileKey: normalizedFileId,
      socketId: socket.id,
      timestamp: Date.now(),
    };

    socket.emit('conflict-request', payload);
  } else {
    console.warn('Socket is not connected');
  }
};

export const emitCodeTyping = ({ code, language, userId, roomId, fileId }) => {
  if (socket && socket.connected) {
    const normalizedFileId = String(fileId || '__default__');
    const payload = {
      code: String(code || ''),
      language,
      userId,
      roomId: String(roomId || ''),
      fileId: normalizedFileId,
      fileKey: normalizedFileId,
      socketId: socket.id,
      timestamp: Date.now(),
    };

    socket.emit('code_typing', payload);
  } else {
    console.warn('Socket is not connected');
  }
};

export const emitCodeCommit = ({ code, language, userId, roomId, fileId }) => {
  if (socket && socket.connected) {
    const normalizedFileId = String(fileId || '__default__');
    const payload = {
      code: String(code || ''),
      language,
      userId,
      roomId: String(roomId || ''),
      fileId: normalizedFileId,
      fileKey: normalizedFileId,
      socketId: socket.id,
      timestamp: Date.now(),
    };

    socket.emit('code_commit', payload);
  } else {
    console.warn('Socket is not connected');
  }
};

export const emitCodeRun = ({ code, language, userId, roomId, fileId, role }) => {
  if (socket && socket.connected) {
    const normalizedFileId = String(fileId || '__default__');
    const payload = {
      code: String(code || ''),
      language,
      userId,
      roomId: String(roomId || ''),
      fileId: normalizedFileId,
      fileKey: normalizedFileId,
      role: String(role || ''),
      socketId: socket.id,
      timestamp: Date.now(),
    };

    socket.emit('code-run', payload);
  } else {
    console.warn('Socket is not connected');
  }
};

export const emitAcceptSuggestion = ({ roomId, fileId, requestId }) => {
  if (socket && socket.connected) {
    const payload = {
      roomId: String(roomId || ''),
      fileId: String(fileId || '__default__'),
      fileKey: String(fileId || '__default__'),
      requestId: String(requestId || ''),
      socketId: socket.id,
      timestamp: Date.now(),
    };

    socket.emit('approve-request', payload);
  } else {
    console.warn('Socket is not connected');
  }
};

export const emitRejectSuggestion = ({ roomId, fileId, requestId, code, language, userId, userName }) => {
  if (socket && socket.connected) {
    const payload = {
      roomId: String(roomId || ''),
      fileId: String(fileId || '__default__'),
      fileKey: String(fileId || '__default__'),
      requestId: String(requestId || ''),
      code: typeof code === 'string' ? code : undefined,
      language: String(language || ''),
      userId: userId || undefined,
      userName: userName || undefined,
      socketId: socket.id,
      timestamp: Date.now(),
    };

    socket.emit('reject-request', payload);
  } else {
    console.warn('Socket is not connected');
  }
};

export const emitApproveCode = ({ roomId, code, fileId, language, userId }) => {
  if (socket && socket.connected) {
    const normalizedFileId = String(fileId || '__default__');
    const payload = {
      roomId: String(roomId || ''),
      code: String(code || ''),
      fileId: normalizedFileId,
      fileKey: normalizedFileId,
      language,
      userId,
      socketId: socket.id,
      timestamp: Date.now(),
    };

    socket.emit('approve-code', payload);
  } else {
    console.warn('Socket is not connected');
  }
};


/**
 * Emit cursor position update to the server
 * @param {number} line - Line number of cursor
 * @param {number} column - Column number of cursor
 * @param {string} userId - ID of the user
 * @param {string} fileKey - Current file key/id
 */
export const emitCursorUpdate = (line, column, userId, fileKey) => {
  if (socket && socket.connected) {
    const payload = {
      userId,
      position: { lineNumber: line, column },
      fileId: fileKey,
      fileKey,
      socketId: socket.id,
      timestamp: Date.now(),
    };

    console.log('[socket emit] cursor-move', {
      userId: payload.userId,
      fileId: payload.fileId,
      lineNumber: payload.position.lineNumber,
      column: payload.position.column,
    });

    socket.emit('cursor-move', payload);
  } else {
    console.warn('Socket is not connected');
  }
};

/**
 * Emit typing status update to the server
 * @param {string} userId - ID of the user
 * @param {boolean} isTyping - Whether user is currently typing
 * @param {string} fileKey - Current file key/id
 */
export const emitTypingStatus = (userId, isTyping, fileKey) => {
  if (socket && socket.connected) {
    socket.emit('typing-status', { userId, isTyping, fileKey, socketId: socket.id, timestamp: Date.now() });
  } else {
    console.warn('Socket is not connected');
  }
};

/**
 * Emit active file presence update to the server
 * @param {string} userId - ID of the user
 * @param {string} fileKey - Current active file key/id
 */
export const emitActiveFilePresence = (userId, fileKey) => {
  if (socket && socket.connected) {
    const payload = {
      userId,
      fileId: fileKey,
      fileKey,
      socketId: socket.id,
      timestamp: Date.now(),
    };

    socket.emit('user-active-file', payload);
  } else {
    console.warn('Socket is not connected');
  }
};

export const emitActiveFileChanged = (fileKey) => {
  if (socket && socket.connected) {
    socket.emit('active-file-changed', {
      fileId: fileKey,
      fileKey,
      socketId: socket.id,
      timestamp: Date.now(),
    });
  }
};

export const emitTabsState = (tabs, activeFileId) => {
  if (socket && socket.connected) {
    socket.emit('tabs-state', {
      tabs,
      activeFileId,
      socketId: socket.id,
      timestamp: Date.now(),
    });
  }
};

export const emitFileEvent = (eventType, payload = {}) => {
  if (socket && socket.connected) {
    socket.emit('file-event', {
      eventType,
      payload,
      socketId: socket.id,
      timestamp: Date.now(),
    });
  }
};

export const emitFileCreate = (roomId, file) => {
  if (socket && socket.connected) {
    const payload = {
      roomId,
      file,
      socketId: socket.id,
      timestamp: Date.now(),
    };
    console.log('[socket emit] file-create', {
      roomId,
      fileId: file?._id || null,
      itemType: file?.itemType || null,
      socketId: socket.id,
    });
    socket.emit('file-create', payload);
  }
};

export const emitChatMessage = (roomId, message, userId, userName, options = {}) => {
  if (!socket) {
    initializeSocket();
  }

  if (!socket || !socket.connected) {
    console.error('[chat] socket is not connected; cannot emit message');
    return null;
  }

  const messageType = options.messageType === 'code' ? 'code' : 'text';
  const rawCodeSnippet = options.codeSnippet || null;
  const codeSnippet = messageType === 'code' && rawCodeSnippet && typeof rawCodeSnippet.code === 'string'
    ? {
        language: String(rawCodeSnippet.language || '').trim().toLowerCase(),
        code: String(rawCodeSnippet.code || ''),
      }
    : null;

  const payload = {
    roomId: String(roomId || ''),
    senderId: String(userId || ''),
    senderName: String(userName || 'Anonymous'),
    text: String(message || ''),
    message: String(message || ''),
    userId: String(userId || ''),
    userName: String(userName || 'Anonymous'),
    messageType,
    codeSnippet,
    attachment: options.attachment || null,
    clientMessageId: options.clientMessageId || `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    socketId: socket.id,
    timestamp: Date.now(),
  };

  socket.emit('send_message', payload);
  return payload.clientMessageId;
};

export const emitChatTyping = (roomId, userName) => {
  if (socket && socket.connected) {
    const payload = {
      roomId: String(roomId || ''),
      userName: String(userName || 'Anonymous'),
      socketId: socket.id,
      timestamp: Date.now(),
    };

    console.log('[socket emit] typing', payload);
    socket.emit('typing', payload);
  }
};

export const emitChatStopTyping = (roomId, userName) => {
  if (socket && socket.connected) {
    const payload = {
      roomId: String(roomId || ''),
      userName: String(userName || 'Anonymous'),
      socketId: socket.id,
      timestamp: Date.now(),
    };

    console.log('[socket emit] stop-typing', payload);
    socket.emit('stop-typing', payload);
  }
};

export const emitChatDelivered = (roomId, messageId) => {
  if (socket && socket.connected) {
    socket.emit('chat-message-delivered', {
      roomId: String(roomId || ''),
      messageId: String(messageId || ''),
      socketId: socket.id,
      timestamp: Date.now(),
    });
  }
};

export const emitChatSeen = (roomId, messageId) => {
  if (socket && socket.connected) {
    socket.emit('chat-message-seen', {
      roomId: String(roomId || ''),
      messageId: String(messageId || ''),
      socketId: socket.id,
      timestamp: Date.now(),
    });
  }
};

export const emitRoomRoleChange = (userId, role) => {
  if (socket && socket.connected) {
    socket.emit('role-change', {
      userId,
      role,
      socketId: socket.id,
      timestamp: Date.now(),
    });
  }
};
