import { OfficeFileError, readZip } from './zip.js';
import { parseXml, elements, textContent } from './xml.js';
import { extractDocx } from './docx.js';
import { extractPptx } from './pptx.js';
import { meaningfulTitle } from './markdown.js';
import { SELECTION_CHARS } from '../limits.js';

export { OfficeFileError } from './zip.js';
export { isOfficeFormat, OFFICE_FORMATS } from './limits.js';

const MAX_TEXT_CHARS = SELECTION_CHARS;
// Problems that mean "this is not a readable Word/PowerPoint file".
const UNREADABLE = new Set(['not-zip', 'corrupt', 'xml', 'unsupported-method', 'invalid']);

const damaged = format => new OfficeFileError('corrupt', `Office file is damaged or not a valid ${format.toUpperCase()} file`);

function coreTitle(zip) {
  if (!zip.has('docProps/core.xml')) return undefined;
  const node = elements(parseXml(zip.text('docProps/core.xml'))).find(child => /(?:^|:)title$/.test(child.name));
  return node ? textContent(node) : undefined;
}

/**
 * Read the text of a .docx or .pptx file (Buffer), server side, with no
 * external dependency. Resolves to the same shape other document formats
 * project to: { sources, warnings, title?, totalPages?, skippedPages?,
 * projectionUnavailable? }. A .pptx gives one source per slide with
 * document.page / document.totalPages (the shape PDF pages use) so citations
 * and page jumps work the same way. Rejects with OfficeFileError for unreadable,
 * password-protected, ZIP64 or oversized-when-unpacked files.
 */
export async function extractOffice(bytes, { format, filename = '' } = {}) {
  if (format !== 'docx' && format !== 'pptx') throw new Error(`Unsupported Office format: ${format}`);
  try {
    const zip = readZip(bytes);
    if (!zip.has(format === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml')) throw damaged(format);
    const title = meaningfulTitle(coreTitle(zip), filename);
    if (format === 'docx') {
      const { text, warnings } = extractDocx(zip);
      if (text.length > MAX_TEXT_CHARS) throw new Error('Extracted text exceeds 600,000 characters');
      return { sources: text ? [{ text }] : [], title,
        warnings: text ? warnings : ['No selectable text is available in this document.'], ...(text ? {} : { projectionUnavailable: true }) };
    }
    const slides = extractPptx(zip);
    const label = title || String(filename).replace(/^.*[\\/]/, '') || 'presentation.pptx';
    const present = slides.filter(slide => slide.text);
    const skippedPages = slides.filter(slide => !slide.text).map(slide => slide.number);
    if (present.reduce((total, slide) => total + slide.text.length, 0) > MAX_TEXT_CHARS) throw new Error('Extracted text exceeds 600,000 characters');
    const warnings = skippedPages.length ? [`Slides ${skippedPages.join(', ')} have no text (pictures or diagrams only) and were skipped.`] : [];
    return { sources: present.map(slide => ({ title: `${label} · p.${slide.number}`, text: slide.text, document: { page: slide.number, totalPages: slides.length } })),
      title, totalPages: slides.length, skippedPages, warnings, ...(present.length ? {} : { projectionUnavailable: true }) };
  } catch (error) {
    if (error instanceof OfficeFileError) throw UNREADABLE.has(error.code) ? damaged(format) : error;
    if (error instanceof RangeError) throw damaged(format);
    throw error;
  }
}
