/* global document, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';

/* The home and 统计 of the sample course, measured in a real browser (#1690, #1703, #1704):
     1690  at 420px every part of the home's left column sits under the course heading, the pace line right after 掌握度, and a part nobody gave a place
           still cannot rise above the heading;
     1703  at 1280 and 1440, no line of a 需要补强 row on 统计 holds a single character, and the count with its unit is never split;
     1704  the first-run card's index-card ruling ends above its buttons, in both themes, and every step row still sits on it;
   HOME_LAYOUT_SHOTS=<dir> keeps a screenshot of each place. */

const SHOTS = process.env.HOME_LAYOUT_SHOTS || '';

async function open(browser, server, { width = 1440, height = 900, theme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, locale: 'zh-CN' });
  await context.addInitScript((t) => { try { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-theme', t); localStorage.setItem('study-autopilot', 'off'); } catch { /* blocked */ } }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(server.url);
  await page.locator('.study-app').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  const later = page.getByRole('button', { name: '以后再说' });
  if (await later.count()) { await later.first().click(); await page.waitForTimeout(800); }
  await page.locator('.first-run-card').waitFor({ timeout: 30000 });
  return { context, page, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };

test('the sample course\'s home and 统计 in a real browser', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-home-layout-'));
  await buildPreview({ outdir: join(base, 'dist') });
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  const root = join(base, 'library');
  await mkdir(root, { recursive: true });
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: join(base, 'dist') });
  try {
    await previewCall(server, 'sample.load', { language: 'zh', uiLanguage: 'zh' });

    await t.test('#1690: at 420px the left column reads heading, mastery, pace, next step; an unplaced part never rises above the heading', async () => {
      const { context, page, errors } = await open(browser, server, { width: 420, height: 860 });
      const tops = () => page.evaluate(() => Object.fromEntries(['course-header', 'desk-mastery', 'pace-meta', 'desk-next', 'unplaced-part'].map((name) => {
        const element = document.querySelector(`.desk-intro > .${name}`);
        return [name, element ? Math.round(element.getBoundingClientRect().top) : null];
      })));
      const at = await tops();
      assert.ok(at['pace-meta'] !== null, `the sample draws the pace line: ${JSON.stringify(at)}`);
      assert.ok(at['course-header'] < at['desk-mastery'] && at['desk-mastery'] < at['pace-meta'] && at['pace-meta'] < at['desk-next'], JSON.stringify(at));
      await shot(page, 'home-420-order');
      await page.evaluate(() => { const part = document.createElement('p'); part.className = 'unplaced-part'; part.textContent = '以后新增的一行'; document.querySelector('.desk-intro').prepend(part); });
      const added = await tops();
      assert.ok(added['unplaced-part'] > added['course-header'], `a part with no place of its own stays under the heading: ${JSON.stringify(added)}`);
      assert.deepEqual(errors, []);
      await context.close();
    });

    await t.test('#1704: no ruled line of the first-run card runs under or beside its buttons, and the step rows sit on the ruling', async () => {
      for (const [width, theme] of [[1440, 'light'], [420, 'dark']]) {
        const { context, page } = await open(browser, server, { width, height: width < 500 ? 860 : 900, theme });
        // The card is dealt in and tilts under the pointer: measured at rest.
        await page.mouse.move(0, 0);
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.first-run-card')).transform === 'none');
        const seen = await page.evaluate(() => {
          const card = document.querySelector('.first-run-card'), box = (element) => element.getBoundingClientRect();
          // Where each ruled background is painted: from its background-position down to the foot of the element that carries it.
          const ruled = [card, ...card.querySelectorAll('*')].filter((element) => getComputedStyle(element).backgroundImage.startsWith('repeating-linear-gradient'))
            .map((element) => ({ top: box(element).top + (parseFloat(getComputedStyle(element).backgroundPositionY) || 0), bottom: box(element).bottom, left: box(element).left, right: box(element).right }));
          return { ruled, buttons: [...card.querySelectorAll('.today-go, .frl-sample-round')].map((button) => ({ words: button.innerText.trim(), top: box(button).top })),
            rows: [...card.querySelectorAll('.frl-step__row')].map((row) => ({ top: box(row).top, bottom: box(row).bottom })), card: { left: box(card).left, right: box(card).right } };
        });
        assert.equal(seen.buttons.length, 2, `${width}px: 添加资料 and 练一轮示例题 (${JSON.stringify(seen.buttons)})`);
        assert.equal(seen.ruled.length, 1, `${width}px ${theme}: one ruled area (${JSON.stringify(seen.ruled)})`);
        const [area] = seen.ruled;
        for (const button of seen.buttons) assert.ok(area.bottom <= button.top, `${width}px ${theme}: the ruling stops above 「${button.words}」 (ruled to ${area.bottom}, button at ${button.top})`);
        assert.ok(area.left - seen.card.left <= 1.5 && seen.card.right - area.right <= 1.5, `${width}px: the ruling still runs the card's width ${JSON.stringify([area, seen.card])}`);
        // Every row ends on a rule: a whole number of 32px lines below where the ruling starts.
        for (const row of seen.rows) {
          const lines = (row.bottom - area.top) / 32;
          assert.ok(Math.abs(lines - Math.round(lines)) < 0.05 && row.bottom <= area.bottom + 0.5, `${width}px ${theme}: a step row sits on the ruling (${lines} lines)`);
        }
        await shot(page, `first-run-card-${width}-${theme}`);
        await context.close();
      }
    });

    await t.test('#1703: no 需要补强 row of 统计 leaves a single character on a line or splits the count from its unit, at 1280 and 1440', async () => {
      for (const width of [1280, 1440]) {
        const { context, page } = await open(browser, server, { width });
        await page.locator('[data-tour="nav-dashboard"]').first().click();
        await page.locator('.dash-weak-row').first().waitFor({ timeout: 30000 });
        await page.waitForTimeout(800);
        const rows = () => page.evaluate(() => [...document.querySelector('.dash-weak').querySelectorAll('.dash-weak-row')].map((row) => {
          // The description as the screen breaks it: its characters grouped by the line they are drawn on.
          const small = row.querySelector('.dash-weak-name small'), walker = document.createTreeWalker(small, 4), range = document.createRange(), lines = new Map();
          for (let node = walker.nextNode(); node; node = walker.nextNode()) for (let at = 0; at < node.length; at += 1) {
            range.setStart(node, at); range.setEnd(node, at + 1);
            const box = range.getClientRects()[0];
            if (box && box.width) lines.set(Math.round(box.top), (lines.get(Math.round(box.top)) || '') + node.data[at]);
          }
          return [...lines.values()].map((line) => line.trim()).filter(Boolean);
        }));
        const check = (seen, when) => {
          assert.ok(seen.length >= 2, `${width}px: the sample has weak topics`);
          for (const lines of seen) {
            assert.ok(lines.every((line) => line.length > 1), `${width}px ${when}: a single character on a line of its own ${JSON.stringify(lines)}`);
            assert.ok(lines.some((line) => /当前薄弱 \d+ 题/.test(line)), `${width}px ${when}: the count and its unit share a line ${JSON.stringify(lines)}`);
          }
        };
        check(await rows(), 'as drawn');
        await shot(page, `stats-weak-${width}`);
        // A longer deck name wraps above the count; the count still goes down whole.
        for (let extra = 1; extra <= 12; extra += 1) {
          await page.evaluate((more) => { for (const lead of document.querySelectorAll('.dash-weak-name small')) { const node = document.createTreeWalker(lead, 4).nextNode(); node.original ??= node.data; node.data = `${'课'.repeat(more * 3)}${node.original}`; } }, extra);
          check(await rows(), `with a ${extra * 3}-character deck name`);
        }
        await context.close();
      }
    });
  } finally {
    await server.close();
    await browser.close();
    await rm(base, { recursive: true, force: true });
  }
});
