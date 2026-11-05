/* The world of the 深度定制 S2 tests: a StudyService over the 500-page book of ./big-book-library.mjs with the fake book model, and what the tests read of it
   (the outline, the book, the calls since a mark, the pages an inventory call read). No network. */
import assert from 'node:assert/strict';
import { StudyService } from '../../lib/service.js';
import { settleJob } from './wait.mjs';
import { privateRoot } from './model-family-baseline.mjs';
import { switchOptions } from './runtime-switch.mjs';
import { bookModel } from './course-book-model.mjs';
import { BIG_COURSE, PAGES_PER_CHAPTER, bigBookLibrary, callPages, topicOf } from './big-book-library.mjs';
import { isCourseNotesSource, isCourseOutlineSource } from '../../lib/exam-point-list.js';

const KIND = 'course-book-build';

export async function bigBookWorld(t, { language = 'en' } = {}) {
  const fake = bookModel(), root = await privateRoot(t, 'custom-book-s2-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  await service.store.update(state => { state.sources.push(...bigBookLibrary().sources); state.focus = { mode: 'class', course: BIG_COURSE }; });
  const records = async () => (await service.store.read()).sources;
  const contract = () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND).at(-1)?.contract;
  const ask = args => service.call('generation.courseBook.build', { course: BIG_COURSE, language, ...args });
  const build = async args => {
    const job = await settleJob(service, (await ask(args)).jobId);
    assert.equal(job.status, 'complete', JSON.stringify(contract()?.error ?? null));
    return contract();
  };
  const chapterIds = async () => (await service.call('course.custom.preview', { course: BIG_COURSE })).skeleton.documents[0].chapters.map(chapter => chapter.id);
  return { service, fake, ask, build, contract, chapterIds, since: mark => fake.calls.slice(mark),
    shown: async () => (await service.call('course.outline', { course: BIG_COURSE })).book,
    notes: async () => (await records()).filter(isCourseNotesSource).find(record => !record.archived),
    outline: async () => (await records()).filter(isCourseOutlineSource).find(record => !record.archived) };
}

export const leavesOf = nodes => nodes.flatMap(node => (node.children ? leavesOf(node.children) : [node]));
export const written = record => record.courseNotes.leaves.filter(leaf => leaf.body && !leaf.body.empty);
export const pagesOf = chapter => [(chapter - 1) * PAGES_PER_CHAPTER + 1, chapter * PAGES_PER_CHAPTER];
const inChapters = (page, chapters) => chapters.some(chapter => page >= pagesOf(chapter)[0] && page <= pagesOf(chapter)[1]);
export const pointTitles = calls => [...new Set(calls.filter(call => call.stage === 'write').map(call => call.data.point.title))].sort();
export const topicsOf = chapters => [...new Set(chapters.flatMap(chapter => Array.from({ length: PAGES_PER_CHAPTER }, (_, at) => topicOf(pagesOf(chapter)[0] + at))))].sort();

/** The inventory calls since `mark` read only the pages of `chapters`: every call holds a page of them, and a page outside them only where a range of whole
    pages runs over a chapter's edge (the page next to it). */
export function readOnly(calls, chapters) {
  const pages = calls.flatMap(callPages), edge = page => inChapters(page - 1, chapters) || inChapters(page + 1, chapters);
  assert.ok(calls.every(call => callPages(call).some(page => inChapters(page, chapters))), 'every inventory call reads a picked chapter');
  const outside = [...new Set(pages.filter(page => !inChapters(page, chapters)))];
  assert.ok(outside.length <= 2 * chapters.length * 15 && outside.every(page => calls.some(call => callPages(call).includes(page) && callPages(call).some(own => inChapters(own, chapters)))),
    `only a range over an edge reads beyond it (${outside.join(',')})`);
  assert.ok(!pages.some(page => !inChapters(page, chapters) && !edge(page) && !calls.some(call => callPages(call).some(own => inChapters(own, chapters)) && callPages(call).includes(page))));
  return pages;
}
