import React, { useMemo, useState } from 'react';

export default function ProblemsPanel({ entries = [] }) {
  const groupedProblems = useMemo(() => {
    return entries.reduce((accumulator, entry) => {
      const source = String(entry.text || '');
      const fileMatch = source.match(/([\w./-]+\.[a-zA-Z0-9]+)(?::(\d+))?/);
      const file = fileMatch?.[1] || 'Unknown file';
      const line = Number.parseInt(fileMatch?.[2] || '1', 10);
      const list = accumulator[file] || [];
      list.push({ ...entry, line });
      accumulator[file] = list;
      return accumulator;
    }, {});
  }, [entries]);

  const [expandedFiles, setExpandedFiles] = useState(() => new Set(Object.keys(groupedProblems)));
  const files = Object.keys(groupedProblems);

  const toggleFile = (file) => {
    setExpandedFiles((previous) => {
      const next = new Set(previous);
      if (next.has(file)) {
        next.delete(file);
      } else {
        next.add(file);
      }
      return next;
    });
  };

  const navigateToProblem = (file, line) => {
    window.dispatchEvent(new CustomEvent('sync-code:problem-click', {
      detail: { file, line },
    }));
  };

  return (
    <section className="panel-content panel-content--problems">
      <div className="problems-toolbar">
        <span className="problems-toolbar__title">PROBLEMS</span>
        <span className="problems-toolbar__count">{entries.length}</span>
      </div>

      <div className="problems-list" role="tree" aria-label="Problems list">
        {files.length === 0 && <div className="output-empty">No problems detected.</div>}

        {files.map((file) => {
          const fileProblems = groupedProblems[file] || [];
          const expanded = expandedFiles.has(file);
          return (
            <div className="problem-group" key={file}>
              <button
                type="button"
                className="problem-group__header"
                onClick={() => toggleFile(file)}
                aria-expanded={expanded}
              >
                <span className="problem-group__arrow">{expanded ? '▾' : '▸'}</span>
                <span className="problem-group__file">{file}</span>
                <span className="problem-group__count">{fileProblems.length}</span>
              </button>

              {expanded && (
                <div className="problem-group__items" role="group">
                  {fileProblems.map((problem) => (
                    <button
                      type="button"
                      key={problem.id}
                      className="problem-item"
                      onClick={() => navigateToProblem(file, problem.line)}
                      title={`Go to ${file}:${problem.line}`}
                    >
                      <span className="problem-item__line">Ln {problem.line}</span>
                      <span className="problem-item__message">{problem.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
