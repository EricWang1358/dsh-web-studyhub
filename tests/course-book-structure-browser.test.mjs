/* global document, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* 复习全书 structure from the page (#470, docs/review-book.md "Structure"): 更多 › 改名… / 移动到… / 删除这个知识点… change the book without the
   main chat and without the outline. Rename keeps the point's number, files and questions; 上移 / 下移 reorder it among its siblings; 放到 moves it
   under another chapter; 删除 asks once and puts what the learner wrote into 未归位. Every call carries the book's structureVersion: a stale one is
   said, the book is read again and what was typed stays. Real page at 1280 and 420 px. */

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
    const leaves = [
      { id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] },
      { id: 'who', title: 'Stakeholders and concerns', anchors: [`${lecture}#1`] },
      { id: 'functional', title: 'Functional requirements', anchors: [`${lecture}#2`] },
    ];
    const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes: [{ id: 'c1', title: 'Introduction', children: leaves.slice(0, 2) }, { id: 'c2', title: 'Requirements', children: leaves.slice(2) }],
      other: { anchors: [] }, counts: { units: 3, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const page = state.sources.find(source => source.id === 'document-l1-p1');
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
      body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} in one line [^1].`], explain: `The explanation of ${leaf.title}.`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }),
      createdAt: '2026-10-09T01:00:00.000Z' });
  });
  await service.dispose();
}

/** Every call the page makes, so a button's action and payload are read as sent (not only what came of it). */
async function watchCalls(page) {
  const sent = [];
  await page.route('**/api/call', async route => {
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch { body = {}; }
    sent.push({ action: body.action, args: body.args || {} });
    await route.continue();
  });
  return sent;
}

const lastCall = (sent, action, match = () => true) => sent.filter(call => call.action === action && match(call.args)).at(-1);

/** Nothing on the page runs wider than the window (the structure dialog is in the top layer and drawn from inside .book-page). */
async function sideways(page) {
  return page.evaluate(() => {
    const width = window.innerWidth, wide = [...document.querySelectorAll('.book-page *')].filter(element => element.getBoundingClientRect().right > width + 1)
      .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
    return { doc: document.documentElement.scrollWidth - width, wide };
  });
}

test('复习全书 structure: 更多 › 改名 / 移动到 / 删除 change the book, a stale version is read again, 未归位 keeps the text (1280 and 420 px)', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-structure-dist-'));
  await buildPreview({ outdir: dist });
  try {
    for (const width of [1280, 420]) {
      const running = await startLateServer({ distDir: dist, seed });
      try {
        await running.api('focus.set', { course: COURSE });
        const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
        try {
          const sent = await watchCalls(page);
          const openBook = async () => {
            await page.goto(running.server.url);
            await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
            await page.locator('.outline-book-line__open').click({ timeout: 30000 });
            await page.locator('.book-bar').waitFor({ timeout: 30000 });
            await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
          };
          await openBook();
          const open = await running.api('course.book.open', {});
          const [chapterOne, chapterTwo] = open.nodes, first = chapterOne.children[0], second = chapterOne.children[1];

          // 改名… from the keyboard (更多 opens with ArrowDown, Enter presses the focused item): what the book shows changes, nothing else moves.
          await page.locator('.book-bar__more').focus();
          await page.keyboard.press('ArrowDown');
          const renameItem = page.getByRole('menuitem', { name: '改名…' });
          await renameItem.waitFor({ timeout: 30000 });
          await renameItem.focus();
          await page.keyboard.press('Enter');
          const renamed = page.getByRole('dialog');
          await renamed.waitFor({ timeout: 30000 });
          assert.equal(await renamed.getByLabel('名称').inputValue(), first.title, `${width}px: the field starts with the title the book shows`);
          await renamed.getByLabel('名称').fill(`改名 ${width}`);
          await renamed.getByLabel('名称').press('Enter');
          await page.locator('.book-step__heading', { hasText: `改名 ${width}` }).waitFor({ timeout: 30000 });
          await renamed.waitFor({ state: 'detached', timeout: 30000 });
          const renameCall = lastCall(sent, 'course.book.rename', args => args.title === `改名 ${width}`);
          assert.ok(renameCall, `${width}px: 保存 sent course.book.rename`);
          assert.equal(renameCall.args.hid, first.hid);
          assert.equal(renameCall.args.course, COURSE);
          assert.equal(renameCall.args.version, open.structureVersion, 'the version the page showed');
          assert.equal(renameCall.args.answer, 'book', 'the whole book comes back in the same call');
          const afterRename = await running.api('course.book.open', {});
          assert.equal(afterRename.nodes[0].children[0].title, `改名 ${width}`, `${width}px: the book itself is renamed`);
          assert.equal(afterRename.nodes[0].children[0].files.gen, first.files.gen, 'the same file, so the explanation and questions stay');
          assert.equal(afterRename.structureVersion, open.structureVersion + 1);

          // A stale version: another change lands while the dialog is open; 保存 is refused, said in the dialog, the book is read again, and what
          // was typed stays. 保存 once more (with the new version) goes through.
          await page.locator('.book-bar__more').click();
          await page.getByRole('menuitem', { name: '改名…' }).click();
          const stale = page.getByRole('dialog');
          await stale.waitFor({ timeout: 30000 });
          await stale.getByLabel('名称').fill(`再来 ${width}`);
          const before = await running.api('course.book.open', {});
          await running.api('course.book.rename', { hid: second.hid, title: `别处改名 ${width}`, version: before.structureVersion });
          const opens = () => sent.filter(call => call.action === 'course.book.open').length, opensBefore = opens();
          await stale.getByLabel('名称').press('Enter');
          const refusal = stale.locator('.sh-inline--error');
          await refusal.waitFor({ timeout: 30000 });
          assert.match(await refusal.innerText(), /这本书的结构刚被改过/, `${width}px: the stale version is said`);
          assert.equal(await stale.getByLabel('名称').inputValue(), `再来 ${width}`, `${width}px: what was typed is still there`);
          const staleCall = lastCall(sent, 'course.book.rename', args => args.title === `再来 ${width}`);
          assert.equal(staleCall.args.version, before.structureVersion, 'the stale version was the one sent');
          await until(() => opens() > opensBefore, 'the book read again after the conflict');
          if (width === 1280) await page.locator('.book-toc__go', { hasText: `别处改名 ${width}` }).waitFor({ timeout: 30000 });
          await stale.getByLabel('名称').press('Enter');
          await page.locator('.book-step__heading', { hasText: `再来 ${width}` }).waitFor({ timeout: 30000 });
          await stale.waitFor({ state: 'detached', timeout: 30000 });
          const retried = lastCall(sent, 'course.book.rename', args => args.title === `再来 ${width}`);
          assert.equal(retried.args.version, before.structureVersion + 1, `${width}px: the retry carries the version the book has now`);

          // 移动到…: the next point goes up among its siblings (afterHid of the one above), then under the other chapter (toParent).
          await page.locator('.book-step__next').click();
          await page.locator('.book-step__heading', { hasText: `别处改名 ${width}` }).waitFor({ timeout: 30000 });
          await page.locator('.book-bar__more').click();
          await page.getByRole('menuitem', { name: '移动到…' }).click();
          const moved = page.getByRole('dialog');
          await moved.waitFor({ timeout: 30000 });
          assert.equal(await moved.getByRole('button', { name: '下移' }).isDisabled(), true, `${width}px: the last point cannot go down`);
          const beforeShift = (await running.api('course.book.open', {})).structureVersion;
          await moved.getByRole('button', { name: '上移' }).click();
          await until(async () => (await running.api('course.book.open', {})).nodes[0].children[0].hid === second.hid, 'the point moved up');
          const shiftCall = lastCall(sent, 'course.book.move');
          assert.equal(shiftCall.args.hid, second.hid);
          assert.equal(shiftCall.args.beforeHid, first.hid, `${width}px: 上移 puts it before the sibling above`);
          assert.equal(shiftCall.args.version, beforeShift);
          assert.equal(shiftCall.args.answer, 'book');
          let overflow = await sideways(page);
          assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px 移动到…: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
          await moved.getByRole('combobox').click();
          await page.getByRole('option', { name: `${chapterTwo.number} ${chapterTwo.title}` }).click();
          await moved.getByRole('button', { name: '移过去' }).click();
          await until(async () => (await running.api('course.book.open', {})).nodes[1].children.some(node => node.hid === second.hid), 'the point moved under the second chapter');
          const underCall = lastCall(sent, 'course.book.move');
          assert.equal(underCall.args.hid, second.hid);
          assert.equal(underCall.args.toParent, chapterTwo.hid);
          assert.equal('afterHid' in underCall.args, false, 'toParent alone: it goes last in that chapter');
          await page.locator('.book-step__path', { hasText: chapterTwo.title }).waitFor({ timeout: 30000 });
          assert.equal(await moved.getByRole('button', { name: '完成' }).isEnabled(), true);
          await moved.getByRole('button', { name: '完成' }).click();
          await moved.waitFor({ state: 'detached', timeout: 30000 });

          // 删除这个知识点…: one confirmation that says where what you wrote goes; the point goes, its text waits in 未归位, and the next point shows.
          const beforeDelete = await running.api('course.book.open', {});
          const target = beforeDelete.nodes[1].children.find(node => node.hid === second.hid);
          assert.ok(target, `${width}px: the moved point is in the second chapter`);
          const mine = target.files.mine;
          await running.api('course.book.save', { file: mine, text: `### 我的笔记 ${width}\n\n留给未归位的句子 ${width}。`, version: beforeDelete.files[mine].version });
          await page.locator('.book-bar__more').click();
          await page.getByRole('menuitem', { name: '删除这个知识点…' }).click();
          const deleted = page.getByRole('dialog');
          await deleted.waitFor({ timeout: 30000 });
          const confirmation = await deleted.innerText();
          assert.match(confirmation, /未归位/, `${width}px: the confirmation says where what you wrote goes`);
          assert.match(confirmation, new RegExp(`别处改名 ${width}`), `${width}px: it names the point being deleted`);
          const beforeRemove = (await running.api('course.book.open', {})).structureVersion;
          await deleted.getByRole('button', { name: '删除', exact: true }).click();
          await deleted.waitFor({ state: 'detached', timeout: 30000 });
          const removeCall = lastCall(sent, 'course.book.delete');
          assert.equal(removeCall.args.hid, second.hid);
          assert.equal(removeCall.args.children, 'promote', 'a point holds nothing below it: nothing is lifted or sent away but its own text');
          assert.equal(removeCall.args.version, beforeRemove);
          const afterDelete = await running.api('course.book.open', {});
          const hids = list => (list || []).flatMap(node => [node.hid, ...hids(node.children)]);
          assert.equal(hids(afterDelete.nodes).includes(second.hid), false, `${width}px: the point is gone`);
          assert.match(afterDelete.unplaced.text, new RegExp(`留给未归位的句子 ${width}`), 'what the learner wrote waits in 未归位');
          assert.match(afterDelete.unplaced.text, new RegExp(`我的笔记 ${width}`), 'under its own heading');
          await page.locator('.book-step__heading', { hasText: 'Functional requirements' }).waitFor({ timeout: 30000 });

          // The stale version is refused as an HTTP 400 (course-book-conflict), which the browser logs as a failed resource load: it is deliberate.
          const failed = errors.filter(text => /Failed to load resource/.test(text));
          assert.deepEqual(failed.map(text => /status of 400/.test(text)), [true], `${width}px: only the conflict's refusal is logged`);
          assert.deepEqual(errors.filter(text => !/Failed to load resource: the server responded with a status of 400/.test(text)), [], `${width}px: no page errors`);
          overflow = await sideways(page);
          assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
        } finally { await context.close(); }
      } finally { await running.close(); }
    }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});

/* #489 item 6: upkeep from the book page. Changed materials are said here with 更新全书; a point left short has 补漏; 更多 leads back to the 总纲. */
test('复习全书 upkeep: 更新全书 when the materials changed, 补漏 on a short point, 回到总纲 from 更多 (1280 and 420 px)', { timeout: 420000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-upkeep-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: async root => {
    await seed(root);
    const service = new StudyService(root);
    await service.store.update(state => { state.sources.find(source => source.provenance === 'course-outline-notes').courseNotes.leaves[0].body.status = 'short'; });
    await service.dispose();
  } });
  try {
    await running.api('focus.set', { course: COURSE });
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      const sent = await watchCalls(page);
      const open = async () => {
        await page.goto(running.server.url);
        const entry = page.locator('[data-tour="nav-book"]').first();
        await entry.waitFor({ state: 'attached', timeout: 30000 });
        await entry.dispatchEvent('click');
        await page.locator('[data-book-point]').first().waitFor({ timeout: 60000 });
      };
      await open();
      if (width === 1280) assert.equal(await page.locator('[data-book-outdated]').count(), 0, 'nothing changed: nothing said');
      await page.locator('.book-point__short').getByRole('button', { name: '补漏' }).click();
      await until(() => sent.some(call => call.action === 'generation.courseBook.build' && call.args.point === 'what'), '补漏 asks for that point');
      if (width === 1280) await running.api('source.add', { title: 'A new lecture', text: 'New material for this course.', course: COURSE });
      await open();
      const line = page.locator('[data-book-outdated]');
      await line.waitFor({ timeout: 30000 });
      sent.length = 0;
      await line.getByRole('button', { name: '更新全书' }).click();
      await until(() => sent.some(call => call.action === 'generation.courseBook.build' && call.args.point === undefined), '更新全书 asks for the whole book');
      await page.locator('.book-bar__more').evaluate(element => element.click());
      await page.getByRole('menuitem', { name: /^回到总纲/ }).click();
      await page.locator('.book-page').waitFor({ state: 'detached', timeout: 30000 });
      // The preview has no task runner, so the build's own refusal is a failed request here; nothing else may fail.
      assert.deepEqual(errors.filter(text => !/Failed to load resource/.test(text)), [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
