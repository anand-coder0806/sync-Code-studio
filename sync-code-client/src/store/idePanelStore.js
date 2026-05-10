import { useSyncExternalStore } from 'react';

const SESSION_KEY = 'syncCodeIdePanelV1';
const MAX_TERMINAL_HISTORY = 80;

const createTerminal = (index = 1) => ({
  id: `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  label: index === 1 ? 'Terminal' : `Terminal ${index}`,
  lines: [],
  cwd: 'workspace/project',
  history: [],
  historyIndex: -1,
  input: '',
  status: 'idle',
});

const splitLines = (text) => String(text || '').replace(/\r\n/g, '\n').split('\n')
  .filter((line, index, arr) => !(index === arr.length - 1 && line === ''));

const createLineEntry = (type, text, index = 0) => ({
  id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${index}`,
  type,
  text,
  timestamp: Date.now(),
});

const createOutputEntry = (type, text, index = 0) => ({
  id: `output-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${index}`,
  type,
  text,
  timestamp: Date.now(),
});

const loadPersistedState = () => {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
};

const initialPersisted = loadPersistedState();

const state = {
  activeBottomTab: initialPersisted?.activeBottomTab || 'terminal',
  terminals: Array.isArray(initialPersisted?.terminals) && initialPersisted.terminals.length > 0
    ? initialPersisted.terminals
    : [createTerminal(1)],
  activeTerminalId: initialPersisted?.activeTerminalId || '',
  splitTerminalId: initialPersisted?.splitTerminalId || '',
  outputEntries: Array.isArray(initialPersisted?.outputEntries) ? initialPersisted.outputEntries : [],
  problemEntries: Array.isArray(initialPersisted?.problemEntries) ? initialPersisted.problemEntries : [],
};

const listeners = new Set();

const persistState = () => {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      activeBottomTab: state.activeBottomTab,
      terminals: state.terminals,
      activeTerminalId: state.activeTerminalId,
      splitTerminalId: state.splitTerminalId,
      outputEntries: state.outputEntries,
      problemEntries: state.problemEntries,
    }));
  } catch (error) {
    // Ignore session storage failures.
  }
};

const emit = () => {
  persistState();
  listeners.forEach((listener) => listener());
};

const setState = (patch) => {
  const nextPatch = typeof patch === 'function' ? patch(state) : patch;
  Object.assign(state, nextPatch);
  emit();
};

const actions = {
  getState: () => state,
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setActiveBottomTab: (tab) => setState({ activeBottomTab: tab }),
  ensureActiveTerminal: () => {
    if (!state.activeTerminalId && state.terminals[0]?.id) {
      setState({ activeTerminalId: state.terminals[0].id });
    }
  },
  setActiveTerminalId: (terminalId) => setState({ activeTerminalId: terminalId }),
  setSplitTerminalId: (terminalId) => setState({ splitTerminalId: terminalId }),
  addTerminal: () => {
    const next = createTerminal(state.terminals.length + 1);
    setState({
      terminals: [...state.terminals, next],
      activeTerminalId: next.id,
      activeBottomTab: 'terminal',
    });
    return next.id;
  },
  closeTerminal: (terminalId) => {
    const nextTerminals = state.terminals.filter((terminal) => terminal.id !== terminalId);
    if (nextTerminals.length === 0) {
      const fallback = createTerminal(1);
      setState({
        terminals: [fallback],
        activeTerminalId: fallback.id,
        splitTerminalId: state.splitTerminalId === terminalId ? '' : state.splitTerminalId,
      });
      return;
    }

    setState({
      terminals: nextTerminals,
      activeTerminalId: state.activeTerminalId === terminalId ? nextTerminals[0].id : state.activeTerminalId,
      splitTerminalId: state.splitTerminalId === terminalId ? '' : state.splitTerminalId,
    });
  },
  renameTerminal: (terminalId, nextLabel) => {
    const label = String(nextLabel || '').trim();
    if (!label) {
      return;
    }

    setState({
      terminals: state.terminals.map((terminal) => (
        terminal.id === terminalId ? { ...terminal, label } : terminal
      )),
    });
  },
  updateTerminal: (terminalId, updater) => {
    setState({
      terminals: state.terminals.map((terminal) => (
        terminal.id === terminalId ? updater(terminal) : terminal
      )),
    });
  },
  setTerminalInput: (terminalId, value) => {
    setState({
      terminals: state.terminals.map((terminal) => (
        terminal.id === terminalId ? { ...terminal, input: value } : terminal
      )),
    });
  },
  setTerminalStatus: (terminalId, status) => {
    setState({
      terminals: state.terminals.map((terminal) => (
        terminal.id === terminalId ? { ...terminal, status } : terminal
      )),
    });
  },
  setTerminalCwd: (terminalId, cwd) => {
    setState({
      terminals: state.terminals.map((terminal) => (
        terminal.id === terminalId ? { ...terminal, cwd: cwd || terminal.cwd } : terminal
      )),
    });
  },
  clearTerminalLines: (terminalId) => {
    setState({
      terminals: state.terminals.map((terminal) => (
        terminal.id === terminalId ? { ...terminal, lines: [] } : terminal
      )),
    });
  },
  appendTerminalLine: (terminalId, type, text) => {
    const lines = splitLines(text).map((line, index) => createLineEntry(type, line, index));
    if (lines.length === 0) {
      return;
    }

    setState({
      terminals: state.terminals.map((terminal) => {
        if (terminal.id !== terminalId) {
          return terminal;
        }

        return {
          ...terminal,
          lines: [...terminal.lines, ...lines],
        };
      }),
    });
  },
  pushTerminalHistoryAndPrompt: (terminalId, command) => {
    setState({
      terminals: state.terminals.map((terminal) => {
        if (terminal.id !== terminalId) {
          return terminal;
        }

        const promptLine = createLineEntry('prompt', `${terminal.cwd}> ${command}`);
        return {
          ...terminal,
          lines: [...terminal.lines, promptLine],
          history: [...terminal.history, command].slice(-MAX_TERMINAL_HISTORY),
          historyIndex: -1,
          input: '',
          status: 'running',
        };
      }),
    });
  },
  navigateHistoryUp: (terminalId) => {
    setState({
      terminals: state.terminals.map((terminal) => {
        if (terminal.id !== terminalId || terminal.history.length === 0) {
          return terminal;
        }

        const nextIndex = Math.min(terminal.historyIndex + 1, terminal.history.length - 1);
        return {
          ...terminal,
          historyIndex: nextIndex,
          input: terminal.history[terminal.history.length - 1 - nextIndex] || '',
        };
      }),
    });
  },
  navigateHistoryDown: (terminalId) => {
    setState({
      terminals: state.terminals.map((terminal) => {
        if (terminal.id !== terminalId || terminal.history.length === 0) {
          return terminal;
        }

        const nextIndex = terminal.historyIndex - 1;
        if (nextIndex < 0) {
          return {
            ...terminal,
            historyIndex: -1,
            input: '',
          };
        }

        return {
          ...terminal,
          historyIndex: nextIndex,
          input: terminal.history[terminal.history.length - 1 - nextIndex] || '',
        };
      }),
    });
  },
  appendOutputEntry: (type, text) => {
    const entries = splitLines(text).map((line, index) => createOutputEntry(type, line, index));
    if (entries.length === 0) {
      return;
    }

    const nextProblems = type === 'stderr'
      ? [...state.problemEntries, ...entries].slice(-1000)
      : state.problemEntries;

    setState({
      outputEntries: [...state.outputEntries, ...entries].slice(-2000),
      problemEntries: nextProblems,
    });
  },
  clearAllLogs: () => setState({ outputEntries: [], problemEntries: [] }),
};

actions.ensureActiveTerminal();

export const useIdePanelStore = (selector = (store) => store) => {
  const subscribe = actions.subscribe;
  const getSnapshot = () => selector({ ...state, ...actions });
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

useIdePanelStore.getState = () => ({ ...state, ...actions });
