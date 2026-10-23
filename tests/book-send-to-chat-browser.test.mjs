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
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* 「发给主会话」 in the real page at 1280 and 420 px (docs/review-book-agent.md "Sending it from the book page"), one destination of 问 AI: at a point's title the
   panel with the five presets and a box: a preset fills the box, 发给主会话 hands the message to the chat (the preview has no chat, so it is copied: the clipboard is
   the test's stand-in for askInChat) and closes the panel; an empty box is allowed; the keyboard opens it and Escape gives the focus back. Selected words: the
   toolbar's 发给主会话 sends them in a fence at once, 写一段… opens the panel with them; 更多 › 整本书 › 发给主会话 sends the whole-book message at once (no form).
   The messages open with the learner's sentence and carry no book text; nothing scrolls sideways. Screenshots go to BOOK_SEND_SHOTS when set. */

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => {
    state.sources.push(...sources);
    state.decks.push(...decks);
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
    const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'who', title: 'Stakeholders and concerns', anchors: [`${lecture}#1`] }] }],
      other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const page = state.sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes[0].children;
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
      body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} in one line [^1].`], explain: `The architect of ${leaf.title} writes each decision down with its reasons.\n\nA second paragraph about ${leaf.title}.`,
        cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }), createdAt: '2026-10-09T01:00:00.000Z' });
  });
  await service.dispose();
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.book-page *, dialog *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});
const flat = (page, width, what) => sideways(page).then(overflow => assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px ${what}: nothing scrolls sideways: ${JSON.stringify(overflow)}`));

/** Select `text` in a paragraph of a point, the way a drag ends (the toolbar listens to selectionchange). */
const selectWords = (page, text) => page.evaluate(words => {
  const paragraph = [...document.querySelectorAll('[data-book-point] .book-file p')].find(element => element.textContent.includes(words) && !element.closest('.book-ai'));
  const node = [...paragraph.childNodes].find(child => child.nodeType === 3 && child.textContent.includes(words)), at = node.textContent.indexOf(words);
  paragraph.scrollIntoView({ block: 'center', behavior: 'instant' });
  const range = document.createRange();
  range.setStart(node, at); range.setEnd(node, at + words.length);
  const selection = window.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
}, text);

/** The messages handed over so far: the preview has no chat, so askInChat copies (the stand-in is installed before the page starts). */
const sentOf = page => page.evaluate(() => window.__sentToChat.slice());
const sentCount = page => page.evaluate(() => window.__sentToChat.length);
const nextSent = async (page, before) => { await page.waitForFunction(count => window.__sentToChat.length > count, before, { timeout: 15000 }); return (await sentOf(page)).at(-1); };
const toastSaid = (page, text) => page.getByText(text).first().waitFor({ timeout: 5000 });

async function openBook(page, running) {
  await page.goto(running.server.url);
  await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
  await page.locator('.outline-book-line__open').click({ timeout: 30000 });
  await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
}

const inside = async (page, selector, width, what) => {
  const box = await page.locator(selector).evaluate(element => { const rect = element.getBoundingClientRect(); return { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top) }; });
  assert.ok(box.left >= 0 && box.right <= width + 1, `${width}px: ${what} is inside the window: ${JSON.stringify(box)}`);
};

test('发给主会话: one destination of 问 AI at the title, the selection toolbar and 写一段…, and 更多 › 整本书, each handing its message over (1280 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-send-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.BOOK_SEND_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await context.addInitScript(() => {
        window.__sentToChat = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__sentToChat.push(text); } } });
      });
      await openBook(page, running);

      // The point's row has no button of its own: 问 AI at the title opens the panel with the keyboard, the focus in its box; Escape gives it back.
      assert.doesNotMatch(await page.locator('.book-point__actions').innerText(), /发给主会话/);
      const trigger = page.locator('.book-step [data-book-ask-open]');
      await trigger.focus();
      await page.keyboard.press('Enter');
      const panel = page.locator('.book-ask[data-placed]');
      await panel.waitFor({ timeout: 5000 });
      assert.equal(await page.evaluate(() => document.activeElement?.closest('.book-ask__form') !== null), true, `${width}px: the focus is inside the panel`);
      await inside(page, '.book-ask', width, 'the panel');
      await flat(page, width, 'the panel');
      if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `send-point-panel-${width}.png`) }); }
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached', timeout: 5000 });
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-book-ask-open')), true, `${width}px: the focus is back on 问 AI`);

      // A preset fills the box; 发给主会话 hands the message over (copied here): it names the skill, the point, its files and the request, and carries no book text.
      await trigger.click();
      await panel.waitFor();
      await panel.locator('[data-book-ask-preset="润色成大白话"]').click();
      assert.equal(await panel.locator('textarea').inputValue(), '润色成大白话');
      await panel.locator('textarea').fill('润色成大白话，再慢一点');
      let before = await sentCount(page);
      await panel.locator('[data-book-ask="chat"]').click();
      const first = await nextSent(page, before);
      await panel.waitFor({ state: 'detached', timeout: 5000 });
      for (const part of ['skill study-book', 'book.read', 'book.coverage', 'course.book.revert', '课程 "' + COURSE + '"', '知识点 hid ', '.gen.md', '.mine.md', '当前版本 v', '资料以外'])
        assert.ok(first.includes(part), `${width}px: the message names ${part}: ${first}`);
      assert.match(first, /资料页已读 \d+\/\d+/, `${width}px: the coverage figure`);
      assert.ok(first.includes('资料以外的内容标（资料以外）') && !first.includes('beyond the materials'), `${width}px: a Chinese book: only its own marker`);
      assert.match(first, /^帮我按下面的要求改复习全书的知识点 `What architects do`：\n````?request 我的要求\n润色成大白话，再慢一点\n````?\n/, `${width}px: the learner's sentence and words first`);
      assert.doesNotMatch(first, /writes each decision down/, `${width}px: no book text`);
      await toastSaid(page, '已复制到剪贴板');
      // An empty box is allowed.
      await trigger.click();
      await panel.waitFor();
      assert.equal(await panel.locator('textarea').inputValue(), '', `${width}px: a new panel starts empty`);
      before = await sentCount(page);
      await panel.locator('[data-book-ask="chat"]').click();
      assert.match(await nextSent(page, before), /^帮我把复习全书的知识点 `What architects do` 改得更清楚易懂/);

      // Selected words: the toolbar's 发给主会话 sends them at once, in a data fence.
      const words = 'writes each decision down';
      await selectWords(page, words);
      const bar = page.locator('.book-select[data-placed]');
      await bar.waitFor({ timeout: 10000 });
      await flat(page, width, 'the selection toolbar');
      before = await sentCount(page);
      await bar.locator('[data-book-select="chat"]').click();
      const selected = await nextSent(page, before);
      assert.match(selected, /^帮我把复习全书 `What architects do` 里我选中的那几句改得更清楚/);
      assert.match(selected, /```data 我选中的话\nwrites each decision down\n```/);
      await bar.waitFor({ state: 'detached', timeout: 5000 });
      // 写一段… opens the panel with the words on top; its own box goes with them.
      await selectWords(page, words);
      await bar.waitFor({ timeout: 10000 });
      await bar.locator('[data-book-select="write"]').click();
      await panel.waitFor({ timeout: 5000 });
      assert.match(await panel.locator('.book-ask__words').innerText(), /「writes each decision down」/);
      await panel.locator('textarea').fill('讲得更直白');
      if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `send-selection-${width}.png`) }); }
      before = await sentCount(page);
      await panel.locator('[data-book-ask="chat"]').click();
      const asked = await nextSent(page, before);
      assert.match(asked, /```data 我选中的话\nwrites each decision down\n```/);
      assert.match(asked, /request 我的要求\n讲得更直白\n/);
      await panel.waitFor({ state: 'detached', timeout: 5000 });

      // 更多 › 整本书 › 发给主会话: the whole book at once (no form: the learner adds a request in the chat's input box); the message starts at book.toc and has no point.
      await page.locator('.book-bar__more').click();
      const book = page.getByRole('menuitem', { name: /^发给主会话/ });
      assert.match(await book.innerText(), /只填进输入框，不自动发送/, `${width}px: the item says it only fills the box`);
      assert.doesNotMatch(await book.innerText(), /…/, `${width}px: it opens nothing first, so no ellipsis`);
      if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `send-book-${width}.png`) }); }
      before = await sentCount(page);
      await book.click();
      const whole = await nextSent(page, before);
      assert.match(whole, /^帮我看看整本复习全书：/);
      assert.match(whole, /- 先读：skill study-book，再用 book\.toc 看目录。/);
      assert.doesNotMatch(whole, /知识点 hid|文件：/);
      assert.equal(await page.locator('dialog[open]').count(), 0, `${width}px: no dialog in between`);

      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
