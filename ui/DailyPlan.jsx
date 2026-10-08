import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button } from './components/Button.jsx';
import { DisclosureToggle, foldLabel } from './components/DisclosureToggle.jsx';
import { Disclosure } from './components/Panel.jsx';
import { Field, NumberInput } from './components/Field.jsx';
import { Hint } from './components/Hint.jsx';
import { LoadingState } from './components/Loading.jsx';
import Menu from './components/Menu.jsx';
import { ProgressBar } from './components/Progress.jsx';
import { InlineMessage } from './components/Feedback.jsx';
import ModelErrorNote from './ModelErrorNote.jsx';
import ModelSetupGate from './ModelSetupGate.jsx';
import { usePersistentState } from './storage.js';
import { useStudy } from './study-context.jsx';
import { normalizeRoot } from './board/meta.js';
import { Adjustment, Profile } from './daily-plan/Editors.jsx';
import css from './daily-plan.css';

/* 今天先做什么. Folded to one hairline row by default (the home's one focal object is the day's paper card); open, it is plain sections
   under hairlines, never a box. `primaryAction` says whether this block may hold the screen's one filled button: the Board has no other
   (the default), the home passes false because its today card owns it. */
const OPEN_KEY = 'study-daily-plan:open';
const estimated = minutes => uiFormat('约 {0} 分钟', [minutes]);
const actionable = task => task.status !== 'done' && task.available !== false;
const nextAction = tasks => tasks.find(task => actionable(task) && task.status === 'doing') || tasks.find(actionable);
const sameReference = (left, right) => left && right && normalizeRoot(left.root) === normalizeRoot(right.root) && left.kind === right.kind &&
  ['id', 'deckId', 'cardId', 'sessionId', 'runId', 'course'].every(key => left[key] === right[key]);
/* The warning older proposals carry when the AI call failed; a proposal with `failure` says it better, so this line is dropped there. */
const AI_UNAVAILABLE = [
  'AI 建议暂不可用，以下是依据已有内容和时间预算的本地建议。调整意见尚未由 AI 处理。',
  'AI suggestions are unavailable. This local proposal uses existing content and your time budget; AI has not processed your feedback.',
];

function TaskProgress({ task }) {
  return <span className="daily-plan__meta">{estimated(task.minutes)}
    {task.progress?.total > 0 && ` · ${task.progress.done}/${task.progress.total}`}
    {task.status === 'done' && ` · ${ui('已完成')}`}
    {task.actualMinutes !== undefined && ` · ${uiFormat('实际 {0} 分钟', [task.actualMinutes])}`}
    {task.archived ? ` · ${ui('已归档')}` : task.available === false && ` · ${ui('内容已不可用')}`}
  </span>;
}

/* 记录实际用时: one compact row (minutes with its unit, 保存) behind a Disclosure; the recorded value shows in the disclosure's meta. */
function ActualTime({ task, plan }) {
  const [minutes, setMinutes] = useState(String(task.actualMinutes ?? task.minutes ?? ''));
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const valid = minutes !== '' && Number.isInteger(Number(minutes)) && Number(minutes) >= 1 && Number(minutes) <= 240;
  return <Disclosure className="daily-plan__actual" summary={ui('记录实际用时')} open={open} onToggle={setOpen}
    meta={task.actualMinutes !== undefined ? uiFormat('已记录 {0} 分钟', [task.actualMinutes]) : undefined}>
    <form className="daily-plan__actual-form" onSubmit={async event => {
      event.preventDefault();
      if (!valid) return;
      setFailed(false);
      if (await plan.complete(task.id, Number(minutes))) setOpen(false); else setFailed(true);
    }}>
      <Field inline width="sm" label={ui('实际用了')}>
        <NumberInput suffix={ui('分钟')} min="1" max="240" step="1" required value={minutes} disabled={!!plan.busy} onChange={event => setMinutes(event.target.value)} />
      </Field>
      <Button type="submit" size="sm" disabled={!!plan.busy || !valid}>{ui('保存')}</Button>
    </form>
    {failed && <Hint tone="error" role="alert">{ui('没能保存用时，请再试一次。')}</Hint>}
  </Disclosure>;
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

/** Why the AI could not plan, next to the local suggestion that stands in for it: the reason, the fix, the provider's own words. */
function PlanFailure({ failure, plan, onSettings }) {
  const again = () => plan.suggest({});
  const retry = plan.busy ? undefined : again;
  if (failure.kind === 'invalid-response' || failure.kind === 'unknown') {
    return <InlineMessage tone="warning" className="daily-plan__failure" title={failure.kind === 'unknown' ? ui('AI 建议暂不可用') : ui('AI 给出的安排没有通过检查')}
      action={retry && { label: ui('再试一次'), onClick: retry }}>
      {failure.kind === 'unknown' ? ui('下面是依据已有内容和时间预算的本地建议，可以再请 AI 安排一次。') : ui('AI 选了不可用的内容或格式不对，没有采用。下面是本地建议，可以再请 AI 安排一次。')}
      {failure.message && <Disclosure summary={ui('技术详情')}><code className="daily-plan__raw">{failure.message}</code></Disclosure>}
    </InlineMessage>;
  }
  return <ModelErrorNote error={failure.message} className="daily-plan__failure" onSettings={onSettings} onRetry={retry} />;
}

/* A proposal with no action is not a plan waiting to be accepted: it says why (the day's time is used up, or there is nothing to schedule)
   and what to do next. `emptyReason` comes from lib/daily-plan/proposal.js. */
function EmptyProposal({ proposal, plan, onSettings, onAdjust }) {
  const { navigate, openModal } = useStudy();
  const { budgetMinutes: budget, spentMinutes } = plan.state, spent = Math.max(0, spentMinutes || 0);
  const reason = proposal.emptyReason || 'declined';
  const title = reason === 'budget' ? (budget === 0 ? ui('今天休息') : ui('今天的学习时间快用完了'))
    : reason === 'nothing-due' ? ui('没有到期复习或待学内容') : ui('这份建议没有新增行动');
  const why = reason === 'budget' ? (budget === 0 ? ui('今天安排为休息日，已有待办留待之后安排。') : uiFormat('今天已投入约 {0} / {1} 分钟，剩下的时间不够再安排一项行动。', [spent, budget]))
    : reason === 'nothing-due' ? ui('学习库里没有到期的复习，也没有待学的内容。可以导入新资料，或去学习库看看。') : ui('可以调整时间或意见，再请 AI 安排一次。');
  return <div className="daily-plan__proposal daily-plan__proposal--empty" data-empty-reason={reason}>
    {proposal.failure && <PlanFailure failure={proposal.failure} plan={plan} onSettings={onSettings} />}
    <h3>{title}</h3>
    {proposal.summary && <p className="daily-plan__intro">{proposal.summary}</p>}
    <p className="daily-plan__intro">{why}</p>
    <div className="daily-plan__actions">
      {reason === 'nothing-due' ? <>
        <Button variant="secondary" disabled={!!plan.busy} onClick={() => navigate('library')}>{ui('去学习库')}</Button>
        <Button variant="quiet" disabled={!!plan.busy} onClick={() => openModal({ type: 'add' })}>{ui('导入资料')}</Button>
      </> : <>
        <Button variant="secondary" disabled={!!plan.busy || !onAdjust} onClick={onAdjust}>{ui('今天再学一会儿')}</Button>
        <Button variant="quiet" busy={plan.busy === 'accept'} disabled={!!plan.busy} onClick={() => plan.accept(proposal.id)}>{ui('今天到此为止')}</Button>
      </>}
    </div>
  </div>;
}

function Proposal({ proposal, plan, primary, onSettings, onAdjust }) {
  if (!proposal.items.length) return <EmptyProposal proposal={proposal} plan={plan} onSettings={onSettings} onAdjust={onAdjust} />;
  const total = proposal.items.reduce((sum, item) => sum + item.minutes, 0);
  return <div className="daily-plan__proposal">
    <p className="daily-plan__eyebrow">{proposal.method === 'ai' ? ui('AI 为你建议') : ui('本地建议')} · {ui('尚未加入待办')}</p>
    {proposal.failure && <PlanFailure failure={proposal.failure} plan={plan} onSettings={onSettings} />}
    <h3>{uiFormat('{0} 项行动，约 {1} 分钟', [proposal.items.length, total])}</h3>
    {proposal.summary && <p className="daily-plan__intro">{proposal.summary}</p>}
    <ol>{proposal.items.map((item, index) => <li key={item.candidateId || index}>
      <div><strong>{item.title}</strong><p>{item.reason}</p></div><span className="daily-plan__meta">{estimated(item.minutes)}</span>
    </li>)}</ol>
    <Button variant={primary ? 'primary' : 'secondary'} busy={plan.busy === 'accept'} disabled={!!plan.busy} onClick={() => plan.accept(proposal.id)}>{ui('接受这份安排')}</Button>
  </div>;
}

function NextAction({ task, plan, primary }) {
  const remainingQuestions = (task.progress?.total || 0) - (task.progress?.done || 0);
  const heading = task.kind === 'practice' && remainingQuestions > 0 ? uiFormat('完成 {0} 道练习', [remainingQuestions]) : task.title;
  return <div className="daily-plan__next" data-next-task={task.id}>
    <p className="daily-plan__eyebrow">{task.status === 'doing' ? ui('正在进行') : ui('接下来')}</p>
    <h3>{heading}</h3>
    {heading !== task.title && <p className="daily-plan__subject">{task.title}</p>}
    {task.reason && <p className="daily-plan__intro">{task.reason}</p>}
    <div className="daily-plan__next-bottom"><TaskProgress task={task} />
      <div className="daily-plan__actions"><Button variant={primary ? 'primary' : 'secondary'} busy={plan.busy === 'start'} disabled={!!plan.busy} onClick={() => plan.start(task.id)}>
        {task.status === 'doing' ? ui('继续学习') : ui('开始学习')}</Button>
        {task.kind === 'reading' && <Button variant="quiet" disabled={!!plan.busy} onClick={() => plan.complete(task.id)}>{ui('我已完成')}</Button>}
      </div>
    </div>
  </div>;
}

function EmptyPlan({ plan, modelReady, primary }) {
  const tasks = plan.state.tasks || [];
  const blocked = tasks.some(task => task.status !== 'done');
  let message = ui('根据待复习、薄弱点和未完成行动，先给你一份适合今天学习量的建议。接受后才加入待办。');
  if (tasks.length) message = blocked ? ui('有行动暂时无法继续，请调整今天的安排。') :
    ui('今天的行动告一段落。按自己的节奏继续，也可以让 AI 重新安排。');
  return <div className="daily-plan__empty"><p>{message}</p>
    <Button variant={primary && !(tasks.length && !blocked) ? 'primary' : 'secondary'} busy={plan.busy === 'suggest'}
      disabled={!!plan.busy || !modelReady} onClick={() => plan.suggest({})}>{ui('请 AI 安排今天')}</Button>
  </div>;
}

/** The one line the folded block shows: the minutes left and what comes next (or that a plan waits to be accepted). */
function summaryOf({ state, plan, next, proposal, budget, spent }) {
  if (!state) return plan.error ? '' : ui('正在读取学习安排…');
  const empty = proposal && !proposal.items.length;
  // A proposal without actions is not waiting for anything: the row says where the day stands instead.
  if (empty && proposal.emptyReason === 'budget' && budget > 0) return uiFormat('今天已投入 {0} / {1} 分钟', [spent, budget]);
  const parts = [budget === 0 ? ui('今天休息') : uiFormat('今天剩余约 {0} 分钟', [Math.max(0, budget - spent)])];
  if (empty) { if (proposal.emptyReason === 'nothing-due') parts.push(ui('没有到期复习或待学内容')); }
  else if (proposal) parts.push(ui('有一份安排等你接受'));
  else if (next) parts.push(uiFormat('下一步：{0}', [next.title]));
  return parts.join(' · ');
}

export default function DailyPlan({ plan, onBoard, modelReady = true, openModelSettings, primaryAction = true }) {
  useInjectCss(css, 'study-daily-plan');
  const [open, setOpen] = usePersistentState(OPEN_KEY, false);
  const [editor, setEditor] = useState(null);
  const editorId = useId(), bodyId = useId();
  const menuTrigger = useRef(null);
  const returnFocus = useRef(null);
  useEffect(() => {
    // Request completion must commit enabled controls before focus can return to the trigger.
    if (!editor && !plan.busy && returnFocus.current) {
      returnFocus.current.focus?.();
      returnFocus.current = null;
    }
  }, [editor, plan.busy]);
  const state = plan.state, proposal = state?.proposal, tasks = state?.tasks || [];
  const next = nextAction(tasks);
  const completed = tasks.filter(task => task.status === 'done').length;
  const spent = Math.max(0, state?.spentMinutes || 0), budget = state?.budgetMinutes || 0;
  const closeEditor = () => {
    returnFocus.current = menuTrigger.current?.current || null;
    setEditor(null);
  };
  const choose = id => {
    if (id === 'board') { onBoard?.(); return; }
    setOpen(true);
    setEditor(current => current === id ? null : id);
  };
  const items = [
    { id: 'adjust', label: ui('调整今天'), disabled: !!plan.busy || !modelReady },
    { id: 'profile', label: ui('学习量习惯'), disabled: !!plan.busy },
    ...(onBoard ? [{ id: 'board', label: ui('查看待办') }] : []),
  ];
  const warnings = [...new Set([...(state?.warnings || []), ...(proposal?.warnings || [])])]
    .filter(warning => !(proposal?.failure && AI_UNAVAILABLE.includes(warning)));
  const summary = summaryOf({ state, plan, next, proposal, budget, spent });
  return <section className={`daily-plan${open ? ' is-open' : ''}`} aria-label={ui('今日学习安排')} aria-busy={!!plan.busy}>
    <header className="daily-plan__heading">
      <DisclosureToggle open={open} onToggle={setOpen} controls={bodyId} label={foldLabel(open, ui('今天先做什么'))} />
      <h2>{ui('今天先做什么')}</h2>
      {summary && <p className="daily-plan__summary">{summary}</p>}
      {state && <Menu className="daily-plan__menu" label={ui('调整')} items={items} onSelect={choose}
        trigger={({ props, ref }) => { menuTrigger.current = ref; return <Button ref={ref} variant="quiet" size="sm" {...props}>{ui('调整')}</Button>; }} />}
    </header>
    <div id={bodyId} className="daily-plan__body" hidden={!open}>
      {state && budget > 0 && <div className="daily-plan__pace">
        <span>{uiFormat('已投入约 {0} / {1} 分钟', [spent, budget])}</span>
        <ProgressBar className="daily-plan__meter" size="sm" value={Math.min(budget, spent)} max={budget} label={ui('今日学习进度')} />
      </div>}
      {plan.error && <InlineMessage tone="error" boxed action={{ label: ui('重试'), onClick: plan.refresh, disabled: !!plan.busy }}>{plan.error}</InlineMessage>}
      {!state ? !plan.error && <LoadingState label={ui('正在读取学习安排…')} /> : <>
        {proposal ? <Proposal proposal={proposal} plan={plan} primary={primaryAction} onSettings={openModelSettings} onAdjust={modelReady ? () => choose('adjust') : undefined}
          /> : next ? <NextAction task={next} plan={plan} primary={primaryAction} /> : <EmptyPlan plan={plan} modelReady={modelReady} primary={primaryAction} />}
        {warnings.map(warning => <InlineMessage key={warning} tone="warning">{warning}</InlineMessage>)}
        {tasks.length > 0 && <details className="daily-plan__list"><summary>{uiFormat('完整安排 · 已完成 {0}/{1}', [completed, tasks.length])}</summary>
          <ul className="daily-plan__tasks">{tasks.map(task => <TaskRow key={task.id} task={task} plan={plan} featured={!proposal && task.id === next?.id} />)}</ul>
          <p className="daily-plan__footnote">{ui('练习进度按实际作答计算；完成行动不代表已经掌握。')}</p>
        </details>}
        <div id={editorId} onKeyDown={event => { if (event.key === 'Escape' && !plan.busy) { event.stopPropagation(); closeEditor(); } }}>
          {editor === 'adjust' && <Adjustment plan={plan} onClose={closeEditor} />}
          {editor === 'profile' && <Profile plan={plan} onClose={closeEditor} />}
        </div>
        {!modelReady && <ModelSetupGate variant="compact" feature="plan" model={{ ready: false }} onOpenSettings={openModelSettings} />}
      </>}
    </div>
  </section>;
}
