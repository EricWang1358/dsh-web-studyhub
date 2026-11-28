import { closeRecord, openRecord, plainReason, updateRecord } from '../../../mineru-history.js';
import { historyOpening } from '../convert-card.js';
import { endedPlan, recordWindows } from '../convert-support.js';

const quiet = work => Promise.resolve(work).catch(() => null);

/** The conversion history (lib/mineru-history.js): a durable row opened now and kept up to date. It is best effort: a row that cannot be written never stops
 * or fails the conversion. Writes are queued per library, so the end always lands after the progress. */
export function openHistory({ root, job, manifest, service }) {
  const clock = () => (service.mineru?.clock ?? Date.now)();
  const opened = quiet(openRecord(root, historyOpening(job, manifest), { now: clock }));
  let seen = '';
  return { opened,
    progress({ phase, done, chunk, chunks }) {
      const key = `${phase}|${chunk?.index || 0}|${done}|${chunks?.length || 0}|${job.local?.halved || 0}`;
      if (key === seen) return;
      seen = key;
      const fields = { phase, piece: chunk?.index || undefined, pagesDone: done, windows: recordWindows(chunks, { current: chunk?.index }) };
      void quiet(updateRecord(root, job.id, fields, { now: clock }));
    },
    /** The book is saved: the record names its document now, so the file it was made from can be recognised before the conversion ends. */
    imported(documentId) { return quiet(updateRecord(root, job.id, { documentId }, { now: clock })); },
    /** What happened, for the history: complete only when the document was really imported; held while it waits for the learner; the stage is where it stopped. */
    close({ outcome, shutdown, reached, secret, importedTitle }) {
      const ended = outcome === 'complete'
        ? { status: 'complete', documentId: job.documentId, title: importedTitle, importedPages: job.sourceIds?.length ?? 0, skippedPages: job.skippedPages?.length ?? 0,
          pagesDone: job.total,
          pieces: job.chunks?.length, windows: recordWindows(job.chunks, { finished: true }), plan: endedPlan(manifest.plan, job.local) }
        : outcome === 'held' ? { status: 'held', pagesDone: manifest.totalPages, pieces: job.chunks?.length, windows: recordWindows(job.chunks, { finished: true }),
          plan: endedPlan(manifest.plan, job.local) }
        : outcome === 'cancelled'
          ? { status: 'cancelled', pagesDone: job.done, pieces: job.chunks?.length, windows: recordWindows(job.chunks), plan: endedPlan(manifest.plan, job.local) }
          : shutdown ? { status: 'interrupted', pagesDone: job.done }
            : { status: 'failed', pagesDone: job.done, pieces: job.chunks?.length, windows: recordWindows(job.chunks), plan: endedPlan(manifest.plan, job.local),
              failure: { stage: reached ? job.phase : 'start', piece: job.chunk?.index || undefined, reason: plainReason(job.stage, { secrets: secret ? [secret] : [] }), code: job.errorCode } };
      return quiet(closeRecord(root, job.id, ended, { now: clock }));
    } };
}
