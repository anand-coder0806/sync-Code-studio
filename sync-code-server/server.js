const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const connectDB = require('./config/db');
const User = require('./models/User');
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes');
const codeRoutes = require('./routes/codeRoutes');
const runRoutes = require('./routes/runRoutes');
const terminalRoutes = require('./routes/terminalRoutes');
const testRoutes = require('./routes/testRoutes');
const systemRoutes = require('./routes/systemRoutes');
const chatbotRoutes = require('./routes/chatbotRoutes');
const { generateAssistantReply } = require('./controllers/chatbotController');
const ChatMessage = require('./models/ChatMessage');
const errorHandler = require('./middleware/errorHandler');
const { blockWriteOperationsInReadOnlyMode } = require('./middleware/readOnlyMode');
const { runCodeWithStreaming } = require('./services/streamingCodeRunner');
const {
  buildTerminalSessionKey,
  executeTerminalCommandInSession,
  addTerminalParticipant,
  removeTerminalParticipantBySocket,
} = require('./services/terminalSessionService');

const app = express();
const uploadsRoot = path.join(__dirname, 'uploads');
const chatUploadsRoot = path.join(uploadsRoot, 'chat');

fs.mkdirSync(chatUploadsRoot, { recursive: true });

const getRequiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not defined in environment variables`);
  }
  return value;
};

const buildCorsOptions = () => {
  const corsOrigin = process.env.CORS_ORIGIN;

  if (!corsOrigin || process.env.NODE_ENV !== 'production') {
    return {};
  }

  const allowedOrigins = corsOrigin.split(',').map((origin) => origin.trim());

  return {
    origin: allowedOrigins,
  };
};

const CHAT_MESSAGE_LIMIT = 2000;
const CHAT_CODE_LIMIT = 10000;
const CHAT_ATTACHMENT_LIMIT_BYTES = 5 * 1024 * 1024;
const CHAT_MESSAGE_RATE_LIMIT_WINDOW_MS = 12000;
const CHAT_MESSAGE_RATE_LIMIT_MAX = 8;

const sanitizeChatText = (value) => String(value || '')
  .replace(/\u0000/g, '')
  .replace(/[\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .trim();

const sanitizeChatCode = (value) => String(value || '')
  .replace(/\u0000/g, '')
  .replace(/[\u0008\u000B\u000C\u000E-\u001F]/g, '');

const normalizeSnippetLanguage = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'plaintext';

  if (['js', 'jsx', 'javascript', 'mjs', 'cjs'].includes(normalized)) return 'javascript';
  if (['py', 'python'].includes(normalized)) return 'python';
  if (['java'].includes(normalized)) return 'java';
  if (['c++', 'cpp', 'cc', 'cxx', 'hpp', 'h++'].includes(normalized)) return 'cpp';
  return normalized.slice(0, 24);
};

const sanitizeFileName = (value) => String(value || 'attachment')
  .replace(/[^a-zA-Z0-9._-]/g, '_')
  .replace(/_+/g, '_')
  .slice(0, 120) || 'attachment';

const getRoomChatUploadDir = (roomId) => {
  const safeRoomId = sanitizeFileName(roomId || 'room');
  const dir = path.join(chatUploadsRoot, safeRoomId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const parseDataUrl = (dataUrl) => {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(String(dataUrl || '').trim());
  if (!match) {
    return null;
  }

  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  return { mimeType, buffer };
};

const isImageMimeType = (mimeType) => /^image\//i.test(String(mimeType || ''));

const createChatUploadUrl = (roomId, fileName) => {
  const safeRoomId = sanitizeFileName(roomId || 'room');
  return `/uploads/chat/${safeRoomId}/${fileName}`;
};

const extractSingleFencedSnippet = (value = '') => {
  const match = /^```([a-zA-Z0-9_+#-]*)\n?([\s\S]*?)```$/m.exec(String(value || '').trim());
  if (!match) {
    return null;
  }

  const code = String(match[2] || '').replace(/\n$/, '');
  if (!code.trim()) {
    return null;
  }

  return {
    language: normalizeSnippetLanguage(match[1] || 'plaintext'),
    code,
  };
};

// Middleware
app.use(cors(buildCorsOptions()));
app.use(express.json());
app.use('/uploads', express.static(uploadsRoot));

// Root route
app.get('/', (req, res) => {
  res.send('SyncCode API Running');
});

// Health route used by frontend connectivity checks
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Backend is reachable',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'degraded',
  });
});

// Read-only mode status and control routes.
app.use('/api/system', systemRoutes);

// Apply global write guard after public status routes and before API handlers.
app.use('/api', blockWriteOperationsInReadOnlyMode);

// Gate database-dependent APIs when DB is unavailable.
app.use('/api/auth', (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      error: 'Database unavailable. Check MongoDB URI or Atlas IP whitelist.',
    });
  }
  return next();
});

app.use('/api/projects', (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      error: 'Database unavailable. Check MongoDB URI or Atlas IP whitelist.',
    });
  }
  return next();
});

app.use('/api/code', (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      error: 'Database unavailable. Check MongoDB URI or Atlas IP whitelist.',
    });
  }
  return next();
});

// Test routes
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/test', testRoutes);
}

// Auth routes
app.use('/api/auth', authRoutes);

// Project and file routes
app.use('/api/projects', projectRoutes);
app.use('/api/code', codeRoutes);
app.use('/api/run-code', runRoutes);
app.use('/api/terminal', terminalRoutes);
app.use('/api/chatbot', chatbotRoutes);

// Fallback for unknown routes
app.use((req, res) => {
  res.status(404).json({ success: false, error: { status: 404, message: 'Route not found' } });
});

// Global error formatter
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
let httpServer;
let isShuttingDown = false;
let databaseReady = false;

const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received. Starting graceful shutdown...`);

  try {
    if (httpServer && typeof httpServer.close === 'function') {
      await new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') return reject(error);
          resolve();
        });
      });
      console.log('HTTP server closed');
    }

    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
      console.log('MongoDB connection closed');
    }

    process.exit(0);
  } catch (error) {
    console.error('Graceful shutdown failed:', error.message);
    process.exit(1);
  }
};

const startServer = async () => {
  try {
    getRequiredEnv('JWT_SECRET');

    if (!process.env.MONGO_URI && !process.env.MONGODB_URI) {
      throw new Error('MONGO_URI or MONGODB_URI is not defined in environment variables');
    }

    try {
      await connectDB();
      databaseReady = true;
    } catch (dbError) {
      databaseReady = false;
      if (process.env.NODE_ENV === 'production') {
        throw dbError;
      }
      console.warn('Starting server in degraded mode (database unavailable).');
      console.warn(dbError.message);
    }

    httpServer = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      if (!databaseReady) {
        console.log('API mode: degraded (database unavailable)');
      }
    });

    // Initialize Socket.io with CORS configuration
    const io = new Server(httpServer, {
      cors: buildCorsOptions(),
    });

    io.use(async (socket, next) => {
      try {
        if (!process.env.JWT_SECRET) {
          return next(new Error('JWT secret is not configured'));
        }

        const token = socket.handshake.auth?.token;
        if (!token) {
          return next(new Error('Authorization token missing'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId).select('_id role name email');
        if (!user) {
          return next(new Error('Invalid user for token'));
        }

        socket.authUser = {
          userId: String(user._id),
          role: user.role || 'writer',
          name: user.name || 'Collaborator',
          email: user.email || '',
        };
        return next();
      } catch (error) {
        return next(new Error('Invalid or expired token'));
      }
    });

    // Store active rooms and their users
    const activeRooms = new Map();
    const roomCodeStates = new Map();
    const roomPresenceStates = new Map();
    const roomRoleStates = new Map();
    const roomHostStates = new Map();
    const roomChatTypingStates = new Map();
    const roomCallStates = new Map();
    const roomPendingChanges = new Map();
    const roomAppliedChanges = new Map();
    const pendingRequests = roomPendingChanges;
    const socketRoomMap = new Map();
    const MAX_ROOM_EDITORS = 3;

    const normalizeFileKey = (fileKey) => String(fileKey || '__default__');
    const getFileSyncChannel = (roomId, fileId) => `${String(roomId || '')}-${normalizeFileKey(fileId)}`;

    const syncSocketFileChannel = (socket, roomId, fileId) => {
      if (!roomId) {
        return null;
      }

      const nextChannel = getFileSyncChannel(roomId, fileId);
      if (socket.currentFileSyncChannel && socket.currentFileSyncChannel !== nextChannel) {
        socket.leave(socket.currentFileSyncChannel);
      }

      socket.join(nextChannel);
      socket.currentFileSyncChannel = nextChannel;
      socket.currentFileId = normalizeFileKey(fileId);
      return nextChannel;
    };

    const ensureRoomChatTypingState = (roomId) => {
      if (!roomChatTypingStates.has(roomId)) {
        roomChatTypingStates.set(roomId, new Map());
      }

      return roomChatTypingStates.get(roomId);
    };

    const clearRoomChatTypingState = (roomId, socketId) => {
      if (!roomChatTypingStates.has(roomId)) {
        return [];
      }

      const typingState = roomChatTypingStates.get(roomId);
      typingState.delete(socketId);
      return Array.from(typingState.values());
    };

    const buildChatHistoryPayload = (entries = []) => entries.map((entry) => ({
      id: entry._id,
      roomId: entry.roomId,
      senderId: entry.senderId || null,
      sender: entry.sender,
      isAssistant: Boolean(entry.isAssistant),
      message: entry.message,
      messageType: entry.messageType || 'text',
      codeSnippet: entry.codeSnippet || null,
      status: entry.status,
      deliveredBy: Array.isArray(entry.deliveredBy) ? entry.deliveredBy : [],
      seenBy: Array.isArray(entry.seenBy) ? entry.seenBy : [],
      deliveredAt: entry.deliveredAt || null,
      seenAt: entry.seenAt || null,
      attachment: entry.attachment || null,
      reactions: Array.isArray(entry.reactions) ? entry.reactions : [],
      editedAt: entry.editedAt || null,
      isDeleted: Boolean(entry.isDeleted),
      timestamp: entry.createdAt,
      socketId: entry.socketId || '',
    }));

    const ensureRoomCallState = (roomId) => {
      if (!roomCallStates.has(roomId)) {
        roomCallStates.set(roomId, new Map());
      }
      return roomCallStates.get(roomId);
    };

    const removeCallParticipant = (roomId, socketId) => {
      if (!roomCallStates.has(roomId)) {
        return;
      }

      const callState = roomCallStates.get(roomId);
      callState.delete(socketId);
      if (callState.size === 0) {
        roomCallStates.delete(roomId);
      }
    };

    const broadcastRoomCallState = (roomId) => {
      if (!roomId) {
        return;
      }

      const participants = Array.from((roomCallStates.get(roomId) || new Map()).values());
      io.to(roomId).emit('room-call-state', {
        roomId,
        participants,
        timestamp: Date.now(),
      });
    };

    const getSocketRoomId = (socket) => socketRoomMap.get(socket.id) || socket.currentRoom || null;

    const isSocketInRoom = (socketId, roomId) => {
      if (!socketId || !roomId) {
        return false;
      }

      const targetSocket = io.sockets.sockets.get(socketId);
      return Boolean(targetSocket && targetSocket.rooms && targetSocket.rooms.has(roomId));
    };

    const emitToRoomUser = (roomId, targetUserId, eventName, payload) => {
      if (!roomId || !targetUserId) {
        return;
      }

      const members = activeRooms.get(roomId) || [];
      members
        .filter((member) => String(member.userId || '') === String(targetUserId || ''))
        .forEach((member) => {
          if (member.socketId && isSocketInRoom(member.socketId, roomId)) {
            io.to(member.socketId).emit(eventName, payload);
          }
        });
    };

    const emitToRoomOwner = (roomId, eventName, payload) => {
      const ownerUserId = getRoomHostId(roomId);
      if (!ownerUserId) {
        return;
      }

      emitToRoomUser(roomId, ownerUserId, eventName, payload);
    };

    const getManagerSocket = (roomId) => {
      if (!activeRooms.has(roomId)) {
        return null;
      }

      const roomMembers = activeRooms.get(roomId) || [];
      const managerUserId = getRoomHostId(roomId);

      if (managerUserId) {
        const managerMember = roomMembers.find((member) => String(member.userId || '') === String(managerUserId) && member.socketId);
        if (managerMember?.socketId) {
          return managerMember.socketId;
        }
      }

      const adminMember = roomMembers.find((member) => {
        if (!member.socketId) {
          return false;
        }

        const memberSocket = io.sockets.sockets.get(member.socketId);
        return String(memberSocket?.authUser?.role || '').toLowerCase() === 'admin';
      });

      return adminMember?.socketId || null;
    };

    const normalizeRoomRole = (role) => (String(role || '').toLowerCase() === 'editor' ? 'editor' : 'viewer');

    const ensureRoomRoleState = (roomId) => {
      if (!roomRoleStates.has(roomId)) {
        roomRoleStates.set(roomId, new Map());
      }
      return roomRoleStates.get(roomId);
    };

    const getRoomHostId = (roomId) => roomHostStates.get(roomId) || null;

    const setRoomHostId = (roomId, userId) => {
      if (roomId && userId) {
        roomHostStates.set(roomId, String(userId));
      }
    };

    const getRoomUserRole = (roomId, userId) => {
      if (!roomId || !userId) {
        return 'viewer';
      }

      const roleState = roomRoleStates.get(roomId);
      return normalizeRoomRole(roleState?.get(String(userId)) || 'viewer');
    };

    const countRoomEditors = (roomId) => {
      const roleState = roomRoleStates.get(roomId);
      if (!roleState) {
        return 0;
      }

      let editorCount = 0;
      roleState.forEach((role) => {
        if (normalizeRoomRole(role) === 'editor') {
          editorCount += 1;
        }
      });
      return editorCount;
    };

    const syncRoomMemberRoles = (roomId) => {
      if (!activeRooms.has(roomId)) {
        return;
      }

      const roleState = ensureRoomRoleState(roomId);
      const members = activeRooms.get(roomId).map((member) => ({
        ...member,
        role: normalizeRoomRole(roleState.get(String(member.userId)) || member.role || 'viewer'),
      }));

      activeRooms.set(roomId, members);
    };

    const ensureRoomHasEditor = (roomId) => {
      if (!activeRooms.has(roomId)) {
        return;
      }

      syncRoomMemberRoles(roomId);

      if (countRoomEditors(roomId) > 0) {
        return;
      }

      const members = activeRooms.get(roomId);
      const fallback = members.find((member) => member.userId) || null;
      if (!fallback) {
        return;
      }

      const roleState = ensureRoomRoleState(roomId);
      roleState.set(String(fallback.userId), 'editor');
      syncRoomMemberRoles(roomId);
    };

    const assignRoomRoleForJoin = (roomId, user) => {
      const roleState = ensureRoomRoleState(roomId);
      const userId = String(user.userId);
      const existingRoleRaw = roleState.get(userId);
      const existingRole = typeof existingRoleRaw === 'string'
        ? normalizeRoomRole(existingRoleRaw)
        : null;

      if (existingRole === 'editor' || existingRole === 'viewer') {
        return existingRole;
      }

      if (String(user.role || '').toLowerCase() === 'admin') {
        roleState.set(userId, 'editor');
        return 'editor';
      }

      const editorCount = countRoomEditors(roomId);
      const nextRole = editorCount < MAX_ROOM_EDITORS ? 'editor' : 'viewer';
      roleState.set(userId, nextRole);
      return nextRole;
    };

    const canManageRoomRoles = (socket, roomId) => {
      if (!roomId || !socket?.userId) {
        return false;
      }

      if (String(socket.authUser?.role || '').toLowerCase() === 'admin') {
        return true;
      }

      return getRoomHostId(roomId) === String(socket.userId);
    };

    const getRoomEditorCountAfterChange = (roomId, targetUserId, nextRole) => {
      const roleState = ensureRoomRoleState(roomId);
      const currentRole = normalizeRoomRole(roleState.get(String(targetUserId)));
      let editorCount = countRoomEditors(roomId);

      if (currentRole === 'editor') {
        editorCount -= 1;
      }

      if (normalizeRoomRole(nextRole) === 'editor') {
        editorCount += 1;
      }

      return editorCount;
    };

    const emitRoomRoleState = (roomId) => {
      if (!activeRooms.has(roomId)) {
        return;
      }

      const roomPresence = ensureRoomPresenceState(roomId);
      const hostUserId = getRoomHostId(roomId);

      activeRooms.get(roomId).forEach((member) => {
        upsertPresenceOnline(roomId, {
          userId: member.userId,
          userName: member.userName,
          socketId: member.socketId,
          fileKey: roomPresence.get(member.userId)?.activeFileKey,
          role: member.role,
        });
      });

      emitRoomPresence(roomId);
      io.to(roomId).emit('room-role-updated', {
        roomId,
        hostUserId,
        usersInRoom: Array.from((roomPresenceStates.get(roomId) || new Map()).values())
          .map((user) => ({
            userId: user.userId,
            userName: user.userName,
            online: Boolean(user.online),
            status: user.online ? 'online' : 'offline',
            activeFileKey: normalizeFileKey(user.activeFileKey),
            lastSeenAt: user.lastSeenAt || null,
            role: getRoomUserRole(roomId, user.userId),
          })),
      });
    };

    const ensureRoomPresenceState = (roomId) => {
      if (!roomPresenceStates.has(roomId)) {
        roomPresenceStates.set(roomId, new Map());
      }
      return roomPresenceStates.get(roomId);
    };

    const upsertPresenceOnline = (roomId, { userId, userName, socketId, fileKey, role }) => {
      if (!roomId || !userId) {
        return;
      }

      const roomPresence = ensureRoomPresenceState(roomId);
      const previous = roomPresence.get(userId) || {};
      roomPresence.set(userId, {
        userId,
        userName: userName || previous.userName || 'Collaborator',
        socketId,
        online: true,
        status: 'online',
        activeFileKey: normalizeFileKey(fileKey || previous.activeFileKey),
        role: normalizeRoomRole(role || previous.role || 'viewer'),
        lastSeenAt: null,
      });
    };

    const markPresenceOffline = (roomId, { userId, userName }) => {
      if (!roomId || !userId) {
        return;
      }

      const roomPresence = ensureRoomPresenceState(roomId);
      const previous = roomPresence.get(userId) || {};
      roomPresence.set(userId, {
        userId,
        userName: userName || previous.userName || 'Collaborator',
        socketId: null,
        online: false,
        status: 'offline',
        activeFileKey: normalizeFileKey(previous.activeFileKey),
        role: normalizeRoomRole(previous.role || 'viewer'),
        lastSeenAt: new Date().toISOString(),
      });
    };

    const updatePresenceFileKey = (roomId, userId, userName, fileKey) => {
      if (!roomId || !userId) {
        return false;
      }

      const roomPresence = ensureRoomPresenceState(roomId);
      const previous = roomPresence.get(userId) || {
        userId,
        userName: userName || 'Collaborator',
        online: true,
        status: 'online',
        socketId: null,
        role: 'viewer',
        lastSeenAt: null,
      };
      const normalizedFileKey = normalizeFileKey(fileKey);

      if (previous.activeFileKey === normalizedFileKey) {
        return false;
      }

      roomPresence.set(userId, {
        ...previous,
        userName: userName || previous.userName,
        activeFileKey: normalizedFileKey,
      });
      return true;
    };

    const emitRoomPresence = (roomId) => {
      const room = activeRooms.get(roomId) || [];
      const roomPresence = ensureRoomPresenceState(roomId);

      room.forEach((member) => {
        upsertPresenceOnline(roomId, {
          userId: member.userId,
          userName: member.userName,
          socketId: member.socketId,
          fileKey: roomPresence.get(member.userId)?.activeFileKey,
        });
      });

      const usersInRoom = Array.from(roomPresence.values())
        .sort((a, b) => {
          if (a.online !== b.online) {
            return a.online ? -1 : 1;
          }
          return String(a.userName).localeCompare(String(b.userName));
        })
        .map((user) => ({
          userId: user.userId,
          userName: user.userName,
          online: Boolean(user.online),
          status: user.online ? 'online' : 'offline',
          activeFileKey: normalizeFileKey(user.activeFileKey),
          role: getRoomUserRole(roomId, user.userId),
          lastSeenAt: user.lastSeenAt || null,
        }));

      io.to(roomId).emit('presence-updated', {
        roomId,
        usersInRoom,
        userCount: usersInRoom.length,
        onlineCount: room.length,
      });
    };

    const rememberRoomCodeState = ({ roomId, fileKey, code, language, userId, userName }) => {
      if (!roomId || typeof code !== 'string') {
        return;
      }

      const resolvedFileKey = String(fileKey || '__default__');
      if (!roomCodeStates.has(roomId)) {
        roomCodeStates.set(roomId, new Map());
      }

      const roomState = roomCodeStates.get(roomId);
      const previousState = roomState.get(resolvedFileKey);
      const nextRevision = (previousState?.revision || 0) + 1;

      roomState.set(resolvedFileKey, {
        fileKey: resolvedFileKey,
        code,
        language: language || 'javascript',
        userId,
        userName,
        revision: nextRevision,
        timestamp: new Date().getTime(),
      });

      return roomState.get(resolvedFileKey);
    };

    const getRoomFileChangeList = (store, roomId, fileKey) => {
      if (!store.has(roomId)) {
        store.set(roomId, new Map());
      }

      const roomStore = store.get(roomId);
      if (!roomStore.has(fileKey)) {
        roomStore.set(fileKey, []);
      }

      return roomStore.get(fileKey);
    };

    const clearRoomChangeState = (roomId) => {
      roomPendingChanges.delete(roomId);
      roomAppliedChanges.delete(roomId);
    };

    const makeChangeId = () => `chg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const normalizeRange = ({ startLine, endLine, startColumn, endColumn }) => {
      const normalizedStartLine = Math.max(1, Number(startLine) || 1);
      const normalizedEndLine = Math.max(normalizedStartLine, Number(endLine) || normalizedStartLine);
      const normalizedStartColumn = Math.max(1, Number(startColumn) || 1);
      const normalizedEndColumn = Math.max(1, Number(endColumn) || normalizedStartColumn);

      return {
        startLine: normalizedStartLine,
        endLine: normalizedEndLine,
        startColumn: normalizedStartColumn,
        endColumn: normalizedEndColumn,
      };
    };

    const rangesOverlap = (a, b) => {
      const left = Math.max(Number(a.startLine) || 1, Number(b.startLine) || 1);
      const aEnd = Number(a.endLine) || left;
      const bEnd = Number(b.endLine) || left;
      const right = Math.min(aEnd, bEnd);
      return left <= right;
    };

    // Socket.io connection handler
    io.on('connection', (socket) => {
      console.log(`User connected: ${socket.id}`);
      console.log('CONNECTED:', socket.id);

      // Handle room join
      const handleJoinRoom = async (data = {}) => {
        const { roomId, fileId, fileKey, code, language } = data;
        const userId = socket.authUser?.userId || socket.userId;
        const userName = socket.authUser?.name || socket.userName;
        const normalizedFileId = normalizeFileKey(fileId || fileKey);

        if (!roomId || !userId) {
          socket.emit('error', 'Room ID and User ID are required');
          return;
        }

        // Leave any previously joined room
        const previousRooms = Array.from(socket.rooms).filter(room => room !== socket.id);
        previousRooms.forEach((room) => {
          socket.leave(room);
          removeCallParticipant(room, socket.id);
          socket.to(room).emit('webrtc-peer-left', {
            roomId: room,
            socketId: socket.id,
            userId: socket.userId || userId,
            userName: socket.userName || userName,
            timestamp: Date.now(),
          });
          broadcastRoomCallState(room);

          if (activeRooms.has(room)) {
            const existing = activeRooms.get(room).filter((member) => member.socketId !== socket.id);
            activeRooms.set(room, existing);
            markPresenceOffline(room, {
              userId: socket.userId || userId,
              userName: socket.userName || userName,
            });

            if (existing.length === 0) {
              activeRooms.delete(room);
              roomCodeStates.delete(room);
              roomPresenceStates.delete(room);
              roomCallStates.delete(room);
              clearRoomChangeState(room);
            } else {
              io.to(room).emit('user-left', {
                userId: socket.userId || userId,
                userName: socket.userName || userName,
              });
              io.to(room).emit('typing-status', {
                userId: socket.userId || userId,
                userName: socket.userName || userName,
                isTyping: false,
                timestamp: new Date().getTime(),
              });
              emitRoomPresence(room);
            }
          }

          console.log(`User ${userId} left room ${room}`);
        });

        // Join the new room
        socket.join(roomId);
        syncSocketFileChannel(socket, roomId, normalizedFileId);

        // Store user info in socket for later use
        socket.userId = userId;
        socket.userName = userName;
        socket.userRole = socket.authUser?.role || 'viewer';
        socket.currentRoom = roomId;
        socketRoomMap.set(socket.id, roomId);

        // Update active rooms
        if (!activeRooms.has(roomId)) {
          activeRooms.set(roomId, []);
        }
        if (!roomHostStates.has(roomId)) {
          setRoomHostId(roomId, userId);
        }

        const assignedRole = assignRoomRoleForJoin(roomId, {
          userId,
          role: socket.authUser?.role,
        });

        const room = activeRooms.get(roomId);
        const deduped = room.filter((member) => member.userId !== userId);
        deduped.push({ socketId: socket.id, userId, userName, role: assignedRole });
        activeRooms.set(roomId, deduped);
        upsertPresenceOnline(roomId, { userId, userName, socketId: socket.id, fileKey: normalizedFileId, role: assignedRole });

        ensureRoomHasEditor(roomId);
        syncRoomMemberRoles(roomId);

        // Get all users in the room
        const usersInRoom = deduped.map(user => ({
          userId: user.userId,
          userName: user.userName,
          role: getRoomUserRole(roomId, user.userId),
        }));

        // Notify all users in the room about the new user
        io.to(roomId).emit('user-joined', { userId, userName, usersInRoom });
        emitRoomPresence(roomId);
        socket.emit('room-joined', {
          roomId,
          userId,
          userName,
          role: assignedRole,
          hostUserId: getRoomHostId(roomId),
          usersInRoom: Array.from((roomPresenceStates.get(roomId) || new Map()).values()).map((member) => ({
            userId: member.userId,
            userName: member.userName,
            online: Boolean(member.online),
            status: member.online ? 'online' : 'offline',
            activeFileKey: normalizeFileKey(member.activeFileKey),
            role: getRoomUserRole(roomId, member.userId),
            lastSeenAt: member.lastSeenAt || null,
          })),
        });

        try {
          await emitChatHistory(roomId, socket);
        } catch (error) {
          console.error(`[chat] Failed to load history for room ${roomId}:`, error.message);
          socket.emit('chat-history', { roomId, messages: [] });
        }

        if (typeof code === 'string' && code.length > 0) {
          rememberRoomCodeState({ roomId, fileKey: normalizedFileId, code, language, userId, userName });
        }

        const roomState = roomCodeStates.get(roomId);
        if (roomState && roomState.size > 0) {
          const preferredFileKey = normalizedFileId;
          const preferredState = roomState.get(preferredFileKey);

          if (preferredState) {
            socket.emit('sync-code', preferredState);
          } else {
            roomState.forEach((state) => {
              socket.emit('sync-code', state);
            });
          }
        }

        const pendingForFile = getRoomFileChangeList(roomPendingChanges, roomId, normalizedFileId)
          .filter((change) => change.status === 'pending');
        socket.emit('pending_changes_snapshot', {
          roomId,
          fileId: normalizedFileId,
          fileKey: normalizedFileId,
          pendingChanges: pendingForFile,
          timestamp: Date.now(),
        });

        console.log(`User ${userId} (${socket.id}) joined room ${roomId}. Users in room: ${usersInRoom.length}`);
        console.log('JOINED ROOM:', roomId, { socketId: socket.id, userId, userName });
      };

      socket.on('join-room', (data = {}) => handleJoinRoom(data));
      socket.on('join_room', (data = {}) => {
        if (typeof data === 'string') {
          handleJoinRoom({ roomId: data });
          return;
        }
        handleJoinRoom(data || {});
      });

      // Handle room leave
      socket.on('leave-room', (data) => {
        const { roomId } = data;
        const userId = socket.userId;
        const userName = socket.userName;

        if (roomId && socket.rooms.has(roomId)) {
          socket.leave(roomId);
          if (socket.currentFileSyncChannel) {
            socket.leave(socket.currentFileSyncChannel);
            socket.currentFileSyncChannel = null;
            socket.currentFileId = null;
          }

          removeCallParticipant(roomId, socket.id);
          socket.to(roomId).emit('webrtc-peer-left', {
            roomId,
            socketId: socket.id,
            userId,
            userName,
            timestamp: Date.now(),
          });
          broadcastRoomCallState(roomId);

          if (socket.chatTypingActive) {
            socket.to(roomId).emit('stop-typing', socket.userName);
            socket.chatTypingActive = false;
          }

          clearRoomChatTypingState(roomId, socket.id);

          // Update active rooms
          if (activeRooms.has(roomId)) {
            const room = activeRooms.get(roomId);
            activeRooms.set(roomId, room.filter(user => user.socketId !== socket.id));
            markPresenceOffline(roomId, { userId, userName });
            ensureRoomHasEditor(roomId);

            // If room is empty, delete it
            if (activeRooms.get(roomId).length === 0) {
              activeRooms.delete(roomId);
              roomCodeStates.delete(roomId);
              roomPresenceStates.delete(roomId);
              roomRoleStates.delete(roomId);
              roomHostStates.delete(roomId);
              roomChatTypingStates.delete(roomId);
              roomCallStates.delete(roomId);
              clearRoomChangeState(roomId);
              console.log(`Room ${roomId} deleted as it's now empty`);
            }
          }

          // Notify remaining users in the room
          io.to(roomId).emit('user-left', { userId, userName });
          io.to(roomId).emit('typing-status', { userId, userName, isTyping: false, timestamp: new Date().getTime() });
          emitRoomPresence(roomId);
          emitRoomRoleState(roomId);
          console.log(`User ${userId} left room ${roomId}`);

          if (getSocketRoomId(socket) === roomId) {
            socket.currentRoom = null;
            socketRoomMap.delete(socket.id);
          }
        }
      });

      // Handle get active rooms
      socket.on('get-rooms', (callback) => {
        const rooms = Array.from(activeRooms.entries()).map(([roomId, users]) => ({
          roomId,
          userCount: users.length,
          users: users.map(u => ({ userId: u.userId, userName: u.userName }))
        }));
        callback(rooms);
      });

      // Handle get room info
      socket.on('get-room-info', (roomId, callback) => {
        if (activeRooms.has(roomId)) {
          const room = activeRooms.get(roomId);
          const roomInfo = {
            roomId,
            userCount: room.length,
            users: room.map(u => ({ userId: u.userId, userName: u.userName }))
          };
          callback(roomInfo);
        } else {
          callback(null);
        }
      });

      const handleCodeTyping = (data = {}) => {
        const {
          code,
          language,
          fileId,
          fileKey,
        } = data;

        const roomId = socket.currentRoom;
        const userId = socket.userId;
        const userName = socket.userName;
        const memberRole = getRoomUserRole(roomId, userId);
        const roomOwnerId = getRoomHostId(roomId);
        const declaredRole = String(data.role || memberRole || '').toLowerCase();
        const bypassOwnerGuard = Boolean(data.bypassOwnerGuard);
        const rawFileId = String(fileId || fileKey || '').trim();
        const normalizedFileId = normalizeFileKey(rawFileId);

        if (!roomId || !rawFileId || typeof code !== 'string') {
          return;
        }

        if (memberRole !== 'editor' || String(userId || '') !== String(roomOwnerId || '')) {
          socket.emit('role-denied', {
            roomId,
            userId,
            role: memberRole,
            reason: 'Only the room owner can send direct live preview updates.',
          });
          return;
        }

        syncSocketFileChannel(socket, roomId, normalizedFileId);
        if (updatePresenceFileKey(roomId, userId || socket.userId, socket.userName, normalizedFileId)) {
          emitRoomPresence(roomId);
        }

        socket.to(roomId).emit('code_preview', {
          code,
          language: language || 'javascript',
          userId,
          userName,
          roomId,
          fileId: normalizedFileId,
          fileKey: normalizedFileId,
          source: 'code_typing',
          socketId: socket.id,
          timestamp: Date.now(),
        });
      };

      const handleCodeCommit = (data = {}) => {
        const {
          code,
          language,
          fileId,
          fileKey,
        } = data;

        const roomId = socket.currentRoom;
        const userId = socket.userId;
        const userName = socket.userName;
        const memberRole = getRoomUserRole(roomId, userId);
        const roomOwnerId = getRoomHostId(roomId);
        const bypassOwnerGuard = Boolean(data.bypassOwnerGuard);
        const declaredRole = String(data.role || memberRole || '').toLowerCase();
        const rawFileId = String(fileId || fileKey || '').trim();
        const normalizedFileId = normalizeFileKey(rawFileId);

        if (!roomId || !rawFileId || typeof code !== 'string') {
          return;
        }

        if (memberRole !== 'editor' || String(userId || '') !== String(roomOwnerId || '')) {
          socket.emit('role-denied', {
            roomId,
            userId,
            role: memberRole,
            reason: 'Only the room owner can commit saved code updates.',
          });
          return;
        }

        syncSocketFileChannel(socket, roomId, normalizedFileId);
        if (updatePresenceFileKey(roomId, userId || socket.userId, socket.userName, normalizedFileId)) {
          emitRoomPresence(roomId);
        }

        const nextState = rememberRoomCodeState({
          roomId,
          fileKey: normalizedFileId,
          code,
          language,
          userId,
          userName,
        });

        const payload = {
          code: nextState.code,
          language: nextState.language,
          userId,
          userName,
          fileId: normalizedFileId,
          fileKey: normalizedFileId,
          roomId,
          source: 'code_commit',
          revision: nextState.revision,
          socketId: socket.id,
          timestamp: Date.now(),
        };

        io.to(roomId).emit('code_updated', payload);
        io.to(roomId).emit('code-update', payload);
      };

      const handleCodeRun = (data = {}) => {
        const {
          code,
          language,
          fileId,
          fileKey,
          role,
        } = data;

        const roomId = socket.currentRoom;
        const userId = socket.userId;
        const userName = socket.userName;
        const memberRole = getRoomUserRole(roomId, userId);
        const roomOwnerId = getRoomHostId(roomId);
        const bypassOwnerGuard = Boolean(data.bypassOwnerGuard);
        const declaredRole = String(data.role || memberRole || '').toLowerCase();
        const rawFileId = String(fileId || fileKey || '').trim();
        const normalizedFileId = normalizeFileKey(rawFileId);

        if (!roomId || !rawFileId || typeof code !== 'string') {
          return;
        }

        if (memberRole !== 'editor') {
          socket.emit('role-denied', {
            roomId,
            userId,
            role: memberRole,
            reason: 'Only collaborators with write access can send run snapshots.',
          });
          return;
        }

        if (String(userId || '') === String(roomOwnerId || '')) {
          return;
        }

        syncSocketFileChannel(socket, roomId, normalizedFileId);
        if (updatePresenceFileKey(roomId, userId || socket.userId, socket.userName, normalizedFileId)) {
          emitRoomPresence(roomId);
        }

        emitToRoomOwner(roomId, 'receive-code-run', {
          roomId,
          fileId: normalizedFileId,
          fileKey: normalizedFileId,
          code,
          language: language || 'javascript',
          userId,
          userName,
          role: String(role || memberRole || ''),
          source: 'code-run',
          socketId: socket.id,
          timestamp: Date.now(),
        });
      };

      const handleCodeRequest = (data = {}) => {
        const {
          code,
          previousCode,
          language,
          fileId,
          fileKey,
          startLine,
          endLine,
          startColumn,
          endColumn,
        } = data;

        const roomId = socket.currentRoom;
        const userId = socket.userId;
        const userName = socket.userName;
        const memberRole = getRoomUserRole(roomId, userId);
        const roomOwnerId = getRoomHostId(roomId);
        const bypassOwnerGuard = Boolean(data.bypassOwnerGuard);
        const declaredRole = String(data.role || memberRole || '').toLowerCase();
        const rawFileId = String(fileId || fileKey || '').trim();
        const normalizedFileId = normalizeFileKey(rawFileId);
        try {

        console.log('[suggest-code] Backend received suggest-code', {
          roomId,
          fileId: normalizedFileId,
          userId,
          socketId: socket.id,
          startLine,
          endLine,
          startColumn,
          endColumn,
          codeLength: String(code || '').length,
        });

        if (!roomId || !rawFileId) {
          return;
        }

        if (!bypassOwnerGuard && (declaredRole === 'manager' || String(userId || '') === String(roomOwnerId || ''))) {
          socket.emit('role-denied', {
            roomId,
            userId,
            role: memberRole,
            reason: 'Managers cannot send suggestions.',
          });
          return;
        }

        if (memberRole !== 'editor') {
          socket.emit('role-denied', {
            roomId,
            userId,
            role: memberRole,
            reason: 'Only collaborators with write access can send code requests.',
          });
          return;
        }

        if (!bypassOwnerGuard && String(userId || '') === String(roomOwnerId || '')) {
          return;
        }

        if (typeof code !== 'string') {
          return;
        }

        if (!roomOwnerId) {
          socket.emit('change_action_error', {
            roomId,
            message: 'Room owner is not available.',
            timestamp: Date.now(),
          });
          return;
        }
        syncSocketFileChannel(socket, roomId, normalizedFileId);
        if (updatePresenceFileKey(roomId, userId || socket.userId, socket.userName, normalizedFileId)) {
          emitRoomPresence(roomId);
        }

        const hasRange = [startLine, endLine, startColumn, endColumn].some((value) => value !== undefined && value !== null && String(value).trim() !== '');
        const range = hasRange ? normalizeRange({ startLine, endLine, startColumn, endColumn }) : null;
        const pendingList = getRoomFileChangeList(pendingRequests, roomId, normalizedFileId);
        const conflictWith = range
          ? pendingList
              .filter((change) => change.status === 'pending' && rangesOverlap(change, range))
              .map((change) => change.changeId)
          : [];

        const requestId = makeChangeId();
        const suggestedChange = {
          requestId,
          changeId: requestId,
          roomId,
          fileId: normalizedFileId,
          fileKey: normalizedFileId,
          userId,
          userName,
          ownerUserId: roomOwnerId,
          requesterSocketId: socket.id,
          previousCode: typeof previousCode === 'string' ? previousCode : '',
          code,
          language: language || 'javascript',
          status: 'pending',
          conflict: conflictWith.length > 0,
          conflictWith,
          ...(range || {
            startLine: 1,
            endLine: 1,
            startColumn: 1,
            endColumn: 1,
          }),
          timestamp: Date.now(),
        };

        pendingList.push(suggestedChange);

        console.log('[debug][change-flow][backend state] pending_request_added', {
          roomId,
          fileId: normalizedFileId,
          requestId: suggestedChange.requestId,
          pendingCount: pendingList.filter((change) => change.status === 'pending').length,
          conflict: suggestedChange.conflict,
          conflictWith: suggestedChange.conflictWith,
        });

        if (conflictWith.length > 0) {
          pendingList.forEach((change) => {
            if (conflictWith.includes(change.changeId)) {
              change.conflict = true;
              change.conflictWith = Array.from(new Set([...(change.conflictWith || []), suggestedChange.changeId]));
            }
          });
        }

        const managerSocketId = getManagerSocket(roomId);
        if (!managerSocketId) {
          socket.emit('change_action_error', {
            roomId,
            changeId: suggestedChange.requestId,
            message: 'Manager is not connected.',
            timestamp: Date.now(),
          });
          return;
        }

        console.log('[debug][change-flow][backend emit] manager-only request', {
          roomId,
          requestId: suggestedChange.requestId,
          managerSocketId,
          requesterUserId: userId,
          codeLength: String(code || '').length,
        });

        io.to(managerSocketId).emit('conflict-request', suggestedChange);
        io.to(managerSocketId).emit('receive-request', suggestedChange);
        io.to(roomId).emit('change_suggested', suggestedChange);
        } catch (error) {
          console.error('[suggest-code] handleCodeRequest error', {
            roomId,
            fileId: normalizedFileId,
            userId,
            message: error?.message || String(error),
          });

          socket.emit('change_action_error', {
            roomId,
            fileId: normalizedFileId,
            message: error?.message || 'Unable to process suggestion request.',
            timestamp: Date.now(),
          });
        }
      };

      const handleConflictRequest = (data = {}) => {
        const {
          code,
          language,
          fileId,
          fileKey,
        } = data;

        const roomId = socket.currentRoom;
        const userId = socket.userId;
        const userName = socket.userName;
        const memberRole = getRoomUserRole(roomId, userId);
        const roomOwnerId = getRoomHostId(roomId);
        const rawFileId = String(fileId || fileKey || '').trim();
        const normalizedFileId = normalizeFileKey(rawFileId);

        if (!roomId || !rawFileId || typeof code !== 'string') {
          return;
        }

        if (memberRole !== 'editor') {
          socket.emit('role-denied', {
            roomId,
            userId,
            role: memberRole,
            reason: 'Only collaborators with write access can send conflict requests.',
          });
          return;
        }

        if (String(userId || '') === String(roomOwnerId || '')) {
          return;
        }

        syncSocketFileChannel(socket, roomId, normalizedFileId);
        if (updatePresenceFileKey(roomId, userId || socket.userId, socket.userName, normalizedFileId)) {
          emitRoomPresence(roomId);
        }

        emitToRoomOwner(roomId, 'conflict-alert', {
          changeId: makeChangeId(),
          roomId,
          fileId: normalizedFileId,
          fileKey: normalizedFileId,
          code,
          language: language || 'javascript',
          userId,
          userName,
          source: 'conflict-request',
          socketId: socket.id,
          timestamp: Date.now(),
        });
      };

      const handleApproveRequest = (data = {}) => {
        const roomId = socket.currentRoom;
        const userId = socket.userId;
        const userName = socket.userName;
        const memberRole = getRoomUserRole(roomId, userId);
        const roomOwnerId = getRoomHostId(roomId);
        const bypassOwnerGuard = Boolean(data.bypassOwnerGuard);
        const normalizedFileId = normalizeFileKey(data.fileId || data.fileKey);
        const requestId = String(data.requestId || data.changeId || '').trim();

        console.log('[debug][change-flow][backend recv] approve_request', {
          roomId,
          fileId: normalizedFileId,
          requestId,
          userId,
          socketId: socket.id,
        });

        if (!roomId || !requestId) {
          return;
        }

        if (memberRole !== 'editor' || (!bypassOwnerGuard && String(userId || '') !== String(roomOwnerId || ''))) {
          socket.emit('role-denied', {
            roomId,
            userId,
            role: memberRole,
            reason: 'Only the room manager can approve requests.',
          });
          return;
        }

        const pendingList = getRoomFileChangeList(pendingRequests, roomId, normalizedFileId);
        const target = pendingList.find((change) => String(change.changeId || change.requestId || '') === requestId && change.status === 'pending');
        if (!target) {
          console.error('[debug][change-flow][backend state] approve_request missing target', {
            roomId,
            fileId: normalizedFileId,
            requestId,
            pendingIds: pendingList.filter((item) => item.status === 'pending').map((item) => item.changeId),
          });
          socket.emit('change_action_error', {
            roomId,
            changeId: requestId,
            message: 'Pending request not found.',
            timestamp: Date.now(),
          });
          return;
        }

        target.status = 'accepted';
        target.acceptedBy = userId;
        target.acceptedByName = userName;
        target.resolvedAt = Date.now();

        const appliedList = getRoomFileChangeList(roomAppliedChanges, roomId, normalizedFileId);
        appliedList.push(target);

        const nextState = rememberRoomCodeState({
          roomId,
          fileKey: normalizedFileId,
          code: target.code,
          language: target.language,
          userId: target.userId,
          userName: target.userName,
        });

        const approvedPayload = {
          ...target,
          roomId,
          fileId: normalizedFileId,
          fileKey: normalizedFileId,
          timestamp: Date.now(),
        };

        io.to(roomId).emit('request-approved', approvedPayload);
        io.to(roomId).emit('change_accepted', approvedPayload);

        const channel = getFileSyncChannel(roomId, normalizedFileId);
        const codeUpdatePayload = {
          code: nextState.code,
          language: nextState.language,
          userId: target.userId,
          userName: target.userName,
          fileId: normalizedFileId,
          fileKey: normalizedFileId,
          roomId,
          changeId: target.changeId,
          requestId: target.requestId || target.changeId,
          source: 'change_accepted',
          revision: nextState.revision,
          socketId: socket.id,
          timestamp: Date.now(),
        };

        console.log('[debug][change-flow][backend emit] request-approved + code-update', {
          roomId,
          fileId: normalizedFileId,
          requestId: target.requestId || target.changeId,
          revision: nextState.revision,
          channel,
          codeLength: String(nextState.code || '').length,
        });

        // Emit to the whole room for stronger eventual consistency; clients still scope by fileId.
        io.to(roomId).emit('code-update', codeUpdatePayload);
        io.to(roomId).emit('code_updated', codeUpdatePayload);
      };

      const handleRejectRequest = (data = {}) => {
        const roomId = socket.currentRoom;
        const userId = socket.userId;
        const userName = socket.userName;
        const memberRole = getRoomUserRole(roomId, userId);
        const roomOwnerId = getRoomHostId(roomId);
        const bypassOwnerGuard = Boolean(data.bypassOwnerGuard);
        const normalizedFileId = normalizeFileKey(data.fileId || data.fileKey);
        const requestId = String(data.requestId || data.changeId || '').trim();

        console.log('[debug][change-flow][backend recv] reject_request', {
          roomId,
          fileId: normalizedFileId,
          requestId,
          userId,
          socketId: socket.id,
        });

        if (!roomId || !requestId) {
          return;
        }

        if (memberRole !== 'editor' || (!bypassOwnerGuard && String(userId || '') !== String(roomOwnerId || ''))) {
          socket.emit('role-denied', {
            roomId,
            userId,
            role: memberRole,
            reason: 'Only the room manager can reject requests.',
          });
          return;
        }

        const pendingList = getRoomFileChangeList(pendingRequests, roomId, normalizedFileId);
        const target = pendingList.find((change) => String(change.changeId || change.requestId || '') === requestId && change.status === 'pending');
        if (!target) {
          console.error('[debug][change-flow][backend state] reject_request missing target', {
            roomId,
            fileId: normalizedFileId,
            requestId,
            pendingIds: pendingList.filter((item) => item.status === 'pending').map((item) => item.changeId),
          });
          socket.emit('change_action_error', {
            roomId,
            changeId: requestId,
            message: 'Pending request not found.',
            timestamp: Date.now(),
          });
          return;
        }

        target.status = 'rejected';
        target.rejectedBy = userId;
        target.rejectedByName = userName;
        target.resolvedAt = Date.now();

        const rejectedPayload = {
          ...target,
          roomId,
          fileId: normalizedFileId,
          fileKey: normalizedFileId,
          timestamp: Date.now(),
        };

        // Emit rejection events to all in room (for status update)
        io.to(roomId).emit('request-rejected', rejectedPayload);
        io.to(roomId).emit('change_rejected', rejectedPayload);

        const managerProvidedCode = typeof data.code === 'string' ? data.code : '';
        const roomState = roomCodeStates.get(roomId);
        const existingState = roomState ? roomState.get(normalizedFileId) : null;
        const fallbackCode = typeof target.previousCode === 'string' ? target.previousCode : '';
        const authoritativeCode = managerProvidedCode
          || (typeof existingState?.code === 'string' ? existingState.code : '')
          || fallbackCode;

        if (typeof authoritativeCode === 'string' && authoritativeCode.length > 0) {
          const revertedState = rememberRoomCodeState({
            roomId,
            fileKey: normalizedFileId,
            code: authoritativeCode,
            language: String(data.language || '') || existingState?.language || target.language || 'javascript',
            userId: roomOwnerId || userId,
            userName: String(data.userName || '') || userName || socket.userName,
          });

          const revertPayload = {
            roomId,
            fileId: normalizedFileId,
            fileKey: normalizedFileId,
            code: revertedState.code,
            language: revertedState.language,
            userId: revertedState.userId,
            userName: revertedState.userName,
            source: 'change_rejected_restore',
            revision: revertedState.revision,
            changeId: target.changeId,
            requestId: target.requestId || target.changeId,
            socketId: socket.id,
            timestamp: Date.now(),
          };

          // Emit code update ONLY to non-manager sockets in the room
          const roomMembers = activeRooms.get(roomId) || [];
          const managerUserId = getRoomHostId(roomId);
          roomMembers.forEach((member) => {
            if (String(member.userId) !== String(managerUserId) && member.socketId) {
              const memberSocket = io.sockets.sockets.get(member.socketId);
              if (memberSocket && memberSocket.rooms && memberSocket.rooms.has(roomId)) {
                memberSocket.emit('code-update', revertPayload);
                memberSocket.emit('code_updated', revertPayload);
              }
            }
          });

          console.log('[debug][change-flow][backend emit] reject -> restore authoritative code (non-manager only)', {
            roomId,
            fileId: normalizedFileId,
            requestId: target.requestId || target.changeId,
            revision: revertedState.revision,
            codeLength: String(revertedState.code || '').length,
          });
        }

        console.log('[debug][change-flow][backend emit] request-rejected', {
          roomId,
          fileId: normalizedFileId,
          requestId: target.requestId || target.changeId,
          requesterUserId: target.userId,
        });
      };

      const handleApproveCode = (data = {}) => {
        const roomId = socket.currentRoom;
        const userId = socket.userId;
        const userName = socket.userName;
        const memberRole = getRoomUserRole(roomId, userId);
        const roomOwnerId = getRoomHostId(roomId);
        const rawFileId = String(data.fileId || data.fileKey || '').trim();
        const normalizedFileId = normalizeFileKey(rawFileId);
        const code = String(data.code || '');
        const language = String(data.language || 'javascript');

        if (!roomId || !rawFileId || !code) {
          return;
        }

        if (memberRole !== 'editor' || String(userId || '') !== String(roomOwnerId || '')) {
          socket.emit('role-denied', {
            roomId,
            userId,
            role: memberRole,
            reason: 'Only the room manager can approve code.',
          });
          return;
        }

        const nextState = rememberRoomCodeState({
          roomId,
          fileKey: normalizedFileId,
          code,
          language,
          userId,
          userName,
        });

        const payload = {
          roomId,
          fileId: normalizedFileId,
          fileKey: normalizedFileId,
          code: nextState.code,
          language: nextState.language,
          userId,
          userName,
          source: 'approve-code',
          revision: nextState.revision,
          socketId: socket.id,
          timestamp: Date.now(),
        };

        io.to(roomId).emit('code-update', payload);
        io.to(roomId).emit('code_updated', payload);
      };

      socket.on('suggest-code', handleCodeRequest);
      socket.on('suggest-change', handleCodeRequest);
      socket.on('code_change', (data = {}) => handleCodeRequest({ ...data, bypassOwnerGuard: true }));
      socket.on('conflict-request', handleConflictRequest);
      socket.on('code_typing', handleCodeTyping);
      socket.on('code_commit', handleCodeCommit);
      socket.on('code-run', handleCodeRun);
      socket.on('approve-request', handleApproveRequest);
      socket.on('reject-request', handleRejectRequest);
      socket.on('accept_change', (data = {}) => handleApproveRequest({ ...data, bypassOwnerGuard: true }));
      socket.on('reject_change', (data = {}) => handleRejectRequest({ ...data, bypassOwnerGuard: true }));

      // Handle cursor position updates
      const handleCursorMove = (data = {}) => {
        const {
          userId,
          fileId,
          fileKey,
          position,
          line,
          column,
        } = data;
        const roomId = socket.currentRoom;

        if (!roomId) {
          return;
        }

        const normalizedLine = Number(position?.lineNumber || line || 1);
        const normalizedColumn = Number(position?.column || column || 1);
        const normalizedFileId = String(fileId || fileKey || '__default__');

        if (updatePresenceFileKey(roomId, userId || socket.userId, socket.userName, normalizedFileId)) {
          emitRoomPresence(roomId);
        }

        const payload = {
          userId,
          userName: socket.userName,
          fileId: normalizedFileId,
          fileKey: normalizedFileId,
          position: {
            lineNumber: normalizedLine,
            column: normalizedColumn,
          },
          line: normalizedLine,
          column: normalizedColumn,
          socketId: socket.id,
          timestamp: new Date().getTime(),
        };

        console.log(`Broadcasting cursor-move for room ${roomId}, file ${normalizedFileId}, user ${userId}`);

        // Broadcast cursor position to all other users in the room
        socket.to(roomId).emit('cursor-move', payload);
        socket.to(roomId).emit('cursor-updated', payload);
      };

      socket.on('cursor-update', handleCursorMove);
      socket.on('cursor-move', handleCursorMove);

      socket.on('user-active-file', (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || !socket.userId) {
          return;
        }

        const fileKey = data.fileId || data.fileKey;
        if (updatePresenceFileKey(roomId, socket.userId, socket.userName, fileKey)) {
          emitRoomPresence(roomId);
        }

        syncSocketFileChannel(socket, roomId, fileKey);
      });

      socket.on('active-file-changed', (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || !socket.userId) {
          return;
        }

        const fileKey = data.fileId || data.fileKey;
        if (updatePresenceFileKey(roomId, socket.userId, socket.userName, fileKey)) {
          emitRoomPresence(roomId);
        }

        syncSocketFileChannel(socket, roomId, fileKey);

        socket.to(roomId).emit('active-file-changed', {
          userId: socket.userId,
          userName: socket.userName,
          fileId: normalizeFileKey(fileKey),
          fileKey: normalizeFileKey(fileKey),
          timestamp: new Date().getTime(),
          socketId: socket.id,
        });
      });

      socket.on('tabs-state', (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || !socket.userId) {
          return;
        }

        socket.to(roomId).emit('tabs-state', {
          userId: socket.userId,
          userName: socket.userName,
          tabs: Array.isArray(data.tabs) ? data.tabs : [],
          activeFileId: data.activeFileId || null,
          timestamp: new Date().getTime(),
          socketId: socket.id,
        });
      });

      socket.on('file-event', (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || !socket.userId) {
          return;
        }

        const eventType = String(data.eventType || '').trim();
        if (!eventType) {
          return;
        }

        socket.to(roomId).emit('file-event', {
          eventType,
          payload: data.payload || {},
          userId: socket.userId,
          userName: socket.userName,
          timestamp: new Date().getTime(),
          socketId: socket.id,
        });
      });

      socket.on('file-create', (data = {}) => {
        const roomId = socket.currentRoom;
        const userId = socket.userId;
        if (!roomId || !userId) {
          return;
        }

        if (getRoomUserRole(roomId, userId) !== 'editor') {
          socket.emit('role-denied', {
            roomId,
            userId,
            role: getRoomUserRole(roomId, userId),
            reason: 'Only editors can create files/folders in this room.',
          });
          return;
        }

        const file = data.file || null;
        console.log('[socket recv] file-create', {
          roomId,
          userId,
          socketId: socket.id,
          fileId: file?._id || null,
          itemType: file?.itemType || null,
          name: file?.name || null,
        });

        io.to(roomId).emit('file-created', {
          roomId,
          file,
          userId,
          userName: socket.userName,
          socketId: socket.id,
          timestamp: new Date().getTime(),
        });
      });

      const emitChatHistory = async (targetRoomId, targetSocket = socket) => {
        if (!targetRoomId) {
          return;
        }

        const chatHistory = await ChatMessage.find({ roomId: targetRoomId })
          .sort({ createdAt: 1 })
          .limit(200)
          .lean();

        targetSocket.emit('chat-history', {
          roomId: targetRoomId,
          messages: buildChatHistoryPayload(chatHistory),
        });
      };

      const saveChatAttachment = async (roomId, attachment = {}) => {
        const parsed = parseDataUrl(attachment.dataUrl);
        if (!parsed || !parsed.buffer || parsed.buffer.length === 0) {
          throw new Error('Invalid attachment payload.');
        }

        if (parsed.buffer.length > CHAT_ATTACHMENT_LIMIT_BYTES) {
          throw new Error('Attachment is too large.');
        }

        const safeName = sanitizeFileName(attachment.name || 'attachment');
        const uniquePrefix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const storedName = `${uniquePrefix}-${safeName}`;
        const roomDir = getRoomChatUploadDir(roomId);
        const storedPath = path.join(roomDir, storedName);

        await fs.promises.writeFile(storedPath, parsed.buffer);

        return {
          name: safeName,
          mimeType: String(parsed.mimeType || attachment.mimeType || 'application/octet-stream'),
          size: parsed.buffer.length,
          url: createChatUploadUrl(roomId, storedName),
          isImage: isImageMimeType(parsed.mimeType || attachment.mimeType),
        };
      };

      const ensureChatRateLimit = (roomId, socketId) => {
        const now = Date.now();
        const timestamps = Array.isArray(socket.chatMessageTimestamps) ? socket.chatMessageTimestamps : [];
        const recent = timestamps.filter((timestamp) => now - timestamp < CHAT_MESSAGE_RATE_LIMIT_WINDOW_MS);
        recent.push(now);
        socket.chatMessageTimestamps = recent;

        if (recent.length > CHAT_MESSAGE_RATE_LIMIT_MAX) {
          console.warn(`[chat] Rate limit triggered for socket ${socketId} in room ${roomId}`);
          return false;
        }

        return true;
      };

      const updateChatMessageStatus = async ({ roomId, messageId, userId, nextStatus }) => {
        if (!roomId || !messageId) {
          return null;
        }

        const messageDoc = await ChatMessage.findOne({ _id: messageId, roomId });
        if (!messageDoc) {
          return null;
        }

        const socketKey = String(socket.id || '');
        const updatedFields = {};
        const deliveredBy = new Set(messageDoc.deliveredBy || []);
        const seenBy = new Set(messageDoc.seenBy || []);

        if (nextStatus === 'delivered') {
          if (deliveredBy.has(socketKey) || String(messageDoc.senderId || '') === String(userId || '')) {
            return messageDoc;
          }
          deliveredBy.add(socketKey);
          updatedFields.deliveredBy = Array.from(deliveredBy);
          updatedFields.status = messageDoc.status === 'seen' ? 'seen' : 'delivered';
          if (!messageDoc.deliveredAt) {
            updatedFields.deliveredAt = new Date();
          }
        }

        if (nextStatus === 'seen') {
          if (seenBy.has(socketKey) || String(messageDoc.senderId || '') === String(userId || '')) {
            return messageDoc;
          }
          seenBy.add(socketKey);
          updatedFields.seenBy = Array.from(seenBy);
          updatedFields.status = 'seen';
          if (!messageDoc.seenAt) {
            updatedFields.seenAt = new Date();
          }
        }

        const nextDoc = await ChatMessage.findByIdAndUpdate(
          messageDoc._id,
          { $set: updatedFields },
          { new: true }
        ).lean();

        if (nextDoc) {
          io.to(roomId).emit('chat-message-status', {
            roomId,
            messageId: String(nextDoc._id),
            status: nextDoc.status,
            deliveredBy: nextDoc.deliveredBy || [],
            seenBy: nextDoc.seenBy || [],
            deliveredAt: nextDoc.deliveredAt || null,
            seenAt: nextDoc.seenAt || null,
            timestamp: Date.now(),
            updatedBy: userId || socket.userId,
            updatedByName: socket.userName,
          });
        }

        return nextDoc;
      };

      socket.on('chat-history-request', async (data = {}) => {
        const requestedRoomId = String(data.roomId || socket.currentRoom || '').trim();
        if (!requestedRoomId || !socket.currentRoom || requestedRoomId !== socket.currentRoom) {
          return;
        }

        try {
          console.log('[socket recv] chat-history-request', {
            roomId: requestedRoomId,
            socketId: socket.id,
            userId: socket.userId,
          });
          await emitChatHistory(requestedRoomId);
        } catch (error) {
          console.error(`[chat] Failed to fulfill history request for room ${requestedRoomId}:`, error.message);
          socket.emit('chat-history', { roomId: requestedRoomId, messages: [] });
        }
      });

      const handleChatMessage = async (eventName, data = {}) => {
        const roomId = getSocketRoomId(socket);
        const userId = socket.userId;
        const userName = socket.userName;
        const clientMessageId = String(data.clientMessageId || '').trim();
        const rawMessageType = String(data.messageType || '').toLowerCase() === 'code' ? 'code' : 'text';
        const rawCodeSnippet = data.codeSnippet || null;
        const rawCode = rawMessageType === 'code'
          ? sanitizeChatCode(rawCodeSnippet?.code || data.message || data.text || '').slice(0, CHAT_CODE_LIMIT)
          : '';
        const rawCodeLanguage = rawMessageType === 'code'
          ? normalizeSnippetLanguage(rawCodeSnippet?.language || data.language)
          : '';
        const rawMessage = rawMessageType === 'code'
          ? rawCode
          : sanitizeChatText(data.text || data.message || '').slice(0, CHAT_MESSAGE_LIMIT);
        const rawAttachment = data.attachment || null;

        if (!roomId || !userId || String(data.roomId || '') !== String(roomId)) {
          console.warn('[chat] dropped message due to room mismatch', {
            eventName,
            roomId: roomId || null,
            requestedRoomId: data.roomId || null,
            socketId: socket.id,
            userId,
          });
          socket.emit('chat-error', {
            roomId: String(data.roomId || roomId || ''),
            message: 'Chat message rejected: socket is not joined to this room.',
            timestamp: Date.now(),
          });
          return;
        }

        console.log('EVENT:', eventName, roomId);

        if (!rawMessage && !rawAttachment) {
          return;
        }

        if (rawMessageType === 'code' && !rawCode) {
          socket.emit('chat-error', {
            roomId,
            message: 'Code snippet cannot be empty.',
            timestamp: Date.now(),
          });
          return;
        }

        if (!ensureChatRateLimit(roomId, socket.id)) {
          socket.emit('chat-error', {
            roomId,
            message: 'You are sending messages too quickly. Please slow down.',
            timestamp: Date.now(),
          });
          return;
        }

        let attachment = null;
        if (rawAttachment) {
          try {
            attachment = await saveChatAttachment(roomId, rawAttachment);
          } catch (error) {
            socket.emit('chat-error', {
              roomId,
              message: error.message || 'Attachment upload failed.',
              timestamp: Date.now(),
            });
            return;
          }
        }

        console.log('[socket recv] chat-message', {
          roomId,
          userId,
          userName,
          socketId: socket.id,
          messageType: rawMessageType,
          codeLanguage: rawCodeLanguage || null,
          messageLength: rawMessage.length,
          hasAttachment: Boolean(attachment),
        });

        try {
          const savedMessage = await ChatMessage.create({
            roomId,
            senderId: userId,
            sender: userName,
            message: rawMessage || (attachment ? attachment.name : ''),
            messageType: rawMessageType,
            codeSnippet: rawMessageType === 'code'
              ? {
                  language: rawCodeLanguage,
                  code: rawCode,
                }
              : undefined,
            status: 'sent',
            deliveredBy: [],
            seenBy: [],
            attachment: attachment ? {
              name: attachment.name,
              mimeType: attachment.mimeType,
              size: attachment.size,
              url: attachment.url,
              isImage: attachment.isImage,
            } : undefined,
            socketId: socket.id,
          });

          const payload = {
            roomId,
            id: String(savedMessage._id),
            clientMessageId,
            senderId: String(userId),
            senderName: userName,
            sender: userName,
            isAssistant: false,
            text: savedMessage.message,
            message: savedMessage.message,
            messageType: savedMessage.messageType || 'text',
            codeSnippet: savedMessage.codeSnippet || null,
            status: savedMessage.status,
            deliveredBy: [],
            seenBy: [],
            deliveredAt: null,
            seenAt: null,
            attachment: savedMessage.attachment || null,
            socketId: socket.id,
            timestamp: savedMessage.createdAt,
          };

          io.to(roomId).emit('receive_message', payload);
          io.to(roomId).emit('chat-message', payload);
        } catch (error) {
          console.error(`[chat] Failed to persist message in room ${roomId}:`, error.message);
          const fallbackPayload = {
            roomId,
            id: clientMessageId || `chat-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            clientMessageId,
            senderId: String(userId),
            senderName: userName,
            sender: userName,
            isAssistant: false,
            text: rawMessage || (attachment ? attachment.name : ''),
            message: rawMessage || (attachment ? attachment.name : ''),
            messageType: rawMessageType,
            codeSnippet: rawMessageType === 'code' ? { language: rawCodeLanguage, code: rawCode } : null,
            status: 'sent',
            deliveredBy: [],
            seenBy: [],
            deliveredAt: null,
            seenAt: null,
            attachment: attachment ? {
              name: attachment.name,
              mimeType: attachment.mimeType,
              size: attachment.size,
              url: attachment.url,
              isImage: attachment.isImage,
            } : null,
            socketId: socket.id,
            timestamp: Date.now(),
            persistence: 'failed',
          };

          io.to(roomId).emit('receive_message', fallbackPayload);
          io.to(roomId).emit('chat-message', fallbackPayload);
          socket.emit('chat-error', {
            roomId,
            message: 'Message delivered in realtime, but persistence failed.',
            timestamp: Date.now(),
          });
        }
      };

      socket.on('chat-message', (data = {}) => handleChatMessage('chat-message', data));
      socket.on('send_message', (data = {}) => handleChatMessage('send_message', data));

      socket.on('chat-ai-request', async (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || String(data.roomId || '') !== String(roomId)) {
          return;
        }

        const prompt = sanitizeChatText(data.prompt || '').slice(0, CHAT_MESSAGE_LIMIT);
        if (!prompt) {
          return;
        }

        const requestId = String(data.requestId || `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        socket.emit('chat-ai-status', {
          roomId,
          requestId,
          status: 'started',
          timestamp: Date.now(),
        });

        try {
          const replyText = await generateAssistantReply({
            message: prompt,
            language: String(data.language || '').trim(),
            projectName: String(data.projectName || '').trim(),
            fileName: String(data.fileName || '').trim(),
            fileCount: Number(data.fileCount) || 0,
            readOnlyMode: false,
          });

          const snippet = extractSingleFencedSnippet(replyText);
          const messageType = snippet ? 'code' : 'text';
          const message = snippet ? snippet.code : String(replyText || '').trim() || 'Assistant could not produce a response.';

          const savedAssistantMessage = await ChatMessage.create({
            roomId,
            sender: 'Assistant',
            isAssistant: true,
            message,
            messageType,
            codeSnippet: snippet || undefined,
            status: 'seen',
            deliveredBy: [],
            seenBy: [],
            socketId: socket.id,
          });

          io.to(roomId).emit('chat-message', {
            roomId,
            id: String(savedAssistantMessage._id),
            senderId: null,
            sender: 'Assistant',
            isAssistant: true,
            message: savedAssistantMessage.message,
            messageType: savedAssistantMessage.messageType || 'text',
            codeSnippet: savedAssistantMessage.codeSnippet || null,
            status: 'seen',
            deliveredBy: [],
            seenBy: [],
            deliveredAt: null,
            seenAt: null,
            attachment: null,
            socketId: socket.id,
            timestamp: savedAssistantMessage.createdAt,
          });

          socket.emit('chat-ai-status', {
            roomId,
            requestId,
            status: 'completed',
            timestamp: Date.now(),
          });
        } catch (error) {
          console.error('[chat] AI request failed:', error.message);
          socket.emit('chat-ai-status', {
            roomId,
            requestId,
            status: 'failed',
            error: 'Assistant request failed.',
            timestamp: Date.now(),
          });
        }
      });

      socket.on('chat-message-delivered', async (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || String(data.roomId || '') !== String(roomId)) {
          return;
        }

        console.log('[socket recv] chat-message-delivered', {
          roomId,
          messageId: data.messageId,
          socketId: socket.id,
          userId: socket.userId,
        });

        await updateChatMessageStatus({
          roomId,
          messageId: data.messageId,
          userId: socket.userId,
          nextStatus: 'delivered',
        });
      });

      socket.on('chat-message-seen', async (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || String(data.roomId || '') !== String(roomId)) {
          return;
        }

        console.log('[socket recv] chat-message-seen', {
          roomId,
          messageId: data.messageId,
          socketId: socket.id,
          userId: socket.userId,
        });

        await updateChatMessageStatus({
          roomId,
          messageId: data.messageId,
          userId: socket.userId,
          nextStatus: 'seen',
        });
      });

      socket.on('chat-message-react', async (data = {}) => {
        const roomId = socket.currentRoom;
        const messageId = String(data.messageId || '').trim();
        const emoji = sanitizeChatText(data.emoji || '');

        if (!roomId || String(data.roomId || '') !== String(roomId) || !messageId || !emoji) {
          return;
        }

        const doc = await ChatMessage.findOne({ _id: messageId, roomId });
        if (!doc) {
          return;
        }

        const userId = String(socket.userId || '');
        const reactions = Array.isArray(doc.reactions) ? [...doc.reactions] : [];
        const reactionIndex = reactions.findIndex((entry) => entry.emoji === emoji);

        if (reactionIndex === -1) {
          reactions.push({ emoji, userIds: [userId] });
        } else {
          const existingUsers = Array.isArray(reactions[reactionIndex].userIds)
            ? [...reactions[reactionIndex].userIds]
            : [];
          const exists = existingUsers.includes(userId);
          reactions[reactionIndex].userIds = exists
            ? existingUsers.filter((id) => id !== userId)
            : [...existingUsers, userId];

          if (reactions[reactionIndex].userIds.length === 0) {
            reactions.splice(reactionIndex, 1);
          }
        }

        const updated = await ChatMessage.findByIdAndUpdate(
          doc._id,
          { $set: { reactions } },
          { new: true }
        ).lean();

        io.to(roomId).emit('chat-message-updated', {
          roomId,
          messageId,
          reactions: updated?.reactions || [],
          updatedBy: userId,
          timestamp: Date.now(),
        });
      });

      socket.on('chat-message-edit', async (data = {}) => {
        const roomId = socket.currentRoom;
        const messageId = String(data.messageId || '').trim();
        const incomingMessage = String(data.message || '');

        if (!roomId || String(data.roomId || '') !== String(roomId) || !messageId) {
          return;
        }

        const doc = await ChatMessage.findOne({ _id: messageId, roomId });
        if (!doc || String(doc.senderId || '') !== String(socket.userId || '')) {
          return;
        }

        const isCodeMessage = String(doc.messageType || 'text') === 'code';
        const nextMessage = isCodeMessage
          ? sanitizeChatCode(incomingMessage).slice(0, CHAT_CODE_LIMIT)
          : sanitizeChatText(incomingMessage).slice(0, CHAT_MESSAGE_LIMIT);
        if (!nextMessage) {
          return;
        }

        const setPayload = {
          message: nextMessage,
          editedAt: new Date(),
        };
        if (isCodeMessage) {
          setPayload.codeSnippet = {
            language: normalizeSnippetLanguage(doc.codeSnippet?.language || 'plaintext'),
            code: nextMessage,
          };
        }

        const updated = await ChatMessage.findByIdAndUpdate(
          doc._id,
          {
            $set: setPayload,
          },
          { new: true }
        ).lean();

        io.to(roomId).emit('chat-message-updated', {
          roomId,
          messageId,
          message: updated?.message || nextMessage,
          messageType: updated?.messageType || 'text',
          codeSnippet: updated?.codeSnippet || null,
          editedAt: updated?.editedAt || new Date(),
          updatedBy: socket.userId,
          timestamp: Date.now(),
        });
      });

      socket.on('chat-message-delete', async (data = {}) => {
        const roomId = socket.currentRoom;
        const messageId = String(data.messageId || '').trim();

        if (!roomId || String(data.roomId || '') !== String(roomId) || !messageId) {
          return;
        }

        const doc = await ChatMessage.findOne({ _id: messageId, roomId });
        if (!doc || String(doc.senderId || '') !== String(socket.userId || '')) {
          return;
        }

        await ChatMessage.findByIdAndUpdate(
          doc._id,
          {
            $set: {
              isDeleted: true,
              message: '[message deleted]',
              attachment: {
                name: '',
                mimeType: '',
                size: 0,
                url: '',
                isImage: false,
              },
              editedAt: new Date(),
            },
          }
        );

        io.to(roomId).emit('chat-message-deleted', {
          roomId,
          messageId,
          deletedBy: socket.userId,
          timestamp: Date.now(),
        });
      });

      socket.on('webrtc-join', (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || String(data.roomId || '') !== String(roomId)) {
          return;
        }

        const callState = ensureRoomCallState(roomId);
        const participant = {
          socketId: socket.id,
          userId: socket.userId,
          userName: socket.userName,
          audioEnabled: data.audioEnabled !== false,
          videoEnabled: Boolean(data.videoEnabled),
          speaking: false,
          joinedAt: Date.now(),
        };

        callState.set(socket.id, participant);
        const peers = Array.from(callState.values()).filter((entry) => entry.socketId !== socket.id);

        socket.emit('webrtc-peers', {
          roomId,
          peers,
          self: participant,
          timestamp: Date.now(),
        });

        socket.to(roomId).emit('webrtc-peer-joined', {
          roomId,
          peer: participant,
          timestamp: Date.now(),
        });

        broadcastRoomCallState(roomId);
      });

      socket.on('webrtc-offer', (data = {}) => {
        const roomId = getSocketRoomId(socket);
        const targetSocketId = String(data.targetSocketId || '').trim();
        if (!roomId || String(data.roomId || '') !== String(roomId) || !targetSocketId || !isSocketInRoom(targetSocketId, roomId)) {
          console.log('[webrtc] blocked offer (room mismatch/target mismatch)', {
            fromSocketId: socket.id,
            roomId,
            targetSocketId,
            requestedRoomId: data.roomId || null,
          });
          return;
        }

        console.log('EVENT:', 'webrtc-offer', roomId);

        io.to(targetSocketId).emit('webrtc-offer', {
          roomId,
          fromSocketId: socket.id,
          fromUserId: socket.userId,
          fromUserName: socket.userName,
          sdp: data.sdp,
          timestamp: Date.now(),
        });
      });

      socket.on('webrtc-answer', (data = {}) => {
        const roomId = getSocketRoomId(socket);
        const targetSocketId = String(data.targetSocketId || '').trim();
        if (!roomId || String(data.roomId || '') !== String(roomId) || !targetSocketId || !isSocketInRoom(targetSocketId, roomId)) {
          console.log('[webrtc] blocked answer (room mismatch/target mismatch)', {
            fromSocketId: socket.id,
            roomId,
            targetSocketId,
            requestedRoomId: data.roomId || null,
          });
          return;
        }

        console.log('EVENT:', 'webrtc-answer', roomId);

        io.to(targetSocketId).emit('webrtc-answer', {
          roomId,
          fromSocketId: socket.id,
          fromUserId: socket.userId,
          fromUserName: socket.userName,
          sdp: data.sdp,
          timestamp: Date.now(),
        });
      });

      socket.on('webrtc-ice-candidate', (data = {}) => {
        const roomId = getSocketRoomId(socket);
        const targetSocketId = String(data.targetSocketId || '').trim();
        if (!roomId || String(data.roomId || '') !== String(roomId) || !targetSocketId || !isSocketInRoom(targetSocketId, roomId)) {
          console.log('[webrtc] blocked ice-candidate (room mismatch/target mismatch)', {
            fromSocketId: socket.id,
            roomId,
            targetSocketId,
            requestedRoomId: data.roomId || null,
          });
          return;
        }

        console.log('EVENT:', 'webrtc-ice-candidate', roomId);

        io.to(targetSocketId).emit('webrtc-ice-candidate', {
          roomId,
          fromSocketId: socket.id,
          candidate: data.candidate,
          timestamp: Date.now(),
        });
      });

      socket.on('webrtc-media-state', (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || String(data.roomId || '') !== String(roomId)) {
          return;
        }

        const callState = ensureRoomCallState(roomId);
        const participant = callState.get(socket.id);
        if (!participant) {
          return;
        }

        participant.audioEnabled = data.audioEnabled !== false;
        participant.videoEnabled = Boolean(data.videoEnabled);
        callState.set(socket.id, participant);

        io.to(roomId).emit('webrtc-media-state', {
          roomId,
          socketId: socket.id,
          userId: socket.userId,
          userName: socket.userName,
          audioEnabled: participant.audioEnabled,
          videoEnabled: participant.videoEnabled,
          timestamp: Date.now(),
        });

        broadcastRoomCallState(roomId);
      });

      socket.on('webrtc-speaking', (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || String(data.roomId || '') !== String(roomId)) {
          return;
        }

        const callState = ensureRoomCallState(roomId);
        const participant = callState.get(socket.id);
        if (!participant) {
          return;
        }

        participant.speaking = Boolean(data.speaking);
        callState.set(socket.id, participant);

        socket.to(roomId).emit('webrtc-speaking', {
          roomId,
          socketId: socket.id,
          userId: socket.userId,
          userName: socket.userName,
          speaking: participant.speaking,
          timestamp: Date.now(),
        });

        broadcastRoomCallState(roomId);
      });

      socket.on('webrtc-leave', (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || String(data.roomId || '') !== String(roomId)) {
          return;
        }

        removeCallParticipant(roomId, socket.id);
        socket.to(roomId).emit('webrtc-peer-left', {
          roomId,
          socketId: socket.id,
          userId: socket.userId,
          userName: socket.userName,
          timestamp: Date.now(),
        });

        broadcastRoomCallState(roomId);
      });

      socket.on('typing', (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || String(data.roomId || '') !== String(roomId)) {
          return;
        }

        const userName = socket.userName || String(data.userName || 'Anonymous');
        const typingState = ensureRoomChatTypingState(roomId);
        typingState.set(socket.id, {
          socketId: socket.id,
          userName,
          userId: socket.userId,
          timestamp: Date.now(),
        });
        socket.chatTypingActive = true;

        console.log('[socket recv] typing', {
          roomId,
          userName,
          socketId: socket.id,
        });

        socket.to(roomId).emit('typing', userName);
      });

      socket.on('stop-typing', (data = {}) => {
        const roomId = socket.currentRoom;
        if (!roomId || String(data.roomId || '') !== String(roomId)) {
          return;
        }

        const userName = socket.userName || String(data.userName || 'Anonymous');
        clearRoomChatTypingState(roomId, socket.id);
        socket.chatTypingActive = false;

        console.log('[socket recv] stop-typing', {
          roomId,
          userName,
          socketId: socket.id,
        });

        socket.to(roomId).emit('stop-typing', userName);
      });

      socket.on('typing-status', (data) => {
        const { isTyping, fileKey } = data;
        const userId = socket.userId;
        const roomId = socket.currentRoom;

        if (!roomId) {
          return;
        }

        if (getRoomUserRole(roomId, userId) !== 'editor') {
          return;
        }

        if (updatePresenceFileKey(roomId, userId || socket.userId, socket.userName, fileKey)) {
          emitRoomPresence(roomId);
        }

        socket.to(roomId).emit('typing-status', {
          userId,
          userName: socket.userName,
          fileKey,
          isTyping: Boolean(isTyping),
          timestamp: new Date().getTime(),
        });
      });

      // Handle code execution with real-time streaming
      socket.on('code-execute', (payload) => {
        const roomId = socket.currentRoom || null;
        console.log('[socket recv] code-execute', {
          executionId: payload?.executionId,
          roomId,
          socketId: socket.id,
          userId: socket.userId,
        });
        runCodeWithStreaming(io, socket, {
          ...(payload || {}),
          roomId,
        });
      });

      socket.on('role-change', (data = {}) => {
        const roomId = socket.currentRoom;
        const actorId = socket.userId;
        const targetUserId = String(data.userId || '').trim();
        const nextRole = normalizeRoomRole(data.role);

        if (!roomId || !actorId || !targetUserId) {
          socket.emit('role-change-error', { roomId, error: 'Invalid role change request.' });
          return;
        }

        if (!canManageRoomRoles(socket, roomId)) {
          socket.emit('role-change-error', { roomId, error: 'Not authorized to change room roles.' });
          return;
        }

        if (!activeRooms.has(roomId)) {
          socket.emit('role-change-error', { roomId, error: 'Room not found.' });
          return;
        }

        const room = activeRooms.get(roomId);
        const targetMember = room.find((member) => String(member.userId) === targetUserId);
        if (!targetMember) {
          socket.emit('role-change-error', { roomId, error: 'Target user is not in this room.' });
          return;
        }

        if (nextRole === 'editor' && countRoomEditors(roomId) >= MAX_ROOM_EDITORS && getRoomUserRole(roomId, targetUserId) !== 'editor') {
          socket.emit('role-change-error', { roomId, error: `Only ${MAX_ROOM_EDITORS} editors are allowed in a room.` });
          return;
        }

        if (nextRole === 'viewer' && getRoomUserRole(roomId, targetUserId) === 'editor' && countRoomEditors(roomId) <= 1) {
          socket.emit('role-change-error', { roomId, error: 'At least one editor must remain in the room.' });
          return;
        }

        const roleState = ensureRoomRoleState(roomId);
        roleState.set(targetUserId, nextRole);
        syncRoomMemberRoles(roomId);
        emitRoomRoleState(roomId);
        socket.to(roomId).emit('role-change', {
          roomId,
          userId: targetUserId,
          role: nextRole,
          changedBy: actorId,
          changedByName: socket.userName,
          timestamp: new Date().getTime(),
        });
        socket.emit('role-change-success', {
          roomId,
          userId: targetUserId,
          role: nextRole,
        });
      });

      socket.on('terminal-exec', async (payload = {}) => {
        const requestId = String(payload.requestId || `term-${Date.now()}`);
        const command = String(payload.command || '');
        const roomId = socket.currentRoom || null;
        const shareWithRoom = Boolean(payload.shared && roomId);
        const sessionKey = buildTerminalSessionKey({
          roomId: shareWithRoom ? roomId : null,
          userId: socket.userId,
          socketId: socket.id,
        });

        addTerminalParticipant(sessionKey, socket.id);

        const emitTerminalEvent = (eventName, data) => {
          const eventPayload = {
            ...data,
            roomId,
            requestId,
            command,
            socketId: socket.id,
            userId: socket.userId,
            userName: socket.userName,
            timestamp: Date.now(),
          };

          if (shareWithRoom) {
            console.log('[socket emit][terminal]', eventName, {
              roomId,
              requestId,
              socketId: socket.id,
              userId: socket.userId,
            });
            io.to(roomId).emit(eventName, eventPayload);
            return;
          }

          console.log('[socket emit][terminal]', eventName, {
            roomId,
            requestId,
            socketId: socket.id,
            userId: socket.userId,
          });
          socket.emit(eventName, eventPayload);
        };

        console.log('[socket recv] terminal-exec', {
          requestId,
          roomId,
          socketId: socket.id,
          userId: socket.userId,
        });

        try {
          const result = await executeTerminalCommandInSession({
            sessionKey,
            requestId,
            command,
            onStart: () => {
              emitTerminalEvent('terminal-start', {});
              emitTerminalEvent('terminal-command', {});
            },
            onOutput: (type, chunk) => {
              emitTerminalEvent('terminal-output', {
                type,
                data: chunk,
              });
            },
          });

          emitTerminalEvent('terminal-done', {
            output: '',
            cwd: result.cwd || null,
            exitCode: result.exitCode,
          });
        } catch (error) {
          emitTerminalEvent('terminal-error', {
            error: error?.message || 'Terminal command failed',
            status: error?.status || 400,
          });
        }
      });

      // Handle client disconnect
      socket.on('disconnect', () => {
        removeTerminalParticipantBySocket(socket.id);
        console.log(`User disconnected: ${socket.id}`);
        socketRoomMap.delete(socket.id);
        const roomId = socket.currentRoom;
        const userId = socket.userId;
        const userName = socket.userName;
        const currentFileSyncChannel = socket.currentFileSyncChannel;

        if (socket.chatTypingActive && roomId) {
          socket.to(roomId).emit('stop-typing', userName);
          socket.chatTypingActive = false;
        }

        if (roomId) {
          clearRoomChatTypingState(roomId, socket.id);
          removeCallParticipant(roomId, socket.id);
          socket.to(roomId).emit('webrtc-peer-left', {
            roomId,
            socketId: socket.id,
            userId,
            userName,
            timestamp: Date.now(),
          });
          broadcastRoomCallState(roomId);
        }

        if (currentFileSyncChannel) {
          socket.leave(currentFileSyncChannel);
          socket.currentFileSyncChannel = null;
          socket.currentFileId = null;
        }

        // Remove user from active room
        if (roomId && activeRooms.has(roomId)) {
          const room = activeRooms.get(roomId);
          activeRooms.set(roomId, room.filter(user => user.socketId !== socket.id));
          markPresenceOffline(roomId, { userId, userName });
          ensureRoomHasEditor(roomId);

          // If room is empty, delete it
          if (activeRooms.get(roomId).length === 0) {
            activeRooms.delete(roomId);
            roomCodeStates.delete(roomId);
            roomPresenceStates.delete(roomId);
            roomRoleStates.delete(roomId);
            roomHostStates.delete(roomId);
            roomChatTypingStates.delete(roomId);
            roomCallStates.delete(roomId);
            clearRoomChangeState(roomId);
            console.log(`Room ${roomId} deleted as it's now empty`);
          } else {
            // Notify remaining users that this user left
            io.to(roomId).emit('user-left', {
              userId: userId,
              userName: userName,
              users: activeRooms.get(roomId),
            });
            emitRoomPresence(roomId);
            emitRoomRoleState(roomId);
            broadcastRoomCallState(roomId);
            console.log(`User ${userName} left room ${roomId}`);
          }
        }
      });

    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startServer();
