import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Store } from '../lib/store.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import App from './ui/App.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  import css from './ui/style.css';
  setUiLanguage('zh');
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  window.callStudy = async (action, args) => {
    const reply = await window.invokeStudy(action, args);
    if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code });
    return reply.value;
  };
  createRoot(document.getElementById('root')).render(<App call={window.callStudy} />);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
  loader: { '.css': 'text' }, logLevel: 'silent' });

test('reading a recap returns to completed results without reopening or moving the closed run', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'recap-navigation-'));
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const store = new Store(join(root, 'library'));
  await store.update(state => {
    state.decks.push({ id: 'deck', title: '检索练习', course: '学习方法', cards: Array.from({ length: 10 }, (_, i) => ({
      id: `q${i}`, kind: 'quiz', topic: '主动回忆', prompt: `第 ${i + 1} 题：怎样用练习检查理解？`,
      answer: 'a', explanation: '不看答案，尝试解释推理，再对照反馈检查。',
      options: [{ id: 'a', text: '尝试回忆并解释推理', correct: true }, { id: 'b', text: '只看答案', correct: false }],
      review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null },
    })) });
    state.attempts.push(...Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, deckId: 'deck', quiz_id: `q${i}`,
      grade: 4, assessment: 'graded', timestamp: new Date().toISOString() })));
  });
  server = await createPreviewServer({ port: 0, libraryRoot: store.root, home: join(root, 'home'), model: createFakeModel() });
  const started = await previewCall(server, 'review.start', { mode: 'new', scope: [{ deckId: 'deck', cardId: 'q9' }], count: 1, fresh: true });
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(error.message)) throw error;
    t.skip('Chromium unavailable'); return;
  }
  const page = await browser.newPage({ locale: 'zh-CN', reducedMotion: 'reduce' });
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('invokeStudy', async (action, args) => {
    requests.push({ action, args });
    try { return { ok: true, value: await previewCall(server, action, args) }; }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
  });
  await page.route('**/*', route => route.request().url() === 'http://recap-navigation.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<main id="root"></main>' }) : route.abort());
  await page.goto('http://recap-navigation.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByRole('button', { name: /^回到题目/ }).click();
  await page.getByRole('button', { name: /尝试回忆并解释推理/ }).click();
  await page.getByRole('button', { name: '完成 →', exact: true }).click();
  await page.getByRole('heading', { name: '这一轮，完成了。', exact: true }).waitFor();
  await page.getByRole('button', { name: '生成今日错题讲解合集', exact: true }).click();
  await page.getByRole('button', { name: '阅读今日合集', exact: true }).click({ timeout: 15000 });
  await page.locator('.note-reader .study-document-body').waitFor();
  // Saved writing stays usable even if one of its original questions is removed later.
  await store.update(state => { state.decks[0].cards.splice(0, 1); });
  await page.getByRole('button', { name: '编辑内容', exact: true }).click();
  await page.getByLabel('文章标题', { exact: true }).fill('我保留的当日总结');
  await page.getByRole('button', { name: '保存合集', exact: true }).click();
  await page.getByText('合集已保存', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回阅读', exact: true }).click();
  await page.locator('summary').getByText('转成资料', { exact: true }).click();
  await page.getByRole('button', { name: '保存当前内容为资料', exact: true }).click();
  await page.getByRole('button', { name: '已保存为资料', exact: true }).waitFor({ timeout: 10000 }).catch(async error => {
    t.diagnostic(await page.locator('.blog-notes-page [role="status"]').allTextContents());
    t.diagnostic(requests.slice(-10).map(request => request.action).join(', '));
    throw error;
  });
  const material = (await store.read()).sources.find(source => source.id.startsWith('note-material-'));
  assert.ok(material);
  assert.equal((await previewCall(server, 'materials.document.get', { sourceId: material.id })).format, 'md');
  const beforeReturn = requests.length;
  await page.getByRole('button', { name: '返回本轮学习结果', exact: true }).click();
  await page.getByRole('heading', { name: '这一轮，完成了。', exact: true }).waitFor({ timeout: 10000 });
  assert.ok(requests.slice(beforeReturn).some(item => item.action === 'review.get' && item.args.runId === started.id));
  assert.ok(!requests.slice(beforeReturn).some(item => item.action === 'review.move'), 'a completed result is read without moving its queue');
  assert.equal((await previewCall(server, 'review.get', { runId: started.id })).complete, true);
  assert.deepEqual(errors, []);
});
