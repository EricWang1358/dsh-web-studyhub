const ACTIVE = new Set(["queued", "running", "cancelling"]);

export const isActiveJob = (job) => ACTIVE.has(job.status);

export function supplementJobLabel(job) {
  if (job.status === 'queued') return { text: '补题排队中' };
  if (job.status === 'running') return { text: '正在审核并补入题组' };
  if (job.status === 'cancelling') return { text: '正在停止补题' };
  if (job.status === 'cancelled') return { text: '补题已取消' };
  const receipt = job.publication;
  if (job.status !== 'complete' || !receipt?.deckId) return { text: '补题未完成' };
  const partial = receipt.rejected > 0 || (job.savedCount ?? 0) < job.requestedTotal;
  return { text: partial ? '部分补入 {0} 题 · 共 {1} 题' : '已补入 {0} 题 · 共 {1} 题',
    args: [receipt.added, receipt.total] };
}

export function visibleGenerationJobs(jobs = []) {
  const recentFinishedIds = new Set(jobs.filter((job) => !isActiveJob(job))
    .slice(-3).map((job) => job.id));
  return jobs.filter((job) => isActiveJob(job) || recentFinishedIds.has(job.id));
}
