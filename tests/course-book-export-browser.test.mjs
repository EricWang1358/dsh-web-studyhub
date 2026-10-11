/* global window document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
import { openCourseBook } from '../lib/course-book-files.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { answerCard } from './helpers/course-book-export-book.mjs';

/* 复习全书 M6 in the real page at 1280 and 420 px (docs/plans/review-book.md): 查找 shows the lookup made from the book (目录 with codes, 按题型 from an
   answer card, 按概念, 易错点), a code opens the book at its heading; 导出 shows the estimate of each choice, saves a page limit that the header then
   compares quietly, and downloads one Markdown file that starts with the lookup; nothing scrolls sideways. Screenshots go to COURSE_BOOK_EXPORT_SHOTS. */

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => {
    state.sources.push(...sources);
    state.decks.push(...decks);
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = key => groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes(`document-l${key}-p1`)).key;
    const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture(1)}#0`] }, { id: 'who', title: 'Stakeholders and concerns', anchors: [`${lecture(1)}#1`] }] },
        { id: 'c2', title: 'Requirements', children: [{ id: 'qa', title: 'Quality attribute scenarios with a rather long title that has to wrap on a phone', anchors: [`${lecture(2)}#1`] }] }],
      other: { anchors: [] }, counts: { units: 3, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const page = state.sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes.flatMap(node => node.children);
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
      body: { fingerprint: 'f'.repeat(16), points: [`**${leaf.title}**：${leaf.title} in one line [^1].`], explain: `About ${leaf.title} [^1].`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }),
      createdAt: '2026-10-09T01:00:00.000Z' });
    // A question of the first point has an answer card (its type goes into 按题型).
    state.decks.find(deck => deck.id === 'deck-l1').cards[0].answerCard = answerCard();
    openCourseBook(state, {});
    const record = state.sources.find(source => source.provenance === 'course-book-doc');
    record.bookDoc.files['what.mine.md'].text = '**决策日志**：记下每个架构决策和理由的文档，篇幅很长很长，好看出窄屏下会不会折行。\n\n<!-- sh:noprint -->\n只给自己看。\n<!-- /sh:noprint -->';
  });
  await service.dispose();
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.book-page *, .book-export *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});

test('复习全书: 查找 from the book, a code opens its heading; 导出 with the estimate, the page limit and the download (1280 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-export-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_BOOK_EXPORT_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: COURSE });
      await running.api('settings.book.set', { patch: { pageLimit: null } });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await page.goto(running.server.url);
      await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-tree--book').waitFor({ timeout: 30000 });
      await page.locator('.outline-book-line__open').click();
      await page.locator('.book-step').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.book-step__heading').innerText(), /H\d+/, `${width}px: a point shows its code`);

      // 查找: the lookup of the book.
      await page.locator('.book-header__mode').getByText('查找', { exact: true }).click();
      await page.locator('.book-lookup').waitFor({ timeout: 30000 });
      const text = await page.locator('.book-lookup').innerText();
      for (const part of ['目录', '按题型', '可用性', '检查顺序 · 公式', '按概念', '决策日志', '易错点（按知识点）', '易错：把串联的可用性相加']) assert.ok(text.includes(part), `${width}px: 查找 shows ${part}`);
      assert.doesNotMatch(text, /只给自己看/, 'the lookup lists terms, not the noprint text');
      let overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways in 查找: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `lookup-${width}.png`), fullPage: true });
      // A code goes to its heading in 预览.
      const code = page.locator('.book-lookup__concepts .book-lookup__code').first(), hid = await code.getAttribute('data-book-code');
      await code.click();
      await page.locator(`#book-${hid}`).waitFor({ timeout: 30000 });
      await page.waitForTimeout(300);
      const top = await page.evaluate(id => Math.round(document.getElementById(`book-${id}`).getBoundingClientRect().top), hid);
      assert.ok(top >= 0 && top < 400, `${width}px: the code brought its heading on screen: ${top}`);

      // 导出: the estimate of each choice, the page limit, the download.
      await page.locator('.book-header__export').click();
      const dialog = page.locator('.book-export');
      await dialog.locator('.book-export__pages').waitFor({ timeout: 30000 });
      assert.match(await dialog.locator('.book-export__pages').innerText(), /约 \d+ 页 A4/);
      assert.match(await dialog.locator('.book-export__key').innerText(), /不含答案册 · 约 \d+ 页[\s\S]*含答案册 · 约 \d+ 页/);
      // Only the linked questions by default; with every point's own questions the estimate grows.
      assert.equal(await dialog.locator('input[name="book-export-questions"][value="linked"]').isChecked(), true);
      const fewer = Number((await dialog.locator('.book-export__pages').innerText()).match(/约 (\d+) 页/)[1]);
      await dialog.getByText('再加每个知识点自己的题').click();
      await page.waitForFunction(n => { const found = document.querySelector('.book-export__pages')?.innerText.match(/约 (\d+) 页/); return found && Number(found[1]) > n; }, fewer, { timeout: 30000 });
      if (shots) await page.screenshot({ path: join(shots, `export-all-${width}.png`) });
      await dialog.getByText('只印书里链接的题').click();
      await page.waitForFunction(n => { const found = document.querySelector('.book-export__pages')?.innerText.match(/约 (\d+) 页/); return found && Number(found[1]) === n; }, fewer, { timeout: 30000 });
      await dialog.locator('input[type="number"]').fill('1');
      await dialog.locator('input[type="number"]').press('Enter');
      await dialog.locator('.book-export__pages .sh-badge').waitFor({ timeout: 30000 });
      assert.match(await dialog.locator('.book-export__pages').innerText(), /超出上限 \d+ 页/, `${width}px: over a limit of one page`);
      overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways in the dialog: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `export-${width}.png`) });
      await dialog.locator('.book-export__key').getByText(/^含答案册/).click();
      await page.waitForTimeout(500);
      const downloaded = page.waitForEvent('download');
      await dialog.getByRole('button', { name: '下载 Markdown' }).click();
      const file = await downloaded;
      assert.equal(file.suggestedFilename(), '复习全书-SA-含答案册.md');
      const saved = await readFile(await file.path(), 'utf8');
      assert.match(saved, /^# 复习全书 · SA \{#book\}\n\n## 查找 \{#lookup\}/);
      assert.match(saved, /## 答案册 \{#answers\}/);
      assert.doesNotMatch(saved, /<!--|studyhub:\/\/|只给自己看/);
      await dialog.getByRole('button', { name: '分文件导出…' }).click();
      await dialog.locator('.book-export__file', { hasText: 'book.yaml' }).waitFor({ timeout: 30000 });
      assert.ok(await dialog.locator('.book-export__file').count() >= 4, `${width}px: the folder's files`);
      if (shots) await page.screenshot({ path: join(shots, `export-files-${width}.png`) });
      await page.keyboard.press('Escape');
      // The header compares quietly once a limit is set.
      await page.locator('.book-header__budget').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.book-header__budget').innerText(), /导出约 \d+ 页 \/ 上限 1 页/);
      overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways with the header line: ${JSON.stringify(overflow)}`);
      if (shots) await page.screenshot({ path: join(shots, `header-${width}.png`) });
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
