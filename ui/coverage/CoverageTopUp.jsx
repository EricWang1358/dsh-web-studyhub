import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Popover } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { TokenEstimate } from '../TokenUsage.jsx';
import { useStudy } from '../study-context.jsx';
import { gateTitle } from '../ModelSetupGate.jsx';
import { draftWork, draftWorkLabel } from '../draft-shortfall.js';
import { isActiveJob } from '../job-visibility.js';
import css from './coverage.css';
import { allCoveredText, countOf } from './copy.js';

/* 为没覆盖的部分补题: THE one top-up of a draft, on the draft page, the home 待发布 card and the 任务 console. It is asked for the sections that have no question, not for a number
   of questions: it says before it starts how many sections it covers this round (planned-and-failed ones first, which it writes again from their plan, then never-planned ones, up to the
   generation limit), what the same request is expected to use (the real estimate of exactly those sections) and, honestly, how many more rounds the rest needs. */

/** The sentences of a round (`round` from coverage.get: { sections, questions, plannedFailed, neverPlanned, reused, left, rounds, limit }): `head` is what it covers, `plan` the same with how each section is done, `more` what it does not reach. */
export function roundLines(round, units) {
  const head = uiFormat('这一轮补 {0}，约 {1} 题。', [countOf(units, round.sections), round.questions]);
  const plan = [head, round.plannedFailed > 0 && uiFormat('其中 {0} 个计划了没出成，按原来的考点重写，不重新规划。', [round.plannedFailed]),
    round.neverPlanned > 0 && (round.plannedFailed > 0 ? uiFormat('另外 {0} 个从原文重新规划考点。', [round.neverPlanned]) : uiFormat('{0} 个从原文规划考点。', [round.neverPlanned]))].filter(Boolean).join(' ');
  const more = round.left > 0 ? uiFormat('还有 {0}一轮补不完（一轮最多 {1} 题），这一轮完成后再补一次，约还要 {2} 轮。', [countOf(units, round.left), round.limit, Math.max(1, round.rounds - 1)]) : '';
  return { head, plan, more };
}

/** What works on the draft right now: a top-up, the run still writing it, a repair, a publication check; and a fill that publishes straight into the deck this draft merges into. */
const workOn = (draft, jobs) => draftWork(draft, jobs) || (() => {
  const job = draft.mergeTargetId && (jobs || []).find((item) => item.mergeTargetId === draft.mergeTargetId && isActiveJob(item));
  return job ? { kind: 'topup', job } : null;
})();
const classOf = (variant) => `cov-topup${variant === 'compact' ? ' cov-topup--compact' : variant === 'panel' ? ' cov-topup--panel' : ''}`;
/** While something works on the draft this is a status (the work's own words, with its progress), not a button that cannot be pressed. */
const WorkStatus = ({ draft, work, variant, percent }) => <div className={`draft-topup ${classOf(variant)}`} data-draft-topup data-coverage-topup><Badge tone="info" dot data-draft-work>{draftWorkLabel(work, draft, percent)}</Badge></div>;

/** The body: the round, the button and the estimate. `compact` is the home card's narrow column; `panel` the console header's popover. */
function TopUpBody({ draft, view, modelReady, held, onTopUp, variant }) {
  const { call, busy } = useStudy();
  const round = view.round, units = view.coverage.units, cls = classOf(variant);
  if (!round.sections) return <div className={cls} data-coverage-topup data-coverage-complete><p className="cov-topup__done">{allCoveredText(units)}</p></div>;
  const lines = roundLines(round, units), blocked = busy || held || !modelReady;
  const sectionIds = round.picks.map((pick) => pick.key);
  return <div className={cls} data-coverage-topup>
    {/* The home card's column is narrow: it says what the round covers; how each section is done and what the round does not reach are on the draft page and in the console. */}
    <p className="cov-topup__plan" data-coverage-round>{variant === 'compact' ? lines.head : lines.plan}</p>
    {/* A draft with a plan says how many rounds are left in the line of its run (ui/coverage/RunPanel.jsx); the sections the plan does not hold are not "more rounds". */}
    {lines.more && variant !== 'compact' && !view.run && <p className="cov-topup__more" data-coverage-more>{lines.more}</p>}
    <div className="cov-topup__act">
      <Button className="cov-topup__button" disabled={blocked} data-coverage-start title={!modelReady ? gateTitle('block') : held ? ui('先保存草稿，再补题。') : undefined}
        onClick={() => onTopUp?.(draft, sectionIds, round)}>{ui('为没覆盖的部分补题')}</Button>
      {modelReady && call && <div className="cov-topup__estimate"><TokenEstimate enabled align="end" request={{ feature: 'generate', resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds } }} /></div>}
    </div>
  </div>;
}

/**
 * The one action. `view` is `coverage.get`'s answer for the draft; nothing is drawn until it says the draft can be topped up. The button is off while the app is busy (useStudy), and `held` is
 * what else keeps it from starting from this page (unsaved edits, a newer version in the background). variant: 'block' (the draft page), 'compact' (a column of the home card) or 'panel' (inside the console's popover).
 */
export function CoverageTopUp({ draft, view, jobs = [], modelReady = true, held = false, onTopUp, variant = 'block' }) {
  useInjectCss(css, 'study-coverage');
  if (!draft) return null;
  // What works on the draft is always said, whether or not the coverage has arrived: the draft is not free to be topped up while it is being written, published or repaired.
  const work = workOn(draft, jobs);
  if (work) return <WorkStatus draft={draft} work={work} variant={variant} percent={view?.status === 'ok' ? view.coverage?.percentLeaves : undefined} />;
  if (view?.status !== 'ok' || !view.canTopUp || !view.coverage?.leaves) return null;
  return <TopUpBody draft={draft} view={view} modelReady={modelReady} held={held} onTopUp={onTopUp} variant={variant} />;
}

/** The same action in a popover: the 任务 console's header button of a finished run. The popover shows what the round is and what it costs before anything starts. */
export function CoverageTopUpPopover({ draft, view, jobs = [], modelReady = true, onTopUp }) {
  useInjectCss(css, 'study-coverage');
  const [open, setOpen] = React.useState(false);
  if (!draft || view?.status !== 'ok' || !view.canTopUp || !view.coverage?.leaves) return null;
  const work = workOn(draft, jobs);
  return <Popover open={open} onOpenChange={setOpen} label={ui('为没覆盖的部分补题')} className="cov-popover" panelClassName="cov-popover__panel" placement="bottom-end"
    trigger={({ props, ref }) => <Button ref={ref} size="sm" {...props} data-coverage-open disabled={!!work}>{ui('为没覆盖的部分补题')}</Button>}>
    <TopUpBody draft={draft} view={view} modelReady={modelReady} held={false} variant="panel" onTopUp={(...args) => { setOpen(false); onTopUp?.(...args); }} />
  </Popover>;
}
