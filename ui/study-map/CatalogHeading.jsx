import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Menu } from '../components/index.js';

/**
 * The heading of the catalogue: its title and count, 查看图谱, and the
 * housekeeping menu (整理题组, add material, manual card, JSON import, 斩题组)
 * that keeps the heading quiet. `merge` is useMergeSuggestions.
 */
export default function CatalogHeading({ count, showArchived, hasDecks, hasSources, course, merge, busy, slain, addSource, createManual, importLibrary, manage, onShowGraph }) {
  const items = [
    course != null && { id: 'merge', label: ui('整理题组'), disabled: busy || merge.busy },
    { id: 'add', label: ui('添加资料'), icon: 'plus' },
    { id: 'manual', label: ui('手工建卡'), disabled: !hasSources },
    { id: 'json', label: ui('导入 JSON 题组') },
    slain && { id: 'slain', label: uiFormat('斩题组（{0}）', [slain.count]), disabled: busy },
  ].filter(Boolean);
  const choose = { merge: merge.run, add: addSource, manual: createManual, json: importLibrary, slain: () => manage(slain.id) };
  return (
    <div className="section-heading map-heading" data-tour="home-catalog">
      <h2>{showArchived ? ui('已归档题组') : ui('学习目录')} <span>{count}</span></h2>
      <div className="section-heading-actions">
        {hasDecks && <Button size="sm" disabled={busy} title={ui('用整块画布打开知识结构图 / 学习路径图（可缩放、拖拽）')}
          onClick={() => onShowGraph?.(null, { canvas: true })}>{ui('查看图谱')}</Button>}
        <Menu className="map-menu-wrap" label={ui('整理与添加')} items={items} onSelect={(id) => choose[id]()}
          trigger={({ props, ref }) => <Button ref={ref} size="sm" className="catalog-menu-toggle" {...props}>{merge.busy ? ui('整理中…') : ui('整理与添加')}</Button>} />
      </div>
    </div>
  );
}
