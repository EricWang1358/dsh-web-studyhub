import React, { useMemo } from 'react';
import { ui } from '../i18n.js';
import { Button, Icon, ProgressBar, Tooltip } from '../components/index.js';
import { selectTodayFocusStrip } from './today-focus-strip.js';
import { useTodayCoursePlan } from './use-today-course-plan.js';

/* onPracticeScope(scope): starts a round of these questions, the way a crunch point's 练 5 道 does (ui/app/practise-round.js); without it (a read-only
   board) the 会掉 sentence shows without its button. */
export default function TodayFocusStrip({ library, today, budgetMinutes = null, focusedMinutes = null, planAnswer, onPracticeScope }) {
  const effectivePlan = useTodayCoursePlan(library, today, planAnswer);
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
      {strip.slip && (
        <div className="board-today__focus-slip" data-tour="today-focus-slip" data-focus-slip={strip.slip.chapters.join(' ')}>
          <Tooltip layer group="today-focus-strip" content={strip.slip.tooltip}>
            <span className="board-today__focus-slip-text" tabIndex={0}>{strip.slip.label}</span>
          </Tooltip>
          {onPracticeScope && <Button variant="secondary" size="sm" onClick={() => onPracticeScope(strip.slip.scope)}>{strip.slip.action}</Button>}
        </div>
      )}
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
