/* global window document MouseEvent */
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

/* 「发给主会话」 in the real page at 1280 and 420 px (docs/review-book-agent.md "Sending it from the book page"): on a point's toolbar row a popover with the three
   presets and a box: a preset fills the box, 发送 hands the message to the chat (the preview has no chat, so it is copied: the clipboard is the test's stand-in for
   askInChat) and closes the popover; an empty box is allowed; the keyboard opens it and Escape gives the focus back. Over selected words the panel has a second
   action that sends the words in a fence; the header's 整本书 · 发给主会话 sends the whole-book message. The messages carry no book text; nothing scrolls sideways.
   Screenshots go to BOOK_SEND_SHOTS when set. */

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
  const width = window.innerWidth, wide = [...document.querySelectorAll('.book-page *, .book-chat__panel *, .book-ai-ask *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});
const flat = (page, width, what) => sideways(page).then(overflow => assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px ${what}: nothing scrolls sideways: ${JSON.stringify(overflow)}`));

/** Select `text` in a paragraph of a point (as the learner's drag does) and let the page see the mouseup. */
const selectWords = (page, text) => page.evaluate(words => {
  const paragraph = [...document.querySelectorAll('[data-book-point] .book-file p')].find(element => element.textContent.includes(words) && !element.closest('.book-ai'));
  const node = [...paragraph.childNodes].find(child => child.nodeType === 3 && child.textContent.includes(words)), at = node.textContent.indexOf(words);
  paragraph.scrollIntoView({ block: 'center', behavior: 'instant' });
  const range = document.createRange();
  range.setStart(node, at); range.setEnd(node, at + words.length);
  const selection = window.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  paragraph.closest('.book-read').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
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

test('发给主会话: a point\'s popover with presets, the selection panel and the header, each handing its message over (1280 and 420 px)', { timeout: 420000 }, async (t) => {
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

      // The point's toolbar row: the button after 整理 (a quiet one), the popover closed.
      const trigger = page.locator('.book-point__actions [data-book-chat="point"]');
      assert.equal((await trigger.innerText()).trim(), '发给主会话');
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('.book-chat__panel').count(), 0);
      assert.match(await page.locator('.book-point__actions').innerText(), /发给主会话$/);
      // Open it with the keyboard: the focus goes into the box; Escape closes it and the focus is back on the button.
      await trigger.focus();
      await page.keyboard.press('Enter');
      const panel = page.locator('.book-chat__panel');
      await panel.waitFor({ timeout: 5000 });
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.evaluate(() => document.activeElement?.closest('.book-chat__form') !== null), true, `${width}px: the focus is inside the popover`);
      await inside(page, '.book-chat__panel', width, 'the popover');
      await flat(page, width, 'the popover');
      assert.match(await panel.innerText(), /也可以直接在主对话里说你想怎么改，主会话会按 study-book 改书，每次改动都能回退/);
      if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `send-point-popover-${width}.png`) }); }
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached', timeout: 5000 });
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-book-chat')), 'point', `${width}px: the focus is back on the button`);

      // A preset fills the box; 发送 hands the message over, copied here: it names the skill, the point, its files and the request, and carries no book text.
      await trigger.click();
      await panel.waitFor();
      await panel.locator('[data-book-chat-preset="润色成大白话"]').click();
      assert.equal(await panel.locator('textarea').inputValue(), '润色成大白话');
      await panel.locator('textarea').fill('润色成大白话，再慢一点');
      let before = await sentCount(page);
      await panel.locator('[data-book-chat-send]').click();
      const first = await nextSent(page, before);
      await panel.waitFor({ state: 'detached', timeout: 5000 });
      for (const part of ['study-book', 'book.read', 'book.coverage', 'course.book.revert', '课程："' + COURSE + '"', '知识点 id（hid）：', '.gen.md', '.mine.md', '当前版本：v', '资料以外'])
        assert.ok(first.includes(part), `${width}px: the message names ${part}: ${first}`);
      assert.match(first, /已读 \d+\/\d+ 页/, `${width}px: the coverage figure`);
      assert.match(first, /````?request 我的要求\n润色成大白话，再慢一点\n````?/);
      assert.match(first, /data 知识点标题\nWhat architects do\n/);
      assert.doesNotMatch(first, /writes each decision down/, `${width}px: no book text`);
      assert.doesNotMatch(first, /整本复习全书/);
      await toastSaid(page, '已复制提示词，粘贴到对话中即可。');

      // An empty box is allowed.
      await trigger.click();
      await panel.waitFor();
      assert.equal(await panel.locator('textarea').inputValue(), '', `${width}px: a new popover starts empty`);
      before = await sentCount(page);
      await panel.locator('[data-book-chat-send]').click();
      assert.match(await nextSent(page, before), /我没有写具体要求：先读这一节/);

      // Over selected words: the panel's second action sends the words (in a data fence) and the instruction of its own box; it closes.
      const words = 'writes each decision down';
      await selectWords(page, words);
      const ask = page.locator('.book-ai-ask');
      await ask.waitFor({ timeout: 10000 });
      assert.match(await ask.locator('[data-book-ai="chat"]').innerText(), /发给主会话/);
      assert.equal(await ask.locator('[data-book-ai="chat"]').isDisabled(), false);
      await flat(page, width, 'the selection panel');
      await ask.locator('.book-ai__input').fill('讲得更直白');
      if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `send-selection-${width}.png`) }); }
      before = await sentCount(page);
      await ask.locator('[data-book-ai="chat"]').click();
      const selected = await nextSent(page, before);
      assert.match(selected, /选中的那几句话/);
      assert.match(selected, /```data 我选中的话\nwrites each decision down\n```/);
      assert.match(selected, /request 我的要求\n讲得更直白\n/);
      assert.match(selected, /知识点 id（hid）：/);
      await ask.waitFor({ state: 'detached', timeout: 5000 });

      // 更多 › 整本书 › 发给主会话…: the whole book, with the same form in a dialog; the message starts at book.toc and has no point.
      await page.locator('.book-bar__more').click();
      const book = page.getByRole('menuitem', { name: /^发给主会话…/ });
      assert.match(await book.innerText(), /只填进输入框，不自动发送/, `${width}px: the item says it only fills the box`);
      await book.click();
      const whole_ = page.locator('dialog.book-chat-dialog');
      await whole_.waitFor();
      assert.match(await whole_.innerText(), /让主会话改整本书/);
      await inside(page, 'dialog.book-chat-dialog', width, 'the dialog');
      await flat(page, width, 'the dialog');
      await whole_.locator('textarea').fill('全书统一成大白话');
      if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `send-book-popover-${width}.png`) }); }
      before = await sentCount(page);
      await whole_.locator('textarea').press('Control+Enter');
      const whole = await nextSent(page, before);
      assert.match(whole, /改整本复习全书/);
      assert.match(whole, /先用 book\.toc 看目录/);
      assert.match(whole, /request 我的要求\n全书统一成大白话\n/);
      assert.doesNotMatch(whole, /知识点 id（hid）|这一节的文件/);
      await whole_.waitFor({ state: 'detached', timeout: 5000 });

      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
