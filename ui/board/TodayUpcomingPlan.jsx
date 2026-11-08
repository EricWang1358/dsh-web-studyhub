import React, { useMemo, useState } from 'react';
import { ui } from '../i18n.js';
import { Button, Icon } from '../components/index.js';
import { selectTodayUpcomingPlan } from './today-upcoming-plan.js';
import { useTodayCoursePlan } from './use-today-course-plan.js';

export default function TodayUpcomingPlan({ library, today, planAnswer, onOpenPlan }) {
  const effectivePlan = useTodayCoursePlan(library, today, planAnswer);
  const [narrowOpen, setNarrowOpen] = useState(false);

  const model = useMemo(
    () => selectTodayUpcomingPlan({ library, planAnswer: effectivePlan }),
    [library, effectivePlan],
  );

  if (!model.visible) return null;

  const toggleButton = (
    <Button
      variant="quiet"
      size="sm"
      iconEnd={<Icon name="chevron-down" size={14} className="board-upcoming__caret" />}
      className="board-upcoming__more-toggle"
      aria-expanded={narrowOpen}
      onClick={() => setNarrowOpen((open) => !open)}
    >
      {ui('更多 · 备考计划')}
    </Button>
  );

  if (model.kind === 'empty') {
    return (
      <section
        className="board-upcoming board-upcoming--empty"
        aria-label={ui('备考计划 · 接下来')}
        data-plan-state="empty"
        data-narrow-open={narrowOpen ? 'true' : 'false'}
      >
        {toggleButton}
        <div className="board-upcoming__panel">
          <p className="board-upcoming__quiet">
            <span className="board-upcoming__quiet-text">{ui('还没有备考计划')}</span>
            <Button
              variant="link"
              size="sm"
              className="board-upcoming__link"
              disabled={!onOpenPlan}
              onClick={() => onOpenPlan?.(model.course)}
            >
              {ui('建一个备考计划')}
            </Button>
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      className="board-upcoming"
      aria-label={ui('备考计划 · 接下来')}
      data-plan-state="plan"
      data-narrow-open={narrowOpen ? 'true' : 'false'}
    >
      {toggleButton}
      <div className="board-upcoming__panel">
        <header className="board-upcoming__head">
          <h3 className="board-upcoming__title">{ui('备考计划 · 接下来')}</h3>
          <Button
            variant="link"
            size="sm"
            className="board-upcoming__link"
            disabled={!onOpenPlan}
            onClick={() => onOpenPlan?.(model.course)}
          >
            {ui('打开备考计划')}
          </Button>
        </header>
        {model.weeklyLine && <p className="board-upcoming__week">{model.weeklyLine}</p>}
        {model.days.length > 0 ? (
          <ul className="board-upcoming__list" aria-label={ui('接下来几天')}>
            {model.days.map((day) => (
              <li key={day.date} className="board-upcoming__day" data-mode={day.mode}>
                <span className="board-upcoming__date">{day.dateLabel}</span>
                <span className="board-upcoming__summary">{day.summary}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="board-upcoming__empty">{model.emptyNote}</p>
        )}
      </div>
    </section>
  );
}
