const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { checkRuntimeForLanguage } = require('./environmentChecker');

const MAX_CODE_LENGTH = 100000;
const MAX_INPUT_LENGTH = 20000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_COMPILE_TIMEOUT_MS = 10000;
const MAX_OUTPUT_LENGTH = 100000;

const LANGUAGE_CONFIG = {
  javascript: {
    aliases: ['javascript', 'js', 'node', 'nodejs'],
    fileName: 'main.js',
    dockerImage: 'node:20-alpine',
    dockerCommand: (filePath) => ['node', filePath],
  },
  python: {
    aliases: ['python', 'py', 'python3'],
    fileName: 'main.py',
    dockerImage: 'python:3.12-alpine',
    dockerCommand: (filePath) => ['python3', filePath],
  },
  cpp: {
    aliases: ['cpp', 'c++', 'cc', 'cxx'],
    fileName: 'main.cpp',
    dockerImage: 'gcc:13',
    dockerCommand: (filePath) => ['sh', '-lc', `set -e; g++ '${filePath}' -O2 -std=c++17 -o /tmp/sync-code-app && /tmp/sync-code-app`],
  },
  java: {
    aliases: ['java'],
    fileName: 'Main.java',
    dockerImage: 'eclipse-temurin:21-jdk',
    dockerCommand: (filePath) => {
      const className = path.basename(filePath, path.extname(filePath));
      return ['sh', '-lc', `set -e; mkdir -p /tmp/out; javac -d /tmp/out '${filePath}' && java -cp /tmp/out ${className}`];
    },
  },
};

const languageLabel = (language) => {
  const labels = {
    javascript: 'JavaScript',
    python: 'Python',
    cpp: 'C++',
    java: 'Java',
  };
  return labels[language] || language;
};

const normalizeLanguage = (language) => {
  const raw = String(language || '').trim().toLowerCase();
  return Object.keys(LANGUAGE_CONFIG).find((key) => LANGUAGE_CONFIG[key].aliases.includes(raw)) || null;
};

const normalizeOutput = (text) => String(text || '').replace(/\r\n/g, '\n').trimEnd();

const mergeOutput = (...parts) => parts
  .map(normalizeOutput)
  .filter(Boolean)
  .join('\n');

const createExecutionError = (status, errorType, message, details = {}) => {
  const error = new Error(message);
  error.status = status;
  error.errorType = errorType;
  error.details = details;
  error.isExecutionError = true;
  return error;
};

const runProcess = (command, args, options = {}) => new Promise((resolve, reject) => {
  const {
    cwd,
    input = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputLength = MAX_OUTPUT_LENGTH,
    env,
    onData, // Callback for streaming output
  } = options;

  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  let timer;

  const appendChunk = (base, chunk) => {
    const next = base + chunk.toString('utf8');
    if (next.length > maxOutputLength) {
      throw createExecutionError(413, 'RUNTIME_ERROR', `Execution output exceeded ${maxOutputLength} characters.`);
    }
    return next;
  };

  const finish = (err, payload) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timer);

    if (err) {
      reject(err);
      return;
    }

    resolve(payload);
  };

  child.stdout.on('data', (chunk) => {
    try {
      stdout = appendChunk(stdout, chunk);
      if (onData) {
        onData('stdout', chunk.toString('utf8'));
      }
    } catch (error) {
      child.kill('SIGKILL');
      finish(error);
    }
  });

  child.stderr.on('data', (chunk) => {
    try {
      stderr = appendChunk(stderr, chunk);
      if (onData) {
        onData('stderr', chunk.toString('utf8'));
      }
    } catch (error) {
      child.kill('SIGKILL');
      finish(error);
    }
  });

  child.on('error', (error) => {
    finish(error);
  });

  child.on('close', (code, signal) => {
    if (timedOut) {
      finish(createExecutionError(408, 'TIMEOUT_ERROR', `Execution timed out after ${timeoutMs}ms.`));
      return;
    }

    finish(null, {
      code: typeof code === 'number' ? code : signal ? 1 : 0,
      signal,
      stdout,
      stderr,
    });
  });

  child.stdin.end(String(input || ''));

  timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
});

const getRunnerProvider = () => {
  const provider = String(process.env.CODE_RUNNER_PROVIDER || 'auto').trim().toLowerCase();
  return ['auto', 'docker', 'local'].includes(provider) ? provider : 'auto';
};

const isDockerDaemonReady = async () => {
  try {
    const result = await runProcess('docker', ['info'], { timeoutMs: 5000, maxOutputLength: 4096 });
    return result.code === 0;
  } catch (error) {
    return false;
  }
};

const withTempWorkspace = async (executor) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-code-sandbox-'));
  try {
    return await executor(tempDir);
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to clean temp workspace:', error.message);
    }
  }
};

const writeSource = async (tempDir, fileName, code) => {
  const safeFileName = path.basename(fileName);
  const sourcePath = path.join(tempDir, safeFileName);
  await fs.writeFile(sourcePath, code, 'utf8');
  return { safeFileName, sourcePath };
};

const classifyFailure = ({ language, phase = 'run', stderr = '', stdout = '', code = 1 }) => {
  const merged = mergeOutput(stdout, stderr);
  const lower = merged.toLowerCase();

  if (phase === 'compile' || lower.includes('syntax') || lower.includes('compile error') || lower.includes('javac')) {
    return {
      errorType: 'SYNTAX_ERROR',
      message: `Syntax Error in ${languageLabel(language)} code.`,
      output: merged || `Compilation failed with exit code ${code}.`,
    };
  }

  return {
    errorType: 'RUNTIME_ERROR',
    message: `Runtime Error in ${languageLabel(language)} code.`,
    output: merged || `Program finished with exit code ${code}.`,
  };
};

const successResult = ({ language, version, compile = null, run = null, output = '', runner }) => ({
  success: true,
  status: 'success',
  language,
  version,
  compileExitCode: compile?.code ?? null,
  runExitCode: run?.code ?? null,
  output: normalizeOutput(output),
  compile,
  run,
  runner,
});

const errorResult = ({ language, version, errorType, message, output = '', compile = null, run = null, runner }) => ({
  success: true,
  status: 'error',
  errorType,
  message,
  language,
  version,
  compileExitCode: compile?.code ?? null,
  runExitCode: run?.code ?? null,
  output: normalizeOutput(output),
  compile,
  run,
  runner,
});

const runLocalJavaScript = async ({ sourcePath, input, onData }) => {
  const run = await runProcess(process.execPath, [sourcePath], { input, timeoutMs: DEFAULT_TIMEOUT_MS, onData });
  if (run.code !== 0) {
    const info = classifyFailure({ language: 'javascript', stderr: run.stderr, stdout: run.stdout, code: run.code });
    return errorResult({ language: 'javascript', version: process.version, runner: 'local', run, ...info });
  }

  return successResult({
    language: 'javascript',
    version: process.version,
    run,
    output: run.stdout,
    runner: 'local',
  });
};

const runLocalPython = async ({ sourcePath, input, onData }) => {
  const run = await runProcess('python3', [sourcePath], { input, timeoutMs: DEFAULT_TIMEOUT_MS, onData });
  if (run.code !== 0) {
    const info = classifyFailure({ language: 'python', stderr: run.stderr, stdout: run.stdout, code: run.code });
    return errorResult({ language: 'python', version: 'python3', runner: 'local', run, ...info });
  }

  return successResult({
    language: 'python',
    version: 'python3',
    run,
    output: run.stdout,
    runner: 'local',
  });
};

const runLocalJava = async ({ sourcePath, input, fileName, onData }) => {
  const className = path.basename(fileName, path.extname(fileName));
  const outDir = path.dirname(sourcePath);
  const compile = await runProcess('javac', ['-encoding', 'UTF-8', '-d', outDir, sourcePath], {
    timeoutMs: DEFAULT_COMPILE_TIMEOUT_MS,
    onData,
  });

  if (compile.code !== 0) {
    const info = classifyFailure({ language: 'java', phase: 'compile', stderr: compile.stderr, stdout: compile.stdout, code: compile.code });
    return errorResult({ language: 'java', version: 'javac', runner: 'local', compile, ...info });
  }

  const run = await runProcess('java', ['-cp', outDir, className], {
    input,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    onData,
  });

  if (run.code !== 0) {
    const info = classifyFailure({ language: 'java', stderr: run.stderr, stdout: run.stdout, code: run.code });
    return errorResult({ language: 'java', version: 'java', runner: 'local', compile, run, ...info });
  }

  return successResult({
    language: 'java',
    version: 'java',
    compile,
    run,
    output: mergeOutput(compile.stdout, compile.stderr, run.stdout, run.stderr),
    runner: 'local',
  });
};

const runLocalCpp = async ({ sourcePath, input, tempDir, onData }) => {
  const executableName = process.platform === 'win32' ? 'sync-code-app.exe' : 'sync-code-app';
  const executablePath = path.join(tempDir, executableName);
  const compile = await runProcess('g++', [sourcePath, '-O2', '-std=c++17', '-o', executablePath], {
    timeoutMs: DEFAULT_COMPILE_TIMEOUT_MS,
    onData,
  });

  if (compile.code !== 0) {
    const info = classifyFailure({ language: 'cpp', phase: 'compile', stderr: compile.stderr, stdout: compile.stdout, code: compile.code });
    return errorResult({ language: 'cpp', version: 'g++', runner: 'local', compile, ...info });
  }

  const run = await runProcess(executablePath, [], {
    input,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    onData,
  });

  if (run.code !== 0) {
    const info = classifyFailure({ language: 'cpp', stderr: run.stderr, stdout: run.stdout, code: run.code });
    return errorResult({ language: 'cpp', version: 'g++', runner: 'local', compile, run, ...info });
  }

  return successResult({
    language: 'cpp',
    version: 'g++',
    compile,
    run,
    output: mergeOutput(compile.stdout, compile.stderr, run.stdout, run.stderr),
    runner: 'local',
  });
};

const runLocal = async ({ language, config, code, input, fileName, onData }) => withTempWorkspace(async (tempDir) => {
  const targetFileName = fileName ? path.basename(fileName) : config.fileName;
  const { sourcePath } = await writeSource(tempDir, targetFileName, code);

  if (language === 'javascript') {
    return runLocalJavaScript({ sourcePath, input, onData });
  }

  if (language === 'python') {
    return runLocalPython({ sourcePath, input, onData });
  }

  if (language === 'java') {
    return runLocalJava({ sourcePath, input, fileName: targetFileName, onData });
  }

  if (language === 'cpp') {
    return runLocalCpp({ sourcePath, input, tempDir, onData });
  }

  throw createExecutionError(400, 'VALIDATION_ERROR', `Unsupported language: ${language}`);
});

const buildDockerArgs = (image, commandArgs, tempDir) => ([
  'run',
  '--rm',
  '-i',
  '--network',
  'none',
  '--cpus',
  '1',
  '--memory',
  process.env.CODE_RUNNER_MEMORY_LIMIT || '256m',
  '--pids-limit',
  '64',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--read-only',
  '--tmpfs',
  '/tmp:rw,nosuid,nodev,noexec,size=64m',
  '--mount',
  `type=bind,source=${path.resolve(tempDir)},target=/workspace`,
  '-w',
  '/workspace',
  image,
  ...commandArgs,
]);

const runDocker = async ({ language, config, code, input, fileName, onData }) => withTempWorkspace(async (tempDir) => {
  const targetFileName = fileName ? path.basename(fileName) : config.fileName;
  const { safeFileName } = await writeSource(tempDir, targetFileName, code);
  const sourcePathInContainer = `/workspace/${safeFileName}`;
  const commandArgs = config.dockerCommand(sourcePathInContainer);

  const run = await runProcess(
    'docker',
    buildDockerArgs(config.dockerImage, commandArgs, tempDir),
    { input, timeoutMs: DEFAULT_TIMEOUT_MS, onData }
  );

  if (run.code !== 0) {
    const info = classifyFailure({ language, stderr: run.stderr, stdout: run.stdout, code: run.code });
    return errorResult({
      language,
      version: config.dockerImage,
      runner: 'docker',
      run,
      ...info,
    });
  }

  return successResult({
    language,
    version: config.dockerImage,
    run,
    output: run.stdout,
    runner: 'docker',
  });
});

const validatePayload = ({ language, code, input }) => {
  const normalizedLanguage = normalizeLanguage(language);
  if (!normalizedLanguage) {
    throw createExecutionError(400, 'VALIDATION_ERROR', 'Unsupported language. Supported languages: JavaScript, Python, C++, Java.');
  }

  if (typeof code !== 'string' || !code.trim()) {
    throw createExecutionError(400, 'VALIDATION_ERROR', 'Code content is required.');
  }


  if (code.length > MAX_CODE_LENGTH) {
    throw createExecutionError(413, 'VALIDATION_ERROR', `Code is too large. Maximum allowed size is ${MAX_CODE_LENGTH} characters.`);
  }

  if (String(input || '').length > MAX_INPUT_LENGTH) {
    throw createExecutionError(413, 'VALIDATION_ERROR', `Input is too large. Maximum allowed size is ${MAX_INPUT_LENGTH} characters.`);
  }

  return normalizedLanguage;
};

const executeCode = async ({ language, code, input = '', fileName, onData }) => {
  const normalizedLanguage = validatePayload({ language, code, input });
  const config = LANGUAGE_CONFIG[normalizedLanguage];
  const provider = getRunnerProvider();

  if (provider === 'docker') {
    const dockerReady = await isDockerDaemonReady();
    if (!dockerReady) {
      throw createExecutionError(503, 'ENVIRONMENT_ERROR', 'Docker is not running on the server. Start Docker Desktop or switch to local runner mode.');
    }

    return runDocker({
      language: normalizedLanguage,
      config,
      code,
      input,
      fileName,
      onData,
    });
  }

  if (provider === 'auto') {
    const dockerReady = await isDockerDaemonReady();
    if (dockerReady) {
      return runDocker({
        language: normalizedLanguage,
        config,
        code,
        input,
        fileName,
        onData,
      });
    }
  }

  const envCheck = await checkRuntimeForLanguage(normalizedLanguage);
  if (!envCheck.installed) {
    throw createExecutionError(503, 'ENVIRONMENT_ERROR', envCheck.message);
  }

  return runLocal({
    language: normalizedLanguage,
    config,
    code,
    input,
    fileName,
    onData,
  });
};

module.exports = {
  executeCode,
};
