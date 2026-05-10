import React from 'react';

export function MenuItem({ menuKey, item, onItemClick }) {
  return (
    <button
      type="button"
      className="menu-item"
      role="menuitem"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onItemClick(menuKey, item.action);
      }}
    >
      <span className="menu-item-label">{item.label}</span>
      {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
    </button>
  );
}

export function MenuSection({ section, onItemClick }) {
  return (
    <section className="menu-section-group" aria-label={section.label}>
      <div className="menu-section-heading">
        <span className="menu-section-icon" aria-hidden="true">{section.icon || '•'}</span>
        <span className="menu-section-title">{section.label}</span>
      </div>
      <div className="menu-section-items">
        {section.items.map((item) => (
          <MenuItem key={`${section.key}-${item.action}`} menuKey={section.key} item={item} onItemClick={onItemClick} />
        ))}
      </div>
    </section>
  );
}

export function MenuContainer({ isOpen, onToggle, sections = [], onItemClick }) {
  return (
    <div className="menu-container">
      <button
        type="button"
        className={`menu-trigger menu-trigger--hamburger ${isOpen ? 'menu-trigger--active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span className="menu-trigger-icon" aria-hidden="true">☰</span>
        <span className="menu-trigger-label">Menu</span>
      </button>

      {isOpen && (
        <div className="menu-dropdown menu-dropdown--single" role="menu" aria-label="Sync Code main menu">
          {sections.map((section) => (
            <MenuSection key={section.key} section={section} onItemClick={onItemClick} />
          ))}
        </div>
      )}
    </div>
  );
}