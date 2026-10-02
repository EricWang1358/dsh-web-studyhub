import React, { useEffect, useRef } from 'react';
import { ui } from '../../i18n.js';

/** The outline (目录): one button per heading, page or part; the current one is marked. */
export default function OutlinePanel({ items, activeId, onJump, labelOf = () => '', id, className = '', ...rest }) {
  const list = useRef(null);
  // Keep the current entry visible inside the panel without scrolling anything around it.
  useEffect(() => {
    const panel = list.current, current = panel?.querySelector('[aria-current="location"]');
    if (!panel || !current) return;
    const box = panel.getBoundingClientRect(), rect = current.getBoundingClientRect();
    if (rect.top < box.top + 8) panel.scrollTop -= box.top + 8 - rect.top;
    else if (rect.bottom > box.bottom - 8) panel.scrollTop += rect.bottom - box.bottom + 8;
  }, [activeId, items]);
  return <nav id={id} className={`reader-outline ${className}`.trim()} aria-label={ui('目录')} {...rest}>
    <h3 className="reader-panel__title">{ui('目录')}</h3>
    <div className="reader-outline__scroll" ref={list}>
      <ol>
        {items.map(item => {
          const label = labelOf(item);
          return <li key={item.id} data-level={Math.min(item.level || 1, 4)}>
            <button type="button" aria-current={item.id === activeId ? 'location' : undefined}
              title={[label, item.title].filter(Boolean).join(' · ')} onClick={() => onJump(item)}>
              {label && <span className="reader-outline__label">{label}</span>}
              {item.title && <span className="reader-outline__title">{item.title}</span>}
            </button>
          </li>;
        })}
      </ol>
    </div>
  </nav>;
}
