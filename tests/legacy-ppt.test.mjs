import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractOffice, OfficeFileError } from '../lib/office/index.js';
import { readCompoundFile, isCompoundFile } from '../lib/office/cfb.js';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { presentationFormat } from '../lib/contexts/materials/files.js';
import { isPagedFormat, isSlideFormat, maxBytesFor, MAX_OFFICE_BYTES } from '../lib/office/limits.js';
import { compoundFile, pptFile } from './helpers/ppt.mjs';
import { pptxFile, shape, apara } from './helpers/office.mjs';

const extract = (bytes, filename = 'deck.ppt', format = 'ppt') => extractOffice(bytes, { format, filename });
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof OfficeFileError && error.code === code);

test('a .ppt is one page-located source per slide: title heading, bullets, text boxes, notes', async () => {
  const result = await extract(pptFile([
    { title: '进程与线程', body: ['进程是资源分配的单位', '线程是调度的单位'], boxes: ['图 3-1 见教材 p.87'], notes: '期末重点：状态转换' },
    { title: 'Scheduling', subtitle: 'FCFS and RR' },
  ]));
  assert.equal(result.totalPages, 2);
  assert.deepEqual(result.sources.map(source => source.document), [{ page: 1, totalPages: 2 }, { page: 2, totalPages: 2 }]);
  assert.deepEqual(result.sources.map(source => source.title), ['deck.ppt · p.1', 'deck.ppt · p.2']);
  assert.equal(result.sources[0].text, '## 第 1 页 · 进程与线程\n\n- 进程是资源分配的单位\n- 线程是调度的单位\n\n图 3-1 见教材 p.87\n\n备注：\n期末重点：状态转换');
  assert.equal(result.sources[1].text, '## 第 2 页 · Scheduling\n\nFCFS and RR');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.projectionUnavailable, undefined);
});

test('slides come in slide-list order, not the order of their records', async () => {
  const result = await extract(pptFile([{ title: 'A' }, { title: 'B' }, { title: 'C' }], { order: [2, 0, 1] }));
  assert.deepEqual(result.sources.map(source => source.text), ['## 第 1 页 · C', '## 第 2 页 · A', '## 第 3 页 · B']);
});

test('grouped shapes are read; footer placeholders and slide-number fields are not', async () => {
  const result = await extract(pptFile([{ title: 'T', grouped: 'Inside a group', footer: 'Course 2026', slideNumber: true }]));
  assert.equal(result.sources[0].text, '## 第 1 页 · T\n\nInside a group');
});

test('text kept in the drawing itself and single-byte text atoms are read', async () => {
  const result = await extract(pptFile([{ title: 'Café', body: ['naïve', 'résumé'], inline: true }], { bytes: true }));
  assert.equal(result.sources[0].text, '## 第 1 页 · Café\n\n- naïve\n- résumé');
});

test('the newest edit wins over an older saved version of a slide', async () => {
  const result = await extract(pptFile([{ title: 'New title' }, { title: 'Two' }], { staleTitle: 'Old title' }));
  assert.equal(result.sources[0].text, '## 第 1 页 · New title');
});

test('without a "Current User" stream the last edit in the document is used', async () => {
  const result = await extract(pptFile([{ title: 'Still read' }], { currentUser: false }));
  assert.equal(result.sources[0].text, '## 第 1 页 · Still read');
});

test('slides without text are skipped and listed, like .pptx', async () => {
  const result = await extract(pptFile([{ title: 'Words' }, {}, { boxes: ['More'] }]));
  assert.deepEqual(result.skippedPages, [2]);
  assert.deepEqual(result.sources.map(source => source.document.page), [1, 3]);
  assert.match(result.warnings[0], /Slides 2 have no text/);
});

test('a long deck is read through the regular sectors as well as the mini stream', async () => {
  const slides = Array.from({ length: 60 }, (_, index) => ({ title: `Slide ${index + 1}`, body: [`Point ${'x'.repeat(40)} ${index}`] }));
  const bytes = pptFile(slides);
  const cfb = readCompoundFile(bytes);
  assert.ok(cfb.read('PowerPoint Document').length >= 4096 && cfb.read('Current User').length < 4096);
  const result = await extract(bytes);
  assert.equal(result.sources.length, 60);
  assert.equal(result.sources[59].text.split('\n')[0], '## 第 60 页 · Slide 60');
});

test('a .ppt renamed to .pptx, and a .pptx renamed to .ppt, are read as what they contain', async () => {
  const legacy = await extract(pptFile([{ title: 'Old deck' }]), 'renamed.pptx', 'pptx');
  assert.equal(legacy.sources[0].text, '## 第 1 页 · Old deck');
  const modern = await extract(pptxFile([{ shapes: [shape([apara('New deck')], { ph: 'title' })] }]), 'renamed.ppt', 'ppt');
  assert.equal(modern.sources[0].text, '## 第 1 页 · New deck');
  assert.equal(presentationFormat(pptFile([{ title: 'x' }]), 'pptx'), 'ppt');
  assert.equal(presentationFormat(pptxFile([{ shapes: [] }]), 'ppt'), 'pptx');
  assert.equal(presentationFormat(pptxFile([{ shapes: [] }]), 'pptx'), 'pptx');
});

test('password-protected presentations say so', async () => {
  await rejects(extract(pptFile([{ title: 'Secret' }], { encrypted: true })), 'encrypted');
  await rejects(extract(pptFile([{ title: 'Secret' }], { encrypted: true, currentUser: false })), 'encrypted');
  // An encrypted .pptx is a compound file with EncryptionInfo, whichever extension it has.
  const locked = compoundFile([{ name: 'EncryptionInfo', data: Buffer.alloc(200, 1) }, { name: 'EncryptedPackage', data: Buffer.alloc(5000, 2) }]);
  await rejects(extract(locked), 'encrypted');
  await rejects(extract(locked, 'locked.pptx', 'pptx'), 'ole');
});

test('damaged and hostile files fail as damaged, without hanging', async () => {
  const bytes = pptFile([{ title: 'T' }]);
  await rejects(extract(bytes.subarray(0, 700)), 'corrupt');
  await rejects(extract(Buffer.from('not a presentation at all')), 'corrupt');
  await rejects(extract(compoundFile([{ name: 'WordDocument', data: Buffer.alloc(100) }])), 'corrupt');
  // The directory's FAT entry points back at itself: a chain that never ends.
  const looped = Buffer.from(bytes);
  const directory = looped.readUInt32LE(0x30), fatSector = looped.readUInt32LE(0x4c);
  looped.writeUInt32LE(directory, (fatSector + 1) * 512 + directory * 4);
  await rejects(extract(looped), 'corrupt');
  // A record that claims to be longer than its stream.
  const cfb = readCompoundFile(bytes), stream = Buffer.from(cfb.read('PowerPoint Document'));
  stream.writeUInt32LE(0x7fffffff, 4);
  const broken = compoundFile([{ name: 'PowerPoint Document', data: stream }, { name: 'Current User', data: cfb.read('Current User') }]);
  await rejects(extract(broken), 'corrupt');
});

test('the compound file reader sees the streams the writer stored', () => {
  const big = Buffer.alloc(9000, 7), small = Buffer.from('tiny stream');
  const cfb = readCompoundFile(compoundFile([{ name: 'Big', data: big }, { name: 'Small', data: small }, { name: 'Empty', data: Buffer.alloc(0) }]));
  assert.deepEqual(cfb.names().sort(), ['Big', 'Empty', 'Small']);
  assert.deepEqual(cfb.read('Big'), big);
  assert.deepEqual(cfb.read('Small'), small);
  assert.equal(cfb.read('Empty').length, 0);
  assert.equal(cfb.read('Missing'), null);
  assert.equal(isCompoundFile(Buffer.from('PK')), false);
});

test('.ppt is an Office, slide and paged format with the Office size limit', () => {
  assert.equal(isSlideFormat('ppt'), true);
  assert.equal(isPagedFormat('ppt'), true);
  assert.equal(isSlideFormat('pdf'), false);
  assert.equal(maxBytesFor('ppt'), MAX_OFFICE_BYTES);
});

async function materials(t) {
  const root = await mkdtemp(join(tmpdir(), 'legacy-ppt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  return (action, args = {}) => ops.handlers[action](args);
}

test('importing a .ppt keeps the original and locates quotes by slide, like a .pptx', async t => {
  const call = await materials(t);
  const bytes = pptFile([{ title: 'Paging', body: ['Round robin quantum'] }, { title: 'Scheduling', body: ['Round robin quantum'] }]);
  const imported = await call('materials.document.import', { dataBase64: bytes.toString('base64'), filename: 'week5.ppt' });
  const document = imported.document;
  assert.equal(document.format, 'ppt');
  assert.equal(document.originalAvailable, true);
  assert.deepEqual(await readFile(document.preview.path), bytes);
  assert.match(document.preview.path, /\.ppt$/);
  assert.deepEqual(document.sources.map(source => source.document.page), [1, 2]);
  assert.ok(document.sources.every(source => source.document.format === 'ppt' && source.document.totalPages === 2));
  assert.equal(document.capabilities.pageRequiredForRepeatedQuotes, true);
  const located = await call('materials.selection.resolve', { documentId: document.id, revision: document.revision, quote: 'Round robin quantum', page: 2 });
  assert.equal(located.status, 'resolved');
  assert.equal(located.selection.sourceId, document.sources[1].id);
});

test('a .ppt renamed to .pptx is imported and kept as a .ppt', async t => {
  const call = await materials(t);
  const bytes = pptFile([{ title: 'Renamed' }]);
  const { document } = await call('materials.document.import', { dataBase64: bytes.toString('base64'), filename: 'review.pptx' });
  assert.equal(document.format, 'ppt');
  assert.match(document.preview.path, /\.ppt$/);
  assert.equal(document.sources[0].text, '## 第 1 页 · Renamed');
});
