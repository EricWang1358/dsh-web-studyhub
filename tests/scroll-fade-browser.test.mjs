/* global localStorage, document, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* #747, in a browser: the settings categories become a horizontal strip on a narrow pane, so the side with more categories beyond it has to fade.
   The attributes are the hook's answer (ui/components/use-scroll-edges.js) and the mask is the shared stylesheet's (ui/components/scroll-fade.css). */

const card = (id, n) => ({ id, kind: 'flashcard', topic: 'Topic', objective: 'Recall', prompt: `Question ${n}?`, answer: `Answer ${n}`, hint: '',
  explanation: 'Because.', misconception: '', citations: [] });

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'scroll-fade-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update((state) => { state.decks.push({ id: 'd1', title: 'First', cards: [1, 2].map((n) => card(`c${n}`, n)) }); });
  return { root, service };
}

const maskOf = (page) => page.locator('.settings-nav').evaluate((nav) => getComputedStyle(nav).maskImage);
const scrollTo = async (page, where) => {
  await page.locator('.settings-nav').evaluate((nav, to) => { nav.scrollLeft = to === 'end' ? nav.scrollWidth : 0; }, where);
  // The hook answers from the scroll event: wait for the attribute the stylesheet keys on.
  await page.waitForFunction((to) => { const nav = document.querySelector('.settings-nav');
    return to === 'end' ? nav?.hasAttribute('data-fade-start') && !nav?.hasAttribute('data-fade-end') : !nav?.hasAttribute('data-fade-start'); }, where);
};

test('in the browser: the narrow settings strip fades the side that still has categories (#747)', { timeout: 600000 }, async (t) => {
  const { root, service } = await library(t);
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }
  // The settings categories turn into a strip when the APP (the @container study) is under 860px; below the sidebar's width it moves into a drawer, so
  // the way to Settings is the top bar's menu button.
  const page = await browser.newPage({ viewport: { width: 820, height: 900 } }), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); });
  await page.goto(server.url);
  await page.locator('[data-tour="nav-library"], .nav-menu-toggle').first().waitFor();
  if (!(await page.locator('.sidebar').count())) {
    await page.locator('.nav-menu-toggle').click();
    await page.locator('.nav-drawer').waitFor();
  }
  await page.locator('[data-tour="nav-settings"]').first().click();
  const nav = page.locator('.settings-nav');
  await nav.waitFor();
  assert.match(await nav.getAttribute('class'), /\bsh-fade-x\b/, 'the strip takes the shared class');
  // The list opens with the selected category scrolled into view, so go to the start first: then the end is the only side with more.
  await scrollTo(page, 'start');
  assert.equal(await nav.getAttribute('data-fade-end'), 'true', 'the end fades');
  assert.equal(await nav.getAttribute('data-fade-start'), null, 'nothing is off screen to the start');
  const endMask = await maskOf(page);
  assert.match(endMask, /linear-gradient/, 'the stylesheet paints the fade');
  // Scrolled to the last category: the start fades, the end does not, and the mask turns around.
  await scrollTo(page, 'end');
  const startMask = await maskOf(page);
  assert.notEqual(startMask, endMask, 'the fade follows the side that has content');
  // And back: the end fades again, on the same element (a mask paints, it does not rebuild anything).
  await scrollTo(page, 'start');
  // A category reached by the keyboard scrolls in with a fade's width to spare, not under the fade (the browser reads scroll-padding for that).
  assert.equal(await nav.evaluate((box) => getComputedStyle(box).scrollPaddingInline), '28px', 'the strip pads its scroll by the width of its fade');
  assert.equal(await nav.getAttribute('data-fade-end'), 'true', 'the attribute is on the element itself');
  // A wide pane turns the list upright: nothing scrolls sideways, so no fade is asked for.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForFunction(() => { const box = document.querySelector('.settings-nav'); return box && !box.hasAttribute('data-fade-end') && !box.hasAttribute('data-fade-start'); });
  assert.doesNotMatch(await maskOf(page), /linear-gradient/, 'a vertical list wears no mask');
  assert.deepEqual(errors, []);
});
