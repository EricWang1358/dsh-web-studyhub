import React from 'react';
import { ui } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import { TERMS } from '../mastery-terms.js';
import { useStudy } from '../study-context.jsx';
import { useMethodAlternativeOpen } from '../method-alternatives.js';

/** The right of the home desk: the one card with today's count and its one action (a newcomer's three steps are the first-run line's compact card, ui/first-run). `quiet`: the 下一步 card above holds the page's primary button (ui/study-map/NextStepCard.jsx), so this action is a secondary one. `extra`: a line that comes later (重读 N 段), drawn under the action and outside the card's body, so its coming never moves the action. */
export default function TodayCard({ plan, todayLabel, quiet = false, extra = null }) {
  const { act, busy } = useStudy();
  const openAlt = useMethodAlternativeOpen();
  const advanceStage = () => {
    if (!plan.stageAdvance) return;
    if (plan.stageAdvance.run) { plan.stageAdvance.run(); return; }
    void act('course.method.save', {
      ...(plan.stageAdvance.courseId ? { id: plan.stageAdvance.courseId } : {}),
      ...(plan.stageAdvance.course ? { course: plan.stageAdvance.course } : {}),
      stageIndex: plan.stageAdvance.targetIndex,
    });
  };
  return (
    <div className="today-stack" data-depth={plan.depth} data-tour="home-today">
      <div className="today-card sh-paper-card">
        <div className="today-card-main">
        <div className="today-card-head">
          <span>{plan.eyebrow}</span>
          <time>{todayLabel}</time>
        </div>
        <div className="today-count">
          <strong>{plan.count}</strong>
          <span>{plan.unit}</span>
        </div>
        {plan.detail && <p className="today-detail">{plan.kind === 'path' ? <Tooltip layer content={ui(TERMS.due.hint)}><span tabIndex={0}>{plan.detail}</span></Tooltip> : plan.detail}</p>}
        {plan.stageAdvance && (
          <p className="today-stage-advance">
            <span>{plan.stageAdvance.note}</span>
            <Button variant="link" size="sm" wrap lock={busy} onClick={advanceStage}>{plan.stageAdvance.label}</Button>
          </p>
        )}
        {plan.methodAlt && (
          <p className="today-method-alt">
            <span>{ui('也可以：')}</span>
            <Tooltip layer content={plan.methodAlt.detail}>
              <Button variant="link" size="sm" lock={busy} onClick={() => openAlt(plan.methodAlt)}>{plan.methodAlt.title}</Button>
            </Tooltip>
          </p>
        )}
        {plan.pickPages && (
          <p className="today-pick-pages">
            <span>{plan.pickPages.note}</span>
            <Tooltip layer content={plan.pickPages.detail}>
              <Button variant="link" size="sm" wrap lock={busy} onClick={plan.pickPages.run}>{plan.pickPages.label}</Button>
            </Tooltip>
          </p>
        )}
        {plan.action && (
          <Button variant={quiet ? "secondary" : "primary"} className="today-go" iconEnd="arrow-right" disabled={plan.action.disabled} lock={busy} data-usage="home.start" onClick={plan.action.run}>
            {plan.action.label}
          </Button>
        )}
        </div>
        {extra}
      </div>
    </div>
  );
}
