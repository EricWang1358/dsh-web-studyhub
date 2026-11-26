/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { frames, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { generateMarginFixture, cutsOf, COURSE, LONG, factsLines, leadProblems, allCourses, boxNames, scrollList } from './helpers/generate-margin.mjs';

const { state, openGenerate, answers } = generateMarginFixture('long');

test('#1084 round 8 review: scrolling a list longer than its first 24 rows changes no row: the names are decided once for the scope and the line\'s width', { timeout: 600000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const [lang, width] of [['zh', 420], ['en', 420], ['en', 900], ['zh', 900]]) for (const all of [false, true]) {
    const tag = `${lang} ${width}${all ? ' 全部课程' : ''}`;
    const { page, errors, context } = await openGenerate({ lang, width, height: 900, answer: answers().badges, on: state.longServer });
    if (all) await allCourses(page, lang);
    await frames(page, 4);
    const decided = () => page.evaluate(() => document.querySelector('[data-tour="generate-sources"] .source-picker').dataset.names);
    const first = await decided(), seen = new Map(), later = [];
    const look = async step => {
      assert.equal(await decided(), first, `${tag}, ${step}: the list's decision stays ${first}`);
      for (const row of await factsLines(page)) {
        if (!row.names.length) continue;
        if (!seen.has(row.title)) seen.set(row.title, row.text);
        else if (seen.get(row.title) !== row.text) later.push(`${step}: ${row.title}: "${seen.get(row.title)}" then "${row.text}"`);
        if (all) assert.ok(row.names[0].shown && row.names[0].seen.replace(/^·\s*/, '').length >= 2, `${tag}, ${step}: in 全部课程 every row says its course (${row.title}: ${row.text})`);
      }
    };
    await look('first paint');
    let drawn = 0, still = 0;
    for (let step = 1; step <= 30 && still < 2; step++) {
      const now = await scrollList(page);
      still = now === drawn ? still + 1 : 0;
      drawn = now;
      await frames(page, 3);
      await look(`scrolled ${step}`);
    }
    assert.ok(seen.size >= 34, `${tag}: every row was drawn (${seen.size})`);
    await scrollList(page, { top: true });
    await frames(page, 4);
    await look('back at the top');
    assert.deepEqual(later, [], `${tag}: no row reads differently after scrolling`);
    const rows = [...seen.values()], withCourse = rows.filter(text => /网络|示例课程/.test(text)).length;
    if (!all) assert.ok(withCourse === 0 || withCourse === rows.length, `${tag}: the other course on every row or on none (${withCourse}/${rows.length})`);
    t.diagnostic(`${tag}: data-names=${first}, ${seen.size} rows: ${rows.slice(0, 2).concat(rows.slice(-1)).join(' | ')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084 round 8 review: at 320–420 a row\'s facts read the same before and after the index answer; #1135: they say the format whole and the size whole or not at all, by one rule for the list', { timeout: 900000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['en', 'zh']) for (const width of [320, 360, 375, 390, 420]) for (const outcome of width === 320 ? ['badges', 'no index', 'fail'] : ['badges', 'no index']) {
    const tag = `${lang} ${width} ${outcome}`;
    const { page, errors, context, release } = await openGenerate({ lang, width, now: false, answer: outcome === 'fail' ? 'fail' : answers()[outcome] });
    await frames(page, 4);
    const coming = await factsLines(page);
    release();
    await until(() => page.evaluate(() => !document.querySelector('[data-tour="generate-sources"] [data-index-slot="held"]')), `${tag}: the answer is in`);
    if (outcome === 'badges') await until(async () => (await page.locator('[data-tour="generate-sources"] [data-index-slot] [data-state]').count()) >= 5, `${tag}: the badges`);
    await settleAnimations(page);
    await frames(page, 4);
    const landed = await factsLines(page);
    assert.deepEqual(landed.map(row => row.text), coming.map(row => row.text), `${tag}: the facts lines read the same before and after the answer`);
    // round 8 review asked for the size at 320–420 even cut in its own words; #1135 (round 10 review): 「Markdown · 560 …」, 「Text · 267 charac…」 and
    // 「PDF · 4 pages…」 on three rows read three ways. The size is now said whole or not at all, by one rule for the rows of a kind (a document with pages
    // says its size in pages), and the format is always said whole.
    assert.deepEqual(leadProblems(landed), [], `${tag}: ${landed.slice(0, 3).map(row => row.text).join(' | ')}`);
    t.diagnostic(`${tag}: ${landed.slice(0, 2).map(row => row.text).join(' | ')}`);
    assert.deepEqual(errors.filter(error => !/status of 500/.test(error)), []);
    await context.close();
  }
});

test('#1084 round 8 review: every course a row carries is in its checkbox\'s name at every width, drawn or not', { timeout: 600000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const lang of ['zh', 'en']) for (const width of [320, 420, 900, 1440]) {
    const { page, errors, context } = await openGenerate({ lang, width, answer: answers().badges });
    for (const all of [false, true]) {
      const tag = `${lang} ${width}${all ? ' 全部课程' : ''}`;
      if (all) await allCourses(page, lang);
      await frames(page, 4);
      const names = await boxNames(page, 5);
      assert.equal(names.length, 5, `${tag}: five rows`);
      for (const name of names) {
        assert.ok(name.includes(LONG), `${tag}: the other course is in the checkbox's name ("${name}")`);
        if (all) assert.ok(name.includes(COURSE), `${tag}: the course is in the checkbox's name ("${name}")`);
      }
      t.diagnostic(`${tag}: ${names[0]}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#1084 round 10: in a course scope a row\'s long notes give way, so the other course is said on every row (en 900, zh 420), not left off the whole list', { timeout: 600000 }, async t => {
  if (state.skip) { t.skip(state.skip); return; }
  for (const [lang, width] of [['en', 900], ['zh', 420]]) {
    const tag = `${lang} ${width}`;
    const { page, errors, context } = await openGenerate({ lang, width, height: 900, answer: answers().badges, on: state.longServer });
    await frames(page, 4);
    const rows = new Map();
    for (let step = 0, drawn = 0, still = 0; step <= 30 && still < 2; step++) {
      for (const row of await factsLines(page)) rows.set(row.title, row);
      const now = await scrollList(page);
      still = now === drawn ? still + 1 : 0;
      drawn = now;
      await frames(page, 3);
    }
    for (const row of await factsLines(page)) rows.set(row.title, row);
    const all = [...rows.values()];
    assert.ok(all.length >= 34, `${tag}: every row was drawn (${all.length})`);
    const without = all.filter(row => !(row.names[0]?.shown && !row.names[0].cut && row.names[0].text === '· 网络'));
    assert.deepEqual(without.map(row => row.text), [], `${tag}: every row says 「· 网络」 whole`);
    for (const row of all.filter(item => /PDF/.test(item.lead.text))) {
      assert.ok(cutsOf(row).length <= 1 && /^PDF · 3 (页|pages) · \S+ (字符|characters)/.test(row.lead.seen), `${tag}: a long-noted row keeps its format and size, its notes give way ("${row.text}")`);
      assert.ok(!/(·\s*|\d)$/.test(row.lead.seen), `${tag}: the format and size are not cut ("${row.text}")`);
      assert.deepEqual(row.pieces.filter(piece => piece.note && piece.shown && (piece.cut || piece.clipped)).map(piece => piece.text), [], `${tag}: a note is said whole or left out ("${row.text}")`);
    }
    t.diagnostic(`${tag}: ${all[0].text} | ${all.at(-1).text}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
