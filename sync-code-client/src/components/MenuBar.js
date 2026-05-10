import React, { useEffect, useMemo, useRef, useState } from 'react';

export default function MenuBar({ menus = [], onSelect }) {
  const [openMenu, setOpenMenu] = useState(null);
  const barRef = useRef(null);
  const menuButtonRefs = useRef({});
  const menuOrder = useMemo(() => menus.map((menu) => menu.key), [menus]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpenMenu(null);
        return;
      }

      if (!openMenu || menuOrder.length === 0) {
        return;
      }

      const currentIndex = menuOrder.indexOf(openMenu);
      if (currentIndex === -1) {
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        const nextIndex = (currentIndex + 1) % menuOrder.length;
        const nextKey = menuOrder[nextIndex];
        setOpenMenu(nextKey);
        menuButtonRefs.current[nextKey]?.focus();
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        const nextIndex = (currentIndex - 1 + menuOrder.length) % menuOrder.length;
        const nextKey = menuOrder[nextIndex];
        setOpenMenu(nextKey);
        menuButtonRefs.current[nextKey]?.focus();
      }
    };

    const handleMouseDown = (event) => {
      if (barRef.current && !barRef.current.contains(event.target)) {
        setOpenMenu(null);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [menuOrder, openMenu]);

  const handleMenuClick = (menuKey) => {
    setOpenMenu((previous) => (previous === menuKey ? null : menuKey));
  };

  const handleMenuItemClick = (menuKey, action) => {
    setOpenMenu(null);
    onSelect(menuKey, action);
  };

  const handleMenuMouseEnter = (menuKey) => {
    if (openMenu && openMenu !== menuKey) setOpenMenu(menuKey);
  };

  return (
    <nav ref={barRef} className="menu-bar" aria-label="Sync Code menu bar">
      {menus.map((menu) => (
        <div
          key={menu.key}
          className="menu-section"
          onMouseEnter={() => handleMenuMouseEnter(menu.key)}
        >
          <button
            type="button"
            className={`menu-trigger ${openMenu === menu.key ? 'menu-trigger--active' : ''}`}
            onClick={() => handleMenuClick(menu.key)}
            ref={(element) => {
              menuButtonRefs.current[menu.key] = element;
            }}
            aria-haspopup="menu"
            aria-expanded={openMenu === menu.key}
          >
            {menu.label}
          </button>

          {openMenu === menu.key && (
            <div className="menu-dropdown" role="menu">
              {menu.items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => handleMenuItemClick(menu.key, item.action)}
                >
                  <span className="menu-item-label">{item.label}</span>
                  {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
