/* global document */
/* node scripts/qa/wpm-shots.mjs [--out <dir>]
   Screenshots of the materials / import / generation-status / update surfaces (UI consistency wave 2, WP-M) from fixed-props galleries
   (scripts/qa/wpm-gallery.jsx and scripts/qa/mineru-gallery.jsx): the deck-merge confirmation, the PDF job rows and the history,
   the import hub with classified errors, the generate page without a model, the update settings. zh + dark at 1280 and 420 wide,
   and en + light at 1280 and 420. Nothing leaves the computer; no library, key or token is read. Chromium: PLAYWRIGHT_CHROMIUM or
   the one under ms-playwright. */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChromium } from './browser.mjs';
import { scrubProcessEnv } from './env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const out = resolve(args.find(arg => arg.startsWith('--out='))?.slice(6) ?? join(root, 'output/wave2-m'));
const sleep = ms => new Promise(done => setTimeout(done, ms));
scrubProcessEnv();
await mkdir(out, { recursive: true });

async function gallery(name, entry) {
  const site = join(out, name);
  await mkdir(site, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, outfile: join(site, 'gallery.js'), format: 'iife', platform: 'browser',
    loader: { '.css': 'text' }, jsx: 'transform', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"development"' } });
  await writeFile(join(site, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>wpm</title></head><body><div id="root"></div><script src="gallery.js"></script></body></html>');
  return pathToFileURL(join(site, 'index.html')).href;
}
const wpm = await gallery('gallery-wpm', 'scripts/qa/wpm-gallery.jsx');
const mineru = await gallery('gallery-mineru', 'scripts/qa/mineru-gallery.jsx');

const browser = await launchChromium();
const shots = [], problems = [];
const combos = [['zh', 'dark', 1280], ['zh', 'dark', 420], ['en', 'light', 1280], ['en', 'light', 420]];
try {
  for (const [lang, theme, width] of combos) {
    const tag = `${lang}-${theme}-${width}`;
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    const tab = await context.newPage();
    tab.on('pageerror', error => problems.push(`${tag}: ${error.message}`));
    tab.on('console', message => { if (message.type() === 'error') problems.push(`${tag} console: ${message.text()}`); });
    const shoot = async (target, name) => {
      const path = join(out, `${name}-${tag}.png`);
      await (target.screenshot ? target.screenshot({ path }) : tab.screenshot({ path }));
      shots.push(path);
    };
    const open = async (url, selector) => { await tab.goto(url); await tab.waitForSelector(selector); await sleep(250); };
    const section = index => tab.locator('.g-section').nth(index);

    // 1. The deck-merge confirmation.
    await open(`${wpm}?lang=${lang}&theme=${theme}&scene=merge`, '#manage-merge-target');
    await tab.selectOption('#manage-merge-target', 'd-se');
    await tab.locator('form:has(#manage-merge-target) button').last().click();
    await tab.waitForSelector('dialog[open]'); await sleep(250);
    await shoot(tab, 'merge-confirm');

    // 2. PDF job rows: running, failed, complete; then the history.
    await open(`${mineru}?lang=${lang}&theme=${theme}&scene=jobs`, '.sh-job');
    await shoot(section(1), 'pdf-job-running-local');
    await shoot(section(3), 'pdf-job-failed');
    await shoot(section(await tab.locator('.g-section').count() - 1), 'pdf-job-complete');
    await open(`${mineru}?lang=${lang}&theme=${theme}&scene=history`, '.pdf-history__row');
    await shoot(section(0), 'pdf-history');
    await shoot(section(2), 'pdf-history-confirm');

    // 3. The import hub with classified errors (one from the host's code and limit, one from the size check in the panel).
    await open(`${wpm}?lang=${lang}&theme=${theme}&scene=import`, '.import-hub .sh-drop');
    await tab.locator('input[type="file"]').first().setInputFiles([
      { name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('PK-not-really-a-docx') },
      { name: 'book.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(9 * 1024 * 1024, 1) }]);
    await tab.waitForSelector('.sh-job-list, [data-status="error"], .sh-file-item', { timeout: 15000 }).catch(() => {});
    await sleep(900);
    await shoot(tab, 'import-hub-errors');

    // 4. The generate page with no model: one gate, at the submit.
    await open(`${wpm}?lang=${lang}&theme=${theme}&scene=generate`, '.sh-setup');
    await shoot(tab, 'generate-no-model');

    // 5. The update settings and the model error notes.
    await open(`${wpm}?lang=${lang}&theme=${theme}&scene=update`, '.update-settings');
    await shoot(section(0), 'update-check-failed');
    await shoot(section(1), 'update-unreachable');
    await shoot(section(3), 'update-available-save-failed');
    await shoot(section(5), 'model-errors');
    await context.close();
  }
} finally { await browser.close(); }
console.log(shots.join('\n'));
if (problems.length) { console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`); process.exitCode = 1; }
