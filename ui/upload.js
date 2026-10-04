/* Handing a file to the backend: base64 of a piece, and the upload protocol every importer shares.
   `call` is the panel's host call. The backend keeps the file until the import starts or the upload is cancelled. */

const MB = 1024 * 1024;
const DEFAULT_PIECE = 2 * MB;

/** Base64 of a Blob or Blob slice, without FileReader (works in the browser and in Node tests). */
export async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/**
 * Upload `file` through `${namespace}.upload.start | chunk | finish`, cancelling (`.cancel`) when anything fails or the
 * signal aborts. A piece is at most `maxChunkBytes` (2 MB unless asked) and never more than the host's own `chunkBytes`.
 * `onStart(started)` fires once the host has an upload id (so a caller can cancel it later); `onProgress(fraction 0..1,
 * bytesSent)` after each piece. Resolves the upload id.
 */
export async function uploadInChunks(call, namespace, file, { onProgress, onStart, signal, maxChunkBytes = DEFAULT_PIECE } = {}) {
  signal?.throwIfAborted();
  const started = await call(`${namespace}.upload.start`, { name: file.name, size: file.size });
  onStart?.(started);
  const piece = Math.max(1, Math.min(started.chunkBytes || maxChunkBytes, maxChunkBytes));
  try {
    for (let offset = 0; offset < file.size; offset += piece) {
      signal?.throwIfAborted();
      await call(`${namespace}.upload.chunk`, { uploadId: started.uploadId, offset, data: await toBase64(file.slice(offset, offset + piece)) });
      const sent = Math.min(file.size, offset + piece);
      onProgress?.(sent / file.size, sent);
    }
    signal?.throwIfAborted();
    await call(`${namespace}.upload.finish`, { uploadId: started.uploadId });
  } catch (error) {
    await Promise.resolve(call(`${namespace}.upload.cancel`, { uploadId: started.uploadId })).catch(() => {});
    throw error;
  }
  return started.uploadId;
}
