import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { holdActions, openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* 复习全书 editor: 完成 · 回到阅读 pressed while a save is still running (#1040 polish). The click used to raise the unsaved-changes question, and the save finishing
   then cleared it with the editor still open. Now the click waits for the save: it leaves when the save worked, and asks (the text is still unsaved) when it did not. */

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

async function openEditor(browser, running, width) {
  const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
  await page.goto(running.server.url);
  await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
  await page.locator('.outline-book-line__open').click({ timeout: 30000 });
  await page.locator('.book-bar').waitFor({ timeout: 30000 });
  await page.locator('[data-book-point]').first().waitFor();
  await page.locator('.book-bar__more').click();
  await page.getByRole('menuitem', { name: '编辑这个知识点…' }).click();
  await page.locator('.book-editor').waitFor();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nSaved while leaving.');
  return { page, errors, context };
}

test('完成 · 回到阅读 during a save waits for it: leaves when the save worked, asks when it failed', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-done-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const ask = page => page.locator('.sh-confirm', { hasText: '还有没保存的改动' });
  try {
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: COURSE });
      // The save is held at the network edge; 完成 is pressed meanwhile; the save then works.
      let opened = await openEditor(browser, running, width);
      let page = opened.page;
      const held = await holdActions(page, ['course.book.save']);
      await page.locator('.book-editor__save').click();
      for (let tries = 0; tries < 200 && !held.seen('course.book.save'); tries += 1) await page.waitForTimeout(25);
      assert.equal(held.seen('course.book.save'), true, `${width}px: the save is in flight`);
      await page.locator('.book-mode__done').click();
      await page.waitForTimeout(300);
      assert.equal(await ask(page).count(), 0, `${width}px: no question while the save is running`);
      assert.equal(await page.locator('.book-editor').count(), 1, `${width}px: still in the editor until the save is done`);
      held.release('course.book.save');
      await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.book-editor').count(), 0, `${width}px: the editor is gone after the save`);
      assert.equal(await ask(page).count(), 0, `${width}px: nothing was asked`);
      assert.match(await page.locator('.book-file', { hasText: 'Saved while leaving.' }).first().innerText(), /Saved while leaving\./, `${width}px: the text was saved`);
      assert.deepEqual(opened.errors, [], `${width}px: no page errors`);
      await opened.context.close();

      // The save fails: the text is still unsaved, so 完成 asks, and the editor stays.
      opened = await openEditor(browser, running, width);
      page = opened.page;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/call', async route => {
        let action = '';
        try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
        if (action !== 'course.book.save') return route.continue();
        await gate;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'Disk is busy' } }) });
      });
      await page.locator('.book-editor__save').click();
      await page.waitForTimeout(300);
      await page.locator('.book-mode__done').click();
      await page.waitForTimeout(300);
      assert.equal(await ask(page).count(), 0, `${width}px: no question while the failing save is running`);
      release();
      await ask(page).waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.book-editor').count(), 1, `${width}px: the editor stays after a failed save`);
      assert.match(await page.locator('.cm-content').innerText(), /Saved while leaving\./, `${width}px: the text is still there`);
      await ask(page).getByRole('button', { name: '继续编辑' }).click();
      await opened.context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
