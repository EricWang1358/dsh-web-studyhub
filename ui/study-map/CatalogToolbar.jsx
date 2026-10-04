import React from 'react';
import { ui } from '../i18n.js';
import { LEVEL_LABEL } from '../shared.js';
import { LEVEL_HINT } from '../mastery-terms.js';
import { BAR_ORDER } from './map-model.js';

/** Search, the 已归档 switch and the mastery legend above the tree. */
export default function CatalogToolbar({ search, onSearch, showArchived, onToggleArchived }) {
  return (
    <div className="map-toolbar">
      <div className="map-tools">
        <input type="search" aria-label={ui('搜索题组或主题')} value={search} onChange={(event) => onSearch(event.target.value)} placeholder={ui('搜索题组、目录或主题')} />
        <button className={showArchived ? 'chip active' : 'chip'} aria-pressed={showArchived} onClick={onToggleArchived}>{ui('已归档')}</button>
      </div>
      {!showArchived && <div className="map-legend" aria-label={ui('掌握程度图例')}>
        {BAR_ORDER.map((level) => <span key={level} title={ui(LEVEL_HINT[level])}><i className={`lv-${level}`} />{LEVEL_LABEL[level]}</span>)}
      </div>}
    </div>
  );
}
