// Consolidated Guided Study Domain Suite
// Merges: round58-study-branch, round59-guided-qa, round62-study-artifact
// node --test tests/domain-guided-study.test.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = await loadDistRuntime();
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore: useDistTuiStore, DEFAULT_PREFERENCES } = await import(
  pathToFileURL(join(distDir, storeFile)).href
);
assert.ok(useDistTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-guided-');

after(async () => {
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

function fakeDiscovery() {
  const result = () => [
    { id: 'agy', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  return {
    async scan() {
      return result();
    },
    getCached: () => result(),
    findReadyPath: () => '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    loading: false,
    refreshing: false,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    activeRunId: null,
    preferences: {
      ...DEFAULT_PREFERENCES,
      recentCommands: [...(DEFAULT_PREFERENCES.recentCommands ?? [])],
      language,
      asciiMode,
    },
    ...extra,
  });
}

async function seedDeckWithCardsAndSession(host, { title, course, goalTitle, cardPrompts }) {
  const imp = await host.call('deck.import', {
    text: JSON.stringify({
      title,
      course,
      cards: cardPrompts.map((prompt, idx) => ({
        kind: 'flashcard',
        prompt,
        answer: idx === 0 ? 'Definition / core answer.' : 'Secondary concept answer.',
        topic: idx === 0 ? 'Basis' : 'Dimension',
      })),
    }),
  });
  assert.equal(imp.ok, true, `deck.import failed: ${imp.error?.message}`);
  const snapRes = await host.refreshSnapshot();
  const deckMeta = (snapRes.snapshot?.decks ?? []).find((d) => !d.archived && !d.systemKind && d.title === title);
  assert.ok(deckMeta, `Seeded deck "${title}" must exist in snapshot`);

  const deckRes = await host.call('deck.get', { id: deckMeta.id });
  assert.equal(deckRes.ok, true, `deck.get failed: ${deckRes.error?.message}`);
  const cards = deckRes.value?.cards ?? [];
  assert.equal(cards.length, cardPrompts.length, `Seeded deck must contain ${cardPrompts.length} card(s)`);

  const sessionRes = await host.call('study.session.start', {
    courseId: course,
    scope: [{ kind: 'deck', id: deckMeta.id }],
    goal: { title: goalTitle },
  });
  assert.equal(sessionRes.ok, true, `study.session.start failed: ${sessionRes.error?.message}`);
  assert.ok(sessionRes.value?.id, 'study.session.start must return a session id');
  return { deck: deckRes.value, deckMeta, cards, card: cards[0], session: sessionRes.value };
}

function createZeroCallGuardHost(base, { label, onAiCall, onFetchCall }) {
  const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
  return {
    env,
    create: (extra = {}) =>
      createTuiHost({
        libraryRoot: join(base, 'library'),
        env,
        home: join(base, 'home'),
        documentsDir: base,
        discovery: fakeDiscovery(),
        injectedComplete: async () => {
          onAiCall();
          return '{}';
        },
        fetch: async () => {
          onFetchCall();
          throw new Error(`Network call must not happen during ${label}`);
        },
        skipAutoProbe: true,
        language: 'zh',
        ...extra,
      }),
  };
}

describe('Round 58: GuidedStudyModal Knowledge Branch Open/Return (0 LLM tokens)', () => {
  test('1) createTuiHost integration (0 model calls): study.branch.open & study.branch.return track focus & returnPath', async () => {
    const base = await temps.make('r58-host');
    let aiCalls = 0;
    let fetchCalls = 0;
    const host = await createZeroCallGuardHost(base, {
      label: 'study.branch.open/return',
      onAiCall: () => {
        aiCalls += 1;
      },
      onFetchCall: () => {
        fetchCalls += 1;
      },
    }).create();

    try {
      const { deck, cards, session } = await seedDeckWithCardsAndSession(host, {
        title: '线性空间基础',
        course: '线性代数',
        goalTitle: '掌握基与维数',
        cardPrompts: ['什么是线性空间的一组基？', '线性空间的维数如何定义？'],
      });
      const [card1, card2] = cards;

      const open1 = await host.call('study.branch.open', {
        sessionId: session.id,
        targetDeckId: deck.id,
        targetCardId: card1.id,
        branchKind: 'prerequisite',
      });
      assert.equal(open1.ok, true, `study.branch.open #1 failed: ${open1.error?.message}`);
      assert.equal(open1.value?.session?.id, session.id);
      assert.equal(open1.value?.session?.focus?.id, card1.id, 'First branch must focus card1');
      assert.equal(open1.value?.session?.focus?.deckId, deck.id);
      assert.ok(open1.value?.branchRun?.id, 'study.branch.open must create isolated branchRun');
      assert.equal(open1.value?.branchRun?.mode, 'path');
      assert.equal(open1.value?.session?.returnPath?.length ?? 0, 0);

      const open2 = await host.call('study.branch.open', {
        sessionId: session.id,
        targetDeckId: deck.id,
        targetCardId: card2.id,
        branchKind: 'prerequisite',
      });
      assert.equal(open2.ok, true, `study.branch.open #2 failed: ${open2.error?.message}`);
      assert.equal(open2.value?.session?.id, session.id);
      assert.equal(open2.value?.session?.focus?.id, card2.id, 'Second branch must focus card2');
      assert.equal(open2.value?.session?.focus?.deckId, deck.id);
      assert.equal(open2.value?.session?.returnPath?.length, 1, 'Second branch must push card1 onto returnPath');
      assert.equal(open2.value?.session?.returnPath?.[0]?.cardId, card1.id);
      assert.equal(open2.value?.session?.returnPath?.[0]?.deckId, deck.id);

      const ret = await host.call('study.branch.return', {
        sessionId: session.id,
      });
      assert.equal(ret.ok, true, `study.branch.return failed: ${ret.error?.message}`);
      assert.equal(ret.value?.session?.id, session.id);
      assert.equal(ret.value?.session?.focus?.id, card1.id, 'study.branch.return must restore focus to card1');
      assert.equal(ret.value?.session?.focus?.deckId, deck.id);
      assert.equal(ret.value?.session?.returnPath?.length, 0, 'study.branch.return must pop returnPath back to 0');

      const getRes = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(getRes.ok, true, `study.session.get failed: ${getRes.error?.message}`);
      assert.equal(getRes.value?.id, session.id);
      assert.equal(getRes.value?.focus?.id, card1.id);
      assert.equal(getRes.value?.returnPath?.length ?? 0, 0);
      assert.equal(aiCalls, 0, 'study.branch.open/return must make 0 model calls');
      assert.equal(fetchCalls, 0, 'study.branch.open/return must make 0 network calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): g -> B -> Enter -> B -> Enter -> u -> Esc -> ? HelpOverlay', async () => {
    const base = await temps.make('r58-e2e-zh');
    let aiCalls = 0;
    let fetchCalls = 0;
    const guard = createZeroCallGuardHost(base, {
      label: 'GuidedStudyModal branch E2E',
      onAiCall: () => {
        aiCalls += 1;
      },
      onFetchCall: () => {
        fetchCalls += 1;
      },
    });
    resetDistStore('zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: guard.env });
    const host = await guard.create({ eventDebounceMs: 30 });

    const { cards, session } = await seedDeckWithCardsAndSession(host, {
      title: '特征值与相似矩阵',
      course: '线性代数',
      goalTitle: '攻克相似对角化',
      cardPrompts: ['前置基础：什么是特征向量？', '核心推导：矩阵何时可对角化？'],
    });

    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: false,
        onExit: () => inkInstance.unmount(),
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await tty.firstFramePromise;
      const libScreen = await tty.waitFor(
        (s) => s.includes('特征值与相似矩阵') && s.includes('线性代数'),
        { timeoutMs: 8_000, label: 'LibraryView zh ready with seeded deck' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView zh 120x36');
      assert.ok(libScreen.includes('特征值与相似矩阵'));
      assert.equal(aiCalls, 0);
      assert.equal(fetchCalls, 0);

      tty.send('g');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('AI 带学工作台') && s.includes('攻克相似对角化') && !s.includes('正在读取带学工作台'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal active session zh' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'GuidedStudyModal active zh 120x36');
      assert.ok(modalScreen.includes('AI 带学工作台'));
      assert.ok(modalScreen.includes('攻克相似对角化'));
      assert.equal(aiCalls, 0);

      tty.send('B');
      const pick1Screen = await tty.waitFor(
        (s) => s.includes('前置支线选卡') && s.includes('什么是特征向量'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch picker #1 zh' },
      );
      tty.assertHealthyScreen(pick1Screen, 120, 36, 'GuidedStudyModal branch picker #1 zh');
      assert.ok(pick1Screen.includes('前置支线选卡'));
      assert.ok(pick1Screen.includes('什么是特征向量'));

      tty.send('\r');
      const afterBranch1 = await tty.waitFor(
        (s) =>
          !s.includes('前置支线选卡') &&
          s.includes('已切入前置支线练习（按 [u] 返回原题）') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('前置支线')),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch #1 opened toast zh' },
      );
      tty.assertHealthyScreen(afterBranch1, 120, 36, 'GuidedStudyModal after branch #1 zh');
      assert.ok(!afterBranch1.includes('前置支线选卡'));
      assert.ok(afterBranch1.includes('已切入前置支线练习（按 [u] 返回原题）'));

      const afterBranch1Session = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(afterBranch1Session.ok, true);
      assert.equal(afterBranch1Session.value?.focus?.id, cards[0].id);
      assert.equal(afterBranch1Session.value?.returnPath?.length ?? 0, 0);

      tty.send('B');
      const pick2Screen = await tty.waitFor(
        (s) => s.includes('前置支线选卡') && s.includes('矩阵何时可对角化'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch picker #2 zh' },
      );
      tty.assertHealthyScreen(pick2Screen, 120, 36, 'GuidedStudyModal branch picker #2 zh');
      assert.ok(pick2Screen.includes('矩阵何时可对角化'));

      tty.send('\r');
      const afterBranch2 = await tty.waitFor(
        (s) => !s.includes('前置支线选卡') && s.includes('支线深度 1'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch depth badge zh' },
      );
      tty.assertHealthyScreen(afterBranch2, 120, 36, 'GuidedStudyModal branch depth 1 zh');
      assert.ok(afterBranch2.includes('支线深度 1'));

      const afterBranch2Session = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(afterBranch2Session.ok, true);
      assert.equal(afterBranch2Session.value?.focus?.id, cards[1].id);
      assert.equal(afterBranch2Session.value?.returnPath?.length, 1);
      assert.equal(afterBranch2Session.value?.returnPath?.[0]?.cardId, cards[0].id);

      tty.send('u');
      const afterReturn = await tty.waitFor(
        (s) =>
          !s.includes('支线深度 1') &&
          s.includes('已从前置支线回到原学习焦点') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('回到原学习焦点')),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch returned toast zh' },
      );
      tty.assertHealthyScreen(afterReturn, 120, 36, 'GuidedStudyModal after return zh');
      assert.ok(!afterReturn.includes('支线深度 1'));
      assert.ok(afterReturn.includes('已从前置支线回到原学习焦点'));

      const sessionCheck = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(sessionCheck.ok, true);
      assert.equal(sessionCheck.value?.focus?.id, cards[0].id, 'Returned session focus must be card 1');
      assert.equal(sessionCheck.value?.returnPath?.length ?? 0, 0, 'Returned session returnPath must be empty');

      tty.send('\x1b');
      const closedModal = await tty.waitFor((s) => !s.includes('AI 带学工作台'), { timeoutMs: 8_000, label: 'GuidedStudyModal closed zh' });
      assert.ok(!closedModal.includes('AI 带学工作台'));

      tty.send('?');
      const helpTopScreen = await tty.waitFor(
        (s) =>
          s.includes('快捷键') &&
          (s.includes('B支线/u回') || s.includes('B开支线/u返回')),
        { timeoutMs: 8_000, label: 'HelpOverlay updated Library label zh' },
      );
      tty.assertHealthyScreen(helpTopScreen, 120, 36, 'HelpOverlay top zh 120x36');
      assert.ok(helpTopScreen.includes('快捷键'));
      assert.equal(helpTopScreen.includes('B支线/u回') || helpTopScreen.includes('B开支线/u返回'), true);

      tty.send('G');
      const helpBottomScreen = await tty.waitFor(
        (s) => s.includes('语义检索诊断/试搜/镜像源'),
        { timeoutMs: 8_000, label: 'HelpOverlay updated Settings label zh' },
      );
      tty.assertHealthyScreen(helpBottomScreen, 120, 36, 'HelpOverlay bottom zh 120x36');
      assert.equal(helpBottomScreen.includes('语义检索诊断/试搜/镜像源'), true);
      assert.equal(aiCalls, 0, 'PTY zh flow must trigger 0 model calls');
      assert.equal(fetchCalls, 0, 'PTY zh flow must trigger 0 network calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore unmount errors
      }
      tty.dispose();
      await host.dispose();
    }
  });
});

describe('Round 59: GuidedStudyModal Guided Q&A Organize (0 LLM tokens)', () => {
  test('1) createTuiHost integration (0 model calls): study.qa.organize persists followup & deduplicates by operationId', async () => {
    const base = await temps.make('r59-host');
    let aiCalls = 0;
    let fetchCalls = 0;
    const host = await createZeroCallGuardHost(base, {
      label: 'study.qa.organize',
      onAiCall: () => {
        aiCalls += 1;
      },
      onFetchCall: () => {
        fetchCalls += 1;
      },
    }).create();

    try {
      const { deck, card, session } = await seedDeckWithCardsAndSession(host, {
        title: '线性空间问答',
        course: '线性代数',
        goalTitle: '理解基与维数',
        cardPrompts: ['什么是线性空间的一组基？'],
      });

      const operationId = 'tui-gqa-test-op-1';
      const question = '基与生成元集合的核心区别是什么？';
      const answerMarkdown = '基必须同时满足**线性无关**与**张成整个空间**。';

      const res1 = await host.call('study.qa.organize', {
        sessionId: session.id,
        operationId,
        target: { deckId: deck.id, cardId: card.id },
        question,
        answerMarkdown,
        explicitUserCommand: true,
      });
      assert.equal(res1.ok, true, `study.qa.organize #1 failed: ${res1.error?.message}`);
      assert.equal(res1.value?.ok, true);
      assert.ok(res1.value?.qaId, 'study.qa.organize must return qaId');
      assert.equal(res1.value?.operationId, operationId);
      assert.equal(res1.value?.deduplicated, false);

      const deckAfter1 = await host.call('deck.get', { id: deck.id });
      assert.equal(deckAfter1.ok, true);
      const persistedCard = deckAfter1.value?.cards?.find((c) => c.id === card.id);
      assert.ok(persistedCard, 'Target card must exist after study.qa.organize');
      assert.equal(persistedCard.followups?.length, 1, 'Card must have 1 organized followup');
      assert.equal(persistedCard.followups[0].id, res1.value.qaId);
      assert.equal(persistedCard.followups[0].operationId, operationId);
      assert.equal(persistedCard.followups[0].question, question);
      assert.equal(persistedCard.followups[0].answer, answerMarkdown);

      const res2 = await host.call('study.qa.organize', {
        sessionId: session.id,
        operationId,
        target: { deckId: deck.id, cardId: card.id },
        question,
        answerMarkdown,
        explicitUserCommand: true,
      });
      assert.equal(res2.ok, true, `study.qa.organize #2 failed: ${res2.error?.message}`);
      assert.equal(res2.value?.ok, true);
      assert.equal(res2.value?.qaId, res1.value.qaId);
      assert.equal(res2.value?.deduplicated, true, 'Duplicate operationId with identical content must deduplicate');

      const deckAfter2 = await host.call('deck.get', { id: deck.id });
      assert.equal(deckAfter2.ok, true);
      const cardAfter2 = deckAfter2.value?.cards?.find((c) => c.id === card.id);
      assert.equal(cardAfter2?.followups?.length, 1, 'Deduplicated retry must not duplicate followup');
      assert.equal(aiCalls, 0, 'study.qa.organize must make 0 model calls');
      assert.equal(fetchCalls, 0, 'study.qa.organize must make 0 network calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): g -> Q -> form -> Tab -> Ctrl+S -> toast & persisted -> Q -> Esc cancel', async () => {
    const base = await temps.make('r59-e2e-zh');
    let aiCalls = 0;
    let fetchCalls = 0;
    const guard = createZeroCallGuardHost(base, {
      label: 'GuidedStudyModal Q&A E2E',
      onAiCall: () => {
        aiCalls += 1;
      },
      onFetchCall: () => {
        fetchCalls += 1;
      },
    });
    resetDistStore('zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: guard.env });
    const host = await guard.create({ eventDebounceMs: 30 });

    const { deck, card } = await seedDeckWithCardsAndSession(host, {
      title: '特征值问答归档',
      course: '线性代数',
      goalTitle: '攻克特征值概念',
      cardPrompts: ['什么是矩阵的特征值与特征向量？'],
    });

    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: false,
        onExit: () => inkInstance.unmount(),
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await tty.firstFramePromise;
      const libScreen = await tty.waitFor(
        (s) => s.includes('特征值问答归档') && s.includes('线性代数'),
        { timeoutMs: 8_000, label: 'LibraryView zh ready' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView zh 120x36');

      tty.send('g');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('AI 带学工作台') && s.includes('攻克特征值概念') && s.includes('整理问答') && !s.includes('正在读取带学工作台'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal active session zh' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'GuidedStudyModal active zh 120x36');
      assert.ok(modalScreen.includes('整理问答'));
      assert.equal(aiCalls, 0);

      tty.send('Q');
      const qaFormScreen = await tty.waitFor(
        (s) => s.includes('整理问答归档') && s.includes('什么是矩阵的特征值与特征向量'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal qa-form opened zh' },
      );
      tty.assertHealthyScreen(qaFormScreen, 120, 36, 'GuidedStudyModal qa-form zh 120x36');
      assert.ok(qaFormScreen.includes('整理问答归档'));

      const qText = '为什么特征向量不能为零向量？';
      const aText = '零向量对任意常数均满足 Av = lambda v，无法确定特征值。';

      tty.send(qText);
      const qTyped = await tty.waitFor((s) => s.includes('为什么特征向量不能为零向量'), { timeoutMs: 5_000, label: 'question text rendered zh' });
      assert.ok(qTyped.includes('为什么特征向量不能为零向量'));

      tty.send('\t');
      await tty.flush();
      tty.send(aText);
      const aTyped = await tty.waitFor((s) => s.includes('无法确定特征值'), { timeoutMs: 5_000, label: 'answer text rendered zh' });
      assert.ok(aTyped.includes('无法确定特征值'));

      tty.send('\x13');
      const afterSubmit = await tty.waitFor(
        (s) =>
          !s.includes('整理问答归档') &&
          s.includes('攻克特征值概念') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已整理问答并归档到卡片')),
        { timeoutMs: 8_000, label: 'GuidedStudyModal qa-form submitted toast zh' },
      );
      tty.assertHealthyScreen(afterSubmit, 120, 36, 'GuidedStudyModal after qa-form submit zh');
      assert.ok(!afterSubmit.includes('整理问答归档'));
      assert.ok(useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已整理问答并归档到卡片')));

      const deckCheck1 = await host.call('deck.get', { id: deck.id });
      assert.equal(deckCheck1.ok, true);
      const cardCheck1 = deckCheck1.value?.cards?.find((c) => c.id === card.id);
      assert.ok(cardCheck1?.followups?.[0]?.id, 'Persisted followup must have an id');
      assert.ok(cardCheck1?.followups?.[0]?.operationId, 'Persisted followup must record operationId');
      assert.equal(cardCheck1?.followups?.length, 1, 'Card must persist 1 organized QA followup');
      assert.equal(cardCheck1.followups[0].question, qText);
      assert.equal(cardCheck1.followups[0].answer, aText);

      tty.send('Q');
      const qaReopened = await tty.waitFor((s) => s.includes('整理问答归档'), { timeoutMs: 8_000, label: 'GuidedStudyModal qa-form re-opened zh' });
      assert.ok(qaReopened.includes('整理问答归档'));

      tty.send('\x1b');
      const afterCancel = await tty.waitFor(
        (s) => !s.includes('整理问答归档') && s.includes('AI 带学工作台') && s.includes('攻克特征值概念'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal qa-form Esc cancel zh' },
      );
      tty.assertHealthyScreen(afterCancel, 120, 36, 'GuidedStudyModal after qa-form Esc cancel zh');
      assert.ok(!afterCancel.includes('整理问答归档'));
      assert.ok(afterCancel.includes('AI 带学工作台'));

      const deckCheck2 = await host.call('deck.get', { id: deck.id });
      assert.equal(deckCheck2.ok, true);
      const cardCheck2 = deckCheck2.value?.cards?.find((c) => c.id === card.id);
      assert.equal(cardCheck2?.followups?.length, 1, 'Esc cancel must not persist extra followup');
      assert.equal(cardCheck2.followups[0].question, qText);
      assert.equal(cardCheck2.followups[0].answer, aText);
      assert.equal(aiCalls, 0, 'PTY zh flow must trigger 0 model calls');
      assert.equal(fetchCalls, 0, 'PTY zh flow must trigger 0 network calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore unmount errors
      }
      tty.dispose();
      await host.dispose();
    }
  });
});

describe('Round 62: GuidedStudyModal Save Teaching Artifact (0 LLM tokens)', () => {
  test('1) createTuiHost integration (0 model calls): study.session.artifact.save persists artifactRefs & deduplicates by operationId', async () => {
    const base = await temps.make('r62-host');
    let aiCalls = 0;
    let fetchCalls = 0;
    const host = await createZeroCallGuardHost(base, {
      label: 'study.session.artifact.save',
      onAiCall: () => {
        aiCalls += 1;
      },
      onFetchCall: () => {
        fetchCalls += 1;
      },
    }).create();

    try {
      const { session } = await seedDeckWithCardsAndSession(host, {
        title: '微积分重点总结',
        course: '高等数学',
        goalTitle: '掌握泰勒展开与拉格朗日余项',
        cardPrompts: ['写出带拉格朗日余项的泰勒公式。'],
      });

      const operationId = randomUUID();
      const title = '泰勒公式余项推导';
      const kind = 'formula';
      const topic = '泰勒展开';
      const markdown = '设 $f$ 在包含 $x_0$ 的区间内 $n+1$ 阶可导，则余项为 $R_n(x)$。';

      const res1 = await host.call('study.session.artifact.save', {
        sessionId: session.id,
        title,
        kind,
        topic,
        markdown,
        operationId,
      });
      assert.equal(res1.ok, true, `study.session.artifact.save #1 failed: ${res1.error?.message}`);
      assert.ok(res1.value?.artifactId, 'study.session.artifact.save must return artifactId');
      assert.equal(res1.value?.operationId, operationId);
      assert.equal(res1.value?.deduplicated, false);
      assert.equal(res1.value?.artifact?.id, res1.value.artifactId);
      assert.equal(res1.value?.artifact?.title, title);
      assert.equal(res1.value?.artifact?.kind, kind);
      assert.equal(res1.value?.artifact?.topic, topic);
      assert.equal(res1.value?.artifact?.markdown, markdown);

      const getAfter1 = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(getAfter1.ok, true, `study.session.get #1 failed: ${getAfter1.error?.message}`);
      assert.equal(getAfter1.value?.artifactRefs?.length, 1, 'Session must persist 1 artifact in artifactRefs');
      assert.equal(getAfter1.value.artifactRefs[0].id, res1.value.artifactId);
      assert.equal(getAfter1.value.artifactRefs[0].kind, kind);
      assert.equal(getAfter1.value.artifactRefs[0].title, title);
      assert.equal(getAfter1.value.artifactRefs[0].topic, topic);
      assert.equal(getAfter1.value.artifactRefs[0].markdown, markdown);

      const res2 = await host.call('study.session.artifact.save', {
        sessionId: session.id,
        title,
        kind,
        topic,
        markdown,
        operationId,
      });
      assert.equal(res2.ok, true, `study.session.artifact.save #2 failed: ${res2.error?.message}`);
      assert.equal(res2.value?.deduplicated, true, 'Duplicate operationId must return deduplicated: true');
      assert.equal(res2.value?.artifactId, res1.value.artifactId);
      assert.equal(res2.value?.operationId, operationId);

      const getAfter2 = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(getAfter2.ok, true);
      assert.equal(getAfter2.value?.artifactRefs?.length, 1, 'Deduplicated retry must not increase artifactRefs count');
      assert.equal(getAfter2.value?.artifactRefs?.[0]?.id, res1.value.artifactId);
      assert.equal(getAfter2.value?.artifactRefs?.[0]?.title, title);
      assert.equal(getAfter2.value?.artifactRefs?.[0]?.kind, kind);
      assert.equal(getAfter2.value?.artifactRefs?.[0]?.topic, topic);
      assert.equal(getAfter2.value?.artifactRefs?.[0]?.markdown, markdown);
      assert.equal(getAfter2.value?.receipts?.length, 1);
      assert.equal(getAfter2.value?.receipts?.[0]?.operationId, operationId);
      assert.equal(aiCalls, 0, 'study.session.artifact.save must make 0 model calls');
      assert.equal(fetchCalls, 0, 'study.session.artifact.save must make 0 network calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): g -> A -> title -> Tab -> Space x2 (summary -> formula) -> Tab -> markdown -> Ctrl+S -> artifact view -> A -> Esc cancel', async () => {
    const base = await temps.make('r62-e2e-zh');
    let aiCalls = 0;
    let fetchCalls = 0;
    const guard = createZeroCallGuardHost(base, {
      label: 'GuidedStudyModal artifact E2E',
      onAiCall: () => {
        aiCalls += 1;
      },
      onFetchCall: () => {
        fetchCalls += 1;
      },
    });
    resetDistStore('zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: guard.env });
    const host = await guard.create({ eventDebounceMs: 30 });

    const { session } = await seedDeckWithCardsAndSession(host, {
      title: '特征值讲义归档',
      course: '线性代数',
      goalTitle: '吃透相似对角化',
      cardPrompts: ['矩阵可对角化的充要条件是什么？'],
    });

    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: false,
        onExit: () => inkInstance.unmount(),
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await tty.firstFramePromise;
      const libScreen = await tty.waitFor(
        (s) => s.includes('特征值讲义归档') && s.includes('线性代数'),
        { timeoutMs: 8_000, label: 'LibraryView zh ready' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView zh 120x36');

      tty.send('g');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('AI 带学工作台') && s.includes('吃透相似对角化') && s.includes('保存讲解') && !s.includes('正在读取带学工作台'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal active session zh' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'GuidedStudyModal active zh 120x36');
      assert.ok(modalScreen.includes('保存讲解'));
      assert.equal(aiCalls, 0);

      tty.send('A');
      const formScreen = await tty.waitFor(
        (s) => s.includes('保存教学讲解') && s.includes('类型 (Kind): explanation'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal artifact-form opened zh' },
      );
      tty.assertHealthyScreen(formScreen, 120, 36, 'GuidedStudyModal artifact-form zh 120x36');
      assert.ok(formScreen.includes('保存教学讲解'));
      assert.ok(formScreen.includes('类型 (Kind): explanation'));

      const artifactTitle = '相似对角化判别速记';
      const artifactMarkdown = '当且仅当矩阵有 $n$ 个线性无关的特征向量时可对角化。';

      tty.send(artifactTitle);
      const titleTyped = await tty.waitFor((s) => s.includes(artifactTitle), { timeoutMs: 5_000, label: 'artifact title rendered zh' });
      assert.ok(titleTyped.includes(artifactTitle));

      // Tab to Kind field, Space twice to cycle explanation -> summary -> formula
      tty.send('\t');
      await tty.flush();
      tty.send(' ');
      const kindStep1 = await tty.waitFor((s) => s.includes('类型 (Kind): summary'), { timeoutMs: 5_000, label: 'artifact kind cycled to summary zh' });
      assert.ok(kindStep1.includes('类型 (Kind): summary'));
      tty.send(' ');
      const kindStep2 = await tty.waitFor((s) => s.includes('类型 (Kind): formula'), { timeoutMs: 5_000, label: 'artifact kind cycled to formula zh' });
      assert.ok(kindStep2.includes('类型 (Kind): formula'));

      tty.send('\t');
      await tty.flush();
      tty.send(artifactMarkdown);
      const mdTyped = await tty.waitFor((s) => s.includes('线性无关的特征向量'), { timeoutMs: 5_000, label: 'artifact markdown rendered zh' });
      assert.ok(mdTyped.includes('线性无关的特征向量'));

      tty.send('\x13');
      const afterSubmit = await tty.waitFor(
        (s) =>
          !s.includes('标题 (Title)') &&
          s.includes('[3] 讲解(1)') &&
          s.includes(artifactTitle) &&
          s.includes('线性无关的特征向量') &&
          s.includes('公式') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已保存教学讲解到会话')),
        { timeoutMs: 8_000, label: 'GuidedStudyModal artifact-form submitted & artifact view shown zh' },
      );
      tty.assertHealthyScreen(afterSubmit, 120, 36, 'GuidedStudyModal after artifact submit zh');
      assert.ok(afterSubmit.includes('[3] 讲解(1)'));
      assert.ok(afterSubmit.includes('公式'));
      assert.ok(useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已保存教学讲解到会话')));

      const sessionAfter1 = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(sessionAfter1.ok, true);
      assert.equal(sessionAfter1.value?.artifactRefs?.length, 1, 'Session must persist 1 teaching artifact');
      assert.ok(sessionAfter1.value.artifactRefs[0].id, 'Artifact must persist an id');
      assert.equal(sessionAfter1.value.artifactRefs[0].title, artifactTitle);
      assert.equal(sessionAfter1.value.artifactRefs[0].kind, 'formula');
      assert.equal(sessionAfter1.value.artifactRefs[0].markdown, artifactMarkdown);
      assert.equal(sessionAfter1.value.receipts?.length, 1, 'Session must record 1 operationId receipt');
      assert.match(sessionAfter1.value.receipts[0].operationId, /^[0-9a-f-]{36}$/i);

      tty.send('A');
      const reopenedForm = await tty.waitFor((s) => s.includes('保存教学讲解'), { timeoutMs: 8_000, label: 'GuidedStudyModal artifact-form re-opened zh' });
      assert.ok(reopenedForm.includes('保存教学讲解'));

      tty.send('\x1b');
      const afterCancel = await tty.waitFor(
        (s) => !s.includes('保存教学讲解') && s.includes('AI 带学工作台') && s.includes(artifactTitle),
        { timeoutMs: 8_000, label: 'GuidedStudyModal artifact-form Esc cancel zh' },
      );
      tty.assertHealthyScreen(afterCancel, 120, 36, 'GuidedStudyModal after artifact-form Esc cancel zh');
      assert.ok(!afterCancel.includes('保存教学讲解'));
      assert.ok(afterCancel.includes(artifactTitle));

      const sessionAfter2 = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(sessionAfter2.ok, true);
      assert.equal(sessionAfter2.value?.artifactRefs?.length, 1, 'Esc cancel must not persist extra artifact');
      assert.equal(sessionAfter2.value.artifactRefs[0].title, artifactTitle);
      assert.equal(sessionAfter2.value.artifactRefs[0].kind, 'formula');
      assert.equal(sessionAfter2.value.artifactRefs[0].markdown, artifactMarkdown);
      assert.equal(aiCalls, 0, 'PTY zh flow must trigger 0 model calls');
      assert.equal(fetchCalls, 0, 'PTY zh flow must trigger 0 network calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore unmount errors
      }
      tty.dispose();
      await host.dispose();
    }
  });
});
