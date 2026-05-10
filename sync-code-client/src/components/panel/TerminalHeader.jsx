import React from "react";

export default function TerminalHeader({
  cwd,
  onNewTerminal,
  onClearTerminal,
  onSplitTerminal,
}) {
  const formatPath = (path) => {
    const normalized = String(path || "").replace(/\\/g, "/");
    if (normalized.startsWith("/home/user")) {
      const rest = normalized.slice(10);
      return rest ? `~${rest}` : "~";
    }
    if (normalized.length > 40) {
      const parts = normalized.split("/").filter(Boolean);
      if (parts.length > 2) {
        return `.../${parts.slice(-2).join("/")}`;
      }
    }
    return normalized || "~";
  };

  const displayPath = formatPath(cwd || "/home/user/sync-code");

  return (
    <header className="terminal-header">
      <div className="terminal-header__path" title={`${displayPath} >`}>
        {`${displayPath} >`}
      </div>
      <div className="terminal-header__actions" aria-label="Terminal controls">
        <button type="button" className="terminal-header__btn" onClick={onNewTerminal} title="New terminal" aria-label="New terminal">+</button>
        <button type="button" className="terminal-header__btn" onClick={onClearTerminal} title="Clear terminal" aria-label="Clear terminal">Clear</button>
        <button type="button" className="terminal-header__btn" onClick={onSplitTerminal} title="Split terminal" aria-label="Split terminal">Split</button>
      </div>
    </header>
  );
}
