/* global document, window, requestAnimationFrame, PointerEvent, MouseEvent, Event */
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
          <textarea id="box" rows={2} style={{ width: 180 }} />
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
    // As in 问 AI: the learner typed in the box, so pressing the button also takes the focus out of it.
    await page.locator('#box').fill('make it simpler');
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

/* What counts as a press that holds the element: the main button, inside the element, until that same pointer lets go. A press that ends without a
   pointerup reaching the page (the window loses focus, a context menu takes the release) must not freeze it: BookSelectBar's hide-away needs placing too. */
test('only a main-button press inside the element holds it, a press cancels a frame already asked for, and a press that never sees its pointerup does not freeze it', { timeout: 120000 }, async (t) => {
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
    // How far the panel sits from its anchor: the same number whenever it was placed after the last layout change.
    const offset = () => page.evaluate(() => Math.round(document.getElementById('send').getBoundingClientRect().top - document.getElementById('anchor').getBoundingClientRect().bottom));
    const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const placed = await offset();
    // In one task: the events of a scenario, then the anchor moves (the page above it grows or shrinks).
    const scenario = (events) => page.evaluate((list) => {
      const target = (name) => (name === 'window' ? window : document.getElementById(name));
      for (const [where, type, init] of list) {
        const Kind = type.startsWith('pointer') || type === 'lostpointercapture' ? PointerEvent : type === 'contextmenu' ? MouseEvent : Event;
        target(where).dispatchEvent(new Kind(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, isPrimary: true, ...init }));
      }
      // Four heights in turn: two scenarios apart the anchor is never where it was, so a panel left behind is always seen.
      window.layouts = (window.layouts || 0) + 1;
      document.getElementById('above').style.height = `${40 + (window.layouts % 4) * 60}px`;
    }, events);
    const follows = async (what, events) => { await scenario(events); await frames(); assert.equal(await offset(), placed, what); };
    const holds = async (what, events) => { await scenario(events); await frames(); assert.notEqual(await offset(), placed, what); };

    await follows('a press elsewhere on the page does not hold the panel', [['above', 'pointerdown']]);
    await follows('a right-button press on the panel does not hold it', [['send', 'pointerdown', { button: 2 }]]);
    await holds('a main-button press on the panel holds it', [['send', 'pointerdown']]);
    await follows('…until that pointer lets go', [['window', 'pointerup']]);
    await holds('a frame asked for just before the press is cancelled by it', [['window', 'resize'], ['send', 'pointerdown']]);
    await holds('another pointer letting go does not end the press', [['window', 'pointerup', { pointerId: 2 }]]);
    await follows('the press ends when its pointer lets go', [['window', 'pointerup']]);
    await follows('a press ended by the window losing focus does not freeze the panel', [['send', 'pointerdown'], ['window', 'blur']]);
    await follows('a press whose release a context menu takes does not freeze it', [['send', 'pointerdown'], ['send', 'contextmenu']]);
    await follows('a press whose pointer capture is lost does not freeze it', [['send', 'pointerdown'], ['send', 'lostpointercapture']]);
  } finally {
    await browser.close();
  }
});
