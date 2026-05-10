import React from 'react';

export default function ChatPanel({
  roomKey,
  typingLabel,
  chatError,
  onDismissError,
  messages,
  shouldShowEmptyState,
  currentUserId,
  isOwnMessage,
  renderMessage,
  scrollRef,
  attachmentDraft,
  formatFileSize,
  onRemoveAttachment,
  composerNode,
  emojiPickerNode,
  fileInputNode,
}) {
  return (
    <section className="feature-panel feature-panel--chat" aria-label="Chat panel">
      {chatError && (
        <div className="room-chat-panel__error">
          {chatError}
          <button type="button" onClick={onDismissError}>Dismiss</button>
        </div>
      )}

      {typingLabel && <div className="room-chat-panel__typing">{typingLabel}</div>}

      <div className="room-chat-panel__messages" ref={scrollRef}>
        {!roomKey && <div className="room-chat-panel__empty">Join a room to start chatting.</div>}
        {roomKey && shouldShowEmptyState && <div className="room-chat-panel__empty">No messages yet. Start the conversation.</div>}

        {messages.map((message) => renderMessage(
          message,
          typeof isOwnMessage === 'function'
            ? isOwnMessage(message)
            : Boolean(currentUserId && message.senderId && String(message.senderId) === String(currentUserId)),
        ))}
      </div>

      {attachmentDraft && (
        <div className="room-chat-panel__attachment-draft">
          <span>{attachmentDraft.name}</span>
          <span>{formatFileSize(attachmentDraft.size)}</span>
          <button type="button" onClick={onRemoveAttachment}>Remove</button>
        </div>
      )}

      {composerNode}
      {emojiPickerNode}
      {fileInputNode}
    </section>
  );
}
