import { open, readFile } from 'node:fs/promises';

/* Pages of a PDF original that is too big to send whole (a referenced textbook of hundreds of MB):
   - Primary path (`rangeSource` / `materials.document.range`): reads bounded byte ranges (64 KB–256 KB) directly from disk via `FileHandle.read`,
     never loading the whole file into Node memory and natively supporting >2 GB files and owner-password read-only textbook PDFs.
   - Legacy fallback (`pageSource` / `materials.document.pages`): copies requested pages into a small PDF (pdf-lib). The big file is read once
     and kept for the next page, never more than ONE big file held, and released when idle. */

const KB = 1024;
const MB = 1024 * 1024;
/** Default byte-range chunk size requested by pdf.js PDFDataRangeTransport (64 KB). */
export const DEFAULT_RANGE_CHUNK_BYTES = 64 * KB;
/** Maximum byte-range chunk size served in one `materials.document.range` call (256 KB). */
export const MAX_RANGE_CHUNK_BYTES = 256 * KB;
/** Pages in one answer (the reader draws one, a hand-off picture a few). */
export const MAX_PAGES = 8;
/** The largest answer: a page of a scanned book can carry a big picture. */
export const MAX_OUTPUT_BYTES = 24 * MB;
/** The largest file read into memory (a Node file read stops at 2 GiB). */
export const MAX_FILE_BYTES = 2 * 1024 * MB - 1;
const IDLE_MS = 45_000;
const GONE = new Set(['ENOENT', 'ENOTDIR']);
const DENIED = new Set(['EACCES', 'EPERM', 'EBUSY']);

const refused = (message, code) => Object.assign(new Error(message), code ? { code } : {});
/** pdf-lib is heavy: loaded on the first page asked for, never at host start (tests/perf-budget.test.mjs). */
const pdfLib = () => import('pdf-lib');

/**
 * Bounded byte-range reader over a verified PDF file on disk (`FileHandle.read`).
 * Allocates only the requested slice (at most `maxChunkBytes`), never loads the whole file into memory,
 * closes its handle immediately (avoiding Windows file locks), and verifies size/mtime on every read.
 */
export function createRangeSource({ maxChunkBytes = MAX_RANGE_CHUNK_BYTES } = {}) {
  let reads = 0;

  async function read(file, begin, end) {
    if (!file || typeof file.path !== 'string' || !file.path || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw refused('A verified original file location is required', 'missing');
    }
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin) {
      throw refused('Byte range requires safe integers with 0 <= begin < end', 'invalid-range');
    }
    if (begin >= file.bytes || end > file.bytes) {
      throw refused(`Byte range [${begin}, ${end}) is outside the file size (${file.bytes} bytes)`, 'range-out-of-bounds');
    }
    const length = end - begin;
    if (length > maxChunkBytes) {
      throw refused(`Byte range of ${length} bytes exceeds the ${Math.round(maxChunkBytes / KB)} KB limit`, 'range-too-large');
    }
    let handle;
    try {
      handle = await open(file.path, 'r');
    } catch (error) {
      if (GONE.has(error?.code)) throw refused('The original file is missing', 'missing');
      if (DENIED.has(error?.code)) throw refused('The original file cannot be read', 'unreadable');
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw refused('The original file is missing', 'missing');
      if (info.size !== file.bytes || (file.mtimeMs !== undefined && info.mtimeMs !== file.mtimeMs)) {
        throw refused('The original file changed while being read', 'changed');
      }
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, begin + filled);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      if (filled !== length) throw refused('The original file changed while being read', 'changed');
      reads += 1;
      return { bytes: buffer, begin, end, totalBytes: file.bytes };
    } catch (error) {
      if (GONE.has(error?.code)) throw refused('The original file is missing', 'missing');
      if (DENIED.has(error?.code)) throw refused('The original file cannot be read', 'unreadable');
      throw error;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  return {
    read,
    state: () => ({ reads, maxChunkBytes }),
  };
}

/** Shared stateless byte-range reader for large PDFs. */
export const rangeSource = createRangeSource();

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
      queue = turn.then(() => {}, () => {});
      return turn;
    },
    release,
    /** For tests and the status line: how many big files are held, which, and how many loads there were. */
    state: () => ({ files: held ? 1 : 0, key: held?.key ?? null, loads }),
  };
}

/** The one holder of the host process: every library shares it, so there is never more than one big file in memory. */
export const pageSource = createPageSource();
