import { pdfPageFor } from './peek-logic.js';

/* 发给主会话 of a page (#488): the picture of a PDF page as a file for the main chat's input box. It draws through the peek's renderer (pdf.js, fetched on the
   first use, never with the reader), opens the document for this one job and closes it after. What cannot be shown truly gives no picture: a file whose
   page count disagrees with the text, a page it does not have, or images that did not decode (the page would come out blank). */

/** The long edge of the picture: enough to read a figure and its labels, far below what a chat takes. */
export const PAGE_IMAGE_EDGE = 1600;
const JPEG_QUALITY = 0.85;

async function jpegOf(bitmap, name) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const blob = await new Promise(done => canvas.toBlob(done, 'image/jpeg', JPEG_QUALITY));
  canvas.width = 0; canvas.height = 0;
  if (!blob) throw new Error('This page could not be turned into a picture.');
  return new File([blob], name, { type: 'image/jpeg' });
}

// Through the peek's own chunk: pdf.js stays one lazy module, so this adds no chunk and no load wave.
const openPeek = async bytes => (await import('./PagePeek.jsx')).createPeekRenderer(bytes);

/**
 * renderPageImages({ loadBytes, pages, totalPages }) -> File[], one per page that can be shown truly, in order; [] when there is no file. A failure of pdf.js rejects.
 * loadBytes(): the original's bytes (a Uint8Array), null when gone. deps (tests): openRenderer, encode(bitmap, name).
 */
export async function renderPageImages({ loadBytes, pages, totalPages = 0, openRenderer = openPeek, encode = jpegOf }) {
  const bytes = await loadBytes();
  if (!bytes) return [];
  const renderer = await openRenderer(bytes), files = [];
  try {
    for (const page of pages) {
      if (!pdfPageFor({ page, totalPages, pdfPages: renderer.numPages }).ok) continue;
      const unit = await renderer.pageSize(page);
      let undecoded = 0;
      const bitmap = await renderer.render(page, { scale: PAGE_IMAGE_EDGE / Math.max(unit.width, unit.height), onReport: report => { undecoded = report.undecoded; } });
      try { if (!undecoded) files.push(await encode(bitmap, `page-${page}.jpg`)); } finally { bitmap.close?.(); }
    }
  } finally { await renderer.destroy(); }
  return files;
}
