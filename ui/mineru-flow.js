/* The pure side of the MinerU conversion entry (cloud and local): which route to lead with, how a PDF goes to the
   backend, and how long things take in words. No React, no DOM beyond a File's own methods, so it runs in tests. */

const MB = 1024 * 1024;
const UPLOAD_SLICE = 2 * MB;

/** Base64 of a Blob slice, without FileReader (works in the browser and in Node tests). */
async function sliceBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/**
 * Hand a PDF to the backend in small pieces (the panel transport caps a request): start, chunks, finish. Nothing leaves the
 * computer here; the backend keeps the file in the DSH home until a conversion is started or the upload is cancelled.
 * onProgress(fraction 0..1); signal stops between pieces. Resolves the upload id.
 */
export async function uploadPdf(call, file, { onProgress, signal } = {}) {
  const started = await call('mineru.upload.start', { name: file.name, size: file.size });
  const piece = Math.max(1, Math.min(started.chunkBytes || UPLOAD_SLICE, UPLOAD_SLICE));
  try {
    for (let offset = 0; offset < file.size; offset += piece) {
      signal?.throwIfAborted();
      await call('mineru.upload.chunk', { uploadId: started.uploadId, offset, data: await sliceBase64(file.slice(offset, offset + piece)) });
      onProgress?.(Math.min(1, (offset + piece) / file.size));
    }
    signal?.throwIfAborted();
    await call('mineru.upload.finish', { uploadId: started.uploadId });
  } catch (error) {
    await Promise.resolve(call('mineru.upload.cancel', { uploadId: started.uploadId })).catch(() => {});
    throw error;
  }
  return started.uploadId;
}

/**
 * The route to lead with: the local mineru when it is ready (free, nothing uploaded), else the cloud when a token is set,
 * else 'gate' (the setup gate). `local` is mineru.local.status, `settings` is mineru.settings.get; either may be null (not read yet).
 */
export function chooseRoute({ local, settings } = {}) {
  if (local?.state === 'ready') return 'local';
  if (settings?.token?.set) return 'cloud';
  return 'gate';
}

/** Whole minutes for a duration in seconds, at least 1 (an estimate is never shown as "0 minutes"). */
export const minutesOf = seconds => Math.max(1, Math.round(Number(seconds) / 60));

/** The local estimate for a book: seconds per page of the tier times its pages (measured once on one CPU laptop; always labelled an estimate). */
export function localEstimate(pages, tier, estimates = {}) {
  const per = Number(estimates[tier]);
  return Number.isFinite(per) && per > 0 ? Math.round(pages * per) : null;
}

/** Megabytes with one decimal below 10, whole above; "0.8 GB" style for 1000 MB and up. */
export function sizeLabel(megabytes) {
  const value = Number(megabytes);
  if (!Number.isFinite(value)) return '';
  if (value >= 1000) return `${(value / 1000).toFixed(1)} GB`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} MB`;
}

/** "1–50" for a piece of pages, "7" for a single page. */
export const pageRange = (start, end) => (start === end ? `${start}` : `${start}–${end}`);

/** Whether a conversion job is the kind the card draws. */
export const isConvertJob = job => job?.type === 'pdf-convert';

/** The phase codes the backend reports, in the order a conversion goes through them (the local route has just one). */
export const CLOUD_PHASES = Object.freeze(['split', 'upload', 'parse', 'download', 'merge', 'save']);
export const LOCAL_PHASES = Object.freeze(['local', 'merge', 'save']);
