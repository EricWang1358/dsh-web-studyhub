import React, { useState } from 'react';
import MathText from '../../MathText.jsx';
import { Button, ConfirmDialog, InlineMessage } from '../../components/index.js';
import { ui, uiFormat } from '../../i18n.js';
import { staleCount } from './model.js';

/**
 * The annotations kept for an older revision of the document: they are not applied to this one (the passages may have moved), so
 * they are listed with their passage and first question under one plain note, and can be cleared. Nothing is dropped silently.
 */
export default function StaleAnnotations({ stale = [], onClear }) {
  const [confirm, setConfirm] = useState(false), total = staleCount(stale);
  if (!total) return null;
  const threads = stale.flatMap(entry => entry.threads || []);
  return <details className="reader-links__stale reader-annotations-stale">
    <summary>{uiFormat('原文已更新 · {0} 条批注', [total])}</summary>
    <InlineMessage tone="warning">{ui('原文已更新，需要重新定位')}</InlineMessage>
    {threads.map(thread => <article className="reader-link-item" key={thread.key} data-kind="annotation">
      <p className="reader-link-item__head"><span className="reader-link-group__quote"><MathText text={thread.quote} /></span></p>
      <p className="reader-link-item__deck">{thread.question} · {uiFormat('{0} 条问答', [thread.nodes])}</p>
    </article>)}
    {onClear && <Button size="sm" variant="quiet" onClick={() => setConfirm(true)}>{ui('清除旧版本批注')}</Button>}
    {confirm && <ConfirmDialog title={ui('清除旧版本批注？')} description={ui('这些批注属于已被替换的旧版本原文，清除后无法恢复。')} confirmLabel={ui('清除')}
      onConfirm={onClear} onClose={() => setConfirm(false)} />}
  </details>;
}
