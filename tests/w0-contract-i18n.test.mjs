import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { loadUi } from './helpers/ui-module.mjs';

const h = React.createElement;
const han = /[\u3400-\u9fff]/;
const noop = () => {};

const m = await loadUi(`
  export { setUiLanguage, ui, errorMessage } from './ui/i18n.js';
  export { deferUnstudiedPagesPlan, runDeferUnstudiedPages } from './ui/document-preview/practice/open-reader-pages.js';
  export { default as TranslationBlock } from './ui/document-preview/translation/TranslationBlock.jsx';
  export { TranslationMenu, TranslationDialog } from './ui/document-preview/translation/TranslationMenu.jsx';
  export { canRetryError, reconcileSelectionKeys, resolveRetryEntry } from './ui/document-preview/translation/model.js';
  export { default as LearningActions } from './ui/review/LearningActions.jsx';
  export { default as TeachingStatus } from './ui/review/TeachingStatus.jsx';
  export { default as RetellPanel } from './ui/review/RetellPanel.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
`);

const withServices = (node, services = {}) => h(m.StudyServicesContext.Provider, {
  value: {
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
    ...services,
  },
}, node);

function pdfPage(page, hash = 'd'.repeat(64)) {
  return {
    id: `doc-p${page}`,
    title: `教材.pdf · 第 ${page} 页`,
    text: `第 ${page} 页正文：概念_${page} 与公式_${page}。`,
    courses: ['CS'],
    document: { id: hash, materialId: `document-${hash}-pdf`, format: 'pdf', page, totalPages: 120, filename: '教材.pdf' },
  };
}

function quizCard(id, page, topic) {
  return {
    id,
    kind: 'quiz',
    topic,
    objective: `理解 ${topic}`,
    prompt: `关于第 ${page} 页 ${topic}，哪项正确？`,
    options: [
      { id: 'a', text: '正确选项', correct: true, explanation: '正确。' },
      { id: 'b', text: '错误选项', correct: false, explanation: '错误。' },
    ],
    answer: '正确选项',
    hint: '提示',
    explanation: '解析',
    misconception: '误区',
    citations: [{ sourceId: `doc-p${page}`, quote: `概念_${page}` }],
  };
}

async function createPagedService(t, cards) {
  const root = await mkdtemp(join(tmpdir(), 'study-w0-defer-'));
  const service = new StudyService(root);
  t.after(async () => {
    service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await service.store.update((s) => {
    const pages = [...new Set(cards.map((c) => c.page))];
    for (const p of pages) s.sources.push(pdfPage(p));
    s.decks.push({
      id: 'd-os',
      title: '操作系统',
      course: 'CS',
      publishedAt: '2026-11-10T10:00:00Z',
      cards: cards.map((c) => quizCard(c.id, c.page, c.topic)),
    });
    s.focus = { mode: 'class', course: 'CS' };
  });
  return service;
}

/* ---------- W0-5: defer unstudied pages contract & rollback ---------- */

test('W0-5: runDeferUnstudiedPages sends remove:[{deckId,cardId}] to review.queue.edit and rolls back to earlier skipped unanswered cards', async (t) => {
  const service = await createPagedService(t, [
    { id: 'q1', page: 1, topic: '第一章' },
    { id: 'q2', page: 2, topic: '第二章' },
    { id: 'q94', page: 94, topic: '第九章' },
    { id: 'q95', page: 95, topic: '第十章' },
  ]);
  let run = await service.call('review.start', { mode: 'path', course: 'CS', daily: true, fresh: true });
  assert.deepEqual(run.navigation.map((n) => n.cardId), ['q1', 'q2', 'q94', 'q95']);

  // Skip q1 (leave unanswered at index 0), move to q2, answer q2, move to q94 (index 2).
  run = await service.call('review.move', { runId: run.id, index: 1 });
  run = await service.call('review.answer', { runId: run.id, cardId: 'q2', selected: ['a'] });
  run = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(run.card.id, 'q94');
  assert.equal(run.index, 2);

  const notices = [];
  let editedRun = null;
  const reviewAct = async (action, args) => {
    editedRun = await service.call(action, {
      runId: run.id,
      cardId: run.card?.id,
      queueVersion: run.queueVersion || 0,
      ...args,
    });
    return editedRun;
  };

  await m.runDeferUnstudiedPages({
    run,
    sources: (await service.call('snapshot')).sources,
    openModal: noop,
    reviewAct,
    notify: (msg) => notices.push(msg),
  });

  assert.ok(editedRun, 'review.queue.edit succeeded without parameter error');
  assert.equal(editedRun.removed.length, 2, 'removed q94 and q95');
  assert.deepEqual(editedRun.navigation.map((n) => n.cardId), ['q1', 'q2']);
  assert.equal(editedRun.complete, false, 'round does not prematurely complete while earlier skipped q1 is unanswered');
  assert.equal(editedRun.closed, false, 'round is not closed');
  assert.equal(editedRun.index, 0, 'index rolls back to the first earlier skipped unanswered question');
  assert.equal(editedRun.card.id, 'q1');
  assert.match(notices[0] || '', /移出第 94 页及之后的 2 道未答题/);
});

test('W0-5: deferUnstudiedPagesPlan excludes retry entries and outputs remove refs', () => {
  const plan = m.deferUnstudiedPagesPlan({
    id: 'r1',
    mode: 'path',
    deckId: 'd1',
    index: 1,
    complete: false,
    cardSource: { page: 50, documentKey: 'pdf:abc' },
    navigation: [
      { index: 0, deckId: 'd1', cardId: 'c1', answered: true, page: 1, documentKey: 'pdf:abc' },
      { index: 1, deckId: 'd1', cardId: 'c50', answered: false, page: 50, documentKey: 'pdf:abc' },
      { index: 2, deckId: 'd1', cardId: 'c1', answered: false, retry: true, page: 50, documentKey: 'pdf:abc' },
      { index: 3, deckId: 'd1', cardId: 'c51', answered: false, page: 51, documentKey: 'pdf:abc' },
    ],
  });
  assert.equal(plan.kind, 'remove');
  assert.deepEqual(plan.remove, [
    { deckId: 'd1', cardId: 'c50' },
    { deckId: 'd1', cardId: 'c51' },
  ]);
  assert.equal(plan.removedCount, 2);
});

/* ---------- W0-3: teaching/retell Chinese source errors, English localization & non-retryable UI ---------- */

test('W0-3: teaching and calculation-teaching errors use Chinese source copy and localize cleanly to English', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-w0-teach-'));
  const service = new StudyService(root, { complete: async () => '{}' });
  t.after(async () => {
    service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await service.store.update((s) => {
    s.sources.push({ id: 'src-1', title: 'Physics', text: 'F = ma is Newton second law.' });
    s.decks.push({
      id: 'd1',
      title: 'Mixed',
      cards: [
        { id: 'no-cite', kind: 'flashcard', prompt: 'Handwritten Q?', answer: 'A', citations: [] },
        { id: 'with-cite', kind: 'flashcard', prompt: 'Cited Q?', answer: 'A', citations: [{ sourceId: 'src-1', quote: 'F = ma' }] },
      ],
    });
  });

  const run1 = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd1', cardId: 'no-cite' }] });
  await service.call('review.reveal', { runId: run1.id, cardId: 'no-cite' });
  await service.call('review.answer', { runId: run1.id, cardId: 'no-cite', grade: 2 });

  // 1. Missing cited source material
  let errZh = null;
  await assert.rejects(
    service.call('teach.start', { runId: run1.id, mode: 'calculation' }),
    (err) => { errZh = err; return true; },
  );
  assert.match(errZh.message, han, `expected Chinese source error, got: ${errZh.message}`);
  assert.doesNotMatch(localizeAppMessage(errZh.message, 'en'), han, `expected English translation, got: ${localizeAppMessage(errZh.message, 'en')}`);

  // 2. Invalid teaching plan
  service.complete = async () => JSON.stringify({ diagnosis: 'x', transfer: 'y', rungs: [] });
  await assert.rejects(
    service.call('teach.start', { runId: run1.id, mode: 'understanding' }),
    (err) => {
      assert.match(err.message, han, `expected Chinese source error, got: ${err.message}`);
      assert.doesNotMatch(localizeAppMessage(err.message, 'en'), han);
      return true;
    },
  );

  // 3. Invalid calculation teaching plan & citation
  const run2 = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd1', cardId: 'with-cite' }] });
  await service.call('review.reveal', { runId: run2.id, cardId: 'with-cite' });
  await service.call('review.answer', { runId: run2.id, cardId: 'with-cite', grade: 2 });
  service.complete = async () => JSON.stringify({ diagnosis: 'x', transfer: 'y', rungs: [{ stage: 'conditions', lesson: 'l', check: 'c', answer: 'a' }] });
  await assert.rejects(
    service.call('teach.start', { runId: run2.id, mode: 'calculation' }),
    (err) => {
      assert.match(err.message, han, `expected Chinese calculation plan error, got: ${err.message}`);
      assert.doesNotMatch(localizeAppMessage(err.message, 'en'), han);
      return true;
    },
  );

  // 4. Invalid retell feedback
  service.complete = async () => '{"passed":"nope"}';
  await assert.rejects(
    service.call('teach.retell', { deckId: 'd1', cardId: 'no-cite', text: 'my explanation' }),
    (err) => {
      assert.match(err.message, han, `expected Chinese retell error, got: ${err.message}`);
      assert.doesNotMatch(localizeAppMessage(err.message, 'en'), han);
      return true;
    },
  );
});

test('W0-3: LearningActions guards calculation teaching when card has no cited source, and TeachingStatus hides retry for non-retryable failures', () => {
  m.setUiLanguage('zh');
  const sessionBase = {
    run: {
      id: 'r1',
      deckId: 'd1',
      mode: 'path',
      index: 0,
      feedback: { correct: false, grade: 1 },
      card: { id: 'c1', kind: 'flashcard', prompt: 'Q' },
      solution: { citations: [] },
    },
    entry: { teaching: null },
    teachingBusy: false,
    teachingError: '',
    actions: { teachingAct: noop, cancelTeaching: noop, retryTeaching: noop },
  };
  const noCiteHtml = renderToStaticMarkup(withServices(h(m.LearningActions, {
    session: sessionBase,
    data: { sources: [], decks: [] },
    model: { ready: true },
    onModelSettings: noop,
    openModal: noop,
  })));
  const calcBtn = noCiteHtml.match(/<button[^>]*>[^<]*计算题引导练习[^<]*<\/button>/)?.[0] || '';
  assert.ok(calcBtn === '' || /\bdisabled\b/.test(calcBtn), 'calculation teaching chip must be hidden or disabled when card has no cited source');

  const statusHtml = renderToStaticMarkup(h(m.TeachingStatus, {
    busy: false,
    failure: '计算题引导练习需要题目关联原文资料，这道题没有引用资料。',
    onCancel: noop,
    onRetry: noop,
  }));
  assert.doesNotMatch(statusHtml, />重试</, 'non-retryable citation error must not show a Retry button');
});

/* ---------- W0-1 & W0-2: translation panel in 原文 view & non-retryable place errors ---------- */

test('W0-1: TranslationMenu in 原文 view (reading=false) does not falsely report no translatable paragraphs and disables/hides batch actions', () => {
  m.setUiLanguage('zh');
  const zhHtml = renderToStaticMarkup(h(m.TranslationMenu, {
    open: true,
    onOpenChange: noop,
    reading: false,
    scopes: [],
    target: 'zh',
    modelAvailable: true,
    stale: [],
    busy: false,
    hasTranslations: true,
    onStart: noop,
    onExpandAll: noop,
    onCollapseAll: noop,
    onGlossary: noop,
    onTarget: noop,
  }));
  assert.doesNotMatch(zhHtml, /这里没有需要翻译的段落/);
  assert.match(zhHtml, /阅读/, 'explains switching back to 阅读 view');
  assert.match(zhHtml, /简体中文/);
  assert.match(zhHtml, /English/);
  assert.match(zhHtml, /术语表…/);
  assert.doesNotMatch(zhHtml, />展开本页全部译文</, 'non-functional expand-all button is hidden in 原文 view');

  m.setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(h(m.TranslationMenu, {
      open: true,
      onOpenChange: noop,
      reading: false,
      scopes: [],
      target: 'en',
      modelAvailable: true,
      stale: [],
      busy: false,
      hasTranslations: true,
      onStart: noop,
      onExpandAll: noop,
      onCollapseAll: noop,
      onGlossary: noop,
      onTarget: noop,
    }));
    assert.doesNotMatch(enHtml.replace(/<[^>]+>/g, ' '), han, 'no untranslated Chinese in English 原文 translation menu');
  } finally {
    m.setUiLanguage('zh');
  }
});

test('W0-2: TranslationBlock omits Retry button for place errors (ambiguous/unlocated) while keeping Retry for retryable errors', () => {
  m.setUiLanguage('zh');
  const common = { state: 'error', target: 'zh', onRetry: noop, onDismiss: noop };
  const ambiguous = renderToStaticMarkup(h(m.TranslationBlock, { ...common, error: { code: 'ambiguous' } }));
  assert.match(ambiguous, /出现了多次/);
  assert.doesNotMatch(ambiguous, />重试</, 'ambiguous selection error must not offer a doomed Retry button');
  assert.match(ambiguous, />关闭</);

  const unlocated = renderToStaticMarkup(h(m.TranslationBlock, { ...common, error: { code: 'unlocated' } }));
  assert.doesNotMatch(unlocated, />重试</, 'unlocated selection error must not offer a doomed Retry button');

  const refusal = renderToStaticMarkup(h(m.TranslationBlock, { ...common, error: { code: 'refusal' } }));
  assert.match(refusal, />重试</, 'retryable model answer error keeps Retry button');

  // Selection retry entry lookup & rejected key migration
  const anchorEl = { id: 'p-1' };
  const tempKey = 'tmp:sel-1';
  const realKey = 'sel:s1|hash|10';
  const passage = { sourceId: 's1', kind: 'selection', text: 'hello world', prefix: '', suffix: '' };
  const layer = {
    byKey: new Map(),
    pinned: new Map([[tempKey, anchorEl]]),
    selectionEntries: new Map([[tempKey, { key: tempKey, passage }]]),
  };
  // Network error keeps tmp:sel-1 retryable via selectionEntries
  assert.deepEqual(m.resolveRetryEntry(layer, tempKey, { code: 'error', message: 'timeout' }), { key: tempKey, passage });
  // Place error is non-retryable even when present in selectionEntries
  assert.equal(m.resolveRetryEntry(layer, tempKey, { code: 'ambiguous' }), null);

  // Quality rejection migrates pinned, selectionEntries and returns remapping for floating card
  const remapped = m.reconcileSelectionKeys(
    layer,
    [{ key: tempKey, passage }],
    [{ index: 0, key: realKey, status: 'rejected', code: 'length', message: 'bad length' }],
  );
  assert.equal(remapped.get(tempKey), realKey);
  assert.equal(layer.pinned.get(realKey), anchorEl);
  assert.equal(layer.pinned.has(tempKey), false);
  assert.deepEqual(m.resolveRetryEntry(layer, realKey, { code: 'length' }), { key: realKey, passage });

  // Successful retry cleans up selectionEntries
  const okMap = m.reconcileSelectionKeys(
    layer,
    [{ key: realKey, passage }],
    [{ index: 0, key: realKey, status: 'translated', item: { key: realKey, text: '你好世界' } }],
  );
  assert.equal(okMap.size, 0);
  assert.equal(layer.selectionEntries.has(realKey), false);
});

/* ---------- W0-4: Desktop bootstrap language wait, crash banner layout, startup error retry ---------- */

test('W0-4: ui/desktop.jsx awaits uiLanguageReady, renders Retry on boot error, and keeps crash banner out of nested .study-app', async () => {
  const source = await readFile(new URL('../ui/desktop.jsx', import.meta.url), 'utf8');
  assert.match(source, /uiLanguageReady/, 'desktop entry must wait for uiLanguageReady before mounting');
  assert.match(source, /useUiLanguage/, 'DesktopRoot must subscribe to useUiLanguage');
  const dm = await loadUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { DesktopRoot } from './ui/desktop.jsx';
  `);
  assert.equal(typeof dm.DesktopRoot, 'function', 'DesktopRoot is exported for direct verification');

  dm.setUiLanguage('zh');
  const errHtml = renderToStaticMarkup(h(dm.DesktopRoot, {
    initialBoot: { status: 'error', rpc: null, subscribeLibraryEvents: null, installFlavor: undefined, error: 'sidecar exited during startup' },
  }));
  assert.match(errHtml, /桌面版启动失败/);
  assert.match(errHtml, /sidecar exited during startup/);
  assert.match(errHtml, />重试</, 'boot failure view must offer a Retry button');

  const crashHtml = renderToStaticMarkup(h(dm.DesktopRoot, {
    initialBoot: { status: 'ready', rpc: async () => ({}), subscribeLibraryEvents: null, installFlavor: undefined, error: '' },
    initialCrash: 'engine stopped',
    AppComponent: () => h('div', { className: 'study-app', 'data-testid': 'main-app' }, 'MAIN'),
  }));
  assert.match(crashHtml, /study-desktop-shell/, 'uses dedicated flex-column desktop shell');
  assert.match(crashHtml, /study-desktop-crash/, 'renders compact crash banner');
  assert.equal((crashHtml.match(/class="study-app/g) || []).length, 1, 'must not wrap crash banner in a second 100%-height .study-app');
  assert.match(crashHtml, /MAIN/);
});
