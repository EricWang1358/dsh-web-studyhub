import React, { useState } from 'react';
import { getUiLanguage } from './i18n.js';

const t = (zh, en) => getUiLanguage() === 'en' ? en : zh;
const duration = (ms = 0) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export default function LiveHistory({ sessions, disabled, capturing, onOpen, onArchive, onDelete }) {
  const [deleting, setDeleting] = useState(null);
  const recent = sessions.filter(item => !item.archivedAt), archived = sessions.filter(item => item.archivedAt);
  const row = item => <div className="live-history-item" key={item.id}>
    <div className="live-history-row"><div><strong>{item.title}</strong><small>{duration(item.elapsedMs)} · {item.segments} {t('句', 'sentences')}{item.active ? ` · ${t('实录中', 'Recording')}` : ''}</small></div>
      <div className="live-actions"><button disabled={disabled || capturing} onClick={() => onOpen(item.id)}>{t('打开', 'Open')}</button>
        <button disabled={disabled || item.active} onClick={() => { setDeleting(null); onArchive(item.id, !item.archivedAt); }}>{item.archivedAt ? t('恢复', 'Restore') : t('归档', 'Archive')}</button>
        {item.archivedAt && <button disabled={disabled} onClick={() => setDeleting(item.id)}>{t('删除', 'Delete')}</button>}</div>
    </div>
    {deleting === item.id && <div className="live-history-confirm" role="group" aria-label={t('确认删除实录', 'Confirm recording deletion')}>
      <p>{t(`永久删除「${item.title}」的实录、译文和课堂笔记？此操作无法撤销。已另存的学习资料会保留。`, `Permanently delete the transcript, translations and class notes for “${item.title}”? This cannot be undone. Separately saved study sources are kept.`)}</p>
      <div className="live-actions"><button disabled={disabled} onClick={() => setDeleting(null)}>{t('取消', 'Cancel')}</button>
        <button disabled={disabled} onClick={() => onDelete(item.id)}>{t('永久删除', 'Delete permanently')}</button></div>
    </div>}
  </div>;
  return <details className="live-history"><summary>{t('历史课堂', 'Previous classes')} ({recent.length})</summary>
    {recent.map(row)}
    {!recent.length && <p className="muted">{t('暂无未归档课堂。实录会自动保存在当前学习库。', 'No unarchived classes. Recordings are saved automatically in this study library.')}</p>}
    <details className="live-archive"><summary>{t('归档课堂', 'Archived classes')} ({archived.length})</summary>
      {archived.map(row)}
      {!archived.length && <p className="muted">{t('归档的课堂会出现在这里，可恢复或永久删除。', 'Archived classes appear here and can be restored or permanently deleted.')}</p>}
    </details>
  </details>;
}
