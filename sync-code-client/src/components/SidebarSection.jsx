import React from 'react';
import SidebarItem from './SidebarItem';

export default function SidebarSection({ section, isExpanded, isActive, activeItemKey, onToggle, onSelect }) {
  return (
    <section className={`sidebar-menu-section ${isExpanded ? 'sidebar-menu-section--expanded' : ''} ${isActive ? 'sidebar-menu-section--active' : ''}`}>
      <button
        type="button"
        className="sidebar-menu-section__header"
        onClick={() => onToggle(section.key)}
        aria-expanded={isExpanded}
        aria-controls={`sidebar-menu-${section.key}`}
      >
        <span className="sidebar-menu-section__icon" aria-hidden="true">{section.icon || '•'}</span>
        <span className="sidebar-menu-section__label">{section.label}</span>
        <span className="sidebar-menu-section__chevron" aria-hidden="true">{isExpanded ? '▼' : '▶'}</span>
      </button>

      <div
        id={`sidebar-menu-${section.key}`}
        className={`sidebar-menu-section__body ${isExpanded ? 'sidebar-menu-section__body--expanded' : ''}`}
      >
        {section.items.map((item) => (
          <SidebarItem
            key={`${section.key}-${item.action}`}
            sectionKey={section.key}
            item={item}
            isActive={activeItemKey === `${section.key}.${item.action}`}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}