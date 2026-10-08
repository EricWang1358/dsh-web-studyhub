import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Checkbox } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useStudy } from '../study-context.jsx';
import { activeJobOf } from './run-job.js';
import { draftRunFacts } from '../../lib/coverage-run.js';
import css from './coverage.css';
import { autoLabel, autoStartLine, repeatingHead, repeatingItem, repeatingNote, runLine, shortfallLine, shortfallWhy, stopText } from './copy.js';
import { draftShortfall } from './use-shortfall.js';
import RepeatingExplain from './RepeatingExplain.jsx';
import RoundCost from './RoundCost.jsx';

/* The run a draft's plan is, on the draft page (and, in one line, on the home row): where it is (「第 1 轮完成，还有 11 轮」, or the round being made), why it stopped when it did, and the choice
   「自动补到完整」. The facts are lib/coverage-run.js draftRunFacts (the same function the 任务 console reads) and the words ui/coverage/copy.js's. While a job works on the draft the choice can be flipped
   any time (the run goes on by itself, or stops after the round in flight); with nothing running, ticking it starts the rest of the plan as one run. */

/** The line a run says about itself, and the reason it stopped: used by the draft page, the home row and the status that replaces the top-up button while a run works. */
export function runSummary(draft, jobs, percent, coverage) {
  const job = activeJobOf(draft, jobs), facts = draftRunFacts(draft, { job, percent, coverage });
  return facts ? { facts, job, line: runLine(facts, { interrupted: facts.interrupted && !facts.live }), stop: facts.live || facts.interrupted ? '' : stopText(facts.stop) } : null;
}

/* `saveThen(next)`: the page's own way to save its edits first and then run `next(saved)` (the draft page passes it while the page has edits; a top-up asks for the saved version). */
export default function RunPanel({ draft, view, jobs = [], held = false, modelReady = true, onStarted, onOpenSource, saveThen }) {
  useInjectCss(css, 'study-coverage');
  const { act, call, busy, notify, openSettings } = useStudy();
  const summary = view?.status === 'ok' && draft ? runSummary(draft, jobs, view.coverage?.percentLeaves ?? null, view.coverage) : null;
  if (!summary || !summary.facts.total) return null;
  const { facts, job } = summary, live = !!job && facts.live, pending = facts.left > 0;
  // The counts and the reason it stands still are the shortfall's (lib/shortfall.js), said the same way on the home row and in the 任务 console.
  const shortfall = draftShortfall(draft, { view, jobs }), why = live || facts.interrupted ? '' : shortfallWhy(shortfall) || summary.stop;
  // Flipped while it runs: the job takes it. With nothing running, ticking it starts the rest of the plan (only while there is a round left and the draft can be topped up).
  const canStart = !live && pending && view.canTopUp && modelReady && !held, toggle = live || canStart;
  const change = (value) => {
    if (live) { act('job.control', { jobId: job.contract?.jobId || job.id, action: 'set', patch: { autoComplete: value } }); return; }
    const announce = (started) => {
      notify?.(uiFormat('已开始自动补完「{0}」：从第 {1} 轮起，共 {2} 轮。', [draft.title, started?.plan?.round ?? facts.round, started?.plan?.rounds ?? facts.rounds]));
      onStarted?.(started);
    };
    if (value) {
      const start = (target) => ({ resumeDraftId: target.id, draftVersion: target.draftVersion, coverage: { run: true, autoComplete: true } });
      if (saveThen) saveThen(async (saved) => announce(await call('generate', start(saved))));
      else act('generate', start(draft), announce);
    }
  };
  return <div className="cov-run" data-coverage-run data-run-state={facts.live ? 'live' : facts.interrupted ? 'interrupted' : facts.state || 'idle'}>
    {!live && <p className="cov-run__counts" data-shortfall-line>{shortfallLine(shortfall)}</p>}
    {!live && <p className="cov-run__line" data-run-line>{summary.line}</p>}
    {why && <p className="cov-run__stop" data-run-stop>{why}</p>}
    {!live && shortfall.repeating.length > 0 && <div className="cov-run__repeating" data-repeating>
      <p className="cov-run__stop cov-run__stop--head">{repeatingHead(shortfall.repeating.length)}</p>
      <ul className="cov-run__repeat-list">{shortfall.repeating.map((item) => <li key={item.key} data-section={item.key}>{repeatingItem(item)}</li>)}</ul>
      <small className="cov-run__hint">{repeatingNote()}</small>
      <RepeatingExplain shortfall={shortfall} onOpenSource={onOpenSource} onOpenSettings={openSettings} />
    </div>}
    {toggle && <div className="cov-run__auto">
      <Checkbox label={autoLabel()} checked={live ? facts.auto : false} disabled={busy} data-run-auto onChange={change} />
      {!live && <small>{autoStartLine(facts.left)}</small>}
      {/* Ticking it spends over several rounds: what the first is expected to use is said here, before the tick, and the rounds after it are on top. */}
      {canStart && <RoundCost request={{ feature: 'generate', resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true, autoComplete: true } }} roundsAfter={Math.max(0, facts.left - 1)} />}
    </div>}
    {!toggle && pending && !live && held && <small className="cov-run__hint">{ui('草稿已在后台更新，先载入最新草稿，再补题。')}</small>}
  </div>;
}
