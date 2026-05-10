import React, { useEffect, useMemo, useRef } from 'react';

const lineClassByType = {
  stdout: 'output-line output-line--stdout',
  stderr: 'output-line output-line--stderr',
  info: 'output-line output-line--info',
  success: 'output-line output-line--success',
  system: 'output-line output-line--system',
};

export default function OutputPanel({
  mode = 'output',
  outputEntries = [],
  problemEntries = [],
  onClear,
}) {
  const containerRef = useRef(null);
  const entries = useMemo(() => (mode === 'problems' ? problemEntries : outputEntries), [mode, outputEntries, problemEntries]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div className="output-panel-root">
      <div className="output-panel-toolbar">
        <span className="output-panel-title">{mode === 'problems' ? 'Problems' : 'Output'}</span>
        <button type="button" className="output-clear-btn" onClick={onClear}>Clear</button>
      </div>

      <div className="output-panel-scroll" ref={containerRef}>
        {entries.length === 0 && (
          <div className="output-empty">No {mode} messages yet.</div>
        )}

        {entries.map((entry) => {
          const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
          const lineClass = lineClassByType[entry.type] || 'output-line output-line--info';
          return (
            <div key={entry.id} className={lineClass}>
              <span className="output-time">{timestamp}</span>
              <span className="output-text">{entry.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
