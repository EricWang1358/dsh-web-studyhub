/* global document window MouseEvent */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { holdActions, openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { openCourseBook } from '../lib/course-book-files.js';
import { aiBlock } from '../lib/course-book-ai-text.js';
import { ALL_CHAPTERS, COURSE as SA, outlineLibrary } from './helpers/course-outline-library.mjs';

/* The 复习全书's line about the course's search index (BookIndexHint.jsx) in the real page at 1280 and 420 px, light and dark, on two books: one shaped
   like ArchSS (16 points, each with a long whole-point AI paragraph, no questions) and one with questions. The index answers (retrieval.index.plan and
   retrieval.index.status) are held at the network edge and answered as: not built, partly built, building, ready. The line keeps its slot while the
   answer is out, so nothing below it moves when it arrives; it is one line at both widths; its hover says where the index is built and what is missing;
   the link opens 设置 › 检索扩展; the 弄懂 panel carries the same state as one muted line. Screenshots go to BOOK_INDEX_SHOTS when it is set. */

const ARCH = 'ArchSS';
const explainOf = title => [`${title} is what this point is about, in one sentence.`, ...Array.from({ length: 3 }, (_, i) => `Paragraph ${i + 1} about ${title}: what the course says and why.`)].join('\n\n');
const longBlock = title => Array.from({ length: 24 }, (_, i) => `原文说：${title} 第 ${i + 1} 段，课件里讲到的要点和例子。\n\n意思就是：${title} 的第 ${i + 1} 个要点用大白话再讲一遍，方便复习时快速看懂。`).join('\n\n');

function addBook(state, course, leaves, { mine = () => '' } = {}) {
  const outline = { ...courseOutlineMaterial({ title: `总纲 · ${course}`, course, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course }).allDocuments),
    nodes: leaves, other: { anchors: [] }, counts: { units: leaves.flatMap(node => node.children).length, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
  state.sources.push(outline);
  const points = leaves.flatMap(node => node.children), page = state.sources.find(source => (source.courses || []).includes(course) && source.document?.page === 1);
  state.sources.push({ ...courseNotesMaterial({ title: `复习全书 · ${course}`, course, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: points.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
    body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} in one line [^1].`, 'A second key point.'], explain: explainOf(leaf.title),
      cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }), createdAt: '2026-10-09T01:00:00.000Z' });
  openCourseBook(state, { course });
  const record = state.sources.find(source => source.provenance === 'course-book-doc' && source.bookDoc?.course === course) ?? state.sources.filter(source => source.provenance === 'course-book-doc').at(-1);
  for (const leaf of points) if (record.bookDoc.files[`${leaf.id}.mine.md`]) record.bookDoc.files[`${leaf.id}.mine.md`].text = mine(leaf);
}

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  // The ArchSS-like copy: the same lectures under their own ids and course, no questions.
  const arch = sources.filter(source => source.document?.format === 'pdf' && !String(source.id).includes('again')).map(source => ({ ...structuredClone(source), id: `arch-${source.id}`, courses: [ARCH],
    document: { ...source.document, materialId: `arch-${source.document.materialId}` } }));
  await service.store.update(state => {
    state.sources.push(...sources, ...arch);
    state.decks.push(...decks);
    state.focus = { mode: 'class', course: SA, role: '', jd: '', targetTopics: [] };
    const lecture = (n, prefix = '') => groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes(`${prefix}document-l${n}-p1`)).key;
    addBook(state, SA, [{ id: 'c1', title: 'Introduction', children: ['What architects do', 'Stakeholders and concerns', 'Views and viewpoints'].map((title, at) => ({ id: `sa${at}`, title, anchors: [`${lecture(1)}#${at}`] })) },
      { id: 'c2', title: 'Requirements', children: ['Functional requirements', 'Quality attribute scenarios', 'Trade-offs'].map((title, at) => ({ id: `sb${at}`, title, anchors: [`${lecture(2)}#${at}`] })) }]);
    const chapters = Array.from({ length: 6 }, (_, n) => ({ id: `a${n + 1}`, title: `Lecture ${n + 1}`, children: [] }));
    ALL_CHAPTERS.slice(0, 16).forEach((title, at) => chapters[Math.floor(at / 3)].children.push({ id: `ap${at}`, title, anchors: [`${lecture(Math.floor(at / 3) + 1, 'arch-')}#${at % 3}`] }));
    addBook(state, ARCH, chapters.filter(node => node.children.length), { mine: leaf => aiBlock({ id: `here-${leaf.id}`, at: 'h:any', about: leaf.title, body: longBlock(leaf.title), mode: 'here' }, 'zh') });
  });
  await service.dispose();
}

const PLAN = { pages: 870, toIndex: 870, unchanged: 0, toRemove: 0, chars: 3170000, firstRun: false, modelMb: 90, canIndex: true, documents: 14,
  missing: [{ title: '04. Design Secure Architecture v4.7', pages: 198 }, { title: '06. Design for Performance', pages: 107 }], missingDocuments: 9 };
const STATES = {
  missing: { plan: PLAN, run: { status: 'idle' }, words: /这门课的资料还没建索引/, link: '去建立索引' },
  partial: { plan: { ...PLAN, toIndex: 70, unchanged: 800 }, run: { status: 'idle' }, words: /索引还差 70 页/, link: '去补建' },
  building: { plan: PLAN, run: { status: 'running', course: null, stage: 'indexing', done: 18, total: 870 }, words: /正在建立索引 18\/870 页/, link: null },
  ready: { plan: { ...PLAN, toIndex: 0, unchanged: 870, missing: [], missingDocuments: 0 }, run: { status: 'idle' }, words: null, link: null },
};

/** retrieval.status of an installed, running search extension (the preview has none). */
const INSTALLED = { selected: 'builtin', effective: 'builtin', explicit: false, autoIndex: true, boot: 'preview', hostCanSearch: false, providers: [], otherTools: [],
  companion: { id: 'mcp:mcp__studyhub__query_documents', running: true }, limits: { retrieveAboveChars: 150000, maxSelectedChars: 400000 },
  extension: { installed: true, canInstall: true, outdated: false, version: '1.0.0', expected: '1.0.0' } };

const sideways = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** Where the reading starts and what stands before it: the y of the point's one sentence, and the controls above it. */
const reading = page => page.evaluate(() => {
  const gist = document.querySelector('.book-point__gist') || document.querySelector('[data-book-point] p');
  const top = gist.getBoundingClientRect().top;
  const controls = [...document.querySelectorAll('.book-page button, .book-page a[href], .book-page [role="button"], .book-page input, .book-page select, .book-page [tabindex="0"]')]
    .filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && box.bottom <= top; }).length;
  return { y: Math.round(top), controls };
});
const slot = page => page.evaluate(() => { const line = document.querySelector('[data-book-index]'); return line ? { kind: line.dataset.bookIndex, height: Math.round(line.getBoundingClientRect().height * 10) / 10 } : null; });

async function openBook(page, running, course, state, { hold = true } = {}) {
  const held = await holdActions(page, ['retrieval.index.plan', 'retrieval.index.status']);
  if (!hold) { held.release('retrieval.index.plan', state.plan); held.release('retrieval.index.status', { ...state.run, course: state.run.course === null ? course : state.run.course }); }
  await running.api('focus.set', { course });
  await page.goto(running.server.url);
  // The sidebar's 复习全书 (dispatched: at 420 px the sidebar is folded away), which opens the written book of the current course.
  const nav = page.locator('[data-tour="nav-book"]').first();
  await nav.waitFor({ state: 'attached', timeout: 30000 });
  await nav.dispatchEvent('click');
  await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
  return held;
}
const answer = (held, course, state) => {
  held.release('retrieval.index.status', { ...state.run, course: state.run.course === null ? course : state.run.course });
  held.release('retrieval.index.plan', { ...state.plan, course });
};

test('the index line on the book page and in the 弄懂 panel: not built, partly built, building, ready; late, it moves nothing (1280 and 420 px, light and dark)', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-index-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.BOOK_INDEX_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shoot = async (page, width, name) => {
    if (!shots) return;
    await page.evaluate(() => { const app = document.querySelector('.study-app'); if (app) app.scrollTop = 0; });
    await settleAnimations(page);
    await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  try {
    for (const [fixture, course] of [['archss', ARCH], ['questions', SA]]) for (const width of [1280, 420]) for (const theme of ['light', 'dark']) {
      // Before this change the page had no line: a ready index draws none either (the answer in before the book), so these are the page's own numbers.
      {
        const { page, context, errors } = await openPage(browser, running, { width, height: 900, theme });
        await openBook(page, running, course, STATES.ready, { hold: false });
        await settleAnimations(page);
        const before = await reading(page);
        t.diagnostic(`BEFORE ${fixture} ${width}px ${theme}: first sentence y=${before.y}, controls above it ${before.controls}, index line ${JSON.stringify(await slot(page))}`);
        assert.equal(await slot(page), null, `${width}px: a ready index says nothing`);
        assert.deepEqual(errors, []);
        await context.close();
      }
      for (const name of ['missing', 'partial', 'building']) {
        const state = STATES[name];
        const { page, context, errors } = await openPage(browser, running, { width, height: 900, theme });
        const held = await openBook(page, running, course, state);
        await settleAnimations(page);
        const waiting = await reading(page), reserved = await slot(page);
        assert.equal(reserved?.kind, 'slot', `${width}px: the line keeps its room while the answer is out`);
        answer(held, course, state);
        const line = page.locator(`[data-book-index="${name}"]`);
        await line.waitFor({ timeout: 30000 });
        await settleAnimations(page);
        const after = await reading(page), drawn = await slot(page);
        t.diagnostic(`AFTER ${fixture} ${name} ${width}px ${theme}: first sentence y=${waiting.y} → ${after.y}, controls above it ${after.controls}, line ${reserved.height} → ${drawn.height} px`);
        assert.ok(Math.abs(after.y - waiting.y) <= 1, `${width}px ${name}: the reading did not move (${waiting.y} → ${after.y})`);
        assert.ok(Math.abs(drawn.height - reserved.height) <= 1, `${width}px ${name}: one line, the height of its slot (${reserved.height} → ${drawn.height})`);
        assert.match(await line.innerText(), state.words);
        assert.equal(await line.getByRole('button', { name: state.link ?? 'none' }).count(), state.link ? 1 : 0, `${width}px ${name}: the link`);
        assert.ok(await sideways(page) <= 0, `${width}px ${name}: nothing scrolls sideways`);
        await shoot(page, width, `${fixture}-${name}-${width}-${theme}`);
        if (name === 'missing' && theme === 'light') {
          // The hover: local, no tokens, which materials are missing.
          await line.locator('.book-index-hint__text').focus();
          const tip = page.getByRole('tooltip').filter({ hasText: '不花 token' });
          await tip.waitFor({ timeout: 10000 });
          assert.match(await tip.innerText(), /其中 870 页还没建索引，来自《04\. Design Secure Architec/);
          await shoot(page, width, `${fixture}-missing-tip-${width}-${theme}`);
          // The 弄懂 panel over selected words: one muted line.
          await page.keyboard.press('Escape');
          await page.locator('.book-point__gist').evaluate(element => {
            const range = document.createRange(); range.selectNodeContents(element.querySelector('p') || element);
            const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          });
          const panel = page.locator('.book-ai-ask');
          await panel.waitFor({ timeout: 10000 });
          assert.match(await panel.locator('.book-index-hint--muted').innerText(), /这门课的资料还没建索引/);
          await shoot(page, width, `${fixture}-panel-${width}-${theme}`);
          assert.equal(await panel.locator('.book-index-hint__full').isVisible(), false, 'the panel says the short words');
          // The link: 设置 › 检索扩展 with this course chosen; nothing is built. The extension answers as installed and running there, so the
          // switch 新资料自动补建索引 shows (on by default) with its hover, and turning it off asks retrieval.auto.set.
          await page.keyboard.press('Escape');
          const settings = await holdActions(page, ['retrieval.status', 'retrieval.auto.set']);
          settings.release('retrieval.status', INSTALLED);
          settings.release('retrieval.auto.set', { ...INSTALLED, autoIndex: false });
          await line.getByRole('button', { name: '去建立索引' }).click();
          const section = page.locator('[data-tour="settings-extensions"]');
          await section.waitFor({ timeout: 30000 });
          const toggle = section.getByRole('switch', { name: '新资料自动补建索引' });
          await toggle.waitFor({ timeout: 30000 });
          assert.equal(await toggle.isChecked(), true, 'on by default');
          await toggle.focus();
          await page.getByRole('tooltip').filter({ hasText: '连着导入几份只补一次' }).waitFor({ timeout: 10000 });
          await toggle.scrollIntoViewIfNeeded();
          await settleAnimations(page);
          if (shots) await page.screenshot({ path: join(shots, `${fixture}-settings-${width}-${theme}.png`) });
          const asked = page.waitForRequest(request => /"action":"retrieval\.auto\.set"/.test(request.postData() || ''));
          await toggle.click();
          assert.equal(JSON.parse((await asked).postData()).args.on, false, 'turning it off');
          assert.equal(held.count('retrieval.index.plan') >= 1, true);
        }
        assert.deepEqual(errors, [], `${width}px ${name}: no page errors`);
        await context.close();
      }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
