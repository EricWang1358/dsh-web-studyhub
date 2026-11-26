import test from 'node:test';
import assert from 'node:assert/strict';
import { frames } from '../scripts/qa/layout-late.mjs';
import { generateMarginFixture, factsLines, allCourses } from './helpers/generate-margin.mjs';

const { state, openGenerate, answers } = generateMarginFixture('kinds');

/* Round 14 review (rv33): en 420 全部课程 read one course three ways, 「Text · 267 chars · 示例课程…」 beside 「Markdown · 示例课程 · 设计模式」 and 「PDF · 4 pages ·
   示例课程 · 设计模式」: a Text note's characters took the end of its course. In 全部课程 the course is the one fact the scope does not give for a row, so the
   rows of a kind say their characters only where every row of it still says its course as the names alone leave it: none of them cuts its course for them. */
test('round 14: in 全部课程 a kind says its characters only where every row of it keeps its course whole beside them (320–1000, zh/en)', { timeout: 900000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['en', 'zh']) {
    const { page, errors, context } = await openGenerate({ lang, width: 320, height: 900, answer: answers().badges });
    await allCourses(page, lang);
    const bad = [];
    let sized = 0;
    for (let width = 320; width <= 1000; width += 4) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page, 2);
      const rows = await factsLines(page), kinds = new Map();
      for (const row of rows) {
        const parts = row.lead.text.split(' · '), paged = parts.length > 2, said = paged ? parts.slice(0, 2).join(' · ') : parts[0];
        const kind = paged ? 'with pages' : parts[0], course = row.names[0];
        if (!kinds.has(kind)) kinds.set(kind, { chars: false, cut: [] });
        if (row.lead.seen.trim().length > said.length) kinds.get(kind).chars = true;
        if (course && course.shown && course.cut) kinds.get(kind).cut.push(row.text);
      }
      for (const [kind, { chars, cut }] of kinds) {
        if (chars) sized++;
        if (chars && cut.length) bad.push(`${width}: ${kind} rows say their characters while one cuts its course: ${cut[0]}`);
      }
    }
    assert.ok(sized > 0, `${lang}: some kind says its characters`);
    assert.deepEqual(bad.slice(0, 8), [], `${lang} 全部课程 (${bad.length} widths)`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
