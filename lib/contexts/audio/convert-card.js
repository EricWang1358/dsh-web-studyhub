import { notify } from '../../inbox.js';
import { CONVERT_TEXT, TYPE, adaptiveOf, finishedPages, publicChunks, recordWindows, stageText, windowsOfPlan } from './convert-support.js';

/** The working card of a conversion: what the job record of the panel carries while it runs. `id` and `status` are the card's own until a runtime Job presents it. */
export function newConvertCard({ manifest, root, language, serviceState, queued }) {
  const local = manifest.route === 'local', phase = queued ? 'queued' : 'split';
  return { id: manifest.id, root, type: TYPE, converter: manifest.converter || 'mineru', route: manifest.route || 'cloud', ...(manifest.tier ? { tier: manifest.tier } : {}), filename: manifest.filename,
    status: queued ? 'queued' : 'running', ...(manifest.env ? { env: manifest.env } : {}), ...(local ? { service: serviceState || { state: 'unknown', basis: 'none', at: new Date().toISOString() } } : {}),
    stage: stageText(phase), phase, done: finishedPages(manifest), total: manifest.totalPages, chunk: { index: 0, count: adaptiveOf(manifest) ? 0 : manifest.chunks.length },
    chunks: publicChunks(manifest), warnings: [], note: '', fingerprint: manifest.sourceHash, ...(adaptiveOf(manifest) ? { local: { adaptive: true } } : {}),
    courses: manifest.courses, startedAt: new Date().toISOString(), language };
}

/** What the history opens a row with for a conversion that is about to start. */
export const historyOpening = (job, manifest) => ({ id: job.id, filename: job.filename, bytes: manifest.sourceBytes, pages: manifest.totalPages, pieces: manifest.chunks.length,
  converter: job.converter, route: job.route, tier: job.tier, pagesDone: job.done, phase: job.phase, title: manifest.title,
  env: manifest.env && { ...manifest.env, ...(manifest.env.kind === 'local' ? { windows: windowsOfPlan(manifest.plan) } : {}) }, plan: manifest.plan, windows: recordWindows(publicChunks(manifest)) });

/** The letter about a conversion that ended (not one the learner stopped) and the notice to the session. A letter that cannot be written is a warning on the card, never a failure. */
export async function announceEnd(service, job) {
  const kind = job.status === 'complete' ? 'pdf-result' : 'pdf-failed';
  try {
    await service.store.update(state => {
      for (const item of state.inbox || []) if (item.jobId === job.id) item.sourceIds = job.sourceIds || [];
      notify(state, { kind, jobId: job.id, filename: job.filename, sourceIds: job.sourceIds,
        detail: job.status === 'failed' && job.retryable ? `${job.stage.length > 90 ? `${job.stage.slice(0, 89)}…` : job.stage} ${CONVERT_TEXT.resumeHint}` : job.stage });
    });
  } catch { job.warnings.push(CONVERT_TEXT.letterFailed); }
  service.announceJob?.(job);
}

/** The letter about a failure is superseded by the retry; if the retry fails too, it brings its own. */
export const withdrawFailureLetter = (ports, jobId) => ports.state.update(state => {
  if (Array.isArray(state.inbox)) state.inbox = state.inbox.filter(item => !(item.kind === 'pdf-failed' && item.jobId === jobId));
});
