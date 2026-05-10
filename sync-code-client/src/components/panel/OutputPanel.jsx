import React from 'react';

const toneClassByType = {
  success: 'output-row--success',
  stderr: 'output-row--error',
  warning: 'output-row--warning',
  info: 'output-row--info',
  stdout: 'output-row--default',
  system: 'output-row--info',
  prompt: 'output-row--default',
};

export default function OutputPanel({ entries = [], onClear }) {
  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(String(text || ''));
    } catch (error) {
      console.error('Copy failed:', error);
    }
  };

  return (
    <section className="panel-content panel-content--output">
      <div className="output-toolbar">
        <span className="output-toolbar__title">OUTPUT</span>
        <button type="button" className="output-toolbar__clear" onClick={onClear}>Clear all</button>
      </div>
      <div className="output-list" role="log" aria-live="polite">
        {entries.length === 0 && <div className="output-empty">No output yet.</div>}
        {entries.map((entry) => {
          const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
          const toneClass = toneClassByType[entry.type] || 'output-row--default';
          return (
            <div className={`output-row ${toneClass}`} key={entry.id}>
              <span className="output-row__time">{timestamp}</span>
              <span className="output-row__text">{entry.text}</span>
              <button
                type="button"
                className="output-row__copy"
                onClick={() => handleCopy(entry.text)}
                title="Copy line"
                aria-label="Copy output line"
              >
                Copy
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
