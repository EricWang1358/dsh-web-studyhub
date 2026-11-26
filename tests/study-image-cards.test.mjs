/* global document, WheelEvent */
/* Images in question cards: a Markdown image in a stem, an option or an explanation is drawn as an
   image; an address that is unsafe or cannot be loaded is drawn as a readable fallback, never as
   active markup and never as an error in the card. The same Markdown component draws every card
   surface (review, flashcard, mock exam), so these cases cover all of them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const require = createRequire(import.meta.url);
const compile = (contents, options) => build({ stdin: { contents, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false,
  loader: { '.css': 'text' }, logLevel: 'silent', ...options });
const compiled = await compile(`export { default as Markdown } from './ui/Markdown.jsx'; export { setUiLanguage } from './ui/i18n.js';`,
  { platform: 'node', format: 'cjs', external: ['react', 'react-dom'] });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { Markdown, setUiLanguage } = module.exports;
const draw = (text, props = {}) => renderToStaticMarkup(React.createElement(Markdown, { text, ...props }));

const FIGURE = 'https://example.org/figure.png';

test('an image in the stem, an option and an explanation is drawn with its description', () => {
  setUiLanguage('zh');
  // The three places a card shows Markdown, with the props each one passes.
  const stem = draw(`看图回答：![受力示意图](${FIGURE})`);
  const option = draw('![选项 A：开路](https://example.org/a.png)', { links: false, className: 'md-compact' });
  const explanation = draw(`解析见 ![解析图](https://example.org/e.png "标题")，注意方向。`);
  for (const [html, src, alt] of [[stem, FIGURE, '受力示意图'], [option, 'https://example.org/a.png', '选项 A：开路'], [explanation, 'https://example.org/e.png', '解析图']]) {
    assert.match(html, new RegExp(`<img src="${src.replaceAll('.', '\\.')}" alt="${alt}"`), html);
    assert.match(html, /loading="lazy"/);
    assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
    assert.doesNotMatch(html, /md-image-fallback/);
  }
  assert.match(stem, /看图回答：/, 'the text around the image stays');
  assert.match(explanation, /，注意方向。/);
});

test('an option that is only an image still draws as an image', () => {
  const html = draw(`![](${FIGURE})`, { links: false, className: 'md-compact' });
  assert.match(html, /<img src="https:\/\/example\.org\/figure\.png" alt=""/);
});

test('an unsafe image address becomes a labelled fallback with no image, link or script', () => {
  setUiLanguage('zh');
  const unsafe = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:text/html;base64,PHNjcmlwdD4=', 'file:///etc/passwd',
    'C:\\Users\\me\\a.png', '../a.png', '/assets/a.png', '//example.org/a.png', 'https://user:secret@example.org/a.png', 'ftp://example.org/a.png', 'blob:https://example.org/id'];
  for (const address of unsafe) {
    const html = draw(`题干 ![示意图](<${address}>) 结束`);
    assert.doesNotMatch(html, /<img|<a |<script|<iframe|onerror|javascript:/i, `${address}\n${html}`);
    assert.match(html, /class="md-image-fallback" role="img" aria-label="示意图: 图片不可用"/, `${address}\n${html}`);
    assert.match(html, /<span class="md-image-caption">示意图<\/span>/);
    assert.match(html, /题干 /); assert.match(html, / 结束/);
  }
  setUiLanguage('en');
  try { assert.match(draw('![Free-body diagram](javascript:alert(1))'), /aria-label="Free-body diagram: Image unavailable"/); }
  finally { setUiLanguage('zh'); }
});

test('an image without a description gets a plain fallback label', () => {
  setUiLanguage('zh');
  const html = draw('![](file:///etc/passwd)');
  assert.match(html, /class="md-image-fallback" role="img" aria-label="图片不可用"/);
  assert.doesNotMatch(html, /md-image-caption/);
});

test('markup in the description or address is text, not HTML', () => {
  const html = draw(`![<img src=x onerror=alert(1)>](${FIGURE})`) + draw('![x](https://example.org/a.png"onerror="alert(1))') + draw('![<b>x</b>](javascript:1)');
  assert.doesNotMatch(html, /<script|<b>|<img src="x"/i, html);
  // Every tag the card produced has only attributes the renderer wrote: quoted values removed, no handler is left.
  for (const tag of html.match(/<[a-z][^>]*>/gi)) assert.doesNotMatch(tag.replace(/="[^"]*"/g, ''), /\son\w+/i, tag);
  assert.match(html, /alt="&lt;img src=x onerror=alert\(1\)&gt;"/, 'the description is shown as text');
  assert.match(html, /src="https:\/\/example\.org\/a\.png%22onerror=%22alert\(1"/, 'a quote in the address cannot end the attribute');
});

test('a card with several images keeps every one, mixed with formulas and unsafe addresses', () => {
  const html = draw(`比较 ![甲](${FIGURE}) 与 ![乙](https://example.org/b.png)，再看 ![丙](file:///c.png)，其中 $a^{2}$ 是面积。`);
  assert.equal((html.match(/<img /g) || []).length, 2);
  assert.equal((html.match(/md-image-fallback/g) || []).length, 1);
});

test('an image that cannot be loaded is replaced by the fallback and the card keeps working', { timeout: 60000 }, async t => {
  const bundle = await compile(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import Markdown from './ui/Markdown.jsx';
    createRoot(document.getElementById('root')).render(<div className="card">
      <Markdown text={'题干 ![坏图](https://example.org/missing.png) 与 ![好图](https://example.org/ok.png)，$x^{2}$ 结束'} />
      <Markdown links={false} className="md-compact" text="![选项图](https://example.org/also-missing.png)" />
    </div>);`, { platform: 'browser', format: 'iife' });
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 390, height: 700 } });
  const errors = [], requested = [];
  page.on('pageerror', error => errors.push(error.message));
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('about:') || url.startsWith('data:')) return route.continue();
    requested.push(url);
    return url.endsWith('/ok.png') ? route.fulfill({ contentType: 'image/png', body: PNG }) : route.abort();
  });
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => document.querySelectorAll('.md-image-fallback').length === 2);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.md-image-fallback')].map(node => node.getAttribute('aria-label'))),
    ['坏图: 图片不可用', '选项图: 图片不可用']);
  assert.equal(await page.locator('.md-image img').count(), 1, 'the reachable image stays');
  await page.waitForFunction(() => document.querySelector('.md-image img')?.naturalWidth === 1);
  assert.match(await page.locator('.card').innerText(), /题干[\s\S]*结束/, 'the stem text is still there');
  assert.equal(await page.locator('.card math').count(), 1, 'the formula next to the images still renders');
  assert.deepEqual(errors, []);
  assert.ok(requested.length >= 2 && requested.every(url => url.startsWith('https://example.org/')), requested.join());
});

const interactiveImage = await loadInteractiveUi(`
  export { default as StudyImage } from './ui/StudyImage.jsx';
  export { default as Dialog } from './ui/components/Dialog.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

test('StudyImage mounts a single trigger button when closed, opens media lightbox with zoom controls, and restores trigger focus on close', async () => {
  const { React, mount, exports: { StudyImage, Dialog, setUiLanguage } } = interactiveImage;
  setUiLanguage('zh');
  await withBrowserGlobals(async () => {
    const prevRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb) => { cb(); return 0; };
    const mounted = mount(() => React.createElement(StudyImage, {
      src: 'https://example.org/diagram.png',
      alt: '图解',
      interactive: true,
    }));
    try {
      const closedButtons = mounted.findAll((node) => node.type === 'button');
      assert.equal(closedButtons.length, 1, 'StudyImage renders exactly one trigger <button> when closed');
      const openBtn = closedButtons[0];
      assert.equal(openBtn.props.className, 'md-image-open');
      assert.equal(mounted.find((node) => node.type === Dialog), null, 'no dialog while closed');

      const focusCalls = [];
      openBtn.ref.current = { isConnected: true, focus: (opts) => focusCalls.push(opts) };

      await mounted.act(() => click(openBtn));
      const dialogNode = mounted.find((node) => node.type === Dialog);
      assert.ok(dialogNode, 'clicking the image trigger opens Dialog');
      assert.equal(dialogNode.props.size, 'media');
      assert.equal(dialogNode.props.title, '图解');

      const toolbarButton = (label) => mounted.find((node) => node.type === 'button' && mounted.text(node).trim() === label);
      const resetBtn = () => mounted.find((node) => node.type === 'button' && node.props?.['aria-label'] === '重设缩放');
      assert.equal(toolbarButton('缩小').props.disabled, true);
      assert.equal(mounted.text(resetBtn()).trim(), '100%');
      assert.ok(!toolbarButton('放大').props.disabled);

      await mounted.act(() => click(toolbarButton('放大')));
      assert.equal(mounted.text(resetBtn()).trim(), '125%');
      assert.ok(!toolbarButton('缩小').props.disabled);
      const canvasImg = mounted.find((node) => node.type === 'img' && node.props?.style?.transform);
      assert.equal(canvasImg.props.style.transform, 'scale(1.25)');

      await mounted.act(() => click(resetBtn()));
      assert.equal(mounted.text(resetBtn()).trim(), '100%');
      assert.equal(toolbarButton('缩小').props.disabled, true);

      await mounted.act(() => dialogNode.props.onClose());
      assert.equal(mounted.find((node) => node.type === Dialog), null, 'onClose closes the lightbox');
      assert.deepEqual(focusCalls, [{ preventScroll: true }], 'closing restores focus to the trigger button');
    } finally {
      if (prevRaf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = prevRaf;
      mounted.unmount();
    }
  });
});

test('StudyImage lightbox provides zoom toolbar, keyboard +/=/-/0 & Ctrl+Wheel zoom, and restores focus to trigger', { timeout: 60000 }, async t => {
  const bundle = await compile(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import Markdown from './ui/Markdown.jsx';
    import { setUiLanguage } from './ui/i18n.js';
    setUiLanguage('zh');
    createRoot(document.getElementById('root')).render(
      <div className="study-app"><Markdown text="![图解](https://example.org/diagram.png)" /></div>
    );`, { platform: 'browser', format: 'iife' });

  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 800, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('about:') || url.startsWith('data:')) return route.continue();
    return route.fulfill({ contentType: 'image/png', body: PNG });
  });
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  const openBtn = page.locator('.md-image-open');
  await openBtn.waitFor();
  await openBtn.focus();
  await openBtn.click();

  const dialog = page.locator('dialog.sh-dialog--media');
  await dialog.waitFor();
  const toolbar = dialog.locator('.md-image-toolbar');
  const zoomOutBtn = toolbar.getByRole('button', { name: '缩小' });
  const resetBtn = toolbar.getByRole('button', { name: '重设缩放' });
  const zoomInBtn = toolbar.getByRole('button', { name: '放大' });

  assert.equal(await zoomOutBtn.isDisabled(), true);
  assert.equal(await resetBtn.innerText(), '100%');
  assert.equal(await zoomInBtn.isDisabled(), false);

  await zoomInBtn.click();
  assert.equal(await resetBtn.innerText(), '125%');
  assert.equal(await zoomOutBtn.isDisabled(), false);
  assert.equal(await dialog.locator('.md-image-dialog-canvas img').evaluate(img => img.style.transform), 'scale(1.25)');

  await zoomInBtn.focus();
  await page.keyboard.press('+');
  assert.equal(await resetBtn.innerText(), '150%');
  await page.keyboard.press('=');
  assert.equal(await resetBtn.innerText(), '175%');
  await page.keyboard.press('-');
  assert.equal(await resetBtn.innerText(), '150%');
  await page.keyboard.press('0');
  assert.equal(await resetBtn.innerText(), '100%');

  for (let n = 0; n < 9; n++) await page.keyboard.press('+');
  assert.equal(await resetBtn.innerText(), '300%');
  assert.equal(await zoomInBtn.isDisabled(), true);

  await resetBtn.click();
  assert.equal(await resetBtn.innerText(), '100%');

  await dialog.locator('.md-image-dialog-canvas').evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }));
  });
  assert.equal(await resetBtn.innerText(), '125%');
  await dialog.locator('.md-image-dialog-canvas').evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 100, bubbles: true, cancelable: true }));
  });
  assert.equal(await resetBtn.innerText(), '100%');

  await dialog.locator('.sh-dialog__close').click();
  await page.waitForFunction(() => !document.querySelector('dialog.sh-dialog--media'));
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('md-image-open')), true);

  await openBtn.click();
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.sh-dialog--media'));
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('md-image-open')), true);
  assert.deepEqual(errors, []);
});
