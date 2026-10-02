import { fileURLToPath } from 'node:url';
import { chaptersFromOutline } from './converted-document.js';

/* Cutting a PDF into pieces the MinerU cloud accepts (WP: cloud conversion).
   MinerU's hard limits are 200 pages and 200 MB per file; the pieces keep a margin
   below the byte limit. The plan (which pages go together) is pure; the pieces
   themselves are written with pdf-lib (pdfjs-dist cannot write PDFs), one at a time,
   and handed to `writeChunk` so a big book is never held in memory twice.
   A PDF that already fits is not rewritten: its original bytes are the one piece.
   pdf-lib and pdfjs-dist are loaded lazily, so importing this file costs nothing
   until a PDF is really read (and the browser bundle never contains them). */

/** MinerU precision API: at most 200 pages per file (owner decision: write at most 200). */
export const MAX_PAGES_PER_CHUNK = 200;
/** MinerU accepts 200 MB per file; 180 MB leaves room for the upload framing and for size differences. */
export const MAX_CHUNK_BYTES = 180 * 1024 * 1024;

export class PdfChunkError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'PdfChunkError'; this.code = code; Object.assign(this, extra); }
}

const NOT_PDF = '这个文件不是有效的 PDF。请重新导出 PDF 后再试。';
const DAMAGED = '这个 PDF 读不出来，可能已损坏或不完整。请重新导出或用「另存为」生成一份新的 PDF 后再试。';
const ENCRYPTED = '这个 PDF 有密码保护，没法拆分和上传。请先在 PDF 阅读器里去掉密码（另存为一份无密码的 PDF）再导入。';

const positive = value => Number.isInteger(value) && value >= 1;

/**
 * Which pages go into which piece. Pure. `outline` is [{ level, title, page }] (1-based pages); when it has chapters
 * they decide the cuts: consecutive chapters are packed into a piece until the next one would not fit, and a chapter
 * longer than a piece is cut every `maxPages` pages (the rest of it joins what follows). Without chapters the cuts are
 * fixed. Result: [{ index, startPage, endPage, cut: 'whole' | 'chapter' | 'fixed' }], contiguous and in book order.
 */
export function planChunks({ totalPages, outline = [], maxPages = MAX_PAGES_PER_CHUNK } = {}) {
  if (!positive(totalPages)) throw new PdfChunkError('empty', '这个 PDF 没有页面。');
  if (!positive(maxPages)) throw new RangeError('maxPages must be a positive integer');
  if (totalPages <= maxPages) return [{ index: 0, startPage: 1, endPage: totalPages, cut: 'whole' }];
  const usable = (Array.isArray(outline) ? outline : []).filter(entry => entry && positive(entry.page) && entry.page <= totalPages && positive(entry.level))
    .sort((a, b) => a.page - b.page);
  const seen = new Set();
  const unique = usable.filter(entry => (seen.has(entry.page) ? false : (seen.add(entry.page), true)));
  const chapters = chaptersFromOutline(unique, totalPages);
  if (chapters.length < 2) return fixedPlan(totalPages, maxPages);
  // Front matter belongs to the first chapter, the end of the book to the last.
  const bounds = chapters.map((chapter, index) => ({ start: index === 0 ? 1 : chapter.startPage, end: index === chapters.length - 1 ? totalPages : chapter.endPage }));
  const units = [];
  for (const chapter of bounds) {
    for (let start = chapter.start; start <= chapter.end; start += maxPages) {
      const end = Math.min(chapter.end, start + maxPages - 1);
      units.push({ start, end, chapterEnd: end === chapter.end });
    }
  }
  const pieces = [];
  let current = null;
  for (const unit of units) {
    if (current && unit.end - current.start + 1 <= maxPages) { current.end = unit.end; current.chapterEnd = unit.chapterEnd; continue; }
    if (current) pieces.push(current);
    current = { ...unit };
  }
  if (current) pieces.push(current);
  return pieces.map((piece, index) => ({ index, startPage: piece.start, endPage: piece.end, cut: piece.chapterEnd ? 'chapter' : 'fixed' }));
}

function fixedPlan(totalPages, maxPages) {
  const plan = [];
  for (let start = 1; start <= totalPages; start += maxPages)
    plan.push({ index: plan.length, startPage: start, endPage: Math.min(totalPages, start + maxPages - 1), cut: 'fixed' });
  return plan;
}

/* ---------- reading ---------- */

async function loadPdfLib() { return import('pdf-lib'); }

function isPdf(bytes) { return bytes.length > 8 && bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')); }

function classify(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`;
  if (/EncryptedPDFError|encrypted/i.test(text)) return new PdfChunkError('encrypted', ENCRYPTED);
  if (error instanceof PdfChunkError) return error;
  return new PdfChunkError('damaged', DAMAGED);
}

async function loadSource(bytes) {
  if (!isPdf(bytes)) throw new PdfChunkError('not-pdf', NOT_PDF);
  const { PDFDocument } = await loadPdfLib();
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    // A truncated file can load and only fail when its page tree is read.
    return { document, pages: document.getPageCount() };
  } catch (error) { throw classify(error); }
}

/** { pages, bytes } of a PDF; throws PdfChunkError (not-pdf, damaged, encrypted, empty) with a plain message. */
export async function inspectPdf(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const { pages } = await loadSource(bytes);
  if (!pages) throw new PdfChunkError('empty', '这个 PDF 没有页面。');
  return { pages, bytes: bytes.length };
}

/**
 * The bookmarks of a PDF as [{ level, title, page }] (1-based page, level 1 = top). Best effort: a PDF without
 * bookmarks, or whose bookmarks cannot be read, gives []. Read with pdfjs-dist, which StudyHub already ships.
 */
export async function readOutline(input, { limit = 5000 } = {}) {
  let loading;
  try {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const assets = new URL('../../', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
    const assetPath = dir => fileURLToPath(new URL(`${dir}/`, assets)).replaceAll('\\', '/');
    loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, useWorkerFetch: false, disableFontFace: true,
      cMapUrl: assetPath('cmaps'), standardFontDataUrl: assetPath('standard_fonts'), wasmUrl: assetPath('wasm'), verbosity: 0 });
    const pdf = await loading.promise;
    const tree = await pdf.getOutline();
    if (!Array.isArray(tree)) return [];
    const result = [];
    const pageOf = async dest => {
      try {
        const target = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
        if (!Array.isArray(target) || target[0] == null) return null;
        return typeof target[0] === 'object' ? (await pdf.getPageIndex(target[0])) + 1 : Number.isInteger(target[0]) ? target[0] + 1 : null;
      } catch { return null; }
    };
    const visit = async (items, level) => {
      for (const item of items) {
        if (result.length >= limit) return;
        const page = await pageOf(item.dest);
        const title = String(item.title ?? '').replace(/\s+/g, ' ').trim();
        if (page && title) result.push({ level, title, page });
        if (Array.isArray(item.items) && item.items.length) await visit(item.items, level + 1);
      }
    };
    await visit(tree, 1);
    return result;
  } catch { return []; }
  finally { try { await loading?.destroy(); } catch { /* nothing to release */ } }
}

/* ---------- writing ---------- */

/**
 * Cut `bytes` into pieces and hand each to `writeChunk({ index, startPage, endPage, pages, bytes, data, original })`
 * in book order (`data` is a Buffer valid only during the call). Returns [{ index, startPage, endPage, pages, bytes,
 * original, cut }]. A book that fits both limits is one piece holding the original bytes; otherwise the plan comes
 * from planChunks, every piece is written for real and measured, and a piece over `maxBytes` is halved until it fits
 * (a single page over the limit is a PdfChunkError 'page-too-large'). `signal` stops before the next piece.
 */
export async function splitPdf({ bytes: input, maxPages = MAX_PAGES_PER_CHUNK, maxBytes = MAX_CHUNK_BYTES, outline, writeChunk, signal } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (typeof writeChunk !== 'function') throw new TypeError('writeChunk is required');
  signal?.throwIfAborted();
  const { document: source, pages: totalPages } = await loadSource(bytes);
  if (!totalPages) throw new PdfChunkError('empty', '这个 PDF 没有页面。');
  const chunks = [];
  const emit = async (piece, data, original, cut) => {
    signal?.throwIfAborted();
    const chunk = { index: chunks.length, startPage: piece.startPage, endPage: piece.endPage, pages: piece.endPage - piece.startPage + 1, bytes: data.length, original, cut };
    await writeChunk({ ...chunk, data });
    chunks.push(chunk);
  };
  if (totalPages <= maxPages && bytes.length <= maxBytes) {
    await emit({ startPage: 1, endPage: totalPages }, bytes, true, 'whole');
    return chunks;
  }
  const plan = planChunks({ totalPages, maxPages, outline: outline ?? (totalPages > maxPages ? await readOutline(bytes) : []) });
  const { PDFDocument } = await loadPdfLib();
  const build = async (startPage, endPage) => {
    const target = await PDFDocument.create();
    const indices = Array.from({ length: endPage - startPage + 1 }, (_, offset) => startPage - 1 + offset);
    for (const page of await target.copyPages(source, indices)) target.addPage(page);
    return Buffer.from(await target.save({ updateFieldAppearances: false }));
  };
  const fit = async (startPage, endPage, cut) => {
    signal?.throwIfAborted();
    const data = await build(startPage, endPage);
    if (data.length <= maxBytes) { await emit({ startPage, endPage }, data, false, cut); return; }
    if (startPage === endPage)
      throw new PdfChunkError('page-too-large', `这个 PDF 的第 ${startPage} 页单独就有 ${Math.ceil(data.length / 1024 / 1024)} MB，超过云端解析单个文件的上限，没法拆小。请先压缩这一页的图片，或用桌面客户端处理。`,
        { page: startPage, bytes: data.length });
    const middle = Math.floor((startPage + endPage) / 2);
    await fit(startPage, middle, 'size');
    await fit(middle + 1, endPage, 'size');
  };
  for (const piece of plan) await fit(piece.startPage, piece.endPage, piece.cut);
  return chunks;
}
