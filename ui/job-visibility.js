import { JOB_STATUS, isActiveJob } from '../lib/job-status.js';

export { isActiveJob, isCancellable } from '../lib/job-status.js';

export function supplementJobLabel(job) {
  if (job.status === JOB_STATUS.QUEUED) return { text: '补题排队中' };
  if (job.status === JOB_STATUS.RUNNING) return { text: '正在审核并补入题组' };
  if (job.status === JOB_STATUS.CANCELLING) return { text: '正在停止补题' };
  if (job.status === JOB_STATUS.CANCELLED) return { text: '补题已取消' };
  const receipt = job.publication;
  if (job.status !== JOB_STATUS.COMPLETE || !receipt?.deckId) return { text: '补题未完成' };
  const partial = receipt.rejected > 0 || (job.savedCount ?? 0) < job.requestedTotal;
  return { text: partial ? '部分补入 {0} 题 · 共 {1} 题' : '已补入 {0} 题 · 共 {1} 题',
    args: [receipt.added, receipt.total] };
}

/* One card per deck (#200, #203): the generation jobs of one draft (a first run and every top-up or fill after it) are one story. The newest job is the
   card; the older ones fold into it, so a running fill is not shown above the old 草稿待补齐 card of the same deck, and two finished partial runs are not
   two identical cards with numbers of one and a process log of the other. Publish, repair and supplement jobs are their own cards. */
const foldable = (job) => !!job?.draftId && (job.type === undefined || job.type === 'generate');
const startedAt = (job) => Date.parse(job?.startedAt);
/**
 * `jobs` as cards, in their order: `[{ job, earlier }]` where `earlier` are the older generation jobs of the same draft, newest first.
 * Without a start time on both, the one met first (the list is newest first) is the newer.
 */
export function foldJobsByDraft(jobs = []) {
  const newest = new Map();
  for (const job of jobs) {
    if (!foldable(job)) continue;
    const best = newest.get(job.draftId);
    if (!best || (Number.isFinite(startedAt(job)) && Number.isFinite(startedAt(best)) && startedAt(job) > startedAt(best))) newest.set(job.draftId, job);
  }
  const earlier = new Map();
  const cards = [];
  for (const job of jobs) {
    if (foldable(job) && newest.get(job.draftId) !== job) { const head = newest.get(job.draftId); earlier.set(head.id, [...(earlier.get(head.id) || []), job]); continue; }
    cards.push(job);
  }
  const recent = (a, b) => (Number.isFinite(startedAt(b)) && Number.isFinite(startedAt(a)) ? startedAt(b) - startedAt(a) : 0);
  return cards.map((job) => ({ job, earlier: (earlier.get(job.id) || []).sort(recent) }));
}

export function visibleGenerationJobs(jobs = []) {
  const recentFinishedIds = new Set(jobs.filter((job) => !isActiveJob(job))
    .slice(-3).map((job) => job.id));
  return jobs.filter((job) => isActiveJob(job) || recentFinishedIds.has(job.id));
}
