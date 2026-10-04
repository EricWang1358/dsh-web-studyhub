import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, SegmentedControl } from '../components/index.js';
import { ParkedChip, isParked } from '../CourseActive.jsx';
import CourseRoute from '../CourseRoute.jsx';
import { TERMS } from '../mastery-terms.js';
import CourseHeading from './CourseHeading.jsx';
import RoleSuggestion from './RoleSuggestion.jsx';
import MasteryBar from './MasteryBar.jsx';

/** The mastery of the current course (and the whole library when it differs), with what the words mean on hover. */
function DeskMastery({ mastery }) {
  const { primary, course, whole, name, others } = mastery;
  const title = `${course ? uiFormat('「{0}」的掌握度 {1}%（{2} 题）', [name || ui('未分类课程'), course.value, course.cards]) : uiFormat('所有课程的掌握度 {0}%', [primary.value])}\n${ui(TERMS.mastery.hint)}\n${ui(TERMS.mastered.hint)}`;
  return (
    <div className="desk-mastery" title={title}>
      <span className="desk-mastery-value">{primary.value}<small>%</small></span>
      <span className="desk-mastery-label">{ui(TERMS.mastery.label)}</span>
      <MasteryBar node={primary.node} />
      {others && whole && <span className="desk-mastery-all" title={uiFormat('全部课程合计 {0} 题', [whole.cards])}>{ui('所有课程 ')}<strong>{whole.value}%</strong></span>}
    </div>
  );
}

/** Runs left half done, other than the one the card offers: resume or end each. */
function OtherRuns({ runs, otherCourse, busy, resume, endRun }) {
  return (
    <details className="resume-list">
      <summary>{ui('另有 ')}{runs.length}{ui(' 组练习未完成')}</summary>
      {runs.map((r) => (
        <div className="resume-row" key={r.id}>
          <button className="resume" disabled={busy} onClick={() => resume(r.id)}>
            <span>
              <span className="eyebrow">{[otherCourse(r) || ui('继续上次学习'), r.inactive ? ui('未激活') : ''].filter(Boolean).join(' · ')}</span>
              <strong>{r.title}</strong>
            </span>
            <span>{r.index + 1} / {r.total} <b>→</b></span>
          </button>
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => endRun(r.id)} title={ui('结束此轮，保留已答记录')}>{ui('结束')}</Button>
        </div>
      ))}
    </details>
  );
}

/** The left of the home desk: study mode, the course (or role) heading, the course route, mastery, the next step and the other ways to start. */
export default function DeskIntro({ data, home, mastery, role, busy, start, resume, endRun, onFocus, onCourseSettings, suggestRole }) {
  const { interview, route, starter, headline, plan, alternatives, otherRuns, otherCourse } = home;
  const currentEntry = (data.focus?.courses || []).find((course) => course.name === data.focus?.course);
  return (
    <div className="desk-intro">
      {/* The study-mode switch matters once there is something to study (P12). */}
      {(data.decks.length > 0 || interview) && <SegmentedControl className="focus-switch" label={ui('学习模式')} value={interview ? 'interview' : 'class'}
        onChange={(mode) => onFocus?.({ mode })} options={[{ value: 'class', label: ui('课堂跟学') }, { value: 'interview', label: ui('笔试 / 面试') }]} />}
      <CourseHeading data={data} headline={headline} onFocus={onFocus} onCourseSettings={onCourseSettings} role={role} />
      {!interview && isParked(currentEntry) && <p className="course-parked-line"><ParkedChip course={currentEntry} />
        <small>{ui('未激活的课程不进入到期复习和推荐；随时可以再激活')}</small></p>}
      {interview && <RoleSuggestion data={data} role={role.draft} suggestRole={suggestRole} onFocus={onFocus} start={start} />}
      {route && <CourseRoute route={route} busy={busy} onStartChapter={(deckId) => start({ mode: 'course', deckId, fresh: true })} />}
      {mastery.primary && <DeskMastery mastery={mastery} />}
      <p className="desk-next">
        {data.next ? (
          <>
            <span className="desk-next-label">{ui('推荐下一步')}</span>
            <span className="desk-next-topic">{data.next.deckTitle} › <strong>{data.next.topic}</strong>
              <small title={ui('按课程里题组和主题的顺序，这是第一个还没掌握的主题。')}>{uiFormat(' · 课程里下一个没掌握的主题 · 掌握 {0}%', [data.next.mastery])}</small></span>
            <Button variant="link" disabled={busy} onClick={() => start({ mode: 'path', scope: [{ deckId: data.next.deckId, topic: data.next.topic }] })}>{ui('只学这个主题 →')}</Button>
          </>
        ) : starter ? starter.next : ui('所有主题都已掌握，可以提前巩固。')}
      </p>
      {plan.kind === 'empty' && plan.also.length > 0 && (
        <p className="desk-also">
          {plan.also.map(([label, run]) => <Button key={label} variant="link" disabled={busy} onClick={run}>{label}</Button>)}
        </p>
      )}
      {plan.kind !== 'empty' && alternatives.length > 0 && (
        <details className="desk-more">
          <summary>{ui('其他开始方式')}</summary>
          <p className="desk-also">
            {alternatives.map(([label, run, hint]) => <Button key={label} variant="link" disabled={busy} title={hint} onClick={run}>{label}</Button>)}
          </p>
        </details>
      )}
      {otherRuns.length > 0 && <OtherRuns runs={otherRuns} otherCourse={otherCourse} busy={busy} resume={resume} endRun={endRun} />}
    </div>
  );
}
