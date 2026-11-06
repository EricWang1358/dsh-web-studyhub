import { baseName } from './file-names.js';
import { unquotePath } from './paths.js';
import { uploadPdf } from './mineru-flow.js';

/* Where a PDF for the local converters comes from. With a native file dialog (host.pickFile) the learner chooses a PATH: nothing is copied through the browser (a 500-page textbook is
   hundreds of MB), the plan and the import take the path, and the finished book is linked to that file as its original (lib/contexts/audio/pdf/keep-original.js). Without one, the browser
   file is uploaded in pieces and the backend keeps a staged copy until the conversion starts, as it always did. Pure: it runs in tests. */

/** Whether this host has a native file dialog. */
export const canPickNative = host => typeof host?.pickFile === 'function';

/** A PDF chosen by path (not a browser File). */
export const isNativeSource = file => !!file && typeof file.path === 'string' && file.native === true;

/** Ask the host's dialog for a PDF: { path, name, size?, native: true }, or null when the learner closed it. */
export async function pickNativePdf(host) {
  const chosen = await host.pickFile({ extensions: ['pdf'] });
  const raw = typeof chosen === 'string' ? chosen : chosen?.path, path = typeof raw === 'string' ? unquotePath(raw) : '';
  if (!path) return null;
  return { path, name: baseName(path), size: Number.isFinite(chosen?.size) ? chosen.size : undefined, native: true };
}

/**
 * Read a PDF's plan: by its path (no upload), or after uploading the browser file. -> { uploadId ('' for a path), plan }, or null when `signal` stopped it after the upload
 * (the staged copy is cancelled then). `onUploaded(id)` tells the caller which upload to cancel if it goes away before a conversion starts.
 */
export async function prepareSource(call, file, { signal, onProgress, onUploaded } = {}) {
  if (isNativeSource(file)) return { uploadId: '', plan: await call('mineru.plan', { path: file.path }) };
  const uploadId = await uploadPdf(call, file, { signal, onProgress });
  onUploaded?.(uploadId);
  if (signal?.aborted) { await call('mineru.upload.cancel', { uploadId }); return null; }
  return { uploadId, plan: await call('mineru.plan', { uploadId }) };
}

/** What a conversion's start call is given for this source: the path, or the staged upload. */
export const sourceArgs = (file, uploadId) => (isNativeSource(file) ? { path: file.path } : { uploadId });
