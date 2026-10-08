/* global window, document, getComputedStyle */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

// WP-4 in a real browser: Select and Combobox on Base UI: aria wiring through Field, keyboard, search, footer actions, the popup's
// place under the interface zoom (90% and 125%), flipping, a narrow pane, inside a Dialog, and reduced motion.
const bundle = await build({ entryPoints: ['tests/helpers/select-harness.jsx'], bundle: true, write: false, format: 'iife', platform: 'browser',
  loader: { '.css': 'text', '.jsx': 'jsx' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const script = bundle.outputFiles[0].text;
const [tokens, base] = await Promise.all([readFile('ui/tokens.css', 'utf8'), readFile('ui/base.css', 'utf8')]);

let browser, unavailable = false;
try { browser = await launchChromium(); }
catch (error) { if (!/Executable doesn't exist|browserType\.launch/.test(String(error.message))) throw error; unavailable = true; }
after(() => browser?.close());

async function open(t, { scale = '100', width = 1000, height = 900, reducedMotion = 'no-preference', scenario } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', reducedMotion });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${tokens}</style><style>${base}</style></head><body data-theme="dark"><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.evaluate(name => window.mountScenario(name), scenario);
  await page.locator('#scene').waitFor();
  await page.evaluate(value => { document.getElementById('scene').dataset.uiScale = value; }, scale);
  // The real trigger replaces the closed shell once the popup code has loaded.
  await page.locator(scenario === 'ingest' || scenario === 'decks' ? 'button[role="combobox"][aria-haspopup="dialog"]' : '#fields .sh-select__valuebox').first().waitFor({ state: 'attached' });
  return { page, errors };
}
const calls = page => page.evaluate(() => JSON.parse(JSON.stringify(window.calls)));
// Select keeps its popup in the document, hidden, after it closes (Base UI's own behaviour); Combobox removes it. Either way: not visible.
const popup = page => page.locator('.sh-pop__popup:not([data-closed])');
const settled = async page => { await page.waitForFunction(() => { const element = document.querySelector('.sh-pop__popup:not([data-closed])'); return !!element && !element.hasAttribute('data-starting-style'); }); await page.waitForTimeout(200); };
// Focus goes back to the trigger when the popup has finished closing, so it is polled for.
const focusedOn = async (locator, message) => { const handle = await locator.elementHandle(); await locator.page().waitForFunction(element => document.activeElement === element, handle, { timeout: 3000 }).catch(() => {}); assert.equal(await locator.evaluate(element => document.activeElement === element), true, message); };
const box = locator => locator.evaluate(element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; });

test('a Select is a labelled combobox button inside a Field: label, hint, required and invalid are wired, the value shows with its hint', { skip: unavailable }, async t => {
  const { page, errors } = await open(t);
  const tone = page.getByRole('combobox', { name: '讲解口吻' });
  assert.equal(await tone.evaluate(element => element.tagName), 'BUTTON');
  assert.equal((await tone.textContent()).replace(/\s+/g, ''), '亲切默认');
  const hint = await page.locator('#fields .sh-hint').first().getAttribute('id');
  assert.match(await tone.getAttribute('aria-describedby'), new RegExp(hint));
  const empty = page.getByRole('combobox', { name: /空的选择/ });
  assert.equal(await empty.getAttribute('aria-invalid'), 'true');
  assert.equal((await empty.textContent()).trim(), '选择…', 'an empty value shows the placeholder');
  assert.equal(await empty.evaluate(element => getComputedStyle(element.querySelector('.sh-select__placeholder')).color !== getComputedStyle(element).color), true, 'the placeholder is the faint colour');
  await page.getByText('讲解口吻', { exact: true }).click();
  await popup(page).waitFor();
  assert.deepEqual(errors, []);
});

test('Select: click opens a listbox of options (the chosen one marked), a click chooses, a disabled option does not, and the popup is as wide as the trigger', { skip: unavailable }, async t => {
  const { page, errors } = await open(t);
  const tone = page.getByRole('combobox', { name: '讲解口吻' });
  await tone.click();
  await popup(page).waitFor();
  const options = page.getByRole('option');
  assert.deepEqual((await options.allTextContents()).map(text => text.replace(/\s+/g, '')), ['亲切默认', '专业', '严格']);
  assert.equal(await page.getByRole('option', { name: /亲切/ }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('option', { name: /严格/ }).getAttribute('aria-disabled'), 'true');
  assert.equal(await tone.getAttribute('aria-expanded'), 'true');
  await settled(page);
  const trigger = await box(tone), pop = await box(popup(page));
  assert.ok(Math.abs(trigger.width - pop.width) <= 1 && Math.abs(trigger.x - pop.x) <= 1, `the popup matches the trigger (${JSON.stringify([trigger, pop])})`);
  assert.ok(pop.y >= trigger.y + trigger.height, 'it opens below');
  await page.getByRole('option', { name: /严格/ }).click({ force: true });
  assert.equal((await calls(page)).select.length, 0, 'a disabled option cannot be chosen');
  await page.getByRole('option', { name: '专业' }).click();
  await popup(page).waitFor({ state: 'hidden' });
  assert.deepEqual((await calls(page)).select, [['professional', '专业']]);
  assert.match(await tone.textContent(), /专业/);
  await focusedOn(tone, 'focus returns to the trigger');
  assert.deepEqual(errors, []);
});

test('Select keyboard: ArrowDown opens, arrows and Home/End move, Enter chooses, Escape closes and returns focus, typing jumps to a match', { skip: unavailable }, async t => {
  const { page, errors } = await open(t);
  const grouped = page.getByRole('combobox', { name: '分组' });
  await grouped.focus();
  await page.keyboard.press('ArrowDown');
  await popup(page).waitFor();
  assert.equal(await grouped.getAttribute('aria-expanded'), 'true');
  assert.deepEqual((await page.getByRole('group').allTextContents()).length, 2, 'two groups');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await popup(page).waitFor({ state: 'hidden' });
  assert.deepEqual((await calls(page)).select.at(-1), ['b', 'grouped']);
  await focusedOn(grouped);
  await grouped.press('Enter');
  await popup(page).waitFor();
  await page.keyboard.press('Escape');
  await popup(page).waitFor({ state: 'hidden' });
  await focusedOn(grouped, 'Escape returns focus to the trigger');
  assert.equal((await calls(page)).select.length, 1, 'Escape chooses nothing');
  await grouped.press('Enter');
  await popup(page).waitFor();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await popup(page).waitFor({ state: 'hidden' });
  assert.deepEqual((await calls(page)).select.at(-1), ['', 'grouped'], 'End goes to the last option, an empty value is a real choice');
  await grouped.press('Enter');
  await popup(page).waitFor();
  await page.keyboard.type('g');
  await page.keyboard.press('Enter');
  await popup(page).waitFor({ state: 'hidden' });
  assert.deepEqual((await calls(page)).select.at(-1), ['c', 'grouped'], 'type-ahead finds Gamma');
  assert.deepEqual(errors, []);
});

test('a disabled Select does not open; a long list scrolls inside the popup and keeps the page still', { skip: unavailable }, async t => {
  const { page, errors } = await open(t, { height: 700 });
  const disabled = page.getByRole('combobox', { name: '停用' });
  assert.equal(await disabled.isDisabled(), true);
  await disabled.click({ force: true }).catch(() => {});
  assert.equal(await popup(page).count(), 0);
  const many = page.getByRole('combobox', { name: '很多项' });
  await many.click();
  await popup(page).waitFor();
  const list = page.locator('.sh-pop__list');
  assert.equal(await list.evaluate(element => element.scrollHeight > element.clientHeight), true, 'sixty options scroll inside the popup');
  assert.equal(await popup(page).evaluate(element => element.getBoundingClientRect().bottom <= window.innerHeight), true, 'the popup stays inside the window');
  await page.keyboard.press('End');
  assert.match(await page.locator('[role="option"][data-highlighted]').textContent(), /第 60 项/);
  assert.deepEqual(errors, []);
});

test('Combobox: searching filters by every word, marks the matches, keeps a course above its matching chapter, and Enter chooses the chapter that was typed', { skip: unavailable }, async t => {
  const { page, errors } = await open(t);
  const trigger = page.getByRole('combobox', { name: '换课程' });
  await trigger.click();
  const search = page.getByRole('combobox', { name: '搜索课程或章节' }).or(page.getByPlaceholder('搜索课程或章节'));
  await search.first().waitFor();
  assert.equal(await page.getByPlaceholder('搜索课程或章节').evaluate(element => document.activeElement === element), true, 'the search box has focus');
  const all = await page.getByRole('option').allTextContents();
  assert.equal(all.length, 7, 'a course, its three chapters and the other courses');
  await page.keyboard.type('矩阵');
  const rows = page.getByRole('option');
  assert.deepEqual((await rows.allTextContents()).map(text => text.trim()), ['第 2 章 矩阵']);
  assert.equal(await page.locator('.sh-pop__list mark').first().textContent(), '矩阵', 'the typed text is marked');
  assert.match(await page.locator('.sh-opt--context').textContent(), /MA1522/, 'the course is shown above its chapter as context');
  assert.equal(await page.locator('.sh-opt--context').getAttribute('role'), 'presentation', 'and is not an option');
  assert.equal(await rows.first().getAttribute('data-highlighted') !== null, true, 'the first match is highlighted');
  assert.equal(await rows.first().getAttribute('aria-level'), '2');
  await page.keyboard.press('Enter');
  await popup(page).waitFor({ state: 'hidden' });
  assert.deepEqual((await calls(page)).course, ['MA1522 线性代数 / 第 2 章 矩阵']);
  await focusedOn(trigger, 'focus returns to the trigger');
  assert.match(await trigger.textContent(), /MA1522 线性代数 \/ 第 2 章 矩阵/, 'the closed trigger says the whole course path');
  assert.deepEqual(errors, []);
});

test('Combobox: the empty state is one sentence, and a footer action is a button (not an option) that closes the popup and runs with the typed text', { skip: unavailable }, async t => {
  const { page, errors } = await open(t);
  const trigger = page.getByRole('combobox', { name: '换课程' });
  await trigger.click();
  await page.getByPlaceholder('搜索课程或章节').fill('量子');
  assert.equal(await page.getByRole('option').count(), 0);
  assert.equal((await page.locator('.sh-combobox__empty').textContent()).trim(), '没有叫「量子」的课程');
  await page.getByPlaceholder('搜索课程或章节').fill('');
  const action = page.getByRole('button', { name: '课程设置…' });
  assert.equal(await action.count(), 1);
  assert.equal(await page.getByRole('option', { name: /课程设置/ }).count(), 0, 'the action is not an option');
  await page.getByPlaceholder('搜索课程或章节').press('ArrowDown');
  await page.keyboard.press('End');
  assert.equal(await action.evaluate(element => document.activeElement === element), false, 'arrow keys never land on the footer');
  await action.click();
  await popup(page).waitFor({ state: 'hidden' });
  assert.deepEqual((await calls(page)).actions, ['settings']);
  assert.deepEqual((await calls(page)).course, [], 'nothing was chosen');
  assert.deepEqual(errors, []);
});

test('Combobox with create: the typed name is in the action label, and Enter creates when nothing matches', { skip: unavailable }, async t => {
  const { page, errors } = await open(t);
  const trigger = page.getByRole('combobox', { name: '题组' }).first();
  assert.match(await trigger.textContent(), /新建题组/, 'a value that is no option shows its own label');
  await trigger.click();
  const search = page.getByPlaceholder('搜索题组');
  await search.fill('特征');
  assert.deepEqual((await page.getByRole('option').allTextContents()).map(text => text.replace(/\s+/g, '')), ['第4章特征值与特征向量38题', '期末·特征分解专项12题']);
  assert.equal(await page.locator('.sh-opt mark').count(), 3, 'both matches in both labels are marked');
  assert.equal((await page.getByRole('button', { name: /新建题组/ }).textContent()).trim(), '新建题组「特征」');
  await search.fill('量子力学');
  assert.equal(await page.getByRole('option').count(), 0);
  await search.press('Enter');
  await popup(page).waitFor({ state: 'hidden' });
  assert.deepEqual((await calls(page)).actions.at(-1), ['new', '量子力学']);
  assert.equal(await page.locator('#typed').textContent(), '量子力学');
  assert.deepEqual(errors, []);
});

test('Ingest: decks are grouped under their course (the current one first) and 新建题组 carries the typed name into the new deck', { skip: unavailable }, async t => {
  const { page, errors } = await open(t, { scenario: 'ingest' });
  const picker = page.getByRole('combobox', { name: '题组', exact: true });
  assert.match(await picker.textContent(), /第 4 章 特征值/, 'a deck of the current course is chosen to begin with');
  await picker.click();
  await popup(page).waitFor();
  const groups = await page.locator('.sh-pop__group-label').allTextContents();
  assert.deepEqual(groups, ['MA1522 线性代数', 'CS2040S 数据结构'], 'the current course comes first');
  assert.deepEqual((await page.getByRole('option').allTextContents()).map(text => text.replace(/\s+/g, '')), ['第4章特征值38题', '期末·错题12题', '图与最短路20题']);
  await page.getByPlaceholder('搜索题组').fill('量子错题');
  assert.equal((await page.getByRole('button', { name: /新建题组/ }).textContent()).trim(), '新建题组「量子错题」');
  await page.getByRole('button', { name: /新建题组/ }).click();
  await popup(page).waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('题组名称').inputValue(), '量子错题', 'the typed name is the name of the new deck');
  await page.getByRole('button', { name: /开始录题/ }).click();
  assert.equal((await calls(page)).ingest[0].deckTitle, '量子错题');
  await picker.click();
  await page.getByRole('option', { name: /图与最短路/ }).click();
  await page.getByRole('button', { name: /开始录题/ }).click();
  assert.equal((await calls(page)).ingest[1].deckId, 'd2');
  assert.deepEqual(errors, []);
});

test('the heading variant keeps the heading size, shows only a caret, and chooses a chapter', { skip: unavailable }, async t => {
  const { page, errors } = await open(t);
  const heading = page.getByRole('combobox', { name: '切换当前课程' });
  const sizes = await page.evaluate(() => ({ h1: getComputedStyle(document.getElementById('heading')).fontSize, button: getComputedStyle(document.querySelector('#heading button')).fontSize,
    border: getComputedStyle(document.querySelector('#heading button')).borderTopWidth }));
  assert.equal(sizes.button, sizes.h1, 'the trigger is the heading text');
  assert.equal(sizes.border, '0px');
  assert.equal(await heading.locator('svg').count(), 1, 'one caret');
  await heading.click();
  await page.getByPlaceholder('搜索').fill('向量');
  await page.getByRole('option', { name: /第 3 章/ }).click();
  assert.deepEqual((await calls(page)).heading, ['MA1522 线性代数 / 第 3 章 向量空间']);
  assert.deepEqual(errors, []);
});

for (const scale of ['90', '125']) {
  test(`at ${scale}% interface size the popup sits flush under its trigger and matches its width`, { skip: unavailable }, async t => {
    const { page, errors } = await open(t, { scale });
    for (const name of ['讲解口吻', '换课程']) {
      const trigger = page.getByRole('combobox', { name });
      await trigger.click();
      await popup(page).waitFor();
      await settled(page);
      const a = await box(trigger), b = await box(popup(page));
      assert.ok(Math.abs(a.x - b.x) <= 1, `${name} @${scale}: left ${a.x} vs ${b.x}`);
      assert.ok(Math.abs(a.width - b.width) <= 1, `${name} @${scale}: width ${a.width} vs ${b.width}`);
      const below = b.y - (a.y + a.height), above = a.y - (b.y + b.height), limit = 8 * Number(scale) / 100;
      assert.ok((below >= 0 && below <= limit) || (above >= 0 && above <= limit), `${name} @${scale}: flush under (${below}) or, when it flipped, flush above (${above}) the trigger`);
      await page.keyboard.press('Escape');
      await popup(page).waitFor({ state: 'hidden' });
    }
    assert.deepEqual(errors, []);
  });
}

test('near the bottom of the window the popup flips above the trigger and never leaves the window; a 420px pane works', { skip: unavailable }, async t => {
  const { page, errors } = await open(t, { width: 420, height: 520 });
  const trigger = page.getByRole('combobox', { name: '题组' }).first();
  await trigger.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 300));
  await trigger.click();
  await popup(page).waitFor();
  await settled(page);
  const a = await box(trigger), b = await box(popup(page));
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  assert.ok(b.y >= 0 && b.y + b.height <= view.h + 1, `inside the window vertically (${JSON.stringify(b)})`);
  assert.ok(b.x >= 0 && b.x + b.width <= view.w + 1, `inside the window horizontally (${JSON.stringify(b)})`);
  assert.ok(b.y + b.height <= a.y + 1 || b.y >= a.y + a.height - 1, 'the popup does not cover its trigger');
  assert.deepEqual(errors, []);
});

test('inside a Dialog the popups open in the dialog (top layer), choose without closing it, and Escape closes the popup first', { skip: unavailable }, async t => {
  const { page, errors } = await open(t);
  await page.getByRole('button', { name: '打开对话框' }).click();
  const dialog = page.locator('dialog[open]');
  await dialog.waitFor();
  const select = dialog.getByRole('combobox', { name: '对话框 Select' });
  await select.click();
  await popup(page).waitFor();
  assert.equal(await popup(page).evaluate(element => !!element.closest('dialog[open]')), true, 'the popup is inside the open dialog');
  await page.getByRole('option', { name: 'Beta' }).click();
  assert.deepEqual((await calls(page)).dialog, ['b']);
  assert.equal(await dialog.count(), 1, 'the dialog stays open');
  await select.click();
  await popup(page).waitFor();
  await page.keyboard.press('Escape');
  await popup(page).waitFor({ state: 'hidden' });
  assert.equal(await dialog.count(), 1, 'Escape closed the popup, not the dialog');
  await focusedOn(select);
  const combo = dialog.getByRole('combobox', { name: '对话框题组' });
  await combo.click();
  await page.getByPlaceholder('搜索').fill('最短');
  await page.getByRole('option', { name: /图与最短路/ }).click();
  assert.deepEqual((await calls(page)).dialog, ['b', 'd4']);
  assert.equal(await dialog.count(), 1);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
});

test('a Select inside a Popover: choosing does not close the popover, and Escape closes the popup before the popover', { skip: unavailable }, async t => {
  const { page, errors } = await open(t);
  await page.getByRole('button', { name: '布局', exact: true }).click();
  const panel = page.locator('.sh-popover');
  await panel.waitFor();
  const select = panel.getByRole('combobox', { name: '布局方向' });
  await select.click();
  await popup(page).waitFor();
  await page.getByRole('option', { name: 'Beta' }).click();
  assert.deepEqual((await calls(page)).popover, ['b']);
  assert.equal(await panel.count(), 1, 'a press inside the select popup is not a press away from the popover');
  await select.click();
  await popup(page).waitFor();
  await page.keyboard.press('Escape');
  await popup(page).waitFor({ state: 'hidden' });
  assert.equal(await panel.count(), 1, 'the first Escape closes the select only');
  await focusedOn(select, 'and gives focus back to its trigger inside the popover');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});

test('the popup animates from the trigger with opacity and a small scale, and not at all under reduced motion', { skip: unavailable }, async t => {
  const { page } = await open(t);
  const tone = page.getByRole('combobox', { name: '讲解口吻' });
  await tone.click();
  await popup(page).waitFor();
  const normal = await popup(page).evaluate(element => { const style = getComputedStyle(element); return { property: style.transitionProperty, duration: style.transitionDuration, origin: style.transformOrigin }; });
  assert.match(normal.property, /opacity/);
  assert.match(normal.property, /transform/);
  assert.notEqual(normal.duration.split(',')[0].trim(), '0s');
  await page.keyboard.press('Escape');
  const reduced = await open(t, { reducedMotion: 'reduce' });
  await reduced.page.getByRole('combobox', { name: '讲解口吻' }).click();
  await popup(reduced.page).waitFor();
  const none = await popup(reduced.page).evaluate(element => getComputedStyle(element).transitionDuration);
  assert.equal(none.split(',')[0].trim(), '0s', 'reduced motion: no transition');
});

// The grouped deck picker (a library of ~60 decks in four courses): headings are labels, titles keep their end, search reads the course, the popup is steady.
const deckPicker = page => page.getByRole('combobox', { name: '补充到现有题组', exact: true });
const optionsOf = page => page.getByRole('option');
const headings = page => page.locator('.sh-pop__group-label').allTextContents();

test('deck picker: decks sit under their course heading (the current course first, 未分类 last); headings are labelled groups, not options; the chosen deck has the check mark', { skip: unavailable }, async t => {
  const { page, errors } = await open(t, { scenario: 'decks', width: 1280 });
  await deckPicker(page).click();
  await popup(page).waitFor();
  await settled(page);
  const found = await headings(page);
  assert.equal(found[0], 'Cloud Native Solution Design', 'the course in focus comes first, with its chapter deck inside it');
  assert.equal(found.at(-1), '未分类');
  assert.equal(found.length, 5, 'one heading per course: a chapter is no group of its own');
  assert.equal(new Set(found).size, 5);
  assert.equal(await optionsOf(page).count(), 60, 'every deck is offered once');
  assert.equal(await page.locator('.sh-pop__group-label[role="option"]').count(), 0, 'a heading is not an option');
  const group = page.getByRole('group', { name: 'Cloud Native Solution Design' });
  assert.equal(await group.count(), 1, 'a heading names its group (role=group, aria-labelledby)');
  assert.ok((await group.getByRole('option').count()) > 10);
  const chosen = page.getByRole('option', { selected: true });
  assert.equal(await chosen.count(), 1);
  assert.equal(await chosen.locator('svg').count(), 1, 'the chosen deck carries the check mark');
  const chapter = page.getByRole('option', { name: /Kubernetes 故障诊断/ });
  assert.match(await chapter.textContent(), /05 Kubernetes · 24 题/, 'the chapter leads the hint');
  const twins = page.getByRole('option', { name: /^解决方案架构导论：概念辨析与情境迁移 \d+ 题/ });
  assert.deepEqual((await twins.allTextContents()).map(text => text.replace(/\s+/g, ' ').trim()), ['解决方案架构导论：概念辨析与情境迁移31 题 · 2026-09-09', '解决方案架构导论：概念辨析与情境迁移30 题 · 2026-09-01'], 'twins are told apart, the newer first');
  const label = await box(page.locator('.sh-pop__group-label').first()), item = await box(optionsOf(page).first());
  assert.ok(item.x > label.x, 'the decks hang under their heading');
  assert.deepEqual(errors, []);
});

test('deck picker: the arrow keys, Home and End walk the decks and skip the headings; Enter chooses; Escape closes without choosing', { skip: unavailable }, async t => {
  const { page, errors } = await open(t, { scenario: 'decks', width: 1280 });
  const trigger = deckPicker(page);
  await trigger.click();
  await popup(page).waitFor();
  await settled(page);
  const highlighted = () => page.locator('[role="option"][data-highlighted]').evaluateAll(nodes => nodes.map(node => node.textContent));
  assert.equal((await highlighted()).length, 1, 'one deck has the highlight');
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('ArrowDown');
    assert.equal((await highlighted()).length, 1, `step ${i}: a deck, never a heading, is highlighted`);
  }
  await page.keyboard.press('End');
  assert.match((await highlighted())[0], /随手记/, 'End goes to the last deck (under 未分类)');
  await page.keyboard.press('Home');
  assert.equal((await highlighted())[0], await optionsOf(page).first().textContent(), 'Home goes to the first deck');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await popup(page).waitFor({ state: 'hidden' });
  assert.equal((await calls(page)).grouped.length, 1);
  await trigger.click();
  await popup(page).waitFor();
  await page.keyboard.press('Escape');
  await popup(page).waitFor({ state: 'hidden' });
  await focusedOn(trigger, 'Escape returns focus to the trigger');
  assert.equal((await calls(page)).grouped.length, 1, 'Escape chooses nothing');
  assert.deepEqual(errors, []);
});

test('deck picker: search reads the title and the course name; a course name shows its whole group; headings of groups with no match go; nothing found says so; the popup stays put', { skip: unavailable }, async t => {
  const { page, errors } = await open(t, { scenario: 'decks', width: 1280 });
  await deckPicker(page).click();
  await popup(page).waitFor();
  await settled(page);
  const top = Math.round((await box(popup(page))).y);
  await page.keyboard.type('软件工程');
  assert.deepEqual(await headings(page), ['SWE5001 软件工程'], 'typing a course name shows that group, whole, and no other heading');
  assert.equal(await optionsOf(page).count(), 14, 'every deck of the course is there, though no title says its name');
  assert.equal(await page.locator('.sh-pop__group-label mark').first().textContent(), '软件工程', 'the matched part of the course heading is marked');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('软件工程 第一部分');
  assert.deepEqual(await headings(page), ['SWE5001 软件工程'], 'a course word and a title word combine; the other headings are gone');
  assert.equal(await optionsOf(page).count(), 14, 'the course word and the title word are both found in those decks');
  assert.equal(Math.round((await box(popup(page))).y), top, 'the popup does not jump when the filter changes');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('随手');
  assert.deepEqual(await headings(page), ['未分类']);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('量子力学');
  assert.equal(await optionsOf(page).count(), 0);
  assert.equal(await page.locator('.sh-pop__group-label').count(), 0);
  assert.match(await page.locator('.sh-combobox__empty').textContent(), /没有叫「量子力学」的题组/);
  assert.equal(Math.round((await box(popup(page))).y), top);
  assert.deepEqual(errors, []);
});

for (const width of [1280, 420]) {
  test(`deck picker at ${width}px: long titles take at most two lines and stay different, nothing overflows sideways, a long list scrolls inside the popup`, { skip: unavailable }, async t => {
    const { page, errors } = await open(t, { scenario: 'decks', width, height: 800 });
    await deckPicker(page).click();
    await popup(page).waitFor();
    await settled(page);
    const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, scroll: document.documentElement.scrollWidth }));
    const pop = await box(popup(page));
    assert.ok(pop.x >= 0 && pop.x + pop.width <= view.w + 1, `inside the window (${JSON.stringify(pop)})`);
    assert.ok(view.scroll <= view.w, 'the page does not scroll sideways');
    const metrics = await page.locator('.sh-pop__list').evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight, overflowY: getComputedStyle(element).overflowY, sideways: element.scrollWidth - element.clientWidth }));
    assert.ok(metrics.scroll > metrics.client && metrics.overflowY === 'auto', 'the list scrolls inside the popup');
    assert.ok(metrics.sideways <= 1, 'no sideways scroll in the list');
    assert.ok(pop.height <= 26 * 16 + 2 && pop.height <= view.h, 'the popup keeps its fixed maximum height');
    const shape = await optionsOf(page).nth(1).locator('.sh-opt__label').evaluate(element => { const style = getComputedStyle(element); return { lines: Math.round(element.getBoundingClientRect().height / parseFloat(style.lineHeight)), clamp: style.webkitLineClamp, white: style.whiteSpace }; });
    assert.equal(shape.clamp, '2');
    assert.notEqual(shape.white, 'nowrap');
    assert.ok(shape.lines <= 2, `two lines at most (${shape.lines})`);
    const rows = await optionsOf(page).evaluateAll(nodes => nodes.map(node => `${node.querySelector('.sh-opt__label').textContent}|${node.querySelector('.sh-opt__hint')?.textContent ?? ''}`));
    assert.equal(new Set(rows).size, rows.length, 'no two rows are the same text');
    if (process.env.DECK_PICKER_SHOTS) await page.screenshot({ path: `${process.env.DECK_PICKER_SHOTS}/deck-picker-${width}.png` });
    assert.deepEqual(errors, []);
  });
}
