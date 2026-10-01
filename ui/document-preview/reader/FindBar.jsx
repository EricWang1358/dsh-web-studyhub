import React from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { IconButton, Icon } from '../../components/index.js';

/** Search inside the document: the count, next / previous (Enter, Shift+Enter) and Esc to close. */
export default function FindBar({ query, onQuery, total, index, onStep, onClose, inputRef }) {
  const onKeyDown = event => {
    if (event.key === 'Enter') { event.preventDefault(); onStep(event.shiftKey ? -1 : 1); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  };
  const searching = !!query.trim();
  return <div className="reader-find" role="search">
    <Icon name="search" size={16} className="reader-find__icon" />
    <input ref={inputRef} className="reader-find__input" type="search" value={query} autoComplete="off" spellCheck={false}
      placeholder={ui('在文中查找')} aria-label={ui('在文中查找')} onChange={event => onQuery(event.target.value)} onKeyDown={onKeyDown} />
    <small className="reader-find__count" aria-live="polite">{total ? uiFormat('{0} / {1}', [index + 1, total]) : searching ? ui('没有找到') : ''}</small>
    <IconButton size="sm" icon={<Icon name="chevron" size={16} className="reader-turn reader-turn--up" />} label={ui('上一处')} disabled={!total} onClick={() => onStep(-1)} />
    <IconButton size="sm" icon={<Icon name="chevron" size={16} className="reader-turn reader-turn--down" />} label={ui('下一处')} disabled={!total} onClick={() => onStep(1)} />
    <IconButton size="sm" icon="close" label={ui('关闭查找')} onClick={onClose} />
  </div>;
}
