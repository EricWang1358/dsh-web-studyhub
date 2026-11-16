/* global document, window, getComputedStyle, NodeFilter */
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
     The bar keeps one height and the button one box with 0, 1 and 5 ticked, and the estimate (「预计 … tok」) is in the bar, on the first screen.
   - #1084: at 420 a long title has the row's text column (at least 80% of it), before the index answer and after it. A short row is one title line and one
     line of facts, as on main (67/68 px there). No fact is split across lines (「267 / 字符」). The badge's place ends the title's last line at the column's
     end, its middle on that line's middle, before 选择页面 for the eye and for Tab. Badges arriving change no row height; an answer that brings no badge
     leaves no empty slot and changes no row height either. */

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
    for (const [lang, theme, width, height] of [['zh', 'light', 1440, 900], ['en', 'light', 1440, 900], ['zh', 'dark', 420, 860], ['en', 'dark', 420, 860]]) {
      const tag = `${lang} ${width}`;
      const { page, errors, context } = await openGenerate(browser, running, { lang, theme, width, height });
      const boxes = boxesOf(page);
      for (let i = 0; i < await boxes.count(); i++) if (await boxes.nth(i).isChecked()) await boxes.nth(i).uncheck();
      await until(async () => (await ticked(page)) === 0, `${tag}: nothing ticked`);
      const none = await barBox(page);
      await boxes.nth(0).check();
      await until(async () => (await ticked(page)) === 1 && await estimateReady(page), `${tag}: one ticked and its estimate`, { timeoutMs: 60000 });
      const one = await barBox(page), seenOne = await estimateSeen(page);
      for (let i = 1; i < 5; i++) await boxes.nth(i).check();
      await until(async () => (await ticked(page)) === 5 && /5/.test(await page.locator('.generate-summary').innerText()) && await estimateReady(page), `${tag}: five ticked and their estimate`, { timeoutMs: 60000 });
      const five = await barBox(page), seenFive = await estimateSeen(page);
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
    const titleLines = [...titleRange.getClientRects()].filter(r => r.width > 0.5), lastLine = titleLines.at(-1);
    const facts = [...item.querySelectorAll('.source-picker__text small')].find(small => !small.classList.contains('source-picker__partial'));
    const factRange = textRange(facts), text = facts.textContent;
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
    const slotElement = row.querySelector('[data-index-slot]'), slot = slotElement?.getBoundingClientRect() ?? null, badge = row.querySelector('[data-index-slot] [data-state]')?.getBoundingClientRect() ?? null;
    // what Tab meets in the row, in DOM order, and the same sorted by where the eye meets it (line, then left)
    const focusable = [...row.querySelectorAll('[data-index-slot] [tabindex="0"], .source-picker__expand')].filter(element => element.getBoundingClientRect().width > 0);
    const named = element => element.matches('.source-picker__expand') ? 'expand' : 'badge';
    const seen = [...focusable].sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return Math.abs(ra.top - rb.top) > 4 ? ra.top - rb.top : ra.left - rb.left; });
    const titleLH = parseFloat(getComputedStyle(title).lineHeight), factsLH = parseFloat(getComputedStyle(facts).lineHeight);
    return { title: title.textContent.slice(0, 16), share: t.width / (columnEnd - t.left), lines: titleLines.length ? lineTops(titleRange).length : 0, factLines: lineTops(factRange).length,
      height: item.getBoundingClientRect().height, oneLineHeight: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + titleLH + factsLH,
      below: box.bottom - parseFloat(style.paddingBottom) - Math.max(...parts.map(r => r.bottom)), split, expand: !!row.querySelector('.source-picker__expand'),
      slot: !!slotElement, emptySlot: !!slotElement && !badge,
      slotOnTitleLine: slot && lastLine ? slot.top < lastLine.bottom && slot.bottom > lastLine.top && Math.abs(slot.right - columnEnd) <= 1 : null,
      badgeMiddle: badge && lastLine ? Math.abs((badge.top + badge.bottom) / 2 - (lastLine.top + lastLine.bottom) / 2) : null,
      tabOrder: focusable.map(named).join(' '), eyeOrder: seen.map(named).join(' '),
      badgeFits: badge && slot ? badge.width <= slot.width + 0.5 && badge.height <= slot.height + 0.5 : null, badge: !!badge };
  });
});

const heights = list => list.map(row => Math.round(row.height * 10) / 10);

test('#1084: at 420 a short row is as on main, a long title has the row, no fact splits, and no index answer moves a row or leaves a hole', { timeout: 900000 }, async t => {
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
    for (const lang of ['zh', 'en']) {
      for (const [answer, value] of Object.entries(answers)) {
        const tag = `${lang}, ${answer === 'badges' ? 'badges arrive' : 'no index'}`;
        const { page, errors, context, hold } = await openGenerate(browser, running, { lang, theme: 'dark', width: 420, height: 860, hold: ['retrieval.index.coverage'] });
        await until(() => hold.seen('retrieval.index.coverage'), 'the page to ask for index coverage');
        await settleAnimations(page);
        await frames(page, 4);
        const before = await rows(page);
        hold.release('retrieval.index.coverage', value);
        if (answer === 'badges') await until(async () => (await page.locator('[data-tour="generate-sources"] [data-index-slot] [data-state]').count()) === 5, 'a badge on every row');
        else await until(async () => (await page.locator('[data-tour="generate-sources"] [data-index-slot]').count()) === 0, 'no badge place left once the answer says no index', { timeoutMs: 8000 });
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
            if (row.slot) assert.equal(row.slotOnTitleLine, true, `${where}: the badge's place ends the title's last line, at the column's end`);
            if (row.badge) assert.ok(row.badgeMiddle <= 1, `${where}: the badge sits on the middle of that line (${row.badgeMiddle} px off)`);
            assert.equal(row.tabOrder, row.eyeOrder, `${where}: Tab meets the row's controls in the order they are seen`);
          }
        }
        assert.deepEqual(heights(after), heights(before), `${tag}: no row changes height when the answer arrives`);
        if (answer === 'badges') assert.deepEqual(after.map(row => row.badgeFits), after.map(() => true), `${tag}: every badge fits its place`);
        else assert.deepEqual(after.filter(row => row.emptySlot).map(row => row.title), [], `${tag}: no row keeps an empty place for a badge that cannot come`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${tag}: no sideways scroll`);
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
