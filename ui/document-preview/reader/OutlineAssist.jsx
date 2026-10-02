import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Button, Dialog } from '../../components/index.js';
import { TokenEstimateView, TokenUsage } from '../../TokenUsage.jsx';
import { ASSIST_IDLE, assistReducer, rejectionKind } from './ai-outline.js';
import SegmentDialog from './SegmentDialog.jsx';

/* The "让 AI 帮你" flow (materials.outline.*), one component wherever it is offered: under the reader's outline and in the
   dialog of a row on the 资料 page. It never starts a model call by itself: the learner sees what one call would cost first,
   starts it, previews the proposal beside the current outline and accepts or discards it. A call, a rejection or a failure
   leaves the automatic outline exactly as it was, and none of it blocks reading. */

const coverageText = coverage => coverage?.condensed
  ? uiFormat('资料较长（共 {0} 段）：已按 {1} 段取样交给模型，标题只能定位到取样段的开头。', [coverage.blocks, coverage.units])
  : uiFormat('资料分成 {0} 段交给模型。', [coverage?.units ?? 0]);

const rejectionText = code => ({
  format: ui('模型的回答不是目录格式，已丢弃；自动目录保持不变。'),
  empty: ui('模型没有给出任何标题，已丢弃；自动目录保持不变。'),
  grounding: ui('模型给出的一些标题在原文里找不到依据，已丢弃；自动目录保持不变。'),
  structure: ui('模型给出的目录位置或层级有误，已丢弃；自动目录保持不变。'),
})[rejectionKind(code)];

/** An outline as an indented list: a heading per row, a tag on a label the model wrote itself. */
function EntryList({ rows, label }) {
  return <ol className="reader-assist__entries" aria-label={label}>
    {rows.map((row, index) => <li key={index} data-depth={row.depth} data-minor={row.minor || undefined}>
      <span>{row.title}</span>
      {row.kind === 'label' && <small className="reader-assist__tag" title={ui('AI 概括的标题，原文里没有这句话')}>{ui('概括')}</small>}
    </li>)}
  </ol>;
}

/** The proposal beside the outline the reader has now, each with its count, and what the call cost. */
export function ProposalPreview({ current, entries, usage, coverage, warnings = [] }) {
  const now = current.map(item => ({ title: item.title, depth: item.depth || 0, minor: item.minor }));
  const proposed = entries.map(entry => ({ title: entry.title, depth: entry.level - 1, kind: entry.kind }));
  return <div className="reader-assist__preview">
    <div className="reader-assist__columns">
      <section><h4>{uiFormat('当前目录 · {0} 项', [current.length])}</h4><EntryList rows={now} label={ui('当前目录')} /></section>
      <section><h4>{uiFormat('AI 建议 · {0} 项', [entries.length])}</h4><EntryList rows={proposed} label={ui('AI 建议')} /></section>
    </div>
    <p className="reader-assist__note">{coverageText(coverage)}</p>
    {warnings.includes('levels-adjusted') && <p className="reader-assist__note">{ui('有几条的层级已按规则调整。')}</p>}
    {usage && <TokenUsage usage={usage} />}
  </div>;
}

/**
 * What the flow shows for each state. `saved` is the kept outline of this revision (or null; its `segmentation` says it is
 * applied as the document's chapters), `stale` a note that only an older revision has one, `missing` how many kept entries
 * could not be placed in what is drawn. variant 'dialog' is the 资料 page's: the two ways to ask are the main buttons.
 */
export function OutlineAssistView({ state, saved, stale, missing = 0, variant = 'inline', onStart, onRun, onCancel, onDiscard, onRestore, onSegment, onRestoreSegmentation }) {
  const { phase } = state;
  const segmentation = saved?.segmentation ? { level: saved.segmentation.level, chapters: saved.entries.filter(entry => entry.level <= saved.segmentation.level).length } : null;
  if (phase === 'estimating') return <p className="reader-assist__status" role="status">{ui('正在估算用量…')}</p>;
  if (phase === 'ready') return <div className="reader-assist" data-phase="ready">
    <p className="reader-assist__note">{coverageText(state.coverage)}</p>
    <TokenEstimateView state={{ status: 'ready', estimate: state.estimate }} />
    <p className="reader-assist__note">{ui('只调用一次模型；不会改动资料的原文、引用、选区和题目。')}</p>
    <div className="reader-assist__actions"><Button size="sm" variant="primary" onClick={onRun}>{ui('开始')}</Button><Button size="sm" variant="quiet" onClick={onCancel}>{ui('取消')}</Button></div>
  </div>;
  if (phase === 'running') return <div className="reader-assist" data-phase="running">
    <p className="reader-assist__status" role="status" aria-live="polite">{ui('AI 正在整理目录…可以继续阅读，完成后会提示。')}</p>
    <span className="reader-assist__bar" aria-hidden="true" />
    <div className="reader-assist__actions"><Button size="sm" variant="quiet" onClick={onCancel}>{ui('取消')}</Button></div>
  </div>;
  if (phase === 'proposal') return <p className="reader-assist__status" role="status">{ui('已生成一份建议目录，请在弹出的窗口里确认。')}</p>;
  if (phase === 'nomodel') return <div className="reader-assist" data-phase="nomodel">
    <p className="reader-assist__note" role="status">{ui('还没有连接模型，没法让 AI 整理目录；仍使用自动目录。')}</p>
    <div className="reader-assist__actions"><Button size="sm" variant="quiet" onClick={onDiscard}>{ui('知道了')}</Button></div>
  </div>;
  if (phase === 'empty') return <div className="reader-assist" data-phase="empty">
    <p className="reader-assist__note" role="status">{ui('这份资料里没有可以整理的文字。')}</p>
    <div className="reader-assist__actions"><Button size="sm" variant="quiet" onClick={onDiscard}>{ui('知道了')}</Button></div>
  </div>;
  if (phase === 'rejected') return <div className="reader-assist" data-phase="rejected">
    <p className="reader-assist__note is-warning" role="alert">{rejectionText(state.code)}</p>
    {state.usage && <TokenUsage usage={state.usage} />}
    <div className="reader-assist__actions"><Button size="sm" onClick={() => onStart(state.mode)}>{ui('重新生成')}</Button><Button size="sm" variant="quiet" onClick={onDiscard}>{ui('关闭')}</Button></div>
  </div>;
  if (phase === 'failed') return <div className="reader-assist" data-phase="failed">
    <p className="reader-assist__note is-warning" role="alert">{uiFormat('没能完成：{0}', [state.message || ui('出现未知错误')])}</p>
    <div className="reader-assist__actions"><Button size="sm" onClick={() => onStart(state.mode)}>{ui('重试')}</Button><Button size="sm" variant="quiet" onClick={onDiscard}>{ui('关闭')}</Button></div>
  </div>;
  return <div className="reader-assist" data-phase="idle">
    {saved && <>
      <p className="reader-assist__note" role="status">{uiFormat('AI 目录 · {0} 项', [saved.entries.length])}</p>
      {missing > 0 && <p className="reader-assist__note is-warning">{uiFormat('有 {0} 项在当前版面里找不到，已略过。', [missing])}</p>}
      {segmentation && <p className="reader-assist__note" role="status">{uiFormat('已按第 {0} 级分成 {1} 章。', [segmentation.level, segmentation.chapters])}</p>}
      <div className="reader-assist__actions">
        {onSegment && <Button size="sm" variant="quiet" onClick={onSegment}>{ui('用它重新分段')}</Button>}
        {onRestoreSegmentation && segmentation && <Button size="sm" variant="quiet" onClick={onRestoreSegmentation}>{ui('恢复自动分段')}</Button>}
        <Button size="sm" variant="quiet" onClick={() => onStart(saved.mode)}>{ui('重新生成')}</Button>
        <Button size="sm" variant="quiet" onClick={onRestore}>{ui('恢复自动目录')}</Button>
      </div>
    </>}
    {!saved && <>
      {stale && <p className="reader-assist__note" role="status">{ui('这份资料已更新；之前为旧版本整理的 AI 目录不再适用。')}</p>}
      {variant === 'dialog'
        ? <div className="reader-assist__actions">
          <Button variant="primary" icon="sparkle" onClick={() => onStart('chapters')} title={ui('只让 AI 找出章节的起点，比完整目录便宜')}>{ui('让 AI 找出章节（较省）')}</Button>
          <Button variant="secondary" onClick={() => onStart('outline')}>{ui('让 AI 整理完整目录')}</Button>
        </div>
        : <div className="reader-assist__actions">
          <Button size="sm" variant="quiet" icon="sparkle" onClick={() => onStart('outline')}>{ui('对自动解析的标题不满意？让 AI 帮你')}</Button>
          <Button size="sm" variant="quiet" onClick={() => onStart('chapters')} title={ui('只让 AI 找出章节的起点，比完整目录便宜')}>{ui('只分章节')}</Button>
        </div>}
    </>}
  </div>;
}

/**
 * The flow with its calls. `target`: { documentId, sourceId?, revision?, legacy? } of what is being outlined; `current`: the
 * outline the reader has now (structured); `onSaved(outline)` / `onCleared()` tell the owner to show the kept outline or the
 * automatic one again. Extra props reach the segmentation step when the owner offers it.
 */
export default function OutlineAssist({ call, target, current, saved, stale, missing, variant, onSaved, onCleared, onChanged }) {
  const [state, dispatch] = useReducer(assistReducer, ASSIST_IDLE);
  const [mode, setMode] = useState('outline'), [segmenting, setSegmenting] = useState(false), token = useRef(0);
  const { documentId, sourceId, revision, legacy } = target;
  const args = useMemo(() => ({ ...(documentId ? { documentId } : { sourceId }), ...(revision && !legacy ? { revision } : {}) }), [documentId, sourceId, revision, legacy]);
  useEffect(() => { token.current += 1; dispatch({ type: 'reset' }); }, [args]);
  const guard = useCallback(async work => { const mine = ++token.current; try { const result = await work(); return mine === token.current ? { result } : null; } catch (error) { return mine === token.current ? { error } : null; } }, []);
  const start = useCallback(async chosen => {
    const next = chosen === 'chapters' ? 'chapters' : 'outline';
    setMode(next); dispatch({ type: 'estimate' });
    const done = await guard(() => call('materials.outline.suggest', { ...args, mode: next, estimate: true }));
    if (done) dispatch(done.error ? { type: 'error', message: done.error.message } : { type: 'result', result: done.result });
  }, [args, call, guard]);
  const run = useCallback(async () => {
    dispatch({ type: 'run' });
    const done = await guard(() => call('materials.outline.suggest', { ...args, mode }));
    if (done) dispatch(done.error ? { type: 'error', message: done.error.message } : { type: 'result', result: done.result });
  }, [args, call, guard, mode]);
  const cancel = () => { token.current += 1; dispatch({ type: 'reset' }); };
  const accept = async () => {
    const taken = state;
    dispatch({ type: 'saving' });
    try {
      const saving = await call('materials.outline.save', { ...args, mode, entries: taken.entries.map(({ title, level, startBlock }) => ({ title, level, startBlock })), usage: taken.usage || undefined,
        ...(mode === 'chapters' ? { segmentLevel: 1 } : {}) });
      dispatch({ type: 'reset' });
      onSaved?.(saving.outline, saving);
      onChanged?.();
    } catch (error) { dispatch({ type: 'error', message: error.message }); }
  };
  const restore = async () => {
    try { await call('materials.outline.clear', args); onCleared?.(); onChanged?.(); }
    catch (error) { dispatch({ type: 'error', message: error.message }); }
  };
  const restoreSegmentation = async () => {
    try { await call('materials.outline.segment', { ...args, level: null }); onSaved?.({ ...saved, segmentation: undefined }); onChanged?.(); }
    catch (error) { dispatch({ type: 'error', message: error.message }); }
  };
  const withMode = { ...state, mode };
  return <>
    <OutlineAssistView state={withMode} saved={saved} stale={stale} missing={missing} variant={variant} onStart={start} onRun={run} onCancel={cancel}
      onDiscard={() => dispatch({ type: 'reset' })} onRestore={restore} onSegment={() => setSegmenting(true)} onRestoreSegmentation={restoreSegmentation} />
    {segmenting && saved && <SegmentDialog call={call} args={args} onClose={() => setSegmenting(false)}
      onApplied={result => { onSaved?.({ ...saved, segmentation: { level: result.level, appliedAt: new Date().toISOString() } }); onChanged?.(); }}
      onRestored={() => { onSaved?.({ ...saved, segmentation: undefined }); onChanged?.(); }} />}
    {state.phase === 'proposal' && <Dialog title={mode === 'chapters' ? ui('AI 建议的章节') : ui('AI 建议的目录')} size="lg" onClose={() => dispatch({ type: 'reset' })}
      description={ui('预览：确认之前，资料和当前目录都不会改变。')}
      footer={<><Button variant="primary" onClick={accept} disabled={state.saving}>{mode === 'chapters' ? ui('采用这些章节') : ui('采用这个目录')}</Button>
        <Button variant="quiet" onClick={() => dispatch({ type: 'reset' })}>{ui('放弃')}</Button></>}>
      <ProposalPreview current={current} entries={state.entries} usage={state.usage} coverage={state.coverage} warnings={state.warnings} />
    </Dialog>}
  </>;
}
