import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.mjs';
import { peekCanvasSize } from './peek-logic.js';

/* 看原页: pdf.js behind a tiny interface. This module (pdf.js, about a megabyte, and its worker) is only ever imported by PagePeek.jsx,
   which the viewer loads lazily on the first peek, never with the reader; the worker runs on the main thread (the page is a bundle with no worker file to point at). One document is open
   at a time and is destroyed with its pages when the peek closes. A page is drawn into an offscreen canvas and handed back as an
   ImageBitmap (the offscreen canvas is emptied at once); the caller owns the bitmap and closes it. Nothing here keeps a page. */

function loadPdfjs() {
  globalThis.pdfjsWorker ||= { WorkerMessageHandler };
  return pdfjs;
}

/** True when an error only says a render was cancelled (the page changed or the peek closed). */
export const isCancelled = error => error?.name === 'RenderingCancelledException' || error?.name === 'AbortException' || error?.name === 'AbortError';

/**
 * Open `bytes` (a Uint8Array of a PDF) for peeking: { numPages, pageSize(n), render(n, { scale, signal }), destroy() }.
 * pageSize -> { width, height } in PDF units. render -> ImageBitmap no larger than 2000 px on its long edge.
 */
export async function createPeekRenderer(bytes) {
  const task = loadPdfjs().getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true, enableXfa: false, verbosity: 0 });
  let doc;
  try { doc = await task.promise; }
  catch (error) { await task.destroy().catch(() => {}); throw error; }
  const sizes = new Map();
  return {
    numPages: doc.numPages,
    async pageSize(number) {
      if (!sizes.has(number)) {
        const page = await doc.getPage(number);
        const unit = page.getViewport({ scale: 1 });
        sizes.set(number, { width: unit.width, height: unit.height });
        page.cleanup();
      }
      return sizes.get(number);
    },
    async render(number, { scale, signal }) {
      const page = await doc.getPage(number);
      try {
        signal?.throwIfAborted();
        const unit = page.getViewport({ scale: 1 });
        const size = peekCanvasSize({ width: unit.width, height: unit.height, scale });
        const canvas = document.createElement('canvas');
        canvas.width = size.width; canvas.height = size.height;
        const render = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale: size.scale }) });
        const cancel = () => render.cancel();
        signal?.addEventListener('abort', cancel, { once: true });
        try { await render.promise; } finally { signal?.removeEventListener('abort', cancel); }
        signal?.throwIfAborted();
        const bitmap = await createImageBitmap(canvas);
        canvas.width = 0; canvas.height = 0;
        return bitmap;
      } finally { page.cleanup(); }
    },
    async destroy() { sizes.clear(); try { await task.destroy(); } catch { /* already gone */ } },
  };
}
