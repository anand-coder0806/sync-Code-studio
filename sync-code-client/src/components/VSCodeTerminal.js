import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useAuth from '../hooks/useAuth';
import '../styles/terminal.css';
import { getSocket, socketOff, socketOn } from '../services/socket';
import { terminalAPI } from '../services/api';

const MAX_HISTORY = 50;

export default function VSCodeTerminal({
  onCodeExecute,
  executionOutput,
  executionStatus,
  isReadOnly,
  language,
  executionId,
}) {
  const outputRef = useRef(null);
  const runningRef = useRef(false);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [lines, setLines] = useState([
    { type: 'system', text: 'Sync Code Terminal' },
    { type: 'system', text: 'Type help for commands' },
  ]);
  const { getCurrentUser } = useAuth();
  // Listen for code-update/code_updated events to reflect manager accept/reject actions
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !socket.connected) return;

    // Helper to determine if this is a reject event
    const isRejectSource = (payload) => {
      return (
        payload?.source === 'change_rejected_restore' ||
        (typeof payload?.source === 'string' && payload.source.includes('reject'))
      );
    };

    const onCodeUpdate = (payload = {}) => {
      // Accept: always update. Reject: only update if not manager.
      const user = getCurrentUser && getCurrentUser();
      const isManager = user && (user.role === 'manager' || user.role === 'owner');
      if (isRejectSource(payload)) {
        if (isManager) return; // Manager should not update on reject
      }
      // For both accept and non-manager reject, show the code update
      if (payload && typeof payload.code === 'string') {
        setLines([
          { type: 'system', text: 'Code updated by manager.' },
          { type: 'stdout', text: payload.code },
        ]);
      }
    };

    socketOn('code-update', onCodeUpdate);
    socketOn('code_updated', onCodeUpdate);
    return () => {
      socketOff('code-update', onCodeUpdate);
      socketOff('code_updated', onCodeUpdate);
    };
  }, [getCurrentUser]);

  const appendLines = useCallback((type, text) => {
    const normalized = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const nextLines = normalized
      .filter((line, idx) => !(idx === normalized.length - 1 && line === ''))
      .map((line) => ({ type, text: line }));

    if (nextLines.length === 0) {
      return;
    }

    setLines((prev) => [...prev, ...nextLines]);
  }, []);

  const writeStdout = useCallback((text) => appendLines('stdout', text), [appendLines]);
  const writeStderr = useCallback((text) => appendLines('stderr', text), [appendLines]);

  const executeTerminalOverSocket = useCallback((command) => new Promise((resolve, reject) => {
    const socket = getSocket();
    if (!socket || !socket.connected) {
      reject(new Error('Socket not connected'));
      return;
    }

    const requestId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let streamed = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      socketOff('terminal-output', onOutput);
      socketOff('terminal-done', onDone);
      socketOff('terminal-error', onError);
    };

    const onOutput = (payload = {}) => {
      if (payload.requestId !== requestId) {
        return;
      }
      streamed = true;
      if (payload.type === 'stderr') {
        writeStderr(payload.data || '');
      } else {
        writeStdout(payload.data || '');
      }
    };

    const onDone = (payload = {}) => {
      if (payload.requestId !== requestId) {
        return;
      }
      cleanup();
      if (!streamed && payload.output) {
        writeStdout(payload.output);
      }
      resolve(payload);
    };

    const onError = (payload = {}) => {
      if (payload.requestId !== requestId) {
        return;
      }
      cleanup();
      reject(new Error(payload.error || 'Terminal execution failed'));
    };

    socketOff('terminal-output', onOutput);
    socketOff('terminal-done', onDone);
    socketOff('terminal-error', onError);
    socketOn('terminal-output', onOutput);
    socketOn('terminal-done', onDone);
    socketOn('terminal-error', onError);

    socket.emit('terminal-exec', {
      requestId,
      command,
      timestamp: Date.now(),
    });

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Terminal command timed out'));
    }, 45000);
  }), [writeStderr, writeStdout]);

  const runCommand = useCallback(async (command) => {
    const trimmed = command.trim();
    if (!trimmed) {
      return;
    }

    setHistory((prev) => {
      const next = [...prev, trimmed];
      if (next.length > MAX_HISTORY) {
        next.shift();
      }
      return next;
    });
    setHistoryIndex(-1);
    appendLines('prompt', `$ ${trimmed}`);

    if (trimmed === 'help') {
      appendLines('system', 'Available commands:');
      appendLines('system', '  run <code>  Execute code in active language');
      appendLines('system', '  clear       Clear terminal');
      appendLines('system', '  help        Show help');
      appendLines('system', '  Ctrl+L      Clear terminal');
      appendLines('system', '  Ctrl+C      Interrupt');
      return;
    }

    if (trimmed === 'clear' || trimmed === 'cls' || trimmed === 'exit' || trimmed === 'quit') {
      setLines([]);
      return;
    }

    if (trimmed.startsWith('run ')) {
      const code = trimmed.slice(4).trim();
      if (!code) {
        writeStderr('No code provided.');
        return;
      }

      runningRef.current = true;
      appendLines('system', 'Executing code...');

      try {
        const socket = getSocket();
        const socketConnected = Boolean(socket && socket.connected);
        const result = await onCodeExecute(code, language);
        if (!socketConnected && result) {
          if (result.status === 'success') {
            writeStdout(result.output || '');
          } else {
            writeStderr(result.message || result.output || 'Execution failed');
          }
        }
      } catch (error) {
        writeStderr(error?.message || 'Execution error');
      } finally {
        runningRef.current = false;
      }
      return;
    }

    runningRef.current = true;
    appendLines('system', 'Running terminal command...');

    try {
      const socket = getSocket();
      if (socket && socket.connected) {
        await executeTerminalOverSocket(trimmed);
      } else {
        const response = await terminalAPI.execute(trimmed);
        const output = response?.data?.output || '';
        if (output) {
          writeStdout(output);
        }
      }
      appendLines('success', 'Done');
    } catch (error) {
      writeStderr(error?.response?.data?.error || error?.message || 'Terminal command failed');
    } finally {
      runningRef.current = false;
    }
  }, [appendLines, executeTerminalOverSocket, language, onCodeExecute, writeStderr, writeStdout]);

  const onInputKeyDown = useCallback((event) => {
    if (event.ctrlKey && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      setLines([]);
      setInput('');
      return;
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      runningRef.current = false;
      appendLines('stderr', '^C');
      setInput('');
      return;
    }

    if (event.key === 'ArrowUp') {
      if (history.length === 0) {
        return;
      }
      event.preventDefault();
      const nextIndex = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(nextIndex);
      setInput(history[history.length - 1 - nextIndex] || '');
      return;
    }

    if (event.key === 'ArrowDown') {
      if (history.length === 0) {
        return;
      }
      event.preventDefault();
      const nextIndex = historyIndex - 1;
      if (nextIndex < 0) {
        setHistoryIndex(-1);
        setInput('');
        return;
      }
      setHistoryIndex(nextIndex);
      setInput(history[history.length - 1 - nextIndex] || '');
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const command = input;
      setInput('');
      runCommand(command);
    }
  }, [appendLines, history, historyIndex, input, runCommand]);

  useEffect(() => {
    if (!executionId) {
      return undefined;
    }

    const socket = getSocket();
    if (!socket || !socket.connected) {
      return undefined;
    }

    const onOutput = ({ executionId: id, type, data }) => {
      if (id !== executionId) {
        return;
      }
      if (type === 'stderr') {
        writeStderr(data);
      } else {
        writeStdout(data);
      }
    };

    const onDone = ({ executionId: id }) => {
      if (id !== executionId) {
        return;
      }
      runningRef.current = false;
      appendLines('success', 'Execution done');
    };

    const onError = ({ executionId: id, error }) => {
      if (id !== executionId) {
        return;
      }
      runningRef.current = false;
      writeStderr(error || 'Execution failed');
    };

    socketOff('output-update', onOutput);
    socketOff('code-execution-done', onDone);
    socketOff('code-execution-error', onError);
    socketOn('output-update', onOutput);
    socketOn('code-execution-done', onDone);
    socketOn('code-execution-error', onError);

    return () => {
      socketOff('output-update', onOutput);
      socketOff('code-execution-done', onDone);
      socketOff('code-execution-error', onError);
    };
  }, [appendLines, executionId, writeStderr, writeStdout]);

  useEffect(() => {
    if (executionOutput) {
      writeStdout(executionOutput);
    }
  }, [executionOutput, writeStdout]);

  useEffect(() => {
    if (executionStatus === 'failed') {
      appendLines('stderr', 'Execution failed');
    }
    if (executionStatus === 'completed') {
      appendLines('success', 'Execution completed');
    }
  }, [appendLines, executionStatus]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  const placeholder = useMemo(() => (
    isReadOnly ? 'Read-only mode: terminal input disabled' : 'Type a command and press Enter'
  ), [isReadOnly]);

  return (
    <div className="vscode-terminal-wrapper">
      <div className="terminal-tab-bar">
        <span className="terminal-tab active">TERMINAL</span>
      </div>
      <div className="xterm-container terminal-fallback">
        <div className="terminal-output" ref={outputRef}>
          {lines.map((line, index) => (
            <div key={`${line.type}-${index}`} className={`terminal-line terminal-line--${line.type}`}>
              {line.text}
            </div>
          ))}
        </div>
        <div className="terminal-input-row">
          <span className="terminal-prompt">$</span>
          <input
            type="text"
            className="terminal-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={placeholder}
            disabled={isReadOnly}
            aria-label="Terminal command input"
          />
        </div>
      </div>
    </div>
  );
}