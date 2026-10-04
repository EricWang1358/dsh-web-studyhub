import React from 'react';
import { ui } from '../../i18n.js';
import { Button, Dialog } from '../../components/index.js';

/** 学习资料: the materials a practice round draws on (or the ones a letter points at); choosing one opens it in the reader. */
export default function SourceListDialog({ modal, run, data, onClose, onOpenSource }) {
  const sources = (modal.sourceIds || run?.sourceIds || []).map((id) => data.sources.find((source) => source.id === id)).filter(Boolean);
  return (
    <Dialog title={ui('学习资料')} size="md" onClose={onClose}>
      {sources.map((source) => (
        <Button key={source.id} variant="quiet" className="source-row" iconEnd="arrow-right" onClick={() => onOpenSource(source)}>{source.title}</Button>
      ))}
    </Dialog>
  );
}
