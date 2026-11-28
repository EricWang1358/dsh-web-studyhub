import React, { useEffect, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Disclosure, LoadingState, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import PointGaps from '../coverage/PointGaps.jsx';
import { pointsLine, prereqMark, prereqTip, unavailableLine } from '../coverage/point-words.js';
import css from './book-point-gaps.css';

/* 知识点查缺 inside 复习全书 (ui/book/BookPage.jsx): reuses the shared PointGaps component (ui/coverage/PointGaps.jsx) for the course summary, uncovered list and
   「补这些知识点」 top-up with token estimate, and adds a collapsible per-chapter / per-section breakdown so the learner can inspect chapter/section coverage,
   jump directly to any missing chapter/section/point, or top up a single chapter or section directly from the Review Book. */

const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0);

function GapMicroBar({ published = 0, drafted = 0, total = 0 }) {
  const pubPct = pct(published, total);
  const draftPct = Math.max(0, Math.min(100 - pubPct, pct(drafted, total)));
  return (
    <span className="book-gaps__bar" aria-hidden="true">
      {pubPct > 0 && <i className="book-gaps__bar-fill" style={{ width: `${pubPct}%` }} />}
      {draftPct > 0 && <i className="book-gaps__bar-draft" style={{ width: `${draftPct}%` }} />}
    </span>
  );
}

function GroupMeta({ group }) {
  return (
    <span className="book-gaps__meta">
      <GapMicroBar published={group.published ?? group.covered} drafted={group.drafted ?? 0} total={group.points} />
      <span>{uiFormat('{0}/{1} 有题', [group.covered, group.points])}</span>
      {group.uncovered > 0 && <span className="book-gaps__gap-num">{uiFormat('缺 {0}', [group.uncovered])}</span>}
      {group.drafted > 0 && <span>{uiFormat('含 {0} 草稿', [group.drafted])}</span>}
    </span>
  );
}

function MissingLinks({ items, onGo }) {
  if (!items?.length) return null;
  return (
    <ul className="book-gaps__missing" aria-label={ui('本章还没有题的知识点')}>
      {items.map((point) => (
        <li key={point.id} className="book-gaps__missing-item" data-gap-point={point.id}>
          {onGo && point.hid
            ? <Button variant="link" size="sm" wrap className="book-gaps__missing-go" data-gap-jump={point.hid} onClick={() => onGo(point.hid)}>
              {point.number ? `${point.number} ` : ''}{point.title}
            </Button>
            : <span>{point.number ? `${point.number} ` : ''}{point.title}</span>}
          {point.dependents > 0 && <Tooltip layer content={prereqTip(point)}><Badge tone="neutral" size="sm" tabIndex={0}>{prereqMark()}</Badge></Tooltip>}
          {!point.coverable && <span className="book-gaps__missing-note">{ui('补不了')}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * course: current course name; report: `course.book.open`'s `pointGaps` (lib/evidence/point-report.js coursePointReport);
 * disabled: busy / model not ready / job running; modelReady; fillingJob: active point top-up job for this course or null;
 * onTopUp(pointIds, options); onGo(hid); onOutline(); onOpenTask(jobId).
 */
export default function BookPointGaps({ course, report, disabled = false, modelReady = true, fillingJob = null, onTopUp, onGo, onOutline, onOpenTask }) {
  useInjectCss(css, 'study-book-point-gaps');
  const [foldOpen, setFoldOpen] = useState(Boolean(fillingJob));
  useEffect(() => {
    if (fillingJob) setFoldOpen(true);
  }, [fillingJob]);
  if (course === null || course === undefined || !report) return null;
  if (report.status !== 'ok') {
    const line = unavailableLine(report.reason);
    if (!line) return null;
    return (
      <div className="book-gaps book-gaps--quiet" data-book-point-gaps={report.reason}>
        <PointGaps course={course} report={report} />
        {onOutline && <Button icon="arrow-left" variant="link" size="sm" onClick={onOutline}>{ui('回到总纲')}</Button>}
      </div>
    );
  }
  if (!report.points) return null;
  const chapters = Array.isArray(report.chapters) ? report.chapters : [];
  const labelOf = (group) => [group.number, group.title].filter(Boolean).join(' ');
  const fillGroup = (group) => {
    if (!group?.topUp || !onTopUp) return;
    onTopUp(group.topUp.pointIds, {
      title: uiFormat('{0} · 补知识点', [group.title || course]),
      label: group.title || course,
      questions: group.topUp.questions,
    });
  };
  return (
    <section className="book-gaps book-gaps--compact" aria-label={ui('知识点查缺')} data-book-point-gaps="ok">
      <details className="book-gaps__fold" open={foldOpen} onToggle={(e) => setFoldOpen(e.currentTarget.open)}>
        <summary className="book-gaps__summary">
          <span className="book-gaps__summary-title">{ui('知识点查缺')}</span>
          <span className="book-gaps__summary-line">{pointsLine(report, 'course')}</span>
          <span className="book-gaps__meta">{uiFormat('{0}/{1}', [report.covered, report.points])}</span>
        </summary>
        <div className="book-gaps__body">
          <PointGaps
            course={course}
            report={report}
            disabled={disabled || !!fillingJob}
            modelReady={modelReady}
            onTopUp={onTopUp}
            onOpenPoint={onGo ? (point) => point.hid && onGo(point.hid) : null}
          />
          {fillingJob && (
            <p className="book-gaps__running" role="status" data-book-gaps-running="">
              <LoadingState inline label={ui('正在按知识点补题…')} />
              {onOpenTask && <Button iconEnd="arrow-right" variant="link" size="sm" onClick={() => onOpenTask(fillingJob.id)}>{ui('看进度')}</Button>}
            </p>
          )}
          {chapters.length > 0 && (
            <Disclosure
              summary={ui('按章节查缺')}
              meta={uiFormat('{0}/{1}', [report.covered, report.points])}
              className="book-gaps__chapters"
              data-book-gaps-chapters=""
            >
              <ul className="book-gaps__chapter-list">
                {chapters.map((chapter) => (
                  <li key={chapter.id} className="book-gaps__chapter" data-gap-chapter={chapter.id} data-uncovered={chapter.uncovered}>
                    <div className="book-gaps__row">
                      {onGo && chapter.hid
                        ? <Button variant="quiet" size="sm" wrap className="book-gaps__title" data-gap-jump={chapter.hid} onClick={() => onGo(chapter.hid)}>
                          {labelOf(chapter)}
                        </Button>
                        : <span className="book-gaps__title">{labelOf(chapter)}</span>}
                      <GroupMeta group={chapter} />
                      {chapter.topUp && onTopUp && (
                        <Button
                          size="sm"
                          variant="quiet"
                          iconEnd="arrow-right"
                          disabled={disabled || !!fillingJob}
                          data-chapter-topup={chapter.id}
                          onClick={() => fillGroup(chapter)}
                        >
                          {uiFormat('补本章（约 {0} 题）', [chapter.topUp.questions])}
                        </Button>
                      )}
                    </div>
                    {chapter.sections?.length > 0 && (
                      <ul className="book-gaps__sections" aria-label={ui('按小节查缺')}>
                        {chapter.sections.map((section) => (
                          <li key={section.id} className="book-gaps__row" data-gap-section={section.id} data-uncovered={section.uncovered}>
                            {onGo && section.hid
                              ? <Button variant="quiet" size="sm" wrap className="book-gaps__title book-gaps__title--section" data-gap-jump={section.hid} onClick={() => onGo(section.hid)}>
                                {labelOf(section)}
                              </Button>
                              : <span className="book-gaps__title book-gaps__title--section">{labelOf(section)}</span>}
                            <GroupMeta group={section} />
                            {section.topUp && onTopUp && (
                              <Button
                                size="sm"
                                variant="quiet"
                                iconEnd="arrow-right"
                                disabled={disabled || !!fillingJob}
                                data-section-topup={section.id}
                                onClick={() => fillGroup(section)}
                              >
                                {ui('补本节')}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {chapter.missing?.length > 0 && <MissingLinks items={chapter.missing} onGo={onGo} />}
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      </details>
    </section>
  );
}
