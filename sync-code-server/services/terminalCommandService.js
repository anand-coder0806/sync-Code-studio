const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const MAX_FILE_READ_SIZE = 65536;
const MAX_COMMAND_LENGTH = 300;
const MAX_TERMINAL_EXEC_MS = 12000;
const ALLOWED_NPM_RUN_SCRIPTS = new Set(['dev', 'start', 'build', 'test', 'lint']);

const createTerminalError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  error.isTerminalCommandError = true;
  return error;
};

const splitCommand = (raw) => {
  const matches = String(raw || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ''));
};

const resolveSafePath = (relativePath = '.') => {
  const candidate = path.resolve(WORKSPACE_ROOT, relativePath);
  if (!candidate.startsWith(WORKSPACE_ROOT)) {
    throw createTerminalError(403, 'Access outside workspace is not allowed.');
  }
  return candidate;
};

const listDirectory = async (relativePath) => {
  const target = resolveSafePath(relativePath || '.');
  const entries = await fs.readdir(target, { withFileTypes: true });
  const rows = entries
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    })
    .map((entry) => `${entry.isDirectory() ? '[DIR] ' : '[FILE]'} ${entry.name}`);

  return {
    output: rows.join('\n') || '(empty directory)',
    cwd: target,
  };
};

const readFileContent = async (relativePath) => {
  if (!relativePath) {
    throw createTerminalError(400, 'Usage: cat <relative-file-path>');
  }

  const target = resolveSafePath(relativePath);
  const stat = await fs.stat(target);

  if (!stat.isFile()) {
    throw createTerminalError(400, 'Target path is not a file.');
  }

  if (stat.size > MAX_FILE_READ_SIZE) {
    throw createTerminalError(413, `File is too large to print (>${MAX_FILE_READ_SIZE} bytes).`);
  }

  const output = await fs.readFile(target, 'utf8');
  return {
    output,
    cwd: path.dirname(target),
  };
};

const executeChild = (command, args = [], onChunk) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: WORKSPACE_ROOT,
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, MAX_TERMINAL_EXEC_MS);

  child.stdout.on('data', (chunk) => {
    const value = chunk.toString('utf8');
    stdout += value;
    if (typeof onChunk === 'function') {
      onChunk('stdout', value);
    }
  });

  child.stderr.on('data', (chunk) => {
    const value = chunk.toString('utf8');
    stderr += value;
    if (typeof onChunk === 'function') {
      onChunk('stderr', value);
    }
  });

  child.on('error', (error) => {
    clearTimeout(timeout);
    reject(createTerminalError(500, `Failed to run ${command}: ${error.message}`));
  });

  child.on('close', (code) => {
    clearTimeout(timeout);
    if (timedOut) {
      reject(createTerminalError(408, `Command timed out after ${MAX_TERMINAL_EXEC_MS}ms.`));
      return;
    }

    if (code !== 0) {
      reject(createTerminalError(400, stderr.trim() || `${command} failed with exit code ${code}.`));
      return;
    }

    resolve({
      output: stdout.trim(),
      cwd: WORKSPACE_ROOT,
    });
  });
});

const executeTerminalCommand = async (rawCommand) => {
  const command = String(rawCommand || '').trim();
  if (!command) {
    throw createTerminalError(400, 'Command is required.');
  }

  if (command.length > MAX_COMMAND_LENGTH) {
    throw createTerminalError(400, `Command exceeds ${MAX_COMMAND_LENGTH} characters.`);
  }

  const [base, ...args] = splitCommand(command);
  const lower = String(base || '').toLowerCase();

  if (lower === 'help') {
    return {
      output: [
        'Allowed commands:',
        '  help',
        '  pwd',
        '  ls [path]',
        '  dir [path]',
        '  cat <file>',
        '  type <file>',
        '  echo <text>',
        '  node -v',
        '  npm -v',
      ].join('\n'),
      cwd: WORKSPACE_ROOT,
    };
  }

  if (lower === 'pwd') {
    return {
      output: WORKSPACE_ROOT,
      cwd: WORKSPACE_ROOT,
    };
  }

  if (lower === 'ls' || lower === 'dir') {
    return listDirectory(args[0] || '.');
  }

  if (lower === 'cat' || lower === 'type') {
    return readFileContent(args[0]);
  }

  if (lower === 'echo') {
    return {
      output: args.join(' '),
      cwd: WORKSPACE_ROOT,
    };
  }

  if (lower === 'node' && args.length === 1 && args[0] === '-v') {
    return executeChild(process.execPath, ['-v']);
  }

  if (lower === 'npm' && args.length === 1 && args[0] === '-v') {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return executeChild(npmCommand, ['-v']);
  }

  if (lower === 'npm' && args[0] === 'run' && args[1] && ALLOWED_NPM_RUN_SCRIPTS.has(args[1])) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return executeChild(npmCommand, ['run', args[1]]);
  }

  throw createTerminalError(400, `Command not allowed: ${base}`);
};

const executeTerminalCommandStreaming = async (rawCommand, onChunk) => {
  const command = String(rawCommand || '').trim();
  if (!command) {
    throw createTerminalError(400, 'Command is required.');
  }

  if (command.length > MAX_COMMAND_LENGTH) {
    throw createTerminalError(400, `Command exceeds ${MAX_COMMAND_LENGTH} characters.`);
  }

  const [base, ...args] = splitCommand(command);
  const lower = String(base || '').toLowerCase();

  if (lower === 'node' && args.length === 1 && args[0] === '-v') {
    return executeChild(process.execPath, ['-v'], onChunk);
  }

  if (lower === 'npm' && args.length === 1 && args[0] === '-v') {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return executeChild(npmCommand, ['-v'], onChunk);
  }

  if (lower === 'npm' && args[0] === 'run' && args[1] && ALLOWED_NPM_RUN_SCRIPTS.has(args[1])) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return executeChild(npmCommand, ['run', args[1]], onChunk);
  }

  const result = await executeTerminalCommand(command);
  if (typeof onChunk === 'function' && result?.output) {
    onChunk('stdout', `${result.output}\n`);
  }
  return result;
};

module.exports = {
  executeTerminalCommand,
  executeTerminalCommandStreaming,
  createTerminalError,
};
