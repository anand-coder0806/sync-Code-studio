import React, { forwardRef } from 'react';

const MenuToggle = forwardRef(function MenuToggle({ isOpen, onToggle, label = 'Menu' }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`menu-toggle ${isOpen ? 'menu-toggle--open' : ''}`}
      onClick={onToggle}
      aria-haspopup="menu"
      aria-expanded={isOpen}
      aria-label={label}
      title={label}
    >
      <span className="menu-toggle__icon" aria-hidden="true">☰</span>
    </button>
  );
});

export default MenuToggle;