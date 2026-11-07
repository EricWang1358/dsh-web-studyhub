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
import { authorPrompts, reviewPrompts, prioritizePlannedTargets, finalizePlannedTargets } from '../lib/generation.js';
import { GENERATION_FOCUS_PRIORITY, prioritizeFocusTopics } from '../lib/focus-progress.js';
import { escalateFocusDifficulty } from '../lib/focus-points.js';
import { coveragePlan } from '../lib/coverage-plan.js';
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


test('focus × mastery prioritization orders empty and weak focus topics first, keeps mastered topics at natural weight/difficulty, and never leaks focusStatus to prompts or disk', async (t) => {
  assert.deepEqual(GENERATION_FOCUS_PRIORITY, { none: 0, weak: 1, todo: 2, active: 2, done: 3 });
  assert.equal(escalateFocusDifficulty('foundation', { status: 'none' }), 'application');
  assert.equal(escalateFocusDifficulty('mixed', { status: 'weak' }), 'advanced');
  assert.equal(escalateFocusDifficulty('foundation', { status: 'done' }), 'foundation');
  assert.equal(escalateFocusDifficulty('mixed', { status: 'done' }), 'application');

  const workspace = await mkdtemp(join(tmpdir(), 'study-focus-mastery-gen-'));
  const log = [];
  const fake = createFakeModel({ log });
  const service = new StudyService(workspace, { complete: fake, light: fake });
  t.after(async () => {
    await service.dispose();
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await service.call('course.save', { name: 'OS', focusTopics: ['TCP', '信号量', '死锁', '页面置换', 'TLB'] });

  await service.store.update((own) => {
    own.decks.push({
      id: 'd-os-seed',
      title: 'OS Seed',
      course: 'OS',
      cards: [
        {
          id: 'tcp-1',
          kind: 'flashcard',
          topic: 'TCP 拥塞窗口',
          objective: 'Explain TCP congestion window',
          prompt: 'What is cwnd?',
          answer: 'Congestion window',
          review: { repetitions: 3, interval_days: 30, ease_factor: 2.5, due_at: '2099-01-01T00:00:00Z' },
        },
        {
          id: 'dead-1',
          kind: 'flashcard',
          topic: '死锁必要条件',
          objective: 'List Coffman conditions',
          prompt: 'Four conditions?',
          answer: 'Mutual exclusion, hold and wait, no preemption, circular wait',
          review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null },
        },
        {
          id: 'sem-1',
          kind: 'flashcard',
          topic: '信号量 PV 操作',
          objective: 'Understand P/V',
          prompt: 'What does P do?',
          answer: 'Decrements semaphore',
          review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null },
        },
      ],
    });
    own.attempts.push(
      { deckId: 'd-os-seed', quiz_id: 'tcp-1', grade: 5, timestamp: '2026-10-04T08:00:00Z' },
      { deckId: 'd-os-seed', quiz_id: 'dead-1', grade: 1, timestamp: '2026-10-04T08:00:00Z' },
    );
  });

  const seeded = await service.call('export');
  const ordered = prioritizeFocusTopics(seeded, 'OS', ['TCP', '信号量', '死锁', '页面置换', 'TLB']);
  assert.deepEqual(ordered.topics, ['页面置换', 'TLB', '死锁', '信号量', 'TCP']);
  assert.deepEqual(ordered.statusByTopic, {
    TCP: 'done',
    信号量: 'todo',
    死锁: 'weak',
    页面置换: 'none',
    TLB: 'none',
  });

  const sDone = 'TCP 协议拥塞窗口控制。'.repeat(60);
  const sWeak = '死锁处理预防与银行家算法。'.repeat(60);
  const sNone = '页面置换算法 LRU 与工作集。'.repeat(60);
  const weightSources = [{ id: 'doc1', title: 'OS Notes', text: `${sDone}\n\n${sWeak}\n\n${sNone}` }];
  const sections = [
    { id: 's-done', key: 'doc1#s-done', sourceId: 'doc1', title: 'TCP 协议', start: 0, end: sDone.length, chars: sDone.length, length: sDone.length },
    { id: 's-weak', key: 'doc1#s-weak', sourceId: 'doc1', title: '死锁处理', start: sDone.length + 2, end: sDone.length + 2 + sWeak.length, chars: sWeak.length, length: sWeak.length },
    { id: 's-none', key: 'doc1#s-none', sourceId: 'doc1', title: '页面置换算法', start: sDone.length + sWeak.length + 4, end: weightSources[0].text.length, chars: sNone.length, length: sNone.length },
  ];
  const weighed = lengthWeights(sections, { focusTopics: ordered.topics, focusStatus: ordered.statusByTopic, sources: weightSources });
  const byId = Object.fromEntries(weighed.map((s) => [s.sectionId, s]));
  assert.equal(byId['doc1#s-none'].importance, 5);
  assert.equal(byId['doc1#s-weak'].importance, 5);
  assert.equal(byId['doc1#s-done'].importance, 3, 'mastered focus topic keeps natural importance instead of forced 5');
  const { rounds } = coveragePlan({ leaves: sections, weights: weighed, level: 'full', goalCount: 3, limit: 1 });
  assert.deepEqual(rounds.map((r) => r.assignments[0].key), ['doc1#s-none', 'doc1#s-weak', 'doc1#s-done'], 'empty focus section comes ahead of weak, and weak ahead of mastered');

  const planned = prioritizePlannedTargets([
    { targetId: 't-plain', topic: '进程状态', conceptKey: 'proc-state', focus: false },
    { targetId: 't-done', topic: 'TCP', conceptKey: 'tcp', focusStatus: 'done' },
    { targetId: 't-weak', topic: '死锁', conceptKey: 'deadlock', focus: true, focusStatus: 'weak' },
    { targetId: 't-none', topic: '页面置换', conceptKey: 'paging', focus: true, focusStatus: 'none' },
  ]);
  assert.deepEqual(planned.map((t) => t.targetId), ['t-none', 't-weak', 't-plain', 't-done']);
  const finalized = finalizePlannedTargets(planned);
  assert.equal(finalized.targets.some((t) => 'focusStatus' in t), false, 'transient focusStatus is stripped before Stage 2-4 prompts');
  assert.equal(finalized.statusByTargetId.get('t-done'), 'done');

  const docPage = await service.call('source.add', {
    title: 'OS 讲义',
    courses: ['OS'],
    text: [
      '# 页面置换算法\nLRU 与时钟页面置换用于缺页中断处理。',
      '# 死锁条件\n互斥、占有并等待、不可抢占、循环等待是死锁四个必要条件。',
      '# TCP 拥塞窗口\n慢启动和拥塞避免共同调节发送窗口。',
    ].join('\n\n'),
  });

  const unprioritized = await service.call('generate', {
    sourceIds: [docPage.id],
    course: 'OS',
    kind: 'flashcard',
    difficulty: 'foundation',
    count: 2,
    prioritizeFocus: false,
  });
  await settleJob(service, unprioritized.jobId);
  const rawDraft = (await service.call('export')).drafts.at(-1);
  assert.deepEqual(rawDraft.editorial.generation.focusTopics, ['TCP', '信号量', '死锁', '页面置换', 'TLB']);

  const run = await service.call('generate', {
    sourceIds: [docPage.id],
    course: 'OS',
    kind: 'flashcard',
    difficulty: 'foundation',
    count: 2,
  });
  await settleJob(service, run.jobId);
  const after = await service.call('export');
  const draft = after.drafts.at(-1);
  assert.deepEqual(draft.editorial.generation.focusTopics, ['页面置换', 'TLB', '死锁', '信号量', 'TCP']);
  assert.equal('focusStatus' in draft.editorial.generation, false, 'focusStatus is never persisted to editorial.generation');
  for (const call of log) {
    assert.equal(JSON.stringify(call).includes('focusStatus'), false, 'focusStatus never leaks into model prompts');
  }
});
