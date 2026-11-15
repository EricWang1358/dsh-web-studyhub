/* global window, requestAnimationFrame */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Store } from '../lib/store.js';
import { localDate } from '../lib/board-model.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

const appBundlePromise = build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import App from './ui/App.jsx';
      import { setUiLanguage } from './ui/i18n.js';
      import css from './ui/styles.js';
      setUiLanguage('zh');
      const style = document.createElement('style');
      style.textContent = css;
      document.head.append(style);
      window.callStudy = async (action, args) => {
        const reply = await window.invokeStudy(action, args);
        if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code });
        return reply.value;
      };
      let root = null;
      window.mountStudyApp = (host) => {
        const el = document.getElementById('root');
        if (!root) root = createRoot(el);
        root.render(<App call={window.callStudy} host={host} />);
      };
      window.unmountStudyApp = () => {
        if (root) {
          root.unmount();
          root = null;
        }
      };
    `,
    resolveDir: process.cwd(),
    loader: 'jsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  loader: { '.css': 'text' },
  logLevel: 'silent',
});

test('warm re-entry paints the previous page in zero RPC wait without LiveClass or spinner and revalidates with since', { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'study-warm-reopen-'));
  let server, browser;
  t.after(async () => {
    await browser?.close();
    await server?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const store = new Store(join(dir, 'library'));
  await store.update((state) => {
    state.sources.push({
      id: 'src-1',
      title: '第一讲讲义',
      text: '主动回忆能显著提高长期记忆保持率。',
      createdAt: new Date().toISOString(),
      courses: ['学习方法'],
    });
    state.decks.push({
      id: 'deck-1',
      title: '检索练习',
      course: '学习方法',
      cards: [{
        id: 'q1',
        kind: 'flashcard',
        topic: '主动回忆',
        prompt: '什么是主动回忆？',
        answer: '不看答案尝试主动提取知识。',
        review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null },
      }],
    });
  });

  server = await createPreviewServer({ port: 0, libraryRoot: store.root, home: join(dir, 'home'), model: createFakeModel() });
  const initialBoard = await previewCall(server, 'board.get', {});
  await previewCall(server, 'board.card.add', {
    revision: initialBoard.revision,
    title: '复习第一章讲义',
    plannedDate: localDate(),
  });

  const compiled = await appBundlePromise;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(error.message)) throw error;
    t.skip('Chromium unavailable');
    return;
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const requests = [], errors = [];
  let gate = null;
  let lastFingerprint = '';
  let lastBoardRevision = null;
  page.on('pageerror', (error) => errors.push(error.message));

  await page.exposeFunction('invokeStudy', async (action, args) => {
    requests.push({ action, args });
    if (gate) await gate;
    try {
      const value = await previewCall(server, action, args);
      if (action === 'snapshot' && value?.fingerprint) lastFingerprint = value.fingerprint;
      if (action === 'board.get' && Number.isSafeInteger(value?.revision)) lastBoardRevision = value.revision;
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error.message, code: error.code };
    }
  });

  await page.route('**/*', (route) => (route.request().url() === 'http://warm-reopen.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<main id="root"></main>' })
    : route.abort()));
  await page.goto('http://warm-reopen.test/');
  await page.addScriptTag({ content: compiled.outputFiles[0].text });

  const host = {
    warmKey: 'session-warm-reopen',
    placement: 'page',
    capabilities: { edition: 'plugin', chat: true, agentTasks: false, landing: false },
  };

  // 1st mount: initial landing goes to board, LiveClass does not mount, then user navigates to 资料 (`sources`).
  await page.evaluate((h) => window.mountStudyApp(h), host);
  await page.locator('.study-app[data-usage-area="board"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('section.live-class').count(), 0);

  await page.locator('[data-tour="nav-sources"]').click();
  await page.locator('.study-app[data-usage-area="sources"]').waitFor({ timeout: 15000 });
  // Allow post-navigation effects (`writeWarmView`) to flush before unmounting.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const firstFingerprint = lastFingerprint;
  const firstBoardRevision = lastBoardRevision;
  assert.ok(firstFingerprint, '1st mount must capture a server snapshot fingerprint');
  assert.ok(Number.isSafeInteger(firstBoardRevision), '1st mount must capture a board revision');

  await page.evaluate(() => window.unmountStudyApp());
  assert.equal(await page.locator('#root > *').count(), 0);

  // 2nd mount with RPC transport held behind `gate`: must paint 资料 immediately without `.app-loading`.
  requests.length = 0;
  let releaseGate;
  gate = new Promise((resolve) => { releaseGate = resolve; });
  await page.evaluate((h) => window.mountStudyApp(h), host);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  assert.equal(await page.locator('.app-loading').count(), 0);
  assert.equal(await page.locator('.study-app[data-usage-area="sources"]').count(), 1);
  assert.equal(await page.locator('section.live-class').count(), 0);

  // Release RPCs and confirm incremental `since` revalidation requests are issued.
  releaseGate();
  gate = null;
  await page.waitForFunction(() => true);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const hasSnapshot = requests.some((r) => r.action === 'snapshot');
    const hasBoard = requests.some((r) => r.action === 'board.get');
    if (hasSnapshot && hasBoard) break;
    await new Promise((r) => setTimeout(r, 25));
  }

  const reopenSnapshot = requests.find((r) => r.action === 'snapshot');
  const reopenBoard = requests.find((r) => r.action === 'board.get');
  assert.ok(reopenSnapshot, 'expected background snapshot revalidation on 2nd mount');
  assert.equal(reopenSnapshot.args?.since, firstFingerprint);
  assert.equal(reopenSnapshot.args?.partial, true);
  assert.equal(reopenSnapshot.args?.uiLanguage, 'zh');

  assert.ok(reopenBoard, 'expected background board.get revalidation on 2nd mount');
  assert.equal(reopenBoard.args?.since, firstBoardRevision);
  assert.equal(reopenBoard.args?.uiLanguage, 'zh');
  assert.deepEqual(errors, []);
});
