import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTermWhitelist,
  meaningfulTokens,
  segmentZhText,
} from '../lib/contexts/generation/book/exam-scope-text.js';
import { sliceExamScope } from '../lib/contexts/generation/contracts.js';
import { inventoryMaterial } from '../lib/course-book-inventory.js';

test('Intl.Segmenter(zh) eliminates the seq.length <= 12 blind spot on long Chinese exam phrases', () => {
  const longPhrase = '进程同步与互斥锁条件变量信号量的实现原理';
  assert.ok(longPhrase.length > 12);
  const tokens = meaningfulTokens(longPhrase);
  assert.ok(tokens.includes('进程'), `expected 进程 in ${JSON.stringify(tokens)}`);
  assert.ok(tokens.includes('同步'), `expected 同步 in ${JSON.stringify(tokens)}`);
  assert.ok(tokens.includes('互斥锁') || tokens.includes('互斥'), `expected 互斥/互斥锁 in ${JSON.stringify(tokens)}`);
  assert.ok(tokens.includes('条件'), `expected 条件 in ${JSON.stringify(tokens)}`);
  assert.ok(tokens.includes('变量'), `expected 变量 in ${JSON.stringify(tokens)}`);
  assert.ok(tokens.includes('信号量') || tokens.includes('信号'), `expected 信号/信号量 in ${JSON.stringify(tokens)}`);
  assert.ok(tokens.includes('原理'), `expected 原理 in ${JSON.stringify(tokens)}`);

  const mathPhrase = '多元线性回归模型的最小二乘估计与残差分析';
  const mathTokens = meaningfulTokens(mathPhrase);
  assert.ok(mathTokens.includes('线性'));
  assert.ok(mathTokens.includes('回归'));
  assert.ok(mathTokens.includes('最小'));
  assert.ok(mathTokens.includes('估计'));
  assert.ok(mathTokens.includes('残差'));
});

test('course glossary / notation ledger whitelist prevents proper nouns from being split', () => {
  const whitelist = buildTermWhitelist([
    { canonical: '拉格朗日中值定理', aliases: ['Lagrange Mean Value Theorem'] },
    { canonical: '卡尔曼滤波器', symbol: 'K_k' },
    '银行家算法 (Banker Algorithm)',
  ]);

  const segs = segmentZhText('重点考查拉格朗日中值定理与卡尔曼滤波器在状态估计中的应用', { whitelist });
  assert.ok(segs.includes('拉格朗日中值定理'), `whitelisted term kept intact: ${JSON.stringify(segs)}`);
  assert.ok(segs.includes('卡尔曼滤波器'), `whitelisted term kept intact: ${JSON.stringify(segs)}`);
  assert.ok(segs.includes('状态'));
  assert.ok(segs.includes('估计'));

  const mixed = meaningfulTokens('使用银行家算法避免死锁以及CPU调度与LRU页面置换', { whitelist });
  assert.ok(mixed.includes('银行家算法'));
  assert.ok(mixed.includes('死锁'));
  assert.ok(mixed.includes('cpu'), 'English token preserved');
  assert.ok(mixed.includes('lru'), 'English token preserved');
  assert.ok(mixed.includes('调度'));
  assert.ok(mixed.includes('页面'));
  assert.ok(mixed.includes('置换'));
});

test('sliceExamScope matches long Chinese exam scope topics (>12 chars) using Intl.Segmenter + notationOverrides whitelist', () => {
  const chapters = [
    { title: '第 1 章 课程导论', body: '系统架构与历史演进。' },
    { title: '第 2 章 进程同步、互斥锁、条件变量与信号量', body: '临界区问题、自旋锁、条件变量与信号量机制。' },
    { title: '第 3 章 拉格朗日中值定理与柯西中值定理', body: '微分中值定理与泰勒展开的严格证明。' },
    { title: '第 4 章 文件系统与磁盘调度', body: '索引节点、日志系统与电梯算法。' },
  ];
  const sources = chapters.map((ch, idx) => ({
    id: `zh-p${idx + 1}`,
    title: `中文教材 · 第 ${idx + 1} 页`,
    text: `# ${ch.title}\n\n${ch.body}`,
    createdAt: '2026-10-01T08:00:00.000Z',
    courses: ['CS-ZH'],
    document: {
      materialId: 'document-zhbook',
      page: idx + 1,
      totalPages: chapters.length,
      format: 'pdf',
      origin: 'converted',
      converter: 'marker',
      filename: '中文教材.pdf',
      chapter: { index: idx, title: ch.title, level: 1 },
      extractionVersion: 2,
    },
  }));
  sources.push(inventoryMaterial({
    title: 'Inventory · CS-ZH',
    course: 'CS-ZH',
    language: 'zh',
    ranges: [{ key: 'r3', doc: 'pdf:document-zhbook', print: '0123456789abcdef', status: 'read', chars: 500, from: 3, to: 3 }],
    items: [{
      kind: 'formula',
      name: '拉格朗日中值定理',
      gist: '连续可导函数区间内存在导数等于平均变化率的点',
      places: [{ range: 'r3', doc: 'pdf:document-zhbook', sourceId: 'zh-p3', start: 0, end: 12, page: 3, quote: '微分中值定理', verified: true }],
    }],
    documents: [{ key: 'pdf:document-zhbook', title: '中文教材', pages: 4, ranges: 1, read: 1, pagesRead: 1 }],
    cache: { clusters: [], order: null },
  }));

  const state = {
    courses: [{
      id: 'c-zh',
      name: 'CS-ZH',
      focusTopics: [
        '进程同步互斥锁条件变量信号量',
        '拉格朗日中值定理柯西中值定理',
      ],
      notationOverrides: [{ canonical: '拉格朗日中值定理', aliases: ['中值定理'], meaning: '微分中值核心定理' }],
    }],
    sources,
    decks: [],
    documents: [],
  };

  const res = sliceExamScope(state, 'CS-ZH', { language: 'zh' });
  assert.deepEqual(res.matchedChapters.map(ch => ch.id), ['pdf:document-zhbook#1', 'pdf:document-zhbook#2']);
  assert.deepEqual(res.unmatchedTopics, []);
});
