import React from 'react';

export default function Dropdown({ menuKey, items, onItemClick }) {
  return (
    <div className="menu-dropdown" role="menu" aria-label={`${menuKey} menu`}>
      {items.map((item) => (
        <button
          key={`${menuKey}-${item.action}`}
          type="button"
          className="menu-item"
          role="menuitem"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            console.log(`[menu click] ${menuKey}.${item.action}`);
            onItemClick(menuKey, item.action);
          }}
        >
          <span className="menu-item-label">{item.label}</span>
          {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}
