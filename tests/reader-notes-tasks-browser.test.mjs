/* global document, getSelection, NodeFilter, MouseEvent -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';

/* The reader, 学习笔记, the 任务 console and the course panel after the shortening, in the browser preview on the sample library (the same data the tour
   shows): a selected passage asks with one click, the top-up form starts filled in, the sidebar says what finished, the page scope says whether it follows the
   current course, the course panel opens on the exam date. RNT_SHOTS=<folder> writes screenshots at 1280 and 420 px. */

const SHOTS = process.env.RNT_SHOTS || '';
const shot = async (page, name) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); } };

/** The fake model answers a question about a passage the way a real one would ("答：…"); everything else is the shared fake. */
function model() {
  const fake = createFakeModel({ latencyMs: 20 });
  return async (system, prompt, options) => {
    if (/grounded|selected passage|依据/i.test(system) && /"question"/.test(prompt)) {
      const { question } = JSON.parse(prompt);
      return `针对「${String(question).slice(0, 12)}」的回答：这段讲的是 [[备忘录]] 如何在不暴露内部状态的前提下保存快照。`;
    }
    return fake(system, prompt, options);
  };
}

async function start(distDir, { seed } = {}) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-rnt-'));
  const root = join(base, 'library');
  await mkdir(root, { recursive: true });
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: model(), distDir });
  const call = (action, args = {}) => previewCall(server, action, { uiLanguage: 'zh', ...args });
  await call('sample.load', { language: 'zh' });
  await seed?.(call);
  return { server, base, call, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

async function openApp(browser, running, { lang = 'zh', width = 1280, height = 900 } = {}) {
  const opened = await openPage(browser, running, { lang, theme: 'dark', width, height });
  await opened.page.goto(running.server.url);
  await opened.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  return opened;
}

/** Select the first `length` characters of the first long paragraph of the document, as the learner's drag would, and tell the reader. */
const selectPassage = (page, { skip = 0, length = 24 } = {}) => page.evaluate(({ skip: skipped, length: size }) => {
  const body = document.querySelector('.study-document-body'), walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.data.trim().length < 40 || node.parentElement.closest('[data-study-marker], h1, h2, h3, pre, code')) continue;
    if (seen++ < skipped) continue;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, size);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return range.toString();
  }
  return '';
}, { skip, length });

async function openReader(page) {
  await page.locator('[data-tour="nav-sources"]').first().dispatchEvent('click');
  await page.locator('.source-doc').first().waitFor({ timeout: 30000 });
  await page.locator('.source-doc').first().locator('.source-main').click();
  await page.locator('.study-document-viewer').waitFor({ timeout: 30000 });
}

test('the reader: a chip asks with one click, the answer stays when the passage changes, the top-up form starts filled in', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-rnt-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openApp(browser, running, { width });
      try {
        await openReader(page);
        const first = await selectPassage(page);
        assert.ok(first, `${width}px: a passage was selected`);
        // A narrow reader keeps the tools in a drawer: one press more (the toolbar button pulses to say a passage is waiting).
        if (width < 900) await page.locator('[data-tour="source-tools-toggle"]').click();
        const learning = page.locator('.study-document-learning').first();
        await learning.locator('.ask-quick').waitFor({ timeout: 30000 });
        // 2 actions: select, chip. No second press.
        await learning.getByRole('button', { name: '没听懂' }).click();
        await learning.locator('.ask-node[data-status="answered"]').waitFor({ timeout: 30000 });
        assert.match(await learning.locator('.ask-node').first().innerText(), /回答/, `${width}px: the chip's question was answered`);
        assert.equal(await learning.locator('textarea').inputValue(), '', `${width}px: the chip did not touch the box`);

        // A second chip joins the first answer instead of replacing it.
        await learning.getByRole('button', { name: '举个例子' }).click();
        await until(async () => (await learning.locator('.ask-node[data-status="answered"]').count()) >= 2, `${width}px: two answers`);
        assert.equal(await learning.locator('.ask-node__keep').count(), 1, `${width}px: one keep row for the thread`);

        // Another passage starts clean; selecting the first one again brings its answers back.
        await selectPassage(page, { skip: 1, length: 30 });
        await until(async () => (await learning.locator('.ask-node').count()) === 0, `${width}px: the other passage has no thread`);
        await selectPassage(page);
        await until(async () => (await learning.locator('.ask-node[data-status="answered"]').count()) >= 2, `${width}px: the answers came back`);
        await shot(page, `reader-${width}-answers`);

        // The top-up form: deck filled in with its reason, the kind and number in the fold.
        const form = learning.locator('form', { has: page.locator('details.study-selection-more') });
        await form.scrollIntoViewIfNeeded();
        assert.match(await form.innerText(), /已选/, `${width}px: the deck was chosen and says why`);
        const fold = form.locator('details.study-selection-more');
        assert.equal(await fold.count(), 1);
        assert.match(await fold.locator('summary').innerText(), /更多设置/);
        assert.match(await fold.locator('summary').innerText(), /单选测验 · 10 题/, `${width}px: the fold says the preferences' kind and number`);
        assert.equal(await form.getByRole('button', { name: '生成、审核并补充题目' }).isDisabled(), false, `${width}px: 生成 is ready without choosing a deck`);
        await shot(page, `reader-${width}-topup`);
        await fold.locator('summary').click();
        await settleAnimations(page);
        await shot(page, `reader-${width}-topup-fold`);
        assert.deepEqual(errors, [], `${width}px: no console errors`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/* ---------- the sidebar's 任务 entry ---------- */

test('a question run that finished while the learner was elsewhere shows on 任务 in the sidebar, and opening the console clears it', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-rnt-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    const { page, errors, context } = await openApp(browser, running);
    try {
      const entry = page.locator('[data-tour="nav-tasks"]').first();
      await entry.waitFor({ state: 'attached', timeout: 30000 });
      assert.equal(await entry.locator('.nav-count').count(), 0, 'nothing has finished yet: no number');
      // The run starts and ends while the learner is on another page; the page is opened again as a learner returning to it would.
      const status = await running.call('sample.status');
      const started = await running.call('generate', { sourceIds: [status.sourceId], count: 2, kind: 'flashcard', language: 'Chinese', course: status.course });
      const job = await running.call('job.wait', { jobId: started.jobId, timeoutSeconds: 60 });
      assert.equal(job.status, 'complete', job.stage);
      await page.reload();
      await entry.waitFor({ state: 'attached', timeout: 30000 });
      await until(async () => (await entry.locator('.nav-count').count()) === 1, 'the number on 任务');
      assert.equal((await entry.locator('.nav-count').innerText()).trim(), '1');
      await entry.hover();
      await page.locator('[role="tooltip"]', { hasText: '1 个任务有新结果' }).waitFor({ timeout: 10000 });
      await shot(page, 'tasks-1280-badge');
      await entry.dispatchEvent('click');
      await page.locator('.tc').waitFor({ timeout: 30000 });
      await until(async () => (await entry.locator('.nav-count').count()) === 0, 'the number to clear when the console is open');
      await page.locator('[data-tour="nav-sources"]').first().dispatchEvent('click');
      await page.locator('.sources-page').waitFor({ timeout: 30000 });
      assert.equal(await entry.locator('.nav-count').count(), 0, 'and it stays clear after leaving the console');
      await page.reload();
      await entry.waitFor({ state: 'attached', timeout: 30000 });
      assert.equal(await entry.locator('.nav-count').count(), 0, 'and after a reload');
      assert.deepEqual(errors, [], 'no console errors');
    } finally { await context.close(); }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/* ---------- 学习笔记: the AI draft ---------- */

test('a note has its AI draft as a main button, with the estimate beside it and what the draft is said before the click', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-rnt-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openApp(browser, running, { width });
      try {
        await page.locator('[data-tour="nav-notes"]').first().dispatchEvent('click');
        await page.locator('.note-list').waitFor({ timeout: 30000 });
        await shot(page, `notes-${width}-list`);
        await page.locator('.note-list > button', { hasText: /\d+ 题/ }).first().click();
        const draft = page.locator('.note-draft');
        await draft.waitFor({ timeout: 30000 });
        assert.equal(await draft.locator('details').count(), 0, `${width}px: not inside a fold`);
        const button = draft.getByRole('button', { name: 'AI 起草解析' });
        assert.equal(await button.isDisabled(), false, `${width}px: the preview has a model`);
        await draft.locator('[data-token-estimate]').waitFor({ timeout: 30000 });
        assert.match(await draft.innerText(), /可以公开发布的通用文章/);
        assert.match(await draft.innerText(), /已用的用量不退/);
        assert.equal(await page.locator('.note-publish button', { hasText: 'AI 起草解析' }).count(), 0, `${width}px: the old button in the publishing fold is gone`);
        await shot(page, `notes-${width}-draft`);
        assert.deepEqual(errors, [], `${width}px: no console errors`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/* ---------- the page scope says whether it follows the current course ---------- */

test('a page scope says it follows the current course until the learner picks one, then says it is pinned and goes back with one click', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-rnt-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openApp(browser, running, { width });
      try {
        await page.locator('[data-tour="nav-dashboard"]').first().dispatchEvent('click');
        const scope = page.locator('.page-scope').first();
        await scope.waitFor({ timeout: 30000 });
        assert.match(await scope.innerText(), /跟随当前课程/, `${width}px: nothing picked yet`);
        assert.equal(await scope.getByRole('button', { name: '改为跟随当前课程' }).count(), 0, `${width}px: nothing to go back to`);
        await shot(page, `scope-${width}-following`);
        // The learner picks all courses: the page stays there from now on.
        await scope.getByRole('combobox').first().click();
        await page.getByRole('option', { name: '全部课程' }).click();
        await until(async () => /已固定/.test(await scope.innerText()), `${width}px: pinned`);
        await shot(page, `scope-${width}-pinned`);
        // It is remembered for the tab: leaving the page and coming back keeps it pinned.
        await page.locator('[data-tour="nav-sources"]').first().dispatchEvent('click');
        await page.locator('.sources-page').waitFor({ timeout: 30000 });
        await page.locator('[data-tour="nav-dashboard"]').first().dispatchEvent('click');
        await page.locator('.page-scope').first().waitFor({ timeout: 30000 });
        await until(async () => /已固定/.test(await page.locator('.page-scope').first().innerText()), `${width}px: still pinned after a visit elsewhere`);
        // One click and it follows again.
        await page.locator('.page-scope').first().getByRole('button', { name: '改为跟随当前课程' }).click();
        await until(async () => /跟随当前课程/.test(await page.locator('.page-scope').first().innerText()) && !/已固定/.test(await page.locator('.page-scope').first().innerText()), `${width}px: following again`);
        assert.deepEqual(errors, [], `${width}px: no console errors`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/* ---------- courses: 新建课程 and the panel that opens on the exam date ---------- */

test('a new course is made from the course list, asked about when its name is nearly an existing one, and its panel opens on the exam date', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-rnt-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openApp(browser, running, { width });
      try {
        await page.locator('[data-tour="nav-settings"]').first().dispatchEvent('click');
        await page.locator('[data-category="courses"]').first().click();
        const create = page.getByRole('button', { name: '新建课程' });
        await create.waitFor({ timeout: 30000 });
        await shot(page, `courses-${width}-list`);
        // A course that already has a profile opens with its fold open: topics as chips, and the weakest topics offered (not added).
        await page.locator('.course-list__item', { hasText: '示例课程' }).getByRole('button', { name: '设置' }).click();
        const existing = page.locator('.course-settings');
        await existing.waitFor({ timeout: 30000 });
        assert.notEqual(await existing.locator('details.course-settings__more').getAttribute('open'), null, `${width}px: the sample course has a profile, so the fold is open`);
        await existing.locator('.topic-field').waitFor();
        assert.equal(await existing.locator('.topic-field__add input').inputValue(), '', `${width}px: the add box is empty`);
        await until(async () => (await existing.locator('.topic-field__suggest').count()) === 1, `${width}px: suggestions from the learner's weak topics`);
        const before = await existing.locator('.topic-field__list').first().locator('li').count();
        await existing.locator('.topic-field__suggest button.sh-chip__main').first().click();
        assert.equal(await existing.locator('.topic-field__list').first().locator('li').count(), before + 1, `${width}px: a click adds the one suggestion, nothing else`);
        await settleAnimations(page);
        await shot(page, `courses-${width}-existing`);
        await existing.getByRole('button', { name: '关闭', exact: true }).last().click();
        await existing.waitFor({ state: 'detached', timeout: 30000 });
        await create.click();
        const input = page.getByRole('textbox', { name: '课程名称' });
        // A name that is one slip from an existing course is asked about, with that course one click away.
        await input.fill('示例课程 · 设计模试');
        await page.getByText(/很像，是同一门吗/).waitFor({ timeout: 10000 });
        assert.equal(await page.getByRole('button', { name: '创建', exact: true }).count(), 0, `${width}px: the plain create waits for the answer`);
        await settleAnimations(page);
        await shot(page, `courses-${width}-similar`);
        // A new name is created with one press, and its panel opens with the exam date first and the rest folded.
        await input.fill(`Operating Systems ${width}`);
        await shot(page, `courses-${width}-new`);
        await page.getByRole('button', { name: '创建', exact: true }).click();
        const panel = page.locator('.course-settings');
        await panel.waitFor({ timeout: 30000 });
        const date = panel.locator('input[type="date"]');
        await date.waitFor();
        assert.equal(await panel.locator('details.course-settings__more').getAttribute('open'), null, `${width}px: the fold is closed for a new course`);
        assert.equal(await panel.locator('details.course-settings__more input[type="date"]').count(), 0, `${width}px: the date is outside the fold`);
        await settleAnimations(page);
        await shot(page, `courses-${width}-panel`);
        // Setting only the exam date: pick it, save.
        await date.fill('2026-12-31');
        await panel.getByRole('button', { name: '保存课程信息' }).click();
        await panel.waitFor({ state: 'detached', timeout: 30000 });
        const saved = await running.call('course.get', { name: `Operating Systems ${width}` });
        assert.equal(saved.exam.date, '2026-12-31');
        assert.deepEqual(errors, [], `${width}px: no console errors`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/* ---------- the reader without a model ---------- */

test('the reader with no model shows the gate where a question would be asked, with the button to the model settings', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-rnt-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openApp(browser, running, { width });
      try {
        // The host says there is no model: the operations that need one are not available, and the snapshot says so too.
        await page.route('**/api/call', async route => {
          let action = '';
          try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
          if (action !== 'runtime.capabilities' && action !== 'snapshot') return route.continue();
          const response = await route.fetch(), body = await response.json();
          if (body.ok && action === 'runtime.capabilities') {
            for (const domain of body.value) domain.operations = (domain.operations || []).map(operation => (/^(selection\.ask|selection\.start|translation\.translate|outline\.suggest)$/.test(operation.name) ? { ...operation, available: false } : operation));
          }
          if (body.ok && action === 'snapshot') body.value = { ...body.value, model: { ready: false, reason: 'no-route', label: '' }, modelReady: false };
          return route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
        });
        await openReader(page);
        await selectPassage(page);
        if (width < 900) await page.locator('[data-tour="source-tools-toggle"]').click();
        const learning = page.locator('.study-document-learning').first();
        await learning.waitFor({ timeout: 30000 });
        await learning.locator('form').first().waitFor({ timeout: 30000 });
        assert.match(await learning.innerText(), /还没有可用的 AI 模型/, `${width}px: the gate`);
        assert.match(await learning.innerText(), /提问和补题需要先配置模型/);
        assert.equal(await learning.getByRole('button', { name: '前往设置' }).count(), 1, `${width}px: the button`);
        assert.equal(await learning.getByRole('button', { name: '没听懂' }).isDisabled(), true, `${width}px: a chip cannot ask without a model`);
        await shot(page, `reader-${width}-nomodel`);
        assert.deepEqual(errors, [], `${width}px: no console errors`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
