// Round 45 AddFocusModal AI Focus Topic Matching (focus.suggest + P2 ConfirmDialog) E2E verification:
// node --test tests/round45-focus-suggest.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round45-focus-suggest-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function createVirtualTty(cols = 120, rows = 36) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 24;

  const stderr = new PassThrough();
  stderr.isTTY = true;
  stderr.columns = cols;
  stderr.rows = rows;

  const term = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    convertEol: true,
  });

  let pendingWrites = Promise.resolve();
  let firstFrameResolve = null;
  let firstFrameSettled = false;
  const firstFramePromise = new Promise((resolveFn) => {
    firstFrameResolve = resolveFn;
  });

  stdout.on('data', (chunk) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    pendingWrites = pendingWrites.then(
      () =>
        new Promise((resolveWrite) => {
          term.write(str, () => {
            if (!firstFrameSettled) {
              firstFrameSettled = true;
              firstFrameResolve?.();
            }
            resolveWrite();
          });
        }),
    );
  });

  async function flush() {
    await sleep(30);
    await pendingWrites;
  }

  function readLines() {
    const buf = term.buffer.active;
    const lines = [];
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  function readScreen() {
    return readLines().join('\n');
  }

  function resize(newCols, newRows) {
    stdout.columns = newCols;
    stdout.rows = newRows;
    stderr.columns = newCols;
    stderr.rows = newRows;
    term.resize(newCols, newRows);
    stdout.emit('resize');
  }

  function send(data) {
    stdin.write(data);
  }

  async function waitFor(predicate, { timeoutMs = 10_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(30);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, label) {
    const lines = screen.split('\n');
    assert.ok(lines.length <= expectedRows, `${label}: row count ${lines.length} > ${expectedRows}`);
    assert.ok(!screen.includes('页面渲染异常') && !screen.includes('View Error'), `${label}: error boundary triggered`);
    assert.ok(!screen.includes('TypeError:') && !screen.includes('ReferenceError:'), `${label}: runtime JS error`);
    assert.ok(!/\bNaN\b/.test(screen), `${label}: raw NaN leaked`);
    assert.ok(!/\bundefined\b/.test(screen), `${label}: raw undefined leaked`);
    assert.ok(!screen.includes('[object Object]'), `${label}: raw [object Object] leaked`);
    for (let i = 0; i < lines.length; i += 1) {
      const w = displayWidth(lines[i]);
      assert.ok(w <= expectedCols, `${label}: row ${i} width ${w} > ${expectedCols}: ${JSON.stringify(lines[i])}`);
    }
  }

  function assertAsciiPure(screen, label) {
    const matches = screen.match(UNICODE_UI_CHROME_RE);
    assert.ok(!matches, `${label}: leaked non-ASCII UI chrome: ${JSON.stringify([...new Set(matches || [])])}\n${screen}`);
  }

  return {
    stdin,
    stdout,
    stderr,
    firstFramePromise,
    flush,
    readScreen,
    resize,
    send,
    waitFor,
    assertHealthyScreen,
    assertAsciiPure,
    dispose: () => {
      term.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

function resetTuiStore() {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    loading: true,
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
  });
}

async function getSampleDeckTopics(host) {
  const deckRes = await host.call('deck.get', { id: 'sample-deck-patterns' });
  assert.equal(deckRes.ok, true, `deck.get(sample-deck-patterns) failed: ${deckRes.error?.message || ''}`);
  const cards = deckRes.value?.cards ?? [];
  const topics = [...new Set(cards.map((c) => c.topic).filter(Boolean))];
  assert.ok(topics.length >= 2, `Expected at least 2 distinct topics in sample deck, got ${topics.length}`);
  return { cards, topics };
}

describe('Round 45: AddFocusModal AI Focus Topic Matching (focus.suggest + P2 ConfirmDialog)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: focus.suggest filters out invented topics to existing deck topics only & handles no-model rules fallback', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const observed = [];
    let modelCalls = 0;

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (system, prompt) => {
        modelCalls += 1;
        const parsed = JSON.parse(String(prompt));
        observed.push({ system, parsed });
        const available = Array.isArray(parsed.availableTopics) ? parsed.availableTopics : [];
        return JSON.stringify({
          role: 'Staff Systems Architect',
          targetTopics: [
            available[0],
            'Invented Ghost Topic Not In Decks',
            available[1],
            'Another Hallucinated Topic',
          ],
        });
      },
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message || ''}`);
      const { cards: beforeCards, topics: deckTopics } = await getSampleDeckTopics(host);

      const res = await host.call('focus.suggest', {
        role: 'Backend Architect',
        jd: 'Decouple state snapshots and abstraction hierarchies.',
      });
      assert.equal(res.ok, true, `focus.suggest failed: ${res.error?.message || ''}`);
      assert.equal(modelCalls, 1, 'focus.suggest must invoke model once');
      assert.equal(res.value?.method, 'ai');
      assert.equal(res.value?.role, 'Staff Systems Architect');
      assert.equal(res.value?.jd, 'Decouple state snapshots and abstraction hierarchies.');
      assert.deepEqual(
        res.value?.targetTopics,
        [deckTopics[0], deckTopics[1]],
        'Backend must filter out invented topics and keep only existing deck topics',
      );
      assert.ok(
        !res.value?.targetTopics?.includes('Invented Ghost Topic Not In Decks'),
        'Invented topic must be excluded',
      );
      assert.ok(
        observed[0]?.parsed?.availableTopics?.includes(deckTopics[0]),
        'Prompt must pass existing deck topics as availableTopics',
      );

      // Verify study cards were not modified
      const { cards: afterCards } = await getSampleDeckTopics(host);
      assert.equal(afterCards.length, beforeCards.length, 'focus.suggest must never alter card count');
      assert.deepEqual(
        afterCards.map((c) => c.topic),
        beforeCards.map((c) => c.topic),
        'focus.suggest must never alter card topics',
      );
    } finally {
      await host.dispose();
    }

    // No-model host -> clean rules fallback with 0 AI calls
    const baseNoModel = await makeTempDir('host-nomodel');
    const hostNoModel = await createTuiHost({
      libraryRoot: join(baseNoModel, 'library'),
      env: { DSH_HOME: join(baseNoModel, 'dsh-home') },
      home: baseNoModel,
      documentsDir: baseNoModel,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: null,
    });
    try {
      const res = await hostNoModel.call('focus.suggest', { role: 'Frontend Engineer', jd: 'React' });
      assert.equal(res.ok, true, 'focus.suggest without model returns structured rules fallback');
      assert.equal(res.value?.method, 'rules');
      assert.deepEqual(res.value?.targetTopics, []);
    } finally {
      await hostNoModel.dispose();
    }
  });

  test('2) PTY E2E: AddFocusModal AI Match (Ctrl+T/Ctrl+G -> P2 ConfirmDialog -> cancel n/Esc -> confirm y) in zh & --ascii en at 120x36 & 80x24', async () => {
    // --- Part A: Default mode (zh) ---
    const baseZh = await makeTempDir('pty-zh');
    const envZh = { DSH_HOME: join(baseZh, 'dsh-home') };
    process.env.DSH_HOME = envZh.DSH_HOME;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: envZh });
    resetTuiStore();

    let zhModelCalls = 0;
    let releaseZh = null;
    let gateZh = null;
    let pickedZhTopics = [];

    const hostZh = await createTuiHost({
      libraryRoot: join(baseZh, 'library'),
      env: envZh,
      home: baseZh,
      documentsDir: baseZh,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async (_system, prompt) => {
        zhModelCalls += 1;
        if (gateZh) await gateZh;
        const parsed = JSON.parse(String(prompt));
        const available = Array.isArray(parsed.availableTopics) ? parsed.availableTopics : [];
        pickedZhTopics = available.slice(0, 2);
        return JSON.stringify({
          role: parsed.role,
          targetTopics: [...pickedZhTopics, '虚构不存在考点'],
        });
      },
    });

    const sampleZh = await hostZh.call('sample.load', { language: 'zh' });
    assert.equal(sampleZh.ok, true, `zh sample.load failed: ${sampleZh.error?.message || ''}`);
    const { topics: zhDeckTopics } = await getSampleDeckTopics(hostZh);
    const zhTargetTopics = zhDeckTopics.slice(0, 2);

    const ttyZh = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostZh, asciiMode: false }), {
        stdin: ttyZh.stdin,
        stdout: ttyZh.stdout,
        stderr: ttyZh.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyZh.firstFramePromise;

      await ttyZh.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'zh LibraryView ready',
      });

      // Navigate to ExamPrepView ('0')
      ttyZh.send('0');
      const prepInit = await ttyZh.waitFor(
        (s) =>
          useTuiStore.getState().page === 'examprep' &&
          s.includes('备考补习') &&
          s.includes('1:考纲重点进度') &&
          !s.includes('正在加载备考重点'),
        { label: 'zh ExamPrepView ready' },
      );
      ttyZh.assertHealthyScreen(prepInit, 120, 36, 'zh ExamPrepView initial');
      assert.equal(zhModelCalls, 0, 'Entering ExamPrepView must make 0 AI calls');

      // Press 'a' to open AddFocusModal
      ttyZh.send('a');
      const modalOpen = await ttyZh.waitFor(
        (s) => s.includes('添加考纲重点') && s.includes('3: AI匹配题库'),
        { label: 'zh AddFocusModal open' },
      );
      ttyZh.assertHealthyScreen(modalOpen, 120, 36, 'zh AddFocusModal initial');
      assert.equal(zhModelCalls, 0, 'Opening AddFocusModal must make 0 AI calls');

      // Switch to AI Match mode using Ctrl+T twice (text -> image -> suggest)
      ttyZh.send('\u0014'); // Ctrl+T -> image
      await ttyZh.waitFor((s) => s.includes('本地截图 / 文件路径'), { label: 'zh AddFocusModal image mode' });
      ttyZh.send('\u0014'); // Ctrl+T -> suggest
      const suggestModeZh = await ttyZh.waitFor(
        (s) => s.includes('目标岗位方向') && s.includes('岗位描述 / JD 关键词'),
        { label: 'zh AddFocusModal suggest mode' },
      );
      ttyZh.assertHealthyScreen(suggestModeZh, 120, 36, 'zh AddFocusModal suggest mode 120x36');
      assert.equal(zhModelCalls, 0, 'Switching to suggest mode must make 0 AI calls');

      // Type target role & Tab -> JD
      ttyZh.send('架构师');
      await ttyZh.waitFor((s) => s.includes('架构师'), { label: 'zh role typed' });
      ttyZh.send('\t');
      await ttyZh.flush();
      ttyZh.send('设计模式');
      await ttyZh.waitFor((s) => s.includes('设计模式'), { label: 'zh jd typed' });
      assert.equal(zhModelCalls, 0, 'Typing role/JD must make 0 AI calls');

      // Trigger focus.suggest with Ctrl+E -> P2 ConfirmDialog must open with 0 AI calls
      ttyZh.send('\u0005'); // Ctrl+E
      const zhConfirm1 = await ttyZh.waitFor(
        (s) =>
          s.includes('确认 AI 匹配题库重点') &&
          s.includes('1 次轻量 AI 调用') &&
          s.includes('绝不修改任何题目'),
        { label: 'zh ConfirmDialog open after Ctrl+E' },
      );
      ttyZh.assertHealthyScreen(zhConfirm1, 120, 36, 'zh ConfirmDialog 120x36');
      assert.equal(zhModelCalls, 0, 'P2 guard: 0 AI calls before ConfirmDialog confirm');

      // Cancel with 'n' -> 0 AI calls
      ttyZh.send('n');
      await ttyZh.waitFor(
        (s) => s.includes('目标岗位方向') && !s.includes('确认 AI 匹配题库重点'),
        { label: 'zh ConfirmDialog cancelled with n' },
      );
      assert.equal(zhModelCalls, 0, 'Cancelling with n must keep AI calls at 0');

      // Reopen with Ctrl+G and cancel with Esc -> 0 AI calls
      ttyZh.send('\u0007'); // Ctrl+G
      await ttyZh.waitFor((s) => s.includes('确认 AI 匹配题库重点'), { label: 'zh ConfirmDialog reopened via Ctrl+G' });
      ttyZh.send('\u001b'); // Esc
      await ttyZh.waitFor(
        (s) => s.includes('目标岗位方向') && !s.includes('确认 AI 匹配题库重点'),
        { label: 'zh ConfirmDialog cancelled with Esc' },
      );
      assert.equal(zhModelCalls, 0, 'Cancelling with Esc must keep AI calls at 0');

      // Trigger again and confirm with 'y' (gated to verify busyRef blocks duplicate triggers)
      gateZh = new Promise((resolveFn) => {
        releaseZh = resolveFn;
      });
      ttyZh.send('\u0005'); // Ctrl+E
      await ttyZh.waitFor((s) => s.includes('确认 AI 匹配题库重点'), { label: 'zh ConfirmDialog before gated y' });
      ttyZh.send('y');
      await ttyZh.waitFor((s) => s.includes('正在匹配题库重点'), { label: 'zh busy spinner during focus.suggest' });
      // Attempt duplicate trigger while busy
      ttyZh.send('\u0005');
      ttyZh.send('\u0007');
      await ttyZh.flush();
      assert.equal(zhModelCalls, 1, 'busyRef must prevent duplicate AI calls while matching');

      releaseZh();
      gateZh = null;

      // Verify AI badge and matched topics populate at 120x36 (and invented topic is filtered out)
      const zhMatchedWide = await ttyZh.waitFor(
        (s) =>
          s.includes('匹配 2 个现有知识点') &&
          s.includes(zhTargetTopics[0]) &&
          s.includes(zhTargetTopics[1]) &&
          s.includes('AI 匹配到 2 个现有知识点'),
        { label: 'zh matched topics rendered at 120x36' },
      );
      ttyZh.assertHealthyScreen(zhMatchedWide, 120, 36, 'zh matched topics 120x36');
      assert.ok(!zhMatchedWide.includes('虚构不存在考点'), 'Invented topic must not appear in matched UI');
      assert.equal(zhModelCalls, 1);

      // Resize to 80x24 and verify healthy layout
      ttyZh.resize(80, 24);
      const zhMatchedNarrow = await ttyZh.waitFor(
        (s) => s.includes('匹配 2 个现有知识点') && s.includes(zhTargetTopics[0]) && s.split('\n').length <= 24,
        { label: 'zh matched topics rendered at 80x24' },
      );
      ttyZh.assertHealthyScreen(zhMatchedNarrow, 80, 24, 'zh matched topics 80x24');

      // Save merged topics to course with Ctrl+S
      useTuiStore.setState({ toasts: [] });
      ttyZh.send('\u0013'); // Ctrl+S
      const zhAfterSave = await ttyZh.waitFor(
        (s) =>
          !s.includes('添加考纲重点') &&
          s.includes('1:考纲重点进度') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已保存')),
        { label: 'zh Ctrl+S saves matched focus topics to course' },
      );
      ttyZh.assertHealthyScreen(zhAfterSave, 80, 24, 'zh ExamPrepView after save 80x24');

      ttyZh.resize(120, 36);
      const zhPrepUpdated = await ttyZh.waitFor(
        (s) => s.includes(zhTargetTopics[0]),
        { label: 'zh saved topic visible in ExamPrepView at 120x36' },
      );
      ttyZh.assertHealthyScreen(zhPrepUpdated, 120, 36, 'zh ExamPrepView after save 120x36');
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      ttyZh.dispose();
      await hostZh.dispose();
    }

    // --- Part B: --ascii mode (en) ---
    const baseEn = await makeTempDir('pty-en');
    const envEn = { DSH_HOME: join(baseEn, 'dsh-home') };
    process.env.DSH_HOME = envEn.DSH_HOME;

    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env: envEn });
    resetTuiStore();

    let enModelCalls = 0;

    const hostEn = await createTuiHost({
      libraryRoot: join(baseEn, 'library'),
      env: envEn,
      home: baseEn,
      documentsDir: baseEn,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (_system, prompt) => {
        enModelCalls += 1;
        const parsed = JSON.parse(String(prompt));
        const available = Array.isArray(parsed.availableTopics) ? parsed.availableTopics : [];
        return JSON.stringify({
          role: parsed.role,
          targetTopics: [available[0], available[1], 'Fake Topic Should Be Filtered'],
        });
      },
    });

    const sampleEn = await hostEn.call('sample.load', { language: 'en' });
    assert.equal(sampleEn.ok, true, `en sample.load failed: ${sampleEn.error?.message || ''}`);
    const { topics: enDeckTopics } = await getSampleDeckTopics(hostEn);
    const enTargetTopics = enDeckTopics.slice(0, 2);

    const ttyEn = createVirtualTty(120, 36);
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostEn, asciiMode: true }), {
        stdin: ttyEn.stdin,
        stdout: ttyEn.stdout,
        stderr: ttyEn.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyEn.firstFramePromise;

      await ttyEn.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'en --ascii LibraryView ready',
      });

      ttyEn.send('0');
      const enPrepInit = await ttyEn.waitFor(
        (s) =>
          useTuiStore.getState().page === 'examprep' &&
          s.includes('Exam Prep') &&
          s.includes('1:Focus Progress') &&
          !s.includes('Loading'),
        { label: 'en --ascii ExamPrepView ready' },
      );
      ttyEn.assertHealthyScreen(enPrepInit, 120, 36, 'en --ascii ExamPrepView initial');
      ttyEn.assertAsciiPure(enPrepInit, 'en --ascii ExamPrepView initial');
      assert.equal(enModelCalls, 0);

      // Open AddFocusModal ('a') and jump directly to AI Match mode via Ctrl+G
      ttyEn.send('a');
      const enModalInit = await ttyEn.waitFor(
        (s) => s.includes('Add Exam Focus') && s.includes('3: AI Match Topics'),
        { label: 'en --ascii AddFocusModal open' },
      );
      ttyEn.assertHealthyScreen(enModalInit, 120, 36, 'en --ascii AddFocusModal initial');
      ttyEn.assertAsciiPure(enModalInit, 'en --ascii AddFocusModal initial');
      assert.equal(enModelCalls, 0);

      ttyEn.send('\u0007'); // Ctrl+G -> switch directly to suggest mode
      const enSuggestMode = await ttyEn.waitFor(
        (s) => s.includes('Target Role') && s.includes('Job Description / Keywords'),
        { label: 'en --ascii AddFocusModal suggest mode' },
      );
      ttyEn.assertHealthyScreen(enSuggestMode, 120, 36, 'en --ascii AddFocusModal suggest mode');
      ttyEn.assertAsciiPure(enSuggestMode, 'en --ascii AddFocusModal suggest mode');
      assert.equal(enModelCalls, 0);

      // Type Role + Enter -> JD + Enter -> ConfirmDialog opens with 0 AI calls
      ttyEn.send('Architect');
      await ttyEn.waitFor((s) => s.includes('Architect'), { label: 'en --ascii role typed' });
      ttyEn.send('\r'); // Enter advances to JD field
      await ttyEn.flush();
      ttyEn.send('patterns');
      await ttyEn.waitFor((s) => s.includes('patterns'), { label: 'en --ascii jd typed' });
      ttyEn.send('\r'); // Enter on JD triggers ConfirmDialog

      const enConfirm = await ttyEn.waitFor(
        (s) =>
          s.includes('Confirm AI Topic Matching') &&
          s.includes('1 lightweight AI call') &&
          s.includes('never modifies cards'),
        { label: 'en --ascii ConfirmDialog open' },
      );
      ttyEn.assertHealthyScreen(enConfirm, 120, 36, 'en --ascii ConfirmDialog 120x36');
      ttyEn.assertAsciiPure(enConfirm, 'en --ascii ConfirmDialog 120x36');
      assert.equal(enModelCalls, 0, 'P2 guard: 0 AI calls before confirm in en --ascii');

      // Cancel with 'n' and Esc -> 0 AI calls
      ttyEn.send('n');
      await ttyEn.waitFor((s) => !s.includes('Confirm AI Topic Matching'), { label: 'en --ascii cancel n' });
      assert.equal(enModelCalls, 0);

      ttyEn.send('\u0005'); // Ctrl+E
      await ttyEn.waitFor((s) => s.includes('Confirm AI Topic Matching'), { label: 'en --ascii reopen ConfirmDialog' });
      ttyEn.send('\u001b'); // Esc
      await ttyEn.waitFor((s) => !s.includes('Confirm AI Topic Matching'), { label: 'en --ascii cancel Esc' });
      assert.equal(enModelCalls, 0);

      // Confirm with 'y' -> matched topics render at 120x36 and 80x24, ASCII pure
      ttyEn.send('\u0005');
      await ttyEn.waitFor((s) => s.includes('Confirm AI Topic Matching'), { label: 'en --ascii before y' });
      ttyEn.send('y');

      const enMatchedWide = await ttyEn.waitFor(
        (s) =>
          s.includes('Matched 2 deck topic(s):') &&
          s.includes(enTargetTopics[0]) &&
          s.includes(enTargetTopics[1]) &&
          s.includes('AI matched 2 deck topic(s)'),
        { label: 'en --ascii matched topics 120x36' },
      );
      ttyEn.assertHealthyScreen(enMatchedWide, 120, 36, 'en --ascii matched topics 120x36');
      ttyEn.assertAsciiPure(enMatchedWide, 'en --ascii matched topics 120x36');
      assert.ok(!enMatchedWide.includes('Fake Topic Should Be Filtered'), 'Invented topic must not appear in en UI');
      assert.equal(enModelCalls, 1);

      ttyEn.resize(80, 24);
      const enMatchedNarrow = await ttyEn.waitFor(
        (s) => s.includes('Matched 2 deck topic(s):') && s.includes(enTargetTopics[0]) && s.split('\n').length <= 24,
        { label: 'en --ascii matched topics 80x24' },
      );
      ttyEn.assertHealthyScreen(enMatchedNarrow, 80, 24, 'en --ascii matched topics 80x24');
      ttyEn.assertAsciiPure(enMatchedNarrow, 'en --ascii matched topics 80x24');

      // Save with Ctrl+S at 80x24
      useTuiStore.setState({ toasts: [] });
      ttyEn.send('\u0013'); // Ctrl+S
      const enSavedNarrow = await ttyEn.waitFor(
        (s) =>
          !s.includes('Add Exam Focus') &&
          s.includes('1:Focus Progress') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Saved')),
        { label: 'en --ascii Ctrl+S saved at 80x24' },
      );
      ttyEn.assertHealthyScreen(enSavedNarrow, 80, 24, 'en --ascii after save 80x24');
      ttyEn.assertAsciiPure(enSavedNarrow, 'en --ascii after save 80x24');
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      ttyEn.dispose();
      await hostEn.dispose();
    }
  });
});
