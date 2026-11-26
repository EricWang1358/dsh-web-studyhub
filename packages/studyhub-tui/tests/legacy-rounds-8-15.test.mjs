// Consolidated Legacy E2E Suite: Rounds 8-15
// Merges: round8-e2e, round9-e2e, round11-e2e, round12-e2e, round14-e2e, round15-e2e
// node --test tests/legacy-rounds-8-15.test.mjs
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  exportFilenameRegex,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-legacy-8-15-');

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    voicePackOpen: false,
    inboxOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    preferences: {
      ...DEFAULT_PREFERENCES,
      recentCommands: [...(DEFAULT_PREFERENCES.recentCommands ?? [])],
      language,
      asciiMode,
    },
    ...extra,
  });
}

after(async () => {
  resetDistStore('zh', false);
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Unified deterministic model stub covering Rounds 8-15 AI contracts:
 * - teach.retell (Round 8)
 * - card.terms, card.followup.suggest, teach.start, teach.answer, AI Tutor stream (Round 11)
 * - source.organize.suggest (Round 12)
 * - generation.answerCard.build write/review/repair (Round 14)
 */
function createGroup1StubComplete() {
  return async (system, prompt, execution = {}) => {
    const s = String(system || '');
    const p = String(prompt || '');
    const task = execution?.task;

    if (p.includes('OK?')) return 'OK';

    if (s.includes('The learner explains a study point in their own words')) {
      const req = JSON.parse(p);
      assert.ok(String(req.learnerExplanation || '').trim().length > 0, 'teach.retell payload must include learnerExplanation');
      const citationsCount = Number(req.citations || 0);
      return JSON.stringify({
        passed: true,
        right: ['Accurately captured Memento state snapshots and encapsulation.'],
        missed: [],
        wrong: [],
        cite: citationsCount > 0 ? 0 : null,
      });
    }

    if (task === 'card.terms' || s.includes('unfamiliar technical terms')) {
      const payload = JSON.parse(p);
      const haystack = [
        payload.prompt,
        payload.answer,
        payload.explanation,
        payload.clozeText,
        ...(Array.isArray(payload.options) ? payload.options.map((o) => `${o?.text || ''} ${o?.explanation || ''}`) : []),
      ]
        .filter(Boolean)
        .join(' ');
      const candidates = ['Memento', 'Caretaker', 'Originator', 'Bridge', 'Snapshot', '报表', '快照'];
      const picked = candidates.filter((term) => haystack.includes(term));
      return JSON.stringify({ terms: picked.length > 0 ? picked : ['Memento'] });
    }

    if (task === 'card.followup.suggest' || s.includes('suggest exactly 3') || s.includes('推荐恰好 3 个')) {
      return JSON.stringify({
        questions: [
          'Caretaker 为何不能读取快照内容？',
          'Memento 与 Originator 的职责边界是什么？',
          '什么场景不适合使用 Memento 模式？',
        ],
      });
    }

    if (s.includes('You are a source-grounded tutor')) {
      return JSON.stringify({
        diagnosis: '区分历史管理者 Caretaker 与快照容器 Memento 的职责边界',
        rungs: [
          {
            lesson: 'Originator 拥有内部状态，负责创建和恢复快照；Caretaker 只负责保管历史列表。',
            check: '在 Memento 模式中，哪个角色负责保存历史列表而不检查快照内容？',
            answer: 'Caretaker',
          },
          {
            lesson: 'Memento 本身是一份不透明的状态快照，通过窄接口对外隐藏内部结构。',
            check: 'Caretaker 可以直接读取或修改 Memento 内部的字段吗？',
            answer: '不能',
          },
        ],
        transfer: '将「状态创建/恢复（Originator）」与「历史保管（Caretaker）」分离即可守住封装边界。',
      });
    }

    if (s.includes('Judge only the current prerequisite check')) {
      const req = JSON.parse(p);
      assert.ok(String(req.learnerAnswer || '').trim().length > 0, 'teach.answer payload must include learnerAnswer');
      return JSON.stringify({
        passed: true,
        feedback: '回答正确！Caretaker 负责管理历史快照列表，但不检查快照内部数据。',
      });
    }

    if (s.includes('Organize study sources into courses')) {
      const req = JSON.parse(p);
      const sources = Array.isArray(req.sources) ? req.sources : [];
      const fallbackCourse =
        Array.isArray(req.courses) && req.courses.length > 0 ? req.courses[0] : '示例课程 · 设计模式';
      return JSON.stringify({
        proposals: sources.map((src) => ({
          id: src.id,
          courses: Array.isArray(src.courses) && src.courses.length > 0 ? src.courses : [fallbackCourse],
          reason: '讲义内容涉及 Memento 与 Bridge 设计模式',
        })),
      });
    }

    if (s.includes('structured model answer card')) {
      if (p.includes('REPAIR:')) {
        return JSON.stringify({
          patch: {
            conclusion:
              '采用 Memento 模式封装每篇笔记的状态快照，由笔记编辑器创建与恢复，撤销历史按笔记隔离保管。',
          },
        });
      }
      if (p.includes('STAGE: review')) {
        return JSON.stringify({
          issues: [],
          summary: '引文、显式假设与评分点均已核对完整。',
        });
      }
      if (p.includes('STAGE: write')) {
        return JSON.stringify({
          questionType: 'general',
          signals: [{ word: '重新设计', quote: '你会怎样重新设计墨笺的撤销功能？' }],
          facts: [
            {
              text: '多模块共享并直接修改全局历史列表',
              quote: '工具栏、同步服务和搜索索引都直接读取并修改这个列表。',
            },
            {
              text: '连按两次撤销可能恢复成另一天的版本',
              quote: '连按两次撤销有时会把笔记恢复成另一天的版本',
            },
          ],
          concepts: [],
          assumptions: ['假设每篇笔记保存的快照数量有上限为 50 份，避免内存无限增长。'],
          steps: [
            '使用 Memento 模式拆分角色：笔记编辑器是 Originator，负责创建与恢复状态快照。',
            '每篇笔记的撤销历史是 Caretaker，从不读取快照内容，仅按顺序保管快照。',
            '原方案中工具栏、同步和搜索都能修改共享历史，破坏了封装。',
            '改由按笔记有序保存不透明快照，解决连续撤销恢复成另一天版本的问题。',
          ],
          conclusion:
            '采用 Memento 模式封装每篇笔记的状态快照，由笔记编辑器创建与恢复，撤销历史按笔记隔离保管。',
          justification: {
            goal: '隔离工具栏、同步与搜索对撤销历史的直接修改，确保撤销只恢复当前笔记的上一状态。',
            cost: '每篇笔记需额外占用一定内存保存快照序列，上限假设为 50 份。',
            failure: '若快照列表为空则禁用撤销按钮，若快照损坏则丢弃该条并保留最近有效状态。',
            verify: '编写单元测试验证连按两次撤销仅回退当前笔记历史，且外部模块无法修改快照内容。',
          },
          pitfalls: ['只扩大全局历史列表而未隔离外部模块读写权限'],
          marks: [
            { point: 'c1.k1', sentence: '使用 Memento 模式拆分角色：笔记编辑器是 Originator，负责创建与恢复状态快照。' },
            { point: 'c1.k2', sentence: '每篇笔记的撤销历史是 Caretaker，从不读取快照内容，仅按顺序保管快照。' },
            { point: 'c2.k1', sentence: '原方案中工具栏、同步和搜索都能修改共享历史，破坏了封装。' },
            { point: 'c2.k2', sentence: '改由按笔记有序保存不透明快照，解决连续撤销恢复成另一天版本的问题。' },
            { point: 'c3.k1', sentence: '假设每篇笔记保存的快照数量有上限为 50 份，避免内存无限增长。' },
          ],
        });
      }
    }

    if (
      task === 'card.help' ||
      s.includes('tutor') ||
      p.includes('解题启发') ||
      p.includes('深入讲解') ||
      p.includes('Caretaker') ||
      p.includes('conceptual hint') ||
      p.includes('solution reasoning')
    ) {
      const chunks = ['[AI 助教] ', 'Caretaker 维护快照历史，', 'Originator 创建并恢复快照。'];
      for (const chunk of chunks) {
        execution.signal?.throwIfAborted?.();
        execution.onOutput?.(chunk);
        await new Promise((r) => setImmediate(r));
      }
      return chunks.join('');
    }

    const fallback = JSON.stringify({ cards: [], status: 'ok' });
    execution.onOutput?.(fallback);
    return fallback;
  };
}

/** Pick an alphanumeric/CJK search token (>= 4 chars) from `text` that matches `searchFn`. */
async function pickMatchingQuery(text, searchFn) {
  const tokens = String(text || '')
    .replace(/[`*_#[\]().,:;!?'"<>]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !w.startsWith('/'));

  const sorted = [
    ...tokens.filter((w) => /^[A-Za-z][A-Za-z0-9_-]{4,}$/.test(w)),
    ...tokens.filter((w) => !/^[A-Za-z][A-Za-z0-9_-]{4,}$/.test(w)),
  ];

  for (const token of sorted) {
    const hit = await searchFn(token);
    if (hit) return token;
  }
  throw new Error(`Could not find a matching search query from text: ${String(text).slice(0, 120)}`);
}

async function mountSuiteApp(label, { autoLaunchpad = false } = {}) {
  resetDistStore('zh', false);
  const boxDir = await temps.make(label);
  const dshHome = join(boxDir, 'dsh-home');
  const libraryRoot = join(boxDir, 'library');
  process.env.DSH_HOME = dshHome;

  const host = await createTuiHost({
    env: { DSH_HOME: dshHome },
    home: join(boxDir, 'home'),
    libraryRoot,
    injectedComplete: createGroup1StubComplete(),
    skipAutoProbe: true,
    language: 'zh',
    eventDebounceMs: 30,
  });

  if (!autoLaunchpad) {
    const sampleRes = await host.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, `${label}: sample.load must succeed`);
  }

  const tty = createVirtualTty(120, 36);
  let inkInstance = null;
  inkInstance = render(
    React.createElement(StudyHubTuiApp, {
      host,
      autoLaunchpad,
      onExit: () => inkInstance?.unmount(),
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
  await tty.firstFramePromise;

  if (!autoLaunchpad) {
    await tty.waitFor(
      (s) =>
        s.includes('示例 · Memento 与 Bridge') &&
        !s.includes('正在打开学习库') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 12_000, label: `${label}: initial LibraryView` },
    );
    await tty.flush();
  }

  return {
    boxDir,
    dshHome,
    libraryRoot,
    host,
    tty,
    async dispose() {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during teardown
      }
      await host?.dispose();
      tty?.dispose();
      resetDistStore('zh', false);
    },
  };
}

describe('Round 8: Board Pomodoro, Backup Export & Feynman Retell', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r8', { autoLaunchpad: true });
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) Board Pomodoro Focus Timer (P / + / - / M / R)', async () => {
    const { tty } = ctx;
    const launchpad = await tty.waitFor(
      (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
      { label: 'Launchpad render' },
    );
    assert.ok(launchpad.includes('载入示例课程体验') || launchpad.includes('Load the sample course'));

    tty.send('s');
    const afterLoad = await tty.waitFor(
      (s) =>
        !s.includes('载入示例课程体验') &&
        (s.includes('示例 · Memento 与 Bridge') || s.includes('Sample · Memento')),
      { timeoutMs: 12_000, label: 'Library after sample load' },
    );
    assert.ok(afterLoad.includes('示例 · Memento 与 Bridge') || afterLoad.includes('Sample · Memento'));
    await tty.flush();

    tty.send('b');
    const boardInit = await tty.waitFor(
      (s) =>
        (s.includes('待办 Todo') || s.includes('Todo')) &&
        s.includes('25:00') &&
        s.includes('⏸') &&
        (s.includes('专注 Focus') || s.includes('Focus')),
      { timeoutMs: 8_000, label: 'Board initial render with PomodoroBar 25:00 paused' },
    );
    tty.assertHealthyScreen(boardInit, 120, 36, 'Board Pomodoro initial');
    assert.ok(boardInit.includes('25:00'), 'Board Pomodoro starts at 25:00');

    tty.send('+');
    const dur45 = await tty.waitFor((s) => s.includes('45:00') && s.includes('⏸'), {
      label: 'Pomodoro duration cycled to 45:00 via +',
    });
    tty.assertHealthyScreen(dur45, 120, 36, 'Board Pomodoro + (45:00)');
    assert.ok(dur45.includes('45:00'), 'Duration cycled to 45:00');

    tty.send('-');
    const dur25 = await tty.waitFor((s) => s.includes('25:00') && s.includes('⏸'), {
      label: 'Pomodoro duration cycled back to 25:00 via -',
    });
    tty.assertHealthyScreen(dur25, 120, 36, 'Board Pomodoro - (25:00)');

    tty.send('+');
    await tty.waitFor((s) => s.includes('45:00') && s.includes('⏸'), {
      label: 'Pomodoro duration back to 45:00',
    });

    tty.send('P');
    const runningScreen = await tty.waitFor(
      (s) => s.includes('▶') && (s.includes('专注 Focus') || s.includes('Focus')),
      { label: 'Pomodoro started (▶)' },
    );
    tty.assertHealthyScreen(runningScreen, 120, 36, 'Board Pomodoro running');

    const tickedScreen = await tty.waitFor(
      (s) => s.includes('▶') && (s.includes('44:59') || s.includes('44:58')),
      { timeoutMs: 4_000, label: 'Pomodoro countdown ticked from 45:00' },
    );
    tty.assertHealthyScreen(tickedScreen, 120, 36, 'Board Pomodoro ticked');
    assert.match(tickedScreen, /44:5[89]/, 'Countdown must tick down below 45:00');

    tty.send('P');
    const pausedScreen = await tty.waitFor((s) => s.includes('⏸') && !s.includes('▶'), {
      label: 'Pomodoro paused (⏸)',
    });
    tty.assertHealthyScreen(pausedScreen, 120, 36, 'Board Pomodoro paused');
    assert.ok(pausedScreen.includes('⏸'), 'Paused indicator ⏸ must appear');

    tty.send('M');
    const breakScreen = await tty.waitFor(
      (s) => (s.includes('短休') || s.includes('Break')) && s.includes('05:00') && s.includes('⏸'),
      { label: 'Pomodoro toggled to Break mode (05:00)' },
    );
    tty.assertHealthyScreen(breakScreen, 120, 36, 'Board Pomodoro break mode');
    assert.ok(breakScreen.includes('05:00'), 'Break mode must reset duration to 05:00');

    tty.send('P');
    const breakTicked = await tty.waitFor(
      (s) => s.includes('▶') && (s.includes('04:59') || s.includes('04:58')),
      { timeoutMs: 4_000, label: 'Break timer ticked to 04:59' },
    );
    assert.match(breakTicked, /04:5[89]/, 'Break timer must tick down from 05:00');

    tty.send('R');
    const resetScreen = await tty.waitFor(
      (s) => s.includes('05:00') && s.includes('⏸') && !s.includes('▶'),
      { label: 'Pomodoro reset to 05:00 paused via R' },
    );
    tty.assertHealthyScreen(resetScreen, 120, 36, 'Board Pomodoro reset');
    assert.ok(resetScreen.includes('05:00') && resetScreen.includes('⏸'), 'Reset returns to 05:00 paused');
  });

  test('2) Settings Workspace Library Backup Export (x)', async () => {
    const { tty, libraryRoot } = ctx;
    tty.send(',');
    const settingsInit = await tty.waitFor(
      (s) => (s.includes('模型配置') || s.includes('Models')) && (s.includes('学习库与工作区') || s.includes('Workspace')),
      { timeoutMs: 8_000, label: 'Settings view rendered' },
    );
    tty.assertHealthyScreen(settingsInit, 120, 36, 'Settings initial');
    assert.equal(useTuiStore.getState().page, 'settings', 'Comma key must open SettingsView');

    tty.send('2');
    const workspaceTab = await tty.waitFor(
      (s) =>
        (s.includes('学习库路径与工作区') || s.includes('Library Root & Workspace')) &&
        (s.includes('导出学习库备份') || s.includes('Export backup')),
      { timeoutMs: 8_000, label: 'Settings Workspace tab rendered' },
    );
    tty.assertHealthyScreen(workspaceTab, 120, 36, 'Settings Workspace tab');
    assert.ok(workspaceTab.includes('导出学习库备份') || workspaceTab.includes('Export backup'));

    const expectedStem = `studyhub-backup-${todayLocalYmd()}`;
    tty.send('x');
    const exportModal = await tty.waitFor(
      (s) =>
        (s.includes('导出学习库备份') || s.includes('Export Library Backup')) &&
        s.includes(expectedStem),
      { timeoutMs: 8_000, label: `Export Backup modal with ${expectedStem}` },
    );
    tty.assertHealthyScreen(exportModal, 120, 36, 'Export Backup modal');
    assert.ok(exportModal.includes(expectedStem), 'Export modal must prefill today backup stem');

    tty.send('\r');
    const afterExport = await tty.waitFor(
      (s) =>
        !s.includes('输入备份文件路径') &&
        !s.includes('Enter backup file path') &&
        (s.includes('已导出备份') || s.includes('Exported backup')),
      { timeoutMs: 10_000, label: 'Backup export success toast' },
    );
    tty.assertHealthyScreen(afterExport, 120, 36, 'Settings Workspace after export');
    assert.ok(afterExport.includes('已导出备份') || afterExport.includes('Exported backup'));

    const backupsDir = join(libraryRoot, 'backups');
    const backupFiles = await readdir(backupsDir);
    const backupRe = exportFilenameRegex('studyhub-backup', 'json', todayLocalYmd());
    const matchedFile = backupFiles.find((name) => backupRe.test(name));
    assert.ok(
      matchedFile,
      `Expected ${backupRe} in ${backupsDir}, found: ${JSON.stringify(backupFiles)}`,
    );
    const rawBackup = await readFile(join(backupsDir, matchedFile), 'utf8');
    const parsedBackup = JSON.parse(rawBackup);
    assert.ok(Array.isArray(parsedBackup.decks) && parsedBackup.decks.length > 0, 'Backup JSON must contain non-empty decks array');
    const totalCards = parsedBackup.decks.reduce(
      (sum, deck) => sum + (Array.isArray(deck?.cards) ? deck.cards.length : 0),
      0,
    );
    assert.ok(totalCards > 0, `Backup JSON decks must contain cards (got ${totalCards})`);
  });

  test('3) Review Feynman Retell (F)', async () => {
    const { tty } = ctx;
    tty.send('6');
    const dashScreen = await tty.waitFor(
      (s) => (s.includes('学习统计与掌握度') || s.includes('Stats')) && !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'Dashboard view before Library' },
    );
    tty.assertHealthyScreen(dashScreen, 120, 36, 'Dashboard view');

    tty.send('1');
    const libScreen = await tty.waitFor(
      (s) => (s.includes('题组列表') || s.includes('Decks')) && !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'Library view' },
    );
    tty.assertHealthyScreen(libScreen, 120, 36, 'Library view');

    tty.send('r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        (s.includes('[t]带学') || s.includes('[t]Guided') || s.includes('[F]复述') || s.includes('[F]Retell')) &&
        !s.includes('正在加载页面') &&
        !s.includes('正在准备复习队列'),
      { timeoutMs: 10_000, label: 'Review active card' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'Review initial card');

    tty.send('F');
    const retellOpen = await tty.waitFor(
      (s) =>
        (s.includes('用自己的话讲一遍') || s.includes('Feynman Retell')) &&
        (s.includes('用自己的话复述核心原理') || s.includes('Explain the core idea in your own words')),
      { timeoutMs: 8_000, label: 'RetellModal opened' },
    );
    tty.assertHealthyScreen(retellOpen, 120, 36, 'RetellModal input');

    const explanation = 'Memento captures state snapshots without breaking encapsulation.';
    tty.send(explanation);
    await tty.waitFor((s) => s.includes('Memento captures state snapshots'), {
      label: 'Explanation typed in RetellModal',
    });

    tty.send('\x13');
    const verdictScreen = await tty.waitFor(
      (s) =>
        (s.includes('通过 · Pass') || s.includes('+ Pass')) &&
        (s.includes('讲对了') || s.includes('What You Got Right')) &&
        s.includes('Accurately captured Memento') &&
        !s.includes('正在评估你的费曼复述'),
      { timeoutMs: 8_000, label: 'RetellModal verdict rendered' },
    );
    tty.assertHealthyScreen(verdictScreen, 120, 36, 'RetellModal verdict');
    assert.ok(verdictScreen.includes('Accurately captured Memento'), 'Verdict must show stub feedback');

    tty.send('\x1b');
    const reviewAfterClose = await tty.waitFor(
      (s) => !s.includes('用自己的话讲一遍') && !s.includes('Feynman Retell'),
      { timeoutMs: 8_000, label: 'RetellModal closed via Esc' },
    );
    tty.assertHealthyScreen(reviewAfterClose, 120, 36, 'Review after RetellModal closed');
  });
});

describe('Round 9: Ctrl+K Live Full-Text Search & Library DeckOpsModal', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r9');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) Ctrl+K Live Full-Text Search (card.search -> review, search.content -> sources reader, Esc close)', async () => {
    const { host, tty } = ctx;
    const snapRes = await host.refreshSnapshot();
    const decks = (snapRes.snapshot?.decks || []).filter((d) => !d.archived && !d.systemKind);
    assert.ok(decks.length > 0, 'Sample course must load at least one active deck');

    const deckDetailRes = await host.call('deck.get', { id: decks[0].id });
    assert.equal(deckDetailRes.ok, true, 'deck.get should succeed');
    const sampleCards = deckDetailRes.value?.cards || [];
    assert.ok(sampleCards.length > 0, 'Sample deck must contain cards');

    let cardQuery = '';
    let matchedCardPrompt = '';
    for (const card of sampleCards) {
      if (!card?.prompt) continue;
      try {
        cardQuery = await pickMatchingQuery(card.prompt, async (q) => {
          const res = await host.call('card.search', { query: q, limit: 6 });
          return Boolean(res.ok && res.value?.results?.length > 0);
        });
        matchedCardPrompt = String(card.prompt);
        break;
      } catch {
        // Try next card if no isolated token matched
      }
    }
    assert.ok(cardQuery.length >= 2, `Expected valid cardQuery >= 2 chars, got "${cardQuery}"`);

    const sourceListRes = await host.call('source.list', { limit: 20 });
    assert.equal(sourceListRes.ok, true, 'source.list should succeed');
    const sources = (sourceListRes.value?.sources || []).filter((s) => !s.archived);
    assert.ok(sources.length > 0, 'Sample course must load at least one active source');

    let sourceQuery = '';
    let matchedSourceTitle = '';
    for (const src of sources) {
      const srcGetRes = await host.call('source.get', { id: src.id, limit: 2000 });
      const text = srcGetRes.ok ? String(srcGetRes.value?.text || '') : '';
      if (!text) continue;
      try {
        sourceQuery = await pickMatchingQuery(text, async (q) => {
          const res = await host.call('search.content', { query: q, limit: 6, includeSample: true });
          const hits = res.value?.groups?.sources || res.value?.results?.filter((r) => r?.kind === 'source') || [];
          return Boolean(res.ok && hits.length > 0);
        });
        matchedSourceTitle = String(src.title || src.name || src.id);
        break;
      } catch {
        // Try next source
      }
    }
    assert.ok(sourceQuery.length >= 2, `Expected valid sourceQuery >= 2 chars, got "${sourceQuery}"`);

    tty.send('\x0b');
    const paletteEmpty = await tty.waitFor(
      (s) => s.includes('命令面板') || s.includes('Command Palette'),
      { label: 'CommandPalette opened via Ctrl+K' },
    );
    tty.assertHealthyScreen(paletteEmpty, 120, 36, 'CommandPalette initial');

    tty.send('\x1b');
    const paletteClosed = await tty.waitFor(
      (s) => !s.includes('命令面板') && !s.includes('Command Palette'),
      { label: 'CommandPalette closed via Esc' },
    );
    tty.assertHealthyScreen(paletteClosed, 120, 36, 'After CommandPalette Esc close');

    tty.send('\x0b');
    await tty.waitFor(
      (s) => s.includes('命令面板') || s.includes('Command Palette'),
      { label: 'CommandPalette reopened for card search' },
    );
    tty.send(cardQuery);
    const cardSearchScreen = await tty.waitFor(
      (s) =>
        (s.includes('题库') || s.includes('Card')) &&
        !s.includes('正在全文检索') &&
        !s.includes('Searching'),
      { timeoutMs: 8_000, label: `Live card hit for "${cardQuery}"` },
    );
    tty.assertHealthyScreen(cardSearchScreen, 120, 36, 'CommandPalette live card search');

    let selectedCardRow = false;
    for (let step = 0; step < 24; step += 1) {
      const lines = tty.readLines();
      if (lines.some((line) => /[│|]\s*(?:❯|>)\s/.test(line) && (line.includes('题库') || line.includes('Card')))) {
        selectedCardRow = true;
        break;
      }
      tty.send('\x1b[B');
      await tty.flush(20);
    }
    assert.ok(selectedCardRow, `Expected to highlight a live Card hit for "${cardQuery}":\n${tty.readScreen()}`);

    tty.send('\r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        !s.includes('Command Palette') &&
        !s.includes('正在加载页面') &&
        !s.includes('正在准备复习队列') &&
        (s.includes('[h]讲解') || s.includes('[h]Help')) &&
        (s.includes(cardQuery) || s.includes(matchedCardPrompt.slice(0, 12))),
      { timeoutMs: 10_000, label: 'Navigated to ReviewView with matched card rendered' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView from CommandPalette card hit');
    assert.equal(useTuiStore.getState().page, 'review', 'Selecting card hit must navigate to ReviewView');

    tty.send('\x0b');
    await tty.waitFor(
      (s) => s.includes('命令面板') || s.includes('Command Palette'),
      { label: 'CommandPalette opened for passage search' },
    );
    tty.send(sourceQuery);
    const passageSearchScreen = await tty.waitFor(
      (s) =>
        (s.includes('原文') || s.includes('Passage')) &&
        !s.includes('正在全文检索') &&
        !s.includes('Searching'),
      { timeoutMs: 8_000, label: `Live passage hit for "${sourceQuery}"` },
    );
    tty.assertHealthyScreen(passageSearchScreen, 120, 36, 'CommandPalette live passage search');

    let selectedPassageRow = false;
    for (let step = 0; step < 24; step += 1) {
      const lines = tty.readLines();
      if (lines.some((line) => /[│|]\s*(?:❯|>)\s/.test(line) && (line.includes('原文') || line.includes('Passage')))) {
        selectedPassageRow = true;
        break;
      }
      tty.send('\x1b[B');
      await tty.flush(20);
    }
    assert.ok(selectedPassageRow, `Expected to highlight a live Passage hit for "${sourceQuery}":\n${tty.readScreen()}`);

    tty.send('\r');
    const readerScreen = await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        !s.includes('Command Palette') &&
        !s.includes('正在加载页面') &&
        !s.includes('正在读取页面内容') &&
        (s.includes('第 ') || s.includes('P. ')) &&
        (s.includes('∑ Unicode') || s.includes('TeX')) &&
        (s.includes(matchedSourceTitle.slice(0, 10)) || s.includes(sourceQuery)),
      { timeoutMs: 10_000, label: 'Navigated to DocumentReader from live passage hit' },
    );
    tty.assertHealthyScreen(readerScreen, 120, 36, 'DocumentReader from CommandPalette passage hit');
    assert.ok(readerScreen.includes('第 ') || readerScreen.includes('P. '), 'DocumentReader must show page indicator');

    tty.send('\x1b');
    const sourcesBack = await tty.waitFor(
      (s) => s.includes('资料列表') || s.includes('Materials'),
      { timeoutMs: 8_000, label: 'Back to SourcesView from DocumentReader' },
    );
    assert.ok(sourcesBack.includes('资料列表') || sourcesBack.includes('Materials'));
  });

  test('2) Library DeckOpsModal [o]: JSON deck.import, topic deck.split, and deck.merge', async () => {
    const { boxDir, host, tty } = ctx;
    tty.send('1');
    const libInit = await tty.waitFor(
      (s) => (s.includes('题组列表') || s.includes('Decks')) && !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'LibraryView active' },
    );
    tty.assertHealthyScreen(libInit, 120, 36, 'LibraryView initial');

    const beforeSnap = await host.refreshSnapshot();
    const beforeDecks = beforeSnap.snapshot?.decks || [];
    const activeCourse = typeof beforeSnap.snapshot?.focus?.course === 'string' ? beforeSnap.snapshot.focus.course : '';

    const importTitle = 'Round9 Imported Deck';
    const splitTitle = 'Round9 Split Alpha';
    const jsonDeckPath = join(boxDir, 'round9-import-deck.json');
    const deckPayload = {
      title: importTitle,
      folder: 'Round9',
      ...(activeCourse ? { course: activeCourse } : {}),
      cards: [
        {
          kind: 'quiz',
          topic: 'Topic Alpha',
          objective: 'Understand Alpha Principle One',
          prompt: 'Which statement accurately describes Alpha Principle One?',
          answer: 'Alpha Principle One keeps state immutable.',
          hint: 'Think about snapshot safety and state mutations.',
          explanation: 'Immutable state prevents unintended side effects across callers.',
          misconception: 'Assuming Alpha Principle One mutates shared buffers in place.',
          options: [
            { id: 'a', text: 'Alpha Principle One keeps state immutable.', correct: true, explanation: 'Immutability avoids shared mutation bugs.' },
            { id: 'b', text: 'Alpha Principle One deletes previous logs.', correct: false, explanation: 'Logs are preserved rather than deleted.' },
            { id: 'c', text: 'Alpha Principle One disables validation.', correct: false, explanation: 'Validation remains active at all times.' },
          ],
        },
        {
          kind: 'quiz',
          topic: 'Topic Alpha',
          objective: 'Identify Alpha Principle Two usage',
          prompt: 'When should Alpha Principle Two be applied in practice?',
          answer: 'Apply Alpha Principle Two during boundary checks.',
          hint: 'Consider where untrusted external payloads enter the module.',
          explanation: 'Boundary checks validate inputs before internal processing begins.',
          misconception: 'Applying Alpha Principle Two only after persistence succeeds.',
          options: [
            { id: 'a', text: 'Apply Alpha Principle Two during boundary checks.', correct: true, explanation: 'Boundaries catch malformed payloads early.' },
            { id: 'b', text: 'Apply Alpha Principle Two inside CSS themes.', correct: false, explanation: 'Styling layers do not govern data boundaries.' },
            { id: 'c', text: 'Apply Alpha Principle Two only during shutdown.', correct: false, explanation: 'Waiting until shutdown skips runtime checks.' },
          ],
        },
        {
          kind: 'quiz',
          topic: 'Topic Beta',
          objective: 'Explain Beta Mechanism Core',
          prompt: 'What is the primary goal of the Beta Mechanism?',
          answer: 'Beta Mechanism decouples producers from consumers.',
          hint: 'Focus on how two subsystems communicate without direct references.',
          explanation: 'Decoupling allows producers and consumers to evolve independently.',
          misconception: 'Assuming Beta Mechanism merges all modules into one file.',
          options: [
            { id: 'a', text: 'Beta Mechanism decouples producers from consumers.', correct: true, explanation: 'Independent evolution relies on decoupling.' },
            { id: 'b', text: 'Beta Mechanism hardcodes database credentials.', correct: false, explanation: 'Credentials should never be hardcoded.' },
            { id: 'c', text: 'Beta Mechanism bypasses asynchronous queues.', correct: false, explanation: 'Queues remain supported for async workflows.' },
          ],
        },
        {
          kind: 'quiz',
          topic: 'Topic Beta',
          objective: 'Contrast Beta Strategy Tradeoff',
          prompt: 'Which tradeoff is characteristic of the Beta Strategy?',
          answer: 'Higher indirection in exchange for modularity.',
          hint: 'Compare extra abstraction layers against flexibility benefits.',
          explanation: 'Adding an abstraction layer increases indirection while improving modularity.',
          misconception: 'Believing Beta Strategy removes all abstraction layers.',
          options: [
            { id: 'a', text: 'Higher indirection in exchange for modularity.', correct: true, explanation: 'Modularity often introduces a thin indirection layer.' },
            { id: 'b', text: 'Zero memory allocation at runtime.', correct: false, explanation: 'Objects and adapters still allocate memory.' },
            { id: 'c', text: 'Single-threaded blocking I/O only.', correct: false, explanation: 'Beta Strategy works with non-blocking flows.' },
          ],
        },
      ],
    };
    await writeFile(jsonDeckPath, JSON.stringify(deckPayload, null, 2), 'utf8');

    tty.send('o');
    const opsImportOpen = await tty.waitFor(
      (s) => s.includes('题组操作中心') || s.includes('Deck Operations'),
      { timeoutMs: 8_000, label: 'DeckOpsModal opened on Tab 1 (Import)' },
    );
    tty.assertHealthyScreen(opsImportOpen, 120, 36, 'DeckOpsModal Tab 1 Import');

    tty.send(jsonDeckPath);
    await tty.waitFor(
      (s) =>
        s.includes(importTitle) &&
        (s.includes('4 题') || s.includes('4 cards') || s.includes('4c')),
      { timeoutMs: 8_000, label: 'DeckOpsModal JSON preview validated' },
    );

    tty.send('\r');
    const afterImportScreen = await tty.waitFor(
      (s) =>
        !s.includes('题组操作中心') &&
        !s.includes('Deck Operations') &&
        s.includes(importTitle),
      { timeoutMs: 10_000, label: 'DeckOpsModal closed after import & imported deck visible' },
    );
    tty.assertHealthyScreen(afterImportScreen, 120, 36, 'LibraryView after deck.import');

    const afterImportSnap = await host.refreshSnapshot();
    const afterImportDecks = afterImportSnap.snapshot?.decks || [];
    assert.equal(
      afterImportDecks.length,
      beforeDecks.length + 1,
      `Decks count should increase by 1 (${beforeDecks.length} -> ${afterImportDecks.length})`,
    );
    const importedDeck = afterImportDecks.find((d) => d.title === importTitle);
    assert.ok(importedDeck, `Expected "${importTitle}" in snapshot decks`);

    let selectedImported = false;
    for (let i = 0; i < afterImportDecks.length + 2; i += 1) {
      const screen = tty.readScreen();
      if (screen.includes('Topic Alpha') && screen.includes('Topic Beta') && screen.includes(importTitle)) {
        selectedImported = true;
        break;
      }
      tty.send('\x1b[B');
      await tty.flush(25);
    }
    assert.ok(selectedImported, `Expected to select "${importTitle}" in LibraryView:\n${tty.readScreen()}`);

    tty.send('o');
    await tty.waitFor(
      (s) => (s.includes('题组操作中心') || s.includes('Deck Operations')) && s.includes(importTitle),
      { timeoutMs: 8_000, label: 'DeckOpsModal reopened for split' },
    );

    tty.send('\x1b[A');
    await tty.flush(20);
    tty.send('3');

    const splitTabScreen = await tty.waitFor(
      (s) =>
        s.includes('Topic Alpha') &&
        s.includes('Topic Beta') &&
        !s.includes('正在读取题组主题') &&
        !s.includes('Loading deck topics'),
      { timeoutMs: 8_000, label: 'DeckOpsModal Tab 3 Split topics loaded' },
    );
    tty.assertHealthyScreen(splitTabScreen, 120, 36, 'DeckOpsModal Tab 3 Split');

    tty.send(' ');
    const topicToggledScreen = await tty.waitFor(
      (s) =>
        (s.includes('[✓] Topic Alpha') || s.includes('[x] Topic Alpha')) &&
        (s.includes('拆出: 2/4') || s.includes('Move: 2/4')),
      { timeoutMs: 8_000, label: 'Topic Alpha toggled via Space (2/4 cards)' },
    );
    tty.assertHealthyScreen(topicToggledScreen, 120, 36, 'DeckOpsModal Tab 3 Topic toggled');

    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes(`${importTitle} - Topic Alpha`),
      { timeoutMs: 8_000, label: 'Split title input focused with prefilled name' },
    );
    tty.send('\x15');
    await tty.flush();
    tty.send(splitTitle);
    await tty.waitFor(
      (s) => s.includes(splitTitle) && !s.includes(`${importTitle} - Topic Alpha`),
      { timeoutMs: 8_000, label: 'Custom split title typed' },
    );

    tty.send('\r');
    const splitConfirmScreen = await tty.waitFor(
      (s) => (s.includes('确认拆分题组') || s.includes('Confirm Split Deck')) && s.includes(splitTitle),
      { timeoutMs: 8_000, label: 'Confirm Split Deck dialog rendered' },
    );
    tty.assertHealthyScreen(splitConfirmScreen, 120, 36, 'DeckOpsModal Split ConfirmDialog');

    tty.send('y');
    const afterSplitScreen = await tty.waitFor(
      (s) => !s.includes('题组操作中心') && !s.includes('Deck Operations') && s.includes(splitTitle),
      { timeoutMs: 10_000, label: 'DeckOpsModal closed after deck.split' },
    );
    tty.assertHealthyScreen(afterSplitScreen, 120, 36, 'LibraryView after deck.split');

    const afterSplitSnap = await host.refreshSnapshot();
    const afterSplitDecks = afterSplitSnap.snapshot?.decks || [];
    assert.equal(
      afterSplitDecks.length,
      afterImportDecks.length + 1,
      `Decks count should increase by 1 after split (${afterImportDecks.length} -> ${afterSplitDecks.length})`,
    );
    const createdSplitDeck = afterSplitDecks.find((d) => d.title === splitTitle);
    assert.ok(createdSplitDeck, `Expected split deck "${splitTitle}" in snapshot`);

    const splitDeckGet = await host.call('deck.get', { id: createdSplitDeck.id });
    assert.equal(splitDeckGet.ok, true);
    assert.equal(splitDeckGet.value?.cards?.length, 2, 'Split deck should contain 2 cards');
    assert.ok(
      splitDeckGet.value.cards.every((c) => c.topic === 'Topic Alpha'),
      'Split deck cards should all belong to Topic Alpha',
    );

    const sourceDeckGet = await host.call('deck.get', { id: importedDeck.id });
    assert.equal(sourceDeckGet.ok, true);
    assert.equal(sourceDeckGet.value?.cards?.length, 2, 'Source deck should retain 2 remaining cards');
    assert.ok(
      sourceDeckGet.value.cards.every((c) => c.topic === 'Topic Beta'),
      'Source deck remaining cards should all belong to Topic Beta',
    );

    const mergeCandidates = afterSplitDecks
      .filter((d) => d.id !== importedDeck.id && !d.archived && !d.systemKind)
      .sort((a, b) => {
        const selCourse = importedDeck.course ?? '';
        const aSame = (a.course ?? '') === selCourse ? 0 : 1;
        const bSame = (b.course ?? '') === selCourse ? 0 : 1;
        if (aSame !== bSame) return aSame - bSame;
        return String(a.title ?? a.name ?? a.id).localeCompare(String(b.title ?? b.name ?? b.id));
      });
    const targetMergeIdx = mergeCandidates.findIndex((d) => d.id === createdSplitDeck.id);
    assert.ok(targetMergeIdx >= 0, 'Split deck must appear in mergeCandidates');

    tty.send('o');
    await tty.waitFor(
      (s) => s.includes('题组操作中心') || s.includes('Deck Operations'),
      { timeoutMs: 8_000, label: 'DeckOpsModal reopened for merge' },
    );

    tty.send('\x1b[A');
    await tty.flush(20);
    tty.send('2');

    const mergeTabScreen = await tty.waitFor(
      (s) =>
        (s.includes('并入下方所选目标题组') || s.includes('into selected target')) &&
        s.includes(splitTitle),
      { timeoutMs: 8_000, label: 'DeckOpsModal Tab 2 Merge rendered' },
    );
    tty.assertHealthyScreen(mergeTabScreen, 120, 36, 'DeckOpsModal Tab 2 Merge');

    for (let step = 0; step < targetMergeIdx; step += 1) {
      tty.send('\x1b[B');
      await tty.flush(20);
    }

    tty.send('\r');
    const mergeConfirmScreen = await tty.waitFor(
      (s) =>
        (s.includes('确认合并题组') || s.includes('Confirm Merge Decks')) &&
        s.includes(importTitle) &&
        s.includes(splitTitle),
      { timeoutMs: 8_000, label: 'Confirm Merge Decks dialog rendered' },
    );
    tty.assertHealthyScreen(mergeConfirmScreen, 120, 36, 'DeckOpsModal Merge ConfirmDialog');

    tty.send('y');
    const afterMergeScreen = await tty.waitFor(
      (s) => !s.includes('题组操作中心') && !s.includes('Deck Operations'),
      { timeoutMs: 10_000, label: 'DeckOpsModal closed after deck.merge' },
    );
    tty.assertHealthyScreen(afterMergeScreen, 120, 36, 'LibraryView after deck.merge');

    const afterMergeSnap = await host.refreshSnapshot();
    const afterMergeDecks = afterMergeSnap.snapshot?.decks || [];
    assert.equal(
      afterMergeDecks.length,
      afterSplitDecks.length - 1,
      `Decks count should decrease by 1 after merge (${afterSplitDecks.length} -> ${afterMergeDecks.length})`,
    );
    assert.equal(
      afterMergeDecks.some((d) => d.id === importedDeck.id),
      false,
      'Source deck should be removed after merging into target',
    );
    const mergedTarget = afterMergeDecks.find((d) => d.id === createdSplitDeck.id);
    assert.ok(mergedTarget, 'Target deck must exist after merge');
    const mergedTargetGet = await host.call('deck.get', { id: mergedTarget.id });
    assert.equal(mergedTargetGet.ok, true);
    assert.equal(mergedTargetGet.value?.cards?.length, 4, 'Merged target deck should contain all 4 cards');
  });
});

describe('Round 11: Review Mastery, Guided Study, Exam Alignment & BookCrunch', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r11');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) Review Mastery (* Focus toggle, D CardTools terms, h->s Follow-up chips, L Socratic TeachModal)', async () => {
    const { tty } = ctx;
    tty.send('\r');
    const reviewInit = await tty.waitFor(
      (s) =>
        (s.includes('[D]工具') || s.includes('[D]Tools')) &&
        (s.includes('[t]带学') || s.includes('[t]Guided') || s.includes('[L]带学') || s.includes('[L]Teach')) &&
        !s.includes('正在准备复习队列'),
      { timeoutMs: 10_000, label: 'Review active card rendered' },
    );
    tty.assertHealthyScreen(reviewInit, 120, 36, 'Review initial card');
    assert.equal(useTuiStore.getState().page, 'review', 'Enter must open ReviewView');

    tty.send('*');
    const focusOnScreen = await tty.waitFor(
      (s) => s.includes('★ 重点') || s.includes('* Focus') || s.includes('* 重点'),
      { timeoutMs: 8_000, label: 'Focus badge toggled on' },
    );
    tty.assertHealthyScreen(focusOnScreen, 120, 36, 'Review Focus badge ON');
    assert.ok(focusOnScreen.includes('★ 重点') || focusOnScreen.includes('* Focus') || focusOnScreen.includes('* 重点'));

    tty.send('*');
    const focusOffScreen = await tty.waitFor(
      (s) => !s.includes('★ 重点') && !s.includes('* Focus') && !s.includes('* 重点'),
      { timeoutMs: 8_000, label: 'Focus badge toggled off' },
    );
    tty.assertHealthyScreen(focusOffScreen, 120, 36, 'Review Focus badge OFF');
    assert.ok(!focusOffScreen.includes('★ 重点') && !focusOffScreen.includes('* Focus'));

    tty.send('*');
    await tty.waitFor(
      (s) => s.includes('★ 重点') || s.includes('* Focus') || s.includes('* 重点'),
      { timeoutMs: 8_000, label: 'Focus badge toggled back on' },
    );

    tty.send('D');
    const toolsMenu = await tty.waitFor(
      (s) =>
        (s.includes('题目工具箱') || s.includes('Card Tools')) &&
        (s.includes('提取核心术语') || s.includes('Extract Technical Terms')),
      { timeoutMs: 8_000, label: 'CardToolsModal menu opened' },
    );
    tty.assertHealthyScreen(toolsMenu, 120, 36, 'CardToolsModal menu');
    assert.ok(toolsMenu.includes('题目工具箱') || toolsMenu.includes('Card Tools'));

    tty.send('6');
    const termsScreen = await tty.waitFor(
      (s) =>
        (s.includes('核心术语 / 生词提取') || s.includes('Technical Terms')) &&
        !s.includes('共 0 项') &&
        !s.includes('0 terms') &&
        !s.includes('正在提取本题核心专业术语'),
      { timeoutMs: 8_000, label: 'CardToolsModal extracted terms rendered' },
    );
    tty.assertHealthyScreen(termsScreen, 120, 36, 'CardToolsModal terms');
    assert.ok(termsScreen.includes('Memento') || termsScreen.includes('Bridge'), 'Extracted terms must include card terms');

    tty.send('\x1b');
    await tty.waitFor((s) => s.includes('编辑题目') || s.includes('Edit Question'), {
      timeoutMs: 8_000,
      label: 'CardToolsModal returned to menu',
    });
    tty.send('\x1b');
    await tty.waitFor((s) => !s.includes('题目工具箱') && !s.includes('Card Tools'), {
      timeoutMs: 8_000,
      label: 'CardToolsModal closed',
    });

    tty.send('h');
    const drawerReady = await tty.waitFor(
      (s) =>
        (s.includes('AI 帮我理解') || s.includes('AI Tutor')) &&
        (s.includes('已就绪') || s.includes('Ready')) &&
        s.includes('Caretaker 维护快照历史'),
      { timeoutMs: 8_000, label: 'AiHelpDrawer opened and initial stream finished' },
    );
    tty.assertHealthyScreen(drawerReady, 120, 36, 'AiHelpDrawer initial');
    assert.ok(drawerReady.includes('Caretaker 维护快照历史'), 'AiHelpDrawer must stream initial explanation');

    tty.send('s');
    const chipsScreen = await tty.waitFor(
      (s) =>
        s.includes('[1]') &&
        s.includes('Caretaker 为何不能读取快照内容？') &&
        !s.includes('正在生成推荐追问'),
      { timeoutMs: 8_000, label: 'AiHelpDrawer suggested follow-up chips rendered' },
    );
    tty.assertHealthyScreen(chipsScreen, 120, 36, 'AiHelpDrawer chips');
    assert.ok(chipsScreen.includes('Caretaker 为何不能读取快照内容？'), 'Suggested follow-up chip 1 must render');

    tty.send('1');
    const afterChipAsk = await tty.waitFor(
      (s) =>
        (s.includes('你: Caretaker 为何不能读取快照内容') || s.includes('You: Caretaker')) &&
        (s.includes('已就绪') || s.includes('Ready')) &&
        !s.includes('正在流式生成'),
      { timeoutMs: 8_000, label: 'AiHelpDrawer chip 1 answered' },
    );
    tty.assertHealthyScreen(afterChipAsk, 120, 36, 'AiHelpDrawer after chip 1');
    assert.ok(afterChipAsk.includes('Caretaker 维护快照历史'), 'Follow-up chip response must stream');

    tty.send('\x1b');
    const reviewAfterDrawer = await tty.waitFor(
      (s) => !s.includes('AI 帮我理解') && !s.includes('AI Tutor'),
      { timeoutMs: 8_000, label: 'AiHelpDrawer closed' },
    );
    await tty.flush();
    assert.ok(
      reviewAfterDrawer.includes('[t]带学') || reviewAfterDrawer.includes('[t]Guided') || reviewAfterDrawer.includes('[L]带学') || reviewAfterDrawer.includes('[L]Teach'),
      `Expected to remain in ReviewView after closing AiHelpDrawer, got:\n${reviewAfterDrawer}`,
    );

    if (
      reviewAfterDrawer.includes('翻开答案') ||
      reviewAfterDrawer.includes('翻卡') ||
      reviewAfterDrawer.includes('flip card') ||
      reviewAfterDrawer.includes('Flip')
    ) {
      tty.send(' ');
      await tty.waitFor((s) => s.includes('FSRS-6') || s.includes('1-4'), {
        timeoutMs: 8_000,
        label: 'Flashcard flipped for rating',
      });
      await tty.flush();
      tty.send('2');
    } else if (reviewAfterDrawer.includes('填空') || reviewAfterDrawer.includes('Type')) {
      tty.send('i');
      await tty.flush();
      tty.send('Originator');
      await tty.flush();
      tty.send('\r');
    } else {
      tty.send('1');
    }
    await tty.waitFor(
      (s) =>
        s.includes('回答正确') ||
        s.includes('Correct') ||
        s.includes('回答有误') ||
        s.includes('Incorrect') ||
        s.includes('已自报') ||
        s.includes('Self-reported'),
      { timeoutMs: 8_000, label: 'Card answered before TeachModal' },
    );

    tty.send('t');
    const teachOpen = await tty.waitFor(
      (s) =>
        (s.includes('苏格拉底带学') || s.includes('Socratic Teach')) &&
        (s.includes('第 1/2 步') || s.includes('Step 1/2')) &&
        s.includes('Originator 拥有内部状态'),
      { timeoutMs: 8_000, label: 'Unified Guided Study opened with Step 1/2' },
    );
    tty.assertHealthyScreen(teachOpen, 120, 36, 'Unified Guided Study Step 1');

    tty.send('Caretaker');
    await tty.waitFor((s) => s.includes('Caretaker'), {
      timeoutMs: 4_000,
      label: 'Answer typed in Guided Study',
    });
    tty.send('\r');
    const teachUpdated = await tty.waitFor(
      (s) =>
        s.includes('回答正确') &&
        (s.includes('第 2/2 步') || s.includes('Step 2/2')),
      { timeoutMs: 8_000, label: 'Guided Study updated after teach.answer' },
    );
    tty.assertHealthyScreen(teachUpdated, 120, 36, 'Unified Guided Study Step 2');
    assert.ok(teachUpdated.includes('第 2/2 步') || teachUpdated.includes('Step 2/2'), 'Guided Study must advance to Step 2/2');

    // Esc 1: blur input; Ctrl+G toggles docked assistant closed cleanly back to ReviewView
    tty.send('\x1b');
    await new Promise((r) => setTimeout(r, 80));
    tty.send('\x07');
    const reviewAfterTeach = await tty.waitFor(
      (s) => !s.includes('苏格拉底带学') && !s.includes('Socratic Teach'),
      { timeoutMs: 8_000, label: 'Guided Study closed back to Review' },
    );
    tty.assertHealthyScreen(reviewAfterTeach, 120, 36, 'Review after Guided Study closed');
  });

  test('2) AI Guided Study Workbench (g in LibraryView: create -> pause -> resume -> end -> Esc)', async () => {
    const { tty } = ctx;
    // Leave ReviewView first (digits 0-9 are claimed inside ReviewView per #1351)
    tty.send(']');
    await tty.waitFor((s) => !s.includes('按?看全部'), { timeoutMs: 4_000, label: 'Left ReviewView' });
    tty.send('1');
    const libScreen = await tty.waitFor(
      (s) => (s.includes('题组列表') || s.includes('Decks')) && !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'LibraryView rendered' },
    );
    tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView before GuidedStudyModal');

    tty.send('g');
    const guidedOpen = await tty.waitFor(
      (s) =>
        (s.includes('AI 带学工作台') || s.includes('Guided Study Workbench')) &&
        !s.includes('正在读取带学工作台'),
      { timeoutMs: 8_000, label: 'GuidedStudyModal opened' },
    );
    tty.assertHealthyScreen(guidedOpen, 120, 36, 'GuidedStudyModal initial');

    tty.send('n');
    await tty.waitFor((s) => s.includes('新目标:') || s.includes('Goal:'), {
      timeoutMs: 8_000,
      label: 'GuidedStudyModal create input visible',
    });

    const goalTitle = 'Master Memento Round 11';
    tty.send('\x15');
    await tty.flush();
    tty.send(goalTitle);
    await tty.waitFor((s) => s.includes(goalTitle), {
      timeoutMs: 5_000,
      label: 'GuidedStudyModal goal title typed',
    });
    tty.send('\r');

    const createdScreen = await tty.waitFor(
      (s) => s.includes(goalTitle) && (s.includes('进行中') || s.includes('Active')) && !s.includes('新目标:'),
      { timeoutMs: 8_000, label: 'GuidedStudyModal new active session rendered' },
    );
    tty.assertHealthyScreen(createdScreen, 120, 36, 'GuidedStudyModal active session');
    assert.ok(createdScreen.includes(goalTitle), 'Created session goal must render');

    tty.send('p');
    const pausedScreen = await tty.waitFor(
      (s) => s.includes(goalTitle) && (s.includes('已暂停') || s.includes('Paused')),
      { timeoutMs: 8_000, label: 'GuidedStudyModal session paused' },
    );
    tty.assertHealthyScreen(pausedScreen, 120, 36, 'GuidedStudyModal paused session');
    assert.ok(pausedScreen.includes('已暂停') || pausedScreen.includes('Paused'));

    tty.send('r');
    const resumedScreen = await tty.waitFor(
      (s) => s.includes(goalTitle) && (s.includes('进行中') || s.includes('Active')),
      { timeoutMs: 8_000, label: 'GuidedStudyModal session resumed' },
    );
    tty.assertHealthyScreen(resumedScreen, 120, 36, 'GuidedStudyModal resumed session');
    assert.ok(resumedScreen.includes('进行中') || resumedScreen.includes('Active'));

    tty.send('e');
    const endConfirm = await tty.waitFor(
      (s) => s.includes('结束带学会话') || s.includes('End Guided Study Session'),
      { timeoutMs: 8_000, label: 'GuidedStudyModal end confirmation dialog' },
    );
    tty.assertHealthyScreen(endConfirm, 120, 36, 'GuidedStudyModal end ConfirmDialog');

    tty.send('y');
    const endedScreen = await tty.waitFor(
      (s) => s.includes(goalTitle) && (s.includes('已结束') || s.includes('Ended')) && !s.includes('结束带学会话'),
      { timeoutMs: 8_000, label: 'GuidedStudyModal session ended' },
    );
    tty.assertHealthyScreen(endedScreen, 120, 36, 'GuidedStudyModal ended session');
    assert.ok(endedScreen.includes('已结束') || endedScreen.includes('Ended'));

    tty.send('\x1b');
    const libAfterGuided = await tty.waitFor(
      (s) => !s.includes('AI 带学工作台') && !s.includes('Guided Study Workbench'),
      { timeoutMs: 8_000, label: 'GuidedStudyModal closed via Esc' },
    );
    tty.assertHealthyScreen(libAfterGuided, 120, 36, 'LibraryView after GuidedStudyModal closed');
  });

  test('3) CourseSettings Exam Alignment Tab 4 (C -> 4 -> a) & BookView Final-Week Crunch (7 -> w)', async () => {
    const { tty } = ctx;
    tty.send('C');
    const settingsOpen = await tty.waitFor(
      (s) => (s.includes('课程设置与学法') || s.includes('Course Settings')) && !s.includes('正在读取课程配置'),
      { timeoutMs: 8_000, label: 'CourseSettingsModal opened' },
    );
    tty.assertHealthyScreen(settingsOpen, 120, 36, 'CourseSettingsModal Tab 1');

    tty.send('4');
    const alignScreen = await tty.waitFor(
      (s) =>
        (s.includes('考前对齐') || s.includes('Exam Align')) &&
        (s.includes('重点掌握度') || s.includes('Focus Mastery')) &&
        !s.includes('正在读取考前对齐与重点进度'),
      { timeoutMs: 8_000, label: 'CourseSettingsModal Tab 4 Exam Alignment rendered' },
    );
    tty.assertHealthyScreen(alignScreen, 120, 36, 'CourseSettingsModal Tab 4');

    const wasEnabled = alignScreen.includes('考前对齐: 已开启') || alignScreen.includes('Exam Align: ON');

    tty.send('a');
    const toggledAlignScreen = await tty.waitFor(
      (s) =>
        wasEnabled
          ? s.includes('考前对齐: 已关闭') || s.includes('Exam Align: OFF')
          : s.includes('考前对齐: 已开启') || s.includes('Exam Align: ON'),
      { timeoutMs: 8_000, label: 'CourseSettingsModal Tab 4 alignment toggled' },
    );
    tty.assertHealthyScreen(toggledAlignScreen, 120, 36, 'CourseSettingsModal Tab 4 toggled');
    assert.notEqual(
      toggledAlignScreen.includes('考前对齐: 已开启') || toggledAlignScreen.includes('Exam Align: ON'),
      wasEnabled,
      'Exam alignment state must flip on [a]',
    );

    tty.send('\x1b');
    await tty.waitFor((s) => !s.includes('课程设置与学法') && !s.includes('Course Settings'), {
      timeoutMs: 8_000,
      label: 'CourseSettingsModal closed via Esc',
    });

    tty.send('7');
    const bookScreen = await tty.waitFor(
      (s) =>
        (s.includes('Math: Unicode') ||
          s.includes('Math: LaTeX') ||
          s.includes('这门课还没有复习全书') ||
          s.includes('章节目录')) &&
        !s.includes('正在打开复习全书') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'BookView rendered' },
    );
    await tty.flush();
    tty.assertHealthyScreen(bookScreen, 120, 36, 'BookView initial');

    tty.send('w');
    const crunchWide = await tty.waitFor(
      (s) =>
        (s.includes('期末一周冲刺') || s.includes('Final Week Crunch')) &&
        !s.includes('正在载入期末一周日程与模拟卷'),
      { timeoutMs: 8_000, label: 'BookCrunchModal opened at 120x36' },
    );
    tty.assertHealthyScreen(crunchWide, 120, 36, 'BookCrunchModal 120x36');
    assert.ok(crunchWide.includes('期末一周冲刺') || crunchWide.includes('Final Week Crunch'));

    tty.resize(80, 24);
    const crunchNarrow = await tty.waitFor(
      (s) => (s.includes('期末一周冲刺') || s.includes('Final Week Crunch')) && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'BookCrunchModal resized to 80x24' },
    );
    tty.assertHealthyScreen(crunchNarrow, 80, 24, 'BookCrunchModal 80x24');
    assert.ok(crunchNarrow.split('\n').length <= 24, 'Narrow crunch modal fits 24 rows');

    tty.resize(120, 36);
    await tty.waitFor((s) => s.includes('期末一周冲刺') || s.includes('Final Week Crunch'), {
      timeoutMs: 8_000,
      label: 'BookCrunchModal restored to 120x36',
    });

    tty.send('\x1b');
    const bookAfterClose = await tty.waitFor(
      (s) => !s.includes('期末一周冲刺') && !s.includes('Final Week Crunch'),
      { timeoutMs: 8_000, label: 'BookCrunchModal closed via Esc' },
    );
    tty.assertHealthyScreen(bookAfterClose, 120, 36, 'BookView after BookCrunchModal closed');
    assert.ok(!bookAfterClose.includes('期末一周冲刺') && !bookAfterClose.includes('Final Week Crunch'));
  });
});

describe('Round 12: Sources Organize/Coverage, DraftEditor Similar/Repair & DeckManage Convert/Supplement', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r12');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) Sources AI Organize ([G]) & Citation/Section Coverage ([V] at 120x36 and 80x24)', async () => {
    const { tty } = ctx;
    tty.send('2');
    const sourcesScreen = await tty.waitFor(
      (s) =>
        (s.includes('示例 · 设计模式讲义') || s.includes('Sample · Design Patterns')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'SourcesView rendered with sample material' },
    );
    tty.assertHealthyScreen(sourcesScreen, 120, 36, 'SourcesView initial');
    assert.equal(useTuiStore.getState().page, 'sources', 'Key 2 must navigate to SourcesView');

    tty.send('V');
    const covWide = await tty.waitFor(
      (s) =>
        (s.includes('资料引用与章节覆盖率') || s.includes('Source Coverage')) &&
        !s.includes('正在统计章节与引用覆盖率') &&
        (s.includes('章节') || s.includes('Sections') || s.includes('直接引用来源') || s.includes('Direct cited')),
      { timeoutMs: 8_000, label: 'SourceCoverageModal rendered at 120x36' },
    );
    tty.assertHealthyScreen(covWide, 120, 36, 'SourceCoverageModal 120x36');
    assert.ok(covWide.includes('资料引用与章节覆盖率') || covWide.includes('Source Coverage'));

    tty.resize(80, 24);
    const covNarrow = await tty.waitFor(
      (s) => (s.includes('资料引用与章节覆盖率') || s.includes('Source Coverage')) && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'SourceCoverageModal resized to 80x24' },
    );
    tty.assertHealthyScreen(covNarrow, 80, 24, 'SourceCoverageModal 80x24');
    assert.ok(covNarrow.split('\n').length <= 24, 'SourceCoverageModal fits 80x24');

    tty.resize(120, 36);
    await tty.waitFor((s) => s.includes('资料引用与章节覆盖率') || s.includes('Source Coverage'), {
      timeoutMs: 8_000,
      label: 'SourceCoverageModal restored to 120x36',
    });
    tty.send('\x1b');
    const afterCovClose = await tty.waitFor(
      (s) => !s.includes('资料引用与章节覆盖率') && !s.includes('Source Coverage'),
      { timeoutMs: 8_000, label: 'SourceCoverageModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterCovClose, 120, 36, 'SourcesView after SourceCoverageModal');

    tty.send('G');
    const confirmOrgScreen = await tty.waitFor(
      (s) =>
        (s.includes('AI 分析资料所属课程') || s.includes('AI Organize Materials by Course')) &&
        (s.includes('将分析') || s.includes('Analyze ')),
      { timeoutMs: 8_000, label: 'OrganizeSourcesModal P2 ConfirmDialog' },
    );
    tty.assertHealthyScreen(confirmOrgScreen, 120, 36, 'OrganizeSourcesModal P2 ConfirmDialog');
    assert.ok(confirmOrgScreen.includes('AI 分析资料所属课程') || confirmOrgScreen.includes('AI Organize Materials by Course'));

    tty.send('y');
    const organizeScreen = await tty.waitFor(
      (s) =>
        (s.includes('AI 智能整理课程归属') || s.includes('AI Organize Courses')) &&
        !s.includes('正在分析') &&
        (s.includes('建议 ') ||
          s.includes('Proposals ') ||
          s.includes('暂无课程整理建议') ||
          s.includes('No organization suggestions')),
      { timeoutMs: 8_000, label: 'OrganizeSourcesModal rendered proposals' },
    );
    tty.assertHealthyScreen(organizeScreen, 120, 36, 'OrganizeSourcesModal');
    assert.ok(organizeScreen.includes('AI 智能整理课程归属') || organizeScreen.includes('AI Organize Courses'));

    tty.send('\x1b');
    const afterOrgClose = await tty.waitFor(
      (s) => !s.includes('AI 智能整理课程归属') && !s.includes('AI Organize Courses'),
      { timeoutMs: 8_000, label: 'OrganizeSourcesModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterOrgClose, 120, 36, 'SourcesView after OrganizeSourcesModal');
    assert.ok(!afterOrgClose.includes('AI 智能整理课程归属') && !afterOrgClose.includes('AI Organize Courses'));
  });

  test('2) DraftEditor Similar Check ([S]) & Repair ([R])', async () => {
    const { tty } = ctx;
    tty.send('1');
    const libScreen = await tty.waitFor(
      (s) => (s.includes('示例草稿 · 选对设计模式') || s.includes('Sample Draft')) && !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'LibraryView with sample draft' },
    );
    tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView before opening draft');

    tty.send('\t');
    await tty.flush();
    tty.send('\r');

    const editorScreen = await tty.waitFor(
      (s) =>
        (s.includes('示例草稿 · 选对设计模式') || s.includes('Sample Draft')) &&
        (s.includes('[S] 查重') || s.includes('[S] Similar')) &&
        (s.includes('题目列表  3') || s.includes('Questions  3')) &&
        !s.includes('加载草稿'),
      { timeoutMs: 8_000, label: 'DraftEditor opened for sample draft' },
    );
    tty.assertHealthyScreen(editorScreen, 120, 36, 'DraftEditor initial');
    await tty.flush(40);

    tty.send('S');
    const similarModal = await tty.waitFor(
      (s) =>
        (s.includes('相似 / 重复题检测') || s.includes('Near-Duplicate Check')) &&
        (s.includes('无明显重复题') || s.includes('No near-duplicates') || s.includes('处高相似') || s.includes('flagged')),
      { timeoutMs: 8_000, label: 'DraftEditor Similar modal rendered' },
    );
    tty.assertHealthyScreen(similarModal, 120, 36, 'DraftEditor Similar modal');
    assert.ok(similarModal.includes('相似 / 重复题检测') || similarModal.includes('Near-Duplicate Check'));

    tty.send('\x1b');
    const afterSimilar = await tty.waitFor(
      (s) => !s.includes('相似 / 重复题检测') && !s.includes('Near-Duplicate Check'),
      { timeoutMs: 8_000, label: 'DraftEditor Similar modal closed via Esc' },
    );
    tty.assertHealthyScreen(afterSimilar, 120, 36, 'DraftEditor after Similar modal');

    tty.send('R');
    const afterRepair = await tty.waitFor(
      (s) =>
        !s.includes('修题中') &&
        (s.includes('没有待处理的题目') ||
          s.includes('已启动修题任务') ||
          s.includes('草稿已修复并刷新') ||
          s.includes('Draft repair')),
      { timeoutMs: 8_000, label: 'DraftEditor repair executed cleanly' },
    );
    tty.assertHealthyScreen(afterRepair, 120, 36, 'DraftEditor after Repair');
    assert.ok(
      afterRepair.includes('没有待处理的题目') ||
        afterRepair.includes('已启动修题任务') ||
        afterRepair.includes('草稿已修复并刷新') ||
        afterRepair.includes('Draft repair'),
    );

    tty.send('\x1b');
    await tty.flush(120);
    tty.send('\x7f');
    const backToLib = await tty.waitFor(
      (s) => (s.includes('示例 · Memento 与 Bridge') || s.includes('Sample · Memento')) && !s.includes('审校草稿题干'),
      { timeoutMs: 8_000, label: 'Returned to LibraryView from DraftEditor' },
    );
    tty.assertHealthyScreen(backToLib, 120, 36, 'LibraryView after DraftEditor');
  });

  test('3) DeckManageModal Card Kind Convert ([k]) & Direct Supplement ([+])', async () => {
    const { tty } = ctx;
    tty.send('1');
    await tty.waitFor(
      (s) => (s.includes('示例 · Memento 与 Bridge') || s.includes('Sample · Memento')) && !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'LibraryView ready for DeckManageModal' },
    );
    await tty.flush();

    tty.send('m');
    const manageScreen = await tty.waitFor(
      (s) =>
        (s.includes('题组管理') || s.includes('Manage Deck')) &&
        !s.includes('正在读取题组卡片') &&
        s.includes('Memento'),
      { timeoutMs: 8_000, label: 'DeckManageModal opened' },
    );
    tty.assertHealthyScreen(manageScreen, 120, 36, 'DeckManageModal browse');

    tty.send('k');
    const convertScreen = await tty.waitFor(
      (s) =>
        (s.includes('转换题型') || s.includes('Convert Card Kind')) &&
        (s.includes('原题型:') || s.includes('From:')),
      { timeoutMs: 8_000, label: 'DeckManageModal convert sub-mode opened' },
    );
    tty.assertHealthyScreen(convertScreen, 120, 36, 'DeckManageModal convert initial');

    tty.send('\t');
    const openTargetScreen = await tty.waitFor(
      (s) => s.includes('-> 简答') || s.includes('-> Open') || s.includes('patch.rubric'),
      { timeoutMs: 5_000, label: 'Convert target switched to open' },
    );
    tty.assertHealthyScreen(openTargetScreen, 120, 36, 'DeckManageModal convert target open');

    tty.send('\r');
    const afterConvert = await tty.waitFor(
      (s) =>
        !s.includes('转换题型') &&
        !s.includes('Convert Card Kind') &&
        (s.includes('[简答]') || s.includes('[Open]') || s.includes('已转换为')),
      { timeoutMs: 8_000, label: 'card.convert completed and deck reloaded' },
    );
    tty.assertHealthyScreen(afterConvert, 120, 36, 'DeckManageModal after convert');
    assert.ok(afterConvert.includes('[简答]') || afterConvert.includes('[Open]'), 'Converted card kind badge must appear');

    tty.send('+');
    const supplementScreen = await tty.waitFor(
      (s) =>
        (s.includes('题组补题') || s.includes('Supplement Deck')) &&
        (s.includes('题数: 5') || s.includes('Count: 5')) &&
        (s.includes('题型: 混合') || s.includes('Kind: Mixed')) &&
        (s.includes('示例 · 设计模式讲义') || s.includes('Sample · Design Patterns')),
      { timeoutMs: 8_000, label: 'DeckManageModal supplement sub-mode opened' },
    );
    tty.assertHealthyScreen(supplementScreen, 120, 36, 'DeckManageModal supplement sub-mode');

    tty.send(' ');
    await tty.flush();
    tty.send('+');
    await tty.flush();
    tty.send('\t');
    const suppUpdated = await tty.waitFor(
      (s) =>
        (s.includes('题数: 10') || s.includes('Count: 10')) &&
        (s.includes('题型: 单选') || s.includes('Kind: MCQ')) &&
        s.includes('1 页已选'),
      { timeoutMs: 5_000, label: 'Supplement controls updated cleanly' },
    );
    tty.assertHealthyScreen(suppUpdated, 120, 36, 'DeckManageModal supplement controls updated');
    assert.ok(suppUpdated.includes('题数: 10') || suppUpdated.includes('Count: 10'), 'Supplement count must update to 10');

    tty.send('\x1b');
    const backBrowse = await tty.waitFor(
      (s) =>
        !s.includes('题组补题') &&
        !s.includes('Supplement Deck') &&
        (s.includes('题组管理') || s.includes('Manage Deck')),
      { timeoutMs: 8_000, label: 'Returned to DeckManageModal browse mode via Esc' },
    );
    tty.assertHealthyScreen(backBrowse, 120, 36, 'DeckManageModal back to browse');

    tty.send('\x1b');
    const afterClose = await tty.waitFor(
      (s) => !s.includes('题组管理') && !s.includes('Manage Deck'),
      { timeoutMs: 8_000, label: 'DeckManageModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterClose, 120, 36, 'LibraryView after DeckManageModal closed');
  });
});

describe('Round 14: AnswerCardModal, VoicePackModal & Settings Workspace Restore Points', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r14');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) AnswerCardModal ([A] in ReviewView: empty state -> [g] build -> [b] pin -> [d] drills -> Esc)', async () => {
    const { tty } = ctx;
    tty.send('j');
    await tty.waitFor(
      (s) => s.includes('▤ 示例案例 · 墨笺笔记') && s.includes('总题数: 2'),
      { timeoutMs: 8_000, label: 'Case deck selected in LibraryView' },
    );
    await tty.flush();
    tty.send('\r');

    const reviewInit = await tty.waitFor(
      (s) => (s.includes('[A]答题卡') || s.includes('[A]AnswerCard')) && !s.includes('正在准备复习队列'),
      { timeoutMs: 10_000, label: 'Review active case card rendered' },
    );
    tty.assertHealthyScreen(reviewInit, 120, 36, 'ReviewView case card');

    tty.send('A');
    const emptyWide = await tty.waitFor(
      (s) =>
        (s.includes('分析题答题卡') || s.includes('Case Answer Card')) &&
        (s.includes('这道题还没有结构化答题卡') || s.includes('No Answer Card Built Yet')) &&
        !s.includes('正在读取答题卡'),
      { timeoutMs: 8_000, label: 'AnswerCardModal empty state at 120x36' },
    );
    tty.assertHealthyScreen(emptyWide, 120, 36, 'AnswerCardModal empty 120x36');
    assert.ok(emptyWide.includes('这道题还没有结构化答题卡') || emptyWide.includes('No Answer Card Built Yet'));

    tty.resize(80, 24);
    const emptyNarrow = await tty.waitFor(
      (s) => (s.includes('分析题答题卡') || s.includes('Case Answer Card')) && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'AnswerCardModal empty state at 80x24' },
    );
    tty.assertHealthyScreen(emptyNarrow, 80, 24, 'AnswerCardModal empty 80x24');
    assert.ok(emptyNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor((s) => s.includes('分析题答题卡') || s.includes('Case Answer Card'), {
      timeoutMs: 8_000,
      label: 'AnswerCardModal restored to 120x36',
    });

    tty.send('g');
    const builtWide = await tty.waitFor(
      (s) =>
        (s.includes('核心结论') || s.includes('Thesis & Conclusion')) &&
        (s.includes('标准作答结构') || s.includes('Model Answer Structure')) &&
        !s.includes('这道题还没有结构化答题卡') &&
        !s.includes('正在写入'),
      { timeoutMs: 12_000, label: 'AnswerCardModal populated after [g] build' },
    );
    tty.assertHealthyScreen(builtWide, 120, 36, 'AnswerCardModal built 120x36');
    assert.ok(builtWide.includes('核心结论') || builtWide.includes('Thesis & Conclusion'), 'Answer card conclusion must render');

    tty.resize(80, 24);
    const builtNarrow = await tty.waitFor(
      (s) => (s.includes('分析题答题卡') || s.includes('Case Answer Card')) && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'AnswerCardModal built at 80x24' },
    );
    tty.assertHealthyScreen(builtNarrow, 80, 24, 'AnswerCardModal built 80x24');

    tty.resize(120, 36);
    await tty.waitFor((s) => s.includes('核心结论') || s.includes('Thesis & Conclusion'), {
      timeoutMs: 8_000,
      label: 'AnswerCardModal built restored to 120x36',
    });

    tty.send('b');
    const afterPin = await tty.waitFor(
      (s) =>
        s.includes('已将答题卡加入复习全书') ||
        s.includes('已从复习全书撤回答题卡') ||
        s.includes('还没有复习全书') ||
        s.includes('Pinned answer card') ||
        s.includes('no review book'),
      { timeoutMs: 8_000, label: 'AnswerCardModal [b] pin action handled cleanly' },
    );
    tty.assertHealthyScreen(afterPin, 120, 36, 'AnswerCardModal after [b]');
    assert.ok(
      afterPin.includes('已将答题卡加入复习全书') ||
        afterPin.includes('已从复习全书撤回答题卡') ||
        afterPin.includes('还没有复习全书') ||
        afterPin.includes('Pinned answer card') ||
        afterPin.includes('no review book'),
    );

    tty.send('d');
    const afterDrills = await tty.waitFor(
      (s) =>
        s.includes('薄弱项练习') ||
        s.includes('Queued') ||
        s.includes('Drills ready') ||
        s.includes('正在生成薄弱评分项练习'),
      { timeoutMs: 8_000, label: 'AnswerCardModal [d] case.drills handled cleanly' },
    );
    tty.assertHealthyScreen(afterDrills, 120, 36, 'AnswerCardModal after [d]');
    assert.ok(
      afterDrills.includes('薄弱项练习') ||
        afterDrills.includes('Queued') ||
        afterDrills.includes('Drills ready') ||
        afterDrills.includes('正在生成薄弱评分项练习'),
    );

    tty.send('\x1b');
    const backToReview = await tty.waitFor(
      (s) =>
        !s.includes('分析题答题卡') &&
        !s.includes('Case Answer Card') &&
        (s.includes('[A]答题卡') || s.includes('[A]AnswerCard')),
      { timeoutMs: 8_000, label: 'AnswerCardModal closed via Esc back to ReviewView' },
    );
    tty.assertHealthyScreen(backToReview, 120, 36, 'ReviewView after AnswerCardModal closed');

    tty.send('\x1b');
    const backToLib = await tty.waitFor(
      (s) => (s.includes('题组列表') || s.includes('Decks')) && !s.includes('[A]答题卡'),
      { timeoutMs: 8_000, label: 'Returned to LibraryView from ReviewView' },
    );
    tty.assertHealthyScreen(backToLib, 120, 36, 'LibraryView after ReviewView');
  });

  test('2) VoicePackModal ([v] in LibraryView: prompt/checklist at 120x36 & 80x24, mode/export, Esc)', async () => {
    const { tty } = ctx;
    tty.send('v');
    const voiceWide = await tty.waitFor(
      (s) =>
        (s.includes('语音带学包导出') || s.includes('Voice Study Pack')) &&
        (s.includes('防发散私教提示词') || s.includes('防跑偏硬协议') || s.includes('Anti-Drift') || s.includes('今日清单')) &&
        !s.includes('正在生成语音带学包'),
      { timeoutMs: 8_000, label: 'VoicePackModal rendered at 120x36' },
    );
    tty.assertHealthyScreen(voiceWide, 120, 36, 'VoicePackModal 120x36');

    tty.send('3');
    await tty.waitFor(
      (s) => s.includes('3:全部 all') && s.includes('抽题模式： all') && !s.includes('正在生成语音带学包'),
      { timeoutMs: 8_000, label: 'VoicePackModal switched to all mode' },
    );
    tty.send('+');
    await tty.waitFor(
      (s) => s.includes('题数上限: 30') && !s.includes('正在生成语音带学包'),
      { timeoutMs: 8_000, label: 'VoicePackModal limit adjusted to 30' },
    );
    tty.send(']');
    const adjustedWide = await tty.waitFor(
      (s) => s.includes('题数上限: 30') && s.includes('时长预算: 45分钟') && !s.includes('正在生成语音带学包'),
      { timeoutMs: 8_000, label: 'VoicePackModal minutes adjusted to 45' },
    );
    tty.assertHealthyScreen(adjustedWide, 120, 36, 'VoicePackModal adjusted 120x36');
    assert.ok(adjustedWide.includes('题数上限: 30') && adjustedWide.includes('时长预算: 45分钟'));

    tty.resize(80, 24);
    const voiceNarrow = await tty.waitFor(
      (s) => (s.includes('语音带学包导出') || s.includes('Voice Study Pack')) && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'VoicePackModal rendered at 80x24' },
    );
    tty.assertHealthyScreen(voiceNarrow, 80, 24, 'VoicePackModal 80x24');

    tty.resize(120, 36);
    await tty.waitFor((s) => s.includes('语音带学包导出') || s.includes('Voice Study Pack'), {
      timeoutMs: 8_000,
      label: 'VoicePackModal restored to 120x36',
    });

    tty.send('e');
    const exportPrompt = await tty.waitFor(
      (s) => s.includes('导出 Markdown 文件路径') || s.includes('Export Markdown file path'),
      { timeoutMs: 8_000, label: 'VoicePackModal export prompt opened' },
    );
    tty.assertHealthyScreen(exportPrompt, 120, 36, 'VoicePackModal export prompt');

    tty.send('\r');
    const exportedScreen = await tty.waitFor(
      (s) => (s.includes('已导出到') || s.includes('Exported to')) && !s.includes('导出 Markdown 文件路径'),
      { timeoutMs: 8_000, label: 'VoicePackModal markdown exported' },
    );
    tty.assertHealthyScreen(exportedScreen, 120, 36, 'VoicePackModal after export');

    tty.send('\x1b');
    const libAfterVoice = await tty.waitFor(
      (s) =>
        !s.includes('语音带学包导出') &&
        !s.includes('Voice Study Pack') &&
        (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 8_000, label: 'VoicePackModal closed via Esc' },
    );
    tty.assertHealthyScreen(libAfterVoice, 120, 36, 'LibraryView after VoicePackModal closed');
  });

  test('3) Settings Workspace Restore Points (Settings [,] -> Tab [2] -> inspect/refresh/export -> return)', async () => {
    const { libraryRoot, tty } = ctx;
    tty.send(',');
    const settingsInit = await tty.waitFor((s) => s.includes('模型配置') || s.includes('Models'), {
      timeoutMs: 8_000,
      label: 'SettingsView opened',
    });
    tty.assertHealthyScreen(settingsInit, 120, 36, 'SettingsView initial');

    tty.send('2');
    const rootTail = basename(libraryRoot);
    const workspaceWide = await tty.waitFor(
      (s) =>
        (s.includes('学习库路径与工作区') || s.includes('Library Root & Workspace')) &&
        (s.includes('学习库自动备份点') || s.includes('Library Restore Points')) &&
        s.includes(rootTail),
      { timeoutMs: 8_000, label: 'Settings WorkspaceTab rendered at 120x36' },
    );
    tty.assertHealthyScreen(workspaceWide, 120, 36, 'Settings WorkspaceTab 120x36');
    assert.ok(workspaceWide.includes(rootTail), 'Workspace tab must render libraryRoot tail');

    tty.send('\x12');
    await tty.flush();
    const afterRefresh = await tty.waitFor(
      (s) =>
        (s.includes('暂无备份点') || s.includes('No restore points yet') || s.includes('cards')) &&
        !s.includes('正在读取备份列表'),
      { timeoutMs: 8_000, label: 'WorkspaceTab restore points refreshed cleanly' },
    );
    tty.assertHealthyScreen(afterRefresh, 120, 36, 'Settings WorkspaceTab after [r]');

    tty.send('x');
    const exportModal = await tty.waitFor(
      (s) =>
        (s.includes('导出学习库备份') || s.includes('Export Library Backup')) &&
        s.includes('studyhub-backup-'),
      { timeoutMs: 8_000, label: 'WorkspaceTab export backup modal opened' },
    );
    tty.assertHealthyScreen(exportModal, 120, 36, 'WorkspaceTab export backup modal');
    await tty.flush(40);

    tty.send('\r');
    const afterBackup = await tty.waitFor(
      (s) => (s.includes('已导出备份') || s.includes('Exported backup')) && !s.includes('输入备份文件路径'),
      { timeoutMs: 8_000, label: 'WorkspaceTab backup exported cleanly' },
    );
    tty.assertHealthyScreen(afterBackup, 120, 36, 'WorkspaceTab after backup export');

    tty.send('\x7f');
    const returnedLib = await tty.waitFor(
      (s) =>
        !s.includes('学习库路径与工作区') &&
        !s.includes('Library Root & Workspace') &&
        (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 8_000, label: 'Returned cleanly to LibraryView from SettingsView' },
    );
    tty.assertHealthyScreen(returnedLib, 120, 36, 'LibraryView after SettingsView');
    assert.equal(useTuiStore.getState().page, 'library', 'Backspace from Settings must return to Library');
  });
});

describe('Round 15: CoachPreferencesModal, BookQaModal & NotesView Save-Keeps-Selection Regression', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r15');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) CoachPreferencesModal (9 -> p): profile summary, add/remove preference, 120x36 & 80x24, Esc closes', async () => {
    const { tty } = ctx;
    tty.send('9');
    const coachScreen = await tty.waitFor(
      (s) =>
        (s.includes('考试教练') || s.includes('Exam Coach')) &&
        (s.includes('校准与考法') || s.includes('Calibration')) &&
        !s.includes('正在加载页面') &&
        !s.includes('正在加载考试教练'),
      { timeoutMs: 10_000, label: 'ExamCoachView rendered' },
    );
    tty.assertHealthyScreen(coachScreen, 120, 36, 'ExamCoachView initial');

    tty.send('p');
    const prefsWide = await tty.waitFor(
      (s) =>
        (s.includes('学习者画像与长期偏好') || s.includes('Learner Profile & Preferences')) &&
        (s.includes('画像摘要') || s.includes('Summary:')) &&
        !s.includes('正在读取学习者画像'),
      { timeoutMs: 8_000, label: 'CoachPreferencesModal opened at 120x36' },
    );
    assert.ok(
      prefsWide.includes('目标:') || prefsWide.includes('Goal:'),
      `Profile summary header must show Goal badge:\n${prefsWide}`,
    );
    tty.assertHealthyScreen(prefsWide, 120, 36, 'CoachPreferencesModal initial 120x36');

    const prefText = 'Prefer concise bullet proofs';
    tty.send('a');
    await tty.waitFor((s) => s.includes('新增偏好') || s.includes('New preference'), {
      timeoutMs: 5_000,
      label: 'CoachPreferencesModal add input opened',
    });

    tty.send(prefText);
    await tty.waitFor((s) => s.includes(prefText), {
      timeoutMs: 5_000,
      label: 'Preference text typed',
    });

    tty.send('\r');
    const prefsPopulatedWide = await tty.waitFor(
      (s) => !s.includes('新增偏好') && !s.includes('New preference') && s.includes(prefText) && s.includes('1/12'),
      { timeoutMs: 8_000, label: 'Added preference rendered in list' },
    );
    tty.assertHealthyScreen(prefsPopulatedWide, 120, 36, 'CoachPreferencesModal populated 120x36');
    assert.ok(prefsPopulatedWide.includes('1/12'), 'Added preference count must display 1/12');

    tty.resize(80, 24);
    const prefsPopulatedNarrow = await tty.waitFor(
      (s) =>
        (s.includes('学习者画像与长期偏好') || s.includes('Learner Profile & Preferences')) &&
        s.includes(prefText) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'CoachPreferencesModal populated at 80x24' },
    );
    tty.assertHealthyScreen(prefsPopulatedNarrow, 80, 24, 'CoachPreferencesModal populated 80x24');

    tty.resize(120, 36);
    await tty.waitFor((s) => s.includes('学习者画像与长期偏好') && s.includes(prefText), {
      timeoutMs: 8_000,
      label: 'CoachPreferencesModal restored to 120x36',
    });

    tty.send('d');
    const prefsRemoved = await tty.waitFor(
      (s) =>
        !s.includes(prefText) &&
        s.includes('0/12') &&
        (s.includes('暂无自定义学习偏好') || s.includes('No study preferences yet')),
      { timeoutMs: 8_000, label: 'Preference removed from list' },
    );
    tty.assertHealthyScreen(prefsRemoved, 120, 36, 'CoachPreferencesModal after remove');
    assert.ok(prefsRemoved.includes('0/12'), 'Removed preference count must display 0/12');

    tty.send('\x1b');
    const backToCoach = await tty.waitFor(
      (s) =>
        !s.includes('学习者画像与长期偏好') &&
        !s.includes('Learner Profile & Preferences') &&
        (s.includes('考试教练') || s.includes('Exam Coach')),
      { timeoutMs: 8_000, label: 'CoachPreferencesModal closed via Esc' },
    );
    tty.assertHealthyScreen(backToCoach, 120, 36, 'ExamCoachView after CoachPreferencesModal closed');
  });

  test('2) BookQaModal (7 -> P): empty/populated state at 120x36 & 80x24, Esc closes cleanly', async () => {
    const { tty } = ctx;
    tty.send('7');
    const bookInit = await tty.waitFor(
      (s) =>
        (s.includes('精选问答') || s.includes('Pinned QA')) &&
        !s.includes('正在打开复习全书') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'BookView rendered' },
    );
    tty.assertHealthyScreen(bookInit, 120, 36, 'BookView initial');

    tty.send('P');
    const qaWide = await tty.waitFor(
      (s) =>
        (s.includes('全书精选问答与答题卡') || s.includes('Book Pinned Q&A & Answer Cards')) &&
        !s.includes('正在读取全书精选问答') &&
        (s.includes('当前课程暂无已收录的答题卡或追问') ||
          s.includes('No pinned Answer Cards or Q&As yet') ||
          s.includes('已收录条目') ||
          s.includes('Pinned')),
      { timeoutMs: 8_000, label: 'BookQaModal rendered at 120x36' },
    );
    tty.assertHealthyScreen(qaWide, 120, 36, 'BookQaModal 120x36');
    assert.ok(qaWide.includes('全书精选问答与答题卡') || qaWide.includes('Book Pinned Q&A & Answer Cards'));

    tty.resize(80, 24);
    const qaNarrow = await tty.waitFor(
      (s) =>
        (s.includes('全书精选问答与答题卡') || s.includes('Book Pinned Q&A & Answer Cards')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'BookQaModal rendered at 80x24' },
    );
    tty.assertHealthyScreen(qaNarrow, 80, 24, 'BookQaModal 80x24');
    assert.ok(qaNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('全书精选问答与答题卡') || s.includes('Book Pinned Q&A & Answer Cards'),
      { timeoutMs: 8_000, label: 'BookQaModal restored to 120x36' },
    );

    tty.send('\x1b');
    const afterQaClose = await tty.waitFor(
      (s) =>
        !s.includes('全书精选问答与答题卡') &&
        !s.includes('Book Pinned Q&A & Answer Cards') &&
        (s.includes('复习全书') || s.includes('Review Book')),
      { timeoutMs: 8_000, label: 'BookQaModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterQaClose, 120, 36, 'BookView after BookQaModal closed');
    assert.ok(!afterQaClose.includes('全书精选问答与答题卡'));
  });

  test('3) NotesView Save-Keeps-Selection Regression (create -> wait for note.list settle -> stays selected -> delete)', async () => {
    const { host, tty } = ctx;
    tty.send('n');
    const notesInit = await tty.waitFor(
      (s) =>
        (s.includes('Unicode Math') || s.includes('Raw LaTeX') || s.includes('笔记正文') || s.includes('Note Reader')) &&
        !s.includes('载入笔记中') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'NotesView rendered' },
    );
    tty.assertHealthyScreen(notesInit, 120, 36, 'NotesView initial');
    assert.equal(useTuiStore.getState().page, 'notes', 'Key n must navigate to NotesView');

    const noteTitle = 'R15 Keep Selection Note';
    const noteBody = 'R15_PENDING_SELECT_REGRESSION_BODY';

    tty.send('a');
    const createModal = await tty.waitFor(
      (s) =>
        (s.includes('新建学习笔记') || s.includes('New Study Note')) &&
        (s.includes('已选 1/30') || s.includes('Linked Cards (1/30)')),
      { timeoutMs: 8_000, label: 'NoteEditorModal create opened with preselected card' },
    );
    tty.assertHealthyScreen(createModal, 120, 36, 'NoteEditorModal create');

    tty.send(noteTitle);
    await tty.waitFor((s) => s.includes(noteTitle), {
      timeoutMs: 5_000,
      label: 'Note title typed',
    });

    for (let i = 0; i < 3; i += 1) {
      tty.send('\t');
      await tty.flush(20);
    }

    tty.send(noteBody);
    await tty.waitFor((s) => s.includes(noteBody), {
      timeoutMs: 5_000,
      label: 'Note body typed',
    });

    tty.send('\t');
    await tty.flush();

    tty.send('\x13');
    await tty.waitFor((s) => !s.includes('新建学习笔记') && !s.includes('New Study Note'), {
      timeoutMs: 8_000,
      label: 'NoteEditorModal closed after Ctrl+S',
    });

    await tty.flush(350);

    const settledScreen = await tty.waitFor(
      (s) =>
        (s.includes('学习笔记  3') || s.includes('Notes  3')) &&
        s.includes(noteTitle) &&
        s.includes(noteBody) &&
        /(?:R15 Keep Selection Note)\s+(?:草稿|Draft)/.test(s),
      { timeoutMs: 6_000, label: 'Newly created note stayed selected in detail pane after background refresh' },
    );
    tty.assertHealthyScreen(settledScreen, 120, 36, 'NotesView settled after create');
    assert.ok(settledScreen.includes(noteBody), 'Created note body must remain selected in detail pane');

    tty.send('d');
    const deleteDialog = await tty.waitFor((s) => s.includes('删除笔记') || s.includes('Delete Note'), {
      timeoutMs: 8_000,
      label: 'Delete note confirmation dialog',
    });
    tty.assertHealthyScreen(deleteDialog, 120, 36, 'NotesView delete ConfirmDialog');

    tty.send('y');
    const afterDelete = await tty.waitFor(
      (s) => !s.includes('删除笔记') && !s.includes('Delete Note') && !s.includes(noteTitle),
      { timeoutMs: 8_000, label: 'Deleted note removed from NotesView' },
    );
    tty.assertHealthyScreen(afterDelete, 120, 36, 'NotesView after delete');
    const finalNotesRes = await host.call('note.list', {});
    assert.equal(finalNotesRes.ok, true, 'note.list after delete must succeed');
  });
});
