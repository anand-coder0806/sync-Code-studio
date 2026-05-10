import React, { forwardRef, useMemo } from 'react';

const PRIMARY_ORDER = ['file', 'edit', 'view', 'terminal', 'help'];

const getItemTitle = (item) => item.title || item.label || '';

const getItemChildren = (item) => (Array.isArray(item.children) ? item.children : Array.isArray(item.items) ? item.items : []);

function MenuLeafItem({ sectionKey, item, isActive, onSelect }) {
  return (
    <button
      type="button"
      className={`menu-popup-item ${isActive ? 'menu-popup-item--active' : ''}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect(sectionKey, item.action, item);
      }}
      role="menuitem"
    >
      <span className="menu-popup-item__label">{getItemTitle(item)}</span>
      {item.shortcut && <span className="menu-popup-item__shortcut">{item.shortcut}</span>}
    </button>
  );
}

function MenuBranchItem({ sectionKey, item, depth, path, activePath, onHoverPath, onSelect }) {
  const title = getItemTitle(item);
  const children = getItemChildren(item);
  const nextPath = [...path, title];
  const isActive = activePath[depth] === title;

  return (
    <div
      className={`menu-popup-node ${isActive ? 'menu-popup-node--active' : ''}`}
      onMouseEnter={() => {
        onHoverPath(nextPath);
      }}
    >
      <button
        type="button"
        className={`menu-popup-entry__button ${isActive ? 'menu-popup-entry__button--active' : ''}`}
        onClick={() => {
          if (children.length > 0) {
            onHoverPath(nextPath);
          }
        }}
        role="menuitem"
        aria-haspopup={children.length > 0 ? 'menu' : undefined}
        aria-expanded={children.length > 0 ? isActive : undefined}
      >
        <span className="menu-popup-entry__label">{title}</span>
        {children.length > 0 ? <span className="menu-popup-entry__arrow" aria-hidden="true">▶</span> : null}
      </button>

      {children.length > 0 && isActive && (
        <MenuSubMenu
          sectionKey={sectionKey}
          items={children}
          depth={depth + 1}
          path={nextPath}
          activePath={activePath}
          onHoverPath={onHoverPath}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

function MenuSubMenu({ sectionKey, items, depth, path, activePath, onHoverPath, onSelect, isRoot = false }) {
  return (
    <div className={`menu-popup-flyout ${isRoot ? 'menu-popup-flyout--root' : ''}`} role="menu" aria-label="submenu">
      {items.map((item) => {
        const title = getItemTitle(item);
        const children = getItemChildren(item);
        const isActive = activePath[depth] === title;

        if (children.length > 0) {
          return (
            <MenuBranchItem
              key={`${path.join('.')}.${title}`}
              sectionKey={sectionKey}
              item={item}
              depth={depth}
              path={path}
              activePath={activePath}
              onHoverPath={onHoverPath}
              onSelect={onSelect}
            />
          );
        }

        return (
          <MenuLeafItem
            key={`${path.join('.')}.${title}`}
            sectionKey={sectionKey}
            item={item}
            isActive={isActive}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
}

const MenuPopup = forwardRef(function MenuPopup(
  {
    isOpen,
    sections = [],
    activePath = [],
    onToggle,
    onHoverPath,
    onSelectItem,
    onClose,
    statusText = 'Backend checking...',
  },
  ref,
) {
  const visibleSections = useMemo(
    () => PRIMARY_ORDER.map((key) => sections.find((section) => section.key === key)).filter(Boolean),
    [sections],
  );

  const activeRoot = activePath[0] || '';

  const handleRootClick = (sectionLabel) => {
    const isAlreadyActive = activeRoot === sectionLabel;
    if (isOpen && isAlreadyActive) {
      onClose?.();
      return;
    }

    if (!isOpen) {
      onToggle?.();
    }
    onHoverPath?.([sectionLabel]);
  };

  return (
    <div
      ref={ref}
      className="menu-topbar"
      role="menubar"
      aria-label="Main menu"
    >
      <div className="menu-topbar__left">
        {visibleSections.map((section) => {
          const isActive = activeRoot === section.label;
          const children = getItemChildren(section);
          return (
            <div
              key={section.key}
              className={`menu-popup-entry ${isActive ? 'menu-popup-entry--active' : ''}`}
              onMouseEnter={() => {
                if (isOpen) {
                  onHoverPath?.([section.label]);
                }
              }}
            >
              <button
                type="button"
                className={`menu-popup-entry__button ${isActive && isOpen ? 'menu-popup-entry__button--active' : ''}`}
                onClick={() => handleRootClick(section.label)}
                role="menuitem"
                aria-haspopup={children.length > 0 ? 'menu' : undefined}
                aria-expanded={children.length > 0 ? (isOpen && isActive) : undefined}
              >
                <span className="menu-popup-entry__label">{section.label}</span>
              </button>

              {isOpen && isActive && children.length > 0 && (
                <div className="menu-popup" role="menu" aria-label={`${section.label} menu`}>
                  <MenuSubMenu
                    sectionKey={section.key}
                    items={children}
                    depth={1}
                    path={[section.label]}
                    activePath={activePath}
                    onHoverPath={onHoverPath}
                    onSelect={onSelectItem}
                    isRoot
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="menu-topbar__right" aria-live="polite">
        <span className="menu-topbar-status">{statusText}</span>
      </div>
    </div>
  );
});

export default MenuPopup;
