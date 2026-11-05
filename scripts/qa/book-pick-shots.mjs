/* BOOK_PICK_SHOTS=<dir> [BOOK_DIST=dist] node scripts/qa/book-pick-shots.mjs   (build first: node scripts/build.mjs)
   只生成部分章节 (#708) in the real page: the library shaped like the owner's (tests/helpers/course-outline-library.mjs), its 总纲 organised by the fake book
   model, light, Chinese, at 1440 and 420 px. Two states, each its own seeded library:
     start    the outline, no book yet: pick-<width>-start.png (the book line with 只生成部分章节 open, two chapters ticked and their scale shown) and
              pick-<width>-start-page.png (the whole page);
     partial  the first chapter built alone (generation.courseBook.build { chapters }): pick-<width>-partial.png (the book line: 已生成 1/N 章, 生成全部其余章节,
              生成其他章节 open with one more chapter ticked) and pick-<width>-partial-rows.png (the chapter rows with their 未生成 badge).
   Prints one JSON line per state and width: the primary buttons, the scale lines, the 未生成 line and the page's sideways overflow. The scale is the build's
   own `estimate: true` (no call). Seeded temporary library, fake model, no network, no key. */
/* global document, window */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';
import { openPage, settleAnimations, startLateServer } from './layout-late.mjs';
import { StudyService } from '../../lib/service.js';
import { switchOptions } from '../../tests/helpers/runtime-switch.mjs';
import { settleJob } from '../../tests/helpers/wait.mjs';
import { COURSE, outlineLibrary } from '../../tests/helpers/course-outline-library.mjs';
import { bookModel } from '../../tests/helpers/course-book-model.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The library with its outline organised; `partial`: and its first chapter built alone. */
const seedOf = partial => async root => {
  await mkdir(root, { recursive: true });
  const fake = bookModel();
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  try {
    await service.call('snapshot');
    const { sources, decks } = outlineLibrary();
    await service.store.update(state => {
      state.sources.push(...sources); state.decks.push(...decks); state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    });
    const organised = await settleJob(service, (await service.call('generation.courseOutline.build', { course: COURSE, language: 'zh' })).jobId);
    if (organised.status !== 'complete') throw new Error(`the outline did not finish: ${organised.status}`);
    if (!partial) return null;
    const parts = (await service.call('course.outline', { course: COURSE })).book.parts;
    const built = await settleJob(service, (await service.call('generation.courseBook.build', { course: COURSE, language: 'zh', chapters: [parts[0].id] })).jobId);
    if (built.status !== 'complete') throw new Error(`the chapter build did not finish: ${built.status}`);
    return null;
  } finally { await service.dispose(); }
};

async function lookAt(browser, state, shots, dist) {
  const running = await startLateServer({ distDir: resolve(repoRoot, dist || 'dist'), seed: seedOf(state === 'partial') }), seen = [];
  try {
    await running.api('focus.set', { course: COURSE });
    for (const width of [1440, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900, theme: 'light' });
      try {
        const name = shot => join(shots, `pick-${width}-${shot}.png`);
        await page.goto(running.server.url);
        await page.locator('.outline-entry').first().click({ timeout: 30000 });
        const fold = page.locator('.outline-book-line .book-pick');
        await fold.waitFor({ timeout: 30000 });
        await fold.locator('summary').click();
        // Two chapters ticked from the start; one more (a chapter not built) once the first is built.
        const boxes = fold.locator('.book-pick__list input[type="checkbox"]');
        const ticks = state === 'partial' ? [1] : [0, 1];
        for (const at of ticks) await boxes.nth(at).check({ force: true });
        await fold.locator('[data-book-pick-scale]').waitFor({ timeout: 30000 });
        await page.mouse.move(width - 10, 890);
        await settleAnimations(page);
        const line = page.locator('.outline-book-line');
        await line.screenshot({ path: name(state) });
        if (state === 'start') await page.screenshot({ path: name('start-page'), fullPage: true });
        else {
          const row = page.locator('.outline-row[data-kind="part"]', { has: page.locator('[data-unbuilt]') }).first();
          await row.scrollIntoViewIfNeeded();
          await settleAnimations(page);
          await page.screenshot({ path: name('partial-rows') });
        }
        const primary = await page.locator('.outline-page .sh-btn--primary').allInnerTexts();
        const scale = (await fold.locator('[data-book-pick-scale]').innerText()).replace(/\s+/g, ' ');
        const unbuilt = await page.locator('[data-book-unbuilt]').allInnerTexts();
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        seen.push({ state, width, primary, scale, unbuilt, sideways, errors });
        console.log(JSON.stringify(seen.at(-1)));
      } finally { await context.close(); }
    }
  } finally { await running.close(); }
  return seen;
}

export async function bookPickShots({ shots = process.env.BOOK_PICK_SHOTS, dist = process.env.BOOK_DIST } = {}) {
  await mkdir(shots, { recursive: true });
  const browser = await launchChromium();
  try { return [...await lookAt(browser, 'start', shots, dist), ...await lookAt(browser, 'partial', shots, dist)]; } finally { await browser.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bookPickShots().catch(error => { console.error(error); process.exitCode = 1; });
}
