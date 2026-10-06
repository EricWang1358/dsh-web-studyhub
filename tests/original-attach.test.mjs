/* Attaching the ORIGINAL file to a document that only kept its extracted text (a legacy import): by reference
   (the path is remembered, nothing is copied) or as a copy in the library. The stored text, the revision, the
   citations, the selections and the card links never change. No network, no model, generated PDFs only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { StudyService } from '../lib/service.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { materialsSchemas } from '../lib/contexts/materials/contracts.js';
import { hashFile } from '../lib/contexts/materials/original-file.js';
import { domainTool } from '../lib/runtime/tools.js';
import { makeTextPdf, LECTURE_PAGES } from './helpers/text-pdf.mjs';
import { collectGarbage, settledMemory } from '../scripts/qa/perf-probe.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'original-attach-'));
  const outside = await mkdtemp(join(tmpdir(), 'original-attach-files-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  const call = (action, args = {}) => ops.handlers[action](args, {});
  return { root, outside, store, call };
}

/** A lecture PDF imported the way every version before originals were kept did it: text only, no document record. */
async function legacyLecture(t, pages = LECTURE_PAGES) {
  const env = await fixture(t);
  const bytes = await makeTextPdf(pages);
  const file = join(env.outside, 'lecture.pdf');
  await writeFile(file, bytes);
  const imported = await env.call('materials.document.import', { dataBase64: bytes.toString('base64'), filename: 'lecture.pdf' });
  await env.store.update(state => {
    state.documents = [];
    for (const source of state.sources) { delete source.document.materialId; delete source.document.materialRevision; delete source.document.format; }
  });
  await rm(join(env.root, 'attachments'), { recursive: true, force: true }); // a legacy import never kept the file
  const sources = (await env.store.read()).sources;
  return { ...env, bytes, file, sources, sourceId: sources[0].id, imported };
}

const withoutAttach = state => ({ sources: state.sources, documentIds: (state.documents || []).map(item => item.id) });

test('a legacy document has no original: the descriptor says what is missing', async t => {
  const { call, sourceId } = await legacyLecture(t);
  const document = await call('materials.document.get', { sourceId });
  assert.equal(document.originalAvailable, false);
  assert.equal(document.original.mode, null);
  assert.equal(document.original.status, 'none');
});

test('attach by reference: only the path is remembered; text, revision, selections and card links do not change', async t => {
  const env = await legacyLecture(t);
  const { call, store, root, file, sourceId, sources } = env;
  const before = await call('materials.document.get', { sourceId });
  const selected = await call('materials.selection.resolve', { sourceId, quote: 'extra data structure' });
  assert.equal(selected.status, 'resolved');
  const cardSelection = selected.selection; // what a card saved: a legacy selection has no document id
  const linksOf = async () => createMaterialsOperations({ root, bankCards: async () => [{ deckId: 'deck', card: { id: 'card', prompt: 'Q', selections: [cardSelection] } }],
    read: async () => structuredClone(await store.read()), update: async () => {} }).handlers['materials.links.list']({ sourceId }, {});
  const linksBefore = await linksOf();
  assert.equal(linksBefore.links[0].status, 'resolved');
  const textBefore = JSON.stringify((await store.read()).sources);

  const result = await call('materials.original.attach', { sourceId, path: file, mode: 'reference' });
  assert.equal(result.status, 'attached');
  assert.equal(result.mode, 'reference');
  assert.equal(result.report.verdict, 'identical');
  assert.equal(result.report.pages.match, true);

  const state = await store.read();
  assert.equal(JSON.stringify(state.sources), textBefore, 'the stored text is byte-for-byte what it was');
  assert.deepEqual(sources.map(source => source.text), state.sources.map(source => source.text));
  const document = await call('materials.document.get', { sourceId });
  assert.equal(document.revision, before.revision, 'the revision does not change');
  assert.equal(document.documentId, before.documentId);
  assert.deepEqual(document.sourceIds, before.sourceIds);
  assert.equal(document.originalAvailable, true);
  assert.equal(document.original.mode, 'reference');
  assert.equal(document.original.status, 'ok');
  assert.equal(document.original.path, file);
  assert.equal(document.original.bytes, (await stat(file)).size);
  assert.ok(!existsSync(join(root, 'attachments')), 'nothing was copied into the library');

  const version = state.documents.find(item => item.id === before.documentId).versions[0];
  assert.equal(version.attachment ?? null, null);
  assert.equal(version.external.path, file);
  assert.equal(version.external.hash, sha(await readFile(file)));
  assert.equal(version.external.bytes, (await stat(file)).size);
  assert.equal(typeof version.external.mtimeMs, 'number');
  assert.ok(Date.parse(version.external.verifiedAt) > 0);

  const after = await call('materials.selection.resolve', { sourceId, quote: 'extra data structure' });
  assert.equal(after.status, 'resolved');
  assert.deepEqual(after.selection, selected.selection);
  const links = await call('materials.links.list', { documentId: before.documentId });
  assert.deepEqual(links, { links: [], capability: 'bank', status: 'unavailable' }, 'unchanged: no bank in this fixture');
  assert.deepEqual(await linksOf(), linksBefore, 'the card link resolves exactly as before');
});

test('the reader gets the verified bytes of a referenced original, from the stored path only', async t => {
  const { call, file, sourceId, bytes, outside } = await legacyLecture(t);
  await call('materials.original.attach', { sourceId, path: file, mode: 'reference' });
  const document = await call('materials.document.get', { sourceId });
  const other = join(outside, 'other.pdf');
  await writeFile(other, await makeTextPdf([['Another unrelated document that must never be served.']]));
  // The client names a document and a revision; a path it adds is ignored.
  const served = await call('materials.document.bytes', { documentId: document.documentId, revision: document.revision, path: other, externalPath: other });
  assert.equal(served.format, 'pdf');
  assert.equal(served.mime, 'application/pdf');
  assert.deepEqual(Buffer.from(served.dataBase64, 'base64'), bytes);
});

test('attach as a copy: stored exactly like a retained original, independent of the source file afterwards', async t => {
  const { call, store, root, file, sourceId, bytes } = await legacyLecture(t);
  const before = await call('materials.document.get', { sourceId });
  const result = await call('materials.original.attach', { sourceId, path: file, mode: 'copy' });
  assert.equal(result.status, 'attached'); assert.equal(result.mode, 'copy');
  const version = (await store.read()).documents[0].versions[0];
  assert.deepEqual(version.attachment, { path: `attachments/materials/${sha(bytes)}.pdf`, hash: sha(bytes), bytes: bytes.length, format: 'pdf' });
  assert.equal(version.external ?? null, null);
  assert.deepEqual(await readFile(join(root, version.attachment.path)), bytes);
  await rm(file);
  const document = await call('materials.document.get', { sourceId });
  assert.equal(document.revision, before.revision);
  assert.equal(document.originalAvailable, true);
  assert.equal(document.original.mode, 'copy'); assert.equal(document.original.bytes, bytes.length);
  assert.equal(document.preview.kind, 'file');
  const served = await call('materials.document.bytes', { documentId: document.documentId, revision: document.revision });
  assert.deepEqual(Buffer.from(served.dataBase64, 'base64'), bytes);
});

test('copy mode accepts the bytes of a file the browser chose (no path), reference mode needs a path', async t => {
  const { call, sourceId, bytes } = await legacyLecture(t);
  await assert.rejects(call('materials.original.attach', { sourceId, dataBase64: bytes.toString('base64'), filename: 'lecture.pdf', mode: 'reference' }), /needs a file path/);
  const copied = await call('materials.original.attach', { sourceId, dataBase64: bytes.toString('base64'), filename: 'lecture.pdf', mode: 'copy' });
  assert.equal(copied.status, 'attached'); assert.equal(copied.report.verdict, 'identical');
  assert.equal((await call('materials.document.get', { sourceId })).original.mode, 'copy');
});

test('verification (no model): identical bytes, the same text re-saved, other text, another page count, another format', async t => {
  const { call, sourceId, outside, file } = await legacyLecture(t);
  const probe = path => call('materials.original.probe', { sourceId, path });
  assert.equal((await probe(file)).verdict, 'identical');

  const resaved = join(outside, 'resaved.pdf');
  await writeFile(resaved, await makeTextPdf(LECTURE_PAGES.map(page => [page[0] + ' ', ...page.slice(1)])));
  const same = await probe(resaved);
  assert.equal(same.verdict, 'match'); assert.equal(same.pages.stored, 3); assert.equal(same.pages.supplied, 3); assert.equal(same.pages.match, true);
  assert.equal(same.checked, 3); assert.equal(same.matched, 3); assert.ok(same.similarity >= 0.99);

  const otherText = join(outside, 'other-text.pdf');
  await writeFile(otherText, await makeTextPdf([['Operating systems schedule processes with a run queue per processor.'], ['Virtual memory maps pages of an address space onto frames of memory.'], ['A file system keeps names, blocks and permissions in on-disk structures.']]));
  const different = await probe(otherText);
  assert.equal(different.verdict, 'mismatch'); assert.equal(different.pages.match, true); assert.equal(different.matched, 0); assert.ok(different.similarity < 0.5);
  assert.deepEqual(different.mismatchedPages, [1, 2, 3]);

  const fewer = join(outside, 'two-pages.pdf');
  await writeFile(fewer, await makeTextPdf(LECTURE_PAGES.slice(0, 2)));
  const short = await probe(fewer);
  assert.equal(short.verdict, 'mismatch'); assert.equal(short.pages.stored, 3); assert.equal(short.pages.supplied, 2); assert.equal(short.pages.match, false);
  assert.ok(short.reasons.includes('page-count'));

  const text = join(outside, 'lecture.txt');
  await writeFile(text, 'Not a pdf');
  await assert.rejects(probe(text), /same type|format/i);
});

test('a mismatch is not attached until the learner confirms it, and the confirmation is recorded', async t => {
  const { call, store, sourceId, outside } = await legacyLecture(t);
  const wrong = join(outside, 'wrong.pdf');
  await writeFile(wrong, await makeTextPdf([['Something else entirely about compilers and parsers.'], ['Lexers turn characters into tokens for the parser to consume.'], ['Code generation maps trees onto instructions for the target machine.']]));
  const before = JSON.stringify(withoutAttach(await store.read()));
  const refused = await call('materials.original.attach', { sourceId, path: wrong, mode: 'reference' });
  assert.equal(refused.status, 'needs-confirmation'); assert.equal(refused.report.verdict, 'mismatch');
  assert.equal(JSON.stringify(withoutAttach(await store.read())), before);
  assert.equal((await call('materials.document.get', { sourceId })).originalAvailable, false);
  const confirmed = await call('materials.original.attach', { sourceId, path: wrong, mode: 'reference', confirm: true });
  assert.equal(confirmed.status, 'attached');
  const version = (await store.read()).documents[0].versions[0];
  assert.equal(version.originalCheck.verdict, 'mismatch'); assert.equal(version.originalCheck.confirmed, true);
  assert.equal((await call('materials.document.get', { sourceId })).originalAvailable, true);
});

test('attaching the same file again changes nothing', async t => {
  const { call, store, sourceId, file } = await legacyLecture(t);
  await call('materials.original.attach', { sourceId, path: file, mode: 'reference' });
  const first = JSON.stringify((await store.read()).documents);
  const again = await call('materials.original.attach', { sourceId, path: file, mode: 'reference' });
  assert.equal(again.status, 'attached'); assert.equal(again.unchanged, true);
  assert.equal(JSON.stringify((await store.read()).documents), first);
  await call('materials.original.attach', { sourceId, path: file, mode: 'copy' });
  const copied = JSON.stringify((await store.read()).documents);
  assert.equal((await call('materials.original.attach', { sourceId, path: file, mode: 'copy' })).unchanged, true);
  assert.equal(JSON.stringify((await store.read()).documents), copied);
});

test('a referenced file that went missing or was edited is reported plainly, never as a blank or a crash', async t => {
  const { call, sourceId, file, outside, bytes } = await legacyLecture(t);
  await call('materials.original.attach', { sourceId, path: file, mode: 'reference' });
  const document = await call('materials.document.get', { sourceId });

  // touched but the same bytes: still fine
  const later = new Date(Date.now() + 60_000);
  await utimes(file, later, later);
  assert.equal((await call('materials.document.get', { sourceId })).original.status, 'ok');
  assert.equal((await call('materials.document.bytes', { documentId: document.documentId })).format, 'pdf');

  // same size, other bytes
  const edited = Buffer.from(bytes); edited[edited.length - 40] ^= 0x01;
  await writeFile(file, edited);
  const changed = await call('materials.document.get', { sourceId });
  assert.equal(changed.originalAvailable, false); assert.equal(changed.original.status, 'changed'); assert.equal(changed.original.mode, 'reference'); assert.equal(changed.original.path, file);
  const refusal = await call('materials.document.bytes', { documentId: document.documentId });
  assert.equal(refusal.status, 'unavailable'); assert.equal(refusal.reason, 'changed'); assert.equal(refusal.path, file); assert.equal(refusal.dataBase64, undefined);

  // moved away
  await rename(file, join(outside, 'moved.pdf'));
  const missing = await call('materials.document.get', { sourceId });
  assert.equal(missing.original.status, 'missing'); assert.equal(missing.originalAvailable, false);
  const gone = await call('materials.document.bytes', { documentId: document.documentId });
  assert.equal(gone.status, 'unavailable'); assert.equal(gone.reason, 'missing'); assert.equal(gone.path, file);
  assert.equal(missing.preview.kind, 'extracted');

  // relink: the new path is verified like the first one
  const relinked = await call('materials.original.attach', { sourceId, path: join(outside, 'moved.pdf'), mode: 'reference' });
  assert.equal(relinked.status, 'attached'); assert.equal(relinked.report.verdict, 'match');
  assert.equal((await call('materials.document.get', { sourceId })).original.status, 'ok');
});

test('"copy into the library" works from the stored path alone while the referenced file is still there', async t => {
  const { call, store, sourceId, file, bytes } = await legacyLecture(t);
  await call('materials.original.attach', { sourceId, path: file, mode: 'reference' });
  const converted = await call('materials.original.attach', { sourceId, mode: 'copy' });
  assert.equal(converted.status, 'attached'); assert.equal(converted.mode, 'copy');
  const version = (await store.read()).documents[0].versions[0];
  assert.equal(version.attachment.hash, sha(bytes)); assert.equal(version.external ?? null, null, 'the reference is replaced');
  await call('materials.original.detach', { sourceId });
  await assert.rejects(call('materials.original.attach', { sourceId, mode: 'copy' }), /file/i);
});

test('detaching forgets the original and leaves the text alone', async t => {
  const { call, store, sourceId, file } = await legacyLecture(t);
  await call('materials.original.attach', { sourceId, path: file, mode: 'reference' });
  const textBefore = JSON.stringify((await store.read()).sources);
  const detached = await call('materials.original.detach', { sourceId });
  assert.equal(detached.status, 'detached');
  assert.equal(JSON.stringify((await store.read()).sources), textBefore);
  const document = await call('materials.document.get', { sourceId });
  assert.equal(document.originalAvailable, false); assert.equal(document.original.status, 'none');
  assert.ok(existsSync(file), 'the learner file is never touched');
  assert.equal((await call('materials.original.detach', { sourceId })).status, 'detached', 'idempotent');
});

test('a document whose retained copy file went missing can be repaired the same way', async t => {
  const env = await fixture(t);
  const bytes = await makeTextPdf(LECTURE_PAGES);
  const imported = await env.call('materials.document.import', { dataBase64: bytes.toString('base64'), filename: 'lecture.pdf' });
  const stored = (await env.store.read()).documents[0].versions[0].attachment;
  await rm(join(env.root, stored.path));
  assert.equal((await env.call('materials.document.get', { documentId: imported.documentId })).originalAvailable, false);
  const file = join(env.outside, 'lecture.pdf'); await writeFile(file, bytes);
  const fixed = await env.call('materials.original.attach', { documentId: imported.documentId, path: file, mode: 'copy' });
  assert.equal(fixed.status, 'attached');
  assert.equal((await env.call('materials.document.get', { documentId: imported.documentId })).originalAvailable, true);
});

test('hashing streams the file in small chunks; a file over the limit is refused before it is read', async t => {
  const { outside, call, sourceId } = await legacyLecture(t);
  const big = join(outside, 'big.pdf');
  await writeFile(big, '%PDF-1.7\n'); await truncate(big, 120 * 1024 * 1024);
  // Measure retained buffers, not when a particular V8 version happens to
  // collect dead stream chunks (Node 24 lets those exceed this budget).
  assert.equal(collectGarbage(), true, 'retained-memory measurement requires collection');
  const chunks = []; let peakBuffersMiB = 0;
  const result = await hashFile(big, { onChunk: size => {
    chunks.push(size);
    peakBuffersMiB = Math.max(peakBuffersMiB, settledMemory().arrayBuffers);
  } });
  assert.equal(result.bytes, 120 * 1024 * 1024);
  assert.ok(chunks.length > 100, 'many chunks'); assert.ok(Math.max(...chunks) <= 1024 * 1024, 'no chunk above 1 MB');
  assert.ok(peakBuffersMiB < 64, `live buffers stay below 64 MiB while hashing (observed ${peakBuffersMiB})`);
  // Negative control: a live full-file copy must still exceed the unchanged
  // budget after collection, so collection cannot hide buffered input.
  const retained = await readFile(big);
  const bufferedMiB = settledMemory().arrayBuffers;
  assert.ok(bufferedMiB >= 120, 'the probe detects a retained full-file copy');
  t.diagnostic(`retained buffers: streaming peak ${peakBuffersMiB} MiB; full-file control ${bufferedMiB} MiB`);
  assert.equal(retained.length, result.bytes);
  assert.equal(sha(retained), result.hash, 'streaming and buffered digests agree');
  await truncate(big, 41 * 1024 * 1024);
  await assert.rejects(call('materials.original.attach', { sourceId, path: big, mode: 'reference' }), /at most 40 MB/);
});

test('path rules: absolute files of the same type only; nothing else is read', async t => {
  const { call, sourceId, outside, file } = await legacyLecture(t);
  await assert.rejects(call('materials.original.attach', { sourceId, path: 'lecture.pdf', mode: 'reference' }), /absolute/);
  await assert.rejects(call('materials.original.attach', { sourceId, path: outside, mode: 'reference' }), /file/);
  await assert.rejects(call('materials.original.attach', { sourceId, path: join(outside, 'nope.pdf'), mode: 'reference' }), /not found|exist/i);
  await assert.rejects(call('materials.original.attach', { sourceId, path: file, mode: 'link' }), /mode/);
  await assert.rejects(call('materials.original.attach', { sourceId, mode: 'reference' }), /path/);
});

test('a referenced path that now leads somewhere else is not followed', async t => {
  const { call, sourceId, outside, bytes } = await legacyLecture(t);
  const folder = join(outside, 'shelf'), elsewhere = join(outside, 'elsewhere');
  await mkdir(folder); await mkdir(elsewhere);
  const file = join(folder, 'lecture.pdf'); await writeFile(file, bytes);
  await call('materials.original.attach', { sourceId, path: file, mode: 'reference' });
  await rename(folder, join(outside, 'shelf-old'));
  await writeFile(join(elsewhere, 'lecture.pdf'), bytes); // the very same bytes, another place
  try { await symlink(elsewhere, folder, 'junction'); } catch { t.diagnostic('junction not allowed here'); return; }
  const document = await call('materials.document.get', { sourceId });
  assert.equal(document.original.status, 'changed');
  const served = await call('materials.document.bytes', { documentId: document.documentId });
  assert.equal(served.status, 'unavailable'); assert.equal(served.reason, 'redirected');
});

test('probing never writes and never keeps the file', async t => {
  const { call, store, sourceId, file, root } = await legacyLecture(t);
  const before = JSON.stringify(await store.read());
  await call('materials.original.probe', { sourceId, path: file });
  assert.equal(JSON.stringify(await store.read()), before);
  assert.ok(!existsSync(join(root, 'attachments')));
});

test('text documents are verified too; an audio transcript has no original to attach', async t => {
  const env = await fixture(t);
  const text = 'Stable lecture notes.\nSecond line of the notes.\n';
  await env.store.update(state => { state.sources.push({ id: 'note-1', title: 'Notes', text }); });
  const file = join(env.outside, 'notes.txt'); await writeFile(file, text);
  assert.equal((await env.call('materials.original.probe', { sourceId: 'note-1', path: file })).verdict, 'identical', 'the very same bytes');
  const windows = join(env.outside, 'notes-windows.txt'); await writeFile(windows, text.replaceAll(String.fromCharCode(10), String.fromCharCode(13, 10)));
  const report = await env.call('materials.original.probe', { sourceId: 'note-1', path: windows });
  assert.equal(report.verdict, 'match'); assert.equal(report.similarity, 1);
  const different = join(env.outside, 'different.txt'); await writeFile(different, 'Completely different notes about another subject.');
  assert.equal((await env.call('materials.original.probe', { sourceId: 'note-1', path: different })).verdict, 'mismatch');
  assert.equal((await env.call('materials.original.attach', { sourceId: 'note-1', path: file, mode: 'reference' })).status, 'attached');
  await env.store.update(state => { state.sources.push({ id: 'talk-1', title: 'Talk', text: 'Spoken words here.', audio: { duration: 10 } }); });
  await assert.rejects(env.call('materials.original.probe', { sourceId: 'talk-1', path: file }), /audio/i);
});

test('the status operation is cheap and summarises the original for a list row', async t => {
  const { call, sourceId, file } = await legacyLecture(t);
  assert.deepEqual(await call('materials.original.status', { sourceId }), { documentId: (await call('materials.document.get', { sourceId })).documentId, revision: (await call('materials.document.get', { sourceId })).revision, format: 'pdf', mode: null, status: 'none', pages: 3 });
  await call('materials.original.attach', { sourceId, path: file, mode: 'reference' });
  const status = await call('materials.original.status', { sourceId });
  assert.equal(status.mode, 'reference'); assert.equal(status.status, 'ok'); assert.equal(status.path, file); assert.equal(status.sources, undefined);
});

test('a library backup includes copies, says referenced originals are not included, and counts them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'original-attach-backup-'));
  const outside = await mkdtemp(join(tmpdir(), 'original-attach-backup-files-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const service = new StudyService(root);
  const copyBytes = await makeTextPdf(LECTURE_PAGES), refBytes = await makeTextPdf([['A second lecture about queues and stacks as abstract data types.'], ['Queues are first in first out while stacks are last in first out.']]);
  const copyFile = join(outside, 'copy.pdf'), refFile = join(outside, 'ref.pdf');
  await writeFile(copyFile, copyBytes); await writeFile(refFile, refBytes);
  for (const [bytes, name] of [[copyBytes, 'copy.pdf'], [refBytes, 'ref.pdf']]) await service.call('materials.document.import', { dataBase64: bytes.toString('base64'), filename: name });
  // make both legacy (text only), then attach one by copy and one by reference
  await new Store(root).update(s => { s.documents = []; for (const source of s.sources) { delete source.document.materialId; delete source.document.materialRevision; delete source.document.format; } });
  const sources = (await new Store(root).read()).sources;
  const ofFile = name => sources.find(source => source.document.filename === name);
  const copySource = ofFile('copy.pdf'), refSource = ofFile('ref.pdf');
  assert.ok(copySource && refSource);
  assert.equal((await service.call('materials.original.attach', { sourceId: copySource.id, path: copyFile, mode: 'copy' })).status, 'attached');
  assert.equal((await service.call('materials.original.attach', { sourceId: refSource.id, path: refFile, mode: 'reference' })).status, 'attached');
  const backup = await service.call('export');
  assert.equal(backup.portableMaterials.attachments.length, 1, 'the copy travels with the backup');
  assert.equal(backup.portableMaterials.attachments[0].hash, sha(copyBytes));
  assert.equal(backup.portableMaterials.referencedOriginals.length, 1, 'the reference does not');
  assert.equal(backup.portableMaterials.referencedOriginals[0].path, refFile);
  assert.ok(!JSON.stringify(backup.portableMaterials.attachments).includes(refBytes.toString('base64').slice(0, 200)));
  // the whole backup restores; the referenced file is looked for at its path again
  const target = await mkdtemp(join(tmpdir(), 'original-attach-restored-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const restored = new StudyService(target);
  await restored.call('restore', { state: JSON.parse(JSON.stringify(backup)) });
  const document = await restored.call('materials.document.get', { sourceId: refSource.id });
  assert.equal(document.original.mode, 'reference'); assert.equal(document.original.status, 'ok');
  assert.equal((await restored.call('materials.document.get', { sourceId: copySource.id })).original.mode, 'copy');
});

test('a copied original larger than the import limit still travels in a library backup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'original-attach-large-')), outside = await mkdtemp(join(tmpdir(), 'original-attach-large-files-')), target = await mkdtemp(join(tmpdir(), 'original-attach-large-restored-'));
  t.after(async () => { for (const dir of [root, outside, target]) await rm(dir, { recursive: true, force: true }); });
  const service = new StudyService(root);
  await service.call('materials.document.import', { dataBase64: (await makeTextPdf(LECTURE_PAGES)).toString('base64'), filename: 'lecture.pdf' });
  await new Store(root).update(state => { state.documents = []; for (const source of state.sources) { delete source.document.materialId; delete source.document.materialRevision; delete source.document.format; } });
  await rm(join(root, 'attachments'), { recursive: true, force: true });
  const large = await makeTextPdf(LECTURE_PAGES, { padBytes: 3_200_000 }), file = join(outside, 'lecture.pdf');
  assert.ok(large.length > 9 * 1024 * 1024, 'above the 8 MB import limit');
  await writeFile(file, large);
  const sourceId = (await new Store(root).read()).sources[0].id;
  assert.equal((await service.call('materials.original.attach', { sourceId, path: file, mode: 'copy' })).status, 'attached');
  const document = await service.call('materials.document.get', { sourceId });
  assert.equal(document.original.status, 'ok'); assert.equal(document.original.bytes, large.length);
  assert.deepEqual(Buffer.from((await service.call('materials.document.bytes', { sourceId })).dataBase64, 'base64'), large);
  const backup = await service.call('export');
  assert.equal(backup.portableMaterials.attachments[0].bytes, large.length);
  const restored = new StudyService(target);
  await restored.call('restore', { state: JSON.parse(JSON.stringify(backup)) });
  assert.deepEqual(Buffer.from((await restored.call('materials.document.bytes', { sourceId })).dataBase64, 'base64'), large);
});

test('enrich no longer lists the original as missing once one is attached', async t => {
  const { call, sourceId, file } = await legacyLecture(t);
  assert.ok((await call('materials.enrich', { sourceIds: [sourceId] })).unresolved.some(item => item.fields.includes('original')));
  await call('materials.original.attach', { sourceId, path: file, mode: 'reference' });
  assert.ok(!(await call('materials.enrich', { sourceIds: [sourceId] })).unresolved.some(item => item.fields.includes('original')));
});

test('the operations are in the shared contracts and in the structured study_materials tool', () => {
  for (const name of ['probe', 'attach', 'detach', 'status']) assert.ok(materialsSchemas[`materials.original.${name}`], name);
  assert.equal(materialsSchemas['materials.original.attach'].input.properties.mode.enum.join(), 'reference,copy');
  const tool = domainTool('materials', { resolveWorkspace: async () => null });
  assert.ok(tool.parameters.properties.operation.enum.includes('original.attach'));
  assert.ok(tool.parameters.properties.mode && tool.parameters.properties.confirm);
});
