import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { formatFor, mimeFor } from '../lib/contexts/materials/files.js';
import { groupSourcesByDocument, sourceFormat } from '../lib/source-groups.js';
import { MAX_OFFICE_BYTES, maxBytesFor } from '../lib/office/limits.js';

/* WP28: converter output imported through the ordinary document import. */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wp28-import-'));
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
const base64 = text => Buffer.from(text, 'utf8').toString('base64');
const marked = pages => pages.map(([page, body]) => `<!-- page: ${page} -->\n${body}`).join('\n\n');
const book = marked([[1, '# 第一章 进程\n进程是资源分配的单位。'], [2, '## 1.1 线程\n线程是调度的单位。'], [3, '# 第二章 内存\n虚拟内存给每个进程独立的地址空间。'], [4, '页表把虚拟页映射到物理帧。']]);

test('.json is a document format with the large-file limit', () => {
  assert.equal(formatFor({ filename: 'content_list.json' }), 'json');
  assert.equal(mimeFor('json'), 'application/json');
  assert.equal(maxBytesFor('json'), MAX_OFFICE_BYTES);
});

test('Markdown with page markers imports as one paged document: a source per page, chapters, no original kept', async t => {
  const { call, store } = await fixture(t);
  const imported = await call('materials.document.import', { dataBase64: base64(book), filename: 'os-book.md', courses: ['OS'] });
  assert.equal(imported.sourceIds.length, 4);
  assert.equal(imported.added, 4);
  assert.equal(imported.originalAvailable, false);
  const state = await store.read();
  assert.equal(state.sources.length, 4);
  const [first, , third] = state.sources;
  assert.equal(first.document.page, 1);
  assert.equal(first.document.totalPages, 4);
  assert.equal(first.document.origin, 'converted');
  assert.equal(first.document.converter, 'generic');
  assert.deepEqual(first.courses, ['OS']);
  assert.match(first.title, /p\.1$/);
  assert.equal(third.document.chapter.title, '第二章 内存');
  assert.equal(state.documents[0].format, 'pdf', 'a paged document, like a PDF, without an original file');
  assert.equal(state.documents[0].versions[0].attachment, null);
  const [item] = groupSourcesByDocument(state.sources);
  assert.equal(groupSourcesByDocument(state.sources).length, 1);
  assert.equal(sourceFormat(first), 'pdf');
  assert.equal(item.converted, 'generic');
  assert.equal(item.totalPages, 4);
  assert.deepEqual(item.chapters.map(chapter => [chapter.title, chapter.startPage, chapter.endPage, chapter.sourceIds.length]),
    [['第一章 进程', 1, 2, 2], ['第二章 内存', 3, 4, 2]]);
  assert.match(item.title, /os-book|进程|OS/i);
});

test('importing the same converted file again adds nothing', async t => {
  const { call } = await fixture(t);
  await call('materials.document.import', { dataBase64: base64(book), filename: 'os-book.md' });
  const again = await call('materials.document.import', { dataBase64: base64(book), filename: 'os-book.md' });
  assert.equal(again.added, 0);
  assert.equal(again.sourceIds.length, 4);
});

test('MinerU content_list.json is recognised by its content, whatever the extension says', async t => {
  const { call, store } = await fixture(t);
  const list = [{ type: 'text', text: '概率论', text_level: 1, page_idx: 0 }, { type: 'text', text: '概率是度量。', page_idx: 0 },
    { type: 'text', text: '条件概率', text_level: 1, page_idx: 1 }, { type: 'text', text: '先验与后验。', page_idx: 1 }];
  const imported = await call('materials.document.import', { dataBase64: base64(JSON.stringify(list)), filename: 'content_list.json' });
  assert.equal(imported.sourceIds.length, 2);
  const state = await store.read();
  assert.equal(state.sources[0].document.converter, 'mineru');
  assert.match(state.sources[1].text, /^# 条件概率/);
});

test('a JSON file that is not converter output is refused with a pointer to the right place', async t => {
  const { call, store } = await fixture(t);
  await assert.rejects(call('materials.document.import', { dataBase64: base64(JSON.stringify({ title: 'deck', cards: [] })), filename: 'deck.json' }),
    /MinerU|Docling|题组/);
  assert.equal((await store.read()).sources.length, 0);
});

test('plain Markdown without markers still imports as a single text source', async t => {
  const { call, store } = await fixture(t);
  const imported = await call('materials.document.import', { dataBase64: base64('# 笔记\n\n一段话。'), filename: 'note.md' });
  assert.equal(imported.sourceIds.length, 1);
  const [source] = (await store.read()).sources;
  assert.equal(source.document.origin, undefined);
  assert.equal(imported.originalAvailable, true);
});

test('a textbook of 1,200 pages (over 600,000 characters) is imported whole and stays selectable by page and by chapter', async t => {
  const { call, store } = await fixture(t);
  const pages = Array.from({ length: 1200 }, (_, i) => [i + 1, `${i % 40 === 0 ? `# 第 ${i / 40 + 1} 章\n` : ''}${`知识点 ${i + 1}。`.repeat(150)}`]);
  const imported = await call('materials.document.import', { dataBase64: base64(marked(pages)), filename: 'big.md' });
  assert.equal(imported.sourceIds.length, 1200);
  const { sources } = await store.read();
  assert.ok(sources.reduce((sum, source) => sum + source.text.length, 0) > 600000);
  const [item] = groupSourcesByDocument(sources);
  assert.equal(item.pages.length, 1200);
  assert.equal(item.chapters.length, 30);
  assert.equal(item.chapters[0].sourceIds.length, 40);
});
