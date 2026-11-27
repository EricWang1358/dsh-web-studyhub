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
  } finally {
    await server.close();
    await browser.close();
    await rm(base, { recursive: true, force: true });
  }
});
