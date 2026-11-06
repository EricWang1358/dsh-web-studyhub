import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

/* Pages of a PDF original that is too big to send whole (a referenced textbook of hundreds of MB): the reader asks for the pages it shows, and just those are copied into a
   small PDF (pdf-lib). The big file is read once and kept for the next page (turning pages asks again and again), but never more than ONE big file is held, and it is let
   go after it sat idle: the memory is only taken while someone is reading it. */

const MB = 1024 * 1024;
/** Pages in one answer (the reader draws one, a hand-off picture a few). */
export const MAX_PAGES = 8;
/** The largest answer: a page of a scanned book can carry a big picture. */
export const MAX_OUTPUT_BYTES = 24 * MB;
const IDLE_MS = 45_000;

const refused = message => new Error(message);

/** A holder of one big PDF at a time. `idleMs` (tests make it short) is how long it stays loaded without a request. */
export function createPageSource({ idleMs = IDLE_MS } = {}) {
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
    const entry = { key, timer: null, ready: readFile(file.path).then(bytes => PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })) };
    held = entry;
    entry.ready.catch(() => { if (held === entry) release(); });
    return entry.ready;
  }

  async function run(file, from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw refused('Ask for a page number from 1, and a last page that is not before it');
    if (to - from + 1 > MAX_PAGES) throw refused(`Ask for at most ${MAX_PAGES} pages at a time`);
    try {
      const source = await documentOf(file), numPages = source.getPageCount();
      if (from > numPages || to > numPages) throw refused(`The original has no page ${Math.max(from, to)}: it has ${numPages} pages`);
      const out = await PDFDocument.create();
      for (const page of await out.copyPages(source, Array.from({ length: to - from + 1 }, (_, index) => from - 1 + index))) out.addPage(page);
      const bytes = await out.save({ useObjectStreams: false });
      if (bytes.length > MAX_OUTPUT_BYTES) throw refused(`Those pages are too big to send (${Math.round(bytes.length / MB)} MB); ask for fewer pages`);
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
