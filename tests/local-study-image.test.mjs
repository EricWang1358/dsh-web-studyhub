/* global document, window, File */
import test from 'node:test';
import assert from 'node:assert/strict';
import { localImageMarkdown, localImageAlt, safeRasterDataUri, MAX_LOCAL_IMAGE_BYTES } from '../ui/local-study-image.js';
import { safeStudyImage, prepareStudyMath, STUDY_IMAGE_PATTERN } from '../ui/study-media.js';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
const uri = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const selected = (bytes, type = 'image/png', name = 'diagram.png') => ({ name, type, size: bytes.length,
  arrayBuffer: async () => Uint8Array.from(bytes).buffer });

test('selected raster image embeds portable Markdown with bounded readable filename text', async () => {
  const markdown = await localImageMarkdown(selected(png, 'image/png', 'C:\\private\\diagram]($x$)<script>.png'));
  const match = STUDY_IMAGE_PATTERN.exec(markdown);
  assert.ok(match);
  assert.equal(match[1], 'diagram)($x$)‹script›');
  assert.equal(match[3], uri('image/png', png));
  assert.equal(safeStudyImage(match[3]), match[3]);
  assert.deepEqual(prepareStudyMath(markdown), { value: markdown, formulas: [] });
  assert.equal(JSON.parse(JSON.stringify({ prompt: markdown })).prompt, markdown, 'embedded bytes survive serialization/reopening');
  assert.equal(localImageAlt(' '.repeat(10)), '图片');
  assert.equal(localImageAlt('a'.repeat(200) + '.png').length, 120);
  assert.doesNotMatch(localImageAlt('line\n[bracket].png'), /[\n\[\]]/);
});

test('raster validator requires canonical base64, matching MIME magic and bounded decoded bytes', () => {
  const signatures = [['image/png', png], ['image/jpeg', [255, 216, 255, 224]],
    ['image/gif', Buffer.from('GIF89a\0\0')], ['image/webp', Buffer.from('RIFF\x04\0\0\0WEBP')]];
  for (const [mime, bytes] of signatures) assert.equal(safeRasterDataUri(uri(mime, bytes)), uri(mime, bytes));
  const valid = uri('image/png', png);
  for (const invalid of [valid.replace('image/png', 'image/jpeg'), valid + '\n', valid.replace('CYII=', 'CYIJ='),
    valid.replace('base64,', 'base64,%'), valid.replace('base64,', 'base64, '), valid.replace('base64,', ''),
    valid.slice(0, -1), 'data:image/png;base64,AAAA', 'data:image/png;base64,====',
    uri('image/svg+xml', Buffer.from('<svg onload="alert(1)"/>')), uri('text/html', Buffer.from('<script>alert(1)</script>'))]) {
    assert.equal(safeRasterDataUri(invalid), null);
    assert.equal(safeStudyImage(invalid), null);
  }
  const largest = Buffer.alloc(MAX_LOCAL_IMAGE_BYTES); png.copy(largest, 0, 0, 8);
  assert.equal(safeRasterDataUri(uri('image/png', largest)), uri('image/png', largest));
  const oversized = Buffer.alloc(MAX_LOCAL_IMAGE_BYTES + 1); png.copy(oversized, 0, 0, 8);
  assert.equal(safeRasterDataUri(uri('image/png', oversized)), null);
});

test('selected files reject oversized, active and mismatched formats before insertion', async () => {
  let reads = 0;
  const read = async () => { reads++; return png.buffer; };
  await assert.rejects(localImageMarkdown({ size: MAX_LOCAL_IMAGE_BYTES + 1, type: 'image/png', arrayBuffer: read }), /2 MiB/);
  await assert.rejects(localImageMarkdown({ size: png.length, type: 'image/svg+xml', arrayBuffer: read }), /PNG/);
  assert.equal(reads, 0, 'unsupported and oversized files are never read');
  await assert.rejects(localImageMarkdown(selected(Buffer.from('<html>payload</html>'))), /格式/);
  await assert.rejects(localImageMarkdown(selected(png, 'image/jpeg')), /格式/);
  await assert.rejects(localImageMarkdown({ ...selected(png), size: 2 }), /格式/);
  await assert.rejects(localImageMarkdown({ ...selected(png), arrayBuffer: async () => { throw new Error('read failed'); } }), /无法读取/);
  await assert.rejects(localImageMarkdown(selected([])), /PNG/);
  assert.equal(await localImageMarkdown(selected(png, '')), `![diagram](${uri('image/png', png)})`, 'empty browser MIME is detected from bytes');
});

test('web images retain the existing URL policy and local paths stay refused', () => {
  assert.equal(safeStudyImage('https://example.org/image.png'), 'https://example.org/image.png');
  for (const value of [null, {}, 'file:///private/image.png', '../image.png', 'C:\\private\\image.png',
    'javascript:alert(1)', 'https://user:password@example.org/image.png']) assert.equal(safeStudyImage(value), null);
});

test('local image picker inserts a decodable raster and reports file errors without network access', { timeout: 45000 }, async t => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import LocalImagePicker from './ui/LocalImagePicker.jsx';
    import Markdown from './ui/Markdown.jsx';
    window.insertedImages = [];
    function Harness({ disabled = false, target = 'first' }) {
      const [text, setText] = useState('');
      return <><LocalImagePicker key={target} disabled={disabled} onInsert={markdown => { window.insertedImages.push(markdown); setText(markdown); }} /><Markdown text={text} /></>;
    }
    const root = createRoot(document.getElementById('root'));
    root.render(<Harness />);
    window.rerenderPicker = () => root.render(<Harness />);
    window.switchTarget = () => root.render(<Harness target="another" />);
    window.disablePicker = () => root.render(<Harness disabled />);
  `, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
    loader: { '.css': 'text' }, logLevel: 'silent' });
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 390, height: 700 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = page.locator('.local-image-picker button'), input = page.locator('.local-image-picker input');
  await button.waitFor();
  assert.equal(await input.getAttribute('accept'), 'image/png,image/jpeg,image/webp,image/gif');
  await input.setInputFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: png });
  await page.locator('.md-image img').waitFor();
  await page.waitForFunction(() => document.querySelector('.md-image img')?.naturalWidth === 1);
  assert.equal(await page.evaluate(() => window.insertedImages.length), 1);
  // Resetting the input allows selecting exactly the same file a second time.
  await input.setInputFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => window.insertedImages.length === 2);
  await input.setInputFiles({ name: 'active.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /PNG/);
  await input.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(MAX_LOCAL_IMAGE_BYTES + 1) });
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('2 MiB'));
  assert.equal(await page.evaluate(() => window.insertedImages.length), 2);
  // A delayed read survives ordinary callback rerenders, but is discarded on
  // a keyed target change or a disable transition.
  for (const [transition, expected] of [['rerenderPicker', 3], ['switchTarget', 3], ['disablePicker', 3]]) {
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      window.readStarted = false;
      File.prototype.arrayBuffer = function () {
        const file = this;
        window.readStarted = true;
        return new Promise(resolve => {
          window.releaseRead = async () => { File.prototype.arrayBuffer = original; resolve(await original.call(file)); };
        });
      };
    });
    await input.setInputFiles({ name: 'pending.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => window.readStarted);
    await page.evaluate(action => window[action](), transition);
    await page.evaluate(async () => { await window.releaseRead(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await page.evaluate(() => window.insertedImages.length), expected);
  }
  await page.evaluate(() => window.disablePicker());
  await page.waitForFunction(() => document.querySelector('.local-image-picker button')?.disabled);
  assert.equal(await button.isDisabled(), true);
  assert.equal(await input.isDisabled(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
});
