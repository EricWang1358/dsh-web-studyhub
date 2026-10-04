import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';

/** What is ticked in the tree: clear it, see it as a graph, or study exactly it. */
export default function SelectionBar({ scope, run, busy, onClear, onShowGraph, onStart, onResume }) {
  if (!scope.length) return null;
  return (
    <div className="selection-bar" role="region" aria-label={ui('已选内容')}>
      <span>{ui('已选 ')}{scope.length}{ui(' 项')}</span>
      <Button size="sm" onClick={onClear}>{ui('清除')}</Button>
      <Button size="sm" disabled={busy} title={ui('用整块画布打开所选范围的知识结构图或学习路径图（可缩放、拖拽）')} onClick={() => onShowGraph?.(scope, { canvas: true })}>{ui('查看图谱')}</Button>
      <Button variant="primary" size="sm" icon="play" disabled={busy} onClick={() => (run ? onResume(run.id) : onStart({ mode: 'path', scope }))}>
        {run ? uiFormat('继续 {0}/{1}', [run.index + 1, run.total]) : ui('学习所选内容')}
      </Button>
    </div>
  );
}
