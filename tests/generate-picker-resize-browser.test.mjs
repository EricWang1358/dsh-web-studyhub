import test from 'node:test';
import assert from 'node:assert/strict';
import { frames } from '../scripts/qa/layout-late.mjs';
import { generateMarginFixture, factsLines, leadProblems, allCourses, everyRow } from './helpers/generate-margin.mjs';

const { state, openGenerate, answers } = generateMarginFixture('kinds');

/* Round 11 (rv30): en 375–420 全部课程, one Markdown note without room for its characters took them from all eleven Text notes; en 320 in the scope no note
   said a size (「Text」 beside 「PDF · 4 pages」). The characters are decided for the rows of a kind, and said in their short words where the long ones
   have no room; the rows of a kind still read alike, and a size is said whole or not at all. Round 14 (rv33): in 全部课程 a note has room for its
   characters only beside its whole course (en 400–420 and zh 375 now say 「Text · 示例课程 · 设计模式」), so there the Text notes say them from en 432 and
   zh 404 on, while the Markdown note still has no room for its own. */
test('round 11: a kind of note that has room for its characters says them, whatever another kind has room for (en/zh 320 scope, en 440–460 and zh 420 全部课程)', { timeout: 600000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const [lang, width, everyCourse] of [['en', 320, false], ['zh', 320, false], ['en', 440, true], ['en', 460, true], ['zh', 420, true]]) {
    const tag = `${lang} ${width}${everyCourse ? ' 全部课程' : ''}`;
    const { page, errors, context } = await openGenerate({ lang, width, height: 900, answer: answers().badges });
    if (everyCourse) await allCourses(page, lang);
    await frames(page, 4);
    const rows = [...(await everyRow(page)).values()];
    assert.ok(rows.length >= 14, `${tag}: every row was drawn (${rows.length})`);
    const notes = rows.filter(row => /^(Text|文本) · /.test(row.lead.text));
    assert.ok(notes.length >= 10, `${tag}: the Text notes (${notes.length})`);
    const bare = notes.filter(row => !/ · \d[\d,]* ?(characters?|字符|chars?|字)$/.test(row.lead.seen.trim()));
    assert.deepEqual(bare.map(row => `${row.title}: ${row.text}`), [], `${tag}: every Text note says its characters`);
    assert.deepEqual(leadProblems(rows), [], `${tag}: ${rows.slice(0, 3).map(row => row.text).join(' | ')}`);
    if (everyCourse) assert.deepEqual(rows.filter(row => !row.names[0]?.shown).map(row => row.text), [], `${tag}: every row says its course`);
    t.diagnostic(`${tag}: ${rows.slice(0, 3).map(row => row.text).join(' | ')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

/* Round 11 (rv30): at 532–540 px (en) 选择页面 moved up onto the title line, a PDF row's facts line lost its width (327 → 274 px) and the list said less
   while the window grew (first/all → first/unpaged → first/all). The facts line of a row with 选择页面 is now the line of a row without, at every width,
   so a wider window never says less. */
test('round 11: a row with 选择页面 has the facts line of a row without on each side of 532 px, so dragging the window wider never says less', { timeout: 600000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['en', 'zh']) for (const everyCourse of [false, true]) {
    const tag = `${lang}${everyCourse ? ' 全部课程' : ''}`;
    const { page, errors, context } = await openGenerate({ lang, width: 500, height: 900, answer: answers().badges });
    if (everyCourse) await allCourses(page, lang);
    let before = null;
    const bad = [];
    for (let width = 500; width <= 600; width += 2) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page, 2);
      const rows = await factsLines(page);
      const lines = rows.map(row => row.line), wide = rows.filter(row => row.wide), plain = rows.filter(row => !row.wide);
      if (wide.length && plain.length && Math.max(...lines) - Math.min(...lines) > 0.5) bad.push(`${width}: a row with 选择页面 has ${Math.round(wide[0].line)} px, one without ${Math.round(plain[0].line)} px`);
      // what each row says: its names, then the parts of its lead (the format, the pages, the characters)
      const said = new Map(rows.map(row => [row.title, [row.names.filter(name => name.shown).length, row.lead.seen.trim().split(' · ').length]]));
      if (before && Math.min(...lines) >= before.line - 0.5) {
        for (const [title, [names, lead]] of said) {
          const [wereNames, wereLead] = before.said.get(title) || [0, 0];
          if (names < wereNames || (names === wereNames && lead < wereLead)) bad.push(`${before.width} → ${width}: ${title} says less`);
        }
      }
      before = { width, line: Math.min(...lines), said };
    }
    assert.deepEqual(bad, [], tag);
    t.diagnostic(`${tag}: ${(await factsLines(page)).slice(2, 4).map(row => row.text).join(' | ')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
