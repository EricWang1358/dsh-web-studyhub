/* global document, getComputedStyle */
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

/* 创建题组, round 6 (#1082, #1084): the defects the round-5 review still found.
   - 更多选项 says its hint while it is open, whatever is chosen, and the chosen pieces while it is shut; its summary is as tall open as shut; a wrapped line
     of pieces never starts with 「·」; picking a choice inside it does not move the control under the pointer.
   - The badge's card never says "1 pages" in English.
   - At 320 the form fits its column (zh and en): nothing is drawn past it, and a folded row's summary is never cut bare.
   - At 320 and 360, with nothing ticked, the bar's reason is said whole, and the bar keeps one height for 0, 1 and 5 ticked.
   - A row's facts never end in a bare 「· …」: a name is shown with some of its words or left out whole, while the index answer is coming too.
   - 题型's label is level with its row of boxes at 1440. */

const STAMP = '2026-10-01T08:00:00.000Z';
const COURSE = '分布式系统';
const LONG = '分布式系统与网络协议（2026 秋季学期 · 周三晚班）';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    // notes whose size piece grows by a digit: the room left for the course names goes from plenty to none, row by row
    for (const [at, chars] of [9, 98, 987, 9876, 98765, 987654, 9876543, 12, 345, 6789, 12345, 678901].entries()) {
      state.sources.push({ id: `n${at}`, title: `笔记 ${at + 1}${at % 2 ? '.md' : ''}`, text: '要点。'.repeat(40), createdAt: STAMP, courses: [COURSE, LONG], chars });
    }
    for (const n of [1, 2]) {
      const name = `讲义 ${n}.pdf`;
      for (let page = 1; page <= 3; page++) state.sources.push({ id: `p${n}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：一致性。`.repeat(20), createdAt: STAMP, courses: [COURSE, LONG],
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
  dist = await mkdtemp(join(tmpdir(), 'study-generate-margin-dist-'));
  await buildPreview({ outdir: dist });
  base = await mkdtemp(join(tmpdir(), 'study-generate-margin-'));
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

const answers = () => ({
  'no index': { ok: true, value: { indexed: [], stale: [], missing: ids, hasIndex: false, canIndex: true, building: null } },
  badges: { ok: true, value: { indexed: ids, stale: [], missing: [], hasIndex: true, canIndex: true, building: null } },
});

/** 创建题组 with the index answer held until `release()` (or given at once with `now`). */
async function openGenerate({ lang, theme = 'light', width, height = 860, answer = answers()['no index'], now = true }) {
  const opened = await openPage(browser, { server }, { lang, theme, width, height });
  let release, held = new Promise(done => { release = done; }), asked = false;
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
  await settleAnimations(opened.page);
  return { ...opened, release: () => release() };
}

/** 更多选项's summary: its height, the words it shows (hidden ones left out) and the first character of each line they take. */
const foldSummary = page => page.evaluate(() => {
  const summary = document.querySelector('.generate-more > summary'), meta = summary.querySelector('.sh-disclosure__meta');
  const shown = node => { for (let element = node.parentElement; element && element !== summary; element = element.parentElement) { const style = getComputedStyle(element); if (style.visibility === 'hidden' || style.display === 'none') return false; } return true; };
  const words = [], starts = [];
  if (meta) {
    const walker = document.createTreeWalker(meta, 4);
    let lineTop = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!shown(node)) continue;
      words.push(node.data);
      for (let at = 0; at < node.data.length; at++) {
        if (/\s/.test(node.data[at])) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        const rect = [...range.getClientRects()].find(r => r.width > 0);
        if (!rect) continue;
        if (lineTop === null || Math.abs(rect.top - lineTop) > 2) { starts.push(node.data[at]); lineTop = rect.top; }
      }
    }
  }
  return { height: summary.getBoundingClientRect().height, text: words.join('').replace(/\s+/g, ' ').trim(), starts };
});

/** The room between 更多选项's summary and its first group's title (「想练什么」): the summary's own band, which a hidden line must not widen. */
const bandUnderSummary = page => page.evaluate(() => {
  const summary = document.querySelector('.generate-more > summary').getBoundingClientRect(), title = document.querySelector('.generate-more .generate-group__title').getBoundingClientRect();
  return { summary: summary.height, band: title.top - summary.bottom };
});

test('#1082: 更多选项 open says its hint on one line whatever is chosen (no empty band under it), shut says the chosen pieces, and no line of pieces starts with 「·」', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  const hints = { en: 'Focus, difficulty, cost, extras', zh: '想练什么、难度、花费、额外要求' };
  for (const [lang, width] of [['en', 420], ['en', 320], ['zh', 420], ['zh', 320]]) {
    const tag = `${lang} ${width}`;
    const { page, errors, context } = await openGenerate({ lang, width });
    const fold = page.locator('.generate-more').first(), summary = fold.locator(':scope > summary');
    if (await fold.evaluate(element => element.open)) { await summary.click(); await until(() => fold.evaluate(element => !element.open), `${tag}: shut`); }
    await settleAnimations(page);
    const shutPlain = await foldSummary(page);
    await summary.click();
    await settleAnimations(page);
    const openPlain = await foldSummary(page), bandPlain = await bandUnderSummary(page);
    assert.ok(Math.abs(openPlain.height - shutPlain.height) <= 0.5, `${tag}: with nothing chosen, open ${openPlain.height} = shut ${shutPlain.height}`);
    for (const [name, at] of [['difficulty', 3], ['language', lang === 'en' ? 0 : 1], ['notation', 2]]) {
      await page.locator(`[data-tour="generate-${name}"] button`).nth(at).click();
      await frames(page, 4);
      const now = await foldSummary(page), band = await bandUnderSummary(page);
      assert.ok(now.text.includes(hints[lang].slice(0, 8)), `${tag}: open, after picking ${name}, the summary says its hint ("${now.text}")`);
      // the open summary is the hint's one line: what is chosen (hidden while open) adds no empty band above 「想练什么」
      assert.ok(Math.abs(now.height - openPlain.height) <= 0.5, `${tag}: open, after picking ${name}, the summary is as tall as with nothing chosen (${now.height} vs ${openPlain.height})`);
      assert.ok(Math.abs(band.band - bandPlain.band) <= 0.5, `${tag}: open, after picking ${name}, the room under the summary is unchanged (${band.band} vs ${bandPlain.band})`);
    }
    await summary.click();
    await until(() => fold.evaluate(element => !element.open), `${tag}: shut`);
    await settleAnimations(page);
    const shutPicked = await foldSummary(page);
    assert.ok(!shutPicked.text.includes(hints[lang].slice(0, 8)), `${tag}: shut, the summary says the chosen pieces, not the hint ("${shutPicked.text}")`);
    assert.equal(shutPicked.text.split('·').filter(piece => piece.trim()).length, 3, `${tag}: shut, three pieces ("${shutPicked.text}")`);
    assert.deepEqual(shutPicked.starts.filter(start => start === '·'), [], `${tag}: no line starts with 「·」 (${shutPicked.starts.join('')}: "${shutPicked.text}")`);
    await summary.click();
    await settleAnimations(page);
    const reopened = await foldSummary(page);
    assert.ok(Math.abs(reopened.height - openPlain.height) <= 0.5, `${tag}: reopened ${reopened.height} = open with nothing chosen ${openPlain.height}`);
    assert.ok(reopened.text.includes(hints[lang].slice(0, 8)), `${tag}: reopened, the hint ("${reopened.text}")`);
    t.diagnostic(`${tag}: plain ${shutPlain.height}/${openPlain.height}, chosen shut ${shutPicked.height} / open ${reopened.height}: "${shutPicked.text}"`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084: the badge\'s card counts one page in the singular (en)', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  const { page, errors, context } = await openGenerate({ lang: 'en', width: 1440, height: 900, answer: answers().badges });
  await until(async () => (await page.locator('[data-tour="generate-sources"] [data-index-slot] [data-state]').count()) >= 5, 'the badges');
  const cards = await page.evaluate(() => [...document.querySelectorAll('[data-tour="generate-sources"] [data-index-slot] [role="tooltip"]')].map(tip => tip.textContent));
  assert.ok(cards.length >= 5, `cards (${cards.length})`);
  const plural = cards.filter(text => /\b1 pages\b/.test(text));
  assert.deepEqual(plural, [], `no card says "1 pages"`);
  assert.ok(cards.some(text => /\b1 page\b/.test(text)), `a one-page note says "1 page" (${cards[0]})`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('#1082: at 320 the form fits its column, zh and en, and no summary in it is cut bare', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['en', 'zh']) {
    const { page, errors, context } = await openGenerate({ lang, width: 320 });
    const fold = page.locator('.generate-more').first();
    if (!await fold.evaluate(element => element.open)) await fold.locator(':scope > summary').click();
    await settleAnimations(page);
    const fit = await page.evaluate(() => {
      const form = document.querySelector('[data-tour="generate-options"]'), column = form.getBoundingClientRect();
      const past = [...form.querySelectorAll('*')].filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.right > column.right + 0.5; })
        .map(element => `${element.className || element.tagName}: ${Math.round(element.getBoundingClientRect().right - column.right)}px`);
      const bare = [...form.querySelectorAll('summary, summary *')].filter(element => element.getBoundingClientRect().width > 0 && element.scrollWidth > element.clientWidth + 0.5
        && getComputedStyle(element).overflow !== 'visible' && getComputedStyle(element).textOverflow !== 'ellipsis').map(element => element.textContent.slice(0, 30));
      const tall = [...form.querySelectorAll('.generate-more__body .sh-disclosure__meta')].filter(meta => meta.getBoundingClientRect().height > parseFloat(getComputedStyle(meta).lineHeight) * 1.5).map(meta => meta.textContent);
      return { past, bare, tall };
    });
    assert.deepEqual(fit.past, [], `${lang} 320: nothing is drawn past the column`);
    assert.deepEqual(fit.bare, [], `${lang} 320: no summary is cut without 「…」`);
    assert.deepEqual(fit.tall, [], `${lang} 320: a folded row's note is one line`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1082: at 320 and 360, with nothing ticked, the bar says why whole, and keeps one height for 0, 1 and 5 ticked', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['en', 'zh']) for (const width of [320, 360]) {
    const tag = `${lang} ${width}`;
    const { page, errors, context } = await openGenerate({ lang, width });
    const clear = page.locator('[data-tour="generate-sources"] .source-picker__actions button').nth(1);
    if (await clear.count()) await clear.click();
    await until(async () => (await page.locator('[data-generate-bar] .generate-submit__note').count()) === 1, `${tag}: the reason`);
    await frames(page, 3);
    const bar = () => page.evaluate(() => document.querySelector('[data-generate-bar]').getBoundingClientRect().height);
    const reason = await page.evaluate(() => { const note = document.querySelector('[data-generate-bar] .generate-submit__note'); return { text: note.textContent, cut: note.scrollWidth > note.clientWidth + 0.5 || note.scrollHeight > note.clientHeight + 0.5 }; });
    assert.ok(reason.text.length > 4, `${tag}: a reason (${reason.text})`);
    assert.equal(reason.cut, false, `${tag}: the reason is said whole ("${reason.text}")`);
    const heights = [await bar()];
    const boxes = page.locator('[data-tour="generate-sources"] .source-picker__item input[type="checkbox"]');
    await boxes.nth(0).check();
    await until(async () => (await page.locator('[data-generate-bar] .generate-summary').count()) === 1, `${tag}: one ticked`);
    await frames(page, 3);
    heights.push(await bar());
    for (let at = 1; at < 5; at++) await boxes.nth(at).check();
    await frames(page, 3);
    heights.push(await bar());
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 0.5, `${tag}: one bar height for 0, 1 and 5 ticked (${heights.join(', ')})`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084: a row\'s facts never end in a bare 「· …」 at 420: a name is said whole or left out whole, while the index answer is coming and after it', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  // what each row's facts line shows: the pieces on its one line, and which of them are cut
  const shown = page => page.evaluate(() => [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__facts')].map(facts => {
    const line = facts.getBoundingClientRect();
    const pieces = [...facts.children].filter(piece => { const box = piece.getBoundingClientRect(); return box.width > 0 && box.top < line.bottom - 1 && box.left < line.right - 0.5; });
    // A course the scope does not name may be shortened (round 7): it then keeps its least width, ends in 「…」 and says its whole name on hover.
    const visible = pieces.map(piece => ({ text: piece.textContent, name: piece.classList.contains('source-picker__fact--name'),
      cut: piece.scrollWidth > piece.clientWidth + 0.5 || piece.getBoundingClientRect().right > line.right + 0.5,
      shortened: piece.classList.contains('source-picker__fact--short') && getComputedStyle(piece).textOverflow === 'ellipsis' && piece.title === piece.textContent.replace(/^·\s*/, '')
        && piece.getBoundingClientRect().right <= line.right + 0.5 && piece.getBoundingClientRect().width >= parseFloat(getComputedStyle(piece).minWidth) - 0.5 }));
    return { text: visible.map(piece => piece.text + (piece.cut ? '…' : '')).join(' '), cutNames: visible.filter(piece => piece.name && piece.cut && !piece.shortened).map(piece => piece.text) };
  }));
  const check = (rows, tag) => {
    assert.ok(rows.length >= 10, `${tag}: rows (${rows.length})`);
    assert.deepEqual(rows.filter(row => row.cutNames.length).map(row => row.text), [], `${tag}: no name is cut bare`);
    assert.deepEqual(rows.filter(row => /·\s*…?$/.test(row.text)).map(row => row.text), [], `${tag}: no line ends in 「·」 or 「· …」`);
  };
  for (const lang of ['zh', 'en']) {
    const { page, errors, context, release } = await openGenerate({ lang, width: 420, now: false });
    await frames(page, 4);
    check(await shown(page), `${lang} 420, while the answer is coming`);
    release();
    await settleAnimations(page);
    await frames(page, 4);
    check(await shown(page), `${lang} 420, answered`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084: every row follows one rule for its courses: the course 课程范围 names is not said again, another course is said first, whole or shortened, and left out only where there is no room for it', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  const rowsOf = page => page.evaluate(([course, long]) => [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__facts')].map(facts => {
    const line = facts.getBoundingClientRect(), gap = parseFloat(getComputedStyle(facts).columnGap) || 0;
    const onLine = piece => { const box = piece.getBoundingClientRect(); return box.width > 0 && box.top < line.bottom - 1; };
    const names = [...facts.querySelectorAll('.source-picker__fact--name')], other = names.find(piece => piece.textContent.includes(long));
    const shown = [...facts.children].filter(onLine), lastRight = Math.max(...shown.map(piece => piece.getBoundingClientRect().right));
    return { text: shown.map(piece => piece.textContent).join(' '), repeats: names.some(piece => piece.textContent.replace(/^·\s*/, '') === course && onLine(piece)),
      firstName: names[0]?.textContent.replace(/^·\s*/, '') ?? '', other: other ? { shown: onLine(other), cut: other.scrollWidth > other.clientWidth + 0.5, title: other.title,
        least: parseFloat(getComputedStyle(other).minWidth) || other.scrollWidth } : null, room: line.right - lastRight - gap };
  }), [COURSE, LONG]);
  for (const lang of ['zh', 'en']) for (const width of [420, 1440]) {
    const tag = `${lang} ${width}`;
    const { page, errors, context } = await openGenerate({ lang, width });
    await frames(page, 4);
    const scope = await page.evaluate(() => document.querySelector('[data-tour="generate-sources"] [data-page-scope] button, [data-tour="generate-sources"] .page-scope button, [data-tour="generate-sources"] select')?.textContent ?? '');
    const rows = await rowsOf(page);
    assert.ok(rows.length >= 10, `${tag}: rows (${rows.length})`);
    t.diagnostic(`${tag}: scope "${scope.slice(0, 40)}"; ${rows.filter(row => row.other?.shown).length}/${rows.length} say ${LONG.slice(0, 6)}…`);
    assert.deepEqual(rows.filter(row => row.repeats).map(row => row.text), [], `${tag}: no row says the scope's course 「${COURSE}」 again`);
    for (const row of rows) {
      assert.equal(row.firstName, LONG, `${tag}: the course outside the scope comes first among the names (${row.text})`);
      if (row.other.shown && row.other.cut) assert.equal(row.other.title, LONG, `${tag}: a shortened course says its whole name on hover (${row.text})`);
      if (!row.other.shown) assert.ok(row.room < row.other.least + 0.5, `${tag}: a course is left out only where its least width does not fit (room ${row.room.toFixed(1)}, least ${row.other.least}): ${row.text}`);
    }
    if (width === 1440) assert.ok(rows.every(row => row.other.shown && !row.other.cut), `${tag}: with room, every row says the other course whole`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1082: at 1440 with nothing ticked, the bar\'s reason is level with the button', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['zh', 'en']) {
    const { page, errors, context } = await openGenerate({ lang, width: 1440, height: 900 });
    const clear = page.locator('[data-tour="generate-sources"] .source-picker__actions button').nth(1);
    if (await clear.count()) await clear.click();
    await until(async () => (await page.locator('[data-generate-bar] .generate-submit__note').count()) === 1, `${lang}: the reason`);
    await frames(page, 3);
    const level = await page.evaluate(() => {
      const note = document.querySelector('[data-generate-bar] .generate-submit__note'), button = document.querySelector('[data-generate-bar] [data-tour="generate-submit"]');
      const range = document.createRange();
      range.selectNodeContents(note);
      const lines = [...range.getClientRects()].filter(r => r.width > 0.5), top = Math.min(...lines.map(r => r.top)), bottom = Math.max(...lines.map(r => r.bottom)), box = button.getBoundingClientRect();
      return (top + bottom) / 2 - (box.top + box.height / 2);
    });
    assert.ok(Math.abs(level) <= 1, `${lang} 1440: the reason's middle is level with the button's (${level.toFixed(1)}px)`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1082: 题型\'s label is level with its row of boxes at 1440', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['en', 'zh']) {
    const { page, errors, context } = await openGenerate({ lang, width: 1440, height: 900 });
    const level = await page.evaluate(() => {
      const row = document.querySelector('[data-tour="generate-kinds"]'), label = row.querySelector('.generate-row__label'), first = row.querySelector('.generate-kind').firstElementChild;
      const range = document.createRange();
      range.selectNodeContents(label);
      const text = range.getClientRects()[0], box = first.getBoundingClientRect();
      return (text.top + text.height / 2) - (box.top + box.height / 2);
    });
    assert.ok(Math.abs(level) <= 1, `${lang} 1440: the label's middle is level with the first box's (${level.toFixed(1)}px)`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
