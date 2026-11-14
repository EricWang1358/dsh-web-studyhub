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
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

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
    const entry = await revealNavRow(page, 'exam');
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

    // Answer the first, step past the second (skipped) via ArrowRight, step to third, answer via key "2", test ArrowLeft/Right, then submit: one is open.
    await page.locator('.exam-option').nth(0).click();
    await page.keyboard.press('ArrowRight');
    await until(async () => (await page.locator('.exam-progress').innerText()).startsWith('2 '), 'ArrowRight moves to question 2');
    await next(3);
    await page.keyboard.press('2');
    await until(async () => (await page.locator('.exam-option').nth(1).getAttribute('aria-pressed')) === 'true', 'key 2 selects second option');
    await page.keyboard.press('ArrowLeft');
    await until(async () => (await page.locator('.exam-progress').innerText()).startsWith('2 '), 'ArrowLeft returns to question 2');
    await page.keyboard.press('ArrowRight');
    await until(async () => (await page.locator('.exam-progress').innerText()).startsWith('3 '), 'ArrowRight advances back to question 3');
    await submit.click();
    await dialog.waitFor({ timeout: 10000 });
    assert.match(await dialog.innerText(), /还有 1 题未作答/, 'a skipped question is counted, the answered ones are not');
    const jumpBlank = dialog.locator('[data-testid="exam-jump-first-blank"]');
    assert.match(await jumpBlank.innerText(), /跳到第 2 题补答/, 'jump button names the first skipped question');
    await jumpBlank.click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });

    // Jumping lands directly on the skipped question (2); answer it via key "1": nothing is open any more.
    await until(async () => (await page.locator('.exam-progress').innerText()).startsWith('2 '), 'jumped straight to skipped question');
    await page.keyboard.press('1');
    await until(async () => (await page.locator('.exam-option').nth(0).getAttribute('aria-pressed')) === 'true', 'key 1 selects first option');
    await submit.click();
    await page.locator('.exam-report').waitFor({ timeout: 30000 });
    assert.equal(await page.getByRole('button', { name: '仍然交卷' }).count(), 0, 'no question was open: the paper went in without a dialog');

    // Oral interview: early-exit confirmation with unanswered count, Ctrl+Shift+Enter follow-up, report veil & needs-work filter.
    await page.getByRole('button', { name: '再考一次' }).click();
    await page.locator('.es-sheet').waitFor({ timeout: 15000 });
    await page.locator('.es-format__seg').getByText('口头面试').click();
    await page.getByRole('button', { name: '开始口头模拟' }).click();
    await page.locator('.oral-question').waitFor({ timeout: 30000 });
    assert.match(await page.locator('.oral-progress').innerText(), /第 1 \/ 3 题/);

    await page.getByRole('button', { name: '提前结束' }).click();
    await dialog.waitFor({ timeout: 10000 });
    assert.match(await dialog.innerText(), /还有 3 题未作答，提前结束将立即完成本次口头模拟。/);
    await dialog.getByRole('button', { name: '继续作答' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });

    const mainInput = page.locator('.oral-answer-input').first();
    await mainInput.click();
    await mainInput.fill('Indexing uses a B-tree to narrow lookup paths quickly.');
    await page.keyboard.press('Control+Shift+Enter');
    await page.locator('.oral-followup').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '保存并继续 →' }).click();
    await until(async () => (await page.locator('.oral-progress').innerText()).includes('第 2 / 3 题'), 'advanced to oral Q2');
    await page.locator('.oral-answer-input').first().fill('Second oral answer leaving Q3 blank.');
    await page.getByRole('button', { name: '提前结束' }).click();
    await dialog.waitFor({ timeout: 10000 });
    assert.match(await dialog.innerText(), /还有 1 题未作答/);
    await dialog.getByRole('button', { name: '仍然交卷' }).click();

    await page.locator('.oral-report').waitFor({ timeout: 30000 });
    await page.locator('.oral-report .result-details summary').first().click();
    await until(async () => (await page.locator('.oral-report-entry').count()) === 3, 'all 3 oral entries shown');
    assert.equal(await page.locator('.oral-report-entry').nth(0).locator('.oral-expected-veil').count(), 0, 'strong entry reveals reference directly');
    assert.equal(await page.locator('.oral-report-entry').nth(1).locator('.oral-expected-veil').count(), 1, 'developing entry veils reference behind active-recall disclosure');
    assert.equal(await page.locator('.oral-report-entry').nth(2).locator('.oral-expected-veil').count(), 1, 'unanswered entry veils reference behind active-recall disclosure');

    const filterBtn = page.getByRole('button', { name: '只看需巩固 (2)' });
    await filterBtn.click();
    await until(async () => (await page.locator('.oral-report-entry').count()) === 2, 'needs-work filter hides strong entry');
    await page.getByRole('button', { name: '显示全部 3 题' }).click();
    await until(async () => (await page.locator('.oral-report-entry').count()) === 3, 'show-all restores all oral entries');
    const firstVeil = page.locator('.oral-expected-veil').first();
    await firstVeil.locator('summary').click();
    assert.match(await firstVeil.innerText(), /Right one/);

    assert.deepEqual(errors.filter(Boolean), [], 'no page errors');
    await context.close();
  } finally {
    await browser.close();
    if (server) await server.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
