/* global document, window -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { StudyService } from '../lib/service.js';

/* From the form to practice, and the places that used to be dead ends, in the browser preview on a seeded library (fake model; the failure and the slow run are the model's):
   1. 创建题组 → 生成 → the finished card says 发布并练习 and one press publishes and starts the questions;
   2. a failed run: the time limit links to the field of the limit in 设置, a run the contract can retry is one press;
   3. a draft with sections without a question: the top-up is pressed with unsaved edits (they are saved first), the draft page says which job works on it and why saving waits, and 停止 frees it;
   4. the 资料 row of a published deck: the confirm button carries the estimate.
   GENERATE_SHOTS=<dir> writes screenshots at 1280 and 420 px. */

const SHOTS = process.env.GENERATE_SHOTS || '';
const STAMP = '2026-10-01T08:00:00.000Z';
const SENTENCES = n => Array.from({ length: 14 }, (_, i) => `第 ${n} 节的第 ${i + 1} 个要点说明数据库索引、事务与范式之间的关系。`).join('');
const longText = Array.from({ length: 6 }, (_, i) => `## 第 ${i + 1} 节\n\n${SENTENCES(i + 1)}\n\n`).join('');
const QUOTE = '第 1 节的第 3 个要点说明数据库索引、事务与范式之间的关系。';
const source = (id, title, text, courses = ['数据库']) => ({ id, title, text, createdAt: STAMP, courses, chars: text.length, excerpt: text.slice(0, 160) });
const flash = (id, quote) => ({ id, kind: 'flashcard', topic: '索引', objective: '理解索引', prompt: `问题 ${id}`, answer: '答案', hint: '提示', explanation: '解析', misconception: '误区', citations: [{ sourceId: 'long', quote }] });

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push(source('n1', '索引与查询.md', `## 第 1 节\n\n${SENTENCES(1)}`), source('n2', '事务与并发.md', `## 第 1 节\n\n${SENTENCES(2)}`), source('long', '数据库总复习.md', longText));
    // a draft that covers only the first section of the long note, and a published deck that does the same (for the 资料 row)
    state.drafts.push({ id: 'dr1', title: '总复习草稿', course: '数据库', draftVersion: 1, cards: [flash('a1', QUOTE)],
      editorial: { requested: 1, generated: 1, generation: { sourceIds: ['long'], kind: 'flashcard', count: 1, language: '中文', difficulty: 'mixed' }, reviewedCards: {} } });
    state.decks.push({ id: 'dk1', title: '总复习小测', course: '数据库', cards: [flash('p1', QUOTE)], editorial: { generation: { sourceIds: ['long'], kind: 'flashcard', count: 1, language: '中文', difficulty: 'mixed' } } });
    state.focus = { ...(state.focus || {}), course: '数据库', mode: 'class' };
  });
  service.dispose?.();
}

/** The fake model, except that it can be made to take its time. */
function model(control) {
  const base = createFakeModel({ latencyMs: 20, generationLatencyMs: 20 });
  return async (system, prompt, options) => {
    if (control.slowMs && /generation|author|plan/i.test(String(options?.stage || ''))) {
      // a slow call that a stop ends at once, as a real one does (the signal is the job's)
      await new Promise((done, reject) => { const timer = setTimeout(done, control.slowMs); options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true }); });
    }
    return base(system, prompt, options);
  };
}

async function start(distDir, control) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-generate-flow-'));
  const root = join(base, 'library');
  await seed(root);
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: model(control), distDir });
  return { server, base, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

async function openApp(browser, running, { lang = 'zh', width = 1280, height = 900 } = {}) {
  const opened = await openPage(browser, running, { lang, theme: 'dark', width, height });
  await opened.page.goto(running.server.url);
  await opened.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  return opened;
}

const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };
const area = page => page.locator('.study-app').first().getAttribute('data-usage-area');
const nav = async (page, id) => { await page.locator(`[data-tour="nav-${id}"]`).first().dispatchEvent('click'); };

test('a finished run of a clean draft is published and practised from its card in one press, and the draft page can be reached from a quiet link', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-generate-flow-dist-'));
  await buildPreview({ outdir: dist });
  const control = {};
  try {
    for (const width of [1280, 420]) {
      const running = await start(dist, control);
      const { page, errors, context } = await openApp(browser, running, { width });
      await nav(page, 'generate');
      await page.locator('.generate-page form').waitFor({ timeout: 30000 });
      await until(async () => (await page.locator('.source-picker__item.is-selected').count()) >= 2, 'the notes without questions are ticked');
      await until(async () => !(await page.locator('[data-usage="generate.submit"]').isDisabled()), 'the button');
      await page.locator('[data-usage="generate.submit"]').click();
      // the home: the job card, then (when the run is done and its draft clean) the one-press button
      await page.locator('.cjc').first().waitFor({ timeout: 60000 });
      await until(async () => /发布并练习/.test(await page.locator('.cjc').first().innerText()), 'the card of the finished run offers 发布并练习', { timeoutMs: 120000 });
      await settleAnimations(page);
      assert.equal(await page.locator('.cjc').first().locator('.cjc__go').count(), 1, 'one primary button');
      assert.match(await page.locator('.cjc__links').first().innerText(), /打开草稿/, 'and the quiet way to look first');
      assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll on the card`);
      await shot(page, `card-${width}`);
      if (width === 1280) {
        await page.locator('.cjc__go').first().click();
        await until(async () => (await area(page)) === 'review', 'practice starts by itself', { timeoutMs: 60000 });
        await shot(page, 'practice-1280');
      } else {
        await page.locator('.cjc__links button', { hasText: '打开草稿' }).first().click();
        await until(async () => (await area(page)) === 'draft', 'the draft page opens from the link');
        await frames(page, 3);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll on the draft page`);
      }
      assert.deepEqual(errors, []);
      await context.close();
      await running.close();
    }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});

test('a failed run: the time limit is one press from its setting, a run the contract can retry is one press, and a run it cannot keeps the form again', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-generate-flow-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist, {});
  // The preview has no way to make a real run hit its 20-minute limit, so the snapshot the page reads carries two failed runs of the shape the host publishes: one that hit the limit, and one whose
  // contract can retry (a retry the host would answer; here the request is recorded and refused, which is all this test asks of it).
  const now = Date.now(), at = seconds => new Date(now - seconds * 1000).toISOString();
  const failed = (id, title, stage, extra = {}) => ({ id, type: 'generate', status: 'failed', stage, deckTitle: title, kind: 'quiz', count: 10, requestedTotal: 10, savedCount: 0, parts: 1, steps: [],
    sourceIds: ['n1'], startedAt: at(900), finishedAt: at(60), ...extra });
  const jobs = [failed('limit-run', '用满时限的一组', 'Generation reached its 20-minute total budget; approved questions were retained'),
    failed('retry-run', '可以再试的一组', 'fetch failed: ECONNRESET', { retryable: true })];
  try {
    for (const width of [1280, 420]) {
      const { page, context } = await openApp(browser, running, { width });
      const asked = [];
      await page.route('**/api/call', async route => {
        const body = (() => { try { return JSON.parse(route.request().postData() || '{}'); } catch { return {}; } })();
        if (body.action === 'job.control') { asked.push(body.args); return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '预览里没有这个任务' }) }); }
        if (body.action !== 'snapshot') return route.continue();
        const response = await route.fetch(), json = await response.json();
        if (json.ok && Array.isArray(json.value?.jobs)) json.value.jobs.push(...jobs);
        return route.fulfill({ response, json });
      });
      await page.reload();
      await page.locator('.cjc').first().waitFor({ timeout: 60000 });
      const card = title => page.locator('.cjc', { hasText: title });
      await settleAnimations(page);
      assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll`);
      // the limit: a link to its field, no retry offered (the contract says it cannot)
      assert.match(await card('用满时限').locator('.cjc__links').innerText(), /调整时限/);
      assert.match(await card('用满时限').locator('.cjc__go').innerText(), /按原资料重新设置/, 'the form again, as before');
      // the retry: one press on the card, the contract's own retry, with the form again as the quiet link
      assert.match(await card('可以再试').locator('.cjc__go').innerText(), /再试一次/);
      assert.match(await card('可以再试').locator('.cjc__links').innerText(), /按原资料重新设置/);
      await shot(page, `failed-${width}`);
      if (width === 1280) {
        await card('可以再试').locator('.cjc__go').click();
        await until(async () => asked.length > 0, 'the retry goes to the contract');
        assert.equal(asked[0].jobId, 'retry-run');
        assert.equal(asked[0].action, 'retry');
        await card('用满时限').locator('.cjc__links button', { hasText: '调整时限' }).click();
        await until(async () => (await area(page)) === 'settings', 'Settings opens');
        await page.locator('[data-tour="settings-generation-time"]').waitFor({ state: 'visible', timeout: 30000 });
        assert.ok(await page.locator('input[name="jobTimeoutMinutes"]').isVisible(), 'at the field of the limit');
        await shot(page, 'limit-1280');
      }
      await context.close();
    }
  } finally { await running.close(); await browser.close(); await rm(dist, { recursive: true, force: true }); }
});

test('a draft with sections without a question: unsaved edits are saved by the top-up, the page says why it waits and 停止 frees it', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-generate-flow-dist-'));
  await buildPreview({ outdir: dist });
  const control = { slowMs: 60000 };
  try {
    for (const width of [1280, 420]) {
      const running = await start(dist, control);
      const { page, context } = await openApp(browser, running, { width });
      // the 资料 row of the published deck: the confirm button carries the estimate
      await nav(page, 'sources');
      await page.locator('.sources-page').waitFor({ timeout: 30000 });
      await page.locator('[data-document-topup-open]').first().click();
      const confirm = page.locator('[data-coverage-start]').first();
      await confirm.waitFor({ timeout: 30000 });
      await until(async () => /预计/.test(await confirm.innerText()), 'the estimate on the confirm button', { timeoutMs: 60000 });
      assert.match(await confirm.innerText(), /本轮：预计 .*tok/);
      await shot(page, `row-confirm-${width}`);
      await page.keyboard.press('Escape');
      // the draft page
      await nav(page, 'library');
      await page.locator('.home-drafts > summary, .home-drafts summary').first().click();
      await page.locator('.draft-open').first().click();
      await page.locator('.draft-page').waitFor({ timeout: 30000 });
      const title = page.locator('.draft-title-field input');
      await title.fill('总复习草稿（改过）');
      const topUp = page.locator('[data-coverage-start]').first();
      await topUp.waitFor({ timeout: 30000 });
      assert.equal(await topUp.isDisabled(), false, 'unsaved edits do not hold the top-up');
      assert.match(await page.locator('.draft-page').innerText(), /补题前会先保存草稿。/);
      await shot(page, `draft-${width}`);
      await topUp.click();
      await page.locator('[data-draft-hold]').waitFor({ timeout: 60000 });
      assert.match(await page.locator('[data-draft-hold]').innerText(), /这期间不能保存或发布/);
      assert.equal(await page.locator('.draft-page .sticky-actions button.sh-btn--primary').isDisabled(), true, 'saving and publishing wait');
      assert.equal(await page.locator('.draft-title-field input').inputValue(), '总复习草稿（改过）', 'the edit was saved, not lost');
      await shot(page, `hold-${width}`);
      assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll while it waits`);
      await page.locator('[data-draft-hold] button', { hasText: '停止并保留已出的题' }).click();
      await until(async () => (await page.locator('[data-draft-hold]').count()) === 0 || /正在停止/.test(await page.locator('[data-draft-hold]').innerText()), 'the job is stopping');
      await until(async () => (await page.locator('[data-draft-hold]').count()) === 0, 'and the page is free again', { timeoutMs: 90000 });
      assert.equal(await page.locator('.draft-page .sticky-actions button.sh-btn--primary').isDisabled(), false, 'saving and publishing are back');
      await context.close();
      await running.close();
    }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});
