/* global document, getComputedStyle -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchChromium, skipMissingChromium } from '../scripts/qa/browser.mjs';

/* An icon-less busy button keeps its size: the label turns invisible and the spinner sits in the middle of it (ui/components/components.css,
   .sh-btn--spin-over). The 精致紧凑 look (ui/appearance-craft.css) lives in a higher cascade layer, so any rule there that sets a button's colour or a
   leading spinner's margin silently beats the component: the spinner was pinned to the left edge with the grey label showing through (owner report on
   测试连通). Both looks, both themes and every filled variant are measured here, in a real browser, because only the cascade can show it. */

const SHEETS = ['ui/tokens.css', 'ui/base.css', 'ui/components/components.css', 'ui/components/button-variants.css', 'ui/appearance-craft.css'];
const css = SHEETS.map((file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).join('\n');
const KINDS = ['secondary', 'primary', 'quiet', 'danger'];
const CASES = ['standard', 'refined'].flatMap((craft) => ['dark', 'light'].map((theme) => ({ craft, theme })));

const markup = ({ craft, theme }) => `<div class="study-app" data-craft="${craft}" data-theme="${theme}" style="min-height:0;padding:12px;display:flex;gap:12px">${
  KINDS.flatMap((kind) => ['md', 'sm'].map((size) => `<button class="sh-btn sh-btn--${kind} sh-btn--${size} sh-btn--spin-over" aria-busy="true" disabled data-case="${craft}/${theme}/${kind}/${size}"><span class="sh-spinner" aria-hidden="true"></span>测试连通</button>`)).join('')
}<button class="sh-btn sh-btn--secondary sh-btn--md" data-idle="${craft}/${theme}">测试连通</button></div>`;

test('a busy button centres its spinner and hides its label in every look', async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { skipMissingChromium(t, error); return; }
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  await page.setContent(`<style>${css}</style>${CASES.map(markup).join('')}`);
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-case]')].map((button) => {
    const box = button.getBoundingClientRect();
    const spinner = button.querySelector('.sh-spinner').getBoundingClientRect();
    return {
      name: button.dataset.case,
      offX: Math.abs((spinner.left + spinner.width / 2) - (box.left + box.width / 2)),
      offY: Math.abs((spinner.top + spinner.height / 2) - (box.top + box.height / 2)),
      label: getComputedStyle(button).color,
    };
  }));
  assert.equal(rows.length, CASES.length * KINDS.length * 2);
  const offCentre = rows.filter((row) => row.offX > 1 || row.offY > 1).map((row) => `${row.name} (${row.offX.toFixed(1)}, ${row.offY.toFixed(1)})`);
  assert.deepEqual(offCentre, [], 'the spinner stands in the middle of the button');
  const showing = rows.filter((row) => row.label !== 'rgba(0, 0, 0, 0)').map((row) => `${row.name} ${row.label}`);
  assert.deepEqual(showing, [], 'the label is invisible under the spinner');
});

test('the spinner is a whole ring with one bright arc, not a broken circle', async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { skipMissingChromium(t, error); return; }
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<style>${css}</style><div class="study-app" data-craft="standard" data-theme="dark" style="color:rgb(200,200,200)"><span class="sh-spinner" aria-hidden="true"></span></div>`);
  const edges = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.sh-spinner'));
    return [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
  });
  const [top, ...track] = edges;
  assert.equal(new Set(track).size, 1, 'three sides share the faint track colour');
  assert.notEqual(top, track[0], 'one side is the bright arc');
  assert.doesNotMatch(track[0], /(, 0\)$|\/ 0\)$|^transparent$)/, 'the track is faint, never missing');
});
