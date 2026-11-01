/* global window document DOMMatrix */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { BOOK_COURSE, seedBookFixture } from './helpers/book-fixtures.mjs';

/* 复习全书 S1, the frame (docs/review-book.md "Open it", "The book bar", "More", "The contents", "Where you were") in the real page at 1280 and 420 px, on the
   ArchSS-like fixture (sixteen points, no questions): no standing mode switch; the bar sticks under the app's top bar while the point scrolls and its line says how
   far the point is read; 更多 › 翻看 takes the page's place and 「完成 · 回到阅读」 comes back to the same point; the place is kept: a reload (and a later visit
   from the sidebar) lands on the same point at the same offset, while an entry's target (the home's 期末一周 card) wins over it; what the main chat wrote
   (book.write) shows up when the page comes back into view, the heading being read where it was; at 420 the 目录 slides over the text and closes on Esc and on
   a row; one course: the title's course is plain text (no switcher). Fake model, seeded temporary library, no network. */

const leaves = nodes => nodes.flatMap(node => (node.leaf ? [node] : leaves(node.children || [])));
const where = page => page.locator('.book-bar__where').innerText().then(text => text.replace(/\s+/g, ' ').trim());
const stepOf = page => page.locator('.book-step').getAttribute('data-book-step');
const headingTop = (page, hid) => page.evaluate(id => Math.round(document.getElementById(`book-${id}`).getBoundingClientRect().top), hid);
const scrollBy = (page, dy) => page.evaluate(by => { document.querySelector('.study-app').scrollTop += by; }, dy);
/** The sidebar's 复习全书 (at 420 the rail may sit aside: the press is dispatched). */
const fromSidebar = async page => {
  const entry = page.locator('[data-tour="nav-book"]').first();
  await entry.waitFor({ state: 'attached', timeout: 30000 });
  await entry.dispatchEvent('click');
  await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
};
/** 更多 › an item (pressed like the learner's click: the menu closes on any scroll). */
const more = async (page, name) => {
  await page.locator('.book-bar__more').evaluate(element => element.click());
  await page.getByRole('menuitem', { name }).click();
};

test('复习全书 frame: the sticky bar, no mode switch, 更多 › 翻看 and back, the place kept across a reload, an entry wins, the re-read on return, the narrow 目录 (1280 and 420 px)', { timeout: 480000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-frame-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: root => seedBookFixture(root, 'archss') });
  try {
    await running.api('focus.set', { course: BOOK_COURSE });
    const book = await running.api('course.book.open', { course: BOOK_COURSE }), points = leaves(book.nodes);
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await page.goto(running.server.url);
      await fromSidebar(page);

      // One reading surface: no segmented control on the page, the title's course is plain text with one course.
      assert.equal(await page.locator('.book-page .sh-seg').count(), 0, `${width}px: no standing mode switch`);
      assert.equal(await page.locator('.book-page h1 [aria-label="切换当前课程"]').count(), 0, `${width}px: one course, no switcher`);
      assert.match(await page.locator('.book-page h1').innerText(), /^复习全书 · ArchSS$/);
      // Narrow: the count alone and the title without its number (no room for a cut 「1.1.…」).
      assert.equal(await where(page), width === 420 ? `1/16 · ${points[0].title}` : `知识点 1/16 · ${points[0].number} ${points[0].title}`);

      // The bar sticks under the app's top bar while the point scrolls, and its line is part way (the point made long: its whole-point AI block open).
      await page.locator('.book-ai[data-ai-block^="h"] .book-ai__toggle').first().click();
      await page.locator('.book-ai[data-ai-block^="h"] .book-ai__body').first().waitFor();
      const scaleOf = () => page.evaluate(() => new DOMMatrix(window.getComputedStyle(document.querySelector('.book-bar__line > span')).transform).a);
      // (Back at the top of the page: the press may have scrolled the block into view.)
      await page.evaluate(() => { document.querySelector('.study-app').scrollTop = 0; });
      await page.waitForTimeout(400);
      const atTop = await scaleOf();
      await scrollBy(page, 1200);
      await page.waitForTimeout(300);
      const bar = await page.evaluate(() => {
        // The app's top bar of this page (the one on screen) and the bar right under it.
        const box = document.querySelector('.book-bar').getBoundingClientRect(), top = Math.max(...[...document.querySelectorAll('.topbar')].map(item => item.getBoundingClientRect().bottom));
        const line = document.querySelector('.book-bar__line > span'), scale = new DOMMatrix(window.getComputedStyle(line).transform).a;
        return { top: Math.round(box.top), under: Math.round(top), scale };
      });
      // Under the app's top bar while it is on screen; at the very top once a long page has scrolled it away (it sticks only as far as its column reaches).
      assert.ok(Math.abs(bar.top - Math.max(0, bar.under)) <= 1, `${width}px: the bar sticks under the top bar: ${JSON.stringify(bar)}`);
      assert.equal(atTop, 0, `${width}px: nothing read yet: the line is empty while the point's top is under the bar`);
      assert.ok(bar.scale > atTop && bar.scale < 1, `${width}px: the line moves on as the point is read: ${atTop} -> ${JSON.stringify(bar)}`);

      await page.locator('.book-ai[data-ai-block^="h"] .book-ai__toggle').first().click();
      // 更多 is reached by the keys like any menu: ↓ moves through its items, the check (整章连着读, off) among them.
      await page.locator('.book-bar__more').evaluate(element => element.click());
      await page.locator('[role="menu"]').waitFor();
      let check = null;
      for (let n = 0; n < 20 && !check; n += 1) {
        await page.keyboard.press('ArrowDown');
        check = await page.evaluate(() => (document.activeElement?.getAttribute('role') === 'menuitemcheckbox' ? document.activeElement.getAttribute('aria-checked') : null));
      }
      assert.equal(check, 'false', `${width}px: 整章连着读 is reached by ↓ and is off`);
      await page.keyboard.press('Escape');
      await page.locator('[role="menu"]').waitFor({ state: 'detached' });
      // 更多 › 展开 / 收起这个知识点的 AI 段落 (the point's long block starts folded), the same words as 我的's link.
      await more(page, '展开这个知识点的 AI 段落');
      await page.waitForFunction(() => document.querySelectorAll('[data-book-point] .book-ai:not([data-ai-folded])').length > 0);
      await more(page, '收起这个知识点的 AI 段落');
      await page.waitForFunction(() => document.querySelectorAll('[data-book-point] .book-ai:not([data-ai-folded])').length === 0);
      // 更多 › 出一套模拟卷… asks at once in a dialog; this book has no single or multiple choice question, and 知道了 closes it.
      await more(page, /^出一套模拟卷/);
      const mock = page.locator('dialog.book-mock-dialog');
      await mock.getByText('这些知识点没有单选或多选题，出不了模拟卷。').waitFor({ timeout: 30000 });
      await mock.getByRole('button', { name: '知道了' }).click();
      await mock.waitFor({ state: 'detached' });
      await page.evaluate(() => { document.querySelector('.study-app').scrollTop = 0; });
      // ›: the next point, under the bar; 更多 › 翻看 takes the page's place, 「完成 · 回到阅读」 comes back to that point.
      await page.locator('.book-bar__next').click();
      await page.waitForFunction(id => document.querySelector('.book-step')?.dataset.bookStep === id, points[1].hid);
      await scrollBy(page, 300);
      await page.waitForTimeout(200);
      const reading = await headingTop(page, points[1].hid);
      await more(page, /^翻看/);
      await page.locator('.book-flip').waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.book-bar').count(), 0, `${width}px: 翻看 takes the page's place`);
      await page.locator('.book-mode__done').click();
      await page.locator('.book-step').waitFor();
      assert.equal(await stepOf(page), points[1].hid, `${width}px: back at the same point`);
      await page.waitForTimeout(200);
      const again = await headingTop(page, points[1].hid);
      assert.ok(Math.abs(again - reading) <= 3, `${width}px: and where it was on screen: ${reading} -> ${again}`);

      // The place: the third point, scrolled into it; a reload (and the sidebar) lands there at the same offset.
      await page.locator('.book-bar__next').click();
      await page.waitForFunction(id => document.querySelector('.book-step')?.dataset.bookStep === id, points[2].hid);
      await scrollBy(page, 600);
      await page.waitForTimeout(700);
      const before = await headingTop(page, points[2].hid);
      await page.reload();
      await fromSidebar(page);
      await page.waitForFunction(id => document.querySelector('.book-step')?.dataset.bookStep === id, points[2].hid, { timeout: 30000 });
      await page.waitForTimeout(300);
      const after = await headingTop(page, points[2].hid);
      assert.ok(Math.abs(after - before) <= 3, `${width}px: the same point at the same offset after a reload: ${before} -> ${after}`);
      assert.notEqual(await page.evaluate(() => document.activeElement?.id || ''), `book-${points[2].hid}`, `${width}px: a plain open does not move the focus to the heading`);

      // What the main chat wrote shows up when the page comes back into view, and the heading being read stays where it is.
      const kept = await headingTop(page, points[2].hid);
      // (The chat adds a line at the end of the learner's file: the page below the heading only grows, so nothing has to be clamped.)
      const mine = leaves((await running.api('course.book.open', { course: BOOK_COURSE })).nodes)[2].mine;
      await running.api('book.write', { course: BOOK_COURSE, hid: points[2].hid, file: 'mine', markdown: `${mine}

Written by the main chat at ${width}.` });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.locator('.book-file', { hasText: `Written by the main chat at ${width}.` }).waitFor({ timeout: 30000 });
      await page.waitForTimeout(200);
      const now = await headingTop(page, points[2].hid);
      assert.ok(Math.abs(now - kept) <= 3, `${width}px: the re-read keeps the heading where it was: ${kept} -> ${now}`);

      // An entry's target wins over the kept place: the home's 期末一周 card opens the book at its point.
      await page.locator('[data-tour="nav-home"], [data-tour="nav-library"]').first().dispatchEvent('click');
      const card = page.locator('.crunch-card .crunch-day__point').first();
      // This library has a book and no deck of the learner's own, so the home opens on the first-run line (3.6), which holds the 期末一周 card back;
      // 以后再说 folds the line and the home, its 期末一周 card included, is back.
      await page.locator('.crunch-card .crunch-day__point, [data-first-run="later"]').first().waitFor({ timeout: 30000 });
      if (await page.locator('[data-first-run="later"]').count()) await page.locator('[data-first-run="later"]').click();
      await card.waitFor({ timeout: 30000 });
      const target = await card.getAttribute('data-point');
      assert.notEqual(target, points[2].hid, 'the card points elsewhere than the kept place');
      await card.getByRole('button', { name: '去读' }).click();
      await page.waitForFunction(id => document.querySelector('.book-step')?.dataset.bookStep === id, target, { timeout: 30000 });

      // 420: the 目录 slides over the text, Esc closes it, a row closes it and goes there.
      if (width === 420) {
        await page.locator('.book-bar__toc').click();
        await page.locator('.book-toc[data-overlay]').waitFor();
        assert.equal(await page.locator('.book-toc-scrim').count(), 1, '420px: with the scrim');
        const overlay = await page.locator('.book-toc').evaluate(element => window.getComputedStyle(element).position);
        assert.equal(overlay, 'fixed', '420px: over the text, not pushing it down');
        await page.keyboard.press('Escape');
        await page.locator('.book-toc').waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('book-bar__toc')), true, '420px: the focus is back on 目录');
        await page.locator('.book-bar__toc').click();
        await page.locator('.book-toc__go', { hasText: points[5].title }).click();
        await page.locator('.book-toc').waitFor({ state: 'detached' });
        await page.waitForFunction(id => document.querySelector('.book-step')?.dataset.bookStep === id, points[5].hid);
      } else assert.equal(await page.locator('.book-toc').evaluate(element => window.getComputedStyle(element).position), 'sticky', '1280px: a column that sticks');
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }

    // Two courses: the title's course is the home's switcher (with what it does on hover); with unsaved text in the editor, switching asks first.
    await running.api('source.add', { title: 'Second course notes', text: 'A note of another course.', course: 'Second course' });
    const { page, errors, context } = await openPage(browser, running, { width: 1280, height: 900 });
    await page.goto(running.server.url);
    await fromSidebar(page);
    const switcher = page.locator('.book-page h1').getByRole('combobox', { name: '切换当前课程' });
    await switcher.waitFor({ timeout: 30000 });
    await switcher.hover();
    await page.getByText('会切换整个应用的当前课程').waitFor({ timeout: 5000 });
    await more(page, /^编辑这个知识点/);
    await page.locator('.book-editor .cm-content').click();
    await page.keyboard.type('Unsaved words.');
    const pick = async () => { await switcher.click(); await page.getByRole('option', { name: /Second course/ }).click(); };
    await pick();
    const ask = page.locator('.sh-confirm', { hasText: '还有没保存的改动' });
    await ask.waitFor({ timeout: 30000 });
    await ask.getByRole('button', { name: '继续编辑' }).click();
    await ask.waitFor({ state: 'detached' });
    assert.match(await page.locator('.book-page h1').innerText(), /ArchSS/, 'still the same course');
    assert.match(await page.locator('.book-editor .cm-content').innerText(), /Unsaved words\./, 'the text is kept');
    // Every other way out passes the same gate (#489): the sidebar and 回到总纲 ask, and staying keeps the page and the text.
    for (const leave of [() => page.locator('.side-nav .nav', { hasText: '任务' }).first().click(), () => page.getByRole('button', { name: '回到总纲' }).first().click()]) {
      await leave();
      await ask.waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.book-editor').count(), 1, 'nothing left yet');
      await ask.getByRole('button', { name: '继续编辑' }).click();
      await ask.waitFor({ state: 'detached' });
      assert.match(await page.locator('.book-editor .cm-content').innerText(), /Unsaved words\./, 'the text is kept');
    }
    // Saved, nothing to lose: the sidebar goes at once, and the words are in the book when the learner comes back.
    await page.locator('.book-editor__save').click();
    await page.locator('.book-editor__forked').waitFor({ timeout: 30000 });
    await page.locator('.side-nav .nav', { hasText: '任务' }).first().click();
    await page.locator('.book-page').waitFor({ state: 'detached', timeout: 30000 });
    await fromSidebar(page);
    assert.match(await page.locator('.book-page').innerText(), /Unsaved words\./, 'what was saved is in the book');
    await more(page, /^编辑这个知识点/);
    await page.locator('.book-editor .cm-content').click();
    await page.keyboard.type(' Then more.');
    // Discarding on the sidebar's question goes where the click was going, and the text is gone.
    await page.locator('.side-nav .nav', { hasText: '任务' }).first().click();
    await ask.getByRole('button', { name: '丢掉改动，离开' }).click();
    await page.locator('.book-page').waitFor({ state: 'detached', timeout: 30000 });
    await fromSidebar(page);
    assert.doesNotMatch(await page.locator('.book-page').innerText(), /Then more\./, 'what was discarded is not in the book');
    await more(page, /^编辑这个知识点/);
    await page.locator('.book-editor .cm-content').click();
    await page.keyboard.type('Unsaved words.');
    await pick();
    await ask.getByRole('button', { name: '丢掉改动，离开' }).click();
    await page.locator('.book-page h1', { hasText: 'Second course' }).waitFor({ timeout: 30000 });
    // What the discard answered is not kept; what went with no question possible (the course changed from outside, as the main chat can) waits and is offered back.
    await switcher.click();
    await page.getByRole('option', { name: /ArchSS/ }).click();
    await page.locator('.book-page h1', { hasText: 'ArchSS' }).waitFor({ timeout: 30000 });
    await more(page, /^编辑这个知识点/);
    const rescue = page.locator('[data-book-rescue]');
    await page.locator('.book-editor .cm-content').waitFor({ timeout: 30000 });
    assert.equal(await rescue.count(), 0, 'nothing is offered after 丢掉改动');
    await page.locator('.book-editor .cm-content').click();
    await page.keyboard.type('Words that nobody asked about.');
    await running.api('focus.set', { course: 'Second course' });
    await page.locator('.book-page h1', { hasText: 'Second course' }).waitFor({ timeout: 60000 });
    await running.api('focus.set', { course: 'ArchSS' });
    await page.locator('.book-page h1', { hasText: 'ArchSS' }).waitFor({ timeout: 60000 });
    await more(page, /^编辑这个知识点/);
    await rescue.waitFor({ timeout: 30000 });
    assert.doesNotMatch(await page.locator('.book-editor .cm-content').innerText(), /nobody asked/, 'offered, not put in by itself');
    await rescue.getByRole('button', { name: '恢复这些改动' }).click();
    assert.match(await page.locator('.book-editor .cm-content').innerText(), /nobody asked/);
    await page.locator('.book-editor__save').click();
    await rescue.waitFor({ state: 'detached' });
    assert.deepEqual(errors, [], 'two courses: no page errors');
    await context.close();
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
