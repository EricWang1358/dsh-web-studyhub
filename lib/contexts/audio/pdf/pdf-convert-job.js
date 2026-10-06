import { jobDir, readManifest } from '../../../mineru-job.js';
import { announceEnd, newConvertCard } from '../convert-card.js';
import { CONVERT_TEXT, TYPE } from '../convert-support.js';
import { holdSlot, observeLocalWith } from '../local-process-job.js';
import { openHistory, runConversion } from './convert-run.js';
import { observeClient, observeLocal } from './observed-mineru.js';
import { PDF_FIELDS, presentPdf } from './pdf-convert-view.js';

const gates = new WeakMap();
/** The one conversion at a time of a library (the original path chains on the same rule): its waiting line. */
export const gateFor = jobs => { let gate = gates.get(jobs); if (!gate) { gate = { limit: 1, active: new Set(), waiting: [] }; gates.set(jobs, gate); } return gate; };

const stoppedByLearner = signal => signal.reason?.code === 'user-cancel';

/** One conversion of one PDF (docs/plans/unified-job-runtime/s5-2-pdf-convert.md). The pieces, the windows, the cloud batch references, the merge and the import are
 * lib/mineru-job.js's own; the attempt around them (folder, history, import) is ./convert-run.js, the same one the original path runs. This definition admits (one at a time per
 * library), observes what goes out of this process, and settles: the letter and the notice are written inside the attempt, and the Job is terminal only after
 * the job folder was dealt with. */
export const pdfConvertDefinition = {
  kind: TYPE, version: 1, title: 'PDF conversion', legacyFields: PDF_FIELDS,
  capabilities: { cancel: true, retry: true },

  async admit(context, input, { worker: service, work }) {
    const root = service.store.root, dir = jobDir(root, input.convertId);
    const manifest = await readManifest(dir).catch(() => { throw new Error(CONVERT_TEXT.folderGone); });
    const card = newConvertCard({ manifest, root, language: service.language, serviceState: input.serviceState, queued: true });
    const history = openHistory({ root, job: card, manifest, service });
    context.present(presentPdf(card));
    const attempt = { service, root, dir, manifest, job: card, signal: context.signal, history, cancelled: () => stoppedByLearner(context.signal) };
    const lease = await holdSlot(context, gateFor(work.jobs));
    try { context.signal.throwIfAborted(); }
    catch (error) { await lease.finish(); await runConversion(attempt); throw error; }
    return { ...lease, state: { attempt } };
  },

  async run(context, _input, { worker: service }) {
    const { attempt } = context.admission.state, { job: card } = attempt;
    const observe = observeLocalWith(context.gateway, 'convert', 'mineru');
    const { outcome } = await runConversion({ ...attempt, convertOptions: { verifyCreates: true },
      instrument: { client: client => observeClient(client, observe), local: local => observeLocal(local, observe) } });
    // A conversion the learner stopped needs no letter and no notice.
    if (outcome !== 'cancelled') await announceEnd(service, { ...card, id: card.runtimeId });
    if (outcome === 'complete') return { refs: (card.sourceIds || []).map(id => ({ kind: 'source', id })), completeness: 'complete' };
    if (outcome === 'cancelled') throw context.signal.reason ?? new Error(card.stage);
    throw Object.assign(new Error(card.stage), card.errorCode ? { code: card.errorCode } : {});
  },
};
