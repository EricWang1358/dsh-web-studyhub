import { CONVERT_TEXT } from '../convert-support.js';

/** A conversion of a file the learner pointed at keeps no copy: it remembers where the file is, as the document's original (a reference: nothing is copied, whatever the size).
 *  The file must be the very one that was converted (its hash is on the conversion's history record); anything else is said as a warning on the card, never a failure. */
export async function keepOriginal({ service, manifest, imported, job, log }) {
  if (!manifest.sourcePath || !imported?.documentId || typeof service.documents?.attachOriginal !== 'function') return;
  try {
    const kept = await service.documents.attachOriginal({ documentId: imported.documentId, revision: imported.revision, path: manifest.sourcePath, mode: 'reference' });
    if (kept?.status !== 'attached') throw new Error('not the converted file');
    log({ level: 'step', code: 'original-kept', args: { bytes: kept.original?.bytes ?? null } });
  } catch {
    job.warnings.push(CONVERT_TEXT.originalNotKept);
    log({ level: 'warn', code: 'original-not-kept', text: CONVERT_TEXT.originalNotKept });
  }
}
