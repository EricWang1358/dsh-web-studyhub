import React, { useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { formatClock } from './format.js';

export default function LiveHistory({ sessions, disabled, capturing, onOpen, onArchive, onDelete }) {
  const [deleting, setDeleting] = useState(null);
  const recent = sessions.filter(item => !item.archivedAt), archived = sessions.filter(item => item.archivedAt);
  const row = item => <div className="live-history-item" key={item.id}>
    <div className="live-history-row"><div><strong>{item.title}</strong><small>{formatClock(item.elapsedMs)} · {uiFormat('{0} 句', [item.segments])}{item.active ? ` · ${ui('实录中')}` : ''}</small></div>
      <div className="live-actions"><button disabled={disabled || capturing} onClick={() => onOpen(item.id)}>{ui('打开')}</button>
        <button disabled={disabled || item.active} onClick={() => { setDeleting(null); onArchive(item.id, !item.archivedAt); }}>{item.archivedAt ? ui('恢复') : ui('归档')}</button>
        {item.archivedAt && <button disabled={disabled} onClick={() => setDeleting(item.id)}>{ui('删除')}</button>}</div>
    </div>
    {deleting === item.id && <div className="live-history-confirm" role="group" aria-label={ui('确认删除实录')}>
      <p>{uiFormat('永久删除「{0}」的实录、译文和课堂笔记？此操作无法撤销。已另存的学习资料会保留。', [item.title])}</p>
      <div className="live-actions"><button disabled={disabled} onClick={() => setDeleting(null)}>{ui('取消')}</button>
        <button disabled={disabled} onClick={() => onDelete(item.id)}>{ui('永久删除')}</button></div>
    </div>}
  </div>;
  return <details className="live-history"><summary>{uiFormat('历史课堂 ({0})', [recent.length])}</summary>
    {recent.map(row)}
    {!recent.length && <p className="muted">{ui('暂无未归档课堂。实录会自动保存在当前学习库。')}</p>}
    <details className="live-archive"><summary>{uiFormat('归档课堂 ({0})', [archived.length])}</summary>
      {archived.map(row)}
      {!archived.length && <p className="muted">{ui('归档的课堂会出现在这里，可恢复或永久删除。')}</p>}
    </details>
  </details>;
}
