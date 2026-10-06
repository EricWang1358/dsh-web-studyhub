import { TYPE, adaptiveOf, finishedPages, publicChunks, recordWindows, stageText, windowsOfPlan } from './convert-support.js';

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
