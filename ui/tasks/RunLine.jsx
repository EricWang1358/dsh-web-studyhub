import React from 'react';
import { ui } from '../i18n.js';
import { contractOf } from './task-model.js';
import { joinMeta } from '../format.js';
import { continueLine, coveragePathText, forecastMath, nextRoundText, repeatingLine, runLine, runPathText, shortfallLine, shortfallWhy, stopText } from '../coverage/copy.js';
import { forecastOf } from './task-facts.js';
import RepeatingExplain from '../coverage/RepeatingExplain.jsx';

/* The line of a coverage run under the facts of its task: 「第 3/12 轮 · 覆盖 31% · 已用 1.2M tok · 预计还要 2.0M tok、约 25 分钟」; under it, once the draft is known, what it holds and what the next round does
   (the draft's SHORTFALL, lib/shortfall.js: 「已出 174/251 题 · 还有 18 个小节没有题」 and 「下一轮补 15 个小节，还剩 3 个」, the same words as the home row and the draft page), and, when the run has stopped,
   the true reason in plain words. The numbers are lib/coverage-run.js runFacts' (the contract's detail.run). The way to full coverage (「覆盖现在 31% → 目标 100%，还要 3 轮、约 90 题」) is said here too: by the
   shortfall once the run stands still (with what the next round makes it), by the run's own rounds while it works.
   A plain run (a count, no plan) that ended before it was done has no rounds: its strip says what 接着做 will do (「已出 13/15 题保留，接着补 2 题」).
   What is left is the run's own forecast (task-facts.js forecastOf: lib/coverage-run.js runForecast): the tokens with their basis in the line, the sum behind them under it (「已用 1.5M + 还要约 2.4M ≈ 共约 3.9M tok」).
   That second line is there, one line high, for as long as the run is going, empty when there is nothing to say, so nothing moves when the numbers arrive or change.
   The sections that keep failing are one line (ui/coverage/copy.js repeatingLine) and, under it, an explanation to open: what happened to each with its numbers, why, and what to do (RepeatingExplain);
   `onOpenSource(sourceId, offset)` and `onOpenSettings(section)` are the host's, and a control is drawn only when the host gave it. */
export default function RunLine({ task, shortfall, now = Date.now(), onOpenSource, onOpenSettings }) {
  const contract = contractOf(task), run = contract.detail?.run;
  const continuing = shortfall?.action === 'continue' && (!!shortfall.ended || ['failed', 'cancelled'].includes(contract.status));
  if (!run?.total) {
    if (!continuing) return null;
    return (
      <div className="tc-run" role="status" aria-label={ui('接着做')} data-run-state="ended">
        <span className="tc-run__k">{ui('接着做')}</span>
        <strong className="tc-run__line" data-continue-line>{continueLine(shortfall)}</strong>
      </div>
    );
  }
  const interrupted = contract.status === 'interrupted';
  const stop = interrupted ? '' : (shortfall ? shortfallWhy(shortfall) : '') || stopText(run.stop);
  const standing = shortfall && !['running', 'paused'].includes(shortfall.state);
  const counts = standing ? joinMeta([continuing ? continueLine(shortfall) : shortfallLine(shortfall), shortfall.state === 'done' ? '' : nextRoundText(shortfall)]) : '';
  const path = standing ? coveragePathText(shortfall) : runPathText(run);
  const forecast = interrupted ? null : forecastOf(contract, now), math = forecast ? forecastMath(forecast) : '';
  return (
    <div className="tc-run" role="status" aria-label={ui('出题计划')} data-run-state={interrupted ? 'interrupted' : run.state || 'running'}>
      <span className="tc-run__k">{ui('出题计划')}</span>
      <strong className="tc-run__line" data-run-line>{runLine(run, { interrupted, forecast })}</strong>
      {forecast && <span className="tc-run__counts tc-run__math" data-run-math title={math || undefined}>{math || '\u00a0'}</span>}
      {counts && <span className="tc-run__counts" data-shortfall-line>{counts}</span>}
      {path && <span className="tc-run__counts" data-coverage-path>{path}</span>}
      {stop && <span className="tc-run__stop" data-run-stop>{stop}</span>}
      {shortfall?.repeating?.length > 0 && !interrupted && <span className="tc-run__stop" data-repeating>{repeatingLine(shortfall)}</span>}
      {shortfall?.repeating?.length > 0 && !interrupted && <RepeatingExplain shortfall={shortfall} onOpenSource={onOpenSource} onOpenSettings={onOpenSettings} />}
    </div>
  );
}
