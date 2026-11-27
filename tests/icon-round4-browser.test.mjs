/* global document, getComputedStyle, OffscreenCanvas, createImageBitmap, fetch, matchMedia */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { StudyService } from '../lib/service.js';
import { sampleAction } from '../lib/sample-library.js';
import { confirmStartIfAsked } from '../scripts/qa/confirm-start.mjs';

/* #1073 / #1074, round 4 of the review of PR #1118, measured in a real browser on the sample course (and on a library with one material of the learner's own):
     3  the tick and cross of an answer are as heavy as the bold label beside them (stroke measured on a 2x screenshot: Regular was 0.9px against 2px);
     4  the skeleton station's 「学这一站 · 3 题 →」 keeps the Button's gap before its arrow (it was 0px, 2.5px high), and the 练 N 题 of the points end in it;
     2  the home selection bar's primary ends in the arrow and leads with nothing;
     5  every 再添加资料 is one colour (ink, never the cinnabar of the one primary) and one icon size, on the first-run line and on the home;
     6  the first-run card's step 2 in the sample state is never cut, in zh and en, at 1440 and 420px;
     8  at 420px the English deck row's title is not cut by its play slot.
   And round 5: at 420px an idle row has no invisible play slot, and the ways in of the sample state's home row are one colour and one size.
   ICON_ROUND4_SHOTS=<dir> keeps a screenshot of each place. */

const SHOTS = process.env.ICON_ROUND4_SHOTS || '';
const ARROW = 'M220.24,132.24';

async function seedSample(root, lang) {
  const service = new StudyService(root);
  await service.call('snapshot');
  await sampleAction({ call: (name, input) => service.call(name, input), store: service.store, has: () => true }, 'sample.load', { language: lang });
  // One question of the sample becomes a multiple-answer one at the front of its deck, so practice reaches an answered multi at once.
  await service.store.update((state) => {
    const deck = state.decks.find((entry) => entry.cards?.some((card) => card.kind === 'quiz'));
    const multi = deck.cards.find((card) => card.kind === 'quiz');
    multi.kind = 'multi';
    multi.options = multi.options.slice(0, 3).map((option, index) => ({ ...option, correct: index < 2 }));
    deck.cards = [multi, ...deck.cards.filter((card) => card !== multi)];
  });
  await service.dispose?.();
}

async function seedOwn(root) {
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => { state.sources.push({ id: 'own1', title: '我的讲义 · 第一章.md', text: '线程、锁与死锁。'.repeat(60), createdAt: '2026-11-01T08:00:00.000Z', courses: ['操作系统'], chars: 480 }); });
  await service.dispose?.();
}

async function serve(base, name, seed, dist) {
  const root = join(base, name, 'library');
  await mkdir(root, { recursive: true });
  await seed(root);
  return createPreviewServer({ libraryRoot: root, home: join(base, name, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
}

async function open(browser, server, { lang = 'zh', theme = 'light', width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme, locale: lang === 'en' ? 'en-US' : 'zh-CN' });
  await context.addInitScript(([l, t]) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-theme', t); localStorage.setItem('study-autopilot', 'off'); localStorage.setItem('study-auto-advance', 'off'); } catch { /* blocked */ } }, [lang, theme]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(server.url);
  await page.locator('.study-app').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  return { context, page, errors };
}

const later = async (page, lang) => {
  const button = page.getByRole('button', { name: lang === 'en' ? /Maybe later|Not now/ : '以后再说' });
  if (await button.count()) { await button.first().click(); await page.waitForTimeout(800); }
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };

/** The stroke of the ink in a clip of a 2x screenshot, in CSS px: the median, over the pixels fully inked, of the shortest run of ink through each
    (across, down, and both diagonals times √2), each pixel counted by how far it is from the background toward the ink colour. */
async function strokeWidth(page, clip, ink) {
  const png = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async ([data64, color]) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), g = canvas.getContext('2d');
    g.drawImage(bitmap, 0, 0);
    const { data, width: W, height: H } = g.getImageData(0, 0, bitmap.width, bitmap.height);
    const counts = new Map();
    for (let i = 0; i < W * H; i++) { const key = `${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]}`; counts.set(key, (counts.get(key) || 0) + 1); }
    const bg = [...counts].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
    const parts = color.replace(/^color\(srgb/, '').match(/[\d.]+/g).slice(0, 3).map(Number);
    const fg = /^color\(srgb/.test(color) ? parts.map((v) => v * 255) : parts;
    const d = fg.map((v, i) => v - bg[i]), dd = d.reduce((sum, v) => sum + v * v, 0) || 1;
    const t = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) t[i] = Math.max(0, Math.min(1, ((data[i * 4] - bg[0]) * d[0] + (data[i * 4 + 1] - bg[1]) * d[1] + (data[i * 4 + 2] - bg[2]) * d[2]) / dd));
    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : t[y * W + x]);
    const run = (x, y, dx, dy) => { let sum = at(x, y); for (const k of [1, -1]) for (let i = 1; i < 60; i++) { const v = at(x + k * dx * i, y + k * dy * i); if (v < 0.08) break; sum += v; } return sum; };
    const widths = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (t[y * W + x] > 0.85) widths.push(Math.min(run(x, y, 1, 0), run(x, y, 0, 1), Math.SQRT2 * run(x, y, 1, 1), Math.SQRT2 * run(x, y, 1, -1)));
    widths.sort((a, b) => a - b);
    return widths.length ? widths[widths.length >> 1] / 2 : 0;
  }, [png, ink]);
}

/** The gap between the last words of a control and its trailing svg, and how far their centres differ (+ = the icon sits high). */
const trailing = (page, selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((element) => element.getClientRects().length).map((element) => {
  const svg = element.querySelector('svg:last-child');
  const text = [...element.childNodes].filter((node) => node.nodeType === 3 && node.textContent.trim()).at(-1);
  if (!svg || !text) return { text: element.textContent.trim(), svg: !!svg, gap: null, mid: null, display: getComputedStyle(element).display };
  const range = document.createRange();
  range.selectNodeContents(text);
  const words = range.getBoundingClientRect(), icon = svg.getBoundingClientRect();
  return { text: element.textContent.trim(), svg: svg.querySelector('path')?.getAttribute('d')?.slice(0, 14), gap: +(icon.left - words.right).toFixed(2), mid: +(((words.top + words.bottom) - (icon.top + icon.bottom)) / 2).toFixed(2), display: getComputedStyle(element).display };
}), selector);

test('round 4 in the browser: answer marks as heavy as their label, the station arrow\'s gap, the selection bar, one 再添加资料, the first-run step, the deck row title at 420px', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-icon-round4-'));
  const dist = join(base, 'dist');
  await buildPreview({ outdir: dist });
  const servers = [];
  try {
    const zh = await serve(base, 'zh', (root) => seedSample(root, 'zh'), dist); servers.push(zh);
    const en = await serve(base, 'en', (root) => seedSample(root, 'en'), dist); servers.push(en);
    const own = await serve(base, 'own', seedOwn, dist); servers.push(own);

    await t.test(`6 (#1074): the first-run card's step 2 with the sample loaded is never cut and says what its button does`, async () => { for (const [lang, server] of [['zh', zh], ['en', en]]) {
      for (const width of [1440, 420]) {
        const { page, context } = await open(browser, server, { lang, width });
        await later(page, lang);
        await page.locator('.first-run-card').first().waitFor({ timeout: 30000 });
        const steps = await page.evaluate(() => [...document.querySelectorAll('.first-run-card .frl-step')].map((step) => {
          const text = step.querySelector('.frl-step__text');
          return { step: step.dataset.step, text: text.textContent, cut: text.scrollWidth > text.clientWidth + 0.5 };
        }));
        const material = steps.find((step) => step.step === 'material');
        assert.ok(material && !material.cut, `${lang} ${width}px: step 2 says all of 「${material?.text}」`);
        assert.ok(!steps.find((step) => step.step === 'deck')?.cut, `${lang} ${width}px: step 3 is not cut either`);
        const button = (await page.locator('.first-run-card .today-go').innerText()).trim();
        assert.ok(material.text.toLowerCase().includes(lang === 'en' ? 'add' : '添加') && material.text.includes(lang === 'en' ? 'source' : '资料'), `${lang}: step 2 says what its button 「${button}」 does`);
        await shot(page, `first-run-card-${lang}-${width}`);
        await context.close();
      }
    } });

    await t.test(`round 6 (5): the model step of the compact first-run card says the whole model id, the provider first, never cut, at 1440 and 420px`, async () => { for (const [lang, server] of [['en', en], ['zh', zh]]) {
      for (const width of [1440, 420]) {
        const { page, context } = await open(browser, server, { lang, width });
        await later(page, lang);
        await page.locator('.first-run-card .frl-step[data-step="model"] .frl-step__text').first().waitFor({ timeout: 30000 });
        // The preview's model is "preview · fake-model"; a learner's is longer. The row is given the ids of the free providers the guide names, as the card would say them.
        for (const id of ['preview · fake-model', 'deepseek · deepseek-chat', 'siliconflow · Qwen/Qwen2.5-7B-Instruct', 'SiliconFlow · Qwen/Qwen3-235B-A22B-Instruct-2507']) {
          const seen = await page.evaluate(([label, zh]) => {
            const text = document.querySelector('.first-run-card .frl-step[data-step="model"] .frl-step__text'), row = text.closest('.frl-step__row');
            text.textContent = zh ? `已选择模型：${label}` : `Model selected: ${label}`;
            const box = text.getBoundingClientRect(), range = document.createRange();
            range.selectNodeContents(text);
            const lines = [...range.getClientRects()].map((rect) => Math.round(rect.top)).filter((top, index, all) => all.indexOf(top) === index).length;
            const shown = Math.round(row.getBoundingClientRect().height / 32);
            return { cut: text.scrollWidth > text.clientWidth + 0.5 || text.scrollHeight > text.clientHeight + 0.5, lines, shown, height: +row.getBoundingClientRect().height.toFixed(1), width: +box.width.toFixed(1) };
          }, [id, lang === 'zh']);
          // The typical ids (the free providers the guide names) are never cut; a longer id is clamped to the two lines with an ellipsis, its provider whole.
          if (!id.startsWith('SiliconFlow')) assert.ok(!seen.cut, `${lang} ${width}px: 「${id}」 is cut on the model step (${JSON.stringify(seen)})`);
          assert.ok(seen.shown <= 2 && (seen.lines <= 2 || seen.cut), `${lang} ${width}px: 「${id}」 shows at most two ruled lines (${JSON.stringify(seen)})`);
          assert.ok(Math.abs(seen.height / 32 - Math.round(seen.height / 32)) < 0.05, `${lang} ${width}px: the row stays on the card's 32px ruling (${seen.height}px)`);
          if (id.startsWith('siliconflow')) await shot(page, `first-run-model-${lang}-${width}`);
        }
        await context.close();
      }
    } });

    await t.test(`8: at 420px no deck title is cut by the play slot, which keeps one width`, async () => { for (const [lang, server] of [['en', en], ['zh', zh]]) {
      const { page, context } = await open(browser, server, { lang, width: 420, height: 844 });
      await later(page, lang);
      await page.locator('.deck-row .map-name strong').first().waitFor({ timeout: 30000 });
      // The title has the first line to itself (beside the fold, the check and the ⋯): the play slot is on the line of the bar, below it. A title longer than
      // that whole line still ends in an ellipsis (the case row's 「Sample case · QuillpadCase · best 6/10」 in English); the deck title the review saw cut is whole.
      const rows = await page.evaluate(() => [...document.querySelectorAll('.deck-row')].map((row) => {
        const title = row.querySelector('.map-name strong'), name = row.querySelector('.map-name').getBoundingClientRect(), slot = row.querySelector('.map-play').getBoundingClientRect();
        return { text: title.textContent, cut: title.scrollWidth > title.clientWidth + 0.5, below: slot.top >= name.bottom - 1 };
      }));
      assert.ok(rows.length >= 2, `${lang} 420px: the sample has its deck rows`);
      for (const row of rows) assert.ok(row.below, `${lang} 420px: 「${row.text}」: the play slot is below the title, not beside it`);
      const deck = rows.find((row) => /Memento/.test(row.text) && !/case|案例/i.test(row.text));
      assert.ok(deck && !deck.cut, `${lang} 420px: 「${deck?.text}」 is whole`);
      const slots = await page.evaluate(() => [...document.querySelectorAll('.deck-row .map-play')].map((slot) => Math.round(slot.getBoundingClientRect().width * 10) / 10));
      assert.equal(new Set(slots).size, 1, `${lang} 420px: the play slots are one width (${slots.join(', ')})`);
      await shot(page, `deck-rows-${lang}-420`);
      await context.close();
    } });

    await t.test(`round 5 (2) / round 6 (2): at 420px with a mouse an idle deck or topic row has no invisible play slot beside its bar, its ▶ is a glyph at the slot's end (not a wide hollow pill), and the bars still line up`, async () => { for (const [lang, server] of [['zh', zh], ['en', en]]) {
      const { page, context } = await open(browser, server, { lang, width: 420, height: 844 });
      await later(page, lang);
      await page.locator('.deck-row .map-play').first().waitFor({ timeout: 30000 });
      assert.ok(await page.evaluate(() => matchMedia('(hover: hover)').matches), 'the browser has a mouse: the case the review found');
      await page.locator('.deck-row .map-fold').first().click();
      await page.locator('.topic-row .map-play').first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      const rows = await page.evaluate(() => [...document.querySelectorAll('.deck-row, .topic-row')].filter((row) => row.getClientRects().length).map((row) => {
        const slot = row.querySelector('.map-play'), bar = row.querySelector('.mastery-bar');
        const box = slot.getBoundingClientRect(), track = bar?.getBoundingClientRect(), style = getComputedStyle(slot);
        // What the eye sees of the slot: its pill when it draws a border or a fill, else only its face (the ▶ glyph).
        const clear = (colour) => /^(?:transparent|rgba\(0, 0, 0, 0\))$/.test(colour) || / 0\)$/.test(colour);
        const face = slot.querySelector('.map-play__face:not(.map-play__ghost)').getBoundingClientRect();
        const pill = (parseFloat(style.borderTopWidth) > 0 && !clear(style.borderTopColor)) || !clear(style.backgroundColor);
        return { kind: row.classList.contains('deck-row') ? 'deck' : 'topic', run: slot.classList.contains('is-run'), opacity: +style.opacity, width: +box.width.toFixed(1), seen: +(pill ? box.width : face.width).toFixed(1),
          end: +(box.right - face.right).toFixed(1), right: track ? +track.right.toFixed(1) : null, left: track ? +track.left.toFixed(1) : null, bar: track ? +track.width.toFixed(1) : null };
      }));
      assert.ok(rows.some((row) => row.kind === 'deck' && !row.run) && rows.some((row) => row.kind === 'topic'), `${lang}: idle deck and topic rows are on screen`);
      for (const row of rows) assert.ok(row.opacity >= 0.99 || row.width <= 4, `${lang} 420px: an idle ${row.kind} row keeps an invisible ${row.width}px slot beside its bar (opacity ${row.opacity})`);
      // Round 6: the idle face is the ▶ alone, at the slot's end where 「继续 →」 ends, never a 74 - 101px hollow pill around one glyph.
      for (const row of rows.filter((entry) => !entry.run)) {
        assert.ok(row.seen <= 40, `${lang} 420px: an idle ${row.kind} row shows a ${row.seen}px pill around its ▶ (slot ${row.width}px)`);
        assert.ok(row.end <= 16, `${lang} 420px: the ▶ of an idle ${row.kind} row sits at the slot's end (${row.end}px from it)`);
      }
      const bars = rows.filter((row) => row.bar !== null);
      for (const kind of ['deck', 'topic']) {
        const mine = bars.filter((row) => row.kind === kind);
        assert.ok(new Set(mine.map((row) => Math.round(row.right))).size <= 1 && new Set(mine.map((row) => Math.round(row.left))).size <= 1, `${lang} 420px: the ${kind} bars share one left and one right edge (${JSON.stringify(mine.map((row) => [row.left, row.right]))})`);
      }
      await shot(page, `deck-rows-idle-${lang}-420`);
      await context.close();
    } });

    await t.test(`round 5 (3 / #1074): the ways in on the home row of the sample state are one system: one colour and one size, the hand-off link too`, async () => { for (const [lang, server] of [['zh', zh], ['en', en]]) {
      const { page, context } = await open(browser, server, { lang, width: 1440 });
      await later(page, lang);
      // The workspace-file hand-off waits under 其他开始方式 (#1696): opened, it looks like the links of the row above it.
      await page.locator('.desk-more > summary').first().click();
      await page.locator('.desk-also [data-hand-off="import.file"]').first().waitFor({ timeout: 30000 });
      const row = await page.evaluate(() => [...document.querySelectorAll('.desk-also')].filter((line) => !line.querySelector('[data-hand-off="guide.start"]')).flatMap((line) => [...line.querySelectorAll('button')].filter((button) => button.getClientRects().length).map((button) => {
        const style = getComputedStyle(button);
        return { text: button.textContent.trim().slice(0, 24), color: style.color, size: style.fontSize };
      })));
      assert.ok(row.length >= 2, `${lang}: the row has the JSON link and the hand-off link (${JSON.stringify(row)})`);
      assert.equal(new Set(row.map((entry) => entry.color)).size, 1, `${lang}: one colour on the row (${JSON.stringify(row)})`);
      assert.equal(new Set(row.map((entry) => entry.size)).size, 1, `${lang}: one text size on the row (${JSON.stringify(row)})`);
      await shot(page, `desk-also-${lang}-1440`);
      await context.close();
    } });

    await t.test(`2: the home selection bar's primary leads with its words and ends in the arrow`, async () => {
      const { page, context } = await open(browser, zh, { lang: 'zh', width: 1440 });
      await later(page, 'zh');
      const box = page.locator('input.map-row__check').nth(1);
      await box.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await box.dispatchEvent('click');
      await page.locator('.selection-bar').waitFor({ timeout: 15000 });
      const primary = await page.evaluate(([arrow]) => {
        const button = document.querySelector('.selection-bar .sh-btn--primary');
        const svgs = [...button.querySelectorAll('svg')];
        return { text: button.textContent.trim(), first: [...button.childNodes].find((node) => node.nodeType === 1 || node.textContent.trim())?.nodeName.toLowerCase(), last: svgs.at(-1)?.querySelector('path')?.getAttribute('d')?.startsWith(arrow) && button.lastElementChild === svgs.at(-1) };
      }, [ARROW]);
      assert.notEqual(primary.first, 'svg', `「${primary.text}」 leads with its words, not with ▶`);
      assert.ok(primary.last, `「${primary.text}」 ends in the arrow`);
      await shot(page, 'selection-bar-zh-1440');
      await context.close();
    });

    await t.test(`4 / 1: the skeleton station keeps the Button's gap before its arrow, and every 练 N 题 ends in one`, async () => {
      const { page, context } = await open(browser, zh, { lang: 'zh', width: 1440 });
      await later(page, 'zh');
      await (await revealNavRow(page, 'skeleton')).click();
      await page.getByText(/示例 · 设计模式/).first().click();
      await page.locator('.spine-station-practice').first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(600);
      const station = (await trailing(page, '.spine-station-practice'))[0];
      assert.equal(station.display, 'inline-flex', 'the station link keeps the Button\'s inline-flex');
      assert.ok(station.gap >= 5.5 && station.gap <= 6.5, `「${station.text}」: 6px before the arrow, the gap of a small Button (${station.gap})`);
      assert.ok(Math.abs(station.mid) <= 1, `「${station.text}」: the arrow on the words' centre line (${station.mid})`);
      const minis = await trailing(page, '.spine-practice:not(.spine-station-practice), .sk-mini, .skc-practice');
      assert.ok(minis.length > 0, 'the points have their 练 N 题');
      for (const mini of minis) assert.ok(mini.svg === ARROW.slice(0, 14) && mini.gap >= 5.5, `「${mini.text}」 ends in the arrow (${JSON.stringify(mini)})`);
      await shot(page, 'skeleton-zh-1440');
      await context.close();
    });

    await t.test(`3: the tick and the cross of an answer are as heavy as the bold label beside them (2x screenshot)`, async () => {
      const { page, context } = await open(browser, zh, { lang: 'zh', width: 1440 });
      await later(page, 'zh');
      await page.locator('.deck-row .map-play[aria-label*="Bridge"]').first().click({ force: true });
      await confirmStartIfAsked(page, page.locator('.question-card, .flash-area'));
      const options = page.locator('.question-card .option'), submit = page.getByRole('button', { name: /^提交/ });
      await page.locator('.question-card').first().waitFor({ timeout: 30000 });
      // The path starts where the course does: skip (K) to the multiple-answer question, answering a single choice on the way.
      for (let step = 0; step < 14 && !(await options.count() && await submit.count()); step++) {
        if (await options.count()) {
          await options.first().click();
          await page.getByRole('button', { name: /^下一题/ }).first().click({ timeout: 5000 }).catch(() => page.keyboard.press('k'));
        } else await page.keyboard.press('k');
        await page.waitForTimeout(900);
      }
      await options.nth(0).click();
      await options.nth(2).click();
      await submit.first().click();
      await page.locator('.answer-state svg').first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(600);
      const states = await page.evaluate(() => [...document.querySelectorAll('.answer-state')].filter((state) => state.querySelector('svg')).map((state) => {
        const icon = state.querySelector('svg').getBoundingClientRect(), box = state.getBoundingClientRect();
        return { text: state.textContent, color: getComputedStyle(state).color, icon: [icon.left, icon.top, icon.width, icon.height], box: [box.left, box.top, box.width, box.height] };
      }));
      assert.ok(states.length >= 2, 'a right pick and a wrong pick carry their marks');
      for (const state of states) {
        const mark = await strokeWidth(page, { x: state.icon[0] - 1, y: state.icon[1] - 1, width: state.icon[2] + 2, height: state.icon[3] + 2 }, state.color);
        const label = await strokeWidth(page, { x: state.icon[0] + state.icon[2] + 2, y: state.box[1], width: state.box[2] - state.icon[2] - 3, height: state.box[3] }, state.color);
        const ratio = mark / label;
        assert.ok(ratio >= 0.9 && ratio <= 1.2, `「${state.text}」: the mark's stroke ${mark.toFixed(2)}px against the label's ${label.toFixed(2)}px (${ratio.toFixed(2)})`);
      }
      await shot(page, 'answer-marks-zh-1440');
      await context.close();
    });

    await t.test(`5 (#1074): every 再添加资料 is ink and has one icon size, on the first-run line and on the home`, async () => {
      const found = [];
      const measure = (page, where) => page.evaluate((place) => [...document.querySelectorAll('button')].filter((button) => button.getClientRects().length && /再添加资料/.test(button.textContent)).map((button) => {
        const icon = button.querySelector('svg').getBoundingClientRect(), style = getComputedStyle(button);
        const probe = document.createElement('span');
        probe.style.color = 'var(--text)';
        button.parentElement.appendChild(probe);
        const ink = getComputedStyle(probe).color;
        probe.remove();
        return { where: place, color: style.color, ink, icon: Math.round(icon.width * 10) / 10 };
      }), where);
      const { page, context } = await open(browser, own, { lang: 'zh', width: 1440 });
      await page.locator('.first-run').first().waitFor({ timeout: 30000 });
      found.push(...await measure(page, 'first-run line'));
      await shot(page, 'more-first-run-zh-1440');
      await later(page, 'zh');
      found.push(...await measure(page, 'home'));
      // The links beside it on the desk (已有题目？导入 JSON 题组) are text actions too: one row, one colour.
      const row = await page.evaluate(() => [...document.querySelectorAll('.desk-also')].filter((p) => /再添加资料/.test(p.textContent)).flatMap((p) => [...p.querySelectorAll('button')].map((button) => [button.textContent.trim(), getComputedStyle(button).color])));
      assert.ok(row.length >= 2 && new Set(row.map((entry) => entry[1])).size === 1, `the desk row of 再添加资料 has one colour (${JSON.stringify(row)})`);
      await shot(page, 'more-home-zh-1440');
      await context.close();
      assert.deepEqual(found.map((entry) => entry.where), ['first-run line', 'home'], 'both places offer 再添加资料');
      for (const entry of found) assert.equal(entry.color, entry.ink, `${entry.where}: 再添加资料 is ink (--text), not the cinnabar of the one primary`);
      assert.equal(new Set(found.map((entry) => entry.icon)).size, 1, `one icon size (${found.map((entry) => `${entry.where} ${entry.icon}px`).join(', ')})`);
    });
  } finally {
    for (const server of servers) await server.close().catch(() => {});
    await browser.close();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
