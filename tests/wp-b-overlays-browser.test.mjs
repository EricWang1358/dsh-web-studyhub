/* global window, document, DataTransfer, DragEvent, File */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

// UI wave 1, WP-B behaviour in a real browser: focus, keyboard, timers and
// single-flight cannot be seen in server-rendered markup.
const bundle = await build({ entryPoints: ['tests/helpers/overlays-harness.jsx'], bundle: true, write: false, format: 'iife', platform: 'browser',
  loader: { '.css': 'text', '.jsx': 'jsx' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const script = bundle.outputFiles[0].text;
const sleep = ms => new Promise(done => setTimeout(done, ms));

let browser, unavailable = false;
try { browser = await launchChromium(); }
catch (error) { if (!/Executable doesn't exist|browserType\.launch/.test(String(error.message))) throw error; unavailable = true; }

async function open(t, scenario) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, locale: 'zh-CN' });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank');
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: script });
  await page.evaluate(name => window.mountScenario(name), scenario);
  return { page, errors };
}
const active = page => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName);
const calls = page => page.evaluate(() => JSON.parse(JSON.stringify(window.calls)));

test('ConfirmDialog is single-flight, locks while busy and shows a thrown error without closing', { skip: unavailable }, async t => {
  const { page, errors } = await open(t, 'confirm');
  const dialog = page.locator('dialog.sh-dialog');
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消', 'initial focus is the cancel button');
  const confirm = page.getByRole('button', { name: '确认删除' });
  await confirm.dblclick();
  assert.equal((await calls(page)).confirm, 1, 'a double click is one call');
  assert.equal(await dialog.getAttribute('aria-busy'), 'true');
  await page.keyboard.press('Escape');
  assert.equal((await calls(page)).close, 0, 'Escape is ignored while busy');
  assert.equal(await dialog.count(), 1);
  assert.equal(await page.getByRole('button', { name: '取消' }).isDisabled(), true);
  assert.equal(await page.locator('.sh-dialog__close').getAttribute('aria-disabled'), 'true');
  await page.evaluate(() => window.settle(true));
  await page.getByText('磁盘已满').waitFor();
  assert.equal(await dialog.count(), 1, 'stays open after a failure');
  assert.equal(await dialog.getAttribute('aria-busy'), null);
  await confirm.click();
  assert.equal((await calls(page)).confirm, 2, 'the learner can retry');
  await page.evaluate(() => window.settle(false));
  await page.locator('dialog').waitFor({ state: 'detached' });
  assert.equal((await calls(page)).done, 1);
  assert.deepEqual(errors, []);
});

test('ConfirmDialog cancel closes and Escape closes when idle', { skip: unavailable }, async t => {
  const { page } = await open(t, 'confirm');
  await page.locator('dialog.sh-dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('dialog').waitFor({ state: 'detached' });
  assert.equal((await calls(page)).close, 1);
});

test('InlineConfirm focuses cancel on mount and hands focus back to the trigger on cancel', { skip: unavailable }, async t => {
  const { page } = await open(t, 'inline');
  await page.locator('#trigger').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('group').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消');
  await page.keyboard.press('Enter');
  await page.locator('#trigger').waitFor();
  await sleep(80);
  assert.equal(await active(page), 'trigger');
  assert.equal((await calls(page)).inlineCancel, 1);
});

test('Popover moves focus in, returns it on Escape and closes on an outside click', { skip: unavailable }, async t => {
  const { page } = await open(t, 'popover');
  const trigger = page.getByRole('button', { name: '显示设置' });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await trigger.click();
  await page.getByRole('dialog', { name: '显示设置' }).waitFor();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(await trigger.getAttribute('aria-pressed'), null);
  assert.equal(await active(page), 'first', 'focus moved into the panel');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true, 'focus came back');
  await trigger.click();
  await page.getByRole('dialog').waitFor();
  await page.mouse.click(850, 600);
  assert.equal(await page.getByRole('dialog').count(), 0, 'an outside click closes it');
});

test('Menu opens with the arrow key, moves with arrows, skips disabled items and returns focus on Escape', { skip: unavailable }, async t => {
  const { page } = await open(t, 'menu');
  const trigger = page.getByRole('button', { name: '更多操作' });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('menu').waitFor();
  const label = () => page.evaluate(() => document.activeElement?.textContent);
  assert.equal(await label(), '编辑');
  await page.keyboard.press('ArrowDown');
  assert.equal(await label(), '删除', 'the disabled item is skipped');
  await page.keyboard.press('ArrowDown');
  assert.equal(await label(), '编辑', 'wraps');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  await trigger.click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  assert.deepEqual((await calls(page)).select, ['delete']);
});

test('an undo toast leaves after its timeout but stays while the pointer is on 撤销', { skip: unavailable }, async t => {
  const { page } = await open(t, 'toast');
  const undo = page.getByRole('button', { name: '撤销' });
  await undo.waitFor();
  await undo.hover();
  await sleep(700);
  assert.equal(await undo.count(), 1, 'hovering keeps it past the timeout');
  await page.mouse.move(850, 650);
  await undo.waitFor({ state: 'detached', timeout: 2000 });
  assert.equal((await calls(page)).dismissed, 1);
});

test('a keyboard-focused 撤销 also holds the toast', { skip: unavailable }, async t => {
  const { page } = await open(t, 'toast');
  const undo = page.getByRole('button', { name: '撤销' });
  await undo.focus();
  await sleep(700);
  assert.equal(await undo.count(), 1);
});

test('Dialog busy ignores Escape and backdrop clicks', { skip: unavailable }, async t => {
  const { page } = await open(t, 'busy');
  const dialog = page.locator('dialog.sh-dialog');
  await dialog.waitFor();
  assert.equal(await dialog.getAttribute('aria-busy'), 'true');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await page.locator('.sh-dialog__close').click({ force: true });
  assert.equal((await calls(page)).dialogClose, 0);
  assert.equal(await dialog.count(), 1);
});

test('Dialog guardDrops keeps a stray file drop inside the dialog', { skip: unavailable }, async t => {
  const { page } = await open(t, 'drop');
  await page.locator('#margin').waitFor();
  const result = await page.evaluate(() => {
    const out = { leaked: 0 };
    document.addEventListener('drop', () => { out.leaked += 1; });
    const transfer = new DataTransfer();
    transfer.items.add(new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
    document.querySelector('.sh-dialog__header').dispatchEvent(event);
    out.prevented = event.defaultPrevented;
    return out;
  });
  assert.equal(result.prevented, true);
  assert.equal(result.leaked, 0, 'the host never sees it');
});

test('Tooltip shows on keyboard focus, is described by aria-describedby and hides on Escape', { skip: unavailable }, async t => {
  const { page } = await open(t, 'tooltip');
  const subject = page.locator('#subject');
  const tip = page.getByRole('tooltip');
  assert.equal(await tip.isVisible(), false);
  await subject.focus();
  await tip.waitFor({ state: 'visible' });
  const id = await subject.getAttribute('aria-describedby');
  assert.equal(await tip.getAttribute('id'), id);
  assert.equal(await tip.textContent(), '本周三 14:00 截止');
  await page.keyboard.press('Escape');
  await tip.waitFor({ state: 'hidden' });
  await page.locator('#after').focus();
  await subject.hover();
  await tip.waitFor({ state: 'visible' });
  await page.mouse.move(800, 600);
  await tip.waitFor({ state: 'hidden' });
});

after(async () => { await browser?.close(); });
