import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { randomBytes } from 'node:crypto';

/* A generated PDF whose pages carry real text lines (ASCII, so no font files are needed).
   pages: an array of arrays of lines, or of strings (one line). Every line must hold at least a
   few words so a page has enough text to be extracted as a source. padBytes: incompressible bytes hidden in every page, to make a big file. */
export async function makeTextPdf(pages, { padBytes = 0 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    [].concat(lines).forEach((line, index) => page.drawText(line, { x: 50, y: 720 - index * 22, size: 12, font }));
    if (padBytes) page.node.set(PDFName.of('StudyhubPad'), doc.context.register(doc.context.flateStream(randomBytes(padBytes))));
  }
  return Buffer.from(await doc.save());
}

export const LECTURE_PAGES = [
  ['Database indexes in practice', 'An index is an extra data structure that avoids scanning every row of a table.'],
  ['Balanced trees', 'The most common index structure is a balanced tree which finds a key in logarithmic time.'],
  ['Hash indexes', 'A hash index answers equality lookups quickly but cannot serve range queries at all.'],
];
