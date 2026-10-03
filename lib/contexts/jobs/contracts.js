/* Stage codes of study jobs (plan P29). Jobs keep their stage prose for the
   agent and for logs; every public job also carries `stageCode`, a stable word
   the UI translates. Codes are derived from the job's status and type first,
   and from its prose only for the running sub-stages, so old job records and
   jobs from an older backend read the same way.

   Pure module: the UI imports it too, and other contexts may import it
   (tests/architecture-boundaries allows cross-context contracts.js imports). */

export const JOB_STAGE_CODES = Object.freeze(['queued', 'planning', 'blueprinting', 'authoring', 'reviewing', 'repairing', 'publishing',
  'cancelling', 'cancelled', 'done', 'partial', 'failed']);

/** The progress prose lib/generation.js reports, keyed by its stage code. */
export const GENERATION_STAGE_TEXT = Object.freeze({
  planning: 'Planning evidence and learning targets',
  blueprinting: 'Preparing supported answers and scenarios',
  authoring: 'Writing and self-checking questions',
  reviewing: 'Reviewing ambiguity and source support',
});

// Most specific first: "Reviewing repaired questions" is a review, "发布前逐题复审" a publication.
const PROSE = [
  ['blueprinting', /Preparing supported answers|确定答案与情景/i],
  ['planning', /Planning evidence|规划考点/i],
  ['publishing', /Publishing|Publication|发布/i],
  ['reviewing', /Review|Checking citations|审阅|复审|验收|核验/i],
  ['repairing', /Repair|修复|修题/i],
  ['authoring', /Writing|Parallel generation|Self-checking|出题|生成/i],
];

/** Code of one stage text (a job step's or a running job's), or undefined when unknown. */
export function stageCodeForText(text) {
  if (typeof text !== 'string' || !text) return undefined;
  return PROSE.find(([, pattern]) => pattern.test(text))?.[0];
}

export const stepStageCode = (step) => stageCodeForText(step?.stage);

const incomplete = (job) => !['draft-repair', 'draft-publish'].includes(job.type) &&
  job.requestedTotal > 0 && (job.savedCount ?? 0) < job.requestedTotal;

/** Stage code of a question job; undefined for audio imports, which report their own phases. */
export function stageCodeOf(job) {
  if (!job || typeof job !== 'object' || job.type === 'audio-import') return undefined;
  switch (job.status) {
    case 'queued': return 'queued';
    case 'cancelling': return 'cancelling';
    case 'cancelled': return 'cancelled';
    case 'failed': return 'failed';
    case 'partial': return 'partial';
    case 'complete': return incomplete(job) ? 'partial' : 'done';
  }
  if (job.type === 'draft-publish') return 'publishing';
  const code = stageCodeForText(job.stage);
  if (job.type === 'draft-repair') return code === 'reviewing' ? 'reviewing' : 'repairing';
  return code === 'repairing' ? 'authoring' : code || 'authoring';
}

/** A job as the API shows it, with its stage code. Steps keep their prose
    unchanged; readers classify them with stepStageCode(). */
export function withStageCodes(job) {
  const stageCode = stageCodeOf(job);
  return stageCode ? { ...job, stageCode } : job;
}
