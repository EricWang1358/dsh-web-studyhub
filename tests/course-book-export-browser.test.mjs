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

/* 复习全书 M6 in the real page at 1280 and 420 px (docs/plans/review-book.md, docs/review-book.md "More"): 更多 › 速查页… shows the lookup made from the book
   in a dialog (按题型 from an answer card, 按概念, 易错点; the page has its own 目录), a code closes it and opens the book at its heading; the printed code is
   not beside the heading but in the 目录's hover and in 复制编号 (h7 · 1.1 Title · course); 更多 › 导出… shows the estimate of each choice, saves a page
   limit that the bar then compares quietly (one red line under it, only when over), and downloads one Markdown file that starts with the lookup; nothing
   scrolls sideways. Screenshots go to COURSE_BOOK_EXPORT_SHOTS. */

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
      assert.doesNotMatch(await page.locator('.book-step__heading').innerText(), /H\d+/, `${width}px: no printed code beside the heading`);
      const hidShown = await page.locator('.book-step').getAttribute('data-book-step');
      if (width === 1280) assert.equal(await page.locator('.book-toc__go[aria-current="location"]').count(), 1, `${width}px: the 目录 beside the text marks the point`);
      // 复制编号: the lowercase hid the book tools match, the number and title, the course.
      await page.evaluate(() => { window.copied = ''; navigator.clipboard.writeText = text => { window.copied = text; return Promise.resolve(); }; });
      await page.locator('.book-bar__more').click();
      await page.getByRole('menuitem', { name: /^复制编号/ }).click();
      await page.waitForFunction(() => window.copied, null, { timeout: 5000 });
      assert.equal(await page.evaluate(() => window.copied), `${hidShown.toLowerCase()} · 1.1 What architects do · ${COURSE}`, `${width}px: 复制编号`);

      // 速查页: the lookup of the book, in a dialog from 更多.
      await page.locator('.book-bar__more').click();
      await page.getByRole('menuitem', { name: '速查页…' }).click();
      await page.locator('dialog .book-lookup').waitFor({ timeout: 30000 });
      const text = await page.locator('.book-lookup').innerText();
      for (const part of ['按题型', '可用性', '检查顺序 · 公式', '按概念', '决策日志', '易错点（按知识点）', '易错：把串联的可用性相加']) assert.ok(text.includes(part), `${width}px: 速查页 shows ${part}`);
      assert.equal(await page.locator('#book-lookup-toc').count(), 0, `${width}px: without its own 目录 (the page has one)`);
      assert.doesNotMatch(text, /只给自己看/, 'the lookup lists terms, not the noprint text');
      let overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways in 查找: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `lookup-${width}.png`), fullPage: true });
      // A code closes the dialog and goes to its heading on the reading surface.
      const code = page.locator('.book-lookup__concepts .book-lookup__code').first(), hid = await code.getAttribute('data-book-code');
      await code.click();
      await page.locator('dialog .book-lookup').waitFor({ state: 'detached', timeout: 30000 });
      await page.locator(`#book-${hid}`).waitFor({ timeout: 30000 });
      await page.waitForTimeout(300);
      const top = await page.evaluate(id => Math.round(document.getElementById(`book-${id}`).getBoundingClientRect().top), hid);
      assert.ok(top >= 0 && top < 400, `${width}px: the code brought its heading on screen: ${top}`);

      // 导出: the estimate of each choice (its item names the pages), the page limit, the download.
      assert.equal(await page.locator('.book-bar-limit').count(), 0, `${width}px: no limit, no line under the bar (nothing reserved for it)`);
      // Where the bar's buttons and the place are before any limit (the line that comes later moves none of them and squeezes nothing).
      const barBefore = await page.evaluate(() => ({ buttons: [...document.querySelectorAll('.book-bar__row > :not(.book-bar__where-tip)')].map(item => Math.round(item.getBoundingClientRect().left)),
        where: Math.round(document.querySelector('.book-bar__where').getBoundingClientRect().width), height: Math.round(document.querySelector('.book-bar').getBoundingClientRect().height) }));
      await page.locator('.book-bar__more').click();
      assert.match(await page.getByRole('menuitem', { name: /^导出…/ }).innerText(), /约 \d+ 页/);
      await page.getByRole('menuitem', { name: /^导出…/ }).click();
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
      assert.match(await dialog.locator('.book-export__pages').innerText(), /比上限多 \d+ 页/, `${width}px: over a limit of one page`);
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
      // The dialog's sections keep their gap.
      assert.equal(await dialog.locator('.book-export__body').evaluate(element => window.getComputedStyle(element).display), 'grid', `${width}px: the sections are laid out`);
      assert.ok(parseFloat(await dialog.locator('.book-export__body').evaluate(element => window.getComputedStyle(element).rowGap)) > 0, `${width}px: and do not touch`);
      // The files of the folder come as one .zip: book.yaml first, then the book's files, in one press.
      const zipped = page.waitForEvent('download');
      await dialog.locator('.book-export__zip').click();
      const archive = await zipped;
      assert.equal(archive.suggestedFilename(), '复习全书-SA-含答案册.zip');
      const bytes = await readFile(await archive.path());
      assert.equal(bytes.readUInt32LE(0), 0x04034b50, `${width}px: a zip`);
      assert.equal(bytes.toString('utf8', 30, 39), 'book.yaml', `${width}px: its first file names the order`);
      assert.ok(bytes.readUInt16LE(bytes.length - 12) >= 4, `${width}px: the folder's files are all in it`);
      if (shots) await page.screenshot({ path: join(shots, `export-files-${width}.png`) });
      // The focus stayed on the button (a busy button is disabled and drops it, and then Esc reaches nothing): Esc hides its tooltip, as any tooltip's, and the next one closes the dialog.
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached', timeout: 10000 });
      // Over the limit: one quiet line under the bar (the estimate and how far over; its Tooltip says where to change the limit). It is not in the bar: the
      // buttons stay where they were, the place keeps its room, and it covers nothing (the way back, the point's path and heading, the 目录).
      await page.locator('.book-bar-limit').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.book-bar-limit').innerText(), /^导出约 \d+ 页，超过 \d+ 页的上限$/);
      assert.equal(await page.locator('.book-bar .book-bar-limit').count(), 0, `${width}px: not inside the sticky bar`);
      const cover = await page.evaluate(() => {
        const box = element => element && element.getBoundingClientRect();
        const meets = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const notice = box(document.querySelector('.book-bar-limit')), bar = box(document.querySelector('.book-bar'));
        return { under: notice.top >= bar.bottom - 0.5, back: meets(notice, box(document.querySelector('.book-header'))), path: meets(notice, box(document.querySelector('.book-step__path'))),
          toc: meets(notice, box(document.querySelector('.book-toc'))), heading: meets(notice, box(document.querySelector('.book-step__heading'))),
          buttons: [...document.querySelectorAll('.book-bar__row > :not(.book-bar__where-tip)')].map(item => Math.round(item.getBoundingClientRect().left)),
          where: Math.round(document.querySelector('.book-bar__where').getBoundingClientRect().width), height: Math.round(bar.height) };
      });
      assert.ok(cover.under && !cover.back && !cover.path && !cover.toc && !cover.heading, `${width}px: the line is under the bar and covers nothing: ${JSON.stringify(cover)}`);
      assert.deepEqual({ buttons: cover.buttons, where: cover.where, height: cover.height }, barBefore, `${width}px: no button of the bar moved and the place kept its room`);
      await page.locator('.book-bar-limit__text').focus();
      await page.getByRole('tooltip').filter({ hasText: /上限是 1 页：在「导出…」里改，留空就是不限。/ }).waitFor({ timeout: 10000 });
      await page.locator('.book-bar-limit__text').blur();
      await page.locator('.book-bar__more').click();
      assert.match(await page.getByRole('menuitem', { name: /^导出…/ }).innerText(), /约 \d+ 页 \/ 上限 1 页/);
      await page.keyboard.press('Escape');
      overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways with the line under the bar: ${JSON.stringify(overflow)}`);
      if (shots) await page.screenshot({ path: join(shots, `header-${width}.png`) });
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
