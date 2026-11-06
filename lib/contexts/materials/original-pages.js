import { readFile } from 'node:fs/promises';

/* Pages of a PDF original that is too big to send whole (a referenced textbook of hundreds of MB): the reader asks for the pages it shows, and just those are copied into a
   small PDF (pdf-lib). The big file is read once and kept for the next page (turning pages asks again and again), but never more than ONE big file is held, and it is let
   go after it sat idle: the memory is only taken while someone is reading it.
   One queue and one held file for the whole host process, whatever library or reader asks: requests are answered one at a time, so a second big file waits for the first
   answer and then replaces it (reading two books side by side reloads each time). What cannot be copied faithfully is refused with a `code` and never answered with a
   page that would draw blank: 'encrypted' (the copy would keep the encrypted streams and drop the key), 'file-too-large' (more than a file read into memory can be),
   'page-too-big' (a page whose resources are over the answer limit). */

const MB = 1024 * 1024;
/** Pages in one answer (the reader draws one, a hand-off picture a few). */
export const MAX_PAGES = 8;
/** The largest answer: a page of a scanned book can carry a big picture. */
export const MAX_OUTPUT_BYTES = 24 * MB;
/** The largest file read into memory (a Node file read stops at 2 GiB). */
export const MAX_FILE_BYTES = 2 * 1024 * MB - 1;
const IDLE_MS = 45_000;

const refused = (message, code) => Object.assign(new Error(message), code ? { code } : {});
/** pdf-lib is heavy: loaded on the first page asked for, never at host start (tests/perf-budget.test.mjs). */
const pdfLib = () => import('pdf-lib');

/** A holder of one big PDF at a time. `idleMs` (tests make it short) is how long it stays loaded without a request. */
export function createPageSource({ idleMs = IDLE_MS, maxFileBytes = MAX_FILE_BYTES, maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
  let held = null, loads = 0, queue = Promise.resolve();

  const release = () => { if (held) { clearTimeout(held.timer); held = null; } };
  const touch = () => {
    clearTimeout(held.timer);
    held.timer = setTimeout(release, idleMs);
    held.timer.unref?.();
  };
  /** The loaded document of this file: the one held, or (replacing it) the file read now. Two requests at once share one load. */
  function documentOf(file) {
    const key = `${file.path}|${file.bytes}|${file.mtimeMs}`;
    if (held?.key === key) { clearTimeout(held.timer); return held.ready; } // in use: it is not idle until the answer is out
    release();
    loads += 1;
    const entry = { key, timer: null, ready: Promise.all([readFile(file.path), pdfLib()]).then(([bytes, { PDFDocument }]) => PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })) };
    held = entry;
    entry.ready.catch(() => { if (held === entry) release(); });
    return entry.ready;
  }

  async function run(file, from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw refused('Ask for a page number from 1, and a last page that is not before it');
    if (to - from + 1 > MAX_PAGES) throw refused(`Ask for at most ${MAX_PAGES} pages at a time`);
    if (file.bytes > maxFileBytes) throw refused(`This original is over ${Math.round(maxFileBytes / 1024 / MB)} GB, too large to open here: its pages cannot be shown in the reader`, 'file-too-large');
    try {
      const source = await documentOf(file), numPages = source.getPageCount();
      // An owner-password file reads without a password but its streams stay encrypted: a copy of a page would have no key and draw blank.
      if (source.isEncrypted) { release(); throw refused('This original is encrypted: its pages cannot be shown here', 'encrypted'); }
      if (from > numPages || to > numPages) throw refused(`The original has no page ${Math.max(from, to)}: it has ${numPages} pages`);
      const { PDFDocument } = await pdfLib(), out = await PDFDocument.create();
      for (const page of await out.copyPages(source, Array.from({ length: to - from + 1 }, (_, index) => from - 1 + index))) out.addPage(page);
      const bytes = await out.save({ useObjectStreams: false });
      if (bytes.length > maxOutputBytes) throw refused(`${to > from ? 'Those pages are' : 'This page is'} too big to show here (${Math.round(bytes.length / MB)} MB)`, 'page-too-big');
      return { bytes, pages: { from, to }, numPages };
    } finally { if (held) touch(); } // the idle time counts from the end of the answer
  }

  return {
    /** Pages `from`..`to` (1-based, inclusive) of `file` ({ path, bytes, mtimeMs }) as a small PDF: { bytes, pages: { from, to }, numPages }. Throws plain English.
        One request at a time: a second big file never loads while the first is still being read. */
    extract(file, from, to = from) {
      const turn = queue.then(() => run(file, from, to));
      queue = turn.catch(() => {});
      return turn;
    },
    release,
    /** For tests and the status line: how many big files are held, which, and how many loads there were. */
    state: () => ({ files: held ? 1 : 0, key: held?.key ?? null, loads }),
  };
}

/** The one holder of the host process: every library shares it, so there is never more than one big file in memory. */
export const pageSource = createPageSource();
