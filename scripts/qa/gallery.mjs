/* Build the component gallery (scripts/qa/gallery-app.jsx) into
   output/qa/gallery/ and, unless --build-only, screenshot it with Playwright in
   zh/en × dark/light at 1440 and 420 px, then run the browser checks that SSR
   tests cannot: top layer, Escape, focus return, drop isolation, toasts inside
   an open dialog and rendered text contrast.
   Usage: node scripts/qa/gallery.mjs [--build-only] [--out output/qa/wp1]
   Chromium: PLAYWRIGHT_CHROMIUM or %LOCALAPPDATA%/ms-playwright/chromium-1234. */
/* global document, window, getComputedStyle, DataTransfer, File, DragEvent */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const shots = resolve(root, outArg >= 0 ? args[outArg + 1] : 'output/qa/wp1');
const site = resolve(root, 'output/qa/gallery');

await mkdir(site, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['scripts/qa/gallery-app.jsx'], bundle: true, outfile: join(site, 'gallery.js'),
  format: 'iife', platform: 'browser', loader: { '.css': 'text' }, jsx: 'transform', logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
});
await writeFile(join(site, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>StudyHub components</title></head><body><div id="root"></div><script src="gallery.js"></script></body></html>\n');
const page = pathToFileURL(join(site, 'index.html')).href;
console.log(`gallery: ${page}`);
if (args.includes('--build-only')) process.exit(0);

const { chromium } = await import('playwright');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  || join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1234/chrome-win64/chrome.exe');
const browser = await chromium.launch(existsSync(executablePath) ? { executablePath } : {});
await mkdir(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const errors = [];

async function open(query, width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const tab = await context.newPage();
  tab.on('pageerror', error => errors.push(`${query}: ${error.message}`));
  tab.on('console', message => { if (message.type() === 'error') errors.push(`${query}: ${message.text()}`); });
  await tab.goto(`${page}?${query}`);
  await tab.waitForSelector('.study-app');
  await tab.waitForTimeout(150);
  return { tab, close: () => context.close() };
}

// The study app is the scroll container (as in DSH), so full-page shots need
// the container height, not the viewport's.
async function fullShot(tab, file) {
  const height = await tab.evaluate(() => document.querySelector('.study-app').scrollHeight);
  const { width } = tab.viewportSize();
  await tab.setViewportSize({ width, height: Math.min(height, 12000) });
  await tab.waitForTimeout(100);
  await tab.screenshot({ path: join(shots, file) });
}

for (const lang of ['zh', 'en']) for (const theme of ['dark', 'light']) for (const width of [1440, 420]) {
  const { tab, close } = await open(`lang=${lang}&theme=${theme}`, width);
  await fullShot(tab, `gallery-${lang}-${theme}-${width}.png`);
  if (process.env.GALLERY_SECTIONS) {
    // Full-resolution crops of each section, for close visual review (the
    // viewport is now as tall as the page, so nothing is clipped by scrolling).
    const sections = tab.locator('.g-section');
    for (let index = 0; index < await sections.count(); index++)
      await sections.nth(index).screenshot({ path: join(shots, `section-${lang}-${theme}-${width}-${index}.png`) });
  }
  if (width === 1440) {
    // Rendered contrast of every text run inside the component library.
    const low = await tab.evaluate(() => {
      const parse = value => { const m = value.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [r, g, b, a]; };
      const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const over = (top, under) => top.slice(0, 3).map((value, index) => value * top[3] + under[index] * (1 - top[3]));
      function background(element) {
        const layers = [];
        for (let node = element; node; node = node.parentElement) {
          const color = parse(getComputedStyle(node).backgroundColor);
          if (color && color[3] > 0) layers.push(color);
          if (color && color[3] >= 1) break;
        }
        return layers.reverse().reduce((under, layer) => over(layer, under), [0, 0, 0]);
      }
      const probe = document.createElement('span');
      document.body.appendChild(probe);
      const rgb = value => { probe.style.color = ''; probe.style.color = value; return parse(getComputedStyle(probe).color); };
      const out = [];
      let checked = 0;
      for (const element of document.querySelectorAll('[class*="sh-"]')) {
        if (element.closest('button:disabled, [aria-disabled="true"], .sh-btn--primary')) continue;
        const own = [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim());
        if (!own) continue;
        const style = getComputedStyle(element);
        const fg = rgb(style.color), bg = background(element);
        if (!fg) continue;
        const color = over(fg, bg);
        checked += 1;
        const [hi, lo] = [lum(color), lum(bg)].sort((a, b) => b - a);
        const ratio = (hi + 0.05) / (lo + 0.05);
        if (ratio < 4.5) out.push(`${element.className} "${element.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}`);
      }
      probe.remove();
      return { out, checked };
    });
    check(`text contrast ≥ 4.5 (${lang}/${theme})`, !low.out.length && low.checked > 40, `${low.checked} text runs; ${low.out.slice(0, 8).join('; ')}`);
  }
  await close();
}

for (const lang of ['zh', 'en']) for (const theme of ['dark', 'light']) {
  // Toasts stay in the visible viewport after scrolling a long page.
  const { tab, close } = await open(`lang=${lang}&theme=${theme}&scene=toast`, 1440, 900);
  await tab.evaluate(() => { document.querySelector('.study-app').scrollTop = 900; });
  await tab.waitForTimeout(250);
  const box = await tab.locator('.sh-toast--error').boundingBox();
  check(`toast visible after scrolling (${lang}/${theme})`, box && box.y >= 0 && box.y < 200, JSON.stringify(box));
  await tab.screenshot({ path: join(shots, `toast-scrolled-${lang}-${theme}-1440.png`) });
  await close();
  // Narrow (DSH sidebar width).
  const narrow = await open(`lang=${lang}&theme=${theme}&scene=toast`, 420, 760);
  await narrow.tab.evaluate(() => { document.querySelector('.study-app').scrollTop = 700; });
  await narrow.tab.waitForTimeout(250);
  await narrow.tab.screenshot({ path: join(shots, `toast-scrolled-${lang}-${theme}-420.png`) });
  await narrow.close();
}

for (const lang of ['zh', 'en']) for (const theme of ['dark', 'light']) for (const width of [1440, 420]) {
  // Dialog with an error raised on the page behind it: the toast must appear in the dialog.
  const { tab, close } = await open(`lang=${lang}&theme=${theme}&scene=dialog&toast=1`, width, 900);
  await tab.waitForSelector('dialog[open]');
  await tab.waitForTimeout(300);
  await tab.screenshot({ path: join(shots, `dialog-${lang}-${theme}-${width}.png`) });
  if (lang === 'zh' && theme === 'dark' && width === 1440) {
    check('dialog is modal in the top layer', await tab.evaluate(() => document.querySelector('dialog').matches(':modal')));
    check('page error is shown inside the open dialog', await tab.locator('dialog .sh-toast--error').count() === 1);
    check('the page region does not duplicate it', await tab.locator('main > .sh-toasts .sh-toast').count() === 0);
    const footer = await tab.locator('.sh-dialog__footer').boundingBox();
    check('dialog footer is inside the viewport', footer && footer.y + footer.height <= 900, JSON.stringify(footer));
    await tab.locator('dialog .sh-toast--error .sh-toast__close').click();
    check('the routed toast can be dismissed', await tab.locator('.sh-toast--error').count() === 0);
  }
  await close();
}

// Escape without and with the document keydown trap ui/App.jsx installs for
// its modals: the dialog closes exactly once and focus returns to the opener.
for (const trap of ['0', '1']) {
  const { tab, close } = await open(`lang=zh&theme=dark&scene=all&trap=${trap}`);
  await tab.locator('#open-dialog').scrollIntoViewIfNeeded();
  await tab.locator('#open-dialog').focus();
  await tab.keyboard.press('Enter');
  await tab.waitForSelector('dialog[open]');
  await tab.waitForTimeout(150);
  if (trap === '1') {
    // Tab from the last focusable wraps to the first.
    const wraps = await tab.evaluate(() => {
      const dialog = document.querySelector('dialog');
      const items = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')];
      items.at(-1).focus();
      return items.length;
    });
    await tab.keyboard.press('Tab');
    const inside = await tab.evaluate(() => document.querySelector('dialog').contains(document.activeElement));
    check('Tab stays inside the dialog', inside, `${wraps} focusables`);
  }
  await tab.keyboard.press('Escape');
  await tab.waitForTimeout(250);
  const state = await tab.evaluate(() => ({ open: !!document.querySelector('dialog'), closes: window.__galleryCloses, focus: document.activeElement?.id }));
  check(`Escape closes the dialog exactly once (App trap ${trap === '1' ? 'on' : 'off'})`, !state.open && state.closes === 1, JSON.stringify(state));
  check(`focus returns to the opener (App trap ${trap === '1' ? 'on' : 'off'})`, state.focus === 'open-dialog', JSON.stringify(state));
  if (trap === '0') {
    await tab.locator('#open-dialog').click();
    await tab.waitForSelector('dialog[open]');
    await tab.mouse.click(8, 8);
    await tab.waitForTimeout(200);
    check('a backdrop click closes the dialog', await tab.locator('dialog').count() === 0);
  }
  await close();
}

{
  // Drop isolation: a file dropped on the zone never reaches the host listener.
  const { tab, close } = await open('lang=zh&theme=dark');
  const outcome = await tab.evaluate(() => {
    window.__hostDrops = 0;
    const fire = (target, type, files) => {
      const data = new DataTransfer();
      files.forEach(([name, body, mime]) => data.items.add(new File([body], name, { type: mime })));
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const zone = document.querySelector('[data-testid="drop-guarded"]');
    const files = [['notes.md', '# hi', 'text/markdown'], ['virus.exe', 'MZ', 'application/octet-stream']];
    fire(zone, 'dragenter', files); fire(zone, 'dragover', files);
    const prevented = fire(zone, 'drop', files);
    const afterZone = window.__hostDrops;
    fire(document.getElementById('outside-zone'), 'drop', files);
    return { prevented, afterZone, afterOutside: window.__hostDrops, log: window.__galleryLog.filter(entry => entry.type === 'guarded') };
  });
  check('a drop on FileDrop never reaches the host drop handler', outcome.prevented && outcome.afterZone === 0, JSON.stringify(outcome));
  check('control: a drop outside the zone does reach it', outcome.afterOutside === 1);
  check('FileDrop accepted the .md and rejected the .exe', JSON.stringify(outcome.log[0]) === JSON.stringify({ type: 'guarded', accepted: ['notes.md'], rejected: ['type'] }));
  const slot = await tab.evaluate(() => {
    const region = document.querySelector('[data-testid="review-slot"] .sh-toasts');
    return { position: getComputedStyle(region).position, height: region.getBoundingClientRect().height };
  });
  check('ActionFeedback inside .action-feedback-slot stays inline', slot.position === 'static' && slot.height > 30, JSON.stringify(slot));
  await tab.locator('[data-testid="drop-guarded"]').scrollIntoViewIfNeeded();
  await tab.waitForTimeout(150);
  await tab.locator('#drop-host').screenshot({ path: join(shots, 'drop-rejected-zh-dark.png') });
  // Drag-over state.
  await tab.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    document.querySelector('[data-testid="drop-main"]').dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await tab.locator('[data-testid="drop-main"]').scrollIntoViewIfNeeded();
  await tab.waitForTimeout(250);
  check('drag-over state is shown', await tab.locator('[data-testid="drop-main"].is-over').count() === 1);
  await tab.locator('[data-testid="drop-main"]').screenshot({ path: join(shots, 'drop-over-zh-dark.png') });
  // Keyboard: the choose button is reachable and opens the picker.
  const chooser = tab.waitForEvent('filechooser', { timeout: 3000 }).then(() => true, () => false);
  await tab.locator('[data-testid="drop-main"] .sh-btn').focus();
  await tab.keyboard.press('Enter');
  check('the choose button opens the file picker from the keyboard', await chooser);
  await close();
}

for (const theme of ['dark', 'light']) {
  const { tab, close } = await open(`lang=en&theme=${theme}&scene=full`, 1440, 900);
  await tab.waitForSelector('dialog[open]');
  await tab.waitForTimeout(200);
  await tab.screenshot({ path: join(shots, `dialog-full-en-${theme}.png`) });
  if (theme === 'dark') check('fullscreen preview is a modal dialog', await tab.evaluate(() => document.querySelector('dialog.sh-dialog--full').matches(':modal')));
  await close();
}

await browser.close();
check('no page errors or console errors', !errors.length, errors.slice(0, 5).join(' | '));
await writeFile(join(shots, 'gallery-checks.json'), JSON.stringify(results, null, 2));
const failed = results.filter(result => !result.ok);
console.log(`${results.length - failed.length}/${results.length} browser checks passed; screenshots in ${shots}`);
process.exit(failed.length ? 1 : 0);
