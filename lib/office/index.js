import { OfficeFileError, readZip } from './zip.js';
import { parseXml, elements, textContent } from './xml.js';
import { extractDocx } from './docx.js';
import { extractPptx } from './pptx.js';
import { extractPpt } from './ppt.js';
import { isCompoundFile, readCompoundFile } from './cfb.js';
import { meaningfulTitle } from './markdown.js';
import { isOfficeFormat } from './limits.js';
import { SELECTION_CHARS } from '../limits.js';
import { IMPORT_ERROR, importError } from '../import-errors.js';

export { OfficeFileError } from './zip.js';
export { isOfficeFormat, OFFICE_FORMATS } from './limits.js';

const MAX_TEXT_CHARS = SELECTION_CHARS;
// Problems that mean "this is not a readable Word/PowerPoint file".
const UNREADABLE = new Set(['not-zip', 'corrupt', 'xml', 'unsupported-method', 'invalid']);

const tooLong = () => importError(`Extracted text exceeds ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters`, IMPORT_ERROR.TEXT_TOO_LONG, MAX_TEXT_CHARS);
const damaged = format => new OfficeFileError('corrupt', `Office file is damaged or not a valid ${format.toUpperCase()} file`);

function coreTitle(zip) {
  if (!zip.has('docProps/core.xml')) return undefined;
  const node = elements(parseXml(zip.text('docProps/core.xml'))).find(child => /(?:^|:)title$/.test(child.name));
  return node ? textContent(node) : undefined;
}

/** One source per slide, the shape PDF pages use. */
function slideProjection(slides, { title, filename, fallback }) {
  const label = title || String(filename).replace(/^.*[\\/]/, '') || fallback;
  const present = slides.filter(slide => slide.text);
  const skippedPages = slides.filter(slide => !slide.text).map(slide => slide.number);
  if (present.reduce((total, slide) => total + slide.text.length, 0) > MAX_TEXT_CHARS) throw tooLong();
  const warnings = skippedPages.length ? [`Slides ${skippedPages.join(', ')} have no text (pictures or diagrams only) and were skipped.`] : [];
  if (!slides.length) warnings.push('No selectable text is available in this document.');
  return { sources: present.map(slide => ({ title: `${label} · p.${slide.number}`, text: slide.text, document: { page: slide.number, totalPages: slides.length } })),
    title, totalPages: slides.length, skippedPages, warnings, ...(present.length ? {} : { projectionUnavailable: true }) };
}

/**
 * Bytes of a legacy PowerPoint (.ppt) file: a compound file holding a
 * "PowerPoint Document" stream. Also what a .ppt renamed to .pptx contains.
 */
function legacyPresentation(bytes) {
  if (!isCompoundFile(bytes)) return null;
  const cfb = readCompoundFile(bytes);
  return cfb.has('PowerPoint Document') ? cfb : null;
}

/**
 * Read the text of a .docx, .pptx or legacy .ppt file (Buffer), server side,
 * with no external dependency. Resolves to the same shape other document
 * formats project to: { sources, warnings, title?, totalPages?, skippedPages?,
 * projectionUnavailable? }. A presentation gives one source per slide with
 * document.page / document.totalPages (the shape PDF pages use) so citations
 * and page jumps work the same way. The contents decide between .ppt and .pptx,
 * so a file renamed from one to the other is still read. Rejects with
 * OfficeFileError for unreadable, password-protected, ZIP64 or
 * oversized-when-unpacked files.
 */
export async function extractOffice(bytes, { format, filename = '' } = {}) {
  if (!isOfficeFormat(format)) throw new Error(`Unsupported Office format: ${format}`);
  try {
    if (format === 'ppt' || format === 'pptx') {
      const legacy = legacyPresentation(bytes);
      if (legacy) return slideProjection(extractPpt(legacy), { title: undefined, filename, fallback: 'presentation.ppt' });
      if (format === 'ppt' && isCompoundFile(bytes)) {
        if (readCompoundFile(bytes).has('EncryptionInfo')) throw new OfficeFileError('encrypted', 'Office file is password-protected or in an old format');
        throw damaged(format);
      }
    }
    // Anything else named .ppt is read as the .pptx it is.
    const kind = format === 'ppt' ? 'pptx' : format;
    const zip = readZip(bytes);
    if (!zip.has(kind === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml')) throw damaged(format);
    const title = meaningfulTitle(coreTitle(zip), filename);
    if (kind === 'docx') {
      const { text, warnings } = extractDocx(zip);
      if (text.length > MAX_TEXT_CHARS) throw tooLong();
      return { sources: text ? [{ text }] : [], title,
        warnings: text ? warnings : ['No selectable text is available in this document.'], ...(text ? {} : { projectionUnavailable: true }) };
    }
    return slideProjection(extractPptx(zip), { title, filename, fallback: 'presentation.pptx' });
  } catch (error) {
    if (error instanceof OfficeFileError) throw UNREADABLE.has(error.code) ? damaged(format) : error;
    if (error instanceof RangeError) throw damaged(format);
    throw error;
  }
}
