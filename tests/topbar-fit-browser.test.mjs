/* global document, window, getComputedStyle -- page.evaluate callbacks run in the browser */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, openPage, seedWrongBookLibrary, until } from '../scripts/qa/layout-late.mjs';

/* The top bar's status words must FIT, measured in Chromium, from a phone (320 px) to a small laptop pane (900 px), in Chinese and English, in every state
   (steady, a background task, an action running, a failed read, a read that reconnects, no model), beside a realistic folder name: the page title keeps its room,
   the status label is drawn whole wherever it is drawn as words (the steady state and the English labels fold into their dot at phone width), the mailbox button
   stays inside the bar, and the page does not scroll sideways. The state is made at the network edge (page.route). */

const NO_MODEL = { model: { ready: false, reason: 'no-route' }, modelReady: false };
const STATES = {
  steady: {},
  running: { shows: /后台处理中|In background/, patch: (value) => { value.jobs = [...(value.jobs || []), { id: 'job-pdf', type: 'pdf-convert', status: 'running', title: 'Lecture 3.pdf', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]; } },
  busy: { hold: ['review.start', 'review.resume', 'review.open', 'review.get'], click: '.today-go, [data-usage="home.start"]' },
  failed: { failAfterLoad: '读取失败' },
  reconnecting: { failAfterLoad: 'Failed to fetch' },
  'no model': { shows: /还没配模型|No model yet/, patch: (value) => Object.assign(value, NO_MODEL) },
};
// Two realistic folder names: the chip beside the status says the folder, and a long one is the worst case for the room of the page title.
const FOLDERS = ['dsh-daily-flashcard', 'SWE5001 Software Engineering'];
const WIDTHS = [320, 360, 390, 420, 450, 480, 520, 600, 640, 700, 768, 900];

let shared;
async function environment(t) {
  if (shared === undefined) {
    shared = (async () => {
      let browser;
      try { browser = await launchChromium(); } catch (error) { return { skip: `no Chromium to measure with: ${String(error.message).split('\n')[0]}` }; }
      scrubProcessEnv();
      const dist = await mkdtemp(join(tmpdir(), 'study-topbar-fit-dist-'));
      await buildPreview({ outdir: dist });
      const base = await mkdtemp(join(tmpdir(), 'study-topbar-fit-'));
      const servers = {};
      for (const name of FOLDERS) {
        const root = join(base, name);
        await seedWrongBookLibrary(root, { wrong: 12 });
        servers[name] = await createPreviewServer({ libraryRoot: root, home: join(base, `home-${name.length}`), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
      }
      return { browser, servers, close: async () => {
        await browser.close();
        for (const server of Object.values(servers)) await server.close();
        await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
        await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      } };
    })();
  }
  const found = await shared;
  if (found.skip) { t.skip(found.skip); return null; }
  return found;
}
after(async () => { if (shared) await (await shared).close?.(); });

async function edge(page, state, spec) {
  let release;
  const held = new Promise((done) => { release = done; });
  await page.route('**/api/call', async (route) => {
    let request = {};
    try { request = JSON.parse(route.request().postData() || '{}'); } catch { /* not JSON */ }
    if (request.action === 'snapshot' && state.fail) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: state.fail }) });
    if (spec.hold?.includes(request.action)) await held;
    if (request.action === 'snapshot' && spec.patch) {
      const response = await route.fetch({ postData: JSON.stringify({ ...request, args: { ...request.args, since: undefined } }) });
      const body = await response.json();
      if (body?.ok && body.value) spec.patch(body.value);
      return route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.continue();
  });
  return release;
}

const measure = (page) => page.evaluate(() => {
  const box = (selector) => { const element = document.querySelector(selector); if (!element) return null; const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
  const label = document.querySelector('.top-status-label'), title = document.querySelector('.crumb[aria-current="page"]');
  return {
    bar: box('.topbar'), mailbox: box('.mailbox__toggle'), status: box('.top-status'),
    text: label?.innerText || '', title: title?.innerText || '', titleWidth: title?.clientWidth || 0,
    titleClipped: title ? title.scrollWidth > title.clientWidth + 1 : true,
    labelClipped: label ? label.scrollWidth > label.clientWidth + 1 : false,
    labelEllipsis: label ? getComputedStyle(label).textOverflow === 'ellipsis' && label.scrollWidth > label.clientWidth : false,
    labelFolded: label ? getComputedStyle(label).position === 'absolute' : false,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    chip: (() => { const chip = document.querySelector('.library-location'); if (!chip || getComputedStyle(chip).display === 'none') return null; return { width: chip.getBoundingClientRect().width, minWidth: parseFloat(getComputedStyle(chip).minWidth) || 0, name: !!chip.querySelector('span') && getComputedStyle(chip.querySelector('span')).display !== 'none' }; })(),
  };
});

test('the top bar fits from 320 to 900 px in zh and en beside a realistic folder name: the page title is kept, every label either whole or folded into its dot, the mailbox inside the bar, no sideways scroll', { timeout: 2400000 }, async (t) => {
  const running = await environment(t);
  if (!running) return;
  for (const folder of FOLDERS) for (const lang of ['zh', 'en']) for (const width of WIDTHS) for (const [name, spec] of Object.entries(STATES)) {
    // The first folder only walks the states that hold the fewest and the most words beside the title; the long one walks them all.
    if (folder === FOLDERS[0] && !['steady', 'failed'].includes(name)) continue;
    const tag = `${folder} ${lang} ${width}px ${name}`;
    const server = running.servers[folder];
    const { page, context, errors } = await openPage(running.browser, { server }, { lang, theme: 'dark', width, height: 844 });
    const state = { fail: '' };
    const release = await edge(page, state, spec);
    await page.goto(server.url);
    await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
    await page.locator('.top-status-label').waitFor({ timeout: 30000 });
    await frames(page, 6);
    if (spec.failAfterLoad) {
      state.fail = spec.failAfterLoad;
      const steady = await page.locator('.top-status-label').innerText();
      await until(async () => (await page.locator('.top-status-label').innerText()) !== steady, `${tag}: the bar shows the failing read`, { timeoutMs: 90000 });
    }
    if (spec.click) {
      await page.locator(spec.click).first().click({ timeout: 15000 });
      await until(async () => /正在处理|Working/.test(await page.locator('.top-status-label').innerText()), `${tag}: the bar shows work`, { timeoutMs: 15000 });
    }
    if (spec.shows) await until(async () => spec.shows.test(await page.locator('.top-status-label').innerText()), `${tag}: the patched state is shown`, { timeoutMs: 30000 });
    await frames(page, 4);
    const m = await measure(page);
    assert.ok(m.text.length > 0, `${tag}: a label`);
    // Two labels fold into their dot on purpose and stay in the page for screen readers: the steady one in a narrow pane (640 px and narrower), and an English one at
    // phone width (320 px), where its longer words would take the room of the page title. Every label that is drawn as words is drawn whole, at every width.
    const folded = (name === 'steady' && width <= 640) || (lang === 'en' && width <= 340 && name !== 'steady');
    assert.equal(m.labelFolded, folded, `${tag}: the label is ${folded ? 'folded into its dot' : 'drawn as words'}`);
    if (!folded) assert.ok(!m.labelClipped && !m.labelEllipsis, `${tag}: the label "${m.text}" is drawn whole: ${JSON.stringify(m)}`);
    // The page title never goes to nothing, and is whole wherever there is room for it.
    assert.ok(m.titleWidth >= 40, `${tag}: the page title "${m.title}" keeps its room (${m.titleWidth}px): ${JSON.stringify(m)}`);
    if (width >= 390) assert.ok(!m.titleClipped, `${tag}: the page title "${m.title}" is drawn whole: ${JSON.stringify(m)}`);
    // The folder chip, by the width it was measured at (the pane is the window minus the sidebar's rail): nothing at phone width, its icon from 420 to 450 px, its name with
    // a readable minimum width from 480 to 640 px (the narrow-pane rule really applies), the whole chip beyond.
    if (width <= 390) assert.equal(m.chip, null, `${tag}: no chip at phone width`);
    if (width >= 420 && width <= 450) assert.ok(m.chip && !m.chip.name, `${tag}: the chip is its icon (${JSON.stringify(m.chip)})`);
    if (width >= 480 && width <= 640) assert.ok(m.chip?.name && m.chip.minWidth >= 60 && m.chip.width >= 60, `${tag}: the chip keeps a readable minimum width (${JSON.stringify(m.chip)})`);
    if (width >= 700) assert.ok(m.chip?.name && m.chip.width >= 100, `${tag}: the whole chip (${JSON.stringify(m.chip)})`);
    assert.ok(m.mailbox, `${tag}: the mailbox button is there`);
    assert.ok(m.mailbox.right <= m.bar.right + 0.5 && m.mailbox.left >= m.bar.left, `${tag}: the mailbox (${m.mailbox.left}–${m.mailbox.right}) stays inside the bar (${m.bar.left}–${m.bar.right})`);
    assert.ok(m.status.right <= m.mailbox.left + 0.5, `${tag}: the status ends before the mailbox`);
    assert.ok(m.overflow <= 0, `${tag}: no sideways scroll`);
    release();
    assert.deepEqual(errors.filter((message) => !/Failed to load resource|Failed to fetch/.test(message)), [], `${tag}: no page errors`);
    await context.close();
  }
});
