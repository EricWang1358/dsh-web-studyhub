/* global document, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { frames, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { generateMarginFixture } from './helpers/generate-margin.mjs';

const { state, openGenerate } = generateMarginFixture();

/** 更多选项's summary: its height, the words it shows (hidden ones left out) and the first character of each line they take. */
const foldSummary = page => page.evaluate(() => {
  const summary = document.querySelector('.generate-more > summary'), meta = summary.querySelector('.sh-disclosure__meta');
  const shown = node => { for (let element = node.parentElement; element && element !== summary; element = element.parentElement) { const style = getComputedStyle(element); if (style.visibility === 'hidden' || style.display === 'none') return false; } return true; };
  const words = [], starts = [];
  if (meta) {
    const walker = document.createTreeWalker(meta, 4);
    let lineTop = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!shown(node)) continue;
      words.push(node.data);
      for (let at = 0; at < node.data.length; at++) {
        if (/\s/.test(node.data[at])) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        const rect = [...range.getClientRects()].find(r => r.width > 0);
        if (!rect) continue;
        if (lineTop === null || Math.abs(rect.top - lineTop) > 2) { starts.push(node.data[at]); lineTop = rect.top; }
      }
    }
  }
  return { height: summary.getBoundingClientRect().height, text: words.join('').replace(/\s+/g, ' ').trim(), starts };
});

/** The room between 更多选项's summary and its first group's title (「出题方式与题量」): the summary's own band, which a hidden line must not widen. */
const bandUnderSummary = page => page.evaluate(() => {
  const summary = document.querySelector('.generate-more > summary').getBoundingClientRect(), title = document.querySelector('.generate-more .generate-group__title').getBoundingClientRect();
  return { summary: summary.height, band: title.top - summary.bottom };
});

test('#1082: 更多选项 open says its hint on one line whatever is chosen (no empty band under it), shut says the chosen pieces, and no line of pieces starts with 「·」', { timeout: 600000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  const hints = { en: 'Count, focus, difficulty, cost, extras', zh: '题量、想练什么、难度、花费、额外要求' };
  for (const [lang, width] of [['en', 420], ['en', 320], ['zh', 420], ['zh', 320]]) {
    const tag = `${lang} ${width}`;
    const { page, errors, context } = await openGenerate({ lang, width });
    const fold = page.locator('.generate-more').first(), summary = fold.locator(':scope > summary');
    if (await fold.evaluate(element => element.open)) { await summary.click(); await until(() => fold.evaluate(element => !element.open), `${tag}: shut`); }
    await settleAnimations(page);
    const shutPlain = await foldSummary(page);
    await summary.click();
    await settleAnimations(page);
    const openPlain = await foldSummary(page), bandPlain = await bandUnderSummary(page);
    assert.ok(Math.abs(openPlain.height - shutPlain.height) <= 0.5, `${tag}: with nothing chosen, open ${openPlain.height} = shut ${shutPlain.height}`);
    for (const [name, at] of [['difficulty', 3], ['language', lang === 'en' ? 0 : 1], ['notation', 2]]) {
      await page.locator(`[data-tour="generate-${name}"] button`).nth(at).click();
      await frames(page, 4);
      const now = await foldSummary(page), band = await bandUnderSummary(page);
      assert.ok(now.text.includes(hints[lang].slice(0, 8)), `${tag}: open, after picking ${name}, the summary says its hint ("${now.text}")`);
      // the open summary is the hint's one line: what is chosen (hidden while open) adds no empty band above the first group
      assert.ok(Math.abs(now.height - openPlain.height) <= 0.5, `${tag}: open, after picking ${name}, the summary is as tall as with nothing chosen (${now.height} vs ${openPlain.height})`);
      assert.ok(Math.abs(band.band - bandPlain.band) <= 0.5, `${tag}: open, after picking ${name}, the room under the summary is unchanged (${band.band} vs ${bandPlain.band})`);
    }
    await summary.click();
    await until(() => fold.evaluate(element => !element.open), `${tag}: shut`);
    await settleAnimations(page);
    const shutPicked = await foldSummary(page);
    assert.ok(!shutPicked.text.includes(hints[lang].slice(0, 8)), `${tag}: shut, the summary says the chosen pieces, not the hint ("${shutPicked.text}")`);
    assert.equal(shutPicked.text.split('·').filter(piece => piece.trim()).length, 3, `${tag}: shut, three pieces ("${shutPicked.text}")`);
    assert.deepEqual(shutPicked.starts.filter(start => start === '·'), [], `${tag}: no line starts with 「·」 (${shutPicked.starts.join('')}: "${shutPicked.text}")`);
    await summary.click();
    await settleAnimations(page);
    const reopened = await foldSummary(page);
    assert.ok(Math.abs(reopened.height - openPlain.height) <= 0.5, `${tag}: reopened ${reopened.height} = open with nothing chosen ${openPlain.height}`);
    assert.ok(reopened.text.includes(hints[lang].slice(0, 8)), `${tag}: reopened, the hint ("${reopened.text}")`);
    t.diagnostic(`${tag}: plain ${shutPlain.height}/${openPlain.height}, chosen shut ${shutPicked.height} / open ${reopened.height}: "${shutPicked.text}"`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1082: at 320 the form fits its column, zh and en, and no summary in it is cut bare', { timeout: 300000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['en', 'zh']) {
    const { page, errors, context } = await openGenerate({ lang, width: 320 });
    const fold = page.locator('.generate-more').first();
    if (!await fold.evaluate(element => element.open)) await fold.locator(':scope > summary').click();
    await settleAnimations(page);
    const fit = await page.evaluate(() => {
      const form = document.querySelector('[data-tour="generate-options"]'), column = form.getBoundingClientRect();
      const past = [...form.querySelectorAll('*')].filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.right > column.right + 0.5; })
        .map(element => `${element.className || element.tagName}: ${Math.round(element.getBoundingClientRect().right - column.right)}px`);
      const bare = [...form.querySelectorAll('summary, summary *')].filter(element => element.getBoundingClientRect().width > 0 && element.scrollWidth > element.clientWidth + 0.5
        && getComputedStyle(element).overflow !== 'visible' && getComputedStyle(element).textOverflow !== 'ellipsis').map(element => element.textContent.slice(0, 30));
      const tall = [...form.querySelectorAll('.generate-more__body .sh-disclosure__meta')].filter(meta => meta.getBoundingClientRect().height > parseFloat(getComputedStyle(meta).lineHeight) * 1.5).map(meta => meta.textContent);
      return { past, bare, tall };
    });
    assert.deepEqual(fit.past, [], `${lang} 320: nothing is drawn past the column`);
    assert.deepEqual(fit.bare, [], `${lang} 320: no summary is cut without 「…」`);
    assert.deepEqual(fit.tall, [], `${lang} 320: a folded row's note is one line`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1082: at 320 and 360, with nothing ticked, the bar says why whole, and keeps one height for 0, 1 and 5 ticked', { timeout: 300000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['en', 'zh']) for (const width of [320, 360]) {
    const tag = `${lang} ${width}`;
    const { page, errors, context } = await openGenerate({ lang, width });
    const clear = page.locator('[data-tour="generate-sources"] .source-picker__actions button').nth(1);
    if (await clear.count()) await clear.click();
    await until(async () => (await page.locator('[data-generate-bar] .generate-submit__note').count()) === 1, `${tag}: the reason`);
    await frames(page, 3);
    const bar = () => page.evaluate(() => document.querySelector('[data-generate-bar]').getBoundingClientRect().height);
    const reason = await page.evaluate(() => { const note = document.querySelector('[data-generate-bar] .generate-submit__note'); return { text: note.textContent, cut: note.scrollWidth > note.clientWidth + 0.5 || note.scrollHeight > note.clientHeight + 0.5 }; });
    assert.ok(reason.text.length > 4, `${tag}: a reason (${reason.text})`);
    assert.equal(reason.cut, false, `${tag}: the reason is said whole ("${reason.text}")`);
    const heights = [await bar()];
    const boxes = page.locator('[data-tour="generate-sources"] .source-picker__item input[type="checkbox"]');
    await boxes.nth(0).check();
    await until(async () => (await page.locator('[data-generate-bar] .generate-summary').count()) === 1, `${tag}: one ticked`);
    await frames(page, 3);
    heights.push(await bar());
    for (let at = 1; at < 5; at++) await boxes.nth(at).check();
    await frames(page, 3);
    heights.push(await bar());
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 0.5, `${tag}: one bar height for 0, 1 and 5 ticked (${heights.join(', ')})`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1082: the estimate under 帮我想想 is as tall while it is coming as when it is in, so the controls under it in 更多选项 do not move when it lands', { timeout: 300000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const [lang, width] of [['en', 320], ['en', 420], ['zh', 320], ['zh', 420], ['en', 1440]]) {
    const tag = `${lang} ${width}`;
    const { page, errors, context } = await openGenerate({ lang, width, height: 1400 });
    let release; const held = new Promise(done => { release = done; });
    await page.route('**/api/call', async route => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* not JSON */ }
      if (body.action === 'usage.estimate' && JSON.stringify(body).includes('"suggest"')) await held;
      return route.fallback();
    });
    // the page again, with the estimate held: it is coming for the first time, as on a fresh visit
    await page.reload();
    await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
    await (await revealNavRow(page, 'generate')).dispatchEvent('click');
    await page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });
    const fold = page.locator('.generate-more').first();
    if (!await fold.evaluate(element => element.open)) await fold.locator(':scope > summary').click();
    const estimate = page.locator('.generate-more__body [data-token-estimate]').first();
    await until(async () => (await estimate.getAttribute('data-status')) === 'loading', `${tag}: the estimate is coming`);
    await frames(page, 3);
    const read = () => page.evaluate(() => ({ box: document.querySelector('.generate-more__body [data-token-estimate]').getBoundingClientRect().height,
      control: document.querySelector('[data-tour="generate-difficulty"] button').getBoundingClientRect().top }));
    const coming = await read();
    release();
    await until(async () => (await estimate.getAttribute('data-status')) === 'ready', `${tag}: the estimate is in`);
    await frames(page, 3);
    const landed = await read();
    t.diagnostic(`${tag}: estimate ${coming.box} → ${landed.box}`);
    assert.ok(Math.abs(landed.box - coming.box) <= 0.5, `${tag}: the estimate keeps its height when it lands (${coming.box} → ${landed.box})`);
    assert.ok(Math.abs(landed.control - coming.control) <= 0.5, `${tag}: 难度 stays where it is (${coming.control} → ${landed.control})`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1082: at 1440 with nothing ticked, the bar\'s reason is level with the button', { timeout: 300000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['zh', 'en']) {
    const { page, errors, context } = await openGenerate({ lang, width: 1440, height: 900 });
    const clear = page.locator('[data-tour="generate-sources"] .source-picker__actions button').nth(1);
    if (await clear.count()) await clear.click();
    await until(async () => (await page.locator('[data-generate-bar] .generate-submit__note').count()) === 1, `${lang}: the reason`);
    await frames(page, 3);
    const level = await page.evaluate(() => {
      const note = document.querySelector('[data-generate-bar] .generate-submit__note'), button = document.querySelector('[data-generate-bar] [data-tour="generate-submit"]');
      const range = document.createRange();
      range.selectNodeContents(note);
      const lines = [...range.getClientRects()].filter(r => r.width > 0.5), top = Math.min(...lines.map(r => r.top)), bottom = Math.max(...lines.map(r => r.bottom)), box = button.getBoundingClientRect();
      return (top + bottom) / 2 - (box.top + box.height / 2);
    });
    assert.ok(Math.abs(level) <= 1, `${lang} 1440: the reason's middle is level with the button's (${level.toFixed(1)}px)`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1082: 题型\'s label is level with its row of boxes at 1440', { timeout: 300000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['en', 'zh']) {
    const { page, errors, context } = await openGenerate({ lang, width: 1440, height: 900 });
    const level = await page.evaluate(() => {
      const row = document.querySelector('[data-tour="generate-kinds"]'), label = row.querySelector('.generate-row__label'), first = row.querySelector('.generate-kind').firstElementChild;
      const range = document.createRange();
      range.selectNodeContents(label);
      const text = range.getClientRects()[0], box = first.getBoundingClientRect();
      return (text.top + text.height / 2) - (box.top + box.height / 2);
    });
    assert.ok(Math.abs(level) <= 1, `${lang} 1440: the label's middle is level with the first box's (${level.toFixed(1)}px)`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
