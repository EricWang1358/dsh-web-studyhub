import test from 'node:test';
import assert from 'node:assert/strict';
import { planGenerationPath, STEP_CHARS, STEP_PAGES, CALL_PAGES, CALL_QUESTIONS, MAX_STEPS, usableTitle, matterKind } from '../lib/generation-path.js';

/* 2.5.8: the starting point of the step path for a big book. Step names never come from a cut-off word, the back matter (index, colophon, about the author, …) is
   its own optional step that is skipped by default, every step carries the pages it covers, and a step is small in pages as well as in characters. */

const page = (n, chars = 1800, document = 'book') => ({ sourceId: `${document}-p${n}`, page: n, chars, title: `Book · p.${n}` });
const chapter = (index, title, from, to, pages) => ({ index, title, level: 1, front: false, startPage: from, endPage: to, sourceIds: pages.slice(from - 1, to).map(p => p.sourceId), chars: pages.slice(from - 1, to).reduce((s, p) => s + p.chars, 0) });
const doc = (key, pages, chapters, title = key) => ({ key, title, format: 'pdf', sourceIds: pages.map(item => item.sourceId), pages, chars: pages.reduce((s, p) => s + p.chars, 0), ...(chapters ? { chapters, chapterUnit: 'page' } : {}) });
const covered = plan => plan.steps.flatMap(step => step.sourceIds);

test('the limits of one generate call are constants next to the step size, and a step respects the page limit as well as the character limit', () => {
  assert.equal(STEP_CHARS, 150_000);
  assert.equal(CALL_PAGES, 20);
  assert.equal(CALL_QUESTIONS, 15);
  assert.equal(STEP_PAGES, CALL_PAGES, 'a step is about one generate call in pages');
  assert.equal(MAX_STEPS, 40);
});

test('81 pages of 147,000 characters is too big a unit: it is cut into balanced steps of at most 20 pages, in order, none of them a stub', () => {
  const pages = Array.from({ length: 81 }, (_, i) => page(i + 1, 1815)); // 147,015 chars: under the character budget, over the page limit
  const plan = planGenerationPath([doc('book', pages)]);
  assert.deepEqual(covered(plan), pages.map(item => item.sourceId), 'every page once, in order');
  assert.ok(plan.steps.every(step => step.pages <= STEP_PAGES), plan.steps.map(step => step.pages).join(','));
  assert.equal(plan.steps.length, 5);
  assert.ok(plan.steps.every(step => step.pages >= 16), 'balanced: 81 pages are 17+16+16+16+16, not 20+20+20+20+1');
  assert.ok(plan.steps.every(step => step.chars <= STEP_CHARS));
});

test('chapters still share a step while both limits hold, and a chapter over either limit is cut', () => {
  const pages = Array.from({ length: 60 }, (_, i) => page(i + 1, 1000));
  const chapters = [chapter(1, 'Alpha', 1, 5, pages), chapter(2, 'Beta', 6, 10, pages), chapter(3, 'Gamma', 11, 50, pages), chapter(4, 'Delta', 51, 60, pages)];
  const plan = planGenerationPath([doc('book', pages, chapters)]);
  assert.ok(plan.steps.every(step => step.pages <= STEP_PAGES));
  assert.match(plan.steps[0].title, /Alpha/);
  assert.match(plan.steps[0].title, /Beta/, 'two small chapters share one step');
  assert.deepEqual(covered(plan), pages.map(item => item.sourceId));
});

test('a very long book widens the steps instead of going past the maximum number of steps, and never drops a page', () => {
  const pages = Array.from({ length: 1000 }, (_, i) => page(i + 1, 1000));
  const plan = planGenerationPath([doc('huge', pages)]);
  assert.ok(plan.steps.length <= MAX_STEPS, `${plan.steps.length} steps`);
  assert.equal(covered(plan).length, 1000);
  const fits = planGenerationPath([doc('fits', pages.slice(0, 700))]);
  assert.equal(fits.steps.length, 35, '700 pages are 35 steps of 20: no widening below the maximum');
  assert.ok(fits.steps.every(step => step.pages === STEP_PAGES));
});

test('a step says which pages of which book it covers: runs of page numbers, so a custom range can be mapped to them', () => {
  const pages = Array.from({ length: 30 }, (_, i) => page(i + 1, 1000));
  const whole = planGenerationPath([doc('book', pages, undefined, 'Architecting Software Solutions')], { budget: 10_000_000, maxPages: 100 });
  assert.deepEqual(whole.steps[0].ranges, [{ document: 'Architecting Software Solutions', from: 1, to: 30 }]);
  const gappy = pages.filter(item => item.page <= 5 || item.page >= 9);
  const plan = planGenerationPath([doc('book', gappy, undefined, 'Book')], { budget: 10_000_000, maxPages: 100 });
  assert.deepEqual(plan.steps[0].ranges, [{ document: 'Book', from: 1, to: 5 }, { document: 'Book', from: 9, to: 30 }]);
  const two = planGenerationPath([doc('a', pages.slice(0, 3), undefined, 'A'), doc('b', pages.slice(0, 3).map(item => ({ ...item, sourceId: `b${item.page}` })), undefined, 'B')]);
  assert.deepEqual(two.steps[0].ranges.map(range => range.document), ['A', 'B']);
});

test('titles: a chapter name that is a cut-off word (one letter, a dangling hyphen or ellipsis, a bare number) is never used', () => {
  for (const bad of ['S', 'T', 'x', '3', 'IV', 'Ex-', 'Architectu…', 'Control ...', '—', '']) assert.equal(usableTitle(bad), '', `${JSON.stringify(bad)} is not a name`);
  for (const good of ['Control Freak', 'Taxonomy', 'Case Study: The Vasa', '绪论', '第 3 章 内存', 'OS']) assert.equal(usableTitle(good), good);
  const pages = Array.from({ length: 30 }, (_, i) => page(i + 1, 3000));
  const chapters = [chapter(1, 'S', 1, 10, pages), chapter(2, 'Ex-', 11, 20, pages), chapter(3, '…', 21, 30, pages)];
  const plan = planGenerationPath([doc('book', pages, chapters)], { budget: 40_000 });
  for (const step of plan.steps) {
    assert.doesNotMatch(step.title, /(^|\s)(S|Ex-|…)(\s|$)/, step.title);
    assert.match(step.title, /^第 \d+–\d+ 页$/, 'with no usable name the title is the page range');
  }
  const mixed = planGenerationPath([doc('book', pages, [chapter(1, 'Control Freak', 1, 15, pages), chapter(2, 'S', 16, 30, pages)])], { budget: 10_000_000, maxPages: 100 });
  assert.equal(mixed.steps.length, 1);
  assert.equal(mixed.steps[0].title, 'Control Freak · 第 1–30 页', 'a usable name stays, and the range says what the unnamed rest is');
});

test('front and back matter is recognised by its heading, in English and Chinese, and never mistaken for a real chapter', () => {
  for (const [title, kind] of [['Index', 'index'], ['INDEX', 'index'], ['索引', 'index'], ['Colophon', 'colophon'], ['About the Author', 'author'], ['About the Authors', 'author'], ['关于作者', 'author'],
    ['Acknowledgments', 'acknowledgments'], ['Acknowledgements', 'acknowledgments'], ['致谢', 'acknowledgments'], ['Table of Contents', 'contents'], ['Contents', 'contents'], ['目录', 'contents'],
    ['Copyright', 'copyright'], ['版权页', 'copyright'], ['Preface', 'preface'], ['Preface to the Second Edition', 'preface'], ['Foreword', 'preface'], ['前言', 'preface'],
    ['Appendix A: Tools', 'appendix'], ['附录 B', 'appendix'], ['Bibliography', 'bibliography'], ['参考文献', 'bibliography']])
    assert.equal(matterKind(title), kind, title);
  for (const real of ['Architecture Index Strategies', 'Indexing and Search', 'Contents Delivery Networks', 'The Author Problem', 'Appendix-free design', 'Fundamentals of Software Architecture', '', 'Control Freak'])
    assert.equal(matterKind(real), '', real);
});

test('the owner\'s book: 422 pages, an index of one chapter per letter and a colophon become optional steps of their own, skipped by default, and never share a step with content', () => {
  const pages = Array.from({ length: 422 }, (_, i) => page(i + 1, i < 5 ? 150 : 1750));
  const names = ['Fundamentals of Software Architecture', 'Extracting Architecture Characteristics from Domain Concerns', 'Case Study: The Vasa', 'Architecture Characteristics Ratings', 'History and Philosophy', 'Taxonomy', 'Architect Personalities', 'Control Freak'];
  const content = names.map((name, i) => [name, 6 + i * 50, 5 + (i + 1) * 50]);
  const last = content.at(-1)[2];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const chapters = content.map(([name, from, to], i) => chapter(i + 1, name, from, to, pages));
  chapters.push(chapter(chapters.length + 1, 'Index', last + 1, last + 2, pages));
  letters.forEach((letter, i) => chapters.push(chapter(chapters.length + 1, letter, Math.min(last + 3 + Math.floor(i / 2), 421), Math.min(last + 3 + Math.floor(i / 2), 421), pages)));
  chapters.push(chapter(chapters.length + 1, 'Colophon', 422, 422, pages));
  const plan = planGenerationPath([doc('book', pages, chapters, 'Architecting Software Solutions')]);
  assert.deepEqual(covered(plan), pages.map(item => item.sourceId), 'every page is in exactly one step, in order');
  assert.ok(plan.steps.every(step => step.pages <= STEP_PAGES));
  const optional = plan.steps.filter(step => step.optional);
  assert.ok(optional.length >= 1, 'the back matter is optional');
  const firstOptional = plan.steps.findIndex(step => step.optional);
  assert.ok(plan.steps.slice(firstOptional).every(step => step.optional), 'the back matter is at the end and all of it is optional');
  assert.ok(plan.steps.slice(0, firstOptional).every(step => !step.optional && step.included === true), 'content steps are on by default');
  assert.ok(optional.every(step => step.included === false), 'optional steps are off by default');
  assert.ok(optional.every(step => ['index', 'colophon'].includes(step.matter)), optional.map(step => step.matter).join());
  for (const step of plan.steps) assert.doesNotMatch(step.title, /(^|\s)[A-Z](\s|$)/, `no cut-off letter in "${step.title}"`);
  assert.ok(optional.some(step => /Colophon/.test(step.title) || /Index/.test(step.title)), optional.map(step => step.title).join(' | '));
  const lastContent = plan.steps[firstOptional - 1];
  assert.ok(lastContent.sourceIds.every(id => Number(id.split('-p')[1]) <= last), 'no index page in a content step');
});

test('a front-matter run (the pages before the first chapter) and blank pages are optional too; a selection that is only matter keeps nothing skipped', () => {
  const pages = Array.from({ length: 40 }, (_, i) => page(i + 1, i < 4 ? 900 : 2000));
  const front = { index: -1, title: '', level: 0, front: true, startPage: 1, endPage: 4, sourceIds: pages.slice(0, 4).map(p => p.sourceId), chars: 3600 };
  const withFront = planGenerationPath([doc('book', pages, [front, chapter(1, 'Alpha', 5, 40, pages)])], { budget: 10_000_000, maxPages: 100 });
  assert.equal(withFront.steps.length, 2);
  assert.deepEqual([withFront.steps[0].optional, withFront.steps[0].matter, withFront.steps[1].optional], [true, 'front', false]);
  const blank = Array.from({ length: 24 }, (_, i) => page(i + 1, i < 20 ? 2000 : 3));
  const plan = planGenerationPath([doc('book', blank)], { budget: 10_000_000 });
  assert.deepEqual(plan.steps.map(step => [step.pages, step.optional, step.matter]), [[20, false, ''], [4, true, 'blank']]);
  const only = planGenerationPath([doc('book', pages, [chapter(1, 'Index', 1, 40, pages)])], { budget: 30_000 });
  assert.ok(only.steps.every(step => !step.optional && step.included === true), 'when everything selected is matter, the learner chose it: nothing is skipped');
});
