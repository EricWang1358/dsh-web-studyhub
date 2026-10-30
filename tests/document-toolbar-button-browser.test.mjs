/* global document, getComputedStyle */
/* #512: 「选段学习」 sits in the host's preview toolbar, outside every study surface, where none of the scoped study button
   rules or tokens apply. It must still look like the host's own icon buttons: a 28 px transparent icon button with an
   accessible name, never the browser's default grey button with a 2px outset border. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

test('the selection-learning toolbar button carries its own look outside the study surfaces', { timeout: 60000 }, async t => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { registerDocumentLearning } from './ui/document-preview/native.jsx';
    let Actions = null;
    const slots = { inject: (_name, initialize) => initialize(), register: (definition, component) => {
      if (definition.name === 'sidebar.right.tab.document.actions') Actions = component; return () => {}; } };
    const ctx = { slots, effect: initialize => initialize(), inject: () => {}, get: () => null };
    const call = () => async action => action === 'runtime.capabilities' ? [{ api: 'materials.v1' }] : {};
    registerDocumentLearning(ctx, call, () => {});
    createRoot(document.getElementById('toolbar')).render(<>
      <button type="button" className="host-icon" aria-label="代码">C</button>
      <Actions sessionId="s1" absolutePath="/notes/a.md" />
    </>);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
  loader: { '.css': 'text' }, logLevel: 'silent' });
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // The host's toolbar: its own icon buttons, and no study container anywhere on the page.
  await page.setContent(`<style>.host-icon { width: 28px; height: 28px; border: 0; background: transparent; }</style>
    <div id="toolbar" style="display:flex;align-items:center;gap:4px;color:rgb(30,26,21)"></div>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = page.getByRole('button', { name: '选段学习' });
  await button.waitFor();
  assert.equal(await page.evaluate(() => !!document.querySelector('.study-app, .study-seat')), false, 'the toolbar is outside every study surface');
  const look = await button.evaluate(element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height), border: style.borderTopStyle, borderWidth: style.borderTopWidth,
      background: style.backgroundColor, radius: style.borderTopLeftRadius, color: style.color, text: element.textContent.trim(),
      title: element.title, icon: !!element.querySelector('svg') };
  });
  assert.deepEqual({ width: look.width, height: look.height }, { width: 28, height: 28 }, 'the same size as the host icons');
  assert.notEqual(look.border, 'outset', 'not the browser default border');
  assert.equal(look.borderWidth, '0px');
  assert.equal(look.background, 'rgba(0, 0, 0, 0)', 'transparent like the host icons');
  assert.equal(look.radius, '22%', 'rounded like the host icons (about 6 px)');
  assert.equal(look.color, 'rgb(30, 26, 21)', "the host toolbar's text colour");
  assert.equal(look.icon, true);
  assert.equal(look.text, '', 'an icon, not a two-icon-wide text button');
  assert.equal(look.title, '选段学习', 'the hover still names it');
  const rows = await page.evaluate(() => [...document.querySelectorAll('#toolbar button')].map(node => Math.round(node.getBoundingClientRect().top)));
  assert.equal(new Set(rows).size, 1, 'it stays in the toolbar row');
  assert.deepEqual(errors, []);
});
