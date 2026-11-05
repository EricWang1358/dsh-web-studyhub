/* CUSTOM_BOOK_SHOTS=<dir> [BOOK_DIST=dist] node scripts/qa/custom-book-shots.mjs   (build first: node scripts/build.mjs)
   深度定制 S2 in the real page: the 500-page, 10-chapter book of tests/helpers/big-book-library.mjs with a 定制方案 of 讲解 and 术语卡 only (no 公式, 索引 or 速查表),
   chapters 3 and 4 built with no outline first (generation.courseBook.build { chapters } with the chapter ids of the material), by the fake book model. Chinese
   dark at 1440 and English light at 420 px, it saves into CUSTOM_BOOK_SHOTS:
     custom-<lang>-<width>-outline.png  the 总纲: the book line (已生成 2/10 章) with 生成其他章节 open (each chapter 已生成, or 未生成 with its pages)
     custom-<lang>-<width>-rows.png     the chapter rows: the two built, the others with their 未生成 badge
     custom-<lang>-<width>-more.png     the book page's 更多 open: no 速查表
     custom-<lang>-<width>-lookup.png   更多 › 速查页: no formula page, no A–Z, no cards by chapter
   Prints one JSON line per page: the pick's chapter states, the 未生成 rows, the menu's items, the lookup's headings and the page's sideways overflow.
   Seeded temporary library, fake model, no network, no key. */
/* global document, window */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';
import { openPage, settleAnimations, startLateServer } from './layout-late.mjs';
import { openBook } from './book-shots.mjs';
import { StudyService } from '../../lib/service.js';
import { switchOptions } from '../../tests/helpers/runtime-switch.mjs';
import { settleJob } from '../../tests/helpers/wait.mjs';
import { bookModel } from '../../tests/helpers/course-book-model.mjs';
import { BIG_COURSE, bigBookLibrary } from '../../tests/helpers/big-book-library.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const PLAN = chapters => ({ version: 1, purpose: 'follow', scope: { kind: 'chapters', chapters }, book: { make: true, coverage: 'standard', parts: ['explain', 'terms'] },
  questions: { make: false, kinds: [], strength: 'standard', variants: false }, plan: { make: false, by: 'weekly' }, sampleFirst: false });

/** The big book with its plan saved and chapters 3 and 4 built, no outline before. */
async function seed(root) {
  await mkdir(root, { recursive: true });
  const fake = bookModel();
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  try {
    await service.call('snapshot');
    await service.store.update(state => { state.sources.push(...bigBookLibrary().sources); state.focus = { mode: 'class', course: BIG_COURSE, role: '', jd: '', targetTopics: [] }; });
    const ids = (await service.call('course.custom.preview', { course: BIG_COURSE })).skeleton.documents[0].chapters.map(chapter => chapter.id);
    await service.call('course.save', { name: BIG_COURSE, custom: PLAN([ids[2], ids[3]]) });
    const built = await settleJob(service, (await service.call('generation.courseBook.build', { course: BIG_COURSE, language: 'zh', sample: 'skip', chapters: [ids[2], ids[3]] })).jobId);
    if (built.status !== 'complete') throw new Error(`the chapter build did not finish: ${built.status}`);
    return null;
  } finally { await service.dispose(); }
}

async function lookAt(browser, running, { lang, theme, width, shots }) {
  const { page, errors, context } = await openPage(browser, running, { lang, theme, width, height: 900 });
  const name = shot => join(shots, `custom-${lang}-${width}-${shot}.png`);
  const more = async () => { await page.locator('.book-bar__more').click(); await page.locator('[role="menu"]').waitFor({ timeout: 30000 }); await page.waitForTimeout(250); };
  try {
    // The book page (the library has no question yet, so the home is the first-run card; the sidebar's 复习全书 is the way in).
    await openBook(page, running);
    await more();
    await settleAnimations(page);
    await page.screenshot({ path: name('more') });
    const menu = await page.locator('[role="menu"] [role^="menuitem"]').allInnerTexts();
    await page.getByRole('menuitem', { name: /速查页|Lookup pages/ }).click();
    await page.locator('dialog.book-lookup-dialog').waitFor({ timeout: 30000 });
    await page.waitForTimeout(250);
    await settleAnimations(page);
    await page.screenshot({ path: name('lookup') });
    const headings = await page.locator('dialog.book-lookup-dialog h2.book-lookup__title').allInnerTexts();
    const sidewaysBook = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.keyboard.press('Escape');
    // The 总纲 from 更多 › 回到总纲.
    await more();
    await page.getByRole('menuitem', { name: /回到总纲|Back to the outline/ }).click();
    const fold = page.locator('.outline-book-line .book-pick');
    await fold.waitFor({ timeout: 30000 });
    await fold.locator('summary').click();
    await page.mouse.move(width - 10, 890);
    await settleAnimations(page);
    await page.locator('.outline-book-line').screenshot({ path: name('outline') });
    const states = await fold.locator('.book-pick__list li').allInnerTexts();
    const row = page.locator('.outline-row[data-kind="part"]').first();
    await row.scrollIntoViewIfNeeded();
    await settleAnimations(page);
    await page.screenshot({ path: name('rows') });
    const unbuilt = await page.locator('.outline-row[data-kind="part"]', { has: page.locator('[data-unbuilt]') }).count();
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const seen = { lang, theme, width, states: states.map(text => text.replace(/\s+/g, ' ')), unbuilt, menu: menu.map(text => text.replace(/\s+/g, ' ')), headings,
      sideways: Math.max(sidewaysBook, sideways), errors };
    console.log(JSON.stringify(seen));
    return seen;
  } finally { await context.close(); }
}

export async function customBookShots({ shots = process.env.CUSTOM_BOOK_SHOTS, dist = process.env.BOOK_DIST } = {}) {
  await mkdir(shots, { recursive: true });
  const running = await startLateServer({ distDir: resolve(repoRoot, dist || 'dist'), seed });
  const browser = await launchChromium();
  try {
    await running.api('focus.set', { course: BIG_COURSE });
    return [await lookAt(browser, running, { lang: 'zh', theme: 'dark', width: 1440, shots }), await lookAt(browser, running, { lang: 'en', theme: 'light', width: 420, shots })];
  } finally { await browser.close(); await running.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  customBookShots().catch(error => { console.error(error); process.exitCode = 1; });
}
