import React from 'react';

const MicIcon = ({ muted = false }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
    {muted ? (
      <path
        d="M4 4.27 5.28 3 21 18.72 19.73 20l-3.2-3.2A7.89 7.89 0 0 1 12 18a8 8 0 0 1-8-8h2a6 6 0 0 0 6 6 5.9 5.9 0 0 0 3.1-.87l-1.51-1.51A3.95 3.95 0 0 1 8 10V7.27ZM12 2a4 4 0 0 1 4 4v6c0 .22-.02.43-.05.64L8.36 5.05A4 4 0 0 1 12 2Z"
        fill="currentColor"
      />
    ) : (
      <path
        d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-5a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-4.08A7 7 0 0 0 19 10Z"
        fill="currentColor"
      />
    )}
  </svg>
);

const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1-.24c1.12.37 2.33.56 3.59.56a1 1 0 0 1 1 1V21a1 1 0 0 1-1 1A17 17 0 0 1 2 5a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.26.19 2.47.56 3.59a1 1 0 0 1-.24 1.01Z" fill="currentColor" />
  </svg>
);

export default function VoicePanel({
  callJoined,
  audioEnabled,
  roomUsers = [],
  voiceParticipants = [],
  chatError,
  onDismissError,
  onJoinVoice,
  onLeaveCall,
  onToggleMute,
}) {
  const activeParticipants = voiceParticipants.length;
  const getSignalLevel = (participant) => {
    if (participant.speaking) return 'high';
    if (participant.muted) return 'low';
    return 'medium';
  };

  return (
    <section className="feature-panel feature-panel--voice collab-media-panel" aria-label="Voice panel">
      <header className="collab-media-panel__header">
        <div>
          <p className="collab-media-panel__eyebrow">Voice Channel</p>
          <h3 className="collab-media-panel__title">Team Voice</h3>
        </div>
        <div className="collab-media-panel__header-meta">
          {callJoined && <span className="collab-media-panel__quality">RTC Stable</span>}
          <span className={`collab-media-panel__state ${callJoined ? 'is-live' : ''}`}>
            <span className="collab-media-panel__dot" aria-hidden="true" />
            {callJoined ? 'Connected' : 'Offline'}
          </span>
        </div>
      </header>

      <div className="feature-panel__controls collab-media-panel__controls">
        <button
          type="button"
          className={`collab-media-btn collab-media-btn--primary ${callJoined ? 'is-active is-danger' : ''}`}
          onClick={callJoined ? onLeaveCall : onJoinVoice}
        >
          <span className="collab-media-btn__icon"><PhoneIcon /></span>
          <span>{callJoined ? 'Leave Voice' : 'Join Voice'}</span>
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

        <div className="collab-media-chip" aria-live="polite">
          {callJoined ? `${activeParticipants || 1} live` : 'Not connected'}
        </div>
      </div>

      {chatError && (
        <div className="room-chat-panel__error">
          {chatError}
          <button type="button" onClick={onDismissError}>Dismiss</button>
        </div>
      )}

      <div className="collab-media-banner" role="status" aria-live="polite">
        <span className={`collab-media-banner__badge ${callJoined ? 'is-live' : ''}`}>
          <MicIcon muted={!audioEnabled} />
          {callJoined ? (audioEnabled ? 'Live - Mic On' : 'Live - Muted') : 'Voice Inactive'}
        </span>
      </div>

      <div className="room-chat-presence">
        {roomUsers.map((member) => (
          <div key={member.userId} className={`room-chat-presence__item ${member.speaking ? 'is-speaking' : ''}`}>
            <span className="room-chat-presence__name">{member.userName}</span>
            <span className="room-chat-presence__state">{member.online !== false ? 'online' : 'offline'}</span>
            {member.inCall && <span className="room-chat-presence__badge">in call</span>}
            {member.speaking && <span className="room-chat-presence__badge">speaking</span>}
          </div>
        ))}
      </div>

      {callJoined && voiceParticipants.length > 0 && (
        <div className="room-chat-voice-channel">
          <div className="room-chat-voice-channel__title">Voice Channel</div>
          <div className="room-chat-voice-channel__list">
            {voiceParticipants.map((participant) => (
              <div key={participant.socketId} className={`room-chat-voice-user ${participant.speaking ? 'is-speaking' : ''}`}>
                <div className="room-chat-voice-user__avatar" aria-hidden="true">{participant.initials}</div>
                <div className="room-chat-voice-user__meta">
                  <span className="room-chat-voice-user__name">{participant.isSelf ? 'You' : participant.userName}</span>
                  <span className="room-chat-voice-user__state">{participant.muted ? 'Muted' : participant.speaking ? 'Speaking' : 'Listening'}</span>
                </div>
                {participant.speaking && (
                  <span className="room-chat-voice-user__wave" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                )}
                <span className={`room-chat-voice-user__signal ${participant.speaking ? 'is-active' : ''}`} aria-hidden="true" />
                <span
                  className={`room-chat-voice-user__quality room-chat-voice-user__quality--${getSignalLevel(participant)}`}
                  title="Connection quality"
                  aria-label="Connection quality"
                >
                  <span />
                  <span />
                  <span />
                </span>
                {participant.muted && <span className="room-chat-voice-user__badge">Muted</span>}
                {participant.speaking && <span className="room-chat-voice-user__badge room-chat-voice-user__badge--speaking">Speaking</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
