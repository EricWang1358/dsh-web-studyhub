import React from 'react';
import { Menu } from '../components/index.js';
import BIcon from './icons.jsx';

/* The board's ⋯ menu is components/Menu; this only draws the board's icon names with the board icon set. */
export default function BoardMenu({ items, icon = 'more', ...props }) {
  return <Menu {...props} icon={<BIcon name={icon} size={18} />}
    items={items.map(item => typeof item.icon === 'string' ? { ...item, icon: <BIcon name={item.icon} /> } : item)} />;
}
