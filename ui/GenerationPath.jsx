import React, { useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Disclosure, Tooltip } from './components/index.js';
import AiHelperNote from './AiHelperNote.jsx';
import { useStudy } from './study-context.jsx';
import { matterWord, stepPages, stepTitle } from './generation-path-titles.js';
import css from './generation-path.css';
import { formatNumber } from './format.js';

/* 分步出题: the steps of a selection too big for one generation, as one block of 创建题组 (ui/TooBigChoice.jsx). The app cuts them from the chapters (instantly, always
   valid); a model can name the steps, say what each practises and suggest an order; the learner edits. What happens to them (state, queuing) is ui/use-generation-path.js and the
   one button that queues them is the form's own submit button; this panel draws the steps and the two helpers that shape them. */

export { stepTitle, stepPages };

/** More regular steps than this are folded behind 显示全部 N 步. */
const LIST_LIMIT = 8;

/** What an optional step is, in words: "可选 · 默认跳过（索引）" / "Optional · skipped by default (Index)". */
const optionalTag = step => uiFormat('可选 · 默认跳过（{0}）', [matterWord(step)]);

function Step({ step, disabled, patch, onUseStep }) {
  const title = stepTitle(step);
  return (
    <li className="gen-path__step" data-included={step.included === false ? 'false' : 'true'} data-optional={step.optional ? 'true' : 'false'}>
      <label className="gen-path__title">
        <input type="checkbox" checked={step.included !== false} disabled={disabled} onChange={event => patch(step.id, { included: event.target.checked })} />
        <span><strong>{uiFormat('第 {0} 步', [step.order])} · {title}</strong>
          {step.optional && <em className="gen-path__tag">{optionalTag(step)}</em>}
          <small>{[uiFormat('{0} 页 · {1} 字符 · 建议 {2} 题', [step.pages, formatNumber(step.chars), step.count]), stepPages(step, title)].filter(Boolean).join(' · ')}</small></span>
      </label>
      {step.optional && step.included === false && <small className="gen-path__reason">{uiFormat('{0}，默认不出题；勾选就会包含这一步。', [matterWord(step)])}</small>}
      {step.reason && <small className="gen-path__reason">{step.reason}</small>}
      <div className="gen-path__edit">
        <input type="text" value={step.focus} maxLength={200} disabled={disabled} aria-label={uiFormat('第 {0} 步想练什么', [step.order])}
          placeholder={ui('这一步想练什么（可选）')} onChange={event => patch(step.id, { focus: event.target.value })} />
        <Tooltip layer placement="bottom-end" content={ui('把选择缩到这一步的页面，回到普通出题（会离开分步模式），题数用这一步的建议题数')}>
          <Button size="sm" variant="quiet" disabled={disabled} onClick={() => onUseStep(step)} data-usage="generate.path-use">{ui('只出这一步')}</Button>
        </Tooltip>
      </div>
    </li>
  );
}

/** Props: path (useGenerationPath), disabled, onUseStep(step), onSettings (the model setup, when the AI helper has nothing to answer with). */
export default function GenerationPath({ path, disabled = false, onUseStep, onSettings }) {
  const { call, askInChat } = useStudy();
  useInjectCss(css, 'study-generation-path');
  const [showAll, setShowAll] = useState(false);
  if (!path?.available) return null;
  const { steps, indexed, ai, aiState, patch } = path;
  const regular = steps.filter(step => !step.optional), optional = steps.filter(step => step.optional);
  const listed = showAll ? regular : regular.slice(0, LIST_LIMIT);
  const words = [...new Set(optional.map(matterWord))], ticked = optional.filter(step => step.included !== false).length;
  const row = step => <Step key={step.id} step={step} disabled={disabled} patch={patch} onUseStep={onUseStep} />;
  return (
    <section className="gen-path" aria-label={ui('分步出题')}>
      <header className="gen-path__head">
        <p className="muted">{uiFormat('分成 {0} 步，每一步都在一次生成的上限内；按顺序一步一步出题，比一次塞进去更准。', [steps.length])}</p>
        {indexed && <p className="gen-path__index" role="status">{ui('这些资料的检索索引已建好：对话里的 AI 可以按主题挑页面来定制章节。')}</p>}
      </header>
      <div className="gen-path__actions">
        <Button size="sm" variant="secondary" icon="sparkle" busy={aiState.phase === 'loading'} disabled={disabled || typeof call !== 'function'} onClick={path.refine} data-usage="generate.path-refine">
          {ai || aiState.phase === 'unavailable' ? ui('重新让 AI 优化') : ui('让 AI 优化路径')}
        </Button>
        {typeof askInChat === 'function' && <Button size="sm" variant="quiet" onClick={path.chat} data-usage="generate.path-chat">{ui('和 AI 聊聊怎么学')}</Button>}
      </div>
      {aiState.phase === 'unavailable' && <AiHelperNote unavailable={aiState.unavailable} fallback="先用按章节做的路径" onSettings={onSettings} />}
      {aiState.phase === 'done' && <p className="muted small" role="status">{ui('AI 给了每一步的名称、重点和顺序；都可以改。页面范围不会变。')}</p>}
      <ol className="gen-path__steps">{listed.map(row)}</ol>
      {regular.length > LIST_LIMIT && <Button size="sm" variant="link" aria-expanded={showAll} onClick={() => setShowAll(open => !open)}>
        {showAll ? ui('收起') : uiFormat('显示全部 {0} 步', [regular.length])}</Button>}
      {optional.length > 0 && <Disclosure className="gen-path__optional" summary={uiFormat('{0} 个可选步骤默认跳过（{1}等）', [optional.length, words.slice(0, 2).join(ui('、'))])}
        meta={ticked ? uiFormat('已勾选 {0} 个', [ticked]) : undefined}>
        <ol className="gen-path__steps">{optional.map(row)}</ol>
      </Disclosure>}
    </section>
  );
}
