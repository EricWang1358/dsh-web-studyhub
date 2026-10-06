import { isActiveJob } from '../job-visibility.js';
import { roundList, runFacts } from '../../lib/coverage-run.js';
import { runLine } from './copy.js';

/* The job that is working on a draft, or the interrupted run the last process left (lib/contexts/generation/operations.js coverage.recover), for the screens that say where a run is; failing that, the
   newest run that ended before it was done (failed or stopped) and CAN be continued (its contract says `actions.retry` is available), plain or coverage run: the record 接着做 acts on and the shortfall
   says how it ended (lib/shortfall.js `ended`). A record that was already continued offers nothing. */
export function activeJobOf(draft, jobs = []) {
  const list = (jobs || []).filter((item) => item.draftId === draft?.id && item.coverageRun);
  const live = list.find((item) => isActiveJob(item)) || list.find((item) => item.status === 'interrupted');
  if (live) return live;
  const ended = (jobs || []).filter((item) => item.draftId === draft?.id && ['failed', 'cancelled'].includes(item.status) && !item.continuedBy && (item.contract?.actions?.retry?.available === true || item.retryable === true));
  return ended.reduce((newest, item) => (!newest || Date.parse(item.finishedAt || item.startedAt) >= Date.parse(newest.finishedAt || newest.startedAt) ? item : newest), null);
}

/** The line a job's own copy of its run says (「第 3/12 轮 · 覆盖 31% · 已用 1.2M tok · 预计还要 2.0M tok、约 25 分钟」): what replaces 「生成中 · 草稿 8/30 题」 while rounds are being made. '' for a plain job. */
export function jobRunLine(job, percent) {
  const run = job?.coverageRun;
  if (!run || !Array.isArray(run.list) || !run.list.length) return '';
  return runLine(runFacts({ rounds: roundList({ rounds: run.list }), run, percent: Number.isFinite(percent) ? percent : run.percent ?? null }), { interrupted: job.status === 'interrupted' });
}
