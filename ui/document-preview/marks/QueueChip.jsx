import React, { useState } from 'react';
import { Button, InlineMessage, Popover, SegmentedControl } from '../../components/index.js';
import { errorMessage, ui, uiFormat } from '../../i18n.js';
import { renderedPassageRange } from '../selection.js';
import { scrollToNode } from '../reader/useReadingPosition.js';
import { clipText, DEFAULT_PER_PASSAGE, PER_PASSAGE } from './model.js';

/* 待出题 N: the passages put aside while reading (right-click › 加入待出题), quiet in the toolbar until there are some. The panel lists them in
   reading order (a passage's words jump to it; × takes it off), asks how many questions each, and 一次性出题 starts ONE ordinary question run in the
   background: the reader stays open, the run is in the 任务 console, and its questions arrive as a draft. At the narrowest (`compact`) the toolbar has no
   room for it: the panel opens from 更多 (useReaderMarks moreItems) and hangs from an empty anchor where the chip would be. */

export default function QueueChip({ queue, disabled = false, modelReady = true, onOpenModelSettings, onRemove, onStart, body, compact = false, open, onOpenChange: setOpen }) {
  const [per, setPer] = useState(DEFAULT_PER_PASSAGE), [starting, setStarting] = useState(false), [error, setError] = useState('');
  const total = queue.length * per;
  const jump = item => {
    const range = body?.current ? renderedPassageRange(body.current, item.selection) : null;
    if (!range) return;
    setOpen(false);
    scrollToNode(body.current.closest('.reader-scroll'), range);
  };
  const start = async () => {
    setStarting(true); setError('');
    try { await onStart(per); setOpen(false); } catch (e) { setError(errorMessage(e)); } finally { setStarting(false); }
  };
  return <Popover open={open} onOpenChange={setOpen} label={ui('待出题')} className="reader-popover reader-queue" panelClassName="reader-popover__panel reader-queue__panel"
    boundsSelector=".study-document-viewer" flip={false}
    trigger={({ props, ref }) => compact ? <span ref={ref} className="reader-queue__anchor" aria-hidden="true" />
      : <Button ref={ref} size="sm" variant="quiet" icon="checklist" iconClassName="reader-toolbar__word-icon" className="reader-toolbar__action reader-queue__chip" {...props}>
        {uiFormat('待出题 {0}', [queue.length])}</Button>}>
    <p className="reader-queue__lead">{ui('读的时候右键「加入待出题」攒下的段落。一次出完，出题时可以接着读。')}</p>
    <ol className="reader-queue__list">
      {queue.map(item => <li key={item.id} className="reader-queue__row">
        <Button size="sm" variant="quiet" wrap align="start" className="reader-queue__quote" onClick={() => jump(item)}>{clipText(item.selection.quote, 90)}</Button>
        <Button size="sm" variant="quiet" icon="close" className="reader-queue__remove" aria-label={uiFormat('移出待出题：{0}', [clipText(item.selection.quote, 30)])} onClick={() => onRemove(item)} />
      </li>)}
    </ol>
    <div className="reader-queue__per">
      <span>{ui('每段出')}</span>
      <SegmentedControl size="sm" label={ui('每段出几题')} value={String(per)} onChange={value => setPer(Number(value))}
        options={PER_PASSAGE.map(n => ({ value: String(n), label: uiFormat('{0} 题', [n]) }))} />
    </div>
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    {modelReady
      ? <Button variant="primary" icon="sparkle" className="reader-queue__start" lock={disabled} busy={starting} busyLabel={ui('正在开始…')} onClick={start}>
        {uiFormat('一次性出题 · 约 {0} 题', [total])}</Button>
      : <Button variant="secondary" className="reader-queue__start" onClick={() => { setOpen(false); onOpenModelSettings?.(); }}>{ui('先连接模型')}</Button>}
    <small className="reader-queue__note">{ui('出成一份草稿，检查后再发布；用到的段落会从这里移走。')}</small>
  </Popover>;
}
