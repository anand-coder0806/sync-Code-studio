import React, { useState } from 'react';

export default function PanelTabs({
  tabs = [],
  activeTab,
  onChange,
  onAdd,
  onClose,
  onRename,
  showAdd = false,
  closable = false,
  className = '',
}) {
  const [editingTabId, setEditingTabId] = useState(null);
  const [editingValue, setEditingValue] = useState('');

  const beginRename = (tab) => {
    if (!onRename) {
      return;
    }
    setEditingTabId(tab.id);
    setEditingValue(tab.label || '');
  };

  const commitRename = () => {
    if (!editingTabId || !onRename) {
      setEditingTabId(null);
      setEditingValue('');
      return;
    }

    const nextLabel = String(editingValue || '').trim();
    if (nextLabel) {
      onRename(editingTabId, nextLabel);
    }

    setEditingTabId(null);
    setEditingValue('');
  };

  return (
    <div className={`panel-tabs ${className}`.trim()} role="tablist" aria-label="Panel tabs">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const isEditing = editingTabId === tab.id;

        return (
          <div key={tab.id} className={`panel-tab-wrap ${isActive ? 'is-active' : ''}`}>
            {isEditing ? (
              <input
                className="panel-tab-rename"
                value={editingValue}
                onChange={(event) => setEditingValue(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    commitRename();
                  }
                  if (event.key === 'Escape') {
                    setEditingTabId(null);
                    setEditingValue('');
                  }
                }}
                autoFocus
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`panel-tab ${isActive ? 'panel-tab--active' : ''}`}
                onClick={() => onChange?.(tab.id)}
                onDoubleClick={() => beginRename(tab)}
                title={tab.label}
              >
                <span className="panel-tab-label">{tab.label}</span>
              </button>
            )}

            {closable && onClose && tabs.length > 1 && (
              <button
                type="button"
                className="panel-tab-close"
                aria-label={`Close ${tab.label}`}
                onClick={() => onClose(tab.id)}
              >
                ×
              </button>
            )}
          </div>
        );
      })}

      {showAdd && onAdd && (
        <button
          type="button"
          className="panel-tab-add"
          aria-label="Add terminal"
          onClick={onAdd}
          title="New terminal"
        >
          +
        </button>
      )}
    </div>
  );
}
