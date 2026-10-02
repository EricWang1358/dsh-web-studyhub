import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts } from 'pdf-lib';
import { randomBytes } from 'node:crypto';

/* Synthetic PDFs for the cloud-conversion tests, written with pdf-lib so no fixture files are needed. */

/**
 * pages: number of pages. padBytes: incompressible bytes attached to every page (or a function of the page number) so a
 * chunk's size can be made to exceed a limit. outline: [{ title, page (1-based), level }] written as real bookmarks.
 * text: draws "Page N" on each page (default true).
 */
export async function makePdf({ pages = 3, padBytes = 0, outline = [], text = true, title } = {}) {
  const doc = await PDFDocument.create();
  const font = text ? await doc.embedFont(StandardFonts.Helvetica) : null;
  const refs = [];
  for (let number = 1; number <= pages; number++) {
    const page = doc.addPage([300, 400]);
    if (font) page.drawText(`Page ${number}`, { x: 40, y: 340, size: 18, font });
    const pad = typeof padBytes === 'function' ? padBytes(number) : padBytes;
    if (pad > 0) {
      const stream = doc.context.flateStream(randomBytes(pad));
      // Not compressible once more, and reachable from the page so copyPages carries it along.
      page.node.set(PDFName.of('StudyhubPad'), doc.context.register(stream));
    }
    refs.push(page.ref);
  }
  if (title) doc.setTitle(title);
  if (outline.length) addOutline(doc, refs, outline);
  return Buffer.from(await doc.save());
}

function addOutline(doc, refs, entries) {
  const { context } = doc;
  const root = context.obj({ Type: 'Outlines' });
  const rootRef = context.register(root);
  // Flat list of entries; `level` is kept as nesting by parenting each entry to the latest shallower one.
  const nodes = entries.map(entry => ({ ...entry, level: entry.level || 1, dict: context.obj({}), children: [] }));
  for (const node of nodes) node.ref = context.register(node.dict);
  const stack = [];
  const top = [];
  for (const node of nodes) {
    while (stack.length && stack.at(-1).level >= node.level) stack.pop();
    (stack.length ? stack.at(-1).children : top).push(node);
    node.parent = stack.length ? stack.at(-1) : null;
    stack.push(node);
  }
  const link = (siblings, parentRef) => {
    siblings.forEach((node, index) => {
      node.dict.set(PDFName.of('Title'), PDFString.of(node.title));
      node.dict.set(PDFName.of('Parent'), parentRef);
      node.dict.set(PDFName.of('Dest'), context.obj([refs[node.page - 1], PDFName.of('Fit')]));
      if (index > 0) node.dict.set(PDFName.of('Prev'), siblings[index - 1].ref);
      if (index < siblings.length - 1) node.dict.set(PDFName.of('Next'), siblings[index + 1].ref);
      if (node.children.length) {
        node.dict.set(PDFName.of('First'), node.children[0].ref);
        node.dict.set(PDFName.of('Last'), node.children.at(-1).ref);
        node.dict.set(PDFName.of('Count'), PDFNumber.of(node.children.length));
        link(node.children, node.ref);
      }
    });
  };
  link(top, rootRef);
  root.set(PDFName.of('First'), top[0].ref);
  root.set(PDFName.of('Last'), top.at(-1).ref);
  root.set(PDFName.of('Count'), PDFNumber.of(top.length));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
}

/** A PDF whose trailer declares encryption (pdf-lib refuses to load these). */
export async function makeEncryptedPdf() {
  const doc = await PDFDocument.create();
  doc.addPage();
  const ref = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: PDFString.of('x'.repeat(32)), U: PDFString.of('y'.repeat(32)), P: -4 }));
  doc.context.trailerInfo.Encrypt = ref;
  return Buffer.from(await doc.save());
}

/** Page count of a PDF, read back with pdf-lib. */
export async function pageCount(bytes) { return (await PDFDocument.load(bytes)).getPageCount(); }

export { PDFArray, PDFDict };
