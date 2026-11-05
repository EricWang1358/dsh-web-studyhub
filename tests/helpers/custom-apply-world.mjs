/* The world of the course.custom.apply tests: a library, a service whose model holds every call (a task stays where it was started), and the few words the tests share. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../../lib/service.js';
import { customDefaults } from '../../lib/custom-plan.js';
import { COURSE, LECTURES, outlineLibrary } from './course-outline-library.mjs';

export { COURSE };
export const held = () => new Promise(() => {});

export async function open(t, { model = true, library = outlineLibrary({ paper: true }), course = COURSE, complete = held, light = held } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-custom-apply-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root, model ? { complete, light } : {});
  t.after(() => study.dispose());
  await study.call('snapshot');
  await study.store.update(own => { own.sources.push(...structuredClone(library.sources)); own.decks.push(...structuredClone(library.decks)); own.focus = { mode: 'class', course, role: '', jd: '', targetTopics: [] }; });
  return study;
}
export const lecture = (skeleton, n) => skeleton.documents.find(doc => doc.title.includes(LECTURES[n - 1].title) && !doc.copyOf && doc.chapters.length === 3);
/** A 定制方案 that asks for nothing: each test switches on what it is about. */
export const plan = (over = {}) => ({ ...customDefaults('follow'), scope: { kind: 'all' }, book: { ...customDefaults('follow').book, make: false }, questions: { ...customDefaults('follow').questions, make: false },
  plan: { make: false, by: 'exam' }, sampleFirst: false, ...over });
export const save = (study, custom, course = COURSE) => study.call('course.save', { name: course, custom });
export const apply = (study, args = {}) => study.call('course.custom.apply', { course: COURSE, ...args });
export const questionJobs = study => [...study.runtime.work.jobs.values()].filter(job => job.coveragePlan || job.coverageRun);
export const steps = (answer, bucket, step) => answer[bucket].filter(item => item.step === step);

/** One converted book of three chapters of ten pages, each page 50 000 characters: what 'full' asks about 1 500 questions of. */
export const bigBook = () => ({ decks: [], sources: [0, 1, 2].flatMap(chapter => Array.from({ length: 10 }, (_, at) => ({ id: `big-c${chapter}-p${at + 1}`, title: `Big · p. ${chapter * 10 + at + 1}`,
  text: `Chapter ${chapter} page ${at + 1}. ${'The architect records this decision. '.repeat(1350)}`, createdAt: '2026-10-01T08:00:00.000Z', courses: ['Big'],
  document: { materialId: 'document-big', page: chapter * 10 + at + 1, totalPages: 30, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'Big.pdf',
    chapter: { index: chapter, title: `Chapter ${chapter + 1}`, level: 1 }, extractionVersion: 2 } }))) });
