import React, { useEffect, useRef, useState } from 'react';
import { MenuContainer } from './MenuStructure';

export default function Navbar({ menus = [], onSelect }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const barRef = useRef(null);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
        return;
      }
    };

    const handleMouseDown = (event) => {
      if (barRef.current && !barRef.current.contains(event.target)) {
        setIsMenuOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, []);

  const handleMenuItemClick = async (menuKey, action) => {
    try {
      await onSelect(menuKey, action);
    } finally {
      setIsMenuOpen(false);
    }
  };

  return (
    <nav ref={barRef} className="menu-bar" aria-label="Sync Code menu bar">
      <MenuContainer
        isOpen={isMenuOpen}
        onToggle={() => setIsMenuOpen((previous) => !previous)}
        sections={menus}
        onItemClick={handleMenuItemClick}
      />
    </nav>
  );
}
