import React from 'react';
import { ui } from '../i18n.js';
import { Icon } from '../components/index.js';
import { TERMS } from '../mastery-terms.js';

/** The right of the home desk: the one card with today's count (or the newcomer's three steps) and its one action. */
export default function TodayCard({ plan, todayLabel, busy }) {
  return (
    <div className="today-stack" data-depth={plan.depth} data-tour="home-today">
      <div className="today-card">
        <div className="today-card-head">
          <span>{plan.eyebrow}</span>
          <time>{todayLabel}</time>
        </div>
        {plan.kind === 'empty' ? (
          <>
            <p className="today-card-empty">{plan.title}</p>
            <ol className="starter-steps" aria-label={ui('第一组题的三步')}>
              {[ui('添加资料'), ui('用资料出题'), ui('检查并发布')].map((label, index) => (
                <li key={label} className={index < plan.step ? 'is-done' : index === plan.step ? 'is-current' : undefined} aria-current={index === plan.step ? 'step' : undefined}>
                  <span className="starter-mark" aria-hidden="true">{index < plan.step ? <Icon name="check" size={14} /> : index + 1}</span>{label}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <div className="today-count">
            <strong>{plan.count}</strong>
            <span>{plan.unit}</span>
          </div>
        )}
        {plan.detail && <p className="today-detail" title={plan.kind === 'path' ? ui(TERMS.due.hint) : undefined}>{plan.detail}</p>}
        {plan.action && (
          <button className="primary today-go" disabled={busy || plan.action.disabled} data-usage="home.start" onClick={plan.action.run}>
            {plan.action.label}<span aria-hidden="true">→</span>
          </button>
        )}
      </div>
    </div>
  );
}
