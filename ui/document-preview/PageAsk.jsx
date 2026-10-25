import React, { useContext } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Hint, IconButton, InlineMessage, TextArea } from '../components/index.js';
import { READER_HINTS, useReaderHint } from './reader/hints.js';
import { HandOff } from '../hand-off/HandOff.jsx';
import { StudyServicesContext } from '../study-context.jsx';
import AskThread from './AskThread.jsx';
import QuickIntents, { PAGE_INTENTS } from './QuickIntents.jsx';
import ReaderModelGate from './ReaderModelGate.jsx';

const noop = () => {};
/** Why a page question could not be asked, in the words of a page, each with what to do next (a selection's reasons talk about selecting again). */
export const pageReasons = {
  missing: '这一页没有能核对的文字：换一页再问，或用「发给主会话」，截图只在主会话能看图片时有用。',
  stale: '这份资料刚更新过：关掉阅读器再打开，就能接着问这一页。',
  ambiguous: '这一页对应了好几段文字：切换到「阅读」，选中要问的那一段。',
  unavailable: '现在没有可用的模型：先在设置里连上模型，再回来问。',
};
export const PAGE_REFUSED = '这一页暂时问不了：稍后再试一次。';

/** The control after a hint in the panel (else the one before it): closing a hint must not drop the keyboard onto the page. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function nextFocusable(panel, hint) {
  const candidates = [...panel.querySelectorAll(FOCUSABLE)].filter(el => !hint.contains(el) && (el.getClientRects?.().length ?? 1));
  const after = candidates.find(el => hint.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  if (after) return after;
  // Nothing after the hint: the box before it is where a learner who just read the hint would type, not a preset chip that sends on Enter.
  const field = panel.querySelector('textarea:not([disabled]), input:not([disabled]):not([type="hidden"])');
  if (field?.getClientRects?.().length) return field;
  return candidates.filter(el => hint.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING).pop() ?? null;
}

/** A first-visit hint: one sentence, closed for good with its own explicitly named button (reader/hints.js); closing keeps the keyboard in the panel. */
function FirstHint({ id, dismiss, children }) {
  const [shown, close] = useReaderHint(id);
  if (!shown) return null;
  const onDismiss = event => {
    const hint = event.currentTarget.closest('[data-reader-hint]'), panel = hint?.closest('.study-page-ask');
    const next = hint && panel ? nextFocusable(panel, hint) : null;
    close();
    (next || panel)?.focus?.();
  };
  return <InlineMessage tone="info" className="study-page-ask__hint" data-reader-hint={id} onDismiss={onDismiss} dismissText={ui(dismiss)}>{children}</InlineMessage>;
}

/**
 * The learning panel in the 原始 PDF view (issue #456): the question is about the current page, which the panel names, never about an
 * old selection. One box and the thread of answers; keeping answers as annotations, saving them as cards and topping up a deck need a
 * selected passage and stay in 阅读. The model reads only the page's saved text, so figures are pointed to 看原页.
 */
/*
 * 发给主会话 of a page (registry id reader.page): the material's name, the page and its saved text, and the question typed on THIS page; the screenshot
 * is the learner's to paste, and helps only when their chat takes pictures. The hover says to press first and take the screenshot after: without a
 * chat (or with words already in its box) the message goes onto the clipboard and would replace a screenshot copied before.
 */
const HAND_OFF_WHAT = '把这一页的文字和你在上面写的问题发给主会话。先点这里，再截图：没有主会话时这段话会占用剪贴板。截图只在你的主会话能看图片时有用';
const HAND_OFF_WHAT_EMPTY = '把资料名和页码发给主会话。先点这里，再截图：没有主会话时这段话会占用剪贴板。截图只在你的主会话能看图片时有用';

/** The input of reader.page: the page and the question typed on it; a page without saved text has no box, so nothing typed goes with it. */
export const pageHandOffInput = (handOff, question, empty) => ({ ...handOff, question: empty ? '' : question });

export default function PageAsk({ scope, handOff = null, onQuick, resolution, refusal = null, question = '', thread, notice = '', noticeWhy = '', cut = null, error = '', askReady = false, modelReady = false,
  list = null, sectionRef, total = 0, onPage, onQuestion, onAsk, onAskInside, onRetryNode, onToggleNode }) {
  const asking = thread.nodes.some(node => node.parentId === null && node.status === 'asking');
  const refused = refusal || (resolution && resolution.status !== 'resolved' ? resolution : null);
  // Only where an app can take it (the reader also runs as a bare preview of the host, which has no chat and no notices).
  const canHandOff = !!useContext(StudyServicesContext) && !!handOff;
  const handOffInput = () => pageHandOffInput(handOff, question, false);
  const handOffEmptyInput = () => pageHandOffInput(handOff, question, true);
  return <section className="study-document-learning study-page-ask" aria-label={ui('按页提问')} ref={sectionRef} data-scope="page" data-tour="reader-page-ask" tabIndex={-1}>
    {list}
    {/* The page can be turned from here too: on a narrow reader the panel covers the page controls. */}
    <div className="study-page-ask__scope">
      <strong role="status" aria-live="polite">{uiFormat('正在问：第 {0} 页', [scope.page])}</strong>
      {onPage && <span className="study-page-ask__step">
        <IconButton size="sm" icon="chevron-left" label={ui('上一页')} disabled={scope.page <= 1} onClick={() => onPage(scope.page - 1)} />
        <IconButton size="sm" icon="chevron" label={ui('下一页')} disabled={!!total && scope.page >= total} onClick={() => onPage(scope.page + 1)} />
      </span>}
    </div>
    <FirstHint id={READER_HINTS.page} dismiss="不再提示：问的是哪一页">{uiFormat('这里问的是第 {0} 页：用翻页按钮换页，在 PDF 里滚动不会改变要问的页。', [scope.page])}</FirstHint>
    {scope.empty ? <>
      <InlineMessage tone="info">{canHandOff ? uiFormat('第 {0} 页没有保存文字（多半是扫描页或图片页）：换一页再问，或发给主会话，截图只在主会话能看图片时有用。', [scope.page])
        : uiFormat('第 {0} 页没有保存文字（多半是扫描页或图片页）：换一页再问，或在「阅读」里点「看原页」看这一页的图。', [scope.page])}</InlineMessage>
      {/* The page is only a picture: the main chat can read the screenshot the learner pastes; here it is the way forward, not a side link. */}
      {canHandOff && <div className="study-page-ask__forward">
        <p className="muted">{ui('先点按钮，再截这一页的图；主会话能看图片时，把截图粘贴到消息最后。')}</p>
        <HandOff id="reader.page" shape="secondary" what={HAND_OFF_WHAT_EMPTY} input={handOffEmptyInput} />
      </div>}
    </> : <>
      {refused && <InlineMessage tone="warning">{ui(pageReasons[refused.status] || PAGE_REFUSED)}</InlineMessage>}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {!modelReady && <ReaderModelGate feature="passage" />}
      <form onSubmit={onAsk}>
        <label>{ui('针对这一页提问')}<TextArea value={question} required rows={3} disabled={asking}
          onChange={event => onQuestion?.(event.target.value, '')} placeholder={ui('输入或粘贴问题，例如：这一页的主要结论是什么？')} /></label>
        <QuickIntents chips={PAGE_INTENTS} disabled={!askReady || asking || !!refused} onAsk={(text, label, intent) => onQuick?.(text, label, intent)} />
        <FirstHint id={READER_HINTS.presets} dismiss="不再提示：预设和发给主会话">{ui('点一个预设就直接提问；图表或扫描页可以「发给主会话」，截图只在主会话能看图片时有用。')}</FirstHint>
        <Button type="submit" busy={asking} busyLabel={ui('正在回答…')} disabled={!askReady || !question.trim() || !!refused}>{ui('依据这一页回答')}</Button>
      </form>
      {cut?.truncated && <InlineMessage tone="info">{uiFormat('这一页很长，回答只读了前 {0} 字（共 {1} 字）；后面的内容请在「阅读」里选中再问。', [cut.used, cut.chars])}</InlineMessage>}
      <AskThread thread={thread} notice={notice} noticeWhy={noticeWhy} onAsk={onAskInside || noop} onRetry={onRetryNode || noop} onToggle={onToggleNode || noop} />
      {/* A quiet way out where the built-in answer cannot help: a figure, a formula drawn as a picture. */}
      {canHandOff && <HandOff id="reader.page" shape="quiet" lead="想让主会话接着讲（主会话能看图片时可附截图）：" what={HAND_OFF_WHAT} input={handOffInput} className="study-page-ask__handoff" />}
    </>}
    {/* A page without saved text has no question box to paste into. */}
    {!scope.empty && <Hint>{ui('在 PDF 里选中的文字可以复制，粘贴进问题框。模型只读这一页保存的文字，看不到图表；要看本页的图，请在「阅读」里点「看原页」查看。')}</Hint>}
  </section>;
}
