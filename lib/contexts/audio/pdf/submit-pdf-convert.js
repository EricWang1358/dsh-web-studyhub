import { CONVERT_TEXT, TYPE } from '../convert-support.js';
import { gateFor } from './pdf-convert-job.js';

/** The conversion receipt the panel has always been given (the Job's own id is the one to follow it by). */
const receipt = ({ job, manifest, queuedBehind }) => ({ jobId: job.runtime.legacyId, status: job.status, queuedBehind, pages: manifest.totalPages,
  chunks: manifest.chunks.map(chunk => ({ index: chunk.index + 1, startPage: chunk.startPage, endPage: chunk.endPage, pages: chunk.pages })),
  converter: manifest.converter || 'mineru',
  next: CONVERT_TEXT.started({ converter: manifest.converter, route: manifest.route }) });

/** Start a prepared conversion as a Job (runtime.pilot.pdfConvert). What the learner confirmed and the manifest on disk were decided by the operation that prepared it;
 * the Job reads the manifest again when it is admitted, so a retry continues from what is finished. */
export async function startPdfConvert(service, { manifest, serviceState }) {
  const { runtimeJobs: jobs, runtimeBinding } = service, binding = runtimeBinding();
  const gate = gateFor(binding.work.jobs), queuedBehind = gate.active.size >= gate.limit ? gate.waiting.length + 1 : 0;
  try {
    const job = await jobs.submit(TYPE, { convertId: manifest.id, ...(serviceState ? { serviceState } : {}) }, {}, binding);
    return receipt({ job, manifest, queuedBehind });
  } catch (error) { throw error?.code === 'executor-unavailable' ? Object.assign(new Error(CONVERT_TEXT.needsSession), { code: 'convert-needs-session' }) : error; }
}
