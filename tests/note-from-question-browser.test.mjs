/* global window document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';

/* 存进笔记 (#1017) in the real page at 1280 and 420 px: under a Q&A of a turned-over question, 「存进笔记」 makes the question's note filled from the card
   (headings, explanation, 来源：第 3 页, the Q&A) and then reads 已存进笔记 · 打开; that opens the note, whose 来源 link opens the reader at the cited quote.
   A second Q&A goes into the same note once. Screenshots go to NOTE_QA_SHOTS when set. */

const COURSE = 'Patterns';
const QUOTE = 'Caretaker 保存快照历史，但不查看快照内容。';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    // A converted PDF of three pages (the shape an import leaves), the question citing page 3.
    for (const page of [1, 2, 3]) state.sources.push({ id: `patterns-p${page}`, title: `设计模式 · p. ${page}`, courses: [COURSE], createdAt: '2026-11-01T00:00:00.000Z',
      text: page === 3 ? `第三页。${QUOTE}其余内容。` : `第 ${page} 页的内容。`,
      document: { materialId: 'document-patterns', page, totalPages: 3, format: 'pdf', origin: 'converted', converter: 'marker', filename: '设计模式.pdf', extractionVersion: 2 } });
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    state.decks.push({ id: 'memento', title: 'Memento', course: COURSE, cards: [{ id: 'm1', topic: 'Memento', prompt: '哪个组件管理快照历史？', answer: 'Caretaker（管理者）',
      explanation: 'Caretaker 保存和管理快照历史；创建与恢复由 Originator 负责。', misconception: '把 Memento 本身当成管理历史的对象。',
      citations: [{ sourceId: 'patterns-p3', quote: QUOTE }] }] });
  });
  const run = await service.call('review.start', { deckId: 'memento', mode: 'flashcard' });
  await service.call('review.reveal', { runId: run.id, cardId: 'm1' });
  await service.dispose();
}

const REFUSED = 'Failed to load resource: the server responded with a status of 400 (Bad Request)';
const sideways = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('存进笔记 on a Q&A: the filled note, 已存进笔记 · 打开, its 来源 link opens the reader at the quote (1280 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-note-qa-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.NOTE_QA_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const ref = { deckId: 'memento', cardId: 'm1' };
  try {
    for (const width of [1280, 420]) {
      const asked = await running.api('card.followup.add', { ...ref, question: `为什么 Caretaker 不看内容？（${width}）`, answer: `窄接口隐藏了状态（${width}）。` });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await context.addInitScript(() => { try { localStorage.setItem('study-autopilot', 'off'); } catch { /* blocked */ } });
      const refused = [];
      page.on('response', response => { if (response.status() === 400) { try { refused.push(JSON.parse(response.request().postData() || '{}').action); } catch { refused.push(response.url()); } } });
      await page.goto(running.server.url);
      await page.getByRole('button', { name: '接着做' }).first().click({ timeout: 30000 });
      const flip = page.locator('[data-usage="review.flip"][aria-label="翻面查看答案"]');
      await page.getByRole('button', { name: '讲解', exact: true }).or(flip).first().waitFor({ timeout: 30000 });
      if (await flip.count()) await flip.first().click();
      const explain = page.getByRole('button', { name: '讲解', exact: true });
      if (await explain.getAttribute('aria-pressed') !== 'true' && await explain.getAttribute('aria-expanded') !== 'true') await explain.click();
      const item = page.locator('.followup-item', { hasText: `为什么 Caretaker 不看内容？（${width}）` });
      await item.waitFor({ timeout: 30000 });
      if (await item.getAttribute('open') === null) await item.locator('summary').click();
      const save = item.locator('[data-note-qa="save"]');
      await save.waitFor({ timeout: 30000 });
      assert.equal((await save.innerText()).trim(), '存进笔记');
      await save.click();
      const saved = item.locator('[data-note-qa="saved"]');
      await saved.waitFor({ timeout: 30000 });
      assert.equal((await saved.innerText()).trim(), '已存进笔记 · 打开');
      const notes = (await running.api('note.list', {})).notes.filter(note => note.cards.some(card => card.cardId === 'm1'));
      assert.equal(notes.length, 1, `${width}px: one note for the question`);
      const text = (await running.api('note.get', { id: notes[0].id })).markdown;
      assert.equal(text.split(`为什么 Caretaker 不看内容？（${width}）`).length, 2, `${width}px: the Q&A once`);
      assert.match(text, /## 核心概念[\s\S]*哪个组件管理快照历史？[\s\S]*## 常见误区[\s\S]*把 Memento 本身[\s\S]*## 学习记录[\s\S]*Caretaker 保存和管理/);
      assert.match(text, /来源：\[第 3 页\]\(#studyhub-cite\/memento\/m1\/0\)/);
      assert.ok((await running.api('snapshot')).noteBadges.m1[0].followupIds.includes(asked.item.id));
      assert.ok(await sideways(page) <= 0, `${width}px: the practice page does not scroll sideways`);
      await settleAnimations(page);
      if (shots) { await item.evaluate(element => element.scrollIntoView({ block: 'center' })); await page.screenshot({ path: join(shots, `note-qa-saved-${width}.png`) }); }

      // 已存进笔记 · 打开 → the note, read as a page; 来源：第 3 页 → the reader at the quote.
      await saved.click();
      const reader = page.locator('.note-reader');
      await reader.waitFor({ timeout: 30000 });
      await reader.getByText(`窄接口隐藏了状态（${width}）。`).waitFor({ timeout: 30000 });
      assert.doesNotMatch(await reader.innerText(), /studyhub-cite|\*\*/, `${width}px: the Markdown is rendered, no link target or asterisks shown`);
      assert.ok(await sideways(page) <= 0, `${width}px: the note does not scroll sideways`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `note-qa-note-${width}.png`) });
      await reader.getByRole('link', { name: '第 3 页' }).click();
      const dialog = page.locator('.source-preview');
      await dialog.waitFor({ timeout: 30000 });
      await dialog.getByText(QUOTE).first().waitFor({ timeout: 30000 });
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `note-qa-source-${width}.png`) });
      // A seeded book has no materials record, so the reader's per-material lists are refused (as in reader-last-read-browser): those 400s only.
      assert.ok(refused.every(action => ['materials.translation.list', 'materials.annotation.list', 'materials.marks.list'].includes(action)), `only the per-material lists are refused: ${JSON.stringify(refused)}`);
      assert.deepEqual(errors.filter(error => error !== REFUSED), [], `${width}px: no other page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
