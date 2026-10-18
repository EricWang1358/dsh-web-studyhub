/* Reading a PDF before it is converted on this computer: how many pages it has, and whether it can be read at all (not a PDF, damaged,
   password-protected), each with a plain message. (Cutting a book into pieces for the MinerU cloud was removed with the cloud route in 3.6:
   the local converters take page ranges.) pdf-lib is loaded lazily, so importing this file costs nothing until a PDF is really read. */

export class PdfChunkError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'PdfChunkError'; this.code = code; Object.assign(this, extra); }
}

const NOT_PDF = '这个文件不是有效的 PDF。请重新导出 PDF 后再试。';
const DAMAGED = '这个 PDF 读不出来，可能已损坏或不完整。请重新导出或用「另存为」生成一份新的 PDF 后再试。';
const ENCRYPTED = '这个 PDF 有密码保护，没法读取。请先在 PDF 阅读器里去掉密码（另存为一份无密码的 PDF）再导入。';

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
