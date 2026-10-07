/* global innerWidth, innerHeight, document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { frames, until } from '../scripts/qa/layout-late.mjs';
import { startConsole, startJobs, openConsole } from '../scripts/qa/task-console.mjs';

/* The 即时控制 row of a running question task, with a session whose model id is long and carries a provider prefix (`cn:deepseek-v4.1-flash`, level high), at
   1280, 1024, 768 and 420 px, dark and light, in both languages: every control is inside the row and the window, a label sits over its own select, nothing is cut
   (the four selects say 「跟随当前会话」 / "Follow session" whole, and 模型默认 / 最低 … never end in an ellipsis), the page does not scroll sideways, and the row keeps its
   height when a value is changed. The popup of the follow option says the model and the level in full, inside the window; the closed select's tooltip has the sentence
   on keyboard focus, and says nothing while another level is chosen. */

const ROUTE = { provider: 'cn', model: 'cn:deepseek-v4.1-flash', reasoningEffort: 'high' };
const WORDS = {
  zh: { short: '跟随当前会话', full: '跟随当前会话 · cn:deepseek-v4.1-flash · high', tip: '跟随当前会话：现在是 cn:deepseek-v4.1-flash，推理档位 high。会话换了模型，这里也跟着换。', lowest: '最低' },
  en: { short: 'Follow session', full: 'Follow session · cn:deepseek-v4.1-flash · high', tip: 'Follows the current session: right now cn:deepseek-v4.1-flash, reasoning level high. If the session switches model, this follows it too.', lowest: 'Lowest' },
};
const EFFORTS = ['effortPlanning', 'effortReview', 'effortWriting', 'effortRepair'];
const squash = (text) => text.replace(/\s+/g, ' ').trim();

/** The row, its controls and what could be cut or pushed out, read in the page. */
const readRow = (page) => page.evaluate(() => {
  const box = (element) => { if (!element) return null; const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const row = document.querySelector('.tc-controls__items')?.closest('.tc-controls');
  if (!row) return null;
  const controls = [...row.querySelectorAll('.tc-control')].map((control) => {
    const label = control.querySelector('.tc-control__label'), widget = [...control.children].find((child) => child !== label);
    return { key: control.dataset.control, box: box(control), label: box(label), labelCut: label ? label.scrollWidth > label.clientWidth + 1 : false, widget: box(widget),
      value: control.querySelector('.sh-select__value')?.textContent.trim() ?? null, valueCut: (() => { const v = control.querySelector('.sh-select__value'); return v ? v.scrollWidth > v.clientWidth + 1 : false; })() };
  });
  return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, row: box(row), rowOverflow: row.scrollWidth > row.clientWidth + 1, controls,
    bar: [...row.querySelector('.tc-controls__bar').children].map((child) => ({ cls: child.className, ...box(child) })), status: row.querySelector('.tc-controls__applied').textContent.trim() };
});

const inside = (inner, outer, slack = 0.75) => inner.left >= outer.left - slack && inner.right <= outer.right + slack;

function judge(m, where, words) {
  assert.ok(m.scrollWidth <= m.viewport, `${where}: no sideways scroll (${m.scrollWidth} in ${m.viewport})`);
  assert.equal(m.rowOverflow, false, `${where}: the row has nothing hidden beyond its edge`);
  assert.deepEqual(m.controls.map((control) => control.key), ['concurrency', ...EFFORTS, 'applySuggestions'], `${where}: all the controls are there`);
  for (const control of m.controls) {
    assert.ok(inside(control.box, m.row) && control.box.right <= m.viewport + 0.75 && control.box.left >= -0.75, `${where}: ${control.key} is inside the row and the window (${Math.round(control.box.left)}-${Math.round(control.box.right)} of ${Math.round(m.row.left)}-${Math.round(m.row.right)})`);
    assert.equal(control.labelCut, false, `${where}: the label of ${control.key} is whole`);
    assert.equal(control.valueCut, false, `${where}: what ${control.key} says is whole (${control.value})`);
    if (control.label && control.widget) {
      assert.ok(Math.abs(control.label.left - control.widget.left) <= 1.5 && control.widget.top >= control.label.bottom - 1.5, `${where}: the label of ${control.key} stays over its widget`);
      assert.ok(control.widget.right <= control.box.right + 0.75, `${where}: the widget of ${control.key} stays in its cell`);
    }
  }
  for (const part of m.bar) assert.ok(inside(part, m.row), `${where}: ${part.cls} of the bar is inside the row`);
  const selects = m.controls.filter((control) => EFFORTS.includes(control.key));
  assert.equal(new Set(selects.map((control) => Math.round(control.widget.width))).size, 1, `${where}: the four selects are as wide as each other (${selects.map((control) => Math.round(control.widget.width))})`);
  for (const control of selects) assert.ok(control.widget.width >= 120, `${where}: ${control.key} is wide enough for its words (${Math.round(control.widget.width)}px)`);
  assert.deepEqual(selects.slice(0, 2).map((control) => control.value), [words.short, words.short], `${where}: the two selects that follow the session say it in the short words`);
}

test('the follow-session select reads clearly and the 即时控制 row holds together at every width, in both themes and languages', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-follow-fit-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startConsole({ distDir: dist, route: ROUTE });
  try {
    await startJobs(running);
    for (const [lang, theme] of [['zh', 'dark'], ['en', 'light']]) {
      const words = WORDS[lang];
      for (const width of [1280, 1024, 768, 420]) {
        const where = `${lang} ${theme} ${width}px`;
        const { page, context, errors } = await openConsole(browser, running, { lang, theme, width, height: 900 });
        // the question run is the row that has the four reasoning selects
        await until(async () => (await page.locator('.tc-row').count()) >= 2, 'the jobs in the list');
        for (let index = 0, rows = await page.locator('.tc-row').count(); index < rows && !(await page.locator('[data-control="effortPlanning"]').count()); index++) {
          await page.locator('.tc-row').nth(index).dispatchEvent('click');
          await frames(page, 4);
        }
        await page.locator('[data-control="effortPlanning"] [role="combobox"]').waitFor({ state: 'attached' });
        await frames(page, 6);
        await page.waitForTimeout(500);
        const first = await readRow(page);
        judge(first, where, words);

        // the popup of the follow option: the model and the level in full, wrapped or wide, inside the window, and not cut
        const planning = page.locator('[data-control="effortPlanning"] [role="combobox"]');
        await planning.click();
        await page.locator('.sh-pop__popup:not([data-closed]):not([data-starting-style])').waitFor();
        await page.waitForTimeout(250);
        const popup = await page.evaluate(() => {
          const el = document.querySelector('.sh-pop__popup:not([data-closed])'), r = el.getBoundingClientRect(), option = el.querySelector('.sh-opt'), label = option.querySelector('.sh-opt__label');
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, viewport: innerWidth, height: innerHeight, text: option.textContent.replace(/\s+/g, ' ').trim(), cut: label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1,
            others: [...el.querySelectorAll('.sh-opt')].slice(1).map((o) => ({ text: o.textContent.trim(), cut: o.querySelector('.sh-opt__label').scrollWidth > o.querySelector('.sh-opt__label').clientWidth + 1 })) };
        });
        assert.equal(popup.text, words.full, `${where}: the option says the model and the level in full`);
        assert.equal(popup.cut, false, `${where}: the option is not cut`);
        assert.ok(popup.left >= -0.75 && popup.right <= popup.viewport + 0.75 && popup.top >= -0.75 && popup.bottom <= popup.height + 0.75, `${where}: the popup is inside the window (${Math.round(popup.left)}-${Math.round(popup.right)})`);
        assert.equal(popup.others.length, 6, `${where}: 模型默认 and the five levels`);
        for (const other of popup.others) assert.equal(other.cut, false, `${where}: ${other.text} is whole`);
        assert.equal(await page.locator('.sh-tooltip:popover-open').count(), 0, `${where}: no tooltip over the open popup`);

        // choosing another level: the select says it, the row keeps its height, and the tooltip has nothing to say
        await page.locator('.sh-pop__popup:not([data-closed]) .sh-opt').nth(2).click();
        await until(async () => /→/.test(await page.locator('.tc-controls__applied').first().innerText()), 'the change to be in force');
        await until(async () => (await planning.innerText()).trim() === words.lowest, 'the select to say the level chosen');
        await page.waitForTimeout(400);
        const changed = await readRow(page);
        judge({ ...changed, controls: changed.controls.map((c) => c.key === 'effortPlanning' ? { ...c, value: words.short } : c) }, `${where} after a change`, words);
        assert.equal(changed.controls.find((c) => c.key === 'effortPlanning').value, words.lowest, `${where}: the select says the level chosen`);
        assert.equal(changed.row.height, first.row.height, `${where}: the row keeps its height when a change is applied (${first.row.height} -> ${changed.row.height})`);
        assert.equal(changed.row.top, first.row.top, `${where}: and its place`);
        await planning.focus();
        await page.waitForTimeout(450);
        assert.equal(await page.locator('.sh-tooltip:popover-open').count(), 0, `${where}: no tooltip while a level is chosen`);

        // back to following the session: keyboard focus brings the sentence
        await planning.click();
        await page.locator('.sh-pop__popup:not([data-closed]):not([data-starting-style])').waitFor();
        await page.locator('.sh-pop__popup:not([data-closed]) .sh-opt').nth(0).click();
        await until(async () => (await planning.innerText()).trim() === words.short, 'the select to follow the session again');
        await page.locator('.sh-pop__popup[data-closed]').first().waitFor({ state: 'attached' }).catch(() => {});
        await planning.blur();
        await planning.focus();
        await until(async () => (await page.locator('.sh-tooltip:popover-open').count()) === 1, 'the tooltip on focus');
        const tip = await page.evaluate(() => {
          const el = document.querySelector('.sh-tooltip:popover-open'), r = el.getBoundingClientRect();
          return { text: el.textContent.replace(/\s+/g, ' ').trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom, viewport: innerWidth, height: innerHeight, title: document.querySelector('[data-control="effortPlanning"] [role="combobox"]').hasAttribute('title') };
        });
        assert.equal(tip.text, words.tip, `${where}: the tooltip is the one sentence`);
        assert.equal(tip.title, false, `${where}: a tooltip, not a title attribute`);
        assert.ok(tip.left >= -0.75 && tip.right <= tip.viewport + 0.75 && tip.top >= -0.75 && tip.bottom <= tip.height + 0.75, `${where}: the tooltip is inside the window`);
        await page.keyboard.press('Escape');
        await until(async () => (await page.locator('.sh-tooltip:popover-open').count()) === 0, 'Escape to close the tooltip');

        const last = await readRow(page);
        assert.equal(last.row.height, first.row.height, `${where}: the row ends as tall as it began`);
        assert.deepEqual(errors, [], where);
        await context.close();
      }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

test('出题偏好 in Settings: the same select, the closed one short, the popup whole', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-follow-fit-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startConsole({ distDir: dist, hold: false, route: ROUTE });
  try {
    for (const [lang, width] of [['zh', 1280], ['en', 420]]) {
      const words = WORDS[lang], where = `${lang} ${width}px settings`;
      const { page, context, errors } = await openConsole(browser, running, { lang, theme: 'dark', width, height: 900 });
      await page.locator('[data-tour="nav-settings"]').first().dispatchEvent('click');
      await page.getByText(lang === 'zh' ? '出题偏好' : 'Question defaults').first().dispatchEvent('click');
      const follow = page.locator('[role="combobox"]', { hasText: words.short });
      await follow.first().waitFor({ state: 'attached' });
      assert.equal(await follow.count(), 2, `${where}: the two stages that follow the session say it short`);
      assert.equal(await page.locator('[role="combobox"]', { hasText: 'cn:deepseek' }).count(), 0, `${where}: the model is not on any closed select`);
      const cut = await page.evaluate(() => [...document.querySelectorAll('[role="combobox"] .sh-select__value')].filter((v) => v.scrollWidth > v.clientWidth + 1).map((v) => v.textContent));
      assert.deepEqual(cut, [], `${where}: no closed select is cut`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${where}: no sideways scroll`);
      await follow.first().focus();
      await until(async () => (await page.locator('.sh-tooltip:popover-open').count()) === 1, 'the tooltip on focus');
      assert.equal(squash(await page.locator('.sh-tooltip:popover-open').innerText()), words.tip, `${where}: the same sentence as the row's`);
      await follow.first().click();
      await page.locator('.sh-pop__popup:not([data-closed]):not([data-starting-style])').waitFor();
      await page.waitForTimeout(250);
      const popup = await page.evaluate(() => {
        const el = document.querySelector('.sh-pop__popup:not([data-closed])'), r = el.getBoundingClientRect(), label = el.querySelector('.sh-opt .sh-opt__label');
        return { text: label.textContent.trim(), cut: label.scrollWidth > label.clientWidth + 1, left: r.left, right: r.right, viewport: innerWidth };
      });
      assert.equal(popup.text, words.full, `${where}: the popup says the model and the level in full`);
      assert.equal(popup.cut, false, `${where}: and is not cut`);
      assert.ok(popup.left >= -0.75 && popup.right <= popup.viewport + 0.75, `${where}: inside the window`);
      assert.deepEqual(errors, [], where);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
