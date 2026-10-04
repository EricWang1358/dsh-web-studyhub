/* WP-Q QA (#176): build scripts/qa/wp-q-app.jsx and drive the real 👎 control with a fake host. Checks that a rewrite tag
   sends rewriteVia: "assist" and opens the 修题 box prefilled (no toast, no silent rewrite), that a difficulty tag shows the
   one-line note, that old hosts without onFix keep the old request, and the aria contract of the 👎 control; screenshots in
   zh/en × dark/light at 1280 and 420 px.
   Usage: node scripts/qa/wp-q.mjs [--out output/wave3-q] [--langs zh,en] [--themes dark,light] */
/* global window */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChromium } from './browser.mjs';
import { scrubProcessEnv } from './env.mjs';

scrubProcessEnv();
const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const out = resolve(root, option('out', 'output/wave3-q'));
const langs = option('langs', 'zh,en').split(','), themes = option('themes', 'dark,light').split(',');
const site = join(out, 'site');
await mkdir(site, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['scripts/qa/wp-q-app.jsx'], bundle: true, outfile: join(site, 'app.js'), format: 'iife', platform: 'browser',
  loader: { '.css': 'text' }, jsx: 'transform', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"development"' } });
await writeFile(join(site, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>wp-q</title></head><body><div id="root"></div><script src="app.js"></script></body></html>\n');
const page = pathToFileURL(join(site, 'index.html')).href;

const browser = await launchChromium();
const results = [], errors = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };
async function open(lang, theme, width, query = '') {
  const context = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 1, colorScheme: theme, locale: lang === 'en' ? 'en-US' : 'zh-CN' });
  const tab = await context.newPage();
  tab.on('pageerror', error => errors.push(error.message));
  tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await tab.goto(`${page}?lang=${lang}&theme=${theme}${query}`);
  await tab.waitForSelector('.thumbs');
  return { tab, close: () => context.close() };
}
const tag = (tab, index) => tab.locator('.thumb-tray .coach-chip').nth(index);
const feedbackCalls = tab => tab.evaluate(() => window.__calls.filter(call => call.action === 'coach.feedback').map(call => call.args));

for (const lang of langs) for (const theme of themes) for (const width of [1280, 420]) {
  const shot = name => join(out, `${name}-${lang}-${theme}-${width}.png`);
  // 1. A rewrite tag: recorded as "assist", the 修题 box opens prefilled, nothing else claims to be rewriting.
  {
    const { tab, close } = await open(lang, theme, width);
    const down = tab.locator('button[aria-keyshortcuts="B"]');
    await down.click();
    await tab.waitForSelector('.thumb-tray');
    await tag(tab, 0).click(); // stem-vague
    await tab.screenshot({ path: shot('tray') });
    await tab.waitForSelector('textarea', { timeout: 4000 });
    const sent = await feedbackCalls(tab);
    const submitted = sent.find(call => call.tags?.length);
    check(`rewrite tag sends rewriteVia assist [${lang}-${theme}-${width}]`, submitted?.rewriteVia === 'assist', JSON.stringify(sent));
    const text = await tab.locator('textarea').inputValue();
    check(`the 修题 box is prefilled from the tag [${lang}-${theme}-${width}]`, text.trim().length > 10, text);
    await tab.waitForTimeout(300);
    await tab.screenshot({ path: shot('fix-box') });
    if (lang === 'zh' && theme === 'dark' && width === 1280) {
      const button = await tab.locator('button[aria-keyshortcuts="B"]').evaluate(node => ({ pressed: node.getAttribute('aria-pressed'), expanded: node.getAttribute('aria-expanded'), controls: node.getAttribute('aria-controls'), described: node.getAttribute('aria-describedby') }));
      check('the 👎 control has aria-expanded and no aria-pressed', button.pressed === null && button.expanded !== null, JSON.stringify(button));
      const voice = await tab.locator('.thumbs .sr-only').textContent();
      check('the vote is conveyed as hidden text', /问题|problem/i.test(voice), voice);
    }
    await close();
  }
  // 2. A difficulty tag with consent: the one-line note, once, and no 修题 box.
  {
    const { tab, close } = await open(lang, theme, width);
    await tab.locator('button[aria-keyshortcuts="B"]').click();
    await tab.waitForSelector('.thumb-tray');
    await tag(tab, 3).click(); // too-hard
    await tab.waitForSelector('.sh-toast', { timeout: 4000 });
    const note = await tab.locator('.sh-toast').allTextContents();
    check(`difficulty tag shows one note [${lang}-${theme}-${width}]`, note.length === 1 && (lang === 'zh' ? /已记下，下一轮据此准备定制题/.test(note[0]) : /Tailored practice/.test(note[0])), note.join('|'));
    check(`difficulty tag does not open the 修题 box [${lang}-${theme}-${width}]`, await tab.locator('textarea').count() === 0);
    const tray = await tab.locator('.sh-toast-region, [role="status"]').count();
    check(`the note is announced through one live region [${lang}-${theme}-${width}]`, tray >= 1);
    await tab.screenshot({ path: shot('difficulty-note') });
    await close();
  }
}

// 3. Old host contract: without onFix the request carries no flag and nothing opens.
{
  const { tab, close } = await open('zh', 'dark', 1280, '&onFix=0');
  await tab.locator('button[aria-keyshortcuts="B"]').click();
  await tab.waitForSelector('.thumb-tray');
  await tag(tab, 0).click();
  await tab.waitForTimeout(1800);
  const sent = (await feedbackCalls(tab)).find(call => call.tags?.length);
  check('without onFix the request keeps the old behaviour (no rewriteVia)', sent && sent.rewriteVia === undefined, JSON.stringify(sent));
  await close();
}

// 4. Keyboard: Escape closes the tray and the trigger keeps its expanded state honest.
{
  const { tab, close } = await open('zh', 'dark', 1280);
  const down = tab.locator('button[aria-keyshortcuts="B"]');
  await down.click();
  check('opening sets aria-expanded true and points at the tray', await down.getAttribute('aria-expanded') === 'true' && !!(await down.getAttribute('aria-controls')));
  await tab.keyboard.press('Escape');
  check('Escape closes the tray', await down.getAttribute('aria-expanded') === 'false' && await down.getAttribute('aria-controls') === null);
  await close();
}

await browser.close();
if (errors.length) { console.log('page errors:', [...new Set(errors)].join('\n')); }
check('no page errors', !errors.length);
const failed = results.filter(result => !result.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
