import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';

/*
 * First-level questions in one click, for a selected passage (阅读) and for a page (原始 PDF, issue #456): a chip asks at once, like the follow-up chips
 * under an answer (typing a question of one's own still takes the box and the button). The chip's name stays with the thread as the first step of its
 * path; hovering or focusing a chip says the exact question it sends. A chip with an `intent` also chooses a fixed instruction of the ask
 * (lib/ask-prompt.js ASK_INTENTS); the passage chips have none and send exactly what they sent before.
 */

/** The chips of a selected passage (catalogue keys). */
export const PASSAGE_INTENTS = Object.freeze([
  { label: '没听懂', question: '这段我没听懂，请按原文顺序讲一下。' },
  { label: '举个例子', question: '请依据这段原文举一个例子。' },
  { label: '为什么', question: '为什么会这样？请依据这段原文回答。' },
  { label: '和什么有区别', question: '这里的内容和什么容易混淆？有什么区别？' },
]);

/** The chips of a page (built in; no learner-made presets yet). */
export const PAGE_INTENTS = Object.freeze([
  { label: '讲解这一页', question: '请按原文顺序讲解这一页。', intent: 'explain' },
  // A quick answer about this page's saved text; the reader's own 翻译 (toolbar, kept per version, with a glossary) is the whole-document translation.
  { label: '翻译这一页', question: '请把这一页完整翻译过来，保持原来的顺序。', intent: 'translate', note: '这是对这一页保存文字的一次回答，不会保存；整份资料的对照翻译在「阅读」工具栏的「翻译」里。' },
  { label: '按知识点拆分这一页', question: '请把这一页按知识点拆开，每个知识点用一两句话说清。', intent: 'points' },
  { label: '提取这一页的公式与代码', question: '请把这一页的公式和代码原样提取出来，并说明各自的用途。', intent: 'extract' },
]);

/** chips: one of the lists above; onAsk(question, label, intent); onQuiz: the 出题考我 jump (a passage only). */
export default function QuickIntents({ chips = PASSAGE_INTENTS, onAsk, onQuiz, disabled = false }) {
  const chip = ({ label, question, intent, note }) => <Tooltip key={label} layer group="ask-help" content={<span className="ask-tip"><span>{uiFormat('点击即发送：「{0}」', [ui(question)])}</span>{note && <span>{ui(note)}</span>}</span>}>
    <Button size="sm" disabled={disabled} onClick={() => onAsk(ui(question), ui(label), intent)}>{ui(label)}</Button>
  </Tooltip>;
  return <div className="ask-quick" role="group" aria-label={ui('快捷提问')}>
    {chips.map(chip)}
    {onQuiz && <Tooltip layer group="ask-help" content={<span className="ask-tip"><span>{ui('跳到下面的「补充到现有题组」。')}</span><span>{ui('不会自动出题。')}</span></span>}>
      <Button size="sm" onClick={onQuiz}>{ui('出题考我')}</Button>
    </Tooltip>}
  </div>;
}
