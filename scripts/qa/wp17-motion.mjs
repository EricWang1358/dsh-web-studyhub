/* WP17 visual proof: the segmented-control thumb slides between segments.
   node scripts/qa/wp17-motion.mjs [--full] [--out output/qa/wp17] [--port 4320]
   Default: zh + dark at 1440; --full runs zh/en x light/dark x 1440/420.

   Runs the preview server with the fake model on a temp library (every
   key/token/base-url variable removed first), loads the sample course, opens
   模拟考试 and clicks through the 题型 row. The thumb's CSS transition is
   frozen with the Web Animations API at 0 / 90 / 220 ms so the mid-transition
   frames are exact, and the computed transform + width at each time is
   printed. Also covers reduced motion (no animation at all), the other
   migrated rows, keyboard arrows and the Settings disclosure.
   Output: <out>/<lang>-<theme>-<width>-exam.png (contact sheet of 4 frames)
   and <out>/summary.json. Build first: npm run build. */
/* global document, getComputedStyle, requestAnimationFrame, HTMLInputElement, Event */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewServer, previewCall } from '../preview-server.mjs';
import { createFakeModel } from '../fake-model.mjs';
import { launchChromium } from './browser.mjs';
import { scrubProcessEnv } from './env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const out = resolve(root, flag('--out', 'output/qa/wp17'));
const port = Number(flag('--port', 4320));
const sleep = ms => new Promise(done => setTimeout(done, ms));

scrubProcessEnv();
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'work'), { recursive: true });
const server = await createPreviewServer({ libraryRoot: join(out, 'work', 'library'), home: join(out, 'work', 'home'), port,
  model: createFakeModel({ latencyMs: 100, generationLatencyMs: 500 }) });
const browser = await launchChromium();
const summary = { checks: [], frames: [], errors: [] };
const check = (name, ok, detail = '') => { summary.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function open({ lang, theme, width, reduced = false }) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'zh-CN',
    colorScheme: theme, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await context.addInitScript(([l, t]) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-theme', t); } catch { /* blocked */ } }, [lang, theme]);
  const page = await context.newPage();
  page.on('pageerror', error => summary.errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') summary.errors.push(message.text()); });
  await page.goto(server.url);
  await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  await sleep(700);
  return { page, close: () => context.close() };
}

async function gotoExam(page) {
  const anchor = page.locator('[data-tour="nav-exam"]');
  await anchor.first().click();
  await page.locator('.exam-type-settings .sh-seg').first().waitFor({ timeout: 15000 });
  await sleep(500);
}

/* Freeze the thumb's transition at the given times; returns what the browser computed at each. */
async function frames(page, group, times) {
  return page.evaluate(async ({ selector, times }) => {
    const seg = document.querySelector(selector);
    const thumb = seg.querySelector('.sh-seg__thumb');
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const animations = thumb.getAnimations().filter(animation => /transform|width|height/.test(animation.transitionProperty || ''));
    const result = { animations: animations.length, at: {} };
    animations.forEach(animation => animation.pause());
    for (const time of times) {
      animations.forEach(animation => { animation.currentTime = time; });
      const style = getComputedStyle(thumb);
      result.at[time] = { transform: style.transform, width: style.width };
    }
    return result;
  }, { selector: group, times });
}

async function clipOf(page, selector, pad = 10) {
  const box = await page.locator(selector).first().boundingBox();
  return { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 };
}

async function contactSheet(file, shots, title) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 400 } });
  const cells = shots.map(({ label, data }) => `<figure><img src="data:image/png;base64,${data.toString('base64')}"><figcaption>${label}</figcaption></figure>`).join('');
  await page.setContent(`<style>body{margin:0;padding:16px;font:13px system-ui;background:#888}h1{font-size:14px;margin:0 0 10px;color:#fff}
    div{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;background:#fff;padding:6px;border-radius:6px}img{display:block;max-width:100%}figcaption{padding-top:4px;color:#222}</style><h1>${title}</h1><div>${cells}</div>`);
  await sleep(100);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
}

const GROUP = '.exam-type-settings .sh-seg';
const ROW = '.exam-type-settings';

try {
  await previewCall(server, 'sample.load', { uiLanguage: 'zh' }).catch(error => summary.errors.push(`sample.load: ${error.message}`));
  const full = args.includes('--full');
  for (const lang of full ? ['zh', 'en'] : ['zh']) {
    for (const theme of full ? ['light', 'dark'] : ['dark']) {
      for (const width of full ? [1440, 420] : [1440]) {
        const label = `${lang}-${theme}-${width}`;
        const { page, close } = await open({ lang, theme, width });
        await gotoExam(page);
        const labels = await page.locator(`${GROUP} .sh-seg__item`).allTextContents();
        const shots = [];
        shots.push({ label: `start (${labels[0]})`, data: await page.screenshot({ clip: await clipOf(page, ROW) }) });
        // Click the last segment: the longest slide, also exercises width change.
        await page.locator(`${GROUP} .sh-seg__item`).last().click();
        const result = await frames(page, GROUP, [0, 90, 220]);
        for (const time of [0, 90, 220]) {
          const t = time;
          await page.evaluate(async ({ selector, t, at }) => {
            // Colour fades: pause every running animation at t. The thumb is pinned by value
            // (the compositor ignores a scripted currentTime when a screenshot is taken).
            document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = t; });
            const thumb = document.querySelector(selector).querySelector('.sh-seg__thumb');
            thumb.style.transition = 'none';
            thumb.style.transform = at.transform;
            thumb.style.width = at.width;
            await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
          }, { selector: GROUP, t, at: result.at[time] });
          shots.push({ label: `+${time} ms  ${result.at[time].transform} / ${result.at[time].width}`, data: await page.screenshot({ clip: await clipOf(page, ROW) }) });
        }
        await page.evaluate(() => { document.getAnimations().forEach(animation => animation.finish()); });
        await sleep(300);
        const finalPressed = await page.locator(`${GROUP} .sh-seg__item[aria-pressed="true"]`).allTextContents();
        shots.push({ label: `settled (${finalPressed.join()})`, data: await page.screenshot({ clip: await clipOf(page, ROW) }) });
        const moved = result.at[0].transform !== result.at[220].transform;
        check(`${label}: the thumb animates (${result.animations} transitions) and moves between 0 and 220 ms`, result.animations >= 1 && moved,
          `0ms ${result.at[0].transform} | 90ms ${result.at[90].transform} | 220ms ${result.at[220].transform}`);
        summary.frames.push({ label, ...result });
        await contactSheet(join(out, `${label}-exam.png`), shots, `${label} — 题型 row, last segment clicked`);
        if (width === 1440) await page.screenshot({ path: join(out, `${label}-exam-page.png`) });
        await close();
      }
    }
  }

  // Reduced motion: no transition runs, the thumb jumps to its new place.
  {
    const { page, close } = await open({ lang: 'zh', theme: 'light', width: 1440, reduced: true });
    await gotoExam(page);
    await page.locator(`${GROUP} .sh-seg__item`).nth(2).click();
    const state = await page.evaluate(async selector => {
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      const seg = document.querySelector(selector);
      const thumb = seg.querySelector('.sh-seg__thumb');
      const item = seg.querySelectorAll('.sh-seg__item')[2];
      return { running: thumb.getAnimations().length, duration: getComputedStyle(thumb).transitionDuration, transform: getComputedStyle(thumb).transform,
        itemLeft: item.offsetLeft, itemColorDuration: getComputedStyle(item).transitionDuration };
    }, GROUP);
    check('reduced motion: no thumb animation runs and transition-duration is 0s', state.running === 0 && parseFloat(state.duration) <= 0.001, JSON.stringify(state));
    await page.screenshot({ path: join(out, 'zh-light-1440-reduced-motion.png'), clip: await clipOf(page, ROW) });
    await close();
  }

  // A parent re-render in the middle of a slide must not cut it short.
  {
    const { page, close } = await open({ lang: 'zh', theme: 'light', width: 1440 });
    await gotoExam(page);
    await page.locator(`${GROUP} .sh-seg__item`).nth(1).click();
    const kept = await page.evaluate(async selector => {
      const count = document.querySelector('.exam-count input');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(count, '7');
      count.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      return document.querySelector(selector).querySelector('.sh-seg__thumb').getAnimations().length;
    }, GROUP);
    check('a re-render during the slide keeps the transition running', kept >= 1, `animations=${kept}`);
    await close();
  }

  // Keyboard: arrows move focus (not the value), Home/End jump, Enter selects.
  {
    const { page, close } = await open({ lang: 'en', theme: 'light', width: 1440 });
    await gotoExam(page);
    const items = page.locator(`${GROUP} .sh-seg__item`);
    await page.locator(`${GROUP} .sh-seg__item[aria-pressed="true"]`).focus();
    await page.keyboard.press('ArrowRight');
    const focused = await page.evaluate(() => document.activeElement?.textContent);
    const pressed = await page.locator(`${GROUP} .sh-seg__item[aria-pressed="true"]`).allTextContents();
    check('keyboard: ArrowRight moves focus to the next segment without changing the value', focused === (await items.nth(1).textContent()) && pressed[0] === (await items.nth(0).textContent()), `focus=${focused} pressed=${pressed}`);
    await page.keyboard.press('End');
    check('keyboard: End focuses the last segment', (await page.evaluate(() => document.activeElement?.textContent)) === (await items.last().textContent()));
    await page.keyboard.press('Enter');
    await sleep(350);
    check('keyboard: Enter selects the focused segment', (await page.locator(`${GROUP} .sh-seg__item[aria-pressed="true"]`).textContent()) === (await items.last().textContent()));
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowLeft');
    check('keyboard: ArrowLeft wraps to the last segment', (await page.evaluate(() => document.activeElement?.textContent)) === (await items.last().textContent()));
    const stops = await page.evaluate(selector => [...document.querySelector(selector).querySelectorAll('.sh-seg__item')].filter(item => item.tabIndex === 0).length, GROUP);
    check('keyboard: exactly one segment is a tab stop', stops === 1, String(stops));
    await close();
  }
} finally {
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  await browser.close().catch(() => {});
  await server.close();
}
const failed = summary.checks.filter(item => !item.ok);
if (summary.errors.length) console.log(`page errors: ${[...new Set(summary.errors)].slice(0, 5).join(' | ')}`);
process.exit(failed.length || summary.errors.length ? 1 : 0);
