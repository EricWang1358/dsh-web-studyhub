import React, { useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button } from './components/Button.jsx';
import { InlineMessage } from './components/Feedback.jsx';
import { normalizeRoot } from './board/meta.js';
import css from './daily-plan.css';

const estimated = (minutes) => uiFormat('约 {0} 分钟', [minutes]);
const sameReference = (left, right) => left && right && normalizeRoot(left.root) === normalizeRoot(right.root) && left.kind === right.kind &&
  ['id', 'deckId', 'cardId', 'sessionId', 'runId', 'course'].every(key => left[key] === right[key]);

function Task({ task, plan }) {
  const [actualMinutes, setActualMinutes] = useState('');
  const done = task.status === 'done';
  const unavailable = task.available === false;
  return <li className={`daily-plan__task${done ? ' is-done' : ''}`}>
    <div className="daily-plan__task-copy"><strong>{task.title}</strong>
      {task.reason && <p>{task.reason}</p>}
      <span className="daily-plan__meta">{estimated(task.minutes)}
        {task.progress?.total > 0 && ` · ${task.progress.done}/${task.progress.total}`}
        {done && ` · ${ui('已完成')}`}
        {task.actualMinutes !== undefined && ` · ${uiFormat('实际 {0} 分钟', [task.actualMinutes])}`}
        {task.archived ? ` · ${ui('已归档')}` : unavailable && ` · ${ui('内容已不可用')}`}
      </span>
      {done && !unavailable && <details className="daily-plan__actual"><summary>{ui('记录实际用时')}</summary>
        <form onSubmit={event => {
          event.preventDefault();
          const value = Number(actualMinutes);
          if (actualMinutes !== '' && Number.isInteger(value) && value > 0 && value <= 240) void plan.complete(task.id, value);
        }}><label>{ui('实际学习分钟数')}<input type="number" min="1" max="240" required value={actualMinutes} disabled={!!plan.busy}
          onChange={event => setActualMinutes(event.target.value)} /></label>
          <Button type="submit" size="sm" disabled={!!plan.busy || actualMinutes === ''}>{ui('保存用时')}</Button></form>
      </details>}
    </div>
    {!done && !unavailable && <div className="daily-plan__task-actions">
      <Button size="sm" disabled={!!plan.busy} onClick={() => plan.start(task.id)}>{task.status === 'doing' ? ui('继续') : ui('开始')}</Button>
      {task.kind === 'reading' && <Button variant="quiet" size="sm" disabled={!!plan.busy} onClick={() => plan.complete(task.id)}>{ui('我已完成')}</Button>}
    </div>}
  </li>;
}

export function RelatedTasks({ plan, reference, runId, onBoard }) {
  useInjectCss(css, 'study-daily-plan');
  const tasks = (plan.state?.tasks || []).filter(task => runId ? task.runId === runId : sameReference(task.studyRef, reference));
  if (!tasks.length) return null;
  return <aside className="daily-related" aria-label={ui('相关学习待办')}>
    <div className="daily-plan__heading"><strong>{ui('相关学习待办')}</strong>
      {onBoard && <Button variant="link" size="sm" onClick={onBoard}>{ui('查看待办')}</Button>}</div>
    {plan.error && <InlineMessage tone="error">{plan.error}</InlineMessage>}
    <ul className="daily-plan__tasks">{tasks.map(task => <Task key={task.id} task={task} plan={plan} />)}</ul>
    <small>{ui('练习进度按实际作答计算；完成行动不代表已经掌握。')}</small>
  </aside>;
}

function Profile({ plan, profile, onClose }) {
  const [weekday, setWeekday] = useState(profile.weekdayMinutes);
  const [weekend, setWeekend] = useState(profile.weekendMinutes);
  const valid = [weekday, weekend].every(value => value !== '' && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 240);
  return <form className="daily-plan__profile" onSubmit={async event => {
    event.preventDefault();
    if (valid && await plan.saveProfile({ weekdayMinutes: Number(weekday), weekendMinutes: Number(weekend) })) onClose();
  }}>
    <p>{ui('长期习惯单独保存。今天的调整不会改掉它。')}</p>
    <div className="daily-plan__fields">
      <label>{ui('工作日（分钟）')}<input type="number" min="0" max="240" required value={weekday} onChange={event => setWeekday(event.target.value)} /></label>
      <label>{ui('周末（分钟）')}<input type="number" min="0" max="240" required value={weekend} onChange={event => setWeekend(event.target.value)} /></label>
    </div>
    {(profile.observedWeekdayMinutes || profile.observedWeekendMinutes) && <p>{uiFormat('根据已完成日的记录：工作日约 {0} 分钟，周末约 {1} 分钟。可以据此调整，系统不会自动覆盖。',
      [profile.observedWeekdayMinutes || '—', profile.observedWeekendMinutes || '—'])}</p>}
    <div className="daily-plan__actions"><Button type="submit" size="sm" disabled={!valid || !!plan.busy}>{ui('保存长期习惯')}</Button>
      <Button variant="quiet" size="sm" disabled={!!plan.busy} onClick={onClose}>{ui('取消')}</Button></div>
  </form>;
}

export default function DailyPlan({ plan, onBoard, modelReady = true, openModelSettings }) {
  useInjectCss(css, 'study-daily-plan');
  const [feedback, setFeedback] = useState('');
  const [minutes, setMinutes] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const state = plan.state, proposal = state?.proposal;
  const validMinutes = minutes === '' || (Number.isInteger(Number(minutes)) && Number(minutes) >= 0 && Number(minutes) <= 240);
  const total = proposal?.items?.reduce((sum, item) => sum + item.minutes, 0) || 0;
  const tasks = state?.tasks || [];
  return <section className="daily-plan" aria-label={ui('今日学习安排')} aria-busy={!!plan.busy}>
    <div className="daily-plan__heading">
      <div><p className="daily-plan__eyebrow">{ui('AI 建议，你来决定')}</p><h2>{ui('今日学习安排')}</h2></div>
      {state && <div className="daily-plan__heading-actions"><span>{uiFormat('今天约 {0} 分钟', [state.budgetMinutes])}</span>
        <Button variant="quiet" size="sm" disabled={!!plan.busy} aria-expanded={profileOpen} onClick={() => setProfileOpen(!profileOpen)}>{ui('学习量习惯')}</Button>
        {onBoard && <Button variant="link" size="sm" onClick={onBoard}>{ui('查看待办')}</Button>}</div>}
    </div>
    {plan.error && <InlineMessage tone="error" boxed action={{ label: ui('重试'), onClick: plan.refresh, disabled: !!plan.busy }}>{plan.error}</InlineMessage>}
    {!state ? !plan.error && <p role="status">{ui('正在读取学习安排…')}</p> : <>
      {profileOpen && <Profile plan={plan} profile={state.profile} onClose={() => setProfileOpen(false)} />}
      {tasks.length > 0 && <><h3>{ui('已接受的行动')}</h3><ul className="daily-plan__tasks">{tasks.map(task => <Task key={task.id} task={task} plan={plan} />)}</ul>
        <p className="daily-plan__footnote">{ui('练习进度按实际作答计算；完成行动不代表已经掌握。')}</p></>}
      {proposal && <div className="daily-plan__proposal">
        <div className="daily-plan__heading"><h3>{proposal.method === 'ai' ? ui('AI 为你建议') : ui('本地建议')}</h3><span>{estimated(total)} · {ui('尚未加入待办')}</span></div>
        {proposal.summary && <p>{proposal.summary}</p>}
        <ol>{proposal.items.map((item, index) => <li key={item.candidateId || index}><div><strong>{item.title}</strong><p>{item.reason}</p></div><span>{estimated(item.minutes)}</span></li>)}</ol>
        {!proposal.items.length && <p>{state.budgetMinutes === 0 ? ui('今天休息，已有待办留待之后安排。') : ui('这份建议没有新增行动。')}</p>}
        <Button variant="primary" busy={plan.busy === 'accept'} disabled={!!plan.busy} onClick={() => plan.accept(proposal.id)}>{ui('接受这份安排')}</Button>
      </div>}
      {[...new Set([...(state.warnings || []), ...(proposal?.warnings || [])])].map(warning => <InlineMessage key={warning} tone="warning">{warning}</InlineMessage>)}
      {!proposal && !tasks.length && <p className="daily-plan__intro">{ui('根据待复习、薄弱点和未完成行动，先给你一份适合今天学习量的建议。接受后才加入待办。')}</p>}
      <form className="daily-plan__adjust" onSubmit={async event => {
        event.preventDefault();
        if (validMinutes && await plan.suggest({ ...(minutes !== '' ? { minutes: Number(minutes) } : {}), feedback: feedback.trim(), ...(proposal ? { proposalId: proposal.id } : {}) })) setMinutes('');
      }}>
        <label>{ui('告诉 AI 你的想法')}<textarea value={feedback} maxLength={2000} rows="2" disabled={!!plan.busy} placeholder={ui('例如：今天先顾考试，少安排阅读')} onChange={event => setFeedback(event.target.value)} /></label>
        <div className="daily-plan__adjust-bottom"><label className="daily-plan__minutes">{ui('只调整今天')}<input type="number" min="0" max="240" value={minutes} placeholder={String(state.budgetMinutes)} disabled={!!plan.busy} onChange={event => setMinutes(event.target.value)} /><span>{ui('分钟')}</span></label>
          <Button type="submit" variant={proposal ? 'secondary' : 'primary'} busy={plan.busy === 'suggest'} disabled={!!plan.busy || !validMinutes || !modelReady}>
            {proposal || tasks.length ? ui('按我的意见重新建议') : ui('请 AI 安排今天')}</Button></div>
        {!modelReady && <InlineMessage tone="info" action={openModelSettings ? { label: ui('打开模型设置'), onClick: openModelSettings } : undefined}>{ui('配置模型后可以协商安排；已接受的行动可以继续。')}</InlineMessage>}
        <p className="daily-plan__footnote">{ui('只发送内容标题和学习进度等摘要，不发送资料全文。预计时长是估计，未完成行动会占用当天预算。')}</p>
      </form>
    </>}
  </section>;
}
