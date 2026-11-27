/* global document, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { frames, until } from '../scripts/qa/layout-late.mjs';
import { generateMarginFixture, LONG, boxNames } from './helpers/generate-margin.mjs';

const { state, openGenerate, answers } = generateMarginFixture('kinds');

/* Round 14 review (rv33): at 1440 the focus ring of 选择页面 (2px at 2px, and a 3px shadow) and its hover fill reached into the 已索引 pill under it on a row
   whose title is one line: the button's box ended where the facts line starts. The button stays at least 24px tall, its words on the title line's middle,
   and neither its box nor its focus ring ever reaches the pill. */
test('round 14: 选择页面\'s box, hover fill and focus ring stay off the 已索引 pill under it (900/1440, zh/en, light/dark)', { timeout: 600000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  const measure = page => page.evaluate(() => {
    const active = document.activeElement;
    return [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].filter(item => item.querySelector('.source-picker__expand')).map(item => {
      const button = item.querySelector('.source-picker__expand'), box = button.getBoundingClientRect(), style = getComputedStyle(button);
      // the title's lines (a grid item is one box: its words' boxes give its lines)
      const title = item.querySelector('strong'), range = document.createRange();
      range.selectNodeContents(title);
      const boxes = [...range.getClientRects()].filter(rect => rect.width > 0), line = boxes[0], lines = new Set(boxes.map(rect => Math.round(rect.top)));
      const facts = item.querySelector('.source-picker__facts').getBoundingClientRect();
      const pill = item.querySelector('[data-index-slot] [data-state]')?.getBoundingClientRect() ?? null;
      const words = document.createRange();
      words.selectNodeContents(button.firstChild?.nodeType === 3 ? button.firstChild : button);
      const text = words.getBoundingClientRect();
      // how far past its box the button draws: the outline (width + offset) and every outer shadow (spread + blur + offset)
      const outline = style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      const shadows = style.boxShadow === 'none' ? [] : style.boxShadow.split(/,(?![^(]*\))/).filter(shadow => !/inset/.test(shadow)).map(shadow => {
        const [x = 0, y = 0, blur = 0, spread = 0] = (shadow.replace(/(rgba?|color-mix|oklch|color)\([^)]*\)/g, '').match(/-?[\d.]+px/g) || []).map(parseFloat);
        return spread + blur + Math.max(Math.abs(x), Math.abs(y));
      });
      return { title: title.textContent, oneLine: lines.size === 1, focused: active === button, height: box.height, bottom: box.bottom, reach: Math.max(0, outline, ...shadows),
        textMiddle: (text.top + text.bottom) / 2, lineMiddle: (line.top + line.bottom) / 2, pillTop: pill?.top ?? null, facts: facts.width };
    });
  });
  for (const [lang, width, theme] of [['zh', 1440, 'light'], ['en', 1440, 'dark'], ['en', 900, 'light'], ['zh', 900, 'dark']]) {
    const tag = `${lang} ${width} ${theme}`;
    const { page, errors, context } = await openGenerate({ lang, theme, width, height: 900, answer: answers().badges });
    await until(async () => (await page.locator('[data-tour="generate-sources"] [data-index-slot] [data-state]').count()) >= 5, `${tag}: the badges`);
    await frames(page, 4);
    const bad = [];
    const rows = await measure(page);
    assert.ok(rows.some(row => row.oneLine), `${tag}: a row with 选择页面 and a one-line title`);
    const lines = await page.evaluate(() => [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__facts')].map(facts => facts.getBoundingClientRect().width));
    if (Math.max(...lines) - Math.min(...lines) > 0.5) bad.push(`the facts lines differ: ${Math.min(...lines)}–${Math.max(...lines)} px`);
    for (const [at, row] of rows.entries()) {
      if (row.height < 24 - 0.01) bad.push(`${row.title}: 选择页面 is ${row.height} px tall`);
      if (Math.abs(row.textMiddle - row.lineMiddle) > 1) bad.push(`${row.title}: its words are ${row.textMiddle - row.lineMiddle} px off the title line's middle`);
      if (row.pillTop !== null && row.bottom > row.pillTop + 0.01) bad.push(`${row.title}: its box (the hover fill) ends ${row.bottom - row.pillTop} px into the pill`);
      // the keyboard's focus ring, and the pointer's hover
      const item = page.locator('[data-tour="generate-sources"] .source-picker__item').filter({ has: page.locator('.source-picker__expand') }).nth(at);
      await item.locator('input[type="checkbox"]').focus();
      await page.keyboard.press('Tab');
      await frames(page, 2);
      await page.waitForTimeout(250);
      const focused = (await measure(page))[at];
      if (!focused.focused) bad.push(`${row.title}: Tab did not reach 选择页面`);
      else if (focused.pillTop !== null && focused.bottom + focused.reach > focused.pillTop + 0.01) bad.push(`${row.title}: its focus ring reaches ${focused.bottom + focused.reach - focused.pillTop} px into the pill`);
      await page.evaluate(() => document.activeElement?.blur());
      await item.locator('.source-picker__expand').hover();
      await page.waitForTimeout(250);
      const hovered = (await measure(page))[at];
      if (hovered.pillTop !== null && hovered.bottom + hovered.reach > hovered.pillTop + 0.01) bad.push(`${row.title}: hovered, it reaches ${hovered.bottom + hovered.reach - hovered.pillTop} px into the pill`);
      await page.mouse.move(1, 1);
    }
    assert.deepEqual(bad, [], tag);
    t.diagnostic(`${tag}: ${rows.map(row => `${row.title.slice(0, 6)} ${row.height.toFixed(1)}px, ${row.pillTop === null ? 'no pill' : `${(row.pillTop - row.bottom).toFixed(1)}px to the pill`}`).join(' | ')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* Round 14 review (rv33): the whole course reached the checkbox's name through an aria-label on a plain span, which ARIA 1.2 prohibits. The name is the
   same without it: the course as written, once, with no space put into it at a word box's edge. */
test('round 14: no span in the list carries an aria-label, and the checkbox\'s name still says the long course as written', { timeout: 300000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const [lang, width] of [['en', 420], ['zh', 1440]]) {
    const { page, errors, context } = await openGenerate({ lang, width, height: 900, answer: answers().badges });
    await frames(page, 4);
    assert.equal(await page.locator('[data-tour="generate-sources"] span[aria-label]').count(), 0, `${lang} ${width}: an aria-label on a span`);
    const names = await boxNames(page, 6), long = names.filter(name => name.includes(LONG));
    assert.ok(long.length >= 3, `${lang} ${width}: the long course as written (${names[2]})`);
    for (const name of long) {
      assert.equal(name.split(LONG).length, 2, `${lang} ${width}: said once: ${name}`);
      assert.doesNotMatch(name, /\s{2}|协议 （/, `${lang} ${width}: no space put into it: ${name}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});
