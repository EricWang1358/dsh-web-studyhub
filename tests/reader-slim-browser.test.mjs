/* global document window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { until } from './helpers/wait.mjs';

/* The slim reader (owner decision 2026-11-06: too many features, too much text). A 60-page book of three chapters, two questions that were answered wrong (one in
   chapter 1, one in chapter 3), seeded through the real store, fake model, no key. In the real page at 1280 and 420 px:
     the toolbar holds 目录, AI 出题 and the arrow of 做这几页的题, 错题, 思维导图 and 更多, and no paragraph of explanation;
     更多 holds the views, find (Ctrl/⌘ F still works), display settings (翻译… joins them for a material the host can translate: a legacy fixture cannot), the study tools, the AI outline, rename and what the dialog adds;
     错题 lists this chapter's mistake first and the rest of the book after it, 看原文 changes chapter and lands on the page, 去练 starts the practice;
     思维导图 draws the current chapter from its headings, folds a branch, jumps to a heading, and hands the tree to the main chat.
   Pictures go to READER_SLIM_SHOTS when set. */

const at = '2026-11-01T08:00:00.000Z';
const PAGES = 60, PER_CHAPTER = 20;
const chapterOf = page => Math.floor((page - 1) / PER_CHAPTER);
const heading = page => (page - 1) % PER_CHAPTER === 0 ? `${chapterOf(page) + 1} Topic of chapter ${chapterOf(page) + 1}` : `${chapterOf(page) + 1}.${(page - 1) % PER_CHAPTER} Heading of page ${page}`;
const pageText = page => [heading(page), `Paragraph one of page ${page} explains the multiplier.`, `Paragraph two of page ${page} explains crowding out.`].join('\n\n');
const source = page => ({ id: `macro-p${page}`, title: `Macro book · p.${page}`, text: pageText(page), createdAt: at, courses: ['宏经'],
  document: { id: 'macro-book-hash', materialId: 'document-macro-book', page, totalPages: PAGES, format: 'pdf', origin: 'converted', converter: 'mineru', filename: 'macro-book.pdf',
    extractionVersion: 2, chapter: { index: chapterOf(page), title: `Chapter ${chapterOf(page) + 1}`, level: 1 } } });
const card = (id, page) => ({ id, kind: 'flashcard', topic: 'Output', objective: `Objective ${id}`, prompt: `Question about page ${page}`, answer: 'The multiplier.',
  hint: 'Think.', explanation: 'See the book.', misconception: 'None.', citations: [{ sourceId: `macro-p${page}`, quote: `Paragraph two of page ${page} explains crowding out.` }] });
const WRONG_IN_CHAPTER = 5, WRONG_ELSEWHERE = 45;

const seed = async root => {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push(...Array.from({ length: PAGES }, (_, index) => source(index + 1)));
    state.decks.push({ id: 'macro-deck', title: 'Macro deck', course: '宏经', cards: [card('wrong-here', WRONG_IN_CHAPTER), card('wrong-there', WRONG_ELSEWHERE), card('fine', 6)] });
    state.attempts = ['wrong-here', 'wrong-there'].map((id, index) => ({ id: `wrong-${index}`, runId: 'seed-run', quiz_id: id, deckId: 'macro-deck', topic: 'Output', timestamp: at, grade: 1, elapsed_ms: 3000,
      before: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null }, after: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null } }));
  });
  await service.dispose();
};

const drawnPages = page => page.evaluate(() => [...document.querySelectorAll('.study-document-viewer .reader-section[data-study-page]')].map(node => Number(node.dataset.studyPage)));
const pageInView = (page, n) => page.evaluate(n => {
  const node = document.querySelector(`.study-document-viewer [data-study-page="${n}"]`), area = document.querySelector('.study-document-viewer .reader-scroll')?.getBoundingClientRect();
  if (!node || !area) return false;
  const rect = node.getBoundingClientRect();
  return rect.top < area.top + area.height / 2 && rect.bottom > area.top;
}, n);
const toolbarNames = viewer => viewer.locator('.reader-toolbar button').evaluateAll(nodes => nodes.map(node => (node.getAttribute('aria-label') || node.textContent || '').trim()));

test('the slim reader: a quiet toolbar, 更多, 错题 and 思维导图 at 1280 and 420 px', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-reader-slim-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await buildPreview({ outdir: dist });
  const shots = process.env.READER_SLIM_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const width of [1280, 420]) {
    const running = await startLateServer({ distDir: dist, seed });
    try {
      const { page, errors } = await openPage(browser, running, { width, height: 900 });
      const shot = async name => { if (shots) await page.screenshot({ path: join(shots, `reader-slim-${name}-${width}.png`) }); };
      const viewer = page.locator('.study-document-viewer');
      const openMore = async () => { await viewer.getByRole('button', { name: '更多', exact: true }).click(); await page.locator('.sh-menu').waitFor(); };
      const choose = async name => { await openMore(); await page.locator('.sh-menu [role^="menuitem"]', { hasText: name }).first().click(); };
      await page.goto(running.server.url);
      await (await revealNavRow(page, 'sources')).dispatchEvent('click');
      const row = page.locator('.source-doc', { hasText: 'macro-book' }).first();
      await row.waitFor({ timeout: 60000 });
      await row.locator('.source-main').click();
      await viewer.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 60000 });
      await until(async () => (await drawnPages(page)).length === PER_CHAPTER, 'the first chapter', { timeoutMs: 30000 });
      // the loop (the questions of the book, the coverage) arrives a moment after the text
      await until(async () => (await toolbarNames(viewer)).includes('错题') && await viewer.getByRole('button', { name: '错题', exact: true }).isEnabled(), 'the 错题 button to be ready', { timeoutMs: 30000 });

      // ---- the toolbar: three actions, the arrow of 做这几页的题, 目录 and 更多; no explanation text ----
      const names = await toolbarNames(viewer);
      assert.deepEqual(names, ['目录', 'AI 出题', '做这几页的题', '错题', '思维导图', '更多'], `${width}px: the always-visible controls`);
      for (const gone of ['在文中查找', '显示设置', '学习工具', '翻译', '阅读', '原文', '原始 PDF', '下载原文件']) assert.ok(!names.includes(gone), `${width}px: ${gone} is not on the toolbar`);
      assert.equal(await page.locator('.reader-pdf-note, [data-tour="reader-original-notice"], .original-notice').count(), 0, 'no notice about the missing original file above the text');
      const textOfBar = (await viewer.locator('.reader-toolbar').innerText()).replace(/\s+/g, ' ').trim();
      t.diagnostic(`${width}px toolbar text: ${textOfBar}`);
      const bar = await viewer.locator('.reader-toolbar').evaluate(node => { const box = node.getBoundingClientRect(), rows = new Set([...node.querySelectorAll('button')].map(button => { const rect = button.getBoundingClientRect(); return Math.round((rect.top + rect.height / 2) / 8); })); return { height: Math.round(box.height), rows: rows.size, overflow: node.scrollWidth > node.clientWidth + 1 }; });
      assert.equal(bar.rows, 1, `${width}px: the toolbar is one row`);
      assert.equal(bar.overflow, false, `${width}px: nothing runs out of the toolbar`);
      await shot('top');

      // ---- 更多: what it holds, and Ctrl+F still finds ----
      await openMore();
      const items = await page.locator('.sh-menu [role^="menuitem"]').allInnerTexts();
      for (const word of ['阅读', '原文', '原始 PDF', '在文中查找', '显示设置…', '学习工具', '掌握度与覆盖', 'AI 整理目录…', '重命名…']) assert.ok(items.some(item => item.startsWith(word)), `${width}px: 更多 holds ${word} (${JSON.stringify(items)})`);
      assert.ok(items.some(item => /原始 PDF\s+没有原文件/.test(item)), 'the original PDF item says there is no original file');
      await shot('more');
      await page.keyboard.press('Escape');
      await page.locator('.sh-menu').waitFor({ state: 'detached' });
      await viewer.locator('.reader-scroll').focus();
      await page.keyboard.press('Control+f');
      await page.getByRole('searchbox', { name: '在文中查找' }).waitFor();
      await page.keyboard.press('Escape');
      await choose('在文中查找');
      await page.getByRole('searchbox', { name: '在文中查找' }).waitFor();
      await page.keyboard.press('Escape');
      await choose('显示设置…');
      await page.getByRole('dialog', { name: '显示设置' }).waitFor();
      // (Escape closes a dialog and the reader under it together, as it always did for 补全原文件: the close button leaves the reader)
      await page.getByRole('dialog', { name: '显示设置' }).getByRole('button', { name: '关闭' }).click();
      await page.getByRole('dialog', { name: '显示设置' }).waitFor({ state: 'detached' });
      assert.equal(await viewer.count(), 1, 'closing the display settings leaves the reader open');
      const tools = viewer.locator('[data-tour="source-tools"]');
      const toolsWere = await tools.isVisible();
      await choose('学习工具');
      await tools.waitFor({ state: toolsWere ? 'hidden' : 'visible' });
      await openMore();
      assert.equal(await page.locator('.sh-menu [role="menuitemcheckbox"]', { hasText: '学习工具' }).getAttribute('aria-checked'), String(!toolsWere), 'the item shows whether the panel is open');
      await page.keyboard.press('Escape');
      await shot('tools');
      await choose('学习工具');
      await tools.waitFor({ state: toolsWere ? 'visible' : 'hidden' });
      await choose('原始 PDF');
      const attach = page.locator('dialog.original-dialog');
      await attach.waitFor();
      await attach.getByRole('button', { name: '关闭' }).click();
      await attach.waitFor({ state: 'detached' });

      // ---- 错题: this chapter's first, the rest of the book after; 看原文 changes chapter; 去练 starts the practice ----
      await viewer.getByRole('button', { name: '错题', exact: true }).click();
      const panel = page.locator('.reader-wrong__panel');
      await panel.locator('.reader-wrong__row').first().waitFor();
      const headings = await panel.locator('.reader-wrong__heading').allInnerTexts();
      assert.equal(headings.length, 2, `${width}px: two groups`);
      assert.match(headings[0], /Chapter 1/, 'the current chapter first');
      assert.match(headings[1], /书的其余部分/);
      const rows = await panel.locator('.reader-wrong__row').allInnerTexts();
      assert.equal(rows.length, 2);
      assert.match(rows[0], new RegExp(`Question about page ${WRONG_IN_CHAPTER}\\b`));
      assert.match(rows[1], new RegExp(`Question about page ${WRONG_ELSEWHERE}\\b`));
      await shot('wrong');
      await panel.locator('.reader-wrong__row').nth(1).getByRole('button', { name: '看原文' }).click();
      await until(async () => (await drawnPages(page)).includes(WRONG_ELSEWHERE), 'the chapter of the other mistake', { timeoutMs: 30000 });
      await until(() => pageInView(page, WRONG_ELSEWHERE), `page ${WRONG_ELSEWHERE} in view`, { timeoutMs: 15000 });
      assert.equal(await page.locator('.reader-wrong__panel').count(), 0, 'the panel closes after a jump');

      // ---- 思维导图 of the chapter that is drawn: its headings as a tree, a fold, a jump, the hand-off ----
      await viewer.getByRole('button', { name: '思维导图', exact: true }).click();
      const map = page.locator('.reader-map__panel');
      await map.locator('.reader-map__root').waitFor();
      assert.equal((await map.locator('.reader-map__root').innerText()).trim(), 'Chapter 3', 'the root is the chapter that is drawn');
      const top = map.locator('.reader-map__body > .reader-map__list > .reader-map__item');
      assert.equal(await top.count(), 1, 'one chapter heading at the top of the tree');
      assert.match(await top.first().locator('.reader-map__node').first().innerText(), /3 Topic of chapter 3/);
      assert.equal(await map.locator('.reader-map__node').count(), PER_CHAPTER, 'a node for every heading of the chapter');
      const mapBox = await map.evaluate(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: window.innerWidth }; });
      assert.ok(mapBox.left >= 0 && mapBox.right <= mapBox.width, `${width}px: the panel stays in the window`);
      await shot('map');
      await map.getByRole('button', { name: /^收起 3 Topic/ }).click();
      assert.equal(await map.locator('.reader-map__node').count(), 1, 'folding the chapter heading hides its sections');
      await map.getByRole('button', { name: /^展开 3 Topic/ }).click();
      await map.getByRole('button', { name: `3.${(55 - 1) % PER_CHAPTER} Heading of page 55`, exact: true }).click();
      assert.equal(await page.locator('.reader-map__panel').count(), 0, 'the panel closes after a jump');
      await until(() => pageInView(page, 55), 'page 55 in view', { timeoutMs: 15000 });
      await viewer.getByRole('button', { name: '思维导图', exact: true }).click();
      await page.locator('.reader-map__panel').getByRole('button', { name: '交给主会话细化' }).click();
      await until(async () => { const said = await page.locator('body').innerText(); return /已复制到剪贴板|需要手动复制|已填进|细化资料/.test(said); }, 'the hand-off to say what became of it', { timeoutMs: 15000 });
      await page.keyboard.press('Escape');

      // ---- 去练 on the mistake of the chapter that is drawn ----
      await viewer.getByRole('button', { name: '错题', exact: true }).click();
      await page.locator('.reader-wrong__panel .reader-wrong__row').first().getByRole('button', { name: '去练' }).click();
      await until(async () => !(await viewer.count()), 'the practice to take over from the reader', { timeoutMs: 20000 });
      // the chapter that is drawn is chapter 3 now, so its mistake is the first row: the run is that question, with the way back to the reading
      await page.getByText(`Question about page ${WRONG_ELSEWHERE}`, { exact: false }).first().waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: '回到原文' }).first().waitFor();
      if (shots) await page.screenshot({ path: join(shots, `reader-slim-practice-${width}.png`) });
      assert.deepEqual(errors.filter(error => !/Failed to load resource/.test(error)), [], `${width}px: no page error`);
    } finally { await running.close(); }
  }
});
