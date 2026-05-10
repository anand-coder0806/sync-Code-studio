import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { codeAPI, authAPI, projectAPI, fileAPI, chatbotAPI, getApiErrorMessage, READ_ONLY_BLOCK_MESSAGE } from '../services/api';
import { createMenuActions, getMenuSections } from '../components/MenuHandlers';
import FileExplorer from '../components/FileExplorer';
import MenuPopup from '../components/MenuPopup';
import TerminalPanel from '../components/TerminalPanel';
import { useIdePanelStore } from '../store/idePanelStore';
import RightPanel from '../components/RightPanel';
import ChatbotAssistant from '../components/ChatbotAssistant';
import { initializeSocket, disconnectSocket, isSocketConnected, socketOn, socketOff, socketEmit, joinRoom, leaveRoom, emitSuggestCode, emitCodeTyping, emitCodeCommit, emitAcceptSuggestion, emitRejectSuggestion, emitCursorUpdate, emitTypingStatus, emitActiveFilePresence, emitActiveFileChanged, emitTabsState, emitFileEvent, emitFileCreate, emitRoomRoleChange, getSocket } from '../services/socket';
import { useReadOnlyMode } from '../context/ReadOnlyModeContext';

const defaultCode = '// Welcome to Sync Code\n// Start coding here...\n';
const AUTO_SAVE_DELAY_MS = 2300;
const SUGGESTION_DEBOUNCE_MS = 850;
const LIVE_PREVIEW_DEBOUNCE_MS = 140;
const MIN_MEANINGFUL_DELTA_CHARS = 3;
const DEBUG_EDITOR_FOCUS = true;

const textEncoder = new TextEncoder();

const getLineColumnFromOffset = (content, offset) => {
  const safeContent = String(content || '');
  const safeOffset = Math.min(Math.max(Number(offset) || 0, 0), safeContent.length);
  const prefix = safeContent.slice(0, safeOffset);
  const lines = prefix.split('\n');
  return {
    line: Math.max(1, lines.length),
    column: Math.max(1, (lines[lines.length - 1] || '').length + 1),
  };
};

const summarizeCodeDelta = (previousCode, nextCode) => {
  const previous = String(previousCode || '');
  const next = String(nextCode || '');

  let start = 0;
  const minLen = Math.min(previous.length, next.length);
  while (start < minLen && previous[start] === next[start]) {
    start += 1;
  }

  let prevEnd = previous.length;
  let nextEnd = next.length;
  while (prevEnd > start && nextEnd > start && previous[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd -= 1;
    nextEnd -= 1;
  }

  const startPos = getLineColumnFromOffset(previous, start);
  const endPos = getLineColumnFromOffset(previous, prevEnd);
  const removedText = previous.slice(start, prevEnd);
  const addedText = next.slice(start, nextEnd);

  return {
    startLine: startPos.line,
    endLine: Math.max(startPos.line, endPos.line),
    startColumn: startPos.column,
    endColumn: Math.max(1, endPos.column),
    removedText,
    addedText,
  };
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
})();

const toUint16LE = (value) => [value & 0xFF, (value >>> 8) & 0xFF];
const toUint32LE = (value) => [
  value & 0xFF,
  (value >>> 8) & 0xFF,
  (value >>> 16) & 0xFF,
  (value >>> 24) & 0xFF,
];

const calculateCrc32 = (bytes) => {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
};

const concatByteArrays = (chunks) => {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);

  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });

  return merged;
};

const createZipBlob = (entries) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  entries.forEach((entry) => {
    const normalizedPath = String(entry.path || 'file.txt')
      .replace(/\\+/g, '/')
      .replace(/^\/+/, '');

    const pathBytes = textEncoder.encode(normalizedPath || 'file.txt');
    const dataBytes = entry.content instanceof Uint8Array
      ? entry.content
      : textEncoder.encode(String(entry.content || ''));

    const crc32 = calculateCrc32(dataBytes);
    const localHeader = Uint8Array.from([
      ...toUint32LE(0x04034B50),
      ...toUint16LE(20),
      ...toUint16LE(0),
      ...toUint16LE(0),
      ...toUint16LE(0),
      ...toUint16LE(0),
      ...toUint32LE(crc32),
      ...toUint32LE(dataBytes.length),
      ...toUint32LE(dataBytes.length),
      ...toUint16LE(pathBytes.length),
      ...toUint16LE(0),
      ...pathBytes,
    ]);

    localParts.push(localHeader, dataBytes);

    const centralHeader = Uint8Array.from([
      ...toUint32LE(0x02014B50),
      ...toUint16LE(20),
      ...toUint16LE(20),
      ...toUint16LE(0),
      ...toUint16LE(0),
      ...toUint16LE(0),
      ...toUint16LE(0),
      ...toUint32LE(crc32),
      ...toUint32LE(dataBytes.length),
      ...toUint32LE(dataBytes.length),
      ...toUint16LE(pathBytes.length),
      ...toUint16LE(0),
      ...toUint16LE(0),
      ...toUint16LE(0),
      ...toUint16LE(0),
      ...toUint32LE(0),
      ...toUint32LE(offset),
      ...pathBytes,
    ]);

    centralParts.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  });

  const localSection = concatByteArrays(localParts);
  const centralSection = concatByteArrays(centralParts);

  const endOfCentralDirectory = Uint8Array.from([
    ...toUint32LE(0x06054B50),
    ...toUint16LE(0),
    ...toUint16LE(0),
    ...toUint16LE(entries.length),
    ...toUint16LE(entries.length),
    ...toUint32LE(centralSection.length),
    ...toUint32LE(localSection.length),
    ...toUint16LE(0),
  ]);

  const zipBytes = concatByteArrays([localSection, centralSection, endOfCentralDirectory]);
  return new Blob([zipBytes], { type: 'application/zip' });
};

export default function EditorPage() {
  const [code, setCode] = useState(defaultCode);
  const [language, setLanguage] = useState('javascript');
  const [fileName, setFileName] = useState('file.js');
  const [isSaved, setIsSaved] = useState(true);
  const [user, setUser] = useState(null);
  const [saving, setSaving] = useState(false);
  const [lineCount, setLineCount] = useState(2);
  const [charCount, setCharCount] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const [lastChangeTime, setLastChangeTime] = useState(null);
  const [collabSyncState, setCollabSyncState] = useState('Saved');
  const [suggestionTriggerMode, setSuggestionTriggerMode] = useState('auto');
  const [originalCode, setOriginalCode] = useState(defaultCode);
  const [pendingChanges, setPendingChanges] = useState([]);
  const [appliedChanges, setAppliedChanges] = useState([]);
  const [inlineActionChangeId, setInlineActionChangeId] = useState('');
  const [lineActionPopover, setLineActionPopover] = useState({
    visible: false,
    top: 0,
    left: 0,
    changeId: '',
  });
  const [roomId, setRoomId] = useState('');
  const [roomInput, setRoomInput] = useState('');
  const [usersInRoom, setUsersInRoom] = useState([]);
  const [joinedRoom, setJoinedRoom] = useState(false);
  const [roomError, setRoomError] = useState('');
  const [remoteUpdaters, setRemoteUpdaters] = useState({});
  const [typingUsers, setTypingUsers] = useState({});
  const [remoteCursors, setRemoteCursors] = useState({});
  const [roomRole, setRoomRole] = useState('viewer');
  const [roomHostId, setRoomHostId] = useState('');
  const [projects, setProjects] = useState([]);
  const [files, setFiles] = useState([]);
  const [fileTreeData, setFileTreeData] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [activeFileId, setActiveFileId] = useState('');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [editorFontSize, setEditorFontSize] = useState(14);
  const [workspaceStatus, setWorkspaceStatus] = useState('Ready');
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [filePickerTitle, setFilePickerTitle] = useState('Open File');
  const [filePickerQuery, setFilePickerQuery] = useState('');
  const [filePickerResults, setFilePickerResults] = useState([]);
  const [filePickerActiveIndex, setFilePickerActiveIndex] = useState(0);
  const [terminalVisible, setTerminalVisible] = useState(true);
  const [requestsPanelVisible, setRequestsPanelVisible] = useState(false);
  const [leftWorkspaceTab, setLeftWorkspaceTab] = useState('files');
  const [collabRequestedTab, setCollabRequestedTab] = useState('chat');
  const [collabPanelOpenSignal, setCollabPanelOpenSignal] = useState(0);
  const [activePath, setActivePath] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showStatusBar, setShowStatusBar] = useState(true);
  const [showActivityBar, setShowActivityBar] = useState(true);
  const [showSideBar, setShowSideBar] = useState(true);
  const [showMinimap, setShowMinimap] = useState(true);
  const [showBreadcrumbs, setShowBreadcrumbs] = useState(true);
  const [isWordWrapEnabled, setIsWordWrapEnabled] = useState(true);
  const [isZenMode, setIsZenMode] = useState(false);
  const [isCenteredLayout, setIsCenteredLayout] = useState(false);
  const [isDebugging, setIsDebugging] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [breakpointsEnabled, setBreakpointsEnabled] = useState(true);
  const [breakpoints, setBreakpoints] = useState([]);
  const [currentExecutionLine, setCurrentExecutionLine] = useState(null);
  const [debugLogs, setDebugLogs] = useState([]);
  const [runConfigurations, setRunConfigurations] = useState([
    { name: 'Launch Current File', type: 'node', request: 'launch', program: 'app.js' },
  ]);
  const [activeRunConfigurationIndex, setActiveRunConfigurationIndex] = useState(0);
  const [runConfigModalOpen, setRunConfigModalOpen] = useState(false);
  const [runConfigJson, setRunConfigJson] = useState('');
  const [terminalInEditorArea, setTerminalInEditorArea] = useState(false);
  const bottomPanelTab = useIdePanelStore((state) => state.activeBottomTab);
  const setBottomPanelTab = useIdePanelStore((state) => state.setActiveBottomTab);
  const appendOutputEntry = useIdePanelStore((state) => state.appendOutputEntry);
  const [executionInput] = useState('');
  const [, setExecutionOutput] = useState('');
  const [, setExecutionStatus] = useState('idle');
  const [executionAlert, setExecutionAlert] = useState(null);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminUsersLoading, setAdminUsersLoading] = useState(false);
  const [adminUsersError, setAdminUsersError] = useState('');
  const [adminUpdatingUserId, setAdminUpdatingUserId] = useState('');
  const [recentFiles, setRecentFiles] = useState([]);
  const [recentProjects, setRecentProjects] = useState([]);
  const [activeSidebarPanel, setActiveSidebarPanel] = useState('explorer');
  const [activeTheme, setActiveTheme] = useState(() => localStorage.getItem('syncCodeTheme') || 'dark');
  const [autoSaveStatus, setAutoSaveStatus] = useState('idle');
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState(null);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [fileVersions, setFileVersions] = useState([]);
  const [versionLoading, setVersionLoading] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState('');
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  const [cursorPosition, setCursorPosition] = useState({ lineNumber: 1, column: 1 });
  const [openTabs, setOpenTabs] = useState([]);
  const [runningCode, setRunningCode] = useState(false);
  const [highlightedExplorerNodeId, setHighlightedExplorerNodeId] = useState('');
  const [terminalHeight, setTerminalHeight] = useState(() => {
    const saved = Number.parseInt(localStorage.getItem('terminalHeight') || '200', 10);
    if (Number.isNaN(saved)) {
      return 200;
    }
    return Math.min(Math.max(saved, 180), 200);
  });
  const [isResizingTerminal, setIsResizingTerminal] = useState(false);
  const [isCollabFullscreen, setIsCollabFullscreen] = useState(false);
  const [, setExecutionId] = useState(null);
  const {
    isReadOnlyMode,
    canToggleReadOnly,
    isTogglingReadOnlyMode,
    refreshReadOnlyMode,
    toggleReadOnlyMode,
  } = useReadOnlyMode();
  const currentUserId = user?._id || user?.id || '';
  const currentUserDisplayName = user?.name || user?.email || 'Not signed in';
  const accountRole = user?.role || 'writer';
  const accountReadOnlyMode = accountRole === 'reader';
  const effectiveReadOnlyMode = isReadOnlyMode || accountReadOnlyMode || (joinedRoom && roomRole !== 'editor');

  const navigate = useNavigate();
  const location = useLocation();
  const isReceivingRemoteUpdate = useRef(false);
  const codeUpdateTimeout = useRef(null);
  const previewEmitTimeoutRef = useRef(null);
  const typingIndicatorTimeoutRef = useRef(null);
  const pendingSuggestionValueRef = useRef(defaultCode);
  const typingStatusTimeout = useRef(null);
  const activeFileKeyRef = useRef('');
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const editorCanvasRef = useRef(null);
  const menuAnchorRef = useRef(null);
  const terminalMenuApiRef = useRef(null);
  const cursorDecorationsRef = useRef([]);
  const suggestionDecorationsRef = useRef([]);
  const breakpointDecorationsRef = useRef([]);
  const executionLineDecorationsRef = useRef([]);
  const cursorStyleSheetRef = useRef(null);
  const injectedCursorStylesRef = useRef(new Set());
  const terminalResizeDividerRef = useRef(null);
  const initialMouseYRef = useRef(0);
  const initialHeightRef = useRef(0);
  const didResizeDuringDragRef = useRef(false);
  const suppressDividerClickRef = useRef(false);
  const consumedProjectParamRef = useRef(false);
  const localFileInputRef = useRef(null);
  const localFolderInputRef = useRef(null);
  const appliedCodeRevisionsRef = useRef(new Map());
  const cursorEmitTimeoutRef = useRef(null);
  const lastCursorEmitAtRef = useRef(0);
  const lastCursorPositionRef = useRef({ lineNumber: 0, column: 0, fileKey: '' });
  const autoSaveTimeoutRef = useRef(null);
  const lastAutoSaveSignatureRef = useRef('');
  const lastSuggestedCodeRef = useRef(defaultCode);
  const suggestionTriggerModeRef = useRef('auto');
  const isAutoSavingRef = useRef(false);
  const isApplyingRemoteTabsRef = useRef(false);
  const isApplyingRemoteFileSelectionRef = useRef(false);
  const explorerHighlightTimeoutRef = useRef(null);
  const socketUserIdRef = useRef('');
  const [remoteRequestedFileId, setRemoteRequestedFileId] = useState('');

  useEffect(() => {
    if (DEBUG_EDITOR_FOCUS) {
      console.log('[editor render]', {
        fileName,
        language,
        bottomPanelTab,
        terminalVisible,
        activeFileId,
        codeLength: code.length,
      });
    }
  });

  useEffect(() => {
    suggestionTriggerModeRef.current = suggestionTriggerMode;
  }, [suggestionTriggerMode]);

  useEffect(() => {
    const onMouseDown = (event) => {
      if (menuOpen) {
        const anchorElement = menuAnchorRef.current;
        const target = event.target;
        if (anchorElement && !anchorElement.contains(target)) {
          setMenuOpen(false);
          setActivePath([]);
        }
      }
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setActivePath([]);
      }
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const guardReadOnlyWrite = useCallback(() => {
    if (!effectiveReadOnlyMode) {
      return false;
    }

    setWorkspaceStatus('Read-only mode active');
    alert(READ_ONLY_BLOCK_MESSAGE);
    return true;
  }, [effectiveReadOnlyMode]);

  const trackRecentItem = useCallback((items, entry) => {
    const next = [entry, ...items.filter((item) => item.id !== entry.id)];
    return next.slice(0, 8);
  }, []);

  const rememberRecentFile = useCallback((file) => {
    if (!file?._id) {
      return;
    }

    setRecentFiles((items) => trackRecentItem(items, {
      id: file._id,
      name: file.name,
      projectId: file.projectId,
      language: file.language,
    }));
  }, [trackRecentItem]);

  const rememberRecentProject = useCallback((project) => {
    if (!project?._id) {
      return;
    }

    setRecentProjects((items) => trackRecentItem(items, {
      id: project._id,
      name: project.name,
    }));
  }, [trackRecentItem]);

  const fileMenuState = useMemo(() => {
    const fileEntries = files
      .filter((item) => (item.itemType || 'file') === 'file')
      .map((item) => ({
        id: String(item._id || ''),
        name: item.name || 'untitled',
        content: String(item.content || ''),
        isActive: String(item._id || '') === String(activeFileId || ''),
      }));

    if (!activeFileId) {
      fileEntries.unshift({
        id: '__unsaved__',
        name: fileName || 'untitled.js',
        content: String(code || ''),
        isActive: true,
      });
    }

    const currentFile = fileEntries.find((entry) => entry.isActive) || null;

    return {
      files: fileEntries,
      currentFile,
      editorContent: String(code || ''),
    };
  }, [files, activeFileId, fileName, code]);

  const highlightExplorerNode = useCallback((nodeId) => {
    if (!nodeId) {
      return;
    }

    setHighlightedExplorerNodeId(String(nodeId));
    if (explorerHighlightTimeoutRef.current) {
      clearTimeout(explorerHighlightTimeoutRef.current);
    }

    explorerHighlightTimeoutRef.current = setTimeout(() => {
      setHighlightedExplorerNodeId('');
    }, 2200);
  }, []);

  const getDefaultFileName = (selectedLanguage) => {
    const extensions = {
      javascript: 'js',
      python: 'py',
      java: 'java',
      cpp: 'cpp',
      csharp: 'cs',
      html: 'html',
      css: 'css',
    };

    return `file.${extensions[selectedLanguage] || selectedLanguage}`;
  };

  const getScopedRoomId = useCallback(() => {
    if (activeFileId) {
      return `file:${activeFileId}`;
    }

    if (activeProjectId && fileName) {
      return `project:${activeProjectId}:file:${fileName}`;
    }

    return '';
  }, [activeFileId, activeProjectId, fileName]);

  const resolveCurrentFileId = useCallback(() => String(activeFileId || fileName || '__default__'), [activeFileId, fileName]);

  const getLanguageFromFileName = useCallback((name) => {
    const extension = String(name || '')
      .trim()
      .toLowerCase()
      .split('.')
      .pop();

    const extensionMap = {
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      jsx: 'javascript',
      py: 'python',
      pyw: 'python',
      java: 'java',
      cpp: 'cpp',
      cc: 'cpp',
      cxx: 'cpp',
      hpp: 'cpp',
      hh: 'cpp',
    };

    return extensionMap[extension] || '';
  }, []);

  const getCodeSignature = useCallback((value, selectedLanguage, selectedFileName) => {
    const content = String(value || '');
    let hash = 0;
    for (let i = 0; i < content.length; i += 1) {
      hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }

    return `${selectedLanguage || ''}::${selectedFileName || ''}::${content.length}::${hash}`;
  }, []);

  const renderMatchedName = useCallback((name, query) => {
    const rawName = String(name || '');
    const rawQuery = String(query || '').trim();
    if (!rawQuery) {
      return rawName;
    }

    const index = rawName.toLowerCase().indexOf(rawQuery.toLowerCase());
    if (index < 0) {
      return rawName;
    }

    return (
      <>
        {rawName.slice(0, index)}
        <mark className="picker-match">{rawName.slice(index, index + rawQuery.length)}</mark>
        {rawName.slice(index + rawQuery.length)}
      </>
    );
  }, []);

  const buildFileTree = useCallback((items) => {
    const map = new Map();
    const roots = [];

    items.forEach((item) => {
      map.set(item._id, { ...item, children: [] });
    });

    map.forEach((node) => {
      if (node.parentId && map.has(String(node.parentId))) {
        map.get(String(node.parentId)).children.push(node);
      } else {
        roots.push(node);
      }
    });

    const sorter = (a, b) => {
      if ((a.itemType || 'file') !== (b.itemType || 'file')) {
        return (a.itemType || 'file') === 'folder' ? -1 : 1;
      }
      return (a.name || '').localeCompare(b.name || '');
    };

    const sortNodes = (nodes) => {
      nodes.sort(sorter);
      nodes.forEach((node) => sortNodes(node.children));
    };

    sortNodes(roots);
    return roots;
  }, []);

  const createEmptyDocument = useCallback((selectedLanguage = 'javascript') => ({
    fileId: '',
    fileName: getDefaultFileName(selectedLanguage),
    code: defaultCode,
    language: selectedLanguage,
  }), []);

  const generateRoomId = useCallback(() => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().split('-')[0];
    }

    return Math.random().toString(36).slice(2, 10);
  }, []);

  const getCursorClassSuffix = useCallback((userId) => String(userId || 'user').replace(/[^a-zA-Z0-9_-]/g, '_'), []);

  const getColorFromUserId = useCallback((userId) => {
    const raw = String(userId || 'user');
    let hash = 0;
    for (let i = 0; i < raw.length; i += 1) {
      hash = (hash << 5) - hash + raw.charCodeAt(i);
      hash |= 0;
    }

    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 72% 54%)`;
  }, []);

  const ensureCursorStylesForUser = useCallback((userId) => {
    const styleSheet = cursorStyleSheetRef.current;
    if (!styleSheet) {
      return;
    }

    const suffix = getCursorClassSuffix(userId);
    if (injectedCursorStylesRef.current.has(suffix)) {
      return;
    }

    const color = getColorFromUserId(userId);
    try {
      styleSheet.insertRule(`.remote-cursor-line-${suffix} { border-left: 2px solid ${color}; }`, styleSheet.cssRules.length);
      styleSheet.insertRule(`.remote-cursor-label-${suffix} { margin-left: 6px; padding: 1px 6px; border-radius: 4px; background: ${color}; color: #ffffff; font-size: 10px; font-weight: 700; }`, styleSheet.cssRules.length);
      injectedCursorStylesRef.current.add(suffix);
    } catch (error) {
      console.error('Failed to inject cursor styles:', error);
    }
  }, [getColorFromUserId, getCursorClassSuffix]);

  const getCurrentUserRole = useCallback(() => {
    return user?.role || 'writer';
  }, [user]);

  const isAdminUser = getCurrentUserRole() === 'admin';
  const isRoomOwner = Boolean(joinedRoom && currentUserId && roomHostId && String(roomHostId) === String(currentUserId));
  const isRoomManager = Boolean(currentUserId && (isAdminUser || String(roomHostId || '') === String(currentUserId || '')));

  const loadAdminUsers = useCallback(async () => {
    if (!isAdminUser) {
      return;
    }

    setAdminUsersLoading(true);
    setAdminUsersError('');

    try {
      const response = await authAPI.listUsers();
      setAdminUsers(response.data.users || []);
    } catch (error) {
      console.error('Failed to load admin users:', error);
      setAdminUsersError(error?.response?.data?.message || 'Unable to load users');
    } finally {
      setAdminUsersLoading(false);
    }
  }, [isAdminUser]);

  const handleOpenAdminPanel = async () => {
    setAdminPanelOpen(true);
    await loadAdminUsers();
  };

  const handleCloseAdminPanel = () => {
    setAdminPanelOpen(false);
    setAdminUsersError('');
  };

  const handleUserRoleChange = async (targetUserId, nextRole) => {
    if (!isAdminUser) {
      return;
    }

    setAdminUpdatingUserId(targetUserId);
    setAdminUsersError('');

    try {
      const response = await authAPI.updateUserRole(targetUserId, nextRole);
      const updatedUser = response?.data?.user;

      setAdminUsers((previous) => previous.map((entry) => (
        String(entry.id) === String(targetUserId)
          ? { ...entry, role: updatedUser?.role || nextRole }
          : entry
      )));

      if (String(user?.id || user?._id) === String(targetUserId)) {
        const refreshedCurrentUser = {
          ...user,
          role: updatedUser?.role || nextRole,
          canWrite: (updatedUser?.role || nextRole) !== 'reader',
          canToggleReadOnly: (updatedUser?.role || nextRole) === 'admin',
        };
        setUser(refreshedCurrentUser);
        localStorage.setItem('user', JSON.stringify(refreshedCurrentUser));
      }

      if ((updatedUser?.role || nextRole) === 'admin') {
        await refreshReadOnlyMode();
      }
      setWorkspaceStatus(`Updated role to ${updatedUser?.role || nextRole}`);
    } catch (error) {
      console.error('Failed to update user role:', error);
      setAdminUsersError(error?.response?.data?.message || 'Unable to update user role');
    } finally {
      setAdminUpdatingUserId('');
    }
  };

  const refreshProjectFiles = useCallback(async (projectId) => {
    if (!projectId) {
      setFiles([]);
      setFileTreeData([]);
      return;
    }

    const [filesResponse, treeResponse] = await Promise.all([
      fileAPI.list(projectId),
      fileAPI.tree(projectId),
    ]);

    setFiles(filesResponse.data.files || []);
    setFileTreeData(treeResponse.data.tree || []);
  }, []);

  const loadProjectsAndFiles = useCallback(async () => {
    try {
      setWorkspaceStatus('Loading workspace...');
      const defaultProjectResponse = await fileAPI.ensureDefaultProject();
      const projectListResponse = await projectAPI.list();

      const defaultProject = defaultProjectResponse.data.project;
      const projectList = projectListResponse.data.projects || [];
      const projectMap = new Map(projectList.map((project) => [project._id, project]));

      if (defaultProject && !projectMap.has(defaultProject._id)) {
        projectMap.set(defaultProject._id, defaultProject);
      }

      const nextProjects = Array.from(projectMap.values());
      setProjects(nextProjects);

      const nextActiveProjectId = activeProjectId || defaultProject?._id || nextProjects[0]?._id || '';
      setActiveProjectId(nextActiveProjectId);

      await refreshProjectFiles(nextActiveProjectId);

      setWorkspaceStatus('Workspace ready');
    } catch (error) {
      console.error('Failed to load workspace:', error);
      setWorkspaceStatus('Workspace failed to load');
    }
  }, [activeProjectId, refreshProjectFiles]);

  useEffect(() => {
    activeFileKeyRef.current = resolveCurrentFileId();
  }, [resolveCurrentFileId]);

  useEffect(() => {
    let cancelled = false;

    const hydrateCurrentUser = async () => {
      const token = localStorage.getItem('token');

      if (!token) {
        localStorage.removeItem('user');
        if (!cancelled) {
          setUser(null);
          navigate('/');
        }
        return;
      }

      try {
        const response = await authAPI.getProfile();
        const profile = response?.data;
        if (!cancelled && profile) {
          const normalizedUser = {
            ...profile,
            id: profile.id || profile._id,
            _id: profile._id || profile.id,
          };
          setUser(normalizedUser);
          localStorage.setItem('user', JSON.stringify(normalizedUser));
        }
      } catch (error) {
        console.error('Failed to hydrate current user:', error);
        await authAPI.logout();
        if (!cancelled) {
          navigate('/');
        }
      }
    };

    hydrateCurrentUser();

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  useEffect(() => {
    if (!user) {
      socketUserIdRef.current = '';
      return;
    }

    const nextUserId = String(user?._id || user?.id || '');
    const previousUserId = String(socketUserIdRef.current || '');

    if (previousUserId && nextUserId && previousUserId !== nextUserId) {
      disconnectSocket();
    }

    if (!isSocketConnected()) {
      initializeSocket();
    }

    socketUserIdRef.current = nextUserId;
  }, [user]);

  useEffect(() => {
    if (user) {
      refreshReadOnlyMode();
    }
  }, [user, refreshReadOnlyMode]);

  useEffect(() => {
    if (adminPanelOpen) {
      loadAdminUsers();
    }
  }, [adminPanelOpen, loadAdminUsers]);

  useEffect(() => {
    if (user) {
      loadProjectsAndFiles();
    }
  }, [user, loadProjectsAndFiles]);

  useEffect(() => {
    if (!user || projects.length === 0 || consumedProjectParamRef.current) {
      return;
    }

    const params = new URLSearchParams(location.search);
    const projectFromQuery = params.get('project');
    if (!projectFromQuery) {
      return;
    }

    const targetProject = projects.find((project) => String(project._id) === String(projectFromQuery));
    if (!targetProject) {
      return;
    }

    consumedProjectParamRef.current = true;
    handleSelectProject(targetProject);
  // handleSelectProject is intentionally omitted to avoid re-running this one-time deep-link effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, projects, location.search]);

  useEffect(() => {
    document.body.classList.remove('theme-dark', 'theme-light', 'theme-dracula', 'theme-monokai');
    document.body.classList.add(`theme-${activeTheme}`);
    localStorage.setItem('syncCodeTheme', activeTheme);
    return () => {
      document.body.classList.remove('theme-dark', 'theme-light', 'theme-dracula', 'theme-monokai');
    };
  }, [activeTheme]);

  useEffect(() => {
    const handleGlobalKeyDown = (event) => {
      const isCtrlOrCmd = event.ctrlKey || event.metaKey;
      const isShift = event.shiftKey;
      const isAlt = event.altKey;
      const key = event.key.toLowerCase();

      if (!isCtrlOrCmd && !isAlt && key !== 'f11') {
        return;
      }

      const targetTag = event.target?.tagName?.toLowerCase();
      const isTypingInInput = targetTag === 'input' || targetTag === 'textarea';
      if (isTypingInInput && !(isCtrlOrCmd && key === 's')) {
        return;
      }

      if (isCtrlOrCmd && key === 's') {
        event.preventDefault();
        if (isShift) {
          handleSaveAs();
          return;
        }
        handleSave();
        return;
      }

      if (isCtrlOrCmd && key === 'n') {
        event.preventDefault();
        handleNewFile();
        return;
      }

      if (isCtrlOrCmd && key === 'o') {
        event.preventDefault();
        handleOpenFile();
        return;
      }

      if (isCtrlOrCmd && key === 'z') {
        event.preventDefault();
        handleUndo();
        return;
      }

      if (isCtrlOrCmd && key === 'y') {
        event.preventDefault();
        handleRedo();
        return;
      }

      if (isCtrlOrCmd && isShift && key === 'z') {
        event.preventDefault();
        handleRedo();
        return;
      }

      if (isCtrlOrCmd && key === '/') {
        event.preventDefault();
        handleToggleLineComment();
        return;
      }

      if (isCtrlOrCmd && key === 'f') {
        event.preventDefault();
        handleFind();
        return;
      }

      if (isCtrlOrCmd && key === 'h') {
        event.preventDefault();
        if (isShift) {
          handleReplaceInFiles();
          return;
        }
        handleReplace();
        return;
      }

      if (isCtrlOrCmd && key === 'g') {
        event.preventDefault();
        handleGoToLine();
        return;
      }

      if (isCtrlOrCmd && key === 'p' && !isShift) {
        event.preventDefault();
        handleGoToFile();
        return;
      }

      if (isCtrlOrCmd && key === 'b') {
        event.preventDefault();
        handleToggleSidebar();
        return;
      }

      if (isCtrlOrCmd && isAlt && key === 'n') {
        event.preventDefault();
        handleRunCode();
        return;
      }

      if (isCtrlOrCmd && isShift && key === 'p') {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      if (isCtrlOrCmd && isShift && key === 'f') {
        event.preventDefault();
        handleFindInFiles();
        return;
      }

      if ((isAlt && key === '`') || (isCtrlOrCmd && key === '`')) {
        event.preventDefault();
        setTerminalVisible((prev) => {
          const next = !prev;
          if (next) {
            setBottomPanelTab('terminal');
          }
          return next;
        });
        return;
      }

      if (isAlt && key === 'z') {
        event.preventDefault();
        handleToggleWordWrap();
        return;
      }

      if (isAlt && key === 'arrowleft') {
        event.preventDefault();
        handleGoToPreviousFile();
        return;
      }

      if (isAlt && isShift && key === 'arrowup') {
        event.preventDefault();
        handleCopyLineUp();
        return;
      }

      if (isAlt && isShift && key === 'arrowdown') {
        event.preventDefault();
        handleCopyLineDown();
        return;
      }

      if (isAlt && isShift && key === 'a') {
        event.preventDefault();
        handleToggleBlockComment();
        return;
      }

      if (isAlt && key === 'arrowright') {
        event.preventDefault();
        handleGoToNextFile();
        return;
      }

      if (key === 'f5' && !isShift) {
        event.preventDefault();
        if (isDebugging) {
          handleContinueExecution();
        } else {
          handleStartDebugging();
        }
        return;
      }

      if (key === 'f5' && isShift) {
        event.preventDefault();
        handleStopDebugging();
        return;
      }

      if (key === 'f9') {
        event.preventDefault();
        handleToggleBreakpoint();
        return;
      }

      if (key === 'f10') {
        event.preventDefault();
        handleStepOver();
        return;
      }

      if (key === 'f11' && isShift) {
        event.preventDefault();
        handleStepOut();
        return;
      }

      if (key === 'f11' && isDebugging) {
        event.preventDefault();
        handleStepInto();
        return;
      }

      if (key === 'f11') {
        event.preventDefault();
        handleToggleFullScreen();
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  });

  useEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-collab-cursor-styles', 'true');
    document.head.appendChild(styleEl);
    const injectedCursorStyles = injectedCursorStylesRef.current;
    cursorStyleSheetRef.current = styleEl.sheet;

    return () => {
      if (styleEl.parentNode) {
        styleEl.parentNode.removeChild(styleEl);
      }
      cursorStyleSheetRef.current = null;
      injectedCursorStyles.clear();
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel?.();
    if (!editor || !model || !monaco?.Range) {
      return;
    }

    const nextBreakpointDecorations = breakpoints.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        glyphMarginClassName: breakpointsEnabled ? 'debug-breakpoint-glyph' : 'debug-breakpoint-glyph--disabled',
        linesDecorationsClassName: breakpointsEnabled ? 'debug-breakpoint-line' : 'debug-breakpoint-line--disabled',
      },
    }));

    breakpointDecorationsRef.current = editor.deltaDecorations(
      breakpointDecorationsRef.current,
      nextBreakpointDecorations,
    );

    const execDecorations = Number.isFinite(Number(currentExecutionLine))
      ? [{
        range: new monaco.Range(Number(currentExecutionLine), 1, Number(currentExecutionLine), 1),
        options: {
          isWholeLine: true,
          className: 'debug-current-line',
          glyphMarginClassName: 'debug-current-line-glyph',
        },
      }]
      : [];

    executionLineDecorationsRef.current = editor.deltaDecorations(
      executionLineDecorationsRef.current,
      execDecorations,
    );
  }, [breakpoints, breakpointsEnabled, currentExecutionLine]);

  useEffect(() => {
    if (!user) {
      return;
    }

    const normalizePresenceUser = (member = {}) => ({
      userId: member.userId,
      userName: member.userName || 'Collaborator',
      online: member.online !== false,
      status: member.online === false ? 'offline' : 'online',
      activeFileKey: String(member.activeFileKey || '__default__'),
      role: member.role === 'editor' ? 'editor' : 'viewer',
      lastSeenAt: member.lastSeenAt || null,
    });

    const applyRoomUsers = (users = [], hostUserId = '') => {
      const normalizedUsers = users.map(normalizePresenceUser);
      setUsersInRoom(normalizedUsers);

      const currentUser = normalizedUsers.find((member) => String(member.userId) === String(currentUserId));
      if (currentUser?.role) {
        setRoomRole(currentUser.role);
      }

      if (hostUserId) {
        setRoomHostId(String(hostUserId));
      }
    };

    const handleRoomJoined = (data = {}) => {
      setJoinedRoom(true);
      setRoomId(data.roomId || roomId);
      try {
        localStorage.setItem('syncCodeLastRoomId', String(data.roomId || roomId || ''));
      } catch (error) {
        // ignore storage errors
      }
      setRoomRole(data.role === 'editor' ? 'editor' : 'viewer');
      setRoomHostId(String(data.hostUserId || ''));
      if (Array.isArray(data.usersInRoom)) {
        applyRoomUsers(data.usersInRoom, data.hostUserId || '');
      }
      setWorkspaceStatus(`Joined room ${data.roomId || roomId} as ${data.role || 'viewer'}`);
    };

    const handleUserJoined = (data) => {
      if (Array.isArray(data.usersInRoom)) {
        applyRoomUsers(data.usersInRoom, roomHostId);
      }
      if (data?.userId && data.userId !== (user._id || user.id)) {
        setWorkspaceStatus(`${data.userName || 'A collaborator'} joined the session`);
      }
    };

    const handleUserLeft = (data) => {
      setUsersInRoom((prev) => prev.map((member) => (
        member.userId === data.userId
          ? { ...member, online: false, status: 'offline', lastSeenAt: new Date().toISOString() }
          : member
      )));
      setRemoteCursors((prev) => {
        const next = { ...prev };
        delete next[data.userId];
        return next;
      });
      setTypingUsers((prev) => {
        const next = { ...prev };
        delete next[data.userId];
        return next;
      });
      setRemoteUpdaters((prev) => {
        const next = { ...prev };
        delete next[data.userId];
        return next;
      });
      if (data?.userId && data.userId !== (user._id || user.id)) {
        setWorkspaceStatus(`${data.userName || 'A collaborator'} left the session`);
      }
    };

    const handlePresenceUpdated = (data) => {
      if (Array.isArray(data.usersInRoom)) {
        applyRoomUsers(data.usersInRoom, data.hostUserId || roomHostId);
      }
    };

    const handleRoomRoleUpdated = (data = {}) => {
      if (data.hostUserId) {
        setRoomHostId(String(data.hostUserId));
      }

      if (Array.isArray(data.usersInRoom)) {
        applyRoomUsers(data.usersInRoom, data.hostUserId || roomHostId);
      }
    };

    const handleRoleChange = (data = {}) => {
      if (Array.isArray(data.usersInRoom)) {
        applyRoomUsers(data.usersInRoom, roomHostId);
        return;
      }

      setUsersInRoom((previous) => previous.map((member) => (
        String(member.userId) === String(data.userId)
          ? { ...member, role: data.role === 'editor' ? 'editor' : 'viewer' }
          : member
      )));

      if (String(data.userId) === String(currentUserId)) {
        setRoomRole(data.role === 'editor' ? 'editor' : 'viewer');
      }
    };

    const handleRoleChangeDenied = (data = {}) => {
      if (String(data.userId || currentUserId) === String(currentUserId)) {
        setWorkspaceStatus(data.reason || 'Role change denied');
      }
    };

    const handlePendingChangesSnapshot = (data = {}) => {
      const incomingFileId = String(data.fileId || data.fileKey || '').trim();
      if (!incomingFileId) {
        return;
      }

      const pending = Array.isArray(data.pendingChanges)
        ? data.pendingChanges.map((item) => ({
            ...item,
            changeId: item.changeId || item.requestId,
            requestId: item.requestId || item.changeId,
          }))
        : [];

      setPendingChanges((previous) => {
        const withoutIncomingFile = previous.filter(
          (item) => String(item.fileId || item.fileKey || '').trim() !== incomingFileId,
        );
        return [...withoutIncomingFile, ...pending]
          .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
      });
      setAppliedChanges([]);
    };

    const handleChangeSuggested = (data = {}) => {
      const requestId = String(data.changeId || data.requestId || '').trim();
      console.log('[suggest-code] Manager received', {
        requestId,
        roomId: data.roomId,
        userId: data.userId,
        userName: data.userName,
        codeLength: String(data.code || '').length,
      });
      console.log('[debug][change-flow][frontend recv] change_suggested', {
        changeId: requestId,
        roomId: data.roomId,
        fileId: data.fileId || data.fileKey,
        userId: data.userId,
        userName: data.userName,
        status: data.status,
        conflict: Boolean(data.conflict),
      });

      const incomingFileId = String(data.fileId || data.fileKey || '').trim();
      if (!requestId || !incomingFileId) {
        return;
      }

      if (String(data.roomId || '') && String(roomId || '') && String(data.roomId) !== String(roomId)) {
        return;
      }

      const normalizedRequest = {
        ...data,
        changeId: requestId,
        requestId,
        status: data.status || 'pending',
      };

      setPendingChanges((previous) => {
        const next = previous.filter((item) => item.changeId !== requestId);
        next.push(normalizedRequest);
        return next.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
      });

      if (isRoomManager) {
        setRequestsPanelVisible(true);
        setLeftWorkspaceTab('git');
      }

      if (String(data.userId) !== String(currentUserId)) {
        setWorkspaceStatus(`${data.userName || 'Collaborator'} requested a change`);
      }
    };

    const handleConflictAlert = (data = {}) => {
      handleChangeSuggested({
        ...data,
        changeId: data.changeId || `conflict-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conflict: true,
      });
    };

    const handleChangeAccepted = (data = {}) => {
      console.log('[debug][change-flow][frontend recv] change_accepted', {
        changeId: data.changeId || data.requestId,
        roomId: data.roomId,
        fileId: data.fileId || data.fileKey,
        acceptedBy: data.acceptedBy,
        acceptedByName: data.acceptedByName,
        codeLength: String(data.code || '').length,
      });

      const incomingFileId = String(data.fileId || data.fileKey || '').trim();
      const currentFileId = resolveCurrentFileId();
      if (!incomingFileId) {
        return;
      }

      const isActiveFile = !currentFileId || incomingFileId === currentFileId;

      const requestId = String(data.changeId || data.requestId || '').trim();

      setPendingChanges((previous) => previous.filter((item) => item.changeId !== requestId));
      setAppliedChanges((previous) => [data, ...previous].slice(0, 60));

      if (!isActiveFile) {
        setCollabSyncState('Saved');
        setWorkspaceStatus(`${data.acceptedByName || 'Manager'} approved the request`);
        return;
      }

      // Immediate local apply for the accepter in case code-update arrives late or is filtered.
      if (typeof data.code === 'string') {
        const editor = editorRef.current;
        const model = editor ? editor.getModel() : null;
        if (model && model.getValue() !== data.code) {
          console.log('[debug][change-flow][frontend apply] change_accepted -> model.setValue', {
            changeId: data.changeId,
            oldLength: String(model.getValue() || '').length,
            newLength: String(data.code || '').length,
          });
          isReceivingRemoteUpdate.current = true;
          model.setValue(data.code);
          setTimeout(() => {
            isReceivingRemoteUpdate.current = false;
          }, 0);
        }

        setCode(data.code);
        setOriginalCode(data.code);
        lastSuggestedCodeRef.current = data.code;
        setLineCount(String(data.code || '').split('\n').length);
        setCharCount(String(data.code || '').length);
      }

      setCollabSyncState('Saved');
      setWorkspaceStatus(`${data.acceptedByName || 'Manager'} approved the request`);
    };

    const handleChangeRejected = (data = {}) => {
      const requestId = String(data.changeId || data.requestId || '').trim();
      if (!requestId) {
        return;
      }

      setPendingChanges((previous) => previous.filter(
        (item) => String(item.changeId || item.requestId || '') !== requestId,
      ));

      if (String(data.userId || '') !== String(currentUserId)) {
        setWorkspaceStatus(`${data.rejectedByName || 'Manager'} rejected a request`);
      }
    };

    const handleCodePreview = (data = {}) => {
      const {
        code: previewCode,
        language: previewLanguage,
        userId,
        userName,
        fileId,
        fileKey,
        socketId,
      } = data;

      if (typeof previewCode !== 'string') {
        return;
      }

      const socket = getSocket();
      if (socket?.id && socketId && socketId === socket.id) {
        return;
      }

      const incomingFileId = String(fileId || fileKey || '').trim();
      const currentFileId = resolveCurrentFileId();
      if (!incomingFileId || (currentFileId && incomingFileId !== currentFileId)) {
        return;
      }

      isReceivingRemoteUpdate.current = true;
      const editor = editorRef.current;
      const model = editor ? editor.getModel() : null;
      if (model && model.getValue() !== previewCode) {
        model.setValue(previewCode);
      }

      setCode(previewCode);
      if (previewLanguage) {
        setLanguage(previewLanguage);
      }
      setIsSaved(false);
      setLineCount(previewCode.split('\n').length);
      setCharCount(previewCode.length);
      setCollabSyncState('Live Preview');
      setWorkspaceStatus(`${userName || 'Collaborator'} is live editing`);

      if (userId) {
        setRemoteUpdaters((prev) => ({ ...prev, [userId]: userName }));
        setTimeout(() => {
          setRemoteUpdaters((prev) => {
            const next = { ...prev };
            delete next[userId];
            return next;
          });
        }, 1200);
      }

      setTimeout(() => {
        isReceivingRemoteUpdate.current = false;
      }, 0);
    };

    const handleReceiveCodeRun = (data = {}) => {
      const socket = getSocket();
      if (socket?.id && data.socketId && socket.id === data.socketId) {
        return;
      }

      const incomingFileId = String(data.fileId || data.fileKey || '').trim();
      const currentFileId = resolveCurrentFileId();
      if (!incomingFileId || (currentFileId && incomingFileId !== currentFileId)) {
        return;
      }

      if (typeof data.code !== 'string') {
        return;
      }

      const editor = editorRef.current;
      const model = editor ? editor.getModel() : null;
      isReceivingRemoteUpdate.current = true;
      if (model && model.getValue() !== data.code) {
        model.setValue(data.code);
      }

      setCode(data.code);
      if (data.language) {
        setLanguage(data.language);
      }
      setIsSaved(false);
      setLineCount(data.code.split('\n').length);
      setCharCount(data.code.length);
      setWorkspaceStatus(`${data.userName || 'Collaborator'} executed code`);

      setTimeout(() => {
        isReceivingRemoteUpdate.current = false;
      }, 0);
    };

    const handleCodeSync = (data) => {
      const {
        code: updatedCode,
        language: updatedLanguage,
        userId,
        userName,
        fileId,
        fileKey,
        revision,
        socketId,
        source,
        roomId: incomingRoomId,
      } = data;

      console.log('[debug][change-flow][frontend recv] code-update', {
        roomId: incomingRoomId || roomId,
        fileId: fileId || fileKey,
        revision,
        source,
        socketId,
        codeLength: String(updatedCode || '').length,
      });

      if (typeof updatedCode !== 'string') {
        return;
      }

      const socket = getSocket();
      if (socket?.id && socketId && socketId === socket.id && source !== 'change_accepted') {
        return;
      }

      const incomingFileId = String(fileId || fileKey || '').trim();
      const currentFileId = resolveCurrentFileId();

      if (!incomingFileId || (currentFileId && incomingFileId !== currentFileId)) {
        return;
      }

      const revisionKey = `${incomingRoomId || roomId || 'room'}:${incomingFileId}`;
      const nextRevision = Number.isFinite(Number(revision)) ? Number(revision) : 0;
      const previousRevision = appliedCodeRevisionsRef.current.get(revisionKey) || 0;

      if (nextRevision > 0 && nextRevision <= previousRevision) {
        return;
      }

      appliedCodeRevisionsRef.current.set(revisionKey, nextRevision || previousRevision + 1);

      if (userId) {
        setRemoteUpdaters((prev) => ({ ...prev, [userId]: userName }));
      }
      isReceivingRemoteUpdate.current = true;

      const editor = editorRef.current;
      const model = editor ? editor.getModel() : null;
      if (model && model.getValue() !== updatedCode) {
        console.log('[debug][change-flow][frontend apply] code-update -> model.setValue', {
          source,
          revision,
          oldLength: String(model.getValue() || '').length,
          newLength: String(updatedCode || '').length,
        });
        model.setValue(updatedCode);
      }

      setCode(updatedCode);
      setOriginalCode(updatedCode);
      lastSuggestedCodeRef.current = updatedCode;
      pendingSuggestionValueRef.current = updatedCode;
      setIsTyping(false);
      setCollabSyncState('Saved');
      if (updatedLanguage) {
        setLanguage(updatedLanguage);
      }

      setLineCount(updatedCode.split('\n').length);
      setCharCount(updatedCode.length);

      setTimeout(() => {
        isReceivingRemoteUpdate.current = false;
      }, 0);

      if (userId) {
        setTimeout(() => {
          setRemoteUpdaters((prev) => {
            const next = { ...prev };
            delete next[userId];
            return next;
          });
        }, 2000);
      }
    };

    const handleCodeUpdated = (data = {}) => {
      handleCodeSync(data);
      if (String(data.userId || '') !== String(currentUserId)) {
        setWorkspaceStatus(`${data.userName || 'Collaborator'} saved changes`);
      }
    };

    const handleChangeActionError = (data = {}) => {
      console.error('[debug][change-flow][frontend recv] change_action_error', data);
      setWorkspaceStatus(data.message || 'Change action failed');
    };

    const handleCursorUpdated = (data = {}) => {
      const {
        userId,
        userName,
        fileKey,
        fileId,
        position,
        line,
        column,
        socketId,
      } = data;

      if (!userId || userId === (user._id || user.id)) {
        return;
      }

      const socket = getSocket();
      if (socket?.id && socketId && socketId === socket.id) {
        return;
      }

      const scopedFileKey = String(fileId || fileKey || '__default__');
      if (scopedFileKey && activeFileKeyRef.current && scopedFileKey !== activeFileKeyRef.current) {
        return;
      }

      const nextLine = Number(position?.lineNumber || line || 1);
      const nextColumn = Number(position?.column || column || 1);

      setRemoteCursors((prev) => {
        const current = prev[userId];
        if (current && current.line === nextLine && current.column === nextColumn && current.userName === userName) {
          return prev;
        }

        return {
          ...prev,
          [userId]: { userName, line: nextLine, column: nextColumn },
        };
      });
    };

    const handleTypingStatus = (data) => {
      const { userId, userName, isTyping, fileKey } = data;
      if (!userId || userId === (user._id || user.id)) {
        return;
      }

      if (fileKey && activeFileKeyRef.current && fileKey !== activeFileKeyRef.current) {
        return;
      }

      setTypingUsers((prev) => {
        const next = { ...prev };
        if (isTyping) {
          next[userId] = userName || 'Collaborator';
        } else {
          delete next[userId];
        }
        return next;
      });
    };

    const handleFileEvent = async (data = {}) => {
      const socket = getSocket();
      if (socket?.id && data.socketId && socket.id === data.socketId) {
        return;
      }

      if (!activeProjectId) {
        return;
      }

      const eventType = data.eventType || 'file-updated';
      await refreshProjectFiles(activeProjectId);
      setWorkspaceStatus(`${data.userName || 'Collaborator'}: ${eventType.replace(/-/g, ' ')}`);
    };

    const handleFileCreated = async (data = {}) => {
      const socket = getSocket();
      if (socket?.id && data.socketId && socket.id === data.socketId) {
        return;
      }

      const createdFile = data.file || data;
      if (!createdFile?._id) {
        return;
      }

      if (!activeProjectId || String(createdFile.projectId || '') !== String(activeProjectId)) {
        return;
      }

      await refreshProjectFiles(activeProjectId);
      highlightExplorerNode(createdFile._id);
      setWorkspaceStatus(`${data.userName || 'Collaborator'} created ${createdFile.name || 'a new item'}`);
    };

    const handleTabsState = (data = {}) => {
      const socket = getSocket();
      if (socket?.id && data.socketId && socket.id === data.socketId) {
        return;
      }

      if (Array.isArray(data.tabs)) {
        isApplyingRemoteTabsRef.current = true;
        const normalizedTabs = data.tabs
          .filter((tab) => tab && tab._id)
          .map((tab) => ({
            _id: tab._id,
            name: tab.name || 'untitled',
            language: tab.language || 'javascript',
          }));
        setOpenTabs(normalizedTabs);
        if (data.activeFileId) {
          setRemoteRequestedFileId(String(data.activeFileId));
        }
        setTimeout(() => {
          isApplyingRemoteTabsRef.current = false;
        }, 0);
      }

      if (Array.isArray(data.tabs) && data.tabs.length > 0) {
        setWorkspaceStatus(`${data.userName || 'Collaborator'} synchronized tabs`);
      }
    };

    const handleActiveFileChanged = (data = {}) => {
      const socket = getSocket();
      if (socket?.id && data.socketId && socket.id === data.socketId) {
        return;
      }

      if (data.userId && data.userId !== (user._id || user.id)) {
        setWorkspaceStatus(`${data.userName || 'Collaborator'} switched file`);
        const nextFileKey = String(data.fileId || data.fileKey || '').trim();
        if (nextFileKey) {
          setRemoteRequestedFileId(nextFileKey);
        }
      }
    };

    const appendSharedOutput = (type, rawText) => {
      const lines = String(rawText || '').replace(/\r\n/g, '\n').split('\n');
      const entries = lines
        .filter((line, index) => !(index === lines.length - 1 && line === ''))
        .map((line, index) => ({
          id: `output-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${index}`,
          type,
          text: line,
          timestamp: Date.now(),
        }));

      if (entries.length === 0) {
        return;
      }

      entries.forEach((entry) => {
        appendOutputEntry(type, entry.text);
      });
    };

    const handleSharedRunOutput = (data = {}) => {
      const socket = getSocket();
      if (socket?.id && data.socketId && socket.id === data.socketId) {
        return;
      }

      console.log('[socket recv][output] output-update', {
        executionId: data.executionId || null,
        roomId: data.roomId || null,
        socketId: data.socketId || null,
        type: data.type || null,
      });

      const prefix = data.userName ? `[${data.userName}] ` : '';
      appendSharedOutput(data.type === 'stderr' ? 'stderr' : 'stdout', `${prefix}${data.data || ''}`);
    };

    const handleSharedRunDone = (data = {}) => {
      const socket = getSocket();
      if (socket?.id && data.socketId && socket.id === data.socketId) {
        return;
      }

      const prefix = data.userName ? `[${data.userName}] ` : '';
      appendSharedOutput('success', `${prefix}Execution finished`);
      setWorkspaceStatus(`${data.userName || 'Collaborator'} finished run`);
    };

    const handleSharedRunError = (data = {}) => {
      const socket = getSocket();
      if (socket?.id && data.socketId && socket.id === data.socketId) {
        return;
      }

      const prefix = data.userName ? `[${data.userName}] ` : '';
      appendSharedOutput('stderr', `${prefix}${data.error || 'Execution error'}`);
      setWorkspaceStatus(`${data.userName || 'Collaborator'} run failed`);
    };

    socketOn('user-joined', handleUserJoined);
    socketOn('user-left', handleUserLeft);
    socketOn('presence-updated', handlePresenceUpdated);
    socketOn('room-joined', handleRoomJoined);
    socketOn('room-role-updated', handleRoomRoleUpdated);
    socketOn('role-change', handleRoleChange);
    socketOn('role-change-error', handleRoleChangeDenied);
    socketOn('pending_changes_snapshot', handlePendingChangesSnapshot);
    socketOn('conflict-request', handleChangeSuggested);
    socketOn('receive-request', handleChangeSuggested);
    socketOn('change_suggested', handleChangeSuggested);
    socketOn('conflict-alert', handleConflictAlert);
    socketOn('request-approved', handleChangeAccepted);
    socketOn('change_accepted', handleChangeAccepted);
    socketOn('request-rejected', handleChangeRejected);
    socketOn('change_rejected', handleChangeRejected);
    socketOn('change_action_error', handleChangeActionError);
    socketOn('code_preview', handleCodePreview);
    socketOn('code_updated', handleCodeUpdated);
    socketOn('code-update', handleCodeSync);
    socketOn('receive-code-run', handleReceiveCodeRun);
    socketOn('sync-code', handleCodeSync);
    socketOn('cursor-move', handleCursorUpdated);
    socketOn('cursor-updated', handleCursorUpdated);
    socketOn('typing-status', handleTypingStatus);
    socketOn('file-event', handleFileEvent);
    socketOn('file-created', handleFileCreated);
    socketOn('tabs-state', handleTabsState);
    socketOn('active-file-changed', handleActiveFileChanged);
    socketOff('output-update', handleSharedRunOutput);
    socketOff('code-execution-done', handleSharedRunDone);
    socketOff('code-execution-error', handleSharedRunError);
    socketOn('output-update', handleSharedRunOutput);
    socketOn('code-execution-done', handleSharedRunDone);
    socketOn('code-execution-error', handleSharedRunError);

    return () => {
      socketOff('user-joined', handleUserJoined);
      socketOff('user-left', handleUserLeft);
      socketOff('presence-updated', handlePresenceUpdated);
      socketOff('room-joined', handleRoomJoined);
      socketOff('room-role-updated', handleRoomRoleUpdated);
      socketOff('role-change', handleRoleChange);
      socketOff('role-change-error', handleRoleChangeDenied);
      socketOff('pending_changes_snapshot', handlePendingChangesSnapshot);
      socketOff('conflict-request', handleChangeSuggested);
      socketOff('receive-request', handleChangeSuggested);
      socketOff('change_suggested', handleChangeSuggested);
      socketOff('conflict-alert', handleConflictAlert);
      socketOff('request-approved', handleChangeAccepted);
      socketOff('change_accepted', handleChangeAccepted);
      socketOff('request-rejected', handleChangeRejected);
      socketOff('change_rejected', handleChangeRejected);
      socketOff('change_action_error', handleChangeActionError);
      socketOff('code_preview', handleCodePreview);
      socketOff('code_updated', handleCodeUpdated);
      socketOff('code-update', handleCodeSync);
      socketOff('receive-code-run', handleReceiveCodeRun);
      socketOff('sync-code', handleCodeSync);
      socketOff('cursor-move', handleCursorUpdated);
      socketOff('cursor-updated', handleCursorUpdated);
      socketOff('typing-status', handleTypingStatus);
      socketOff('file-event', handleFileEvent);
      socketOff('file-created', handleFileCreated);
      socketOff('tabs-state', handleTabsState);
      socketOff('active-file-changed', handleActiveFileChanged);
      socketOff('output-update', handleSharedRunOutput);
      socketOff('code-execution-done', handleSharedRunDone);
      socketOff('code-execution-error', handleSharedRunError);

      // eslint-disable-next-line react-hooks/exhaustive-deps -- capture timeout refs for cleanup
      const codeUpdateTimeoutId = codeUpdateTimeout.current;
      const previewEmitTimeoutId = previewEmitTimeoutRef.current;
      const typingStatusTimeoutId = typingStatusTimeout.current;
      const typingIndicatorTimeoutId = typingIndicatorTimeoutRef.current;

      if (codeUpdateTimeoutId) {
        clearTimeout(codeUpdateTimeoutId);
      }

      if (previewEmitTimeoutId) {
        clearTimeout(previewEmitTimeoutId);
      }

      if (typingStatusTimeoutId) {
        clearTimeout(typingStatusTimeoutId);
      }

      if (typingIndicatorTimeoutId) {
        clearTimeout(typingIndicatorTimeoutId);
      }

      if (cursorEmitTimeoutRef.current) {
        clearTimeout(cursorEmitTimeoutRef.current);
      }

      if (explorerHighlightTimeoutRef.current) {
        clearTimeout(explorerHighlightTimeoutRef.current);
      }
    };
  }, [roomId, user, activeProjectId, refreshProjectFiles, currentUserId, roomHostId, resolveCurrentFileId, highlightExplorerNode, isRoomManager, appendOutputEntry]);

  useEffect(() => {
    if (!joinedRoom || !roomId || !user) {
      return;
    }

    const handleSocketReconnectJoin = () => {
      const editor = editorRef.current;
      const currentCode = typeof editor?.getValue === 'function' ? editor.getValue() : '';
      const fileId = resolveCurrentFileId();

      console.log('JOIN ROOM:', roomId, { socketReconnect: true, fileId, userId: user._id || user.id });
      joinRoom(roomId, user._id || user.id, user.name, fileId, currentCode, language);
    };

    socketOff('connect', handleSocketReconnectJoin);
    socketOn('connect', handleSocketReconnectJoin);

    return () => {
      socketOff('connect', handleSocketReconnectJoin);
    };
  }, [joinedRoom, roomId, user, language, resolveCurrentFileId]);

  useEffect(() => {
    if (!joinedRoom) {
      setPendingChanges([]);
      setAppliedChanges([]);
      setCollabSyncState('Saved');
      return;
    }

    setPendingChanges([]);
    setAppliedChanges([]);
    setCollabSyncState('Saved');
    const editor = editorRef.current;
    const baseline = typeof editor?.getValue === 'function' ? editor.getValue() : '';
    setOriginalCode(baseline);
    lastSuggestedCodeRef.current = baseline;
  }, [joinedRoom, roomId, activeFileId]);

  useEffect(() => {
    if (!joinedRoom || !user) {
      return;
    }

    if (isApplyingRemoteFileSelectionRef.current) {
      return;
    }

    const fileId = resolveCurrentFileId();
    emitActiveFilePresence(user._id || user.id, fileId);
    emitActiveFileChanged(fileId);
  }, [joinedRoom, user, resolveCurrentFileId]);

  useEffect(() => {
    if (!joinedRoom) {
      return;
    }

    if (isApplyingRemoteTabsRef.current) {
      return;
    }

    const sanitizedTabs = openTabs.map((tab) => ({
      _id: tab._id,
      name: tab.name,
      language: tab.language,
    }));
    emitTabsState(sanitizedTabs, activeFileId || null);
  }, [joinedRoom, openTabs, activeFileId]);

  useEffect(() => {
    if (!filePickerOpen) {
      setFilePickerResults([]);
      setFilePickerActiveIndex(0);
      return;
    }

    const shouldUseBackendSearch = ['Go to File', 'Open File', 'Find in Files'].includes(filePickerTitle);
    if (!shouldUseBackendSearch) {
      const local = files.filter((item) => (item.itemType || 'file') === 'file');
      setFilePickerResults(local);
      setFilePickerActiveIndex(0);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        if (!activeProjectId) {
          const local = files.filter((item) => (item.itemType || 'file') === 'file');
          setFilePickerResults(local);
          setFilePickerActiveIndex(0);
          return;
        }

        const response = await fileAPI.search(activeProjectId, filePickerQuery, 40);
        const results = (response?.data?.results || []).filter((item) => (item.itemType || 'file') === 'file');
        setFilePickerResults(results);
        setFilePickerActiveIndex(0);
      } catch (error) {
        console.error('File search failed:', error);
        const fallback = files.filter((item) => {
          if ((item.itemType || 'file') !== 'file') {
            return false;
          }
          return String(item.name || '').toLowerCase().includes(String(filePickerQuery || '').toLowerCase());
        });
        setFilePickerResults(fallback);
        setFilePickerActiveIndex(0);
      }
    }, 120);

    return () => clearTimeout(timer);
  }, [activeProjectId, filePickerOpen, filePickerQuery, filePickerTitle, files]);

  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) {
      return;
    }

    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor.getModel();
    if (!model) {
      return;
    }

    const lineMax = model.getLineCount();
    const decorations = Object.entries(remoteCursors).map(([userId, cursor]) => {
      ensureCursorStylesForUser(userId);
      const classSuffix = getCursorClassSuffix(userId);
      const safeLine = Math.min(Math.max(cursor.line || 1, 1), lineMax);
      const maxColumn = model.getLineMaxColumn(safeLine);
      const safeColumn = Math.min(Math.max(cursor.column || 1, 1), maxColumn);

      return {
        range: new monaco.Range(safeLine, safeColumn, safeLine, safeColumn),
        options: {
          className: `remote-cursor-line-${classSuffix}`,
          after: {
            content: cursor.userName || 'Collaborator',
            inlineClassName: `remote-cursor-label-${classSuffix}`,
          },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          hoverMessage: { value: `Editing: ${cursor.userName || 'Collaborator'}` },
        },
      };
    });

    cursorDecorationsRef.current = editor.deltaDecorations(cursorDecorationsRef.current, decorations);
  }, [remoteCursors, ensureCursorStylesForUser, getCursorClassSuffix]);

  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) {
      return;
    }

    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor.getModel();
    if (!model) {
      return;
    }

    const pendingForCurrentFile = pendingChanges
      .filter((change) => String(change.fileId || change.fileKey || '') === resolveCurrentFileId())
      .filter((change) => change.status === 'pending');

    const nextDecorations = pendingForCurrentFile.map((change) => {
      const safeStartLine = Math.min(Math.max(Number(change.startLine) || 1, 1), model.getLineCount());
      const safeEndLine = Math.min(Math.max(Number(change.endLine) || safeStartLine, safeStartLine), model.getLineCount());

      const decorationClass = change.conflict
        ? 'suggestion-line suggestion-line--conflict'
        : (String(change.removedText || '').length > 0
          ? 'suggestion-line suggestion-line--remove'
          : 'suggestion-line suggestion-line--add');

      return {
        range: new monaco.Range(safeStartLine, 1, safeEndLine, model.getLineMaxColumn(safeEndLine)),
        options: {
          isWholeLine: true,
          className: decorationClass,
          glyphMarginClassName: change.conflict ? 'suggestion-glyph suggestion-glyph--conflict' : 'suggestion-glyph',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          hoverMessage: {
            value: change.conflict
              ? `Conflict with pending changes (${(change.conflictWith || []).length})`
              : `Suggested by ${change.userName || 'Collaborator'}`,
          },
        },
      };
    });

    suggestionDecorationsRef.current = editor.deltaDecorations(suggestionDecorationsRef.current, nextDecorations);
  }, [pendingChanges, resolveCurrentFileId]);

  const updateLineActionPopoverPosition = useCallback((change) => {
    const editor = editorRef.current;
    if (!editor || !change) {
      setLineActionPopover((previous) => ({ ...previous, visible: false }));
      return;
    }

    const anchorLine = Number(change.startLine || 1);
    const anchorColumn = Math.max(1, Number(change.startColumn || 1));
    const position = editor.getScrolledVisiblePosition({ lineNumber: anchorLine, column: anchorColumn });
    const layout = editor.getLayoutInfo();

    if (!position) {
      setLineActionPopover((previous) => ({ ...previous, visible: false }));
      return;
    }

    const estimatedWidth = 290;
    const left = Math.min(
      Math.max(layout.contentLeft + 20, position.left + layout.contentLeft + 24),
      Math.max(layout.contentLeft + 20, layout.width - estimatedWidth - 12),
    );
    const top = Math.max(8, position.top + 2);

    setLineActionPopover({
      visible: true,
      top,
      left,
      changeId: change.changeId,
    });
  }, []);

  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) {
      return undefined;
    }

    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const disposable = editor.onMouseDown((event) => {
      const targetType = event.target?.type;
      const isGutterClick = [
        monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
        monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
      ].includes(targetType);

      if (!isGutterClick) {
        return;
      }

      const clickedLine = Number(event.target?.position?.lineNumber || 0);
      if (!clickedLine) {
        return;
      }

      const currentFileId = resolveCurrentFileId();
      const targetChange = pendingChanges
        .filter((change) => String(change.fileId || change.fileKey || '') === currentFileId)
        .filter((change) => change.status === 'pending')
        .find((change) => clickedLine >= Number(change.startLine || 1) && clickedLine <= Number(change.endLine || change.startLine || 1));

      if (!targetChange) {
        setInlineActionChangeId('');
        return;
      }

      setInlineActionChangeId(targetChange.changeId);
      updateLineActionPopoverPosition(targetChange);
      setBottomPanelTab('terminal');
      setWorkspaceStatus(`Selected suggestion by ${targetChange.userName || 'Collaborator'} on line ${clickedLine}`);
    });

    return () => {
      disposable?.dispose?.();
    };
  }, [pendingChanges, resolveCurrentFileId, setBottomPanelTab, updateLineActionPopoverPosition]);

  const handleAcceptPendingChange = useCallback((changeId) => {
    if (!joinedRoom || !roomId || !changeId) {
      return;
    }

    if (!isRoomOwner) {
      setWorkspaceStatus('Only the room owner can approve requests');
      return;
    }

    const targetChange = pendingChanges.find((change) => String(change.changeId || change.requestId || '') === String(changeId) && change.status === 'pending');
    const fileId = String(targetChange?.fileId || targetChange?.fileKey || resolveCurrentFileId());
    console.log('[debug][change-flow][frontend click] ACCEPT CLICKED', {
      changeId,
      roomId,
      fileId,
      pendingCount: pendingChanges.length,
    });
    if (targetChange) {
      const resolvedRequestId = targetChange.requestId || targetChange.changeId;
      setPendingChanges((previous) => previous.filter((change) => String(change.changeId || change.requestId || '') !== String(resolvedRequestId)));
      emitAcceptSuggestion({
        roomId,
        fileId,
        requestId: resolvedRequestId,
      });
      return;
    }

    emitAcceptSuggestion({ roomId, fileId, requestId: changeId });
  }, [joinedRoom, roomId, resolveCurrentFileId, pendingChanges, isRoomOwner]);

  const handleRejectPendingChange = useCallback((changeId) => {
    if (!joinedRoom || !roomId || !changeId) {
      return;
    }

    if (!isRoomOwner) {
      setWorkspaceStatus('Only the room owner can reject requests');
      return;
    }

    const targetChange = pendingChanges.find(
      (change) => String(change.changeId || change.requestId || '') === String(changeId) && change.status === 'pending',
    );
    const fileId = String(targetChange?.fileId || targetChange?.fileKey || resolveCurrentFileId());
    const editor = editorRef.current;
    const currentValue = editor && typeof editor.getValue === 'function'
      ? editor.getValue()
      : code;
    setPendingChanges((previous) => previous.filter((change) => String(change.changeId || change.requestId || '') !== String(changeId)));
    console.log('[debug][change-flow][frontend click] REJECT CLICKED', {
      changeId,
      roomId,
      fileId,
      pendingCount: pendingChanges.length,
      codeLength: String(currentValue || '').length,
    });
    emitRejectSuggestion({
      roomId,
      fileId,
      requestId: changeId,
      code: currentValue,
      language,
      userId: user?._id || user?.id,
      userName: user?.name || user?.email || 'Manager',
    });
  }, [joinedRoom, roomId, resolveCurrentFileId, pendingChanges, isRoomOwner, code, language, user]);

  useEffect(() => {
    if (!inlineActionChangeId) {
      setLineActionPopover((previous) => ({ ...previous, visible: false, changeId: '' }));
      return;
    }

    const target = pendingChanges.find((change) => change.changeId === inlineActionChangeId && change.status === 'pending');
    const stillExists = Boolean(target);
    if (!stillExists) {
      setInlineActionChangeId('');
      setLineActionPopover((previous) => ({ ...previous, visible: false, changeId: '' }));
      return;
    }

    updateLineActionPopoverPosition(target);
  }, [inlineActionChangeId, pendingChanges, updateLineActionPopoverPosition]);

  useEffect(() => {
    if (!editorRef.current || !inlineActionChangeId) {
      return undefined;
    }

    const editor = editorRef.current;
    const onScrollDisposable = editor.onDidScrollChange(() => {
      const target = pendingChanges.find((change) => change.changeId === inlineActionChangeId && change.status === 'pending');
      if (!target) {
        setLineActionPopover((previous) => ({ ...previous, visible: false, changeId: '' }));
        return;
      }
      updateLineActionPopoverPosition(target);
    });

    return () => {
      onScrollDisposable?.dispose?.();
    };
  }, [inlineActionChangeId, pendingChanges, updateLineActionPopoverPosition]);

  const shouldEmitSuggestion = useCallback((previousCode, nextCode, triggerMode = 'auto') => {
    if (String(previousCode) === String(nextCode)) {
      return false;
    }

    // Explicit triggers must always submit once requested.
    if (triggerMode === 'manual' || triggerMode === 'enter') {
      return true;
    }

    const delta = summarizeCodeDelta(previousCode, nextCode);
    const deltaMagnitude = Math.max(
      String(delta.addedText || '').trim().length,
      String(delta.removedText || '').trim().length,
    );
    const includesLineBreak = String(delta.addedText || '').includes('\n') || String(delta.removedText || '').includes('\n');

    return includesLineBreak || deltaMagnitude >= MIN_MEANINGFUL_DELTA_CHARS;
  }, []);

  const sendChange = useCallback((nextValue, triggerMode = 'manual') => {
    if (!joinedRoom || !user) {
      console.log('[debug][trigger] sendChange skipped: not in room/user missing', {
        joinedRoom,
        hasUser: Boolean(user),
        triggerMode,
      });
      return false;
    }

    if (isRoomManager) {
      return false;
    }

    if (triggerMode === 'auto') {
      return false;
    }

    if (isRoomManager) {
      return false;
    }

    const fileId = resolveCurrentFileId();
    const previousCode = lastSuggestedCodeRef.current;
    const nextCode = String(nextValue || '');

    if (!shouldEmitSuggestion(previousCode, nextCode, triggerMode)) {
      console.log('[debug][trigger] sendChange skipped: threshold/no diff', {
        triggerMode,
        previousLength: String(previousCode || '').length,
        nextLength: String(nextCode || '').length,
      });
      return false;
    }

    const delta = summarizeCodeDelta(previousCode, nextCode);
    console.log('[debug][trigger] sendChange skipped', {
      roomId,
      fileId,
      socketId: getSocket()?.id || null,
      codeLength: String(nextCode || '').length,
      triggerMode,
      deltaSize: Math.max(String(delta.addedText || '').length, String(delta.removedText || '').length),
    });

    lastSuggestedCodeRef.current = nextCode;
    setIsTyping(false);
    return true;
  }, [isRoomManager, joinedRoom, resolveCurrentFileId, roomId, shouldEmitSuggestion, user]);

  const handleEditorChange = (value = '') => {
    if (DEBUG_EDITOR_FOCUS) {
      console.log('[editor change]', {
        length: value.length,
        activeElement: document.activeElement?.tagName || 'unknown',
        bottomPanelTab,
        terminalVisible,
      });
    }

    if (isReceivingRemoteUpdate.current) {
      return;
    }

    if (effectiveReadOnlyMode) {
      return;
    }

    setCode(value);
    setIsSaved(false);
    setLineCount(value.split('\n').length);
    setCharCount(value.length);
    setIsTyping(true);
    setCollabSyncState(isRoomOwner ? 'Live Preview' : 'Request Draft');
    setLastChangeTime(Date.now());
    pendingSuggestionValueRef.current = value;

    if (codeUpdateTimeout.current) {
      clearTimeout(codeUpdateTimeout.current);
    }

    if (typingIndicatorTimeoutRef.current) {
      clearTimeout(typingIndicatorTimeoutRef.current);
    }
    typingIndicatorTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
    }, 1500);

    if (typingStatusTimeout.current) {
      clearTimeout(typingStatusTimeout.current);
    }

    if (joinedRoom && user) {
      const fileId = resolveCurrentFileId();

      if (isRoomOwner) {
        if (previewEmitTimeoutRef.current) {
          clearTimeout(previewEmitTimeoutRef.current);
        }
        previewEmitTimeoutRef.current = setTimeout(() => {
          emitCodeTyping({
            code: pendingSuggestionValueRef.current,
            language,
            userId: user._id || user.id,
            roomId,
            fileId,
          });
        }, LIVE_PREVIEW_DEBOUNCE_MS);
      }

      emitTypingStatus(user._id || user.id, true, fileId);
      typingStatusTimeout.current = setTimeout(() => {
        emitTypingStatus(user._id || user.id, false, fileId);
      }, 1200);
    }

  };

  const handleSubmitChangeSuggestion = useCallback(() => {
    if (isRoomManager) {
      setWorkspaceStatus('Manager edits are applied directly; no conflict request is sent.');
      return;
    }

    const editor = editorRef.current;
    const currentValue = editor && typeof editor.getValue === 'function'
      ? editor.getValue()
      : code;
    const fileId = resolveCurrentFileId();

    pendingSuggestionValueRef.current = currentValue;
    if (codeUpdateTimeout.current) {
      clearTimeout(codeUpdateTimeout.current);
    }
    console.log('[debug][change-flow][frontend emit] suggest-code', {
      roomId,
      fileId,
      userId: user?._id || user?.id,
      role: isRoomManager ? 'manager' : 'member',
      codeLength: String(currentValue || '').length,
    });
    emitSuggestCode({
      roomId,
      fileId,
      code: currentValue,
      userId: user?._id || user?.id,
      role: isRoomManager ? 'manager' : 'member',
      source: 'manual',
    });
    setWorkspaceStatus('Suggestion sent to manager');
  }, [code, isRoomManager, resolveCurrentFileId, roomId, user]);

  useEffect(() => {
    if (!user || effectiveReadOnlyMode) {
      return;
    }

    if (!activeProjectId || !String(fileName || '').trim()) {
      return;
    }

    const signature = getCodeSignature(code, language, fileName);
    if (signature === lastAutoSaveSignatureRef.current) {
      return;
    }

    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    setAutoSaveStatus('pending');

    autoSaveTimeoutRef.current = setTimeout(async () => {
      if (isAutoSavingRef.current) {
        return;
      }

      isAutoSavingRef.current = true;
      try {
        const response = await fileAPI.autoSave({
          fileId: activeFileId || undefined,
          projectId: activeProjectId,
          fileName,
          code,
          language,
        });

        const savedFile = response?.data?.file;
        if (savedFile?._id && !activeFileId) {
          setActiveFileId(savedFile._id);
          emitFileEvent('file-created', { file: savedFile });
        }

        if (savedFile?.name && savedFile.name !== fileName) {
          setFileName(savedFile.name);
        }

        if (response?.data?.autoSaved) {
          setLastAutoSavedAt(new Date().toISOString());
          setWorkspaceStatus('Auto-saved');
        }

        lastAutoSaveSignatureRef.current = signature;
        setIsSaved(true);
        setAutoSaveStatus(response?.data?.skipped ? 'synced' : 'saved');
      } catch (error) {
        console.error('Autosave failed:', error);
        setAutoSaveStatus('error');
      } finally {
        isAutoSavingRef.current = false;
      }
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, [activeFileId, activeProjectId, code, effectiveReadOnlyMode, fileName, getCodeSignature, language, user]);

  const handleEditorMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleSave();
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => {
      setCommandPaletteOpen(true);
    });

    editor.addCommand(monaco.KeyCode.F9, () => {
      handleToggleBreakpoint();
    });

    editor.onKeyDown((event) => {
      if (event.keyCode !== monaco.KeyCode.Enter) {
        return;
      }

      const currentValue = editor.getValue();
      pendingSuggestionValueRef.current = currentValue;
      if (codeUpdateTimeout.current) {
        clearTimeout(codeUpdateTimeout.current);
      }

      console.log('[debug][trigger] ENTER PRESSED', {
        mode: suggestionTriggerModeRef.current,
        codeLength: String(currentValue || '').length,
      });

      sendChange(currentValue, 'enter');
    });

    editor.onDidChangeCursorPosition((event) => {
      setCursorPosition({
        lineNumber: event.position.lineNumber,
        column: event.position.column,
      });

      if (!joinedRoom || !user || isReceivingRemoteUpdate.current) {
        return;
      }

      const { lineNumber, column } = event.position;
      const fileKey = resolveCurrentFileId();

      const previous = lastCursorPositionRef.current;
      if (
        previous.lineNumber === lineNumber
        && previous.column === column
        && previous.fileKey === fileKey
      ) {
        return;
      }

      lastCursorPositionRef.current = { lineNumber, column, fileKey };

      const emitNow = () => {
        lastCursorEmitAtRef.current = Date.now();
        emitCursorUpdate(lineNumber, column, user._id || user.id, fileKey);
      };

      const elapsed = Date.now() - lastCursorEmitAtRef.current;
      if (elapsed >= 40) {
        emitNow();
        return;
      }

      if (cursorEmitTimeoutRef.current) {
        clearTimeout(cursorEmitTimeoutRef.current);
      }

      cursorEmitTimeoutRef.current = setTimeout(() => {
        emitNow();
      }, 40 - elapsed);
    });

    editor.onMouseDown((event) => {
      const mouseTargetType = event.target?.type;
      const isGutterClick = mouseTargetType === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
        || mouseTargetType === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;

      if (!isGutterClick) {
        return;
      }

      const lineNumber = event.target?.position?.lineNumber;
      if (!lineNumber) {
        return;
      }

      handleToggleBreakpoint(lineNumber);
    });

    editor.focus();
  };

  const handleSave = async ({ silent = false } = {}) => {
    if (guardReadOnlyWrite()) {
      return false;
    }

    if (joinedRoom && !isRoomManager) {
      setWorkspaceStatus('Saved locally. Run to send this code snapshot to manager.');
    }

    setSaving(true);
    try {
      const saveResponse = await codeAPI.save({
        fileId: activeFileId || undefined,
        projectId: activeProjectId || undefined,
        fileName,
        code,
        language,
      });

      const savedFile = saveResponse.data.file;
      setActiveFileId(savedFile?._id || activeFileId);
      if (savedFile?.name) {
        setFileName(savedFile.name);
      }
      setIsSaved(true);
      setCollabSyncState('Saved');
      lastAutoSaveSignatureRef.current = getCodeSignature(code, language, savedFile?.name || fileName);
      setAutoSaveStatus('saved');
      setWorkspaceStatus('File saved');

      if (joinedRoom && user && isRoomManager) {
        emitCodeCommit({
          code,
          language,
          userId: user._id || user.id,
          roomId,
          fileId: resolveCurrentFileId(),
        });
      }

      await loadProjectsAndFiles();
      emitFileEvent('file-saved', { file: savedFile });
      if (!silent) {
        alert('Code saved successfully!');
      }
      return true;
    } catch (error) {
      console.error('Save error:', error);
      if (!silent) {
        alert(error.response?.data?.message || 'An error occurred while saving');
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAs = async () => {
    if (guardReadOnlyWrite()) {
      return;
    }

    const nextName = window.prompt('Save As file name', fileName || 'untitled.js');
    if (!nextName || !nextName.trim()) {
      return;
    }

    setFileName(nextName.trim());
    setActiveFileId('');

    try {
      setSaving(true);
      const saveResponse = await codeAPI.save({
        projectId: activeProjectId || undefined,
        fileName: nextName.trim(),
        code,
        language,
      });

      setActiveFileId(saveResponse.data.file?._id || '');
      setIsSaved(true);
      lastAutoSaveSignatureRef.current = getCodeSignature(code, language, saveResponse?.data?.file?.name || nextName.trim());
      setAutoSaveStatus('saved');
      await loadProjectsAndFiles();
      emitFileEvent('file-created', { file: saveResponse?.data?.file });
      alert('File saved as new copy');
    } catch (error) {
      console.error('Save As error:', error);
      alert(error.response?.data?.message || 'Unable to save as new file');
    } finally {
      setSaving(false);
    }
  };

  const handleNewFile = () => {
    if (guardReadOnlyWrite()) {
      return;
    }

    const nextDocument = createEmptyDocument(language);
    setFileName(nextDocument.fileName);
    setCode(nextDocument.code);
    setActiveFileId('');
    setOpenTabs((tabs) => {
      const unsavedTabId = '__unsaved__';
      const nextTab = { _id: unsavedTabId, name: nextDocument.fileName, language };
      const deduped = tabs.filter((tab) => tab._id !== unsavedTabId);
      return [nextTab, ...deduped].slice(0, 12);
    });
    setIsSaved(false);
    setWorkspaceStatus('New file created');
    editorRef.current?.focus();
  };

  const handleCloseFile = () => {
    if (!isSaved) {
      const confirmClose = window.confirm('You have unsaved changes. Close anyway?');
      if (!confirmClose) {
        return;
      }
    }

    if (!activeFileId) {
      const nextDocument = createEmptyDocument(language);
      setFileName(nextDocument.fileName);
      setCode(nextDocument.code);
      setActiveFileId('');
      setOpenTabs((tabs) => tabs.filter((tab) => tab._id !== '__unsaved__'));
      setIsSaved(true);
      setWorkspaceStatus('File closed');
      return;
    }

    const closingFileId = String(activeFileId);
    const remainingTabs = openTabs.filter((tab) => String(tab._id) !== closingFileId);
    setOpenTabs(remainingTabs);

    const nextTab = remainingTabs[0];
    if (nextTab && nextTab._id && nextTab._id !== '__unsaved__') {
      loadFileById(nextTab._id);
      setWorkspaceStatus(`Closed ${fileName}`);
      return;
    }

    const nextDocument = createEmptyDocument(language);
    setFileName(nextDocument.fileName);
    setCode(nextDocument.code);
    setActiveFileId('');
    setIsSaved(true);
    setWorkspaceStatus(`Closed ${fileName}`);
  };

  const loadFileById = useCallback(async (fileId) => {
    const localFile = files.find((item) => String(item?._id || '') === String(fileId) && item.source === 'local-folder');
    if (localFile) {
      const localContent = String(localFile.content || '');
      const detectedLanguage = getLanguageFromFileName(localFile.name) || localFile.language || 'javascript';
      setCode(localContent);
      setFileName(localFile.name || 'untitled.js');
      setLanguage(detectedLanguage);
      setActiveFileId(localFile._id);
      setOpenTabs((tabs) => {
        const deduped = tabs.filter((tab) => tab._id !== localFile._id);
        return [
          { _id: localFile._id, name: localFile.name || 'untitled.js', language: detectedLanguage },
          ...deduped,
        ].slice(0, 12);
      });
      setIsSaved(false);
      setAutoSaveStatus('idle');
      setWorkspaceStatus(`Opened ${localFile.localPath || localFile.name}`);
      rememberRecentFile(localFile);
      editorRef.current?.focus();
      return;
    }

    try {
      const fileResponse = await codeAPI.load(fileId);
      const file = fileResponse.data.file;

      setCode(file.content || '');
      setFileName(file.name || 'untitled.js');
      setLanguage(getLanguageFromFileName(file.name) || file.language || 'javascript');
      setActiveFileId(file._id);
      setActiveProjectId(file.projectId);
      setOpenTabs((tabs) => {
        const deduped = tabs.filter((tab) => tab._id !== file._id);
        return [
          { _id: file._id, name: file.name, language: file.language || 'javascript' },
          ...deduped,
        ].slice(0, 12);
      });
      setIsSaved(true);
      lastAutoSaveSignatureRef.current = getCodeSignature(file.content || '', getLanguageFromFileName(file.name) || file.language || 'javascript', file.name || 'untitled.js');
      setAutoSaveStatus('synced');
      setWorkspaceStatus(`Opened ${file.name}`);
      rememberRecentFile(file);
      if (joinedRoom && !isApplyingRemoteFileSelectionRef.current) {
        emitActiveFileChanged(file._id);
      }
      editorRef.current?.focus();
    } catch (error) {
      console.error('Open file error:', error);
      alert(error.response?.data?.message || 'Unable to open file');
    }
  }, [files, getCodeSignature, getLanguageFromFileName, joinedRoom, rememberRecentFile]);

  useEffect(() => {
    if (!remoteRequestedFileId) {
      return;
    }

    if (String(remoteRequestedFileId) === String(activeFileId || '')) {
      setRemoteRequestedFileId('');
      return;
    }

    let cancelled = false;

    const syncRemoteFile = async () => {
      isApplyingRemoteFileSelectionRef.current = true;
      try {
        await loadFileById(remoteRequestedFileId);
      } catch (error) {
        console.error('Failed to sync remote active file:', error);
      } finally {
        isApplyingRemoteFileSelectionRef.current = false;
        if (!cancelled) {
          setRemoteRequestedFileId('');
        }
      }
    };

    syncRemoteFile();

    return () => {
      cancelled = true;
    };
  }, [remoteRequestedFileId, activeFileId, loadFileById]);

  const handleSelectProject = async (project) => {
    if (!project?._id) {
      return;
    }

    setActiveProjectId(project._id);
    setActiveFileId('');
    setWorkspaceStatus(`Selected ${project.name}`);
    rememberRecentProject(project);
    await refreshProjectFiles(project._id);
  };

  const handleOpenFile = async () => {
    const quickSelectableFiles = fileMenuState.files.filter((item) => item.id && item.id !== '__unsaved__');
    if (quickSelectableFiles.length > 0) {
      const quickRows = quickSelectableFiles.map((item, index) => `${index + 1}. ${item.name}`);
      const quickSelection = window.prompt(`Open File:\n${quickRows.join('\n')}`, '1');

      if (quickSelection !== null && quickSelection.trim() !== '') {
        const selectedIndex = Number.parseInt(quickSelection, 10) - 1;
        if (Number.isFinite(selectedIndex) && selectedIndex >= 0 && selectedIndex < quickSelectableFiles.length) {
          await loadFileById(quickSelectableFiles[selectedIndex].id);
          return;
        }
      }
    }

    let availableFiles = files;

    if (!activeProjectId) {
      await loadProjectsAndFiles();
    }

    if (availableFiles.length === 0 && activeProjectId) {
      const refreshed = await fileAPI.list(activeProjectId);
      availableFiles = refreshed.data.files || [];
      setFiles(availableFiles);
    }

    if (availableFiles.length === 0) {
      alert('No files found in the current project. Use New File or Save to create one.');
      return;
    }

    setFilePickerTitle('Open File');
    setFilePickerQuery('');
    setFilePickerOpen(true);
  };

  const handleOpenLocalFile = () => {
    localFileInputRef.current?.click();
  };

  const handleOpenFolder = async () => {
    const element = document.getElementById('folderInput');
    if (element) {
      element.value = '';
      element.click();
      return;
    }

    localFolderInputRef.current?.click();
  };

  const loadVersionHistory = useCallback(async () => {
    if (!activeFileId) {
      setFileVersions([]);
      return;
    }

    setVersionLoading(true);
    try {
      const response = await fileAPI.listVersions(activeFileId, 80);
      setFileVersions(response?.data?.versions || []);
    } catch (error) {
      console.error('Failed to load versions:', error);
      setFileVersions([]);
    } finally {
      setVersionLoading(false);
    }
  }, [activeFileId]);

  const handleOpenVersionHistory = async () => {
    if (!activeFileId) {
      alert('Save this file first to access version history.');
      return;
    }
    setVersionHistoryOpen(true);
    await loadVersionHistory();
  };

  const handleRestoreVersion = async (versionId) => {
    if (!activeFileId || !versionId) {
      return;
    }

    try {
      const response = await fileAPI.restoreVersion(activeFileId, versionId);
      const restoredFile = response?.data?.file;
      if (restoredFile) {
        setCode(restoredFile.content || '');
        setLanguage(restoredFile.language || language);
        setIsSaved(true);
        setWorkspaceStatus(`Restored version #${response?.data?.restoredFrom?.versionNumber || ''}`);
        lastAutoSaveSignatureRef.current = getCodeSignature(restoredFile.content || '', restoredFile.language || language, restoredFile.name || fileName);
        emitFileEvent('file-restored', {
          fileId: restoredFile._id,
          versionId,
        });
      }
      await loadVersionHistory();
    } catch (error) {
      console.error('Restore version failed:', error);
      alert(getApiErrorMessage(error, 'Unable to restore version'));
    }
  };

  const handleLocalFileSelected = async (event) => {
    const selectedFile = event.target?.files?.[0];
    if (!selectedFile) {
      return;
    }

    try {
      const text = await selectedFile.text();
      const detectedLanguage = getLanguageFromFileName(selectedFile.name) || language;
      setFileName(selectedFile.name);
      setLanguage(detectedLanguage);
      setCode(text);
      setActiveFileId('');
      setIsSaved(false);
      setLineCount(text.split('\n').length);
      setCharCount(text.length);
      setWorkspaceStatus(`Loaded local file: ${selectedFile.name}`);
      editorRef.current?.focus();
    } catch (error) {
      console.error('Open local file error:', error);
      alert('Unable to read selected file');
    } finally {
      if (event.target) {
        event.target.value = '';
      }
    }
  };

  const handleLocalFolderSelected = async (event) => {
    const selectedEntries = Array.from(event.target?.files || []);
    if (selectedEntries.length === 0) {
      return;
    }

    try {
      setWorkspaceStatus('Loading local folder...');

      const folderMap = new Map();
      const importedNodes = [];
      const fileNodes = [];

      const ensureFolderNode = (pathParts) => {
        if (!Array.isArray(pathParts) || pathParts.length === 0) {
          return null;
        }

        const folderPath = pathParts.join('/');
        if (folderMap.has(folderPath)) {
          return folderMap.get(folderPath);
        }

        const parentPath = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';
        const node = {
          _id: `local-folder:${folderPath}`,
          name: pathParts[pathParts.length - 1],
          itemType: 'folder',
          parentId: parentPath ? `local-folder:${parentPath}` : null,
          source: 'local-folder',
          projectId: '',
        };

        folderMap.set(folderPath, node);
        importedNodes.push(node);
        return node;
      };

      const filePayloads = await Promise.all(selectedEntries.map(async (entry) => {
        const relativePath = String(entry.webkitRelativePath || entry.name || '').replace(/\\+/g, '/');
        if (!relativePath) {
          return null;
        }

        const pathParts = relativePath.split('/').filter(Boolean);
        if (pathParts.length === 0) {
          return null;
        }

        const folderParts = pathParts.slice(0, -1);
        if (folderParts.length > 0) {
          for (let index = 1; index <= folderParts.length; index += 1) {
            ensureFolderNode(folderParts.slice(0, index));
          }
        }

        let textContent = '';
        try {
          textContent = await entry.text();
        } catch (error) {
          textContent = '';
        }

        const fileNameValue = pathParts[pathParts.length - 1] || entry.name || 'untitled.txt';
        const parentPath = folderParts.join('/');
        const normalizedPath = relativePath;
        return {
          _id: `local-file:${normalizedPath}`,
          name: fileNameValue,
          itemType: 'file',
          parentId: parentPath ? `local-folder:${parentPath}` : null,
          source: 'local-folder',
          projectId: '',
          localPath: normalizedPath,
          content: textContent,
          language: getLanguageFromFileName(fileNameValue) || 'javascript',
        };
      }));

      filePayloads.forEach((node) => {
        if (!node) {
          return;
        }
        importedNodes.push(node);
        fileNodes.push(node);
      });

      if (fileNodes.length === 0) {
        alert('No readable files were found in the selected folder.');
        return;
      }

      const importedTree = buildFileTree(importedNodes);
      setFiles(importedNodes);
      setFileTreeData(importedTree);
      setOpenTabs([]);
      setActiveProjectId('');

      const firstFile = fileNodes[0];
      if (firstFile?._id) {
        await loadFileById(firstFile._id);
      }

      const rootFolderName = String(selectedEntries[0]?.webkitRelativePath || selectedEntries[0]?.name || '')
        .split('/')
        .filter(Boolean)[0] || 'Folder';
      setWorkspaceStatus(`Loaded folder ${rootFolderName} (${fileNodes.length} files)`);
    } catch (error) {
      console.error('Open folder from device error:', error);
      alert('Unable to open the selected folder');
      setWorkspaceStatus('Failed to load local folder');
    } finally {
      if (event.target) {
        event.target.value = '';
      }
    }
  };

  const handleGoToFile = async () => {
    let availableFiles = files;

    if (!activeProjectId) {
      await loadProjectsAndFiles();
    }

    if (availableFiles.length === 0 && activeProjectId) {
      const refreshed = await fileAPI.list(activeProjectId);
      availableFiles = refreshed.data.files || [];
      setFiles(availableFiles);
    }

    if (availableFiles.length === 0) {
      alert('No files available in the selected project.');
      return;
    }

    setFilePickerTitle('Go to File');
    setFilePickerQuery('');
    setFilePickerOpen(true);
  };

  const handleSelectPickerFile = async (fileId) => {
    setFilePickerOpen(false);
    await loadFileById(fileId);
  };

  const getActiveProject = useCallback(() => projects.find((project) => project._id === activeProjectId) || null, [projects, activeProjectId]);

  const addOutputEntry = useCallback((type, text) => {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const entries = lines
      .filter((line, index) => !(index === lines.length - 1 && line === ''))
      .map((line, index) => ({
        id: `output-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${index}`,
        type,
        text: line,
        timestamp: Date.now(),
      }));

    if (entries.length === 0) {
      return;
    }

    entries.forEach((entry) => {
      appendOutputEntry(type, entry.text);
    });
  }, [appendOutputEntry]);

  const handleCreateProject = async () => {
    if (guardReadOnlyWrite()) {
      return;
    }

    const projectName = window.prompt('Project name', 'New Project');
    if (!projectName) {
      return;
    }

    try {
      const createResponse = await projectAPI.create(projectName.trim());
      const newProject = createResponse.data.project;
      setProjects((prev) => [newProject, ...prev]);
      setActiveProjectId(newProject._id);
      setFiles([]);
      setActiveFileId('');
      rememberRecentProject(newProject);
      setWorkspaceStatus(`Created ${newProject.name}`);
    } catch (error) {
      console.error('Create project error:', error);
      alert(error.response?.data?.message || 'Unable to create project');
    }
  };

  const runEditorAction = async (actionId) => {
    const editor = editorRef.current;
    if (!editor || typeof editor.getAction !== 'function') {
      return false;
    }

    const action = editor.getAction(actionId);
    if (!action) {
      return false;
    }

    await action.run();
    return true;
  };

  const getEditorAndModel = () => {
    const editor = editorRef.current;
    const model = editor?.getModel?.();
    const monaco = monacoRef.current;
    if (!editor || !model || !monaco?.Range) {
      return null;
    }
    return { editor, model, monaco };
  };

  const indentText = (text, spaces = 2) => String(text || '')
    .split('\n')
    .map((line) => `${' '.repeat(spaces)}${line}`)
    .join('\n');

  const expandSimpleEmmetAbbreviation = (abbreviation) => {
    const parts = String(abbreviation || '').split('>').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) {
      return '';
    }

    const parseToken = (token) => {
      const match = token.match(/^([a-zA-Z][a-zA-Z0-9-]*)(?:\*(\d+))?$/);
      if (!match) {
        return null;
      }
      return { tag: match[1], count: Math.max(1, Number.parseInt(match[2] || '1', 10)) };
    };

    let inner = '';
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const parsed = parseToken(parts[index]);
      if (!parsed) {
        return '';
      }

      const blocks = [];
      for (let i = 0; i < parsed.count; i += 1) {
        if (!inner) {
          blocks.push(`<${parsed.tag}></${parsed.tag}>`);
        } else {
          blocks.push(`<${parsed.tag}>\n${indentText(inner)}\n</${parsed.tag}>`);
        }
      }
      inner = blocks.join('\n');
    }

    return inner;
  };

  const handleCopy = async () => {
    const copied = await runEditorAction('editor.action.clipboardCopyAction');
    if (copied) {
      return;
    }

    const editorState = getEditorAndModel();
    if (!editorState) {
      return;
    }

    const { editor, model } = editorState;
    const selection = editor.getSelection?.();
    if (!selection || selection.isEmpty()) {
      return;
    }

    const selectedText = model.getValueInRange(selection);
    if (!selectedText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedText);
      setWorkspaceStatus('Copied to clipboard');
    } catch (error) {
      console.error('Copy failed:', error);
    }
  };

  const handleCut = async () => {
    const cut = await runEditorAction('editor.action.clipboardCutAction');
    if (cut) {
      return;
    }

    const editorState = getEditorAndModel();
    if (!editorState) {
      return;
    }

    const { editor, model } = editorState;
    const selection = editor.getSelection?.();
    if (!selection || selection.isEmpty()) {
      return;
    }

    const selectedText = model.getValueInRange(selection);
    if (!selectedText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedText);
      editor.executeEdits('cut-fallback', [{ range: selection, text: '' }]);
      setWorkspaceStatus('Cut selection');
    } catch (error) {
      console.error('Cut failed:', error);
    }
  };

  const handlePaste = async () => {
    const pasted = await runEditorAction('editor.action.clipboardPasteAction');
    if (pasted) {
      return;
    }

    const editorState = getEditorAndModel();
    if (!editorState) {
      return;
    }

    const { editor } = editorState;
    const selection = editor.getSelection?.();
    if (!selection) {
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      editor.executeEdits('paste-fallback', [{ range: selection, text }]);
    } catch (error) {
      console.error('Paste failed:', error);
    }
  };
  const handleUndo = async () => runEditorAction('undo');
  const handleRedo = async () => runEditorAction('redo');
  const handleSelectAll = async () => runEditorAction('editor.action.selectAll');
  const handleAddCursorAbove = async () => runEditorAction('editor.action.insertCursorAbove');
  const handleAddCursorBelow = async () => runEditorAction('editor.action.insertCursorBelow');
  const handleCopyLineUp = async () => runEditorAction('editor.action.copyLinesUpAction');
  const handleCopyLineDown = async () => runEditorAction('editor.action.copyLinesDownAction');

  const handleToggleLineComment = async () => {
    editorRef.current?.focus();
    const toggled = await runEditorAction('editor.action.commentLine');
    if (toggled) {
      return;
    }

    const editorState = getEditorAndModel();
    if (!editorState) {
      return;
    }

    const { editor, model, monaco } = editorState;
    const selections = editor.getSelections?.() || (editor.getSelection?.() ? [editor.getSelection()] : []);
    if (!selections.length) {
      return;
    }

    const edits = [];
    selections.forEach((selection) => {
      const startLine = Math.min(selection.startLineNumber, selection.endLineNumber);
      const endLine = Math.max(selection.startLineNumber, selection.endLineNumber);
      const lines = [];

      for (let line = startLine; line <= endLine; line += 1) {
        lines.push(model.getLineContent(line));
      }

      const allCommented = lines.every((line) => /^\s*\/\//.test(line));
      for (let offset = 0; offset < lines.length; offset += 1) {
        const lineNumber = startLine + offset;
        const line = lines[offset];
        if (allCommented) {
          const commentMatch = line.match(/^(\s*)\/\//);
          if (!commentMatch) {
            continue;
          }

          const startColumn = commentMatch[1].length + 1;
          edits.push({
            range: new monaco.Range(lineNumber, startColumn, lineNumber, startColumn + 2),
            text: '',
          });
        } else {
          const indentMatch = line.match(/^(\s*)/);
          const insertColumn = (indentMatch?.[1]?.length || 0) + 1;
          edits.push({
            range: new monaco.Range(lineNumber, insertColumn, lineNumber, insertColumn),
            text: '//',
          });
        }
      }
    });

    if (edits.length > 0) {
      editor.executeEdits('toggle-line-comment-fallback', edits);
    }
  };

  const handleToggleBlockComment = async () => {
    editorRef.current?.focus();
    const toggled = await runEditorAction('editor.action.blockComment');
    if (toggled) {
      return;
    }

    const editorState = getEditorAndModel();
    if (!editorState) {
      return;
    }

    const { editor, model, monaco } = editorState;
    const selection = editor.getSelection?.();
    if (!selection) {
      return;
    }

    const normalizedRange = selection.isEmpty()
      ? new monaco.Range(selection.startLineNumber, 1, selection.startLineNumber, model.getLineMaxColumn(selection.startLineNumber))
      : selection;

    const selectedText = model.getValueInRange(normalizedRange);
    const trimmed = selectedText.trim();
    const isAlreadyBlockComment = trimmed.startsWith('/*') && trimmed.endsWith('*/');

    const nextText = isAlreadyBlockComment
      ? trimmed.replace(/^\/\*/, '').replace(/\*\/$/, '').trim()
      : `/* ${selectedText} */`;

    editor.executeEdits('toggle-block-comment-fallback', [{ range: normalizedRange, text: nextText }]);
  };

  const handleEmmetExpandAbbreviation = async () => {
    editorRef.current?.focus();
    const expanded = await runEditorAction('editor.emmet.action.expandAbbreviation');
    if (expanded) {
      return;
    }

    const editorState = getEditorAndModel();
    if (!editorState) {
      return;
    }

    const { editor, model, monaco } = editorState;
    const selection = editor.getSelection?.();
    if (!selection) {
      return;
    }

    const position = editor.getPosition?.();
    const word = position ? model.getWordUntilPosition(position) : null;
    const range = selection.isEmpty() && word
      ? new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      : selection;

    const abbreviation = String(model.getValueInRange(range) || '').trim();
    if (!abbreviation) {
      setWorkspaceStatus('No Emmet abbreviation found');
      return;
    }

    const nextText = expandSimpleEmmetAbbreviation(abbreviation);
    if (!nextText) {
      setWorkspaceStatus('Unable to expand abbreviation');
      return;
    }

    editor.executeEdits('emmet-expand-fallback', [{ range, text: nextText }]);
    setWorkspaceStatus('Emmet abbreviation expanded');
  };

  const handleNewFolder = async (parentId = null, proposedName = '') => {
    if (guardReadOnlyWrite()) {
      return null;
    }

    if (!activeProjectId) {
      alert('Select a project first.');
      return null;
    }

    const folderName = String(proposedName || '').trim() || window.prompt('Folder name', 'New Folder');
    if (!folderName || !String(folderName).trim()) {
      return null;
    }

    const normalizedFolderName = String(folderName).trim();
    console.log('[explorer create] folder click', {
      roomId,
      projectId: activeProjectId,
      parentId: parentId || null,
      name: normalizedFolderName,
      socketId: getSocket()?.id || null,
    });

    try {
      console.log('[explorer create] folder api request', {
        projectId: activeProjectId,
        parentId: parentId || null,
        name: normalizedFolderName,
      });
      const response = await fileAPI.createFolder(activeProjectId, { name: normalizedFolderName, parentId: parentId || null });
      const createdFolder = response?.data?.file;
      console.log('[explorer create] folder api response', {
        fileId: createdFolder?._id || null,
        itemType: createdFolder?.itemType || null,
      });

      await refreshProjectFiles(activeProjectId);
      if (createdFolder?._id) {
        highlightExplorerNode(createdFolder._id);
      }
      emitFileEvent('folder-created', { file: createdFolder });
      if (joinedRoom && roomId && createdFolder) {
        emitFileCreate(roomId, createdFolder);
      }
      setWorkspaceStatus(`Created folder ${normalizedFolderName}`);
      return createdFolder || null;
    } catch (error) {
      console.error('Create folder error:', error);
      alert(getApiErrorMessage(error, 'Unable to create folder'));
      return null;
    }
  };

  const handleCreateFileInFolder = async (parentId = null, proposedName = '') => {
    if (guardReadOnlyWrite()) {
      return null;
    }

    if (!activeProjectId) {
      alert('Select a project first.');
      return null;
    }

    const requestedName = String(proposedName || '').trim() || window.prompt('File name', 'new-file.js');
    if (!requestedName || !requestedName.trim()) {
      return null;
    }

    const nextName = requestedName.trim();
    const nextLanguage = getLanguageFromFileName(nextName) || language || 'javascript';
    console.log('[explorer create] file click', {
      roomId,
      projectId: activeProjectId,
      parentId: parentId || null,
      name: nextName,
      language: nextLanguage,
      socketId: getSocket()?.id || null,
    });

    try {
      console.log('[explorer create] file api request', {
        projectId: activeProjectId,
        parentId: parentId || null,
        name: nextName,
      });
      const saveResponse = await fileAPI.createFile(activeProjectId, {
        name: nextName,
        parentId: parentId || null,
        language: nextLanguage,
        content: '',
      });

      const savedFile = saveResponse?.data?.file;
      console.log('[explorer create] file api response', {
        fileId: savedFile?._id || null,
        itemType: savedFile?.itemType || null,
      });
      await refreshProjectFiles(activeProjectId);

      if (savedFile?._id) {
        highlightExplorerNode(savedFile._id);
        await loadFileById(savedFile._id);
      }

      emitFileEvent('file-created', { file: savedFile });
      if (joinedRoom && roomId && savedFile) {
        emitFileCreate(roomId, savedFile);
      }
      setWorkspaceStatus(`Created ${nextName}`);
      return savedFile || null;
    } catch (error) {
      console.error('Create file in folder error:', error);
      alert(getApiErrorMessage(error, 'Unable to create file'));
      return null;
    }
  };
  const handleOpenRecent = async () => {
    const recentProjectRows = recentProjects.map((project, index) => `${index + 1}. [Project] ${project.name}`);
    const recentFileRows = recentFiles.map((file, index) => `${index + 1 + recentProjectRows.length}. [File] ${file.name}`);
    const rows = [...recentProjectRows, ...recentFileRows];

    if (rows.length === 0) {
      alert('No recent items yet.');
      return;
    }

    const selection = window.prompt(`Open Recent:\n${rows.join('\n')}`, '1');
    const selectedIndex = Number.parseInt(selection, 10) - 1;
    if (!Number.isFinite(selectedIndex) || selectedIndex < 0 || selectedIndex >= rows.length) {
      return;
    }

    if (selectedIndex < recentProjectRows.length) {
      const selectedProject = projects.find((project) => project._id === recentProjects[selectedIndex].id);
      if (selectedProject) {
        await handleSelectProject(selectedProject);
      }
      return;
    }

    const fileIndex = selectedIndex - recentProjectRows.length;
    const selectedFile = recentFiles[fileIndex];
    if (selectedFile) {
      await loadFileById(selectedFile.id);
    }
  };

  const handleSaveAll = async () => {
    const uniqueTabIds = [...new Set(openTabs.map((tab) => String(tab._id || '')).filter(Boolean))];

    let savedCount = 0;
    const currentSaved = await handleSave({ silent: true });
    if (currentSaved) {
      savedCount += 1;
    }

    if (activeProjectId && uniqueTabIds.length > 1) {
      const activeId = String(activeFileId || '');
      const currentEditorFile = files.find((item) => String(item?._id || '') === activeId);

      for (const tabId of uniqueTabIds) {
        if (tabId === '__unsaved__' || tabId === activeId) {
          continue;
        }

        const target = files.find((item) => String(item?._id || '') === tabId);
        if (!target || (target.itemType || 'file') !== 'file') {
          continue;
        }

        try {
          await codeAPI.save({
            fileId: target._id,
            projectId: target.projectId || activeProjectId,
            fileName: target.name,
            code: target.content || '',
            language: target.language || getLanguageFromFileName(target.name) || language,
          });
          savedCount += 1;
        } catch (error) {
          console.error(`Save All skipped ${target.name}:`, error);
        }
      }

      if (currentEditorFile) {
        setFiles((prev) => prev.map((item) => (
          String(item?._id || '') === activeId ? { ...item, content: code } : item
        )));
      }
    }

    await loadProjectsAndFiles();
    setWorkspaceStatus(`Save All completed (${savedCount} file${savedCount === 1 ? '' : 's'})`);
    alert(`Save All completed. Saved ${savedCount} file${savedCount === 1 ? '' : 's'}.`);
  };

  const handleCloseFolder = () => {
    setActiveProjectId('');
    setActiveFileId('');
    setFiles([]);
    handleNewFile();
    setWorkspaceStatus('Folder closed');
  };

  const handleExit = async () => handleLogout();

  const handleLeaveRoomOrExit = async () => {
    if (joinedRoom) {
      handleLeaveRoom();
      setWorkspaceStatus('Left room');
      return;
    }

    await handleExit();
  };

  const handleFind = () => {
    editorRef.current?.focus();
    runEditorAction('actions.find');
  };

  const handleReplace = () => {
    editorRef.current?.focus();
    runEditorAction('editor.action.startFindReplaceAction');
  };

  const handleFindInFiles = () => {
    setFilePickerTitle('Find in Files');
    setFilePickerQuery('');
    setFilePickerOpen(true);
  };

  const handleReplaceInFiles = async () => {
    if (guardReadOnlyWrite()) {
      return;
    }

    if (files.length === 0) {
      alert('Open a project or local folder with files first.');
      return;
    }

    const findText = window.prompt('Find in files', '');
    if (!findText) {
      return;
    }

    const replaceText = window.prompt('Replace with', '');
    if (replaceText === null) {
      return;
    }

    const localFileMode = files.some((item) => item.source === 'local-folder') || !activeProjectId;
    if (localFileMode) {
      let localModified = 0;
      let nextCode = code;
      const nextFiles = files.map((item) => {
        if ((item.itemType || 'file') !== 'file') {
          return item;
        }

        const source = String(item.content || '');
        if (!source.includes(findText)) {
          return item;
        }

        const updatedContent = source.split(findText).join(replaceText);
        localModified += 1;
        if (String(item._id || '') === String(activeFileId || '')) {
          nextCode = updatedContent;
        }

        return { ...item, content: updatedContent };
      });

      setFiles(nextFiles);
      setFileTreeData(buildFileTree(nextFiles));
      if (localModified > 0 && String(activeFileId || '')) {
        setCode(nextCode);
        setIsSaved(false);
      }

      setWorkspaceStatus(`Replace in Files updated ${localModified} file${localModified === 1 ? '' : 's'}`);
      return;
    }

    let modified = 0;
    for (const item of files) {
      const loaded = await codeAPI.load(item._id);
      const source = loaded.data.file;
      if (!source?.content?.includes(findText)) {
        continue;
      }

      const updatedCode = source.content.split(findText).join(replaceText);
      await codeAPI.save({
        fileId: source._id,
        projectId: source.projectId,
        fileName: source.name,
        code: updatedCode,
        language: source.language,
      });

      if (source._id === activeFileId) {
        setCode(updatedCode);
        setIsSaved(true);
      }

      modified += 1;
    }

    await loadProjectsAndFiles();
    setWorkspaceStatus(`Replace in Files updated ${modified} file${modified === 1 ? '' : 's'}`);
  };

  const handleZoomIn = () => setEditorFontSize((value) => Math.min(value + 1, 24));
  const handleZoomOut = () => setEditorFontSize((value) => Math.max(value - 1, 10));

  const handleToggleSidebar = () => setSidebarVisible((value) => !value);
  const handleExtensions = () => window.open('https://marketplace.visualstudio.com/vscode', '_blank', 'noopener,noreferrer');

  const openSidebarView = (tab, panel) => {
    setLeftWorkspaceTab(tab);
    setActiveSidebarPanel(panel);
    setShowSideBar(true);
    setSidebarVisible(true);
    setRequestsPanelVisible(false);
    setWorkspaceStatus(`View: ${panel}`);
  };

  const handleViewCommandPalette = () => {
    setCommandPaletteOpen(true);
    setWorkspaceStatus('Command Palette opened');
  };

  const handleOpenExplorerView = () => openSidebarView('files', 'explorer');
  const handleOpenSearchView = () => openSidebarView('search', 'search');
  const handleOpenSourceControlView = () => openSidebarView('git', 'sourceControl');
  const handleOpenRunDebugView = () => openSidebarView('debug', 'runDebug');
  const handleOpenExtensionsView = () => openSidebarView('extensions', 'extensions');

  const handleOpenProblemsPanel = () => {
    setTerminalVisible(true);
    setBottomPanelTab('problems');
    setWorkspaceStatus('Problems panel opened');
  };

  const handleOpenOutputPanel = () => {
    setTerminalVisible(true);
    setBottomPanelTab('output');
    setWorkspaceStatus('Output panel opened');
  };

  const handleOpenDebugConsolePanel = () => {
    setTerminalVisible(true);
    setBottomPanelTab('output');
    addOutputEntry('info', '[Debug Console] Focused');
    setWorkspaceStatus('Debug Console opened');
  };

  const handleOpenTerminalPanel = () => {
    setTerminalVisible(true);
    setBottomPanelTab('terminal');
    setWorkspaceStatus('Terminal opened');
  };

  const handleTerminalApiReady = useCallback((api) => {
    terminalMenuApiRef.current = api || null;
  }, []);

  const handleNewTerminal = () => {
    setTerminalVisible(true);
    setBottomPanelTab('terminal');
    terminalMenuApiRef.current?.newTerminal?.();
    setWorkspaceStatus('New terminal created');
  };

  const handleSplitTerminal = () => {
    setTerminalVisible(true);
    setBottomPanelTab('terminal');
    terminalMenuApiRef.current?.splitTerminal?.();
    setWorkspaceStatus('Terminal split created');
  };

  const handleRunTask = async () => {
    setTerminalVisible(true);
    setBottomPanelTab('terminal');
    terminalMenuApiRef.current?.runTask?.();
    setWorkspaceStatus('Task started in terminal');
  };

  const handleRunBuildTask = async () => {
    setTerminalVisible(true);
    setBottomPanelTab('terminal');
    terminalMenuApiRef.current?.runBuildTask?.();
    setWorkspaceStatus('Build task started in terminal');
  };

  const handleRunActiveFile = async () => {
    setTerminalVisible(true);
    setBottomPanelTab('terminal');
    terminalMenuApiRef.current?.runActiveFile?.();
    setWorkspaceStatus('Run active file started');
  };

  const handleRunSelectedText = async () => {
    setTerminalVisible(true);
    setBottomPanelTab('terminal');
    terminalMenuApiRef.current?.runSelectedText?.();
    setWorkspaceStatus('Run selected text started');
  };

  const handleKillTerminal = () => {
    terminalMenuApiRef.current?.killTerminal?.();
    setWorkspaceStatus('Terminal killed');
  };

  const handleClearTerminal = () => {
    terminalMenuApiRef.current?.clearTerminal?.();
    setWorkspaceStatus('Terminal cleared');
  };

  const handleFocusTerminal = () => {
    setTerminalVisible(true);
    setBottomPanelTab('terminal');
    terminalMenuApiRef.current?.focusTerminal?.();
    setWorkspaceStatus('Terminal focused');
  };

  const handleMoveTerminalToEditorArea = () => {
    setTerminalInEditorArea(false);
    setWorkspaceStatus('Terminal is pinned to bottom panel');
  };

  const handleToggleTerminal = () => {
    setTerminalVisible((value) => !value);
    setBottomPanelTab('terminal');
    terminalMenuApiRef.current?.toggleTerminal?.();
    setWorkspaceStatus('Terminal visibility toggled');
  };

  const handleToggleWordWrap = () => {
    setIsWordWrapEnabled((value) => !value);
    setWorkspaceStatus(`Word Wrap ${!isWordWrapEnabled ? 'enabled' : 'disabled'}`);
  };

  const handleToggleMinimap = () => {
    setShowMinimap((value) => !value);
    setWorkspaceStatus(`Minimap ${!showMinimap ? 'shown' : 'hidden'}`);
  };

  const handleToggleBreadcrumbs = () => {
    setShowBreadcrumbs((value) => !value);
    setWorkspaceStatus(`Breadcrumbs ${!showBreadcrumbs ? 'shown' : 'hidden'}`);
  };

  const handleToggleZenMode = () => {
    setIsZenMode((value) => !value);
    setWorkspaceStatus(`Zen Mode ${!isZenMode ? 'enabled' : 'disabled'}`);
  };

  const handleToggleCenteredLayout = () => {
    setIsCenteredLayout((value) => !value);
    setWorkspaceStatus(`Centered Layout ${!isCenteredLayout ? 'enabled' : 'disabled'}`);
  };

  const handleToggleShowMenuBar = () => {
    setActivePath([]);
    setMenuOpen((value) => !value);
    setWorkspaceStatus(`Main Menu ${!menuOpen ? 'shown' : 'hidden'}`);
  };

  const handleToggleShowStatusBar = () => {
    setShowStatusBar((value) => !value);
    setWorkspaceStatus(`Status Bar ${!showStatusBar ? 'shown' : 'hidden'}`);
  };

  const handleToggleShowActivityBar = () => {
    setShowActivityBar((value) => !value);
    setWorkspaceStatus(`Activity Bar ${!showActivityBar ? 'shown' : 'hidden'}`);
  };

  const handleToggleShowSideBar = () => {
    setShowSideBar((value) => {
      const next = !value;
      setSidebarVisible(next);
      if (next && !leftWorkspaceTab) {
        setLeftWorkspaceTab('files');
        setActiveSidebarPanel('explorer');
      }
      return next;
    });
  };

  const handleViewOpenView = async () => {
    const viewMap = {
      explorer: handleOpenExplorerView,
      search: handleOpenSearchView,
      source: handleOpenSourceControlView,
      'source control': handleOpenSourceControlView,
      run: handleOpenRunDebugView,
      'run and debug': handleOpenRunDebugView,
      extensions: handleOpenExtensionsView,
      problems: handleOpenProblemsPanel,
      output: handleOpenOutputPanel,
      'debug console': handleOpenDebugConsolePanel,
      terminal: handleOpenTerminalPanel,
    };

    const selection = window.prompt(
      'Open View:\nExplorer\nSearch\nSource Control\nRun and Debug\nExtensions\nProblems\nOutput\nDebug Console\nTerminal',
      'Explorer'
    );
    if (!selection) {
      return;
    }

    const normalized = String(selection).trim().toLowerCase();
    const handler = viewMap[normalized];
    if (handler) {
      await handler();
    }
  };

  const handleToggleFullScreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (error) {
      console.error('Fullscreen toggle error:', error);
      setWorkspaceStatus('Unable to toggle fullscreen in this browser');
    }
  };

  const handleGoToLine = () => {
    const lineNumber = window.prompt('Go to line', '1');
    const targetLine = Number.parseInt(lineNumber, 10);

    if (!Number.isFinite(targetLine) || targetLine < 1) {
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    editor.revealLineInCenter(targetLine);
    editor.setPosition({ lineNumber: targetLine, column: 1 });
    editor.focus();
  };

  const handleGoToPreviousFile = async () => {
    if (!files.length) {
      setWorkspaceStatus('No files available');
      return;
    }

    const fileEntries = files.filter((item) => (item.itemType || 'file') === 'file');
    if (!fileEntries.length) {
      setWorkspaceStatus('No files available');
      return;
    }

    const currentIndex = fileEntries.findIndex((item) => String(item._id) === String(activeFileId));
    const targetIndex = currentIndex <= 0 ? fileEntries.length - 1 : currentIndex - 1;
    await loadFileById(fileEntries[targetIndex]._id);
  };

  const handleGoToNextFile = async () => {
    if (!files.length) {
      setWorkspaceStatus('No files available');
      return;
    }

    const fileEntries = files.filter((item) => (item.itemType || 'file') === 'file');
    if (!fileEntries.length) {
      setWorkspaceStatus('No files available');
      return;
    }

    const currentIndex = fileEntries.findIndex((item) => String(item._id) === String(activeFileId));
    const targetIndex = currentIndex === -1 || currentIndex >= fileEntries.length - 1 ? 0 : currentIndex + 1;
    await loadFileById(fileEntries[targetIndex]._id);
  };

  const getEditorLineCount = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel?.();
    return model?.getLineCount?.() || Math.max(1, String(code || '').split('\n').length);
  }, [code]);

  const appendDebugLog = useCallback((message, type = 'info') => {
    const entry = {
      id: `debug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      message,
      timestamp: new Date().toISOString(),
    };
    setDebugLogs((previous) => [...previous.slice(-300), entry]);
    addOutputEntry(type === 'error' ? 'stderr' : 'info', `[Debug] ${message}`);
  }, [addOutputEntry]);

  const getNextExecutionLine = useCallback((mode = 'continue') => {
    const totalLines = getEditorLineCount();
    const base = Number(currentExecutionLine || 1);
    const enabledBreakpoints = breakpointsEnabled
      ? [...breakpoints].sort((a, b) => a - b).filter((line) => line >= 1 && line <= totalLines)
      : [];

    if (mode === 'continue') {
      const nextBreakpoint = enabledBreakpoints.find((line) => line > base);
      if (nextBreakpoint) {
        return nextBreakpoint;
      }
      return Math.min(totalLines, base + 1);
    }

    return Math.min(totalLines, base + 1);
  }, [breakpoints, breakpointsEnabled, currentExecutionLine, getEditorLineCount]);

  const moveExecutionCursorToLine = useCallback((lineNumber) => {
    const editor = editorRef.current;
    if (!editor || !lineNumber) {
      return;
    }

    editor.revealLineInCenter(lineNumber);
    editor.setPosition({ lineNumber, column: 1 });
  }, []);

  const handleToggleBreakpoint = (targetLine) => {
    const editor = editorRef.current;
    const lineNumber = Number(targetLine || editor?.getPosition?.()?.lineNumber || 1);
    if (!Number.isFinite(lineNumber) || lineNumber < 1) {
      return;
    }

    setBreakpoints((previous) => {
      const exists = previous.includes(lineNumber);
      const next = exists
        ? previous.filter((line) => line !== lineNumber)
        : [...previous, lineNumber].sort((a, b) => a - b);
      setWorkspaceStatus(exists ? `Breakpoint removed at line ${lineNumber}` : `Breakpoint added at line ${lineNumber}`);
      return next;
    });
  };

  const handleEnableAllBreakpoints = () => {
    setBreakpointsEnabled(true);
    setWorkspaceStatus('All breakpoints enabled');
  };

  const handleDisableAllBreakpoints = () => {
    setBreakpointsEnabled(false);
    setWorkspaceStatus('All breakpoints disabled');
  };

  const handleRemoveAllBreakpoints = () => {
    setBreakpoints([]);
    setWorkspaceStatus('All breakpoints removed');
  };

  const handleOpenRunConfigurations = () => {
    const active = runConfigurations[activeRunConfigurationIndex] || runConfigurations[0] || {};
    const launchJson = {
      version: '0.2.0',
      configurations: runConfigurations,
      activeConfiguration: active,
    };

    setRunConfigJson(JSON.stringify(launchJson, null, 2));
    setRunConfigModalOpen(true);
    setWorkspaceStatus('Run configurations opened');
  };

  const handleSaveRunConfigurations = () => {
    try {
      const parsed = JSON.parse(runConfigJson || '{}');
      const nextConfigs = Array.isArray(parsed.configurations) ? parsed.configurations : [];
      if (nextConfigs.length === 0) {
        throw new Error('No configurations found');
      }
      setRunConfigurations(nextConfigs);
      setActiveRunConfigurationIndex(0);
      setRunConfigModalOpen(false);
      setWorkspaceStatus('Run configurations saved');
    } catch (error) {
      alert('Invalid launch configuration JSON');
    }
  };

  const handleAddRunConfiguration = () => {
    const selectedType = String(window.prompt('Configuration type (node/python/java/cpp)', 'node') || '').trim().toLowerCase();
    if (!selectedType) {
      return;
    }

    const typeMap = {
      node: 'node',
      javascript: 'node',
      python: 'python',
      java: 'java',
      cpp: 'cppdbg',
      'c++': 'cppdbg',
    };

    const normalizedType = typeMap[selectedType] || 'node';
    const defaultProgram = {
      node: 'app.js',
      python: 'main.py',
      java: 'Main.java',
      cppdbg: 'main.cpp',
    }[normalizedType];

    const program = window.prompt('Program file', fileName || defaultProgram || 'app.js');
    if (!program) {
      return;
    }

    const next = {
      name: `Launch ${program}`,
      type: normalizedType,
      request: 'launch',
      program,
    };

    setRunConfigurations((previous) => {
      const merged = [...previous, next];
      setActiveRunConfigurationIndex(merged.length - 1);
      return merged;
    });
    setWorkspaceStatus(`Added run configuration for ${program}`);
  };

  const handleStartDebugging = async () => {
    if (isDebugging) {
      return;
    }

    setIsDebugging(true);
    setIsRunning(true);
    setTerminalVisible(true);
    setBottomPanelTab('output');
    const firstLine = breakpointsEnabled && breakpoints.length > 0
      ? Math.min(...breakpoints)
      : 1;
    setCurrentExecutionLine(firstLine);
    moveExecutionCursorToLine(firstLine);
    appendDebugLog(`Debug session started at line ${firstLine}`);
    setWorkspaceStatus('Debugging started');
  };

  const handleRunWithoutDebugging = async () => {
    await handleRunCode();
  };

  const handleStopDebugging = () => {
    if (!isDebugging && !isRunning) {
      return;
    }
    setIsRunning(false);
    setIsDebugging(false);
    setCurrentExecutionLine(null);
    appendDebugLog('Debug session stopped');
    setWorkspaceStatus('Debugging stopped');
  };

  const handleRestartDebugging = async () => {
    handleStopDebugging();
    await handleStartDebugging();
  };

  const handleContinueExecution = () => {
    if (!isDebugging) {
      return;
    }
    const nextLine = getNextExecutionLine('continue');
    setCurrentExecutionLine(nextLine);
    moveExecutionCursorToLine(nextLine);
    appendDebugLog(`Continue to line ${nextLine}`);
  };

  const handleStepOver = () => {
    if (!isDebugging) {
      return;
    }
    const nextLine = getNextExecutionLine('step');
    setCurrentExecutionLine(nextLine);
    moveExecutionCursorToLine(nextLine);
    appendDebugLog(`Step Over to line ${nextLine}`);
  };

  const handleStepInto = () => {
    if (!isDebugging) {
      return;
    }
    const nextLine = getNextExecutionLine('step');
    setCurrentExecutionLine(nextLine);
    moveExecutionCursorToLine(nextLine);
    appendDebugLog(`Step Into line ${nextLine}`);
  };

  const handleStepOut = () => {
    if (!isDebugging) {
      return;
    }
    const nextLine = getNextExecutionLine('step');
    setCurrentExecutionLine(nextLine);
    moveExecutionCursorToLine(nextLine);
    appendDebugLog(`Step Out to line ${nextLine}`);
  };

  const buildExecutionAlert = (result, detectedLanguage) => {
    const friendlyLanguage = {
      javascript: 'JavaScript',
      python: 'Python',
      cpp: 'C++',
      java: 'Java',
    }[detectedLanguage] || detectedLanguage;

    if (!result?.errorType) {
      return null;
    }

    if (result.errorType === 'ENVIRONMENT_ERROR') {
      return {
        tone: 'warning',
        title: `\u26A0\uFE0F ${friendlyLanguage} runtime is not installed on the server`,
        message: result.message,
        suggestion: 'Contact admin or switch language.',
      };
    }

    if (result.errorType === 'SYNTAX_ERROR') {
      return {
        tone: 'error',
        title: 'Syntax Error',
        message: result.message || 'Your code has syntax issues.',
      };
    }

    if (result.errorType === 'RUNTIME_ERROR') {
      return {
        tone: 'error',
        title: 'Runtime Error',
        message: result.message || 'Your program crashed while running.',
      };
    }

    if (result.errorType === 'TIMEOUT_ERROR') {
      return {
        tone: 'error',
        title: 'Timeout Error',
        message: result.message || 'Code execution timed out.',
      };
    }

    return {
      tone: 'error',
      title: 'Execution Error',
      message: result.message || 'Execution failed.',
    };
  };

  const handleRunCode = async (event) => {
    if (guardReadOnlyWrite()) {
      return;
    }

    if (event?.preventDefault) {
      event.preventDefault();
    }

    if (event?.stopPropagation) {
      event.stopPropagation();
    }

    if (runningCode) {
      return;
    }

    const editor = editorRef.current;
    const sourceCode = typeof editor?.getValue === 'function' ? editor.getValue() : code;
    // The language selector is the source of truth for execution.
    const detectedLanguage = language || getLanguageFromFileName(fileName) || 'javascript';
    const startedAt = Date.now();

    if (joinedRoom && user && !isRoomManager) {
      emitSuggestCode({
        roomId,
        code: sourceCode,
        userId: user._id || user.id,
        role: 'member',
        fileId: resolveCurrentFileId(),
      });

      setCollabSyncState('Request Pending');
      setWorkspaceStatus('Run request sent to manager');
      setRunningCode(false);
      setIsRunning(false);
      return;
    }

    setTerminalVisible(true);
    setBottomPanelTab('output');
    setRunningCode(true);
    setIsRunning(true);
    setLanguage(detectedLanguage);
    setExecutionOutput('');
    setExecutionStatus('running');
    setExecutionAlert(null);
    setWorkspaceStatus('Running code...');
    addOutputEntry('info', `RUN ${fileName} (${detectedLanguage})`);

    try {
      const result = await handleCodeExecuteViaSocket(sourceCode, detectedLanguage, {
        onChunk: ({ type, data }) => {
          addOutputEntry(type === 'stderr' ? 'stderr' : 'stdout', data || '');
        },
      });
      const normalizedOutput = String(result.output || result.message || '').replace(/\r\n/g, '\n');
      setExecutionOutput(normalizedOutput);

      const isSuccess = result.status === 'success';
      setExecutionStatus(isSuccess ? 'completed' : 'failed');
      setExecutionAlert(isSuccess ? null : buildExecutionAlert(result, detectedLanguage));
      addOutputEntry(isSuccess ? 'success' : 'stderr', `Execution finished in ${Date.now() - startedAt} ms`);

      if (isSuccess) {
        setWorkspaceStatus('Code execution finished');
      } else {
        setWorkspaceStatus('Code execution finished with errors');
      }
    } catch (error) {
      const payload = error?.response?.data || {};
      const alert = buildExecutionAlert(payload, detectedLanguage);
      setExecutionAlert(alert);
      if (payload?.errorType === 'ENVIRONMENT_ERROR') {
        setExecutionOutput(payload.message || 'Runtime missing on server.');
      } else {
        const message = payload?.message || getApiErrorMessage(error, 'Unable to run code');
        setExecutionOutput(message);
        addOutputEntry('stderr', message);
      }
      setExecutionStatus('failed');
      setWorkspaceStatus('Code execution failed');
    } finally {
      setRunningCode(false);
      setIsRunning(false);
    }
  };

  // Handler for Socket.io-based code execution with real-time streaming
  const handleCodeExecuteViaSocket = async (code, lang, { onChunk } = {}) => {
    const socket = getSocket();
    if (!socket || !socket.connected) {
      // Fall back to REST API if Socket.io is not connected
      try {
        const response = await codeAPI.run({
          language: lang || language,
          code,
          fileName,
        });
        if (typeof onChunk === 'function' && response?.data?.output) {
          onChunk({ type: 'stdout', data: response.data.output });
        }
        return response.data;
      } catch (error) {
        return {
          error: true,
          message: error.response?.data?.message || error.message,
          errorType: error.response?.data?.errorType || 'ERROR',
        };
      }
    }

    // Use Socket.io for streaming execution
    const newExecutionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setExecutionId(newExecutionId);

    return new Promise((resolve, reject) => {
      // Set a timeout to prevent hanging
      const timeout = setTimeout(() => {
        reject(new Error('Code execution timed out'));
      }, 30000);

      // Handler for successful completion
      const handleDone = (data) => {
        if (data.executionId === newExecutionId) {
          clearTimeout(timeout);
          socketOff('code-execution-done', handleDone);
          socketOff('output-update', handleOutput);
          socketOff('code-execution-error', handleError);
          resolve(data.result || { status: 'success', output: '' });
        }
      };

      const handleOutput = (data) => {
        if (data.executionId !== newExecutionId) {
          return;
        }
        if (typeof onChunk === 'function') {
          onChunk({ type: data.type, data: data.data });
        }
      };

      // Handler for execution errors
      const handleError = (data) => {
        if (data.executionId === newExecutionId) {
          clearTimeout(timeout);
          socketOff('code-execution-done', handleDone);
          socketOff('output-update', handleOutput);
          socketOff('code-execution-error', handleError);
          resolve({
            error: true,
            message: data.error,
            errorType: data.errorType,
            status: 'error',
          });
        }
      };

      // Register one-time listeners
      socketOff('code-execution-done', handleDone);
      socketOff('output-update', handleOutput);
      socketOff('code-execution-error', handleError);
      socketOn('code-execution-done', handleDone);
      socketOn('output-update', handleOutput);
      socketOn('code-execution-error', handleError);

      // Emit code execution request
      socketEmit('code-execute', {
        executionId: newExecutionId,
        language: lang || language,
        code,
        fileName,
        input: executionInput || '',
      });
    });
  };

  const handleNewWindow = () => {
    const editorUrl = `${window.location.origin}/editor`;
    window.open(editorUrl, '_blank', 'noopener,noreferrer');
    setWorkspaceStatus('Opened a new editor window');
  };

  const handleTerminalResizeMouseDown = (event) => {
    event.preventDefault();
    didResizeDuringDragRef.current = false;
    suppressDividerClickRef.current = false;
    setIsResizingTerminal(true);
    initialMouseYRef.current = event.clientY;
    initialHeightRef.current = terminalHeight;
  };

  const handleTerminalDividerClick = () => {
    if (suppressDividerClickRef.current) {
      suppressDividerClickRef.current = false;
      return;
    }

    const presets = [180, 200];
    const current = terminalHeight;
    const next = presets.find((size) => size > current + 6) || presets[0];
    setTerminalHeight(next);
    setWorkspaceStatus(`Terminal height: ${next}px`);
  };

  const handleTerminalDividerKeyDown = (event) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setTerminalHeight((value) => Math.min(value + 20, 200));
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setTerminalHeight((value) => Math.max(value - 20, 180));
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setTerminalHeight(180);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      setTerminalHeight(200);
    }
  };

  useEffect(() => {
    if (!isResizingTerminal) return;

    const handleMouseMove = (event) => {
      const deltaY = initialMouseYRef.current - event.clientY;
      const maxHeight = 200;
      const newHeight = Math.max(180, Math.min(maxHeight, initialHeightRef.current + deltaY));
      if (Math.abs(deltaY) > 2) {
        didResizeDuringDragRef.current = true;
      }
      setTerminalHeight(newHeight);
    };

    const handleMouseUp = () => {
      if (didResizeDuringDragRef.current) {
        suppressDividerClickRef.current = true;
      }
      localStorage.setItem('terminalHeight', String(terminalHeight));
      setIsResizingTerminal(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingTerminal, terminalHeight]);

  const handleKeyboardShortcuts = () => alert([
    'Sync Code Keyboard Shortcuts',
    '',
    'File',
    'Ctrl/Cmd+S: Save',
    'Ctrl/Cmd+Shift+S: Save As',
    '',
    'Edit',
    'Ctrl/Cmd+Z: Undo',
    'Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z: Redo',
    'Ctrl/Cmd+X: Cut',
    'Ctrl/Cmd+C: Copy',
    'Ctrl/Cmd+V: Paste',
    'Ctrl/Cmd+F: Find',
    'Ctrl/Cmd+H: Replace',
    'Ctrl/Cmd+Shift+F: Find in Files',
    'Ctrl/Cmd+Shift+H: Replace in Files',
    'Ctrl/Cmd+/: Toggle Line Comment',
    'Shift+Alt+A: Toggle Block Comment',
    'Ctrl+Alt+Up/Down: Add Cursor Above/Below',
    'Shift+Alt+Up/Down: Copy Line Up/Down',
    '',
    'View/Go/Run',
    'Ctrl/Cmd+B: Toggle Sidebar',
    'Ctrl/Cmd+G: Go to Line',
    'Ctrl/Cmd+P: Go to File',
    'Ctrl/Cmd+Alt+N: Run Code',
    'Ctrl/Cmd+`: Toggle Terminal',
  ].join('\n'));
  const handleAbout = () => {
    setHelpModalOpen(true);
    setWorkspaceStatus('Opened Help');
  };

  const handleDownloadProject = async () => {
    if (!activeProjectId) {
      alert('Select a project before downloading.');
      return;
    }

    try {
      setWorkspaceStatus('Preparing project export...');
      const project = getActiveProject();
      const response = await fileAPI.list(activeProjectId);
      const projectFiles = response.data.files || [];

      const fileMap = new Map(projectFiles.map((item) => [String(item._id), item]));
      const resolvePath = (item) => {
        const pathParts = [item.name || 'untitled.txt'];
        let cursor = item;
        let guard = 0;

        while (cursor?.parentId && guard < 100) {
          const parent = fileMap.get(String(cursor.parentId));
          if (!parent) {
            break;
          }

          pathParts.unshift(parent.name || 'folder');
          cursor = parent;
          guard += 1;
        }

        return pathParts.join('/');
      };

      const zipEntries = [
        {
          path: 'project-meta.json',
          content: JSON.stringify(
            {
              project: {
                id: project?._id,
                name: project?.name || 'sync-code-project',
                exportedAt: new Date().toISOString(),
              },
              totalItems: projectFiles.length,
            },
            null,
            2
          ),
        },
      ];

      projectFiles.forEach((item) => {
        if ((item.itemType || 'file') === 'folder') {
          return;
        }

        zipEntries.push({
          path: resolvePath(item),
          content: item.content || '',
        });
      });

      if (zipEntries.length === 1) {
        zipEntries.push({
          path: 'README.txt',
          content: 'This project has no files to export yet.',
        });
      }

      const objectUrl = URL.createObjectURL(createZipBlob(zipEntries));
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `${(project?.name || 'sync-code-project').replace(/\s+/g, '-')}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
      setWorkspaceStatus('Project ZIP downloaded');
    } catch (error) {
      console.error('Download project error:', error);
      alert('Unable to download project ZIP');
      setWorkspaceStatus('Project ZIP download failed');
    }
  };

  const handleShareProject = async () => {
    if (guardReadOnlyWrite()) {
      return;
    }

    if (!activeProjectId) {
      alert('Select a project before sharing.');
      return;
    }

    try {
      const response = await projectAPI.share(activeProjectId);
      const shareId = response?.data?.shareId;
      const shareUrl = `${window.location.origin}/editor?project=${activeProjectId}`;
      await navigator.clipboard.writeText(shareUrl);
      setWorkspaceStatus('Project link copied to clipboard');
      if (shareId) {
        alert(`Share link copied:\n${shareUrl}\n\nShare ID: ${shareId}`);
      } else {
        alert(`Share link copied:\n${shareUrl}`);
      }
    } catch (error) {
      console.error('Share project error:', error);
      const shareUrl = `${window.location.origin}/editor?project=${activeProjectId}`;
      window.prompt('Copy this project link', shareUrl);
    }
  };

  const commandPaletteActions = [
    { id: 'new-file', label: 'File: New File', run: handleNewFile },
    { id: 'open-file', label: 'File: Open File', run: handleOpenFile },
    { id: 'save-file', label: 'File: Save', run: handleSave },
    { id: 'view-open-view', label: 'View: Open View', run: handleViewOpenView },
    { id: 'view-zen-mode', label: 'View: Toggle Zen Mode', run: handleToggleZenMode },
    { id: 'view-centered-layout', label: 'View: Toggle Centered Layout', run: handleToggleCenteredLayout },
    { id: 'view-show-menu-bar', label: 'View: Toggle Menu Bar', run: handleToggleShowMenuBar },
    { id: 'view-show-status-bar', label: 'View: Toggle Status Bar', run: handleToggleShowStatusBar },
    { id: 'view-show-activity-bar', label: 'View: Toggle Activity Bar', run: handleToggleShowActivityBar },
    { id: 'view-show-side-bar', label: 'View: Toggle Side Bar', run: handleToggleShowSideBar },
    { id: 'view-explorer', label: 'View: Explorer', run: handleOpenExplorerView },
    { id: 'view-search', label: 'View: Search', run: handleOpenSearchView },
    { id: 'view-source-control', label: 'View: Source Control', run: handleOpenSourceControlView },
    { id: 'view-run-debug', label: 'View: Run and Debug', run: handleOpenRunDebugView },
    { id: 'view-extensions', label: 'View: Extensions', run: handleOpenExtensionsView },
    { id: 'view-problems', label: 'View: Problems', run: handleOpenProblemsPanel },
    { id: 'view-output', label: 'View: Output', run: handleOpenOutputPanel },
    { id: 'view-debug-console', label: 'View: Debug Console', run: handleOpenDebugConsolePanel },
    { id: 'view-terminal', label: 'View: Terminal', run: handleOpenTerminalPanel },
    { id: 'view-word-wrap', label: 'View: Toggle Word Wrap', run: handleToggleWordWrap },
    { id: 'view-minimap', label: 'View: Toggle Minimap', run: handleToggleMinimap },
    { id: 'view-breadcrumbs', label: 'View: Toggle Breadcrumbs', run: handleToggleBreadcrumbs },
    { id: 'run-start-debug', label: 'Run: Start Debugging', run: handleStartDebugging },
    { id: 'run-without-debug', label: 'Run: Run Without Debugging', run: handleRunWithoutDebugging },
    { id: 'run-stop-debug', label: 'Run: Stop Debugging', run: handleStopDebugging },
    { id: 'run-restart-debug', label: 'Run: Restart Debugging', run: handleRestartDebugging },
    { id: 'run-open-config', label: 'Run: Open Configurations', run: handleOpenRunConfigurations },
    { id: 'run-add-config', label: 'Run: Add Configuration', run: handleAddRunConfiguration },
    { id: 'run-toggle-breakpoint', label: 'Run: Toggle Breakpoint', run: handleToggleBreakpoint },
    { id: 'run-enable-breakpoints', label: 'Run: Enable All Breakpoints', run: handleEnableAllBreakpoints },
    { id: 'run-disable-breakpoints', label: 'Run: Disable All Breakpoints', run: handleDisableAllBreakpoints },
    { id: 'run-remove-breakpoints', label: 'Run: Remove All Breakpoints', run: handleRemoveAllBreakpoints },
    { id: 'run-step-over', label: 'Run: Step Over', run: handleStepOver },
    { id: 'run-step-into', label: 'Run: Step Into', run: handleStepInto },
    { id: 'run-step-out', label: 'Run: Step Out', run: handleStepOut },
    { id: 'run-continue', label: 'Run: Continue', run: handleContinueExecution },
    { id: 'edit-toggle-line-comment', label: 'Edit: Toggle Line Comment', run: handleToggleLineComment },
    { id: 'edit-toggle-block-comment', label: 'Edit: Toggle Block Comment', run: handleToggleBlockComment },
    { id: 'edit-emmet-expand', label: 'Edit: Emmet Expand Abbreviation', run: handleEmmetExpandAbbreviation },
    { id: 'find-files', label: 'Search: Find in Files', run: handleFindInFiles },
    { id: 'open-terminal', label: 'Terminal: New Terminal', run: handleNewTerminal },
    { id: 'run-code', label: 'Run: Run Code', run: handleRunCode },
    { id: 'theme-dark', label: 'Theme: Dark', run: () => setActiveTheme('dark') },
    { id: 'theme-light', label: 'Theme: Light', run: () => setActiveTheme('light') },
    { id: 'theme-dracula', label: 'Theme: Dracula', run: () => setActiveTheme('dracula') },
    { id: 'theme-monokai', label: 'Theme: Monokai', run: () => setActiveTheme('monokai') },
  ];

  const filteredCommandActions = commandPaletteActions.filter((item) =>
    item.label.toLowerCase().includes(commandPaletteQuery.toLowerCase())
  );

  const handleRunCommandPaletteItem = async (action) => {
    setCommandPaletteOpen(false);
    setCommandPaletteQuery('');
    await action.run();
  };

  const menuActions = createMenuActions({
    handleNewFile,
    handleNewWindow,
    handleNewFolder,
    handleOpenLocalFile,
    handleOpenFile,
    handleOpenFolder,
    handleOpenRecent,
    handleSave,
    handleSaveAll,
    handleSaveAs,
    handleCloseFile,
    handleCloseFolder,
    handleDownloadProject,
    handleShareProject,
    handleLeaveRoomOrExit,
    handleExit,
    handleUndo,
    handleRedo,
    handleCut,
    handleCopy,
    handlePaste,
    handleFind,
    handleReplace,
    handleFindInFiles,
    handleReplaceInFiles,
    handleToggleLineComment,
    handleToggleBlockComment,
    handleEmmetExpandAbbreviation,
    handleCopyLineUp,
    handleCopyLineDown,
    handleViewCommandPalette,
    handleViewOpenView,
    handleToggleZenMode,
    handleToggleCenteredLayout,
    handleToggleShowMenuBar,
    handleToggleShowStatusBar,
    handleToggleShowActivityBar,
    handleToggleShowSideBar,
    handleOpenExplorerView,
    handleOpenSearchView,
    handleOpenSourceControlView,
    handleOpenRunDebugView,
    handleOpenExtensionsView,
    handleOpenProblemsPanel,
    handleOpenOutputPanel,
    handleOpenDebugConsolePanel,
    handleOpenTerminalPanel,
    handleToggleWordWrap,
    handleToggleMinimap,
    handleToggleBreadcrumbs,
    handleToggleSidebar,
    handleZoomIn,
    handleZoomOut,
    handleToggleFullScreen,
    handleSelectAll,
    handleAddCursorAbove,
    handleAddCursorBelow,
    handleGoToFile,
    handleGoToPreviousFile,
    handleGoToNextFile,
    handleGoToLine,
    handleStartDebugging,
    handleRunWithoutDebugging,
    handleStopDebugging,
    handleRestartDebugging,
    handleOpenRunConfigurations,
    handleAddRunConfiguration,
    handleToggleBreakpoint,
    handleEnableAllBreakpoints,
    handleDisableAllBreakpoints,
    handleRemoveAllBreakpoints,
    handleStepOver,
    handleStepInto,
    handleStepOut,
    handleContinueExecution,
    handleRunCode,
    handleNewTerminal,
    handleSplitTerminal,
    handleRunTask,
    handleRunBuildTask,
    handleRunActiveFile,
    handleRunSelectedText,
    handleKillTerminal,
    handleClearTerminal,
    handleFocusTerminal,
    handleMoveTerminalToEditorArea,
    handleToggleTerminal,
    handleKeyboardShortcuts,
    handleAbout,
  });

  const sidebarSections = useMemo(() => getMenuSections(), []);
  const topMenuSections = useMemo(
    () => sidebarSections.filter((section) => ['file', 'edit', 'view', 'terminal', 'help'].includes(section.key)),
    [sidebarSections],
  );

  const handleMenuAction = async (menuKey, action) => {
    console.log(`[menu dispatch] ${menuKey}.${action}`);
    const handler = menuActions[menuKey]?.[action];
    if (handler) {
      try {
        await handler();
        console.log(`[menu success] ${menuKey}.${action}`);
      } catch (error) {
        console.error(`[menu error] ${menuKey}.${action}`, error);
        setWorkspaceStatus(`Action failed: ${menuKey}.${action}`);
      }
      return;
    }

    console.warn(`Missing menu action handler for ${menuKey}.${action}`);
    setWorkspaceStatus(`Action not implemented: ${menuKey}.${action}`);
  };

  const handleSidebarMenuAction = async (sectionKey, action) => {
    await handleMenuAction(sectionKey, action);
    setMenuOpen(false);
    setActivePath([]);
  };

  const handleToggleMainMenu = () => {
    setActivePath([]);
    setMenuOpen((previous) => !previous);
  };

  const handleCloseMainMenu = () => {
    setMenuOpen(false);
    setActivePath([]);
  };

  const handleHoverMenuPath = (path) => {
    setActivePath(Array.isArray(path) ? path : []);
  };

  const handleLogout = async () => {
    if (!isSaved) {
      const confirmLogout = window.confirm('You have unsaved changes. Are you sure you want to logout?');
      if (!confirmLogout) {
        return;
      }
    }

    try {
      disconnectSocket();
      authAPI.logout();
      navigate('/');
    } catch (error) {
      console.error('Logout error:', error);
      navigate('/');
    }
  };

  const handleToggleReadOnlyMode = async () => {
    if (!canToggleReadOnly) {
      return;
    }

    const nextMode = !isReadOnlyMode;
    try {
      const response = await toggleReadOnlyMode(nextMode);
      setWorkspaceStatus(response?.message || (nextMode ? 'Read-only mode enabled' : 'Write mode enabled'));
    } catch (error) {
      console.error('Toggle read-only mode error:', error);
      alert(error?.response?.data?.message || 'Unable to update read-only mode');
    }
  };

  const handleLanguageChange = (event) => {
    const selectedLanguage = event.target.value;
    setLanguage(selectedLanguage);
    setFileName(getDefaultFileName(selectedLanguage));
  };

  const handleFileNameChange = (event) => {
    const nextFileName = event.target.value;
    setFileName(nextFileName);

    const detectedLanguage = getLanguageFromFileName(nextFileName);
    if (detectedLanguage) {
      setLanguage(detectedLanguage);
    }
  };

  const handleChatbotAction = async (action) => {
    const actionHandlers = {
      save: () => handleSave(),
      saveAll: () => handleSaveAll(),
      run: () => handleRunCode(),
      newFile: () => handleNewFile(),
      openFile: () => handleOpenFile(),
      goToFile: () => handleGoToFile(),
      toggleTerminal: () => setTerminalVisible((value) => !value),
    };

    const handler = actionHandlers[action];
    if (handler) {
      await handler();
    }
  };

  useEffect(() => {
    if (DEBUG_EDITOR_FOCUS) {
      console.log('[panel changed]', {
        bottomPanelTab,
        terminalVisible,
      });
    }
  }, [bottomPanelTab, terminalVisible]);

  useEffect(() => {
    if (!DEBUG_EDITOR_FOCUS) {
      return undefined;
    }

    const onFocusIn = (event) => {
      const target = event.target;
      const descriptor = target?.className || target?.tagName || 'unknown';
      console.log('[focus changed]', { target: descriptor });
    };

    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  const handleChatbotReplyRequest = async (message) => {
    const activeProject = getActiveProject();

    const response = await chatbotAPI.reply({
      message,
      fileName,
      language,
      projectName: activeProject?.name || '',
      fileCount: files.length,
      readOnlyMode: isReadOnlyMode,
    });

    return response.data;
  };

  const handleGetSelectedCodeSnippet = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) {
      return null;
    }

    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) {
      return null;
    }

    const model = editor.getModel();
    if (!model) {
      return null;
    }

    const snippetCode = model.getValueInRange(selection);
    if (!snippetCode.trim()) {
      return null;
    }

    return {
      code: snippetCode,
      language: language || 'javascript',
      fileName,
    };
  }, [language, fileName]);

  const handleOpenSnippetInEditor = useCallback((snippetCode, snippetLanguage = '') => {
    const nextCode = String(snippetCode || '');
    if (!nextCode.trim()) {
      return;
    }

    const nextLanguage = String(snippetLanguage || language || 'javascript').trim();
    setCode(nextCode);
    setLanguage(nextLanguage);
    setIsSaved(false);

    if (joinedRoom && user) {
      const fileId = resolveCurrentFileId();
      emitSuggestCode({
        code: nextCode,
        userId: user._id || user.id,
        roomId,
        fileId,
        role: isRoomManager ? 'manager' : 'member',
      });
      lastSuggestedCodeRef.current = nextCode;
    }

    setWorkspaceStatus('Code snippet opened from chat');
    setBottomPanelTab('terminal');
    editorRef.current?.focus();
  }, [isRoomManager, joinedRoom, language, resolveCurrentFileId, roomId, setBottomPanelTab, user]);

  const handleRenameFile = async (file, providedName = '') => {
    if (guardReadOnlyWrite()) {
      return;
    }

    if (!file?._id) {
      return;
    }

    const nextName = String(providedName || '').trim() || window.prompt('Rename file', file.name || fileName);
    if (!nextName) {
      return null;
    }

    try {
      let renamedFile;
      if ((file.itemType || 'file') === 'folder') {
        const renameResponse = await fileAPI.renameNode(file._id, nextName.trim());
        renamedFile = renameResponse.data.file;
      } else {
        setSaving(true);
        const sourceFile = file._id === activeFileId
          ? { content: code, language }
          : (await codeAPI.load(file._id)).data.file;

        const renameResponse = await codeAPI.save({
          fileId: file._id,
          projectId: file.projectId || activeProjectId || undefined,
          fileName: nextName.trim(),
          code: sourceFile?.content || '',
          language: sourceFile?.language || file.language || language,
          parentId: file.parentId || null,
        });
        renamedFile = renameResponse.data.file;
      }

      if (file._id === activeFileId && (file.itemType || 'file') !== 'folder') {
        setFileName(renamedFile?.name || nextName.trim());
      }
      emitFileEvent('file-renamed', { fileId: file._id, name: renamedFile?.name || nextName.trim() });
      setWorkspaceStatus(`Renamed ${file.name} to ${renamedFile?.name || nextName.trim()}`);
      if (renamedFile?._id) {
        highlightExplorerNode(renamedFile._id);
      }
      await loadProjectsAndFiles();
      return renamedFile || null;
    } catch (error) {
      console.error('Rename file error:', error);
      alert(error.response?.data?.message || 'Unable to rename file');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteFile = async (file) => {
    if (guardReadOnlyWrite()) {
      return;
    }

    if (!file?._id) {
      return;
    }

    const confirmed = window.confirm(`Delete ${file.name}? This cannot be undone.`);
    if (!confirmed) {
      return;
    }

    try {
      await fileAPI.remove(file._id);
      emitFileEvent('file-deleted', { fileId: file._id, name: file.name });
      setWorkspaceStatus(`Deleted ${file.name}`);
      if (file._id === activeFileId) {
        handleNewFile();
      }
      await loadProjectsAndFiles();
    } catch (error) {
      console.error('Delete file error:', error);
      alert(error.response?.data?.message || 'Unable to delete file');
    }
  };

  const handleMoveNodeInExplorer = async (nodeId, targetParentId = null, targetIndex = 0) => {
    if (guardReadOnlyWrite()) {
      return;
    }

    try {
      await fileAPI.moveNode(nodeId, {
        parentId: targetParentId || null,
        targetIndex,
      });

      await refreshProjectFiles(activeProjectId);
      emitFileEvent('file-moved', { fileId: nodeId, parentId: targetParentId || null, targetIndex });
      setWorkspaceStatus('Moved item');
    } catch (error) {
      console.error('Move item error:', error);
      alert(error.response?.data?.message || 'Unable to move item');
    }
  };

  const handleCopyNodePath = async (path) => {
    if (!path) {
      return;
    }

    try {
      await navigator.clipboard.writeText(path);
      setWorkspaceStatus('Path copied to clipboard');
    } catch (error) {
      console.error('Copy path error:', error);
      window.prompt('Copy path', path);
    }
  };

  const handleJoinRoom = (forcedRoomId) => {
    if (!user) {
      setRoomError('User information not available');
      return;
    }

    const explicitRoomId = String(forcedRoomId || roomInput || '').trim();
    const selectedRoomId = explicitRoomId || getScopedRoomId() || generateRoomId();
    const editor = editorRef.current;
    const currentCode = typeof editor?.getValue === 'function' ? editor.getValue() : code;
    const fileId = resolveCurrentFileId();

    setRoomError('');
    setRoomId(selectedRoomId);
    setRoomRole('viewer');
    setRoomHostId('');
    console.log('JOIN ROOM:', selectedRoomId, {
      userId: user._id || user.id,
      userName: user.name,
      fileId,
      socketId: getSocket()?.id || null,
    });
    joinRoom(selectedRoomId, user._id || user.id, user.name, fileId, currentCode, language);
    setRoomInput('');
    setWorkspaceStatus(`Joining room ${selectedRoomId}...`);
  };

  const handleToggleRoomMemberRole = (member) => {
    if (!isRoomManager || !member?.userId || String(member.userId) === String(currentUserId)) {
      return;
    }

    emitRoomRoleChange(member.userId, member.role === 'editor' ? 'viewer' : 'editor');
  };

  const handleCopyRoomId = async () => {
    if (!roomId) {
      return;
    }

    try {
      await navigator.clipboard.writeText(roomId);
      setWorkspaceStatus('Room ID copied to clipboard');
    } catch (error) {
      console.error('Copy room id error:', error);
      window.prompt('Copy Room ID', roomId);
    }
  };

  const handleGenerateAndJoinRoom = () => {
    handleJoinRoom(generateRoomId());
  };

  const handleLeaveRoom = () => {
    if (roomId && joinedRoom) {
      leaveRoom(roomId);
      try {
        localStorage.removeItem('syncCodeLastRoomId');
      } catch (error) {
        // ignore storage errors
      }
      setRoomId('');
      setJoinedRoom(false);
      setRoomRole('viewer');
      setRoomHostId('');
      setUsersInRoom([]);
      setRemoteUpdaters({});
      setTypingUsers({});
      setRemoteCursors({});
      setRoomError('');

      if (codeUpdateTimeout.current) {
        clearTimeout(codeUpdateTimeout.current);
      }

      if (typingStatusTimeout.current) {
        clearTimeout(typingStatusTimeout.current);
      }

      if (cursorEmitTimeoutRef.current) {
        clearTimeout(cursorEmitTimeoutRef.current);
      }

      if (editorRef.current) {
        cursorDecorationsRef.current = editorRef.current.deltaDecorations(cursorDecorationsRef.current, []);
      }
    }
  };

  if (!user) {
    return <div className="loading">Loading...</div>;
  }

  const filteredFiles = filePickerResults;
  const monacoTheme = activeTheme === 'light' ? 'vs' : 'vs-dark';
  const explorerTree = fileTreeData.length > 0 ? fileTreeData : buildFileTree(files);
  const currentFilePresenceKey = resolveCurrentFileId();
  const onlinePresenceCount = usersInRoom.filter((member) => member.online !== false).length;
  const usersEditingSameFileCount = usersInRoom.filter(
    (member) => member.online !== false && String(member.activeFileKey || '__default__') === currentFilePresenceKey,
  ).length;
  const compactOnlineUsers = usersInRoom.filter((member) => member.online !== false);
  const compactVisibleUsers = compactOnlineUsers.slice(0, 4);
  const compactOverflowUsers = Math.max(0, compactOnlineUsers.length - compactVisibleUsers.length);
  const activeFilePendingChanges = pendingChanges
    .filter((change) => change.status === 'pending')
    .filter((change) => (
      isRoomManager
        ? true
        : String(change.fileId || change.fileKey || '') === currentFilePresenceKey
    ))
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  const activeFileConflicts = activeFilePendingChanges.filter((change) => Boolean(change.conflict)).length;
  const inlineSelectedChange = activeFilePendingChanges.find((change) => change.changeId === inlineActionChangeId) || null;

  return (
    <>
    <div className="editor-container">
      <input
        ref={localFileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleLocalFileSelected}
      />
      <input
        id="folderInput"
        ref={localFolderInputRef}
        type="file"
        style={{ display: 'none' }}
        multiple
        webkitdirectory=""
        directory=""
        onChange={handleLocalFolderSelected}
      />

      {filePickerOpen && (
        <div className="modal-overlay" role="presentation" onClick={() => setFilePickerOpen(false)}>
          <div
            className="file-picker-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-picker-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="file-picker-header">
              <div>
                <h2 id="file-picker-title">{filePickerTitle}</h2>
                <p>Choose a file from the current project.</p>
              </div>
              <button type="button" className="modal-close-button" onClick={() => setFilePickerOpen(false)}>
                ×
              </button>
            </div>

            <input
              type="text"
              className="file-picker-search"
              placeholder="Search files..."
              value={filePickerQuery}
              onChange={(event) => setFilePickerQuery(event.target.value)}
              onKeyDown={(event) => {
                if (!filteredFiles.length) {
                  return;
                }

                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setFilePickerActiveIndex((index) => Math.min(index + 1, filteredFiles.length - 1));
                }

                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setFilePickerActiveIndex((index) => Math.max(index - 1, 0));
                }

                if (event.key === 'Enter') {
                  event.preventDefault();
                  const target = filteredFiles[filePickerActiveIndex] || filteredFiles[0];
                  if (target?._id) {
                    handleSelectPickerFile(target._id);
                  }
                }
              }}
              disabled={isReadOnlyMode}
            />

            <div className="file-picker-list">
              {filteredFiles.map((item, index) => (
                <button
                  key={item._id}
                  type="button"
                  className={`file-picker-item ${index === filePickerActiveIndex ? 'file-picker-item--active' : ''}`}
                  onClick={() => handleSelectPickerFile(item._id)}
                  onMouseEnter={() => setFilePickerActiveIndex(index)}
                >
                  <span className="file-picker-item-name">{renderMatchedName(item.name, filePickerQuery)}</span>
                  <span className="file-picker-item-meta">{item.language}</span>
                </button>
              ))}
            </div>

            {filteredFiles.length === 0 && (
              <div className="file-picker-empty">
                No files match your search or the project is empty.
              </div>
            )}
          </div>
        </div>
      )}

      {commandPaletteOpen && (
        <div className="modal-overlay" role="presentation" onClick={() => setCommandPaletteOpen(false)}>
          <div
            className="file-picker-modal command-palette-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-palette-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="file-picker-header">
              <div>
                <h2 id="command-palette-title">Command Palette</h2>
                <p>Type a command or action name.</p>
              </div>
              <button type="button" className="modal-close-button" onClick={() => setCommandPaletteOpen(false)}>
                ×
              </button>
            </div>

            <input
              type="text"
              className="file-picker-search"
              placeholder="Type a command..."
              value={commandPaletteQuery}
              onChange={(event) => setCommandPaletteQuery(event.target.value)}
              autoFocus
              disabled={isReadOnlyMode}
            />

            <div className="file-picker-list">
              {filteredCommandActions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="file-picker-item"
                  onClick={() => handleRunCommandPaletteItem(item)}
                >
                  <span className="file-picker-item-name">{item.label}</span>
                </button>
              ))}
            </div>

            {filteredCommandActions.length === 0 && (
              <div className="file-picker-empty">
                No commands match your query.
              </div>
            )}
          </div>
        </div>
      )}

      {runConfigModalOpen && (
        <div className="modal-overlay" role="presentation" onClick={() => setRunConfigModalOpen(false)}>
          <div
            className="file-picker-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="run-config-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="file-picker-header">
              <div>
                <h2 id="run-config-modal-title">Run Configurations</h2>
                <p>Edit your launch configuration JSON.</p>
              </div>
              <button type="button" className="modal-close-button" onClick={() => setRunConfigModalOpen(false)}>
                ×
              </button>
            </div>

            <textarea
              className="file-picker-search"
              style={{ minHeight: '260px', fontFamily: "'Fira Code', 'Consolas', monospace", whiteSpace: 'pre' }}
              value={runConfigJson}
              onChange={(event) => setRunConfigJson(event.target.value)}
            />

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="sidebar-action" onClick={() => setRunConfigModalOpen(false)}>Cancel</button>
              <button type="button" className="sidebar-action" onClick={handleSaveRunConfigurations}>Save</button>
            </div>
          </div>
        </div>
      )}

      {helpModalOpen && (
        <div className="modal-overlay" role="presentation" onClick={() => setHelpModalOpen(false)}>
          <div
            className="file-picker-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="file-picker-header">
              <div>
                <h2 id="help-modal-title">About Sync Code</h2>
                <p>MERN collaborative editor with real-time rooms, run panel, and terminal.</p>
              </div>
              <button type="button" className="modal-close-button" onClick={() => setHelpModalOpen(false)}>
                ×
              </button>
            </div>

            <div className="file-picker-empty" style={{ textAlign: 'left' }}>
              <strong>Keyboard Shortcuts</strong>
              <br />
              Ctrl/Cmd+S: Save
              <br />
              Ctrl/Cmd+Shift+S: Save As
              <br />
              Ctrl/Cmd+Z: Undo
              <br />
              Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z: Redo
              <br />
              Ctrl/Cmd+X: Cut
              <br />
              Ctrl/Cmd+C: Copy
              <br />
              Ctrl/Cmd+V: Paste
              <br />
              Ctrl/Cmd+F: Find
              <br />
              Ctrl/Cmd+H: Replace
              <br />
              Ctrl/Cmd+Shift+F: Find in Files
              <br />
              Ctrl/Cmd+Shift+H: Replace in Files
              <br />
              Ctrl/Cmd+/: Toggle Line Comment
              <br />
              Shift+Alt+A: Toggle Block Comment
              <br />
              Ctrl+Alt+Up/Down: Add Cursor Above/Below
              <br />
              Shift+Alt+Up/Down: Copy Line Up/Down
              <br />
              Ctrl/Cmd+B: Toggle Sidebar
              <br />
              Ctrl/Cmd+P: Go to File
              <br />
              Ctrl/Cmd+G: Go to Line
              <br />
              Ctrl/Cmd+Alt+N: Run Code
            </div>
          </div>
        </div>
      )}

      {versionHistoryOpen && (
        <div className="modal-overlay" role="presentation" onClick={() => setVersionHistoryOpen(false)}>
          <div
            className="file-picker-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="version-history-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="file-picker-header">
              <div>
                <h2 id="version-history-title">Version History</h2>
                <p>Restore any previously autosaved or manually saved snapshot.</p>
              </div>
              <button type="button" className="modal-close-button" onClick={() => setVersionHistoryOpen(false)}>
                ×
              </button>
            </div>

            <div className="file-picker-list">
              {versionLoading && <div className="file-picker-empty">Loading versions...</div>}
              {!versionLoading && fileVersions.map((version) => (
                <div key={version._id} className="file-picker-item file-picker-item--row">
                  <span className="file-picker-item-name">
                    Version #{version.versionNumber} • {version.source}
                  </span>
                  <span className="file-picker-item-meta">
                    {new Date(version.createdAt).toLocaleString()}
                  </span>
                  <button
                    type="button"
                    className="sidebar-action"
                    onClick={() => handleRestoreVersion(version._id)}
                    disabled={isReadOnlyMode}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>

            {!versionLoading && fileVersions.length === 0 && (
              <div className="file-picker-empty">No versions available yet.</div>
            )}
          </div>
        </div>
      )}

      {!isZenMode && (
      <>
      <MenuPopup
        ref={menuAnchorRef}
        isOpen={menuOpen}
        sections={topMenuSections}
        activePath={activePath}
        onToggle={handleToggleMainMenu}
        onHoverPath={handleHoverMenuPath}
        onSelectItem={handleSidebarMenuAction}
        onClose={handleCloseMainMenu}
        statusText={isSocketConnected() ? 'Backend connected' : 'Backend disconnected'}
      />
      </>
      )}

      {adminPanelOpen && (
        <div className="modal-overlay" role="presentation" onClick={handleCloseAdminPanel}>
          <div
            className="admin-panel-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-panel-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="admin-panel-header">
              <div>
                <h2 id="admin-panel-title">Admin Panel</h2>
                <p>Manage who can read or write in Sync Code.</p>
              </div>
              <button type="button" className="modal-close-button" onClick={handleCloseAdminPanel}>
                ×
              </button>
            </div>

            {adminUsersError && <div className="error-message">{adminUsersError}</div>}

            <div className="admin-panel-list">
              {adminUsersLoading ? (
                <div className="file-picker-empty">Loading users...</div>
              ) : adminUsers.length === 0 ? (
                <div className="file-picker-empty">No users found.</div>
              ) : (
                adminUsers.map((member) => (
                  <div key={member.id} className="admin-user-row">
                    <div className="admin-user-meta">
                      <strong>{member.name}</strong>
                      <span>{member.email}</span>
                      <small>{member.isVerified ? 'Verified' : 'Pending verification'}</small>
                    </div>

                    <div className="admin-user-controls">
                      <label htmlFor={`role-${member.id}`}>Role</label>
                      <select
                        id={`role-${member.id}`}
                        value={member.role}
                        disabled={adminUpdatingUserId === member.id}
                        onChange={(event) => handleUserRoleChange(member.id, event.target.value)}
                      >
                        <option value="admin">Admin</option>
                        <option value="writer">Writer</option>
                        <option value="reader">Reader</option>
                      </select>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <div className={`editor-shell ${isCollabFullscreen ? 'editor-shell--collab-full' : ''}`}>
        {leftWorkspaceTab === 'chat' && (
          <RightPanel
            roomId={joinedRoom ? roomId : ''}
            currentUserId={currentUserId}
            currentUserName={user?.name || user?.email || 'You'}
            roomUsers={usersInRoom}
            isRoomManager={isRoomManager}
            onGetSelectedSnippet={handleGetSelectedCodeSnippet}
            onOpenSnippetInEditor={handleOpenSnippetInEditor}
            isFullscreen={isCollabFullscreen}
            onToggleFullscreen={setIsCollabFullscreen}
            dock="left"
            requestedTab={collabRequestedTab}
            panelOpenSignal={collabPanelOpenSignal}
            forceOpen
          />
        )}

        {!isZenMode && showActivityBar && (
        <aside className="activity-bar" aria-label="Activity Bar">
          <div className="activity-bar__top">
            <button
              type="button"
              className={`activity-button ${leftWorkspaceTab === 'files' ? 'activity-button--active' : ''}`}
              onClick={() => {
                const next = leftWorkspaceTab === 'files' ? '' : 'files';
                setLeftWorkspaceTab(next);
                setActiveSidebarPanel('explorer');
                setSidebarVisible(Boolean(next));
                setRequestsPanelVisible(false);
              }}
              title="Files"
            >
              <span className="activity-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M8 3h6l5 5v13H8V3z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
            </button>
            <button
              type="button"
              className={`activity-button ${leftWorkspaceTab === 'search' ? 'activity-button--active' : ''}`}
              onClick={() => {
                const next = leftWorkspaceTab === 'search' ? '' : 'search';
                setLeftWorkspaceTab(next);
                setActiveSidebarPanel('search');
                setSidebarVisible(Boolean(next));
                setRequestsPanelVisible(false);
              }}
              title="Search"
            >
              <span className="activity-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="10.5" cy="10.5" r="5.5" stroke="currentColor" strokeWidth="1.8"/>
                  <path d="M15 15l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
              </span>
            </button>
            <button
              type="button"
              className={`activity-button ${leftWorkspaceTab === 'git' ? 'activity-button--active' : ''}`}
              onClick={() => {
                const next = leftWorkspaceTab === 'git' ? '' : 'git';
                setLeftWorkspaceTab(next);
                setSidebarVisible(false);
                setRequestsPanelVisible(Boolean(next));
              }}
              title="Git / Requests"
            >
              <span className="activity-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="6" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.6"/>
                  <circle cx="18" cy="5" r="2.2" stroke="currentColor" strokeWidth="1.6"/>
                  <circle cx="18" cy="18" r="2.2" stroke="currentColor" strokeWidth="1.6"/>
                  <path d="M8.2 6h4.8c2.4 0 4.2 1.8 4.2 4.2V15.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
            </button>
            <button
              type="button"
              className={`activity-button ${leftWorkspaceTab === 'debug' ? 'activity-button--active' : ''}`}
              onClick={() => {
                const next = leftWorkspaceTab === 'debug' ? '' : 'debug';
                setLeftWorkspaceTab(next);
                setActiveSidebarPanel('runDebug');
                setSidebarVisible(Boolean(next));
                setRequestsPanelVisible(false);
              }}
              title="Debug / Run"
            >
              <span className="activity-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 7c2.8 0 5 2.2 5 5v4.2a5 5 0 0 1-10 0V12c0-2.8 2.2-5 5-5z" stroke="currentColor" strokeWidth="1.6"/>
                  <path d="M9.6 7.2L8.2 5.8M14.4 7.2l1.4-1.4M7 12H5m14 0h-2M7.2 16.2 5.8 17.6m11-1.4 1.4 1.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                </svg>
              </span>
            </button>
            <button
              type="button"
              className={`activity-button ${leftWorkspaceTab === 'chat' ? 'activity-button--active' : ''}`}
              onClick={() => {
                const next = leftWorkspaceTab === 'chat' ? '' : 'chat';
                setLeftWorkspaceTab(next);
                setSidebarVisible(false);
                setRequestsPanelVisible(false);
                if (next) {
                  setCollabRequestedTab('chat');
                  setCollabPanelOpenSignal((previous) => previous + 1);
                }
              }}
              title="Chat"
            >
              <span className="activity-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-5 3v-3H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
                </svg>
              </span>
            </button>
          </div>

          <div className="activity-bar__bottom">
            <button
              type="button"
              className="activity-button"
              onClick={() => setHelpModalOpen(true)}
              title="Settings / Profile"
            >
              <span className="activity-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z" stroke="currentColor" strokeWidth="1.7"/>
                  <path d="M19.2 13.2v-2.4l-2-.7a5.3 5.3 0 0 0-.4-1l1-1.9-1.7-1.7-1.9 1a5.3 5.3 0 0 0-1-.4l-.7-2h-2.4l-.7 2a5.3 5.3 0 0 0-1 .4l-1.9-1-1.7 1.7 1 1.9a5.3 5.3 0 0 0-.4 1l-2 .7v2.4l2 .7a5.3 5.3 0 0 0 .4 1l-1 1.9 1.7 1.7 1.9-1a5.3 5.3 0 0 0 1 .4l.7 2h2.4l.7-2a5.3 5.3 0 0 0 1-.4l1.9 1 1.7-1.7-1-1.9a5.3 5.3 0 0 0 .4-1l2-.7z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                </svg>
              </span>
            </button>
          </div>
        </aside>
        )}

        {!isZenMode && showSideBar && sidebarVisible && leftWorkspaceTab !== 'chat' && (
          <aside className="workspace-sidebar">
            <div className="sidebar-brand" aria-label="Sync Code brand">
              <h2 className="sidebar-brand__title">Sync Code</h2>
              <p className="sidebar-brand__subtitle">{currentUserDisplayName}</p>
            </div>

            <div className="sidebar-file-panel">

            {activeSidebarPanel !== 'explorer' && (
              <div className="sidebar-section">
                <div className="sidebar-heading-row">
                  <h3>{activeSidebarPanel === 'search' ? 'Search' : activeSidebarPanel === 'sourceControl' ? 'Source Control' : activeSidebarPanel === 'runDebug' ? 'Run & Debug' : 'Extensions'}</h3>
                </div>
                <div className="sidebar-list">
                  {activeSidebarPanel === 'search' && (
                    <button type="button" className="sidebar-action" onClick={handleFindInFiles}>Open Global Search</button>
                  )}
                  {activeSidebarPanel === 'sourceControl' && (
                    <p className="sidebar-placeholder">Git integration placeholder. Connect your repository to enable staged changes and commits.</p>
                  )}
                  {activeSidebarPanel === 'runDebug' && (
                    <div className="run-debug-panel">
                      <div className="run-debug-actions">
                        <button type="button" className="sidebar-action" onClick={handleStartDebugging}>Start Debugging</button>
                        <button type="button" className="sidebar-action" onClick={handleRunWithoutDebugging}>Run Without Debugging</button>
                        <button type="button" className="sidebar-action" onClick={handleStopDebugging}>Stop</button>
                        <button type="button" className="sidebar-action" onClick={handleRestartDebugging}>Restart</button>
                        <button type="button" className="sidebar-action" onClick={handleOpenRunConfigurations}>Open Configurations</button>
                      </div>
                      <div className="run-debug-console" aria-label="Debug Console">
                        {debugLogs.length === 0 ? (
                          <p className="sidebar-placeholder">Debug Console is empty.</p>
                        ) : (
                          debugLogs.slice(-80).map((entry) => (
                            <div key={entry.id} className={`run-debug-log run-debug-log--${entry.type || 'info'}`}>
                              <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                              <span>{entry.message}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                  {activeSidebarPanel === 'extensions' && (
                    <button type="button" className="sidebar-action" onClick={handleExtensions}>Browse Extensions Marketplace</button>
                  )}
                </div>
              </div>
            )}

            {activeSidebarPanel === 'explorer' && (
            <div className="sidebar-section sidebar-section--projects">
              <div className="sidebar-heading-row">
                <h3>Projects</h3>
                  <button type="button" className="sidebar-action" onClick={handleCreateProject} disabled={effectiveReadOnlyMode}>+ New</button>
              </div>
              <div className="sidebar-list">
                {projects.map((project) => (
                  <button
                    type="button"
                    key={project._id}
                    className={`sidebar-item ${project._id === activeProjectId ? 'sidebar-item--active' : ''}`}
                    onClick={() => handleSelectProject(project)}
                  >
                    <span>{project.name}</span>
                    <span className="sidebar-count">{project.fileCount || 0}</span>
                  </button>
                ))}
              </div>
            </div>
            )}

            {activeSidebarPanel === 'explorer' && (
            <div className="sidebar-section sidebar-section--files">
              <div className="sidebar-heading-row">
                <h3>Files</h3>
                <div className="explorer-top-actions">
                  <button type="button" className="sidebar-action" onClick={() => handleNewFolder(null)} disabled={effectiveReadOnlyMode}>+ Folder</button>
                  <button type="button" className="sidebar-action" onClick={() => handleCreateFileInFolder(null)} disabled={effectiveReadOnlyMode}>+ File</button>
                  <button type="button" className="sidebar-action" onClick={handleOpenFile}>Open</button>
                </div>
              </div>
              <FileExplorer
                treeData={explorerTree}
                activeFileId={activeFileId}
                highlightedNodeId={highlightedExplorerNodeId}
                isReadOnly={effectiveReadOnlyMode}
                onOpenFile={loadFileById}
                onNewFile={handleCreateFileInFolder}
                onNewFolder={handleNewFolder}
                onRename={handleRenameFile}
                onDelete={handleDeleteFile}
                onMoveNode={handleMoveNodeInExplorer}
                onCopyPath={handleCopyNodePath}
              />
            </div>
            )}
            </div>
          </aside>
        )}

        <div className="editor-workspace">
          {!isZenMode && (
            <div className="editor-header">
              <div className="header-left">
                <div className="editor-toolbar editor-toolbar--inline">
                  <div className="toolbar-group toolbar-group--file">
                    <span className="toolbar-label">File</span>
                    <input
                      type="text"
                      value={fileName}
                      onChange={handleFileNameChange}
                      className="file-name-input"
                      placeholder="Enter filename"
                      disabled={effectiveReadOnlyMode}
                    />
                  </div>

                  <div className="toolbar-group toolbar-group--primary-actions">
                    <button
                      type="button"
                      onClick={handleSubmitChangeSuggestion}
                      className="btn-save btn-save--subtle"
                      disabled={effectiveReadOnlyMode || !joinedRoom || isRoomManager}
                      title={isRoomManager ? 'Manager edits are applied directly' : 'Submit a conflict request to the manager'}
                    >
                      Suggest Change
                    </button>
                  </div>

                  <div className="toolbar-group toolbar-group--language">
                    <label htmlFor="language" className="toolbar-label">Language</label>
                    <select id="language" value={language} onChange={handleLanguageChange} className="language-select" disabled={effectiveReadOnlyMode}>
                      <option value="javascript">JavaScript</option>
                      <option value="python">Python</option>
                      <option value="java">Java</option>
                      <option value="cpp">C++</option>
                      <option value="csharp">C#</option>
                      <option value="html">HTML</option>
                      <option value="css">CSS</option>
                    </select>
                  </div>

                  <details className="toolbar-more" open={false}>
                    <summary>More</summary>
                    <div className="toolbar-more-menu">
                      <button type="button" onClick={() => {
                        setLeftWorkspaceTab('files');
                        setActiveSidebarPanel('explorer');
                        setSidebarVisible(true);
                        setRequestsPanelVisible(false);
                      }} className="btn-save btn-save--subtle">
                        Open Files Panel
                      </button>
                      <button type="button" onClick={() => {
                        setLeftWorkspaceTab('chat');
                        setSidebarVisible(false);
                        setRequestsPanelVisible(false);
                        setCollabRequestedTab('chat');
                        setCollabPanelOpenSignal((previous) => previous + 1);
                      }} className="btn-save btn-save--subtle">
                        Open Chat Panel
                      </button>
                      <button type="button" onClick={() => {
                        setLeftWorkspaceTab('git');
                        setSidebarVisible(false);
                        setRequestsPanelVisible((previous) => !previous);
                      }} className="btn-save btn-save--subtle">
                        {requestsPanelVisible ? 'Hide Requests' : 'Show Requests'}
                      </button>
                      <button type="button" onClick={() => {
                        setLeftWorkspaceTab('terminal');
                        setSidebarVisible(false);
                        setRequestsPanelVisible(false);
                        setTerminalVisible((previous) => !previous);
                        if (!terminalVisible) {
                          setBottomPanelTab('terminal');
                        }
                      }} className="btn-save btn-save--subtle">
                        {terminalVisible ? 'Hide Terminal' : 'Show Terminal'}
                      </button>
                      <label htmlFor="suggestion-trigger-mode" className="toolbar-label">Suggestion mode</label>
                      <select
                        id="suggestion-trigger-mode"
                        value={suggestionTriggerMode}
                        onChange={(event) => setSuggestionTriggerMode(event.target.value)}
                        className="language-select"
                      >
                        <option value="auto">Auto (debounced)</option>
                        <option value="enter">Enter key</option>
                        <option value="manual">Manual</option>
                      </select>
                      <button type="button" onClick={handleOpenVersionHistory} className="btn-save btn-save--subtle" disabled={!activeFileId}>
                        History
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveTheme((current) => (current === 'light' ? 'dark' : 'light'))}
                        className="btn-save btn-save--subtle"
                      >
                        {activeTheme === 'light' ? 'Dark Mode' : 'Light Mode'}
                      </button>
                      {isAdminUser && (
                        <button
                          type="button"
                          onClick={handleOpenAdminPanel}
                          className="btn-save btn-save--subtle"
                        >
                          Admin Panel
                        </button>
                      )}
                      {canToggleReadOnly && (
                        <button
                          type="button"
                          onClick={handleToggleReadOnlyMode}
                          className="btn-save btn-save--subtle"
                          disabled={isTogglingReadOnlyMode}
                        >
                          {isTogglingReadOnlyMode
                            ? 'Updating...'
                            : isReadOnlyMode
                            ? 'Switch to Write Mode'
                            : 'Switch to Read-Only'}
                        </button>
                      )}
                      {isRoomManager && usersInRoom.length > 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            const target = usersInRoom.find((member) => String(member.userId) !== String(currentUserId));
                            if (target) {
                              handleToggleRoomMemberRole(target);
                            }
                          }}
                          className="btn-save btn-save--subtle"
                        >
                          Toggle Collaborator Role
                        </button>
                      )}
                      <button type="button" onClick={handleLogout} className="btn-save btn-save--subtle">Logout</button>
                    </div>
                  </details>
                </div>
              </div>

              <div className="header-center">
                {!joinedRoom ? (
                  <div className="room-join-controls">
                    <input
                      type="text"
                      value={roomInput}
                      onChange={(event) => setRoomInput(event.target.value)}
                      placeholder="Enter Room ID (or leave empty)"
                      className="room-input"
                      onKeyDown={(event) => event.key === 'Enter' && handleJoinRoom()}
                      disabled={isReadOnlyMode}
                    />
                    <button onClick={() => handleJoinRoom()} className="btn-join-room" disabled={isReadOnlyMode}>Join Room</button>
                    <button onClick={handleGenerateAndJoinRoom} className="btn-generate-room" disabled={isReadOnlyMode}>Generate & Join</button>
                    <button
                      type="button"
                      onClick={handleSave}
                      className="btn-save"
                      disabled={saving || effectiveReadOnlyMode}
                      title="Save"
                    >
                      {saving ? 'Saving...' : isSaved ? 'Saved' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={handleRunCode}
                      className="btn-run-code"
                      disabled={runningCode || effectiveReadOnlyMode}
                      title="Run"
                    >
                      {runningCode ? 'Running...' : 'Run'}
                    </button>
                    {roomError && <span className="room-error">{roomError}</span>}
                  </div>
                ) : (
                  <div className="room-info-panel room-info-panel--compact">
                    <div className="user-avatar-stack" aria-label="Active users">
                      {compactVisibleUsers.map((member) => (
                        <span
                          key={member.userId || member.userName}
                          className="user-avatar-chip"
                          title={member.userName || 'Collaborator'}
                        >
                          {String(member.userName || 'U').slice(0, 1).toUpperCase()}
                        </span>
                      ))}
                      {compactOverflowUsers > 0 && (
                        <span className="user-avatar-chip user-avatar-chip--count">+{compactOverflowUsers}</span>
                      )}
                    </div>
                    <span className="room-mini-meta" title={workspaceStatus}>Live {onlinePresenceCount}</span>
                    <span className="room-mini-meta">Typing {Object.keys(typingUsers).length}</span>
                    <span className="room-mini-meta">Editing {Object.keys(remoteUpdaters).length}</span>
                    <span className="room-mini-meta">Same file {usersEditingSameFileCount}</span>
                    {isRoomManager && (
                      <span className="room-mini-meta room-mini-meta--manager">Manager</span>
                    )}
                    <button
                      type="button"
                      onClick={handleSave}
                      className="btn-save"
                      disabled={saving || effectiveReadOnlyMode}
                      title="Save"
                    >
                      {saving ? 'Saving...' : isSaved ? 'Saved' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={handleRunCode}
                      className="btn-run-code"
                      disabled={runningCode || effectiveReadOnlyMode}
                      title="Run"
                    >
                      {runningCode ? 'Running...' : 'Run'}
                    </button>
                    <button type="button" onClick={handleCopyRoomId} className="btn-generate-room">Copy Room ID</button>
                    <button onClick={handleLeaveRoom} className="btn-leave-room">Leave Room</button>
                  </div>
                )}
              </div>

              <div className="header-right" />
            </div>
          )}

              {joinedRoom && !isZenMode && (
                <div className="collab-status-strip" role="status" aria-live="polite">
                  <span className="collab-status-strip__badge">{`Collab: ${collabSyncState}`}</span>
                  <span>
                    {isRoomManager
                      ? 'Manager mode: edits apply directly.'
                      : isTyping
                      ? `Typing... (${suggestionTriggerMode === 'auto' ? `auto suggest in ${Math.round(SUGGESTION_DEBOUNCE_MS / 100) / 10}s after pause` : 'debounce off'} • press Enter or click Suggest Change to submit now)`
                      : 'Non-manager mode: click Suggest Change to send a conflict request.'}
                  </span>
                  {lastChangeTime ? <span>{`Last edit ${new Date(lastChangeTime).toLocaleTimeString()}`}</span> : null}
                </div>
              )}

              {executionAlert && !isZenMode && (
                <div className={`execution-alert execution-alert--${executionAlert.tone || 'error'}`}>
                  <strong>{executionAlert.title}</strong>
                  <p>{executionAlert.message}</p>
                  {executionAlert.suggestion && <p>{executionAlert.suggestion}</p>}
                </div>
              )}

              <div className={`editor-main-stack ${isCenteredLayout && !isZenMode ? 'editor-main-stack--centered' : ''}`}>
                <div className={`editor-main-column ${isCenteredLayout && !isZenMode ? 'editor-main-column--centered' : ''}`}>
                  <div className="editor-wrapper">
                    <div className="editor-canvas" ref={editorCanvasRef}>
                      {lineActionPopover.visible && inlineSelectedChange && (
                        <div
                          className="line-action-popover"
                          style={{ top: `${lineActionPopover.top}px`, left: `${lineActionPopover.left}px` }}
                          role="dialog"
                          aria-label="Suggestion quick actions"
                        >
                          <div className="line-action-popover__title">
                            {inlineSelectedChange.userName || 'Collaborator'} suggested on line {inlineSelectedChange.startLine}
                          </div>
                          <div className="line-action-popover__actions">
                            <button
                              type="button"
                              className="change-action-btn accept"
                              disabled={effectiveReadOnlyMode || !isRoomOwner}
                              onClick={() => handleAcceptPendingChange(inlineSelectedChange.changeId)}
                            >
                              Accept
                            </button>
                            <button
                              type="button"
                              className="change-action-btn reject"
                              disabled={effectiveReadOnlyMode || !isRoomOwner}
                              onClick={() => handleRejectPendingChange(inlineSelectedChange.changeId)}
                            >
                              Reject
                            </button>
                            <button
                              type="button"
                              className="line-action-popover__close"
                              onClick={() => {
                                setInlineActionChangeId('');
                                setLineActionPopover((previous) => ({ ...previous, visible: false, changeId: '' }));
                              }}
                            >
                              Close
                            </button>
                          </div>
                        </div>
                      )}
                      <Editor
                      height="100%"
                      width="100%"
                      language={language}
                      value={code}
                      onChange={handleEditorChange}
                      onMount={handleEditorMount}
                      theme={monacoTheme}
                      defaultLanguage="javascript"
                      options={{
                        readOnly: effectiveReadOnlyMode,
                        minimap: {
                          enabled: showMinimap,
                          size: 'fit',
                          showSlider: 'mouseover',
                          maxColumn: 120,
                        },
                        fontSize: editorFontSize,
                        fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace",
                        fontLigatures: true,
                        lineHeight: 1.6,
                        wordWrap: isWordWrapEnabled ? 'on' : 'off',
                        automaticLayout: true,
                        lineNumbers: 'on',
                        glyphMargin: true,
                        lineDecorationsWidth: 6,
                        folding: true,
                        foldingHighlight: true,
                        showFoldingControls: 'mouseover',
                        cursorBlinking: 'blink',
                        cursorSmoothCaretAnimation: 'on',
                        cursorStyle: 'line',
                        cursorWidth: 2,
                        scrollBeyondLastLine: true,
                        smoothScrolling: true,
                        scrollbar: {
                          vertical: 'visible',
                          horizontal: 'visible',
                          useShadows: true,
                          verticalSliderSize: 12,
                          horizontalSliderSize: 12,
                        },
                        formatOnPaste: true,
                        formatOnType: true,
                        autoIndent: 'full',
                        tabSize: 2,
                        insertSpaces: true,
                        quickSuggestions: {
                          other: true,
                          comments: true,
                          strings: true,
                        },
                        suggestLineHeight: 26,
                        renderWhitespace: 'none',
                        renderControlCharacters: false,
                        guides: {
                          bracketPairs: true,
                          bracketPairsHorizontal: true,
                          highlightActiveBracketPair: true,
                          indentation: true,
                        },
                        selectionClipboard: true,
                        selectionHighlight: true,
                        occurrencesHighlight: true,
                        hideCursorInOverviewRuler: false,
                        overviewRulerBorder: true,
                        overviewRulerLanes: 3,
                        mouseWheelZoom: true,
                        allowMultilineString: true,
                        bracketPairColorization: {
                          enabled: true,
                          independentColorPoolPerBracketType: true,
                        },
                      }}
                    />

                    </div>

                    {showStatusBar && !isZenMode && (
                    <div className="editor-status-bar">
                      <div className="status-left">
                        <span className="status-item">
                          <span className="status-value">Ln {cursorPosition.lineNumber}, Col {cursorPosition.column}</span>
                        </span>
                        <span className="status-item status-file">
                          <span className="status-value">{fileName}</span>
                        </span>
                      </div>

                      <div className="status-center">
                        <span className="status-item">
                          <span className="status-value">{language.toUpperCase()}</span>
                        </span>
                        <span className="status-item">
                          <span className="status-value">UTF-8</span>
                        </span>
                      </div>

                      <div className="status-right">
                        <span className="status-item">
                          <span className="status-value">Git: main</span>
                        </span>
                        <span className="status-item">
                          <span className="status-value">Lines: {lineCount}</span>
                        </span>
                        <span className="status-item">
                          <span className="status-value">Chars: {charCount}</span>
                        </span>
                        {!terminalVisible && (
                          <button
                            type="button"
                            className="status-item status-terminal-toggle"
                            onClick={() => {
                              setTerminalVisible(true);
                              setBottomPanelTab('terminal');
                            }}
                            title="Show terminal (Ctrl+`)"
                          >
                            ⌞ Terminal
                          </button>
                        )}
                        <span className={`status-item ${isSaved ? 'saved' : 'unsaved'}`}>
                          {saving ? 'Saving...' : isSaved ? 'All changes saved' : 'Unsaved changes'}
                        </span>
                        <span className="status-item">
                          <span className="status-value">
                            Auto-save: {autoSaveStatus}
                            {lastAutoSavedAt ? ` (${new Date(lastAutoSavedAt).toLocaleTimeString()})` : ''}
                          </span>
                        </span>
                      </div>
                    </div>
                    )}

                    {terminalVisible && terminalInEditorArea && !isZenMode && (
                      <div
                        className="terminal-panel"
                        style={{ height: `${terminalHeight}px` }}
                      >
                        <TerminalPanel
                          isReadOnly={effectiveReadOnlyMode}
                          onTerminalApiReady={handleTerminalApiReady}
                          activeFileName={fileName}
                          activeFileLanguage={language}
                          activeFileContent={code}
                          selectedCode={handleGetSelectedCodeSnippet()?.code || ''}
                        />
                      </div>
                    )}

                    {terminalVisible && !terminalInEditorArea && !isZenMode && (
                      <>
                        <div
                          ref={terminalResizeDividerRef}
                          className={`terminal-resize-handle ${isResizingTerminal ? 'dragging' : ''}`}
                          onMouseDown={handleTerminalResizeMouseDown}
                          onClick={handleTerminalDividerClick}
                          onKeyDown={handleTerminalDividerKeyDown}
                          role="separator"
                          aria-label="Resize terminal"
                          aria-orientation="horizontal"
                          aria-valuemin={180}
                          aria-valuemax={200}
                          aria-valuenow={terminalHeight}
                          tabIndex={0}
                        />
                        <div
                          className="terminal-panel"
                          style={{ height: `${terminalHeight}px` }}
                        >
                        <TerminalPanel
                          isReadOnly={effectiveReadOnlyMode}
                          onTerminalApiReady={handleTerminalApiReady}
                          activeFileName={fileName}
                          activeFileLanguage={language}
                          activeFileContent={code}
                          selectedCode={handleGetSelectedCodeSnippet()?.code || ''}
                        />
                        </div>
                      </>
                    )}

                    {!isZenMode && (
                    <div className="editor-fab-group" aria-label="Quick actions">
                      <button
                        type="button"
                        className="editor-fab editor-fab--run"
                        onClick={handleRunCode}
                        disabled={runningCode || effectiveReadOnlyMode}
                        title="Run Code"
                      >
                        ▶
                      </button>
                      <button
                        type="button"
                        className="editor-fab editor-fab--save"
                        onClick={handleSave}
                        disabled={saving || effectiveReadOnlyMode}
                        title="Save"
                      >
                        💾
                      </button>
                    </div>
                    )}
                  </div>
                </div>

                {joinedRoom && requestsPanelVisible && (
                  <aside className="requests-sidebar" aria-label="Change requests panel">
                    <div className="requests-sidebar__header">
                      <div className="requests-sidebar__header-top">
                        <div>
                          <strong>Requests</strong>
                          <div className="requests-sidebar__title-subtext">Incoming suggestions</div>
                        </div>
                        <button
                          type="button"
                          className="requests-sidebar__close"
                          onClick={() => setRequestsPanelVisible(false)}
                          aria-label="Close requests panel"
                          title="Close"
                        >
                          ×
                        </button>
                      </div>
                      <div className="requests-sidebar__meta">
                        <span>{activeFilePendingChanges.length} pending</span>
                        <span>{appliedChanges.length} accepted</span>
                        <span>{String(originalCode || '').length} base chars</span>
                        {activeFileConflicts > 0 && <span className="change-conflict-pill">{activeFileConflicts} conflicts</span>}
                      </div>
                    </div>

                    {inlineSelectedChange && (
                      <div className="inline-change-actions" role="status" aria-live="polite">
                        <span>
                          Line {inlineSelectedChange.startLine}-{inlineSelectedChange.endLine} suggested by {inlineSelectedChange.userName || 'Collaborator'}
                        </span>
                        <button
                          type="button"
                          className="change-action-btn accept"
                          disabled={effectiveReadOnlyMode || !isRoomOwner}
                          onClick={() => handleAcceptPendingChange(inlineSelectedChange.changeId)}
                        >
                          Accept selected
                        </button>
                        <button
                          type="button"
                          className="change-action-btn reject"
                          disabled={effectiveReadOnlyMode || !isRoomOwner}
                          onClick={() => handleRejectPendingChange(inlineSelectedChange.changeId)}
                        >
                          Reject selected
                        </button>
                      </div>
                    )}

                    {activeFilePendingChanges.length === 0 ? (
                      <p className="change-review-empty">No pending suggestions for this file.</p>
                    ) : (
                      <div className="change-review-list">
                        {activeFilePendingChanges.map((change) => {
                          const canResolve = !effectiveReadOnlyMode && isRoomOwner;
                          const previewAdded = String(change.code || '').slice(0, 120);
                          const previewRemoved = String(change.previousCode || '').slice(0, 120);

                          return (
                            <div key={change.changeId} className={`change-review-item ${change.conflict ? 'is-conflict' : ''}`}>
                              <div className="change-review-meta">
                                <span className="change-review-author">{change.userName || 'Collaborator'}</span>
                                <span className="change-review-time">
                                  {new Date(change.timestamp || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                                </span>
                                <span className="change-review-location">Ln {change.startLine}-{change.endLine}</span>
                                {change.conflict && <span className="change-conflict-pill">Conflict</span>}
                              </div>

                              <div className="change-review-diff">
                                {previewRemoved ? <pre className="change-preview change-preview--remove">- {previewRemoved}</pre> : null}
                                {previewAdded ? <pre className="change-preview change-preview--add">+ {previewAdded}</pre> : null}
                              </div>

                              <div className="change-review-actions">
                                <button
                                  type="button"
                                  className="change-action-btn accept"
                                  disabled={!canResolve}
                                  onClick={() => handleAcceptPendingChange(change.changeId)}
                                >
                                  Accept
                                </button>
                                <button
                                  type="button"
                                  className="change-action-btn reject"
                                  disabled={!canResolve}
                                  onClick={() => handleRejectPendingChange(change.changeId)}
                                >
                                  Reject
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </aside>
                )}
              </div>
            </div>
          </div>
      </div>

      <ChatbotAssistant
        requestReply={handleChatbotReplyRequest}
        onAction={handleChatbotAction}
        isReadOnlyMode={isReadOnlyMode}
      />
    </>
  );
}
