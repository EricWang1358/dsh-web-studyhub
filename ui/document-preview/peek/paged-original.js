/* The reader's seam for the bytes of an original. The reader holds a FILE URL for the original it shows: a blob of the whole file for a normal one, or (for a referenced
   original too big to send whole) a marker that stands for a PAGED original. Whatever draws a page (the 原始 PDF view, 看原页, the picture for 发给主会话) asks
   `originalBytes(fileUrl)`: the whole file's bytes, or a page source `{ kind: 'pages', total, fetchPage(n) }` that createPeekRenderer draws one page at a time
   (peek/paged-renderer.js) from materials.document.pages. Nothing of the file but the pages asked for ever reaches the browser. */

import { ui } from '../../i18n.js';

const PREFIX = 'studyhub-pages:';
const KEPT = 6;
const sources = new Map(), failures = new Map();

/** Why a page could not be had, in the learner's words (the host's reason: lib/contexts/materials/original-pages.js, or a file that went away). */
const WHY = {
  encrypted: () => ui('这份原文件设了加密保护，这里没法单独取出它的页面。'),
  'page-too-big': () => ui('这一页太大，没法在这里显示。'),
  'file-too-large': () => ui('这份原文件超过 2 GB，没法在这里打开它的页面。'),
};
const whyNot = reason => (WHY[reason] || (() => ui('这份原文件现在打不开：它可能被移走或改动了。')))();

const bytesOf = base64 => Uint8Array.from(atob(base64), char => char.charCodeAt(0));

/** The file URL of a paged original (`paged` is what materials.document.bytes said: { documentId, revision, totalPages }); `call` is the reader's host call. */
export function pagedFileUrl(call, paged) {
  const url = `${PREFIX}${paged.documentId}:${paged.revision}`;
  sources.delete(url); failures.delete(url);
  const entry = { kind: 'pages', total: paged.totalPages || 0, numPages: 0,
    async fetchPage(number) {
      const answer = await call('materials.document.pages', { documentId: paged.documentId, revision: paged.revision, from: number, to: number });
      if (answer?.status !== 'ok') { const message = whyNot(answer?.reason); failures.set(url, message); throw Object.assign(new Error(message), { reason: answer?.reason }); }
      failures.delete(url);
      // The file's own page count (the text may be from another edition): the renderer reports it, so the reader checks it as it does for a whole file.
      if (Number.isInteger(answer.numPages)) entry.numPages = answer.numPages;
      return bytesOf(answer.dataBase64);
    } };
  sources.set(url, entry);
  while (sources.size > KEPT) sources.delete(sources.keys().next().value);
  return url;
}

/** What the last refused page of this paged original said (plain words), or '' when the last one was had. */
export const pagedFailure = fileUrl => failures.get(fileUrl) || '';

/** Whether this file URL stands for a paged original. */
export const isPagedUrl = url => typeof url === 'string' && url.startsWith(PREFIX);

/** The original behind a file URL: its bytes (a Uint8Array), or the page source of a paged original; null when there is none. */
export async function originalBytes(fileUrl) {
  if (isPagedUrl(fileUrl)) return sources.get(fileUrl) ?? null;
  return new Uint8Array(await (await fetch(fileUrl)).arrayBuffer());
}
