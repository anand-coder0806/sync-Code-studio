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
    console.log(`[OWNER_APPROVAL_TEST] ${label} connected`, socket.id);
    resolve(socket);
  });

  socket.on('connect_error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

(async () => {
  let socketOwner;
  let socketCollab;
  try {
    console.log('[OWNER_APPROVAL_TEST] ========== STARTING OWNER APPROVAL SYSTEM TEST ==========');
    console.log('[OWNER_APPROVAL_TEST] Ensuring two users...');
    const [owner, collab] = await Promise.all([ensureLogin('Owner'), ensureLogin('Collab')]);

    console.log('[OWNER_APPROVAL_TEST] Connecting sockets...');
    socketOwner = await connectSocket(owner.token, 'OWNER');
    socketCollab = await connectSocket(collab.token, 'COLLAB');

    const roomId = `owner-approval-${Date.now()}`;
    const fileId = 'test-file';
    const initialCode = 'function hello() {\n  return "world";\n}\n';

    console.log('[OWNER_APPROVAL_TEST] Joining room/file (Owner first)...');
    socketOwner.emit('join-room', {
      roomId,
      userId: owner.user.id,
      userName: owner.user.name,
      fileId,
      code: initialCode,
      language: 'javascript',
    });

    await waitSocketEvent(socketOwner, 'room-joined', (payload) => payload?.roomId === roomId);
    console.log('[OWNER_APPROVAL_TEST] ✓ Owner joined room (now ROOM HOST)');

    console.log('[OWNER_APPROVAL_TEST] Joining room/file (Collaborator)...');
    socketCollab.emit('join-room', {
      roomId,
      userId: collab.user.id,
      userName: collab.user.name,
      fileId,
      code: initialCode,
      language: 'javascript',
    });

    await waitSocketEvent(socketCollab, 'room-joined', (payload) => payload?.roomId === roomId);
    console.log('[OWNER_APPROVAL_TEST] ✓ Collaborator joined room');

    console.log('\n[OWNER_APPROVAL_TEST] ========== TEST 1: COLLABORATOR SENDS CHANGE REQUEST ==========');
    const collabCode = 'function hello() {\n  return "world updated";\n}\n';

    const ownerReceivesRequest = waitSocketEvent(
      socketOwner,
      'change_request',
      (payload) => payload?.roomId === roomId && payload?.fileId === fileId,
    );

    const collabReceivesAck = waitSocketEvent(
      socketCollab,
      'change_request_sent',
      (payload) => payload?.roomId === roomId && payload?.fileId === fileId,
    );

    console.log('[OWNER_APPROVAL_TEST] Collaborator emitting change_request...');
    socketCollab.emit('change_request', {
      roomId,
      fileId,
      fileKey: fileId,
      previousCode: initialCode,
      code: collabCode,
      language: 'javascript',
      startLine: 2,
      endLine: 2,
      startColumn: 13,
      endColumn: 20,
      timestamp: Date.now(),
    });

    const requestPayload = await ownerReceivesRequest;
    const ackPayload = await collabReceivesAck;

    console.log(`[OWNER_APPROVAL_TEST] ✓ Owner received 'change_request' (changeId: ${requestPayload.changeId})`);
    console.log(`[OWNER_APPROVAL_TEST] ✓ Collaborator received 'change_request_sent' acknowledgement`);
    const changeId = requestPayload.changeId;

    console.log('\n[OWNER_APPROVAL_TEST] ========== TEST 2: OWNER APPROVES CHANGE ==========');
    const ownerReceivesApproval = waitSocketEvent(
      socketOwner,
      'change_approved',
      (payload) => payload?.changeId === changeId,
    );

    const collabReceivesApproval = waitSocketEvent(
      socketCollab,
      'change_approved',
      (payload) => payload?.changeId === changeId,
    );

    const ownerReceivesCodeUpdate = waitSocketEvent(
      socketOwner,
      'code-update',
      (payload) => payload?.changeId === changeId && payload?.code === collabCode,
    );

    const collabReceivesCodeUpdate = waitSocketEvent(
      socketCollab,
      'code-update',
      (payload) => payload?.changeId === changeId && payload?.code === collabCode,
    );

    console.log('[OWNER_APPROVAL_TEST] Owner emitting approve_change...');
    socketOwner.emit('approve_change', {
      roomId,
      fileId,
      fileKey: fileId,
      changeId,
      timestamp: Date.now(),
    });

    await Promise.all([ownerReceivesApproval, collabReceivesApproval, ownerReceivesCodeUpdate, collabReceivesCodeUpdate]);
    console.log(`[OWNER_APPROVAL_TEST] ✓ Both users received 'change_approved' event`);
    console.log(`[OWNER_APPROVAL_TEST] ✓ Both users received 'code-update' with new code`);

    console.log('\n[OWNER_APPROVAL_TEST] ========== TEST 3: SECOND CHANGE REQUEST & REJECTION ==========');
    const collabCode2 = 'function hello() {\n  return "final version";\n}\n';

    const ownerReceivesRequest2 = waitSocketEvent(
      socketOwner,
      'change_request',
      (payload) => payload?.roomId === roomId && payload?.fileId === fileId && payload?.code === collabCode2,
    );

    const collabReceivesAck2 = waitSocketEvent(
      socketCollab,
      'change_request_sent',
      (payload) => payload?.roomId === roomId && payload?.fileId === fileId,
    );

    console.log('[OWNER_APPROVAL_TEST] Collaborator emitting second change_request...');
    socketCollab.emit('change_request', {
      roomId,
      fileId,
      fileKey: fileId,
      previousCode: collabCode,
      code: collabCode2,
      language: 'javascript',
      startLine: 2,
      endLine: 2,
      startColumn: 13,
      endColumn: 25,
      timestamp: Date.now(),
    });

    const requestPayload2 = await ownerReceivesRequest2;
    await collabReceivesAck2;
    const changeId2 = requestPayload2.changeId;
    console.log(`[OWNER_APPROVAL_TEST] ✓ Owner received second 'change_request' (changeId: ${changeId2})`);

    const ownerReceivesRejection = waitSocketEvent(
      socketOwner,
      'change_rejected',
      (payload) => payload?.changeId === changeId2,
    );

    const collabReceivesRejection = waitSocketEvent(
      socketCollab,
      'change_rejected',
      (payload) => payload?.changeId === changeId2,
    );

    console.log('[OWNER_APPROVAL_TEST] Owner emitting reject_change...');
    socketOwner.emit('reject_change', {
      roomId,
      fileId,
      fileKey: fileId,
      changeId: changeId2,
      timestamp: Date.now(),
    });

    await Promise.all([ownerReceivesRejection, collabReceivesRejection]);
    console.log(`[OWNER_APPROVAL_TEST] ✓ Both users received 'change_rejected' event`);

    // Verify that NO code-update is emitted for rejected change
    let rejectionCodeUpdateTriggered = false;
    const onCodeUpdate = () => {
      rejectionCodeUpdateTriggered = true;
    };
    socketOwner.on('code-update', onCodeUpdate);
    await wait(1500);
    socketOwner.off('code-update', onCodeUpdate);

    if (rejectionCodeUpdateTriggered) {
      throw new Error('ERROR: Code update was incorrectly emitted for rejected change!');
    }
    console.log(`[OWNER_APPROVAL_TEST] ✓ Verified: NO code-update emitted for rejected change (code remains unchanged)`);

    console.log('\n[OWNER_APPROVAL_TEST] ========== TEST 4: VERIFY BACKWARD COMPATIBILITY ==========');
    const ownerReceivesOldStyle = waitSocketEvent(
      socketOwner,
      'change_request',
      (payload) => payload?.roomId === roomId && payload?.fileId === fileId,
    );

    console.log('[OWNER_APPROVAL_TEST] Collaborator emitting OLD EVENT: code_change (maps to change_request)...');
    socketCollab.emit('code_change', {
      roomId,
      fileId,
      fileKey: fileId,
      previousCode: collabCode,
      code: 'const x = 1;',
      language: 'javascript',
      startLine: 1,
      endLine: 1,
      startColumn: 1,
      endColumn: 10,
      timestamp: Date.now(),
    });

    await ownerReceivesOldStyle;
    console.log(`[OWNER_APPROVAL_TEST] ✓ Owner receives 'change_request' (server routes code_change as change_request)`);

    console.log('\n[OWNER_APPROVAL_TEST] ========== FINAL RESULT: ✅ ALL TESTS PASSED ==========');
    console.log('[OWNER_APPROVAL_TEST] Owner Approval System is working correctly!\n');
  } catch (error) {
    console.error('\n[OWNER_APPROVAL_TEST] ========== FINAL RESULT: ❌ TEST FAILED ==========');
    console.error('[OWNER_APPROVAL_TEST] Error:', error.message);
    process.exitCode = 1;
  } finally {
    await wait(100);
    if (socketOwner) socketOwner.disconnect();
    if (socketCollab) socketCollab.disconnect();
  }
})();
