const { spawn } = require('child_process');

const DEFAULT_CACHE_TTL_MS = Number.parseInt(process.env.RUNTIME_CHECK_CACHE_TTL_MS || '60000', 10);

const RUNTIME_REQUIREMENTS = {
  javascript: {
    languageLabel: 'JavaScript',
    command: 'node',
    args: ['-v'],
    missingMessage: 'Node.js is not installed on the server. Please install Node.js to run this code.',
  },
  python: {
    languageLabel: 'Python',
    command: 'python3',
    args: ['--version'],
    missingMessage: 'Python is not installed on the server. Please install Python to run this code.',
  },
  cpp: {
    languageLabel: 'C++',
    command: 'g++',
    args: ['--version'],
    missingMessage: 'C++ compiler (g++) not found on the server. Please install g++ to run this code.',
  },
  java: {
    languageLabel: 'Java',
    command: 'javac',
    args: ['-version'],
    missingMessage: 'Java compiler (javac) missing on the server. Please install JDK to run this code.',
  },
};

const runtimeCache = new Map();

const runVersionCommand = (command, args) => new Promise((resolve) => {
  const child = spawn(command, args, { windowsHide: true });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const finish = (result) => {
    if (settled) {
      return;
    }
    settled = true;
    resolve(result);
  };

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.on('error', () => {
    finish({ installed: false, code: null, stdout, stderr });
  });

  child.on('close', (code) => {
    const combined = `${stdout}\n${stderr}`.toLowerCase();
    const hasWindowsStoreAliasMessage = combined.includes('python was not found');
    const installed = code === 0 && !hasWindowsStoreAliasMessage;
    finish({ installed, code, stdout, stderr });
  });
});

const parseVersion = ({ stdout, stderr }) => {
  const raw = String(stdout || stderr || '').trim();
  if (!raw) {
    return '';
  }
  return raw.split(/\r?\n/)[0].trim();
};

const getRequirement = (language) => RUNTIME_REQUIREMENTS[language] || null;

const getCacheKey = (language) => `runtime:${language}`;

const checkRuntimeForLanguage = async (language) => {
  const requirement = getRequirement(language);
  if (!requirement) {
    return {
      installed: true,
      command: '',
      version: '',
      message: '',
    };
  }

  const cacheKey = getCacheKey(language);
  const cached = runtimeCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.checkedAt < DEFAULT_CACHE_TTL_MS) {
    return cached.result;
  }

  const probe = await runVersionCommand(requirement.command, requirement.args);
  const result = {
    installed: probe.installed,
    command: requirement.command,
    version: parseVersion(probe),
    message: probe.installed ? '' : requirement.missingMessage,
  };

  runtimeCache.set(cacheKey, {
    checkedAt: now,
    result,
  });

  return result;
};

module.exports = {
  checkRuntimeForLanguage,
};
