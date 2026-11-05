/* BOOK_SHOTS=<dir> [BOOK_FIXTURES=archss,questions] [BOOK_DIST=dist] node scripts/qa/book-shots.mjs   (build first: npm run build)
   复习全书 (docs/review-book.md): looks at the book in the real page and counts what stands on the screen. For each fixture of tests/helpers/book-fixtures.mjs
   (archss: sixteen points, a 3,000-6,000 character AI block each, no questions; questions: most points with 10-25 questions) at 1280 and 420 px, light and dark,
   Chinese, it opens the book and saves, into BOOK_SHOTS, <fixture>-<width>-<theme>-<shot>.png: top (the top of the first point), end (the end of it), ai-row (the
   folded AI row), more (the bar's 更多 menu open), bar-mid (scrolled into the middle of the first point: the bar stuck, its reading line part way), toc (the
   目录 open: the column at 1280, the slide-over at 420), lookup (the 速查页 dialog), edit and flip (更多 › 编辑这个知识点… and 翻看, with 「完成 · 回到阅读」), chat
   (整本书 · 发给主会话: it sends at once, the receipt it leaves), placed (the point with a short explain block, in its place), placed-block (that block in the middle of the window), open-here (a
   whole-point block open), mine-tip (the 我的 row with the explanation of its label), full (the whole page), notice (over a page limit of one page: the line under
   the bar), course (a second course added: the title's switcher open), and 问 AI: ask-panel, selection-toolbar, writing-line, landed-folded, deleted-undo
   (lookAtAi below). It prints one JSON line per fixture and width:
     controlsBeforeFirstLine  the visible interactive elements (button, a, summary, [role=button], input, select, textarea) of the book page above the first line
                              of the 讲解 text (the 目录 beside the text at 1280 is not above it and not counted)
     firstLineY               where that line starts, from the top of the window with the page scrolled to its top
     perPointStandingControls the visible interactive elements inside the shown point with nothing expanded
     perPointWithoutInlineMarks  the same without the 角标 and dashed words inside the reading text
     standingModeSwitches     the segmented controls standing on the page (a mode switch: 预览/原文/查找/翻看, 逐节读/整章滚动), outside any dialog or menu
   BOOK_SHOTS_DETAIL=1 adds the names of the elements counted. Seeded temporary library, fake model, no network, no key.
   BOOK_FIXTURES=built (#710, not in the default list): a book BUILT by the fake model (tests/helpers/book-fixtures.mjs seedBuiltBook), at 1440 and 420, light:
   built-<width>-light-cards (the first point's 术语卡 open), card-link (a relation followed to its card), lookup-az, lookup-chapters and lookup-formulas (the
   速查页's A–Z with the cards' numbers and other names, the cards by chapter, the formula page).
   BOOK_FIXTURES=confusables (#710 S3, not in the default list): seedConfusableBook at 1440 and 420, light: confusables-<width>-light-lookup (the 速查页 scrolled to its
   易混概念 part) and confusables-<width>-light-link (a card's number in it followed to the card).
   BOOK_SAMPLE_SHOTS=<dir> instead looks at the sample of a first 复习全书 build (#710; light, Chinese, 1440 and 420 px): sample-<width>-outline.png (the 总纲's
   book line with the sample, its scale and its one primary button), sample-<width>-card.png (the card alone), sample-<width>-book.png (the book page with it) and
   sample-<width>-console.png (the 任务 console: the build ended, waiting for the learner), and prints what the card and the console say.
   BOOK_FIXTURES=old (#710 S6, not in the default list): that book as written before 术语卡 existed (seedOldBook), at 1440 and 420, light: old-<width>-light-tip
   (更多 open, the pointer on 补术语卡, its Tooltip); then after the pass (seedCardPassBook: the preview has no job executor, so the pass runs in the seed):
   cards (the first point's 术语卡, open) and more-after (更多 without 补术语卡). The 任务 console of the pass is not shown: its job ran in the seed's own
   runtime, which the preview does not list. */
/* global document, window, getComputedStyle */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';
import { openPage, settleAnimations, startLateServer } from './layout-late.mjs';
import { BOOK_COURSE, BOOK_FIXTURES, seedBookFixture, seedBuiltBook, seedCardPassBook, seedConfusableBook, seedOldBook } from '../../tests/helpers/book-fixtures.mjs';
import { StudyService } from '../../lib/service.js';
import { createFakeModel } from '../fake-model.mjs';
import { switchOptions } from '../../tests/helpers/runtime-switch.mjs';
import { settleJob } from '../../tests/helpers/wait.mjs';
import { revealNavRow } from './nav-reveal.mjs';
import { COURSE as OUTLINE_COURSE, outlineLibrary } from '../../tests/helpers/course-outline-library.mjs';
import { bookModel } from '../../tests/helpers/course-book-model.mjs';

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

/** The book page of the focused course, its first point drawn (also scripts/qa/book-kit-shots.mjs). */
export async function openBook(page, running) {
  await page.goto(running.server.url);
  await (await revealNavRow(page, 'book')).click({ timeout: 30000 });
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
    // 更多 › 编辑这个知识点… and 翻看 take the page's place with 「完成 · 回到阅读」; 整本书 · 发给主会话 sends at once and leaves its receipt.
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
    await page.getByRole('menuitem', { name: /^发给主会话/ }).click();
    await page.locator('.sh-toast--receipt').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(600);
    await save('chat');
    await page.locator('.sh-toast--receipt .sh-toast__close').first().click().catch(() => {});
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

/** 问 AI (docs/review-book.md "Ask AI"): ask-panel (问 AI at the title open), selection-toolbar (words selected with the keyboard's way: selection.modify),
    writing-line (弄懂 started: the one line right after the paragraph), landed-folded (the block in that line's place, folded, its short highlight) and
    block-menu (the folded row's ⋯ open), deleted-undo (⋯ › 删除: 「已删除这段 · 撤销」; left deleted, so the book is as it was for the next picture) and
    deleted-faded (that line past its 8 seconds: faded out, its room kept). The task is run by a second service over the same
    library (the fake model); its end is held until the writing line is taken. */
async function lookAtAi(browser, running, { kind, width, theme, shots }) {
  const { page, errors, context } = await openPage(browser, running, { width, height: 900, theme });
  const model = createFakeModel({ latencyMs: 5 });
  const service = new StudyService(join(running.base, 'library'), { complete: model, ...switchOptions('runtime', { complete: model, paths: [] }) });
  const ended = new Map();
  let held = true;
  const answer = (route, value) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value }) });
  await page.route('**/api/call', async route => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* not JSON */ }
    if (body.action === 'generation.courseBook.explain') {
      const started = await service.call('generation.courseBook.explain', body.args);
      settleJob(service, started.jobId).then(job => ended.set(started.jobId, job.status), () => ended.set(started.jobId, 'failed'));
      return answer(route, started);
    }
    if (body.action === 'job.status' && body.args?.jobId) return answer(route, { status: !held && ended.has(body.args.jobId) ? ended.get(body.args.jobId) : 'running' });
    return route.continue();
  });
  const name = shot => join(shots, `${kind}-${width}-${theme}-${shot}.png`);
  const save = async shot => { await page.waitForTimeout(250); await settleAnimations(page); await page.screenshot({ path: name(shot) }); };
  try {
    await openBook(page, running);
    await toTop(page);
    await page.locator('.book-step [data-book-ask-open]').click();
    await page.locator('.book-ask[data-placed]').waitFor({ timeout: 30000 });
    await save('ask-panel');
    await page.keyboard.press('Escape');
    await page.locator('.book-ask').waitFor({ state: 'detached', timeout: 30000 });
    await page.evaluate(() => {
      const paragraph = document.querySelector('[data-book-point] .book-point__part .book-file p');
      paragraph.scrollIntoView({ block: 'center', behavior: 'instant' });
      const node = document.createTreeWalker(paragraph, 4).nextNode(), selection = window.getSelection();
      selection.collapse(node, Math.min(4, node.data.length - 1));
      for (let step = 0; step < 400 && !/[。.]/.test(selection.toString()); step += 1) selection.modify('extend', 'forward', 'character');
      document.activeElement?.blur?.();
    });
    await page.locator('.book-select[data-placed]').waitFor({ timeout: 30000 });
    await page.mouse.move(width - 10, 890);
    await save('selection-toolbar');
    await page.locator('.book-select [data-book-select="explain"]').click();
    await page.locator('[data-ai-line="writing"]').waitFor({ timeout: 30000 });
    await page.mouse.move(width - 10, 890);
    await save('writing-line');
    held = false;
    const landed = page.locator('.book-ai[data-ai-landed]');
    await landed.waitFor({ timeout: 90000 });
    const id = await landed.getAttribute('data-ai-block');
    await page.screenshot({ path: name('landed-folded') });
    await page.locator('.book-ai[data-ai-landed]').waitFor({ state: 'detached', timeout: 30000 });
    await page.locator(`.book-ai[data-ai-block="${id}"] .book-ai__more`).click();
    await page.getByRole('menuitem', { name: /删除/ }).waitFor({ timeout: 30000 });
    await save('block-menu');
    await page.getByRole('menuitem', { name: /删除/ }).click();
    await page.locator('[data-ai-line="undo"]').waitFor({ timeout: 30000 });
    await page.mouse.move(width - 10, 890);
    await save('deleted-undo');
    await page.locator('[data-ai-line="undo"][data-ai-faded]').waitFor({ timeout: 30000 });
    await save('deleted-faded');
    return errors;
  } finally { await context.close(); await service.dispose(); }
}

/** 易混概念 (#710 S3) in the 速查页 of a book built by the fake model: see the top of this file. */
async function lookAtConfusables(browser, running, { width, theme, shots }) {
  const { page, errors, context } = await openPage(browser, running, { width, height: 900, theme });
  const save = async shot => { await page.waitForTimeout(300); await settleAnimations(page); await page.screenshot({ path: join(shots, `confusables-${width}-${theme}-${shot}.png`) }); };
  try {
    await openBook(page, running);
    await page.locator('.book-bar__more').click();
    await page.getByRole('menuitem', { name: '速查页…' }).click();
    const dialog = page.locator('dialog.book-lookup-dialog');
    await dialog.waitFor({ timeout: 30000 });
    const part = dialog.locator('#book-lookup-confusables');
    if (!await part.count()) { console.error('confusables: the 速查页 has no 易混概念 part'); return errors; }
    await part.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await save('lookup');
    console.log(JSON.stringify({ kind: 'confusables', width, pairs: await dialog.locator('[data-confusable]').count(), rows: await dialog.locator('[data-confusable] [data-aspect]').count() }));
    const link = dialog.locator('[data-confusable] [data-term-link]').first();
    await link.click();
    await page.waitForTimeout(500);
    await save('link');
    return errors;
  } finally { await context.close(); }
}

/** 术语卡 (#710) on a book built by the fake model: see the top of this file. */
async function lookAtCards(browser, running, { width, theme, shots }) {
  const { page, errors, context } = await openPage(browser, running, { width, height: 900, theme });
  const save = async shot => { await page.waitForTimeout(300); await settleAnimations(page); await page.screenshot({ path: join(shots, `built-${width}-${theme}-${shot}.png`) }); };
  // The element's top a little under the sticky bars.
  const toTopOf = locator => locator.evaluate(element => { element.scrollIntoView({ block: 'start' }); const app = document.querySelector('.study-app'); if (app) app.scrollTop -= 120; window.scrollBy(0, -120); });
  try {
    await openBook(page, running);
    const fold = page.locator('.book-cards').first();
    await fold.locator('summary').click();
    await toTopOf(fold);
    await page.mouse.move(width - 10, 890);
    await save('cards');
    const link = fold.locator('[data-term-link]').first();
    if (await link.count()) { await link.click(); await page.waitForTimeout(500); await save('card-link'); } else console.error('built: no relation link in the first point');
    await page.locator('.book-bar__more').click();
    await page.getByRole('menuitem', { name: '速查页…' }).click();
    const dialog = page.locator('dialog.book-lookup-dialog');
    await dialog.waitFor({ timeout: 30000 });
    for (const [part, shot] of [['glossary', 'lookup-az'], ['cards', 'lookup-chapters'], ['formulas', 'lookup-formulas']]) {
      const heading = dialog.locator(`#book-lookup-${part}`);
      if (!await heading.count()) { console.error(`built: the 速查页 has no ${part} part`); continue; }
      await heading.evaluate(element => element.scrollIntoView({ block: 'start' }));
      await save(shot);
    }
    return errors;
  } finally { await context.close(); }
}

/** 补术语卡 (#710 S6): see the top of this file. `after`: the book after the pass (seedCardPassBook), else before it (seedOldBook). */
async function lookAtCardPass(browser, running, { width, theme, shots, after }) {
  const { page, errors, context } = await openPage(browser, running, { width, height: 900, theme });
  const save = async shot => { await page.waitForTimeout(300); await settleAnimations(page); await page.screenshot({ path: join(shots, `old-${width}-${theme}-${shot}.png`) }); };
  try {
    await openBook(page, running);
    if (!after) {
      await page.locator('.book-bar__more').click();
      const item = page.getByRole('menuitem', { name: '补术语卡' });
      await item.waitFor({ timeout: 30000 });
      await item.hover();
      await page.locator('.sh-tooltip:popover-open').waitFor({ timeout: 10000 });
      await save('tip');
      return errors;
    }
    const fold = page.locator('.book-cards').first();
    await fold.locator('summary').click();
    await fold.evaluate(element => { element.scrollIntoView({ block: 'start' }); const app = document.querySelector('.study-app'); if (app) app.scrollTop -= 120; });
    await page.mouse.move(width - 10, 890);
    await save('cards');
    await page.locator('.book-bar__more').click();
    await page.getByRole('menuitem', { name: '速查页…' }).waitFor({ timeout: 30000 });
    if (await page.getByRole('menuitem', { name: '补术语卡' }).count()) console.error('old: 补术语卡 is still offered after the pass');
    await save('more-after');
    return errors;
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
      if (kind === 'old') {
        for (const after of [false, true]) {
          const running = await startLateServer({ distDir: resolve(repoRoot, dist || 'dist'), seed: after ? seedCardPassBook : seedOldBook });
          try {
            for (const width of [1440, 420]) {
              const errors = await lookAtCardPass(browser, running, { width, theme: 'light', shots, after });
              if (errors.length) console.error(`old ${width} light: page errors ${JSON.stringify(errors)}`);
            }
          } finally { await running.close(); }
        }
        continue;
      }
      if (kind === 'confusables') {
        const running = await startLateServer({ distDir: resolve(repoRoot, dist || 'dist'), seed: seedConfusableBook });
        try {
          for (const width of [1440, 420]) {
            const errors = await lookAtConfusables(browser, running, { width, theme: 'light', shots });
            if (errors.length) console.error(`confusables ${width} light: page errors ${JSON.stringify(errors)}`);
          }
        } finally { await running.close(); }
        continue;
      }
      if (kind === 'built') {
        const running = await startLateServer({ distDir: resolve(repoRoot, dist || 'dist'), seed: seedBuiltBook });
        try {
          for (const width of [1440, 420]) {
            const errors = await lookAtCards(browser, running, { width, theme: 'light', shots });
            if (errors.length) console.error(`built ${width} light: page errors ${JSON.stringify(errors)}`);
          }
        } finally { await running.close(); }
        continue;
      }
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
          for (const width of [1280, 420]) {
            for (const theme of ['dark', 'light']) {
              const errors = await lookAtAi(browser, running, { kind, width, theme, shots });
              if (errors.length) console.error(`${kind} ${width} ${theme} ai: page errors ${JSON.stringify(errors)}`);
            }
          }
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

/**
 * The library shaped like the owner's (134 materials, a sample paper) after a first 复习全书 build, run by the unified runtime with the fake book model: the
 * sample written, the book waiting. -> { jobs }: the snapshot's jobs of that run. The preview has no DSH job executor to run a runtime Job itself, so the 任务
 * console is shown this run's own record (added to the page's snapshot answers at the network edge).
 */
async function seedSample(root) {
  await mkdir(root, { recursive: true });
  const fake = bookModel();
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  try {
    await service.call('snapshot');
    const { sources, decks } = outlineLibrary({ paper: true });
    await service.store.update(state => { state.sources.push(...sources); state.decks.push(...decks); state.focus = { mode: 'class', course: OUTLINE_COURSE, role: '', jd: '', targetTopics: [] }; });
    const { jobId } = await service.call('generation.courseBook.build', { course: OUTLINE_COURSE, language: 'zh' });
    const job = await settleJob(service, jobId);
    if (job.status !== 'complete') throw new Error(`the sample build did not finish: ${job.status}`);
    return { jobId, jobs: (await service.call('snapshot')).jobs };
  } finally { await service.dispose(); }
}

/** The page's snapshot answers carry the seeded run's jobs too (see seedSample). */
const withJobs = (page, jobs) => page.route('**/api/call', async route => {
  let action = '';
  try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
  if (action !== 'snapshot') return route.continue();
  const answer = await route.fetch(), body = await answer.json();
  if (body?.ok && body.value) body.value.jobs = [...jobs, ...(body.value.jobs || [])];
  return route.fulfill({ response: answer, body: JSON.stringify(body) });
});

export async function bookSampleShots({ shots = process.env.BOOK_SAMPLE_SHOTS, dist = process.env.BOOK_DIST } = {}) {
  await mkdir(shots, { recursive: true });
  const browser = await launchChromium(), seen = [];
  const running = await startLateServer({ distDir: resolve(repoRoot, dist || 'dist'), seed: seedSample });
  const built = running.seeded;
  try {
    await running.api('focus.set', { course: OUTLINE_COURSE });
    for (const width of [1440, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900, theme: 'light' });
      try {
        await withJobs(page, built.jobs);
        const name = shot => join(shots, `sample-${width}-${shot}.png`);
        await page.goto(running.server.url);
        await page.locator('.outline-entry').first().click({ timeout: 30000 });
        const card = page.locator('.outline-book-line [data-book-sample]');
        await card.waitFor({ timeout: 30000 });
        await page.mouse.move(width - 10, 890);
        await settleAnimations(page);
        await page.screenshot({ path: name('outline') });
        await card.screenshot({ path: name('card') });
        const primary = await page.locator('.outline-page .sh-btn--primary').allInnerTexts();
        const text = (await card.innerText()).replace(/\s+/g, ' ');
        // The book page: the two written points, the card above the reading.
        await page.locator('.outline-book-line__open').click();
        await page.locator('.book-page [data-book-sample]').waitFor({ timeout: 30000 });
        await page.mouse.move(width - 10, 890);
        await settleAnimations(page);
        await page.screenshot({ path: name('book') });
        // The 任务 console: the build ended and says the book waits for the learner.
        await (await revealNavRow(page, 'tasks')).dispatchEvent('click');
        const row = page.locator('.tc-row', { hasText: '生成复习全书' }).first();
        await row.waitFor({ timeout: 30000 }).catch(async error => { await page.screenshot({ path: name('console-failed') }); throw error; });
        await row.dispatchEvent('click');
        await page.locator('.tc-detail').first().waitFor({ timeout: 30000 });
        await page.mouse.move(width - 10, 890);
        await settleAnimations(page);
        await page.screenshot({ path: name('console'), fullPage: width < 768 });
        const task = (await page.locator('.tc-detail').first().innerText()).replace(/\s+/g, ' ').slice(0, 400);
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        seen.push({ width, primary, card: text, console: task, sideways, errors });
        console.log(JSON.stringify(seen.at(-1)));
      } finally { await context.close(); }
    }
  } finally { await running.close(); await browser.close(); }
  return seen;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (process.env.BOOK_SAMPLE_SHOTS ? bookSampleShots() : bookShots()).catch(error => { console.error(error); process.exitCode = 1; });
}
