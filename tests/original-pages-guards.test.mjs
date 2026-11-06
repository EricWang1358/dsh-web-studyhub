/* What a paged original must NOT do: draw a blank page for a PDF it cannot copy (encrypted ones: owner-password-only publisher textbooks, RC4-128 and AES-256), be offered for a
   file that is not a PDF, read a file past what it can hold, or send a page too big to show. Each says so in plain words; nothing is sent as a picture of a blank page. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { createPageSource, pageSource } from '../lib/contexts/materials/original-pages.js';
import { makeTextPdf, LECTURE_PAGES } from './helpers/text-pdf.mjs';

const MB = 1024 * 1024;
const fixture = name => new URL(`./fixtures/${name}`, import.meta.url);

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), 'original-guards-'));
  const outside = await mkdtemp(join(tmpdir(), 'original-guards-files-'));
  t.after(async () => { pageSource.release(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  return { root, outside, call: (action, args = {}) => ops.handlers[action](args, {}) };
}

for (const kind of ['rc4-128', 'aes-256']) {
  test(`an owner-password PDF (${kind}) is not copied page by page into a blank page: the answer says it is encrypted`, async t => {
    const { call, outside } = await world(t);
    const imported = await call('materials.document.import', { dataBase64: (await makeTextPdf(LECTURE_PAGES)).toString('base64'), filename: 'Publisher.pdf' });
    await call('materials.original.detach', { documentId: imported.documentId });
    const { readFile } = await import('node:fs/promises');
    const path = join(outside, `${kind}.pdf`);
    await writeFile(path, await readFile(fixture(`encrypted-owner-${kind}.pdf`)));
    const attached = await call('materials.original.attach', { documentId: imported.documentId, path, mode: 'reference', confirm: true });
    assert.equal(attached.status, 'attached');
    const answer = await call('materials.document.pages', { documentId: imported.documentId, from: 1 });
    assert.equal(answer.status, 'unavailable');
    assert.equal(answer.reason, 'encrypted');
    assert.equal(answer.dataBase64, undefined, 'no page of unreadable streams is sent');
    assert.equal(pageSource.state().files, 0, 'the file is not kept for a request that cannot be answered');
  });
}

test('only a PDF original is ever paged: a big text or Office original is said to be too large, with its path, and is not offered to the reader', async t => {
  const { call, outside } = await world(t);
  const imported = await call('materials.document.import', { dataBase64: Buffer.from('Plain notes about indexes. '.repeat(40)).toString('base64'), filename: 'notes.txt' });
  await call('materials.original.detach', { documentId: imported.documentId });
  const path = join(outside, 'notes.txt');
  await writeFile(path, ''); await truncate(path, 45 * MB);
  assert.equal((await call('materials.original.attach', { documentId: imported.documentId, path, mode: 'reference', confirm: true })).status, 'attached');
  const document = await call('materials.document.get', { documentId: imported.documentId });
  assert.equal(document.original.status, 'ok');
  assert.equal(document.original.tooLargeForReader, true);
  assert.equal(document.originalAvailable, false, 'the reader keeps the extracted text and shows no download that would fail');
  const served = await call('materials.document.bytes', { documentId: imported.documentId });
  assert.equal(served.status, 'unavailable');
  assert.equal(served.reason, 'too-large');
  assert.equal(served.path, path);
  assert.equal(served.paged, undefined);
  assert.match(served.message, /too large/i);
  await assert.rejects(call('materials.document.pages', { documentId: imported.documentId, from: 1 }), /PDF/);
});

test('a file past what can be read into memory is refused with a named limit, before it is read', async t => {
  const { outside } = await world(t);
  const path = join(outside, 'huge.pdf');
  await writeFile(path, '%PDF-1.7\n');
  const source = createPageSource({ maxFileBytes: 4 });
  await assert.rejects(source.extract({ path, bytes: 9, mtimeMs: 1 }, 1, 1), error => error.code === 'file-too-large' && /too large/i.test(error.message));
  assert.equal(source.state().files, 0);
  assert.equal(source.state().loads, 0, 'not read');
});

test('a page too big to show is its own plain refusal, not a generic failure', async t => {
  const { outside } = await world(t);
  const path = join(outside, 'scan.pdf');
  const bytes = await makeTextPdf(LECTURE_PAGES, { padBytes: 20_000 });
  await writeFile(path, bytes);
  const source = createPageSource({ maxOutputBytes: 1000 });
  await assert.rejects(source.extract({ path, bytes: bytes.length, mtimeMs: 1 }, 1, 1), error => error.code === 'page-too-big' && /too big/i.test(error.message));
  source.release();
});

test('every answer carries the real page count of the file (the reader checks it against the text)', async t => {
  const { call, outside } = await world(t);
  const imported = await call('materials.document.import', { dataBase64: (await makeTextPdf(LECTURE_PAGES)).toString('base64'), filename: 'Lecture.pdf' });
  await call('materials.original.detach', { documentId: imported.documentId });
  const path = join(outside, 'Lecture.pdf');
  await writeFile(path, await makeTextPdf(LECTURE_PAGES, { padBytes: 5000 }));
  await call('materials.original.attach', { documentId: imported.documentId, path, mode: 'reference', confirm: true });
  const ok = await call('materials.document.pages', { documentId: imported.documentId, from: 2 });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.numPages, LECTURE_PAGES.length, 'the real page count of the file comes with every answer');
});
