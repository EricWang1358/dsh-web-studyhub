/* global document, window, getComputedStyle, NodeFilter, requestAnimationFrame */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, holdActions, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { StudyService } from '../lib/service.js';
import { sampleAction } from '../lib/sample-library.js';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* 创建题组 on the sample library (its course is 「示例课程 · 设计模式」) plus three materials: two with long titles, and those three also in a long second
   course, so their facts are long too (#1082, #1084).
   - #1082: with all five ticked, 生成并检查题组 is on the first screen at 1440×900 (zh, en) and at 420: one primary in view, nothing on top of it, and
     Tab through the form never puts the focused control under the bar that holds it. At the end of the page the bar is back in its place.
     The bar keeps one height and the button one box with 0, 1 and 5 ticked, and the estimate (「预计 … tok」) is in the bar, on the first screen. Its count
     line is never cut inside a word, at 360, 420 and 1440, in zh and en; on a narrow page the bar is lighter than the 120 px of round 2; its top hairline
     reads in both themes.
   - #1084: at 420 a long title has the row's text column (at least 80% of it), whether the index answer came before the rows were drawn or after. A short
     row is one title line and one line of facts, as on main (67/68 px there). No fact is split across lines (「267 / 字符」). Every row has the badge's
     slot at the end of its facts line, at the row's end, its badge's middle on that line's middle; Tab meets the row's controls in the order they are
     seen. An answer that comes at once or late fills the slots and no row changes height; a late badge is shown like one that came at once (round 4).
     The title-length sweep is tests/generate-picker-sweep-browser.test.mjs; the page as a whole is tests/generate-steady-browser.test.mjs. */

const STAMP = '2026-10-01T08:00:00.000Z';
const LONG_COURSE = '分布式系统与网络协议（2026 秋季学期 · 周三晚班）';
const LONG_PDF = '网络协议与分布式系统一致性原理讲义（第二版，含习题与参考答案）.pdf';
const LONG_NOTE = 'A very long English lecture title about distributed consensus protocols and their failure modes.md';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await sampleAction({ call: (name, args) => service.call(name, args), store: service.store, has: () => true }, 'sample.load', { language: 'zh' });
  let course = '';
  await service.store.update(state => {
    course = state.sampleLibrary.course;
    const courses = [course, LONG_COURSE];
    for (const [name, pages] of [[LONG_PDF, 4], ['并发编程讲义.pdf', 3]]) {
      for (let page = 1; page <= pages; page++) state.sources.push({ id: `${name}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：线程、锁与死锁。`.repeat(20), createdAt: STAMP, courses,
        document: { id: name, filename: name, page, totalPages: pages, extractionVersion: 2, format: 'pdf' } });
    }
    state.sources.push({ id: 'n3', title: LONG_NOTE, text: 'Consensus needs a quorum. '.repeat(30), createdAt: STAMP, courses, chars: 780 });
    state.focus = { ...(state.focus || {}), course, mode: 'class' };
  });
  service.dispose?.();
  return course;
}

async function start(distDir) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-generate-reach-'));
  const root = join(base, 'library');
  const course = await seed(root);
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir });
  return { server, course, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

async function openGenerate(browser, running, options) {
  const opened = await openPage(browser, running, options);
  const hold = options.hold ? await holdActions(opened.page, options.hold) : null;
  // an answer given here is let through as soon as it is asked for
  if (hold && options.answer !== undefined) for (const action of options.hold) hold.release(action, options.answer);
  await opened.page.goto(running.server.url);
  await opened.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  await (await revealNavRow(opened.page, 'generate')).dispatchEvent('click');
  await opened.page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });
  return { ...opened, hold };
}

/** The scrolling box of the page (the app's shell scrolls, not the document). */
const scrollTo = (page, where) => page.evaluate(to => {
  const button = document.querySelector('[data-tour="generate-submit"]');
  for (let node = button.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) { node.scrollTop = to === 'end' ? node.scrollHeight : 0; return true; }
  }
  document.scrollingElement.scrollTop = to === 'end' ? document.scrollingElement.scrollHeight : 0;
  return false;
}, where);

/** Where the one button is, whether something else is drawn on it, and how many primaries are in view. */
const reach = page => page.evaluate(() => {
  const button = document.querySelector('[data-tour="generate-submit"]'), box = button.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  const inView = element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight; };
  const primaries = [...document.querySelectorAll('.generate-page .sh-btn--primary')].filter(inView).length;
  const count = document.querySelector('.generate-summary')?.getBoundingClientRect();
  return { top: box.top, bottom: box.bottom, vh: window.innerHeight, onTop: !!hit && button.contains(hit), primaries,
    countInView: !!count && count.top >= 0 && count.bottom <= window.innerHeight };
});

/** Wait until the focused control stops moving: a row of the list is scrolled into its window a few frames after Tab (a row drawn on demand, #205),
 *  and only where it lands counts. */
const focusSettled = page => page.evaluate(() => new Promise(done => {
  let last = '', still = 0, left = 30;
  const tick = () => {
    const box = document.activeElement?.getBoundingClientRect(), now = box ? `${Math.round(box.top)},${Math.round(box.left)}` : '';
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 3 || --left <= 0) done(); else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));

const boxesOf = page => page.locator('[data-tour="generate-sources"] .source-picker__item input[type="checkbox"]');
const ticked = page => page.locator('[data-tour="generate-sources"] .source-picker__item.is-selected').count();
const estimateReady = page => page.locator('[data-generate-estimate] [data-token-estimate][data-status="ready"]').count().then(count => count > 0);

/** The count line of the bar: whether a word is cut by its edge (a piece of it partly in the line's box and partly out), whether it runs out sideways, and
 *  the pieces it shows whole. A piece is what lies between 「·」 (a narrow line may leave whole pieces out, never half of one). */
const countLine = page => page.evaluate(() => {
  const line = document.querySelector('.generate-summary');
  if (!line) return null;
  const box = line.getBoundingClientRect(), text = line.textContent;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT), nodes = [];
  for (let node = walker.nextNode(), at = 0; node; at += node.data.length, node = walker.nextNode()) nodes.push([node, at]);
  const rangeOf = (from, to) => {
    const locate = offset => { const found = nodes.findLast(([node, start]) => start <= offset && offset <= start + node.data.length); return [found[0], offset - found[1]]; };
    const range = document.createRange();
    range.setStart(...locate(from));
    range.setEnd(...locate(to));
    return range;
  };
  const cut = [], shown = [];
  let from = 0;
  for (const piece of text.split('·').map(part => part.trim()).filter(Boolean)) {
    const at = text.indexOf(piece, from);
    from = at + piece.length;
    const rects = [...rangeOf(at, at + piece.length).getClientRects()].filter(r => r.width > 0.5);
    const inside = rects.filter(r => r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5);
    const outside = rects.filter(r => r.top >= box.bottom - 0.5 || r.left >= box.right - 0.5);
    if (rects.length && inside.length === rects.length) shown.push(piece);
    else if (outside.length !== rects.length) cut.push(piece);
  }
  return { cut, shown, overflow: line.scrollWidth - line.clientWidth, text };
});

/** How far the bar's top hairline stands out from the ground it is drawn on: the contrast ratio of the two colours as composited. */
const hairline = page => page.evaluate(() => {
  const rgba = value => (value.match(/[\d.]+/g) || []).map(Number);
  const ground = element => { for (let node = element; node; node = node.parentElement) { const [r, g, b, a = 1] = rgba(getComputedStyle(node).backgroundColor); if (a > 0.5) return [r, g, b]; } return [255, 255, 255]; };
  const bar = document.querySelector('[data-generate-bar]'), style = getComputedStyle(bar), below = ground(bar);
  const [r, g, b, a = 1] = rgba(style.borderTopColor), line = [r, g, b].map((value, i) => value * a + below[i] * (1 - a));
  const luminance = colour => colour.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [luminance(line), luminance(below)].sort((x, y) => y - x);
  return { width: parseFloat(style.borderTopWidth), contrast: (hi + 0.05) / (lo + 0.05) };
});

test('#1082: with five materials ticked, 生成并检查题组 is on the first screen, alone, uncovered, and Tab never hides a control under it', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-generate-reach-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const [lang, theme, width, height] of [['zh', 'light', 1440, 900], ['en', 'light', 1440, 900], ['zh', 'dark', 420, 860]]) {
      const tag = `${lang} ${width}`;
      const { page, errors, context } = await openGenerate(browser, running, { lang, theme, width, height });
      const boxes = boxesOf(page);
      assert.equal(await boxes.count(), 5, `${tag}: five materials`);
      for (let i = 0; i < 5; i++) await boxes.nth(i).check();
      await until(async () => (await ticked(page)) === 5, 'all five ticked');
      await until(() => estimateReady(page), 'the estimate', { timeoutMs: 60000 });
      await scrollTo(page, 'top');
      await settleAnimations(page);
      await frames(page, 4);
      const first = await reach(page);
      assert.ok(first.top >= 0 && first.bottom <= first.vh, `${tag}: the button is on the first screen (${Math.round(first.top)}–${Math.round(first.bottom)} of ${first.vh})`);
      assert.equal(first.onTop, true, `${tag}: nothing is drawn over the button`);
      assert.equal(first.primaries, 1, `${tag}: one primary in view`);
      assert.equal(first.countInView, true, `${tag}: the one-line count is in view with it`);

      // Tab from the first material to the button: every control on the way is in view and not under the bar
      await boxes.first().focus();
      const covered = [];
      for (let step = 0; step < 80; step++) {
        const state = await page.evaluate(() => {
          const active = document.activeElement, bar = document.querySelector('[data-tour="generate-submit"]').closest('[data-generate-bar]') || document.querySelector('[data-tour="generate-submit"]');
          if (active?.matches('[data-tour="generate-submit"]') || !document.querySelector('.generate-page form')?.contains(active)) return { done: true };
          const r = active.getBoundingClientRect(), b = bar.getBoundingClientRect();
          return { done: false, under: r.bottom > b.top + 1 && r.top < b.bottom - 1 && !bar.contains(active), name: (active.getAttribute('aria-label') || active.textContent || active.tagName).trim().slice(0, 24) };
        });
        if (state.done) break;
        if (state.under) covered.push(state.name);
        await page.keyboard.press('Tab');
        await focusSettled(page);
      }
      assert.deepEqual(covered, [], `${tag}: no focused control sits under the bar`);

      // at the end of the page the bar is in its place: above what the run asks for and the note about the checks, which nothing covers
      await scrollTo(page, 'end');
      await frames(page, 4);
      const end = await page.evaluate(() => {
        const button = document.querySelector('[data-tour="generate-submit"]').getBoundingClientRect(), run = document.querySelector('[data-generate-run]');
        const after = run.getBoundingClientRect(), last = run.lastElementChild.getBoundingClientRect();
        const hit = document.elementFromPoint(last.left + 4, last.top + last.height / 2);
        return { button: button.bottom, run: after.top, runOnTop: !!hit && run.contains(hit) };
      });
      assert.ok(end.button <= end.run, `${tag}: at the end the button stands above the rest of the form (${end.button} ≤ ${end.run})`);
      assert.equal(end.runOnTop, true, `${tag}: and nothing covers it`);
      assert.equal((await reach(page)).primaries, 1, `${tag}: one primary in view at the end too`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${tag}: no sideways scroll`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/** The bar's height and the button's box (0.5 px), with the page at its top, so the bar is the one held at the bottom of the view. */
const barBox = async page => {
  await scrollTo(page, 'top');
  await settleAnimations(page);
  await frames(page, 4);
  return page.evaluate(() => {
    const half = value => Math.round(value * 2) / 2;
    const bar = document.querySelector('[data-generate-bar]').getBoundingClientRect(), button = document.querySelector('[data-tour="generate-submit"]').getBoundingClientRect();
    return { bar: half(bar.height), button: [half(button.left), half(button.top), half(button.width), half(button.height)] };
  });
};

/** The estimate line: in the view, not under anything, and saying the tokens. */
const estimateSeen = page => page.evaluate(() => {
  const element = document.querySelector('[data-generate-estimate]');
  if (!element) return { inView: false, onTop: false, text: '' };
  const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.left + Math.min(8, box.width / 2), box.top + box.height / 2);
  return { inView: box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight, onTop: !!hit && element.contains(hit), text: element.innerText.trim(), top: Math.round(box.top) };
});

test('#1082: the bar keeps one height and the button one place with 0, 1 and 5 ticked, and the estimate is in the bar on the first screen', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-generate-bar-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const [lang, theme, width, height] of [['zh', 'light', 1440, 900], ['en', 'light', 1440, 900], ['zh', 'dark', 420, 860], ['en', 'dark', 420, 860], ['zh', 'dark', 360, 780], ['en', 'dark', 360, 780]]) {
      const tag = `${lang} ${width}`;
      const { page, errors, context } = await openGenerate(browser, running, { lang, theme, width, height });
      const boxes = boxesOf(page);
      for (let i = 0; i < await boxes.count(); i++) if (await boxes.nth(i).isChecked()) await boxes.nth(i).uncheck();
      await until(async () => (await ticked(page)) === 0, `${tag}: nothing ticked`);
      const none = await barBox(page);
      await boxes.nth(0).check();
      await until(async () => (await ticked(page)) === 1 && await estimateReady(page), `${tag}: one ticked and its estimate`, { timeoutMs: 60000 });
      const one = await barBox(page), seenOne = await estimateSeen(page), countOne = await countLine(page);
      for (let i = 1; i < 5; i++) await boxes.nth(i).check();
      await until(async () => (await ticked(page)) === 5 && /5/.test(await page.locator('.generate-summary').innerText()) && await estimateReady(page), `${tag}: five ticked and their estimate`, { timeoutMs: 60000 });
      const five = await barBox(page), seenFive = await estimateSeen(page), countFive = await countLine(page);
      for (const [count, line] of [[1, countOne], [5, countFive]]) {
        assert.deepEqual(line.cut, [], `${tag}, ${count} ticked: no word of the count line is cut by its edge (${line.text})`);
        assert.ok(line.overflow <= 0, `${tag}, ${count} ticked: the count line does not run out sideways (${line.overflow} px)`);
        assert.match(line.shown.join(' · '), lang === 'en' ? new RegExp(`\\b${count} (?:materials?|sources?)\\b`) : new RegExp(`${count} 份资料`), `${tag}, ${count} ticked: the line shows how many materials, whole (${line.shown.join(' · ')})`);
      }
      const seam = await hairline(page);
      assert.ok(seam.width >= 1 && seam.contrast >= 1.2, `${tag}, ${theme}: the bar's top hairline reads against the page (contrast ${seam.contrast.toFixed(2)})`);
      if (width < 600) assert.ok(none.bar <= 112, `${tag}: the bar is lighter than round 2's 120 px (${none.bar} px)`);
      assert.deepEqual([one.bar, five.bar], [none.bar, none.bar], `${tag}: the bar is as tall with 0, 1 and 5 ticked`);
      assert.deepEqual([one.button, five.button], [none.button, none.button], `${tag}: the button has one box with 0, 1 and 5 ticked`);
      for (const [count, seen] of [[1, seenOne], [5, seenFive]]) {
        assert.match(seen.text, /tok/, `${tag}, ${count} ticked: the estimate says the tokens (${seen.text})`);
        assert.equal(seen.inView && seen.onTop, true, `${tag}, ${count} ticked: the estimate is on the first screen and uncovered (top ${seen.top})`);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/** Per row: its lines, height, the empty band under it, where the badge's place is, what Tab meets and in what order the eye meets it, split facts. */
const rows = page => page.evaluate(() => {
  const textRange = (element, from = 0, to = null) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes = [];
    let length = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push([node, length]); length += node.data.length; }
    const locate = offset => { const found = nodes.findLast(([node, start]) => start <= offset && offset <= start + node.data.length) || nodes[0]; return [found[0], offset - found[1]]; };
    const range = document.createRange();
    range.setStart(...locate(from));
    range.setEnd(...locate(to ?? length));
    return range;
  };
  // the lines a range is drawn on: its boxes grouped by their middles (a Latin and a CJK run on one line have different tops, never middles 6 px apart)
  const lineTops = range => [...range.getClientRects()].filter(r => r.width > 0.5).map(r => (r.top + r.bottom) / 2).sort((a, b) => a - b)
    .reduce((lines, middle) => (lines.length && middle - lines.at(-1) < 6 ? lines : [...lines, middle]), []);
  return [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].map(item => {
    const row = item.querySelector('.source-picker__row'), style = getComputedStyle(row), box = row.getBoundingClientRect();
    const columnEnd = box.right - parseFloat(style.paddingRight);
    const title = item.querySelector('.source-picker__text strong'), titleRange = textRange(title), t = titleRange.getBoundingClientRect();
    const titleLines = [...titleRange.getClientRects()].filter(r => r.width > 0.5).sort((a, b) => a.top - b.top);
    const facts = item.querySelector('.source-picker__facts') ?? [...item.querySelectorAll('.source-picker__text small')].find(small => !small.classList.contains('source-picker__partial'));
    const factRange = textRange(facts), text = facts.textContent, firstLine = [...factRange.getClientRects()].filter(r => r.width > 0.5).sort((a, b) => a.top - b.top)[0];
    // every piece between 「 · 」 on one line, unless it is wider than the column itself
    const split = [];
    let from = 0;
    for (const piece of text.split(' · ')) {
      const at = text.indexOf(piece, from), range = textRange(facts, at, at + piece.length);
      from = at + piece.length;
      const width = [...range.getClientRects()].reduce((sum, r) => sum + r.width, 0);
      if (lineTops(range).length > 1 && width < columnEnd - t.left) split.push(piece);
    }
    const parts = [...row.querySelectorAll('.source-picker__text strong, .source-picker__text small, .source-picker__expand, [data-index-slot], [data-index-slot] [data-state]')]
      .map(element => element.getBoundingClientRect()).filter(r => r.height > 0);
    // a slot that is not drawn (no badge once the answer is in, round 5) is no slot
    const slotElement = row.querySelector('[data-index-slot]'), slot = slotElement && getComputedStyle(slotElement).display !== 'none' ? slotElement.getBoundingClientRect() : null, badge = row.querySelector('[data-index-slot] [data-state]')?.getBoundingClientRect() ?? null;
    // what Tab meets in the row, in DOM order, and the same sorted by where the eye meets it (line, then left)
    const focusable = [...row.querySelectorAll('[data-index-slot] [tabindex="0"], .source-picker__expand')].filter(element => element.getBoundingClientRect().width > 0);
    const named = element => element.matches('.source-picker__expand') ? 'expand' : 'badge';
    const seen = [...focusable].sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return Math.abs(ra.top - rb.top) > 4 ? ra.top - rb.top : ra.left - rb.left; });
    const titleLH = parseFloat(getComputedStyle(title).lineHeight), factsLH = parseFloat(getComputedStyle(facts).lineHeight);
    // The facts' first line box (the slot is that line's height; a glyph's own box is a little shorter).
    const factsTop = facts.getBoundingClientRect().top, factLine = firstLine ? { top: Math.min(factsTop, firstLine.top), bottom: Math.min(factsTop, firstLine.top) + factsLH } : null;
    return { title: title.textContent.slice(0, 16), share: t.width / (columnEnd - t.left), lines: titleLines.length ? lineTops(titleRange).length : 0,
      // the lines drawn: a name that does not fit goes whole on to a next line the facts' one-line height hides (round 6), which is not a line the row shows
      factLines: lineTops(factRange).filter(middle => middle < facts.getBoundingClientRect().bottom).length,
      height: item.getBoundingClientRect().height, oneLineHeight: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + titleLH + factsLH,
      below: box.bottom - parseFloat(style.paddingBottom) - Math.max(...parts.map(r => r.bottom)), split, expand: !!row.querySelector('.source-picker__expand'),
      slot: !!slot, factsEnd: Math.round(facts.getBoundingClientRect().right * 10) / 10, columnEnd: Math.round(columnEnd * 10) / 10,
      slotPlace: slot && factLine ? [slot.top, slot.bottom, slot.right, factLine.top, factLine.bottom, columnEnd].map(v => Math.round(v * 10) / 10).join(' ') : '',
      slotOnFactsLine: slot && factLine ? slot.top >= factLine.top - 1 && slot.bottom <= factLine.bottom + 1 && Math.abs(slot.right - columnEnd) <= 1 : null,
      badgeMiddle: badge && firstLine ? Math.abs((badge.top + badge.bottom) / 2 - (firstLine.top + firstLine.bottom) / 2) : null,
      tabOrder: focusable.map(named).join(' '), eyeOrder: seen.map(named).join(' '),
      badgeFits: badge && slot ? badge.width <= slot.width + 0.5 && badge.height <= slot.height + 0.5 : null, badge: !!badge };
  });
});

const heights = list => list.map(row => Math.round(row.height * 10) / 10);

test('#1084: at 420 a short row is as on main, a long title has the row, no fact splits, and no index answer, at once or late, moves a row or leaves a hole', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-generate-rows420-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    const ids = (await previewCall(running.server, 'snapshot')).sources.map(source => source.id);
    const partial = ids.filter(id => id.startsWith(LONG_PDF)).slice(0, 2);
    const answers = {
      badges: { indexed: ids.filter(id => !partial.includes(id)), stale: [], missing: partial, hasIndex: true, canIndex: true, building: null },
      none: { indexed: [], stale: [], missing: ids, hasIndex: false, canIndex: true, building: null },
    };
    for (const lang of ['zh', 'en']) for (const late of [false, true]) {
      for (const [answer, value] of Object.entries(answers)) {
        const tag = `${lang}, ${answer === 'badges' ? 'badges' : 'no index'} ${late ? 'late' : 'at once'}`;
        // at once: the answer is let through as soon as it is asked for; late: it is held until the rows are drawn
        const { page, errors, context, hold } = await openGenerate(browser, running, { lang, theme: 'dark', width: 420, height: 860, hold: ['retrieval.index.coverage'], answer: late ? undefined : value });
        await until(() => hold.seen('retrieval.index.coverage'), 'the page to ask for index coverage');
        await settleAnimations(page);
        await frames(page, 4);
        const before = await rows(page);
        const answered = late ? page.waitForResponse(response => response.url().endsWith('/api/call') && (response.request().postData() || '').includes('retrieval.index.coverage')) : null;
        if (late) hold.release('retrieval.index.coverage', value);
        if (late) await answered;
        // at once or late, every row shows its badge
        if (answer === 'badges') await until(async () => (await page.locator('[data-tour="generate-sources"] [data-index-slot] [data-state]').count()) === 5, 'a badge on every row');
        await settleAnimations(page);
        await frames(page, 6);
        const after = await rows(page);
        for (const [when, list] of [['before the answer', before], ['after it', after]]) {
          for (const row of list) {
            const where = `${tag}, ${when}: ${row.title}`;
            if (row.lines > 1 || row.title.startsWith('网络') || row.title.startsWith('A very')) assert.ok(row.share >= 0.8, `${where}: the title has ${Math.round(row.share * 100)}% of the text column`);
            if (!row.expand && row.lines === 1 && /^(示例|案例)/.test(row.title)) {
              assert.equal(row.factLines, 1, `${where}: a short row's facts are one line`);
              assert.ok(row.height <= row.oneLineHeight + 4, `${where}: a short row is one title line and one line of facts (${row.height} ≤ ${row.oneLineHeight} + the gap)`);
            }
            assert.deepEqual(row.split, [], `${where}: no fact is split across lines`);
            assert.ok(row.below <= 1, `${where}: ${Math.round(row.below)}px of empty band under the content`);
            // while the answer is coming every row holds the slot; once it is in, every row keeps it, badge or none (round 8: the names on the facts line keep
            // their room when the answer lands; a row without a badge lends it to its format and size only)
            if (when === 'before the answer' && late) assert.equal(row.slot, true, `${where}: the slot is held while the answer is coming`);
            if (when === 'after it') assert.equal(row.slot, true, `${where}: the slot is kept, badge or none`);
            if (row.slot) assert.equal(row.slotOnFactsLine, true, `${where}: the badge's slot ends the facts' first line, at the row's end (slot top, bottom, right; line top, bottom; column end: ${row.slotPlace})`);
            else assert.ok(Math.abs(row.factsEnd - row.columnEnd) <= 1, `${where}: with no slot the facts take the column (${row.factsEnd} vs ${row.columnEnd})`);
            if (row.badge) assert.ok(row.badgeMiddle <= 1, `${where}: the badge sits on the middle of that line (${row.badgeMiddle} px off)`);
            assert.equal(row.tabOrder, row.eyeOrder, `${where}: Tab meets the row's controls in the order they are seen`);
          }
        }
        assert.deepEqual(heights(after), heights(before), `${tag}: no row changes height when the answer arrives`);
        assert.deepEqual(after.filter(row => row.badge && !row.badgeFits).map(row => row.title), [], `${tag}: every badge fits its place`);
        if (answer === 'badges') assert.ok(after.every(row => row.badge), `${tag}: every row shows its badge, late or not`);
        if (answer === 'badges') {
          // the badge is no Tab stop: the row's checkbox, focused from the keyboard, opens the badge's card (one forceOpen decision, ui/components/Tooltip.jsx)
          await page.keyboard.press('Shift');
          await page.locator('[data-tour="generate-sources"] .source-picker__row').first().locator('input[type="checkbox"]').focus();
          await frames(page, 3);
          const shown = await page.locator('[data-tour="generate-sources"] .source-picker__row').first().evaluate(row => !!row.querySelector('[data-index-slot] [role="tooltip"]')?.matches(':popover-open'));
          assert.equal(shown, true, `${tag}: the keyboard-focused row's badge shows its card`);
          // another badge hovered: one card on screen, never two
          await page.locator('[data-tour="generate-sources"] .source-picker__row').nth(1).locator('[data-index-slot] [data-state]').hover();
          await page.waitForTimeout(700);
          const cards = await page.evaluate(() => [...document.querySelectorAll('[data-tour="generate-sources"] [data-index-slot] [role="tooltip"]')].filter(tip => tip.matches(':popover-open')).length);
          assert.ok(cards <= 1, `${tag}: ${cards} badge cards are on screen at once`);
          await page.mouse.move(0, 0);
          // Esc shuts a keyboard-opened card while the checkbox keeps its focus
          await page.keyboard.press('Shift');
          await page.locator('[data-tour="generate-sources"] .source-picker__row').nth(2).locator('input[type="checkbox"]').focus();
          await frames(page, 3);
          await page.keyboard.press('Escape');
          await frames(page, 3);
          const still = await page.locator('[data-tour="generate-sources"] .source-picker__row').nth(2).evaluate(row => !!row.querySelector('[data-index-slot] [role="tooltip"]')?.matches(':popover-open'));
          assert.equal(still, false, `${tag}: Esc closes the keyboard-opened badge card`);
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${tag}: no sideways scroll`);
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
