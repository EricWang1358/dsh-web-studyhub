/* WP-X QA: build scripts/qa/wpx-app.jsx and screenshot the written exam (setup, running, report), the case paper (setup, running, report),
   the oral exam (setup, running, report) and the audio form (empty, with files and jobs): zh dark at 1280 and 420, plus en light at 1280,
   and check what static tests cannot (the clock reads m:ss, the page restores its run, nothing throws).
   Usage: node scripts/qa/wpx.mjs [--out output/wave1-x] [--langs zh,en] [--themes dark,light] */
/* global document */
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
const out = resolve(root, option('out', 'output/wave1-x'));
const site = join(out, 'site');
await mkdir(site, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['scripts/qa/wpx-app.jsx'], bundle: true, outfile: join(site, 'app.js'), format: 'iife', platform: 'browser',
  loader: { '.css': 'text' }, jsx: 'transform', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"development"' } });
await writeFile(join(site, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>wpx</title></head><body><div id="root"></div><script src="app.js"></script></body></html>\n');
const page = pathToFileURL(join(site, 'index.html')).href;

const browser = await launchChromium();
const results = [], errors = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };
async function open(scene, lang, theme, width, height = 900) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme, locale: lang === 'en' ? 'en-US' : 'zh-CN' });
  const tab = await context.newPage();
  tab.on('pageerror', error => errors.push(`${scene}: ${error.message}`));
  tab.on('console', message => { if (message.type() === 'error') errors.push(`${scene}: ${message.text()}`); });
  await tab.goto(`${page}?scene=${scene}&lang=${lang}&theme=${theme}`);
  await tab.waitForSelector('.study-app');
  await tab.waitForTimeout(700);
  return { tab, close: () => context.close() };
}
const scenes = ['exam-setup', 'exam-running', 'exam-report', 'case-setup', 'case-setup-nomodel', 'case-running', 'case-report', 'oral-setup', 'oral-running', 'oral-report', 'audio', 'audio-empty'];
const shots = [['zh', 'dark', 1280], ['zh', 'dark', 420], ['en', 'light', 1280]];
for (const scene of scenes) for (const [lang, theme, width] of shots) {
  const { tab, close } = await open(scene, lang, theme, width);
  await tab.screenshot({ path: join(out, `${scene}-${lang}-${theme}-${width}.png`), fullPage: true });
  if (lang === 'zh' && theme === 'dark' && width === 1280) {
    const text = await tab.evaluate(() => document.querySelector('main').innerText);
    if (scene === 'exam-running') {
      check('the written exam restores its run and shows the clock as m:ss', /已用时 7:1\d/.test(text) && /3 \/ 10/.test(text), text.slice(0, 120).replace(/\n/g, ' | '));
      check('the running exam has one h1 (the shared page header)', await tab.locator('main h1').count() === 1);
    }
    if (scene === 'exam-report') check('the report opens from its run id with the score and a human duration', /70%/.test(text) && /18 分 22 秒/.test(text), text.slice(0, 160).replace(/\n/g, ' | '));
    if (scene === 'case-running') check('the case paper restores into the writing phase with a countdown clock', /作答时间/.test(text) && /\d+:\d\d/.test(text) && !/^0\d:/m.test(text), text.slice(0, 120).replace(/\n/g, ' | '));
    if (scene === 'case-report') check('the case report opens from its run id', /各题得分/.test(text) && /7/.test(text));
    if (scene === 'oral-running') check('the oral exam restores its active run', /第 2 \/ 5 题/.test(text) && /覆盖索引/.test(text));
    if (scene === 'oral-report') check('the oral report opens from its run id', /3 题回答扎实/.test(text));
    if (scene === 'case-setup-nomodel') check('the grade gate is the shared block gate', /先配置一个 AI 模型/.test(text) && /批改需要模型/.test(text));
    if (scene === 'audio') check('the audio form shows its jobs, files, split offer and the order controls', /分段并继续/.test(text) && /lecture-week4/.test(text) && await tab.locator('.audio-order-actions .sh-btn--icon').count() === 4);
  }
  await close();
}
await browser.close();
check('no page or console errors', !errors.length, errors.slice(0, 6).join(' | '));
await writeFile(join(out, 'summary.json'), JSON.stringify({ results, errors }, null, 2));
process.exit(results.every(result => result.ok) ? 0 : 1);
