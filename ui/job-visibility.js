const ACTIVE = new Set(["queued", "running", "cancelling"]);

export const isActiveJob = (job) => ACTIVE.has(job.status);

export function visibleGenerationJobs(jobs = []) {
  const recentFinishedIds = new Set(jobs.filter((job) => !isActiveJob(job))
    .slice(-3).map((job) => job.id));
  return jobs.filter((job) => isActiveJob(job) || recentFinishedIds.has(job.id));
}
