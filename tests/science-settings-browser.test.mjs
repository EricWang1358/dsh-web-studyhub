/* global localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

test('science settings apply, persist and run exact local tools in the real app', { timeout: 480000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'science-browser-')); t.after(() => rm(root, { recursive: true, force: true }));
  const out = resolve('output/playwright/science-settings'); await mkdir(out, { recursive: true });
  const service = new StudyService(join(root, 'library'));
  await service.store.update(s => {
    s.sources.push({ id: 'source', title: 'Algebra', text: 'A square can be expanded by multiplication.' });
    s.drafts.push({ id: 'draft', title: 'Image draft', version: 1, cards: [{ id: 'card', kind: 'flashcard',
      prompt: 'Expand $x^2$.', answer: 'Square x.', topic: 'Algebra', objective: 'Expand', explanation: '', hint: '', misconception: '',
      citations: [{ sourceId: 'source', quote: 'A square can be expanded by multiplication.' }] }] });
  });
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: null, distDir });
  t.after(() => server.close());
  let browser;
  try { browser = await launchChromium(); }
  catch (error) { if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error; t.skip('Chromium unavailable'); return; }
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } }), errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'en'); localStorage.setItem('study-autopilot', 'off'); });
  await page.goto(server.url);
  await page.locator('[data-usage="nav.settings"]').click();
  const open = () => page.getByRole('button', { name: 'Formulas, images and calculation tools', exact: true }).click();
  await open();
  await page.locator('.science-preview math').waitFor();
  await page.getByLabel('Formula size', { exact: true }).selectOption('150');
  await page.getByLabel('Formula alignment', { exact: true }).selectOption('left');
  await page.getByLabel('Maximum image height', { exact: true }).selectOption('540');
  assert.equal(await page.locator('.study-app').evaluate(el => el.style.getPropertyValue('--study-formula-scale')), '1.5');
  assert.equal(await page.locator('.science-preview .md-math').evaluate(el => parseFloat(el.ownerDocument.defaultView.getComputedStyle(el).fontSize) > 20), true);
  await page.getByRole('button', { name: 'Balance equation', exact: true }).click();
  await page.getByText('Balanced: element counts agree on both sides.', { exact: true }).waitFor();
  assert.match(await page.locator('.science-tool').first().locator('math annotation').textContent(), /2 H2 \+ O2 -> 2 H2O/);
  await page.getByRole('button', { name: 'Verify identity', exact: true }).click();
  await page.getByText('Identity proved under the conditions below.', { exact: true }).waitFor();
  await page.getByLabel('Right-hand side', { exact: true }).fill('x^2 + 1');
  assert.equal(await page.getByText('Identity proved under the conditions below.', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Verify identity', exact: true }).click();
  await page.getByText('The expansions differ: this is not an identity.', { exact: true }).waitFor();
  await page.screenshot({ path: join(out, 'desktop.png') });
  await page.getByRole('checkbox', { name: 'Enable chemical balancing', exact: true }).uncheck();
  assert.equal(await page.getByRole('button', { name: 'Balance equation', exact: true }).count(), 0);
  await page.reload(); await page.locator('[data-usage="nav.settings"]').click(); await open();
  assert.equal(await page.getByLabel('Formula size', { exact: true }).inputValue(), '150');
  assert.equal(await page.getByRole('checkbox', { name: 'Enable chemical balancing', exact: true }).isChecked(), false);
  await page.setViewportSize({ width: 390, height: 900 });
  assert.ok(await page.locator('.science-settings').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await page.screenshot({ path: join(out, 'mobile.png') });
  await page.locator('.science-settings').getByRole('button', { name: 'Reset', exact: true }).click();
  assert.equal(await page.getByLabel('Formula size', { exact: true }).inputValue(), '100');
  assert.equal(await page.getByRole('checkbox', { name: 'Enable chemical balancing', exact: true }).isChecked(), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Study library', exact: true }).click();
  await page.locator('.draft-open').filter({ hasText: 'Image draft' }).click();
  await page.locator('.draft-card summary').click();
  await page.locator('.draft-card input[type="file"]').first().setInputFiles({
    name: 'diagram.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=', 'base64'),
  });
  const prompt = page.locator('.draft-card textarea').first();
  await page.waitForFunction(() => [...globalThis.document.querySelectorAll('.draft-card textarea')].some(el => el.value.includes('data:image/png;base64,')));
  assert.match(await prompt.inputValue(), /Expand.*data:image\/png;base64,/s);
  assert.doesNotMatch(await page.locator('.draft-card summary').innerText(), /iVBOR/);
  const savedResponse = page.waitForResponse(response => response.request().postData()?.includes('"draft.save"'));
  await page.getByRole('button', { name: 'Save & validate', exact: true }).click();
  await savedResponse;
  const saved = await service.store.read();
  assert.match(saved.drafts.find(d => d.id === 'draft').cards[0].prompt, /data:image\/png;base64,/);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
