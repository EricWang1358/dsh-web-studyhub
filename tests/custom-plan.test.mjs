/* 深度定制 (4.4 S0): the 定制方案 a learner agrees to in the main chat is the course record's optional `custom` (lib/custom-plan.js), saved only through
   course.save {custom} and checked there, exactly as `plan` is. This file holds the record: its shape, its refusals, the one table of defaults per purpose and the
   one place where the parts of the 复习全书 depend on each other. The read-only preview is tests/custom-preview.test.mjs. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { BASIC_KINDS } from '../lib/generation-settings.js';
import { LEVELS } from '../lib/coverage-strength.js';
import { COVERAGE_LEVELS } from '../lib/book-settings.js';
import { BOOK_PARTS, CUSTOM_PURPOSES, SCOPE_KINDS, PLAN_BASES, PART_NEEDS, checkedCustom, closedParts, customDefaults, lockedParts, partsWithout } from '../lib/custom-plan.js';

const mine = (purpose = 'review', over = {}) => ({ ...customDefaults(purpose), scope: { kind: 'chapters', chapters: ['doc#0', 'doc#1'] }, ...over });
const refuses = (custom, pattern, label = JSON.stringify(custom)) => assert.throws(() => checkedCustom(custom), pattern, label);

test('the ids S1 and the card use are the repo\'s own: the book parts, the question kinds, the strength levels, the coverage levels', () => {
  assert.deepEqual([...CUSTOM_PURPOSES], ['preview', 'follow', 'review', 'openbook']);
  assert.deepEqual([...SCOPE_KINDS], ['all', 'exam', 'chapters']);
  assert.deepEqual([...BOOK_PARTS], ['explain', 'terms', 'formulas', 'index', 'confusables', 'answerKit', 'cheatSheet']);
  assert.deepEqual([...PLAN_BASES], ['exam', 'weekly']);
  const custom = checkedCustom(mine('follow'));
  assert.ok(COVERAGE_LEVELS.includes(custom.book.coverage), 'coverage is one of lib/book-settings.js COVERAGE_LEVELS');
  assert.ok(LEVELS.includes(custom.questions.strength), 'strength is one of lib/coverage-strength.js LEVELS');
  assert.ok(custom.questions.kinds.every(kind => BASIC_KINDS.includes(kind)), 'kinds are the generation kinds');
});

test('customDefaults is the one table: the four purposes, as proposed, each a fresh copy', () => {
  const preview = customDefaults('preview'), follow = customDefaults('follow'), review = customDefaults('review'), openbook = customDefaults('openbook');
  assert.deepEqual(preview, { version: 1, purpose: 'preview', scope: { kind: 'chapters', chapters: [] }, book: { make: true, coverage: 'brief', parts: ['explain', 'terms'] },
    questions: { make: true, kinds: ['quiz', 'cloze'], strength: 'lean', variants: false }, plan: { make: true, by: 'weekly', chaptersPerWeek: 1 }, sampleFirst: true });
  assert.deepEqual(follow.book, { make: true, coverage: 'standard', parts: ['explain', 'terms', 'formulas'] });
  assert.deepEqual(follow.questions, { make: true, kinds: [...BASIC_KINDS], strength: 'standard', variants: true });
  assert.deepEqual(follow.scope, { kind: 'chapters', chapters: [] });
  assert.equal(follow.plan.by, 'weekly');
  assert.deepEqual(review.scope, { kind: 'all' });
  assert.deepEqual(review.book.parts, ['explain', 'terms', 'formulas', 'confusables', 'answerKit']);
  assert.deepEqual(review.questions, { make: true, kinds: [...BASIC_KINDS], strength: 'standard', variants: true });
  assert.deepEqual(review.plan, { make: true, by: 'exam' });
  assert.deepEqual(openbook.scope, { kind: 'all' });
  assert.equal(openbook.book.coverage, 'brief');
  assert.deepEqual(openbook.book.parts, ['explain', 'terms', 'formulas', 'index', 'confusables', 'answerKit', 'cheatSheet'], 'explain is in: every other text part is made from it');
  assert.deepEqual(openbook.questions, { make: true, kinds: ['quiz', 'open'], strength: 'lean', variants: false });
  for (const custom of [preview, follow, review, openbook]) {
    assert.equal(custom.sampleFirst, true);
    assert.deepEqual(closedParts(custom.book.parts), custom.book.parts, `${custom.purpose}: a default already has what its parts need`);
  }
  preview.book.parts.push('x'); preview.scope.chapters.push('x');
  assert.deepEqual(customDefaults('preview').book.parts, ['explain', 'terms'], 'a caller cannot change the table');
  assert.deepEqual(customDefaults('preview').scope.chapters, []);
  assert.throws(() => customDefaults('someday'), /用途/);
});

test('every default, with chapters filled in where it asks for them, is a valid record and comes back unchanged (idempotent)', () => {
  for (const purpose of CUSTOM_PURPOSES) {
    const filled = mine(purpose, customDefaults(purpose).scope.kind === 'chapters' ? {} : { scope: customDefaults(purpose).scope });
    const once = checkedCustom(filled);
    assert.deepEqual(checkedCustom(once), once, purpose);
    assert.equal(once.version, 1);
    assert.equal(once.purpose, purpose);
  }
});

test('the dependencies of the parts live in one place: a part that cannot be made without another brings it, in the book\'s order', () => {
  assert.deepEqual({ ...PART_NEEDS }, { terms: ['explain'], formulas: ['explain'], index: ['explain'], confusables: ['terms'] });
  assert.deepEqual(closedParts(['confusables']), ['explain', 'terms', 'confusables'], 'pairs are made from the term cards, which are written from the explanations');
  assert.deepEqual(closedParts(['formulas']), ['explain', 'formulas']);
  assert.deepEqual(closedParts(['answerKit']), ['answerKit'], 'the answer kit comes from the sample papers, not from the explanations');
  assert.deepEqual(closedParts(['cheatSheet']), ['explain', 'terms', 'cheatSheet'], 'a cheat sheet with nothing to put on it gets the term cards');
  assert.deepEqual(closedParts(['cheatSheet', 'answerKit']), ['answerKit', 'cheatSheet'], 'the answer kit already fills the sheet');
  assert.deepEqual(closedParts(['cheatSheet', 'formulas']), ['explain', 'formulas', 'cheatSheet']);
  assert.deepEqual(closedParts(['index', 'index', 'explain']), ['explain', 'index'], 'once each, in the book\'s order');
  assert.deepEqual(closedParts([]), []);
});

test('turning a part off takes its dependents with it; a part another one needs is locked', () => {
  const all = [...BOOK_PARTS];
  assert.deepEqual(partsWithout(all, 'terms'), ['explain', 'formulas', 'index', 'answerKit', 'cheatSheet']);
  assert.deepEqual(partsWithout(['explain', 'terms', 'cheatSheet'], 'terms'), ['explain'], 'the sheet has nothing left to show');
  assert.deepEqual(partsWithout(['explain', 'terms', 'confusables'], 'confusables'), ['explain', 'terms']);
  assert.deepEqual(partsWithout(['explain', 'formulas'], 'index'), ['explain', 'formulas'], 'an unticked part is a no-op');
  assert.deepEqual([...lockedParts(['explain', 'terms', 'confusables'])].sort(), ['explain', 'terms']);
  assert.deepEqual([...lockedParts(['explain'])], []);
  assert.deepEqual([...lockedParts(['explain', 'index'])], ['explain']);
});

test('checkedCustom keeps what the learner agreed to, tidied: parts in the book\'s order and closed, kinds in the form\'s order, chapters once', () => {
  const custom = checkedCustom({ version: 1, purpose: 'openbook', scope: { kind: 'chapters', chapters: ['b#1', 'a#0', 'b#1'], note: '  第 3–9 章 ' }, sampleFirst: false,
    book: { make: true, coverage: 'full', parts: ['cheatSheet', 'confusables', 'confusables'] },
    questions: { make: true, kinds: ['cloze', 'quiz', 'quiz'], strength: 'full', variants: true },
    plan: { make: true, by: 'weekly', chaptersPerWeek: 4, minutesPerDay: 90 } });
  assert.deepEqual(custom, { version: 1, purpose: 'openbook', scope: { kind: 'chapters', chapters: ['b#1', 'a#0'], note: '第 3–9 章' }, sampleFirst: false,
    book: { make: true, coverage: 'full', parts: ['explain', 'terms', 'confusables', 'cheatSheet'] },
    questions: { make: true, kinds: ['quiz', 'cloze'], strength: 'full', variants: true },
    plan: { make: true, by: 'weekly', chaptersPerWeek: 4, minutesPerDay: 90 } });
});

test('what is not asked for is not kept: chapters of an all/exam scope, a weekly pace of an exam plan, an empty note, a made-up updatedAt', () => {
  const all = checkedCustom({ ...mine('review'), scope: { kind: 'all', chapters: ['x'], note: '   ' }, updatedAt: '2000-01-01' });
  assert.deepEqual(all.scope, { kind: 'all' });
  assert.equal('updatedAt' in all, false, 'the save stamps it');
  const exam = checkedCustom({ ...mine('review'), scope: { kind: 'exam', note: '往年题范围' } });
  assert.deepEqual(exam.scope, { kind: 'exam', note: '往年题范围' });
  const byExam = checkedCustom({ ...mine('review'), plan: { make: true, by: 'exam', chaptersPerWeek: 3, minutesPerDay: 60 } });
  assert.deepEqual(byExam.plan, { make: true, by: 'exam', minutesPerDay: 60 });
});

test('a part the learner turned off needs nothing more than make:false', () => {
  const custom = checkedCustom({ version: 1, purpose: 'review', scope: { kind: 'all' }, sampleFirst: true, book: { make: false }, questions: { make: false }, plan: { make: false } });
  assert.deepEqual(custom.book, { make: false, coverage: 'standard', parts: [] });
  assert.deepEqual(custom.questions, { make: false, kinds: [], strength: 'standard', variants: false });
  assert.deepEqual(custom.plan, { make: false, by: 'exam' });
  const kept = checkedCustom({ ...mine('review'), book: { ...customDefaults('review').book, make: false } });
  assert.deepEqual(kept.book.parts, customDefaults('review').book.parts, 'the ticks survive an off switch, so the next on has them again');
});

test('every refusal says in plain Chinese what to change, and nothing is half-saved', () => {
  const ok = mine('review');
  refuses([], /定制方案格式不对/);
  refuses('plan', /定制方案格式不对/);
  refuses({ ...ok, version: 2 }, /version 需为 1/);
  refuses({ ...ok, version: undefined }, /version 需为 1/);
  refuses({ ...ok, purpose: 'later' }, /用途需为 preview、follow、review 或 openbook/);
  refuses({ ...ok, purpose: undefined }, /用途/);
  refuses({ ...ok, sampleFirst: 'yes' }, /sampleFirst 需为 true 或 false/);
  refuses({ ...ok, sampleFirst: undefined }, /sampleFirst/);
  refuses({ ...ok, scope: 'all' }, /范围格式不对/);
  refuses({ ...ok, scope: { kind: 'some' } }, /范围需为 all（全部）、exam（考试范围）或 chapters/);
  refuses({ ...ok, scope: { kind: 'chapters' } }, /指定章节需选 1 到 800 章/);
  refuses({ ...ok, scope: { kind: 'chapters', chapters: [] } }, /指定章节需选 1 到 800 章/);
  refuses({ ...ok, scope: { kind: 'chapters', chapters: [''] } }, /指定章节/);
  refuses({ ...ok, scope: { kind: 'chapters', chapters: [7] } }, /指定章节/);
  refuses({ ...ok, scope: { kind: 'chapters', chapters: ['x'.repeat(301)] } }, /指定章节/);
  refuses({ ...ok, scope: { kind: 'chapters', chapters: Array.from({ length: 801 }, (_, at) => `d#${at}`) } }, /指定章节/);
  refuses({ ...ok, scope: { kind: 'all', note: 'x'.repeat(501) } }, /范围备注不超过 500 字/);
  refuses({ ...ok, scope: { kind: 'all', note: 5 } }, /范围备注/);
  refuses({ ...ok, book: 'all' }, /复习全书的设置格式不对/);
  refuses({ ...ok, book: { ...ok.book, make: 'yes' } }, /复习全书的 make 需为 true 或 false/);
  refuses({ ...ok, book: { ...ok.book, coverage: 'deep' } }, /讲解详尽程度需为 brief、standard 或 full/);
  refuses({ ...ok, book: { ...ok.book, parts: ['explain', 'poster'] } }, /复习全书的部分只能是 explain、terms、formulas、index、confusables、answerKit、cheatSheet/);
  refuses({ ...ok, book: { ...ok.book, parts: 'explain' } }, /复习全书的部分需为列表/);
  refuses({ ...ok, book: { ...ok.book, parts: [] } }, /做复习全书至少要选一个部分/);
  refuses({ ...ok, questions: 'all' }, /出题的设置格式不对/);
  refuses({ ...ok, questions: { ...ok.questions, make: 1 } }, /出题的 make 需为 true 或 false/);
  refuses({ ...ok, questions: { ...ok.questions, kinds: [] } }, /出题至少要选一种题型/);
  refuses({ ...ok, questions: { ...ok.questions, kinds: ['essay'] } }, /题型只能是 quiz、multi、flashcard、open、cloze/);
  refuses({ ...ok, questions: { ...ok.questions, kinds: 'quiz' } }, /题型需为列表/);
  refuses({ ...ok, questions: { ...ok.questions, strength: 'heavy' } }, /覆盖强度需为 lean、standard 或 full/);
  refuses({ ...ok, questions: { ...ok.questions, variants: 'yes' } }, /variants 需为 true 或 false/);
  refuses({ ...ok, plan: 'weekly' }, /学习计划的设置格式不对/);
  refuses({ ...ok, plan: { make: true, by: 'daily' } }, /排计划的依据需为 exam（按考试日期）或 weekly/);
  refuses({ ...ok, plan: { make: true, by: 'weekly', chaptersPerWeek: 0 } }, /每周章数需为 1–10/);
  refuses({ ...ok, plan: { make: true, by: 'weekly', chaptersPerWeek: 11 } }, /每周章数需为 1–10/);
  refuses({ ...ok, plan: { make: true, by: 'weekly', chaptersPerWeek: 1.5 } }, /每周章数需为 1–10/);
  refuses({ ...ok, plan: { make: true, by: 'weekly', chaptersPerWeek: '2' } }, /每周章数需为 1–10/);
  refuses({ ...ok, plan: { make: true, by: 'exam', minutesPerDay: 14 } }, /每日学习分钟数需为 15–960/);
  refuses({ ...ok, plan: { make: true, by: 'exam', minutesPerDay: 961 } }, /每日学习分钟数需为 15–960/);
  assert.deepEqual(checkedCustom({ ...ok, plan: { make: true, by: 'weekly', chaptersPerWeek: 10, minutesPerDay: 960 } }).plan, { make: true, by: 'weekly', chaptersPerWeek: 10, minutesPerDay: 960 });
  assert.equal(checkedCustom(undefined), undefined);
  assert.equal(checkedCustom(null), null);
});

/* ---------- through the library: course.save {custom}, the way {plan} goes ---------- */

const COURSE = 'Networks';
async function study(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-custom-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new StudyService(root);
}

test('course.save {custom}: stored on the course record, stamped, replaced as a whole, read back by course.get, removed by null; the exam and the plan are left alone', async t => {
  const service = await study(t);
  await service.call('course.save', { name: COURSE, exam: { date: '2027-01-20' } });
  await service.call('course.save', { name: COURSE, plan: { version: 1 } });
  const saved = await service.call('course.save', { name: COURSE, custom: mine('review', { sampleFirst: false }) });
  assert.equal(saved.custom.purpose, 'review');
  assert.equal(saved.custom.sampleFirst, false);
  assert.match(saved.custom.updatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(saved.exam.date, '2027-01-20');
  assert.equal(saved.plan.version, 1);
  assert.deepEqual((await service.call('course.get', { name: COURSE })).custom, saved.custom);
  await service.call('course.save', { name: COURSE, focusTopics: ['TCP'] });
  assert.deepEqual((await service.call('course.get', { name: COURSE })).custom, saved.custom, 'saving something else leaves the 定制方案');
  const again = await service.call('course.save', { name: COURSE, custom: customDefaults('openbook') });
  assert.equal(again.custom.purpose, 'openbook');
  assert.deepEqual(again.custom.book.parts, customDefaults('openbook').book.parts);
  const removed = await service.call('course.save', { name: COURSE, custom: null });
  assert.equal('custom' in removed, false, 'custom:null removes it');
  assert.equal(removed.plan.version, 1);
});

test('course.save {custom}: a refused record is not stored, the saved one stays', async t => {
  const service = await study(t);
  await service.call('course.save', { name: COURSE, custom: mine('follow') });
  await assert.rejects(service.call('course.save', { name: COURSE, custom: { ...mine('follow'), purpose: 'later' } }), /用途需为/);
  await assert.rejects(service.call('course.save', { name: COURSE, focusTopics: ['TCP'], custom: { version: 2 } }), /version 需为 1/);
  const view = await service.call('course.get', { name: COURSE });
  assert.equal(view.custom.purpose, 'follow');
  assert.deepEqual(view.focusTopics, [], 'the refused save changed nothing else either');
});

test('merging courses keeps a 定制方案 the target does not have, like the plan', async t => {
  const service = await study(t);
  const from = await service.call('course.save', { name: 'Net 2', custom: mine('preview', { scope: { kind: 'all' } }) });
  const into = await service.call('course.save', { name: COURSE });
  assert.equal('custom' in into, false);
  const merged = await service.call('course.merge', { from: [from.id], into: into.id });
  assert.equal(merged.course.custom.purpose, 'preview');
});
