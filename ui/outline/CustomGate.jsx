import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Dialog, LoadingState, Tooltip } from '../components/index.js';
import { callsText, rangeTok } from '../token-usage.js';
import { handOffTip } from '../hand-off/use-hand-off.js';
import { CUSTOM_BOOK_WHAT } from '../custom-entry.js';

/* The one question before a whole-book spend on the 总纲 page: 生成总纲 / 生成复习全书 of a course that has a document of CUSTOM_BOOK_PAGES pages or more and no
   custom plan do not start at once (ui/custom-entry.js customGateOf). 深度定制这本书（推荐）, 整本生成 (the original action) and 取消, in that order, with a rough
   size of the whole-book way from the build's own estimate (`estimate: true`, no model call): calls and tokens as ranges, never a price. */

/**
 * The size of the whole-book way, from the answers of the two estimates (`book`: courseBook.build's `scale`, which exists once the course has an outline; `outline`:
 * courseOutline.build's answer, whose steps are the calls the build makes and whose `readTokens` are what the inventory reads) -> { points (null: not known yet),
 * calls { low, high }, tokens { low, high }, sample?, firstStep? } or null when there is nothing to say. A book build with no outline yet only has its first step
 * (organising the outline) to show: `firstStep` says so.
 */
export function gateScaleOf(kind, answers) {
  if (kind === 'book' && answers?.book) return { points: answers.book.points, calls: answers.book.calls, tokens: answers.book.readTokens, sample: !!answers.book.sample };
  const outline = answers?.outline;
  if (!outline?.estimate) return null;
  const calls = outline.estimate.calls || 0, tokens = outline.estimate.readTokens || { low: 0, high: 0 };
  if (!calls && !tokens.high) return null;
  // The whole a build asks for, when the estimate can say it (#773): the material it reads AND the writing it asks for. The prompts are named as extra rather
  // than dropped: a range that leaves out half the spend is the thing this gate was wrong about.
  const write = outline.estimate.writeTokens || null, total = outline.estimate.totalTokens || null;
  return { points: null, calls: { low: calls, high: Math.max(calls, outline.steps || 0) }, tokens, write, total, ...(kind === 'book' ? { firstStep: true } : {}) };
}

function ScaleLines({ scale }) {
  if (scale === 'loading') return <LoadingState inline label={ui('正在估算…')} />;
  if (!scale) return null;
  return (
    <div className="custom-gate__scale" data-custom-gate-scale="">
      <p className="custom-gate__line">{scale.points == null ? uiFormat('整本生成大约要 {0}', [callsText(scale.calls)]) : uiFormat('要写 {0} 个知识点 · {1}', [scale.points, callsText(scale.calls)])}</p>
      {scale.total && scale.write
        ? <p className="custom-gate__line">{uiFormat('整笔约 {0}：读资料 {1}，模型写出的 {2}；提示词另计', [rangeTok(scale.total), rangeTok(scale.tokens), rangeTok(scale.write)])}</p>
        : <p className="custom-gate__line">{uiFormat('读资料约 {0}（不含提示和模型写出的内容）', [rangeTok(scale.tokens)])}</p>}
      {scale.firstStep && <p className="custom-gate__line">{ui('这只是第一步（整理总纲）；之后还要给每个知识点写讲解，比这更多。')}</p>}
      <p className="custom-gate__line">{ui('数字只是估计，实际用量在任务页看。')}</p>
    </div>
  );
}

/**
 * <CustomGate kind gate scale onCustom onWhole onClose busy />: kind 'outline' (生成总纲) or 'book' (生成复习全书); gate { pages } (customGateOf); scale: gateScaleOf's
 * answer, 'loading' or null; onCustom() sends the 深度定制 hand-off, onWhole() starts the original action, onClose() cancels.
 */
export default function CustomGate({ kind, gate, scale, onCustom, onWhole, onClose, busy = false }) {
  const book = kind === 'book';
  return (
    <Dialog size="sm" title={ui('先深度定制这本书？')} onClose={onClose} busy={busy} data-custom-gate={kind}
      description={book ? uiFormat('「生成复习全书」会先整理总纲，再给每个知识点写讲解，整本书都要读；这门课里最大的一本有 {0} 页。', [gate.pages])
        : uiFormat('「生成总纲」会把这门课的资料整本读一遍来排章节；这门课里最大的一本有 {0} 页。', [gate.pages])}
      footer={<>
        <Tooltip layer content={handOffTip(CUSTOM_BOOK_WHAT)}><Button variant="primary" icon="chat" lock={busy} onClick={onCustom} data-custom-gate-action="custom">{ui('深度定制这本书（推荐）')}</Button></Tooltip>
        <Tooltip layer content={book ? ui('照原来的做法：读整本书，生成复习全书，马上开始') : ui('照原来的做法：读整本书，生成总纲，马上开始')}>
          <Button variant="secondary" lock={busy} onClick={onWhole} data-custom-gate-action="whole">{ui('整本生成')}</Button></Tooltip>
        <Tooltip layer content={ui('什么都不生成，回到总纲')}><Button variant="quiet" lock={busy} onClick={() => onClose('button')} data-custom-gate-action="cancel">{ui('取消')}</Button></Tooltip>
      </>}>
      <ScaleLines scale={scale} />
      <p className="custom-gate__line">{ui('深度定制：先由主会话问你几个选项（学哪几章、要不要出题），确认之前不生成任何东西，只做你选的部分。')}</p>
    </Dialog>
  );
}
