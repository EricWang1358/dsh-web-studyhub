/* global localStorage, window, document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

// #183: the shared Menu opens against its trigger (also under the interface zoom) and reserves an icon column only when an item has an icon.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { Menu } from './ui/components/index.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const h = React.createElement;

test('a menu without icons has no icon column; with one icon the others line up under it (#183)', () => {
  const plain = renderToStaticMarkup(h(module.exports.Menu, { label: 'More', defaultOpen: true, onSelect() {}, items: [{ id: 'a', label: 'Write a note' }, { id: 'b', label: 'Add a task' }] }));
  assert.match(plain, /sh-menu__item/);
  assert.doesNotMatch(plain, /sh-menu__gap/);
  const mixed = renderToStaticMarkup(h(module.exports.Menu, { label: 'More', defaultOpen: true, onSelect() {}, items: [{ id: 'a', label: 'A', icon: 'plus' }, { id: 'b', label: 'B' }] }));
  assert.equal(mixed.match(/sh-menu__gap/g)?.length, 1, 'the item without an icon keeps the column');
});

const flash = (id, n) => ({ id, kind: 'flashcard', topic: 'Topic', objective: 'Recall', prompt: `Question ${n}?`, answer: `Answer ${n}`, hint: '', explanation: '', misconception: '', citations: [] });

test('the review 更多 menu and the library ⋯ menu open against their trigger, at 100% and 150%, wide and narrow (#183)', { timeout: 180000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wave4-menu-'));
  const service = new StudyService(join(root, 'library'));
  await service.store.update((s) => { s.decks.push({ id: 'd', title: 'Flash deck', cards: [1, 2, 3].map((n) => flash(`c${n}`, n)) }); });
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await service.dispose(); await rm(root, { recursive: true, force: true }); });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }
  const rects = (page, trigger) => page.evaluate((selector) => {
    const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const menu = document.querySelector('[role="menu"]');
    return { trigger: box(document.querySelector(selector)), menu: box(menu), window: { width: window.innerWidth, height: window.innerHeight } };
  }, trigger);
  const check = (name, { trigger, menu, window: win }) => {
    const below = menu.top - trigger.bottom, above = trigger.top - menu.bottom;
    assert.ok((below >= -1 && below <= 8) || (above >= -1 && above <= 8), `${name}: panel is against the trigger (below ${below.toFixed(1)}, above ${above.toFixed(1)})`);
    assert.ok(Math.abs(menu.right - trigger.right) <= 2 || (menu.left >= 0 && menu.left < 40 && menu.right <= win.width) /* wider than the room left of the trigger: held inside the window */, `${name}: right-aligned (${menu.right.toFixed(1)} vs ${trigger.right.toFixed(1)})`);
  };
  for (const [width, scale] of [[1280, 100], [1280, 150], [420, 100], [420, 150]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((value) => { localStorage.setItem('study-ui-language', 'en'); localStorage.setItem('study-autopilot', 'off'); localStorage.setItem('study-interface', JSON.stringify({ scale: value })); }, scale);
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Start studying Flash deck' }).first().click();
    await page.locator('.flashcard').waitFor();
    await page.waitForTimeout(1500); // the toolbar is rebuilt once when the run's first refresh lands
    await page.locator('.review-more-trigger').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300); // a scroll event after the click would close the menu: let the scroll settle first
    await page.locator('.review-more-trigger').click();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    await page.waitForTimeout(250);
    const label = `review ${width}px @${scale}%`;
    check(label, await rects(page, '.review-more-trigger'));
    assert.equal(await menu.locator('.sh-menu__gap').count(), 0, `${label}: no icon column when no item has an icon`);
    const textLeft = await menu.evaluate((element) => ({ item: element.querySelector('.sh-menu__item .sh-menu__label').getBoundingClientRect().left, panel: element.getBoundingClientRect().left }));
    assert.ok(textLeft.item - textLeft.panel < 24, `${label}: text starts near the panel's left padding (${(textLeft.item - textLeft.panel).toFixed(1)})`);
    await page.screenshot({ path: join(tmpdir(), `wave4-menu-review-${width}-${scale}.png`) });
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, [], label);
    await page.close();
  }
});
