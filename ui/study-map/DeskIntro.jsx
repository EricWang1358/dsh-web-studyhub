import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { AddSourceButton, Badge, Button, Icon, Tooltip } from '../components/index.js';
import { ParkedChip, isParked } from '../CourseActive.jsx';
import CourseRoute from '../CourseRoute.jsx';
import FocusProgressLine from './FocusProgressLine.jsx';
import MethodLine from './MethodLine.jsx';
import { TERMS } from '../mastery-terms.js';
import CourseHeading from './CourseHeading.jsx';
import OutlineEntry from './OutlineEntry.jsx';
import MasteryBar from './MasteryBar.jsx';
import { HandOff } from '../hand-off/HandOff.jsx';
import { FrontDoor } from './NextStepCard.jsx';
import { META_DOT } from '../format.js';
import { useStudy } from '../study-context.jsx';
import LetterpressNumber from '../letterpress/LetterpressNumber.jsx';
import PaceMeta from '../pace/PaceMeta.jsx';
import { liteShows } from '../lite-view.js';

/** The mastery of the current course (and the whole library when it differs), with what the words mean on hover. */
function DeskMastery({ mastery, onOpenMasteryMap }) {
  const { primary, course, whole, name, others } = mastery;
  const title = `${course ? uiFormat('「{0}」的掌握度 {1}%（{2} 题）', [name || ui('未分类课程'), course.value, course.cards]) : uiFormat('所有课程的掌握度 {0}%', [primary.value])}\n${ui(TERMS.mastery.hint)}\n${ui(TERMS.mastered.hint)}`;
  return (
    <div className="desk-mastery" title={title} data-tour="home-mastery">
      <span className="desk-mastery-value">{typeof primary.value === 'number' && Number.isFinite(primary.value) ? <LetterpressNumber value={primary.value} /> : primary.value}<small>%</small></span>
      <span className="desk-mastery-label">{ui(TERMS.mastery.label)}</span>
      <MasteryBar node={primary.node} />
      {onOpenMasteryMap && <Button variant="link" size="sm" iconEnd="arrow-right" onClick={onOpenMasteryMap}>{ui('掌握图谱')}</Button>}
      {others && whole && <span className="desk-mastery-all"><Tooltip layer content={uiFormat('全部课程合计 {0} 题', [whole.cards])}><span tabIndex={0}>{ui('所有课程')}{' '}<strong>{whole.value}%</strong></span></Tooltip></span>}
    </div>
  );
}

/** Runs left half done, other than the one the card offers: resume or end each. */
function OtherRuns({ runs, otherCourse, resume, endRun }) {
  const { busy } = useStudy();
  return (
    <details className="resume-list">
      <summary>{uiFormat('另有 {0} 组练习未完成', [runs.length])}</summary>
      {runs.map((r) => (
        <div className="resume-row" key={r.id}>
          <button className="resume" disabled={busy} onClick={() => resume(r.id)}>
            <span>
              <span className="eyebrow resume__eyebrow">{[otherCourse(r) || ui('继续上次学习'), r.inactive ? ui('未激活') : ''].filter(Boolean).join(' · ')}</span>
              <strong>{r.title}</strong>
            </span>
            <span className="row-end">{r.index + 1} / {r.total}<Icon name="arrow-right" className="sh-icon--inline" /></span>
          </button>
          <Button variant="quiet" size="sm" lock={busy} onClick={() => endRun(r.id)} title={ui('结束此轮，保留已答记录')}>{ui('结束')}</Button>
        </div>
      ))}
    </details>
  );
}

/** The left of the home desk: the course heading, the way to the 总纲 beside the course title, the course route, method, mastery, the next step and the other ways to start.
    `lite` (ui/lite-view.js): the course heading and the ways to start stay; the course's extras are left out. `nextShown`: the 下一步 card is on the page. */
export default function DeskIntro({ data, home, mastery, start, resume, endRun, onFocus, onCourseSettings, onGenerateFocus, onShowOutline, onOpenMasteryMap, lite = false, nextShown = false }) {
  const { busy } = useStudy();
  const { route, starter, headline, plan, alternatives, otherRuns, otherCourse } = home;
  const currentEntry = (data.focus?.courses || []).find((course) => course.name === data.focus?.course);
  const paceForecast = data?.paceForecast;
  const focusedCourse = data.focus?.course;
  const extras = liteShows(lite, 'home.course-extras');
  // 「不知道从哪开始？」 for a learner with decks is on the 下一步 card; while the lite view draws no card, it waits under 其他开始方式.
  const frontDoor = lite && !nextShown;
  // The empty card's other way to the main chat (a file in the workspace) waits under 其他开始方式, so the surface has one hand-off (#1696).
  const folded = plan.kind === 'empty' ? plan.more || [] : [];
  const offers = plan.kind !== 'empty' && (alternatives.length > 0 || frontDoor);
  const coursePace = paceForecast
    ? (focusedCourse != null && focusedCourse !== '*'
      ? (paceForecast.courses?.[focusedCourse] || null)
      : (paceForecast.library || null))
    : null;
  return (
    <div className="desk-intro">
      <CourseHeading data={data} headline={headline} onFocus={onFocus} onCourseSettings={onCourseSettings}
        aside={extras && route?.chapters?.length && onShowOutline ? <OutlineEntry onShowOutline={onShowOutline} /> : undefined} />
      {isParked(currentEntry) && <p className="course-parked-line"><ParkedChip course={currentEntry} />
        <small>{ui('未激活的课程不进入到期复习和推荐；随时可以再激活')}</small></p>}
      {extras && <>
        {route && <CourseRoute route={route} />}
        <MethodLine method={data.focus?.method} courseId={data.focus?.courseId} onCourseSettings={onCourseSettings} />
        <FocusProgressLine progress={data.focus?.progress} courseId={data.focus?.courseId} lock={busy} start={start} onCourseSettings={onCourseSettings} onGenerateFocus={onGenerateFocus} />
        {mastery.primary && <DeskMastery mastery={mastery} onOpenMasteryMap={onOpenMasteryMap} />}
        {coursePace && <PaceMeta className="desk-pace" variant="course" forecast={coursePace} pace={paceForecast?.pace} asOf={paceForecast?.asOf} />}
      </>}
      {/* Without the extras there is no 推荐下一步; what a newcomer's empty home says about its next step stays. */}
      {(extras || (!data.next && starter)) && <p className="desk-next">
        {data.next ? (
          <>
            <span className="desk-next-label">{ui('推荐下一步')}</span>
            <span className="desk-next-topic">{data.next.deckTitle} › <strong>{data.next.topic}</strong>{data.next.focus ? <> <Badge size="sm" tone="accent">{ui('重点')}</Badge></> : null}
              <Tooltip layer content={ui('按课程里题组和主题的顺序，这是第一个还没掌握的主题。')}><small tabIndex={0}>{META_DOT}{uiFormat('课程里下一个没掌握的主题 · 掌握 {0}%', [data.next.mastery])}</small></Tooltip></span>
            <Button variant="link" iconEnd="arrow-right" lock={busy} onClick={() => start({ mode: 'path', scope: [{ deckId: data.next.deckId, topic: data.next.topic }] })}>{ui('只学这个主题')}</Button>
          </>
        ) : starter ? starter.next : ui('现在没有未掌握的主题，可以提前巩固。')}
      </p>}
      {plan.kind === 'empty' && plan.also.length > 0 && (
        <p className="desk-also">
          {/* The other ways in beside 再添加资料 are text actions like it, so they are ink too (sh-btn--ink; the hand-off link by .desk-also in desk.css) and one size: one row, one system (#1074). */}
          {plan.also.map((entry) => (Array.isArray(entry) ? <Button key={entry[0]} variant="link" className="sh-btn--ink" icon={entry[2]} lock={busy} onClick={entry[1]}>{entry[0]}</Button>
            : <AddSourceButton key={entry.label} more variant="link" lock={busy} onClick={entry.onClick} />))}
        </p>
      )}
      {plan.kind === 'empty' && <p className="desk-also"><FrontDoor /></p>}
      {(offers || folded.length > 0) && (
        <details className="desk-more">
          <summary>{ui('其他开始方式')}</summary>
          {folded.length > 0 && <p className="desk-also">
            {folded.map(({ handOff }) => <HandOff key={handOff.id} id={handOff.id} input={handOff.input} lead={handOff.lead} what={handOff.what} copyLabel={handOff.copyLabel} size="md" disabled={busy} />)}
          </p>}
          {offers && alternatives.length > 0 && <p className="desk-also">
            {alternatives.map(([label, run, hint]) => {
              const btn = <Button key={label} variant="link" lock={busy} onClick={run}>{label}</Button>;
              return hint ? <Tooltip key={label} layer content={hint}>{btn}</Tooltip> : btn;
            })}
          </p>}
          {offers && frontDoor && <p className="desk-also"><FrontDoor /></p>}
        </details>
      )}
      {otherRuns.length > 0 && <OtherRuns runs={otherRuns} otherCourse={otherCourse} resume={resume} endRun={endRun} />}
    </div>
  );
}
