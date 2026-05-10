const path = require('path');

const socketIoClientPath = path.join(__dirname, '..', 'sync-code-client', 'node_modules', 'socket.io-client');
const { io } = require(socketIoClientPath);

const API_BASE = 'http://localhost:5001/api';
const SOCKET_URL = 'http://localhost:5001';
const PASSWORD = 'Test@123456';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || payload?.message || `Request failed: ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
};

const ensureLogin = async (namePrefix) => {
  const email = `${namePrefix.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@demo.local`;
  const name = `${namePrefix}_${Math.random().toString(36).slice(2, 5)}`;

  try {
    await requestJson(`${API_BASE}/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name, email, password: PASSWORD }),
    });
  } catch (error) {
    if (error.status !== 409) {
      throw error;
    }
  }

  const login = await requestJson(`${API_BASE}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD }),
  });

  return {
    token: login.token,
    user: login.user,
  };
};

const waitSocketEvent = (socket, eventName, predicate = () => true, timeoutMs = 12000) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    socket.off(eventName, onEvent);
    reject(new Error(`Timed out waiting for ${eventName}`));
  }, timeoutMs);

  const onEvent = (payload) => {
    if (!predicate(payload)) {
      return;
    }
    clearTimeout(timeout);
    socket.off(eventName, onEvent);
    resolve(payload);
  };

  socket.on(eventName, onEvent);
});

const connectSocket = (token, label) => new Promise((resolve, reject) => {
  const socket = io(SOCKET_URL, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });

  const timer = setTimeout(() => {
    socket.disconnect();
    reject(new Error(`${label} socket connect timeout`));
  }, 10000);

  socket.on('connect', () => {
    clearTimeout(timer);
    console.log(`[SMOKE] ${label} connected`, socket.id);
    resolve(socket);
  });

  socket.on('role-denied', (payload) => {
    console.error(`[SMOKE][${label}] role-denied`, payload);
  });

  socket.on('change_action_error', (payload) => {
    console.error(`[SMOKE][${label}] change_action_error`, payload);
  });

  socket.on('error', (payload) => {
    console.error(`[SMOKE][${label}] socket error`, payload);
  });

  socket.on('connect_error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

const verifyNoAcceptedUpdateFor = (socket, changeId, waitMs = 1400) => new Promise((resolve) => {
  let triggered = false;

  const onUpdate = (payload = {}) => {
    if (payload?.source === 'change_accepted' && payload?.changeId === changeId) {
      triggered = true;
    }
  };

  socket.on('code-update', onUpdate);
  setTimeout(() => {
    socket.off('code-update', onUpdate);
    resolve(!triggered);
  }, waitMs);
});

(async () => {
  let socketA;
  let socketB;
  try {
    console.log('[SMOKE] Ensuring two users...');
    const [a, b] = await Promise.all([ensureLogin('UserA'), ensureLogin('UserB')]);

    console.log('[SMOKE] Connecting sockets...');
    socketA = await connectSocket(a.token, 'A');
    socketB = await connectSocket(b.token, 'B');

    const TRACE_EVENTS = new Set([
      'room-joined',
      'change_suggested',
      'change_accepted',
      'change_rejected',
      'code-update',
      'role-denied',
      'change_action_error',
    ]);
    socketA.onAny((eventName, payload) => {
      if (TRACE_EVENTS.has(eventName)) {
        console.log('[SMOKE][A recv]', eventName, payload?.changeId || payload?.fileId || payload?.roomId || '');
      }
    });
    socketB.onAny((eventName, payload) => {
      if (TRACE_EVENTS.has(eventName)) {
        console.log('[SMOKE][B recv]', eventName, payload?.changeId || payload?.fileId || payload?.roomId || '');
      }
    });

    const roomId = `smoke-${Date.now()}`;
    const fileId = 'smoke-file';
    const initialCode = 'const value = 1;\n';

    console.log('[SMOKE] Joining room/file...');
    socketA.emit('join-room', {
      roomId,
      userId: a.user.id,
      userName: a.user.name,
      fileId,
      code: initialCode,
      language: 'javascript',
    });
    socketB.emit('join-room', {
      roomId,
      userId: b.user.id,
      userName: b.user.name,
      fileId,
      code: initialCode,
      language: 'javascript',
    });

    await Promise.all([
      waitSocketEvent(socketA, 'room-joined', (payload) => payload?.roomId === roomId),
      waitSocketEvent(socketB, 'room-joined', (payload) => payload?.roomId === roomId),
    ]);

    console.log('[SMOKE] STEP 1: A suggests change');
    const acceptedCode = 'const value = 2;\n';

    const bSuggested = waitSocketEvent(
      socketB,
      'change_suggested',
      (payload) => payload?.roomId === roomId && payload?.fileId === fileId,
    );

    socketA.emit('code_change', {
      roomId,
      fileId,
      fileKey: fileId,
      previousCode: initialCode,
      code: acceptedCode,
      language: 'javascript',
      startLine: 1,
      endLine: 1,
      startColumn: 1,
      endColumn: 18,
      timestamp: Date.now(),
    });

    const suggestion = await bSuggested;
    console.log('[SMOKE] STEP 1 PASS changeId:', suggestion.changeId);

    console.log('[SMOKE] STEP 2: B accepts');
    const aAccepted = waitSocketEvent(socketA, 'change_accepted', (payload) => payload?.changeId === suggestion.changeId);
    const bAccepted = waitSocketEvent(socketB, 'change_accepted', (payload) => payload?.changeId === suggestion.changeId);
    const aCodeUpdate = waitSocketEvent(
      socketA,
      'code-update',
      (payload) => payload?.source === 'change_accepted' && payload?.changeId === suggestion.changeId && payload?.code === acceptedCode,
    );
    const bCodeUpdate = waitSocketEvent(
      socketB,
      'code-update',
      (payload) => payload?.source === 'change_accepted' && payload?.changeId === suggestion.changeId && payload?.code === acceptedCode,
    );

    socketB.emit('accept_change', {
      roomId,
      fileId,
      fileKey: fileId,
      changeId: suggestion.changeId,
      timestamp: Date.now(),
    });

    await Promise.all([aAccepted, bAccepted, aCodeUpdate, bCodeUpdate]);
    console.log('[SMOKE] STEP 2 PASS accepted sync received on both users');

    console.log('[SMOKE] STEP 3: A suggests second change, B rejects');
    const rejectedCode = 'const value = 3;\n';

    const bSuggested2 = waitSocketEvent(
      socketB,
      'change_suggested',
      (payload) => payload?.roomId === roomId && payload?.fileId === fileId && payload?.code === rejectedCode,
    );

    socketA.emit('code_change', {
      roomId,
      fileId,
      fileKey: fileId,
      previousCode: acceptedCode,
      code: rejectedCode,
      language: 'javascript',
      startLine: 1,
      endLine: 1,
      startColumn: 1,
      endColumn: 18,
      timestamp: Date.now(),
    });

    const suggestion2 = await bSuggested2;
    const aRejected = waitSocketEvent(socketA, 'change_rejected', (payload) => payload?.changeId === suggestion2.changeId);
    const bRejected = waitSocketEvent(socketB, 'change_rejected', (payload) => payload?.changeId === suggestion2.changeId);

    socketB.emit('reject_change', {
      roomId,
      fileId,
      fileKey: fileId,
      changeId: suggestion2.changeId,
      timestamp: Date.now(),
    });

    await Promise.all([aRejected, bRejected]);
    const noCodeUpdateAfterReject = await verifyNoAcceptedUpdateFor(socketA, suggestion2.changeId);

    if (!noCodeUpdateAfterReject) {
      throw new Error('Reject path incorrectly emitted accepted code update for rejected change');
    }

    console.log('[SMOKE] STEP 3 PASS rejected sync received on both users, no accepted update emitted');
    console.log('[SMOKE] RESULT: PASS end-to-end suggestion/accept/reject flow');
  } catch (error) {
    console.error('[SMOKE] RESULT: FAIL', error.message);
    process.exitCode = 1;
  } finally {
    await wait(100);
    if (socketA) socketA.disconnect();
    if (socketB) socketB.disconnect();
  }
})();
