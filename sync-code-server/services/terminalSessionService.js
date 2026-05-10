const path = require('path');
const pty = require('node-pty');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const MAX_COMMAND_LENGTH = 2000;
const COMMAND_TIMEOUT_MS = 120000;
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DONE_PREFIX = '__SYNC_CODE_DONE__';

const sessions = new Map();

const createTerminalError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  error.isTerminalCommandError = true;
  return error;
};

const getShellConfig = () => {
  if (process.platform === 'win32') {
    const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return {
      shell: powershellPath,
      args: ['-NoLogo', '-NoProfile'],
    };
  }

  return {
    shell: process.env.SHELL || '/bin/bash',
    args: ['-i'],
  };
};

const buildWrappedCommand = (command, marker) => {
  if (process.platform === 'win32') {
    const markerBase64 = Buffer.from(marker, 'utf8').toString('base64');
    return `${command}; $syncCodeMarker = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${markerBase64}')); $syncCodeExit = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }; Write-Output ("$syncCodeMarker|{0}|{1}" -f $PWD.Path, $syncCodeExit)`;
  }

  return `${command}; printf "${marker}|%s|%s\\n" "$PWD" "$?"`;
};

const createSession = (sessionKey) => {
  const shellConfig = getShellConfig();
  const ptyProcess = pty.spawn(shellConfig.shell, shellConfig.args, {
    name: 'xterm-color',
    cols: 120,
    rows: 30,
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      TERM: process.env.TERM || 'xterm-256color',
    },
  });

  const session = {
    key: sessionKey,
    pty: ptyProcess,
    cwd: WORKSPACE_ROOT,
    queue: [],
    active: null,
    participants: new Set(),
    lastActiveAt: Date.now(),
  };

  ptyProcess.onData((chunk) => {
    session.lastActiveAt = Date.now();

    if (!session.active) {
      return;
    }

    session.active.buffer += chunk;
    const active = session.active;

    if (active.suppressEcho) {
      const firstLineEnd = active.buffer.indexOf('\n');
      if (firstLineEnd === -1) {
        return;
      }
      active.buffer = active.buffer.slice(firstLineEnd + 1);
      active.suppressEcho = false;
    }

    while (true) {
      const markerStart = active.buffer.indexOf(active.marker);
      if (markerStart === -1) {
        const keep = Math.min(active.marker.length - 1, active.buffer.length);
        const flushLength = active.buffer.length - keep;
        if (flushLength > 0) {
          const flushChunk = active.buffer.slice(0, flushLength);
          active.buffer = active.buffer.slice(flushLength);
          if (flushChunk) {
            active.onOutput('stdout', flushChunk);
          }
        }
        break;
      }

      const markerDataStart = markerStart + active.marker.length;
      if (active.buffer[markerDataStart] !== '|') {
        const flushChunk = active.buffer.slice(0, markerDataStart);
        active.onOutput('stdout', flushChunk);
        active.buffer = active.buffer.slice(markerDataStart);
        continue;
      }

      const cwdSeparator = active.buffer.indexOf('|', markerDataStart + 1);
      if (cwdSeparator === -1) {
        break;
      }

      let cursor = cwdSeparator + 1;
      let exitCodeText = '';
      while (cursor < active.buffer.length) {
        const ch = active.buffer[cursor];
        if (!/[0-9-]/.test(ch)) {
          break;
        }
        exitCodeText += ch;
        cursor += 1;
      }

      if (!exitCodeText) {
        if (cursor >= active.buffer.length) {
          break;
        }

        const flushChunk = active.buffer.slice(0, markerDataStart + 1);
        active.onOutput('stdout', flushChunk);
        active.buffer = active.buffer.slice(markerDataStart + 1);
        continue;
      }

      if (cursor >= active.buffer.length) {
        break;
      }

      const before = active.buffer.slice(0, markerStart);
      if (before) {
        active.onOutput('stdout', before);
      }

      const cwd = active.buffer.slice(markerDataStart + 1, cwdSeparator) || session.cwd;
      const parsedExit = Number.parseInt(exitCodeText, 10);
      const exitCode = Number.isNaN(parsedExit) ? 0 : parsedExit;
      const afterMarker = active.buffer.slice(cursor);
      active.buffer = '';
      session.cwd = cwd;

      if (afterMarker) {
        active.onOutput('stdout', afterMarker);
      }

      clearTimeout(active.timeoutId);
      const resolver = active.resolve;
      session.active = null;
      resolver({ cwd, exitCode });
      processQueue(session);
      break;
    }
  });

  ptyProcess.onExit(() => {
    if (session.active) {
      clearTimeout(session.active.timeoutId);
      const rejecter = session.active.reject;
      session.active = null;
      rejecter(createTerminalError(500, 'Terminal session exited unexpectedly.'));
    }

    while (session.queue.length > 0) {
      const queued = session.queue.shift();
      queued.reject(createTerminalError(500, 'Terminal session exited unexpectedly.'));
    }

    sessions.delete(sessionKey);
  });

  sessions.set(sessionKey, session);
  return session;
};

const getOrCreateSession = (sessionKey) => sessions.get(sessionKey) || createSession(sessionKey);

const processQueue = (session) => {
  if (session.active || session.queue.length === 0) {
    return;
  }

  const next = session.queue.shift();
  const marker = `${DONE_PREFIX}_${next.requestId}_${Date.now()}`;
  const wrappedCommand = buildWrappedCommand(next.command, marker);
  const timeoutId = setTimeout(() => {
    if (!session.active || session.active.requestId !== next.requestId) {
      return;
    }

    session.pty.write('\u0003');
    const rejecter = session.active.reject;
    session.active = null;
    rejecter(createTerminalError(408, `Command timed out after ${COMMAND_TIMEOUT_MS}ms.`));
    processQueue(session);
  }, COMMAND_TIMEOUT_MS);

  session.active = {
    requestId: next.requestId,
    marker,
    onOutput: next.onOutput,
    resolve: next.resolve,
    reject: next.reject,
    timeoutId,
    buffer: '',
    suppressEcho: true,
  };

  session.lastActiveAt = Date.now();
  next.onStart();
  session.pty.write(`${wrappedCommand}\r`);
};

const executeTerminalCommandInSession = ({ sessionKey, requestId, command, onStart, onOutput }) => {
  const normalized = String(command || '').trim();
  if (!normalized) {
    throw createTerminalError(400, 'Command is required.');
  }

  if (normalized.length > MAX_COMMAND_LENGTH) {
    throw createTerminalError(400, `Command exceeds ${MAX_COMMAND_LENGTH} characters.`);
  }

  const session = getOrCreateSession(sessionKey);
  session.lastActiveAt = Date.now();

  return new Promise((resolve, reject) => {
    session.queue.push({
      requestId,
      command: normalized,
      onStart: typeof onStart === 'function' ? onStart : () => {},
      onOutput: typeof onOutput === 'function' ? onOutput : () => {},
      resolve,
      reject,
    });

    processQueue(session);
  });
};

const buildTerminalSessionKey = ({ roomId, userId, socketId }) => {
  if (roomId) {
    return `room:${String(roomId)}`;
  }

  if (userId) {
    return `user:${String(userId)}`;
  }

  return `socket:${String(socketId || 'anonymous')}`;
};

const addTerminalParticipant = (sessionKey, socketId) => {
  const session = getOrCreateSession(sessionKey);
  session.participants.add(String(socketId));
  session.lastActiveAt = Date.now();
};

const removeTerminalParticipantBySocket = (socketId) => {
  const normalizedSocketId = String(socketId || '');
  if (!normalizedSocketId) {
    return;
  }

  for (const session of sessions.values()) {
    if (session.participants.delete(normalizedSocketId)) {
      session.lastActiveAt = Date.now();
    }
  }
};

const destroySession = (sessionKey) => {
  const session = sessions.get(sessionKey);
  if (!session) {
    return;
  }

  if (session.active) {
    clearTimeout(session.active.timeoutId);
    session.active.reject(createTerminalError(499, 'Terminal session closed.'));
    session.active = null;
  }

  while (session.queue.length > 0) {
    const queued = session.queue.shift();
    queued.reject(createTerminalError(499, 'Terminal session closed.'));
  }

  session.pty.kill();
  sessions.delete(sessionKey);
};

setInterval(() => {
  const now = Date.now();
  for (const [sessionKey, session] of sessions.entries()) {
    if (session.participants.size > 0) {
      continue;
    }

    if (now - session.lastActiveAt > SESSION_IDLE_TIMEOUT_MS) {
      destroySession(sessionKey);
    }
  }
}, 60000).unref();

module.exports = {
  buildTerminalSessionKey,
  executeTerminalCommandInSession,
  addTerminalParticipant,
  removeTerminalParticipantBySocket,
  createTerminalError,
};
