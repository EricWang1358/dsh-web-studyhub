import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Tooltip } from '../components/index.js';
import { HandOff } from '../hand-off/HandOff.jsx';
import { useInjectCss } from '../shared.js';
import CrunchDay from './CrunchDay.jsx';
import { countdownText, dayKind } from './crunch-words.js';
import { crunchStartOf, handsToCrunch, planKind, shortDate, upcomingDays } from './plan-model.js';
import css from './book-plan.css';

/* 备考计划 on the review book page (docs/review-book.md): the course's whole-period plan (course.plan, lib/course-plan.js) under the book bar. The strategy is the
   learner's, agreed in the chat and saved there (course.save {plan}); this section only shows it: the countdown, how many points are learnt and placed, the
   points that did not fit, the phases, today's day (the same day component as 期末一周) and the next days. Read only; no model call.
   One flow with 期末一周: the plan covers the whole period, and from the day the final week begins (the exam within `windowDays`) the daily part is 期末一周's:
   the plan lists its days only up to that day and then points at 今天读哪几节, so a day is never said twice.
   Without a plan, or without an exam date, it is one quiet line that points at the exam date (the same way the 更多 menu has) and at 发给主会话: the plan is
   drafted with the AI in the chat, there is no form here.
   plan: the course.plan answer; course; windowDays (settings.book.crunchWindowDays); open / onToggle (the fold, kept by the page); onRefresh; onExamDate (opens the
   course settings; none: the line offers only the hand-off); onToday (opens 今天读哪几节; none: the final week's day is not read yet); the day's handlers as
   CrunchDay's (onRead, onPractice, onMarkRead, onFlip, onMockStarted). */

const HAND_OFF_DRAFT = '让主会话和你一起定备考计划；你同意之后才会存。';
const HAND_OFF_REVISE = '让主会话和你一起看这份计划要不要改；你同意之后才会存。';

const handOffInput = (plan, course) => ({ course, examDate: plan?.examDate ?? null, hasPlan: !!plan?.plan });

/** The quiet line: one sentence, at most two links. */
function QuietLine({ kind, plan, course, onExamDate }) {
  const input = handOffInput(plan, course);
  return (
    <p className="book-plan book-plan--quiet" data-plan={kind}>
      {kind === 'invite' && <><span>{ui('还没有备考计划：和主会话一起定一份，它会按考试日期和各节的掌握情况来排。')}</span>
        <HandOff id="course.plan" input={input} what={HAND_OFF_DRAFT} /></>}
      {kind === 'need-exam' && <><span>{ui('备考计划要先有考试日期。')}</span>
        {onExamDate && <Button variant="link" size="sm" onClick={onExamDate}>{ui('设置考试日期')}</Button>}
        <HandOff id="course.plan" input={input} what={HAND_OFF_DRAFT} lead="再和主会话一起定：" /></>}
      {kind === 'past' && <span>{ui('考试日期已过，备考计划不再排日子。')}</span>}
    </p>
  );
}

/** What one later day holds, in a few words. */
const summary = item => (item.mode === 'mock' ? ui('整套模拟卷') : item.mode === 'off' ? '' : !item.points.length ? ui('没有新的节') : uiFormat('{0} 节 · 约 {1} 分钟', [item.points.length, item.minutes]));

function Head({ answer, schedule, open, onToggle, onRefresh, windowDays }) {
  const status = answer.plan?.status ?? 'active', { progress, coverage } = schedule;
  return (
    <p className="book-plan__head">
      <Tooltip layer content={uiFormat('备考计划管从开始到考试的整段时间；考前 {0} 天起每天读什么由「期末一周」排。', [windowDays])}>
        <Button variant="link" size="sm" className="book-plan__title" aria-expanded={open} onClick={onToggle}>{ui('备考计划')}</Button>
      </Tooltip>
      <span className="book-plan__countdown">{countdownText(schedule.daysLeft)}</span>
      {status === 'paused' && <Badge size="sm">{ui('已暂停')}</Badge>}
      {status === 'done' && <Badge size="sm" tone="success">{ui('已完成')}</Badge>}
      <Tooltip layer content={ui('已学：一天里答够 5 道题（题不到 5 道就答完）或标了「读完了」的节。已排：已学的，加上计划里有学习日可放的节。')}>
        <span className="book-plan__coverage" tabIndex={0}>{uiFormat('已学 {0}/{1} 节 · 已排 {2}/{1} 节', [progress.learnt, progress.total, coverage.scheduled])}</span>
      </Tooltip>
      {coverage.unplaced.length > 0 && <Tooltip layer content={ui('计划里没有学习日可以放这几节（休息日太多，或离考试太近）。它们仍会出现在考试日的复习里。')}>
        <Badge size="sm" tone="warning" tabIndex={0}>{uiFormat('{0} 节没排下', [coverage.unplaced.length])}</Badge>
      </Tooltip>}
      <Tooltip layer content={ui('按现在的做题和标记重新排一遍。')}>
        <Button variant="quiet" size="sm" className="book-plan__refresh" onClick={onRefresh}>{ui('刷新')}</Button>
      </Tooltip>
    </p>
  );
}

function Phases({ schedule }) {
  if (schedule.phases.length < 2) return null;
  const current = schedule.today?.phase;
  return (
    <ul className="book-plan__phases" aria-label={ui('阶段')}>
      {schedule.phases.map(phase => <li key={phase.name} className="book-plan__phase" data-current={phase.name === current ? '' : undefined}>
        <strong>{phase.name}</strong>
        <span className="book-plan__range">{`${shortDate(phase.from)}–${phase.until === schedule.examDate ? ui('考试') : shortDate(phase.until)}`}</span>
        {phase.goal && <span className="book-plan__goal">{phase.goal}</span>}
      </li>)}
    </ul>
  );
}

/** The daily part: the final week's (one line pointing at it) or the plan's own (today, then the next days up to the final week). */
function Days({ answer, schedule, windowDays, course, onToday, todayOpen, ...handlers }) {
  if (handsToCrunch(schedule.daysLeft, windowDays)) {
    return (
      <p className="book-plan__handover">
        <span>{uiFormat('已进入考前 {0} 天：每天读什么由「期末一周」排。', [windowDays])}</span>
        {onToday && <Button variant="link" size="sm" aria-pressed={!!todayOpen} onClick={onToday}>{ui('今天读哪几节')}</Button>}
      </p>
    );
  }
  const before = crunchStartOf(schedule.examDate, windowDays), today = schedule.today && schedule.today.date < before ? schedule.today : null;
  const byId = new Map((answer.points || []).map(point => [point.id, point])), points = (today?.points || []).map(id => byId.get(id)).filter(Boolean);
  const next = upcomingDays(schedule, before, 7);
  return (
    <>
      {today && <CrunchDay course={course} day={today} points={points} onRead={handlers.onRead} onPractice={handlers.onPractice} onMarkRead={handlers.onMarkRead}
        onFlip={handlers.onFlip} onMockStarted={handlers.onMockStarted} />}
      {next.length > 0 && <ul className="book-plan__next" aria-label={ui('接下来几天')}>
        {next.map(item => <li key={item.date} className="book-plan__day" data-mode={item.mode}>
          <span className="book-plan__date">{shortDate(item.date)}</span> <span className="book-plan__kind">{dayKind(item)}</span>
          {summary(item) && <span className="book-plan__summary">{summary(item)}</span>}
        </li>)}
      </ul>}
      <p className="book-plan__note">{uiFormat('{0} 起是期末一周，每天读什么到时另排。', [shortDate(before)])}</p>
    </>
  );
}

export default function PlanSection({ plan, course, windowDays, open = true, onToggle, onRefresh, onExamDate, onToday, todayOpen = false, ...handlers }) {
  useInjectCss(css, 'study-book-plan');
  const kind = planKind(plan);
  if (!kind || !course) return null;
  if (kind !== 'plan') return <QuietLine kind={kind} plan={plan} course={course} onExamDate={onExamDate} />;
  const { schedule } = plan, active = (plan.plan?.status ?? 'active') === 'active';
  return (
    <section className="book-plan" aria-label={ui('备考计划')} data-open={open ? '' : undefined} data-plan="plan">
      <Head answer={plan} schedule={schedule} open={open} onToggle={onToggle} onRefresh={onRefresh} windowDays={windowDays} />
      {open && <>
        <Phases schedule={schedule} />
        {active && <Days answer={plan} schedule={schedule} windowDays={windowDays} course={course} onToday={onToday} todayOpen={todayOpen} {...handlers} />}
        <p className="book-plan__revise"><HandOff id="course.plan" input={handOffInput(plan, course)} what={HAND_OFF_REVISE} lead="想调整这份计划：" /></p>
      </>}
    </section>
  );
}
