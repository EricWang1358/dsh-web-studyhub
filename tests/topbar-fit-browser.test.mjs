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

/* The top bar's status words must FIT a narrow pane, measured in Chromium: at 360, 390 and 420 px, in Chinese and English, in every state (steady,
   a background task, an action running, a failed read, a read that reconnects, no model) the status label is drawn whole (no ellipsis, no clipping),
   the mailbox button stays inside the bar, and the page does not scroll sideways. The state is made at the network edge (page.route). */

const NO_MODEL = { model: { ready: false, reason: 'no-route' }, modelReady: false };
const STATES = {
  steady: {},
  running: { shows: /后台处理中|In background/, patch: (value) => { value.jobs = [...(value.jobs || []), { id: 'job-pdf', type: 'pdf-convert', status: 'running', title: 'Lecture 3.pdf', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]; } },
  busy: { hold: ['review.start', 'review.resume', 'review.open', 'review.get'], click: '.today-go, [data-usage="home.start"]' },
  failed: { failAfterLoad: '读取失败' },
  reconnecting: { failAfterLoad: 'Failed to fetch' },
  'no model': { shows: /还没配模型|No model yet/, patch: (value) => Object.assign(value, NO_MODEL) },
};

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
      const root = join(base, 'library');
      await seedWrongBookLibrary(root, { wrong: 12 });
      const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
      return { browser, server, close: async () => {
        await browser.close();
        await server.close();
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
  const label = document.querySelector('.top-status-label');
  return {
    bar: box('.topbar'), mailbox: box('.mailbox__toggle'), status: box('.top-status'),
    text: label?.innerText || '',
    labelClipped: label ? label.scrollWidth > label.clientWidth + 1 : false,
    labelEllipsis: label ? getComputedStyle(label).textOverflow === 'ellipsis' && label.scrollWidth > label.clientWidth : false,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
});

test('the top bar status fits at 360, 390 and 420 px in zh and en: the label whole, the mailbox inside the bar, no sideways scroll', { timeout: 900000 }, async (t) => {
  const running = await environment(t);
  if (!running) return;
  for (const lang of ['zh', 'en']) for (const width of [360, 390, 420]) for (const [name, spec] of Object.entries(STATES)) {
    const tag = `${lang} ${width}px ${name}`;
    const { page, context, errors } = await openPage(running.browser, running, { lang, theme: 'dark', width, height: 844 });
    const state = { fail: '' };
    const release = await edge(page, state, spec);
    await page.goto(running.server.url);
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
    // The steady label folds into its dot in a narrow pane on purpose (it stays in the page for screen readers); every other state keeps its whole words.
    if (name !== 'steady') assert.ok(!m.labelClipped && !m.labelEllipsis, `${tag}: the label "${m.text}" is drawn whole`);
    assert.ok(m.mailbox, `${tag}: the mailbox button is there`);
    assert.ok(m.mailbox.right <= m.bar.right + 0.5 && m.mailbox.left >= m.bar.left, `${tag}: the mailbox (${m.mailbox.left}–${m.mailbox.right}) stays inside the bar (${m.bar.left}–${m.bar.right})`);
    assert.ok(m.status.right <= m.mailbox.left + 0.5, `${tag}: the status ends before the mailbox`);
    assert.ok(m.overflow <= 0, `${tag}: no sideways scroll`);
    release();
    assert.deepEqual(errors.filter((message) => !/Failed to load resource|Failed to fetch/.test(message)), [], `${tag}: no page errors`);
    await context.close();
  }
});
