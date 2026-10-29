/* global document, getSelection, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchChromium } from '../scripts/qa/browser.mjs';

// The native DSH seat shares its document with the floating composer. A drag
// starting in the composer's padding must not anchor in the page behind it.
const sheets = (await Promise.all(['tokens', 'base', 'appearance-themes', 'host/studyhub']
  .map(name => readFile(`ui/${name}.css`, 'utf8')))).join('\n');
const fixture = (palette = 'standard', theme = 'dark') => `<!doctype html>
<style>${sheets}</style>
<style>
  body { margin: 0; font: 16px/24px sans-serif; }
  [data-conversation-scroll] { position: relative; width: 900px; height: 600px; --dsh-composer-height: 100px; }
  .study-app { display: block; padding: 24px; background: var(--bg-canvas); }
  [data-conversation-region="composer"] { position: absolute; bottom: 0; left: 100px; width: 700px; padding: 20px; box-sizing: border-box; background: #999; }
  [contenteditable] { min-height: 24px; padding: 4px; background: #fff; }
</style>
<div data-conversation-scroll>
  <div class="study-seat-frame" data-conversation-composer-overlay>
    <div class="study-seat"><div class="study-app" data-palette="${palette}" data-theme="${theme}">
      <p id="article">StudyHub source text stays selectable.</p>
      <p>Unrelated study content must stay out of a composer selection.</p>
    </div></div>
  </div>
  <div data-conversation-region="composer"><div contenteditable="true" role="textbox">Draft text for editing</div></div>
</div>`;

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await page.mouse.up();
  return page.evaluate(() => getSelection().toString());
}

test('DSH composer padding cannot select StudyHub, including with a skin', { timeout: 60000 }, async t => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  for (const [palette, theme] of [['standard', 'dark'], ['standard', 'light'], ['oled', 'dark'], ['paper', 'light']]) {
    await t.test(`${palette} / ${theme}`, async () => {
      await page.setContent(fixture(palette, theme));
      const editor = await page.locator('[contenteditable]').boundingBox();
      const selected = await drag(page, { x: editor.x - 10, y: editor.y + 12 }, { x: 40, y: 40 });
      assert.equal(selected, '', 'dragging the empty composer edge selected the study page');

      // Editing still supports drag selection and Select All within the draft.
      const draft = await drag(page, { x: editor.x + 150, y: editor.y + 12 }, { x: editor.x + 5, y: editor.y + 12 });
      assert.ok(draft.length > 0);
      assert.ok('Draft text for editing'.includes(draft));
      await page.locator('[contenteditable]').press('ControlOrMeta+a');
      assert.equal(await page.evaluate(() => getSelection().toString()), 'Draft text for editing');

      // The skin cannot paint over the input or steal its hit target.
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x + 8, y + 8)?.isContentEditable, editor), true);

      const article = await page.locator('#article').boundingBox();
      const quote = await drag(page, { x: article.x + 2, y: article.y + 12 }, { x: article.x + 170, y: article.y + 12 });
      assert.ok(quote.length > 0, 'reading and copying source text still works');
      assert.ok('StudyHub source text stays selectable.'.includes(quote));
    });
  }
  await t.test('the normal chat and a sidebar-only StudyHub seat keep host defaults', async () => {
    await page.setContent(fixture());
    await page.locator('.study-seat-frame').evaluate(el => el.classList.remove('study-seat-frame'));
    assert.notEqual(await page.locator('[data-conversation-region="composer"]').evaluate(el => getComputedStyle(el).userSelect), 'none');
  });
});
