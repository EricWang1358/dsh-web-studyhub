/* #468: `papers` of a 课程总纲 / 复习全书 build names its sample papers by any id the library gives a material: the material's key (doc:…, pdf:…), its
   document id (document-…), or the id of one of its pages (what source.courses.set and source.list take). The pages of one material are one paper. An id
   that names no material of the course is refused, the message naming the field, the id and why (unknown, filed under another course, not an id). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { isCourseOutlineSource } from '../lib/exam-point-list.js';
import { COURSE, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';
import { planOutline, planPapersOnly } from '../lib/contexts/generation/outline/plan.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { MAX_PAPERS, choosePapers } from '../lib/contexts/generation/outline/papers.js';
import { COURSE_OUTLINE_VERSION } from '../lib/course-outline-book.js';

const PAPER = 'doc:document-paper-2025', LECTURE = 'pdf:document-l2';
const library = (extra = []) => {
  const { sources, decks } = outlineLibrary({ paper: true });
  return { sources: [...sources, ...extra], decks, documents: [], drafts: [], attempts: [], courses: [] };
};
const refusedWith = (fn, pattern) => assert.throws(fn, error => {
  assert.equal(error.code, 'course-outline-paper-invalid', error.message);
  assert.match(error.message, pattern);
  return true;
});
const keysOf = plan => plan.papers.map(paper => paper.key);

test('a paper is named by its key, its document id or the id of any of its pages; the pages of one material are one paper, in the order asked', () => {
  const state = library();
  assert.deepEqual(keysOf(planOutline(state, { course: COURSE, papers: [PAPER] })), [PAPER]);
  assert.deepEqual(keysOf(planOutline(state, { course: COURSE, papers: ['document-paper-2025'] })), [PAPER], 'the document id');
  assert.deepEqual(keysOf(planOutline(state, { course: COURSE, papers: ['paper-2025'] })), [PAPER], 'the id of its page');
  const pages = ['document-l2-p1', 'document-l2-p2', 'document-l2-p3', 'document-l2-p4', 'document-l2-p5', 'document-l2-p6'];
  const plan = planOutline(state, { course: COURSE, papers: [...pages, 'paper-2025', PAPER] });
  assert.deepEqual(keysOf(plan), [LECTURE, PAPER], 'six page ids of one lecture are one paper; a paper named twice is used once');
  assert.equal(plan.papersBy, 'learner');
  const described = plan.described, alias = key => [...described.aliases].find(([, keys]) => keys.includes(key))[0];
  assert.equal(described.descriptors.find(item => item.id === alias(PAPER)).role, 'sample paper', 'the descriptor of a paper named by its page says so');
  assert.deepEqual(plan.papers[0].sourceIds, pages, 'a paper reads all its pages, not only the ones named');
});

test('the review book and a papers-only build read the ids the same way', () => {
  const state = library();
  const documents = buildOutlineIndex(state, { course: COURSE }).allDocuments;
  assert.deepEqual(choosePapers(documents, { asked: ['paper-2025', 'document-l2-p3'] }).keys, [PAPER, LECTURE]);
  const outline = planOutline(state, { course: COURSE });
  const current = { id: 'outline-1', title: 'outline', provenance: 'course-outline', text: 'x', courses: [COURSE],
    courseOutline: { version: COURSE_OUTLINE_VERSION, course: COURSE, nodes: [], other: { anchors: [] }, orderBasis: { codes: [] }, counts: {}, fingerprint: outline.fingerprint } };
  const withOutline = { ...state, sources: [...state.sources, current] };
  const papersOnly = planPapersOnly(withOutline, { course: COURSE, papers: ['paper-2025'] });
  assert.deepEqual(keysOf(papersOnly), [PAPER]);
  const alias = [...papersOnly.described.aliases].find(([, keys]) => keys.includes(PAPER))[0];
  assert.equal(papersOnly.described.descriptors.find(item => item.id === alias).role, 'sample paper');
});

test('an id that names no material of the course is refused with the field, the id and the reason, in either language', () => {
  const elsewhere = { id: 'other-p1', title: 'Other course paper · p. 1', text: 'Q1 something', courses: ['Other course'],
    document: { materialId: 'document-other', format: 'md', filename: 'Other course paper.md' } };
  const state = library([elsewhere]);
  refusedWith(() => planOutline(state, { course: COURSE, papers: ['nowhere-p1'] }), /papers.*「nowhere-p1」.*找不到/);
  refusedWith(() => planOutline(state, { course: COURSE, papers: ['nowhere-p1'], language: 'en' }), /papers.*"nowhere-p1".*no material/i);
  refusedWith(() => planOutline(state, { course: COURSE, papers: ['other-p1'] }), /「other-p1」.*Other course paper.*没有归到这门课「SA」/);
  refusedWith(() => planOutline(state, { course: COURSE, papers: ['other-p1'], language: 'en' }), /"other-p1".*Other course paper.*not filed under the course "SA"/);
  refusedWith(() => planOutline(state, { course: COURSE, papers: [42] }), /papers 的每一项/);
  // The limit counts materials, not ids: 21 materials are too many, 6 page ids of one material are one.
  const documents = buildOutlineIndex(state, { course: COURSE }).allDocuments.filter(item => item.sourceIds.length);
  const many = documents.slice(0, MAX_PAPERS + 1).map(item => item.sourceIds[0]);
  refusedWith(() => planOutline(state, { course: COURSE, papers: many }), new RegExp(`最多 ${MAX_PAPERS} 份.*${MAX_PAPERS + 1} 份`));
  refusedWith(() => planOutline(state, { course: COURSE, papers: many, language: 'en' }), new RegExp(`at most ${MAX_PAPERS}.*${MAX_PAPERS + 1}`));
});

test('the limit counts only materials of the course: ids that name none are refused first, for what they are, and pages of one material are one', () => {
  // A paper of 25 pages filed under no course; a material filed (the old way, `course`) under another course; an archived one; one with no title.
  const outside = Array.from({ length: 25 }, (_, at) => ({ id: `ext-p${at + 1}`, title: `External paper · p. ${at + 1}`, text: `Q${at + 1} a question.`, courses: [],
    document: { materialId: 'document-ext', format: 'pdf', page: at + 1, totalPages: 25, filename: 'External paper.pdf' } }));
  const legacy = { id: 'legacy-1', title: 'Legacy handout', text: 'Something.', course: 'Other course', document: { materialId: 'document-legacy', format: 'md' } };
  const archived = { id: 'old-1', title: 'Old paper', text: 'Q1 old.', courses: [COURSE], archived: true, document: { materialId: 'document-old', format: 'md' } };
  const untitled = { id: 'blank-1', title: '', text: 'Q1 blank.', courses: ['Other course'], document: { materialId: 'document-blank', format: 'md' } };
  const state = library([...outside, legacy, archived, untitled]);
  refusedWith(() => planOutline(state, { course: COURSE, papers: outside.map(source => source.id) }),
    /「ext-p1」是《External paper[^》]*》，它没有归到这门课「SA」（现在归在：未分类）/);
  const documents = buildOutlineIndex(state, { course: COURSE }).allDocuments.filter(item => item.sourceIds.length);
  const twenty = documents.slice(0, MAX_PAPERS).map(item => item.sourceIds[0]);
  refusedWith(() => planOutline(state, { course: COURSE, papers: [...twenty, 'typo-p1'] }), /「typo-p1」在资料库里找不到/);
  refusedWith(() => planOutline(state, { course: COURSE, papers: ['legacy-1'] }), /《Legacy handout》，它没有归到这门课「SA」（现在归在：Other course）/);
  refusedWith(() => planOutline(state, { course: COURSE, papers: ['old-1'] }), /「old-1」是《Old paper》，它已归档/);
  refusedWith(() => planOutline(state, { course: COURSE, papers: ['old-1'], language: 'en' }), /"old-1" is "Old paper", which is archived/);
  refusedWith(() => planOutline(state, { course: COURSE, papers: ['blank-1'] }), /「blank-1」.*没有归到这门课「SA」（现在归在：Other course）/);
  refusedWith(() => planOutline(state, { course: COURSE, papers: [42], language: 'en' }), /Each item of papers must be the id of a material \(text\); got 42/);
  // Thousands of ids are matched at once, not one by one.
  const started = Date.now();
  refusedWith(() => planOutline(state, { course: COURSE, papers: [...Array.from({ length: 20000 }, (_, at) => `nowhere-${at}`)] }), /「nowhere-0」在资料库里找不到/);
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
});

test('a papers-only build with no papers re-reads the outline\'s own; one of them that left the course is named as the saved paper, not as the papers field', () => {
  const state = library();
  const outline = planOutline(state, { course: COURSE });
  const current = { id: 'outline-1', title: 'outline', provenance: 'course-outline', text: 'x', courses: [COURSE],
    courseOutline: { version: COURSE_OUTLINE_VERSION, course: COURSE, nodes: [], other: { anchors: [] }, orderBasis: { codes: [] }, counts: {}, fingerprint: outline.fingerprint,
      papers: [{ key: 'doc:document-gone', title: 'Gone paper', sourceIds: ['gone-p1'] }], papersBy: 'learner' } };
  const withOutline = { ...state, sources: [...state.sources, current] };
  refusedWith(() => planPapersOnly(withOutline, { course: COURSE }), /总纲原来用作样卷的「doc:document-gone」在资料库里找不到/);
  refusedWith(() => planPapersOnly(withOutline, { course: COURSE, language: 'en' }), /sample paper the outline was marked with, "doc:document-gone", names no material/);
});

test('a chosen paper with no readable text is named in the refusal', () => {
  const blank = { id: 'scan-p1', title: 'Scanned paper', text: '   ', courses: [COURSE], document: { materialId: 'document-scan', format: 'md' } };
  const state = library([blank]);
  assert.throws(() => planOutline(state, { course: COURSE, papers: ['scan-p1'] }),
    error => error.code === 'course-outline-no-readable-text' && /《Scanned paper》（doc:document-scan）里没有可读的文字/.test(error.message));
  assert.throws(() => planOutline(state, { course: COURSE, papers: ['scan-p1'], language: 'en' }),
    error => error.code === 'course-outline-no-readable-text' && /"Scanned paper" \(doc:document-scan\) has no readable text/.test(error.message));
});

test('the issue as reported: a paper filed under the course with source.courses.set (its page id) is then accepted by a build that names that id', async t => {
  const fake = outlineModel({ inventory: 'none' }), root = await privateRoot(t, 'course-outline-papers-ids-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary({ paper: true });
  const unfiled = sources.map(source => (source.id === 'paper-2025' ? { ...source, courses: [] } : source));
  await service.store.update(state => { state.sources.push(...structuredClone(unfiled)); state.decks.push(...structuredClone(decks)); });
  const build = () => service.call('generation.courseOutline.build', { course: COURSE, language: 'zh', papers: ['paper-2025'] });
  await assert.rejects(build(), error => error.code === 'course-outline-paper-invalid' && /「paper-2025」.*没有归到这门课「SA」（现在归在：未分类）/.test(error.message));
  const set = await service.call('source.courses.set', { assignments: [{ id: 'paper-2025', courses: [COURSE] }] });
  assert.equal(set.updated, 1);
  assert.equal((await settleJob(service, (await build()).jobId)).status, 'complete');
  const outline = (await service.store.read()).sources.find(source => isCourseOutlineSource(source) && !source.archived);
  assert.deepEqual(outline.courseOutline.papers.map(paper => paper.key), [PAPER]);
});
