import { cheatSheet } from './cheat-sheet-model.js';
import { cheatSheetFilename, cheatSheetHtml } from './cheat-sheet-html.js';
import { downloadText } from './download.js';

/* The 速查表 (#710 S5) as the page needs it: the one HTML page of a book, and its saving as a file. The formula renderer (KaTeX) is not part of the book page's
   load: it is the one optional chunk every formula of the app already uses (ui/StudyMath.jsx), asked for only when a sheet has formulas. */

/** -> { html, filename } | null (the book has nothing for a sheet). `links`: the view's page, whose point codes open the book (cheatSheetHtml). */
export async function cheatSheetPage(book, { links = false } = {}) {
  const sheet = cheatSheet(book);
  if (!sheet) return null;
  // The formulas are drawn only when there are some; the renderer arrives with them.
  const math = sheet.formulas.length ? await import('../study-math-render.js') : null;
  const formulaCss = math ? await math.mathPageCss() : '';
  return { html: cheatSheetHtml(sheet, { formula: math?.renderStudyFormula ?? null, formulaCss, links }), filename: cheatSheetFilename(sheet) };
}

/** Saves the book's 速查表 as one .html file through the book export's own download (ui/book/download.js). false when there is none to save. */
export async function downloadCheatSheet(book) {
  const page = await cheatSheetPage(book);
  if (!page) return false;
  downloadText(page.filename, page.html, 'text/html');
  return true;
}
