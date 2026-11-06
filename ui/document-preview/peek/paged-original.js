/* The reader's seam for the bytes of an original. The reader holds a FILE URL for the original it shows: a blob of the whole file for a normal one, or (for a referenced
   original too big to send whole) a marker that stands for a PAGED original. Whatever draws a page (the 原始 PDF view, 看原页, the picture for 发给主会话) asks
   `originalBytes(fileUrl)`: the whole file's bytes, or a page source `{ kind: 'pages', total, fetchPage(n) }` that createPeekRenderer draws one page at a time
   (peek/paged-renderer.js) from materials.document.pages. Nothing of the file but the pages asked for ever reaches the browser. */

const PREFIX = 'studyhub-pages:';
const KEPT = 6;
const sources = new Map();

const bytesOf = base64 => Uint8Array.from(atob(base64), char => char.charCodeAt(0));

/** The file URL of a paged original (`paged` is what materials.document.bytes said: { documentId, revision, totalPages }); `call` is the reader's host call. */
export function pagedFileUrl(call, paged) {
  const url = `${PREFIX}${paged.documentId}:${paged.revision}`;
  sources.delete(url);
  sources.set(url, { kind: 'pages', total: paged.totalPages || 0,
    async fetchPage(number) {
      const answer = await call('materials.document.pages', { documentId: paged.documentId, revision: paged.revision, from: number, to: number });
      if (answer?.status !== 'ok') throw new Error(`The original file is ${answer?.reason === 'missing' ? 'missing' : 'unavailable'}`);
      return bytesOf(answer.dataBase64);
    } });
  while (sources.size > KEPT) sources.delete(sources.keys().next().value);
  return url;
}

/** Whether this file URL stands for a paged original. */
export const isPagedUrl = url => typeof url === 'string' && url.startsWith(PREFIX);

/** The original behind a file URL: its bytes (a Uint8Array), or the page source of a paged original; null when there is none. */
export async function originalBytes(fileUrl) {
  if (isPagedUrl(fileUrl)) return sources.get(fileUrl) ?? null;
  return new Uint8Array(await (await fetch(fileUrl)).arrayBuffer());
}
