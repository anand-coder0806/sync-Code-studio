import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { getSocket, socketOff, socketOn } from '../services/socket';
import { codeAPI, terminalAPI } from '../services/api';
import { useIdePanelStore } from '../store/idePanelStore';
import TerminalHeader from './panel/TerminalHeader';
import TerminalOutput from './panel/TerminalOutput';
import OutputPanel from './panel/OutputPanel';
import ProblemsPanel from './panel/ProblemsPanel';
import { parseCommandForCwd } from '../utils/cwdParser';
import '../styles/terminalPanel.css';

const panelTabs = [
  { id: 'problems', label: 'PROBLEMS' },
  { id: 'output', label: 'OUTPUT' },
  { id: 'terminal', label: 'TERMINAL' },
];

export default function TerminalPanel({
  isReadOnly,
  onTerminalApiReady,
  activeFileName,
  activeFileLanguage,
  activeFileContent,
  selectedCode,
}) {
  const inputRef = useRef(null);
  const pendingRequestsRef = useRef(new Map());
  const commandTerminalMapRef = useRef(new Map());

  const activeBottomTab = useIdePanelStore((state) => state.activeBottomTab);
  const terminals = useIdePanelStore((state) => state.terminals);
  const activeTerminalId = useIdePanelStore((state) => state.activeTerminalId);
  const splitTerminalId = useIdePanelStore((state) => state.splitTerminalId);
  const outputEntries = useIdePanelStore((state) => state.outputEntries);
  const problemEntries = useIdePanelStore((state) => state.problemEntries);
  const setActiveBottomTab = useIdePanelStore((state) => state.setActiveBottomTab);
  const ensureActiveTerminal = useIdePanelStore((state) => state.ensureActiveTerminal);
  const setActiveTerminalId = useIdePanelStore((state) => state.setActiveTerminalId);
  const setSplitTerminalId = useIdePanelStore((state) => state.setSplitTerminalId);
  const addTerminal = useIdePanelStore((state) => state.addTerminal);
  const closeTerminal = useIdePanelStore((state) => state.closeTerminal);
  const renameTerminal = useIdePanelStore((state) => state.renameTerminal);
  const updateTerminal = useIdePanelStore((state) => state.updateTerminal);
  const setTerminalInput = useIdePanelStore((state) => state.setTerminalInput);
  const setTerminalStatus = useIdePanelStore((state) => state.setTerminalStatus);
  const setTerminalCwd = useIdePanelStore((state) => state.setTerminalCwd);
  const clearTerminalLines = useIdePanelStore((state) => state.clearTerminalLines);
  const appendTerminalLine = useIdePanelStore((state) => state.appendTerminalLine);
  const pushTerminalHistoryAndPrompt = useIdePanelStore((state) => state.pushTerminalHistoryAndPrompt);
  const navigateHistoryUp = useIdePanelStore((state) => state.navigateHistoryUp);
  const navigateHistoryDown = useIdePanelStore((state) => state.navigateHistoryDown);
  const clearAllLogs = useIdePanelStore((state) => state.clearAllLogs);

  const activeTerminal = useMemo(() => {
    const found = terminals.find((terminal) => terminal.id === activeTerminalId);
    return found || terminals[0] || null;
  }, [terminals, activeTerminalId]);

  const splitTerminal = useMemo(() => {
    if (!splitTerminalId) {
      return null;
    }
    return terminals.find((terminal) => terminal.id === splitTerminalId) || null;
  }, [splitTerminalId, terminals]);

  useEffect(() => {
    ensureActiveTerminal();
  }, [ensureActiveTerminal]);

  useEffect(() => {
    if (activeBottomTab === 'terminal') {
      inputRef.current?.focus();
    }
  }, [activeBottomTab, activeTerminalId]);

  const executeSocketCommand = useCallback((terminalId, command) => new Promise((resolve, reject) => {
    const socket = getSocket();
    if (!socket || !socket.connected) {
      reject(new Error('Socket not connected'));
      return;
    }

    const requestId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingRequestsRef.current.set(requestId, terminalId);

    const cleanup = () => {
      pendingRequestsRef.current.delete(requestId);
      commandTerminalMapRef.current.delete(requestId);
    };

    socket.emit('terminal-exec', {
      requestId,
      command,
      shared: false,
      timestamp: Date.now(),
    });

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Terminal command timed out'));
    }, 20000);

    const finish = (error, payload) => {
      clearTimeout(timeoutId);
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve(payload);
    };

    const onDone = (payload = {}) => {
      if (payload.requestId !== requestId) {
        return;
      }
      socketOff('terminal-done', onDone);
      socketOff('terminal-error', onError);
      finish(null, payload);
    };

    const onError = (payload = {}) => {
      if (payload.requestId !== requestId) {
        return;
      }
      socketOff('terminal-done', onDone);
      socketOff('terminal-error', onError);
      finish(new Error(payload.error || 'Command failed'));
    };

    socketOff('terminal-done', onDone);
    socketOff('terminal-error', onError);
    socketOn('terminal-done', onDone);
    socketOn('terminal-error', onError);
  }), []);

  const runCommand = useCallback(async (terminalId, rawCommand) => {
    const command = String(rawCommand || '').trim();
    if (!terminalId || !command) {
      return;
    }

    pushTerminalHistoryAndPrompt(terminalId, command);
      // Parse and update CWD from cd/pushd commands
      const terminal = terminals.find(t => t.id === terminalId);
      if (terminal) {
        const nextCwd = parseCommandForCwd(command, terminal.cwd);
        if (nextCwd !== terminal.cwd) {
          setTerminalCwd(terminalId, nextCwd);
        }
      }

    if (command === 'clear' || command === 'cls') {
      clearTerminalLines(terminalId);
      setTerminalStatus(terminalId, 'idle');
      return;
    }

    try {
      const socket = getSocket();
      if (socket && socket.connected) {
        await executeSocketCommand(terminalId, command);
      } else {
        const response = await terminalAPI.execute(command);
        if (response?.data?.output) {
          appendTerminalLine(terminalId, 'stdout', response.data.output);
        }
        setTerminalCwd(terminalId, response?.data?.cwd);
        setTerminalStatus(terminalId, 'idle');
      }
    } catch (error) {
      appendTerminalLine(terminalId, 'stderr', error.message || 'Terminal command failed');
      setTerminalStatus(terminalId, 'idle');
    }
    }, [appendTerminalLine, clearTerminalLines, executeSocketCommand, pushTerminalHistoryAndPrompt, setTerminalCwd, setTerminalStatus, terminals]);

  const runCodeSnippet = useCallback(async ({ code, language, label }) => {
    if (!activeTerminal?.id) {
      return;
    }

    const snippet = String(code || '').trim();
    if (!snippet) {
      appendTerminalLine(activeTerminal.id, 'stderr', `No executable code for ${label}.`);
      return;
    }

    appendTerminalLine(activeTerminal.id, 'prompt', `${activeTerminal.cwd}> run ${label}`);
    setTerminalStatus(activeTerminal.id, 'running');

    try {
      const response = await codeAPI.run({
        code: snippet,
        language: language || 'javascript',
        fileName: activeFileName || 'snippet',
      });

      const result = response?.data || {};
      if (result.output) {
        appendTerminalLine(activeTerminal.id, result.status === 'success' ? 'stdout' : 'stderr', result.output);
      }
      if (result.message && !result.output) {
        appendTerminalLine(activeTerminal.id, result.status === 'success' ? 'stdout' : 'stderr', result.message);
      }
      setTerminalStatus(activeTerminal.id, 'idle');
    } catch (error) {
      appendTerminalLine(activeTerminal.id, 'stderr', error?.response?.data?.message || error?.message || 'Execution failed');
      setTerminalStatus(activeTerminal.id, 'idle');
    }
  }, [activeFileName, activeTerminal, appendTerminalLine, setTerminalStatus]);

  useEffect(() => {
    const onStart = (payload = {}) => {
      const terminalId = pendingRequestsRef.current.get(payload.requestId);
      if (!terminalId) {
        return;
      }
      setTerminalStatus(terminalId, 'running');
    };

    const onCommand = (payload = {}) => {
      const socket = getSocket();
      const isSelf = Boolean(socket?.id && payload.socketId && socket.id === payload.socketId);
      const fallbackTerminalId = useIdePanelStore.getState().activeTerminalId;

      const mappedTerminalId = pendingRequestsRef.current.get(payload.requestId)
        || commandTerminalMapRef.current.get(payload.requestId)
        || fallbackTerminalId;

      if (!mappedTerminalId) {
        return;
      }

      commandTerminalMapRef.current.set(payload.requestId, mappedTerminalId);
      if (isSelf) {
        return;
      }

      appendTerminalLine(
        mappedTerminalId,
        'prompt',
        `${payload.userName || 'Collaborator'}@${payload.roomId || 'room'}: ${payload.command || ''}`
      );
    };

    const onOutput = (payload = {}) => {
      const fallbackTerminalId = useIdePanelStore.getState().activeTerminalId;
      const terminalId = pendingRequestsRef.current.get(payload.requestId)
        || commandTerminalMapRef.current.get(payload.requestId)
        || fallbackTerminalId;

      if (!terminalId) {
        return;
      }

      commandTerminalMapRef.current.set(payload.requestId, terminalId);
      appendTerminalLine(terminalId, payload.type === 'stderr' ? 'stderr' : 'stdout', payload.data || '');
    };

    const onDone = (payload = {}) => {
      const fallbackTerminalId = useIdePanelStore.getState().activeTerminalId;
      const terminalId = pendingRequestsRef.current.get(payload.requestId)
        || commandTerminalMapRef.current.get(payload.requestId)
        || fallbackTerminalId;

      if (!terminalId) {
        return;
      }

      setTerminalCwd(terminalId, payload.cwd);
      setTerminalStatus(terminalId, 'idle');
      pendingRequestsRef.current.delete(payload.requestId);
      commandTerminalMapRef.current.delete(payload.requestId);
    };

    const onError = (payload = {}) => {
      const fallbackTerminalId = useIdePanelStore.getState().activeTerminalId;
      const terminalId = pendingRequestsRef.current.get(payload.requestId)
        || commandTerminalMapRef.current.get(payload.requestId)
        || fallbackTerminalId;

      if (!terminalId) {
        return;
      }

      appendTerminalLine(terminalId, 'stderr', payload.error || 'Command failed');
      setTerminalStatus(terminalId, 'idle');
      pendingRequestsRef.current.delete(payload.requestId);
      commandTerminalMapRef.current.delete(payload.requestId);
    };

    socketOff('terminal-start', onStart);
    socketOff('terminal-command', onCommand);
    socketOff('terminal-output', onOutput);
    socketOff('terminal-done', onDone);
    socketOff('terminal-error', onError);
    socketOn('terminal-start', onStart);
    socketOn('terminal-command', onCommand);
    socketOn('terminal-output', onOutput);
    socketOn('terminal-done', onDone);
    socketOn('terminal-error', onError);

    return () => {
      socketOff('terminal-start', onStart);
      socketOff('terminal-command', onCommand);
      socketOff('terminal-output', onOutput);
      socketOff('terminal-done', onDone);
      socketOff('terminal-error', onError);
    };
  }, [appendTerminalLine, setTerminalCwd, setTerminalStatus]);

  useEffect(() => {
    if (typeof onTerminalApiReady !== 'function') {
      return;
    }

    onTerminalApiReady({
      newTerminal: () => addTerminal(),
      splitTerminal: () => {
        const newId = addTerminal();
        setSplitTerminalId(newId);
      },
      runTask: () => activeTerminal?.id && runCommand(activeTerminal.id, 'help'),
      runBuildTask: () => activeTerminal?.id && runCommand(activeTerminal.id, 'npm run build'),
      runActiveFile: () => runCodeSnippet({
        code: activeFileContent,
        language: activeFileLanguage,
        label: activeFileName || 'active file',
      }),
      runSelectedText: () => runCodeSnippet({
        code: selectedCode,
        language: activeFileLanguage,
        label: 'selected text',
      }),
      killTerminal: () => activeTerminal?.id && closeTerminal(activeTerminal.id),
      clearTerminal: () => activeTerminal?.id && clearTerminalLines(activeTerminal.id),
      focusTerminal: () => {
        setActiveBottomTab('terminal');
        inputRef.current?.focus();
      },
      toggleTerminal: () => setActiveBottomTab('terminal'),
    });
  }, [
    activeFileContent,
    activeFileLanguage,
    activeFileName,
    activeTerminal,
    addTerminal,
    clearTerminalLines,
    closeTerminal,
    onTerminalApiReady,
    runCodeSnippet,
    runCommand,
    selectedCode,
    setActiveBottomTab,
    setSplitTerminalId,
  ]);

  const handleTerminalInputKeyDown = (event) => {
    if (!activeTerminal) {
      return;
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      appendTerminalLine(activeTerminal.id, 'stderr', '^C');
      updateTerminal(activeTerminal.id, (terminal) => ({ ...terminal, status: 'idle', input: '' }));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      navigateHistoryUp(activeTerminal.id);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      navigateHistoryDown(activeTerminal.id);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      runCommand(activeTerminal.id, activeTerminal.input);
    }
  };

  return (
    <div className="vscode-dock-panel" onMouseDown={() => activeBottomTab === 'terminal' && inputRef.current?.focus()}>
      <div className="vscode-dock-tabs" role="tablist" aria-label="Bottom panel tabs">
        {panelTabs.map((tab) => (
          <button
            type="button"
            key={tab.id}
            role="tab"
            aria-selected={activeBottomTab === tab.id}
            className={`vscode-dock-tab ${activeBottomTab === tab.id ? 'is-active' : ''}`}
            onClick={() => setActiveBottomTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="vscode-dock-body">
        <section className={`panel-view ${activeBottomTab === 'terminal' ? 'is-active' : ''}`}>
          <div className="terminal-panel-root">
            <div className="terminal-session-tabs" role="tablist" aria-label="Terminal sessions">
              {terminals.map((terminal) => (
                <div className="terminal-session-tabs__item" key={terminal.id}>
                  <button
                    type="button"
                    className={`terminal-session-tab ${activeTerminal?.id === terminal.id ? 'is-active' : ''}`}
                    onClick={() => setActiveTerminalId(terminal.id)}
                    onDoubleClick={() => {
                      const nextLabel = window.prompt('Rename terminal', terminal.label);
                      if (nextLabel) {
                        renameTerminal(terminal.id, nextLabel);
                      }
                    }}
                    title={terminal.label}
                  >
                    {terminal.label}
                  </button>
                  {terminals.length > 1 && (
                    <button
                      type="button"
                      className="terminal-session-tab__close"
                      onClick={() => closeTerminal(terminal.id)}
                      aria-label={`Close ${terminal.label}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            <TerminalHeader
              cwd={activeTerminal?.cwd || 'workspace/project'}
              onNewTerminal={() => addTerminal()}
              onClearTerminal={() => activeTerminal?.id && clearTerminalLines(activeTerminal.id)}
              onSplitTerminal={() => {
                const newId = addTerminal();
                setSplitTerminalId(newId);
              }}
            />

            <TerminalOutput
              activeLines={activeTerminal?.lines || []}
              splitLines={splitTerminal?.lines || []}
              isSplit={Boolean(splitTerminal?.id)}
            />

            <div className="terminal-input-bar">
              <span className="terminal-input-bar__cwd">{(() => { const p = activeTerminal?.cwd || "/home/user/sync-code"; const n = String(p).replace(/\\/g, "/"); return n.startsWith("/home/user") ? (n.slice(10) ? `~${n.slice(10)}` : "~") : n; })()}</span>
              <span className="terminal-input-bar__prompt">$</span>
              <input
                ref={inputRef}
                className="terminal-input"
                value={activeTerminal?.input || ''}
                onChange={(event) => activeTerminal?.id && setTerminalInput(activeTerminal.id, event.target.value)}
                onKeyDown={handleTerminalInputKeyDown}
                placeholder={isReadOnly ? 'Read-only mode' : 'Type command...'}
                disabled={isReadOnly}
              />
            </div>
          </div>
        </section>

        <section className={`panel-view ${activeBottomTab === 'output' ? 'is-active' : ''}`}>
          <OutputPanel entries={outputEntries} onClear={clearAllLogs} />
        </section>

        <section className={`panel-view ${activeBottomTab === 'problems' ? 'is-active' : ''}`}>
          <ProblemsPanel entries={problemEntries} />
        </section>
      </div>
    </div>
  );
}

