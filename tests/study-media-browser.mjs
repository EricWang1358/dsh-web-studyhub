/* Explicit browser receipt: npm test -- tests/study-media-browser.mjs.
 * Uses a temporary fake library, loopback preview and intercepted image URLs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../lib/store.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { buildPreview } from '../scripts/build.mjs';

test('fake-library math/media browser smoke at desktop and narrow widths', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'study-media-browser-'));
  const libraryRoot = join(root, 'library'), home = join(root, 'home'), distDir = join(root, 'dist');
  const out = resolve('output/playwright/study-media');
  await mkdir(out, { recursive: true });
  const store = new Store(libraryRoot);
  await store.update(state => {
    state.decks.push({ id: 'math', title: 'Math media QA', cards: [{ id: 'm1', kind: 'flashcard', topic: 'Chemistry',
      prompt: String.raw`$$\underbrace{1+2+3+4+5+6+7+8+9+10+11+12+13+14+15+16+17+18+19+20}_{\text{long equation}}$$ Balance $\ce{H2(g) + O2(g) -> H2O(l)}$. ![Question diagram](https://example.org/question.png)`,
      answer: String.raw`SECRET ANSWER $\ce{2H2(g) + O2(g) -> 2H2O(l)}$`,
      explanation: String.raw`$$\frac{x_i^2}{\sqrt{2}}$$`, hint: String.raw`\(x_i^2\)`,
      translation: { prompt: String.raw`English $x^2$`, answer: 'SECRET EN ANSWER' }, citations: [] }] });
  });
  await buildPreview({ outdir: distDir });
  let server, browser;
  try {
    server = await createPreviewServer({ libraryRoot, home, distDir, port: 0, model: 'fake', fakeLatencyMs: 0 });
    browser = await launchChromium();
    for (const width of [1280, 390, 320]) {
      await previewCall(server, 'review.start', { deckId: 'math', mode: 'path', fresh: true });
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US' });
      await context.addInitScript(dark => { localStorage.setItem('study-ui-language', 'en'); localStorage.setItem('study-theme', dark ? 'dark' : 'light'); }, width === 320);
      const page = await context.newPage(), errors = [], external = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'example.org') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="#d8b26e"/><text x="50" y="200" font-size="100">H₂ + O₂</text></svg>' });
        if (url.hostname !== '127.0.0.1') { external.push(url.href); return route.abort(); }
        return route.continue();
      });
      await page.goto(server.url);
      await page.locator('.study-app').waitFor();
      await page.waitForFunction(() => !globalThis.document.querySelector('.study-app')?.textContent.includes('Opening your study workspace'));
      await page.getByRole('button', { name: /Return to question/ }).waitFor();
      await page.getByRole('button', { name: /Return to question/ }).focus();
      await page.keyboard.press('s');

      await page.locator('.flip-front math').first().waitFor();
      const faceFits = await page.locator('.flip-front').evaluate(face => {
        const card = face.closest('.flashcard').getBoundingClientRect(), bounds = face.getBoundingClientRect();
        return bounds.left >= card.left - 1 && bounds.right <= card.right + 1;
      });
      assert.equal(faceFits, true, 'long formulas must not stretch the card face beyond its container');
      await page.screenshot({ path: join(out, `${width}-front.png`), animations: 'disabled' });
      if (width < 700) {
        const formula = page.locator('.flip-front .md-math-display');
        assert.equal(await formula.evaluate(el => el.scrollWidth > el.clientWidth), true);
        assert.ok(await formula.evaluate(el => {
          const equation = el.querySelector('math').getBoundingClientRect();
          return equation.left >= el.getBoundingClientRect().left - 1;
        }), 'the beginning of a centered long equation must remain reachable');
        await formula.focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => globalThis.document.querySelector('.flip-front .md-math-display').scrollLeft > 0);
        assert.equal(await formula.evaluate(el => el.ownerDocument.defaultView.getComputedStyle(el).pointerEvents), 'auto');
        assert.equal(await page.locator('.flashcard.flipped').count(), 0);
      }
      await page.getByRole('button', { name: 'Hint', exact: true }).click();
      await page.locator('.hint math').waitFor();
      await page.getByRole('button', { name: 'Hint', exact: true }).click();
      assert.equal(await page.getByText('SECRET ANSWER', { exact: false }).count(), 0);
      assert.equal(await page.getByText('SECRET EN ANSWER', { exact: false }).count(), 0);
      assert.equal(await page.locator('button button').count(), 0);
      await page.locator('.flip-front .md-image-open').focus();
      await page.keyboard.press('Enter');
      await page.locator('dialog[open]').waitFor();
      assert.ok(await page.locator('dialog[open]').evaluate(el => {
        const bounds = el.getBoundingClientRect();
        const viewport = el.ownerDocument.defaultView;
        return bounds.left >= 0 && bounds.right <= viewport.innerWidth + 1 && bounds.top >= 0 && bounds.bottom <= viewport.innerHeight + 1;
      }));
      await page.screenshot({ path: join(out, `${width}-image.png`), animations: 'disabled' });
      assert.equal(await page.locator('.flashcard.flipped').count(), 0);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !globalThis.document.querySelector('dialog[open]'));
      assert.equal(await page.locator('.flashcard.flipped').count(), 0);
      assert.equal(await page.locator('.flip-front .md-image-open').evaluate(el => el === el.ownerDocument.activeElement), true);
      await page.locator('.flip-control').focus();
      await page.keyboard.press('Space');
      await page.locator('.flashcard.flipped .flip-back math').first().waitFor();
      await page.locator('.flip-back').getByText('SECRET ANSWER', { exact: false }).waitFor();
      assert.ok((await page.locator('.flip-back').innerText()).includes('SECRET ANSWER'));
      await page.getByRole('button', { name: 'Explanation', exact: true }).click();
      await page.locator('.explanation math').waitFor();
      await page.getByRole('button', { name: 'Explanation', exact: true }).click();
      const fits = await page.locator('.flashcard').evaluate(el => el.getBoundingClientRect().width <= el.parentElement.getBoundingClientRect().width + 1);
      assert.equal(fits, true);
      await page.screenshot({ path: join(out, `${width}-revealed.png`), animations: 'disabled' });
      const flipBounds = await page.locator('.flip-control').boundingBox();
      await page.locator('.flip-control').click({ position: { x: flipBounds.width / 2, y: flipBounds.height - 24 } });
      await page.locator('.flashcard:not(.flipped)').waitFor();
      // A failed image reports its alt text without leaving an oversized broken image.
      await page.route('https://example.org/question.png', route => route.abort());
      await page.locator('.flip-front img').evaluate(img => { img.src = 'https://example.org/missing.png'; img.dispatchEvent(new Event('error')); });
      await page.locator('.flip-front .md-image-fallback').waitFor();
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      await context.close();
    }
  } finally {
    await browser?.close(); await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
