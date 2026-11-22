// Round 47 Batch Topic Retagging (card.update.batch) integration + PTY E2E tests:
// node --test tests/round47-batch-topic.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { Box, render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');

let createTuiHost = null;
let displayWidth = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(displayWidth, 'dist/ must export displayWidth');

const [
  { DeckManageModal },
  { ToastStack },
  { useTuiStore: useSrcTuiStore, DEFAULT_PREFERENCES },
] = await Promise.all([
  import('../src/views/library/DeckManageModal.tsx'),
  import('../src/components/Badge.tsx'),
  import('../src/state/store.ts'),
]);

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round47-topic-${label}-`));
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

function resetStore(store, language = 'zh', asciiMode = false) {
  store.setState({
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
      language,
      asciiMode,
    },
  });
}

function BatchTopicModalHarness({ host, deckId, width = 120, height = 36, onClose = () => {}, onUpdated }) {
  const toasts = useSrcTuiStore((s) => s.toasts);
  const dismissToast = useSrcTuiStore((s) => s.dismissToast);
  return React.createElement(
    Box,
    { width, height, flexDirection: 'column', position: 'relative' },
    React.createElement(DeckManageModal, {
      host,
      deckId,
      isActive: true,
      width,
      height,
      onClose,
      onUpdated,
    }),
    React.createElement(ToastStack, {
      toasts,
      width: Math.min(60, width - 4),
      onDismiss: dismissToast,
      autoDismissMs: 0,
    }),
  );
}

after(async () => {
  unregisterTsx?.();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 47: Batch Topic Retagging (card.update.batch)', () => {
  test('1) createTuiHost integration: load sample course -> card.update.batch updates topic on 2 cards -> deck.get reflects new topic', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      const snap0 = await host.call('snapshot', {});
      assert.equal(snap0.ok, true);
      const origDeck = (snap0.value?.decks ?? []).find((d) => !d.systemKind);
      assert.ok(origDeck, 'sample course must include an ordinary deck');

      const origGet0 = await host.call('deck.get', { id: origDeck.id });
      assert.equal(origGet0.ok, true, origGet0.error?.message);
      assert.ok(origGet0.value.cards.length >= 2, 'sample deck must have at least 2 cards');
      const c1 = origGet0.value.cards[0];
      const c2 = origGet0.value.cards[1];
      const c3 = origGet0.value.cards[2];

      const newTopic = 'Round47-Unified-Topic';
      const batchRes = await host.call('card.update.batch', {
        updates: [c1.id, c2.id].map((cardId) => ({
          deckId: origDeck.id,
          cardId,
          patch: { topic: newTopic },
          reason: 'Batch topic retag from TUI',
        })),
      });
      assert.equal(batchRes.ok, true, `card.update.batch failed: ${batchRes.error?.message}`);
      assert.equal(batchRes.value?.updated, 2, 'updated count must be 2');
      assert.equal(batchRes.value?.failed, 0, 'failed count must be 0');
      assert.equal(batchRes.value?.results?.length, 2);
      assert.ok(batchRes.value.results.every((r) => r.ok === true));

      const afterGet = await host.call('deck.get', { id: origDeck.id });
      assert.equal(afterGet.ok, true, afterGet.error?.message);
      const updatedC1 = afterGet.value.cards.find((c) => c.id === c1.id);
      const updatedC2 = afterGet.value.cards.find((c) => c.id === c2.id);
      assert.equal(updatedC1?.topic, newTopic, 'c1 topic must be updated');
      assert.equal(updatedC2?.topic, newTopic, 'c2 topic must be updated');
      if (c3) {
        const untouchedC3 = afterGet.value.cards.find((c) => c.id === c3.id);
        assert.equal(untouchedC3?.topic, c3.topic, 'unselected c3 topic must remain untouched');
      }
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: DeckManageModal Space multi-select 2 cards -> T -> Esc cancel -> T -> type topic -> Enter in zh & --ascii en', async () => {
    // 2a) Default zh mode
    {
      const base = await makeTempDir('pty-zh');
      const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
      process.env.DSH_HOME = env.DSH_HOME;
      const libraryRoot = join(base, 'library');

      const host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        providerDiscovery: fakeDiscovery(),
        skipAutoProbe: true,
        language: 'zh',
      });

      let tty = null;
      let inkInstance = null;
      let onUpdatedCount = 0;
      try {
        const sampleRes = await host.call('sample.load', { language: 'zh' });
        assert.equal(sampleRes.ok, true, sampleRes.error?.message);

        const snap0 = await host.call('snapshot', {});
        const origDeck = (snap0.value?.decks ?? []).find((d) => !d.systemKind);
        assert.ok(origDeck, 'sample ordinary deck required');

        const origDetail = await host.call('deck.get', { id: origDeck.id });
        const origCount = origDetail.value.cards.length;
        assert.ok(origCount >= 2, 'sample deck needs >= 2 cards');
        const c1 = origDetail.value.cards[0];
        const c2 = origDetail.value.cards[1];
        const origTopic1 = c1.topic;
        const origTopic2 = c2.topic;

        resetStore(useSrcTuiStore, 'zh', false);
        tty = createVirtualTty(120, 36);
        inkInstance = render(
          React.createElement(BatchTopicModalHarness, {
            host,
            deckId: origDeck.id,
            width: 120,
            height: 36,
            onUpdated: () => {
              onUpdatedCount += 1;
            },
          }),
          {
            stdin: tty.stdin,
            stdout: tty.stdout,
            stderr: tty.stderr,
            exitOnCtrlC: false,
            patchConsole: false,
          },
        );
        await tty.firstFramePromise;

        const zhInitial = await tty.waitFor(
          (s) =>
            s.includes('题组管理') &&
            s.includes(`${origCount}/${origCount} 题`) &&
            !s.includes('正在读取题组卡片'),
          { label: 'DeckManageModal loaded in zh mode' },
        );
        tty.assertHealthyScreen(zhInitial, 120, 36, 'DeckManageModal zh initial');

        // Multi-select 2 cards with Space
        tty.send(' ');
        await tty.waitFor((s) => s.includes('已选 1'), { label: 'first card selected in zh' });
        tty.send('j');
        await tty.flush();
        tty.send(' ');
        const zhSelected = await tty.waitFor(
          (s) => s.includes('已选 2') && s.includes('[T]改主题'),
          { label: '2 cards selected and [T]改主题 hint shown in zh' },
        );
        tty.assertHealthyScreen(zhSelected, 120, 36, 'DeckManageModal zh 2 selected');

        // Press T -> Esc cancels cleanly
        tty.send('T');
        const zhTopicPrompt = await tty.waitFor(
          (s) => s.includes('批量修改主题标签 (2 题):'),
          { label: 'topic input opened in zh mode' },
        );
        tty.assertHealthyScreen(zhTopicPrompt, 120, 36, 'DeckManageModal zh topic prompt');

        tty.send('\u001b');
        const zhCancelled = await tty.waitFor(
          (s) => !s.includes('批量修改主题标签') && s.includes('已选 2'),
          { label: 'topic input cancelled with Esc in zh mode' },
        );
        tty.assertHealthyScreen(zhCancelled, 120, 36, 'DeckManageModal zh after Esc cancel');
        assert.equal(onUpdatedCount, 0, 'Esc cancel must not trigger onUpdated');

        const afterCancelGet = await host.call('deck.get', { id: origDeck.id });
        assert.equal(afterCancelGet.value.cards.find((c) => c.id === c1.id)?.topic, origTopic1);
        assert.equal(afterCancelGet.value.cards.find((c) => c.id === c2.id)?.topic, origTopic2);

        // Press T -> type new topic -> Enter
        const targetTopicZh = 'R47TopicZh';
        tty.send('T');
        await tty.waitFor((s) => s.includes('批量修改主题标签 (2 题):'), { label: 'topic input reopened in zh mode' });
        tty.send(targetTopicZh);
        await tty.flush();
        tty.send('\r');

        const zhAfterTopic = await tty.waitFor(
          (s) =>
            !s.includes('批量修改主题标签') &&
            !s.includes('已选 2') &&
            s.includes(targetTopicZh) &&
            useSrcTuiStore.getState().toasts.some(
              (toast) => toast.tone === 'success' && toast.text.includes('2') && toast.text.includes(targetTopicZh),
            ),
          { label: '2 cards retagged cleanly in zh mode' },
        );
        tty.assertHealthyScreen(zhAfterTopic, 120, 36, 'DeckManageModal zh after batch topic');
        assert.equal(onUpdatedCount, 1, 'onUpdated must fire once after batch topic');

        const afterTopicGet = await host.call('deck.get', { id: origDeck.id });
        assert.equal(afterTopicGet.value.cards.find((c) => c.id === c1.id)?.topic, targetTopicZh);
        assert.equal(afterTopicGet.value.cards.find((c) => c.id === c2.id)?.topic, targetTopicZh);
      } finally {
        inkInstance?.unmount();
        tty?.dispose();
        await host.dispose();
      }
    }

    // 2b) --ascii en mode
    {
      const base = await makeTempDir('pty-en-ascii');
      const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
      process.env.DSH_HOME = env.DSH_HOME;
      const libraryRoot = join(base, 'library');

      const host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        providerDiscovery: fakeDiscovery(),
        skipAutoProbe: true,
        language: 'en',
      });

      let tty = null;
      let inkInstance = null;
      let onUpdatedCount = 0;
      try {
        const sampleRes = await host.call('sample.load', { language: 'en' });
        assert.equal(sampleRes.ok, true, sampleRes.error?.message);

        const snap0 = await host.call('snapshot', {});
        const origDeck = (snap0.value?.decks ?? []).find((d) => !d.systemKind);
        assert.ok(origDeck, 'sample ordinary deck required');

        const origDetail = await host.call('deck.get', { id: origDeck.id });
        const origCount = origDetail.value.cards.length;
        assert.ok(origCount >= 2, 'sample deck needs >= 2 cards');
        const c1 = origDetail.value.cards[0];
        const c2 = origDetail.value.cards[1];

        resetStore(useSrcTuiStore, 'en', true);
        tty = createVirtualTty(120, 36);
        inkInstance = render(
          React.createElement(BatchTopicModalHarness, {
            host,
            deckId: origDeck.id,
            width: 120,
            height: 36,
            onUpdated: () => {
              onUpdatedCount += 1;
            },
          }),
          {
            stdin: tty.stdin,
            stdout: tty.stdout,
            stderr: tty.stderr,
            exitOnCtrlC: false,
            patchConsole: false,
          },
        );
        await tty.firstFramePromise;

        const enInitial = await tty.waitFor(
          (s) =>
            s.includes('Manage Deck') &&
            s.includes(`${origCount}/${origCount} cards`) &&
            !s.includes('Loading deck cards'),
          { label: 'DeckManageModal loaded in --ascii en mode' },
        );
        tty.assertHealthyScreen(enInitial, 120, 36, 'DeckManageModal en ascii initial');
        tty.assertAsciiPure(enInitial, 'DeckManageModal en ascii initial');

        // Multi-select 2 cards with Space
        tty.send(' ');
        await tty.waitFor((s) => s.includes('1 sel'), { label: 'first card selected in en ascii' });
        tty.send('j');
        await tty.flush();
        tty.send(' ');
        const enSelected = await tty.waitFor(
          (s) => s.includes('2 sel') && s.includes('[T]Topic'),
          { label: '2 cards selected and [T]Topic hint shown in en ascii' },
        );
        tty.assertHealthyScreen(enSelected, 120, 36, 'DeckManageModal en ascii 2 selected');
        tty.assertAsciiPure(enSelected, 'DeckManageModal en ascii 2 selected');

        // Press T -> type new topic -> Enter
        const targetTopicEn = 'R47TopicEn';
        tty.send('T');
        const enTopicPrompt = await tty.waitFor(
          (s) => s.includes('Batch retag topic (2 selected):'),
          { label: 'topic input opened in --ascii en mode' },
        );
        tty.assertHealthyScreen(enTopicPrompt, 120, 36, 'DeckManageModal en ascii topic prompt');
        tty.assertAsciiPure(enTopicPrompt, 'DeckManageModal en ascii topic prompt');

        tty.send(targetTopicEn);
        await tty.flush();
        tty.send('\r');

        const enAfterTopic = await tty.waitFor(
          (s) =>
            !s.includes('Batch retag topic') &&
            !s.includes('2 sel') &&
            s.includes(targetTopicEn) &&
            useSrcTuiStore.getState().toasts.some(
              (toast) => toast.tone === 'success' && toast.text.includes(`Retagged 2 card(s) to "${targetTopicEn}"`),
            ),
          { label: '2 cards retagged cleanly in --ascii en mode' },
        );
        tty.assertHealthyScreen(enAfterTopic, 120, 36, 'DeckManageModal en ascii after batch topic');
        tty.assertAsciiPure(enAfterTopic, 'DeckManageModal en ascii after batch topic');
        assert.equal(onUpdatedCount, 1, 'onUpdated must fire once after batch topic');

        const afterTopicGet = await host.call('deck.get', { id: origDeck.id });
        assert.equal(afterTopicGet.value.cards.find((c) => c.id === c1.id)?.topic, targetTopicEn);
        assert.equal(afterTopicGet.value.cards.find((c) => c.id === c2.id)?.topic, targetTopicEn);
      } finally {
        inkInstance?.unmount();
        tty?.dispose();
        await host.dispose();
      }
    }
  });
});
