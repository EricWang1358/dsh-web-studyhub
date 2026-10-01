import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { exportAttachments, importAttachments, formatFor, mimeFor } from '../lib/contexts/materials/files.js';
import { groupSourcesByDocument, sourceFormat } from '../lib/source-groups.js';
import { MAX_DOCUMENT_BYTES, MAX_OFFICE_BYTES, maxBytesFor } from '../lib/office/limits.js';
import { MAX_PDF_BYTES, MAX_REQUEST_BYTES } from '../lib/documents.js';
import { docxFile, pptxFile, para, shape, apara, zipFiles } from './helpers/office.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wp22-materials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  return { root, store, call: (action, args = {}) => ops.handlers[action](args) };
}
const base64 = bytes => bytes.toString('base64');
const deck = () => pptxFile([
  { shapes: [shape([apara('Paging')], { ph: 'title' }), shape([apara('Frames and pages'), apara('Page size', { lvl: 1 })], { ph: 'body', id: 3 })], notes: 'Mention the TLB.' },
  { shapes: [shape([apara('Scheduling')], { ph: 'title' }), shape([apara('Round robin quantum')], { ph: 'body', id: 3 })] },
  { shapes: [shape([apara('Round robin quantum')], { ph: 'body', id: 3 })] },
], { title: 'OS Lecture 5' });
const doc = () => docxFile(para('Memory', { style: 'Heading1' }) + para('Virtual memory gives each process its own address space.') + para('step', { list: { numId: 2 } }), { title: 'OS Notes' });

test('formats and MIME types for Word and PowerPoint', () => {
  assert.equal(formatFor({ filename: 'a.DOCX' }), 'docx');
  assert.equal(formatFor({ path: '/x/b.pptx' }), 'pptx');
  assert.equal(formatFor({ filename: 'x', format: 'pptx' }), 'pptx');
  assert.match(mimeFor('docx'), /wordprocessingml\.document$/);
  assert.match(mimeFor('pptx'), /presentationml\.presentation$/);
  assert.throws(() => formatFor({ filename: 'old.doc' }), /Supported document formats/);
  assert.throws(() => formatFor({ filename: 'old.ppt' }), /Supported document formats/);
});

test('size limits are one constant per format', () => {
  assert.equal(MAX_DOCUMENT_BYTES.pdf, 8 * 1024 * 1024);
  for (const format of ['md', 'html', 'txt']) assert.equal(maxBytesFor(format), MAX_DOCUMENT_BYTES.pdf);
  assert.equal(maxBytesFor('docx'), MAX_OFFICE_BYTES);
  assert.equal(maxBytesFor('pptx'), MAX_OFFICE_BYTES);
  assert.ok(MAX_OFFICE_BYTES > MAX_PDF_BYTES && MAX_OFFICE_BYTES <= 48 * 1024 * 1024, 'fits the 64 MB transport cap once base64-encoded');
  assert.ok(MAX_REQUEST_BYTES >= Math.ceil(MAX_OFFICE_BYTES / 3) * 4, 'requests can carry the largest document');
  assert.ok(MAX_REQUEST_BYTES < 64 * 1024 * 1024);
});

test('importing a .docx keeps the original and one selectable text source', async t => {
  const { call } = await fixture(t);
  const bytes = doc();
  const imported = await call('materials.document.import', { dataBase64: base64(bytes), filename: 'notes.docx', courses: ['OS'] });
  const document = imported.document;
  assert.equal(document.format, 'docx');
  assert.equal(document.title, 'OS Notes');
  assert.equal(document.filename, 'notes.docx');
  assert.equal(document.originalAvailable, true);
  assert.equal(document.preview.kind, 'file');
  assert.equal(document.preview.mime, mimeFor('docx'));
  assert.deepEqual(await readFile(document.preview.path), bytes);
  assert.equal(imported.sourceIds.length, 1);
  assert.equal(document.sources[0].text, '# Memory\n\nVirtual memory gives each process its own address space.\n\n1. step');
  assert.deepEqual(document.sources[0].courses, ['OS']);
  assert.equal(document.sources[0].document.format, 'docx');
  const got = await call('materials.document.bytes', { documentId: document.id });
  assert.equal(got.mime, mimeFor('docx'));
  assert.deepEqual(Buffer.from(got.dataBase64, 'base64'), bytes);
  const selected = await call('materials.selection.resolve', { documentId: document.id, revision: document.revision, quote: 'own address space' });
  assert.equal(selected.status, 'resolved');
});

test('importing a .pptx makes one page-located source per slide, like PDF pages', async t => {
  const { call } = await fixture(t);
  const bytes = deck();
  const imported = await call('materials.document.import', { dataBase64: base64(bytes), filename: 'week5.pptx' });
  const document = imported.document;
  assert.equal(document.format, 'pptx');
  assert.equal(document.title, 'OS Lecture 5');
  assert.equal(document.originalAvailable, true);
  assert.deepEqual(await readFile(document.preview.path), bytes);
  assert.equal(imported.sourceIds.length, 3);
  assert.deepEqual(document.sources.map(source => source.document.page), [1, 2, 3]);
  assert.ok(document.sources.every(source => source.document.totalPages === 3 && source.document.format === 'pptx'));
  assert.deepEqual(document.sources.map(source => source.title), ['OS Lecture 5 · p.1', 'OS Lecture 5 · p.2', 'OS Lecture 5 · p.3']);
  assert.match(document.sources[0].text, /备注：\nMention the TLB\./);
  assert.equal(document.capabilities.pageRequiredForRepeatedQuotes, true);
  // The same phrase is on slides 2 and 3; the page makes the locator exact.
  const ambiguous = await call('materials.selection.resolve', { documentId: document.id, revision: document.revision, quote: 'Round robin quantum' });
  assert.equal(ambiguous.status, 'ambiguous');
  const located = await call('materials.selection.resolve', { documentId: document.id, revision: document.revision, quote: 'Round robin quantum', page: 3 });
  assert.equal(located.status, 'resolved');
  assert.equal(located.selection.page, 3);
  assert.equal(located.selection.sourceId, document.sources[2].id);
});

test('re-importing the same Office file is idempotent', async t => {
  const { call, store } = await fixture(t);
  const args = { dataBase64: base64(deck()), filename: 'week5.pptx' };
  const first = await call('materials.document.import', args);
  const second = await call('materials.document.import', args);
  assert.deepEqual(second.sourceIds, first.sourceIds);
  assert.equal(second.added, 0);
  assert.equal((await store.read()).sources.length, 3);
});

test('a slide-less deck imports as unavailable text with a warning', async t => {
  const { call } = await fixture(t);
  const bytes = pptxFile([{ shapes: ['<p:pic><p:nvPicPr><p:cNvPr id="1" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr></p:pic>'] }]);
  const imported = await call('materials.document.import', { dataBase64: base64(bytes), filename: 'images.pptx' });
  assert.deepEqual(imported.sourceIds, []);
  assert.ok(imported.warnings.length);
  assert.deepEqual(imported.skippedPages, [1]);
});

test('Office limits: 8 MB for text and PDF, a larger shared limit for docx and pptx', async t => {
  const { root, call } = await fixture(t);
  // 9 MB of incompressible-ish media inside a package: over 8 MB, under the Office limit.
  const filler = Buffer.alloc(9 * 1024 * 1024, 7);
  const big = docxFile(para('Hello big document'), { extra: { 'word/media/image1.png': filler }, method: 'stored' });
  assert.ok(big.length > 8 * 1024 * 1024 && big.length < MAX_OFFICE_BYTES);
  const imported = await call('materials.document.import', { dataBase64: base64(big), filename: 'big.docx' });
  assert.equal(imported.document.format, 'docx');
  const file = join(root, 'big.docx'); await writeFile(file, big);
  assert.equal((await call('materials.document.import', { path: file })).document.format, 'docx');
  // The same size is refused for a text file.
  await assert.rejects(call('materials.document.import', { dataBase64: base64(Buffer.alloc(9 * 1024 * 1024, 65)), filename: 'big.txt' }), /8 MB/);
  const textPath = join(root, 'big.txt'); await writeFile(textPath, Buffer.alloc(9 * 1024 * 1024, 65));
  await assert.rejects(call('materials.document.import', { path: textPath }), /at most 8 MB/);
  // And an Office file above its own limit is refused with that limit named.
  const huge = join(root, 'huge.pptx'); await writeFile(huge, Buffer.alloc(MAX_OFFICE_BYTES + 1));
  await assert.rejects(call('materials.document.import', { path: huge }), /at most 40 MB/);
});

test('corrupt, encrypted-looking and bomb Office files fail with clear messages', async t => {
  const { call } = await fixture(t);
  await assert.rejects(call('materials.document.import', { dataBase64: base64(Buffer.from('not a zip')), filename: 'x.docx' }), /not a valid DOCX|damaged/i);
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
  await assert.rejects(call('materials.document.import', { dataBase64: base64(ole), filename: 'locked.docx' }), /password-protected or in an old format/);
  const bomb = zipFiles([{ name: 'word/document.xml', data: Buffer.alloc(200 * 1024 * 1024, 32) }]);
  await assert.rejects(call('materials.document.import', { dataBase64: base64(bomb), filename: 'bomb.docx' }), /too large when unpacked/);
});

test('Office originals back up and restore with the portable materials backup', async t => {
  const { root, call } = await fixture(t);
  const bytes = doc();
  const imported = await call('materials.document.import', { dataBase64: base64(bytes), filename: 'notes.docx' });
  const documents = [{ versions: [{ attachment: (await call('materials.document.get', { id: imported.documentId })).versions[0].attachment }] }];
  const exported = await exportAttachments(root, documents);
  assert.equal(exported[0].format, 'docx');
  const other = await mkdtemp(join(tmpdir(), 'wp22-restore-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  assert.deepEqual(await importAttachments(other, exported), { restored: 1 });
  assert.deepEqual(await readFile(join(other, exported[0].path)), bytes);
});

test('the Sources list groups slides as one PowerPoint item and Word is not a PDF', async t => {
  const { call, store } = await fixture(t);
  await call('materials.document.import', { dataBase64: base64(deck()), filename: 'week5.pptx' });
  await call('materials.document.import', { dataBase64: base64(doc()), filename: 'notes.docx' });
  const items = groupSourcesByDocument((await store.read()).sources);
  assert.equal(items.length, 2);
  const [slides, word] = items;
  assert.equal(slides.format, 'pptx');
  assert.equal(slides.title, 'OS Lecture 5');
  assert.equal(slides.sourceIds.length, 3);
  assert.deepEqual(slides.pages.map(page => page.page), [1, 2, 3]);
  assert.equal(slides.totalPages, 3);
  assert.deepEqual(slides.warnings, []);
  assert.equal(word.format, 'docx');
  assert.equal(word.sourceIds.length, 1);
  assert.equal(sourceFormat({ document: { page: 2, format: 'pptx' } }), 'pptx');
  assert.equal(sourceFormat({ document: { page: 2, extractionVersion: 2 } }), 'pdf', 'PDF pages are unchanged');
});

test('materials.enrich reads the format of Office sources from their document', async t => {
  const { call, store } = await fixture(t);
  await call('materials.document.import', { dataBase64: base64(deck()), filename: 'week5.pptx' });
  await store.update(state => { for (const source of state.sources) delete source.format; });
  await call('materials.enrich', {});
  assert.ok((await store.read()).sources.every(source => source.format === 'pptx'));
});
