/* WP-E QA: build scripts/qa/wave1-e-app.jsx and screenshot the MinerU token form, the audio job rows, the mailbox opened from the
   keyboard (focus inside the panel) and the exam error state in zh x dark wide/narrow, plus the English mailbox and the light
   audio rows, then check what static markup cannot: focus after opening the mailbox, one-row job actions at 420 px.
   Usage: node scripts/qa/wave1-e.mjs [--out output/wave1-e] */
/* global document, getComputedStyle */
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
const out = resolve(root, option('out', 'output/wave1-e'));
const site = join(out, 'site');
await mkdir(site, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['scripts/qa/wave1-e-app.jsx'], bundle: true, outfile: join(site, 'app.js'), format: 'iife', platform: 'browser',
  loader: { '.css': 'text' }, jsx: 'transform', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"development"' } });
await writeFile(join(site, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>wave1-e</title></head><body><div id="root"></div><script src="app.js"></script></body></html>\n');
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

const shots = [
  ['mineru', 'zh', 'dark', 1280], ['mineru', 'zh', 'dark', 420], ['audio', 'zh', 'dark', 1280], ['audio', 'zh', 'dark', 420], ['audio', 'zh', 'light', 420],
  ['inbox', 'zh', 'dark', 1280], ['inbox', 'zh', 'dark', 420], ['inbox', 'en', 'dark', 1280], ['exam', 'zh', 'dark', 1280], ['exam', 'zh', 'dark', 420],
];
for (const [scene, lang, theme, width] of shots) {
  const { tab, close } = await open(scene, lang, theme, width, scene === 'mineru' ? 1400 : 860);
  if (scene === 'inbox') {
    await tab.keyboard.press('Tab');
    await tab.keyboard.press('Enter');
    await tab.waitForSelector('.mailbox__panel');
    await tab.waitForTimeout(250);
    const info = await tab.evaluate(() => {
      const active = document.activeElement;
      const ring = active ? getComputedStyle(active).outlineStyle : '';
      return { inside: !!active?.closest('.mailbox__panel'), tag: active?.tagName, text: active?.textContent?.slice(0, 20), ring, times: [...document.querySelectorAll('.mailbox__time')].map(node => node.textContent) };
    });
    if (lang === 'zh' && width === 1280) check('after keyboard open, focus is inside the mailbox panel', info.inside, JSON.stringify(info));
    if (lang === 'en') check('English ages are singular/plural correct', info.times.includes('1 minute ago') && info.times.includes('1 hour ago') && !info.times.some(label => /days? ago/.test(label)), info.times.join(' | '));
    if (lang === 'zh' && width === 1280) {
      await tab.keyboard.press('Escape');
      await tab.waitForTimeout(150);
      check('Escape returns focus to the toggle', await tab.evaluate(() => document.activeElement?.classList.contains('mailbox__toggle')));
      await tab.keyboard.press('Enter');
      await tab.waitForSelector('.mailbox__panel');
      await tab.waitForTimeout(250);
    }
  }
  if (scene === 'exam') {
    check(`exam error is a shared alert (${width})`, await tab.locator('.sh-inline[role="alert"], [role="alert"].sh-inline').count() >= 1 && await tab.locator('.exam-error').count() === 0);
  }
  if (scene === 'mineru' && width === 420) {
    const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('MinerU settings do not scroll sideways at 420 px', overflow <= 0, String(overflow));
    check('MinerU token field is the shared SecretKeyForm', await tab.locator('form.sh-secret input[name="mineru-token"][type="password"]').count() === 1);
  }
  if (scene === 'audio' && width === 420) {
    const rows = await tab.evaluate(() => [...document.querySelectorAll('.sh-job')].map(row => {
      const box = node => node.getBoundingClientRect();
      const actions = row.querySelector('.sh-job__actions');
      const title = row.querySelector('.sh-job__title');
      const textBox = button => { const range = document.createRange(); range.selectNodeContents(button); return range.getBoundingClientRect(); };
      const buttons = actions ? [...actions.querySelectorAll('.sh-btn')].map(button => ({ text: button.textContent.trim().slice(0, 12), textBottom: Math.round(textBox(button).bottom), left: Math.round(box(button).left) })) : [];
      const labels = actions ? [...actions.querySelectorAll('.sh-btn')].map(button => { const range = document.createRange(); range.selectNodeContents(button); return Math.round(range.getBoundingClientRect().left); }) : [];
      return { cls: row.className, border: getComputedStyle(row).borderTopColor, titleLeft: Math.round(box(title).left), buttons, firstTextLeft: labels[0] };
    }));
    const done = rows.find(row => row.cls.includes('sh-job--complete'));
    check('complete row: link and 知道了 share one line and one baseline (±1px)', done.buttons.length === 2 && Math.abs(done.buttons[0].textBottom - done.buttons[1].textBottom) <= 1, JSON.stringify(done.buttons));
    check('complete row: the first action text starts at the title edge (±2px)', Math.abs(done.firstTextLeft - done.titleLeft) <= 2, `${done.firstTextLeft} vs ${done.titleLeft}`);
    const running = rows.find(row => row.cls.includes('sh-job--running'));
    check('running row border is not cinnabar', !/^rgb\((19\d|20\d|21\d),/.test(running.border), running.border);
  }
  await tab.screenshot({ path: join(out, `${scene}-${lang}-${theme}-${width}.png`), fullPage: scene === 'mineru' });
  await close();
}
await browser.close();
check('no page or console errors', !errors.length, errors.slice(0, 5).join(' | '));
await writeFile(join(out, 'summary.json'), JSON.stringify({ results, errors }, null, 2));
process.exit(results.every(result => result.ok) ? 0 : 1);
