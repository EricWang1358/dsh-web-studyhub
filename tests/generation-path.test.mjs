import test from 'node:test';
import assert from 'node:assert/strict';
import { planGenerationPath, suggestedCount, STEP_CHARS, applyPathRefinement } from '../lib/generation-path.js';

/* 分步出题路径: a selection too big for one generation is cut into steps, each small enough to generate (and review) well, in the order of the book. The plan is made
   locally from the chapters (or the pages when there are none); a model may then rename the steps, say what each one practises and reorder them. */

const page = (n, chars) => ({ sourceId: `p${n}`, page: n, chars, title: `p${n}` });
const doc = (key, pages, chapters) => ({ key, title: key, format: 'pdf', sourceIds: pages.map(item => item.sourceId), pages, chars: pages.reduce((s, p) => s + p.chars, 0), ...(chapters ? { chapters, chapterUnit: 'page' } : {}) });
const chapter = (index, title, from, to, pages) => ({ index, title, level: 1, front: false, startPage: from, endPage: to, sourceIds: pages.slice(from - 1, to).map(p => p.sourceId), chars: pages.slice(from - 1, to).reduce((s, p) => s + p.chars, 0) });

test('chapters become steps in book order; small neighbours share a step; a step never goes over the budget', () => {
  const pages = Array.from({ length: 12 }, (_, i) => page(i + 1, 20_000)); // 240k chars
  const chapters = [chapter(1, '第 1 章 引言', 1, 2, pages), chapter(2, '第 2 章 进程', 3, 6, pages), chapter(3, '第 3 章 内存', 7, 10, pages), chapter(4, '第 4 章 文件', 11, 12, pages)];
  const plan = planGenerationPath([doc('book', pages, chapters)], { budget: 100_000 });
  assert.ok(plan.steps.length >= 3);
  assert.deepEqual(plan.steps.flatMap(step => step.sourceIds), pages.map(item => item.sourceId), 'every page once, in order');
  assert.ok(plan.steps.every(step => step.chars <= 100_000), 'no step over the budget');
  assert.match(plan.steps[0].title, /引言/);
  assert.match(plan.steps[0].title, /第 1 章 引言/, 'a step is named after its chapters');
  assert.deepEqual(plan.steps.map(step => step.order), plan.steps.map((_, i) => i + 1));
  assert.equal(plan.basis, 'chapters');
});

test('a chapter bigger than the budget is cut by pages, a book without chapters by page runs', () => {
  const pages = Array.from({ length: 10 }, (_, i) => page(i + 1, 30_000)); // 300k
  const one = planGenerationPath([doc('big', pages, [chapter(1, '整本一章', 1, 10, pages)])], { budget: 100_000 });
  assert.ok(one.steps.length >= 3 && one.steps.every(step => step.chars <= 100_000));
  assert.match(one.steps[0].title, /整本一章/);
  assert.match(one.steps[0].title, /第 1–3 页|第 1–3 页/);
  const plain = planGenerationPath([doc('plain', pages)], { budget: 100_000 });
  assert.equal(plain.basis, 'pages');
  assert.deepEqual(plain.steps.flatMap(step => step.sourceIds), pages.map(item => item.sourceId));
  assert.match(plain.steps[0].title, /第 1–3 页/);
});

test('several documents keep their order and never share a step across a document boundary unless both are small', () => {
  const a = Array.from({ length: 3 }, (_, i) => page(i + 1, 10_000)), b = Array.from({ length: 3 }, (_, i) => ({ ...page(i + 1, 10_000), sourceId: `b${i + 1}` }));
  const plan = planGenerationPath([doc('A', a), doc('B', b)], { budget: 100_000 });
  assert.equal(plan.steps.length, 1, 'two small documents fit one step');
  const tight = planGenerationPath([doc('A', a), doc('B', b)], { budget: 35_000 });
  assert.deepEqual(tight.steps.flatMap(step => step.sourceIds), [...a, ...b].map(item => item.sourceId));
  assert.ok(tight.steps.every(step => step.chars <= 35_000));
});

test('the number of questions follows the size of a step, within a sensible range, and the plan is capped at forty steps', () => {
  assert.equal(suggestedCount(1_000), 6);
  assert.equal(suggestedCount(60_000), 10);
  assert.equal(suggestedCount(600_000), 30);
  assert.equal(STEP_CHARS, 150_000);
  const pages = Array.from({ length: 200 }, (_, i) => page(i + 1, 20_000));
  const plan = planGenerationPath([doc('huge', pages)], { budget: 20_000 });
  assert.ok(plan.steps.length <= 40, `${plan.steps.length} steps`);
  assert.deepEqual(plan.steps.flatMap(step => step.sourceIds).length, 200, 'the cap widens the steps, it never drops a page');
});

test('a model refinement renames, reorders and tunes steps, but cannot add, drop or change what a step covers', () => {
  const pages = Array.from({ length: 6 }, (_, i) => page(i + 1, 40_000));
  const base = planGenerationPath([doc('b', pages, [chapter(1, '一', 1, 2, pages), chapter(2, '二', 3, 4, pages), chapter(3, '三', 5, 6, pages)])], { budget: 90_000 });
  const ids = base.steps.map(step => step.id);
  const refined = applyPathRefinement(base.steps, { steps: [
    { id: ids[2], title: '先学这个', focus: '重点练习概念辨析', count: 12, reason: '后面依赖它' },
    { id: ids[0], title: '再学这个', focus: '', count: 999 },
    { id: ids[1], title: '最后', focus: '应用题'.repeat(500) },
    { id: 'invented', title: '不存在', focus: 'x' },
  ] });
  assert.equal(refined.source, 'model');
  assert.deepEqual(refined.steps.map(step => step.id), [ids[2], ids[0], ids[1]], 'the model order, unknown ids ignored');
  assert.equal(refined.steps[0].title, '先学这个');
  assert.equal(refined.steps[0].count, 12);
  assert.equal(refined.steps[1].count <= 30, true, 'count is clamped');
  assert.ok(refined.steps[2].focus.length <= 200, 'focus is clipped');
  assert.deepEqual(refined.steps[0].sourceIds, base.steps.find(step => step.id === ids[2]).sourceIds, 'coverage unchanged');
  assert.deepEqual(refined.steps.map(step => step.order), [1, 2, 3]);
  // a refinement that forgets a step keeps it, at the end, with its own plan
  const partial = applyPathRefinement(base.steps, { steps: [{ id: ids[1], title: '只改一个' }] });
  assert.deepEqual(partial.steps.map(step => step.id), [ids[1], ids[0], ids[2]]);
  assert.equal(applyPathRefinement(base.steps, null).source, 'local');
  assert.equal(applyPathRefinement(base.steps, { steps: 'nope' }).source, 'local');
});
