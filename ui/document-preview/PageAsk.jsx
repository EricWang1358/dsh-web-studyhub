import React, { useContext } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Hint, IconButton, InlineMessage, TextArea } from '../components/index.js';
import { HandOff } from '../hand-off/HandOff.jsx';
import { StudyServicesContext } from '../study-context.jsx';
import AskThread from './AskThread.jsx';
import QuickIntents, { PAGE_INTENTS } from './QuickIntents.jsx';
import ReaderModelGate from './ReaderModelGate.jsx';

const noop = () => {};
/** Why a page question could not be asked, in the words of a page (a selection's reasons talk about selecting again). */
export const pageReasons = {
  missing: '这一页没有可核实的已保存文字，无法依据原文回答。',
  stale: '资料已更新，请重新打开这份资料再问这一页。',
  ambiguous: '这一页对应了多段保存的文字，请切换到「阅读」选中一段再问。',
  unavailable: '当前未安装所需能力，或没有可用模型。',
};

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
  return <section className="study-document-learning study-page-ask" aria-label={ui('按页提问')} ref={sectionRef} data-scope="page">
    {list}
    {/* The page can be turned from here too: on a narrow reader the panel covers the page controls. */}
    <div className="study-page-ask__scope">
      <strong role="status" aria-live="polite">{uiFormat('正在问：第 {0} 页', [scope.page])}</strong>
      {onPage && <span className="study-page-ask__step">
        <IconButton size="sm" icon="chevron-left" label={ui('上一页')} disabled={scope.page <= 1} onClick={() => onPage(scope.page - 1)} />
        <IconButton size="sm" icon="chevron" label={ui('下一页')} disabled={!!total && scope.page >= total} onClick={() => onPage(scope.page + 1)} />
      </span>}
    </div>
    {scope.empty ? <>
      <InlineMessage tone="info">{uiFormat('第 {0} 页没有保存的文字（可能是扫描页、图片页，或导入时跳过了），无法依据原文回答。', [scope.page])}</InlineMessage>
      {/* The page is only a picture: the main chat can read the screenshot the learner pastes; here it is the way forward, not a side link. */}
      {canHandOff && <div className="study-page-ask__forward">
        <p className="muted">{ui('可以发给主会话接着问：先点下面的按钮，再截这一页的图；如果你的主会话能看图片，把截图粘贴到消息最后。')}</p>
        <HandOff id="reader.page" shape="secondary" what={HAND_OFF_WHAT_EMPTY} input={handOffEmptyInput} />
      </div>}
    </> : <>
      {refused && <InlineMessage tone="warning">{ui(pageReasons[refused.status] || '这一页暂时无法提问。')}</InlineMessage>}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {!modelReady && <ReaderModelGate feature="passage" />}
      <form onSubmit={onAsk}>
        <label>{ui('针对这一页提问')}<TextArea value={question} required rows={3} disabled={asking}
          onChange={event => onQuestion?.(event.target.value, '')} placeholder={ui('输入或粘贴问题，例如：这一页的主要结论是什么？')} /></label>
        <QuickIntents chips={PAGE_INTENTS} disabled={!askReady || asking || !!refused} onAsk={(text, label, intent) => onQuick?.(text, label, intent)} />
        <Button type="submit" busy={asking} busyLabel={ui('正在回答…')} disabled={!askReady || !question.trim() || !!refused}>{ui('依据这一页回答')}</Button>
      </form>
      {cut?.truncated && <InlineMessage tone="info">{uiFormat('这一页文字较长，回答只依据了前 {0} 字（共 {1} 字）。', [cut.used, cut.chars])}</InlineMessage>}
      <AskThread thread={thread} notice={notice} noticeWhy={noticeWhy} onAsk={onAskInside || noop} onRetry={onRetryNode || noop} onToggle={onToggleNode || noop} />
      {/* A quiet way out where the built-in answer cannot help: a figure, a formula drawn as a picture. */}
      {canHandOff && <HandOff id="reader.page" shape="quiet" lead="想让主会话接着讲（可附截图）：" what={HAND_OFF_WHAT} input={handOffInput} className="study-page-ask__handoff" />}
    </>}
    <Hint>{ui('在 PDF 里选中的文字不会自动带到这里，可以复制后粘贴进问题框。模型只读这一页保存的文字，看不到图表；要看本页图片，可在「阅读」里点「看原页」。要针对选中的一段提问、存为批注或补题，请切换到「阅读」。')}</Hint>
  </section>;
}
