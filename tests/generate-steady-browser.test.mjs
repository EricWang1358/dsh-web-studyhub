/* global document, window, getComputedStyle, NodeFilter, requestAnimationFrame, PerformanceObserver, performance */
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
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { StudyService } from '../lib/service.js';
import { sampleAction } from '../lib/sample-library.js';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* 创建题组, round 4 (#1084, #1082), on the sample library plus three materials (two long titles, a long second course).
   - The page is drawn whole, as on main: no frame shows the header without the ways in, the list and the form, whether the index answer is slow (2 s)
     or fails. Nothing on the page moves after its first frame: the list window has its final height in its first frame, and what stands below it keeps its
     place while the answer comes, with a gap line (「有 N 份资料的索引还没建完」) included; no layout shift is recorded, at 420, 900 and 1440.
   - #1082: a difficulty and a language that are not the defaults (深入辨析, English) are seen on the page with 更多选项 shut.
   - #1082: the bar's count line is one line at 320, 360, 420 and 1440, zh and en, with 1 and 5 ticked: a piece that does not fit is left out whole, nothing of
     it is drawn over the tokens line or above the bar's hairline. */

const STAMP = '2026-10-01T08:00:00.000Z';
const LONG_COURSE = '分布式系统与网络协议（2026 秋季学期 · 周三晚班）';
const LONG_PDF = '网络协议与分布式系统一致性原理讲义（第二版，含习题与参考答案）.pdf';
const LONG_NOTE = 'A very long English lecture title about distributed consensus protocols and their failure modes.md';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await sampleAction({ call: (name, args) => service.call(name, args), store: service.store, has: () => true }, 'sample.load', { language: 'zh' });
  await service.store.update(state => {
    const courses = [state.sampleLibrary.course, LONG_COURSE];
    for (const [name, pages] of [[LONG_PDF, 4], ['并发编程讲义.pdf', 3]]) {
      for (let page = 1; page <= pages; page++) state.sources.push({ id: `${name}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：线程、锁与死锁。`.repeat(20), createdAt: STAMP, courses,
        document: { id: name, filename: name, page, totalPages: pages, extractionVersion: 2, format: 'pdf' } });
    }
    state.sources.push({ id: 'n3', title: LONG_NOTE, text: 'Consensus needs a quorum. '.repeat(30), createdAt: STAMP, courses, chars: 780 });
    state.focus = { ...(state.focus || {}), course: state.sampleLibrary.course, mode: 'class' };
  });
  service.dispose?.();
}

async function start(distDir) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-generate-steady-'));
  const root = join(base, 'library');
  await seed(root);
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir });
  return { server, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

/** The index coverage answered after `delayMs` with `body` (an answer object of /api/call). */
async function answerCoverage(page, body, delayMs = 0) {
  await page.route('**/api/call', async route => {
    let action = '';
    try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
    if (action !== 'retrieval.index.coverage') return route.continue();
    if (delayMs) await new Promise(done => setTimeout(done, delayMs));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function openGenerate(browser, running, options, before) {
  const opened = await openPage(browser, running, options);
  if (before) await before(opened.page);
  await opened.page.goto(running.server.url);
  await opened.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  await (await revealNavRow(opened.page, 'generate')).dispatchEvent('click');
  await opened.page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });
  return opened;
}

/** From the click on 创建题组 on: in every frame, what of the page is drawn and where the parts under the list stand, relative to the page (its own rise is a transform, not a shift); and every layout shift. */
function recordFrames() {
  window.__frames = [];
  window.__shifts = [];
  window.__from = null;
  document.addEventListener('click', event => { if (window.__from === null && event.target.closest?.('[data-tour="nav-generate"]')) window.__from = performance.now(); }, true);
  new PerformanceObserver(list => { for (const entry of list.getEntries()) if (window.__from !== null && !entry.hadRecentInput && entry.value > 0) window.__shifts.push([Math.round(entry.startTime - window.__from), +entry.value.toFixed(4)]); })
    .observe({ type: 'layout-shift', buffered: true });
  const tick = () => {
    const page = document.querySelector('.generate-page');
    if (window.__from !== null && page) {
      const origin = page.getBoundingClientRect().top;
      const at = selector => { const element = document.querySelector(selector); if (!element) return null; const box = element.getBoundingClientRect(); return [Math.round((box.top - origin) * 100) / 100, Math.round(box.height * 100) / 100]; };
      window.__frames.push({ t: Math.round(performance.now() - window.__from), header: !!page.querySelector('.generate-header'), tabs: !!page.querySelector('.source-mode .sh-seg__item'),
        list: !!page.querySelector('[data-tour="generate-sources"] .source-picker__item'), form: !!page.querySelector('[data-tour="generate-options"]'),
        place: { window: at('[data-tour="generate-sources"] .sh-scroll__viewport'), foot: at('[data-tour="generate-sources"] .source-picker__foot'),
          options: at('[data-tour="generate-options"]'), main: at('.generate-page .generate-rows--main'), more: at('.generate-page .generate-more') } });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

test('#1084: the page is drawn whole at once, whatever the index answer, and nothing on it moves after its first frame', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-generate-steady-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    const ids = (await previewCall(running.server, 'snapshot')).sources.map(source => source.id);
    // Two of the long PDF's four pages: a small document with no page built has no badge (documentIndexState), a half-built one has 「部分索引」 and the line.
    const missing = ids.filter(id => id.startsWith(LONG_PDF)).slice(0, 2);
    const answers = {
      'slow (2 s), with a gap': [{ ok: true, value: { indexed: ids.filter(id => !missing.includes(id)), stale: [], missing, hasIndex: true, canIndex: true, building: null } }, 2000],
      'failed': [{ ok: false, error: 'no search component' }, 0],
    };
    const failures = [];
    for (const [lang, width, height] of [['zh', 420, 860], ['zh', 900, 860], ['zh', 1440, 900], ['en', 1440, 900]]) for (const [answer, [body, delayMs]] of Object.entries(answers)) {
      const tag = `${lang} ${width}, ${answer}`;
      const { page, errors, context } = await openGenerate(browser, running, { lang, theme: 'dark', width, height }, async opened => { await opened.addInitScript(recordFrames); await answerCoverage(opened, body, delayMs); });
      await until(() => page.evaluate(() => window.__frames.at(-1)?.t > 2600), `${tag}: the answer and a while after it`, { timeoutMs: 30000 });
      if (answer.startsWith('slow')) await page.locator('[data-tour="generate-sources"] [data-index-gap]').waitFor({ timeout: 10000 }).catch(() => failures.push(`${tag}: no line says the index is not finished`));
      await settleAnimations(page);
      await frames(page, 4);
      const log = await page.evaluate(() => ({ frames: window.__frames, shifts: window.__shifts }));
      const drawn = log.frames.filter(frame => frame.header);
      const half = drawn.filter(frame => !frame.tabs || !frame.list || !frame.form);
      if (half.length) failures.push(`${tag}: ${half.length} frames show the header without the rest (${half[0].t}–${half.at(-1).t} ms after the click)`);
      const steady = drawn.filter(frame => frame.list);
      const first = steady[0];
      for (const [part, place] of Object.entries(first?.place ?? {})) {
        // A quarter of a pixel apart is a move: the page's own rise (a transform) jitters a box by a hundredth of a pixel, which is no move.
        const moved = steady.find(frame => !frame.place[part] !== !place || (place && frame.place[part].some((value, at) => Math.abs(value - place[at]) > 0.25)));
        if (moved) failures.push(`${tag}: ${part} ${JSON.stringify(place)} at ${first.t} ms → ${JSON.stringify(moved.place[part])} at ${moved.t} ms`);
      }
      if (!first?.place.foot) failures.push(`${tag}: no foot row under the list`);
      if (log.shifts.length) failures.push(`${tag}: layout shifts ${JSON.stringify(log.shifts)}`);
      if (errors.length) failures.push(`${tag}: errors ${errors.join(' | ')}`);
      t.diagnostic(`${tag}: first whole frame ${first?.t} ms, ${steady.length} frames, ${failures.filter(line => line.startsWith(tag)).length} failures`);
      await context.close();
    }
    assert.deepEqual(failures, []);
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/** Is `text` drawn somewhere a learner sees it, outside the list of materials (a title may hold the word): in an element with a box, not inside a fold that is shut. */
const seen = (page, text) => page.evaluate(wanted => [...document.querySelectorAll('.generate-page *')].some(element => {
  if (element.closest('[data-tour="generate-sources"]') || ![...element.childNodes].some(node => node.nodeType === 3 && node.data.includes(wanted))) return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && element.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && !element.closest('details:not([open]) > :not(summary)');
}), text);

test('#1082: a difficulty and a language that are not the defaults are seen with 更多选项 shut', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-generate-choices-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const [lang, width, hard, language] of [['zh', 1440, '深入辨析', 'English'], ['zh', 420, '深入辨析', 'English'], ['en', 1440, 'In-depth distinctions', 'Chinese']]) {
      const tag = `${lang} ${width}`;
      const { page, errors, context } = await openGenerate(browser, running, { lang, theme: 'light', width, height: 900 });
      const fold = page.locator('.generate-more').first(), summary = fold.locator(':scope > summary');
      if (!await fold.evaluate(element => element.open)) await summary.click();
      const pick = async (name, label) => page.locator(`[data-tour="generate-${name}"] [role="radio"], [data-tour="generate-${name}"] button`).filter({ hasText: label }).first().click();
      await pick('difficulty', hard);
      await pick('language', language);
      await summary.click();
      await until(() => fold.evaluate(element => !element.open), `${tag}: 更多选项 shut`);
      await settleAnimations(page);
      await frames(page, 3);
      assert.equal(await seen(page, hard), true, `${tag}: the difficulty 「${hard}」 is seen with 更多选项 shut`);
      assert.equal(await seen(page, language), true, `${tag}: the language 「${language}」 is seen with 更多选项 shut`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${tag}: no sideways scroll`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/** The count line of the bar: one line, inside the bar under its hairline and over the tokens line, clipped to itself; and its pieces (between 「·」) each shown whole or not at all. */
const countLine = page => page.evaluate(() => {
  const line = document.querySelector('.generate-summary'), bar = document.querySelector('[data-generate-bar]'), tokens = document.querySelector('[data-generate-estimate]');
  const box = line.getBoundingClientRect(), barBox = bar.getBoundingClientRect(), style = getComputedStyle(line);
  const text = line.textContent, walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT), nodes = [];
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
    if (rects.length && inside.length === rects.length) shown.push(piece);
    else if (inside.length) cut.push(piece);
  }
  return { text, cut, shown, height: box.height, lineHeight: parseFloat(style.lineHeight), clipped: style.overflowY !== 'visible',
    underHairline: box.top >= barBox.top + parseFloat(getComputedStyle(bar).borderTopWidth) - 0.5, overTokens: !tokens || box.bottom <= tokens.getBoundingClientRect().top + 0.5 };
});

test('#1082: the count line is one line from 320 to 1440 px, zh and en, with 1 and 5 ticked: pieces that do not fit are left out whole and nothing leaves the line', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-generate-count-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    const failures = [];
    for (const lang of ['zh', 'en']) for (const width of [320, 360, 420, 1440]) {
      const { page, errors, context } = await openGenerate(browser, running, { lang, theme: 'dark', width, height: width < 600 ? 780 : 900 });
      const boxes = page.locator('[data-tour="generate-sources"] .source-picker__item input[type="checkbox"]');
      const ticked = () => page.locator('[data-tour="generate-sources"] .source-picker__item.is-selected').count();
      const ready = () => page.locator('[data-generate-estimate] [data-token-estimate][data-status="ready"]').count().then(count => count > 0);
      for (let i = 0; i < await boxes.count(); i++) if (await boxes.nth(i).isChecked()) await boxes.nth(i).uncheck();
      for (const count of [1, 5]) {
        const tag = `${lang} ${width}, ${count} ticked`;
        for (let i = 0; i < count; i++) if (!await boxes.nth(i).isChecked()) await boxes.nth(i).check();
        await until(async () => (await ticked()) === count && await ready(), `${tag}: the estimate`, { timeoutMs: 60000 });
        await settleAnimations(page);
        await frames(page, 4);
        const line = await countLine(page);
        if (line.height > line.lineHeight + 0.5) failures.push(`${tag}: the count line is ${line.height} px tall, one line is ${line.lineHeight} px (${line.text})`);
        if (!line.clipped) failures.push(`${tag}: the count line does not clip what it leaves out`);
        if (!line.underHairline || !line.overTokens) failures.push(`${tag}: the count line leaves its place (under the hairline: ${line.underHairline}, over the tokens: ${line.overTokens})`);
        if (line.cut.length) failures.push(`${tag}: pieces cut by the line's edge: ${line.cut.join(' / ')}`);
        if (!new RegExp(lang === 'en' ? `\\b${count} sources?\\b` : `${count} 份资料`).test(line.shown.join(' · '))) failures.push(`${tag}: the line does not show the materials whole (${line.shown.join(' · ')})`);
      }
      if (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) > 0) failures.push(`${lang} ${width}: sideways scroll`);
      if (errors.length) failures.push(`${lang} ${width}: errors ${errors.join(' | ')}`);
      await context.close();
    }
    assert.deepEqual(failures, []);
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
