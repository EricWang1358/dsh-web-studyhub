import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchChromium, skipMissingChromium } from '../scripts/qa/browser.mjs';
import { INTER_FAMILY, interFaceCss } from '../ui/fonts/inter-face.js';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('a changing board count keeps its width with the bundled Inter face and application styles', async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { skipMissingChromium(t, error); return; }
  t.after(() => browser.close());
  const page = await browser.newPage();
  const { default: font } = await import('../ui/fonts/inter-data.js');
  await page.setContent('<main lang="zh" class="study-app" style="font-family:var(--font-ui)"><span class="board-count"></span></main>');
  await page.addStyleTag({ content: [interFaceCss(font), read('ui/tokens.css'), read('ui/board/board.css'), read('ui/source-picker.css')].join('\n') });
  const widths = await page.locator('.board-count').evaluate(async (count, family) => {
    const faces = await count.ownerDocument.fonts.load(`16px "${family}"`, '0123456789');
    const range = count.ownerDocument.createRange();
    const measure = () => Array.from('0123456789', digit => {
      count.textContent = digit.repeat(4);
      range.selectNodeContents(count);
      return range.getBoundingClientRect().width;
    });
    const normal = measure();
    count.style.fontFeatureSettings = '"tnum" 0';
    return { loaded: faces.length, normal, proportional: measure() };
  }, INTER_FAMILY);
  assert.equal(widths.loaded, 1, 'the bundled font was available to the browser');
  assert.ok(Math.max(...widths.normal) - Math.min(...widths.normal) < 0.1, 'changing digits keeps the count aligned');
  assert.ok(Math.max(...widths.proportional) - Math.min(...widths.proportional) > 1, 'disabling tabular numerals visibly shifts the count');
});
