import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { DisclosureToggle, Icon } from '../../components/index.js';
import { defaultExpanded, filterOutline, outlineRows } from './outline.js';
import { MasteryMark } from '../practice/MasteryMark.jsx';
import MathText from '../../MathText.jsx';

/* A filter box appears once the outline is too long to scan by eye. */
const FILTER_FROM = 12;

/**
 * The outline (目录) as a tree: `items` come from structureOutline (parent, depth, minor). Folded rows have a twisty
 * (a button, so the keyboard reaches it); the current entry is marked, and when it is folded away its nearest open part is.
 * `footer` is the slot under the list (the "让 AI 帮你" flow). `initialOpen`: ids open at first (default: defaultExpanded).
 */
export default function OutlinePanel({ items, activeId, onJump, labelOf = () => '', id, className = '', footer = null, initialOpen, meters = null, ...rest }) {
  const list = useRef(null), [query, setQuery] = useState(''), [toggled, setToggled] = useState(() => new Map());
  const signature = `${items.length}:${items[0]?.id ?? ''}:${items.at(-1)?.id ?? ''}`;
  useEffect(() => { setToggled(new Map()); setQuery(''); }, [signature]);
  const base = useMemo(() => initialOpen ? new Set(initialOpen) : defaultExpanded(items, activeId), [items, activeId, initialOpen]);
  const expanded = useMemo(() => new Set(items.filter(item => toggled.has(item.id) ? toggled.get(item.id) : base.has(item.id)).map(item => item.id)), [items, base, toggled]);
  const filtering = query.trim().length > 0;
  const rows = useMemo(() => filtering ? filterOutline(items, query) : outlineRows(items, expanded), [filtering, items, query, expanded]);
  // The current entry, or the nearest part above it that is on screen.
  const current = useMemo(() => {
    const byId = new Map(items.map(item => [item.id, item])), shown = new Set(rows.map(row => row.id));
    for (let node = byId.get(activeId); node; node = byId.get(node.parent)) if (shown.has(node.id)) return node.id;
    return null;
  }, [items, rows, activeId]);
  // Keep the current entry visible inside the panel without scrolling anything around it.
  useEffect(() => {
    const panel = list.current, mark = panel?.querySelector('[aria-current="location"]');
    if (!panel || !mark) return;
    const box = panel.getBoundingClientRect(), rect = mark.getBoundingClientRect();
    if (rect.top < box.top + 8) panel.scrollTop -= box.top + 8 - rect.top;
    else if (rect.bottom > box.bottom - 8) panel.scrollTop += rect.bottom - box.bottom + 8;
  }, [current, items, expanded]);
  const toggle = item => setToggled(previous => new Map(previous).set(item.id, !expanded.has(item.id)));
  const onFilterKey = event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); } };
  const name = item => [labelOf(item), item.title].filter(Boolean).join(' · ');
  return <nav id={id} className={`reader-outline ${className}`.trim()} aria-label={ui('目录')} {...rest}>
    <h3 className="reader-panel__title">{ui('目录')}</h3>
    {items.length > FILTER_FROM && <div className="reader-outline__filter" role="search">
      <Icon name="search" size={16} className="reader-find__icon" />
      <input type="search" value={query} autoComplete="off" spellCheck={false} placeholder={ui('在目录中查找')} aria-label={ui('在目录中查找')}
        onChange={event => setQuery(event.target.value)} onKeyDown={onFilterKey} />
    </div>}
    <div className="reader-outline__scroll" ref={list}>
      {items.length === 0 && <p className="reader-outline__empty">{ui('没有解析出标题')}</p>}
      {items.length > 0 && filtering && rows.length === 0 && <p className="reader-outline__empty" role="status">{ui('没有找到')}</p>}
      <ol>
        {rows.map(item => {
          const label = labelOf(item), open = expanded.has(item.id), foldable = !filtering && item.children > 0;
          return <li key={item.id} data-depth={filtering ? 0 : Math.min(item.depth || 0, 4)} data-minor={item.minor || undefined}>
            {foldable
              ? <DisclosureToggle className="reader-outline__twisty" open={open}
                label={open ? uiFormat('收起「{0}」', [name(item) || ui('此节')]) : uiFormat('展开「{0}」', [name(item) || ui('此节')])} onToggle={() => toggle(item)} />
              : <span className="reader-outline__twisty reader-outline__twisty--none" aria-hidden="true" />}
            <button type="button" className="reader-outline__link" aria-current={item.id === current ? 'location' : undefined}
              title={[name(item), filtering && item.trail?.length ? item.trail.join(' › ') : ''].filter(Boolean).join('\n')} onClick={() => onJump(item)}>
              {label && <span className="reader-outline__label">{label}</span>}
              {item.title && <span className="reader-outline__title"><MathText text={item.title} /></span>}
              {filtering && item.trail?.length > 0 && <small className="reader-outline__trail">{item.trail.at(-1)}</small>}
            </button>
            {/* 资料掌握度 of this entry (and what is below it); present only when the document has questions at all. */}
            {meters && <span className="reader-outline__meter"><MasteryMark summary={meters.get(item.id) ?? null} title={name(item)} size={13} /></span>}
          </li>;
        })}
      </ol>
    </div>
    {footer && <div className="reader-outline__foot">{footer}</div>}
  </nav>;
}
