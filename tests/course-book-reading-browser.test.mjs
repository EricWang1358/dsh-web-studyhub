/* global window document localStorage */
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
import { openCourseBook } from '../lib/course-book-files.js';
import { aiBlock } from '../lib/course-book-ai-text.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* 复习全书 reading in the real page at 1280 and 420 px (docs/review-book.md "Reading modes", "Reading a point"): 逐节读 by default, one point under its
   path; 下一节 / 上一节 and ← / → go point by point and the window starts at its top; the 目录 marks it; the toolbar row is at the top right (练 5 道,
   本节问答, 整理), a point without questions says 暂无题 with 出题; the takeaway comes first; the learner's layer starts folded (three items), its long
   whole-point block says it repeats the 讲解 with 收起 (the fold remembered); 整理 › 只留我写的 hides it and 全部显示 brings it back; 整章滚动 folds the other
   points and is remembered; a formula is drawn once; nothing scrolls sideways. Screenshots (dark and light) go to COURSE_BOOK_READING_SHOTS when set. */

const explainOf = title => [`${title} is the part of the work an architect owns from the first day.`, ...Array.from({ length: 4 }, (_, i) =>
  `Paragraph ${i + 1}: an architect writes down each decision about ${title} and the reasons for it, so the team can see later why the system is shaped as it is.`),
'Its cost grows with the system: $C = n^2$ for $n$ parts [^1].'].join('\n\n');

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
      nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture(1)}#0`] }, { id: 'who', title: 'Stakeholders and concerns', anchors: [`${lecture(1)}#1`] },
        { id: 'views', title: 'Views and viewpoints', anchors: [`${lecture(1)}#2`] }] },
      { id: 'c2', title: 'Requirements', children: [{ id: 'fr', title: 'Functional requirements', anchors: [`${lecture(2)}#0`] },
        { id: 'qa', title: 'Quality attribute scenarios with a rather long title that has to wrap on a phone', anchors: [`${lecture(2)}#1`] }, { id: 'none', title: 'A point without questions', anchors: [] }] }],
      other: { anchors: [] }, counts: { units: 6, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const page = state.sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes.flatMap(node => node.children);
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
      body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} in one line [^1].`, 'A second key point.', 'A third key point.'], explain: explainOf(leaf.title),
        example: `A team that skips ${leaf.title} rebuilds the same part twice.`, extra: ['Beyond the materials: an industry habit.'],
        cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }), createdAt: '2026-10-09T01:00:00.000Z' });
    openCourseBook(state, {});
    // The first point's own file: a note, a long whole-point block that restates the notes (as a bulk 「here」 request writes it), one about some words.
    const record = state.sources.find(source => source.provenance === 'course-book-doc');
    const restated = explainOf('What architects do').split('\n\n').map(line => `原文说：${line}\n\n意思就是：${line}`).join('\n\n');
    record.bookDoc.files['what.mine.md'].text = ['My own note about the decision log.', '',
      aiBlock({ id: 'here1', at: 'h:any', about: 'What architects do', body: restated, mode: 'here' }, 'zh'), '',
      aiBlock({ id: 'words1', at: 'x', about: 'the reasons for it', body: 'Why the reasons matter: a later reader needs them.', mode: 'explain', state: 'kept' }, 'zh')].join('\n');
  });
  await service.dispose();
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.book-page *, .sh-menu *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});
const flat = (page, width, what) => sideways(page).then(overflow => assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px ${what}: nothing scrolls sideways: ${JSON.stringify(overflow)}`));
const words = locator => locator.innerText().then(text => text.replace(/\s+/g, ' ').trim());
const stepOf = page => page.locator('.book-step').getAttribute('data-book-step');
const stepTop = page => page.locator('.book-step').evaluate(element => Math.round(element.getBoundingClientRect().top));

/** A screenshot of the whole page: the window as tall as what the app scrolls (the app scrolls inside .study-app), then back. */
const shoot = async (page, width, path) => {
  const height = await page.evaluate(() => { const app = document.querySelector('.study-app'); if (app) app.scrollTop = 0; return Math.min(6000, app?.scrollHeight ?? 900); });
  await page.setViewportSize({ width, height: Math.max(900, height) });
  await settleAnimations(page);
  await page.screenshot({ path });
  await page.setViewportSize({ width, height: 900 });
};

async function openBook(page, running) {
  await page.goto(running.server.url);
  await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
  await page.locator('.outline-book-line__open').click({ timeout: 30000 });
  await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
}

test('复习全书 reading: 逐节读 with 上一节 / 下一节 and the keys, the toolbar, the folded layer, the repeat hint, 整理, 整章滚动 (1280 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-reading-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_BOOK_READING_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await openBook(page, running);
      // 逐节读 by default: one point, its path, its place in the book.
      assert.equal(await page.locator('.book-step').count(), 1, `${width}px: 逐节读 is the default`);
      assert.equal(await page.locator('[data-book-point]').count(), 1, `${width}px: one point drawn`);
      const first = await stepOf(page);
      assert.match(await page.locator('.book-step__top').innerText(), /Introduction[\s\S]*第 1 \/ 6 节/);
      assert.match(await words(page.locator('.book-step__heading')), /1\.1 What architects do/);
      // The toolbar row: at the top right of the point, before its text.
      const bar = await page.evaluate(() => {
        const point = document.querySelector('.book-point').getBoundingClientRect(), actions = document.querySelector('.book-point__actions').getBoundingClientRect();
        const gist = document.querySelector('.book-point__takeaway').getBoundingClientRect();
        return { right: Math.round(point.right - actions.right), above: actions.bottom <= gist.top + 1 };
      });
      assert.ok(bar.right <= 2 && bar.above, `${width}px: the toolbar is at the top right: ${JSON.stringify(bar)}`);
      assert.match(await page.locator('.book-point__actions').innerText(), /练 5 道[\s\S]*本节问答[\s\S]*整理/);
      // The takeaway first, then 讲解 without it; 要点清单 and 补充 folded; 出处 one chip.
      assert.equal((await page.locator('.book-point__gist').innerText()).trim(), 'What architects do is the part of the work an architect owns from the first day.');
      assert.equal(await page.locator('.book-point__fold[open]').count(), 0, `${width}px: 要点清单 and 补充 start folded`);
      assert.equal((await page.locator('.book-point__cites-toggle').innerText()).trim(), '出处 1');
      if (shots) await shoot(page, width, join(shots, `reading-step-dark-${width}.png`));
      assert.equal(await page.locator('[data-book-link="source"]').count(), 0);
      await page.locator('.book-point__cites-toggle').click();
      await page.locator('[data-book-link="source"]').first().waitFor();
      // A formula is drawn once: MathML only, its TeX annotation not rendered.
      const math = await page.evaluate(() => [...document.querySelectorAll('.book-point .md-math')].map(element => ({ text: element.innerText.replace(/\s+/g, ''),
        hidden: [...element.querySelectorAll('annotation')].every(item => window.getComputedStyle(item).display === 'none') })));
      assert.deepEqual(math.map(item => item.hidden), [true, true], `${width}px: two formulas, each drawn once: ${JSON.stringify(math)}`);
      assert.ok(math.every(item => !/\\|\^/.test(item.text)), `${width}px: no TeX source in the visible text: ${JSON.stringify(math)}`);
      // The layer: three items, so its blocks start folded; the long whole-point block says it repeats the 讲解.
      assert.match(await page.locator('.book-layer__toggle').innerText(), /我的笔记与 AI 解释 \(3\)/);
      assert.equal(await page.locator('.book-layer__toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('.book-ai[data-ai-folded="true"]').count(), 2, `${width}px: both blocks folded`);
      const here = page.locator('.book-ai[data-ai-block="here1"]');
      assert.match(await here.locator('.book-ai__repeat').innerText(), /与上面的讲解重复度高/);
      await flat(page, width, '逐节读');
      await settleAnimations(page);
      // Opened, it offers 收起; an open block stays open after a reload, and 收起 is remembered too.
      await here.locator('.book-ai__toggle').click();
      await here.locator('.book-ai__body').waitFor();
      await page.reload();
      await openBook(page, running);
      await page.locator('.book-ai[data-ai-block="here1"] .book-ai__body').waitFor({ timeout: 10000 });
      if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `reading-repeat-dark-${width}.png`) }); }
      await page.locator('.book-ai[data-ai-block="here1"] .book-ai__repeat-fold').click();
      await page.locator('.book-ai[data-ai-block="here1"][data-ai-folded="true"]').waitFor({ timeout: 5000 });
      assert.match(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('study-book-ai-folded:')).map(([, value]) => value).join('')), /here1/);
      // 整理 › 只留我写的 hides the new whole-point block (counted), 全部显示 brings it back; 展开所有 / 收起所有 AI 块.
      // A menu closes when the page scrolls (ui/components/Menu.jsx), so its button is brought into view and left to settle before the press.
      const openTidy = async () => {
        await page.locator('.book-point__tidy-button').scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await page.locator('.book-point__tidy-button').click();
        await page.locator('.sh-menu').waitFor({ timeout: 5000 });
      };
      const tidy = async label => { await openTidy(); await page.locator('.sh-menu [role="menuitem"]', { hasText: label }).click(); };
      await openTidy();
      await flat(page, width, 'the 整理 menu');
      if (shots) await page.screenshot({ path: join(shots, `reading-tidy-dark-${width}.png`) });
      await page.keyboard.press('Escape');
      await tidy('只留我写的（隐藏 1 段）');
      await here.waitFor({ state: 'detached', timeout: 5000 });
      assert.match(await page.locator('.book-layer__hidden').innerText(), /已隐藏 1 段 AI 写的/);
      assert.match(await page.locator('.book-layer__toggle').innerText(), /\(2\)/);
      await page.locator('.book-layer__show').click();
      await here.waitFor({ timeout: 5000 });
      await tidy('展开所有 AI 块');
      assert.equal(await page.locator('.book-ai[data-ai-folded]').count(), 0, `${width}px: all open`);
      await tidy('收起所有 AI 块');
      assert.equal(await page.locator('.book-ai:not([data-ai-folded])').count(), 0, `${width}px: all folded`);

      // 下一节: the next point, the window at its top, the 目录 marks it.
      await page.locator('.book-step__next').scrollIntoViewIfNeeded();
      await page.locator('.book-step__next').click();
      await page.waitForFunction(id => document.querySelector('.book-step')?.dataset.bookStep !== id, first);
      const second = await stepOf(page);
      assert.match(await words(page.locator('.book-step__heading')), /1\.2 Stakeholders and concerns/);
      const top = await stepTop(page);
      assert.ok(top >= 0 && top < 220, `${width}px: the new point starts at the top: ${top}`);
      if (width === 420) await page.locator('.book-header__toc').click();
      assert.match(await page.locator('.book-toc__go[aria-current="location"]').innerText(), /Stakeholders and concerns/, `${width}px: the 目录 marks it`);
      if (width === 420) await page.locator('.book-header__toc').click();
      // ← / →.
      await page.locator('.book-step__heading').click();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(id => document.querySelector('.book-step')?.dataset.bookStep !== id, second);
      assert.match(await words(page.locator('.book-step__heading')), /1\.3 Views and viewpoints/);
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(id => document.querySelector('.book-step')?.dataset.bookStep === id, second);
      await page.locator('.book-step__back').click();
      await page.waitForFunction(id => document.querySelector('.book-step')?.dataset.bookStep === id, first);
      // The 目录 goes to any point: one without questions says 暂无题 and offers 出题 in its toolbar.
      if (width === 420) await page.locator('.book-header__toc').click();
      await page.locator('.book-toc__go', { hasText: 'A point without questions' }).click();
      await page.locator('.book-step__heading', { hasText: 'A point without questions' }).waitFor();
      assert.match(await page.locator('.book-point__actions').innerText(), /暂无题[\s\S]*出题[\s\S]*本节问答/);
      assert.equal(await page.locator('.book-point__practice').count(), 0);
      assert.doesNotMatch(await page.locator('.book-point').innerText(), /这一节还没有题/);
      assert.equal(await page.locator('.book-step__next').isDisabled(), true, `${width}px: the last point has no 下一节`);
      await flat(page, width, 'the last point');

      // 整章滚动: the chapters, the point being read open and the others folded to a line; remembered.
      await page.locator('.book-header__reading').getByText('整章滚动', { exact: true }).click();
      await page.locator('.book-chapter').first().waitFor();
      assert.equal(await page.locator('[data-book-point]').count(), 1, `${width}px: only the point being read is open`);
      assert.match(await page.locator('[data-book-point]').evaluate(element => element.closest('.book-node').querySelector('.book-node__heading').innerText), /A point without questions/);
      assert.ok(await page.locator('.book-node[data-book-folded] .book-node__summary').count() >= 2, `${width}px: the others are a title and a line`);
      await page.locator('.book-node__toggle', { hasText: 'Functional requirements' }).click();
      assert.equal(await page.locator('[data-book-point]').count(), 2);
      await flat(page, width, '整章滚动');
      await settleAnimations(page);
      if (shots) await shoot(page, width, join(shots, `reading-scroll-dark-${width}.png`));
      await page.reload();
      await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-book-line__open').click({ timeout: 30000 });
      await page.locator('.book-chapter').first().waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.book-step').count(), 0, `${width}px: 整章滚动 is remembered`);
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();

      // The same page in the light theme.
      if (shots) {
        const light = await openPage(browser, running, { width, height: 900, theme: 'light' });
        await openBook(light.page, running);
        await settleAnimations(light.page);
        await shoot(light.page, width, join(shots, `reading-step-light-${width}.png`));
        await light.context.close();
      }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
