/* BOOK_SHOTS=<dir> [BOOK_FIXTURES=archss,questions] [BOOK_DIST=dist] node scripts/qa/book-shots.mjs   (build first: npm run build)
   复习全书 (docs/review-book.md): looks at the book in the real page and counts what stands on the screen. For each fixture of tests/helpers/book-fixtures.mjs
   (archss: sixteen points, a 3,000-6,000 character AI block each, no questions; questions: most points with 10-25 questions) at 1280 and 420 px, light and dark,
   Chinese, it opens the book and saves, into BOOK_SHOTS, <fixture>-<width>-<theme>-<shot>.png: top (the top of the first point), end (the end of it), ai-row (the
   folded AI row), more (the bar's 更多 menu open), bar-mid (scrolled into the middle of the first point: the bar stuck, its reading line part way), toc (the
   目录 open: the column at 1280, the slide-over at 420), lookup (the 速查页 dialog), edit and flip (更多 › 编辑这个知识点… and 翻看, with 「完成 · 回到阅读」), chat
   (整本书 · 发给主会话…), placed (the point with a short explain block, in its place), placed-block (that block in the middle of the window), open-here (a
   whole-point block open), mine-tip (the 我的 row with the explanation of its label), full (the whole page), notice (over a page limit of one page: the line under
   the bar), course (a second course added: the title's switcher open). It prints one JSON line per fixture and width:
     controlsBeforeFirstLine  the visible interactive elements (button, a, summary, [role=button], input, select, textarea) of the book page above the first line
                              of the 讲解 text (the 目录 beside the text at 1280 is not above it and not counted)
     firstLineY               where that line starts, from the top of the window with the page scrolled to its top
     perPointStandingControls the visible interactive elements inside the shown point with nothing expanded
     perPointWithoutInlineMarks  the same without the 角标 and dashed words inside the reading text
     standingModeSwitches     the segmented controls standing on the page (a mode switch: 预览/原文/查找/翻看, 逐节读/整章滚动), outside any dialog or menu
   BOOK_SHOTS_DETAIL=1 adds the names of the elements counted. Seeded temporary library, fake model, no network, no key. */
/* global document, window, getComputedStyle */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';
import { openPage, settleAnimations, startLateServer } from './layout-late.mjs';
import { BOOK_COURSE, BOOK_FIXTURES, seedBookFixture } from '../../tests/helpers/book-fixtures.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** In the page: the numbers (a function body run by page.evaluate; nothing from here is visible inside it). */
const measure = () => {
  const WANTED = 'button, a, summary, [role="button"], input, select, textarea';
  const visible = element => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none') return false;
    for (let fold = element.closest('details'); fold; fold = fold.parentElement?.closest('details')) {
      if (!fold.open && !(element.tagName === 'SUMMARY' && element.parentElement === fold)) return false;
    }
    return !element.closest('[hidden], [inert], [aria-hidden="true"]');
  };
  const name = element => `${element.tagName.toLowerCase()}.${String(element.className).split(/\s+/)[0] || ''} ${(element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)}`;
  const page = document.querySelector('.book-page');
  const first = document.querySelector('.book-point__part .book-file p, .book-point__part .book-file li, .book-point__part .book-file');
  const firstLineY = first ? Math.round(first.getBoundingClientRect().top) : null;
  const all = page ? [...page.querySelectorAll(WANTED)].filter(visible) : [];
  const before = firstLineY === null ? [] : all.filter(element => !element.closest('.book-toc') && element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2 < firstLineY);
  const point = document.querySelector('[data-book-point]');
  const inPoint = point ? [...point.querySelectorAll(WANTED)].filter(visible) : [];
  // The 角标 and the dashed words are marks inside the reading text, not controls standing beside it: counted in the first number, left out of the second.
  const apart = inPoint.filter(element => !element.closest('.md-cite, .book-ai-anchor'));
  const switches = page ? [...page.querySelectorAll('.sh-seg')].filter(element => visible(element) && !element.closest('dialog, [role="menu"], [role="dialog"]')) : [];
  return { firstLineY, controlsBeforeFirstLine: before.length, perPointStandingControls: inPoint.length, perPointWithoutInlineMarks: apart.length,
    standingModeSwitches: switches.length, before: before.map(name), inPoint: inPoint.map(name) };
};

const toTop = page => page.evaluate(() => { const app = document.querySelector('.study-app'); if (app) app.scrollTop = 0; window.scrollTo(0, 0); });
/** The element in the middle of the window (the sticky bars off it). */
const centre = locator => locator.evaluate(element => element.scrollIntoView({ block: 'center' }));
const toEnd = page => page.evaluate(() => { const app = document.querySelector('.study-app'); if (app) app.scrollTop = app.scrollHeight; window.scrollTo(0, document.documentElement.scrollHeight); });

/** The whole page: the window as tall as what the app scrolls, then back. */
async function whole(page, width, path) {
  const height = await page.evaluate(() => { const app = document.querySelector('.study-app'); if (app) app.scrollTop = 0; return Math.min(7000, app?.scrollHeight ?? 900); });
  await page.setViewportSize({ width, height: Math.max(900, height) });
  await settleAnimations(page);
  await page.screenshot({ path });
  await page.setViewportSize({ width, height: 900 });
}

async function openBook(page, running) {
  await page.goto(running.server.url);
  await page.locator('[data-tour="nav-book"]').click({ timeout: 30000 });
  await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
  // The pointer is left over the page, not over the sidebar entry it pressed (that tooltip would be in every picture).
  await page.mouse.move(900, 500);
  await page.waitForTimeout(400);
}

async function lookAt(browser, running, { kind, width, theme, shots }) {
  const { page, errors, context } = await openPage(browser, running, { width, height: 900, theme });
  const name = shot => (shots ? join(shots, `${kind}-${width}-${theme}-${shot}.png`) : null);
  // A picture waits for the bar's reading line (drawn on the next frame after a scroll, with a short transition), and a focus left on a button by Esc is let go
  // unless a menu or a dialog is open (its ring would be in every picture after it).
  const save = async (shot, options = {}) => {
    if (!shots) return;
    await page.evaluate(() => { if (!document.querySelector('[role="menu"], dialog[open], .book-toc[data-overlay]')) document.activeElement?.blur?.(); });
    await page.waitForTimeout(200);
    await settleAnimations(page);
    await page.screenshot({ path: name(shot), ...options });
  };
  try {
    await openBook(page, running);
    await settleAnimations(page);
    await toTop(page);
    const numbers = await page.evaluate(measure);
    await save('top');
    // The bar's 更多 open, then closed with Esc.
    await page.locator('.book-bar__more').click();
    await page.locator('[role="menu"]').waitFor({ timeout: 30000 });
    await page.waitForTimeout(250);
    await save('more');
    await page.keyboard.press('Escape');
    // The 速查页 from 更多: a dialog over the book.
    await page.locator('.book-bar__more').click();
    await page.getByRole('menuitem', { name: '速查页…' }).click();
    await page.locator('dialog.book-lookup-dialog').waitFor({ timeout: 30000 });
    await page.waitForTimeout(250);
    await save('lookup');
    await page.keyboard.press('Escape');
    await page.locator('dialog.book-lookup-dialog').waitFor({ state: 'detached', timeout: 30000 });
    // 更多 › 编辑这个知识点… and 翻看 take the page's place with 「完成 · 回到阅读」; 整本书 · 发给主会话… opens in a dialog.
    for (const [item, ready, shot] of [[/^编辑这个知识点/, '.book-editor .cm-content', 'edit'], [/^翻看/, '.book-flip', 'flip']]) {
      await page.locator('.book-bar__more').click();
      await page.getByRole('menuitem', { name: item }).click();
      await page.locator(ready).first().waitFor({ timeout: 30000 });
      await page.mouse.move(900, 500);
      await page.waitForTimeout(300);
      await save(shot);
      await page.locator('.book-mode__done').click();
      await page.locator('.book-bar').waitFor({ timeout: 30000 });
    }
    await page.locator('.book-bar__more').click();
    await page.getByRole('menuitem', { name: /^发给主会话…/ }).click();
    await page.locator('dialog.book-chat-dialog').waitFor({ timeout: 30000 });
    await page.waitForTimeout(250);
    await save('chat');
    await page.keyboard.press('Escape');
    await page.locator('dialog.book-chat-dialog').waitFor({ state: 'detached', timeout: 30000 });
    await toTop(page);
    // The 目录: the column at 1280 (open by default), the slide-over at 420 (closed with Esc).
    if (width < 900) {
      await page.locator('.book-bar__toc').click();
      await page.locator('.book-toc[data-overlay]').waitFor({ timeout: 30000 });
      await page.waitForTimeout(300);
      await save('toc');
      await page.keyboard.press('Escape');
      await page.locator('.book-toc').waitFor({ state: 'detached', timeout: 30000 });
    } else await save('toc');
    // In the middle of the first point: the bar stays on top, its line part way.
    await page.evaluate(() => { const point = document.querySelector('[data-book-point]'), app = document.querySelector('.study-app'); if (point && app) app.scrollTop += point.getBoundingClientRect().top + point.getBoundingClientRect().height * 0.4; });
    await page.waitForTimeout(250);
    await save('bar-mid');
    await toTop(page);
    const row = page.locator('.book-ai').first();
    if (await row.count()) { await row.scrollIntoViewIfNeeded(); if (shots) { await settleAnimations(page); await row.screenshot({ path: name('ai-row') }); } }
    await toEnd(page);
    await save('end');
    // The next point has a short explain block on words of its 讲解: shown in its place.
    await page.locator('.book-step__next').first().scrollIntoViewIfNeeded();
    await page.locator('.book-step__next').first().click();
    await page.locator('.book-step__heading', { hasText: 'Architect the Solution' }).waitFor({ timeout: 30000 });
    await toTop(page);
    await save('placed');
    // The short block in its place (opened by default, with 保留 because it is new), the whole-point block open, and the 我的 row of this point (two blocks: the
    // link that folds or opens them all; the label's explanation on hover).
    const short = page.locator('.book-ai[data-ai-block^="w"]').first();
    if (await short.count()) { await centre(short); await save('placed-block'); }
    const here = page.locator('.book-ai[data-ai-block^="h"]').first();
    if (await here.count()) {
      await here.locator('.book-ai__toggle').click();
      await centre(here);
      await save('open-here');
      await here.locator('.book-ai__toggle').click();
    }
    const label = page.locator('.book-layer__label').first();
    if (await label.count()) {
      await centre(label);
      await label.hover();
      await page.waitForTimeout(500);
      await save('mine-tip');
      await page.mouse.move(900, 100);
    }
    await page.locator('.book-bar__prev').first().click();
    await page.locator('.book-step__heading', { hasText: 'What architects do' }).waitFor({ timeout: 30000 });
    if (shots) await whole(page, width, name('full'));
    if (shots) {
      // Over the page limit (one page, set for this picture and cleared again): the quiet line under the bar.
      await running.api('settings.book.set', { patch: { pageLimit: 1 } });
      try {
        await openBook(page, running);
        await page.locator('.book-bar-limit').waitFor({ timeout: 30000 });
        await toTop(page);
        await save('notice');
      } finally { await running.api('settings.book.set', { patch: { pageLimit: null } }); }
    }
    return { numbers, errors };
  } finally { await context.close(); }
}

/** Two courses (a note of a second one added): the title's course is the home's switcher; the picture has its list open. */
async function lookAtCourse(browser, running, { kind, width, theme, shots }) {
  const { page, errors, context } = await openPage(browser, running, { width, height: 900, theme });
  try {
    await openBook(page, running);
    await toTop(page);
    await page.locator('.book-page h1').getByRole('combobox', { name: '切换当前课程' }).click();
    await page.getByRole('option', { name: /软件测试/ }).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, `${kind}-${width}-${theme}-course.png`) });
    return errors;
  } finally { await context.close(); }
}

export async function bookShots({ shots = process.env.BOOK_SHOTS, kinds = (process.env.BOOK_FIXTURES || BOOK_FIXTURES.join(',')).split(',').filter(Boolean), dist = process.env.BOOK_DIST } = {}) {
  if (shots) await mkdir(shots, { recursive: true });
  const browser = await launchChromium(), results = [];
  try {
    for (const kind of kinds) {
      const running = await startLateServer({ distDir: resolve(repoRoot, dist || 'dist'), seed: root => seedBookFixture(root, kind) });
      try {
        await running.api('focus.set', { course: BOOK_COURSE });
        for (const width of [1280, 420]) {
          for (const theme of ['dark', 'light']) {
            const { numbers, errors } = await lookAt(browser, running, { kind, width, theme, shots });
            if (errors.length) console.error(`${kind} ${width} ${theme}: page errors ${JSON.stringify(errors)}`);
            if (theme === 'dark') {
              const { before, inPoint, ...counts } = numbers;
              results.push({ fixture: kind, width, ...counts });
              console.log(JSON.stringify({ fixture: kind, width, ...counts, ...(process.env.BOOK_SHOTS_DETAIL ? { before, inPoint } : {}) }));
            }
          }
        }
        if (shots) {
          await running.api('source.add', { title: '软件测试 笔记', text: '另一门课的一份笔记。', course: '软件测试' });
          for (const width of [1280, 420]) {
            for (const theme of ['dark', 'light']) {
              const errors = await lookAtCourse(browser, running, { kind, width, theme, shots });
              if (errors.length) console.error(`${kind} ${width} ${theme} course: page errors ${JSON.stringify(errors)}`);
            }
          }
        }
      } finally { await running.close(); }
    }
  } finally { await browser.close(); }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bookShots().catch(error => { console.error(error); process.exitCode = 1; });
}
