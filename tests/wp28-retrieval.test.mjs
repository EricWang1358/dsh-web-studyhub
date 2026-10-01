import test from 'node:test';
import assert from 'node:assert/strict';
import { argsForTool, describeProviders, hitsFromMcpResult, narrowSources, normalizeHits, resolveHits, retrieveFromPort, RETRIEVAL_SERVICE } from '../lib/retrieval.js';

/* WP28: the retrieval provider contract
   retrieve({ query, sourceIds?, course?, limit }) -> [{ sourceId, page?, text, score }]
   and the adapters that map a third-party MCP tool's result, or another plugin's service, onto it. */

const page = (n, text, extra = {}) => ({ id: `bk-p${n}`, title: `操作系统 · p.${n}`, text, courses: ['OS'],
  document: { id: 'h1', page: n, totalPages: 400, bookTitle: '操作系统', filename: 'os-book.md', ...extra } });
const book = [page(1, '进程是程序的一次执行，拥有独立的地址空间与资源。'), page(2, '线程是 CPU 调度的基本单位，同一进程的线程共享内存。'),
  page(3, '页表把虚拟页映射到物理帧，TLB 缓存最近的映射结果。'), page(4, '死锁需要互斥、持有并等待、不可抢占、循环等待四个条件。')];

test('normalizeHits accepts the common spellings and keeps only usable passages', () => {
  const hits = normalizeHits({ results: [{ content: '页表映射', filePath: '/books/os-book.md', page_no: 3, relevance: 0.91 },
    { text: '', page: 2 }, { chunk: '死锁条件', source: 'os-book', pageNumber: '4', similarity: 0.5 }, 'not a passage'] });
  assert.deepEqual(hits.map(hit => [hit.text, hit.document, hit.page, hit.score]), [['页表映射', '/books/os-book.md', 3, 0.91], ['死锁条件', 'os-book', 4, 0.5]]);
  assert.deepEqual(normalizeHits([{ sourceId: 'bk-p2', text: '线程', score: 2 }]).map(hit => hit.sourceId), ['bk-p2']);
  assert.deepEqual(normalizeHits({ nothing: true }), []);
  // page_idx is zero-based.
  assert.equal(normalizeHits([{ text: 'x', page_idx: 0 }])[0].page, 1);
  // Without scores the order is the rank.
  const ranked = normalizeHits([{ text: 'a' }, { text: 'b' }]);
  assert.ok(ranked[0].score > ranked[1].score);
});

test('an MCP tool result becomes passages: structured content, JSON text, entry blocks and plain text', () => {
  const structured = hitsFromMcpResult({ content: [], structuredContent: { results: [{ text: 'A', page: 1, score: 0.8 }] } });
  assert.equal(structured[0].text, 'A');
  const json = hitsFromMcpResult({ content: [{ type: 'text', text: JSON.stringify([{ text: 'B', filePath: 'os.md', chunkIndex: 2, score: 0.7 }]) }] });
  assert.equal(json[0].document, 'os.md');
  const entries = hitsFromMcpResult({ content: [{ type: 'text', text: '<entry><content>线程共享内存</content><metadata>{"page":2,"source":"os-book"}</metadata></entry>' },
    { type: 'text', text: '<entry><content>页表</content><metadata>{}</metadata></entry>' }] });
  assert.deepEqual(entries.map(hit => [hit.text, hit.page, hit.document]), [['线程共享内存', 2, 'os-book'], ['页表', undefined, undefined]]);
  const plain = hitsFromMcpResult({ content: [{ type: 'text', text: '第 3 页\n页表把虚拟页映射到物理帧' }, { type: 'image', data: 'x' }] });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].page, 3);
  assert.deepEqual(hitsFromMcpResult({ content: [] }), []);
  assert.deepEqual(hitsFromMcpResult(null), []);
});

test('which arguments a tool wants is read from its schema; an unknown required argument is refused', () => {
  const schema = { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] };
  assert.deepEqual(argsForTool(schema, { query: '死锁', limit: 5 }), { query: '死锁', limit: 5 });
  assert.deepEqual(argsForTool({ type: 'object', properties: { question: { type: 'string' }, top_k: { type: 'number' } }, required: ['question'] }, { query: 'q', limit: 3 }), { question: 'q', top_k: 3 });
  assert.deepEqual(argsForTool({ type: 'object', properties: { text: { type: 'string' } } }, { query: 'q', limit: 3 }), { text: 'q' });
  assert.deepEqual(argsForTool(schema, { query: 'q', limit: 3 }, { queryArg: 'query', limitArg: 'k' }), { query: 'q', k: 3 });
  assert.throws(() => argsForTool({ type: 'object', properties: { query: { type: 'string' }, index: { type: 'string' } }, required: ['query', 'index'] }, { query: 'q', limit: 3 }), /index/);
  assert.throws(() => argsForTool({ type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }, { query: 'q', limit: 3 }), /id/);
});

test('passages are matched to StudyHub sources: by id, by file name and page, by the text itself', () => {
  const hits = normalizeHits([
    { sourceId: 'bk-p2', text: '线程共享内存', score: 0.9 },
    { document: '/data/books/os-book.md', page: 3, text: '页表映射（片段）', score: 0.8 },
    { text: '死锁需要互斥、持有并等待、不可抢占、循环等待四个条件', score: 0.7 },
    { document: 'another.pdf', page: 1, text: '别的书', score: 0.6 },
    { sourceId: 'bk-p2', text: '线程共享内存 重复', score: 0.1 },
  ]);
  const { passages, unresolved } = resolveHits(hits, book);
  assert.deepEqual(passages.map(item => [item.sourceId, item.page, item.matchedBy]), [['bk-p2', 2, 'id'], ['bk-p3', 3, 'document'], ['bk-p4', 4, 'text']]);
  assert.equal(passages[0].score, 0.9, 'a source keeps its best score');
  assert.equal(unresolved, 1);
  // A page number alone is enough when the selection holds one paged document.
  assert.equal(resolveHits(normalizeHits([{ page: 1, text: 'x' }]), book).passages[0].sourceId, 'bk-p1');
});

test('narrowing keeps the best passages within a size budget, in reading order', () => {
  const passages = resolveHits(normalizeHits([{ sourceId: 'bk-p4', text: 'a', score: 0.5 }, { sourceId: 'bk-p1', text: 'b', score: 0.9 }, { sourceId: 'bk-p3', text: 'c', score: 0.7 }]), book).passages;
  const wide = narrowSources(book, passages, { budgetChars: 10000 });
  assert.deepEqual(wide.sources.map(source => source.id), ['bk-p1', 'bk-p3', 'bk-p4']);
  assert.equal(wide.truncated, false);
  const tight = narrowSources(book, passages, { budgetChars: book[0].text.length + book[2].text.length + 1 });
  assert.deepEqual(tight.sources.map(source => source.id), ['bk-p1', 'bk-p3']);
  assert.equal(tight.truncated, true);
  assert.deepEqual(tight.pages.map(item => [item.sourceId, item.page, item.score]), [['bk-p1', 1, 0.9], ['bk-p3', 3, 0.7]]);
  // The first passage is always kept, even over budget.
  assert.equal(narrowSources(book, passages, { budgetChars: 1 }).sources.length, 1);
});

test('providers are listed from the MCP tools DSH exposes and from a registered service; searching tools come first', () => {
  const tools = [
    { name: 'mcp__rag__query_documents', description: 'Semantic search over ingested documents', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'mcp__rag__list_files', description: 'List indexed files', parameters: { type: 'object', properties: {} } },
    { name: 'mcp__docs__convert', description: 'Convert a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'read_file', description: 'Read a file', parameters: {} },
  ];
  const none = describeProviders({ tools: [], service: undefined });
  assert.deepEqual(none.providers, []);
  const found = describeProviders({ tools, service: { retrieve() {} } });
  assert.equal(RETRIEVAL_SERVICE, 'studyRetrieval');
  assert.deepEqual(found.providers.map(provider => [provider.id, provider.kind]), [['service', 'service'], ['mcp:mcp__rag__query_documents', 'mcp']]);
  assert.equal(found.providers[1].server, 'rag');
  assert.equal(found.providers[1].tool, 'mcp__rag__query_documents');
  assert.deepEqual(found.otherTools.map(tool => tool.name), ['mcp__rag__list_files', 'mcp__docs__convert']);
  assert.ok(!found.providers.some(provider => provider.id === 'mcp:read_file'));
});

test('retrieving through a port: the tool is called with the schema arguments and its result is resolved to sources', async () => {
  const calls = [];
  const port = {
    tools: () => [{ name: 'mcp__rag__query_documents', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } }],
    call: async (name, args) => { calls.push([name, args]); return { content: [{ type: 'text', text: JSON.stringify([{ text: '页表', page: 3, filePath: 'os-book.md', score: 0.9 }, { text: '线程', page: 2, filePath: 'os-book.md', score: 0.4 }]) }] }; },
  };
  const result = await retrieveFromPort(port, { provider: 'mcp:mcp__rag__query_documents' }, { query: '页表和 TLB', sources: book, limit: 2 });
  assert.deepEqual(calls, [['mcp__rag__query_documents', { query: '页表和 TLB', limit: 2 }]]);
  assert.deepEqual(result.passages.map(item => item.sourceId), ['bk-p3', 'bk-p2']);
  assert.equal(result.provider, 'mcp:mcp__rag__query_documents');
});

test('a missing tool, a failing tool and a service are reported plainly or used', async () => {
  const port = { tools: () => [], call: async () => { throw new Error('boom'); } };
  await assert.rejects(retrieveFromPort(port, { provider: 'mcp:mcp__gone__search' }, { query: 'q', sources: book }), /mcp__gone__search/);
  const failing = { tools: () => [{ name: 'mcp__a__search', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } } }], call: async () => { throw new Error('connection refused'); } };
  await assert.rejects(retrieveFromPort(failing, { provider: 'mcp:mcp__a__search' }, { query: 'q', sources: book }), /connection refused/);
  const service = { retrieve: async ({ query, sourceIds, course, limit }) => [{ sourceId: sourceIds[1], text: query, score: 1, course, limit }] };
  const viaService = await retrieveFromPort({ tools: () => [], call: async () => ({}), service: () => service }, { provider: 'service' }, { query: '线程', sources: book, course: 'OS', limit: 4 });
  assert.deepEqual(viaService.passages.map(item => item.sourceId), ['bk-p2']);
  assert.equal(await retrieveFromPort({ tools: () => [], call: async () => ({}) }, { provider: 'builtin' }, { query: 'q', sources: book }), null);
  assert.equal(await retrieveFromPort(undefined, { provider: 'service' }, { query: 'q', sources: book }), null);
});
