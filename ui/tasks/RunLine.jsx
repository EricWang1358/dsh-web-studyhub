import React from 'react';
import { ui } from '../i18n.js';
import { contractOf } from './task-model.js';
import { joinMeta } from '../format.js';
import { nextRoundText, repeatingLine, runLine, shortfallLine, shortfallWhy, stopText } from '../coverage/copy.js';

/* The line of a coverage run under the facts of its task: 「第 3/12 轮 · 覆盖 31% · 已用 1.2M tok · 预计还要 2.0M tok、约 25 分钟」; under it, once the draft is known, what it holds and what the next round does
   (the draft's SHORTFALL, lib/shortfall.js: 「已出 174/251 题 · 还有 18 个小节没有题」 and 「下一轮补 15 个小节，还剩 3 个」, the same words as the home row and the draft page), and, when the run has stopped,
   the true reason in plain words. The numbers are lib/coverage-run.js runFacts' (the contract's detail.run). */
export default function RunLine({ task, shortfall }) {
  const contract = contractOf(task), run = contract.detail?.run;
  if (!run?.total) return null;
  const interrupted = contract.status === 'interrupted';
  const stop = interrupted ? '' : (shortfall ? shortfallWhy(shortfall) : '') || stopText(run.stop);
  const counts = shortfall && !['running', 'paused'].includes(shortfall.state) ? joinMeta([shortfallLine(shortfall), shortfall.state === 'done' ? '' : nextRoundText(shortfall)]) : '';
  return (
    <div className="tc-run" role="status" aria-label={ui('出题计划')} data-run-state={interrupted ? 'interrupted' : run.state || 'running'}>
      <span className="tc-run__k">{ui('出题计划')}</span>
      <strong className="tc-run__line" data-run-line>{runLine(run, { interrupted })}</strong>
      {counts && <span className="tc-run__counts" data-shortfall-line>{counts}</span>}
      {stop && <span className="tc-run__stop" data-run-stop>{stop}</span>}
      {shortfall?.repeating?.length > 0 && !interrupted && <span className="tc-run__stop" data-repeating>{repeatingLine(shortfall)}</span>}
    </div>
  );
}
