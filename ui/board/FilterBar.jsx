import { ui } from '../i18n.js';
import React, { useId } from 'react';
import { Button, Icon, IconButton } from '../components/index.js';
import { isFiltering, labelHue } from '../../lib/board-model.js';
import { cardsText } from './meta.js';

const MAX_LABELS = 10;

/**
 * Search, label chips and the two due filters. On narrow widths the bar is
 * collapsed behind one filter icon (CSS decides; `open` is the narrow state).
 */
export default function FilterBar({ query, labels, onChange, open, onToggle, matched, total }) {
  const barId = useId();
  const active = isFiltering(query);
  const chosen = query.labels || [];
  const set = (patch) => onChange({ ...query, ...patch });
  const toggleLabel = (label) => set({ labels: chosen.includes(label) ? chosen.filter((entry) => entry !== label) : [...chosen, label] });
  const due = (value) => set({ due: query.due === value ? '' : value });
  return (
    <div className={`board-filter${open ? ' is-open' : ''}${active ? ' is-active' : ''}`}>
      <IconButton icon={<Icon name="filter" size={18} />} label={ui('筛选')} className="board-filter__toggle" aria-expanded={!!open} aria-controls={barId} onClick={onToggle} />
      <div id={barId} className="board-filter__bar" role="search">
        <label className="board-search">
          <Icon name="search" size={16} />
          <input type="search" value={query.text || ''} placeholder={ui('搜索待办')} aria-label={ui('搜索待办')} onChange={(event) => set({ text: event.target.value })} />
        </label>
        <div className="board-filter__group" role="group" aria-label={ui('按到期筛选')}>
          <Button size="sm" shape="pill" aria-pressed={query.due === 'overdue'} onClick={() => due('overdue')}>{ui('只看逾期')}</Button>
          <Button size="sm" shape="pill" aria-pressed={query.due === 'week'} onClick={() => due('week')}>{ui('本周截止')}</Button>
        </div>
        {labels.length > 0 && <div className="board-filter__group" role="group" aria-label={ui('按标签筛选')}>
          {labels.slice(0, MAX_LABELS).map(({ label, count }) => <button key={label} type="button" className={`board-chip is-choice board-hue-${labelHue(label)}`}
            aria-pressed={chosen.includes(label)} title={cardsText(count)} onClick={() => toggleLabel(label)}>{label}</button>)}
        </div>}
        {active && <div className="board-filter__result" role="status">
          <span>{matched} / {total}</span>
          <Button variant="link" size="sm" onClick={() => onChange({})}>{ui('清除筛选')}</Button>
        </div>}
      </div>
    </div>
  );
}
