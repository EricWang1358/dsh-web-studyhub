/* WP-C QA: build scripts/qa/wave1-c-app.jsx and screenshot the mailbox (failed + successful letters, empty), the audio job rows,
   the dashboard empty state and the graph error state in zh/en × dark/light at 1280 and 420 px, then check what static tests
   cannot: the job row's live region stays silent while its timer ticks, and the mailbox panel scrolls inside a ScrollWindow.
   Usage: node scripts/qa/wave1-c.mjs [--out output/wave1-c] [--langs zh,en] [--themes dark,light] */
/* global document, window, getComputedStyle, MutationObserver */
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
const out = resolve(root, option('out', 'output/wave1-c'));
const langs = option('langs', 'zh,en').split(','), themes = option('themes', 'dark,light').split(',');
const site = join(out, 'site');
await mkdir(site, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['scripts/qa/wave1-c-app.jsx'], bundle: true, outfile: join(site, 'app.js'), format: 'iife', platform: 'browser',
  loader: { '.css': 'text' }, jsx: 'transform', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"development"' } });
await writeFile(join(site, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>wave1-c</title></head><body><div id="root"></div><script src="app.js"></script></body></html>\n');
const page = pathToFileURL(join(site, 'index.html')).href;

const browser = await launchChromium();
const results = [], errors = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };
async function open(scene, lang, theme, width, height = 860) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme, locale: lang === 'en' ? 'en-US' : 'zh-CN' });
  const tab = await context.newPage();
  tab.on('pageerror', error => errors.push(`${scene}: ${error.message}`));
  tab.on('console', message => { if (message.type() === 'error') errors.push(`${scene}: ${message.text()}`); });
  await tab.goto(`${page}?scene=${scene}&lang=${lang}&theme=${theme}`);
  await tab.waitForSelector('.study-app');
  await tab.waitForTimeout(500);
  return { tab, close: () => context.close() };
}
const scenesList = ['inbox', 'inbox-empty', 'audio', 'dashboard', 'graph'];
for (const lang of langs) for (const theme of themes) for (const width of [1280, 420]) for (const scene of scenesList) {
  const { tab, close } = await open(scene, lang, theme, width);
  await tab.screenshot({ path: join(out, `${scene}-${lang}-${theme}-${width}.png`) });
  if (scene === 'inbox' && lang === 'zh' && theme === 'dark' && width === 1280) {
    const info = await tab.evaluate(() => {
      const pill = [...document.querySelectorAll('.mailbox__item .sh-badge')].map(node => ({ text: node.textContent.trim(), tone: node.dataset.tone, icon: !!node.querySelector('svg'), size: getComputedStyle(node).fontSize }));
      const viewport = document.querySelector('.mailbox__panel .sh-scroll__viewport');
      const sizes = [...document.querySelectorAll('.mailbox__panel *')].map(node => getComputedStyle(node).fontSize);
      return { pill, scrollable: viewport.scrollHeight > viewport.clientHeight, region: viewport.getAttribute('role'), sizes: [...new Set(sizes)] };
    });
    check('mailbox pills carry tone and the failed one an icon', info.pill.some(p => p.tone === 'error' && p.icon) && info.pill.some(p => p.tone === 'success') && info.pill.some(p => p.tone === 'warning'), JSON.stringify(info.pill));
    check('mailbox text is on the token scale (12-17px)', info.sizes.every(size => parseFloat(size) >= 12 && parseFloat(size) <= 17), info.sizes.join(','));
    check('mailbox list is a named scroll region', info.region === 'region');
  }
  if (scene === 'graph' && lang === 'zh' && theme === 'dark' && width === 1280) {
    check('graph error is an alert with a Button retry', await tab.locator('.graph-state [role="alert"] button.sh-btn').count() === 1);
  }
  if (scene === 'dashboard' && lang === 'zh' && theme === 'dark' && width === 1280) {
    check('dashboard empty state is a sh-empty with a primary action', await tab.locator('.sh-empty .sh-btn--primary').count() >= 1);
  }
  await close();
}

// The live region of a ticking job row speaks only when the status or stage changes.
{
  const { tab, close } = await open('livejob', 'zh', 'dark', 1280);
  const spoken = await tab.evaluate(async () => {
    const node = document.querySelector('.sh-job [role="status"]');
    let mutations = 0;
    new MutationObserver(records => { mutations += records.length; }).observe(node, { childList: true, characterData: true, subtree: true });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const ticking = mutations;
    window.__liveJob.setStage('proofread');
    await new Promise(resolve => setTimeout(resolve, 200));
    const afterStage = mutations;
    window.__liveJob.setStatus('complete');
    await new Promise(resolve => setTimeout(resolve, 200));
    return { ticking, afterStage, afterComplete: mutations, text: node.textContent };
  });
  check('a ticking job row announces nothing for 1.5 s of timer updates', spoken.ticking === 0, JSON.stringify(spoken));
  check('a stage change and a completion announce once each', spoken.afterStage - spoken.ticking >= 1 && spoken.afterComplete - spoken.afterStage >= 1 && spoken.afterComplete <= 4, JSON.stringify(spoken));
  await close();
}
const { tab, close } = await open('primitives', 'zh', 'dark', 1280, 1500);
await tab.screenshot({ path: join(out, 'primitives-zh-dark-1280.png'), fullPage: true });
await close();
const narrow = await open('primitives', 'zh', 'light', 420, 1800);
await narrow.tab.screenshot({ path: join(out, 'primitives-zh-light-420.png'), fullPage: true });
await narrow.close();
await browser.close();
check('no page or console errors', !errors.length, errors.slice(0, 5).join(' | '));
await writeFile(join(out, 'summary.json'), JSON.stringify({ results, errors }, null, 2));
process.exit(results.every(result => result.ok) ? 0 : 1);
