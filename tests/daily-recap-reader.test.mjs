/* global document, window, localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { pick } from '../scripts/qa/pick.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=';
const markdown = `# 今日学习回顾\n\n## 概念与错因\n\n检索练习帮助记忆，检索练习需要解释原因。\n\n公式：$x^2 + \\frac{1}{2}$\n\n![知识关系](${image})\n\n<script>window.unsafeRecap = true</script>\n\n${'这一段完整解释学习方法，以及为什么要回看自己的判断。\n\n'.repeat(24)}## 明天的复习\n\n${'用自己的话再讲一遍，把判断与理由一一对应起来。\n\n'.repeat(14)}`;

const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import DocumentViewer from './ui/document-preview/DocumentViewer.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  import css from './ui/styles.js';
  setUiLanguage('zh');
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  window.readerCalls = [];
  const originalMarkdown = ${JSON.stringify(markdown)};
  const materialSource = { id: 'material-source', title: '课程资料', text: '# 课程资料\\n\\n## 第一部分\\n\\n学习内容。', format: 'md' };
  const material = { id: 'material-document', documentId: 'material-document', revision: 'r1', format: 'md', originalAvailable: false, sources: [materialSource], original: { status: 'none' } };
  const call = async (name, params) => {
    window.readerCalls.push({ name, params });
    if (name === 'materials.document.get') return window.convertedMaterial?.document || (window.holdMaterialLoad ? new Promise(resolve => { window.releaseMaterialLoad = () => resolve(material); }) : material);
    if (name === 'materials.links.list') return { links: [] };
    if (name === 'materials.translation.list') return { items: [] };
    if (name === 'materials.pages.cards') return { cards: [] };
    if (name === 'bank.decks.list') return { decks: [] };
    return [];
  };
  const data = { sources: [materialSource], decks: [] };
  const root = createRoot(document.getElementById('root'));
  window.showLocal = (text = originalMarkdown) => root.render(<DocumentViewer
    source={{ id: 'recap-local', title: '今日学习回顾', text: originalMarkdown, format: 'md' }}
    localContent={{ id: 'recap-local', title: '今日学习回顾', markdown: text }} call={call} data={data}
    onGenerate={() => {}} onPracticePages={() => {}} onCaseFromPassage={() => {}} />);
  window.showMaterial = () => root.render(<DocumentViewer source={materialSource} call={call} data={data} onGenerate={() => {}} />);
  window.showConverted = (source, document) => {
    window.convertedMaterial = { source, document };
    root.render(<DocumentViewer source={source} call={call} data={{ sources: [source], decks: [] }} />);
  };
  window.unmountReader = () => root.render(null);
  window.showLocal();
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
  loader: { '.css': 'text' }, logLevel: 'silent' });

async function openReader(t, width = 1280) {
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(error.message)) throw error;
    t.skip('Chromium unavailable'); return null;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width, height: 760 }, reducedMotion: 'reduce' });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === 'http://daily-recap-reader.test/') return route.fulfill({ contentType: 'text/html', body: '<main class="study-app" id="root"></main>' });
    requests.push(url); return route.abort();
  });
  await page.goto('http://daily-recap-reader.test/');
  await page.addStyleTag({ content: 'body{margin:0}#root{display:flex;height:720px;width:100%;min-width:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('.study-document-body').waitFor();
  return { page, errors, requests };
}

test('local recap shares the reader, renders math/images and never exposes material operations', { timeout: 45000 }, async t => {
  const opened = await openReader(t); if (!opened) return;
  const { page, errors, requests } = opened;
  await page.getByRole('heading', { name: '今日学习回顾', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.readerCalls), [], 'reading a saved recap must not send a synthetic source ID to materials');
  assert.equal(await page.locator('.reader-tools').count(), 0);
  assert.equal(await page.getByRole('button', { name: '学习工具', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '从这份资料出题', exact: true }).count(), 0);
  assert.equal(await page.locator('.reader-assist, .reader-practice, .study-original-notice, .translation-menu').count(), 0);
  assert.equal(await page.locator('.study-document-body math').count(), 1);
  await page.waitForFunction(() => document.querySelector('.study-document-body img')?.naturalWidth === 1);
  assert.equal(await page.locator('.study-document-body img').getAttribute('loading'), 'lazy');
  assert.equal(await page.locator('.study-document-body img').getAttribute('alt'), '知识关系');
  assert.equal(await page.evaluate(() => window.unsafeRecap), undefined);

  await page.locator('.reader-scroll').focus();
  await page.keyboard.press('Control+f');
  await page.getByRole('searchbox', { name: '在文中查找' }).fill('检索练习');
  await page.waitForFunction(() => document.querySelector('.reader-find__count')?.textContent === '1 / 2');
  await page.getByRole('searchbox', { name: '在文中查找' }).press('Enter');
  await page.waitForFunction(() => document.querySelector('.reader-find__count')?.textContent === '2 / 2');
  await page.getByRole('searchbox', { name: '在文中查找' }).press('Escape');
  assert.equal(await page.locator('.reader-find').count(), 0);
  await page.locator('.reader-outline__link').filter({ hasText: '明天的复习' }).click();
  await page.waitForFunction(() => document.querySelector('.reader-scroll').scrollTop > 100);
  await page.waitForFunction(() => document.querySelector('.reader-toolbar__where')?.textContent.includes('明天的复习'));
  assert.ok(await page.locator('.reader-pager [data-direction="previous"]').count());
  assert.deepEqual(await page.evaluate(() => window.readerCalls), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
});

test('a real converted recap reopens as Markdown with math and a heading outline in the material reader', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'recap-material-reader-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update(state => { state.notes.push({ id: 'converted-recap', kind: 'daily-recap-history', cards: [],
    title: '资料里的当日总结', markdown, status: 'draft', revision: 0, daily: { course: '学习方法' } }); });
  const payload = await service.call('note.material.prepare', { id: 'converted-recap', expectedRevision: 0 });
  const source = await service.call('source.add', payload);
  const document = await service.call('materials.document.get', { sourceId: source.id });
  assert.equal(document.format, 'md');
  const opened = await openReader(t); if (!opened) return;
  const { page, errors } = opened;
  await page.evaluate(({ source, document }) => window.showConverted(source, document), { source, document });
  await page.waitForFunction(() => window.readerCalls.some(call => call.name === 'materials.document.get'));
  await page.getByRole('heading', { name: '概念与错因', exact: true }).waitFor();
  assert.equal(await page.locator('.study-document-body math').count(), 1);
  await page.locator('.reader-outline__link').filter({ hasText: '明天的复习' }).waitFor();
  assert.deepEqual(errors, []);
});

test('recap edits update the reading and outline while retaining the shared reading preferences', { timeout: 45000 }, async t => {
  const opened = await openReader(t); if (!opened) return;
  const { page, errors } = opened;
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  await page.getByRole('button', { name: '增大字号', exact: true }).click();
  await page.getByRole('button', { name: '宽', exact: true }).click();
  await pick(page, page.getByRole('combobox', { name: '字体', exact: true }), '宋体 / 衬线');
  await page.getByRole('button', { name: '纸张', exact: true }).click();
  assert.equal(await page.getByRole('group', { name: '下划线', exact: true }).count(), 0);
  const chosen = await page.evaluate(() => JSON.parse(localStorage.getItem('study-reader-settings')));
  assert.equal(chosen.size, 17); assert.equal(chosen.width, 'wide'); assert.equal(chosen.face, 'serif'); assert.equal(chosen.tone, 'paper');
  await page.evaluate(() => window.showLocal('# 更新后的学习回顾\n\n## 新的薄弱点\n\n新的讲解内容。'));
  await page.getByRole('heading', { name: '更新后的学习回顾', exact: true }).waitFor();
  assert.equal(await page.locator('.study-document-body').getByText('新的讲解内容。', { exact: true }).count(), 1);
  await page.locator('.reader-outline__link').filter({ hasText: '新的薄弱点' }).waitFor();
  assert.equal(await page.locator('.reader-outline__link').filter({ hasText: '明天的复习' }).count(), 0);
  await page.getByRole('button', { name: '原文', exact: true }).click();
  assert.match(await page.locator('.study-document-body').innerText(), /^# 更新后的学习回顾/);
  await page.evaluate(() => window.showLocal(''));
  await page.waitForFunction(() => document.querySelector('.study-document-body')?.textContent === '');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  assert.equal(await page.locator('.study-document-body').innerText(), '', 'an empty edit must not fall back to the synthetic source’s older text');
  await page.evaluate(() => window.unmountReader());
  await page.locator('.study-document-viewer').waitFor({ state: 'detached' });
  await page.evaluate(() => window.showLocal());
  await page.getByRole('heading', { name: '今日学习回顾', exact: true }).waitFor();
  assert.equal(await page.locator('.study-document-viewer').getAttribute('data-tone'), 'paper');
  assert.equal(await page.locator('.study-document-viewer').getAttribute('data-face'), 'serif');
  assert.equal(await page.locator('.study-document-viewer').evaluate(node => node.style.getPropertyValue('--reader-size')), '17px');
  assert.equal(await page.locator('.study-document-viewer').evaluate(node => node.style.getPropertyValue('--reader-measure')), '56em');
  assert.deepEqual(await page.evaluate(() => window.readerCalls), []);
  assert.deepEqual(errors, []);
});

test('a delayed material load cannot replace local writing or start source requests after switching back', { timeout: 45000 }, async t => {
  const opened = await openReader(t); if (!opened) return;
  const { page, errors } = opened;
  await page.evaluate(() => { window.holdMaterialLoad = true; window.showMaterial(); });
  await page.waitForFunction(() => typeof window.releaseMaterialLoad === 'function');
  await page.evaluate(() => window.showLocal());
  await page.getByRole('heading', { name: '今日学习回顾', exact: true }).waitFor();
  const calls = await page.evaluate(() => window.readerCalls);
  await page.evaluate(async () => { window.releaseMaterialLoad(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.deepEqual(await page.evaluate(() => window.readerCalls), calls);
  assert.equal(await page.getByRole('heading', { name: '今日学习回顾', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '学习工具', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test('narrow recap keeps reading controls reachable and source reading retains its material capabilities', { timeout: 45000 }, async t => {
  const opened = await openReader(t, 390); if (!opened) return;
  const { page, errors } = opened;
  await page.waitForFunction(() => document.querySelector('.study-document-viewer')?.dataset.narrow === 'true');
  await page.getByRole('button', { name: '目录', exact: true }).click();
  await page.locator('.reader-outline').waitFor();
  await page.locator('.reader-outline__link').filter({ hasText: '明天的复习' }).click();
  assert.equal(await page.locator('.reader-outline').count(), 0, 'the narrow outline closes after navigation');
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  const bounds = await page.locator('.reader-popover__panel').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391, 'the shared Aa panel stays within the viewport');
  const controls = await page.locator('.reader-toolbar button').evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label') || node.textContent, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })));
  assert.ok(controls.every(control => control.left >= 0 && control.right <= 391), JSON.stringify(controls));
  await page.evaluate(() => window.showMaterial());
  await page.getByRole('heading', { name: '课程资料', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '学习工具', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '从这份资料出题', exact: true }).count(), 1);
  const materialCalls = await page.evaluate(() => window.readerCalls);
  assert.ok(materialCalls.some(entry => entry.name === 'materials.document.get' && entry.params.sourceId === 'material-source'));
  assert.ok(materialCalls.some(entry => entry.name === 'materials.links.list' && entry.params.documentId === 'material-document'));
  const count = materialCalls.length;
  await page.evaluate(() => window.showLocal());
  await page.getByRole('heading', { name: '今日学习回顾', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '学习工具', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.readerCalls.length), count, 'returning to local content makes no new material requests');
  assert.deepEqual(errors, []);
});
