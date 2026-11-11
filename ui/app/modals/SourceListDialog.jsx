import React from 'react';
import { ui } from '../../i18n.js';
import { Button, Dialog } from '../../components/index.js';
import { groupSourcesByDocument } from '../../../lib/source-groups.js';

/** 学习资料: the materials a practice round draws on (or the ones a letter points at); choosing one opens it in the reader. */
export default function SourceListDialog({ modal, run, data, onClose, onOpenSource }) {
  const allSources = data?.sources || [];
  const byId = new Map(allSources.filter(Boolean).map((source) => [source.id, source]));
  const wantedIds = new Set(modal.sourceIds || run?.sourceIds || []);
  const grouped = groupSourcesByDocument(allSources).filter((item) => item.sourceIds.some((id) => wantedIds.has(id)));
  const rows = grouped.length
    ? grouped
        .map((item) => {
          const first = byId.get(item.pages[0]?.sourceId ?? item.sourceIds[0]);
          return first ? { id: item.key, title: item.title, source: first } : null;
        })
        .filter(Boolean)
    : [...wantedIds].map((id) => byId.get(id)).filter(Boolean).map((source) => ({ id: source.id, title: source.title, source }));
  return (
    <Dialog title={modal.pickPages ? ui('选择资料按页做题') : ui('学习资料')} size="md" onClose={onClose}>
      {modal.pickPages && <p className="muted small">{ui('打开正在看的那份资料，翻到已学章节或页码后点「做这几页的题」。')}</p>}
      {rows.map((row) => (
        <Button key={row.id} variant="quiet" className="source-row" iconEnd="arrow-right" onClick={() => onOpenSource(row.source)}>{row.title}</Button>
      ))}
    </Dialog>
  );
}
