/* global document, getComputedStyle, NodeFilter */
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
import { StudyService } from '../lib/service.js';
import { sampleAction } from '../lib/sample-library.js';
import { confirmStartIfAsked } from '../scripts/qa/confirm-start.mjs';

/* #1073 round 7 of the review of PR #1118, measured in a real browser on the sample course:
     4  the citation card under an answered question ends in its → (StudyHub's own reader, never the external mark), with the Button's gap before it, level
        with the card's first line (±1px; the external mark led the title 3.5px off its line, with no gap);
     6  the first-run card's model step with a long model id: no line ends with the 「·」 of the provider, and the whole label is in the shared Tooltip on hover
        and on keyboard focus (since round 8: when the card cuts it, only then);
     7  at 420px an idle row's ▶ takes keyboard focus as a ring around the glyph (not the slot's 74 - 101px), and its centre is level with the bar's (±0.5px).
   ICON_ROUND7_SHOTS=<dir> keeps a screenshot of each place. */

const SHOTS = process.env.ICON_ROUND7_SHOTS || '';
const ARROW = 'M220.24,132.24';
const LONG = 'SiliconFlow · Qwen/Qwen3-235B-A22B-Instruct-2507';

async function seedSample(root, lang) {
  const service = new StudyService(root);
  await service.call('snapshot');
  await sampleAction({ call: (name, input) => service.call(name, input), store: service.store, has: () => true }, 'sample.load', { language: lang });
  await service.dispose?.();
}

async function serve(base, lang, dist) {
  const root = join(base, lang, 'library');
  await mkdir(root, { recursive: true });
  await seedSample(root, lang);
  return createPreviewServer({ libraryRoot: root, home: join(base, lang, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
}

async function open(browser, server, { lang = 'zh', theme = 'light', width = 1440, height = 900, label = '' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme, locale: lang === 'en' ? 'en-US' : 'zh-CN' });
  await context.addInitScript(([l, t]) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-theme', t); localStorage.setItem('study-autopilot', 'off'); localStorage.setItem('study-auto-advance', 'off'); } catch { /* blocked */ } }, [lang, theme]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  // The model's label as DSH reports it for a real provider (the fake model's is short).
  if (label) await page.route('**/api/call', async (route) => {
    let action = '';
    try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
    if (action !== 'snapshot') return route.continue();
    try {
      const response = await route.fetch(), body = await response.json();
      if (body?.value?.model && typeof body.value.model === 'object') body.value.model.label = label;
      return await route.fulfill({ response, json: body });
    } catch { return undefined; /* the page closed while the snapshot was on its way */ }
  });
  await page.goto(server.url);
  await page.locator('.study-app').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  const later = page.getByRole('button', { name: lang === 'en' ? /Maybe later|Not now/ : '以后再说' });
  if (await later.count()) { await later.first().click(); await page.waitForTimeout(800); }
  return { context, page, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
// Keyboard focus as the learner's (:focus-visible): a key is pressed first, so a script's focus counts as keyboard focus.
const keyboardFocus = async (page, locator) => { await page.keyboard.press('Shift'); await locator.focus(); await page.waitForTimeout(500); };
const shown = (page) => page.evaluate(() => [...document.querySelectorAll('.sh-tooltip')].filter((card) => card.getClientRects().length && getComputedStyle(card).visibility !== 'hidden').map((card) => card.textContent.trim()));

test('round 7 in the browser: the citation card\'s arrow, the first-run model id, the narrow ▶ under keyboard focus', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-icon-round7-'));
  const dist = join(base, 'dist');
  await buildPreview({ outdir: dist });
  const servers = {};
  try {
    servers.zh = await serve(base, 'zh', dist);
    servers.en = await serve(base, 'en', dist);

    await t.test('4: the citation card ends in its →, with the gap before it, level with its first line (zh light 1440, en dark 420)', async () => {
      for (const [lang, theme, width] of [['zh', 'light', 1440], ['en', 'dark', 420]]) {
        const where = `${lang} ${theme} ${width}px`;
        const { page, context, errors } = await open(browser, servers[lang], { lang, theme, width });
        // The first choice question of the second deck (its flashcards before it are turned and rated), answered: its explanation carries the citations.
        let answered = false;
        await page.locator('.deck-row .map-play').nth(1).click({ force: true });
        await confirmStartIfAsked(page, page.locator('.question-card, .flash-area'));
        await page.locator('.question-card, .flash-area').first().waitFor({ timeout: 30000 });
        await page.keyboard.press('Escape');
        for (let step = 0; step < 8 && !answered; step++) {
          const options = page.locator('.option:not([disabled])');
          if (await options.count()) {
            await options.first().click();
            const submit = page.getByRole('button', { name: lang === 'en' ? /^Submit/ : /^提交/ });
            if (await submit.count()) await submit.first().click().catch(() => {});
            answered = await page.locator('.citation-disclosure').first().waitFor({ state: 'attached', timeout: 10000 }).then(() => true, () => false);
            break;
          }
          await page.keyboard.press('Space');
          await page.waitForTimeout(700);
          await page.keyboard.press('3');
          await page.waitForTimeout(1000);
        }
        assert.ok(answered, `${where}: an answered question shows its citations`);
        // The cards are drawn once 引用与来源核对 is open.
        const disclosure = page.locator('.citation-disclosure').first();
        if (!(await disclosure.evaluate((element) => element.open))) { await disclosure.locator('summary').first().scrollIntoViewIfNeeded(); await disclosure.locator('summary').first().click(); }
        await page.locator('.citations .citations__button').first().waitFor({ timeout: 10000 });
        await page.waitForTimeout(500);
        const cards = await page.evaluate(() => [...document.querySelectorAll('.citations .citations__button')].filter((button) => button.getClientRects().length).map((button) => {
          const svgs = [...button.querySelectorAll('svg')], icon = svgs.at(-1).getBoundingClientRect();
          const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT), rects = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.data.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0));
          }
          const top = Math.min(...rects.map((rect) => rect.top)), first = rects.filter((rect) => rect.top < top + 2);
          const right = Math.max(...first.map((rect) => rect.right)), bottom = Math.max(...first.map((rect) => rect.bottom));
          return { text: button.textContent.trim().slice(0, 30), icons: svgs.length, path: svgs.at(-1).querySelector('path')?.getAttribute('d')?.slice(0, 14),
            gap: +(icon.left - right).toFixed(2), mid: +((top + bottom - icon.top - icon.bottom) / 2).toFixed(2) };
        }));
        assert.ok(cards.length >= 1, `${where}: the citation cards are there`);
        for (const card of cards) {
          assert.equal(card.icons, 1, `${where}: 「${card.text}」 draws one icon (${JSON.stringify(card)})`);
          assert.equal(card.path, ARROW, `${where}: 「${card.text}」 ends in the → of StudyHub's own reader, not the external mark (${JSON.stringify(card)})`);
          assert.ok(card.gap >= 6, `${where}: 「${card.text}」 keeps the Button's gap before its arrow (${JSON.stringify(card)})`);
          assert.ok(Math.abs(card.mid) <= 1, `${where}: 「${card.text}」's arrow is level with its first line, ±1px (${JSON.stringify(card)})`);
        }
        await page.evaluate(() => document.querySelector('.citations')?.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(300);
        await shot(page, `citation-${lang}-${theme}-${width}`);
        assert.deepEqual(errors, [], where);
        await context.close();
      }
    });

    await t.test('6: the model step with a long id ends no line in 「·」 and shows the whole label on hover and on keyboard focus (zh 1440, en 420)', async () => {
      for (const [lang, width] of [['zh', 1440], ['en', 420]]) {
        const where = `${lang} ${width}px`;
        const { page, context, errors } = await open(browser, servers[lang], { lang, width, height: width < 700 ? 844 : 900, label: LONG });
        const text = page.locator('.first-run-card .frl-step[data-step="model"] .frl-step__text').first();
        await text.waitFor({ timeout: 30000 });
        await page.mouse.move(1, 1);
        await page.waitForTimeout(400);
        const seen = await text.evaluate((element) => {
          const box = element.getBoundingClientRect(), lines = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) for (let at = 0; at < node.data.length; at++) {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + 1);
            const rect = [...range.getClientRects()].find((entry) => entry.width > 0);
            if (!rect || rect.bottom > box.bottom + 1) continue;
            const line = lines.find((entry) => Math.abs(entry.top - rect.top) < 4);
            if (line) line.text += node.data[at]; else lines.push({ top: rect.top, text: node.data[at] });
          }
          return { lines: lines.map((line) => line.text), title: element.closest('[title]')?.getAttribute('title') || '' };
        });
        assert.ok(seen.lines.join('').includes('SiliconFlow'), `${where}: the model step names the provider (${JSON.stringify(seen.lines)})`);
        for (const line of seen.lines) assert.doesNotMatch(line.trimEnd(), /·$/, `${where}: no line ends with the provider's 「·」 (${JSON.stringify(seen.lines)})`);
        assert.equal(seen.title, '', `${where}: no title attribute; the shared Tooltip says the label`);
        await shot(page, `first-run-long-id-${lang}-${width}`);
        // Round 8: the whole label is in the Tooltip, and the row a Tab stop, only when the card cuts it (tests/icon-round8-browser.test.mjs measures both cases).
        const cut = await text.evaluate((element) => element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1);
        await text.hover();
        await page.waitForTimeout(700);
        assert.equal((await shown(page)).includes(LONG), cut, `${where}: hovering the model step shows the whole label when it is cut, only then (${JSON.stringify(await shown(page))})`);
        await shot(page, `first-run-long-id-hover-${lang}-${width}`);
        await page.mouse.move(1, 1);
        await page.waitForTimeout(500);
        assert.equal(await text.evaluate((element) => element.tabIndex), cut ? 0 : -1, `${where}: the model step is a Tab stop when it is cut, only then`);
        if (cut) {
          await keyboardFocus(page, text);
          assert.ok(await text.evaluate((element) => element.matches(':focus-visible')), `${where}: the model step takes keyboard focus`);
          assert.ok((await shown(page)).includes(LONG), `${where}: keyboard focus on the model step shows the whole label`);
        }
        await shot(page, `first-run-long-id-focus-${lang}-${width}`);
        assert.deepEqual(errors, [], where);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
      }
    });

    await t.test('7: at 420px the keyboard ring of an idle ▶ hugs the glyph, and the ▶ is level with the bar (zh and en)', async () => {
      for (const lang of ['zh', 'en']) {
        const where = `${lang} 420px`;
        const { page, context, errors } = await open(browser, servers[lang], { lang, width: 420, height: 844 });
        const play = page.locator('.deck-row .map-play:not(.is-run)').first();
        await play.waitFor({ timeout: 30000 });
        await play.evaluate((element) => element.scrollIntoView({ block: 'center' }));
        await keyboardFocus(page, play);
        const seen = await play.evaluate((button) => {
          const ring = (element) => {
            const style = getComputedStyle(element), box = element.getBoundingClientRect();
            const out = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 ? parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth) : null;
            return { outline: out === null ? null : { width: +(box.width + 2 * out).toFixed(1), height: +(box.height + 2 * out).toFixed(1) }, shadow: style.boxShadow !== 'none' };
          };
          const face = button.querySelector('.map-play__face:not(.map-play__ghost)'), icon = face.querySelector('svg').getBoundingClientRect();
          const bar = button.closest('.map-row').querySelector('.mastery-bar').getBoundingClientRect();
          return { focus: button.matches(':focus-visible'), slot: +button.getBoundingClientRect().width.toFixed(1), button: ring(button), face: ring(face),
            level: +((icon.top + icon.bottom) / 2 - (bar.top + bar.bottom) / 2).toFixed(2) };
        });
        assert.ok(seen.focus, `${where}: the ▶ has keyboard focus`);
        assert.ok(!seen.button.outline && !seen.button.shadow, `${where}: no ring around the slot's ${seen.slot}px (${JSON.stringify(seen)})`);
        assert.ok(seen.face.outline && seen.face.outline.width <= 32 && seen.face.outline.height <= 32, `${where}: the ring hugs the ▶ (${JSON.stringify(seen)})`);
        assert.ok(Math.abs(seen.level) <= 0.5, `${where}: the ▶ is level with the bar, ±0.5px (${JSON.stringify(seen)})`);
        await shot(page, `play-focus-${lang}-420`);
        assert.deepEqual(errors, [], where);
        await context.close();
      }
    });
  } finally {
    await browser.close();
    for (const server of Object.values(servers)) await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
