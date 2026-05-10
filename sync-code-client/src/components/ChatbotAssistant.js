import React, { useMemo, useState } from 'react';

const initialMessages = [
  {
    id: 'welcome',
    role: 'bot',
    text: 'Hi, I am Sync Assistant. Ask me about this project or use quick actions below.',
    suggestions: [
      { label: 'Workspace status', action: 'prompt-status' },
      { label: 'How do I run code?', action: 'prompt-run' },
      { label: 'Open a file', action: 'openFile' },
    ],
  },
];

export default function ChatbotAssistant({ requestReply, onAction, isReadOnlyMode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState(initialMessages);
  const [isSending, setIsSending] = useState(false);

  const quickPrompts = useMemo(
    () => [
      { label: 'Workspace status', value: 'Show workspace status' },
      { label: 'Run help', value: 'How do I run this file?' },
      { label: 'Save help', value: 'How do I save all changes?' },
    ],
    []
  );

  const appendMessage = (message) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `${message.role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ...message,
      },
    ]);
  };

  const runSuggestionAction = async (action) => {
    if (!action) {
      return;
    }

    if (action === 'prompt-status') {
      await handleSend('Show workspace status');
      return;
    }

    if (action === 'prompt-run') {
      await handleSend('How do I run code?');
      return;
    }

    if (typeof onAction === 'function') {
      onAction(action);
      appendMessage({ role: 'bot', text: `Action triggered: ${action}` });
    }
  };

  const handleSend = async (forcedText) => {
    const text = (forcedText ?? input).trim();
    if (!text || isSending) {
      return;
    }

    if (!forcedText) {
      setInput('');
    }

    appendMessage({ role: 'user', text });
    setIsSending(true);

    try {
      const payload = await requestReply(text);
      appendMessage({
        role: 'bot',
        text: payload?.reply || 'I could not generate a response right now.',
        suggestions: Array.isArray(payload?.suggestions) ? payload.suggestions : [],
      });
    } catch (error) {
      appendMessage({
        role: 'bot',
        text: 'Chat service is currently unavailable. You can still use quick actions.',
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="chatbot-root" aria-live="polite">
      {isOpen && (
        <section className="chatbot-panel" aria-label="Sync chatbot assistant">
          <header className="chatbot-header">
            <div className="chatbot-header__text">
              <h3 className="chatbot-title">Sync Assistant</h3>
              <p className="chatbot-subtitle">{isReadOnlyMode ? 'Read-only mode detected' : 'Ready to help'}</p>
            </div>
            <button type="button" onClick={() => setIsOpen(false)} className="chatbot-close" aria-label="Close assistant">
              <span aria-hidden="true">×</span>
            </button>
          </header>

          <div className="chatbot-messages">
            {messages.map((message) => (
              <div key={message.id} className={`chatbot-message chatbot-message--${message.role}`}>
                <p className="chatbot-message__text">{message.text}</p>
                {Array.isArray(message.suggestions) && message.suggestions.length > 0 && (
                  <div className="chatbot-suggestions">
                    {message.suggestions.map((suggestion) => (
                      <button
                        key={`${message.id}-${suggestion.label}-${suggestion.action}`}
                        type="button"
                        className="chatbot-suggestion"
                        onClick={() => runSuggestionAction(suggestion.action)}
                      >
                        {suggestion.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="chatbot-prompts">
            {quickPrompts.map((prompt) => (
              <button
                key={prompt.label}
                type="button"
                className="chatbot-prompt"
                onClick={() => handleSend(prompt.value)}
              >
                {prompt.label}
              </button>
            ))}
          </div>

          <form
            className="chatbot-input-row"
            onSubmit={(event) => {
              event.preventDefault();
              handleSend();
            }}
          >
            <input
              className="chatbot-input"
              type="text"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask about files, run, save, or terminal"
              disabled={isSending}
            />
            <button className="chatbot-send" type="submit" disabled={isSending || !input.trim()}>
              {isSending ? '...' : 'Send'}
            </button>
          </form>
        </section>
      )}

      <button
        type="button"
        className={`chatbot-toggle ${isOpen ? 'chatbot-toggle--open' : ''}`}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
      >
        {isOpen ? 'Close Chat' : 'Chatbot'}
      </button>
    </div>
  );
}
