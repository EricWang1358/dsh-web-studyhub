/* The 速查表 of a book of some chapters (#710 S5 with #708): a chapter that is not built yet (未生成: none of its points has an explanation) is not on the sheet,
   neither its points as places of a template nor as places of a formula; course.book.open says which points are not built. Fake model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { bookModel } from './helpers/course-book-model.mjs';
import { isCourseOutlineSource } from '../lib/exam-point-list.js';
import { SAMPLE_FROM } from '../lib/contexts/generation/book/constants.js';
import { cheatSheet } from '../ui/book/cheat-sheet-model.js';

const leavesOf = nodes => nodes.flatMap(node => (node.children?.length ? leavesOf(node.children) : [node]));

test('course.book.open marks the points of a chapter that was not built; the sheet leaves such a chapter out', async t => {
  const fake = bookModel(), root = await privateRoot(t, 'book-cheat-parts-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const built = outlineLibrary();
  await service.store.update(state => {
    state.sources.push(...structuredClone(built.sources)); state.decks.push(...structuredClone(built.decks)); state.focus = { mode: 'class', course: COURSE };
  });
  const organised = await settleJob(service, (await service.call('generation.courseOutline.build', { course: COURSE, language: 'zh' })).jobId);
  assert.equal(organised.status, 'complete');
  const outline = (await service.store.read()).sources.filter(isCourseOutlineSource).find(record => !record.archived);
  const chapters = outline.courseOutline.nodes.map(top => ({ id: top.id, points: leavesOf([top]).filter(leaf => leaf.anchors?.length) })).filter(chapter => chapter.points.length && chapter.points.length < SAMPLE_FROM);
  assert.ok(chapters.length >= 2);
  const [picked, other] = chapters;
  const job = await settleJob(service, (await service.call('generation.courseBook.build', { course: COURSE, language: 'zh', chapters: [picked.id] })).jobId);
  assert.equal(job.status, 'complete');

  const book = await service.call('course.book.open', { course: COURSE });
  const top = id => book.nodes.find(node => outline.courseOutline.nodes.find(each => each.id === id).title === node.title);
  const flags = id => leavesOf([top(id)]).map(leaf => !!leaf.unbuilt);
  assert.ok(flags(picked.id).includes(false) && !flags(picked.id).includes(true), 'the built chapter: no point is marked');
  assert.ok(flags(other.id).length && flags(other.id).every(Boolean), 'the chapter not picked: every point is marked 未生成');

  // The sheet: a template placed on a point of each chapter names only the built one.
  const own = leavesOf([top(picked.id)])[0], away = leavesOf([top(other.id)])[0];
  const sheet = cheatSheet({ ...book, examKit: { language: 'zh', types: [{ code: 'T01', name: '比较', family: 'compare', signals: [], asks: '', template: '[A] 对 [B]', fills: [], anchors: [], hids: [own.hid, away.hid] }] } });
  assert.deepEqual(sheet.kit.types[0].places.map(place => place.hid), [own.hid]);
});
