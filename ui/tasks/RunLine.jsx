import React from 'react';
import { ui } from '../i18n.js';
import { contractOf } from './task-model.js';
import { runLine, stopText } from '../coverage/copy.js';

/* The line of a coverage run under the facts of its task: 「第 3/12 轮 · 覆盖 31% · 已用 1.2M tok · 预计还要 2.0M tok、约 25 分钟」, and, when the run has stopped, the true reason. The words are
   ui/coverage/copy.js's, the numbers are lib/coverage-run.js runFacts' (the contract's detail.run): the draft page and the home row say the same thing the same way. */
export default function RunLine({ task }) {
  const contract = contractOf(task), run = contract.detail?.run;
  if (!run?.total) return null;
  const interrupted = contract.status === 'interrupted';
  const stop = interrupted ? '' : stopText(run.stop);
  return (
    <div className="tc-run" role="status" aria-label={ui('出题计划')} data-run-state={interrupted ? 'interrupted' : run.state || 'running'}>
      <span className="tc-run__k">{ui('出题计划')}</span>
      <strong className="tc-run__line" data-run-line>{runLine(run, { interrupted })}</strong>
      {stop && <span className="tc-run__stop" data-run-stop>{stop}</span>}
    </div>
  );
}
