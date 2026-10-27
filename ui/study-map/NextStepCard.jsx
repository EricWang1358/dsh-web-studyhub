import React from 'react';
import { ui } from '../i18n.js';
import { Button } from '../components/index.js';
import { HandOff } from '../hand-off/HandOff.jsx';
import { useInjectCss } from '../shared.js';
import css from './next-step.css';

/* The home's one 「下一步」 card (3.7 guidance, step 3), drawn from nextCardView (ui/study-map/next-card-view.js): the state named by nextStep
   (ui/study-map/next-step.js), a fact, ONE primary button (the done state has none) and the quiet 「今天先不」, which hides the card for the local day
   (ui/study-map/next-dismiss.js). Below them the quiet 「不知道从哪开始？」 hand-off to the main chat (guide.start), so the way to the front door stays one
   click away once the first-run line is gone. The card is the page's primary button while it shows: the day's card under it (TodayCard) takes a secondary one. */
export default function NextStepCard({ view, busy = false, onDismiss }) {
  useInjectCss(css, 'study-next-card');
  const { action } = view;
  const primary = { variant: 'primary', iconEnd: 'arrow-right', wrap: true, disabled: busy || !!action?.disabled, 'data-next-action': '' };
  return (
    <section className="next-card" data-next={view.id} aria-label={view.eyebrow}>
      <div className="next-card__text">
        <p className="next-card__eyebrow">{view.eyebrow}</p>
        <p className="next-card__headline">{view.headline}</p>
        <p className="next-card__detail">{view.detail || ' '}</p>
      </div>
      <div className="next-card__actions">
        {/* (two literals: the usage list is checked against the data-usage values written in the source) */}
        {action && (action.usage === 'home.start'
          ? <Button {...primary} data-usage="home.start" onClick={action.run}>{action.label}</Button>
          : <Button {...primary} data-usage="home.next" onClick={action.run}>{action.label}</Button>)}
        <Button variant="quiet" size="sm" disabled={busy} data-usage="home.next-later" data-next-dismiss onClick={onDismiss}>{ui('今天先不')}</Button>
      </div>
      <p className="next-card__help">
        <HandOff id="guide.start" lead={ui('不知道从哪开始？')} what={ui('让主会话看一眼你的学习库，再说两三条能马上开始的路。')} disabled={busy} />
      </p>
    </section>
  );
}
