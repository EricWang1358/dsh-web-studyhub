import React, { useEffect, useState } from 'react';
import { ui, uiFormat, uiLocale } from '../../i18n.js';
import { Button, Dialog, InlineMessage, LoadingState } from '../../components/index.js';
import { chapterLabel } from '../../SourcePicker.jsx';

/* Using a kept outline as the document's chapters (materials.outline.segment): which level defines a chapter, what each
   level would give with its page ranges, applied only when the learner says so. It is a view over the same text: no page,
   character, citation or question changes, and the automatic chapters come back with one click. */

const currentText = current => current.source === 'segmentation' ? uiFormat('现在：已按 AI 目录分成 {0} 章', [current.count])
  : current.source === 'converted' ? uiFormat('现在：按转换时识别的章节分成 {0} 章', [current.count]) : ui('现在：没有章节');

/** The levels with their counts, and the chapters of the chosen one. `preview`: the result of materials.outline.segment { preview: true }. */
export function SegmentPreview({ preview, level, onLevel }) {
  const view = preview.levels[level] || { count: 0, chapters: [], partialCount: 0 }, unit = preview.unit || 'page';
  const tag = unit === 'part' ? ui('从文件中间开始') : ui('从页中间开始');
  return <div className="reader-segment">
    <p className="reader-assist__note" role="status">{currentText(preview.current)}</p>
    <fieldset className="reader-segment__levels">
      <legend>{ui('用哪一级的标题分章')}</legend>
      {[1, 2, 3].map(value => <label key={value}>
        <input type="radio" name="segment-level" value={value} checked={level === value} onChange={() => onLevel(value)} />
        <span>{uiFormat('第 {0} 级 · {1} 章', [value, preview.levels[value]?.count ?? 0])}</span>
      </label>)}
    </fieldset>
    <ol className="reader-segment__chapters" aria-label={ui('分段结果')}>
      {view.chapters.map(chapter => <li key={chapter.index} data-partial={chapter.partial && unit !== 'text' ? 'true' : undefined}>
        <span>{chapterLabel(chapter, unit)}</span>
        {chapter.partial && unit !== 'text' && <small className="reader-assist__tag">{tag}</small>}
        {unit !== 'text' && <small>{uiFormat('{0} 字符', [chapter.chars.toLocaleString(uiLocale())])}</small>}
      </li>)}
    </ol>
    {unit === 'text' && <p className="reader-assist__note">{ui('这份资料是一整段文字：章节用于阅读时跳转和资料页浏览；出题仍以整份资料为单位。')}</p>}
    {unit !== 'text' && view.partialCount > 0 && <p className="reader-assist__note">{unit === 'part'
      ? uiFormat('{0} 章从文件中间开始：那个文件归在前一章，阅读时会精确定位到章首。', [view.partialCount])
      : uiFormat('{0} 章从页中间开始：那一页归在前一章，阅读时会精确定位到章首。', [view.partialCount])}</p>}
    <p className="reader-assist__note">{ui('只改变章节的划分：原文、页码、引用和题目都不会改动。')}</p>
  </div>;
}

/**
 * The dialog around it: loads the preview, lets the learner pick the level, applies it. `args`: the operation arguments naming the
 * document; `onApplied(result)` / `onRestored(result)` tell the owner what happened (the result says how many chapters changed).
 */
export default function SegmentDialog({ call, args, onClose, onApplied, onRestored }) {
  const [preview, setPreview] = useState(null), [level, setLevel] = useState(1), [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    let live = true;
    call('materials.outline.segment', { ...args, preview: true }).then(value => {
      if (!live) return;
      setPreview(value); setLevel(value.applied || (value.levels[1].count ? 1 : value.levels[2].count ? 2 : 3)); setState({ status: 'ready' });
    }, error => { if (live) setState({ status: 'error', message: error.message }); });
    return () => { live = false; };
  }, [call, args]);
  const apply = async value => {
    setState({ status: 'saving' });
    try {
      const result = await call('materials.outline.segment', { ...args, level: value });
      (value ? onApplied : onRestored)?.(result);
      onClose();
    } catch (error) { setState({ status: 'error', message: error.message }); }
  };
  const busy = state.status === 'saving';
  return <Dialog title={ui('用这份目录重新分段')} size="lg" busy={busy} onClose={onClose}
    footer={<>
      {preview?.applied && <Button variant="quiet" disabled={busy} onClick={() => apply(null)}>{ui('恢复自动分段')}</Button>}
      <Button variant="quiet" disabled={busy} onClick={onClose}>{ui('取消')}</Button>
      <Button variant="primary" busy={busy} disabled={busy || !preview || !preview.levels[level]?.count} onClick={() => apply(level)}>{ui('用这个分段')}</Button>
    </>}>
    {state.status === 'loading' && <LoadingState label={ui('正在计算每一级的章节…')} />}
    {state.status === 'error' && <InlineMessage tone="error">{uiFormat('没能完成：{0}', [state.message])}</InlineMessage>}
    {preview && <SegmentPreview preview={preview} level={level} onLevel={setLevel} />}
  </Dialog>;
}
