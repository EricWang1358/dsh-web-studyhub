import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocumentTree,
  createTreeRetriever,
  scoreTreeNodes,
  treeRetrieve,
  treeRetrieveWithTrace,
} from '../lib/contexts/generation/retrieval/tree-retrieve.js';
import { normalizeHits, resolveHits, retrieveFromPort } from '../lib/retrieval.js';

function makeBookState() {
  const sources = [
    {
      id: 'p1',
      title: '操作系统教材 · 第 1 页',
      text: '# 第 1 章 进程与线程\n\n进程控制块 PCB 与上下文切换基础。',
      courses: ['OS'],
      document: { materialId: 'doc-os', page: 1, totalPages: 6, format: 'pdf', origin: 'converted', converter: 'marker', filename: '操作系统教材.pdf', extractionVersion: 2 },
    },
    {
      id: 'p2',
      title: '操作系统教材 · 第 2 页',
      text: '## 1.2 用户级线程与内核级线程\n\n一对一与多对多映射模型对比。',
      courses: ['OS'],
      document: { materialId: 'doc-os', page: 2, totalPages: 6, format: 'pdf', origin: 'converted', converter: 'marker', filename: '操作系统教材.pdf', extractionVersion: 2 },
    },
    {
      id: 'p3',
      title: '操作系统教材 · 第 3 页',
      text: '# 第 2 章 死锁与避免\n\n死锁四个必要条件：互斥、占有并等待、不可抢占、循环等待。',
      courses: ['OS'],
      document: { materialId: 'doc-os', page: 3, totalPages: 6, format: 'pdf', origin: 'converted', converter: 'marker', filename: '操作系统教材.pdf', extractionVersion: 2 },
    },
    {
      id: 'p4',
      title: '操作系统教材 · 第 4 页',
      text: '## 2.2 银行家算法安全性检查\n\n通过 Need 矩阵与 Work 向量寻找安全序列以实现死锁避免。',
      courses: ['OS'],
      document: { materialId: 'doc-os', page: 4, totalPages: 6, format: 'pdf', origin: 'converted', converter: 'marker', filename: '操作系统教材.pdf', extractionVersion: 2 },
    },
    {
      id: 'p5',
      title: '操作系统教材 · 第 5 页',
      text: '# 第 3 章 虚拟内存\n\n按需调页、缺页中断处理与工作集模型。',
      courses: ['OS'],
      document: { materialId: 'doc-os', page: 5, totalPages: 6, format: 'pdf', origin: 'converted', converter: 'marker', filename: '操作系统教材.pdf', extractionVersion: 2 },
    },
    {
      id: 'p6',
      title: '操作系统教材 · 第 6 页',
      text: '## 3.2 页面置换算法\n\nLRU 最近最少使用、Clock 时钟算法与 Belady 异常。',
      courses: ['OS'],
      document: { materialId: 'doc-os', page: 6, totalPages: 6, format: 'pdf', origin: 'converted', converter: 'marker', filename: '操作系统教材.pdf', extractionVersion: 2 },
    },
  ];
  const documents = [{
    id: 'doc-os',
    currentRevision: 'rev1',
    versions: [{
      revision: 'rev1',
      sourceIds: sources.map(s => s.id),
      outline: {
        revision: 'rev1',
        entries: [
          { title: '第 1 章 进程与线程', level: 1, anchor: { sourceId: 'p1', offset: 0 } },
          { title: '1.2 用户级线程与内核级线程', level: 2, anchor: { sourceId: 'p2', offset: 0 } },
          { title: '第 2 章 死锁与避免', level: 1, anchor: { sourceId: 'p3', offset: 0 } },
          { title: '2.2 银行家算法安全性检查', level: 2, anchor: { sourceId: 'p4', offset: 0 } },
          { title: '第 3 章 虚拟内存', level: 1, anchor: { sourceId: 'p5', offset: 0 } },
          { title: '3.2 页面置换算法', level: 2, anchor: { sourceId: 'p6', offset: 0 } },
        ],
      },
    }],
  }];
  const courses = [{
    id: 'c-os',
    name: 'OS',
    notationOverrides: [{ canonical: '银行家算法', aliases: ['Banker Algorithm'], meaning: '死锁避免安全性检测算法' }],
  }];
  return { sources, documents, courses };
}

test('buildDocumentTree builds nested chapter hierarchy from StudyHub kept document outline', () => {
  const state = makeBookState();
  const tree = buildDocumentTree({ state, course: 'OS' });
  assert.equal(tree.roots.length, 3);
  assert.equal(tree.roots[1].title, '第 2 章 死锁与避免');
  assert.equal(tree.roots[1].startPage, 3);
  assert.equal(tree.roots[1].endPage, 4);
  assert.equal(tree.roots[1].children.length, 1);
  assert.equal(tree.roots[1].children[0].title, '2.2 银行家算法安全性检查');
  assert.deepEqual(tree.roots[1].children[0].sourceIds, ['p4']);
});

test('deterministic PageIndex treeRetrieve returns standard retrieve() contract compatible with lib/retrieval.js', async () => {
  const state = makeBookState();
  const hits = await treeRetrieve({
    state,
    course: 'OS',
    query: '银行家算法安全性检查与死锁避免的判定条件',
    limit: 3,
  });

  assert.ok(hits.length >= 1 && hits.length <= 3);
  assert.equal(hits[0].sourceId, 'p4', 'ranks exact subsection page p4 first');
  assert.equal(hits[0].page, 4);
  assert.equal(typeof hits[0].document, 'string');
  assert.ok(hits[0].text.includes('银行家算法'));
  assert.ok(hits[0].score > 0 && hits[0].score <= 1);

  // Must pass lib/retrieval.js normalizeHits and resolveHits seamlessly
  const normalized = normalizeHits(hits);
  assert.equal(normalized.length, hits.length);
  const resolved = resolveHits(normalized, state.sources);
  assert.equal(resolved.unresolved, 0);
  assert.equal(resolved.passages[0].sourceId, 'p4');
  assert.equal(resolved.passages[0].matchedBy, 'id');
});

test('optional light model selects exact tree nodes & tight page ranges without receiving full text, and falls back safely on error', async () => {
  const state = makeBookState();
  const tree = buildDocumentTree({ state, course: 'OS' });
  const scored = scoreTreeNodes(tree, '页面置换 Belady 异常');
  assert.ok(scored.length > 0);
  const targetNodeId = tree.roots[2].children[0].nodeId; // 3.2 页面置换算法 (p6)

  const seenPrompts = [];
  const fakeLight = async (_sys, prompt) => {
    seenPrompts.push(prompt);
    return JSON.stringify({
      nodeIds: [targetNodeId, 'nonexistent-hallucinated-node'],
      pageRanges: [{ nodeId: targetNodeId, startPage: 6, endPage: 99 }],
      reason: 'Section 3.2 directly covers page replacement and Belady anomaly.',
    });
  };

  const trace = await treeRetrieveWithTrace({
    state,
    course: 'OS',
    query: 'Belady 异常是如何发生的',
    completeLight: fakeLight,
    limit: 4,
  });

  assert.equal(trace.usedModel, true);
  assert.equal(seenPrompts.length, 1);
  // Compact tree prompt contains chapter titles, NOT full body prose like "通过 Need 矩阵与 Work 向量"
  assert.ok(seenPrompts[0].includes('3.2 页面置换算法'));
  assert.ok(!seenPrompts[0].includes('通过 Need 矩阵与 Work 向量'), 'never dumps full page body into tree router prompt');
  assert.equal(trace.selectedNodes.length, 1, 'drops hallucinated node id');
  assert.equal(trace.selectedNodes[0].endPage, 6, 'clamps out-of-bounds page range to node endPage');
  assert.equal(trace.hits[0].sourceId, 'p6');

  // Graceful fallback when model fails or returns garbage
  const fallback = await treeRetrieveWithTrace({
    state,
    course: 'OS',
    query: '页面置换算法 LRU',
    completeLight: async () => { throw new Error('model offline'); },
    limit: 3,
  });
  assert.equal(fallback.usedModel, false);
  assert.equal(fallback.hits[0].sourceId, 'p6');
});

test('createTreeRetriever works as a drop-in studyRetrieval service provider for retrieveFromPort', async () => {
  const state = makeBookState();
  const service = createTreeRetriever(() => state);
  const port = { tools: () => [], service: () => service, call: async () => { throw new Error('unused'); } };
  const result = await retrieveFromPort(port, { provider: 'service' }, {
    query: '用户级线程与内核级线程',
    sources: state.sources,
    course: 'OS',
    limit: 2,
  });

  assert.ok(result);
  assert.equal(result.provider, 'service');
  assert.equal(result.unresolved, 0);
  assert.equal(result.passages[0].sourceId, 'p2');
});
