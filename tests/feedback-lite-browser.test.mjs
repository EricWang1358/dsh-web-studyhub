/* global document, window -- page.evaluate callbacks run in the browser */
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
import { StudyService } from '../lib/service.js';

/* Closing the feedback loop, in the real app on a seeded temporary library: the mock exam shows its time limit (the course's own 作答时间) and keeps the one
   chosen, the report's weak topics and a chapter row's 练这一章 each start practice in one click, and the dashboard names its rates apart from 掌握度.
   FEEDBACK_LITE_SHOTS=<folder> writes screenshots at 1280 and 420 px. */

const SHOTS = process.env.FEEDBACK_LITE_SHOTS || '';
const PAGE_TEXT = { one: 'Indexes speed up lookups on a key.', two: 'A transaction is atomic: all of it happens or none of it.', three: 'Normal forms remove redundancy.' };

const card = (id, topic, sourceId, quote) => ({
  id, kind: 'quiz', topic, objective: `Explain ${topic} precisely (${id})`, prompt: `Question ${id}: which statement about ${topic} is right?`, answer: 'Right one', hint: 'Think about the storage.',
  explanation: 'Because it follows from the source.', misconception: 'Confusing it with caching.',
  citations: [{ sourceId, quote }],
  options: [{ id: 'a', text: 'Right one', correct: true, explanation: 'Yes.' }, { id: 'b', text: 'Wrong one', correct: false, explanation: 'No.' }, { id: 'c', text: 'Other wrong one', correct: false, explanation: 'No.' }],
});

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.call('course.save', { name: 'Databases', exam: { format: 'closed-book', totalMarks: 60, writingMinutes: 45 } });
  await service.store.update(state => {
    const hash = 'e'.repeat(64);
    const pages = [[1, 0, PAGE_TEXT.one], [2, 0, PAGE_TEXT.one], [3, 1, PAGE_TEXT.two], [4, 2, PAGE_TEXT.three]];
    for (const [page, chapter, text] of pages) {
      state.sources.push({ id: `s${page}`, title: `Databases · p.${page}`, text, createdAt: new Date(Date.UTC(2026, 8, 1, 12, page)).toISOString(), courses: ['Databases'],
        document: { id: hash, page, totalPages: 4, format: 'pdf', materialId: `document-${hash}-pdf`, filename: 'databases.pdf', origin: 'converted', converter: 'mineru',
          chapter: { index: chapter, title: ['Indexes', 'Transactions', 'Normal forms'][chapter], level: 1 } } });
    }
  });
  const cards = [
    ...[1, 2, 3, 4].map(n => card(`i${n}`, 'Indexes', n % 2 ? 's1' : 's2', PAGE_TEXT.one)),
    ...[1, 2, 3, 4].map(n => card(`t${n}`, 'Transactions', 's3', PAGE_TEXT.two)),
  ];
  await service.call('draft.save', { deck: { id: 'dbq', title: 'Databases · Final paper 01', course: 'Databases', cards } });
  await service.call('draft.publish', { id: 'dbq' });
  // One graded answer so far: the dashboard has data, but too little to quote a rate on.
  const run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'dbq', cardId: 'i1' }, { deckId: 'dbq', cardId: 'i2' }], fresh: true });
  await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: ['b'] });
  service.dispose?.();
}

async function start(distDir) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-feedback-lite-'));
  const root = join(base, 'library');
  await seed(root);
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir });
  return { server, base, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function openApp(browser, running, { width, scope }) {
  const opened = await openPage(browser, running, { lang: 'zh', theme: 'dark', width, height: 900 });
  const snapshot = await previewCall(running.server, 'snapshot', {});
  if (scope) await opened.context.addInitScript(([key, value]) => { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* blocked */ } },
    [`study-page-scope:v1:${JSON.stringify([snapshot.root, 'exam'])}`, scope]);
  await opened.page.goto(running.server.url);
  await opened.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  return opened;
}

const go = async (page, id) => {
  const entry = page.locator(`[data-tour="nav-${id}"]`).first();
  await entry.waitFor({ state: 'attached', timeout: 30000 });
  await entry.dispatchEvent('click');
};

test('time limit on the exam card, a weak topic and a chapter each start practice in one click, and the dashboard names its rates', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-feedback-lite-dist-'));
  let running = null;
  try {
    await buildPreview({ outdir: dist });
    running = await start(dist);
    // 统计: one answer is too few to quote a rate; the 30-day rate is 达标率, and 掌握度 is not on the page.
    {
      const { page, context } = await openApp(browser, running, { width: 1280 });
      await go(page, 'dashboard');
      await page.locator('.dash-rates').waitFor({ timeout: 30000 });
      await settleAnimations(page);
      const text = await page.locator('.page:has(.dash-rates)').innerText();
      assert.match(text, /数据不足/, 'one graded answer: no percentage');
      assert.match(text, /客观题通过率 · 1 次/);
      assert.match(text, /达标率/);
      assert.doesNotMatch(text, /掌握度/, '掌握度 means one thing, and the dashboard does not use it');
      assert.ok(await overflow(page) <= 0, 'no sideways scroll on the dashboard');
      await shot(page, 'dashboard-1280');
      await context.close();
    }

    for (const width of [1280, 420]) {
      // 模拟考试: the course's own time on the card, folded 怎么考, one click to change the limit; the run keeps it.
      const { page, context, errors } = await openApp(browser, running, { width, scope: 'Databases' });
      await go(page, 'exam');
      await page.locator('.es-sheet').waitFor({ timeout: 30000 });
      await settleAnimations(page);
      assert.equal(await page.locator('details.es-how').evaluate(element => element.open), false, `${width}px: 怎么考 is folded`);
      assert.equal(await page.locator('details.es-how li.es-step').first().isVisible(), false, 'its steps are not on the way');
      assert.match(await page.locator('.es-summary').innerText(), /10 题 · 限时 45 分钟/, 'the limit comes from the course profile, and is said on the card');
      assert.match(await page.locator('.es-sheet').innerText(), /取自课程「Databases」的作答时间 45 分钟 · 到时自动交卷/);
      assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll on the setup card`);
      await shot(page, `exam-setup-${width}`);
      await page.locator('details.es-how summary').click();
      await settleAnimations(page);
      assert.equal(await page.locator('details.es-how li.es-step').first().isVisible(), true, 'one click opens the five steps');
      await shot(page, `exam-how-${width}`);
      await page.locator('details.es-how summary').click();
      await page.getByRole('group', { name: '限时（分钟）' }).getByRole('button', { name: '60', exact: true }).click();
      assert.match(await page.locator('.es-summary').innerText(), /限时 60 分钟/, 'one click changes the limit');
      assert.match(await page.locator('.es-sheet').innerText(), /已改；课程设置是 45 分钟/);
      await shot(page, `exam-limit-60-${width}`);
      await page.getByRole('button', { name: '开始考试' }).click();
      await page.locator('.exam-card').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.exam-foot').innerText(), /计时满 60 分钟自动交卷/, 'the running page says the limit it was started with');
      const snapshot = await previewCall(running.server, 'snapshot', {});
      const open = snapshot.runs.filter(run => run.mode === 'exam').at(-1);
      assert.equal((await previewCall(running.server, 'review.get', { runId: open.id })).limitMs, 60 * 60000, 'and the run keeps it');
      await shot(page, `exam-running-${width}`);
      // Every question answered wrongly (option B): the report has weak topics.
      const total = await page.locator('.exam-progress').innerText().then(text => Number(text.split('/')[1]));
      for (let index = 0; index < total; index++) {
        await page.locator('.exam-option').nth(1).click();
        if (index < total - 1) { await page.getByRole('button', { name: '下一题 →' }).click(); await until(async () => (await page.locator('.exam-progress').innerText()).startsWith(`${index + 2} `), 'the next question'); }
      }
      await page.locator('.exam-foot').getByRole('button', { name: '交卷', exact: true }).click();
      await page.getByRole('button', { name: '仍然交卷' }).click();
      await page.locator('.exam-report').waitFor({ timeout: 30000 });
      await settleAnimations(page);
      const topics = page.locator('.exam-report .result-weak li');
      assert.ok(await topics.count() >= 1, 'the report lists weak topics');
      assert.equal(await topics.first().getByRole('button', { name: '练这个主题' }).count(), 1, 'each weak topic has its own button');
      assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll on the report`);
      await shot(page, `exam-report-${width}`);
      const label = (await topics.first().innerText()).split('·')[0].trim();
      const lastRun = async () => (await previewCall(running.server, 'snapshot', {})).lastRun;
      await topics.first().getByRole('button', { name: '练这个主题' }).click();
      await until(async () => (await page.locator('body').innerText()).includes('Question '), 'a practice question');
      // The same practice the dashboard starts: it picks an unfinished round of the same topic up again (a second pass on the same topic is that round).
      await until(async () => (await lastRun())?.mode === 'path', 'the practice run');
      const started = await previewCall(running.server, 'review.get', { runId: (await lastRun()).id });
      assert.equal(started.mode, 'path');
      assert.equal(started.total, 4, `one click: the four questions of the topic ${label}`);
      assert.match(started.card.topic, new RegExp(label.replace(/^.* · /, '')));
      await shot(page, `practice-from-report-${width}`);
      assert.deepEqual(errors, [], 'no page errors');
      await context.close();
    }

    // 资料: the chapter that has questions offers 练这一章; the one without offers 出题; one click starts the chapter's questions.
    for (const width of [1280, 420]) {
      const { page, context, errors } = await openApp(browser, running, { width });
      await go(page, 'sources');
      await page.locator('.sources-page .source-doc').first().waitFor({ timeout: 30000 });
      await page.locator('.source-doc__pages-toggle').first().click();
      await page.locator('.source-doc__chapters li').first().waitFor({ timeout: 30000 });
      await settleAnimations(page);
      const rows = page.locator('.source-doc__chapters li');
      assert.equal(await rows.count(), 3);
      assert.equal(await rows.nth(0).getByRole('button', { name: '练这一章' }).count(), 1, 'the chapter with questions');
      assert.equal(await rows.nth(1).getByRole('button', { name: '练这一章' }).count(), 1);
      assert.equal(await rows.nth(2).getByRole('button', { name: '练这一章' }).count(), 0, 'the chapter with none offers only 出题');
      assert.equal(await rows.nth(2).getByRole('button', { name: '从这一章出题' }).count(), 1);
      assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll on the chapter rows`);
      await shot(page, `chapters-${width}`);
      const lastRun = async () => (await previewCall(running.server, 'snapshot', {})).lastRun;
      const earlier = (await lastRun())?.id;
      await rows.nth(0).getByRole('button', { name: '练这一章' }).click();
      await until(async () => (await lastRun())?.id !== earlier, 'the practice run');
      const started = await previewCall(running.server, 'review.get', { runId: (await lastRun()).id });
      assert.equal(started.mode, 'path');
      assert.equal(started.total, 4, 'the four questions made from the first chapter, not the other chapter');
      assert.match(started.card.topic, /Indexes/);
      await until(async () => (await page.locator('body').innerText()).includes('Question i'), 'the first practice question');
      await shot(page, `practice-from-chapter-${width}`);
      assert.deepEqual(errors, [], 'no page errors');
      await context.close();
    }

    // 统计 again: enough answers now, so the percentages are back.
    {
      const { page, context } = await openApp(browser, running, { width: 420 });
      await go(page, 'dashboard');
      await page.locator('.dash-rates').waitFor({ timeout: 30000 });
      await settleAnimations(page);
      assert.ok(await overflow(page) <= 0, '420px: no sideways scroll on the dashboard');
      await shot(page, 'dashboard-420');
      await context.close();
    }
  } finally {
    await browser.close().catch(() => {});
    await running?.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});
