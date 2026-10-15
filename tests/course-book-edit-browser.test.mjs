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

/* 复习全书 M2 in the real page at 1280 and 420 px (docs/plans/review-book.md, docs/review-book.md "Edit it"): 更多 › 编辑这一节… opens the Markdown editor on
   the point's explanation, 「完成 · 回到阅读」 comes back to the same point and asks first when there are unsaved edits; edit a generated file and save (it is
   then 已改动), the book shows the edit, a save that met another change leaves a 书已更新 suggestion to 采用 or 忽略, 回退到上一版 takes the edit back, nothing
   scrolls sideways. Screenshots go to COURSE_BOOK_EDIT_SHOTS when set. */

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
      body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} in one line [^1].`], explain: `The explanation of ${leaf.title}.`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }),
      createdAt: '2026-10-09T01:00:00.000Z' });
  });
  await service.dispose();
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.book-page *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});

test('复习全书 editing: 预览/原文, edit and save a generated file (已改动), 书已更新 with 采用 and 忽略, 回退到上一版 (1280 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-edit-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_BOOK_EDIT_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      const openBook = async () => {
        await page.goto(running.server.url);
        await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
        await page.locator('.outline-book-line__open').click({ timeout: 30000 });
        await page.locator('.book-bar').waitFor({ timeout: 30000 });
      };
      // 编辑 opens from 更多 and 完成 · 回到阅读 comes back (at the same point).
      const mode = async name => {
        if (name === '原文') {
          await page.locator('.book-bar__more').click();
          await page.getByRole('menuitem', { name: '编辑这一节…' }).click();
          await page.locator('.book-editor').waitFor();
        } else {
          await page.locator('.book-mode__done').click();
          await page.locator('[data-book-point]').first().waitFor();
        }
      };
      const pickFile = async label => {
        await page.locator('.book-editor__file').click();
        await page.locator('[role="option"]', { hasText: label }).first().click();
        await page.locator('.book-editor__file', { hasText: label }).waitFor();
      };
      await openBook();
      await page.locator('[data-book-point]').first().waitFor();
      assert.equal(await page.locator('.book-editor').count(), 0, `${width}px: the book never opens in the editor`);

      // 编辑这一节: the editor opens on the explanation of the point being read (1.1), edited and saved; it is 已改动 from then on.
      await mode('原文');
      await page.locator('.book-editor__file', { hasText: '1.1 What architects do · 讲解（生成）' }).waitFor();
      assert.match(await page.locator('.book-mode__title').innerText(), /1\.1 What architects do/);
      if (width === 1280) {
        // Unsaved text: 完成 asks first; 继续编辑 keeps it, 丢掉改动，离开 goes back to the same point without saving.
        await page.locator('.cm-content').click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type('\n\nNot to be kept.');
        await page.locator('.book-mode__done').click();
        const ask = page.locator('.sh-confirm', { hasText: '还有没保存的改动' });
        await ask.waitFor();
        await ask.getByRole('button', { name: '继续编辑' }).click();
        await ask.waitFor({ state: 'detached' });
        assert.match(await page.locator('.cm-content').innerText(), /Not to be kept\./, 'the edit is still there');
        await page.locator('.book-mode__done').click();
        await page.locator('.sh-confirm', { hasText: '还有没保存的改动' }).getByRole('button', { name: '丢掉改动，离开' }).click();
        await page.locator('.book-step__heading', { hasText: 'What architects do' }).waitFor();
        assert.equal(await page.locator('.book-file', { hasText: 'Not to be kept.' }).count(), 0, 'nothing was saved');
        await mode('原文');
      }
      assert.match(await page.locator('.book-editor__note').innerText(), /改了之后它就归你/);
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(`\n\nMy addition at ${width}.`);
      await page.locator('.book-editor__save').click();
      await page.locator('.book-editor__forked').waitFor({ timeout: 30000 });
      let overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px 原文: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `edit-source-${width}.png`) });
      await mode('预览');
      await page.locator('.book-file', { hasText: `My addition at ${width}.` }).waitFor();
      assert.match(await page.locator('.book-suggestion__forked').first().innerText(), /已改动/);

      // A heading typed in the own file gets its id on save; the 目录 lists it and goes to it (the anchor is on the rendered heading).
      await mode('原文');
      await pickFile('1.1 What architects do · 我的笔记');
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(`\n\n## My heading ${width}\n\nUnder my heading.`);
      await page.locator('.book-editor__save').click();
      await page.waitForFunction(text => document.querySelector('.cm-content')?.innerText.includes(text), 'sh:id h', { timeout: 30000 });
      await mode('预览');
      if (width === 420) await page.locator('.book-bar__toc').click();
      await page.locator('.book-toc__go', { hasText: `My heading ${width}` }).click();
      const typed = page.locator('.book-file--mine .md-heading', { hasText: `My heading ${width}` });
      await typed.waitFor();
      assert.match(await typed.getAttribute('id'), /^book-h\d+$/, `${width}px: a typed heading carries its id`);
      await page.waitForTimeout(300);
      // At the top of the window, or as far as the page scrolls (a short book cannot bring its last heading higher).
      const place = await typed.evaluate(element => {
        const scroller = document.querySelector('.study-app'), top = Math.round(element.getBoundingClientRect().top);
        return { top, end: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2, height: window.innerHeight };
      });
      assert.ok(place.top >= 0 && place.top < place.height && (place.top < 300 || place.end), `${width}px: the 目录 brought the typed heading into view: ${JSON.stringify(place)}`);

      // A save that met another change (two saves from the same version, through the API): 书已更新 with 采用 / 忽略 in the preview.
      const conflict = async text => {
        const book = await running.api('course.book.open', {}), mine = book.nodes[0].children[1].files.mine, version = book.files[mine].version;
        await running.api('course.book.save', { file: mine, text: `${text} A`, version });
        const merged = await running.api('course.book.save', { file: mine, text: `${text} B`, version });
        assert.equal(merged.write, 'merged');
      };
      await conflict(`Server ${width}`);
      await openBook();
      // The learner's file of 1.2: the book opens where the learner was (1.1 here), 下一节 is 1.2.
      const toSecond = async () => { await page.locator('.book-step__next').click(); await page.locator('.book-step__heading', { hasText: 'Stakeholders' }).waitFor(); };
      assert.match(await page.locator('.book-step__heading').innerText(), /What architects do/);
      await toSecond();
      const suggestion = page.locator('.book-suggestion', { hasText: '书已更新' });
      await suggestion.waitFor({ timeout: 30000 });
      if (shots) await page.screenshot({ path: join(shots, `edit-suggestion-${width}.png`) });
      await suggestion.getByText('采用', { exact: true }).click();
      await page.locator('.book-file', { hasText: `Server ${width} A` }).waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.book-suggestion', { hasText: '书已更新' }).count(), 0);
      await conflict(`Again ${width}`);
      await openBook();
      // Opened again, the book is back at 1.2, where the learner was (kept in this browser).
      await page.locator('.book-step__heading', { hasText: 'Stakeholders' }).waitFor();
      await page.locator('.book-suggestion', { hasText: '书已更新' }).getByText('忽略', { exact: true }).click();
      await page.locator('.book-suggestion', { hasText: '书已更新' }).waitFor({ state: 'detached', timeout: 30000 });
      await page.locator('.book-file--mine', { hasText: `Again ${width} B` }).waitFor();
      overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px 预览: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      if (shots) await page.screenshot({ path: join(shots, `edit-preview-${width}.png`) });

      // 回退到上一版 takes the edit of the generated file back.
      await mode('原文');
      await pickFile('1.1 What architects do · 讲解（生成）');
      await page.locator('.book-editor__revert').click();
      await page.waitForFunction(text => !document.querySelector('.cm-content')?.innerText.includes(text), `My addition at ${width}.`, { timeout: 30000 });
      await mode('预览');
      await page.locator('[data-book-point]').first().waitFor();
      assert.equal(await page.locator('.book-file', { hasText: `My addition at ${width}.` }).count(), 0, `${width}px: the edit is taken back`);
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
