/* 界面大小 is a CSS zoom on the app, so there are two pixels: the ones the screen draws (pointer events, getBoundingClientRect) and the app's own
   (styles, scrollTop, offsetWidth). Code that mixes them is off by the zoom: 10 % at 90 %, half at 50 %. These are the places that were, measured
   in the browser at 50 % (and 70 % where the first paint depends on the size): what is dragged follows the pointer, what is drawn to a measured width
   fills it, and a 420 px panel does not paint one sidebar layout and then jump to the other. Temporary seeded library, fake model. */
/* global document, window, localStorage, getComputedStyle, MutationObserver */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { seedLibrary } from '../scripts/qa/perf-seed.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { confirmStartIfAsked } from '../scripts/qa/confirm-start.mjs';
import { frames, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { Store } from '../lib/store.js';

const SCALE = 50;
const rect = (locator) => locator.evaluate((element) => { const box = element.getBoundingClientRect(); return { x: box.left, y: box.top, w: box.width, h: box.height }; });
const near = (actual, expected, slack, message) => assert.ok(Math.abs(actual - expected) <= slack, `${message}: ${actual}, expected ${expected} ± ${slack}`);
/* A slow machine draws later, never differently: read until the number is there, and say the last one when it never is. */
const eventually = async (read, expected, slack, message) => {
  let last = NaN;
  await until(async () => Math.abs((last = await read()) - expected) <= slack, message, { timeoutMs: 15000, intervalMs: 50 }).catch(() => {});
  near(last, expected, slack, message);
};
/* Where something rests: two readings a few frames apart that agree. */
const atRest = async (locator, page) => {
  let last = null;
  await until(async () => {
    const now = await rect(locator), same = last && ['x', 'y', 'w', 'h'].every((key) => Math.abs(now[key] - last[key]) < 0.5);
    last = now;
    await frames(page, 6);
    return same;
  }, 'the element comes to rest', { timeoutMs: 15000, intervalMs: 100 });
  return last;
};

/* The 词解 card is position: fixed inside the zoomed reader, and the passage it explains is known in drawn pixels. One root, as in the reader:
   the pointer going from one wavy line straight to the next re-renders the same card with the new passage, never through nothing. The
   right-click menu is placed by the same measuring (placeInHost) and is moved the same way when it opens at another point. */
const explainHarness = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import ExplainCard from './ui/document-preview/marks/ExplainCard.jsx';
  import { ContextMenu } from './ui/components/index.js';
  let root, menuRoot;
  window.show = (rect) => { root ||= createRoot(document.getElementById('app')); root.render(<ExplainCard shown={{ rect, card: { term: '双边市场', answer: '两类用户通过平台找到彼此。' } }} />); };
  window.menuAt = (point) => { menuRoot ||= createRoot(document.getElementById('menu')); menuRoot.render(<ContextMenu label="m" point={point} items={[{ id: 'a', label: '复制' }, { id: 'b', label: '问 AI' }]} onClose={() => {}} />); };
`;

test('the 词解 card opens right under its passage at 50 %, 100 % and 150 %, and follows the pointer to the next passage', { timeout: 120000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  try {
    const bundle = await build({ stdin: { contents: explainHarness, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'iife', platform: 'browser',
      loader: { '.css': 'text', '.jsx': 'jsx' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const styles = await Promise.all(['ui/tokens.css', 'ui/base.css', 'ui/document-preview/marks/marks.css'].map((file) => readFile(file, 'utf8')));
    const blank = async (t2, scale) => {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      t2.after(() => page.close());
      await page.setContent(`<!doctype html><meta charset="utf-8">${styles.map((css) => `<style>${css}</style>`).join('')}<div class="study-app" data-theme="light" data-ui-scale="${scale}"><div id="app"></div><div id="menu"></div></div>`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      return page;
    };
    for (const scale of [50, 100, 150]) await t.test(`${scale}%`, async (t2) => {
      const page = await blank(t2, scale);
      await page.evaluate(() => window.show({ left: 400, top: 300, right: 520, bottom: 320, width: 120, height: 20 }));
      const card = page.locator('.reader-explain');
      await card.waitFor({ state: 'visible' });
      const drawn = await rect(card);
      near(drawn.x, 400, 2, 'its left edge lines up with the passage');
      near(drawn.y, 320 + 6 * (scale / 100), 2, 'it starts just under the passage');
    });
    /* Placing measures the card at the window's corner; a coordinate the new place shares with the old one must not stay there. */
    for (const scale of [50, 100]) await t.test(`${scale}%: moved straight to another place, nothing is left at the window's edge`, async (t2) => {
      await t2.test('the card, to the next passage on the same left', async (t3) => {
        const page = await blank(t3, scale), card = page.locator('.reader-explain');
        await page.evaluate(() => window.show({ left: 400, top: 300, right: 520, bottom: 320, width: 120, height: 20 }));
        await card.waitFor({ state: 'visible' });
        await page.evaluate(() => window.show({ left: 400, top: 340, right: 600, bottom: 360, width: 200, height: 20 }));
        const drawn = await rect(card);
        near(drawn.x, 400, 2, 'same left as the last passage: still lined up with it');
        near(drawn.y, 360 + 6 * (scale / 100), 2, 'under the new passage');
      });
      await t2.test('the card, between two passages at the right edge (both pulled in to the same left)', async (t3) => {
        const page = await blank(t3, scale), card = page.locator('.reader-explain');
        await page.evaluate(() => window.show({ left: 950, top: 100, right: 990, bottom: 120, width: 40, height: 20 }));
        await card.waitFor({ state: 'visible' });
        await page.evaluate(() => window.show({ left: 960, top: 200, right: 990, bottom: 220, width: 30, height: 20 }));
        const drawn = await rect(card);
        near(drawn.x + drawn.w, 1000 - 8 * (scale / 100), 2, 'pulled in from the right edge, not left at the window\'s left');
        near(drawn.y, 220 + 6 * (scale / 100), 2, 'under the new passage');
      });
      // The right-click menu is portalled to the window, outside the zoom. Its first place is taken before its own styles settle, so the line it
      // keeps is shared by the second point and the third.
      await t2.test('the right-click menu, opened again further along the same line', async (t3) => {
        const page = await blank(t3, scale), menu = page.locator('.sh-menu--context');
        await page.evaluate(() => window.menuAt({ x: 200, y: 250 }));
        await menu.waitFor({ state: 'visible' });
        await page.evaluate(() => window.menuAt({ x: 300, y: 250 }));
        await until(async () => Math.abs((await rect(menu)).x - 300) <= 2, 'the menu moves to the second point', { timeoutMs: 5000, intervalMs: 50 });
        await page.evaluate(() => window.menuAt({ x: 400, y: 250 }));
        const drawn = await rect(menu);
        near(drawn.x, 400, 2, 'the menu opens at the new point');
        near(drawn.y, 252, 2, 'on the same line as before, not at the window\'s top');
      });
    });
  } finally {
    await browser.close().catch(() => {});
  }
});

/* Parts that measure drawn widths or distances and use them as the app's own pixels, each rendered alone inside the zoomed app. */
const partsHarness = `
  import React, { useRef } from 'react';
  import { createRoot } from 'react-dom/client';
  import { GenerationSettingsForm } from './ui/GenerationSettings.jsx';
  import { GENERATION_SETTINGS_DEFAULTS } from './lib/generation-settings.js';
  import { useRowFit } from './ui/use-row-fit.js';
  import { useFactsFit } from './ui/picker-names.js';
  let root;
  const mount = (node) => { root ||= createRoot(document.getElementById('app')); root.render(node); };
  window.settings = () => mount(<GenerationSettingsForm root="/library" saved={GENERATION_SETTINGS_DEFAULTS} />);
  // A title row 400 px wide with an 8 px gap: whether a title and a copy of the actions of the given widths fit on it.
  function Row({ title, probe }) {
    const ref = useRef(null), fits = useRowFit(ref, '.row', '.probe');
    return <div ref={ref} data-fits={String(fits)}>
      <div className="row" style={{ display: 'flex', columnGap: 8, width: 400 }}><span style={{ flex: 'none', width: title }} /></div>
      <div className="probe" style={{ position: 'absolute', width: probe, height: 1 }} />
    </div>;
  }
  window.row = (props) => mount(<Row key={props.probe} {...props} />);
  // One picker row: its facts line is room px wide, 8 px between its pieces.
  const FACTS = { kind: 'PDF', pages: '· 12 页', size: '· 3,000 字', short: '· 3k 字', first: '经济学原理', later: ['微观经济学', '宏观经济学'], shortened: false, multi: false, group: 'paged' };
  const rows = [FACTS];
  function Picker({ room }) {
    const ref = useRef(null);
    useFactsFit(ref, rows, false);
    return <div ref={ref} className="source-picker"><div className="source-picker__row">
      <div className="source-picker__facts" style={{ display: 'flex', columnGap: 8, fontSize: 16, width: room }}>{FACTS.kind}</div>
    </div></div>;
  }
  window.picker = (room) => mount(<Picker key={room} room={room} />);
  // The words' widths as the picker measures them, read on a page at 100 %.
  window.words = () => {
    const facts = document.querySelector('.source-picker__facts'), sum = (list) => list.reduce((total, word) => {
      const span = document.createElement('span'); span.style.cssText = 'display:inline-block;white-space:pre'; span.textContent = word; facts.append(span);
      const width = span.getBoundingClientRect().width; span.remove(); return total + width; }, 0);
    return { all: sum([FACTS.kind, FACTS.pages, FACTS.first, ...FACTS.later]), dot: sum(['· ']) };
  };
`;

test('at 50 % a measured distance is used in the pixels of what it is applied to', { timeout: 120000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  try {
    const bundle = await build({ stdin: { contents: partsHarness, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'iife', platform: 'browser',
      loader: { '.css': 'text', '.jsx': 'jsx' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const styles = await Promise.all(['ui/tokens.css', 'ui/base.css', 'ui/settings.css'].map((file) => readFile(file, 'utf8')));
    const blank = async (t2, { scale = 50, app = '<div id="app"></div>', attrs = '' } = {}) => {
      const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
      t2.after(() => page.close());
      await page.setContent(`<!doctype html><meta charset="utf-8">${styles.map((css) => `<style>${css}</style>`).join('')}<div class="study-app" data-theme="light" data-ui-scale="${scale}"${attrs}>${app}</div>`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      return page;
    };

    /* Embedded in a page that scrolls the app with it (the app is not its own scroller here), the window scrolls, and the window is not zoomed:
       the distance is scrolled as drawn, not as the save bar's pixels. */
    await t.test('a changed field the save bar would cover is scrolled just clear of it', async (t2) => {
      const page = await blank(t2, { attrs: ' style="overflow: visible"', app: '<div class="settings-page"><div style="height: 1500px"></div><div id="app"></div><div style="height: 1500px"></div></div>' });
      await page.evaluate(() => window.settings());
      const box = page.locator('.settings-form input[name="selectionCount"]'), bar = page.locator('.generation-settings__save');
      await box.waitFor({ state: 'attached' });
      // the field's bottom at the window's bottom: under where the bar sticks once there is something to save
      await page.evaluate(() => { const field = document.querySelector('.settings-form input[name="selectionCount"]'), at = (field.closest('.sh-field') || field).getBoundingClientRect();
        window.scrollBy(0, at.bottom - window.innerHeight + 2); });
      await box.focus();
      await page.keyboard.press('ArrowUp');
      await page.locator('.generation-settings__save[data-dirty="true"]').waitFor();
      await frames(page, 4);
      const field = await page.evaluate(() => { const at = (document.activeElement.closest('.sh-field') || document.activeElement).getBoundingClientRect(); return at.bottom; });
      near(field, (await rect(bar)).y - 16, 2, 'the field ends 16 px above the bar');
    });

    /* 200 + 8 + 190 = 398 of 400 fits, 200 + 8 + 196 = 404 does not, at any size: the gap is the row's own pixels, the widths drawn ones. */
    for (const scale of [50, 100]) await t.test(`${scale}%: a header's actions stay on the title row exactly when they fit`, async (t2) => {
      const page = await blank(t2, { scale });
      const fits = async (probe) => {
        await page.evaluate((width) => window.row({ title: 200, probe: width }), probe);
        await frames(page, 2);
        return page.locator('[data-fits]').getAttribute('data-fits');
      };
      assert.equal(await fits(190), 'true', '398 px of 400: they fit');
      assert.equal(await fits(196), 'false', '404 px of 400: they do not');
    });

    /* The words are measured as drawn; the gap, the font size and the spare room are the line's own pixels. The line is made 10 px wider than every
       name needs (8 px between the pieces, 4 px spare), then 10 px narrower: the picker says every name exactly when there is room, at 50 % as at 100 %. */
    for (const scale of [50, 100]) await t.test(`${scale}%: a picker row says every name exactly when it has room, and hides its 「· 」 by its own width`, async (t2) => {
      const reference = await blank(t2, { scale: 100 });
      await reference.evaluate(() => window.picker(2000));
      await reference.locator('.source-picker[data-names]').waitFor({ state: 'attached' });
      const words = await reference.evaluate(() => window.words()), need = words.all + 3 * 8 + 4;
      const page = await blank(t2, { scale });
      const names = async (room) => {
        await page.evaluate((width) => window.picker(width), room);
        await page.locator('.source-picker[data-names]').waitFor({ state: 'attached' });
        return page.evaluate(() => document.querySelector('.source-picker').dataset.names);
      };
      assert.equal(await names(Math.ceil(need + 10)), 'all', `${need.toFixed(1)} px of ${Math.ceil(need + 10)}: every name`);
      const dot = await page.evaluate(() => parseFloat(document.querySelector('.source-picker').style.getPropertyValue('--picker-dot')));
      near(dot, words.dot, 1, '--picker-dot is the 「· 」 as wide as the line draws it, in its own pixels');
      assert.equal(await names(Math.floor(need - 10)), 'first', `${need.toFixed(1)} px of ${Math.floor(need - 10)}: the first name only`);
    });
  } finally {
    await browser.close().catch(() => {});
  }
});

test('below 100% the pointer, the measured widths and the first paint agree with what is drawn', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-scale-pointer-'));
  let server;
  try {
    const dist = join(base, 'dist'), library = join(base, 'library');
    await buildPreview({ outdir: dist });
    await seedLibrary(library, { sources: 10, decks: 3, cardsPerDeck: 10, runs: 2, attempts: 30, courses: 1, largeSources: 1, largeSourceChars: 6000 });
    // The score chart draws answers of the last days only: some are dated today, so the test does not empty itself as the calendar moves on.
    await new Store(library).update((state) => {
      state.attempts.slice(-12).forEach((attempt, index) => { attempt.timestamp = new Date(Date.now() - index * 60_000).toISOString(); });
    });
    server = await createPreviewServer({ libraryRoot: library, home: join(base, 'home'), port: 0, distDir: dist, model: createFakeModel({ latencyMs: 20 }) });

    const open = async (t2, { scale = SCALE, width = 1440, height = 900, init } = {}) => {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN' });
      t2.after(() => context.close());
      await context.addInitScript((value) => {
        localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-autopilot', 'off');
        localStorage.setItem('study-interface', JSON.stringify({ scale: value }));
      }, scale);
      if (init) await context.addInitScript(init);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(server.url);
      await page.locator(`.study-app[data-ui-scale="${scale}"]`).waitFor({ timeout: 30000 });
      await page.locator('.sidebar, .nav-menu-toggle').first().waitFor({ timeout: 30000 });
      return { page, errors };
    };

    for (const scale of [70, 50]) await t.test(`a 420 px panel at ${scale}% draws the docked sidebar from the first paint, never the drawer button first`, async (t2) => {
      const { page, errors } = await open(t2, { scale, width: 420, height: 860, init: () => {
        window.sidebarStates = [];
        new MutationObserver(() => {
          const now = document.querySelector('.nav-menu-toggle') ? 'drawer' : document.querySelector('.study-app > .sidebar') ? 'docked' : '';
          if (now && window.sidebarStates.at(-1) !== now) window.sidebarStates.push(now);
        }).observe(document, { childList: true, subtree: true });
      } });
      await page.waitForTimeout(800);
      assert.deepEqual(await page.evaluate(() => window.sidebarStates), ['docked']);
      assert.deepEqual(errors, []);
    });

    await t.test('a lifted sidebar row stays under the pointer', async (t2) => {
      const { page, errors } = await open(t2);
      // The first row of the main list, lifted upward: it stays first, so no row moves out of its way and only its own offset brings it under the pointer.
      const id = await page.locator('.study-app > .sidebar [data-nav-group="main"] [data-nav-id]').first().getAttribute('data-nav-id');
      const row = page.locator(`.study-app > .sidebar [data-nav-id="${id}"]`);
      const before = await atRest(row, page), x = before.x + before.w / 2, y = before.y + before.h / 2, to = y - Math.min(40, y - 4);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.locator(`.study-app > .sidebar [data-nav-id="${id}"].is-dragging`).waitFor({ timeout: 15000 }); // held long enough to be lifted
      // One move, read before any other: a sum that mixes the two pixels is off by a share of the move on every event and only creeps up on the
      // pointer over many, so many small moves would hide it.
      await page.mouse.move(x, to);
      await eventually(async () => { const lifted = await rect(row); return lifted.y + lifted.h / 2; }, to, 2, 'the row centre is under the pointer after its first move');
      await page.keyboard.press('Escape');
      await page.mouse.up();
      assert.deepEqual(errors, []);
    });

    await t.test('the score chart is drawn as wide as its box, and the outline filter bar sticks right under the top bar', async (t2) => {
      const { page, errors } = await open(t2);
      await (await revealNavRow(page, 'dashboard')).click();
      const chart = page.locator('.dash-trend-panel .dash-chart-box');
      await chart.locator('svg').waitFor({ timeout: 30000 });
      await eventually(async () => (await rect(chart.locator('svg'))).w, (await atRest(chart, page)).w, 2, 'the svg is as wide as its box');
      await (await revealNavRow(page, 'library')).click();
      await page.getByRole('button', { name: '总纲' }).first().click();
      await page.locator('.outline-filter-bar').waitFor({ timeout: 30000 });
      await settleAnimations(page);
      const bar = await page.evaluate(() => ({ top: parseFloat(getComputedStyle(document.querySelector('.outline-page')).getPropertyValue('--outline-bar-top')),
        topbar: document.querySelector('.study-app .topbar').offsetHeight }));
      near(bar.top, bar.topbar, 1, 'the bar sticks at the top bar\'s own height, in the app\'s pixels');
      assert.deepEqual(errors, []);
    });

    await t.test('dragging the course graph moves it as far as the pointer went', async (t2) => {
      const { page, errors } = await open(t2);
      await page.getByRole('button', { name: '查看图谱' }).first().click();
      const view = page.locator('.graph-viewport').first();
      await view.waitFor({ timeout: 30000 });
      const node = view.getByText('Deck 1', { exact: true }).first();
      await node.waitFor({ timeout: 30000 });
      await settleAnimations(page);
      const before = await atRest(node, page), area = await rect(view), x = area.x + 30, y = area.y + area.h - 30;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 120, y - 60, { steps: 12 });
      await page.mouse.up();
      await eventually(async () => (await rect(node)).x - before.x, 120, 2, 'sideways');
      await eventually(async () => (await rect(node)).y - before.y, -60, 2, 'up');
      assert.deepEqual(errors, []);
    });

    await t.test('dragging the divider of 对照资料 changes the column by what the pointer moved', async (t2) => {
      const { page, errors } = await open(t2);
      await page.locator('.resume-nav').first().click();
      await confirmStartIfAsked(page, page.locator('.review-page'));
      await page.locator('.review-page .question-card').first().waitFor({ timeout: 30000 });
      const original = page.getByRole('button', { name: /看这题的原文/ }).first();
      if (!await original.count()) await page.locator('.review-page .question-card').first().click();
      await original.click();
      const column = page.locator('.source-column'), handle = page.locator('.source-column__handle');
      await handle.waitFor({ timeout: 30000 });
      await settleAnimations(page);
      const grip = await atRest(handle, page), width = (await rect(column)).w, x = grip.x + grip.w / 2, y = Math.min(grip.y + grip.h / 2, 450);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 60, y, { steps: 10 });
      await eventually(async () => grip.x - (await rect(handle)).x, 60, 2, 'the divider follows the pointer while it is held');
      await page.mouse.up();
      await eventually(async () => (await rect(column)).w - width, 60, 2, 'the column takes the width the pointer asked for');
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close().catch(() => {});
    await server?.close();
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
