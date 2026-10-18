/* global window document getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { drainLayoutStability, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { BOOK_COURSE, seedBookFixture } from './helpers/book-fixtures.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { settleJob } from './helpers/wait.mjs';
import { replaceAiBlock } from '../lib/course-book-ai-text.js';

/* 复习全书 问 AI in the real page at 1280 and 420 px (docs/review-book.md "Ask AI", "AI blocks"), on the ArchSS-like book: words selected with the keyboard
   (selection.modify, what Shift+arrows do: only `selectionchange` tells the page) show the toolbar 弄懂 / 写一段… / 发给主会话 (弄懂 secondary, the page keeps at
   most one primary); 弄懂 closes it and leaves ONE line right after the paragraph at once; the block lands in that line's place, folded, and the point's text does
   not move (CLS ≤ 0.05, the next paragraph's top the same); its ⋯ menu deletes it, 「已删除这段 · 撤销」 brings it back, and a write since the deletion refuses the
   撤销; 取消 stops a running task; a failure says why and 重试 starts it again; 问 AI at the title writes into 我的 with Ctrl+Enter; 删除 of a block another writer
   already took out leaves no 撤销; in 整章连着读 scrolling keeps the 问 AI panel and its text; the first Tab goes into the toolbar once. The task is answered by a second
   service over the same library with the unified runtime (the fake model); job.status is held until the test lets it go. Screenshots to COURSE_BOOK_AI_SHOTS. */

/** Answers generation.courseBook.explain and job.status / job.cancel at the network edge. `mode`: 'real' (the second service runs the task) or 'fake' (a task
    that only answers what `fake` says: running until told otherwise, 'failed' with a reason). A real task's end is held until `release(jobId)`. */
async function tasksFor(page, root) {
  const model = createFakeModel({ latencyMs: 5 });
  const service = new StudyService(root, { complete: model, ...switchOptions('runtime', { complete: model, paths: [] }) });
  const control = { mode: 'real', ended: new Map(), held: true, fake: new Map(), cancels: [], started: [], n: 0 };
  const answer = (route, value) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value }) });
  await page.route('**/api/call', async route => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* not JSON */ }
    if (body.action === 'generation.courseBook.explain') {
      control.started.push(body.args);
      if (control.mode === 'fake') { control.n += 1; const jobId = `fake-${control.n}`; control.fake.set(jobId, { status: 'running' }); return answer(route, { jobId, status: 'running', blockId: `aifake${control.n}` }); }
      const started = await service.call('generation.courseBook.explain', body.args);
      settleJob(service, started.jobId).then(job => control.ended.set(started.jobId, job.status), () => control.ended.set(started.jobId, 'failed'));
      return answer(route, started);
    }
    if (body.action === 'job.status') {
      const id = body.args?.jobId;
      if (control.fake.has(id)) return answer(route, control.fake.get(id));
      return answer(route, { status: !control.held && control.ended.has(id) ? control.ended.get(id) : 'running' });
    }
    if (body.action === 'job.cancel') { control.cancels.push(body.args?.jobId); control.fake.set(body.args?.jobId, { status: 'cancelled' }); return answer(route, { status: 'cancelled' }); }
    return route.continue();
  });
  return { control, dispose: () => service.dispose() };
}

/** Select, from the start of `from`, up to and with `to` in the first point's text, the way Shift+arrows do (selection.modify, one character at a time). */
const selectByKeys = (page, from, to) => page.evaluate(([start, end]) => {
  const paragraph = [...document.querySelectorAll('[data-book-point] .book-point__part .book-file p')].find(element => element.textContent.includes(start));
  paragraph.scrollIntoView({ block: 'center', behavior: 'instant' });
  const walker = document.createTreeWalker(paragraph, 4);
  let node = walker.nextNode();
  while (node && !node.data.includes(start)) node = walker.nextNode();
  // The focus goes where the caret is (caret browsing, a press in the text): off the sidebar button that opened the page.
  document.activeElement?.blur?.();
  const selection = window.getSelection();
  selection.collapse(node, node.data.indexOf(start));
  for (let step = 0; step < 400 && !selection.toString().includes(end); step += 1) selection.modify('extend', 'forward', 'character');
  return selection.toString();
}, [from, to]);

const visiblePrimaries = page => page.evaluate(() => [...document.querySelectorAll('.book-page .sh-btn--primary, .book-select .sh-btn--primary, .book-ask .sh-btn--primary')]
  .filter(element => { const box = element.getBoundingClientRect(); return box.width && box.height && box.bottom > 0 && box.top < window.innerHeight; }).length);
const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.book-page *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});
/** The top of the paragraph after the first one of the first point's 讲解 (the text the line and the block stand above). */
const nextTop = page => page.evaluate(() => Math.round([...document.querySelectorAll('[data-book-point] .book-point__part .book-file p')][1].getBoundingClientRect().top * 10) / 10);

test('复习全书 问 AI: the keyboard selection toolbar, the writing line and the quiet landing, ⋯ 删除 / 撤销 with a version check, 取消, 重试 and 问 AI at the title (1280 and 420 px)', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-ai-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: root => seedBookFixture(root, 'archss') });
  const shots = process.env.COURSE_BOOK_AI_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: BOOK_COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900, theme: 'light' });
      const tasks = await tasksFor(page, join(running.base, 'library'));
      t.after(() => tasks.dispose());
      const { control } = tasks;
      await page.goto(running.server.url);
      await page.locator('[data-tour="nav-book"]').click({ timeout: 30000 });
      await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
      await page.mouse.move(width - 10, 890);

      // 问 AI is a quiet button at the title; the page has at most one primary.
      const askOpen = page.locator('.book-step [data-book-ask-open]');
      assert.match(await askOpen.getAttribute('class'), /sh-btn--quiet/);
      assert.ok(await visiblePrimaries(page) <= 1, `${width}px: at most one primary`);

      // A keyboard selection (no mouseup): the toolbar shows, above the selection's first line (every selected word in sight) and within the reading column;
      // 弄懂 is secondary and no second primary appears. (The column check allows 2 px: placeInHost's zoom scale is read from a rounded width.)
      const words = await selectByKeys(page, '只有架构师', '。');
      assert.match(words, /成立\s*1?。/, `${width}px: the selection runs over the 角标: ${words}`);
      const bar = page.locator('.book-select[data-placed]');
      await bar.waitFor({ timeout: 5000 });
      assert.match(await bar.locator('[data-book-select="explain"]').getAttribute('class'), /sh-btn--secondary/);
      assert.deepEqual(await bar.locator('button').allInnerTexts(), ['弄懂', '写一段…', '发给主会话']);
      assert.ok(await visiblePrimaries(page) <= 1, `${width}px: 弄懂 is not a second primary`);
      const place = await page.evaluate(() => {
        const selection = window.getSelection(), rects = [...selection.getRangeAt(0).getClientRects()].filter(rect => rect.width > 0), box = document.querySelector('.book-select').getBoundingClientRect();
        const top = Math.min(...rects.map(rect => rect.top)), column = document.querySelector('.book-read').getBoundingClientRect();
        return { above: box.bottom <= top + 1, inside: box.left >= column.left - 2 && box.right <= column.right + 2, lines: new Set(rects.map(rect => Math.round(rect.top))).size > 1 };
      });
      assert.deepEqual({ ...place, lines: undefined }, { above: true, inside: true, lines: undefined }, `${width}px: above the first line, inside the reading column: ${JSON.stringify(place)}`);
      // The selection's colour is the theme's token (--bg-selected), not the browser's blue.
      const wash = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.background = 'var(--bg-selected)';
        document.querySelector('.book-read').append(probe);
        const token = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { token, selection: getComputedStyle(document.querySelector('[data-book-point] .book-file p'), '::selection').backgroundColor };
      });
      assert.equal(wash.selection, wash.token, `${width}px: the selection colour is the token: ${JSON.stringify(wash)}`);
      if (shots) await page.screenshot({ path: join(shots, `selection-toolbar-${width}.png`) });
      // Tab goes into it from the selection, once: Tab on goes through the toolbar and out of it, never back in (no loop for the keyboard).
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.bookSelect), 'explain', `${width}px: Tab moves into the toolbar`);
      const tabs = [];
      for (let step = 0; step < 5; step += 1) { await page.keyboard.press('Tab'); tabs.push(await page.evaluate(() => document.activeElement?.dataset.bookSelect || document.activeElement?.tagName)); }
      assert.deepEqual(tabs.slice(0, 2), ['write', 'chat'], `${width}px: through the toolbar`);
      assert.equal(tabs.slice(2).some(name => ['explain', 'write', 'chat'].includes(name)), false, `${width}px: and on through the page, not back into it: ${tabs}`);
      await selectByKeys(page, '只有架构师', '。');
      await bar.waitFor({ timeout: 5000 });

      // 弄懂: the toolbar goes at once, ONE line right after the paragraph.
      await bar.locator('[data-book-select="explain"]').click();
      const line = page.locator('[data-book-point] [data-ai-line="writing"]');
      await line.waitFor({ timeout: 5000 });
      assert.equal(await page.locator('.book-select').count(), 0, `${width}px: the toolbar is gone`);
      assert.equal(await page.locator('[data-ai-line]').count(), 1);
      assert.match((await line.innerText()).replace(/\s+/g, ' '), /AI 正在写 · 约 1 分钟 · 取消/);
      assert.equal(control.started.at(-1).mode, 'explain');
      assert.doesNotMatch(control.started.at(-1).words, /成立1|1。/, `${width}px: the words sent carry no 角标 digit: ${control.started.at(-1).words}`);
      const order = await line.evaluate(element => {
        const paragraphs = [...document.querySelectorAll('[data-book-point] .book-point__part .book-file p')];
        return { after: !!(paragraphs[0].compareDocumentPosition(element) & 4), beforeNext: !!(paragraphs[1].compareDocumentPosition(element) & 2) };
      });
      assert.deepEqual(order, { after: true, beforeNext: true }, `${width}px: right after the paragraph`);
      await page.waitForTimeout(700);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `writing-line-${width}.png`) });
      // The task ends: the block takes the line's place, folded, and nothing below moves.
      const before = await nextTop(page);
      await drainLayoutStability(page);
      control.held = false;
      const landed = page.locator('[data-book-point] .book-ai[data-ai-landed]');
      await landed.waitFor({ timeout: 90000 });
      const id = await landed.getAttribute('data-ai-block'), block = page.locator(`.book-ai[data-ai-block="${id}"]`);
      assert.equal(await page.locator('[data-ai-line]').count(), 0, `${width}px: the line is gone`);
      assert.equal(await block.getAttribute('data-ai-folded'), 'true', `${width}px: it lands folded`);
      await page.waitForTimeout(400);
      const verdict = judgeLayoutStability(await drainLayoutStability(page));
      assert.ok(verdict.cls <= 0.05, `${width}px: the landing moves nothing (CLS ${verdict.cls})`);
      assert.equal(await nextTop(page), before, `${width}px: the next paragraph stays where it was`);
      if (shots) await page.screenshot({ path: join(shots, `landed-folded-${width}.png`) });
      await page.locator('.book-ai[data-ai-landed]').waitFor({ state: 'detached', timeout: 5000 });

      // ⋯ › 删除: 「已删除这段 · 撤销」 in place; 撤销 brings it back.
      await block.locator('.book-ai__more').click();
      const items = await page.getByRole('menuitem').allInnerTexts();
      assert.deepEqual(items.map(text => text.split('\n')[0].trim()), ['保留', '重新生成', '复制', '删除'], `${width}px: the menu`);
      if (shots) await page.screenshot({ path: join(shots, `block-menu-${width}.png`) });
      await page.getByRole('menuitem', { name: /删除/ }).click();
      const undo = page.locator('[data-ai-line="undo"]');
      await undo.waitFor({ timeout: 10000 });
      assert.equal(await block.count(), 0);
      if (shots) await page.screenshot({ path: join(shots, `deleted-undo-${width}.png`) });
      await undo.locator('[data-book-ai="undo"]').click();
      await block.waitFor({ timeout: 10000 });
      assert.equal(await undo.count(), 0);
      // A write since the deletion (here the file saved by another hand) refuses the 撤销, and says so.
      await block.locator('.book-ai__more').click();
      await page.getByRole('menuitem', { name: /删除/ }).click();
      await undo.waitFor({ timeout: 10000 });
      const opened = await running.api('course.book.open', { course: BOOK_COURSE }), mine = opened.nodes[0].children[0].children[0].files.mine;
      await running.api('course.book.save', { course: BOOK_COURSE, file: mine, text: `${opened.files[mine].text ?? ''}\n\nTyped meanwhile.`, version: opened.files[mine].version });
      await undo.locator('[data-book-ai="undo"]').click();
      await page.getByText('这段删除之后书又改过了，没法撤销。').first().waitFor({ timeout: 10000 });
      assert.equal(await block.count(), 0, `${width}px: the refused 撤销 brings nothing back`);

      // 取消 stops a running task: job.cancel, and the line goes.
      control.mode = 'fake';
      await selectByKeys(page, '只有架构师', '。');
      await bar.waitFor({ timeout: 5000 });
      await bar.locator('[data-book-select="explain"]').click();
      await line.waitFor({ timeout: 5000 });
      await page.waitForTimeout(300);
      await line.getByRole('button', { name: '取消' }).click();
      await line.waitFor({ state: 'detached', timeout: 5000 });
      assert.equal(control.cancels.length, 1, `${width}px: the task was stopped`);
      // A failure says why in the line's place; 重试 starts it again.
      await selectByKeys(page, '只有架构师', '。');
      await bar.waitFor({ timeout: 5000 });
      await bar.locator('[data-book-select="explain"]').click();
      await line.waitFor({ timeout: 5000 });
      control.fake.set(`fake-${control.n}`, { status: 'failed', error: { message: '资料里找不到这几句话' } });
      const failed = page.locator('[data-book-point] [data-ai-line="failed"]');
      await failed.waitFor({ timeout: 10000 });
      assert.match(await failed.innerText(), /没写成：资料里找不到这几句话/);
      const startedBefore = control.started.length;
      await failed.getByRole('button', { name: '重试' }).click();
      await line.waitFor({ timeout: 5000 });
      assert.equal(control.started.length, startedBefore + 1, `${width}px: 重试 starts it again`);
      await line.getByRole('button', { name: '取消' }).click();
      await line.waitFor({ state: 'detached', timeout: 5000 });

      // 问 AI at the title: a preset fills the box, Escape closes it (the focus back on the button), Ctrl+Enter writes into 我的.
      control.mode = 'real';
      control.held = false;
      await page.evaluate(() => { const app = document.querySelector('.study-app'); if (app) app.scrollTop = 0; window.scrollTo(0, 0); });
      await askOpen.click();
      const panel = page.locator('.book-ask[data-placed]');
      await panel.waitFor({ timeout: 5000 });
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA', `${width}px: the focus is in the box`);
      await panel.locator('[data-book-ask-preset="加个例子"]').click();
      assert.equal(await panel.locator('textarea').inputValue(), '加个例子');
      assert.equal(await panel.locator('[data-book-ask="write"]').isDisabled(), false);
      const fits = await panel.evaluate(element => { const box = element.getBoundingClientRect(), page = document.querySelector('.book-page').getBoundingClientRect(); return box.left >= page.left - 1 && box.right <= page.right + 1; });
      assert.equal(fits, true, `${width}px: the panel stays inside the page column`);
      if (shots) await page.screenshot({ path: join(shots, `ask-panel-${width}.png`) });
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached', timeout: 5000 });
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-book-ask-open')), true, `${width}px: the focus is back on 问 AI`);
      await askOpen.click();
      await panel.locator('textarea').fill(`对比两种做法 ${width}`);
      await panel.locator('textarea').press('Control+Enter');
      await panel.waitFor({ state: 'detached', timeout: 2000 });
      const layerLine = page.locator('[data-book-layer] [data-ai-line="writing"]');
      await layerLine.waitFor({ timeout: 5000 });
      assert.equal(control.started.at(-1).mode, 'here');
      const hereId = await page.locator('[data-book-layer] .book-ai[data-ai-landed]').getAttribute('data-ai-block', { timeout: 90000 });

      // 删除 of a block another writer already took out (the main chat rewrote the file; the page still shows it): no 「撤销」 (it would take back their
      // write), only a notice. The page looks for a newer book when the focus comes into it (S1); that look
      // is over before the menu opens, and the other write comes while the learner is choosing 删除.
      const here = page.locator(`.book-ai[data-ai-block="${hereId}"]`);
      await page.locator('[data-book-layer] .book-ai[data-ai-landed]').waitFor({ state: 'detached', timeout: 5000 });
      // In the middle of the window, so its menu opens without scrolling the page (a scroll closes a menu).
      await here.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.waitForTimeout(2100);
      await page.locator('.book-bar__where').focus();
      await page.waitForTimeout(1000);
      await here.locator('.book-ai__more').click();
      await page.getByRole('menuitem', { name: /删除/ }).waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
      const book = await running.api('course.book.open', { course: BOOK_COURSE }), point = book.nodes[0].children[0].children[0], file = point.files.mine;
      const without = replaceAiBlock(point.mine ?? '', hereId, '');
      assert.equal(typeof without, 'string', `${width}px: the block ${hereId} is in ${file}`);
      await running.api('course.book.save', { course: BOOK_COURSE, file, text: without, version: book.files[file].version });
      await page.getByRole('menuitem', { name: /删除/ }).click();
      await page.getByText('这段已经不在书里了').first().waitFor({ timeout: 10000 });
      assert.equal(await page.locator('[data-ai-line="undo"]').count(), 0, `${width}px: nothing of this page's to undo`);

      // 整章连着读: scrolling keeps the 问 AI panel and what is typed in it (the place read changes; the panel's point is still drawn).
      await page.evaluate(() => { const app = document.querySelector('.study-app'); if (app) app.scrollTop = 0; window.scrollTo(0, 0); });
      await page.locator('.book-bar__more').click();
      await page.getByRole('menuitemcheckbox', { name: '整章连着读' }).click();
      await page.locator('.book-chapter').first().waitFor({ timeout: 10000 });
      await page.locator('.book-node[data-book-folded] .book-node__toggle').first().click();
      const second = page.locator('.book-chapter [data-book-ask-open]').nth(1);
      await second.scrollIntoViewIfNeeded();
      await second.click();
      await panel.waitFor({ timeout: 5000 });
      await panel.locator('textarea').fill('我自己打的一段要求');
      const placeBefore = await page.locator('.book-bar__title').innerText();
      await page.mouse.move(Math.round(width / 2), 600);
      for (let step = 0; step < 30 && (await page.locator('.book-bar__title').innerText()) === placeBefore; step += 1) { await page.mouse.wheel(0, 120); await page.waitForTimeout(120); }
      assert.notEqual(await page.locator('.book-bar__title').innerText(), placeBefore, `${width}px: the place read moved`);
      await page.waitForTimeout(300);
      assert.equal(await page.locator('.book-ask').count(), 1, `${width}px: scrolling keeps the panel`);
      assert.equal(await page.locator('.book-ask textarea').inputValue(), '我自己打的一段要求', `${width}px: and what is typed in it`);
      await page.keyboard.press('Escape');

      const overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      // The one refused 撤销 is the host's answer 400 (course-book-conflict), which the browser logs; nothing else.
      assert.deepEqual(errors.filter(error => !/status of 400/.test(error)), [], `${width}px: no page errors`);
      assert.ok(errors.length <= 1, `${width}px: only the refused 撤销 answered 400: ${JSON.stringify(errors)}`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
