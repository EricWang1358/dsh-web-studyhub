import React, { useEffect, useMemo, useState } from 'react';
import { ui, uiFormat, uiLocale, getUiLanguage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, InlineMessage } from './components/index.js';
import AiHelperNote from './AiHelperNote.jsx';
import { applyPathRefinement, planGenerationPath, stepTitleOf, STEP_CHARS } from '../lib/generation-path.js';
import { MATTER_WORDS, pathBrief, queueSteps, selectedItems } from './generation-path-flow.js';
import css from './generation-path.css';

/* 分步出题路径: for a selection too big to generate in one go. The app cuts it into steps from the chapters (instantly, always valid); a model can name the
   steps, say what each practises and suggest an order; the learner edits, and each step becomes its own generation job, queued in order. Or opens a conversation
   with the plan, to shape the chapters with the AI first (the search index, when built, is what lets it pick pages by topic). */

const pageRange = (from, to) => from === to ? uiFormat('第 {0} 页', [from]) : uiFormat('第 {0}–{1} 页', [from, to]);

/** The step's name in the interface language: a model's name as it is, otherwise from its parts (the same rule as the plan's own: usable chapter names, else the pages). */
export function stepTitle(step) {
  if (step.named || getUiLanguage() !== 'en') return step.title;
  const parts = step.parts || [];
  if (!parts.length) return step.title;
  return stepTitleOf(parts, { range: pageRange, front: ui('前言与目录'), join: ', ', ellipsis: ' … ' });
}

/** The pages a step covers, in the interface language, when its name does not already say so ("第 55–76 页、第 80 页" / "Pages 55–76, Page 80"). */
export function stepPages(step, title) {
  const runs = (step.ranges || []).filter(run => Number.isInteger(run?.from) && Number.isInteger(run?.to));
  if (!runs.length) return '';
  const documents = new Set(runs.map(run => run.document));
  const text = runs.map(run => (documents.size > 1 && run.document ? `${run.document} ` : '') + pageRange(run.from, run.to)).join(getUiLanguage() === 'en' ? ', ' : '、');
  return runs.length === 1 && documents.size === 1 && String(title).includes(pageRange(runs[0].from, runs[0].to)) ? '' : text;
}

const matterWord = step => ui(MATTER_WORDS[step.matter]?.zh || MATTER_WORDS.front.zh);
/** What an optional step is, in words: "可选 · 默认跳过（索引）" / "Optional · skipped by default (Index)". */
const optionalTag = step => uiFormat('可选 · 默认跳过（{0}）', [matterWord(step)]);

export default function GenerationPath({ sources, selectedIds, onUseStep, gen, course = '', goal = '', call, askInChat, indexCoverage = null, disabled = false, onQueued, setNotice, onSettings }) {
  useInjectCss(css, 'study-generation-path');
  const items = useMemo(() => selectedItems(sources, selectedIds), [sources, selectedIds]);
  const total = items.reduce((sum, item) => sum + (item.chars || 0), 0);
  const base = useMemo(() => planGenerationPath(items), [items]);
  const signature = base.steps.map(step => `${step.id}:${step.chars}`).join('|');
  const [ai, setAi] = useState(null), [aiState, setAiState] = useState({ phase: 'idle' });
  const [edits, setEdits] = useState({}), [queueing, setQueueing] = useState(false), [report, setReport] = useState(null);
  // A different selection is a different plan: nothing of the old one carries over.
  useEffect(() => { setAi(null); setEdits({}); setAiState({ phase: 'idle' }); setReport(null); }, [signature]);
  const ordered = ai ? applyPathRefinement(base.steps, { steps: ai }).steps : base.steps;
  const steps = ordered.map(step => ({ ...step, ...(edits[step.id] || {}) }));
  const included = steps.filter(step => step.included !== false);
  const indexed = !!indexCoverage && selectedIds.length > 0 && selectedIds.every(id => indexCoverage.indexed?.includes(id));
  if (!total || (total <= STEP_CHARS && base.steps.length < 2)) return null;
  const patch = (id, change) => setEdits(current => ({ ...current, [id]: { ...(current[id] || {}), ...change } }));

  async function refine() {
    setAiState({ phase: 'loading' });
    try {
      const result = await call('generate.path.suggest', { steps: base.steps.map(({ id, title, pages, chars }) => ({ id, title, pages, chars })), course, ...(goal ? { goal } : {}) });
      if (result?.source === 'model' && result.steps?.length) { setAi(result.steps); setAiState({ phase: 'done' }); }
      else setAiState({ phase: 'unavailable', unavailable: result?.unavailable || { reason: 'nothing-usable' } });
    } catch (error) { setAiState({ phase: 'unavailable', unavailable: { reason: 'failed', message: String(error?.message || error) } }); }
  }
  async function queue() {
    setQueueing(true); setReport(null);
    const result = await queueSteps(call, included, gen, { course });
    setQueueing(false); setReport(result);
    if (result.started.length) { setNotice?.({ text: uiFormat('已按顺序排队 {0} 个出题任务。', [result.started.length]), tone: 'success' }); onQueued?.(result); }
  }
  // The conversation gets every step (in the language of the screen): the ones switched off are listed as steps to skip.
  const chat = () => askInChat?.(pathBrief({ steps: steps.map(step => ({ ...step, title: stepTitle(step) })), course, goal, indexed, language: getUiLanguage() }));
  const chars = value => value.toLocaleString(uiLocale());

  return (
    <section className="gen-path" aria-labelledby="gen-path-title">
      <header className="gen-path__head">
        <h3 id="gen-path-title">{ui('分步生成路径')}</h3>
        <p className="muted">{uiFormat('所选资料共 {0} 字符，分成 {1} 步，每一步都在一次生成的上限内；按顺序一步一步出题，比一次塞进去更准。', [chars(total), steps.length])}</p>
        {indexed && <p className="gen-path__index" role="status">{ui('这些资料的检索索引已建好：对话里的 AI 可以按主题挑页面来定制章节。')}</p>}
      </header>
      <div className="gen-path__actions">
        <Button size="sm" variant="secondary" icon="sparkle" busy={aiState.phase === 'loading'} disabled={disabled || typeof call !== 'function'} onClick={refine} data-usage="generate.path-refine">
          {ai || aiState.phase === 'unavailable' ? ui('重新让 AI 优化') : ui('让 AI 优化路径')}
        </Button>
        {typeof askInChat === 'function' && <Button size="sm" variant="quiet" onClick={chat} data-usage="generate.path-chat">{ui('和 AI 聊聊怎么学')}</Button>}
      </div>
      {aiState.phase === 'unavailable' && <AiHelperNote unavailable={aiState.unavailable} fallback="先用按章节做的路径" onSettings={onSettings} />}
      {aiState.phase === 'done' && <p className="muted small" role="status">{ui('AI 给了每一步的名称、重点和顺序；都可以改。页面范围不会变。')}</p>}
      <ol className="gen-path__steps">
        {steps.map(step => (
          <li key={step.id} className="gen-path__step" data-included={step.included === false ? 'false' : 'true'} data-optional={step.optional ? 'true' : 'false'}>
            <label className="gen-path__title">
              <input type="checkbox" checked={step.included !== false} disabled={disabled} onChange={event => patch(step.id, { included: event.target.checked })} />
              <span><strong>{uiFormat('第 {0} 步', [step.order])} · {stepTitle(step)}</strong>
                {step.optional && <em className="gen-path__tag">{optionalTag(step)}</em>}
                <small>{[uiFormat('{0} 页 · {1} 字符 · 建议 {2} 题', [step.pages, chars(step.chars), step.count]), stepPages(step, stepTitle(step))].filter(Boolean).join(' · ')}</small></span>
            </label>
            {step.optional && step.included === false && <small className="gen-path__reason">{uiFormat('{0}，默认不出题；勾选就会包含这一步。', [matterWord(step)])}</small>}
            {step.reason && <small className="gen-path__reason">{step.reason}</small>}
            <div className="gen-path__edit">
              <input type="text" value={step.focus} maxLength={200} disabled={disabled} aria-label={uiFormat('第 {0} 步想练什么', [step.order])}
                placeholder={ui('这一步想练什么（可选）')} onChange={event => patch(step.id, { focus: event.target.value })} />
              <Button size="sm" variant="quiet" disabled={disabled} onClick={() => onUseStep(step)} data-usage="generate.path-use">{ui('只用这一步')}</Button>
            </div>
          </li>
        ))}
      </ol>
      <div className="gen-path__go">
        <Button variant="secondary" icon="sparkle" busy={queueing} disabled={disabled || queueing || !included.length || typeof call !== 'function'} onClick={queue} data-usage="generate.path-queue">
          {uiFormat('按路径逐步出题 · {0} 步依次排队', [included.length])}
        </Button>
        <small className="muted">{ui('每一步是一个独立的出题任务，按顺序排队；先做完的一步就可以先练。')}</small>
      </div>
      {report?.failed.length > 0 && <InlineMessage tone="warning" boxed title={uiFormat('有 {0} 步没能开始', [report.failed.length])}>
        {report.failed.map(item => `${stepTitle(item.step)}：${item.message}`).join('；')}
      </InlineMessage>}
    </section>
  );
}
