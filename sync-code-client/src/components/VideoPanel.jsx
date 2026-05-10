import React, { useMemo, useState } from 'react';

const CameraIcon = ({ off = false }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
    {off ? (
      <path d="M3.27 2 2 3.27l4.07 4.07H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h11.73L20.73 23 22 21.73ZM7 9.27 15.73 18H5v-8ZM21 7l-4 3.6v2.05l4-3.6V15l-3.56-3.2-1.46 1.46L21 17.73A2 2 0 0 0 23 16V8a2 2 0 0 0-2-1Z" fill="currentColor" />
    ) : (
      <path d="M17 10.5V7a2 2 0 0 0-2-2H5A2 2 0 0 0 3 7v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5L22 18V6l-5 4.5Z" fill="currentColor" />
    )}
  </svg>
);

const MicIcon = ({ muted = false }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
    {muted ? (
      <path d="M4 4.27 5.28 3 21 18.72 19.73 20l-3.2-3.2A7.89 7.89 0 0 1 12 18a8 8 0 0 1-8-8h2a6 6 0 0 0 6 6 5.9 5.9 0 0 0 3.1-.87l-1.51-1.51A3.95 3.95 0 0 1 8 10V7.27ZM12 2a4 4 0 0 1 4 4v6c0 .22-.02.43-.05.64L8.36 5.05A4 4 0 0 1 12 2Z" fill="currentColor" />
    ) : (
      <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-5a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-4.08A7 7 0 0 0 19 10Z" fill="currentColor" />
    )}
  </svg>
);

const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1-.24c1.12.37 2.33.56 3.59.56a1 1 0 0 1 1 1V21a1 1 0 0 1-1 1A17 17 0 0 1 2 5a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.26.19 2.47.56 3.59a1 1 0 0 1-.24 1.01Z" fill="currentColor" />
  </svg>
);

export default function VideoPanel({
  callJoined,
  audioEnabled,
  videoEnabled,
  callGridParticipants = [],
  hasVideoTiles,
  chatError,
  onDismissError,
  onJoinVideo,
  onLeaveCall,
  onToggleMute,
  onToggleVideo,
  attachVideoRef,
  getAvatarInitials,
}) {
  const [pinnedSocketId, setPinnedSocketId] = useState('');
  const [selfFocus, setSelfFocus] = useState(false);

  const visibleParticipants = useMemo(() => {
    if (selfFocus) {
      const self = callGridParticipants.find((entry) => entry.isSelf);
      return self ? [self] : [];
    }

    if (!pinnedSocketId) {
      return callGridParticipants;
    }

    const pinned = callGridParticipants.find((entry) => entry.socketId === pinnedSocketId);
    if (!pinned) {
      return callGridParticipants;
    }

    const rest = callGridParticipants.filter((entry) => entry.socketId !== pinnedSocketId);
    return [pinned, ...rest];
  }, [callGridParticipants, pinnedSocketId, selfFocus]);

  const speakingNames = visibleParticipants
    .filter((entry) => entry.speaking)
    .map((entry) => (entry.isSelf ? 'You' : entry.userName));
  const speakingLabel = speakingNames.length
    ? speakingNames.slice(0, 3).join(', ')
    : 'No one is speaking right now';

  const getSignalLevel = (entry) => {
    if (entry.speaking) return 'high';
    if (!entry.showVideo) return 'low';
    return 'medium';
  };

  return (
    <section className="feature-panel feature-panel--video collab-media-panel" aria-label="Video panel">
      <header className="collab-media-panel__header">
        <div>
          <p className="collab-media-panel__eyebrow">Video Call</p>
          <h3 className="collab-media-panel__title">Live Stage</h3>
        </div>
        <div className="collab-media-panel__header-meta">
          {callJoined && <span className="collab-media-panel__quality">HD Stream</span>}
          <span className={`collab-media-panel__state ${(callJoined && videoEnabled) ? 'is-live' : ''}`}>
            <span className="collab-media-panel__dot" aria-hidden="true" />
            {(callJoined && videoEnabled) ? 'Live' : 'Camera Off'}
          </span>
        </div>
      </header>

      <div className="feature-panel__controls collab-media-panel__controls">
        <button
          type="button"
          className={`collab-media-btn collab-media-btn--primary ${(callJoined && videoEnabled) ? 'is-active is-danger' : ''}`}
          onClick={!callJoined ? onJoinVideo : onToggleVideo}
        >
          <span className="collab-media-btn__icon"><CameraIcon off={callJoined && videoEnabled} /></span>
          <span>{(callJoined && videoEnabled) ? 'Stop Video' : 'Join Video'}</span>
        </button>

        <button
          type="button"
          className={`collab-media-btn collab-media-btn--ghost ${callJoined ? 'is-active' : ''}`}
          onClick={onToggleMute}
          disabled={!callJoined}
        >
          <span className="collab-media-btn__icon"><MicIcon muted={!audioEnabled} /></span>
          <span>{audioEnabled ? 'Mute' : 'Unmute'}</span>
        </button>

        <button
          type="button"
          className="collab-media-btn collab-media-btn--danger"
          onClick={onLeaveCall}
          disabled={!callJoined}
        >
          <span className="collab-media-btn__icon"><PhoneIcon /></span>
          <span>Leave Voice</span>
        </button>

        <button
          type="button"
          className={`collab-media-btn collab-media-btn--ghost ${selfFocus ? 'is-active' : ''}`}
          onClick={() => setSelfFocus((previous) => !previous)}
          disabled={!callJoined}
        >
          <span>{selfFocus ? 'Show All' : 'Self Focus'}</span>
        </button>

        <div className="collab-media-chip" aria-live="polite">
          {callJoined ? `${visibleParticipants.length || 1} participant${visibleParticipants.length === 1 ? '' : 's'}` : 'Not connected'}
        </div>
      </div>

      {chatError && (
        <div className="room-chat-panel__error">
          {chatError}
          <button type="button" onClick={onDismissError}>Dismiss</button>
        </div>
      )}

      {callJoined ? (
        <>
          <div className={`collab-media-panel__speaking-strip ${speakingNames.length ? 'is-live' : ''}`}>
            <span className="collab-media-panel__speaking-dot" aria-hidden="true" />
            <span>{speakingLabel}</span>
          </div>
          <div className="room-chat-video-grid">
          {visibleParticipants.map((entry, index) => (
            <article
              key={entry.socketId}
              className={`room-chat-video-tile ${entry.speaking ? 'is-speaking' : ''} ${entry.socketId === pinnedSocketId ? 'is-pinned' : ''}`}
              style={{ '--tile-index': index }}
            >
              {entry.showVideo ? (
                <video
                  autoPlay
                  playsInline
                  muted={entry.isSelf}
                  className="room-chat-video"
                  ref={(element) => attachVideoRef(element, entry)}
                />
              ) : (
                <div className="room-chat-video-placeholder" aria-hidden="true">
                  <span className="room-chat-video-placeholder__avatar">{getAvatarInitials(entry.userName)}</span>
                </div>
              )}
              <div className="room-chat-video-label">{entry.isSelf ? 'You' : entry.userName}</div>
              <div className="room-chat-video-actions">
                <button
                  type="button"
                  className={`room-chat-video-action ${entry.socketId === pinnedSocketId ? 'is-active' : ''}`}
                  onClick={() => setPinnedSocketId((previous) => (previous === entry.socketId ? '' : entry.socketId))}
                >
                  {entry.socketId === pinnedSocketId ? 'Unpin' : 'Pin'}
                </button>
                {entry.isSelf && (
                  <button
                    type="button"
                    className={`room-chat-video-action ${selfFocus ? 'is-active' : ''}`}
                    onClick={() => setSelfFocus((previous) => !previous)}
                  >
                    {selfFocus ? 'Exit Focus' : 'Focus'}
                  </button>
                )}
              </div>
              <span
                className={`room-chat-video-quality room-chat-video-quality--${getSignalLevel(entry)}`}
                title="Connection quality"
                aria-label="Connection quality"
              >
                <span />
                <span />
                <span />
              </span>
              {!entry.showVideo && <div className="room-chat-video-muted">Camera Off</div>}
            </article>
          ))}
          {!hasVideoTiles && visibleParticipants.length === 0 && (
            <div className="room-chat-video-empty">Join video to see participants here.</div>
          )}
          </div>
        </>
      ) : (
        <div className="collab-media-panel__empty-stage" role="status" aria-live="polite">
          <div className="collab-media-panel__empty-icon"><CameraIcon off /></div>
          <p>Video is currently inactive</p>
          <span>Click Join Video to start your camera and open the live stage.</span>
        </div>
      )}
    </section>
  );
}
