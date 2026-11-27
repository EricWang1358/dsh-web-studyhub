import test from 'node:test';
import assert from 'node:assert/strict';
import { frames } from '../scripts/qa/layout-late.mjs';
import { generateMarginFixture, LONG, factsLines, boxNames } from './helpers/generate-margin.mjs';

const { state, openGenerate, answers } = generateMarginFixture('kinds');

/* Round 11 (rv30): the long course was cut inside its figure at the line's end, 「分布式系统与网络协议（202…」. A shortened course ends on a whole word
   (before a space, an opening bracket or a figure after a Chinese word), keeps its 「…」 and its hover card, and the checkbox's name says it as written. */
test('round 11: a shortened course is never cut inside a figure, and its checkbox\'s name says it as written', { timeout: 600000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['en', 'zh']) {
    const { page, errors, context } = await openGenerate({ lang, width: 480, height: 900, answer: answers().badges });
    const bad = [];
    let cuts = 0;
    for (let width = 480; width <= 960; width += 4) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page, 2);
      let rows = await factsLines(page);
      // the hover card comes with the shared observer's answer, a frame or two after the cut (ui/use-cut.js), or after the shell's sidebar has finished
      // opening where the window crosses its width (the line keeps changing while it slides)
      const untilTips = Date.now() + 2000;
      while (Date.now() < untilTips && rows.some(row => row.names.some(piece => piece.shown && piece.cut && !piece.tip))) {
        await frames(page, 1);
        rows = await factsLines(page);
      }
      for (const row of rows) {
        for (const name of row.names.filter(piece => piece.shown && piece.cut)) {
          cuts++;
          const whole = name.text, shown = name.seen;
          if (/\d$/.test(shown) && /^\d/.test(whole.slice(shown.length))) bad.push(`${width}: cut inside a figure: ${row.text}`);
          if (!name.tip) bad.push(`${width}: a cut name has no hover card: ${row.text}`);
        }
      }
    }
    assert.ok(cuts > 0, `${lang}: some course was cut`);
    assert.deepEqual(bad.slice(0, 8), [], lang);
    const names = await boxNames(page, 6);
    assert.ok(names.filter(name => name.includes(LONG)).length >= 3, `${lang}: the checkbox's name says the long course as written (${names[2]})`);
    t.diagnostic(`${lang}: ${cuts} cut names checked`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
