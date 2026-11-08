import React, { useContext, useMemo, useState } from 'react';
import { ui } from '../i18n.js';
import { Icon, ProgressBar, Tooltip } from '../components/index.js';
import { StudyServicesContext } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';
import { activePlanCourse } from './today-header.js';
import { selectTodayFocusStrip } from './today-focus-strip.js';

export default function TodayFocusStrip({ library, today, budgetMinutes = null, focusedMinutes = null, planAnswer }) {
  const services = useContext(StudyServicesContext);
  const course = activePlanCourse(library);
  const courseName = course ? course.name : null;
  const [fetchedPlan, setFetchedPlan] = useState(null);

  useLiveEffect((isLive) => {
    if (planAnswer !== undefined || courseName === null || !services?.call) {
      setFetchedPlan(null);
      return;
    }
    services.call('course.plan', { course: courseName, date: today })
      .then((res) => { if (isLive()) setFetchedPlan(res); })
      .catch(() => { if (isLive()) setFetchedPlan(null); });
  }, [planAnswer, courseName, today, library?.revision, services]);

  const effectivePlan = planAnswer !== undefined ? planAnswer : fetchedPlan;
  const strip = useMemo(
    () => selectTodayFocusStrip({ library, planAnswer: effectivePlan, budgetMinutes, focusedMinutes }),
    [library, effectivePlan, budgetMinutes, focusedMinutes],
  );

  if (!strip.visible) return null;

  return (
    <section className="board-today__focus-strip" aria-label={ui('今天的重点')}>
      <div className="board-today__focus-main">
        <span className="board-today__focus-title">
          <span>{ui('今天的重点')}</span>
          <Tooltip layer group="today-focus-strip" content={strip.helpTooltip}>
            <span className="board-today__focus-help" tabIndex={0} role="img" aria-label={ui('重点条说明')}>
              <Icon name="help" size={14} />
            </span>
          </Tooltip>
        </span>
        {strip.chips.length > 0 && (
          <div className="board-today__focus-chips">
            {strip.chips.map((chip) => (
              <Tooltip key={chip.id} layer group="today-focus-strip" content={chip.tooltip}>
                <span className="board-chip board-today__focus-chip" data-focus-chip={chip.id} tabIndex={0}>
                  <span className="board-today__focus-chip-text">{chip.label}</span>
                </span>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
      {strip.budget && (
        <div className="board-today__focus-budget">
          <Tooltip layer group="today-focus-strip" content={strip.budget.tooltip}>
            <span className="board-today__focus-budget-label" tabIndex={0}>{strip.budget.label}</span>
          </Tooltip>
          <ProgressBar size="sm" value={strip.budget.value} max={strip.budget.max} label={strip.budget.label} />
        </div>
      )}
    </section>
  );
}
