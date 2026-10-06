import { locateMarker, parseMarkerWindow } from '../../../marker-local.js';
import { readMarkerSettings } from '../../../marker-settings.js';
import { NO_MINERU_TOKEN, hasMineruToken, readMineruSettings } from '../../../mineru-settings.js';
import { createMineruClient } from '../../../mineru-api.js';
import { convertPdf, discardJob } from '../../../mineru-job.js';
import { PdfChunkError } from '../../../pdf-chunker.js';
import { LocalMineruError, locateMineru } from '../../../mineru-local.js';
import { closeRecord, openRecord, plainReason, updateRecord } from '../../../mineru-history.js';
import { historyOpening } from '../convert-card.js';
import { CONVERT_TEXT, NO_MATERIALS, endedPlan, recordWindows, stageText } from '../convert-support.js';

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
      if (key !== seen) { seen = key; void quiet(updateRecord(root, job.id, { phase, piece: chunk?.index || undefined, pagesDone: done, windows: recordWindows(chunks, { current: chunk?.index }) }, { now: clock })); }
    },
    /** What happened, for the history: complete only when the document was really imported; the stage is where it stopped. */
    close({ shutdown, reached, secret, importedTitle }) {
      const ended = job.status === 'complete'
        ? { status: 'complete', documentId: job.documentId, title: importedTitle, importedPages: job.sourceIds?.length ?? 0, skippedPages: job.skippedPages?.length ?? 0, pagesDone: job.total,
          pieces: job.chunks?.length, windows: recordWindows(job.chunks, { finished: true }), plan: endedPlan(manifest.plan, job.local) }
        : job.status === 'cancelled' ? { status: 'cancelled', pagesDone: job.done, pieces: job.chunks?.length, windows: recordWindows(job.chunks), plan: endedPlan(manifest.plan, job.local) }
          : shutdown ? { status: 'interrupted', pagesDone: job.done }
            : { status: 'failed', pagesDone: job.done, pieces: job.chunks?.length, windows: recordWindows(job.chunks), plan: endedPlan(manifest.plan, job.local),
              failure: { stage: reached ? job.phase : 'start', piece: job.chunk?.index || undefined, reason: plainReason(job.stage, { secrets: [secret] }), code: job.errorCode } };
      return quiet(closeRecord(root, job.id, ended, { now: clock }));
    } };
}

/** One attempt at a conversion: convert, import, clean up, write the history. The card (`job`) says where it is, the whole time; it ends as 'complete', 'cancelled' or
 * 'failed' only after the job folder has been dealt with. Resolves { cancelled, shutdown }, never rejects. `cancelled()` says whether the learner asked for the stop (else a stop
 * is the plugin closing). `instrument` wraps what starts work outside this process (the MinerU client, the local window runner) so a Job can observe it. */
export async function runConversion({ service, root, dir, manifest, job, signal, history, cancelled, instrument = {}, convertOptions = {} }) {
  let secret = '', reached = false, importedTitle;
  const seam = (manifest.converter === 'marker' ? service.marker : service.mineru) || {};
  const onProgress = patch => {
    const { phase, done, total, chunk, chunks, note } = patch;
    Object.assign(job, { phase, done, total, chunk, chunks, note: note || '' });
    job.stage = stageText(phase, chunk);
    if (patch.service) job.service = patch.service;
    if (patch.local) job.local = patch.local;
    if ('liveness' in patch) { if (patch.liveness) job.liveness = patch.liveness; else delete job.liveness; }
    history.progress({ phase, done, chunk, chunks });
  };
  const importMerged = async ({ bytes, filename, title, courses, format = 'json' }) => {
    if (!service.documents) throw new Error(NO_MATERIALS);
    return service.documents.import({ dataBase64: bytes.toString('base64'), filename, format, ...(title ? { title } : {}), ...(courses ? { courses } : {}) });
  };
  try {
    await history.opened;
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    job.status = 'running'; job.phase = 'split'; job.stage = stageText('split'); job.startedAt = new Date().toISOString();
    let client, local;
    if (manifest.route === 'local') {
      // Free and offline: no token, nothing uploaded. The CLI is looked for again now, in case it moved since the job was made.
      // (`parseWindow` and `now` are seams of a test or a preview: a stand-in machine of a chosen speed on a clock it owns.)
      local = manifest.converter === 'marker'
        ? { cli: seam.local && 'cli' in seam.local ? seam.local.cli : locateMarker(await readMarkerSettings()), timeoutMs: seam.local?.timeoutMs, parseWindow: parseMarkerWindow, liveness: false }
        : { cli: seam.local && 'cli' in seam.local ? seam.local.cli : locateMineru(), timeoutMs: seam.local?.timeoutMs, parseWindow: seam.local?.parseWindow, now: seam.local?.now };
      if (instrument.local) local = instrument.local(local);
    } else {
      const settings = await readMineruSettings();
      if (!hasMineruToken(settings)) throw new Error(NO_MINERU_TOKEN);
      secret = settings.token;
      client = createMineruClient({ token: settings.token, ...(seam.baseUrl ? { baseUrl: seam.baseUrl } : {}) });
      if (instrument.client) client = instrument.client(client);
    }
    reached = true;
    const outcome = await convertPdf({ dir, manifest, root, client, local, signal, onProgress, importMerged, sleep: seam.sleep, now: seam.now, limits: seam.limits, ...convertOptions });
    const imported = outcome.imported || {};
    importedTitle = imported.document?.title;
    Object.assign(job, { status: 'complete', phase: 'done', done: job.total, note: '', sourceIds: imported.sourceIds || [], documentId: imported.documentId,
      skippedPages: imported.skippedPages || [], stage: CONVERT_TEXT.savedAs(imported.sourceIds?.length ?? 0) });
    for (const text of [...(imported.warnings || []), ...(outcome.notes || [])]) if (!job.warnings.includes(text)) job.warnings.push(text);
    try { await discardJob(root, job.id, { sourceHash: manifest.sourceHash, converter: manifest.converter }); } catch { job.warnings.push(CONVERT_TEXT.cleanupLeft); }
  } catch (error) {
    job.note = '';
    if (error instanceof LocalMineruError && error.code === 'server-stopped') job.service = { state: 'stopped', basis: 'window', at: new Date().toISOString() };
    if (cancelled()) {
      // The folder is dealt with first: a cancelled conversion is cancelled when nothing of it is still running or half removed.
      await discardJob(root, job.id, { keepResults: true, sourceHash: manifest.sourceHash, converter: manifest.converter }).catch(() => {});
      Object.assign(job, { status: 'cancelled', retryable: false, stage: CONVERT_TEXT.cancelled });
    } else {
      const permanent = error instanceof PdfChunkError;
      Object.assign(job, { status: 'failed', retryable: !permanent, stage: String(error?.message || error).slice(0, 400) });
      if (error.code) job.errorCode = String(error.code).slice(0, 40);
      if (permanent) await discardJob(root, job.id, { keepResults: true, sourceHash: manifest.sourceHash, converter: manifest.converter }).catch(() => {});
    }
  }
  job.finishedAt = new Date().toISOString();
  const shutdown = job.status === 'failed' && signal.aborted && !cancelled();
  await history.close({ shutdown, reached, secret, importedTitle });
  return { cancelled: job.status === 'cancelled', shutdown };
}
