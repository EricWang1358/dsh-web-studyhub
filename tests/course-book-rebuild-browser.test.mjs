/* global document, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { courseOutlineMaterial, currentCourseOutline, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* #461 from the page: an outline organised again over the learner's own notes shows where they would go before they move; 按这样放 applies it; the notice folds to one line that
   leads to the whole list; 撤销这次整理 takes that one rebuild back. Real page at 1280 and 420 px; BOOK_SHOTS=<folder> keeps a picture of each step. */

const moved = 'The first line of my own note on architects';

/** The outline `id`, archived by an undo, made current again from outside the page, as a finished build would. */
async function rebuildAgain(running, id) {
  const service = new StudyService(join(running.base, 'library'));
  await service.store.update(state => {
    currentCourseOutline(state.sources, COURSE).archived = true;
    const made = state.sources.find(source => source.id === id);
    made.archived = false;
  });
  await service.dispose();
}

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  const keyOf = id => groupSourcesByDocument(sources).find(item => item.sourceIds.includes(id)).key, lecture = keyOf('document-l1-p1'), other = keyOf('document-l3-p1');
  const outlineOf = (state, nodes, createdAt) => ({ ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes, other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt });
  const notesOf = (outlineId, leaves, createdAt, supersedes) => ({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId, language: 'zh', papers: [], counts: {}, ...(supersedes ? { supersedes } : {}),
    leaves: leaves.map(([id, title]) => ({ id, title, anchors: [`${lecture}#0`], body: { fingerprint: 'f'.repeat(16), points: [`${title} in one line.`], explain: `The explanation of ${title}.`, cites: [] } })) }), createdAt });
  let older;
  await service.store.update(state => {
    state.sources.push(...sources);
    state.decks.push(...decks);
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    const outline = outlineOf(state, [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] },
      { id: 'who', title: 'Stakeholders and views', anchors: [`${lecture}#1`, `${lecture}#2`] }] }], '2026-10-09T00:00:00.000Z');
    older = notesOf(outline.id, [['what', 'What architects do'], ['who', 'Stakeholders and views']], '2026-10-09T01:00:00.000Z');
    state.sources.push(outline, older);
  });
  const book = await service.call('course.book.open', { course: COURSE });
  const [what, who] = book.nodes[0].children;
  await service.call('course.book.save', { course: COURSE, file: what.files.mine, text: `${moved}.\n\nMore of it.`, version: book.files[what.files.mine].version });
  await service.call('course.book.save', { course: COURSE, file: who.files.mine, text: 'A long note on stakeholders and views.', version: book.files[who.files.mine].version });
  await service.store.update(state => {
    currentCourseOutline(state.sources, COURSE).archived = true;
    state.sources.find(source => source.id === older.id).archived = true;
    const rebuilt = outlineOf(state, [{ id: 'k1', title: 'Introduction', children: [{ id: 'k2', title: 'Databases state failure conditions', anchors: [`${lecture}#0`] },
      { id: 'k3', title: 'Networks', anchors: [`${lecture}@s2-2`, other] }] }], '2026-10-10T00:00:00.000Z');
    state.sources.push(rebuilt, notesOf(rebuilt.id, [['k2', 'Databases state failure conditions'], ['k3', 'Networks']], '2026-10-10T01:00:00.000Z', older.id));
  });
  await service.dispose();
}

test('a save that lands in a pending rebuild: the preview shows, and applying it leads to reading, not back into the editor', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-rebuild-edit-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  try {
    const { page, errors, context } = await openPage(browser, running, { width: 1280, height: 900 });
    try {
      // Book as it was: the rebuild of the seed taken back, so the page opens the book itself.
      await running.api('focus.set', { course: COURSE });
      const preview = await running.api('course.book.open', {});
      await running.api('course.book.rebuild', { action: 'undo', outlineId: preview.moves.outlineId });
      await page.goto(running.server.url);
      await page.locator('[data-tour="nav-book"]').first().click({ timeout: 30000 });
      await page.locator('.book-bar').waitFor({ timeout: 30000 });
      await page.locator('.book-bar__more').click();
      await page.getByRole('menuitem', { name: '编辑这个知识点…' }).click();
      await page.locator('.book-editor').waitFor({ timeout: 30000 });
      // The outline made again meanwhile: the rebuilt one, saved again, is current again (sources.ingest), while the editor stays open.
      const rebuiltId = preview.moves.outlineId;
      await rebuildAgain(running, rebuiltId);
      await page.locator('.book-editor .cm-content').click();
      await page.keyboard.type('Typed while it was rebuilt. ');
      await page.locator('.book-editor__save').click();
      await page.locator('[data-book-rebuild-preview]').waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: '按这样放' }).click();
      await page.locator('.book-bar').waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.book-editor').count(), 0, 'reading, not the editor');
      assert.equal(await page.locator('[data-book-rebuild-preview]').count(), 0);
      const book = await running.api('course.book.open', {});
      assert.match(JSON.stringify(book.nodes), /Typed while it was rebuilt\./);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  } finally {
    await running.close();
    await browser.close();
    await rm(dist, { recursive: true, force: true });
  }
});

test('复习全书: the moves are shown before they happen, can always be read again, and one rebuild can be undone (1280 and 420 px)', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-rebuild-dist-'));
  await buildPreview({ outdir: dist });
  const shots = process.env.BOOK_SHOTS;
  try {
    for (const width of [1280, 420]) {
      const running = await startLateServer({ distDir: dist, seed });
      try {
        await running.api('focus.set', { course: COURSE });
        const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
        const shot = async name => { if (shots) await page.screenshot({ path: join(shots, `${width}-${name}.png`) }); };
        const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        try {
          await page.goto(running.server.url);
          const before = await running.api('course.book.revision', {});
          // The real way in: the sidebar's 复习全书, which opens the book before it knows what is there.
          const entry = page.locator('[data-tour="nav-book"]').first();
          await entry.waitFor({ timeout: 30000 });
          await entry.click({ timeout: 5000 }).catch(() => entry.dispatchEvent('click'));
          await page.locator('[data-book-rebuild-preview]').waitFor({ timeout: 30000 });
          assert.equal((await running.api('course.book.revision', {})).revision, before.revision, 'opening the preview writes nothing');
          assert.match(await page.locator('[data-book-rebuild-preview]').innerText(), new RegExp(moved));
          assert.equal(await page.locator('[data-book-rebuild-preview] [title]').count(), 0);
          assert.ok(await sideways() <= 0, 'nothing runs sideways');
          await shot('1-preview');
          // Applied: the text under its new title, and the notice.
          await page.getByRole('button', { name: '按这样放' }).click();
          await page.locator('[data-book-moves]').waitFor({ timeout: 30000 });
          await shot('2-notice');
          await page.locator('[data-book-moves]').getByRole('button', { name: '知道了' }).click();
          await page.locator('[data-book-moves-line]').waitFor({ timeout: 30000 });
          await shot('3-line');
          // In the editor with unsaved text the undo is not offered: it would take away the file under the words being typed (#489).
          await page.locator('.book-bar__more').evaluate(element => element.click());
          await page.getByRole('menuitem', { name: /^编辑这个知识点/ }).click();
          await page.locator('.book-editor .cm-content').waitFor({ timeout: 30000 });
          await page.locator('.book-editor .cm-content').click();
          await page.keyboard.type('Unsaved words.');
          await page.locator('[data-book-moves-line]').getByRole('button', { name: '查看' }).click();
          await page.getByRole('dialog').waitFor({ timeout: 30000 });
          assert.equal(await page.getByRole('dialog').getByRole('button', { name: '撤销这次整理' }).count(), 0, 'no undo over unsaved text');
          await page.keyboard.press('Escape');
          await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 30000 });
          assert.match(await page.locator('.book-editor .cm-content').innerText(), /Unsaved words\./);
          await page.getByRole('button', { name: '放弃改动' }).click();
          await page.locator('.book-mode__done').click();
          await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
          await page.locator('[data-book-moves-line]').getByRole('button', { name: '查看' }).click();
          const dialog = page.getByRole('dialog');
          await dialog.waitFor({ timeout: 30000 });
          assert.match(await dialog.innerText(), new RegExp(moved));
          await shot('4-list');
          await dialog.getByRole('button', { name: '撤销这次整理' }).click();
          const asks = page.getByRole('dialog').filter({ hasText: '笔记和总纲都回到这次整理之前' }).last();
          await asks.waitFor({ timeout: 30000 });
          await shot('5-confirm');
          await asks.getByRole('button', { name: '撤销这次整理' }).click();
          await page.locator('[data-book-moves-line], [data-book-moves]').waitFor({ state: 'detached', timeout: 30000 });
          const back = await running.api('course.book.open', {});
          assert.deepEqual(back.nodes[0].children.map(point => point.title), ['What architects do', 'Stakeholders and views']);
          assert.match(back.nodes[0].children[0].mine, new RegExp(moved));
          assert.equal(back.unplaced.text.trim(), '');
          await shot('6-undone');
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      } finally { await running.close(); }
    }
  } finally {
    await browser.close();
    await rm(dist, { recursive: true, force: true });
  }
});
