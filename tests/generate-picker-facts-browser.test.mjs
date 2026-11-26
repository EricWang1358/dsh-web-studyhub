/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { frames, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { generateMarginFixture, COURSE, LONG, factsLines, allCourses } from './helpers/generate-margin.mjs';

const { state, openGenerate, answers } = generateMarginFixture();

test('#1084: the badge\'s card counts one page in the singular (en)', { timeout: 300000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  const { page, errors, context } = await openGenerate({ lang: 'en', width: 1440, height: 900, answer: answers().badges });
  await until(async () => (await page.locator('[data-tour="generate-sources"] [data-index-slot] [data-state]').count()) >= 5, 'the badges');
  const cards = await page.evaluate(() => [...document.querySelectorAll('[data-tour="generate-sources"] [data-index-slot] [role="tooltip"]')].map(tip => tip.textContent));
  assert.ok(cards.length >= 5, `cards (${cards.length})`);
  const plural = cards.filter(text => /\b1 pages\b/.test(text));
  assert.deepEqual(plural, [], `no card says "1 pages"`);
  assert.ok(cards.some(text => /\b1 page\b/.test(text)), `a one-page note says "1 page" (${cards[0]})`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('#1084: a row\'s facts never end in a bare 「· …」 at 420: a name is said whole or left out whole, while the index answer is coming and after it', { timeout: 300000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  const check = async (page, lang, stage) => {
    const tag = `${lang} 420, ${stage}`;
    // Each cut course acquires its hover anchor when the shared ResizeObserver measures its text.
    const rows = await until(async () => {
      const current = await factsLines(page);
      const shortened = current.flatMap(row => row.names.filter(name => name.shown && name.cut));
      if (current.length < 10 || (lang === 'zh' && !shortened.length)) return null;
      return shortened.every(name => name.tip !== null) ? current : null;
    }, `${tag}: each cut course to have its tooltip`, { timeoutMs: 10000 });
    // A linked tooltip must contain the complete course, including words beyond the ellipsis.
    assert.deepEqual(rows.filter(row => row.names.some(name => name.shown && name.cut && name.tip !== name.text.replace(/^·\s*/, ''))).map(row => row.text), [], `${tag}: no name is cut bare`);
    assert.deepEqual(rows.filter(row => /·\s*…?$/.test(row.text)).map(row => row.text), [], `${tag}: no line ends in 「·」 or 「· …」`);
  };
  for (const lang of ['zh', 'en']) {
    const { page, errors, context, release } = await openGenerate({ lang, width: 420, now: false });
    await check(page, lang, 'while the answer is coming');
    if (lang === 'zh') {
      // This scope shows the shortened second course. A pointer can read it before the index request returns.
      const name = page.locator('.source-picker__fact-anchor > [data-name="first"]').first();
      await name.hover();
      const opened = page.locator('.source-picker__fact-anchor [role="tooltip"]:popover-open');
      await opened.waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await opened.innerText(), LONG);
      await page.mouse.move(0, 0);
    }
    release();
    await until(async () => await page.locator('[data-tour="generate-sources"] [data-index-slot="held"]').count() === 0, `${lang}: index answer applied`);
    await check(page, lang, 'answered');
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084 round 8: in 全部课程 the first course takes the room: no later name while it is cut, and a cut never ends on its own 「·」', { timeout: 300000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['zh', 'en']) for (const width of [420, 900, 1440]) {
    const tag = `${lang} ${width} 全部课程`;
    const { page, errors, context } = await openGenerate({ lang, width, answer: answers().badges });
    await allCourses(page, lang);
    const rows = await factsLines(page);
    assert.ok(rows.length >= 10, `${tag}: rows (${rows.length})`);
    for (const row of rows) {
      const [first, ...later] = row.names;
      assert.equal(first.text, `· ${COURSE}`, `${tag}: the course comes first (${row.title})`);
      if (first.shown && first.cut) {
        assert.deepEqual(later.filter(name => name.shown).map(name => name.text), [], `${tag}: no later name while the first is cut (${row.text})`);
        assert.ok(!/·\s*$/.test(first.seen) && first.seen.replace(/^·\s*/, '').length >= 2, `${tag}: the cut shows some of the name and does not end on its own 「·」 (${row.text})`);
      }
    }
    t.diagnostic(`${tag}: ${rows.slice(0, 3).map(row => row.text).join(' | ')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084: one rule for the courses, and a run of rows reads the same: the course 课程范围 names is not said again; another course is said first, whole or shortened, on every row that has one or on none', { timeout: 600000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['zh', 'en']) for (const width of [420, 900, 1440]) for (const all of [false, true]) {
    const tag = `${lang} ${width}${all ? ' 全部课程' : ''}`;
    const { page, errors, context } = await openGenerate({ lang, width, answer: answers().badges });
    if (all) await allCourses(page, lang);
    await frames(page, 4);
    let rows = await factsLines(page);
    // a cut name's hover card comes with the shared observer's answer (ui/use-cut.js), a few frames later on a busy machine: wait for it, 2 s at most
    const untilTips = Date.now() + 2000;
    while (Date.now() < untilTips && rows.some(row => row.names.some(piece => piece.shown && piece.cut && !piece.tip))) {
      await frames(page, 1);
      rows = await factsLines(page);
    }
    assert.ok(rows.length >= 10, `${tag}: rows (${rows.length})`);
    if (!all) assert.deepEqual(rows.filter(row => row.names.some(name => name.text.replace(/^·\s*/, '') === COURSE)).map(row => row.text), [], `${tag}: no row says the scope's course 「${COURSE}」 again`);
    const firstShown = rows.filter(row => row.names[0]?.shown).length, withLater = rows.filter(row => row.names.length > 1), laterShown = withLater.filter(row => row.names.slice(1).every(name => name.shown)).length;
    t.diagnostic(`${tag}: the first name on ${firstShown}/${rows.length} rows, every later one on ${laterShown}/${withLater.length}: ${rows.slice(0, 3).map(row => row.text).join(' | ')}`);
    for (const row of rows) {
      assert.equal(row.names[0].text, `· ${all ? COURSE : LONG}`, `${tag}: the course outside the scope comes first among the names (${row.text})`);
      for (const name of row.names.filter(piece => piece.shown && piece.cut)) {
        assert.equal(name.tip, name.text.replace(/^·\s*/, ''), `${tag}: a shortened course says its whole name in the shared Tooltip (${row.text})`);
      }
    }
    assert.ok(firstShown === 0 || firstShown === rows.length, `${tag}: the first course is said on every row or on none (${firstShown}/${rows.length}): ${rows.map(row => row.text).join(' | ')}`);
    assert.ok(laterShown === 0 || laterShown === withLater.length, `${tag}: the later names are said on every row or on none (${laterShown}/${withLater.length})`);
    if (width === 1440) assert.ok(rows.every(row => row.names.every(name => name.shown && !name.cut)), `${tag}: with room, every row says its courses whole`);
    if (width === 420 && !all && lang === 'zh') assert.equal(firstShown, rows.length, `${tag}: with room for a shortened course on every row, every row says it`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084 round 8: what a row\'s facts line shows does not change when the index answer lands (a failed one, an empty one)', { timeout: 300000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const [lang, width, outcome] of [['en', 420, 'fail'], ['en', 420, 'no index'], ['zh', 420, 'fail'], ['en', 900, 'fail']]) {
    const tag = `${lang} ${width} ${outcome}`;
    const { page, errors, context, release } = await openGenerate({ lang, width, now: false, answer: outcome === 'fail' ? 'fail' : answers()[outcome] });
    await frames(page, 4);
    const coming = (await factsLines(page)).map(row => row.text);
    release();
    await until(() => page.evaluate(() => !document.querySelector('[data-tour="generate-sources"] [data-index-slot="held"]')), `${tag}: the answer is in`);
    await settleAnimations(page);
    await frames(page, 4);
    const landed = (await factsLines(page)).map(row => row.text);
    t.diagnostic(`${tag}: ${coming.slice(0, 3).join(' | ')}`);
    assert.deepEqual(landed, coming, `${tag}: the facts lines read the same before and after the answer`);
    // the failed read is the browser's own console line for the 500 the test answers with
    assert.deepEqual(errors.filter(error => !/status of 500/.test(error)), []);
    await context.close();
  }
});

test('#1084 round 8: a name shown whole has no hover card (1440)', { timeout: 300000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['zh', 'en']) {
    const { page, errors, context } = await openGenerate({ lang, width: 1440, height: 900, answer: answers().badges });
    const rows = await factsLines(page);
    const worded = rows.flatMap(row => row.names.filter(name => name.shown && !name.cut && name.tip));
    assert.deepEqual(worded.map(name => name.text), [], `${lang} 1440: no whole name carries hover words`);
    const name = page.locator('[data-tour="generate-sources"] .source-picker__fact--name').first();
    await name.hover();
    await page.waitForTimeout(600);
    const open = await page.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')].filter(tip => { try { return tip.matches(':popover-open') || (!tip.hidden && tip.getBoundingClientRect().height > 0); } catch { return false; } }).map(tip => tip.textContent));
    assert.deepEqual(open, [], `${lang} 1440: hovering a whole name opens no card`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
