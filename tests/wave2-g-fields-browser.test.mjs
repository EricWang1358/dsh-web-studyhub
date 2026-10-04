/* global window, document, getComputedStyle */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

// WP-G behaviour in a real browser: toggling, keyboard, the aria wiring a Field adds, and the one label weight / one hint size.
const bundle = await build({ entryPoints: ['tests/helpers/fields-harness.jsx'], bundle: true, write: false, format: 'iife', platform: 'browser',
  loader: { '.css': 'text', '.jsx': 'jsx' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const script = bundle.outputFiles[0].text;

let browser, unavailable = false;
try { browser = await launchChromium(); }
catch (error) { if (!/Executable doesn't exist|browserType\.launch/.test(String(error.message))) throw error; unavailable = true; }
after(() => browser?.close());

async function open(t) {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, locale: 'zh-CN' });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank');
  await page.setContent('<!doctype html><html><head><style>:where(.study-app) label { display: flex; flex-direction: column; gap: 8px; margin: 19px 0; } :where(.study-app) :is(input, select, textarea) { width: 100%; padding: 12px; } :where(.study-app) small { font-size: 15px; } .study-app { --text: #111; --text-muted: #666; --text-dim: #444; --bg-sunken: #eee; --bg-surface: #fff; --line: #ccc; --line-strong: #999; --accent: #c33; --accent-soft: #d55; --bad: #a22; --bad-ink: #811; --fs-xs: 12px; --fs-sm: 13px; --fs-lg: 17px; --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px; --space-7: 32px; --radius-sm: 8px; --radius-pill: 999px; --radius-card: 16px; }</style></head><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => window.mountScenario('fields'));
  await page.locator('.sh-field').first().waitFor();
  return { page, errors };
}
const calls = page => page.evaluate(() => JSON.parse(JSON.stringify(window.calls)));

test('a Switch toggles by click and by Space, reports the new value, and a disabled one does nothing', { skip: unavailable }, async t => {
  const { page, errors } = await open(t);
  const usage = page.getByRole('switch', { name: '记录使用频率' });
  assert.equal(await usage.isChecked(), false);
  await usage.click();
  assert.equal(await usage.isChecked(), true);
  await usage.focus();
  await page.keyboard.press('Space');
  assert.equal(await usage.isChecked(), false);
  assert.deepEqual((await calls(page)).switch, [true, false]);
  const disabled = page.getByRole('switch', { name: '停用的开关' });
  assert.equal(await disabled.isDisabled(), true);
  await disabled.click({ force: true }).catch(() => {});
  assert.equal((await calls(page)).disabled, 0);
  assert.deepEqual(errors, []);
});

test('clicking the label text toggles a Checkbox, and the input is described by its hint', { skip: unavailable }, async t => {
  const { page } = await open(t);
  const agree = page.getByRole('checkbox', { name: '同意上传' });
  assert.equal(await agree.isChecked(), true);
  await page.getByText('同意上传', { exact: true }).click();
  assert.equal(await agree.isChecked(), false);
  assert.deepEqual((await calls(page)).check, [false]);
  const described = await agree.getAttribute('aria-describedby');
  assert.equal(await page.locator(`[id="${described}"]`).textContent(), '文档会上传。');
});

test('RadioCards select one at a time by click and by arrow keys', { skip: unavailable }, async t => {
  const { page } = await open(t);
  const [basic, standard] = [page.getByRole('radio', { name: /^basic/ }), page.getByRole('radio', { name: /^standard/ })];
  assert.equal(await basic.isChecked(), true);
  await page.locator('.sh-radio-card', { hasText: 'standard' }).click();
  assert.equal(await standard.isChecked(), true);
  assert.equal(await page.locator('.sh-radio-card.is-selected').count(), 1);
  await standard.focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(await basic.isChecked(), true);
  assert.deepEqual((await calls(page)).tier, ['standard', 'basic']);
  assert.equal(await page.getByRole('group', { name: '选一个档位' }).count(), 1);
});

test('a Field wires its label, hint and error to the control as the learner types', { skip: unavailable }, async t => {
  const { page } = await open(t);
  const input = page.getByLabel('课程名称');
  assert.equal(await input.getAttribute('aria-invalid'), null);
  await input.fill('abcdef');
  assert.equal(await input.getAttribute('aria-invalid'), 'true');
  const ids = (await input.getAttribute('aria-describedby')).split(' ');
  assert.equal(ids.length, 2);
  const texts = await Promise.all(ids.map(id => page.locator(`[id="${id}"]`).textContent()));
  assert.deepEqual(texts, ['最多 3 个字', '最多 3 个字']);
  assert.equal(await page.locator('[role="alert"]').count(), 1);
  await input.fill('abc');
  assert.equal(await input.getAttribute('aria-invalid'), null);
  assert.equal(await page.locator('[role="alert"]').count(), 0);
});

test('every field label and choice title has one weight and every hint one size', { skip: unavailable }, async t => {
  const { page } = await open(t);
  const styles = await page.evaluate(() => {
    const values = (selector, property) => [...new Set([...document.querySelectorAll(selector)].map(node => getComputedStyle(node)[property]))];
    return { weights: values('.sh-field__label, .sh-check__label', 'fontWeight'), sizes: values('.sh-hint', 'fontSize'), inputs: values('.sh-input', 'borderTopLeftRadius') };
  });
  assert.equal(styles.weights.length, 1, `label weights: ${styles.weights}`);
  assert.equal(styles.sizes.length, 1, `hint sizes: ${styles.sizes}`);
});

test('the switch track follows the input state and the sheet is scoped to the study surfaces', { skip: unavailable }, async t => {
  const { page } = await open(t);
  const track = page.locator('.sh-switch__track').first();
  const before = await track.evaluate(node => getComputedStyle(node).backgroundColor);
  await page.getByRole('switch', { name: '记录使用频率' }).click();
  const after = await track.evaluate(node => getComputedStyle(node).backgroundColor);
  assert.notEqual(before, after, 'the track changes with the state');
  assert.equal(await page.evaluate(() => document.querySelector('style[data-study-fields]')?.textContent.includes(':is(.study-app, .study-seat)')), true);
});

test('the rows keep their own layout against the legacy element defaults (a label is a column with a margin, an input is full width)', { skip: unavailable }, async t => {
  const { page } = await open(t);
  const layout = await page.evaluate(() => {
    const of = selector => getComputedStyle(document.querySelector(selector));
    return { check: [of('.sh-check').flexDirection, of('.sh-check').marginTop], card: [of('.sh-radio-card').flexDirection, of('.sh-radio-card').marginTop],
      box: of('.sh-check__input').width, radio: of('.sh-radio-card__input').width, label: [of('.sh-field__label').display, of('.sh-field__label').marginTop],
      input: of('.sh-field .sh-input').paddingTop };
  });
  assert.deepEqual(layout.check, ['row', '0px']);
  assert.deepEqual(layout.card, ['row', '0px']);
  assert.ok(parseFloat(layout.box) < 40 && parseFloat(layout.radio) < 40, `checkbox ${layout.box}, radio ${layout.radio}`);
  assert.deepEqual(layout.label, ['block', '0px']);
  assert.equal(layout.input, '8px', 'the input has its own padding, not the legacy 12px');
});
