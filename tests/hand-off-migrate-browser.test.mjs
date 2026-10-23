/* global window document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { StudyService } from '../lib/service.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* 「发给主会话」 on every place that handed over before the shared unit existed (the hand-off plan, S2b), in Chromium through the REAL host adapter
   (ui/host/workspace.jsx) and the REAL App on a real library; only DSH is faked and its conversation is wrapped in a Proxy whose submit throws.
   Each place: the shared control (one label, its rule in a layered Tooltip, never a title attribute), the shared receipt after it (no line of the page's
   own), the message in the composer by setDraft alone (the learner's sentence first), the learner's own words in the composer kept. Places: 创建题组 › 录题, the library home (a deck's ⋯,
   a topic's icon, the topic-group reminder), 知识骨架 (the groups, the primary button, an open skeleton's two links, its extension box, a concept's),
   the result page, 学习流 (the list, the editor, the start page, a step; for the editor and the step also the save that is refused, which hands nothing over), 分步出题, 音频.
   MIGRATE_SHOTS=<dir> writes screenshots (zh; 1280×800 and 390×844, light and dark); otherwise only 1280 light runs. */

const host = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import * as workspace from './ui/host/workspace.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  setUiLanguage('zh');
  const seats = {}, roots = {}, log = window.dshLog = [];
  const rpc = { call: async (_route, _path, payload) => {
    const reply = await window.invokeStudy(payload.action, payload.args);
    return reply.ok ? { ok: true, value: reply.value } : { ok: false, error: { message: reply.error, code: reply.code } };
  } };
  const shell = {
    get projection() { return { detectText: window.composerText }; },
    state: { getSnapshot: () => ({ draft: window.composerText, attachmentIds: [] }) },
    setDraft: (text) => { log.push('setDraft'); window.composerText = text; },
    submit: () => { log.push('submit'); },
    actions: { submit: () => { log.push('actions.submit'); } },
  };
  const guarded = (target, path) => new Proxy(target, { get(object, key) {
    if (key === 'submit') { log.push('submit-touched:' + path); throw new Error(path + '.submit must never be called'); }
    const value = object[key];
    return value && typeof value === 'object' ? guarded(value, path + '.' + String(key)) : value;
  } });
  const conversation = { input: { for: () => guarded(shell, 'input') } };
  const services = {
    connection: { rpc },
    layout: { selectPanel: (id) => { if (window.dshReady) log.push('selectPanel:' + id); } },
    sessions: { scope: () => ({ get: (name) => (name === 'conversation' && !window.noChat ? conversation : undefined) }) },
  };
  const ctx = { get: (name) => services[name], effect(fn) { fn(); }, inject: (_n, fn) => fn(ctx),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: (_n, fn) => fn(), register: (descriptor, component) => { seats[descriptor.name + ':' + (descriptor.key || descriptor.id)] = component; return () => {}; } },
    sidebarRightTabs: { register: () => () => {} } };
  window.installDsh = () => workspace.apply(ctx, () => {});
  window.mountPage = () => { roots.page ||= createRoot(document.getElementById('main')); roots.page.render(React.createElement(seats['study-workspace.page:undefined'], { sessionId: 's1' })); };
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });

const shots = process.env.MIGRATE_SHOTS;
const views = shots ? [[1280, 800, 'light'], [1280, 800, 'dark'], [390, 844, 'light'], [390, 844, 'dark']] : [[1280, 800, 'light']];

const card = (n) => ({ id: `c${n}`, kind: 'flashcard', topic: `主题${n}`, objective: `目标${n}`, prompt: `问题 ${n}？`, answer: `答案 ${n}`, hint: '', explanation: '因为。', misconception: '', citations: [] });
const bookPage = (n) => ({ id: `bp${n}`, title: `操作系统教材 · p.${n}`, text: '进程调度与内存管理。'.repeat(3600), createdAt: '2026-10-01T08:00:00.000Z', courses: ['操作系统'],
  document: { id: 'book', page: n, totalPages: 12, bookTitle: '操作系统教材', origin: 'converted', converter: 'mineru' } });

/** A library with one deck of fourteen topics (no topic groups yet), a saved skeleton, a finished round with weak topics and a big book for 分步出题. */
async function seed(root) {
  const service = new StudyService(root);
  await service.store.update((state) => {
    state.decks.push({ id: 'd1', title: '操作系统', course: '操作系统', cards: Array.from({ length: 14 }, (_, i) => card(i + 1)) });
    for (let n = 1; n <= 12; n++) state.sources.push(bookPage(n));
    state.focus = { ...(state.focus || {}), course: '操作系统' };
  });
  await service.call('skeleton.save', { skeleton: { title: '进程与线程', scope: [{ deckId: 'd1', topic: '主题1' }, { deckId: 'd1', topic: '主题2' }], overview: '进程是资源分配的单位，线程是调度的单位。', classNote: '线程属于进程。',
    nodes: [{ id: 'n1', term: '进程', meaning: '资源分配的单位', attributes: ['独立的地址空间'], cards: [{ deckId: 'd1', cardId: 'c1' }] },
      { id: 'n2', term: '线程', meaning: '调度的单位', attributes: ['共享进程的地址空间'], parent: 'n1', cards: [{ deckId: 'd1', cardId: 'c2' }] }],
    relations: [{ from: 'n2', to: 'n1', type: 'part-of' }], sequences: [] } });
  let run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd1', topic: '主题1' }, { deckId: 'd1', topic: '主题2' }, { deckId: 'd1', topic: '主题3' }], fresh: true });
  while (!run.complete) {
    await service.call('review.reveal', { runId: run.id, cardId: run.card.id });
    await service.call('review.answer', { runId: run.id, cardId: run.card.id, grade: 1 });
    run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  await service.dispose?.();
}

const RULE = '只填进主会话的输入框';

test('发给主会话 on the places that handed over before: the shared control, the shared notice, the prompt in the box and nothing sent', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const root = await mkdtemp(join(tmpdir(), 'hand-off-migrate-'));
  t.after(async () => { await browser.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await seed(join(root, 'library'));
  // A transcription key that is only a name for the audio form's pre-flight (without one the form is the setup card): nothing here sends audio anywhere.
  await mkdir(join(root, 'home', 'study'), { recursive: true });
  await writeFile(join(root, 'home', 'study', 'audio.json'), JSON.stringify({ version: 1, siliconflowKey: 'sk-hand-off-migrate-test-key-0000000' }));
  const server = await createPreviewServer({ port: 0, libraryRoot: join(root, 'library'), home: join(root, 'home'), model: createFakeModel() });
  t.after(() => server.close());
  if (shots) await mkdir(shots, { recursive: true });
  // Study actions the server refuses on purpose (a save that fails): the hand-off that needs the save must then hand nothing over.
  const refused = new Set();
  for (const [width, height, theme] of views) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', colorScheme: theme, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (process.env.MIGRATE_DEBUG) page.on('console', (message) => console.error(`[console ${message.type()}] ${message.text().slice(0, 300)}`));
    await page.exposeFunction('invokeStudy', async (action, args) => {
      if (refused.has(action)) return { ok: false, error: `refused for the test: ${action}` };
      try { return { ok: true, value: await previewCall(server, action, args) }; } catch (error) { return { ok: false, error: error.message, code: error.code }; }
    });
    await context.addInitScript(([chosen]) => {
      try { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-theme', chosen); } catch { /* blocked */ }
      window.composerText = ''; window.copied = [];
      // The page is served from a made-up http host (not a secure context): crypto.randomUUID, which the learning-flow editor calls, exists only in secure ones.
      if (!crypto.randomUUID) crypto.randomUUID = () => '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copied.push(text); } } });
    }, [theme]);
    await page.route('**/*', (route) => (route.request().url() === 'http://hand-off.test/' ? route.fulfill({ contentType: 'text/html', body: '<div id="main"></div>' }) : route.abort()));
    await page.goto('http://hand-off.test/');
    await page.addScriptTag({ content: host.outputFiles[0].text });
    await page.evaluate(() => { window.installDsh(); window.mountPage(); });
    await page.waitForTimeout(100);
    await page.evaluate(() => { window.dshReady = true; });
    const tag = `${width}-${theme}`;
    const shot = async (name) => { if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: join(shots, `${name}-${tag}.png`) }); } };
    /** The receipt of `outcome` (ui/hand-off/use-hand-off.js), its line matching `line` (what a write before it did comes first). */
    const receipt = (outcome, line) => page.locator(`.sh-toasts .sh-toast--receipt[data-receipt="${outcome}"]`).filter({ hasText: line });
    const FILLED = '看一眼，再由你按发送', KEPT = '输入框里你写的字都留着';
    const go = async (id) => { await page.locator(`[data-tour="nav-${id}"]`).first().click({ timeout: 60000, force: true }); };
    const state = () => page.evaluate(() => ({ log: window.dshLog.slice(), text: window.composerText, copied: window.copied.slice() }));
    const reset = async (extra = {}) => {
      await page.evaluate((s) => { Object.assign(window, { composerText: '', noChat: false, copied: [] }, s); window.dshLog.length = 0; }, extra);
      for (const close of await page.locator('.sh-toast__close').all()) await close.click().catch(() => {});
    };
    // The pointer is moved onto the control: its Tooltip carries the fixed rule (a layered tooltip, never a title attribute).
    const rule = async (control) => {
      const box = await control.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.getByRole('tooltip').filter({ hasText: RULE }).first().waitFor({ timeout: 5000 });
    };
    /** Clicks the control, expects the prompt in the empty box by setDraft alone and the shared notice; returns the prompt. */
    const handOver = async (control, { tail = '', saved = '', shotName = '' } = {}) => {
      await reset();
      assert.equal(await control.getAttribute('title'), null, `${tag}: no title attribute on the control`);
      if (shotName && shots) { await control.scrollIntoViewIfNeeded(); await rule(control).catch(() => {}); await shot(`${shotName}-tip`); }
      await control.click();
      await receipt('filled', new RegExp(`${saved}${FILLED}`)).waitFor({ timeout: 15000 }).catch(async (error) => {
        if (process.env.MIGRATE_DEBUG) await page.screenshot({ path: 'output/hand-off-migrate-fail.png' });
        throw new Error(`${error.message}\npage errors: ${JSON.stringify(errors)}\nnotices: ${JSON.stringify(await page.locator('.sh-toasts').allInnerTexts())}\nstate: ${JSON.stringify(await state()).slice(0, 400)}`);
      });
      const after = await state();
      assert.deepEqual(after.log.filter((entry) => entry !== 'selectPanel:null'), ['setDraft'], `${tag}: setDraft and nothing else`);
      assert.ok(after.text.includes('请用中文回复；已有的题目和引文保持原文，不要翻译。'), `${tag}: the one language sentence`);
      assert.doesNotMatch(after.text, /languagePreference|This overrides generic language defaults/, `${tag}: no long English block in the box`);
      if (tail) assert.ok(after.text.endsWith(tail), `${tag}: ends with ${tail}: ${after.text.slice(-60)}`);
      assert.equal(await page.locator('.sh-toasts').getByText(/已交给|交给主/).count(), 0, `${tag}: no line of the page's own`);
      if (shotName) await shot(shotName);
      return after.text;
    };

    // ---------------- the library home: a deck's ⋯, a topic's icon, the topic-group reminder ----------------
    await go('library');
    await page.locator('.map-deck').first().waitFor({ timeout: 60000 });
    const reminder = page.locator('.group-reminder [data-hand-off="topics.group"]');
    await reminder.waitFor({ timeout: 30000 });
    let text = await handOver(reminder, { shotName: 'home-reminder' });
    assert.match(text, /skeleton\.topics/);
    assert.match(text, /replace/);
    if (!(await page.locator('.topic-row').count())) await page.locator('.map-deck .map-name').first().click();
    const topicIcon = page.locator('.topic-row [data-hand-off="topic.explain"]').first();
    if (width > 700) {
      await topicIcon.waitFor({ timeout: 15000 });
      assert.equal(await topicIcon.getAttribute('aria-label'), '发给主会话', `${tag}: the icon is named by the label`);
      text = await handOver(topicIcon, { shotName: 'home-topic-icon' });
      assert.match(text, /^给我讲讲题组 `[^`]+` 里的 `主题1`：/);
    }
    await reset();
    const deckMenu = async () => {
      const button = page.locator('.map-deck [aria-haspopup="menu"]').first();
      await button.scrollIntoViewIfNeeded();
      await button.click();
      if (!(await page.getByRole('menu').first().isVisible().catch(() => false))) { await page.waitForTimeout(300); await button.click(); }
      await page.getByRole('menu').first().waitFor({ timeout: 10000 });
    };
    await deckMenu();
    const item = page.getByRole('menuitem', { name: /^发给主会话/ });
    assert.match(await item.innerText(), /只填进输入框，不自动发送/);
    assert.equal(await item.getAttribute('title'), null, `${tag}: the menu item shows its rule inline and carries no title attribute`);
    await shot('home-deck-menu');
    await item.click();
    await receipt('filled', FILLED).waitFor({ timeout: 15000 });
    text = (await state()).text;
    assert.match(text, /^帮我看看题组 `操作系统`：哪些主题最薄弱/);
    assert.ok(text.endsWith('请用中文回复；已有的题目和引文保持原文，不要翻译。'), 'the learner\'s sentence already asks: no bare 我想： after it');
    // The learner's own words in the box stay: the prompt is copied instead.
    await reset({ composerText: '我自己先打的字' });
    await deckMenu();
    await page.getByRole('menuitem', { name: /^发给主会话/ }).click();
    await receipt('kept', KEPT).waitFor({ timeout: 15000 });
    assert.equal((await state()).text, '我自己先打的字');
    assert.equal((await state()).copied.length, 1);

    // ---------------- 创建题组 › 在主会话里录题: the page's own primary button ----------------
    await go('generate');
    await page.getByRole('tab', { name: /在主会话里录题/ }).click();
    const start = page.getByRole('button', { name: '开始录题并发给主会话' });
    await start.waitFor({ timeout: 30000 });
    assert.equal(await start.getAttribute('title'), null);
    assert.match(await start.evaluate((element) => element.className), /sh-btn--primary/, `${tag}: the page keeps its primary button`);
    if (await page.locator('.ingest-setup input[required]').count()) await page.locator('.ingest-setup input[required]').fill('操作系统 · 错题');
    await shot('ingest');
    await reset();
    if (await start.isEnabled()) {
      await start.click();
      await receipt('filled', `已进入录题模式。${FILLED}`).waitFor({ timeout: 20000 });
      text = (await state()).text;
      assert.match(text, /^接下来我会在这里贴题目，帮我直接录进题组/);
      assert.ok(text.endsWith('\n\n第一批题目：'), 'the pasted questions follow 第一批题目： at the very end');
      assert.match(text, /我给的是整本题册文件时，按 skill study-import 按章录入/);
      assert.deepEqual((await state()).log.filter((entry) => entry !== 'selectPanel:null'), ['setDraft']);
      await shot('ingest-notice');
      await page.getByRole('button', { name: '停止录题' }).click().catch(() => {});
    }

    // ---------------- 知识骨架 ----------------
    await go('skeleton');
    await page.locator('.skeleton-page').waitFor({ timeout: 30000 });
    const group = page.locator('.sk-group-bar [data-hand-off="topics.group"]');
    await group.waitFor({ timeout: 30000 });
    text = await handOver(group, { shotName: 'skeleton-groups' });
    assert.match(text, /skeleton\.topics/);
    await page.locator('.sk-picker input[type="checkbox"]').first().check().catch(() => {});
    const design = page.getByRole('button', { name: '在主会话里生成骨架' });
    assert.match(await design.evaluate((element) => element.className), /sh-btn--primary/);
    assert.equal(await design.getAttribute('title'), null);
    await page.locator('.sk-picker .sk-topic, .sk-picker label').filter({ hasText: '主题1' }).first().click().catch(() => {});
    if (await design.isEnabled()) {
      await reset();
      await design.click();
      await receipt('filled', FILLED).waitFor({ timeout: 15000 });
      assert.match((await state()).text, /skeleton\.context/);
      assert.equal(await page.locator('.sk-note').count(), 0, `${tag}: no line of the page's own about it`);
      await shot('skeleton-primary');
    }
    await page.locator('.sk-saved-item').first().click();
    const update = page.locator('.sk-view-head [data-hand-off="skeleton.design"]');
    await update.waitFor({ timeout: 30000 });
    text = await handOver(update, { shotName: 'skeleton-update' });
    assert.match(text, /^帮我更新知识骨架 `进程与线程`：/);
    text = await handOver(page.locator('.sk-view-head [data-hand-off="skeleton.archify"]'));
    assert.match(text, /archify/);
    assert.equal(await page.locator('.sk-view-head').getByText('这门课').count(), 0, `${tag}: the link says 这份骨架`);
    const extend = page.locator('[data-hand-off-form="skeleton.extend"]').first();
    await extend.scrollIntoViewIfNeeded();
    assert.equal(await extend.getByRole('button', { name: '发给主会话' }).isDisabled(), true, `${tag}: the button waits for a word`);
    await extend.locator('textarea').fill('加上 CAP 定理，并和 BASE 对比');
    await reset();
    await shot('skeleton-extend');
    await extend.getByRole('button', { name: '发给主会话' }).click();
    await receipt('filled', FILLED).waitFor({ timeout: 15000 });
    text = (await state()).text;
    assert.match(text, /```request 我的要求\n加上 CAP 定理，并和 BASE 对比\n```/);
    assert.equal(await extend.locator('textarea').inputValue(), '', `${tag}: the box is empty once handed over`);
    await page.getByRole('radio', { name: '结构图' }).click().catch(async () => { await page.getByRole('button', { name: '结构图' }).click(); });
    await page.locator('.skc-class').first().click();
    const concept = page.locator('.skc-extend [data-hand-off-form="skeleton.extend"]');
    await concept.waitFor({ timeout: 15000 });
    await concept.locator('textarea').fill('Paxos');
    await reset();
    await shot('skeleton-concept');
    await concept.getByRole('button', { name: '发给主会话' }).click();
    await receipt('filled', FILLED).waitFor({ timeout: 15000 });
    assert.match((await state()).text, /把 `进程` 和 `Paxos` 对比清楚/);

    // ---------------- the result page: the weak topics of the round ----------------
    await reset();
    await page.getByRole('button', { name: /^回到题目/ }).first().click({ force: true });
    // The round on screen is answered through the page (every card 'again', the low grades), up to its result page.
    await page.locator('[data-usage="review.flip"]').waitFor({ timeout: 30000 });
    for (let guard = 0; guard < 30 && !(await page.locator('.result-page').count()); guard++) {
      if (!(await page.locator('.next-due').count())) { await page.locator('[data-usage="review.flip"]').click(); await page.locator('.grade.low').first().click(); }
      await page.locator('[data-usage="review.next"]:not([disabled])').waitFor({ timeout: 15000 });
      await page.locator('[data-usage="review.next"]').click();
      await page.waitForFunction(() => document.querySelector('.result-page') || !document.querySelector('.next-due'), null, { timeout: 15000 });
    }
    await page.locator('.result-page').waitFor({ timeout: 30000 });
    const details = page.locator('details.result-details');
    await details.waitFor({ timeout: 60000 }).catch(async (error) => { if (process.env.MIGRATE_DEBUG) await page.screenshot({ path: 'output/hand-off-migrate-fail.png' }); throw error; });
    await details.locator('summary').click();
    const weak = details.locator('[data-hand-off="review.weakTopics"]');
    text = await handOver(weak, { shotName: 'result-weak' });
    assert.match(text, /(`主题\d+`、)+`主题\d+` 还没掌握稳|下面这 \d+ 个主题还没掌握稳/);

    // ---------------- 学习流: the list, the editor, the start page, a step ----------------
    await go('workflows');
    await page.locator('details.wf-advanced > summary').click();
    const listChat = page.locator('details.wf-advanced details.wf-chat');
    await listChat.locator('summary').click();
    const listForm = listChat.locator('[data-hand-off-form="workflow.design"]');
    await listForm.locator('textarea').fill('先讲例子');
    await reset();
    await shot('workflows-list');
    await listForm.getByRole('button', { name: '发给主会话' }).click();
    await receipt('filled', FILLED).waitFor({ timeout: 15000 });
    assert.match((await state()).text, /先讲例子/);
    // With words already in the box: kept, copied, and the notice is the last word.
    await listForm.locator('textarea').fill('先讲例子');
    await reset({ composerText: '我自己先打的字' });
    await listForm.getByRole('button', { name: '发给主会话' }).click();
    await receipt('kept', KEPT).waitFor({ timeout: 15000 });
    assert.equal((await state()).text, '我自己先打的字');
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.sh-toasts').getByText(/请求已准备好/).count(), 0, `${tag}: no toast of the page's own`);

    // The editor: save first, then hand over; the notice says both.
    await page.getByRole('button', { name: '编辑并保存这条流程' }).click();
    const editorChat = page.locator('.wf-editor details.wf-chat');
    await editorChat.locator('summary').click();
    const editorForm = editorChat.locator('[data-hand-off-form="workflow.design"]');
    await editorForm.waitFor({ timeout: 15000 });
    await editorForm.locator('textarea').fill('不用选择题');
    // The save is refused: nothing is handed over, the page says why, and the typed words stay.
    refused.add('workflow.save');
    await reset();
    await editorForm.getByRole('button', { name: '保存并发给主会话' }).click();
    await page.getByText('refused for the test: workflow.save').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    let after = await state();
    assert.deepEqual(after.log.filter((entry) => entry !== 'selectPanel:null'), [], `${tag}: a refused save hands nothing over`);
    assert.equal(after.text, '', `${tag}: the box is untouched`);
    assert.equal(await page.locator('.sh-toasts').getByText(/已填进|已复制/).count(), 0, `${tag}: no hand-off notice after a refused save`);
    assert.equal(await editorForm.locator('textarea').inputValue(), '不用选择题', `${tag}: the typed words stay`);
    refused.delete('workflow.save');
    await reset();
    await shot('workflows-editor');
    await editorForm.getByRole('button', { name: '保存并发给主会话' }).click();
    await receipt('filled', `学习流已保存；正在进行的学习保持原来的步骤。${FILLED}`).waitFor({ timeout: 20000 });
    text = (await state()).text;
    assert.match(text, /^帮我调整学习流 `/);
    assert.match(text, /不用选择题/);
    await page.getByRole('button', { name: /学习流工作台/ }).first().click();
    // The start page (使用): 生成知识骨架 is a hand-off with a lead; it needs topics ticked.
    await page.locator('details.wf-advanced > summary').click({ timeout: 30000 });
    await page.getByRole('button', { name: '使用', exact: true }).first().click({ timeout: 30000 });
    const skeletonLink = page.locator('.wf-skeleton-shortcut [data-hand-off="workflow.skeleton"]');
    await skeletonLink.waitFor({ timeout: 30000 });
    assert.equal(await skeletonLink.isDisabled(), true, `${tag}: nothing ticked yet`);
    await page.locator('.wf-topic-list input[type="checkbox"]').first().check();
    text = await handOver(skeletonLink, { shotName: 'workflows-start' });
    assert.match(text, /skeleton\.context/);

    // One step of a running learning (#19): the notes are saved first, then the prompt is handed over; a refused save hands nothing over.
    const topicBox = page.getByLabel('这次学什么');
    if (!(await topicBox.inputValue())) await topicBox.fill('进程调度');
    await page.getByRole('button', { name: '进入学习 Portal' }).click();
    await page.locator('.wf-activity').waitFor({ timeout: 30000 });
    const stepTitle = (await page.locator('.wf-activity h2').first().innerText()).trim();
    await page.locator('details.wf-notes > summary').click();
    await page.locator('details.wf-notes textarea').fill('我的笔记：进程和线程的区别');
    await page.locator('details.wf-chat > summary').click();
    const stepForm = page.locator('[data-hand-off-form="workflow.step"]');
    await stepForm.locator('textarea').fill('多举一个例子');
    refused.add('workflow.session.record');
    await reset();
    await stepForm.getByRole('button', { name: '保存笔记并发给主会话' }).click();
    await page.getByText('refused for the test: workflow.session.record').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    after = await state();
    assert.deepEqual(after.log.filter((entry) => entry !== 'selectPanel:null'), [], `${tag}: a refused note save hands nothing over`);
    assert.equal(after.text, '', `${tag}: the box is untouched`);
    assert.equal(await page.locator('.sh-toasts').getByText(/已填进|已复制|笔记已保存/).count(), 0, `${tag}: no hand-off notice after a refused save`);
    assert.equal(await stepForm.locator('textarea').inputValue(), '多举一个例子', `${tag}: the typed wish stays`);
    assert.equal(await page.locator('details.wf-notes textarea').inputValue(), '我的笔记：进程和线程的区别', `${tag}: the notes stay`);
    refused.delete('workflow.session.record');
    await reset();
    await shot('workflows-step');
    await stepForm.getByRole('button', { name: '保存笔记并发给主会话' }).click();
    await receipt('filled', `笔记已保存。${FILLED}`).waitFor({ timeout: 20000 });
    after = await state();
    assert.deepEqual(after.log.filter((entry) => entry !== 'selectPanel:null'), ['setDraft'], `${tag}: setDraft and nothing else`);
    assert.ok(after.text.includes(`的 \`${stepTitle}\` 这一步`), `${tag}: the message names the step ${stepTitle}: ${after.text.slice(0, 120)}`);
    assert.match(after.text, /```request 我的要求\n多举一个例子\n```/, `${tag}: the wish sits in a request fence`);
    assert.equal(await stepForm.locator('textarea').inputValue(), '', `${tag}: the box empties once handed over`);
    const sessionId = after.text.match(/"sessionId":"([^"]+)"/)?.[1];
    assert.ok(sessionId, `${tag}: the prompt carries the session id`);
    assert.match(JSON.stringify((await previewCall(server, 'workflow.session.get', { id: sessionId })).session.records), /进程和线程的区别/, `${tag}: the notes were saved`);

    // ---------------- 分步出题 and 音频 ----------------
    await go('generate');
    await page.getByRole('tab', { name: /用资料出题/ }).click();
    // The book is long: the page asks how to go on; 分步出题 draws the plan of steps (and its 发给主会话).
    const way = page.locator('.too-big').getByText('分步出题', { exact: true }).first();
    await way.click({ timeout: 30000 });
    const brief = page.locator('.gen-path [data-hand-off="path.brief"]');
    await brief.waitFor({ timeout: 30000 }).catch(async (error) => { if (process.env.MIGRATE_DEBUG) await page.screenshot({ path: 'output/hand-off-migrate-fail.png', fullPage: true }); throw error; });
    text = await handOver(brief, { shotName: 'path-brief' });
    assert.match(text, /^我想按步骤学完 `/);
    assert.equal(await page.locator('.gen-path').getByText('和 AI 聊聊怎么学').count(), 0);
    await go('audio');
    const audio = page.locator('[data-hand-off="import.file"]').first();
    await audio.waitFor({ timeout: 30000 }).catch(async (error) => { if (process.env.MIGRATE_DEBUG) await page.screenshot({ path: 'output/hand-off-migrate-fail.png', fullPage: true }); throw error; });
    text = await handOver(audio, { tail: '文件（不在工作区就粘贴完整路径）：@', shotName: 'audio' });
    assert.match(text, /audio\.import/);
    assert.match(text, /- 先读：skill study-import，再用 study_workspace 读 library\.context/);

    assert.equal((await page.evaluate(() => window.dshLog)).some((entry) => /submit/.test(entry)), false, `${tag}: submit was never touched`);
    assert.deepEqual(errors, [], `${tag}: no page errors`);
    await context.close();
  }
});
