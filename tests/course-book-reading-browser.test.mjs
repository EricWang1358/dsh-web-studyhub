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
   本节问答, 发给主会话), a point without questions has a quiet 出题; the takeaway comes first; 我的 is a label, its long whole-point block starts folded as one
   row (AI, its first real sentence, its size, 多为重复; the fold remembered), a short one about words is open right after its paragraph, 全部收起 / 全部展开 fold
   them all; 整章滚动 folds the other points and is remembered; a formula is drawn once; nothing scrolls sideways. Screenshots (dark and light) go to
   COURSE_BOOK_READING_SHOTS when set. */

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

test('复习全书 reading: 逐节读 with 上一节 / 下一节 and the keys, the toolbar, 我的, the folded AI row, 全部收起, 整章滚动 (1280 and 420 px)', { timeout: 420000 }, async (t) => {
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
        const gist = document.querySelector('.book-point__gist').getBoundingClientRect();
        return { right: Math.round(point.right - actions.right), above: actions.bottom <= gist.top + 1 };
      });
      assert.ok(bar.right <= 2 && bar.above, `${width}px: the toolbar is at the top right: ${JSON.stringify(bar)}`);
      assert.match(await page.locator('.book-point__actions').innerText(), /^练 5 道[\s\S]*本节问答[\s\S]*发给主会话$/);
      assert.equal(await page.locator('.book-point__tidy-button').count(), 0, `${width}px: no 整理 menu`);
      // The takeaway first, then 讲解 without it; 要点清单 and 补充 folded; 出处 one chip.
      assert.equal((await page.locator('.book-point__gist').innerText()).trim(), 'What architects do is the part of the work an architect owns from the first day.');
      assert.equal(await page.locator('.book-point__fold[open]').count(), 0, `${width}px: 要点清单 and 补充 start folded`);
      assert.equal((await page.locator('.book-point__cites-toggle').innerText()).trim(), '出处 1');
      if (shots) await shoot(page, width, join(shots, `reading-step-dark-${width}.png`));
      assert.equal(await page.locator('[data-book-link="source"]').count(), 0);
      await page.locator('.book-point__cites-toggle').click();
      await page.locator('[data-book-link="source"]').first().waitFor();
      // Ink, not cinnabar, inside the point: the 出处 entries are the text colour, a 角标 the dim ink (underlined only on hover), the global link colour untouched elsewhere.
      const ink = await page.evaluate(() => {
        const colour = value => { const probe = document.createElement('i'); probe.style.color = value; document.querySelector('.book-point').append(probe); const out = window.getComputedStyle(probe).color; probe.remove(); return out; };
        const style = element => window.getComputedStyle(element);
        const mark = document.querySelector('.book-point .md-cite__mark'), source = document.querySelector('.book-point [data-book-link="source"]');
        return { text: colour('var(--text)'), dim: colour('var(--text-dim)'), accent: colour('var(--accent-text)'), source: style(source).color, mark: style(mark).color, markLine: style(mark).textDecorationLine };
      });
      assert.equal(ink.source, ink.text, `${width}px: a 出处 entry is ink: ${JSON.stringify(ink)}`);
      assert.equal(ink.mark, ink.dim, `${width}px: a 角标 is dim ink: ${JSON.stringify(ink)}`);
      assert.equal(ink.markLine, 'none', `${width}px: and not underlined at rest`);
      assert.notEqual(ink.source, ink.accent, `${width}px: not cinnabar`);
      // A formula is drawn once: MathML only, its TeX annotation not rendered.
      const math = await page.evaluate(() => [...document.querySelectorAll('.book-point .md-math')].map(element => ({ text: element.innerText.replace(/\s+/g, ''),
        hidden: [...element.querySelectorAll('annotation')].every(item => window.getComputedStyle(item).display === 'none') })));
      assert.deepEqual(math.map(item => item.hidden), [true, true], `${width}px: two formulas, each drawn once: ${JSON.stringify(math)}`);
      assert.ok(math.every(item => !/\\|\^/.test(item.text)), `${width}px: no TeX source in the visible text: ${JSON.stringify(math)}`);
      // 我的: a hairline and a label (not a toggle); the long whole-point block starts folded (one row: AI, its first real sentence, its size, 多为重复), the short kept
      // one about words is open, right after the paragraph that holds its words (in 讲解, not in 我的).
      assert.equal((await page.locator('.book-layer__label').innerText()).trim(), '我的');
      assert.equal(await page.locator('.book-layer__toggle').count(), 0, `${width}px: 我的 is not a toggle`);
      assert.equal(await page.locator('.book-ai[data-ai-folded="true"]').count(), 1, `${width}px: only the long block starts folded`);
      const here = page.locator('.book-ai[data-ai-block="here1"]');
      assert.equal(await here.getAttribute('data-ai-folded'), 'true');
      assert.equal(await page.locator('.book-ai[data-ai-block="words1"]').getAttribute('data-ai-folded'), null, `${width}px: a kept short block starts open`);
      assert.equal(await page.locator('.book-ai[data-ai-block="words1"]').evaluate(element => !!element.closest('[data-book-layer]')), false, `${width}px: the block about words is not in 我的`);
      assert.equal(await here.evaluate(element => !!element.closest('[data-book-layer]')), true, `${width}px: the whole-point block is`);
      assert.equal((await here.locator('.book-ai__summary').innerText()).trim(), 'What architects do is the part of the work an architect owns from the first day.', `${width}px: the first real sentence, not the template`);
      assert.match(await here.locator('.book-ai__toggle').innerText(), /^[\s\S]*AI[\s\S]*约 [\d,]+ 字[\s\S]*多为重复/);
      assert.equal(await page.locator('.book-ai-anchor').count(), 1, `${width}px: its words are dashed in the paragraph`);
      await flat(page, width, '逐节读');
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `reading-ai-row-dark-${width}.png`) });
      // Opened, it keeps its labels quiet; an open block stays open after a reload, and folding it is remembered too.
      await here.locator('.book-ai__toggle').click();
      await here.locator('.book-ai__body').waitFor();
      assert.ok(await here.locator('.book-ai__label').count() >= 2, `${width}px: the 原文说： / 意思就是： labels are muted`);
      assert.equal(await here.locator('.book-ai__label').first().evaluate(element => window.getComputedStyle(element).color !== window.getComputedStyle(element.parentElement).color), true);
      await page.reload();
      await openBook(page, running);
      await page.locator('.book-ai[data-ai-block="here1"] .book-ai__body').waitFor({ timeout: 10000 });
      if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `reading-ai-open-dark-${width}.png`) }); }
      await here.locator('.book-ai__toggle').click();
      await page.locator('.book-ai[data-ai-block="here1"][data-ai-folded="true"]').waitFor({ timeout: 5000 });
      assert.match(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('study-book-ai-folded:')).map(([, value]) => value).join('')), /here1/);
      // From two blocks, one quiet link on the divider's row folds or opens them all.
      const all = page.locator('.book-layer__fold');
      assert.equal((await all.innerText()).trim(), '全部收起', `${width}px: one block is open: the link folds them`);
      await all.click();
      assert.equal(await page.locator('.book-ai:not([data-ai-folded])').count(), 0, `${width}px: all folded`);
      assert.equal((await all.innerText()).trim(), '全部展开');
      await all.click();
      assert.equal(await page.locator('.book-ai[data-ai-folded]').count(), 0, `${width}px: all open`);
      await flat(page, width, 'the open blocks');

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
      // The 目录 goes to any point: one without questions has a quiet 出题 in its toolbar and says nothing else about it.
      if (width === 420) await page.locator('.book-header__toc').click();
      await page.locator('.book-toc__go', { hasText: 'A point without questions' }).click();
      await page.locator('.book-step__heading', { hasText: 'A point without questions' }).waitFor();
      assert.match(await page.locator('.book-point__actions').innerText(), /^出题[\s\S]*本节问答[\s\S]*发给主会话$/);
      assert.doesNotMatch(await page.locator('.book-point').innerText(), /暂无题|还没有题|还没出题/);
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
