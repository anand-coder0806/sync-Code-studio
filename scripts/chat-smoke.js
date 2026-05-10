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

  return { email, name, token: login.token, user: login.user };
};

const runChatSmokeTest = async () => {
  console.log('[CHAT-SMOKE] Starting chat sender identification test...\n');

  try {
    // Step 1: Login two users
    console.log('[CHAT-SMOKE] Step 1: Logging in User1 and User2...');
    const user1 = await ensureLogin('Alice');
    const user2 = await ensureLogin('Bob');
    console.log('[CHAT-SMOKE] ✓ User1:', user1.name, `(${user1.email})`);
    console.log('[CHAT-SMOKE] ✓ User2:', user2.name, `(${user2.email})\n`);

    // Step 2: Create a room
    console.log('[CHAT-SMOKE] Step 2: Creating a collaboration room...');
    const roomRes = await requestJson(`${API_BASE}/projects/room`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user1.token}` },
      body: JSON.stringify({ name: 'Chat Test Room' }),
    });
    const roomId = roomRes.roomId || roomRes.id;
    console.log('[CHAT-SMOKE] ✓ Room created:', roomId, '\n');

    // Step 3: Connect both users via socket
    console.log('[CHAT-SMOKE] Step 3: Connecting both users to room via socket...');
    
    const messages = [];
    let user1Connected = false;
    let user2Connected = false;

    const user1Socket = io(SOCKET_URL, {
      reconnection: true,
      auth: { token: user1.token },
    });

    const user2Socket = io(SOCKET_URL, {
      reconnection: true,
      auth: { token: user2.token },
    });

    // Listen for messages from user2 perspective
    user2Socket.on('receive_message', (payload) => {
      console.log('[CHAT-SMOKE] User2 received message:');
      console.log('  - Message ID:', payload.id);
      console.log('  - Sender ID:', payload.senderId);
      console.log('  - Sender Name:', payload.sender);
      console.log('  - Content:', payload.message);
      messages.push({ from: 'user2', payload });
    });

    // Listen for messages from user1 perspective
    user1Socket.on('receive_message', (payload) => {
      console.log('[CHAT-SMOKE] User1 received message:');
      console.log('  - Message ID:', payload.id);
      console.log('  - Sender ID:', payload.senderId);
      console.log('  - Sender Name:', payload.sender);
      console.log('  - Content:', payload.message);
      messages.push({ from: 'user1', payload });
    });

    // Wait for connections
    await new Promise((resolve) => {
      user1Socket.on('connect', () => {
        user1Connected = true;
        console.log('[CHAT-SMOKE] ✓ User1 socket connected');
        if (user1Connected && user2Connected) resolve();
      });

      user2Socket.on('connect', () => {
        user2Connected = true;
        console.log('[CHAT-SMOKE] ✓ User2 socket connected');
        if (user1Connected && user2Connected) resolve();
      });

      setTimeout(resolve, 5000);
    });

    console.log();

    // Step 4: Join room
    console.log('[CHAT-SMOKE] Step 4: Joining room...');
    user1Socket.emit('join-room', { roomId });
    user2Socket.emit('join-room', { roomId });
    await wait(500);
    console.log('[CHAT-SMOKE] ✓ Both users joined room\n');

    // Step 5: Send messages
    console.log('[CHAT-SMOKE] Step 5: Sending chat messages...');
    
    user1Socket.emit('chat-message', {
      roomId,
      message: 'Hello from User1',
      messageType: 'text',
    });
    console.log('[CHAT-SMOKE] ✓ User1 sent message');

    await wait(800);

    user2Socket.emit('chat-message', {
      roomId,
      message: 'Reply from User2',
      messageType: 'text',
    });
    console.log('[CHAT-SMOKE] ✓ User2 sent message');

    await wait(1000);

    // Step 6: Verify message ownership
    console.log('\n[CHAT-SMOKE] Step 6: Verifying sender identification...');
    
    let passedTests = 0;
    let failedTests = 0;

    // Check received messages
    const user2Received = messages.filter((m) => m.from === 'user2');
    const user1Received = messages.filter((m) => m.from === 'user1');

    console.log(`\n[CHAT-SMOKE] Messages received by User2: ${user2Received.length}`);
    user2Received.forEach((m) => {
      const payload = m.payload;
      console.log(`  - Sender: "${payload.sender}" | Sender ID: ${payload.senderId}`);
      
      // Verify sender name is NOT "User2" (it's from someone else)
      if (payload.sender !== user2.name && payload.sender !== 'You') {
        console.log('    ✓ Correctly shows other user name (not receiver)');
        passedTests += 1;
      } else if (payload.sender === user1.name) {
        console.log('    ✓ Correctly identifies as User1');
        passedTests += 1;
      } else {
        console.log('    ✗ FAIL: Sender shown as ', payload.sender);
        failedTests += 1;
      }
    });

    console.log(`\n[CHAT-SMOKE] Messages received by User1: ${user1Received.length}`);
    user1Received.forEach((m) => {
      const payload = m.payload;
      console.log(`  - Sender: "${payload.sender}" | Sender ID: ${payload.senderId}`);
      
      // Verify sender name is NOT "User1" (it's from someone else)
      if (payload.sender !== user1.name && payload.sender !== 'You') {
        console.log('    ✓ Correctly shows other user name (not receiver)');
        passedTests += 1;
      } else if (payload.sender === user2.name) {
        console.log('    ✓ Correctly identifies as User2');
        passedTests += 1;
      } else {
        console.log('    ✗ FAIL: Sender shown as ', payload.sender);
        failedTests += 1;
      }
    });

    // Final verdict
    console.log('\n' + '='.repeat(60));
    if (failedTests === 0 && passedTests > 0) {
      console.log('[CHAT-SMOKE] ✓ RESULT: PASS');
      console.log(`[CHAT-SMOKE] All ${passedTests} sender identification checks passed`);
      console.log('[CHAT-SMOKE] Sender names correctly displayed (not all "You")');
    } else {
      console.log('[CHAT-SMOKE] ✗ RESULT: FAIL');
      console.log(`[CHAT-SMOKE] Passed: ${passedTests}, Failed: ${failedTests}`);
    }
    console.log('='.repeat(60) + '\n');

    user1Socket.disconnect();
    user2Socket.disconnect();
    process.exit(failedTests > 0 ? 1 : 0);
  } catch (error) {
    console.error('[CHAT-SMOKE] ✗ RESULT: FAIL', error.message);
    console.error(error.stack);
    process.exit(1);
  }
};

runChatSmokeTest();
