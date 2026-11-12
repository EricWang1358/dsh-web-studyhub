/* global document window */
/* #996 in a real Chromium: the sample set the issue names (scripts, \sum_{i\ge1}, \mathbb{E}, \mathcal{F}, fractions, matrices, \left( \right), mhchem) drawn
   as the app draws it (ui/study-math-render.js inside .md-math, with the app's tokens and formula rules, the stylesheet installed in the app's layer).
   Checked for every glyph: it is set in a KaTeX face that is loaded (that each glyph is IN that face is tests/math-font.test.mjs's: KaTeX's metrics are
   measured from these fonts and it warns for a character without them). Checked for the page: the KaTeX fonts swap in (never block), an inline formula
   keeps the line height of a mixed Chinese/English sentence, and on the dark theme a formula and its fraction bars take the text colour. Screenshots at
   1280 and 420, light and dark, go to MATH_FONT_SHOTS when it is set. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { renderStudyFormula, MATH_STYLE } from '../ui/study-math-render.js';
import { MATH_SAMPLES as SAMPLES, INLINE_SAMPLES as INLINE } from './helpers/math-samples.mjs';
const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const formula = (source, display) => `<span class="md-math${display ? ' md-math-display' : ''}"><span class="md-math-content">${renderStudyFormula(source, display)}</span></span>`;
const sentence = (inner) => `<p class="probe">在快照隔离 (snapshot isolation) 下 ${inner} 事务读取一致快照, and more text.</p>`;

async function page(theme) {
  const css = (await Promise.all(['ui/tokens.css', 'ui/markdown.css'].map((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')))).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style><style>${MATH_STYLE}</style>
<style>body{margin:0}.study-app{background:var(--bg-canvas);color:var(--text);font:16px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;padding:16px}
table{border-collapse:collapse;width:100%;table-layout:fixed}td{padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
td.src{width:38%;font:12px/1.4 ui-monospace,Consolas,monospace;color:var(--text-muted);overflow-wrap:anywhere}</style></head>
<body><div class="study-app"${theme === 'light' ? ' data-theme="light"' : ''}>
<table>${SAMPLES.map((source) => `<tr><td class="src">${esc(source)}</td><td class="drawn">${formula(source, true)}</td></tr>`).join('')}</table>
${sentence('')}${INLINE.map((source) => sentence(formula(source, false))).join('')}
</div></body></html>`;
}

test('the #996 samples draw in Chromium with KaTeX fonts only, swap in, keep the line height, and read on the dark theme', { timeout: 180000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const shots = process.env.MATH_FONT_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const theme of ['dark', 'light']) for (const width of [1280, 420]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, offline: true });
      const tab = await context.newPage();
      await tab.setContent(await page(theme));
      const result = await tab.evaluate(async () => {
        await document.fonts.ready;
        const faces = [...document.fonts].filter((face) => face.family.replace(/"/g, '').startsWith('KaTeX_'));
        // Every glyph is set in a KaTeX face, and that face is loaded.
        const loadedFamilies = new Set(faces.filter((face) => face.status === 'loaded').map((face) => face.family.replace(/"/g, '')));
        const missing = [];
        for (const element of document.querySelectorAll('.katex-html *')) {
          const own = [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.data).join('').replace(/\s/g, '');
          if (!own) continue;
          const family = window.getComputedStyle(element).fontFamily.split(',')[0].trim().replace(/"/g, '');
          if (!family.startsWith('KaTeX_') || !loadedFamilies.has(family)) missing.push(`${own} (${family})`);
        }
        const heights = [...document.querySelectorAll('p.probe')].map((p) => p.getBoundingClientRect().height);
        const app = document.querySelector('.study-app'), katex = document.querySelector('td.drawn .katex'), bar = document.querySelector('td.drawn .frac-line');
        return { faces: faces.length, loaded: faces.filter((face) => face.status === 'loaded').map((face) => face.family), display: [...new Set(faces.map((face) => face.display))],
          errors: document.querySelectorAll('.katex-error').length, drawn: document.querySelectorAll('td.drawn .katex-html').length, missing: [...new Set(missing)], heights,
          weight: window.getComputedStyle(document.querySelector('td.drawn .mord.mathnormal')).fontWeight,
          text: window.getComputedStyle(app).color, katexColor: window.getComputedStyle(katex).color, barColor: window.getComputedStyle(bar).borderBottomColor,
          sideways: document.documentElement.scrollWidth - window.innerWidth };
      });
      const label = `${theme} ${width}px`;
      assert.equal(result.errors, 0, `${label}: every sample parses`);
      assert.equal(result.drawn, SAMPLES.length, `${label}: every sample is laid out by KaTeX`);
      assert.deepEqual(result.missing, [], `${label}: no glyph from a fallback font`);
      assert.equal(result.faces, 20, `${label}: the twenty faces are registered`);
      assert.ok(result.loaded.length > 0, `${label}: the faces the samples use are loaded`);
      assert.deepEqual(result.display, ['swap'], `${label}: a formula never blocks the page`);
      const [plain, ...inline] = result.heights;
      for (const [at, height] of inline.entries()) assert.ok(Math.abs(height - plain) <= 0.5, `${label}: ${INLINE[at]} keeps the line height (${height} vs ${plain})`);
      assert.equal(result.weight, '400', `${label}: a letter is the regular face, not the app's text weight`);
      assert.equal(result.katexColor, result.text, `${label}: a formula takes the text colour`);
      assert.equal(result.barColor, result.text, `${label}: and so do its fraction bars`);
      assert.ok(result.sideways <= 0, `${label}: nothing scrolls sideways (${result.sideways}px)`);
      if (shots) await tab.screenshot({ path: join(shots, `math-${theme}-${width}.png`), fullPage: true });
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
