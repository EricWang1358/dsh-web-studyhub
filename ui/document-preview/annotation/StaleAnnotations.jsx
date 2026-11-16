import React, { useState } from 'react';
import Markdown from '../../Markdown.jsx';
import MathText from '../../MathText.jsx';
import { Badge, Button, ConfirmDialog, InlineMessage } from '../../components/index.js';
import { ui, uiFormat } from '../../i18n.js';
import { stripTermMarkers } from '../../term-marker.js';
import { clip } from '../links/link-model.js';
import { staleCount } from './model.js';

const markKindLabel = style => {
  if (style === 'highlight') return ui('荧光笔');
  if (style === 'bold') return ui('加粗');
  if (style === 'queue') return ui('待出题');
  return ui('划线');
};

function normalizeStaleThreads(stale) {
  const out = [];
  for (const entry of stale || []) {
    if (!entry) continue;
    if (Array.isArray(entry.threads)) {
      for (const thread of entry.threads) out.push(thread);
    } else if (entry.quote || entry.selection?.quote || entry.question || entry.note || entry.answer || entry.qa) {
      out.push({
        key: entry.key || entry.id || entry.quote || entry.selection?.quote,
        ids: entry.ids || (entry.id ? [entry.id] : []),
        quote: entry.quote || entry.selection?.quote || '',
        question: entry.question || entry.qa?.question || '',
        note: entry.note || '',
        answer: entry.answer || entry.qa?.answer || '',
        qa: entry.qa,
        nodes: entry.nodes || 1,
      });
    }
  }
  return out;
}

/**
 * The annotations and reader marks kept for an older revision whose passages were deleted or rewritten:
 * listed with their saved quote, note / Q&A answer, and 1-click dismiss or clear actions so nothing is dropped silently.
 */
export default function StaleAnnotations({ stale = [], staleMarks = [], onClear, onDismissAnnotation, onDismissMark, onClearMarks }) {
  const [confirm, setConfirm] = useState(false);
  const noteTotal = staleCount(stale);
  const marks = (staleMarks || []).filter(item => item && (item.quote || item.selection?.quote));
  const markTotal = marks.length;
  if (!noteTotal && !markTotal) return null;
  const threads = normalizeStaleThreads(stale);
  const summaryLabel = noteTotal > 0 && markTotal > 0
    ? uiFormat('原文已更新 · {0} 条批注、{1} 处划线', [noteTotal, markTotal])
    : markTotal > 0
      ? uiFormat('原文已更新 · {0} 处划线', [markTotal])
      : uiFormat('原文已更新 · {0} 条批注', [noteTotal]);
  const canClearAll = (noteTotal > 0 && !!onClear) || (markTotal > 0 && !!(onClearMarks || onClear));
  const clearLabel = noteTotal > 0 && markTotal > 0
    ? ui('清除失效批注与划线')
    : markTotal > 0
      ? ui('清除失效划线')
      : ui('清除旧版本批注');
  const confirmTitle = noteTotal > 0 && markTotal > 0
    ? ui('清除失效批注与划线？')
    : markTotal > 0
      ? ui('清除失效划线？')
      : ui('清除旧版本批注？');
  const confirmDescription = noteTotal > 0 && markTotal > 0
    ? ui('这些批注与划线对应的原句在当前版本已被删除或改写，清除后无法恢复。')
    : markTotal > 0
      ? ui('这些划线对应的原句在当前版本已被删除或改写，清除后无法恢复。')
      : ui('这些批注属于已被替换的旧版本原文，清除后无法恢复。');
  const handleClearAll = async () => {
    if (noteTotal > 0 && onClear) await onClear();
    if (markTotal > 0) {
      if (onClearMarks) await onClearMarks();
      else if (!noteTotal && onClear) await onClear();
    }
  };
  return <details className="reader-links__stale reader-annotations-stale">
    <summary>{summaryLabel}</summary>
    <InlineMessage tone="warning">{ui('原文已更新，需要重新定位')}</InlineMessage>
    {threads.map(thread => {
      const quote = thread.quote || thread.selection?.quote || '';
      const question = thread.question || thread.qa?.question || '';
      const note = typeof thread.note === 'string' ? thread.note.trim() : '';
      const answer = stripTermMarkers(String(thread.answer || thread.qa?.answer || '')).trim();
      const ids = Array.isArray(thread.ids) ? thread.ids : thread.id ? [thread.id] : [];
      return <article className="reader-link-item" key={thread.key || quote} data-kind="annotation">
        {quote && <p className="reader-link-item__head"><span className="reader-link-group__quote"><MathText text={quote} /></span></p>}
        {(question || thread.nodes) && <p className="reader-link-item__deck">
          {[question, thread.nodes ? uiFormat('{0} 条问答', [thread.nodes]) : ''].filter(Boolean).join(' · ')}
        </p>}
        {note && <p className="reader-link-item__deck">{note}</p>}
        {answer && <div className="reader-link-item__answer"><Markdown text={clip(answer, 280)} /></div>}
        {onDismissAnnotation && ids.length > 0 && <div className="reader-link-item__actions">
          <Button size="sm" variant="quiet" onClick={() => onDismissAnnotation(ids)}>{ui('移除')}</Button>
        </div>}
      </article>;
    })}
    {marks.map(mark => {
      const quote = mark.quote || mark.selection?.quote || '';
      const id = mark.id || mark.key || quote;
      return <article className="reader-link-item" key={id} data-kind="mark">
        <p className="reader-link-item__head">
          <Badge size="sm" className="origin-note">{markKindLabel(mark.style)}</Badge>
          <span className="reader-link-group__quote"><MathText text={quote} /></span>
        </p>
        {onDismissMark && mark.id && <div className="reader-link-item__actions">
          <Button size="sm" variant="quiet" onClick={() => onDismissMark(mark.id)}>{ui('移除这条划线')}</Button>
        </div>}
      </article>;
    })}
    {canClearAll && <Button size="sm" variant="quiet" onClick={() => setConfirm(true)}>{clearLabel}</Button>}
    {confirm && <ConfirmDialog title={confirmTitle} description={confirmDescription} confirmLabel={ui('清除')}
      onConfirm={handleClearAll} onClose={() => setConfirm(false)} />}
  </details>;
}
