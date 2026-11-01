import React from 'react';
import { ui } from '../i18n.js';
import { Button } from '../components/index.js';
import { TERMS } from '../mastery-terms.js';
import { useStudy } from '../study-context.jsx';

/** The right of the home desk: the one card with today's count and its one action (a newcomer's three steps are the first-run line's compact card, ui/first-run). `quiet`: the 下一步 card above holds the page's primary button (ui/study-map/NextStepCard.jsx), so this action is a secondary one. */
export default function TodayCard({ plan, todayLabel, quiet = false }) {
  const { busy } = useStudy();
  return (
    <div className="today-stack" data-depth={plan.depth} data-tour="home-today">
      <div className="today-card sh-paper-card">
        <div className="today-card-head">
          <span>{plan.eyebrow}</span>
          <time>{todayLabel}</time>
        </div>
        <div className="today-count">
          <strong>{plan.count}</strong>
          <span>{plan.unit}</span>
        </div>
        {plan.detail && <p className="today-detail" title={plan.kind === 'path' ? ui(TERMS.due.hint) : undefined}>{plan.detail}</p>}
        {plan.action && (
          <Button variant={quiet ? "secondary" : "primary"} className="today-go" iconEnd="arrow-right" disabled={busy || plan.action.disabled} data-usage="home.start" onClick={plan.action.run}>
            {plan.action.label}
          </Button>
        )}
      </div>
    </div>
  );
}
