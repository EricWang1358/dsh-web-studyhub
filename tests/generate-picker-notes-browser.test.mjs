/* global document, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { frames, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { generateMarginFixture, factsGeometry, leadProblems, allCourses, everyRow } from './helpers/generate-margin.mjs';

const { state, openGenerate, answers } = generateMarginFixture('long');

/* #1132 (round 10 review): at 375–420 the first note of a long-noted row was cut mid-word with no 「…」 (「PDF · 3 pages · 480 characters · littl」,
   「… · 网络 · 文字偏少」): the notes' box clipped it, its own box being whole. A note is said whole or left out of sight, at first paint, when the index
   answer lands late, and after scrolling (#1133: judged by its right edge against the notes' box). */
test('#1132: a row\'s note is said whole or left out of sight at 375–900, in the scope and in 全部课程, before and after a late index answer', { timeout: 900000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['en', 'zh']) for (const width of [375, 420, 900]) for (const all of [false, true]) {
    const tag = `${lang} ${width}${all ? ' 全部课程' : ''}`;
    const { page, errors, context, release } = await openGenerate({ lang, width, height: 900, answer: answers().badges, now: false, on: state.longServer });
    if (all) await allCourses(page, lang);
    await frames(page, 4);
    const coming = await everyRow(page, 34);
    release();
    await until(() => page.evaluate(() => !document.querySelector('[data-tour="generate-sources"] [data-index-slot="held"]')), `${tag}: the answer is in`);
    await settleAnimations(page);
    await frames(page, 4);
    const landed = await everyRow(page, 34);
    assert.ok(landed.size >= 34, `${tag}: every row was drawn (${landed.size})`);
    const bad = [];
    for (const [title, row] of landed) {
      for (const piece of row.pieces.filter(item => item.shown && (item.clipped || (item.note && item.cut)))) bad.push(`${piece.note ? 'a note' : 'a piece'} is cut bare: ${title}: ${row.text} (${piece.text})`);
      if (coming.has(title) && coming.get(title).text !== row.text) bad.push(`${title}: "${coming.get(title).text}" then "${row.text}"`);
    }
    assert.deepEqual(bad, [], tag);
    const noted = [...landed.values()].filter(row => row.pieces.some(piece => piece.note));
    assert.ok(noted.length >= 4, `${tag}: the long-noted rows were drawn (${noted.length})`);
    t.diagnostic(`${tag}: ${noted.at(-1).text} (${noted.filter(row => row.pieces.some(piece => piece.note && piece.shown)).length}/${noted.length} rows say a note)`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* #1134 (round 10 review): in 全部课程 a list where one row had no room for its format, size and course said the course alone on every row: at en 420
   34 rows read 「操作系统」, though 30 short notes had room for 「Text · 180 characters · 操作系统」. Every row now keeps its format; a document with pages says
   its size in pages, so its characters give way first, and a note keeps its characters where every note has room for them. */
/* Round 14 (rv33): a note's characters no longer take the end of its course in 全部课程: at 420 the notes say their format beside their whole course, and
   their characters from where those fit beside it too. */
test('#1134: 全部课程 at 420 keeps every row\'s format, a PDF\'s pages and the whole course, and a note\'s characters from where they fit beside it', { timeout: 600000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['en', 'zh']) {
    const tag = `${lang} 420 全部课程`;
    const { page, errors, context } = await openGenerate({ lang, width: 420, height: 900, answer: answers().badges, on: state.longServer });
    await allCourses(page, lang);
    await frames(page, 4);
    const rows = [...(await everyRow(page, 34)).values()];
    assert.ok(rows.length >= 34, `${tag}: every row was drawn (${rows.length})`);
    const bad = leadProblems(rows);
    for (const row of rows) {
      const paged = /PDF/.test(row.lead.text), want = paged ? /^PDF · 3 (页|pages)/ : /^(Text|文本)( · 180 ?(字符|characters|字|chars))?$/;
      if (!want.test(row.lead.seen.trim())) bad.push(`${paged ? 'no pages' : 'no format'}: ${row.title}: ${row.text}`);
      if (!(row.names[0]?.shown && row.names[0].seen.replace(/^·\s*/, '').length >= 2)) bad.push(`no course: ${row.title}: ${row.text}`);
      else if (!paged && row.names[0].cut) bad.push(`a note cuts its course: ${row.title}: ${row.text}`);
    }
    if (bad.length) t.diagnostic(JSON.stringify(await factsGeometry(page)));
    assert.deepEqual(bad, [], `${tag}: ${rows.map(row => row.title + ': ' + row.text).join(' | ')}`);
    // a little wider, the notes say their characters too, beside their whole course (by 448 px: a looser bound would let a lost size pass)
    let said = 0;
    for (let width = 424; width <= 448 && !said; width += 8) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page, 3);
      const notes = [...(await everyRow(page, 34)).values()].filter(row => !/PDF/.test(row.lead.text));
      if (notes.every(row => /^(Text|文本) · 180 ?(字符|characters|字|chars)$/.test(row.lead.seen.trim()))) {
        said = width;
        assert.deepEqual(notes.filter(row => row.names[0]?.cut).map(row => row.text), [], `${lang} ${width} 全部课程: the course whole beside the characters`);
      }
    }
    assert.ok(said, `${lang} 全部课程: the notes say their characters again by 448 px (they come back at en 432, zh 424: round 15 asked for a bound that pins it)`);
    t.diagnostic(`${lang}: the notes say their characters from ${said} px`);
    t.diagnostic(`${tag}: data-names=${await page.evaluate(() => document.querySelector('[data-tour="generate-sources"] .source-picker').dataset.names)}: ${rows[0].text} | ${rows.at(-1).text}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* #1136 (round 10 review): a course name the list leaves out ('none') that counted as cut still drew the hover card's anchor (0 wide, a column gap on the
   line, never to open): more elements on every such row. A name left out has no anchor: such a row draws as many elements as at 1440. */
test('#1136: a course name left out of the line draws no hover anchor, so its row has the elements it has at 1440', { timeout: 600000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  const count = page => page.evaluate(() => [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].map(item => {
    const hidden = element => { for (let at = element; at && at !== item; at = at.parentElement) if (Number(getComputedStyle(at).opacity) === 0) return true; return false; };
    const anchors = [...item.querySelectorAll('.source-picker__fact-anchor')];
    return { title: item.querySelector('strong').textContent, elements: item.querySelectorAll('*').length, idle: anchors.filter(anchor => hidden(anchor.querySelector('[data-name]') || anchor)).length,
      anchors: anchors.length };
  }));
  for (const [lang, width] of [['en', 320], ['en', 420], ['zh', 320], ['zh', 420]]) {
    const tag = `${lang} ${width}`;
    const { page, errors, context } = await openGenerate({ lang, width, answer: answers().badges });
    await frames(page, 4);
    const narrow = await count(page);
    await page.setViewportSize({ width: 1440, height: 860 });
    await frames(page, 6);
    const wide = new Map((await count(page)).map(row => [row.title, row]));
    assert.ok(narrow.length >= 10, `${tag}: rows (${narrow.length})`);
    assert.deepEqual(narrow.filter(row => row.idle).map(row => `${row.title}: ${row.idle}`), [], `${tag}: no anchor around a name left out`);
    const differ = narrow.filter(row => !row.anchors && wide.has(row.title) && row.elements !== wide.get(row.title).elements);
    assert.deepEqual(differ.map(row => `${row.title}: ${row.elements} at ${width}, ${wide.get(row.title).elements} at 1440`), [], `${tag}: a row without a cut name draws what it draws at 1440`);
    t.diagnostic(`${tag}: data-names=${await page.evaluate(() => document.querySelector('[data-tour="generate-sources"] .source-picker').dataset.names)}, elements ${narrow.slice(0, 3).map(row => row.elements).join('/')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
