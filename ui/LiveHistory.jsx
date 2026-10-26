import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { formatClock } from './format.js';
import { Button } from './components/index.js';

/* The classes of the live page: the recent ones and, folded, the archived ones. An archived class can be restored or deleted; 删除 asks nothing (a recording is not a
   source or a question): the caller hides the row and offers 撤销 in the notice (ui/undoable.js), and the host deletes it when that notice leaves. */
export default function LiveHistory({ sessions, disabled, capturing, onOpen, onArchive, onDelete }) {
  const recent = sessions.filter(item => !item.archivedAt), archived = sessions.filter(item => item.archivedAt);
  const row = item => <div className="live-history-item" key={item.id} data-live={item.id}>
    <div className="live-history-row"><div><strong>{item.title}</strong><small>{formatClock(item.elapsedMs)} · {uiFormat('{0} 句', [item.segments])}{item.active ? ` · ${ui('实录中')}` : ''}</small></div>
      <div className="live-actions"><Button disabled={disabled || capturing} onClick={() => onOpen(item.id)}>{ui('打开')}</Button>
        <Button disabled={disabled || item.active} onClick={() => onArchive(item.id, !item.archivedAt)}>{item.archivedAt ? ui('恢复') : ui('归档')}</Button>
        {item.archivedAt && <Button disabled={disabled} aria-label={uiFormat('删除「{0}」的实录', [item.title])} onClick={() => onDelete(item)}>{ui('删除')}</Button>}</div>
    </div>
  </div>;
  return <details className="live-history"><summary>{uiFormat('历史课堂 ({0})', [recent.length])}</summary>
    {recent.map(row)}
    {!recent.length && <p className="muted">{ui('暂无未归档课堂。实录会自动保存在当前学习库。')}</p>}
    <details className="live-archive"><summary>{uiFormat('归档课堂 ({0})', [archived.length])}</summary>
      {archived.map(row)}
      {!archived.length && <p className="muted">{ui('归档的课堂会出现在这里，可以恢复或删除。')}</p>}
    </details>
  </details>;
}
