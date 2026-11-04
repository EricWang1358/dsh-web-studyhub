import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { stageFocusImages } from '../lib/focus-image-stage.js';
import { lengthWeights, sectionWeights } from '../lib/section-weights.js';
import { planPrompts, blueprintPrompts } from '../lib/assessment-quality.js';
import { authorPrompts, reviewPrompts } from '../lib/generation.js';
import { settleJob } from './helpers/wait.mjs';

// 1x1 valid PNG (68 bytes)
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('stageFocusImages validates raster magic bytes, rejects spoofed formats, and writes relative workspace paths', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'study-focus-stage-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const staged = await stageFocusImages(workspace, {
    files: [
      { name: '老师划重点 截图(1).png', dataUrl: TINY_PNG_DATA_URL },
      { name: '../../escape.png', dataUrl: TINY_PNG_DATA_URL },
    ],
  });
  assert.equal(staged.files.length, 2);
  assert.match(staged.folder, /^studyhub-work\/focus-intake\//);
  for (const item of staged.files) {
    assert.ok(item.relativePath.startsWith(`${staged.folder}/`), item.relativePath);
    assert.equal(item.relativePath.includes('..'), false);
    assert.equal(item.mimeType, 'image/png');
    const diskBytes = await readFile(join(workspace, item.relativePath));
    assert.equal(diskBytes.length, item.bytes);
  }

  // Spoofed MIME header (PNG bytes declared as image/jpeg) must be rejected
  const spoofedJpeg = TINY_PNG_DATA_URL.replace('data:image/png;', 'data:image/jpeg;');
  await assert.rejects(
    stageFocusImages(workspace, { files: [{ name: 'spoof.jpg', dataUrl: spoofedJpeg }] }),
    /不匹配/,
  );

  // SVG / non-raster must be rejected
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from('<svg></svg>').toString('base64')}`;
  await assert.rejects(
    stageFocusImages(workspace, { files: [{ name: 'vector.svg', dataUrl: svgDataUrl }] }),
    /PNG、JPG/,
  );
});

test('focus.extract extracts focus topics via light model and falls back cleanly to local parser without model', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-focus-extract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const darkService = new StudyService(root, {});
  t.after(() => darkService.dispose());

  const localOnly = await darkService.call('focus.extract', {
    course: '操作系统',
    text: '期末重点：\n1. 页面置换（LRU、Clock）\n2. 死锁四个必要条件与银行家算法',
  });
  assert.equal(localOnly.source, 'local');
  assert.equal(localOnly.unavailable?.reason, 'no-model');
  assert.deepEqual(localOnly.topics, ['页面置换（LRU、Clock）', '死锁四个必要条件与银行家算法']);

  const modelService = new StudyService(root, { complete: createFakeModel(), light: createFakeModel() });
  t.after(() => modelService.dispose());
  const mat = await modelService.call('source.add', {
    title: '第 4 章 虚拟内存重点',
    text: 'TCP 拥塞控制与慢启动阈值\n页面置换 LRU 与 Belady 异常\n死锁预防与银行家算法安全性检查',
    courses: ['操作系统'],
  });
  const extracted = await modelService.call('focus.extract', {
    course: '操作系统',
    sourceIds: [mat.id],
    text: '老师补充必考：段页式地址变换',
  });
  assert.equal(extracted.source, 'model');
  assert.ok(extracted.topics.some((topic) => topic.includes('段页式地址变换')));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
});

test('sectionWeights and lengthWeights boost sections matching focusTopics to importance 5', async () => {
  const sources = [
    {
      id: 'os-notes',
      title: 'Operating Systems Notes',
      text: 'Chapter 1 Course Logistics and Grading Policy. Office hours are Tuesday.\n\nChapter 2 Virtual Memory and LRU Page Replacement. LRU evicts the least recently used frame and avoids Belady anomaly.',
    },
  ];
  const sections = [
    { id: 'sec-1', sourceId: 'os-notes', title: 'Chapter 1 Course Logistics', start: 0, end: 72 },
    { id: 'sec-2', sourceId: 'os-notes', title: 'Chapter 2 Virtual Memory', start: 74, end: sources[0].text.length },
  ];

  const byLength = lengthWeights(sections, { focusTopics: ['LRU'], sources });
  assert.equal(byLength[0].importance, 3);
  assert.equal(byLength[1].importance, 5);

  // Even if the light model rates both sections importance 2, the focus section is floored at 5.
  const weighed = await sectionWeights({
    sections,
    sources,
    focusTopics: ['LRU'],
    light: async () => JSON.stringify({
      sections: [
        { id: 's1', importance: 2, kind: 'chatter', reason: 'logistics' },
        { id: 's2', importance: 2, kind: 'method', reason: 'ordinary' },
      ],
    }),
  });
  assert.equal(weighed.weights[0].importance, 2);
  assert.equal(weighed.weights[1].importance, 5);
});

test('Stages 1-4 escalate cognitive depth for focusTopics and stamp cards with focus: true and escalated difficulty', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-focus-gen-'));
  const log = [];
  const fake = createFakeModel({ log });
  const service = new StudyService(root, { complete: fake, light: fake });
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await service.call('course.save', {
    name: '计算机网络',
    focusTopics: ['TCP 拥塞控制', '慢启动'],
  });
  const focusSource = await service.call('source.add', {
    title: '运输层拥塞控制讲义',
    courses: ['计算机网络'],
    text: [
      'TCP 拥塞控制通过拥塞窗口 cwnd 动态调节发送速率，慢启动阶段每经过一个 RTT 就使拥塞窗口翻倍增长。',
      '当 cwnd 达到慢启动阈值 ssthresh 时，TCP 从慢启动切换为拥塞避免阶段，防止网络队列瞬间过载。',
      '收到三个重复确认（3-ACK）时，快重传与快恢复会将 ssthresh 设为当前 cwnd 的一半并跳过慢启动清零。',
    ].join('\n\n'),
  });
  const generalSource = await service.call('source.add', {
    title: '物理层编码简介',
    courses: ['计算机网络'],
    text: '曼彻斯特编码在每个比特周期中心都有一次电平跳变，用于接收端提取同步时钟信号并区分高低电平比特。',
  });

  // Verify pure prompt builders carry focusTopics and cognitive escalation only when focusTopics is present
  const plainPlan = planPrompts({ sources: [focusSource], count: 2, kind: 'quiz', difficulty: 'foundation' });
  assert.equal(plainPlan.prompt.includes('focusTopics'), false);
  const focusPlan = planPrompts({ sources: [focusSource], count: 2, kind: 'quiz', difficulty: 'foundation', focusTopics: ['TCP 拥塞控制'] });
  assert.ok(focusPlan.prompt.includes('"focusTopics":["TCP 拥塞控制"]'));
  const focusBlueprint = blueprintPrompts(
    { sources: [focusSource], count: 1, kind: 'quiz', difficulty: 'foundation', focusTopics: ['TCP 拥塞控制'] },
    { targets: [{ targetId: 'target-1', objective: 'TCP 拥塞控制', knowledge: 'cwnd', focus: true, citations: [{ sourceId: focusSource.id, quote: 'TCP 拥塞控制通过拥塞窗口 cwnd 动态调节发送速率' }] }] },
  );
  assert.ok(focusBlueprint.prompt.includes('escalate cognitive depth to "application"'));
  const focusAuthor = authorPrompts(
    { sources: [focusSource], count: 1, kind: 'quiz', difficulty: 'mixed', focusTopics: ['TCP 拥塞控制'] },
    { targets: [{ targetId: 'target-1', objective: 'TCP 拥塞控制', knowledge: 'cwnd', focus: true, citations: [{ sourceId: focusSource.id, quote: 'TCP 拥塞控制通过拥塞窗口 cwnd 动态调节发送速率' }] }] },
    { items: [{ targetId: 'target-1', answer: 'A', reasoning: 'R', comparisonAxis: 'C', scenario: { kind: 'none', facts: [], decisiveConditions: [] } }] },
  );
  assert.ok(focusAuthor.prompt.includes('"advanced" cognitive depth'));
  const focusReview = reviewPrompts({
    sources: [focusSource],
    deck: { title: 'D', cards: [{ id: 'q1', kind: 'flashcard', focus: true }] },
    kind: 'flashcard',
    count: 1,
    structuralErrors: [],
    difficulty: 'mixed',
    focusTopics: ['TCP 拥塞控制'],
  });
  assert.ok(focusReview.payload.includes('course exam focus highlights'));

  // Run 1: difficulty = 'foundation' -> focus cards escalate to 'application', non-focus cards have no focus flag
  const run1 = await service.call('generate', {
    sourceIds: [focusSource.id, generalSource.id],
    course: '计算机网络',
    kind: 'quiz',
    difficulty: 'foundation',
    count: 2,
  });
  await settleJob(service, run1.jobId);
  const state1 = await service.call('export');
  const snap1 = await service.call('snapshot');
  const draft1 = state1.drafts.find((d) => d.id === snap1.drafts[0].id) || state1.drafts[0];
  assert.deepEqual(draft1.editorial.generation.focusTopics, ['TCP 拥塞控制', '慢启动']);
  const focusCards1 = draft1.cards.filter((c) => c.focus === true);
  assert.ok(focusCards1.length >= 1, 'at least one focus card was stamped');
  for (const card of focusCards1) {
    assert.equal(card.difficulty, 'application');
  }

  // Run 2: difficulty = 'mixed' -> focus cards escalate to 'advanced' and publish cleanly into bank
  const run2 = await service.call('generate', {
    sourceIds: [focusSource.id],
    course: '计算机网络',
    kind: 'flashcard',
    difficulty: 'mixed',
    count: 2,
  });
  await settleJob(service, run2.jobId);
  const state2 = await service.call('export');
  const draft2 = state2.drafts.at(-1);
  assert.ok(draft2.cards.length >= 1);
  for (const card of draft2.cards) {
    assert.equal(card.focus, true);
    assert.equal(card.difficulty, 'advanced');
  }
  const published = await service.call('draft.publish.quick', { id: draft2.id, draftVersion: draft2.draftVersion });
  const deck = (await service.call('export')).decks.find((item) => item.id === published.deckId);
  assert.equal(deck.cards[0].focus, true);
  assert.equal(deck.cards[0].difficulty, 'advanced');
});
