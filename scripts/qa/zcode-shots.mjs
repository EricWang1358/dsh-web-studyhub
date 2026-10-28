/* global document, window */
/* node scripts/qa/zcode-shots.mjs [--out=<dir>]
   Real-browser screenshots of the ZCode panel: the production panel bundle (the --test build of scripts/build-zcode.mjs)
   in Chromium, loaded through packages/studyhub-zcode/scripts/test-panel-server.mjs, which reaches the real MCP server
   (host/entry.mjs) over stdio as ZCode does. At 1280 and 420 px:
     1. the panel's first screen (empty library, no model)
     2. Settings › 学习库与模型 with the ZCode model form empty
     3. the same with an endpoint saved (filled; the key shows only its last four characters)
     4. 创建题组 with one material and no model: the page's model gate (its 前往设置 opens the form of 2; a block gate
        elsewhere carries the form itself)
   Every shot is checked for horizontal overflow, page errors and console errors. Library and home are temporary folders
   under output/; inherited keys are removed first, and nothing calls a model. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';
import { scrubProcessEnv } from './env.mjs';
import { buildZcodePanel } from '../build-zcode.mjs';
import { createTestPanelServer } from '../../packages/studyhub-zcode/scripts/test-panel-server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) || join(root, 'output', 'qa', 'zcode'));
scrubProcessEnv();
await mkdir(out, { recursive: true });
await mkdir(join(root, 'output'), { recursive: true });
const scratch = await mkdtemp(join(root, 'output', 'zcode-qa-'));
const ui = join(scratch, 'ui');
await buildZcodePanel({ outdir: ui, test: true });

const results = [];
const browser = await launchChromium();
const server = await createTestPanelServer({ libraryRoot: join(scratch, 'library'), home: join(scratch, 'home'), uiDir: ui, env: process.env });
const call = async (action, args = {}) => JSON.parse((await server.client.callTool({ name: 'study_call', arguments: { action, args } })).content[0].text);
try {
  // One material, so 创建题组 reaches the step that needs a model.
  await call('source.add', { title: '光合作用讲义', text: '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。光反应发生在类囊体膜上，暗反应发生在叶绿体基质中。'.repeat(3) });
  for (const filled of [false, true]) {
    if (filled) await call('model.config.set', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', label: '智谱 GLM', apiKey: 'sk-demo-not-real-7f3a' });
    for (const width of [1280, 420]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
      await page.goto(server.url);
      await page.waitForSelector('.study-app main', { timeout: 60_000 });
      await page.waitForFunction(() => !document.getElementById('studyhub-boot'));
      await page.waitForTimeout(800);
      const shoot = async (name) => {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const file = join(out, `${name}-${width}.png`);
        await page.screenshot({ path: file });
        results.push({ shot: file, width, overflow, errors: [...errors] });
      };
      if (!filled) {
        await shoot('zcode-panel-first');
        // The gate before generation, with the endpoint form inside it.
        await page.getByRole('button', { name: /创建题组/ }).first().click();
        // The page's own gate (a banner on top, the block at the submit step); the block carries the endpoint form.
        await page.waitForSelector('.sh-setup, .sh-banner', { timeout: 20_000 });
        const form = page.locator('.sh-setup .zcode-model');
        if (await form.count()) await form.first().scrollIntoViewIfNeeded();
        else await page.locator('.sh-setup').last().scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(300);
        await shoot('zcode-generate-gate');
      }
      // Settings › 学习库与模型: the top bar's model state opens it while no model is connected; Settings otherwise.
      const fix = page.locator('.top-status__fix');
      if (await fix.count()) await fix.first().click();
      else {
        await page.getByRole('button', { name: /^设置$/ }).first().click();
        await page.getByRole('button', { name: '学习库与模型' }).first().click();
      }
      try { await page.waitForSelector('[data-tour="settings-model"]', { timeout: 20_000 }); }
      catch (error) { await page.screenshot({ path: join(out, `debug-${width}.png`) }); throw error; }
      await page.locator('[data-tour="settings-model"]').scrollIntoViewIfNeeded();
      await page.waitForSelector('.zcode-model', { timeout: 20_000 });
      await page.locator('.zcode-model').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shoot(filled ? 'zcode-model-form-filled' : 'zcode-model-form-empty');
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
  await rm(scratch, { recursive: true, force: true });
}
let failed = false;
for (const result of results) {
  const bad = result.overflow > 0 || result.errors.length;
  failed ||= bad;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${result.shot} overflow=${result.overflow}${result.errors.length ? ` errors=${JSON.stringify(result.errors)}` : ''}`);
}
process.exit(failed ? 1 : 0);
