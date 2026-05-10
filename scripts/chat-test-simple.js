const path = require('path');
const socketIoClient = require(path.join(__dirname, '..', 'sync-code-client', 'node_modules', 'socket.io-client'));

const API_BASE = 'http://localhost:5001/api';
const SOCKET_URL = 'http://localhost:5001';
const PASSWORD = 'Test@123456';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function login(prefix) {
  const email = `${prefix.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@demo.local`;
  const name = `${prefix}_${Math.random().toString(36).slice(2, 5)}`;

  try {
    await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: PASSWORD }),
    });
  } catch (e) {}

  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await res.json();
  return { name, token: data.token, userId: data.user.id };
}

async function test() {
  console.log('[CHAT-SMOKE] Chat sender identification test\n');

  try {
    console.log('[1] Logging in users...');
    const alice = await login('Alice');
    const bob = await login('Bob');
    console.log(`✓ Alice (${alice.userId})`);
    console.log(`✓ Bob (${bob.userId})\n`);

    const roomId = 'test-room-' + Date.now();
    const messages = [];

    console.log('[2] Connecting to socket...');
    const s1 = socketIoClient(SOCKET_URL, { auth: { token: alice.token } });
    const s2 = socketIoClient(SOCKET_URL, { auth: { token: bob.token } });

    s1.on('receive_message', (msg) => {
      messages.push({ receiver: 'Alice', sender: msg.sender, senderId: msg.senderId, aliceId: alice.userId });
    });
    s2.on('receive_message', (msg) => {
      messages.push({ receiver: 'Bob', sender: msg.sender, senderId: msg.senderId, bobId: bob.userId });
    });

    await new Promise(resolve => {
      let n = 0;
      s1.on('connect', () => { n++; if (n === 2) resolve(); });
      s2.on('connect', () => { n++; if (n === 2) resolve(); });
      setTimeout(resolve, 4000);
    });
    console.log('✓ Connected\n');

    console.log('[3] Joining room and sending messages...');
    s1.emit('join-room', { roomId });
    s2.emit('join-room', { roomId });
    await wait(300);

    s1.emit('chat-message', { roomId, message: 'Hi from Alice', messageType: 'text' });
    console.log('✓ Alice sent message');
    await wait(600);

    s2.emit('chat-message', { roomId, message: 'Hi from Bob', messageType: 'text' });
    console.log('✓ Bob sent message');
    await wait(1200);

    console.log('\n[4] Validating sender names...\n');
    let pass = 0, fail = 0;

    messages.forEach(m => {
      console.log(`[${m.receiver}] Received from "${m.sender}"`);
      
      if (m.receiver === 'Alice') {
        if (m.sender === bob.name) {
          console.log(`  ✓ Correct (Bob's name = ${bob.name})`);
          pass++;
        } else if (m.sender === 'You') {
          console.log(`  ✗ FAIL: Shows "You" instead of Bob's name`);
          fail++;
        } else {
          console.log(`  ✗ Unexpected: ${m.sender}`);
        }
      } else if (m.receiver === 'Bob') {
        if (m.sender === alice.name) {
          console.log(`  ✓ Correct (Alice's name = ${alice.name})`);
          pass++;
        } else if (m.sender === 'You') {
          console.log(`  ✗ FAIL: Shows "You" instead of Alice's name`);
          fail++;
        } else {
          console.log(`  ✗ Unexpected: ${m.sender}`);
        }
      }
    });

    console.log('\n' + '='.repeat(50));
    if (fail === 0 && pass > 0) {
      console.log('✓ PASS: Sender names correctly identified');
    } else {
      console.log('✗ FAIL: Issues found');
      console.log(`Passed: ${pass}, Failed: ${fail}`);
    }
    console.log('='.repeat(50));

    s1.disconnect();
    s2.disconnect();
    process.exit(fail > 0 ? 1 : 0);

  } catch (error) {
    console.error('✗ Error:', error.message);
    process.exit(1);
  }
}

test();
