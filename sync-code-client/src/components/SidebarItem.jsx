import React from 'react';

export default function SidebarItem({ sectionKey, item, isActive, onSelect }) {
  return (
    <button
      type="button"
      className={`sidebar-menu-item ${isActive ? 'sidebar-menu-item--active' : ''}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect(sectionKey, item.action);
      }}
      role="menuitem"
    >
      <span className="sidebar-menu-item__label">{item.label}</span>
      {item.shortcut && <span className="sidebar-menu-item__shortcut">{item.shortcut}</span>}
    </button>
  );
}