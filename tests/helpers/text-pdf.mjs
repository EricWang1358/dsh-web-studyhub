import { PDFDocument, StandardFonts } from 'pdf-lib';

/* A generated PDF whose pages carry real text lines (ASCII, so no font files are needed).
   pages: an array of arrays of lines, or of strings (one line). Every line must hold at least a
   few words so a page has enough text to be extracted as a source. */
export async function makeTextPdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    [].concat(lines).forEach((line, index) => page.drawText(line, { x: 50, y: 720 - index * 22, size: 12, font }));
  }
  return Buffer.from(await doc.save());
}

export const LECTURE_PAGES = [
  ['Database indexes in practice', 'An index is an extra data structure that avoids scanning every row of a table.'],
  ['Balanced trees', 'The most common index structure is a balanced tree which finds a key in logarithmic time.'],
  ['Hash indexes', 'A hash index answers equality lookups quickly but cannot serve range queries at all.'],
];
