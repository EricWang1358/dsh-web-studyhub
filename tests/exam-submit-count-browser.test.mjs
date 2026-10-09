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
import { openPage, until } from '../scripts/qa/layout-late.mjs';
import { StudyService } from '../lib/service.js';

/* 模拟考试 交卷 in the real app on a seeded temporary library: with questions still open the dialog says how many (and
   继续作答 leaves the paper as it was); with every question answered 交卷 hands the paper in at once, no dialog. */

const card = (id) => ({
  id, kind: 'quiz', topic: 'Indexes', objective: `Explain indexes precisely (${id})`, prompt: `Question ${id}: which statement about indexes is right?`, answer: 'Right one', hint: 'Think about the storage.',
  explanation: 'Because it follows from the source.', misconception: 'Confusing it with caching.',
  citations: [{ sourceId: 's1', quote: 'Indexes speed up lookups on a key.' }],
  options: [{ id: 'a', text: 'Right one', correct: true, explanation: 'Yes.' }, { id: 'b', text: 'Wrong one', correct: false, explanation: 'No.' }, { id: 'c', text: 'Other wrong one', correct: false, explanation: 'No.' }],
});

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.call('course.save', { name: 'Databases' });
  await service.call('source.add', { id: 's1', title: 'Indexes', text: 'Indexes speed up lookups on a key.' });
  await service.call('draft.save', { deck: { id: 'dbq', title: 'Databases quiz', course: 'Databases', cards: ['q1', 'q2', 'q3'].map(card) } });
  await service.call('draft.publish', { id: 'dbq' });
  service.dispose?.();
}

test('交卷 asks only about questions that are still open, and a full paper goes in at once', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const dist = await mkdtemp(join(tmpdir(), 'study-submit-count-dist-'));
  const base = await mkdtemp(join(tmpdir(), 'study-submit-count-'));
  let server = null;
  try {
    await buildPreview({ outdir: dist });
    const root = join(base, 'library');
    await seed(root);
    server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
    const { page, context, errors } = await openPage(browser, { server }, { lang: 'zh', theme: 'dark', width: 1280, height: 900 });
    const snapshot = await previewCall(server, 'snapshot', {});
    await context.addInitScript(([key, value]) => { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* blocked */ } },
      [`study-page-scope:v1:${JSON.stringify([snapshot.root, 'exam'])}`, 'Databases']);
    await page.goto(server.url);
    await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
    const entry = page.locator('[data-tour="nav-exam"]').first();
    await entry.waitFor({ state: 'attached', timeout: 30000 });
    await entry.dispatchEvent('click');
    await page.locator('.es-sheet').waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: '开始考试' }).click();
    await page.locator('.exam-card').waitFor({ timeout: 30000 });
    const total = await page.locator('.exam-progress').innerText().then(text => Number(text.split('/')[1]));
    assert.equal(total, 3);
    const submit = page.locator('.exam-foot').getByRole('button', { name: '交卷', exact: true });
    const dialog = page.getByRole('dialog');
    const next = async number => { await page.getByRole('button', { name: '下一题 →' }).click(); await until(async () => (await page.locator('.exam-progress').innerText()).startsWith(`${number} `), 'the next question'); };

    // Nothing answered: all three are open. 继续作答 closes the dialog and the paper is still running.
    await submit.click();
    await dialog.waitFor({ timeout: 10000 });
    assert.match(await dialog.innerText(), /还有 3 题未作答/);
    await dialog.getByRole('button', { name: '继续作答' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await page.locator('.exam-card').count(), 1, 'the paper is still on screen');

    // Answer the first, step past the second (skipped), answer the third: one is open.
    await page.locator('.exam-option').nth(0).click();
    await next(2);
    await next(3);
    await page.locator('.exam-option').nth(1).click();
    await submit.click();
    await dialog.waitFor({ timeout: 10000 });
    assert.match(await dialog.innerText(), /还有 1 题未作答/, 'a skipped question is counted, the answered ones are not');
    await dialog.getByRole('button', { name: '继续作答' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });

    // Take the third answer back by going to the skipped one and answering it: nothing is open any more.
    await page.getByRole('button', { name: '← 上一题' }).click();
    await until(async () => (await page.locator('.exam-progress').innerText()).startsWith('2 '), 'the skipped question');
    await page.locator('.exam-option').nth(0).click();
    await submit.click();
    await page.locator('.exam-report').waitFor({ timeout: 30000 });
    assert.equal(await page.getByRole('button', { name: '仍然交卷' }).count(), 0, 'no question was open: the paper went in without a dialog');
    assert.deepEqual(errors.filter(Boolean), [], 'no page errors');
    await context.close();
  } finally {
    await browser.close();
    if (server) await server.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
