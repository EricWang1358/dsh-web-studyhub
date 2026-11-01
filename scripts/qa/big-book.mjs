/* [BIG_BOOK_POINTS=400] [BIG_BOOK_CHARS=1250] [BIG_BOOK_DIST=dist] node scripts/qa/big-book.mjs   (build first: npm run build)
   #489 item 3: what a big 复习全书 costs, measured, not guessed: 10 chapters, 400 points, about 500,000 characters by default (the real size the issue names), seeded with no model and no network.
   It prints one JSON object per step: the service's own time and answer size of course.book.open, .save, .export {estimateOnly} and .revision (no browser), then in Chromium at 1280 and 420 px the
   click to the first line, the 目录's rows and the time it takes to open it, ‹ › to the next point, typing, a save, and the main-thread long tasks of each step (their total ms over 50 ms each). */
/* global document, window, performance, PerformanceObserver */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../../lib/course-outline-book.js';
import { courseNotesMaterial } from '../../lib/course-book.js';
import { buildOutlineIndex } from '../../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { launchChromium } from './browser.mjs';
import { openPage, startLateServer } from './layout-late.mjs';

const COURSE = 'BigBook', CHAPTERS = 10;
const POINTS = Number(process.env.BIG_BOOK_POINTS) || 400, CHARS = Number(process.env.BIG_BOOK_CHARS) || 1250;
const paragraph = at => `第 ${at} 节的讲解。延迟的分位数 p99 表示百分之九十九的请求不超过这个时间，容量规划时不能只看平均值；服务的尾延迟常常由排队决定，负载一高就急剧上升。`;

/** A library with one course: its material, an outline of POINTS points over CHAPTERS chapters, the notes of every point (about CHARS characters each). */
export async function seedBigBook(root, { points = POINTS, chars = CHARS } = {}) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push({ id: 'big-p1', title: 'Big lecture', text: paragraph(0).repeat(20), format: 'text', courses: [COURSE], createdAt: '2026-10-01T00:00:00.000Z' });
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    const key = groupSourcesByDocument(state.sources)[0].key;
    const nodes = Array.from({ length: CHAPTERS }, (_, chapter) => ({ id: `c${chapter}`, title: `第 ${chapter + 1} 章`, children: Array.from({ length: Math.ceil(points / CHAPTERS) }, (_, at) => ({
      id: `p${chapter}-${at}`, title: `知识点 ${chapter + 1}.${at + 1}`, anchors: [`${key}#${chapter * 1000 + at}`] })) }));
    const outline = { ...courseOutlineMaterial({ title: `总纲 · ${COURSE}`, course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes, other: { anchors: [] }, counts: { units: points, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    let at = 0;
    const leaves = nodes.flatMap(chapter => chapter.children).map(leaf => {
      at += 1;
      return { id: leaf.id, title: leaf.title, anchors: leaf.anchors, body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} 的要点 [^1]。`], explain: paragraph(at).repeat(Math.ceil(chars / paragraph(at).length)),
        cites: [{ n: 1, sourceId: 'big-p1', quote: paragraph(0).slice(0, 40), start: 0, end: 40 }] } };
    });
    state.sources.push({ ...courseNotesMaterial({ title: `复习全书 · ${COURSE}`, course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves }), createdAt: '2026-10-09T01:00:00.000Z' });
  });
  await service.dispose();
  return { course: COURSE };
}

const timed = async work => { const started = performance.now(), result = await work(); return { ms: Math.round(performance.now() - started), result }; };
const sizeOf = value => JSON.stringify(value).length;

async function measureService(root) {
  const service = new StudyService(root), out = {};
  try {
    const first = await timed(() => service.call('course.book.open', { course: COURSE }));
    out.firstOpen = { ms: first.ms, answerChars: sizeOf(first.result), points: first.result.nodes.flatMap(chapter => chapter.children).length };
    const open = await timed(() => service.call('course.book.open', { course: COURSE }));
    out.open = { ms: open.ms };
    const leaf = open.result.nodes[0].children[0], file = leaf.files.mine;
    const save = await timed(() => service.call('course.book.save', { course: COURSE, file, text: '一条笔记', version: open.result.files[file].version }));
    out.save = { ms: save.ms, answerChars: sizeOf(save.result) };
    const estimate = await timed(() => service.call('course.book.export', { course: COURSE, estimateOnly: true }));
    out.exportEstimate = { ms: estimate.ms, pages: estimate.result.pages ?? estimate.result.estimate?.pages };
    out.revision = { ms: (await timed(() => service.call('course.book.revision', { course: COURSE }))).ms };
  } finally { await service.dispose(); }
  return out;
}

const watchLongTasks = page => page.evaluate(() => {
  window.__long = [];
  new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__long.push(entry.duration); }).observe({ entryTypes: ['longtask'] });
});
const takeLong = page => page.evaluate(() => { const list = window.__long || []; window.__long = []; return { count: list.length, ms: Math.round(list.reduce((sum, value) => sum + value, 0)), worst: Math.round(Math.max(0, ...list)) }; });
const step = async (page, work) => { await takeLong(page); const { ms } = await timed(work); await page.waitForTimeout(100); return { ms, long: await takeLong(page) }; };

async function measureBrowser(browser, running, width) {
  const { page, context, errors } = await openPage(browser, running, { width, height: 900 });
  const out = { width };
  const calls = [];
  page.on('request', request => { const body = request.postData(); if (body?.includes('course.book')) { try { calls.push(JSON.parse(body).action); } catch { /* not an action */ } } });
  await page.goto(running.server.url);
  const entry = page.locator('[data-tour="nav-book"]').first();
  await entry.waitFor({ state: 'attached', timeout: 60000 });
  await watchLongTasks(page);
  out.openBook = await step(page, async () => { await entry.dispatchEvent('click'); await page.locator('[data-book-point]').first().waitFor({ timeout: 120000 }); });
  out.tocRowsOnOpen = await page.locator('.book-toc__item').count();
  out.domNodes = await page.evaluate(() => document.querySelectorAll('*').length);
  if (width <= 720) {
    const toggle = page.locator('.book-bar button').first();
    out.openToc = await step(page, async () => { await toggle.click(); await page.locator('.book-toc__item').first().waitFor({ timeout: 60000 }); });
    out.tocRows = await page.locator('.book-toc__item').count();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  const next = page.getByRole('button', { name: /下一/ }).first();
  const atFirst = await page.locator('[data-book-point]').first().getAttribute('data-book-point');
  out.nextPoint = await step(page, async () => {
    await next.click();
    await page.waitForFunction(id => document.querySelector('[data-book-point]')?.getAttribute('data-book-point') !== id, atFirst, { timeout: 60000 });
  });
  await page.locator('.book-bar__more').evaluate(element => element.click());
  await page.getByRole('menuitem', { name: /^编辑这个知识点/ }).click();
  await page.locator('.book-editor .cm-content').waitFor({ timeout: 60000 });
  await page.locator('.book-editor .cm-content').click();
  out.typeTenChars = await step(page, () => page.keyboard.type('一二三四五六七八九十'));
  calls.length = 0;
  out.save = await step(page, async () => { await page.locator('.book-editor__save').click(); await page.locator('.book-editor__forked').waitFor({ timeout: 120000 }); });
  await page.waitForTimeout(1500);
  out.callsAfterSave = [...calls];
  out.back = await step(page, async () => { await page.locator('.book-mode__done').click(); await page.locator('[data-book-point]').first().waitFor({ timeout: 60000 }); });
  // 整章连着读: every open chapter drawn at once, the heaviest way to read.
  await page.locator('.book-bar__more').evaluate(element => element.click());
  out.scrollMode = await step(page, async () => {
    await page.locator('[role^="menuitem"]', { hasText: '整章连着读' }).click();
    await page.locator('.book-chapter').first().waitFor({ timeout: 120000 });
  });
  out.scrollModeChapters = await page.locator('.book-chapter').count();
  out.scrollModeFolded = await page.locator('[data-book-folded]').count();
  out.scrollModeDomNodes = await page.evaluate(() => document.querySelectorAll('*').length);
  out.errors = errors.slice(0, 3);
  await context.close();
  return out;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.env.BIG_BOOK_DIST || 'dist'), base = await mkdtemp(join(tmpdir(), 'study-big-book-'));
  const offline = join(base, 'library');
  await seedBigBook(offline);
  console.log(JSON.stringify({ service: await measureService(offline) }));
  await rm(base, { recursive: true, force: true });
  const browser = await launchChromium();
  const running = await startLateServer({ distDir: dist, seed: seedBigBook });
  try {
    for (const width of [1280, 420]) console.log(JSON.stringify({ browser: await measureBrowser(browser, running, width) }));
  } finally { await browser.close(); await running.close(); }
}
