import React from 'react';
import Markdown from '../Markdown.jsx';
import MathText from '../MathText.jsx';
import { Badge, Button, Dialog, useToast } from '../components/index.js';
import { ui, uiFormat } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { clip } from './links/link-model.js';
import { formatMarksMarkdown, marksExportFilename, staleTagText } from './marks-export.js';
import marksCss from './marks/marks.css';

function entryBadgeLabel(entry) {
  if (entry.kind === 'mark') return entry.styleLabel;
  if (entry.explain) return ui('词解');
  if (entry.kind === 'qa') return ui('问答');
  if (entry.kind === 'note') return ui('笔记');
  return ui('批注');
}

function downloadMarkdownFile(filename, markdown) {
  if (typeof window === 'undefined' || typeof Blob === 'undefined' || !window.document) return false;
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

function useExportActions(summary, onExportMarkdown) {
  const toast = useToast();
  const copyMarkdown = async () => {
    const markdown = formatMarksMarkdown(summary);
    if (!globalThis.navigator?.clipboard?.writeText) {
      toast.show({ tone: 'warning', message: ui('没能复制，请用 Ctrl+C。') });
      return;
    }
    try {
      await globalThis.navigator.clipboard.writeText(markdown);
      toast.show({ tone: 'success', message: ui('已复制 Markdown') });
    } catch {
      toast.show({ tone: 'warning', message: ui('没能复制，请用 Ctrl+C。') });
    }
  };
  const exportFile = () => {
    const markdown = formatMarksMarkdown(summary);
    const filename = marksExportFilename(summary.title);
    if (onExportMarkdown) {
      onExportMarkdown({ filename, markdown });
      return;
    }
    if (downloadMarkdownFile(filename, markdown)) {
      toast.show({ tone: 'success', message: ui('已导出 Markdown') });
    }
  };
  return { copyMarkdown, exportFile };
}

function SummaryContent({ summary, onJump, onOpenAnnotation }) {
  if (!summary.total) {
    return <p className="reader-marks-summary__empty" role="status">{ui('暂无划线或批注。')}</p>;
  }
  return <div className="reader-marks-summary__groups">
    {summary.sections.map(section => <section key={section.heading} className="reader-marks-summary__group">
      <h4 className="reader-marks-summary__heading">{section.heading}</h4>
      <div className="reader-marks-summary__items">
        {section.entries.map(entry => {
          const canJump = entry.placed && !!onJump && !!(entry.sourceId || Number.isInteger(entry.page));
          return <article key={entry.id} className="reader-marks-summary__item" data-stale={entry.stale || undefined}>
            <div className="reader-marks-summary__meta">
              <Badge size="sm" className="origin-note">{entryBadgeLabel(entry)}</Badge>
              {entry.stale && <Badge size="sm" tone="warning">{staleTagText()}</Badge>}
              {canJump && <Button size="sm" variant="quiet" onClick={() => onJump(entry)}>{ui('跳转到原文')}</Button>}
              {entry.kind === 'annotation' && !entry.stale && entry.selection && onOpenAnnotation && (
                <Button size="sm" variant="quiet" onClick={() => onOpenAnnotation(entry)}>{ui('打开问答')}</Button>
              )}
            </div>
            {entry.quote && <blockquote className="reader-marks-summary__quote"><MathText text={entry.quote} /></blockquote>}
            {entry.note && <p className="reader-marks-summary__note">{entry.note}</p>}
            {entry.question && <p className="reader-marks-summary__question"><strong>{entry.question}</strong></p>}
            {entry.answer && <div className="reader-marks-summary__answer"><Markdown text={clip(entry.answer, 320)} /></div>}
          </article>;
        })}
      </div>
    </section>)}
  </div>;
}

export function MarksSummarySection({ summary, onJump, onOpenAnnotation, onOpenSheet, onExportMarkdown }) {
  useInjectCss(marksCss, 'study-reader-marks');
  const { copyMarkdown, exportFile } = useExportActions(summary, onExportMarkdown);
  if (!summary?.total) return null;
  return <details className="reader-links__stale reader-marks-summary" data-tour="reader-marks-summary">
    <summary>{uiFormat('批注与划线汇总 · {0}', [summary.total])}</summary>
    <div className="reader-marks-summary__bar">
      <Button size="sm" variant="secondary" icon="copy" onClick={copyMarkdown}>{ui('复制 Markdown')}</Button>
      <Button size="sm" variant="secondary" icon="download" onClick={exportFile}>{ui('导出 .md')}</Button>
      {onOpenSheet && <Button size="sm" variant="quiet" onClick={onOpenSheet}>{ui('展开窗口')}</Button>}
    </div>
    <SummaryContent summary={summary} onJump={onJump} onOpenAnnotation={onOpenAnnotation} />
  </details>;
}

export function MarksSummaryDialog({ open, summary, onClose, onJump, onOpenAnnotation, onExportMarkdown }) {
  useInjectCss(marksCss, 'study-reader-marks');
  const { copyMarkdown, exportFile } = useExportActions(summary, onExportMarkdown);
  if (!open || !summary) return null;
  const footer = <>
    <Button variant="quiet" onClick={onClose}>{ui('关闭')}</Button>
    <Button variant="secondary" icon="copy" disabled={!summary.total} onClick={copyMarkdown}>{ui('复制 Markdown')}</Button>
    <Button variant="primary" icon="download" disabled={!summary.total} onClick={exportFile}>{ui('导出 .md')}</Button>
  </>;
  return <Dialog size="md" className="reader-marks-dialog" contentClassName="reader-marks-dialog__content"
    title={uiFormat('批注与划线汇总（{0}）', [summary.total])} onClose={onClose} footer={footer}>
    <SummaryContent summary={summary}
      onJump={entry => { onClose?.(); onJump?.(entry); }}
      onOpenAnnotation={entry => { onClose?.(); onOpenAnnotation?.(entry); }} />
  </Dialog>;
}
