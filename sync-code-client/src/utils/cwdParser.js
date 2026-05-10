/**
 * CWD Parser Utility
 * Processes terminal commands to track and update current working directory
 * Supports cd, pwd, ls, and other common shell commands
 */

const normalizePath = (path) => {
  if (!path) return '';
  return String(path).trim().replace(/\\/g, '/').replace(/\/+/g, '/');
};

const resolvePath = (currentCwd, relativePath) => {
  const cwd = normalizePath(currentCwd) || '/';
  const target = normalizePath(relativePath);

  if (!target) return cwd;

  // Absolute path
  if (target.startsWith('/')) {
    return target;
  }

  // Home expansion
  if (target.startsWith('~')) {
    return target.replace('~', '/home/user');
  }

  // Relative path
  if (target === '..') {
    const parts = cwd.split('/').filter(Boolean);
    return parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '/';
  }

  if (target === '.') {
    return cwd;
  }

  if (target.startsWith('./')) {
    return `${cwd}/${target.slice(2)}`;
  }

  if (target.startsWith('../')) {
    const parts = cwd.split('/').filter(Boolean);
    const count = (target.match(/\.\.\//g) || []).length;
    const baseDepth = Math.max(0, parts.length - count);
    return `/${parts.slice(0, baseDepth).join('/')}`;
  }

  // Regular relative path
  return `${cwd}/${target}`;
};

/**
 * Parse terminal command to extract next working directory
 * @param {string} command - The command line entered
 * @param {string} currentCwd - Current working directory
 * @returns {string} - New CWD or current if no change
 */
export const parseCommandForCwd = (command, currentCwd = '/') => {
  if (!command) return currentCwd;

  const trimmed = String(command).trim();
  if (!trimmed) return currentCwd;

  // Extract first word (command)
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  // Handle cd command
  if (cmd === 'cd') {
    if (args.length === 0 || args[0] === '~') {
      return '/home/user';
    }
    return resolvePath(currentCwd, args[0]);
  }

  // Handle pushd (push directory stack)
  if (cmd === 'pushd') {
    if (args.length === 0) {
      return currentCwd;
    }
    return resolvePath(currentCwd, args[0]);
  }

  // Handle pwd (just displays current, no change)
  if (cmd === 'pwd') {
    return currentCwd;
  }

  // Clear terminal doesn't change CWD
  if (cmd === 'clear' || cmd === 'cls') {
    return currentCwd;
  }

  // No change for other commands
  return currentCwd;
};

/**
 * Format CWD as terminal prompt
 * @param {string} cwd - Current working directory
 * @param {string} userContext - Optional user info (default: 'user')
 * @returns {string} - Formatted prompt like "~/project >"
 */
export const formatCwdPrompt = (cwd = '/home/user', userContext = 'user') => {
  const normalized = normalizePath(cwd) || '/';
  let display = normalized;

  // Replace /home/user with ~
  if (display.startsWith('/home/user')) {
    display = `~${display.slice(10)}`;
  }

  // Shorten long paths to last 2 segments
  if (display !== '/' && display.length > 40) {
    const parts = display.split('/').filter(Boolean);
    if (parts.length > 2) {
      display = `.../${parts.slice(-2).join('/')}`;
    }
  }

  return `${display} >`;
};

/**
 * Extract actual directory from cd command
 * @param {string} command - Full command line
 * @returns {string|null} - Directory path or null if not a cd command
 */
export const extractCdTarget = (command) => {
  const trimmed = String(command).trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd !== 'cd' && cmd !== 'pushd') {
    return null;
  }

  return parts[1] || null;
};

/**
 * Sanitize and validate command for CWD purposes
 * @param {string} command - Raw command input
 * @returns {string} - Cleaned command
 */
export const sanitizeCommand = (command) => {
  if (!command) return '';
  return String(command).trim().replace(/\r\n/g, '').replace(/\r/g, '');
};

const cwdParserUtils = {
  parseCommandForCwd,
  formatCwdPrompt,
  extractCdTarget,
  sanitizeCommand,
  normalizePath,
  resolvePath,
};

export default cwdParserUtils;
