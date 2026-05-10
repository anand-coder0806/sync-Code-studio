import React from 'react';
import SidebarItem from './SidebarItem';

export default function Sidebar({
  isOpen,
  sections = [],
  activeSection = '',
  activeItemKey = '',
  onActivateSection,
  onSelectItem,
  onClose,
}) {
  if (!isOpen) {
    return null;
  }

  const primaryOrder = ['file', 'edit', 'view', 'run', 'terminal'];
  const visibleSections = primaryOrder
    .map((key) => sections.find((section) => section.key === key))
    .filter(Boolean);

  return (
    <aside className="left-sidebar-drawer" aria-label="Main menu sidebar">
      <div className="left-sidebar-drawer__body" role="menu" aria-label="Sidebar menu sections">
        <div className="sidebar-flyout-nav">
          {visibleSections.map((section) => {
            const isActive = activeSection === section.key;
            const compactLabel = section.key === 'terminal' ? 'Term' : section.label;
            return (
              <div
                key={section.key}
                className={`sidebar-flyout-entry ${isActive ? 'is-active' : ''}`}
                onMouseEnter={() => onActivateSection?.(section.key)}
              >
                <button
                  type="button"
                  className="sidebar-flyout-entry__button"
                  onClick={() => onActivateSection?.(section.key)}
                  title={section.label}
                >
                  <span className="sidebar-flyout-entry__label">{compactLabel}</span>
                </button>

                {isActive && (
                  <div className="sidebar-flyout-panel" role="menu" aria-label={`${section.label} options`}>
                    {section.items.map((item) => (
                      <SidebarItem
                        key={`${section.key}-${item.action}`}
                        sectionKey={section.key}
                        item={item}
                        isActive={activeItemKey === `${section.key}.${item.action}`}
                        onSelect={onSelectItem}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}