import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { ADD_SOURCE_ICON, Button, Menu } from '../components/index.js';
import { useStudy } from '../study-context.jsx';

/**
 * The heading of the catalogue: its title and count, 查看图谱, and the
 * housekeeping menu (整理题组, add material, manual card, JSON import, 斩题组)
 * that keeps the heading quiet. `merge` is useMergeSuggestions. `onShowGraph` is passed only while the desk above has no way to the graph of its own
 * (the home draws one, #1695); `maps` false leaves 查看图谱 out (简洁版). The way to the 总纲 is beside the course title (ui/study-map/OutlineEntry.jsx).
 */
export default function CatalogHeading({ count, showArchived, hasDecks, hasSources, course, merge, slain, addSource, createManual, importLibrary, manage, onShowGraph, maps = true }) {
  const { busy, openModal } = useStudy();
  const canOpenCompanionBuild = typeof openModal === 'function';
  const items = [
    course != null && { id: 'merge', label: ui('整理题组'), disabled: busy || merge.busy },
    { id: 'add', label: ui('添加资料'), icon: ADD_SOURCE_ICON },
    canOpenCompanionBuild && { id: 'companion', label: ui('新建交互伴学课…'), icon: 'plus' },
    { id: 'manual', label: ui('手工建卡'), disabled: !hasSources },
    { id: 'json', label: ui('导入 JSON 题组') },
    slain && { id: 'slain', label: uiFormat('斩题组（{0}）', [slain.count]), disabled: busy },
  ].filter(Boolean);
  const choose = {
    merge: merge.run,
    add: addSource,
    companion: () => openModal?.({ type: 'companionBuild', course: course || '' }),
    manual: createManual,
    json: importLibrary,
    slain: () => manage(slain.id),
  };
  return (
    <div className="section-heading map-heading" data-tour="home-catalog">
      <h2>{showArchived ? ui('已归档题组') : ui('学习目录')} <span>{count}</span></h2>
      <div className="section-heading-actions">
        {maps && hasDecks && onShowGraph && <Button size="sm" iconEnd="arrow-right" lock={busy} title={ui('用整块画布打开知识结构图 / 学习路径图（可缩放、拖拽）')}
          onClick={() => onShowGraph(null, { canvas: true })}>{ui('查看图谱')}</Button>}
        <Menu className="map-menu-wrap" label={ui('整理与添加')} items={items} onSelect={(id) => choose[id]()}
          trigger={({ props, ref }) => <Button ref={ref} size="sm" className="catalog-menu-toggle" busy={!!merge.busy} busyLabel={ui('整理中…')} {...props}>{ui('整理与添加')}</Button>} />
      </div>
    </div>
  );
}
