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
   - 题型's label is level with its row of boxes at 1440.
   Round 8 (#1084): the course names on a row's facts line.
   - The first course takes the room: a later name is never shown while the first is cut, and a cut never ends on the name's own 「·」.
   - A run of rows reads the same: a name is shown on every row that has one or on none, at 420, 900 and 1440, in the scope and in 全部课程.
   - What a row's facts line shows does not change when the index answer lands (a failed one, an empty one).
   - A name shown whole has no hover card; a cut one says its whole name in the shared Tooltip.
   Round 8 review: which names the rows show is decided once for the scope and the line's width, so scrolling a long list (more rows drawn) changes no
   row; at 320–420 a row's facts read the same before and after the index answer and say the size (cut in its own words if need be); every course a row
   carries is in its checkbox's name, drawn or not.
   Round 10 (rv26): at 320–420 a row has at most one cut piece, a cut ends after a whole part (never on 「·」 or a figure), the line never starts with
   「·」, and in a course scope long notes give way at the line's end, so the other course is said on every row.
   Round 10 review (#1132–#1136): a note is said whole or out of sight (judged by its right edge against the notes' box); 全部课程 keeps every row's format
   beside its course; a size is said whole or not at all, by one rule for the rows of a kind; a course name left out draws no hover anchor.
   Round 11 review (rv30): the characters are decided for the rows of a kind, so one Markdown note no longer takes the Text notes' (en 375–420 全部课程),
   and en 320 says them in their short words; a row with 选择页面 has the facts line of a row without, so dragging the window wider never says less
   (532–540 px); a shortened course ends on a whole word, never inside a figure (「…（202…」). */

const STAMP = '2026-10-01T08:00:00.000Z';
const COURSE = '示例课程 · 设计模式';
const LONG = '分布式系统与网络协议（2026 秋季学期 · 周三晚班）';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    // notes whose size piece grows by a digit (the size is counted from the text): the room left for the course names differs from row to row
    for (const [at, times] of [3, 33, 333, 3333, 33334, 4, 44, 444, 4444, 5, 55, 5555].entries()) {
      state.sources.push({ id: `n${at}`, title: `笔记 ${at + 1}${at % 2 ? '.md' : ''}`, text: '要点。'.repeat(times), createdAt: STAMP, courses: [COURSE, LONG] });
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

/* A list longer than the 24 rows a window draws at first: 30 notes, then PDFs whose format, size and notes are long (drawn only on scroll). */
async function seedLong(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    for (let n = 1; n <= 30; n++) state.sources.push({ id: `m${n}`, title: `第 ${n} 讲 笔记.md`, text: '要点。'.repeat(60), createdAt: STAMP, courses: [COURSE, '网络'] });
    for (const n of [1, 2, 3, 4]) {
      const name = `扫描讲义 ${n}.pdf`;
      for (let page = 1; page <= 3; page++) state.sources.push({ id: `s${n}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：锁。`.repeat(20), createdAt: STAMP, courses: [COURSE, '网络'],
        document: { id: name, filename: name, page, totalPages: 3, extractionVersion: 2, format: 'pdf', warnings: ['complex'], sparseText: true } });
    }
    state.focus = { ...(state.focus || {}), course: COURSE, mode: 'class' };
  });
  service.dispose?.();
}

/* Round 11 (rv30): the reviewer's sample library: a Markdown note, Text notes (one in the long course), and two PDFs with 选择页面 in the long course. */
async function seedKinds(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push({ id: 'k-md', title: '示例 · 设计模式讲义', format: 'md', text: '模式。'.repeat(186) + '模式', createdAt: STAMP, courses: [COURSE] });
    state.sources.push({ id: 'k-case', title: '案例：墨笺笔记应用', text: '笔记。'.repeat(89), createdAt: STAMP, courses: [COURSE] });
    for (const [name, pages] of [['网络协议与分布式系统一致性原理讲义（第二版，含习题与参考答案）.pdf', 4], ['并发编程讲义.pdf', 3]]) {
      for (let page = 1; page <= pages; page++) state.sources.push({ id: `${name}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：线程、锁与死锁。`.repeat(20), createdAt: STAMP,
        courses: [COURSE, LONG], document: { id: name, filename: name, page, totalPages: pages, extractionVersion: 2, format: 'pdf' } });
    }
    state.sources.push({ id: 'k-long', title: 'A very long English lecture title about distributed consensus protocols and their failure modes', text: 'Consensus, quorum and failure. '.repeat(30), createdAt: STAMP, courses: [COURSE, LONG] });
    for (let n = 1; n <= 5; n++) state.sources.push({ id: `k-z${n}`, title: `第 ${n} 讲 一致性原理`, text: '要点。'.repeat(60), createdAt: STAMP, courses: [COURSE] });
    for (let n = 1; n <= 4; n++) state.sources.push({ id: `k-e${n}`, title: `Lecture ${n}: consensus in practice`, text: 'Point. '.repeat(60), createdAt: STAMP, courses: [COURSE] });
    state.focus = { ...(state.focus || {}), course: COURSE, mode: 'class' };
  });
  service.dispose?.();
}

let browser = null, server = null, longServer = null, kindsServer = null, base = null, dist = null, ids = [], skip = '';
before(async () => {
  try { browser = await launchChromium(); } catch (error) { skip = `no Chromium to measure with: ${String(error.message).split('\n')[0]}`; return; }
  scrubProcessEnv();
  dist = await mkdtemp(join(tmpdir(), 'study-generate-margin-dist-'));
  await buildPreview({ outdir: dist });
  base = await mkdtemp(join(tmpdir(), 'study-generate-margin-'));
  await seed(join(base, 'library'));
  server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
  ids = (await previewCall(server, 'snapshot')).sources.map(source => source.id);
  await seedLong(join(base, 'long'));
  longServer = await createPreviewServer({ libraryRoot: join(base, 'long'), home: join(base, 'home-long'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
  await seedKinds(join(base, 'kinds'));
  kindsServer = await createPreviewServer({ libraryRoot: join(base, 'kinds'), home: join(base, 'home-kinds'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
});
after(async () => {
  await browser?.close();
  await server?.close();
  await longServer?.close();
  await kindsServer?.close();
  if (base) await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  if (dist) await rm(dist, { recursive: true, force: true });
});

const answers = (all = ids) => ({
  'no index': { ok: true, value: { indexed: [], stale: [], missing: all, hasIndex: false, canIndex: true, building: null } },
  badges: { ok: true, value: { indexed: all, stale: [], missing: [], hasIndex: true, canIndex: true, building: null } },
});

/** 创建题组 with the index answer held until `release()` (or given at once with `now`). */
async function openGenerate({ lang, theme = 'light', width, height = 860, answer = answers()['no index'], now = true, on = server }) {
  const opened = await openPage(browser, { server: on }, { lang, theme, width, height });
  let release, held = new Promise(done => { release = done; }), asked = false;
  if (now) release();
  await opened.page.route('**/api/call', async route => {
    let action = '';
    try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
    if (action !== 'retrieval.index.coverage') return route.continue();
    asked = true;
    await held;
    if (answer === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'the search server is down' }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) });
  });
  await opened.page.goto(on.url);
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

/**
 * Each row's facts line as a learner sees it: the pieces on its one line that are drawn (not hidden), each with the words it shows. A cut piece shows its
 * words up to the 「…」: the characters (and the unbreakable parts, inline blocks) that end before the ellipsis.
 */
const factsLines = page => page.evaluate(() => {
  const ellipsis = element => { const canvas = document.createElement('canvas').getContext('2d'); canvas.font = getComputedStyle(element).font; return canvas.measureText('…').width; };
  // a part left out of a piece (see-through, out of the line's flow) is not seen (#1134, #1135: the size and the pages give way whole)
  const seen = (element, cut) => {
    const text = [], edge = cut ? element.getBoundingClientRect().right - ellipsis(element) + 0.5 : Infinity;
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1 && Number(getComputedStyle(child).opacity) === 0) continue;
        if (child.nodeType === 3) {
          for (let at = 0; at < child.data.length; at++) {
            const range = document.createRange();
            range.setStart(child, at);
            range.setEnd(child, at + 1);
            const box = range.getBoundingClientRect();
            if (box.right > edge) return false;
            text.push(child.data[at]);
          }
        } else if (getComputedStyle(child).display.startsWith('inline-')) {
          if (child.getBoundingClientRect().right > edge) return false;
          text.push(child.textContent);
        } else if (!walk(child)) return false;
      }
      return true;
    };
    walk(element);
    // round 11: the characters' short words, drawn after the lead from its data-short where the list says them (not in the checkbox's name)
    const after = getComputedStyle(element, '::after');
    if (element.dataset.short && !['none', 'normal'].includes(after.content) && Number(after.opacity) !== 0 && after.position !== 'absolute') text.push(element.dataset.short);
    return text.join('');
  };
  return [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].map(item => {
    const facts = item.querySelector('.source-picker__facts'), line = facts.getBoundingClientRect(), lineHeight = parseFloat(getComputedStyle(facts).height);
    const unseen = piece => { for (let element = piece; element && element !== facts; element = element.parentElement) { const style = getComputedStyle(element); if (style.visibility !== 'visible' || Number(style.opacity) === 0) return true; } return false; };
    const drawn = piece => { const box = piece.getBoundingClientRect(); return box.width > 0 && box.top < line.top + lineHeight / 2 && box.left < line.right - 0.5 && !unseen(piece); };
    // #1133: a piece is cut bare where a box around it that clips (the notes' box, the line) ends before it does: its own box is whole, so its own widths
    // do not show it
    const clipRight = piece => {
      let right = Infinity;
      for (let element = piece.parentElement; element; element = element.parentElement) {
        if (getComputedStyle(element).overflowX !== 'visible') right = Math.min(right, element.getBoundingClientRect().right);
        if (element === facts) break;
      }
      return right;
    };
    const pieces = [...facts.querySelectorAll('.source-picker__fact')].map(piece => {
      const cut = piece.scrollWidth > piece.clientWidth + 0.5, tip = document.getElementById(piece.getAttribute('aria-describedby') || ''), box = piece.getBoundingClientRect();
      return { text: piece.textContent, short: piece.dataset.short || '', name: piece.classList.contains('source-picker__fact--name'), note: piece.classList.contains('source-picker__fact--note'), shown: drawn(piece), cut, seen: seen(piece, cut),
        clipped: box.right > clipRight(piece) + 0.5, tip: tip ? tip.textContent : null, right: box.right };
    });
    const shown = pieces.filter(piece => piece.shown);
    // the first character drawn inside the line (a piece pulled left of the line's start is clipped there)
    let start = '';
    for (const piece of [...facts.querySelectorAll('.source-picker__fact')].filter(element => drawn(element))) {
      const walker = document.createTreeWalker(piece, 4);
      for (let node = walker.nextNode(); node && !start; node = walker.nextNode()) {
        for (let at = 0; at < node.data.length && !start; at++) {
          if (/\s/.test(node.data[at])) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 1);
          const box = range.getBoundingClientRect();
          if (box.width > 0 && box.left >= line.left - 0.5) start = node.data[at];
        }
      }
      if (start) break;
    }
    return { title: item.querySelector('strong').textContent, lead: pieces[0], pieces, names: pieces.filter(piece => piece.name), text: shown.map(piece => piece.seen + (piece.cut ? '…' : '')).join(' '),
      room: line.right - Math.max(...shown.map(piece => piece.right)), start };
  });
});

/**
 * #1134, #1135: what is wrong with the rows' formats and sizes, in words. The format (the lead's first part) is said whole on every row; the pages and the
 * characters are each said whole or left out, never cut (round 11: the characters in their long words or their short ones); and the rows of a kind (the
 * rows with pages; the rows of one format without) say their characters all or none, in one kind of words for the list.
 */
const leadProblems = rows => {
  const bad = [], says = new Map(), words = new Set();
  for (const row of rows) {
    const parts = row.lead.text.split(' · '), [kind] = parts, paged = parts.length > 2, seen = row.lead.seen.trim(), sized = paged ? parts.slice(0, 2).join(' · ') : kind;
    if (!row.lead.shown || !seen.startsWith(kind)) { bad.push(`the format is not said whole: ${row.title}: ${row.text}`); continue; }
    const wholes = [kind, sized, row.lead.text, `${sized}${row.lead.short}`];
    if (row.lead.cut || !wholes.includes(seen)) bad.push(`the size is cut: ${row.title}: ${row.text}`);
    const group = paged ? 'with pages' : `${kind} without pages`;
    if (!says.has(group)) says.set(group, new Set());
    says.get(group).add(seen.length > sized.length);
    if (seen.length > sized.length) words.add(seen === row.lead.text ? 'long' : 'short');
  }
  for (const [group, said] of says) if (said.size > 1) bad.push(`rows ${group} disagree on their characters`);
  if (words.size > 1) bad.push('the list says its characters in two kinds of words');
  return bad;
};

/** 课程范围: 全部课程. */
async function allCourses(page, lang) {
  await page.locator('[data-tour="generate-sources"] .page-scope__select').first().click();
  await page.getByRole('option', { name: lang === 'zh' ? '全部课程' : 'All courses' }).first().click();
  await until(async () => (await factsLines(page)).some(row => row.names.some(name => name.text.includes(COURSE))), `${lang}: 全部课程`);
  await settleAnimations(page);
  await frames(page, 4);
}

test('#1084: a row\'s facts never end in a bare 「· …」 at 420: a name is said whole or left out whole, while the index answer is coming and after it', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  const check = (rows, tag) => {
    assert.ok(rows.length >= 10, `${tag}: rows (${rows.length})`);
    // a name is cut only where it is the shortened course, which then says its whole name on hover
    assert.deepEqual(rows.filter(row => row.names.some(name => name.shown && name.cut && name.tip !== name.text.replace(/^·\s*/, ''))).map(row => row.text), [], `${tag}: no name is cut bare`);
    assert.deepEqual(rows.filter(row => /·\s*…?$/.test(row.text)).map(row => row.text), [], `${tag}: no line ends in 「·」 or 「· …」`);
  };
  for (const lang of ['zh', 'en']) {
    const { page, errors, context, release } = await openGenerate({ lang, width: 420, now: false });
    await frames(page, 4);
    check(await factsLines(page), `${lang} 420, while the answer is coming`);
    release();
    await settleAnimations(page);
    await frames(page, 4);
    check(await factsLines(page), `${lang} 420, answered`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084 round 8: in 全部课程 the first course takes the room: no later name while it is cut, and a cut never ends on its own 「·」', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['zh', 'en']) for (const width of [420, 900, 1440]) {
    const tag = `${lang} ${width} 全部课程`;
    const { page, errors, context } = await openGenerate({ lang, width, answer: answers().badges });
    await allCourses(page, lang);
    const rows = await factsLines(page);
    assert.ok(rows.length >= 10, `${tag}: rows (${rows.length})`);
    for (const row of rows) {
      const [first, ...later] = row.names;
      assert.equal(first.text, `· ${COURSE}`, `${tag}: the course comes first (${row.title})`);
      if (first.shown && first.cut) {
        assert.deepEqual(later.filter(name => name.shown).map(name => name.text), [], `${tag}: no later name while the first is cut (${row.text})`);
        assert.ok(!/·\s*$/.test(first.seen) && first.seen.replace(/^·\s*/, '').length >= 2, `${tag}: the cut shows some of the name and does not end on its own 「·」 (${row.text})`);
      }
    }
    t.diagnostic(`${tag}: ${rows.slice(0, 3).map(row => row.text).join(' | ')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084: one rule for the courses, and a run of rows reads the same: the course 课程范围 names is not said again; another course is said first, whole or shortened, on every row that has one or on none', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['zh', 'en']) for (const width of [420, 900, 1440]) for (const all of [false, true]) {
    const tag = `${lang} ${width}${all ? ' 全部课程' : ''}`;
    const { page, errors, context } = await openGenerate({ lang, width, answer: answers().badges });
    if (all) await allCourses(page, lang);
    await frames(page, 4);
    let rows = await factsLines(page);
    // a cut name's hover card comes with the shared observer's answer (ui/use-cut.js), a few frames later on a busy machine: wait for it, 2 s at most
    for (let wait = 0; wait < 2000 && rows.some(row => row.names.some(piece => piece.shown && piece.cut && !piece.tip)); wait += 100) {
      await page.waitForTimeout(100); rows = await factsLines(page);
    }
    assert.ok(rows.length >= 10, `${tag}: rows (${rows.length})`);
    if (!all) assert.deepEqual(rows.filter(row => row.names.some(name => name.text.replace(/^·\s*/, '') === COURSE)).map(row => row.text), [], `${tag}: no row says the scope's course 「${COURSE}」 again`);
    const firstShown = rows.filter(row => row.names[0]?.shown).length, withLater = rows.filter(row => row.names.length > 1), laterShown = withLater.filter(row => row.names.slice(1).every(name => name.shown)).length;
    t.diagnostic(`${tag}: the first name on ${firstShown}/${rows.length} rows, every later one on ${laterShown}/${withLater.length}: ${rows.slice(0, 3).map(row => row.text).join(' | ')}`);
    for (const row of rows) {
      assert.equal(row.names[0].text, `· ${all ? COURSE : LONG}`, `${tag}: the course outside the scope comes first among the names (${row.text})`);
      for (const name of row.names.filter(piece => piece.shown && piece.cut)) {
        assert.equal(name.tip, name.text.replace(/^·\s*/, ''), `${tag}: a shortened course says its whole name in the shared Tooltip (${row.text})`);
      }
    }
    assert.ok(firstShown === 0 || firstShown === rows.length, `${tag}: the first course is said on every row or on none (${firstShown}/${rows.length}): ${rows.map(row => row.text).join(' | ')}`);
    assert.ok(laterShown === 0 || laterShown === withLater.length, `${tag}: the later names are said on every row or on none (${laterShown}/${withLater.length})`);
    if (width === 1440) assert.ok(rows.every(row => row.names.every(name => name.shown && !name.cut)), `${tag}: with room, every row says its courses whole`);
    if (width === 420 && !all && lang === 'zh') assert.equal(firstShown, rows.length, `${tag}: with room for a shortened course on every row, every row says it`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084 round 8: what a row\'s facts line shows does not change when the index answer lands (a failed one, an empty one)', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const [lang, width, outcome] of [['en', 420, 'fail'], ['en', 420, 'no index'], ['zh', 420, 'fail'], ['en', 900, 'fail']]) {
    const tag = `${lang} ${width} ${outcome}`;
    const { page, errors, context, release } = await openGenerate({ lang, width, now: false, answer: outcome === 'fail' ? 'fail' : answers()[outcome] });
    await frames(page, 4);
    const coming = (await factsLines(page)).map(row => row.text);
    release();
    await until(() => page.evaluate(() => !document.querySelector('[data-tour="generate-sources"] [data-index-slot="held"]')), `${tag}: the answer is in`);
    await settleAnimations(page);
    await frames(page, 4);
    const landed = (await factsLines(page)).map(row => row.text);
    t.diagnostic(`${tag}: ${coming.slice(0, 3).join(' | ')}`);
    assert.deepEqual(landed, coming, `${tag}: the facts lines read the same before and after the answer`);
    // the failed read is the browser's own console line for the 500 the test answers with
    assert.deepEqual(errors.filter(error => !/status of 500/.test(error)), []);
    await context.close();
  }
});

test('#1084 round 8: a name shown whole has no hover card (1440)', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['zh', 'en']) {
    const { page, errors, context } = await openGenerate({ lang, width: 1440, height: 900, answer: answers().badges });
    const rows = await factsLines(page);
    const worded = rows.flatMap(row => row.names.filter(name => name.shown && !name.cut && name.tip));
    assert.deepEqual(worded.map(name => name.text), [], `${lang} 1440: no whole name carries hover words`);
    const name = page.locator('[data-tour="generate-sources"] .source-picker__fact--name').first();
    await name.hover();
    await page.waitForTimeout(600);
    const open = await page.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')].filter(tip => { try { return tip.matches(':popover-open') || (!tip.hidden && tip.getBoundingClientRect().height > 0); } catch { return false; } }).map(tip => tip.textContent));
    assert.deepEqual(open, [], `${lang} 1440: hovering a whole name opens no card`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1082: the estimate under 帮我想想 is as tall while it is coming as when it is in, so the controls under it in 更多选项 do not move when it lands', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const [lang, width] of [['en', 320], ['en', 420], ['zh', 320], ['zh', 420], ['en', 1440]]) {
    const tag = `${lang} ${width}`;
    const { page, errors, context } = await openGenerate({ lang, width, height: 1400 });
    let release, held = new Promise(done => { release = done; });
    await page.route('**/api/call', async route => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* not JSON */ }
      if (body.action === 'usage.estimate' && JSON.stringify(body).includes('"suggest"')) await held;
      return route.fallback();
    });
    // the page again, with the estimate held: it is coming for the first time, as on a fresh visit
    await page.reload();
    await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
    await (await revealNavRow(page, 'generate')).dispatchEvent('click');
    await page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });
    const fold = page.locator('.generate-more').first();
    if (!await fold.evaluate(element => element.open)) await fold.locator(':scope > summary').click();
    const estimate = page.locator('.generate-more__body [data-token-estimate]').first();
    await until(async () => (await estimate.getAttribute('data-status')) === 'loading', `${tag}: the estimate is coming`);
    await frames(page, 3);
    const read = () => page.evaluate(() => ({ box: document.querySelector('.generate-more__body [data-token-estimate]').getBoundingClientRect().height,
      control: document.querySelector('[data-tour="generate-difficulty"] button').getBoundingClientRect().top }));
    const coming = await read();
    release();
    await until(async () => (await estimate.getAttribute('data-status')) === 'ready', `${tag}: the estimate is in`);
    await frames(page, 3);
    const landed = await read();
    t.diagnostic(`${tag}: estimate ${coming.box} → ${landed.box}`);
    assert.ok(Math.abs(landed.box - coming.box) <= 0.5, `${tag}: the estimate keeps its height when it lands (${coming.box} → ${landed.box})`);
    assert.ok(Math.abs(landed.control - coming.control) <= 0.5, `${tag}: 难度 stays where it is (${coming.control} → ${landed.control})`);
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

/** The checkboxes' accessible names, as Chromium computes them for a screen reader (the row's title, its facts and its badge's word). */
async function boxNames(page, count) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-tour="generate-sources"] .source-picker__item input[type="checkbox"]' });
    const names = [];
    for (const nodeId of nodeIds.slice(0, count)) names.push((await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })).nodes[0]?.name?.value ?? '');
    return names;
  } finally { await cdp.detach(); }
}

/** Scroll the list's window to its end (the window then draws more rows) or back to its top. The number of rows drawn. */
const scrollList = (page, { top = false } = {}) => page.evaluate(top => {
  const box = document.querySelector('[data-tour="generate-sources"] .sh-scroll__viewport');
  box.scrollTop = top ? 0 : box.scrollHeight;
  return document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item').length;
}, top);

test('#1084 round 8 review: scrolling a list longer than its first 24 rows changes no row: the names are decided once for the scope and the line\'s width', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const [lang, width] of [['zh', 420], ['en', 420], ['en', 900], ['zh', 900]]) for (const all of [false, true]) {
    const tag = `${lang} ${width}${all ? ' 全部课程' : ''}`;
    const { page, errors, context } = await openGenerate({ lang, width, height: 900, answer: answers().badges, on: longServer });
    if (all) await allCourses(page, lang);
    await frames(page, 4);
    const decided = () => page.evaluate(() => document.querySelector('[data-tour="generate-sources"] .source-picker').dataset.names);
    const first = await decided(), seen = new Map(), later = [];
    const look = async step => {
      assert.equal(await decided(), first, `${tag}, ${step}: the list's decision stays ${first}`);
      for (const row of await factsLines(page)) {
        if (!row.names.length) continue;
        if (!seen.has(row.title)) seen.set(row.title, row.text);
        else if (seen.get(row.title) !== row.text) later.push(`${step}: ${row.title}: "${seen.get(row.title)}" then "${row.text}"`);
        if (all) assert.ok(row.names[0].shown && row.names[0].seen.replace(/^·\s*/, '').length >= 2, `${tag}, ${step}: in 全部课程 every row says its course (${row.title}: ${row.text})`);
      }
    };
    await look('first paint');
    let drawn = 0, still = 0;
    for (let step = 1; step <= 30 && still < 2; step++) {
      const now = await scrollList(page);
      still = now === drawn ? still + 1 : 0;
      drawn = now;
      await page.waitForTimeout(150);
      await frames(page, 3);
      await look(`scrolled ${step}`);
    }
    assert.ok(seen.size >= 34, `${tag}: every row was drawn (${seen.size})`);
    await scrollList(page, { top: true });
    await frames(page, 4);
    await look('back at the top');
    assert.deepEqual(later, [], `${tag}: no row reads differently after scrolling`);
    const rows = [...seen.values()], withCourse = rows.filter(text => /网络|示例课程/.test(text)).length;
    if (!all) assert.ok(withCourse === 0 || withCourse === rows.length, `${tag}: the other course on every row or on none (${withCourse}/${rows.length})`);
    t.diagnostic(`${tag}: data-names=${first}, ${seen.size} rows: ${rows.slice(0, 2).concat(rows.slice(-1)).join(' | ')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084 round 8 review: at 320–420 a row\'s facts read the same before and after the index answer; #1135: they say the format whole and the size whole or not at all, by one rule for the list', { timeout: 900000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['en', 'zh']) for (const width of [320, 360, 375, 390, 420]) for (const outcome of width === 320 ? ['badges', 'no index', 'fail'] : ['badges', 'no index']) {
    const tag = `${lang} ${width} ${outcome}`;
    const { page, errors, context, release } = await openGenerate({ lang, width, now: false, answer: outcome === 'fail' ? 'fail' : answers()[outcome] });
    await frames(page, 4);
    const coming = await factsLines(page);
    release();
    await until(() => page.evaluate(() => !document.querySelector('[data-tour="generate-sources"] [data-index-slot="held"]')), `${tag}: the answer is in`);
    if (outcome === 'badges') await until(async () => (await page.locator('[data-tour="generate-sources"] [data-index-slot] [data-state]').count()) >= 5, `${tag}: the badges`);
    await settleAnimations(page);
    await frames(page, 4);
    const landed = await factsLines(page);
    assert.deepEqual(landed.map(row => row.text), coming.map(row => row.text), `${tag}: the facts lines read the same before and after the answer`);
    // round 8 review asked for the size at 320–420 even cut in its own words; #1135 (round 10 review): 「Markdown · 560 …」, 「Text · 267 charac…」 and
    // 「PDF · 4 pages…」 on three rows read three ways. The size is now said whole or not at all, by one rule for the rows of a kind (a document with pages
    // says its size in pages), and the format is always said whole.
    assert.deepEqual(leadProblems(landed), [], `${tag}: ${landed.slice(0, 3).map(row => row.text).join(' | ')}`);
    t.diagnostic(`${tag}: ${landed.slice(0, 2).map(row => row.text).join(' | ')}`);
    assert.deepEqual(errors.filter(error => !/status of 500/.test(error)), []);
    await context.close();
  }
});

test('#1084 round 8 review: every course a row carries is in its checkbox\'s name at every width, drawn or not', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['zh', 'en']) for (const width of [320, 420, 900, 1440]) {
    const { page, errors, context } = await openGenerate({ lang, width, answer: answers().badges });
    for (const all of [false, true]) {
      const tag = `${lang} ${width}${all ? ' 全部课程' : ''}`;
      if (all) await allCourses(page, lang);
      await frames(page, 4);
      const names = await boxNames(page, 5);
      assert.equal(names.length, 5, `${tag}: five rows`);
      for (const name of names) {
        assert.ok(name.includes(LONG), `${tag}: the other course is in the checkbox's name ("${name}")`);
        if (all) assert.ok(name.includes(COURSE), `${tag}: the course is in the checkbox's name ("${name}")`);
      }
      t.diagnostic(`${tag}: ${names[0]}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* Round 10 (#1084, rv26): at 320–420 a 全部课程 row read 「Text · … · 示例课…」: two cut pieces, the first ending on its own 「·」, and at 420 a size was cut inside
   its figure (「1,12…」). Each piece now shows whole parts: a cut ends after a whole part, and a row has at most one cut piece. */
const cutsOf = row => row.pieces.filter(piece => piece.shown && piece.cut);

test('#1084 round 10: at 320–420, in the scope and in 全部课程, a row has at most one cut piece, a cut ends after a whole part (never on 「·」 or a figure), and the line never starts with 「·」', { timeout: 900000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const on of [server, longServer]) for (const lang of ['en', 'zh']) for (const width of [320, 360, 375, 390, 420]) {
    const { page, errors, context } = await openGenerate({ lang, width, answer: answers().badges, on });
    for (const all of [false, true]) {
      const tag = `${on === server ? 'notes' : 'long'} ${lang} ${width}${all ? ' 全部课程' : ''}`;
      if (all) await allCourses(page, lang);
      await frames(page, 4);
      const rows = await factsLines(page), names = await boxNames(page, 3);
      assert.ok(rows.length >= 10, `${tag}: rows (${rows.length})`);
      const bad = [];
      for (const row of rows) {
        const cuts = cutsOf(row);
        if (cuts.length > 1) bad.push(`two cut pieces: ${row.text}`);
        for (const piece of cuts) {
          if (/(·\s*|\d)$/.test(piece.seen)) bad.push(`cut on 「·」 or a figure: ${row.text}`);
          if (piece.seen.replace(/^·\s*/, '').trim().length < 2) bad.push(`a cut piece shows almost nothing: ${row.text}`);
        }
        if (row.start === '·') bad.push(`starts with 「·」: ${row.text}`);
        // #1133: a note is cut where the notes' box ends before it does (its own box is whole): judged by the right edges
        if (row.pieces.some(piece => piece.note && piece.shown && (piece.cut || piece.clipped))) bad.push(`a note is cut: ${row.text}`);
        if (row.pieces.some(piece => piece.shown && piece.clipped)) bad.push(`a piece is drawn past its box: ${row.text}`);
        if (all && !row.names[0]?.shown) bad.push(`no course in 全部课程: ${row.text}`);
      }
      // #1134, #1135: every row says its format whole (全部课程 too), and its size whole or not at all, by one rule for its kind. 全部课程 says the course
      // alone only where the format would leave it less than 6em (a long format at 320): never above 320
      const decided = await page.evaluate(() => document.querySelector('[data-tour="generate-sources"] .source-picker').dataset.names);
      if (!(all && decided === 'alone')) bad.push(...leadProblems(rows));
      else if (width > 320) bad.push(`全部课程 says the course alone at ${width}`);
      assert.deepEqual(bad, [], `${tag}: ${rows.slice(0, 3).map(row => row.text).join(' | ')}`);
      // what a row leaves out is still in its checkbox's name: the format, size and notes whole, and every course
      rows.slice(0, 3).forEach((row, at) => assert.ok(names[at]?.includes(row.pieces.map(piece => piece.text).join(' ')), `${tag}: the checkbox's name has every fact ("${names[at]}")`));
      t.diagnostic(`${tag}: data-names=${await page.evaluate(() => document.querySelector('[data-tour="generate-sources"] .source-picker').dataset.names)}: ${rows.slice(0, 2).concat(rows.slice(-1)).map(row => row.text).join(' | ')}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084 round 10: in a course scope a row\'s long notes give way, so the other course is said on every row (en 900, zh 420), not left off the whole list', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const [lang, width] of [['en', 900], ['zh', 420]]) {
    const tag = `${lang} ${width}`;
    const { page, errors, context } = await openGenerate({ lang, width, height: 900, answer: answers().badges, on: longServer });
    await frames(page, 4);
    const rows = new Map();
    for (let step = 0, drawn = 0, still = 0; step <= 30 && still < 2; step++) {
      for (const row of await factsLines(page)) rows.set(row.title, row);
      const now = await scrollList(page);
      still = now === drawn ? still + 1 : 0;
      drawn = now;
      await page.waitForTimeout(150);
      await frames(page, 3);
    }
    for (const row of await factsLines(page)) rows.set(row.title, row);
    const all = [...rows.values()];
    assert.ok(all.length >= 34, `${tag}: every row was drawn (${all.length})`);
    const without = all.filter(row => !(row.names[0]?.shown && !row.names[0].cut && row.names[0].text === '· 网络'));
    assert.deepEqual(without.map(row => row.text), [], `${tag}: every row says 「· 网络」 whole`);
    for (const row of all.filter(item => /PDF/.test(item.lead.text))) {
      assert.ok(cutsOf(row).length <= 1 && /^PDF · 3 (页|pages) · \S+ (字符|characters)/.test(row.lead.seen), `${tag}: a long-noted row keeps its format and size, its notes give way ("${row.text}")`);
      assert.ok(!/(·\s*|\d)$/.test(row.lead.seen), `${tag}: the format and size are not cut ("${row.text}")`);
      assert.deepEqual(row.pieces.filter(piece => piece.note && piece.shown && (piece.cut || piece.clipped)).map(piece => piece.text), [], `${tag}: a note is said whole or left out ("${row.text}")`);
    }
    t.diagnostic(`${tag}: ${all[0].text} | ${all.at(-1).text}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/** Every row of the list: scrolled to its end step by step (the window draws more rows as it goes), the rows' facts lines by title. */
async function everyRow(page) {
  const rows = new Map();
  for (let step = 0, drawn = 0, still = 0; step <= 30 && still < 2; step++) {
    for (const row of await factsLines(page)) rows.set(row.title, row);
    const now = await scrollList(page);
    still = now === drawn ? still + 1 : 0;
    drawn = now;
    await page.waitForTimeout(150);
    await frames(page, 3);
  }
  for (const row of await factsLines(page)) rows.set(row.title, row);
  return rows;
}

/* #1132 (round 10 review): at 375–420 the first note of a long-noted row was cut mid-word with no 「…」 (「PDF · 3 pages · 480 characters · littl」,
   「… · 网络 · 文字偏少」): the notes' box clipped it, its own box being whole. A note is said whole or left out of sight, at first paint, when the index
   answer lands late, and after scrolling (#1133: judged by its right edge against the notes' box). */
test('#1132: a row\'s note is said whole or left out of sight at 375–900, in the scope and in 全部课程, before and after a late index answer', { timeout: 900000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['en', 'zh']) for (const width of [375, 420, 900]) for (const all of [false, true]) {
    const tag = `${lang} ${width}${all ? ' 全部课程' : ''}`;
    const { page, errors, context, release } = await openGenerate({ lang, width, height: 900, answer: answers().badges, now: false, on: longServer });
    if (all) await allCourses(page, lang);
    await frames(page, 4);
    const coming = await everyRow(page);
    release();
    await until(() => page.evaluate(() => !document.querySelector('[data-tour="generate-sources"] [data-index-slot="held"]')), `${tag}: the answer is in`);
    await settleAnimations(page);
    await frames(page, 4);
    const landed = await everyRow(page);
    assert.ok(landed.size >= 34, `${tag}: every row was drawn (${landed.size})`);
    const bad = [];
    for (const [title, row] of landed) {
      for (const piece of row.pieces.filter(item => item.shown && (item.clipped || (item.note && item.cut)))) bad.push(`${piece.note ? 'a note' : 'a piece'} is cut bare: ${title}: ${row.text} (${piece.text})`);
      if (coming.has(title) && coming.get(title).text !== row.text) bad.push(`${title}: "${coming.get(title).text}" then "${row.text}"`);
    }
    assert.deepEqual(bad, [], tag);
    const noted = [...landed.values()].filter(row => row.pieces.some(piece => piece.note));
    assert.ok(noted.length >= 4, `${tag}: the long-noted rows were drawn (${noted.length})`);
    t.diagnostic(`${tag}: ${noted.at(-1).text} (${noted.filter(row => row.pieces.some(piece => piece.note && piece.shown)).length}/${noted.length} rows say a note)`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* #1134 (round 10 review): in 全部课程 a list where one row had no room for its format, size and course said the course alone on every row: at en 420
   34 rows read 「操作系统」, though 30 short notes had room for 「Text · 180 characters · 操作系统」. Every row now keeps its format; a document with pages says
   its size in pages, so its characters give way first, and a note keeps its characters where every note has room for them. */
/* Round 14 (rv33): a note's characters no longer take the end of its course in 全部课程: at 420 the notes say their format beside their whole course, and
   their characters from where those fit beside it too. */
test('#1134: 全部课程 at 420 keeps every row\'s format, a PDF\'s pages and the whole course, and a note\'s characters from where they fit beside it', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  for (const lang of ['en', 'zh']) {
    const tag = `${lang} 420 全部课程`;
    const { page, errors, context } = await openGenerate({ lang, width: 420, height: 900, answer: answers().badges, on: longServer });
    await allCourses(page, lang);
    await frames(page, 4);
    const rows = [...(await everyRow(page)).values()];
    assert.ok(rows.length >= 34, `${tag}: every row was drawn (${rows.length})`);
    const bad = leadProblems(rows);
    for (const row of rows) {
      const paged = /PDF/.test(row.lead.text), want = paged ? /^PDF · 3 (页|pages)/ : /^(Text|文本)( · 180 ?(字符|characters|字|chars))?$/;
      if (!want.test(row.lead.seen.trim())) bad.push(`${paged ? 'no pages' : 'no format'}: ${row.title}: ${row.text}`);
      if (!(row.names[0]?.shown && row.names[0].seen.replace(/^·\s*/, '').length >= 2)) bad.push(`no course: ${row.title}: ${row.text}`);
      else if (!paged && row.names[0].cut) bad.push(`a note cuts its course: ${row.title}: ${row.text}`);
    }
    assert.deepEqual(bad, [], tag);
    // a little wider, the notes say their characters too, beside their whole course (by 448 px: a looser bound would let a lost size pass)
    let said = 0;
    for (let width = 424; width <= 448 && !said; width += 8) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page, 3);
      const notes = [...(await everyRow(page)).values()].filter(row => !/PDF/.test(row.lead.text));
      if (notes.every(row => /^(Text|文本) · 180 ?(字符|characters|字|chars)$/.test(row.lead.seen.trim()))) {
        said = width;
        assert.deepEqual(notes.filter(row => row.names[0]?.cut).map(row => row.text), [], `${lang} ${width} 全部课程: the course whole beside the characters`);
      }
    }
    assert.ok(said, `${lang} 全部课程: the notes say their characters again by 448 px (they come back at en 432, zh 424: round 15 asked for a bound that pins it)`);
    t.diagnostic(`${lang}: the notes say their characters from ${said} px`);
    t.diagnostic(`${tag}: data-names=${await page.evaluate(() => document.querySelector('[data-tour="generate-sources"] .source-picker').dataset.names)}: ${rows[0].text} | ${rows.at(-1).text}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* #1136 (round 10 review): a course name the list leaves out ('none') that counted as cut still drew the hover card's anchor (0 wide, a column gap on the
   line, never to open): more elements on every such row. A name left out has no anchor: such a row draws as many elements as at 1440. */
test('#1136: a course name left out of the line draws no hover anchor, so its row has the elements it has at 1440', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  const count = page => page.evaluate(() => [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].map(item => {
    const hidden = element => { for (let at = element; at && at !== item; at = at.parentElement) if (Number(getComputedStyle(at).opacity) === 0) return true; return false; };
    const anchors = [...item.querySelectorAll('.source-picker__fact-anchor')];
    return { title: item.querySelector('strong').textContent, elements: item.querySelectorAll('*').length, idle: anchors.filter(anchor => hidden(anchor.querySelector('[data-name]') || anchor)).length,
      anchors: anchors.length };
  }));
  for (const [lang, width] of [['en', 320], ['en', 420], ['zh', 320], ['zh', 420]]) {
    const tag = `${lang} ${width}`;
    const { page, errors, context } = await openGenerate({ lang, width, answer: answers().badges });
    await frames(page, 4);
    const narrow = await count(page);
    await page.setViewportSize({ width: 1440, height: 860 });
    await frames(page, 6);
    const wide = new Map((await count(page)).map(row => [row.title, row]));
    assert.ok(narrow.length >= 10, `${tag}: rows (${narrow.length})`);
    assert.deepEqual(narrow.filter(row => row.idle).map(row => `${row.title}: ${row.idle}`), [], `${tag}: no anchor around a name left out`);
    const differ = narrow.filter(row => !row.anchors && wide.has(row.title) && row.elements !== wide.get(row.title).elements);
    assert.deepEqual(differ.map(row => `${row.title}: ${row.elements} at ${width}, ${wide.get(row.title).elements} at 1440`), [], `${tag}: a row without a cut name draws what it draws at 1440`);
    t.diagnostic(`${tag}: data-names=${await page.evaluate(() => document.querySelector('[data-tour="generate-sources"] .source-picker').dataset.names)}, elements ${narrow.slice(0, 3).map(row => row.elements).join('/')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* Round 11 (rv30): en 375–420 全部课程, one Markdown note without room for its characters took them from all eleven Text notes; en 320 in the scope no note
   said a size (「Text」 beside 「PDF · 4 pages」). The characters are decided for the rows of a kind, and said in their short words where the long ones
   have no room; the rows of a kind still read alike, and a size is said whole or not at all. Round 14 (rv33): in 全部课程 a note has room for its
   characters only beside its whole course (en 400–420 and zh 375 now say 「Text · 示例课程 · 设计模式」), so there the Text notes say them from en 432 and
   zh 404 on, while the Markdown note still has no room for its own. */
test('round 11: a kind of note that has room for its characters says them, whatever another kind has room for (en/zh 320 scope, en 440–460 and zh 420 全部课程)', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  const all = (await previewCall(kindsServer, 'snapshot')).sources.map(source => source.id);
  for (const [lang, width, everyCourse] of [['en', 320, false], ['zh', 320, false], ['en', 440, true], ['en', 460, true], ['zh', 420, true]]) {
    const tag = `${lang} ${width}${everyCourse ? ' 全部课程' : ''}`;
    const { page, errors, context } = await openGenerate({ lang, width, height: 900, answer: answers(all).badges, on: kindsServer });
    if (everyCourse) await allCourses(page, lang);
    await frames(page, 4);
    const rows = [...(await everyRow(page)).values()];
    assert.ok(rows.length >= 14, `${tag}: every row was drawn (${rows.length})`);
    const notes = rows.filter(row => /^(Text|文本) · /.test(row.lead.text));
    assert.ok(notes.length >= 10, `${tag}: the Text notes (${notes.length})`);
    const bare = notes.filter(row => !/ · \d[\d,]* ?(characters?|字符|chars?|字)$/.test(row.lead.seen.trim()));
    assert.deepEqual(bare.map(row => `${row.title}: ${row.text}`), [], `${tag}: every Text note says its characters`);
    assert.deepEqual(leadProblems(rows), [], `${tag}: ${rows.slice(0, 3).map(row => row.text).join(' | ')}`);
    if (everyCourse) assert.deepEqual(rows.filter(row => !row.names[0]?.shown).map(row => row.text), [], `${tag}: every row says its course`);
    t.diagnostic(`${tag}: ${rows.slice(0, 3).map(row => row.text).join(' | ')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* Round 11 (rv30): at 532–540 px (en) 选择页面 moved up onto the title line, a PDF row's facts line lost its width (327 → 274 px) and the list said less
   while the window grew (first/all → first/unpaged → first/all). The facts line of a row with 选择页面 is now the line of a row without, at every width,
   so a wider window never says less. */
test('round 11: a row with 选择页面 has the facts line of a row without on each side of 532 px, so dragging the window wider never says less', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  const all = (await previewCall(kindsServer, 'snapshot')).sources.map(source => source.id);
  for (const lang of ['en', 'zh']) for (const everyCourse of [false, true]) {
    const tag = `${lang}${everyCourse ? ' 全部课程' : ''}`;
    const { page, errors, context } = await openGenerate({ lang, width: 500, height: 900, answer: answers(all).badges, on: kindsServer });
    if (everyCourse) await allCourses(page, lang);
    let before = null;
    const bad = [];
    for (let width = 500; width <= 600; width += 2) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page, 2);
      const rows = await page.evaluate(() => [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].map(item => ({
        title: item.querySelector('strong').textContent, wide: item.querySelector('.source-picker__row').classList.contains('has-expand'),
        line: item.querySelector('.source-picker__facts').getBoundingClientRect().width })));
      const lines = rows.map(row => row.line), wide = rows.filter(row => row.wide), plain = rows.filter(row => !row.wide);
      if (wide.length && plain.length && Math.max(...lines) - Math.min(...lines) > 0.5) bad.push(`${width}: a row with 选择页面 has ${Math.round(wide[0].line)} px, one without ${Math.round(plain[0].line)} px`);
      // what each row says: its names, then the parts of its lead (the format, the pages, the characters)
      const said = new Map((await factsLines(page)).map(row => [row.title, [row.names.filter(name => name.shown).length, row.lead.seen.trim().split(' · ').length]]));
      if (before && Math.min(...lines) >= before.line - 0.5) {
        for (const [title, [names, lead]] of said) {
          const [wereNames, wereLead] = before.said.get(title) || [0, 0];
          if (names < wereNames || (names === wereNames && lead < wereLead)) bad.push(`${before.width} → ${width}: ${title} says less`);
        }
      }
      before = { width, line: Math.min(...lines), said };
    }
    assert.deepEqual(bad, [], tag);
    t.diagnostic(`${tag}: ${(await factsLines(page)).slice(2, 4).map(row => row.text).join(' | ')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* Round 11 (rv30): the long course was cut inside its figure at the line's end, 「分布式系统与网络协议（202…」. A shortened course ends on a whole word
   (before a space, an opening bracket or a figure after a Chinese word), keeps its 「…」 and its hover card, and the checkbox's name says it as written. */
test('round 11: a shortened course is never cut inside a figure, and its checkbox\'s name says it as written', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  const all = (await previewCall(kindsServer, 'snapshot')).sources.map(source => source.id);
  for (const lang of ['en', 'zh']) {
    const { page, errors, context } = await openGenerate({ lang, width: 480, height: 900, answer: answers(all).badges, on: kindsServer });
    const bad = [];
    let cuts = 0;
    for (let width = 480; width <= 960; width += 4) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page, 2);
      let rows = await factsLines(page);
      // the hover card comes with the shared observer's answer, a frame or two after the cut (ui/use-cut.js), or after the shell's sidebar has finished
      // opening where the window crosses its width (the line keeps changing while it slides)
      for (let wait = 0; wait < 2000 && rows.some(row => row.names.some(piece => piece.shown && piece.cut && !piece.tip)); wait += 200) {
        await page.waitForTimeout(200); rows = await factsLines(page);
      }
      for (const row of rows) {
        for (const name of row.names.filter(piece => piece.shown && piece.cut)) {
          cuts++;
          const whole = name.text, shown = name.seen;
          if (/\d$/.test(shown) && /^\d/.test(whole.slice(shown.length))) bad.push(`${width}: cut inside a figure: ${row.text}`);
          if (!name.tip) bad.push(`${width}: a cut name has no hover card: ${row.text}`);
        }
      }
    }
    assert.ok(cuts > 0, `${lang}: some course was cut`);
    assert.deepEqual(bad.slice(0, 8), [], lang);
    const names = await boxNames(page, 6);
    assert.ok(names.filter(name => name.includes(LONG)).length >= 3, `${lang}: the checkbox's name says the long course as written (${names[2]})`);
    t.diagnostic(`${lang}: ${cuts} cut names checked`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* Round 14 review (rv33): en 420 全部课程 read one course three ways, 「Text · 267 chars · 示例课程…」 beside 「Markdown · 示例课程 · 设计模式」 and 「PDF · 4 pages ·
   示例课程 · 设计模式」: a Text note's characters took the end of its course. In 全部课程 the course is the one fact the scope does not give for a row, so the
   rows of a kind say their characters only where every row of it still says its course as the names alone leave it: none of them cuts its course for them. */
test('round 14: in 全部课程 a kind says its characters only where every row of it keeps its course whole beside them (320–1000, zh/en)', { timeout: 900000 }, async t => {
  if (skip) { t.skip(skip); return; }
  const all = (await previewCall(kindsServer, 'snapshot')).sources.map(source => source.id);
  for (const lang of ['en', 'zh']) {
    const { page, errors, context } = await openGenerate({ lang, width: 320, height: 900, answer: answers(all).badges, on: kindsServer });
    await allCourses(page, lang);
    const bad = [];
    let sized = 0;
    for (let width = 320; width <= 1000; width += 4) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page, 2);
      const rows = await factsLines(page), kinds = new Map();
      for (const row of rows) {
        const parts = row.lead.text.split(' · '), paged = parts.length > 2, said = paged ? parts.slice(0, 2).join(' · ') : parts[0];
        const kind = paged ? 'with pages' : parts[0], course = row.names[0];
        if (!kinds.has(kind)) kinds.set(kind, { chars: false, cut: [] });
        if (row.lead.seen.trim().length > said.length) kinds.get(kind).chars = true;
        if (course && course.shown && course.cut) kinds.get(kind).cut.push(row.text);
      }
      for (const [kind, { chars, cut }] of kinds) {
        if (chars) sized++;
        if (chars && cut.length) bad.push(`${width}: ${kind} rows say their characters while one cuts its course: ${cut[0]}`);
      }
    }
    assert.ok(sized > 0, `${lang}: some kind says its characters`);
    assert.deepEqual(bad.slice(0, 8), [], `${lang} 全部课程 (${bad.length} widths)`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* Round 14 review (rv33): at 1440 the focus ring of 选择页面 (2px at 2px, and a 3px shadow) and its hover fill reached into the 已索引 pill under it on a row
   whose title is one line: the button's box ended where the facts line starts. The button stays at least 24px tall, its words on the title line's middle,
   and neither its box nor its focus ring ever reaches the pill. */
test('round 14: 选择页面\'s box, hover fill and focus ring stay off the 已索引 pill under it (900/1440, zh/en, light/dark)', { timeout: 600000 }, async t => {
  if (skip) { t.skip(skip); return; }
  const all = (await previewCall(kindsServer, 'snapshot')).sources.map(source => source.id);
  const measure = page => page.evaluate(() => {
    const active = document.activeElement;
    return [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].filter(item => item.querySelector('.source-picker__expand')).map(item => {
      const button = item.querySelector('.source-picker__expand'), box = button.getBoundingClientRect(), style = getComputedStyle(button);
      // the title's lines (a grid item is one box: its words' boxes give its lines)
      const title = item.querySelector('strong'), range = document.createRange();
      range.selectNodeContents(title);
      const boxes = [...range.getClientRects()].filter(rect => rect.width > 0), line = boxes[0], lines = new Set(boxes.map(rect => Math.round(rect.top)));
      const facts = item.querySelector('.source-picker__facts').getBoundingClientRect();
      const pill = item.querySelector('[data-index-slot] [data-state]')?.getBoundingClientRect() ?? null;
      const words = document.createRange();
      words.selectNodeContents(button.firstChild?.nodeType === 3 ? button.firstChild : button);
      const text = words.getBoundingClientRect();
      // how far past its box the button draws: the outline (width + offset) and every outer shadow (spread + blur + offset)
      const outline = style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      const shadows = style.boxShadow === 'none' ? [] : style.boxShadow.split(/,(?![^(]*\))/).filter(shadow => !/inset/.test(shadow)).map(shadow => {
        const [x = 0, y = 0, blur = 0, spread = 0] = (shadow.replace(/(rgba?|color-mix|oklch|color)\([^)]*\)/g, '').match(/-?[\d.]+px/g) || []).map(parseFloat);
        return spread + blur + Math.max(Math.abs(x), Math.abs(y));
      });
      return { title: title.textContent, oneLine: lines.size === 1, focused: active === button, height: box.height, bottom: box.bottom, reach: Math.max(0, outline, ...shadows),
        textMiddle: (text.top + text.bottom) / 2, lineMiddle: (line.top + line.bottom) / 2, pillTop: pill?.top ?? null, facts: facts.width };
    });
  });
  for (const [lang, width, theme] of [['zh', 1440, 'light'], ['en', 1440, 'dark'], ['en', 900, 'light'], ['zh', 900, 'dark']]) {
    const tag = `${lang} ${width} ${theme}`;
    const { page, errors, context } = await openGenerate({ lang, theme, width, height: 900, answer: answers(all).badges, on: kindsServer });
    await until(async () => (await page.locator('[data-tour="generate-sources"] [data-index-slot] [data-state]').count()) >= 5, `${tag}: the badges`);
    await frames(page, 4);
    const bad = [];
    const rows = await measure(page);
    assert.ok(rows.some(row => row.oneLine), `${tag}: a row with 选择页面 and a one-line title`);
    const lines = await page.evaluate(() => [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__facts')].map(facts => facts.getBoundingClientRect().width));
    if (Math.max(...lines) - Math.min(...lines) > 0.5) bad.push(`the facts lines differ: ${Math.min(...lines)}–${Math.max(...lines)} px`);
    for (const [at, row] of rows.entries()) {
      if (row.height < 24 - 0.01) bad.push(`${row.title}: 选择页面 is ${row.height} px tall`);
      if (Math.abs(row.textMiddle - row.lineMiddle) > 1) bad.push(`${row.title}: its words are ${row.textMiddle - row.lineMiddle} px off the title line's middle`);
      if (row.pillTop !== null && row.bottom > row.pillTop + 0.01) bad.push(`${row.title}: its box (the hover fill) ends ${row.bottom - row.pillTop} px into the pill`);
      // the keyboard's focus ring, and the pointer's hover
      const item = page.locator('[data-tour="generate-sources"] .source-picker__item').filter({ has: page.locator('.source-picker__expand') }).nth(at);
      await item.locator('input[type="checkbox"]').focus();
      await page.keyboard.press('Tab');
      await frames(page, 2);
      await page.waitForTimeout(250);
      const focused = (await measure(page))[at];
      if (!focused.focused) bad.push(`${row.title}: Tab did not reach 选择页面`);
      else if (focused.pillTop !== null && focused.bottom + focused.reach > focused.pillTop + 0.01) bad.push(`${row.title}: its focus ring reaches ${focused.bottom + focused.reach - focused.pillTop} px into the pill`);
      await page.evaluate(() => document.activeElement?.blur());
      await item.locator('.source-picker__expand').hover();
      await page.waitForTimeout(250);
      const hovered = (await measure(page))[at];
      if (hovered.pillTop !== null && hovered.bottom + hovered.reach > hovered.pillTop + 0.01) bad.push(`${row.title}: hovered, it reaches ${hovered.bottom + hovered.reach - hovered.pillTop} px into the pill`);
      await page.mouse.move(1, 1);
    }
    assert.deepEqual(bad, [], tag);
    t.diagnostic(`${tag}: ${rows.map(row => `${row.title.slice(0, 6)} ${row.height.toFixed(1)}px, ${row.pillTop === null ? 'no pill' : `${(row.pillTop - row.bottom).toFixed(1)}px to the pill`}`).join(' | ')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* Round 14 review (rv33): the whole course reached the checkbox's name through an aria-label on a plain span, which ARIA 1.2 prohibits. The name is the
   same without it: the course as written, once, with no space put into it at a word box's edge. */
test('round 14: no span in the list carries an aria-label, and the checkbox\'s name still says the long course as written', { timeout: 300000 }, async t => {
  if (skip) { t.skip(skip); return; }
  const all = (await previewCall(kindsServer, 'snapshot')).sources.map(source => source.id);
  for (const [lang, width] of [['en', 420], ['zh', 1440]]) {
    const { page, errors, context } = await openGenerate({ lang, width, height: 900, answer: answers(all).badges, on: kindsServer });
    await frames(page, 4);
    assert.equal(await page.locator('[data-tour="generate-sources"] span[aria-label]').count(), 0, `${lang} ${width}: an aria-label on a span`);
    const names = await boxNames(page, 6), long = names.filter(name => name.includes(LONG));
    assert.ok(long.length >= 3, `${lang} ${width}: the long course as written (${names[2]})`);
    for (const name of long) {
      assert.equal(name.split(LONG).length, 2, `${lang} ${width}: said once: ${name}`);
      assert.doesNotMatch(name, /\s{2}|协议 （/, `${lang} ${width}: no space put into it: ${name}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});
