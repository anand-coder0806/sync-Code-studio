import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  emitChatDelivered,
  emitChatMessage,
  emitChatSeen,
  emitChatStopTyping,
  emitChatTyping,
  emitSuggestCode,
  getSocket,
  initializeSocket,
  socketEmit,
  socketOff,
  socketOn,
} from '../services/socket';
import ChatPanel from './ChatPanel';
import VoicePanel from './VoicePanel';
import VideoPanel from './VideoPanel';

const EMOJIS = ['😀', '😁', '😂', '🤣', '😊', '😍', '🤔', '🙌', '🔥', '👍', '🎉', '🚀', '💡', '😎', '🙏', '❤️'];
const REACTION_EMOJIS = ['👍', '🔥', '😂', '❤️', '🚀', '👏'];
const SNIPPET_LANGUAGES = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'java', label: 'Java' },
  { value: 'python', label: 'Python' },
  { value: 'cpp', label: 'C++' },
];
const SNIPPET_LANGUAGE_VALUES = new Set(SNIPPET_LANGUAGES.map((entry) => entry.value));
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const formatTime = (value) => {
  if (!value) {
    return '';
  }

  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const formatFileSize = (size) => {
  if (!size) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const getAvatarInitials = (name = '') => {
  const cleaned = String(name || '').trim();
  if (!cleaned) {
    return 'U';
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }

  return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
};

const detectSnippetLanguage = (snippet = '') => {
  const text = String(snippet || '');
  if (/\bfunction\b|=>|console\.log|const\s|let\s/.test(text)) return 'javascript';
  if (/\bdef\b|print\(|import\s+\w+/.test(text)) return 'python';
  if (/\bpublic\s+class\b|System\.out\.println/.test(text)) return 'java';
  if (/#include\s*<|std::|cout\s*<</.test(text)) return 'cpp';
  if (/^\s*<[^>]+>/m.test(text)) return 'html';
  if (/\bSELECT\b|\bFROM\b|\bWHERE\b/i.test(text)) return 'sql';
  return 'plaintext';
};

const normalizeSnippetLanguage = (value = '') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return 'plaintext';
  }

  if (['js', 'jsx', 'javascript', 'mjs', 'cjs'].includes(normalized)) return 'javascript';
  if (['py', 'python'].includes(normalized)) return 'python';
  if (['java'].includes(normalized)) return 'java';
  if (['c++', 'cpp', 'cc', 'cxx', 'hpp', 'h++'].includes(normalized)) return 'cpp';
  if (SNIPPET_LANGUAGE_VALUES.has(normalized)) return normalized;
  return 'plaintext';
};

const CODE_BLOCK_ONLY_REGEX = /^```([a-zA-Z0-9_+#-]*)\n?([\s\S]*?)```$/;

const parseCodeMessageFromDraft = (draftText = '') => {
  const trimmed = String(draftText || '').trim();
  if (!trimmed) {
    return null;
  }

  const match = CODE_BLOCK_ONLY_REGEX.exec(trimmed);
  if (!match) {
    return null;
  }

  const snippetCode = String(match[2] || '').replace(/\n$/, '');
  if (!snippetCode.trim()) {
    return null;
  }

  return {
    language: normalizeSnippetLanguage(match[1] || detectSnippetLanguage(snippetCode)),
    code: snippetCode,
  };
};

const escapeHtml = (value = '') => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const escapeRegex = (value = '') => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const wrapRegex = (input, regex, className) => input.replace(regex, `<span class="${className}">$1</span>`);

const highlightCodeSnippet = (snippetCode = '', snippetLanguage = 'plaintext') => {
  const language = normalizeSnippetLanguage(snippetLanguage);
  let html = escapeHtml(snippetCode);

  if (language === 'python') {
    html = wrapRegex(html, /(#.*)$/gm, 'room-chat-token-comment');
  } else {
    html = wrapRegex(html, /(\/\/.*)$/gm, 'room-chat-token-comment');
  }

  html = wrapRegex(html, /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, 'room-chat-token-string');

  const keywordMap = {
    javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'import', 'from', 'export', 'try', 'catch', 'await', 'async'],
    java: ['public', 'private', 'protected', 'class', 'interface', 'static', 'final', 'void', 'int', 'long', 'double', 'boolean', 'new', 'return', 'if', 'else', 'for', 'while', 'try', 'catch'],
    python: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'import', 'from', 'as', 'with', 'lambda', 'pass', 'None', 'True', 'False'],
    cpp: ['include', 'using', 'namespace', 'class', 'struct', 'public', 'private', 'protected', 'void', 'int', 'long', 'double', 'bool', 'return', 'if', 'else', 'for', 'while', 'try', 'catch', 'template'],
  };

  const keywords = keywordMap[language] || [];
  if (keywords.length > 0) {
    const keywordRegex = new RegExp(`\\b(${keywords.map(escapeRegex).join('|')})\\b`, 'g');
    html = wrapRegex(html, keywordRegex, 'room-chat-token-keyword');
  }

  html = wrapRegex(html, /\b(\d+(?:\.\d+)?)\b/g, 'room-chat-token-number');
  return html;
};

const normalizeMessage = (message) => ({
  id: message?.id || message?._id || `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  clientMessageId: String(message?.clientMessageId || ''),
  roomId: String(message?.roomId || ''),
  senderId: String(message?.senderId || message?.userId || ''),
  sender: String(message?.sender || message?.senderName || message?.userName || 'Anonymous'),
  message: String(message?.message || message?.text || ''),
  messageType: message?.messageType === 'code' ? 'code' : 'text',
  codeSnippet: message?.codeSnippet && typeof message.codeSnippet.code === 'string'
    ? {
        language: normalizeSnippetLanguage(message.codeSnippet.language || detectSnippetLanguage(message.codeSnippet.code)),
        code: String(message.codeSnippet.code || ''),
      }
    : null,
  status: message?.status || 'sent',
  deliveredBy: Array.isArray(message?.deliveredBy) ? message.deliveredBy : [],
  seenBy: Array.isArray(message?.seenBy) ? message.seenBy : [],
  deliveredAt: message?.deliveredAt || null,
  seenAt: message?.seenAt || null,
  attachment: message?.attachment || null,
  reactions: Array.isArray(message?.reactions) ? message.reactions : [],
  editedAt: message?.editedAt || null,
  isDeleted: Boolean(message?.isDeleted),
  timestamp: message?.timestamp || message?.createdAt || Date.now(),
  socketId: message?.socketId || '',
  isAssistant: Boolean(message?.isAssistant),
});

const parseMessageTokens = (text = '') => {
  const content = String(text || '');
  const tokens = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  let cursor = 0;
  let match = regex.exec(content);

  while (match) {
    if (match.index > cursor) {
      tokens.push({ type: 'text', value: content.slice(cursor, match.index) });
    }

    const language = match[1] || detectSnippetLanguage(match[2]);
    tokens.push({ type: 'code', value: match[2], language });
    cursor = regex.lastIndex;
    match = regex.exec(content);
  }

  if (cursor < content.length) {
    tokens.push({ type: 'text', value: content.slice(cursor) });
  }

  return tokens.length > 0 ? tokens : [{ type: 'text', value: content }];
};

const statusLabel = (status) => {
  if (status === 'seen') return '👁 seen';
  if (status === 'delivered') return '✓✓ delivered';
  return '✓ sent';
};

const isImageAttachment = (attachment) => Boolean(attachment && attachment.isImage && attachment.url);

const parseAiPromptFromText = (value = '') => {
  const text = String(value || '').trim();
  if (!text) {
    return { shouldAskAi: false, prompt: '' };
  }

  const matched = /^\s*(?:@ai|ask\s+ai)\b[:,-]?\s*(.*)$/i.exec(text);
  if (!matched) {
    return { shouldAskAi: false, prompt: '' };
  }

  const prompt = String(matched[1] || '').trim();
  return {
    shouldAskAi: Boolean(prompt),
    prompt,
  };
};

const ChatIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M5 6h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H10l-5 3v-3H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
  </svg>
);

const AttachmentIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M8.5 12.5 14.8 6.2a3 3 0 1 1 4.2 4.2l-7.8 7.8a4.5 4.5 0 0 1-6.4-6.4l8.1-8.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ShareCodeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="m9.5 7.5-4 4 4 4M14.5 7.5l4 4-4 4M13 5l-2 14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function RoomChatPanel({
  roomId,
  activePanelTab,
  featureView = 'chat',
  currentUserId,
  currentUserName,
  roomUsers = [],
  isRoomManager = false,
  onGetSelectedSnippet,
  onOpenSnippetInEditor,
  onUnreadCountChange,
}) {
  const roomKey = String(roomId || (typeof window !== 'undefined' ? localStorage.getItem('syncCodeLastRoomId') || '' : '') || '');
  const resolvedPanelTab = ['chat', 'voice', 'video'].includes(featureView)
    ? featureView
    : (['chat', 'voice', 'video'].includes(activePanelTab) ? activePanelTab : 'chat');
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [composerMode, setComposerMode] = useState('text');
  const [snippetLanguage, setSnippetLanguage] = useState('javascript');
  const [editingMessageId, setEditingMessageId] = useState('');
  const [editingDraft, setEditingDraft] = useState('');
  const [isEmojiOpen, setIsEmojiOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isAiReplying, setIsAiReplying] = useState(false);
  const [remoteTypingNames, setRemoteTypingNames] = useState([]);
  const [attachmentDraft, setAttachmentDraft] = useState(null);
  const [notificationPermission, setNotificationPermission] = useState(() => (typeof window !== 'undefined' && 'Notification' in window ? window.Notification.permission : 'unsupported'));
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [chatError, setChatError] = useState('');
  const [aiPendingCount, setAiPendingCount] = useState(0);
  const [callJoined, setCallJoined] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [callParticipants, setCallParticipants] = useState([]);
  const [remoteStreams, setRemoteStreams] = useState([]);
  const [localStream, setLocalStream] = useState(null);
  const [speakingUsers, setSpeakingUsers] = useState([]);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const localVideoRef = useRef(null);
  const fileInputRef = useRef(null);
  const typingTimerRef = useRef(null);
  const typingActiveRef = useRef(false);
  const unreadCountRef = useRef(0);
  const deliveredAckedRef = useRef(new Set());
  const seenAckedRef = useRef(new Set());
  const peersRef = useRef(new Map());
  const localStreamRef = useRef(null);
  const speakingTimerRef = useRef(null);
  const audioContextRef = useRef(null);

  const roomMessages = useMemo(() => messages, [messages]);

  const isOwnMessage = useCallback((message = {}) => {
    const normalizedCurrentUserId = String(currentUserId || '').trim();
    const normalizedSenderId = String(message?.senderId || message?.userId || '').trim();

    // Primary ownership check: strict senderId vs currentUserId comparison.
    if (normalizedCurrentUserId && normalizedSenderId) {
      return normalizedSenderId === normalizedCurrentUserId;
    }

    // Fallback: same active socket means this client originated the message.
    const currentSocketId = String(getSocket()?.id || '').trim();
    const senderSocketId = String(message?.socketId || '').trim();
    if (currentSocketId && senderSocketId) {
      return senderSocketId === currentSocketId;
    }

    return false;
  }, [currentUserId]);
  const currentUserIsManager = useMemo(() => {
    if (isRoomManager) {
      return true;
    }

    const currentMember = roomUsers.find((member) => String(member.userId || '') === String(currentUserId || ''));
    return Boolean(currentMember && ['manager', 'owner', 'host'].includes(String(currentMember.role || '').toLowerCase()));
  }, [isRoomManager, roomUsers, currentUserId]);

  const typingLabel = useMemo(() => {
    if (remoteTypingNames.length === 0) return '';
    if (remoteTypingNames.length === 1) return `${remoteTypingNames[0]} is typing...`;
    return `${remoteTypingNames.slice(0, 2).join(', ')} and ${remoteTypingNames.length - 2} others are typing...`;
  }, [remoteTypingNames]);

  const collaboratorStatus = useMemo(() => {
    const participantsByUserId = new Map(callParticipants.map((entry) => [String(entry.userId || ''), entry]));
    return roomUsers.map((member) => {
      const call = participantsByUserId.get(String(member.userId || ''));
      const speaking = Boolean(call?.speaking) || speakingUsers.includes(String(member.userId || ''));
      return {
        ...member,
        inCall: Boolean(call),
        speaking,
      };
    });
  }, [roomUsers, callParticipants, speakingUsers]);

  const voiceChannelParticipants = useMemo(() => (
    callParticipants.map((entry) => ({
      socketId: entry.socketId,
      userId: String(entry.userId || ''),
      userName: entry.userName || 'Collaborator',
      speaking: Boolean(entry.speaking) || speakingUsers.includes(String(entry.userId || '')),
      muted: entry.audioEnabled === false,
      hasVideo: Boolean(entry.videoEnabled),
      isSelf: Boolean(currentUserId && String(entry.userId || '') === String(currentUserId)),
    }))
  ), [callParticipants, speakingUsers, currentUserId]);

  const remoteStreamsBySocketId = useMemo(() => {
    const map = new Map();
    remoteStreams.forEach((entry) => {
      map.set(String(entry.socketId || ''), entry.stream || null);
    });
    return map;
  }, [remoteStreams]);

  const callGridParticipants = useMemo(() => {
    const participants = callParticipants.map((entry) => {
      const socketId = String(entry.socketId || '');
      const isSelf = Boolean(currentUserId && String(entry.userId || '') === String(currentUserId));
      const stream = isSelf ? localStream : remoteStreamsBySocketId.get(socketId) || null;
      const hasVideoTrack = Boolean(stream?.getVideoTracks?.().length > 0);
      const showVideo = Boolean(entry.videoEnabled) && hasVideoTrack;

      return {
        socketId,
        userName: entry.userName || 'Collaborator',
        isSelf,
        stream,
        showVideo,
        speaking: Boolean(entry.speaking) || speakingUsers.includes(String(entry.userId || '')),
      };
    });

    return participants.sort((a, b) => {
      if (a.isSelf) return -1;
      if (b.isSelf) return 1;
      return a.userName.localeCompare(b.userName);
    });
  }, [callParticipants, currentUserId, localStream, remoteStreamsBySocketId, speakingUsers]);

  const hasVideoTiles = useMemo(() => {
    const hasLocalVideo = Boolean(localStream && localStream.getVideoTracks().some((track) => track.enabled !== false));
    const hasRemoteVideo = callParticipants.some((entry) => Boolean(entry.videoEnabled));
    return hasLocalVideo || hasRemoteVideo;
  }, [localStream, callParticipants]);

  const setUnreadCount = useCallback((value) => {
    unreadCountRef.current = Math.max(0, Number(value) || 0);
    onUnreadCountChange?.(unreadCountRef.current);
  }, [onUnreadCountChange]);

  const requestHistory = useCallback(() => {
    const socket = getSocket();
    if (socket?.connected && roomKey) {
      console.log('[chat] request history', { roomId: roomKey, socketId: socket.id });
      socket.emit('chat-history-request', { roomId: roomKey });
    }
  }, [roomKey]);

  const requestAssistantReply = useCallback((prompt, options = {}) => {
    const normalizedPrompt = String(prompt || '').trim();
    if (!normalizedPrompt || !roomKey) {
      return;
    }

    const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setAiPendingCount((previous) => previous + 1);
    socketEmit('chat-ai-request', {
      roomId: roomKey,
      requestId,
      prompt: normalizedPrompt,
      ...options,
    });
  }, [roomKey]);

  const emitStopTyping = useCallback(() => {
    if (!roomKey || !typingActiveRef.current) {
      return;
    }

    emitChatStopTyping(roomKey, currentUserName);
    typingActiveRef.current = false;
  }, [roomKey, currentUserName]);

  const scheduleStopTyping = useCallback(() => {
    window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => {
      emitStopTyping();
    }, 1500);
  }, [emitStopTyping]);

  const markTyping = useCallback(() => {
    if (!roomKey) {
      return;
    }

    if (!typingActiveRef.current) {
      emitChatTyping(roomKey, currentUserName);
      typingActiveRef.current = true;
    }
    scheduleStopTyping();
  }, [roomKey, currentUserName, scheduleStopTyping]);

  const cleanupPeerConnection = useCallback((socketId) => {
    const existing = peersRef.current.get(socketId);
    if (existing?.pc) {
      try {
        existing.pc.close();
      } catch (error) {
        // ignore close errors
      }
    }
    peersRef.current.delete(socketId);
    setRemoteStreams((previous) => previous.filter((entry) => entry.socketId !== socketId));
  }, []);

  const teardownCall = useCallback(() => {
    peersRef.current.forEach((_, socketId) => cleanupPeerConnection(socketId));
    peersRef.current.clear();

    if (speakingTimerRef.current) {
      window.clearInterval(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    setRemoteStreams([]);
    setCallParticipants([]);
    setLocalStream(null);
    setSpeakingUsers([]);
    setCallJoined(false);
  }, [cleanupPeerConnection]);

  const buildPeerConnection = useCallback((targetSocketId, targetUserName = 'Collaborator') => {
    const socket = getSocket();
    if (!socket?.connected) {
      return null;
    }

    if (peersRef.current.has(targetSocketId)) {
      return peersRef.current.get(targetSocketId).pc;
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const local = localStreamRef.current;
    if (local) {
      local.getTracks().forEach((track) => {
        pc.addTrack(track, local);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketEmit('webrtc-ice-candidate', {
          roomId: roomKey,
          targetSocketId,
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) {
        return;
      }

      setRemoteStreams((previous) => {
        if (previous.some((entry) => entry.socketId === targetSocketId)) {
          return previous.map((entry) => (
            entry.socketId === targetSocketId
              ? { ...entry, stream, userName: targetUserName }
              : entry
          ));
        }

        return [...previous, { socketId: targetSocketId, stream, userName: targetUserName }];
      });
    };

    peersRef.current.set(targetSocketId, { pc, userName: targetUserName });
    return pc;
  }, [roomKey]);

  const createOfferForPeer = useCallback(async (targetSocketId, targetUserName) => {
    const pc = buildPeerConnection(targetSocketId, targetUserName);
    if (!pc) {
      return;
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socketEmit('webrtc-offer', {
      roomId: roomKey,
      targetSocketId,
      sdp: offer,
    });
      console.log('[webrtc] sent offer', { roomId: roomKey, targetSocketId });
  }, [buildPeerConnection, roomKey]);

  const startSpeakingDetector = useCallback((stream) => {
    if (!stream || stream.getAudioTracks().length === 0) {
      return;
    }

    if (speakingTimerRef.current) {
      window.clearInterval(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }

    const AudioContextRef = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextRef) {
      return;
    }

    const context = new AudioContextRef();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    audioContextRef.current = context;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let speaking = false;

    speakingTimerRef.current = window.setInterval(() => {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i += 1) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;
      const nextSpeaking = average > 14;
      if (nextSpeaking !== speaking) {
        speaking = nextSpeaking;
        socketEmit('webrtc-speaking', {
          roomId: roomKey,
          speaking,
        });
      }
    }, 160);
  }, [roomKey]);

  const joinCall = useCallback(async (preferVideo = false) => {
    if (!roomKey || callJoined) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
          sampleSize: 16,
          latency: 0,
        },
        video: Boolean(preferVideo || videoEnabled),
      });

      stream.getAudioTracks().forEach((track) => {
        track.contentHint = 'speech';
      });

      localStreamRef.current = stream;
      setLocalStream(stream);
      setAudioEnabled(true);
      setVideoEnabled(Boolean(preferVideo || videoEnabled));
      setCallJoined(true);

      socketEmit('webrtc-join', {
        roomId: roomKey,
        audioEnabled: true,
        videoEnabled: Boolean(preferVideo || videoEnabled),
      });
      console.log('[webrtc] join call', {
        roomId: roomKey,
        audioEnabled: true,
        videoEnabled: Boolean(preferVideo || videoEnabled),
      });

      startSpeakingDetector(stream);
    } catch (error) {
      setChatError(error.message || 'Unable to join voice/video call.');
    }
  }, [roomKey, callJoined, videoEnabled, startSpeakingDetector]);

  const leaveCall = useCallback(() => {
    socketEmit('webrtc-leave', { roomId: roomKey });
    console.log('[webrtc] leave call', { roomId: roomKey });
    teardownCall();
  }, [roomKey, teardownCall]);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) {
      return;
    }

    const nextEnabled = !audioEnabled;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = nextEnabled;
    });
    setAudioEnabled(nextEnabled);
    socketEmit('webrtc-media-state', {
      roomId: roomKey,
      audioEnabled: nextEnabled,
      videoEnabled,
    });
    if (!nextEnabled) {
      socketEmit('webrtc-speaking', {
        roomId: roomKey,
        speaking: false,
      });
    }
  }, [audioEnabled, roomKey, videoEnabled]);

  const toggleVideo = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream) {
      return;
    }

    let nextEnabled = !videoEnabled;
    if (nextEnabled && stream.getVideoTracks().length === 0) {
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const [videoTrack] = videoStream.getVideoTracks();
        if (videoTrack) {
          stream.addTrack(videoTrack);
          peersRef.current.forEach(({ pc }) => {
            pc.addTrack(videoTrack, stream);
          });
        }
      } catch (error) {
        setChatError('Unable to enable camera.');
        nextEnabled = false;
      }
    }

    stream.getVideoTracks().forEach((track) => {
      track.enabled = nextEnabled;
    });

    setVideoEnabled(nextEnabled);
    socketEmit('webrtc-media-state', {
      roomId: roomKey,
      audioEnabled,
      videoEnabled: nextEnabled,
    });
  }, [audioEnabled, roomKey, videoEnabled]);

  const clearComposerState = useCallback(() => {
    setDraft('');
    setComposerMode('text');
    setAttachmentDraft(null);
    setIsEmojiOpen(false);
    emitStopTyping();
    window.clearTimeout(typingTimerRef.current);
  }, [emitStopTyping]);

  useEffect(() => {
    setMessages([]);
    setDraft('');
    setComposerMode('text');
    setSnippetLanguage('javascript');
    setEditingMessageId('');
    setEditingDraft('');
    setRemoteTypingNames([]);
    setAttachmentDraft(null);
    setChatError('');
    setAiPendingCount(0);
    setUnreadCount(0);
    deliveredAckedRef.current = new Set();
    seenAckedRef.current = new Set();
    emitStopTyping();
    teardownCall();
  }, [roomKey, emitStopTyping, setUnreadCount, teardownCall]);

  useEffect(() => {
    if (!roomKey) {
      return undefined;
    }

    initializeSocket();

    const onHistory = (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey) {
        console.warn('[chat] history dropped due to room mismatch', {
          expectedRoomId: roomKey,
          payloadRoomId: payload.roomId || null,
        });
        return;
      }
      const history = Array.isArray(payload.messages) ? payload.messages.map(normalizeMessage) : [];
      setMessages(history);
      if (resolvedPanelTab === 'chat') {
        setUnreadCount(0);
      }
    };

    const onMessage = (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey) {
        console.warn('[chat] receive_message dropped due to room mismatch', {
          expectedRoomId: roomKey,
          payloadRoomId: payload.roomId || null,
          socketId: payload.socketId || null,
        });
        return;
      }
      const nextMessage = normalizeMessage(payload);
      console.log('RECEIVE: receive_message', {
        roomId: payload.roomId,
        clientMessageId: payload.clientMessageId || null,
        messageId: payload.id || payload._id || null,
        socketId: payload.socketId || null,
      });
      console.log('[chat] received message', {
        roomId: payload.roomId,
        messageId: payload.id || payload._id || null,
        senderId: payload.senderId || null,
        sender: payload.sender || null,
      });

      setMessages((previous) => {
        const hasExactId = previous.some((entry) => String(entry.id) === String(nextMessage.id));
        const hasClientMessageId = Boolean(nextMessage.clientMessageId)
          && previous.some((entry) => String(entry.clientMessageId || '') === String(nextMessage.clientMessageId));

        if (hasExactId || hasClientMessageId) {
          return previous.map((entry) => {
            const sameId = String(entry.id) === String(nextMessage.id);
            const sameClientMessageId = Boolean(nextMessage.clientMessageId)
              && String(entry.clientMessageId || '') === String(nextMessage.clientMessageId);

            return sameId || sameClientMessageId ? { ...entry, ...nextMessage } : entry;
          });
        }
        return [...previous, nextMessage];
      });

      const isSelf = isOwnMessage(nextMessage);
      if (!isSelf) {
        if (!deliveredAckedRef.current.has(nextMessage.id)) {
          deliveredAckedRef.current.add(nextMessage.id);
          emitChatDelivered(roomKey, nextMessage.id);
        }

        if (resolvedPanelTab !== 'chat') {
          setUnreadCount(unreadCountRef.current + 1);
          if (notificationsEnabled && typeof window !== 'undefined' && 'Notification' in window && window.Notification.permission === 'granted') {
            const preview = nextMessage.attachment ? nextMessage.attachment.name : nextMessage.message;
            // eslint-disable-next-line no-new
            new window.Notification(`New message from ${nextMessage.sender}`, {
              body: preview || 'You have a new message',
              tag: `chat-${roomKey}`,
            });
          }
        }
      }
    };

    const onStatus = (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey) return;
      const messageId = String(payload.messageId || '');
      if (!messageId) return;
      setMessages((previous) => previous.map((entry) => (
        String(entry.id) === messageId
          ? {
              ...entry,
              status: payload.status || entry.status,
              deliveredBy: Array.isArray(payload.deliveredBy) ? payload.deliveredBy : entry.deliveredBy,
              seenBy: Array.isArray(payload.seenBy) ? payload.seenBy : entry.seenBy,
              deliveredAt: payload.deliveredAt || entry.deliveredAt,
              seenAt: payload.seenAt || entry.seenAt,
            }
          : entry
      )));
    };

    const onMessageUpdated = (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey) return;
      const messageId = String(payload.messageId || '');
      if (!messageId) return;
      setMessages((previous) => previous.map((entry) => (
        String(entry.id) === messageId
          ? normalizeMessage({
              ...entry,
              ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
              ...(payload.messageType ? { messageType: payload.messageType } : {}),
              ...(payload.codeSnippet ? { codeSnippet: payload.codeSnippet } : {}),
              ...(Array.isArray(payload.reactions) ? { reactions: payload.reactions } : {}),
              ...(payload.editedAt ? { editedAt: payload.editedAt } : {}),
            })
          : entry
      )));
    };

    const onMessageDeleted = (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey) return;
      const messageId = String(payload.messageId || '');
      if (!messageId) return;
      setMessages((previous) => previous.map((entry) => (
        String(entry.id) === messageId
          ? {
              ...entry,
              message: '[message deleted]',
              isDeleted: true,
              attachment: null,
            }
          : entry
      )));
    };

    const onTyping = (userName) => {
      if (!userName || String(userName) === String(currentUserName)) return;
      setRemoteTypingNames((previous) => Array.from(new Set([...previous, String(userName)])));
    };

    const onStopTyping = (userName) => {
      if (!userName) return;
      setRemoteTypingNames((previous) => previous.filter((name) => name !== String(userName)));
    };

    const onChatError = (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey) return;
      setChatError(String(payload.message || 'Chat error'));
    };

    const onChatAiStatus = (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey) return;
      if (payload.status === 'failed') {
        setChatError(String(payload.error || 'Assistant request failed.'));
      }
      if (payload.status === 'completed' || payload.status === 'failed') {
        setAiPendingCount((previous) => Math.max(0, previous - 1));
      }
    };

    const onCallState = (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey) return;
      setCallParticipants(Array.isArray(payload.participants) ? payload.participants : []);
    };

    const onWebRtcPeers = (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey) return;
      const peers = Array.isArray(payload.peers) ? payload.peers : [];
      setCallParticipants((previous) => {
        const map = new Map(previous.map((entry) => [entry.socketId, entry]));
        peers.forEach((peer) => map.set(peer.socketId, peer));
        return Array.from(map.values());
      });
    };

    const onWebRtcPeerJoined = async (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey || !callJoined) return;
      const peer = payload.peer || {};
      if (!peer.socketId) return;
      console.log('[webrtc] peer joined', { roomId: payload.roomId, peerSocketId: peer.socketId, peerUserId: peer.userId });
      await createOfferForPeer(peer.socketId, peer.userName || 'Collaborator');
      setCallParticipants((previous) => {
        const map = new Map(previous.map((entry) => [entry.socketId, entry]));
        map.set(peer.socketId, peer);
        return Array.from(map.values());
      });
    };

    const onWebRtcOffer = async (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey || !callJoined) return;
      const fromSocketId = String(payload.fromSocketId || '');
      if (!fromSocketId) return;
      console.log('[webrtc] received offer', { roomId: payload.roomId, fromSocketId });
      const pc = buildPeerConnection(fromSocketId, payload.fromUserName || 'Collaborator');
      if (!pc) return;

      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketEmit('webrtc-answer', {
        roomId: roomKey,
        targetSocketId: fromSocketId,
        sdp: answer,
      });
      console.log('[webrtc] sent answer', { roomId: roomKey, targetSocketId: fromSocketId });
    };

    const onWebRtcAnswer = async (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey || !callJoined) return;
      const fromSocketId = String(payload.fromSocketId || '');
      const existing = peersRef.current.get(fromSocketId);
      if (!existing?.pc || !payload.sdp) return;
      console.log('[webrtc] received answer', { roomId: payload.roomId, fromSocketId });
      await existing.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    };

    const onWebRtcIceCandidate = async (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey || !callJoined) return;
      const fromSocketId = String(payload.fromSocketId || '');
      const existing = peersRef.current.get(fromSocketId);
      if (!existing?.pc || !payload.candidate) return;
      console.log('[webrtc] received ice-candidate', { roomId: payload.roomId, fromSocketId });
      try {
        await existing.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch (error) {
        // ignore invalid candidates
      }
    };

    const onWebRtcMediaState = (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey) return;
      setCallParticipants((previous) => previous.map((entry) => (
        entry.socketId === payload.socketId
          ? { ...entry, audioEnabled: payload.audioEnabled !== false, videoEnabled: Boolean(payload.videoEnabled) }
          : entry
      )));
    };

    const onWebRtcSpeaking = (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey) return;
      setSpeakingUsers((previous) => {
        const userId = String(payload.userId || '');
        if (!userId) return previous;
        if (payload.speaking) return Array.from(new Set([...previous, userId]));
        return previous.filter((entry) => entry !== userId);
      });
    };

    const onWebRtcPeerLeft = (payload = {}) => {
      if (String(payload.roomId || '') !== roomKey) return;
      const socketId = String(payload.socketId || '');
      if (!socketId) return;
      cleanupPeerConnection(socketId);
      setCallParticipants((previous) => previous.filter((entry) => entry.socketId !== socketId));
    };

    const onConnect = () => {
      requestHistory();
      if (callJoined) {
        socketEmit('webrtc-join', {
          roomId: roomKey,
          audioEnabled,
          videoEnabled,
        });
      }
    };

    socketOff('chat-history', onHistory);
    socketOff('chat-message', onMessage);
    socketOff('receive_message', onMessage);
    socketOff('chat-message-status', onStatus);
    socketOff('chat-message-updated', onMessageUpdated);
    socketOff('chat-message-deleted', onMessageDeleted);
    socketOff('typing', onTyping);
    socketOff('stop-typing', onStopTyping);
    socketOff('chat-error', onChatError);
    socketOff('chat-ai-status', onChatAiStatus);
    socketOff('room-call-state', onCallState);
    socketOff('webrtc-peers', onWebRtcPeers);
    socketOff('webrtc-peer-joined', onWebRtcPeerJoined);
    socketOff('webrtc-offer', onWebRtcOffer);
    socketOff('webrtc-answer', onWebRtcAnswer);
    socketOff('webrtc-ice-candidate', onWebRtcIceCandidate);
    socketOff('webrtc-media-state', onWebRtcMediaState);
    socketOff('webrtc-speaking', onWebRtcSpeaking);
    socketOff('webrtc-peer-left', onWebRtcPeerLeft);
    socketOff('connect', onConnect);

    socketOn('chat-history', onHistory);
    socketOn('chat-message', onMessage);
    socketOn('receive_message', onMessage);
    socketOn('chat-message-status', onStatus);
    socketOn('chat-message-updated', onMessageUpdated);
    socketOn('chat-message-deleted', onMessageDeleted);
    socketOn('typing', onTyping);
    socketOn('stop-typing', onStopTyping);
    socketOn('chat-error', onChatError);
    socketOn('chat-ai-status', onChatAiStatus);
    socketOn('room-call-state', onCallState);
    socketOn('webrtc-peers', onWebRtcPeers);
    socketOn('webrtc-peer-joined', onWebRtcPeerJoined);
    socketOn('webrtc-offer', onWebRtcOffer);
    socketOn('webrtc-answer', onWebRtcAnswer);
    socketOn('webrtc-ice-candidate', onWebRtcIceCandidate);
    socketOn('webrtc-media-state', onWebRtcMediaState);
    socketOn('webrtc-speaking', onWebRtcSpeaking);
    socketOn('webrtc-peer-left', onWebRtcPeerLeft);
    socketOn('connect', onConnect);
    // Smoke test: popup for manager on conflict-request/receive-request
    socketOn('conflict-request', (payload = {}) => {
      window.alert(`Conflict request received from ${payload.userName || 'a user'} for file: ${payload.fileKey || payload.fileId || ''}`);
    });
    socketOn('receive-request', (payload = {}) => {
      window.alert(`Request received from ${payload.userName || 'a user'} for file: ${payload.fileKey || payload.fileId || ''}`);
    });

    // Listen for request approval: update all users
    socketOn('code-update', (payload = {}) => {
      // You may want to check fileKey/roomId matches current context
      // For smoke test, just log or update UI as needed
      // Example: setCode(payload.code) or similar
      console.log('[sync] code-update received', payload);
      // TODO: update code editor state here
    });

    // Listen for request rejection: only non-managers update
    socketOn('request-rejected', (payload = {}) => {
      if (!currentUserIsManager) {
        // Only non-managers update their screen to match manager's state
        // Example: setCode(payload.code) or similar
        console.log('[sync] request-rejected, updating to manager state', payload);
        // TODO: update code editor state here
      } else {
        // Optionally notify manager
        console.log('[sync] request-rejected (manager view)', payload);
      }
    });

    requestHistory();

    return () => {
      socketOff('chat-history', onHistory);
      socketOff('chat-message', onMessage);
      socketOff('receive_message', onMessage);
      socketOff('chat-message-status', onStatus);
      socketOff('chat-message-updated', onMessageUpdated);
      socketOff('chat-message-deleted', onMessageDeleted);
      socketOff('typing', onTyping);
      socketOff('stop-typing', onStopTyping);
      socketOff('chat-error', onChatError);
      socketOff('chat-ai-status', onChatAiStatus);
      socketOff('room-call-state', onCallState);
      socketOff('webrtc-peers', onWebRtcPeers);
      socketOff('webrtc-peer-joined', onWebRtcPeerJoined);
      socketOff('webrtc-offer', onWebRtcOffer);
      socketOff('webrtc-answer', onWebRtcAnswer);
      socketOff('webrtc-ice-candidate', onWebRtcIceCandidate);
      socketOff('webrtc-media-state', onWebRtcMediaState);
      socketOff('webrtc-speaking', onWebRtcSpeaking);
      socketOff('webrtc-peer-left', onWebRtcPeerLeft);
      socketOff('connect', onConnect);
    };
  }, [
    roomKey,
    currentUserId,
    currentUserName,
    isOwnMessage,
    resolvedPanelTab,
    notificationsEnabled,
    requestHistory,
    setUnreadCount,
    callJoined,
    audioEnabled,
    videoEnabled,
    createOfferForPeer,
    buildPeerConnection,
    cleanupPeerConnection,
  ]);

  useEffect(() => {
    if (resolvedPanelTab === 'chat') {
      setUnreadCount(0);
      inputRef.current?.focus();
    }
  }, [resolvedPanelTab, setUnreadCount]);

  useEffect(() => {
    if (resolvedPanelTab !== 'chat' || roomMessages.length === 0) {
      return;
    }

    roomMessages.forEach((message) => {
      const isSelf = isOwnMessage(message);
      if (!isSelf && !seenAckedRef.current.has(message.id)) {
        seenAckedRef.current.add(message.id);
        emitChatSeen(roomKey, message.id);
      }
    });
  }, [resolvedPanelTab, roomMessages, roomKey, isOwnMessage]);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [roomMessages, typingLabel, remoteStreams]);

  useEffect(() => () => {
    emitStopTyping();
    window.clearTimeout(typingTimerRef.current);
    leaveCall();
  }, [emitStopTyping, leaveCall]);

  const insertTextAtCursor = (text) => {
    const input = inputRef.current;
    if (!input) {
      setDraft((previous) => `${previous}${text}`);
      markTyping();
      return;
    }

    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const nextValue = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
    setDraft(nextValue);
    window.requestAnimationFrame(() => {
      input.focus();
      const nextCursor = start + text.length;
      input.setSelectionRange(nextCursor, nextCursor);
    });
    markTyping();
  };

  const highlightMentions = (text) => {
    const mentionRegex = /(@[a-zA-Z0-9_.-]+)/g;
    const parts = String(text || '').split(mentionRegex);
    return parts.map((part, index) => {
      const normalizedCurrentName = String(currentUserName || '').replace(/\s+/g, '').toLowerCase();
      const normalizedMention = String(part || '').replace(/^@/, '').toLowerCase();
      const isMention = part.startsWith('@');
      const isCurrentUserMention = isMention && normalizedMention === normalizedCurrentName;
      return (
        <span
          key={`${part}-${index}`}
          className={isCurrentUserMention ? 'room-chat-mention room-chat-mention--self' : isMention ? 'room-chat-mention' : ''}
        >
          {part}
        </span>
      );
    });
  };

  const handleFileSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (file.size > MAX_ATTACHMENT_SIZE) {
      setChatError('Attachment is too large. Max size is 5 MB.');
      return;
    }

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read attachment'));
      reader.readAsDataURL(file);
    });

    setAttachmentDraft({
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl,
      isImage: /^image\//i.test(file.type || ''),
    });
  };

  const handleSend = async (options = {}) => {
    const forceAi = Boolean(options.forceAi);
    const text = draft.trim();
    
    if ((!text && !attachmentDraft) || !roomKey) {
      return;
    }

    setIsSending(true);
    try {
      let messageType = 'text';
      let codeSnippet = null;
      let outgoingMessage = text;

      if (composerMode === 'code') {
        const code = String(draft || '');
        if (!code.trim()) {
          return;
        }
        messageType = 'code';
        codeSnippet = {
          language: normalizeSnippetLanguage(snippetLanguage || detectSnippetLanguage(code)),
          code,
        };
        outgoingMessage = code;
      } else {
        const parsedCodeSnippet = parseCodeMessageFromDraft(text);
        if (parsedCodeSnippet) {
          messageType = 'code';
          codeSnippet = parsedCodeSnippet;
          outgoingMessage = parsedCodeSnippet.code;
        }
      }

      const clientMessageId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimisticMessage = normalizeMessage({
        id: clientMessageId,
        clientMessageId,
        roomId: roomKey,
        senderId: String(currentUserId || ''),
        sender: String(currentUserName || 'You'),
        message: outgoingMessage,
        messageType,
        codeSnippet,
        status: 'sent',
        deliveredBy: [],
        seenBy: [],
        attachment: attachmentDraft || null,
        timestamp: Date.now(),
      });

      setMessages((previous) => [...previous, optimisticMessage]);
      
      emitChatMessage(roomKey, outgoingMessage, currentUserId, currentUserName, {
        attachment: attachmentDraft,
        messageType,
        codeSnippet,
        language: codeSnippet?.language || '',
        clientMessageId,
      });

      if (messageType === 'text') {
        const parsedAiPrompt = parseAiPromptFromText(outgoingMessage);
        if (forceAi || parsedAiPrompt.shouldAskAi) {
          requestAssistantReply(forceAi ? outgoingMessage : parsedAiPrompt.prompt);
        }
      }

      clearComposerState();
    } catch (error) {
      console.error('[chat] failed to send message:', error);
      setChatError('Failed to send message');
    } finally {
      setIsSending(false);
    }
  };

  const handleAskAssistant = async () => {
    await handleSend({ forceAi: true });
  };

  useEffect(() => {
    setIsAiReplying(aiPendingCount > 0);
  }, [aiPendingCount]);

  const handleShareSelection = () => {
    const snippet = typeof onGetSelectedSnippet === 'function' ? onGetSelectedSnippet() : null;
    if (!snippet?.code) {
      setChatError('No selected code found in editor.');
      return;
    }

    if (currentUserIsManager) {
      setChatError('Managers do not send suggestions.');
      return;
    }

    console.log('[suggest-code] Suggest sent', {
      roomId: roomKey,
      userId: currentUserId,
      userName: currentUserName,
      codeLength: String(snippet.code || '').length,
    });

    emitSuggestCode({
      roomId: roomKey,
      code: snippet.code,
      userId: currentUserId,
      role: currentUserIsManager ? 'manager' : 'member',
    });

    setChatError('');
  };

  const toggleSnippetComposer = () => {
    setComposerMode((previous) => {
      const nextMode = previous === 'code' ? 'text' : 'code';
      if (nextMode === 'code' && !String(draft || '').trim()) {
        setDraft('');
      }
      return nextMode;
    });
    inputRef.current?.focus();
  };

  const handleDraftChange = (event) => {
    const value = event.target.value;
    setDraft(value);
    if (value.trim()) markTyping();
    else emitStopTyping();
  };

  const handleMessageEditStart = (message) => {
    setEditingMessageId(String(message.id));
    setEditingDraft(message.message || '');
  };

  const handleMessageEditCancel = () => {
    setEditingMessageId('');
    setEditingDraft('');
  };

  const handleMessageEditSave = (messageId) => {
    const nextText = editingDraft.trim();
    if (!nextText) {
      return;
    }

    socketEmit('chat-message-edit', {
      roomId: roomKey,
      messageId,
      message: nextText,
    });
    handleMessageEditCancel();
  };

  const handleDeleteMessage = (messageId) => {
    socketEmit('chat-message-delete', {
      roomId: roomKey,
      messageId,
    });
  };

  const handleReactToMessage = (messageId, emoji) => {
    socketEmit('chat-message-react', {
      roomId: roomKey,
      messageId,
      emoji,
    });
  };

  const handleCopySnippet = async (snippetCode) => {
    await navigator.clipboard.writeText(snippetCode || '');
  };

  const handleOpenSnippet = (snippetCode, snippetLanguage) => {
    if (typeof onOpenSnippetInEditor === 'function') {
      onOpenSnippetInEditor(snippetCode, snippetLanguage);
    }
  };

  const requestNotificationPermission = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return;
    }
    const permission = await window.Notification.requestPermission();
    setNotificationPermission(permission);
    setNotificationsEnabled(permission === 'granted');
  };

  const getSenderDisplayName = useCallback((message = {}) => {
    // Primary: use sender name from message if available
    // CRITICAL: Never return "You" for other users - that's a bug indicator
    const messageSender = String(message?.sender || '').trim();
    if (messageSender && messageSender !== 'Anonymous' && messageSender !== 'You') {
      return messageSender;
    }

    // Fallback: look up sender from roomUsers by senderId
    const senderId = String(message?.senderId || message?.userId || '').trim();
    if (senderId && Array.isArray(roomUsers)) {
      const user = roomUsers.find((member) => String(member.userId || '') === senderId);
      if (user && user.userName) {
        return String(user.userName).trim();
      }
    }

    // Final fallback: use 'Unknown user'
    return 'Unknown user';
  }, [roomUsers]);

  const shouldShowEmptyState = roomMessages.length === 0;

  const renderMessage = (message, isSelf) => {
    const tokens = message.messageType === 'code' && message.codeSnippet?.code
      ? [{ type: 'code', value: message.codeSnippet.code, language: message.codeSnippet.language || 'plaintext' }]
      : parseMessageTokens(message.message);
    const attachment = message.attachment;
    
    // Use the isSelf parameter which is already correctly calculated by isOwnMessage
    // This includes socket ID check and user ID comparison
    const isCurrentUser = Boolean(isSelf);
    
    const displaySenderName = isCurrentUser ? 'You' : getSenderDisplayName(message);

    return (
      <article key={message.id} className={`room-chat-message ${isCurrentUser ? 'room-chat-message--self' : ''} ${message.isAssistant ? 'room-chat-message--assistant' : ''}`}>
        <div className="room-chat-message__meta">
          <span className="room-chat-message__author">{isCurrentUser ? 'You' : displaySenderName}</span>
          {message.isAssistant && <span className="room-chat-message__assistant-tag">Assistant</span>}
          <span className="room-chat-message__time">{formatTime(message.timestamp)}</span>
          {isCurrentUser && <span className="room-chat-message__status">{statusLabel(message.status)}</span>}
          {message.editedAt && <span className="room-chat-message__edited">edited</span>}
        </div>

        <div className="room-chat-message__bubble">
          {editingMessageId === String(message.id) ? (
            <div className="room-chat-message__edit-row">
              <textarea value={editingDraft} onChange={(event) => setEditingDraft(event.target.value)} rows={3} />
              <div className="room-chat-message__edit-actions">
                <button type="button" onClick={() => handleMessageEditSave(message.id)}>Save</button>
                <button type="button" onClick={handleMessageEditCancel}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              {tokens.map((token, index) => (
                token.type === 'code' ? (
                  <div key={`code-${message.id}-${index}`} className="room-chat-code-block">
                    <div className="room-chat-code-header">
                      <span>{token.language}</span>
                      <div className="room-chat-code-actions">
                        <button type="button" onClick={() => handleCopySnippet(token.value)}>Copy Code</button>
                        <button type="button" onClick={() => handleOpenSnippet(token.value, token.language)}>Open in Editor</button>
                      </div>
                    </div>
                    <pre className="room-chat-code">
                      <code
                        className={`language-${normalizeSnippetLanguage(token.language)}`}
                        dangerouslySetInnerHTML={{ __html: highlightCodeSnippet(token.value, token.language) }}
                      />
                    </pre>
                  </div>
                ) : (
                  <div key={`text-${message.id}-${index}`} className="room-chat-message__text">{highlightMentions(token.value)}</div>
                )
              ))}

              {attachment && attachment.url && (
                <div className="room-chat-message__attachment">
                  {isImageAttachment(attachment) && (
                    <a href={attachment.url} target="_blank" rel="noreferrer" className="room-chat-message__image-link">
                      <img src={attachment.url} alt={attachment.name} className="room-chat-message__image" />
                    </a>
                  )}
                  <a href={attachment.url} target="_blank" rel="noreferrer" className="room-chat-message__file-link">
                    {attachment.name}
                  </a>
                  <span className="room-chat-message__file-meta">{formatFileSize(attachment.size)}</span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="room-chat-message__actions">
          <div className="room-chat-message__reactions-picker" aria-label="Add reaction">
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={`${message.id}-${emoji}`}
                type="button"
                className="room-chat-message__reaction-btn"
                onClick={() => handleReactToMessage(message.id, emoji)}
                title={`React with ${emoji}`}
                aria-label={`React with ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>

          {isCurrentUser && !message.isDeleted && editingMessageId !== String(message.id) && (
            <div className="room-chat-message__message-tools" aria-label="Message actions">
              <button type="button" className="room-chat-message__tool-btn" onClick={() => handleMessageEditStart(message)} title="Edit message">
                <span aria-hidden="true">✏</span>
                <span>Edit</span>
              </button>
              <button type="button" className="room-chat-message__tool-btn room-chat-message__tool-btn--danger" onClick={() => handleDeleteMessage(message.id)} title="Delete message">
                <span aria-hidden="true">🗑</span>
                <span>Delete</span>
              </button>
            </div>
          )}
        </div>

        {Array.isArray(message.reactions) && message.reactions.length > 0 && (
          <div className="room-chat-message__reactions">
            {message.reactions.map((reaction) => (
              <span key={`${message.id}-${reaction.emoji}`} className="room-chat-message__reaction-pill">
                {reaction.emoji} {Array.isArray(reaction.userIds) ? reaction.userIds.length : 0}
              </span>
            ))}
          </div>
        )}
      </article>
    );
  };

  const composerNode = (
    <div className="room-chat-panel__composer">
      <div className="room-chat-panel__composer-actions">
        <button type="button" className="room-chat-panel__icon-btn" onClick={() => setIsEmojiOpen((value) => !value)} title="Emoji picker"><span className="room-chat-panel__icon-glyph"><ChatIcon /></span></button>
        <button type="button" className="room-chat-panel__icon-btn" onClick={() => fileInputRef.current?.click()} title="Attach file"><span className="room-chat-panel__icon-glyph"><AttachmentIcon /></span></button>
        <button type="button" className={`room-chat-panel__icon-btn ${composerMode === 'code' ? 'is-active' : ''}`} onClick={toggleSnippetComposer}>
          {'</>'}
        </button>
        <button type="button" className="room-chat-panel__icon-btn" onClick={handleShareSelection} title="Share selection"><span className="room-chat-panel__icon-glyph"><ShareCodeIcon /></span></button>
        {composerMode === 'code' && (
          <select
            className="room-chat-panel__language-select"
            value={snippetLanguage}
            onChange={(event) => setSnippetLanguage(normalizeSnippetLanguage(event.target.value))}
          >
            {SNIPPET_LANGUAGES.map((entry) => (
              <option key={entry.value} value={entry.value}>{entry.label}</option>
            ))}
          </select>
        )}
      </div>

      <textarea
        ref={inputRef}
        className="room-chat-panel__input"
        value={draft}
        onChange={handleDraftChange}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSend();
          }
        }}
        onFocus={markTyping}
        onBlur={emitStopTyping}
        placeholder={roomKey ? (composerMode === 'code' ? 'Write code snippet and send it to the room' : 'Send a message, mention teammates with @name, or share snippets') : 'Join a room first'}
        disabled={!roomKey || isSending}
        rows={composerMode === 'code' ? 7 : 2}
      />

      <button
        type="button"
        className="room-chat-panel__send"
        onClick={handleSend}
        disabled={!roomKey || isSending || (!draft.trim() && !attachmentDraft)}
      >
        Send
      </button>
      <button
        type="button"
        className="room-chat-panel__send room-chat-panel__send--assistant"
        onClick={handleAskAssistant}
        disabled={!draft.trim() || isAiReplying}
      >
        {isAiReplying ? 'Thinking...' : 'Ask AI'}
      </button>
    </div>
  );

  const emojiPickerNode = isEmojiOpen ? (
    <div className="room-chat-panel__emoji-picker">
      {EMOJIS.map((emoji) => (
        <button key={emoji} type="button" className="room-chat-panel__emoji-btn" onClick={() => insertTextAtCursor(emoji)}>
          {emoji}
        </button>
      ))}
    </div>
  ) : null;

  const fileInputNode = <input ref={fileInputRef} type="file" className="room-chat-panel__file-input" onChange={handleFileSelected} />;

  const attachVideoRef = (element, entry) => {
    if (element && entry.stream && element.srcObject !== entry.stream) {
      element.srcObject = entry.stream;
    }
    if (entry.isSelf && element && localVideoRef.current !== element) {
      localVideoRef.current = element;
    }
  };

  return (
    <div className="room-chat-panel">
      <div className="room-chat-panel__toolbar">
        <div className="room-chat-panel__title-group">
          <span className="room-chat-panel__title">Room Collaboration</span>
          <span className="room-chat-panel__subtitle">{roomKey ? `Room ${roomKey}` : 'Join a room to collaborate'}</span>
        </div>

        <div className="room-chat-panel__toolbar-right">
          <span className={`room-chat-panel__status ${roomKey ? 'is-live' : ''}`}>
            {roomKey ? `${roomMessages.length} messages` : 'Offline'}
          </span>
          {resolvedPanelTab === 'chat' && notificationPermission !== 'granted' && notificationPermission !== 'unsupported' && (
            <button type="button" className="room-chat-panel__notify-btn" onClick={requestNotificationPermission}>
              Enable alerts
            </button>
          )}
        </div>
      </div>

      <div className="room-chat-audio-sinks" aria-hidden="true">
        {remoteStreams.map((entry) => (
          <audio
            key={`global-audio-${entry.socketId}`}
            autoPlay
            ref={(element) => {
              if (element && entry.stream) {
                element.srcObject = entry.stream;
              }
            }}
          />
        ))}
      </div>

      {resolvedPanelTab === 'chat' && (
        <ChatPanel
          roomKey={roomKey}
          typingLabel={typingLabel}
          chatError={chatError}
          onDismissError={() => setChatError('')}
          messages={roomMessages}
          shouldShowEmptyState={shouldShowEmptyState}
          currentUserId={currentUserId}
          isOwnMessage={isOwnMessage}
          renderMessage={renderMessage}
          scrollRef={scrollRef}
          attachmentDraft={attachmentDraft}
          formatFileSize={formatFileSize}
          onRemoveAttachment={() => setAttachmentDraft(null)}
          composerNode={composerNode}
          emojiPickerNode={emojiPickerNode}
          fileInputNode={fileInputNode}
        />
      )}

      {resolvedPanelTab === 'voice' && (
        <VoicePanel
          callJoined={callJoined}
          audioEnabled={audioEnabled}
          roomUsers={collaboratorStatus}
          voiceParticipants={voiceChannelParticipants.map((participant) => ({
            ...participant,
            initials: getAvatarInitials(participant.userName),
          }))}
          chatError={chatError}
          onDismissError={() => setChatError('')}
          onJoinVoice={() => joinCall(false)}
          onLeaveCall={leaveCall}
          onToggleMute={toggleMute}
        />
      )}

      {resolvedPanelTab === 'video' && (
        <VideoPanel
          callJoined={callJoined}
          audioEnabled={audioEnabled}
          videoEnabled={videoEnabled}
          callGridParticipants={callGridParticipants}
          hasVideoTiles={hasVideoTiles}
          chatError={chatError}
          onDismissError={() => setChatError('')}
          onJoinVideo={() => joinCall(true)}
          onLeaveCall={leaveCall}
          onToggleMute={toggleMute}
          onToggleVideo={toggleVideo}
          attachVideoRef={attachVideoRef}
          getAvatarInitials={getAvatarInitials}
        />
      )}
    </div>
  );
}