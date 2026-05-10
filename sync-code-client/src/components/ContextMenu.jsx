import React, { useLayoutEffect, useRef, useState } from 'react';

export default function ContextMenu({ x, y, options, onClose }) {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const edgeGap = 8;
    const menuEl = menuRef.current;
    if (!menuEl) {
      setPosition({ left: x, top: y });
      return;
    }

    const rect = menuEl.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - edgeGap;
    const maxTop = window.innerHeight - rect.height - edgeGap;

    const clampedLeft = Math.max(edgeGap, Math.min(Number(x) || edgeGap, maxLeft));
    const clampedTop = Math.max(edgeGap, Math.min(Number(y) || edgeGap, maxTop));
    setPosition({ left: clampedLeft, top: clampedTop });
  }, [x, y, options]);

  return (
    <div className="explorer-context-backdrop" onClick={onClose} role="presentation">
      <div
        ref={menuRef}
        className="explorer-context-menu"
        style={{ left: position.left, top: position.top }}
        role="menu"
        onClick={(event) => event.stopPropagation()}
      >
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`explorer-context-item ${option.id === 'delete' ? 'explorer-context-item--danger' : ''}`}
            role="menuitem"
            onClick={() => {
              console.log(`[explorer context] ${option.id}`);
              option.onClick();
              onClose();
            }}
            disabled={option.disabled}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
