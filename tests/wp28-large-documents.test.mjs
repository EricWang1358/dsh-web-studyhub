import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { LARGE_DOCUMENT_LIMITS, VERIFIED_AT, TOOLS, bigDocuments, classifyImportFailure, mcpConfigSnippet, selectionChars, selectionTooBig, toolsFor } from '../lib/large-documents.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';

/* WP28: when to recommend a converter or a retrieval tool, and what to recommend. */

const page = (n, chars = 100, extra = {}) => ({ id: `p${n}`, title: `书 · p.${n}`, text: 'x'.repeat(chars), document: { id: 'h', page: n, totalPages: 1000, ...extra } });

test('limits are the ones the importer and generation enforce', () => {
  assert.deepEqual(LARGE_DOCUMENT_LIMITS, { pdfBytes: 8 * 1024 * 1024, pdfPages: 200, selectionChars: 600000, advisePages: 300 });
});

test('an import failure is recognised as "too large" in every wording the importer uses', () => {
  for (const message of ['Document exceeds 8 MB', 'Document must be a file of at most 8 MB', '文件超过 8 MB。请按章节拆分后再导入。', '这个 PDF 读不出来（可能已损坏或超过 8 MB）。请重新导出 PDF 后再试。', '文件不是有效 PDF，或超过 8 MB'])
    assert.equal(classifyImportFailure(message), 'pdf-size', message);
  for (const message of ['PDF 超过 200 页，请先按章节拆分', 'PDF 超过 200 页。请按章节拆分后再导入。', 'PDF exceeds 200 pages'])
    assert.equal(classifyImportFailure(message), 'pdf-pages', message);
  for (const message of ['Extracted text exceeds 600,000 characters', '提取出的文字超过 60 万字。请按章节拆分后再导入。', '所选 PDF 页面的文字超过 600,000 字符，请减少页数'])
    assert.equal(classifyImportFailure(message), 'text-chars', message);
  for (const message of ['Text documents must use UTF-8 encoding', '', undefined, '这个 Word 文件读不出来（可能已损坏）'])
    assert.equal(classifyImportFailure(message), null, String(message));
  assert.equal(classifyImportFailure(new Error('文件超过 8 MB')), 'pdf-size', 'accepts an Error');
  assert.equal(classifyImportFailure('文件超过 40 MB。请压缩图片或拆分后再导入。'), 'office-size');
});

test('a selection is too big above 600,000 characters, whichever pages it holds', () => {
  const sources = [page(1, 400000), page(2, 150000), page(3, 100000)];
  assert.equal(selectionChars(sources, ['p1', 'p2']), 550000);
  assert.equal(selectionTooBig(sources, ['p1', 'p2']), null);
  assert.deepEqual(selectionTooBig(sources, ['p1', 'p2', 'p3']), { chars: 650000, limit: 600000 });
  assert.equal(selectionTooBig(sources, []), null);
  // Snapshot sources may carry `chars` instead of `text`.
  assert.equal(selectionChars([{ id: 'a', chars: 700000 }], ['a']), 700000);
});

test('documents of more than 300 pages are the ones to advise on', () => {
  const sources = [...Array.from({ length: 320 }, (_, i) => page(i + 1, 10, { totalPages: 320 })), { id: 'note', title: '笔记', text: 'n' },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, title: `slides · p.${i + 1}`, text: 's', document: { id: 'other', page: i + 1, totalPages: 40 } }))];
  const items = groupSourcesByDocument(sources);
  const big = bigDocuments(items);
  assert.equal(big.length, 1);
  assert.equal(big[0].pages.length, 320);
  assert.equal(bigDocuments(items, { pages: 500 }).length, 0);
  // A document with only some pages imported still counts by its length.
  assert.equal(bigDocuments(groupSourcesByDocument([page(1, 10, { totalPages: 900 }), page(2, 10, { totalPages: 900 })])).length, 1);
});

test('the catalogue states what is true and checkable: licence, platforms, download channels, verification date', () => {
  assert.match(VERIFIED_AT, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(toolsFor('converter').length >= 2 && toolsFor('retrieval').length >= 2);
  for (const tool of TOOLS) {
    assert.ok(tool.id && tool.name && tool.license && tool.platforms.length, tool.id);
    assert.ok(tool.channels.length >= 2, `${tool.id} has more than one download channel`);
    for (const channel of tool.channels) { assert.match(channel.url, /^https:\/\/[^\s]+$/); assert.ok(['official', 'mainland', 'source', 'package'].includes(channel.kind), channel.kind); }
    assert.ok(tool.channels.some(channel => channel.kind === 'official' || channel.kind === 'source'), `${tool.id} has an official channel`);
    assert.ok(!('installed' in tool) && !('detected' in tool), 'the catalogue never claims a tool is installed');
  }
  for (const tool of TOOLS.filter(entry => entry.recommended))
    assert.ok(tool.channels.some(channel => channel.kind === 'mainland'), `${tool.id} is reachable from mainland China`);
  const recommended = role => TOOLS.filter(tool => tool.role === role && tool.recommended).map(tool => tool.id);
  // Local MinerU models lead; cloud and the desktop export route remain optional.
  assert.deepEqual(recommended('converter'), ['mineru-local', 'docling']);
  assert.equal(TOOLS.find(tool => tool.id === 'mineru').recommended, false);
  assert.deepEqual(recommended('retrieval'), ['mcp-local-rag', 'ragflow']);
  assert.equal(TOOLS.find(tool => tool.id === 'mineru').studyhubFormat, 'mineru-content-list');
  assert.equal(TOOLS.find(tool => tool.id === 'mineru-cloud').studyhubFormat, 'mineru-content-list');
  assert.equal(TOOLS.find(tool => tool.id === 'docling').studyhubFormat, 'docling-json');
});

test('the MCP configuration for DSH is valid YAML in the shape DSH reads, and never carries a secret', () => {
  const local = YAML.parse(mcpConfigSnippet('mcp-local-rag', { directory: 'C:/Books/converted' }));
  assert.equal(local[0].insert[0].name, '@deepseek-ai/dsh-mcp-client');
  assert.equal(local[0].insert[0].config.transport, 'stdio');
  assert.equal(local[0].insert[0].config.command, 'npx');
  assert.deepEqual(local[0].insert[0].config.args, ['-y', 'mcp-local-rag']);
  assert.equal(local[0].insert[0].config.env.BASE_DIR, 'C:/Books/converted');
  assert.match(local[0].insert[0].config.serverName, /^[A-Za-z0-9_-]{1,32}$/);
  const ragflow = YAML.parse(mcpConfigSnippet('ragflow'));
  assert.equal(ragflow[0].insert[0].config.transport, 'streamable-http');
  assert.equal(ragflow[0].insert[0].config.url, 'http://127.0.0.1:9380/api/v1/mcp');
  assert.equal(ragflow[0].insert[0].config.headers, undefined, 'the key stays on the RAGFlow side');
  assert.doesNotMatch(mcpConfigSnippet('mcp-local-rag'), /KEY|TOKEN|SECRET|PASSWORD/i);
  assert.throws(() => mcpConfigSnippet('mineru'), /no MCP/i);
  // A path with YAML-special characters stays one string.
  assert.equal(YAML.parse(mcpConfigSnippet('mcp-local-rag', { directory: 'C:/a: b #c/books' }))[0].insert[0].config.env.BASE_DIR, 'C:/a: b #c/books');
});
