import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { createMaterialsOperations, validateSelection } from '../lib/contexts/materials/operations.js';
import { exportAttachments, importAttachments } from '../lib/contexts/materials/files.js';

function pdfBytes(text) {
  const stream = `BT /F1 12 Tf 40 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  const offsets = []; let body = '%PDF-1.7\n';
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'materials-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }), ...options });
  return { root, store, call: (action, args = {}, request = {}) => ops.handlers[action](args, request) };
}

test('materials-only runtime exposes unavailable links without invoking an absent bank', async t => {
  const { root } = await fixture(t);
  const runtime = createStudyRuntime(root, { contexts: ['materials'] });
  t.after(() => runtime.dispose());
  const result = await runtime.call('materials.links.list', {});
  assert.equal(result.status, 'unavailable');
  assert.equal(result.capability, 'bank');
  assert.deepEqual(result.links, []);
});

test('materials retains original TXT bytes and resolves whitespace to authoritative offsets', async t => {
  const { root, call } = await fixture(t);
  const original = 'Title\r\nA  precise\tpassage.\r\n';
  const file = join(root, 'lecture.txt'); await writeFile(file, original);
  const imported = await call('materials.document.import', { path: file });
  const document = await call('materials.document.get', { id: imported.documentId });
  assert.equal(document.format, 'txt'); assert.equal(document.originalAvailable, true);
  assert.equal(await readFile(document.preview.path, 'utf8'), original);
  assert.notEqual(document.preview.path, file);
  const selected = await call('materials.selection.resolve', { documentId: document.id, revision: document.revision, quote: 'A precise passage.' });
  assert.equal(selected.status, 'resolved');
  const source = document.sources.find(source => source.id === selected.selection.sourceId);
  assert.equal(source.text.slice(selected.selection.start, selected.selection.end), 'A  precise\tpassage.');
  assert.equal(selected.selection.quote, 'A  precise\tpassage.');
});

test('materials resolves rendered Markdown table cells, links and entities rather than markup', async t => {
  const { call } = await fixture(t);
  const markdown = '# Heading\n\n| Concept | Meaning |\n| --- | --- |\n| **Bounded context** | [Shared contract](https://example.org) &amp; ownership |\n';
  const imported = await call('materials.document.import', { filename: 'table.md', dataBase64: Buffer.from(markdown).toString('base64') });
  const document = await call('materials.document.get', { id: imported.documentId });
  assert.equal(await readFile(document.preview.path, 'utf8'), markdown);
  const selected = await call('materials.selection.resolve', { documentId: document.id, quote: 'Shared contract & ownership', revision: document.revision });
  assert.equal(selected.status, 'resolved');
  assert.equal(selected.selection.quote, 'Shared contract & ownership');
  assert.equal(document.sources[0].text.includes('https://example.org'), false);
});

test('materials extracts HTML through a parser, decodes entities and excludes inert content', async t => {
  const { call } = await fixture(t);
  const html = '<!doctype html><html><head><title>Hidden title</title><script>doEvil()</script></head><body><p>A &lt; B &amp; C &gt; D</p><div hidden>Invisible</div><style>.secret{}</style><p>Quoted <b>visible</b> text.</p></body></html>';
  const imported = await call('materials.document.import', { filename: 'lesson.html', dataBase64: Buffer.from(html).toString('base64') });
  const document = await call('materials.document.get', { id: imported.documentId });
  assert.equal(await readFile(document.preview.path, 'utf8'), html);
  assert.equal(document.sources[0].text.includes('Invisible'), false);
  assert.equal(document.sources[0].text.includes('doEvil'), false);
  assert.equal((await call('materials.selection.resolve', { documentId: document.id, revision: document.revision, quote: 'A < B & C > D' })).status, 'resolved');
});

test('materials retains original PDF bytes and maps a visible page selection', async t => {
  const { call } = await fixture(t);
  const bytes = pdfBytes('Public APIs preserve independent ownership of learning content.');
  const imported = await call('materials.document.import', { filename: 'lecture.pdf', dataBase64: bytes.toString('base64') });
  const document = await call('materials.document.get', { id: imported.documentId });
  assert.deepEqual(await readFile(document.preview.path), bytes);
  const original = await call('materials.document.bytes', { documentId: document.id });
  assert.equal(original.mime, 'application/pdf'); assert.equal(original.dataBase64, bytes.toString('base64'));
  const selected = await call('materials.selection.resolve', { documentId: document.id, revision: document.revision, page: 1, quote: 'Public APIs preserve independent ownership' });
  assert.equal(selected.status, 'resolved'); assert.equal(selected.selection.page, 1);
});

test('duplicate quotes require context or checked offsets and changed revisions remain stale', async t => {
  const { root, call } = await fixture(t);
  const file = join(root, 'repeated.txt'); await writeFile(file, 'First repeat here. Second repeat there.');
  const imported = await call('materials.document.import', { path: file });
  const identity = { documentId: imported.documentId, revision: imported.revision, quote: 'repeat' };
  assert.equal((await call('materials.selection.resolve', identity)).status, 'ambiguous');
  const selected = await call('materials.selection.resolve', { ...identity, prefix: 'Second ' });
  assert.equal(selected.status, 'resolved'); assert.equal(selected.selection.start, 26);
  assert.equal((await call('materials.selection.resolve', { ...identity, start: 7, end: 13 })).status, 'missing');
  await writeFile(file, 'Changed first repeat here. Changed second repeat there.');
  const refreshed = await call('materials.document.get', { id: imported.documentId, refresh: true });
  assert.notEqual(refreshed.revision, imported.revision);
  assert.equal((await call('materials.selection.resolve', selected.selection)).status, 'stale');
  assert.equal((await call('materials.selection.resolve', { ...selected.selection, revalidate: true, prefix: '', suffix: '', start: undefined, end: undefined })).status, 'ambiguous');
  const old = await call('materials.document.get', { id: imported.documentId, revision: imported.revision });
  assert.equal(old.sources[0].text, 'First repeat here. Second repeat there.');
});

test('atomic selection validator rejects stale versions, forged offsets and invented quotes', async t => {
  const { call, store } = await fixture(t);
  const imported = await call('materials.document.import', { filename: 'evidence.txt', dataBase64: Buffer.from('API contracts isolate ownership.').toString('base64') });
  const selected = await call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: 'API contracts' });
  const state = await store.read();
  assert.deepEqual(validateSelection(state, selected.selection), selected.selection);
  assert.throws(() => validateSelection(state, { ...selected.selection, revision: 'old' }), /stale/);
  assert.throws(() => validateSelection(state, { ...selected.selection, sourceId: 'other' }), /missing/);
  assert.throws(() => validateSelection(state, { ...selected.selection, documentId: 'unrelated-document' }), /missing/);
  assert.throws(() => validateSelection(state, { ...selected.selection, start: 1 }), /missing/);
  assert.throws(() => validateSelection(state, { ...selected.selection, quote: 'API contracts invent facts' }), /missing/);
});

test('old extracted-only sources stay readable, selectable and enrich without losing optional values', async t => {
  const { store, call } = await fixture(t);
  const source = { id: 'legacy-pdf-p1', title: 'Old lecture', text: 'Stable legacy evidence.', document: { id: 'old-pdf', page: 1, filename: 'old.pdf' }, custom: { untouched: true } };
  await store.update(state => { state.sources.push(source); });
  const document = await call('materials.document.get', { sourceId: source.id });
  assert.equal(document.preview.kind, 'extracted'); assert.equal(document.originalAvailable, false);
  assert.equal((await call('materials.selection.resolve', { sourceId: source.id, quote: source.text })).status, 'resolved');
  const enriched = await call('materials.enrich', { sourceIds: [source.id] });
  assert.ok(enriched.unresolved.some(item => item.id === source.id && item.fields.includes('original')));
  const state = await store.read();
  assert.equal(state.sources[0].text, source.text); assert.equal(state.sources[0].document.page, 1);
  assert.equal(state.sources[0].courses, undefined);
  assert.deepEqual(state.sources[0].custom, { untouched: true });
});

test('attaching a legacy original preserves historical source text and citation identity', async t => {
  const { store, call } = await fixture(t);
  const source = { id: 'legacy-pdf', title: 'Historical extraction', text: 'Historical evidence stays intact.', document: { id: 'legacy-identity', page: 1, filename: 'old.pdf' } };
  await store.update(state => state.sources.push(source));
  const attached = await call('materials.document.attach', { sourceId: source.id, filename: 'old.pdf', dataBase64: pdfBytes('A corrected original extraction provides new learning evidence.').toString('base64') });
  assert.equal(attached.originalAvailable, true);
  const document = await call('materials.document.get', { sourceId: source.id });
  assert.equal(document.originalAvailable, true); assert.ok(!document.sourceIds.includes(source.id));
  assert.equal((await store.read()).sources.find(item => item.id === source.id).text, source.text);
  const old = await call('materials.selection.resolve', { sourceId: source.id, quote: source.text });
  assert.equal(old.status, 'resolved'); assert.equal(old.selection.sourceId, source.id);
});

test('portable original backup uses relative content hashes and validates before restoration', async t => {
  const first = await fixture(t), second = await fixture(t);
  const text = 'A portable retained original.';
  const imported = await first.call('materials.document.import', { filename: 'portable.txt', dataBase64: Buffer.from(text).toString('base64') });
  const state = await first.store.read(), exported = await exportAttachments(first.root, state.documents);
  assert.match(exported[0].path, /^attachments\/materials\/[a-f0-9]{64}\.txt$/);
  await assert.rejects(importAttachments(second.root, [{ ...exported[0], path: '../outside.txt' }]), /reference/);
  await assert.rejects(importAttachments(second.root, [{ ...exported[0], dataBase64: Buffer.from('forged').toString('base64') }]), /hash or size/);
  await importAttachments(second.root, exported);
  await second.store.update(restored => { restored.sources = structuredClone(state.sources); restored.documents = structuredClone(state.documents); });
  const document = await second.call('materials.document.get', { id: imported.documentId });
  assert.equal(document.originalAvailable, true); assert.equal(await readFile(document.preview.path, 'utf8'), text);
  assert.ok(document.preview.path.startsWith(second.root));
});

test('an opened historical retained path preserves its visible revision after refresh', async t => {
  const { call } = await fixture(t);
  const first = await call('materials.document.import', { filename: 'old.txt', dataBase64: Buffer.from('Stable quote. Old supporting context.').toString('base64') });
  const second = await call('materials.document.import', { documentId: first.documentId, filename: 'new.txt', dataBase64: Buffer.from('Stable quote. New supporting context.').toString('base64') });
  const opened = await call('materials.document.get', { path: first.document.preview.path });
  assert.equal(opened.revision, first.revision);
  assert.equal(opened.preview.path, first.document.preview.path);
  assert.notEqual(opened.revision, second.revision);
});

test('the same original bytes in different formats retain separate projections', async t => {
  const { call } = await fixture(t);
  const dataBase64 = Buffer.from('# Heading\n\nA passage.').toString('base64');
  const text = await call('materials.document.import', { filename: 'mixed.txt', dataBase64 });
  const markdown = await call('materials.document.import', { filename: 'mixed.md', dataBase64 });
  assert.notEqual(text.documentId, markdown.documentId);
  assert.notEqual(text.revision, markdown.revision);
  assert.equal(text.document.sources[0].text, '# Heading\n\nA passage.');
  assert.equal(markdown.document.sources[0].text, 'Heading\nA passage.');
});

test('links resolve existing card JSON and asking uses the request model and cancellation', async t => {
  let cards = [], seen;
  const { call } = await fixture(t, { bankCards: async () => cards, complete: () => { throw new Error('wrong model'); } });
  const imported = await call('materials.document.import', { filename: 'plain.txt', dataBase64: Buffer.from('API boundaries preserve ownership.').toString('base64') });
  const resolved = await call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: 'API boundaries' });
  cards = [{ deckId: 'existing', deckTitle: 'Current deck', id: 'q1', prompt: 'What preserves ownership?', answer: 'API boundaries', explanation: 'Current explanation', selections: [resolved.selection] }];
  const links = await call('materials.links.list', { documentId: imported.documentId });
  assert.equal(links.links.length, 1); assert.equal(links.links[0].explanation, 'Current explanation');
  cards[0].explanation = 'Revised explanation';
  assert.equal((await call('materials.links.list', { cardId: 'q1' })).links[0].explanation, 'Revised explanation');
  const controller = new AbortController();
  const asked = await call('materials.selection.ask', { selection: resolved.selection, question: 'Why?' }, { signal: controller.signal, complete: async (system, prompt, options) => { seen = { system, prompt, options }; return 'The contract protects ownership.'; } });
  assert.equal(asked.status, 'answered'); assert.equal(asked.selection.sourceId, resolved.selection.sourceId);
  assert.ok(seen.prompt.includes('API boundaries')); assert.equal(seen.options.signal, controller.signal);
  controller.abort();
  await assert.rejects(call('materials.selection.ask', { selection: resolved.selection, question: 'Why?' }, { signal: controller.signal, complete: () => { throw new Error('Model must not run after abort'); } }), { name: 'AbortError' });
  const unavailable = await fixture(t);
  await unavailable.store.update(state => state.sources.push({ id: 'source', title: 'Source', text: 'Evidence' }));
  assert.equal((await unavailable.call('materials.selection.ask', { selection: { sourceId: 'source', quote: 'Evidence' }, question: 'Why?' })).status, 'unavailable');
});
