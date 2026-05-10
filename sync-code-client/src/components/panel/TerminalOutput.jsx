import React, { useEffect, useRef } from 'react';

function TerminalStream({ lines = [] }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);

  return (
    <div className="terminal-output__scroll" ref={scrollRef}>
      {lines.map((line) => (
        <div key={line.id} className={`terminal-line terminal-line--${line.type || 'stdout'}`}>
          {line.text}
        </div>
      ))}
    </div>
  );
}

export default function TerminalOutput({
  activeLines = [],
  splitLines = [],
  isSplit = false,
}) {
  return (
    <div className={`terminal-output ${isSplit ? 'terminal-output--split' : ''}`}>
      <div className="terminal-output__pane">
        <TerminalStream lines={activeLines} />
      </div>
      {isSplit && (
        <div className="terminal-output__pane">
          <TerminalStream lines={splitLines} />
        </div>
      )}
    </div>
  );
}
