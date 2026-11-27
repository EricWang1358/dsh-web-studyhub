/* global document, window, requestAnimationFrame */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* The shared anchoring (ui/document-preview/translation/useRangeAnchor.js: BookAsk's 问 AI panel, the reader's 译 chip and 原文 card) moves its element again
   on every scroll and resize of the page. A move between pressing a button in it and letting go puts the button somewhere else under the pointer, and the
   browser then sends the click to neither: the learner's press of 发给主会话 is lost. While a press is on the element it stays put; it moves when the press ends. */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function bundle() {
  const out = await build({
    stdin: { resolveDir: repo, loader: 'jsx', contents: `
      import React, { useRef } from 'react';
      import { createRoot } from 'react-dom/client';
      import useRangeAnchor from './ui/document-preview/translation/useRangeAnchor.js';
      function Panel({ host, anchor }) {
        const element = useRef(null), range = useRef({ getClientRects: () => anchor.getClientRects() });
        useRangeAnchor({ elementRef: element, host, rangeRef: range, scrollerRef: { current: null }, active: true, trigger: 'one', placement: 'bottom-end', gap: 6, margin: 8 });
        return <div ref={element} id="panel" style={{ position: 'absolute', width: 200, padding: 8, background: '#eee' }}>
          <button id="send" style={{ width: 180, height: 40 }} onClick={() => { window.clicks += 1; }}>send</button>
        </div>;
      }
      window.clicks = 0;
      const host = document.getElementById('host'), anchor = document.getElementById('anchor');
      createRoot(document.getElementById('mount')).render(<Panel host={host} anchor={anchor} />);
    ` },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}

test('a press on a button of an anchored panel is not lost when the page lays out again under it; the panel follows once the press ends', { timeout: 120000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  const script = await bundle();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.setContent(`<!doctype html><html><body style="margin:0">
      <div id="host" style="position:relative;width:600px;margin:20px">
        <div id="above" style="height:40px"></div>
        <button id="anchor" style="margin-left:300px">问 AI</button>
        <div style="height:600px"></div>
        <div id="mount"></div>
      </div></body></html>`);
    await page.addScriptTag({ content: script });
    await page.locator('#panel[data-placed]').waitFor({ timeout: 10000 });
    const send = page.locator('#send');
    const before = await send.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    // Something above the anchor grows while the button is held (a picture loads, a line is written): the host resizes, the anchor moves down.
    await page.evaluate(() => { document.getElementById('above').style.height = '240px'; });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const held = await send.boundingBox();
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.clicks), 1, `the press must reach the button (it moved from ${before.y} to ${held.y} while held)`);
    assert.equal(Math.round(held.y), Math.round(before.y), 'the panel stays under the pointer while the press lasts');
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const after = await send.boundingBox();
    assert.equal(Math.round(after.y - before.y), 200, 'and follows its anchor once the press ends');
  } finally {
    await browser.close();
  }
});
