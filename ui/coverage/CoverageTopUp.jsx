import React, { useContext } from 'react';
import { ui } from '../i18n.js';
import { Badge, Button, Popover } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { TokenEstimate } from '../TokenUsage.jsx';
import { useStudy } from '../study-context.jsx';
import { gateTitle } from '../ModelSetupGate.jsx';
import { ModelSettingsContext } from '../ModelErrorNote.jsx';
import { draftWork, draftWorkLabel } from '../draft-shortfall.js';
import { isActiveJob } from '../job-visibility.js';
import css from './coverage.css';
import { actionLabel, allCoveredText, continueLine, coveragePathText, nextRoundText, shortfallWhy } from './copy.js';
import { describeFailure } from '../generation-status.js';
import { continueArgs, continueNotice } from './top-up.js';
import { draftShortfall } from './use-shortfall.js';
import { activeJobOf } from './run-job.js';

/* THE one primary action of a draft that stands still, on the draft page, the home 待发布 row and the 任务 console, chosen by the shortfall (lib/shortfall.js `action`): 继续 (a paused run),
   接着做 (an interrupted one), 去配置模型 (a refused key), 为没覆盖的部分补题 (it stopped or was stopped with sections left); nothing while it runs or when nothing is missing. The top-up is asked for the
   sections that have no question, not for a number of questions: it says before it starts what the next round covers and what it leaves (ONE sentence, the same on every screen:
   「下一轮补 15 个小节，还剩 3 个」) and what the same request is expected to use (the real estimate of exactly those sections). It also says the way to full coverage (「覆盖现在 …（13%）→ 本轮后约 38% →
   目标 100%，还要 4 轮、约 100 题」): the rounds then go on by themselves (自动补到完整), one after another, until every section has a question.
   After a run that ended before it was done (the time limit, a failure, a stop) the primary action is 接着做 and it says what it will do (「已出 13/15 题保留，接着补 2 题」) and why it is needed; the top-up is
   then the other, deliberate thing beside it (never a second primary). */

/** What works on the draft right now: a top-up, the run still writing it, a repair, a publication check; and a fill that publishes straight into the deck this draft merges into. */
const workOn = (draft, jobs) => draftWork(draft, jobs) || (() => {
  const job = draft.mergeTargetId && (jobs || []).find((item) => item.mergeTargetId === draft.mergeTargetId && isActiveJob(item));
  return job ? { kind: 'topup', job } : null;
})();
const classOf = (variant) => `cov-topup${variant === 'compact' ? ' cov-topup--compact' : variant === 'panel' ? ' cov-topup--panel' : ''}`;
/** While something works on the draft this is a status (the work's own words, with its progress), not a button that cannot be pressed. */
const WorkStatus = ({ draft, work, variant, percent }) => <div className={`draft-topup ${classOf(variant)}`} data-draft-topup data-coverage-topup><Badge tone="info" dot data-draft-work>{draftWorkLabel(work, draft, percent)}</Badge></div>;

/** The body: the round, the button and the estimate. `compact` is the home card's narrow column; `panel` the console header's popover. */
function TopUpBody({ draft, view, shortfall, modelReady, held, onTopUp, variant }) {
  const { call, busy } = useStudy();
  const round = view.round, units = view.coverage.units, cls = classOf(variant);
  if (!round.sections) return <div className={cls} data-coverage-topup data-coverage-complete><p className="cov-topup__done">{allCoveredText(units)}</p></div>;
  const blocked = busy || held || !modelReady;
  const sectionIds = round.picks.map((pick) => pick.key);
  return <div className={cls} data-coverage-topup data-shortfall-action="topup">
    <p className="cov-topup__plan" data-coverage-round>{nextRoundText(shortfall)}</p>
    {coveragePathText(shortfall) && <p className="cov-topup__path" data-coverage-path>{coveragePathText(shortfall)}</p>}
    <div className="cov-topup__act">
      <Button className="cov-topup__button" disabled={blocked} data-coverage-start title={!modelReady ? gateTitle('block') : held ? ui('先保存草稿，再补题。') : shortfall.reason === 'manual' ? ui('一次补一轮') : ui('补完这一轮后自动做下一轮，直到每个小节都有题；可以随时暂停或停下。')}
        onClick={() => onTopUp?.(draft, sectionIds, round)}>{actionLabel('topup')}</Button>
      {modelReady && call && <div className="cov-topup__estimate"><TokenEstimate enabled align="end" request={{ feature: 'generate', resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds } }} /></div>}
    </div>
  </div>;
}

/** 继续 / 接着做 / 去配置模型: the action of a paused, interrupted or refused run. A refusal says in one plain sentence why before the button; what was kept stays, and 接着做 is in the console once the key works. */
function ActionBody({ draft, shortfall, job, variant, modelReady }) {
  const { act, busy, openSettings, notify, call } = useStudy();
  const openModelSettings = useContext(ModelSettingsContext);
  const jobId = job?.contract?.jobId || job?.id, action = shortfall.action;
  // A plain run (a count, no plan) is continued on its draft: every approved question stays and the ones it still owes are made. A run of rounds is continued through its job (the contract's retry).
  const count = action === 'continue' && shortfall.continueKind === 'count';
  const run = { resume: () => act('job.control', { jobId, action: 'resume' }),
    continue: () => (count ? act('generate', continueArgs(draft), (started) => notify?.(continueNotice(draft, started))) : act('job.control', { jobId, action: 'retry' })),
    'model-settings': () => (openModelSettings ? openModelSettings() : openSettings?.('settings-model')) }[action];
  // On the draft page the run's own panel says why (ui/coverage/RunPanel.jsx); on the home row and in the popover this is the only place.
  const why = action === 'model-settings' && variant !== 'block' ? shortfallWhy(shortfall) : '';
  const needsJob = action === 'resume' || (action === 'continue' && !count), hold = action !== 'model-settings' && (busy || (needsJob && !jobId) || (action === 'continue' && !modelReady));
  // After a run that ended before it was done: how it ended (the one sentence of describeFailure) and what 接着做 will do, said before the button.
  const ended = action === 'continue' && shortfall.ended?.status === 'failed' && variant !== 'compact' ? describeFailure(shortfall.ended.stage, { hasDraft: true }).title : '';
  return <div className={classOf(variant)} data-coverage-topup data-shortfall-action={action}>
    {why && <p className="cov-topup__plan" data-shortfall-why>{why}</p>}
    {ended && <p className="cov-topup__plan" data-shortfall-ended>{ended}</p>}
    {action === 'continue' && <p className="cov-topup__plan" data-continue-line>{continueLine(shortfall)}</p>}
    <div className="cov-topup__act">
      <Button className="cov-topup__button" variant={action === 'model-settings' || action === 'continue' ? 'primary' : undefined} disabled={hold} data-shortfall-act={action} title={action === 'continue' && !modelReady ? gateTitle('block') : undefined} onClick={run}>{actionLabel(action)}</Button>
      {count && modelReady && call && <div className="cov-topup__estimate"><TokenEstimate enabled align="end" request={{ feature: 'generate', resumeDraftId: draft.id, draftVersion: draft.draftVersion }} /></div>}
    </div>
  </div>;
}

/**
 * The one action. `view` is `coverage.get`'s answer for the draft; nothing is drawn until it says the draft can be topped up (or the shortfall has another action: continue, resume, set the model up).
 * The button is off while the app is busy (useStudy), and `held` is what else keeps it from starting from this page (unsaved edits, a newer version in the background).
 * variant: 'block' (the draft page), 'compact' (a column of the home card) or 'panel' (inside the console's popover).
 */
export function CoverageTopUp({ draft, view, jobs = [], modelReady = true, held = false, onTopUp, variant = 'block' }) {
  useInjectCss(css, 'study-coverage');
  if (!draft) return null;
  const shortfall = draftShortfall(draft, { view, jobs });
  // What works on the draft is always said, whether or not the coverage has arrived: the draft is not free to be topped up while it is being written, published or repaired.
  const work = workOn(draft, jobs), percent = view?.status === 'ok' ? view.coverage?.percentLeaves : undefined;
  if (work && shortfall.state !== 'paused') return <WorkStatus draft={draft} work={work} variant={variant} percent={percent} />;
  if (['resume', 'continue', 'model-settings'].includes(shortfall.action)) {
    const body = <ActionBody draft={draft} shortfall={shortfall} job={activeJobOf(draft, jobs)} variant={variant} modelReady={modelReady} />;
    // The top-up of the sections without a question stays beside the continuation (the draft page and the console's popover), as the other, deliberate thing: not a second primary, and not on the home row.
    const other = shortfall.secondary === 'topup' && variant !== 'compact' && view?.status === 'ok' && view.canTopUp && view.coverage?.leaves > 0 && view.round?.sections > 0
      ? <TopUpBody draft={draft} view={view} shortfall={shortfall} modelReady={modelReady} held={held} onTopUp={onTopUp} variant={variant} /> : null;
    return <>{work && <WorkStatus draft={draft} work={work} variant={variant} percent={percent} />}{body}{other}</>;
  }
  if (view?.status !== 'ok' || !view.canTopUp || !view.coverage?.leaves) return null;
  // The draft page keeps saying 「每个小节都有题了」 (and offers the extension of a plan that met its target); the home row and the banner offer only the shortfall's own action.
  if (shortfall.action !== 'topup' && !(variant === 'block' && shortfall.state === 'done')) return null;
  return <TopUpBody draft={draft} view={view} shortfall={shortfall} modelReady={modelReady} held={held} onTopUp={onTopUp} variant={variant} />;
}

/** The same action in a popover: the 任务 console's header button of a finished run. The popover shows what the round is and what it costs before anything starts. */
export function CoverageTopUpPopover({ draft, view, jobs = [], modelReady = true, onTopUp }) {
  useInjectCss(css, 'study-coverage');
  const [open, setOpen] = React.useState(false);
  if (!draft || view?.status !== 'ok' || !view.canTopUp || !view.coverage?.leaves) return null;
  const shortfall = draftShortfall(draft, { view, jobs });
  // A run that can be continued, paused or that needs its key has its own button in the console's header: this is the action of a run that stopped with sections left, and the other, deliberate thing
  // beside the 接着做 of a plain run.
  if (shortfall.action !== 'topup' && shortfall.secondary !== 'topup') return null;
  const work = workOn(draft, jobs);
  return <Popover open={open} onOpenChange={setOpen} label={actionLabel('topup')} className="cov-popover" panelClassName="cov-popover__panel" placement="bottom-end"
    trigger={({ props, ref }) => <Button ref={ref} size="sm" {...props} data-coverage-open disabled={!!work}>{actionLabel('topup')}</Button>}>
    <TopUpBody draft={draft} view={view} shortfall={shortfall} modelReady={modelReady} held={false} variant="panel" onTopUp={(...args) => { setOpen(false); onTopUp?.(...args); }} />
  </Popover>;
}
