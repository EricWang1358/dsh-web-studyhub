/* global document, getComputedStyle -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { frames, holdActions, openPage, seedWrongBookLibrary, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';

/* #153: the app runs one action at a time, so every button of a page is disabled while one runs, but only the button that was pressed shows the work. On the
   mistakes page: press 开始重练 while the answer to review.start is held. That one button has a spinner and aria-busy, keeps its width and height, and nothing
   around it moves; every other button that was enabled is disabled with no spinner, in the one disabled look (no faded copy); disabled segments are clearly
   dimmer than enabled inactive segments in both themes; and icon-less buttons do not widen when pressed. */

const SHOTS = process.env.BUSY_LOCK_SHOTS || '';
const START = '.wb-retrain .sh-btn--primary';

const snapshot = (page) => page.evaluate((start) => {
  const box = (element) => { const rect = element.getBoundingClientRect(); return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }; };
  const compositeRgb = (fgCss, bgCss = null) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 1, 1);
    if (bgCss) {
      ctx.fillStyle = bgCss;
      ctx.fillRect(0, 0, 1, 1);
    }
    ctx.fillStyle = fgCss;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const lum = (rgb) => {
    const f = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };

  const seg = document.querySelector('.wb-retrain .sh-seg');
  const segBgCss = getComputedStyle(seg).backgroundColor;
  const segBg = compositeRgb(segBgCss);
  const segItems = [...seg.querySelectorAll('.sh-seg__item')].map((el) => {
    const style = getComputedStyle(el);
    const fg = compositeRgb(style.color, segBgCss);
    return {
      text: el.textContent.trim(),
      active: el.classList.contains('is-active'),
      disabled: el.disabled,
      opacity: style.opacity,
      contrast: ratio(fg, segBg),
    };
  });
  const thumb = seg.querySelector('.sh-seg__thumb');
  const buttons = [...document.querySelectorAll('main .sh-btn')].filter((element) => element.getClientRects().length);
  return {
    start: box(document.querySelector(start)),
    bar: box(document.querySelector('.wb-retrain')),
    busy: buttons.filter((element) => element.getAttribute('aria-busy') === 'true').map((element) => element.className),
    spinners: document.querySelectorAll('main .sh-btn .sh-spinner').length,
    startBusy: document.querySelector(start).getAttribute('aria-busy') === 'true',
    startSpinner: !!document.querySelector(`${start} .sh-spinner`),
    disabled: buttons.filter((element) => element.disabled).map((element) => ({ text: element.textContent.trim(), opacity: getComputedStyle(element).opacity, busy: element.hasAttribute('aria-busy') })),
    enabled: buttons.filter((element) => !element.disabled).length,
    segments: [...document.querySelectorAll('main .sh-seg__item:disabled')].map((element) => getComputedStyle(element).opacity),
    segItems,
    thumbShadow: thumb ? getComputedStyle(thumb).boxShadow : 'none',
  };
}, START);

test('only the pressed button shows the work while the app is locked, disabled segments read clearly, and icon-less buttons keep their width', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-busy-lock-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: (root) => seedWrongBookLibrary(root) });
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      for (const theme of (width === 1280 ? ['light', 'dark'] : ['light'])) {
        const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme, width, height: 900 });
        const hold = await holdActions(page, ['review.start']);
        await page.goto(running.server.url);

        if (width === 1280 && theme === 'light') {
          // Icon-less link button on the home desk: pressing it must not widen it by ~23px or shove its neighbour.
          await page.locator('[data-tour^="nav-"]').first().waitFor({ state: 'visible', timeout: 30000 });
          await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
          await settleAnimations(page);
          await frames(page, 3);
          const readIconless = () => page.evaluate(() => {
            const buttons = [...document.querySelectorAll('main .sh-btn--link')].filter((el) => el.getClientRects().length && !el.querySelector('svg'));
            const idx = buttons.findIndex((el) => /今日学习|课程下一批/.test(el.textContent));
            const target = buttons[idx];
            const sibling = buttons[idx + 1] || buttons[idx - 1];
            const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; };
            return {
              text: target?.textContent.trim() || '',
              busy: target?.getAttribute('aria-busy') === 'true',
              spinner: !!target?.querySelector('.sh-spinner'),
              color: target ? getComputedStyle(target).color : '',
              box: target ? rect(target) : null,
              siblingBox: sibling ? rect(sibling) : null,
            };
          });
          const beforeIconless = await readIconless();
          assert.ok(beforeIconless.box, 'found an icon-less button on the home desk');
          await page.evaluate(() => {
            const target = [...document.querySelectorAll('main .sh-btn--link')].find((el) => el.getClientRects().length && !el.querySelector('svg') && /今日学习|课程下一批/.test(el.textContent));
            target.click();
          });
          await until(() => hold.seen('review.start'), 'icon-less button triggered review.start');
          await frames(page, 3);
          const duringIconless = await readIconless();
          if (SHOTS) await page.screenshot({ path: join(SHOTS, 'home-iconless-held.png') });
          assert.equal(duringIconless.busy, true, 'icon-less pressed button announces aria-busy');
          assert.equal(duringIconless.spinner, true, 'icon-less pressed button shows a spinner');
          assert.equal(duringIconless.color, 'rgba(0, 0, 0, 0)', 'icon-less label hides immediately without colliding with the spinner');
          assert.ok(Math.abs(duringIconless.box.width - beforeIconless.box.width) <= 1, `icon-less button kept its width (${beforeIconless.box.width} -> ${duringIconless.box.width})`);
          assert.ok(Math.abs(duringIconless.box.height - beforeIconless.box.height) <= 1, `icon-less button kept its height (${beforeIconless.box.height} -> ${duringIconless.box.height})`);
          if (beforeIconless.siblingBox && duringIconless.siblingBox) {
            assert.ok(Math.abs(duringIconless.siblingBox.x - beforeIconless.siblingBox.x) <= 1, `neighbour button did not shift (${beforeIconless.siblingBox.x} -> ${duringIconless.siblingBox.x})`);
          }
          hold.release('review.start');
          await until(() => page.evaluate(() => !document.querySelector('[aria-busy="true"]')), 'icon-less action released');
          // Return to home / wrongbook fresh hold
        }

        const nav = page.locator('[data-tour="nav-wrongbook"]').first();
        await nav.waitFor({ state: 'visible', timeout: 30000 });
        await nav.dispatchEvent('click');
        await page.locator(START).waitFor({ timeout: 30000 });
        await until(() => page.evaluate((start) => !document.querySelector(start).disabled, START), 'the retrain button to be enabled');
        await settleAnimations(page);
        await frames(page, 3);

        const idle = await snapshot(page);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `idle-${theme}-${width}.png`) });
        assert.deepEqual(idle.busy, [], `${theme} ${width}px: nothing is busy at rest`);
        assert.ok(idle.enabled >= 2, `${theme} ${width}px: there are other buttons that can be pressed`);
        const enabledInactive = idle.segItems.find((item) => !item.active && !item.disabled);
        const disabledIdle = idle.segItems.find((item) => item.disabled);
        assert.ok(enabledInactive && disabledIdle, `${theme} ${width}px: retrain switch has enabled inactive and disabled segments`);
        assert.ok(enabledInactive.contrast / disabledIdle.contrast >= 2.2,
          `${theme} ${width}px: enabled inactive segment contrast (${enabledInactive.contrast.toFixed(2)}) must clearly exceed disabled segment contrast (${disabledIdle.contrast.toFixed(2)})`);

        const holdWrongbook = await holdActions(page, ['review.start']);
        await page.locator(START).click();
        await until(() => holdWrongbook.seen('review.start'), 'review.start to be asked');
        await frames(page, 3);
        const held = await snapshot(page);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `held-${theme}-${width}.png`) });

        assert.equal(held.startBusy, true, `${theme} ${width}px: the pressed button announces aria-busy`);
        assert.equal(held.startSpinner, true, `${theme} ${width}px: and shows the spinner`);
        assert.equal(held.busy.length, 1, `${theme} ${width}px: it is the only busy button (${held.busy.join(' | ')})`);
        assert.equal(held.spinners, 1, `${theme} ${width}px: one spinner on the page`);
        const others = held.disabled.filter((button) => !button.busy);
        assert.ok(others.length >= 2, `${theme} ${width}px: the other buttons are locked, and quiet (${others.length})`);
        assert.ok(held.disabled.every((button) => button.opacity === '1'), `${theme} ${width}px: every locked button has the one disabled look, not a faded copy`);
        assert.ok(held.segments.length === held.segItems.length && held.segments.every((opacity) => opacity === '1'),
          `${theme} ${width}px: every segment in the locked retrain bar is disabled with opacity 1 (${held.segments.length}/${held.segItems.length})`);
        assert.equal(held.thumbShadow, 'none', `${theme} ${width}px: a locked segmented switch flattens its active thumb shadow`);
        assert.ok(Math.abs(held.start.width - idle.start.width) <= 1, `${theme} ${width}px: the busy button kept its width (${idle.start.width} -> ${held.start.width})`);
        assert.ok(Math.abs(held.start.height - idle.start.height) <= 1, `${theme} ${width}px: and its height`);
        assert.ok(Math.abs(held.start.x - idle.start.x) <= 1 && Math.abs(held.start.y - idle.start.y) <= 1, `${theme} ${width}px: and its place`);
        assert.ok(Math.abs(held.bar.height - idle.bar.height) <= 1, `${theme} ${width}px: the bar around it did not change height`);

        holdWrongbook.release('review.start');
        await until(() => page.evaluate(() => !document.querySelector('[aria-busy="true"]')), 'no button to claim it is busy');
        assert.deepEqual(errors, [], `${theme} ${width}px: no console or page errors`);
        await context.close();
      }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
