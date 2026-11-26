/* global document, window, getComputedStyle, requestAnimationFrame */
import test, { after, before } from 'node:test';
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
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* 创建题组, round 5 (#1082, #1084), on a library of notes whose titles grow one character at a time (Chinese and English) and three PDFs with 选择页面.
   - #1084: the index badge's slot is held on every row only while the index answer is coming. Once it is in, a row with a badge keeps a slot as wide as
     its badge, and a row without one (no index, a failed read) gives the slot and its gap back to the facts line. No row changes height either way.
   - #1084: no title leaves one character (or one short word) alone on its last line, at 900 and 1440, zh and en.
   - #1084: the row's checkbox keeps a short name while its badge's card is held open from the keyboard: the card is its description, not its name.
   - #1082: 更多选项 shut says the non-default choices whole (wrapped at a 「·」, never cut inside a word), at 320 and 420; while it is open, picking
     a choice inside it does not move what is under its summary.
   - #1082: the bar's tokens line is never cut inside a word: a piece that does not fit is left out whole (320 to 1440, zh and en). */

const STAMP = '2026-10-01T08:00:00.000Z';
const COURSE = '分布式系统';
const ZH = '分布式系统一致性原理与共识协议的失败模式及其工程实践讲义第二版含习题与参考答案附录';
const EN = 'Distributed consensus protocols and their failure modes in practice with exercises and answers appendix';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    for (let n = 14; n <= 44; n++) state.sources.push({ id: `z${n}`, title: `${String(n).padStart(2, '0')}${ZH.slice(0, n - 2)}.md`, text: '要点。'.repeat(60), createdAt: STAMP, courses: [COURSE], chars: 180 });
    for (let n = 30; n <= 76; n += 3) state.sources.push({ id: `e${n}`, title: `${String(n).padStart(2, '0')} ${EN.slice(0, n - 3)}.md`, text: 'Point. '.repeat(60), createdAt: STAMP, courses: [COURSE], chars: 420 });
    for (const n of [16, 22, 29]) {
      const name = `P${n}${ZH.slice(0, n - 3)}.pdf`;
      for (let page = 1; page <= 3; page++) state.sources.push({ id: `p${n}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：一致性。`.repeat(20), createdAt: STAMP, courses: [COURSE],
        document: { id: name, filename: name, page, totalPages: 3, extractionVersion: 2, format: 'pdf' } });
    }
    state.focus = { ...(state.focus || {}), course: COURSE, mode: 'class' };
  });
  service.dispose?.();
}

let browser = null, server = null, base = null, dist = null, ids = [], skip = '';
before(async () => {
  try { browser = await launchChromium(); } catch (error) { skip = `no Chromium to measure with: ${String(error.message).split('\n')[0]}`; return; }
  scrubProcessEnv();
  dist = await mkdtemp(join(tmpdir(), 'study-generate-polish-dist-'));
  await buildPreview({ outdir: dist });
  base = await mkdtemp(join(tmpdir(), 'study-generate-polish-'));
  await seed(join(base, 'library'));
  server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
  ids = (await previewCall(server, 'snapshot')).sources.map(source => source.id);
});
after(async () => {
  await browser?.close();
  await server?.close();
  if (base) await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  if (dist) await rm(dist, { recursive: true, force: true });
});

const answers = () => {
  const partial = ids.filter(id => id.startsWith('p22-')).slice(0, 2);
  return {
    'no index': { ok: true, value: { indexed: [], stale: [], missing: ids, hasIndex: false, canIndex: true, building: null } },
    'a failed read': { ok: false, error: 'no search component' },
    badges: { ok: true, value: { indexed: ids.filter(id => !partial.includes(id)), stale: [], missing: partial, hasIndex: true, canIndex: true, building: null } },
  };
};

/** 创建题组 with the index answer held until `release()` (or given at once with `now`). */
async function openGenerate({ lang, theme = 'dark', width, height = 860, answer, now = false }) {
  const opened = await openPage(browser, { server }, { lang, theme, width, height });
  let release; const held = new Promise(done => { release = done; }); let asked = false;
  if (now) release();
  await opened.page.route('**/api/call', async route => {
    let action = '';
    try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
    if (action !== 'retrieval.index.coverage') return route.continue();
    asked = true;
    await held;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) });
  });
  await opened.page.goto(server.url);
  await opened.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  await (await revealNavRow(opened.page, 'generate')).dispatchEvent('click');
  await opened.page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });
  await until(() => asked, 'the page to ask for index coverage');
  return { ...opened, release: () => release() };
}

/** The first rows of the list: height, the facts line's end, the title column's end, the slot and the badge. */
const pickerRows = page => page.evaluate(() => [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].slice(0, 10).map(item => {
  const title = item.querySelector('.source-picker__text strong').getBoundingClientRect(), facts = item.querySelector('.source-picker__facts').getBoundingClientRect();
  const slotElement = item.querySelector('[data-index-slot]'), slot = slotElement && getComputedStyle(slotElement).display !== 'none' ? slotElement.getBoundingClientRect() : null;
  const badge = item.querySelector('[data-index-slot] [data-state]')?.getBoundingClientRect() ?? null;
  // how far the format, the size and the notes may run: the piece's end with a long text in it (put back at once, in the same task: nothing is drawn)
  const lead = item.querySelector('.source-picker__fact'), long = document.createTextNode(' ·'.repeat(200));
  lead.append(long);
  const leadEnd = lead.getBoundingClientRect().right;
  long.remove();
  return { title: item.querySelector('strong').textContent.slice(0, 12), height: Math.round(item.getBoundingClientRect().height * 10) / 10, factsRight: facts.right, columnEnd: title.right,
    leadRoom: leadEnd, slot: slot && slot.width > 0 ? { left: slot.left, width: slot.width, right: slot.right } : null,
    badge: badge ? { left: badge.left, width: badge.width, right: badge.right } : null };
}));

test('#1084: at 420 the badge column keeps one width on every row, coming, with a badge and without (round 8); the facts keep their room when the answer lands; no row moves', { timeout: 900000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['zh', 'en']) for (const [answer, body] of Object.entries(answers())) {
    const tag = `${lang} 420, ${answer}`;
    const { page, errors, context, release } = await openGenerate({ lang, width: 420, answer: body });
    await settleAnimations(page);
    await frames(page, 4);
    const loading = await pickerRows(page);
    for (const row of loading) assert.ok(row.slot, `${tag}, while the answer is coming: ${row.title}: the slot is held`);
    release();
    if (answer === 'badges') await until(async () => (await page.locator('[data-tour="generate-sources"] [data-index-slot] [data-state]').count()) >= 10, `${tag}: the badges`);
    await settleAnimations(page);
    await frames(page, 6);
    const settled = await pickerRows(page);
    assert.deepEqual(settled.map(row => row.height), loading.map(row => row.height), `${tag}: no row changes height when the answer comes`);
    // Round 8: the column is as wide on every row before and after the answer, so the names on the facts line keep their room and none comes or goes.
    const width = loading[0].slot.width;
    for (const row of [...loading, ...settled]) assert.ok(row.slot && Math.abs(row.slot.width - width) <= 0.5, `${tag}: ${row.title}: the badges' column is ${width} px (${row.slot?.width})`);
    for (const row of settled) {
      if (row.badge) {
        assert.ok(row.badge.width <= row.slot.width + 0.5 && Math.abs(row.badge.right - row.slot.right) <= 0.5, `${tag}: ${row.title}: the badge ends at the column's end (${row.badge.right} vs ${row.slot.right})`);
        assert.ok(row.factsRight >= row.slot.left - 13, `${tag}: ${row.title}: the facts end by the badge (${Math.round(row.factsRight)} vs the column at ${Math.round(row.slot.left)})`);
      }
    }
    // Round 8 review: a row without a badge does not lend the column to its format, size and notes either, so they have the same room before and after
    // the answer (a size said while the answer is coming is not cut, nor a cut one said whole, when it lands).
    settled.forEach((row, at) => assert.ok(Math.abs(row.leadRoom - loading[at].leadRoom) <= 0.5 && row.leadRoom <= row.slot.left + 0.5,
      `${tag}: ${row.title}: the format, the size and the notes keep their room (${Math.round(loading[at].leadRoom)} then ${Math.round(row.leadRoom)}, the column at ${Math.round(row.slot.left)})`));
    if (answer === 'badges') assert.ok(settled.every(row => row.badge), `${tag}: every row shows its badge`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/** Each title's last line: how many characters it holds and its text. */
const lastLines = page => page.evaluate(async () => {
  const list = document.querySelector('[data-tour="generate-sources"] .source-picker__list');
  let box = list.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  const seen = {};
  const read = () => {
    for (const title of document.querySelectorAll('[data-tour="generate-sources"] .source-picker__text strong')) {
      const node = title.firstChild;
      if (!node || node.nodeType !== 3 || title.getBoundingClientRect().height === 0) continue;
      const tops = [];
      for (let at = 0; at < node.data.length; at++) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        const rect = [...range.getClientRects()].find(r => r.width > 0);
        if (rect) tops.push([Math.round(rect.top), at]);
      }
      const lineTops = [...new Set(tops.map(([top]) => top))].sort((a, b) => a - b);
      const last = tops.filter(([top]) => top === lineTops.at(-1)).map(([, at]) => node.data[at]).join('').trim();
      seen[node.data.slice(0, 12)] = { lines: lineTops.length, last };
    }
  };
  for (let step = 0; step < 80; step++) {
    read();
    if (!box || box.scrollTop + box.clientHeight >= box.scrollHeight - 1) break;
    box.scrollTop += box.clientHeight * 0.6;
    await new Promise(done => setTimeout(done, 120));
  }
  if (box) box.scrollTop = 0;
  return seen;
});

test('#1084: no title leaves one character or one short word alone on its last line, at 900 and 1440, zh and en, with and without 选择页面', { timeout: 900000 }, async t => {
  if (skip) { t.skip(skip); return; }
  const orphans = [];
  for (const lang of ['zh', 'en']) for (const width of [900, 1440]) {
    const { page, errors, context, release } = await openGenerate({ lang, theme: 'light', width, height: 900, answer: answers().badges, now: true });
    release();
    await page.addStyleTag({ content: '.source-picker__entry { content-visibility: visible !important; }' });
    await settleAnimations(page);
    await frames(page, 6);
    const titles = await lastLines(page);
    const wrapped = Object.entries(titles).filter(([, line]) => line.lines > 1);
    for (const [title, line] of wrapped) {
      const words = line.last.split(/\s+/).filter(Boolean);
      const alone = /[一-鿿]/.test(line.last) && !/\s/.test(line.last) ? [...line.last].length <= 1 : words.length === 1 && words[0].length <= 4;
      if (alone) orphans.push(`${lang} ${width}: 「${title}…」 ends on 「${line.last}」 alone`);
    }
    t.diagnostic(`${lang} ${width}: ${Object.keys(titles).length} titles, ${wrapped.length} wrapped`);
    assert.ok(Object.keys(titles).length >= 50, `${lang} ${width}: the whole list is read (${Object.keys(titles).length})`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert.deepEqual(orphans, [], `${orphans.length} orphans`);
});

test('#1084: the row\'s checkbox keeps a short name while the badge\'s card is held open from the keyboard; the card is its description', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['zh', 'en']) {
    const { page, errors, context, release } = await openGenerate({ lang, width: 1440, height: 900, answer: answers().badges, now: true });
    release();
    await until(async () => (await page.locator('[data-tour="generate-sources"] [data-index-slot] [data-state]').count()) >= 5, 'the badges');
    await settleAnimations(page);
    const row = page.locator('[data-tour="generate-sources"] .source-picker__row').first(), box = row.locator('input[type="checkbox"]');
    const closed = await box.ariaSnapshot();
    await page.keyboard.press('Shift');
    await box.focus();
    await until(async () => row.evaluate(element => !!element.querySelector('[data-index-slot] [role="tooltip"]')?.matches(':popover-open')), `${lang}: the card is held open`);
    const open = await box.ariaSnapshot();
    const tip = await row.evaluate(element => { const tooltip = element.querySelector('[data-index-slot] [role="tooltip"]'); return { id: tooltip.id, text: tooltip.textContent.split('\n')[0].trim() }; });
    assert.equal(open, closed, `${lang}: the name is the same with the card open as shut (${open})`);
    assert.ok(!open.includes(tip.text.slice(0, 12)), `${lang}: the card's words are not in the name (${open})`);
    const describedBy = await box.getAttribute('aria-describedby');
    assert.ok((describedBy || '').split(/\s+/).includes(tip.id), `${lang}: the card describes the checkbox (aria-describedby ${describedBy}, card ${tip.id})`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/** 更多选项's summary: its height, its meta's pieces (between 「·」) and whether each is drawn whole inside the summary. With choices the meta also holds the
    hint, hidden while the fold is shut (round 6): the pieces are read from the choices. */
const foldSummary = page => page.evaluate(() => {
  const summary = document.querySelector('.generate-more > summary'), meta = summary.querySelector('.generate-more__choices') ?? summary.querySelector('.sh-disclosure__meta');
  const box = summary.getBoundingClientRect();
  if (!meta || getComputedStyle(meta).display === 'none') return { height: box.height, text: '', pieces: [] };
  const text = meta.textContent, walker = document.createTreeWalker(meta, 4), nodes = [];
  for (let node = walker.nextNode(), at = 0; node; at += node.data.length, node = walker.nextNode()) nodes.push([node, at]);
  const locate = offset => { const found = nodes.findLast(([node, start]) => start <= offset && offset <= start + node.data.length); return [found[0], offset - found[1]]; };
  const pieces = [];
  let from = 0;
  for (const piece of text.split('·').map(part => part.trim()).filter(Boolean)) {
    const at = text.indexOf(piece, from), range = document.createRange();
    from = at + piece.length;
    range.setStart(...locate(at));
    range.setEnd(...locate(at + piece.length));
    const rects = [...range.getClientRects()].filter(r => r.width > 0.5);
    const lines = new Set(rects.map(r => Math.round(r.top))).size;
    const inside = rects.every(r => r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5);
    pieces.push({ piece, whole: rects.length > 0 && inside && lines === 1 });
  }
  const cut = [meta, ...meta.querySelectorAll('*')].filter(element => element.scrollWidth > element.clientWidth + 0.5 && getComputedStyle(element).overflow !== 'visible').map(element => element.textContent);
  return { height: box.height, text, pieces, cut };
});

/** 更多选项's summary and the given control, read once a frame until two frames agree (a layout that is still settling is not measured; no fixed sleep):
    the page's scroll, the summary's top and height, the control's top. */
const steadyFold = (page, control) => page.evaluate(async selector => {
  const read = () => {
    let box = document.querySelector('[data-generate-bar]');
    while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    const summary = document.querySelector('.generate-more > summary').getBoundingClientRect(), target = document.querySelector(selector).getBoundingClientRect();
    return { scroll: (box ?? document.scrollingElement).scrollTop, summaryTop: summary.top, summaryHeight: summary.height, controlTop: target.top, controlBottom: target.bottom };
  };
  const frame = () => new Promise(done => requestAnimationFrame(() => done()));
  let last = read();
  for (let count = 0; count < 120; count++) {
    await frame();
    const now = read();
    if (Object.keys(now).every(key => Math.abs(now[key] - last[key]) < 0.01)) return now;
    last = now;
  }
  return { ...last, unsteady: true };
}, control);

test('#1082: 更多选项 open: picking a visible choice keeps the scroll, summary and control still (tall narrow windows, zh and en); shut, it says each choice whole', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const [lang, width, height] of [['en', 420, 1400], ['zh', 420, 1400], ['en', 320, 1400], ['zh', 320, 1400], ['en', 320, 2400], ['zh', 420, 2400]]) {
    const tag = `${lang} ${width}×${height}`;
    const { page, errors, context, release } = await openGenerate({ lang, width, height, answer: answers()['no index'], now: true });
    let resumePrices;
    try {
      release();
      await settleAnimations(page);
      const fold = page.locator('.generate-more').first(), summary = fold.locator(':scope > summary');
      if (!await fold.evaluate(element => element.open)) await summary.click();
      await settleAnimations(page);
      // A language/difficulty change reprices the nine cells above these controls. Exercise
      // both their pending and completed layouts even when the real server answers quickly.
      const matrix = fold.locator('[data-preset-matrix]');
      const holdPrices = lang === 'en' && width === 420 && height === 1400;
      if (holdPrices) {
        await matrix.and(page.locator('[data-status="ready"]')).waitFor();
        const held = new Promise(resolve => { resumePrices = resolve; });
        await page.route('**/api/call', async route => {
          if (route.request().postDataJSON()?.action === 'usage.estimate') await held;
          return route.fallback();
        });
      }
      // Start at the summary. The lower choices in the expanded form can be more than a screen below it.
      await summary.evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.evaluate(() => { let box = document.querySelector('[data-generate-bar]'); while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement; (box ?? document.scrollingElement).scrollTop -= 60; });
      // 深入辨析, the language that is not the page's own (English on a Chinese page, 中文 on an English one) and 公式（LaTeX）; each one clicked where it is on
      // the screen, as a pointer does. The open summary is its hint's one line, so a pick changes neither its height nor anything under it.
      const choices = [['difficulty', 3], ['language', lang === 'en' ? 0 : 1], ['notation', 2]];
      const start = await summary.boundingBox();
      assert.ok(start.y >= 0 && start.y + start.height <= height, `${tag}: the summary starts in view`);
      for (const [name, at] of choices) {
        const selector = `[data-tour="generate-${name}"] button:nth-of-type(${at + 1})`;
        const choice = page.locator(selector);
        // Scroll to read an off-screen choice before measuring what the selection itself changes.
        await choice.evaluate(element => {
          const barTop = document.querySelector('[data-generate-bar]').getBoundingClientRect().top;
          const bounds = element.getBoundingClientRect();
          if (bounds.top < 0 || bounds.bottom > barTop) element.scrollIntoView({ block: 'center', behavior: 'instant' });
        });
        const before = await steadyFold(page, selector);
        assert.ok(!before.unsteady, `${tag}: the page is still before picking ${name}`);
        if (height === 2400) assert.ok(before.summaryTop >= 0 && before.summaryTop + before.summaryHeight <= height, `${tag}: the summary and ${name} fit together`);
        const bar = await page.locator('[data-generate-bar]').boundingBox();
        assert.ok(before.controlTop >= 0 && before.controlBottom <= bar.y, `${tag}: ${name} is on the screen, clear of the bar (${before.controlTop})`);
        const box = await choice.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await until(() => page.locator(selector).evaluate(element => element.getAttribute('aria-pressed') === 'true' || element.getAttribute('aria-checked') === 'true'), `${tag}: ${name} picked`);
        if (holdPrices && name === 'difficulty') {
          await matrix.and(page.locator('[data-status="loading"]')).waitFor();
          const pending = await steadyFold(page, selector);
          resumePrices();
          for (const key of ['scroll', 'summaryTop', 'summaryHeight', 'controlTop']) {
            assert.ok(Math.abs(pending[key] - before[key]) < 0.5, `${tag}: pending prices keep ${key} still (${before[key]} → ${pending[key]})`);
          }
          await matrix.and(page.locator('[data-status="ready"]')).waitFor();
        }
        const after = await steadyFold(page, selector);
        assert.ok(!after.unsteady, `${tag}: the page settles after picking ${name}`);
        for (const key of ['scroll', 'summaryTop', 'summaryHeight', 'controlTop']) {
          assert.ok(Math.abs(after[key] - before[key]) < 0.5, `${tag}: picking ${name} leaves ${key} where it was (${before[key]} → ${after[key]})`);
        }
      }
      await summary.click();
      await until(() => fold.evaluate(element => !element.open), `${tag}: 更多选项 shut`);
      await settleAnimations(page);
      await frames(page, 3);
      const shut = await foldSummary(page);
      assert.equal(shut.pieces.length, 3, `${tag}: the three choices are said (${shut.text})`);
      assert.deepEqual(shut.pieces.filter(piece => !piece.whole).map(piece => piece.piece), [], `${tag}: every choice is drawn whole, on one line, inside the summary (${shut.text})`);
      assert.deepEqual(shut.cut, [], `${tag}: nothing in the summary is cut`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${tag}: no sideways scroll`);
      assert.deepEqual(errors, []);
    } finally {
      resumePrices?.();
      await context.close();
    }
  }
});

/** The bar's tokens line: its pieces and whether each is drawn whole inside the line, or not at all. */
const tokensLine = page => page.evaluate(() => {
  const line = document.querySelector('[data-generate-estimate]'), box = line.getBoundingClientRect();
  const parts = [...line.querySelectorAll('.token-estimate__line:not(.token-estimate__line--loading) .token-estimate__part')];
  return { text: line.textContent, parts: parts.map(part => {
    const range = document.createRange();
    range.selectNodeContents(part);
    const rects = [...range.getClientRects()].filter(r => r.width > 0.5);
    // a line box wholly inside the line, wholly outside it (left out on the hidden next line), or across its edge (cut)
    const inside = rects.filter(r => r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5);
    const outside = rects.filter(r => r.left >= box.right - 0.5 || r.right <= box.left + 0.5 || r.top >= box.bottom - 0.5 || r.bottom <= box.top + 0.5);
    const ellipsis = part.scrollWidth > part.clientWidth + 0.5;
    return { text: part.textContent, state: rects.length && inside.length === rects.length && !ellipsis ? 'whole' : rects.length && outside.length === rects.length ? 'left out' : 'cut' };
  }) };
});

test('#1082: the bar\'s tokens line is never cut inside a word: a piece that does not fit is left out whole, 320 to 1440, zh and en', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['en', 'zh']) for (const width of [320, 360, 420, 1440]) {
    const tag = `${lang} ${width}`;
    const { page, errors, context, release } = await openGenerate({ lang, width, height: 860, answer: answers()['no index'], now: true });
    release();
    const boxes = page.locator('[data-tour="generate-sources"] .source-picker__item input[type="checkbox"]');
    for (let at = 0; at < 5; at++) await boxes.nth(at).check();
    await until(async () => (await page.locator('[data-generate-estimate] .token-estimate[data-status="ready"]').count()) === 1, `${tag}: the estimate`);
    await settleAnimations(page);
    await frames(page, 3);
    const line = await tokensLine(page);
    assert.ok(line.parts.length >= 1, `${tag}: the tokens are said (${line.text})`);
    assert.equal(line.parts[0].state, 'whole', `${tag}: the token range is drawn whole (${JSON.stringify(line.parts)})`);
    assert.deepEqual(line.parts.filter(part => part.state === 'cut'), [], `${tag}: no piece is cut (${JSON.stringify(line.parts)})`);
    if (width >= 420) assert.ok(line.parts.every(part => part.state === 'whole'), `${tag}: with room, every piece is said (${JSON.stringify(line.parts)})`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
