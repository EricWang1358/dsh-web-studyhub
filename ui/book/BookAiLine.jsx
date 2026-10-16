import React, { useEffect, useRef } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Spinner, Tooltip } from '../components/index.js';

/* The one line an AI task or a deletion leaves in a point of the review book (ui/book/ai-lines.js), drawn as high as a folded AI block's row so the block that
   lands, or the page around it, never moves: 「AI 正在写 · 约 1 分钟 · 取消」, a failure with its reason and 重试 (and 关闭), or 「已删除这段 · 撤销」 for a few
   seconds. Its actions are quiet links; each hidden rule (what 取消 keeps, which deletion 撤销 can take back) is said on hover and focus. A 撤销 line that has
   had its seconds fades out (opacity) and keeps its room, so nothing below moves by itself; it goes once it is off screen (or its point is no longer drawn). */

/** line: the line (kind writing | done | failed | undo; `faded`: an undo line past its seconds); onCancel(line), onRetry(line), onDismiss(line), onUndo();
    onForget(line): a faded line is off screen (or no longer drawn) and can go. */
export default function BookAiLine({ line, onCancel, onRetry, onDismiss, onUndo, onForget }) {
  const kind = line.kind === 'done' ? 'writing' : line.kind, faded = kind === 'undo' && !!line.faded;
  const ref = useRef(null), latest = useRef(null);
  latest.current = { line, onForget, faded };
  useEffect(() => {
    if (!faded || typeof IntersectionObserver === 'undefined' || !ref.current) return undefined;
    const observer = new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) latest.current.onForget?.(latest.current.line); });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [faded]);
  // A faded line whose point is no longer drawn (another point, a folded one) is not drawn again when the reader comes back.
  useEffect(() => () => { if (latest.current.faded) latest.current.onForget?.(latest.current.line); }, []);
  return (
    <aside className="book-ai book-ai--line" ref={ref} data-ai-line={kind} data-ai-faded={faded ? '' : undefined} aria-hidden={faded || undefined} aria-label={ui('AI 段落')}>
      <div className="book-ai__line" role={faded ? undefined : kind === 'failed' ? 'alert' : 'status'}>
        {kind === 'writing' && <>
          <Spinner size="sm" className="book-ai__spin" />
          <Badge size="sm" className="book-ai__tag">AI</Badge>
          <span className="book-ai__state">{ui('正在写 · 约 1 分钟')}</span>
          {line.kind === 'writing' && <span className="book-ai__dot" aria-hidden="true">·</span>}
          {/* 取消 works from the first moment: pressed before the host has answered, the task is stopped as soon as its id is known. */}
          {line.kind === 'writing' && <Tooltip layer content={ui('停下这个任务，这里什么也不会写进书里。')} anchorClassName="book-ai__act">
            <Button variant="link" size="sm" className="book-ai__link" onClick={() => onCancel?.(line)}>{ui('取消')}</Button>
          </Tooltip>}
        </>}
        {kind === 'failed' && <>
          <Badge size="sm" tone="warning" className="book-ai__tag">AI</Badge>
          {/* One line, as high as the line it replaces; the whole reason on hover and focus. */}
          <Tooltip layer content={line.error || ''} anchorClassName="book-ai__why">
            <span className="book-ai__state book-ai__state--failed" tabIndex={0}>{uiFormat('没写成：{0}', [line.error || ui('出现未知错误')])}</span>
          </Tooltip>
          <span className="book-ai__act">
            <Button variant="link" size="sm" className="book-ai__link" onClick={() => onRetry?.(line)}>{ui('重试')}</Button>
            <Button variant="link" size="sm" className="book-ai__link" onClick={() => onDismiss?.(line)}>{ui('关闭')}</Button>
          </span>
        </>}
        {kind === 'undo' && <>
          <span className="book-ai__state">{ui('已删除这段')}</span>
          <span className="book-ai__dot" aria-hidden="true">·</span>
          <Tooltip layer content={ui('只能撤销最近一次删除，几秒后这一行会消失。')} anchorClassName="book-ai__act">
            <Button variant="link" size="sm" className="book-ai__link" data-book-ai="undo" disabled={faded} onClick={() => onUndo?.()}>{ui('撤销')}</Button>
          </Tooltip>
        </>}
      </div>
    </aside>
  );
}
