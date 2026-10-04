import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button } from './components/Button.jsx';
import { InlineMessage } from './components/Feedback.jsx';
import { normalizeRoot } from './board/meta.js';
import { Adjustment, Profile } from './daily-plan/Editors.jsx';
import css from './daily-plan.css';

const estimated = minutes => uiFormat('约 {0} 分钟', [minutes]);
const actionable = task => task.status !== 'done' && task.available !== false;
const nextAction = tasks => tasks.find(task => actionable(task) && task.status === 'doing') || tasks.find(actionable);
const sameReference = (left, right) => left && right && normalizeRoot(left.root) === normalizeRoot(right.root) && left.kind === right.kind &&
  ['id', 'deckId', 'cardId', 'sessionId', 'runId', 'course'].every(key => left[key] === right[key]);

function TaskProgress({ task }) {
  return <span className="daily-plan__meta">{estimated(task.minutes)}
    {task.progress?.total > 0 && ` · ${task.progress.done}/${task.progress.total}`}
    {task.status === 'done' && ` · ${ui('已完成')}`}
    {task.actualMinutes !== undefined && ` · ${uiFormat('实际 {0} 分钟', [task.actualMinutes])}`}
    {task.archived ? ` · ${ui('已归档')}` : task.available === false && ` · ${ui('内容已不可用')}`}
  </span>;
}

function ActualTime({ task, plan }) {
  const [minutes, setMinutes] = useState(task.actualMinutes ?? '');
  return <details className="daily-plan__actual"><summary>{ui('记录实际用时')}</summary>
    <form onSubmit={event => {
      event.preventDefault();
      if (minutes !== '' && Number.isInteger(Number(minutes)) && Number(minutes) > 0 && Number(minutes) <= 240) void plan.complete(task.id, Number(minutes));
    }}><label>{ui('实际学习分钟数')}<input type="number" min="1" max="240" required value={minutes} disabled={!!plan.busy}
      onChange={event => setMinutes(event.target.value)} /></label>
      <Button type="submit" size="sm" disabled={!!plan.busy || minutes === ''}>{ui('保存用时')}</Button></form>
  </details>;
}

function TaskRow({ task, plan, featured }) {
  return <li className={`daily-plan__task${task.status === 'done' ? ' is-done' : ''}`}>
    <div className="daily-plan__task-copy"><strong>{task.title}</strong><TaskProgress task={task} />
      {task.status === 'done' && task.available !== false && <ActualTime task={task} plan={plan} />}
    </div>
    {actionable(task) && !featured && <Button variant="quiet" size="sm" disabled={!!plan.busy} onClick={() => plan.start(task.id)}>
      {task.status === 'doing' ? ui('继续') : ui('开始')}</Button>}
  </li>;
}

/** Learning pages already opened the content: keep the connection, omit duplicate launch controls. */
export function RelatedTasks({ plan, reference, runId, onBoard }) {
  useInjectCss(css, 'study-daily-plan');
  const tasks = (plan.state?.tasks || []).filter(task => runId ? task.runId === runId : sameReference(task.studyRef, reference));
  if (!tasks.length) return null;
  return <aside className="daily-related" aria-label={ui('相关学习待办')}>
    {plan.error && <InlineMessage tone="error">{plan.error}</InlineMessage>}
    {tasks.map(task => <div className="daily-related__row" key={task.id}>
      <div className="daily-plan__task-copy"><span className="daily-plan__eyebrow">{ui('今日行动')}</span>
        <strong>{task.title}</strong><TaskProgress task={task} /></div>
      {task.kind === 'reading' && actionable(task) && <Button size="sm" disabled={!!plan.busy} onClick={() => plan.complete(task.id)}>{ui('我已完成')}</Button>}
    </div>)}
    {onBoard && <Button variant="link" size="sm" onClick={onBoard}>{ui('查看待办')}</Button>}
  </aside>;
}

function Proposal({ proposal, plan }) {
  const total = proposal.items.reduce((sum, item) => sum + item.minutes, 0);
  return <div className="daily-plan__proposal">
    <p className="daily-plan__eyebrow">{proposal.method === 'ai' ? ui('AI 为你建议') : ui('本地建议')} · {ui('尚未加入待办')}</p>
    <h3>{uiFormat('{0} 项行动，约 {1} 分钟', [proposal.items.length, total])}</h3>
    {proposal.summary && <p className="daily-plan__intro">{proposal.summary}</p>}
    <ol>{proposal.items.map((item, index) => <li key={item.candidateId || index}>
      <div><strong>{item.title}</strong><p>{item.reason}</p></div><span className="daily-plan__meta">{estimated(item.minutes)}</span>
    </li>)}</ol>
    {!proposal.items.length && <p>{plan.state.budgetMinutes === 0 ? ui('今天休息，已有待办留待之后安排。') : ui('这份建议没有新增行动。')}</p>}
    <Button variant="primary" busy={plan.busy === 'accept'} disabled={!!plan.busy} onClick={() => plan.accept(proposal.id)}>{ui('接受这份安排')}</Button>
  </div>;
}

function NextAction({ task, plan }) {
  const remainingQuestions = (task.progress?.total || 0) - (task.progress?.done || 0);
  const heading = task.kind === 'practice' && remainingQuestions > 0 ? uiFormat('完成 {0} 道练习', [remainingQuestions]) : task.title;
  return <div className="daily-plan__next" data-next-task={task.id}>
    <p className="daily-plan__eyebrow">{task.status === 'doing' ? ui('正在进行') : ui('接下来')}</p>
    <h3>{heading}</h3>
    {heading !== task.title && <p className="daily-plan__subject">{task.title}</p>}
    {task.reason && <p className="daily-plan__intro">{task.reason}</p>}
    <div className="daily-plan__next-bottom"><TaskProgress task={task} />
      <div className="daily-plan__actions"><Button variant="primary" busy={plan.busy === 'start'} disabled={!!plan.busy} onClick={() => plan.start(task.id)}>
        {task.status === 'doing' ? ui('继续学习') : ui('开始学习')}</Button>
        {task.kind === 'reading' && <Button variant="quiet" disabled={!!plan.busy} onClick={() => plan.complete(task.id)}>{ui('我已完成')}</Button>}
      </div>
    </div>
  </div>;
}

function EmptyPlan({ plan, modelReady }) {
  const tasks = plan.state.tasks || [];
  const blocked = tasks.some(task => task.status !== 'done');
  let message = ui('根据待复习、薄弱点和未完成行动，先给你一份适合今天学习量的建议。接受后才加入待办。');
  if (tasks.length) message = blocked ? ui('有行动暂时无法继续，请调整今天的安排。') :
    ui('今天的行动告一段落。按自己的节奏继续，也可以让 AI 重新安排。');
  return <div className="daily-plan__empty"><p>{message}</p>
    <Button variant={tasks.length && !blocked ? 'secondary' : 'primary'} busy={plan.busy === 'suggest'}
      disabled={!!plan.busy || !modelReady} onClick={() => plan.suggest({})}>{ui('请 AI 安排今天')}</Button>
  </div>;
}

export default function DailyPlan({ plan, onBoard, modelReady = true, openModelSettings }) {
  useInjectCss(css, 'study-daily-plan');
  const [editor, setEditor] = useState(null);
  const editorId = useId();
  const adjustmentButton = useRef(null), profileButton = useRef(null);
  const returnFocus = useRef(null);
  useEffect(() => {
    // Request completion must commit enabled controls before focus can return to the trigger.
    if (!editor && !plan.busy && returnFocus.current) {
      returnFocus.current.focus();
      returnFocus.current = null;
    }
  }, [editor, plan.busy]);
  const state = plan.state, proposal = state?.proposal, tasks = state?.tasks || [];
  const next = nextAction(tasks);
  const completed = tasks.filter(task => task.status === 'done').length;
  const spent = Math.max(0, state?.spentMinutes || 0), budget = state?.budgetMinutes || 0;
  const closeEditor = () => {
    returnFocus.current = (editor === 'adjust' ? adjustmentButton : profileButton).current;
    setEditor(null);
  };
  return <section className="daily-plan" aria-label={ui('今日学习安排')} aria-busy={!!plan.busy}>
    <header className="daily-plan__heading">
      <h2>{ui('今天先做什么')}</h2>
      {state && <div className="daily-plan__pace"><strong>{budget === 0 ? ui('今天休息') : uiFormat('今天剩余约 {0} 分钟', [Math.max(0, budget - spent)])}</strong>
        <span>{uiFormat('已投入约 {0} / {1} 分钟', [spent, budget])}</span></div>}
    </header>
    {state && budget > 0 && <progress className="daily-plan__meter" max={budget} value={Math.min(budget, spent)} aria-label={ui('今日学习进度')} />}
    {plan.error && <InlineMessage tone="error" boxed action={{ label: ui('重试'), onClick: plan.refresh, disabled: !!plan.busy }}>{plan.error}</InlineMessage>}
    {!state ? !plan.error && <p role="status">{ui('正在读取学习安排…')}</p> : <>
      {proposal ? <Proposal proposal={proposal} plan={plan} /> : next ? <NextAction task={next} plan={plan} /> : <EmptyPlan plan={plan} modelReady={modelReady} />}
      {[...new Set([...(state.warnings || []), ...(proposal?.warnings || [])])].map(warning => <InlineMessage key={warning} tone="warning">{warning}</InlineMessage>)}
      {tasks.length > 0 && <details className="daily-plan__list"><summary>{uiFormat('完整安排 · 已完成 {0}/{1}', [completed, tasks.length])}</summary>
        <ul className="daily-plan__tasks">{tasks.map(task => <TaskRow key={task.id} task={task} plan={plan} featured={!proposal && task.id === next?.id} />)}</ul>
        <p className="daily-plan__footnote">{ui('练习进度按实际作答计算；完成行动不代表已经掌握。')}</p>
      </details>}
      <footer className="daily-plan__tools">
        <Button ref={adjustmentButton} variant="link" size="sm" disabled={!!plan.busy || !modelReady} aria-expanded={editor === 'adjust'} aria-controls={editorId}
          onClick={() => setEditor(editor === 'adjust' ? null : 'adjust')}>{ui('调整今天')}</Button>
        <Button ref={profileButton} variant="link" size="sm" disabled={!!plan.busy} aria-expanded={editor === 'profile'} aria-controls={editorId}
          onClick={() => setEditor(editor === 'profile' ? null : 'profile')}>{ui('学习量习惯')}</Button>
        {onBoard && <Button variant="link" size="sm" onClick={onBoard}>{ui('查看待办')}</Button>}
      </footer>
      <div id={editorId} onKeyDown={event => { if (event.key === 'Escape' && !plan.busy) { event.stopPropagation(); closeEditor(); } }}>
        {editor === 'adjust' && <Adjustment plan={plan} onClose={closeEditor} />}
        {editor === 'profile' && <Profile plan={plan} onClose={closeEditor} />}
      </div>
      {!modelReady && <InlineMessage tone="info" action={openModelSettings ? { label: ui('打开模型设置'), onClick: openModelSettings } : undefined}>
        {ui('配置模型后可以协商安排；已接受的行动可以继续。')}</InlineMessage>}
    </>}
  </section>;
}
