/* global document, getComputedStyle, NodeFilter, Buffer */
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

/* #1073 round 8 of the review of PR #1118, measured in a real browser:
     4  a citation card's → sits at the card's inline end (it floated after the title, 178px short of the end on a wide card), with the Button's gap before it
        and level with the first line;
     6  a first-run step's words are in the shared Tooltip, and a Tab stop, when the row cuts them and only then (the model step was a stop with a Tooltip
        even when shown whole; the material step was cut with neither);
     7  the 更多 menu of a 资料 row lists menu items (no border or fill of their own, every text 17px in, 补全原文件… too), and a finished round has one
        way back with ← (it had 返回学习库, 回到学习路径 and 回到学习目录).
   ICON_ROUND8_SHOTS=<dir> keeps a screenshot of each place. */

const SHOTS = process.env.ICON_ROUND8_SHOTS || '';
const ARROW = 'M220.24,132.24';
const TYPICAL = 'siliconflow · Qwen/Qwen2.5-7B-Instruct';
const VLONG = 'OpenRouter · deepseek/deepseek-r1-distill-llama-70b:free-extended-context-preview-2026-11-17-experimental-build';

async function serve(base, name, { lang = 'zh', sample = true, own = false } = {}) {
  const root = join(base, name, 'library');
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  if (sample) await sampleAction({ call: (action, input) => service.call(action, input), store: service.store, has: () => true }, 'sample.load', { language: lang });
  if (own) await service.store.update((state) => { state.sources.push({ id: 'own1', title: '我的讲义 · 第一章.md', text: '线程、锁与死锁。'.repeat(60), createdAt: '2026-11-01T08:00:00.000Z', courses: ['操作系统'], chars: 480 }); });
  await service.dispose?.();
  return createPreviewServer({ libraryRoot: root, home: join(base, name, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: join(base, 'dist') });
}

async function open(browser, server, { lang = 'zh', theme = 'light', width = 1440, height = 900, label = '', dismiss = true } = {}) {
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
  if (dismiss) {
    await page.keyboard.press('Escape');
    const later = page.getByRole('button', { name: lang === 'en' ? /Maybe later|Not now/ : '以后再说' });
    if (await later.count()) { await later.first().click(); await page.waitForTimeout(800); }
  }
  return { context, page, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const shown = (page) => page.evaluate(() => [...document.querySelectorAll('.sh-tooltip')].filter((card) => card.getClientRects().length && getComputedStyle(card).visibility !== 'hidden').map((card) => card.textContent.trim()));

/** Answer the first choice question of the second deck (its flashcards before it turned and rated) so that its citations show. */
async function answerChoice(page, lang) {
  await page.locator('.deck-row .map-play').nth(1).click({ force: true });
  await confirmStartIfAsked(page, page.locator('.question-card, .flash-area'));
  await page.locator('.question-card, .flash-area').first().waitFor({ timeout: 30000 });
  await page.keyboard.press('Escape');
  for (let step = 0; step < 8; step++) {
    const options = page.locator('.option:not([disabled])');
    if (await options.count()) {
      await options.first().click();
      const submit = page.getByRole('button', { name: lang === 'en' ? /^Submit/ : /^提交/ });
      if (await submit.count()) await submit.first().click().catch(() => {});
      return page.locator('.citation-disclosure').first().waitFor({ state: 'attached', timeout: 10000 }).then(() => true, () => false);
    }
    await page.keyboard.press('Space');
    await page.waitForTimeout(700);
    await page.keyboard.press('3');
    await page.waitForTimeout(1000);
  }
  return false;
}

test('round 8 in the browser: the citation card\'s → at its end, the first-run steps\' Tooltip only when cut, the 资料 更多 menu and one way back', { timeout: 1200000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-icon-round8-'));
  await buildPreview({ outdir: join(base, 'dist') });
  const servers = {};
  try {
    servers.zh = await serve(base, 'zh');

    await t.test('4: the citation card\'s → sits at its inline end, the gap before it, level with the first line (zh/en 1440, zh dark 420)', async () => {
      for (const [lang, theme, width] of [['zh', 'light', 1440], ['en', 'light', 1440], ['zh', 'dark', 420]]) {
        const where = `${lang} ${theme} ${width}px`;
        // A library of its own for each place: the same first choice question, not the one after it that an earlier place left.
        const server = servers[`citation-${lang}-${theme}-${width}`] = await serve(base, `citation-${lang}-${theme}-${width}`, { lang });
        const { page, context, errors } = await open(browser, server, { lang, theme, width });
        const answered = await answerChoice(page, lang);
        if (!answered) await shot(page, `citation-missing-${lang}-${theme}-${width}`);
        assert.ok(answered, `${where}: an answered question shows its citations`);
        const disclosure = page.locator('.citation-disclosure').first();
        if (!(await disclosure.evaluate((element) => element.open))) { await disclosure.locator('summary').first().scrollIntoViewIfNeeded(); await disclosure.locator('summary').first().click(); }
        await page.locator('.citations .citations__button').first().waitFor({ timeout: 10000 });
        await page.waitForTimeout(500);
        const cards = await page.evaluate(() => [...document.querySelectorAll('.citations .citations__button')].filter((button) => button.getClientRects().length).map((button) => {
          const box = button.getBoundingClientRect(), style = getComputedStyle(button), svg = [...button.querySelectorAll('svg')].at(-1), icon = svg.getBoundingClientRect();
          const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT), rects = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.data.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0));
          }
          const top = Math.min(...rects.map((rect) => rect.top)), first = rects.filter((rect) => rect.top < top + 2), widest = Math.max(...rects.map((rect) => rect.right));
          return { text: button.textContent.trim().slice(0, 30), path: svg.querySelector('path')?.getAttribute('d')?.slice(0, 14),
            toEnd: +(box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) - icon.right).toFixed(2), gap: +(icon.left - widest).toFixed(2),
            mid: +((top + Math.max(...first.map((rect) => rect.bottom)) - icon.top - icon.bottom) / 2).toFixed(2) };
        }));
        assert.ok(cards.length >= 1, `${where}: the citation cards are there`);
        for (const card of cards) {
          assert.equal(card.path, ARROW, `${where}: 「${card.text}」 ends in → (${JSON.stringify(card)})`);
          assert.ok(Math.abs(card.toEnd) <= 1.5, `${where}: 「${card.text}」's → sits at the card's inline end, ±1.5px (${JSON.stringify(card)})`);
          assert.ok(card.gap >= 6, `${where}: 「${card.text}」 keeps a gap of 6px or more before its → (${JSON.stringify(card)})`);
          assert.ok(Math.abs(card.mid) <= 1, `${where}: 「${card.text}」's → is level with its first line, ±1px (${JSON.stringify(card)})`);
        }
        await page.evaluate(() => document.querySelector('.citations')?.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(300);
        await shot(page, `citation-${lang}-${theme}-${width}`);
        assert.deepEqual(errors, [], where);
        await context.close();
      }
    });

    await t.test('6: a first-run step is a Tab stop with its words in the Tooltip when the card cuts them, and only then (zh 1440 typical id, en 420 long id and long file name)', async () => {
      const seen = { cut: 0, whole: 0 };
      for (const [lang, width, label, file] of [['zh', 1440, TYPICAL, '第3讲 进程与线程.md'], ['en', 420, VLONG, 'Lecture 3 Processes and threads: scheduling, synchronisation and deadlock, the complete notes.md']]) {
        const where = `${lang} ${width}px`;
        const server = servers[`first-run-${lang}-${width}`] = await serve(base, `first-run-${lang}-${width}`, { lang, sample: false });
        const { page, context, errors } = await open(browser, server, { lang, width, height: 900, label, dismiss: false });
        await page.locator('.first-run').first().waitFor({ timeout: 30000 });
        await page.locator('.first-run .sh-btn--primary').first().click();
        const dialog = page.locator('dialog[open], [role="dialog"]').first();
        await dialog.waitFor({ timeout: 30000 });
        await dialog.locator('.sh-drop input[type="file"]').first().setInputFiles({ name: file, mimeType: 'text/markdown', buffer: Buffer.from('# Lecture 3\n\n## Processes\n\nA process owns resources.\n') });
        for (let i = 0; i < 60; i++) {
          if (!(await page.locator('dialog[open]').count()) && (await page.locator('.first-run .frl-step[data-step="deck"][data-open]').count())) break;
          await page.waitForTimeout(500);
        }
        await page.locator('.first-run [data-first-run="later"]').click();
        const card = page.locator('[data-first-run="compact"]');
        await card.waitFor({ timeout: 30000 });
        await page.mouse.move(1, 1);
        await page.waitForTimeout(1200);
        const steps = await card.locator('.frl-step').evaluateAll((list) => list.map((item) => {
          const text = item.querySelector('.frl-step__text');
          return { step: item.dataset.step, cut: text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1, tab: text.tabIndex };
        }));
        for (const step of steps) {
          const text = card.locator(`.frl-step[data-step="${step.step}"] .frl-step__text`).first();
          await text.hover();
          await page.waitForTimeout(800);
          const tip = (await shown(page)).length > 0;
          await page.mouse.move(1, 1);
          await page.waitForTimeout(400);
          assert.equal(step.tab, step.cut ? 0 : -1, `${where}: the ${step.step} step is a Tab stop when cut, only then (${JSON.stringify(steps)})`);
          assert.equal(tip, step.cut, `${where}: hovering the ${step.step} step shows a Tooltip when cut, only then (${JSON.stringify(step)})`);
          seen[step.cut ? 'cut' : 'whole'] += 1;
        }
        if (lang === 'zh') assert.equal(steps.find((step) => step.step === 'model')?.cut, false, `${where}: a typical model id is shown whole (${JSON.stringify(steps)})`);
        else assert.equal(steps.find((step) => step.step === 'material')?.cut, true, `${where}: the long file name is cut on the material step (${JSON.stringify(steps)})`);
        await card.scrollIntoViewIfNeeded();
        await shot(page, `first-run-card-${lang}-${width}`);
        assert.deepEqual(errors, [], where);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
      }
      assert.ok(seen.cut > 0 && seen.whole > 0, `both a cut step and a whole one were measured (${JSON.stringify(seen)})`);
    });

    await t.test('7: the 资料 更多 menu lists menu items: no border or fill, every text 17px in, 补全原文件… too (zh light 1440, en dark 420)', async () => {
      for (const [lang, theme, width] of [['zh', 'light', 1440], ['en', 'dark', 420]]) {
        const where = `${lang} ${theme} ${width}px`;
        const server = servers[`sources-${lang}`] = await serve(base, `sources-${lang}`, { lang, sample: false, own: true });
        const { page, context, errors } = await open(browser, server, { lang, theme, width });
        const nav = page.locator('[data-tour="nav-sources"]').first();
        if (!(await nav.isVisible().catch(() => false))) { await page.locator('.nav-menu-toggle').first().click(); await page.waitForTimeout(400); }
        if (!(await nav.isVisible().catch(() => false))) { await page.locator('.nav-fold__toggle').first().click().catch(() => {}); await page.waitForTimeout(300); }
        await nav.click();
        await page.waitForTimeout(1200);
        await page.keyboard.press('Escape');
        const summary = page.locator('main details.source-row-actions > summary').first();
        await summary.waitFor({ timeout: 30000 });
        await page.mouse.move(1, 1);
        await summary.click();
        await page.waitForTimeout(500);
        await page.mouse.move(1, 1);
        await page.waitForTimeout(300);
        const items = await page.locator('.source-row-menu').first().evaluate((menu) => [...menu.querySelectorAll('button, small')].map((item) => {
          const style = getComputedStyle(item), box = item.getBoundingClientRect();
          const node = [...item.querySelectorAll('*'), item].flatMap((element) => [...element.childNodes]).find((child) => child.nodeType === 3 && child.data.trim());
          const range = document.createRange();
          range.selectNodeContents(node);
          return { text: item.textContent.trim().slice(0, 16), tag: item.tagName, border: style.borderTopColor, background: style.backgroundColor, size: style.fontSize,
            height: +box.height.toFixed(1), start: +(range.getBoundingClientRect().left - box.left).toFixed(1) };
        }));
        const buttons = items.filter((item) => item.tag === 'BUTTON');
        assert.ok(buttons.length >= 5 && buttons.some((item) => /补全原文件|Add the original/.test(item.text)), `${where}: the menu and its 补全原文件… are there (${JSON.stringify(items)})`);
        for (const item of buttons) {
          assert.match(item.border, /rgba\(0, 0, 0, 0\)|transparent/, `${where}: 「${item.text}」 has no border of its own (${JSON.stringify(item)})`);
          assert.match(item.background, /rgba\(0, 0, 0, 0\)|transparent/, `${where}: 「${item.text}」 has no fill of its own (${JSON.stringify(item)})`);
          assert.equal(item.size, buttons[0].size, `${where}: 「${item.text}」 has the menu's text size (${JSON.stringify(items)})`);
          assert.equal(item.height, buttons[0].height, `${where}: 「${item.text}」 has the menu's height (${JSON.stringify(items)})`);
        }
        for (const item of items) assert.ok(Math.abs(item.start - 17) <= 0.5, `${where}: 「${item.text}」 starts its text 17px in (${JSON.stringify(item)})`);
        await shot(page, `source-menu-${lang}-${theme}-${width}`);
        assert.deepEqual(errors, [], where);
        await context.close();
      }
    });

    await t.test('7: a finished round of the sample course has one way back with ←, 回到学习路径 (zh 1440)', async () => {
      const { page, context, errors } = await open(browser, servers.zh, { lang: 'zh', theme: 'light', width: 1440 });
      await page.locator('.deck-row .map-play').nth(1).click({ force: true });
      await confirmStartIfAsked(page, page.locator('.question-card, .flash-area'));
      await page.locator('.question-card, .flash-area').first().waitFor({ timeout: 30000 });
      await page.keyboard.press('Escape');
      for (let i = 0; i < 45; i++) {
        if (await page.locator('.session-summary').count()) break;
        const next = page.getByRole('button', { name: /^下一题|^看结果|^完成|^结束本轮|^看本轮/ }).first();
        if (await next.count() && await next.isEnabled().catch(() => false)) { await next.click(); await page.waitForTimeout(1200); continue; }
        const area = page.locator('main textarea:visible').first();
        if (await area.count()) await area.fill('x');
        for (const input of await page.locator('.question-card input[type="text"]:visible, .question-card input:not([type]):visible').all()) await input.fill('x').catch(() => {});
        if (i > 25) { await page.keyboard.press('k'); await page.waitForTimeout(800); }
        await page.mouse.click(5, 600);
        await page.keyboard.press('1');
        await page.waitForTimeout(500);
        const submit = page.getByRole('button', { name: /^提交/ });
        if (await submit.count() && await submit.first().isEnabled().catch(() => false)) { await submit.first().click().catch(() => {}); await page.waitForTimeout(1200); continue; }
        await page.keyboard.press('Space');
        await page.waitForTimeout(400);
        await page.keyboard.press('1');
        await page.waitForTimeout(900);
      }
      await page.locator('.session-summary').first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(1500);
      const ways = await page.evaluate(() => [...document.querySelectorAll('main button')].filter((button) => button.getClientRects().length
        && button.firstElementChild?.tagName.toLowerCase() === 'svg' && /^(?:返回|回到)/.test(button.textContent.trim())).map((button) => button.textContent.trim().replace(/\s+/g, ' ')));
      assert.deepEqual(ways, ['回到学习路径'], 'one way back with ← on the result page: 回到学习路径, no header 返回学习库, no 回到学习目录 at the foot');
      await shot(page, 'round-result-zh-1440');
      assert.deepEqual(errors, [], 'round result');
      await context.close();
    });
  } finally {
    // The browser first: a server closed while a page still holds its connections waits on them (a failed place leaves its page open).
    await browser.close();
    for (const server of Object.values(servers)) await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
