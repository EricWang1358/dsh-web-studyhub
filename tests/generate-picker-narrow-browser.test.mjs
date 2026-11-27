/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { frames } from '../scripts/qa/layout-late.mjs';
import { generateMarginFixture, cutsOf, factsGeometry, factsLines, leadProblems, allCourses, boxNames } from './helpers/generate-margin.mjs';

const { state, openGenerate, answers } = generateMarginFixture('long');

/* Round 10 (#1084, rv26): at 320–420 a 全部课程 row read 「Text · … · 示例课…」: two cut pieces, the first ending on its own 「·」, and at 420 a size was cut inside
   its figure (「1,12…」). Each piece now shows whole parts: a cut ends after a whole part, and a row has at most one cut piece. */
test('#1084 round 10: at 320–420, in the scope and in 全部课程, a row has at most one cut piece, a cut ends after a whole part (never on 「·」 or a figure), and the line never starts with 「·」', { timeout: 900000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const on of [state.server, state.longServer]) for (const lang of ['en', 'zh']) for (const width of [320, 360, 375, 390, 420]) {
    const { page, errors, context } = await openGenerate({ lang, width, answer: answers().badges, on });
    for (const all of [false, true]) {
      const tag = `${on === state.server ? 'notes' : 'long'} ${lang} ${width}${all ? ' 全部课程' : ''}`;
      if (all) await allCourses(page, lang);
      await frames(page, 4);
      const rows = await factsLines(page), names = await boxNames(page, 3);
      assert.ok(rows.length >= 10, `${tag}: rows (${rows.length})`);
      const bad = [];
      for (const row of rows) {
        const cuts = cutsOf(row);
        if (cuts.length > 1) bad.push(`two cut pieces: ${row.text}`);
        for (const piece of cuts) {
          if (/(·\s*|\d)$/.test(piece.seen)) bad.push(`cut on 「·」 or a figure: ${row.text}`);
          if (piece.seen.replace(/^·\s*/, '').trim().length < 2) bad.push(`a cut piece shows almost nothing: ${row.text}`);
        }
        if (row.start === '·') bad.push(`starts with 「·」: ${row.text}`);
        // #1133: a note is cut where the notes' box ends before it does (its own box is whole): judged by the right edges
        if (row.pieces.some(piece => piece.note && piece.shown && (piece.cut || piece.clipped))) bad.push(`a note is cut: ${row.text}`);
        if (row.pieces.some(piece => piece.shown && piece.clipped)) bad.push(`a piece is drawn past its box: ${row.text}`);
        if (all && !row.names[0]?.shown) bad.push(`no course in 全部课程: ${row.text}`);
      }
      // #1134, #1135: every row says its format whole (全部课程 too), and its size whole or not at all, by one rule for its kind. 全部课程 says the course
      // alone only where the format would leave it less than 6em (a long format at 320): never above 320
      const decided = await page.evaluate(() => document.querySelector('[data-tour="generate-sources"] .source-picker').dataset.names);
      if (!(all && decided === 'alone')) bad.push(...leadProblems(rows));
      else if (width > 320) bad.push(`全部课程 says the course alone at ${width}`);
      if (bad.length) t.diagnostic(JSON.stringify(await factsGeometry(page)));
      assert.deepEqual(bad, [], `${tag}: ${rows.map(row => row.title + ': ' + row.text).join(' | ')}`);
      // what a row leaves out is still in its checkbox's name: the format, size and notes whole, and every course
      rows.slice(0, 3).forEach((row, at) => assert.ok(names[at]?.includes(row.pieces.map(piece => piece.text).join(' ')), `${tag}: the checkbox's name has every fact ("${names[at]}")`));
      t.diagnostic(`${tag}: data-names=${await page.evaluate(() => document.querySelector('[data-tour="generate-sources"] .source-picker').dataset.names)}: ${rows.slice(0, 2).concat(rows.slice(-1)).map(row => row.text).join(' | ')}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});
