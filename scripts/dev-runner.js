const { spawn } = require('child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const RESTART_DELAY_MS = 1200;
const MAX_RESTARTS_PER_PROCESS = 10;

const managed = new Map();
let shuttingDown = false;

function stopChild(name) {
  const state = managed.get(name);
  if (!state || !state.child) {
    return;
  }

  const child = state.child;
  state.child = null;

  if (!child.killed) {
    child.kill('SIGINT');
  }
}

function spawnManaged(name, args) {
  const state = managed.get(name) || { child: null, restarts: 0, timer: null };

  const child = spawn(npmCommand, args, {
    // Use shell mode on Windows to avoid spawn EINVAL for npm.cmd in some environments.
    shell: process.platform === 'win32',
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  state.child = child;
  managed.set(name, state);

  child.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.log(`[${name}] exited with ${reason}`);
    state.child = null;

    if (shuttingDown) {
      return;
    }

    if (code === 0) {
      return;
    }

    state.restarts += 1;
    if (state.restarts > MAX_RESTARTS_PER_PROCESS) {
      console.error(`[${name}] exceeded max restart attempts (${MAX_RESTARTS_PER_PROCESS}).`);
      return;
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      console.log(`[${name}] restarting (${state.restarts}/${MAX_RESTARTS_PER_PROCESS})...`);
      spawnManaged(name, args);
    }, RESTART_DELAY_MS);
  });

  child.on('error', (error) => {
    console.error(`[${name}] failed to start:`, error.message);
  });
}

function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  managed.forEach((state, name) => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    stopChild(name);
  });

  setTimeout(() => {
    process.exit(0);
  }, 150);
}

spawnManaged('server', ['--prefix', './sync-code-server', 'start']);
spawnManaged('client', ['--prefix', './sync-code-client', 'start']);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
