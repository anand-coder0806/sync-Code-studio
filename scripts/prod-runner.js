const { spawn } = require('child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const isWindows = process.platform === 'win32';

let serverChild = null;
let clientChild = null;
let shuttingDown = false;

function spawnProcess(name, args, extraEnv = {}) {
  const child = spawn(npmCommand, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: isWindows,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  child.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.log(`[${name}] exited with ${reason}`);

    if (!shuttingDown) {
      console.error(`[${name}] exited unexpectedly. Stopping production runner.`);
      shutdown(code || 1);
    }
  });

  child.on('error', (error) => {
    console.error(`[${name}] failed to start:`, error.message);
    if (!shuttingDown) {
      shutdown(1);
    }
  });

  return child;
}

function stopChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGINT');
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  stopChild(serverChild);
  stopChild(clientChild);

  setTimeout(() => process.exit(code), 250);
}

const serverPort = process.env.SERVER_PORT || process.env.PORT || '5001';
const clientPort = process.env.CLIENT_PORT || '3000';

serverChild = spawnProcess('server', ['--prefix', './sync-code-server', 'start'], {
  PORT: serverPort,
});

clientChild = spawnProcess('client', ['--prefix', './sync-code-client', 'start'], {
  PORT: clientPort,
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
