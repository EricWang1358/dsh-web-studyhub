import { hasOwnDeck, sampleIdsOf } from '../study-map/home-plan.js';
import { modelReadiness } from '../generation-status.js';
import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { isActiveJob, isAudioJob, JOB_STATUS, JOB_TYPES } from '../../lib/job-status.js';

/* The first-run line (3.6 D2): 配模型 → 加资料 → 做第一组, the one way from an empty library to a first deck of the learner's own. Pure: what the line shows is
   read off the library snapshot, and ui/first-run/FirstRunLine.jsx draws it (the whole first screen, or the compact card after 「以后再说」). The line is there
   until the learner has published a deck of their own (hasOwnDeck); the sample course's material, draft, decks and jobs never count, so a loaded sample
   neither ticks a step nor hides one. */

/** The steps, in order. */
export const FIRST_RUN_STEPS = Object.freeze(['model', 'material', 'deck']);

/** What the third step can be: nothing to make it from yet, ready to start, a run going, a run that ended without a draft, a draft to publish at once, a draft to look at first. */
export const DECK_STATES = Object.freeze(['waiting', 'ready', 'generating', 'failed', 'draft-clean', 'draft-review']);

// The jobs of the home's question runs (the cards the home draws), not a conversion, an audio import, a translation, 为你定制, a repair, a publication or a supplement to a deck.
const NOT_A_RUN = new Set([JOB_TYPES.PDF_CONVERT, JOB_TYPES.TRANSLATION, JOB_TYPES.COACH_DAILY, JOB_TYPES.DRAFT_PUBLISH, JOB_TYPES.DRAFT_REPAIR, JOB_TYPES.SUPPLEMENT]);
const ENDED = new Set([JOB_STATUS.FAILED, JOB_STATUS.CANCELLED, JOB_STATUS.INTERRUPTED]);

/** Is this job a question run of the first deck (the card the line's third step carries)? */
export const isFirstRunJob = (job) => !!job && !isAudioJob(job) && !NOT_A_RUN.has(job.type) && job.origin !== 'selection';

/** The newest draft of the learner's own (the sample's does not count), or null. The third step publishes or opens this one. */
export function firstRunDraft(data) {
  const sample = sampleIdsOf(data);
  return (data?.drafts || []).filter((draft) => !draft.sample && !sample.has(draft.id)).at(-1) || null;
}

/**
 * The line for a library snapshot: { show, step, steps }. `show` is false once the learner has published a deck of their own (and for no snapshot); then
 * `step` is -1 and `steps` is empty. Otherwise `step` is the index of the one step that is open, and `steps` are, in FIRST_RUN_STEPS order:
 *   model     { status: 'done' | 'todo', ready, reason, label, verified }: the readiness (modelReadiness); `verified` when DSH said the key is there too
 *   material  { status: 'done' | 'todo', count, title, sourceIds }: the learner's own materials (a PDF is one), the newest one's title, their ids
 *   deck      { status: one of DECK_STATES, draft, jobIds, sourceIds, modelReady }: `jobIds` are the runs the step carries (the running ones, or the one
 *             that ended without a draft), `draft` the draft it publishes or opens
 * `publishAtOnce` is what canPublishAtOnce (ui/draft-publish.js) says of that draft: 'draft-clean' only then, else 'draft-review'.
 * The open step: the third while something is made or waits there; else the model while there is none; else the material while there is none; else the third.
 * The second step is never locked behind the first: a material can be added before the model is set up.
 */
export function firstRunLine(data, { publishAtOnce = false } = {}) {
  if (!data || hasOwnDeck(data)) return { show: false, step: -1, steps: [] };
  const sample = sampleIdsOf(data);
  const own = (item) => !!item && !item.sample && !sample.has(item.id);
  const readiness = modelReadiness(data);
  const model = { id: 'model', status: readiness.ready ? 'done' : 'todo', ready: readiness.ready, reason: readiness.reason, label: readiness.label, verified: readiness.ready && readiness.reason === 'ok' };
  // Materials as the learner counts them (a PDF is one, by its document's title, as 资料 shows it).
  const sources = (data.sources || []).filter(own), documents = groupSourcesByDocument(sources).filter((item) => !item.archived), count = documents.length;
  const material = { id: 'material', status: count ? 'done' : 'todo', count, title: documents.at(-1)?.title || '', sourceIds: sources.map((source) => source.id) };
  const draft = firstRunDraft(data);
  const sampleDraft = (job) => !!job.draftId && (sample.has(job.draftId) || (data.drafts || []).some((item) => item.id === job.draftId && item.sample));
  const runs = (data.jobs || []).filter((job) => isFirstRunJob(job) && !sampleDraft(job));
  const running = runs.filter(isActiveJob);
  const last = runs.filter((job) => !isActiveJob(job)).at(-1);
  const failed = !draft && last && ENDED.has(last.status) && !last.continuedBy ? last : null;
  const status = running.length ? 'generating' : draft ? (publishAtOnce ? 'draft-clean' : 'draft-review') : failed ? 'failed' : count ? 'ready' : 'waiting';
  const deck = { id: 'deck', status, draft, jobIds: running.length ? running.map((job) => job.id) : failed ? [failed.id] : [], sourceIds: material.sourceIds, modelReady: readiness.ready };
  const working = ['generating', 'failed', 'draft-clean', 'draft-review'].includes(status);
  const step = working ? 2 : model.status === 'todo' ? 0 : material.status === 'todo' ? 1 : 2;
  return { show: true, step, steps: [model, material, deck] };
}
