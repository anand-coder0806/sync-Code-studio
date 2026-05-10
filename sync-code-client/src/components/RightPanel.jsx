import React, { useEffect, useRef, useState } from 'react';
import RoomChatPanel from './RoomChatPanel';
import '../styles/rightPanel.css';

const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 240;
const MAX_WIDTH = 300;
const WIDTH_KEY = 'syncCodeRightPanelWidth';
const OPEN_KEY = 'syncCodeRightPanelOpen';
const TAB_KEY = 'syncCodeRightPanelTab';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const TabIcon = ({ type }) => {
  if (type === 'voice') {
    return (
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="9" y="3.5" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
        <path d="M6.5 10.5a5.5 5.5 0 0 0 11 0M12 16v4M9 20h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }

  if (type === 'video') {
    return (
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="3.5" y="6.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" />
        <path d="M15.5 10.2 20.5 7.8v8.4l-5-2.4" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M5 6h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H10l-5 3v-3H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
};

export default function RightPanel({
  roomId,
  currentUserId,
  currentUserName,
  roomUsers = [],
  isRoomManager = false,
  onGetSelectedSnippet,
  onOpenSnippetInEditor,
  isFullscreen = false,
  onToggleFullscreen,
  dock = 'right',
  requestedTab = '',
  panelOpenSignal = 0,
  forceOpen,
}) {
  const [isOpen, setIsOpen] = useState(() => {
    const saved = localStorage.getItem(OPEN_KEY);
    return saved == null ? true : saved === 'true';
  });
  const [activeTab, setActiveTab] = useState(() => {
    const saved = String(localStorage.getItem(TAB_KEY) || 'chat');
    return ['chat', 'voice', 'video'].includes(saved) ? saved : 'chat';
  });
  const [panelWidth, setPanelWidth] = useState(() => {
    const parsed = Number.parseInt(localStorage.getItem(WIDTH_KEY) || `${DEFAULT_WIDTH}`, 10);
    return Number.isNaN(parsed) ? DEFAULT_WIDTH : clamp(parsed, MIN_WIDTH, MAX_WIDTH);
  });
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ x: 0, width: DEFAULT_WIDTH });

  useEffect(() => {
    localStorage.setItem(OPEN_KEY, String(isOpen));
  }, [isOpen]);

  useEffect(() => {
    localStorage.setItem(TAB_KEY, activeTab);
    if (activeTab === 'chat') {
      setChatUnreadCount(0);
    }
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(panelWidth));
  }, [panelWidth]);

  useEffect(() => {
    if (['chat', 'voice', 'video'].includes(String(requestedTab || ''))) {
      setActiveTab(String(requestedTab));
      setIsOpen(true);
    }
  }, [requestedTab]);

  useEffect(() => {
    if (panelOpenSignal > 0) {
      setIsOpen(true);
    }
  }, [panelOpenSignal]);

  useEffect(() => {
    if (typeof forceOpen === 'boolean') {
      setIsOpen(forceOpen);
    }
  }, [forceOpen]);

  useEffect(() => {
    if (isFullscreen && !isOpen) {
      setIsOpen(true);
    }
  }, [isFullscreen, isOpen]);

  useEffect(() => {
    if (!isResizing) {
      return undefined;
    }

    const onMouseMove = (event) => {
      const delta = resizeStartRef.current.x - event.clientX;
      const next = clamp(resizeStartRef.current.width + delta, MIN_WIDTH, MAX_WIDTH);
      setPanelWidth(next);
    };

    const onMouseUp = () => {
      setIsResizing(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isResizing]);

  const startResize = (event) => {
    event.preventDefault();
    resizeStartRef.current = { x: event.clientX, width: panelWidth };
    setIsResizing(true);
  };

  const tabs = [
    { id: 'chat', label: 'Chat' },
    { id: 'voice', label: 'Voice' },
    { id: 'video', label: 'Video' },
  ];

  return (
    <>
      <button
        type="button"
        className={`right-panel-toggle ${isOpen ? 'is-open' : 'is-closed'} ${isFullscreen ? 'is-hidden' : ''} ${dock === 'left' ? 'is-left' : ''}`}
        onClick={() => {
          if (isOpen && isFullscreen) {
            onToggleFullscreen?.(false);
          }
          setIsOpen((previous) => !previous);
        }}
        style={dock === 'left'
          ? { left: isOpen ? `${panelWidth}px` : '0px' }
          : { right: isOpen ? `${panelWidth}px` : '0px' }}
        aria-label={isOpen ? 'Collapse collaboration panel' : 'Open collaboration panel'}
        title={isOpen ? 'Collapse collaboration panel' : 'Open collaboration panel'}
      >
        {isOpen ? '❯' : '❮'}
      </button>

      {isOpen && (
        <aside
          className={`right-panel ${isFullscreen ? 'right-panel--fullscreen' : ''} ${dock === 'left' ? 'right-panel--left' : ''}`}
          style={{ width: isFullscreen ? '100%' : `${panelWidth}px` }}
          aria-label="Collaboration sidebar"
        >
          {!isFullscreen && (
            <div
              className={`right-panel__resize-handle ${isResizing ? 'is-resizing' : ''}`}
              onMouseDown={startResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize collaboration panel"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  setPanelWidth((previous) => clamp(previous + 20, MIN_WIDTH, MAX_WIDTH));
                }
                if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  setPanelWidth((previous) => clamp(previous - 20, MIN_WIDTH, MAX_WIDTH));
                }
              }}
            />
          )}

          <header className="right-panel__header">
            <div className="right-panel__title-wrap">
              <h3 className="right-panel__title">Copilot Collaboration</h3>
              <p className="right-panel__subtitle">Chat, voice and video</p>
            </div>
            <div className="right-panel__header-actions">
              <button
                type="button"
                className="right-panel__collapse-btn"
                onClick={() => onToggleFullscreen?.(!isFullscreen)}
                aria-label={isFullscreen ? 'Exit full page mode' : 'Expand to full page mode'}
                title={isFullscreen ? 'Exit full page' : 'Full page collaboration'}
              >
                {isFullscreen ? '⤡' : '⤢'}
              </button>
              <button
                type="button"
                className="right-panel__collapse-btn"
                onClick={() => {
                  onToggleFullscreen?.(false);
                  setIsOpen(false);
                }}
                aria-label="Collapse collaboration panel"
              >
                ×
              </button>
            </div>
          </header>

          <div className="right-panel__tabs" role="tablist" aria-label="Collaboration tabs">
            {tabs.map((tab) => {
              const active = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`right-panel__tab ${active ? 'is-active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="right-panel__tab-icon" aria-hidden="true"><TabIcon type={tab.id} /></span>
                  <span>{tab.label}</span>
                  {tab.id === 'chat' && chatUnreadCount > 0 && (
                    <span className="right-panel__badge">{chatUnreadCount}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="right-panel__content">
            <RoomChatPanel
              roomId={roomId}
              activePanelTab={activeTab}
              featureView={activeTab}
              currentUserId={currentUserId}
              currentUserName={currentUserName}
              roomUsers={roomUsers}
              isRoomManager={isRoomManager}
              onGetSelectedSnippet={onGetSelectedSnippet}
              onOpenSnippetInEditor={onOpenSnippetInEditor}
              onUnreadCountChange={setChatUnreadCount}
            />
          </div>
        </aside>
      )}
    </>
  );
}
