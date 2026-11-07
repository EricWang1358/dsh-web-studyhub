import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { CLASSROOM_METHOD, METHOD_VERSION, courseMethod, checkedMethod } from '../lib/course-method.js';
import { methodProgress } from '../lib/course-method-progress.js';
import { stageGate } from '../lib/course-method-gate.js';

/* 学法 (#775, 4.5 S1): every course has one, the default package 「课堂跟学」 until it is changed — and that package is today's behaviour said in stages, so a
   course nobody customised learns exactly as before. The record lives on the course (course.save {method}), copied there when it is attached. */

const stage = (over = {}) => ({ name: '按批练', activity: 'practice', alternatives: ['explain'], level: 'medium', ...over });

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-method-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage: { roundLimit: 8 } });
  t.after(() => service.dispose());
  return service;
}

test('the default package is today\'s flow in three stages, and a course without one gets it', () => {
  assert.equal(CLASSROOM_METHOD.version, METHOD_VERSION);
  assert.equal(CLASSROOM_METHOD.stages.length, 3);
  assert.deepEqual(CLASSROOM_METHOD.stages.map(entry => entry.activity), ['publish', 'practice', 'review']);
  assert.equal(courseMethod({ name: 'Net' }).name, '课堂跟学');
  assert.deepEqual(courseMethod(null).stages.map(entry => entry.activity), ['publish', 'practice', 'review']);
  const mine = { ...CLASSROOM_METHOD, name: '我的学法' };
  assert.equal(courseMethod({ method: mine }).name, '我的学法', 'a course that has one gets its own');
  const copy = courseMethod({ method: mine });
  copy.stages[0].name = '改了';
  assert.equal(mine.stages[0].name, '课前：导入资料', 'the copy is not the record');
  // The names are what the card and the home line show: short, and no batch sizes that the practice settings own.
  for (const entry of CLASSROOM_METHOD.stages) assert.ok(entry.name.length <= 12 && !/\d/.test(entry.name), entry.name);
});

test('a method is checked before it is stored: the sentences the chat reads out, and what null and undefined mean', () => {
  assert.equal(checkedMethod(undefined), undefined, 'not given: leave what is there');
  assert.equal(checkedMethod(null), null, 'null detaches it');
  const one = checkedMethod({ name: '期末冲刺', targetDate: '2027-01-20', stages: [stage()] });
  assert.equal(one.version, METHOD_VERSION);
  assert.equal(one.targetDate, '2027-01-20');
  assert.deepEqual(one.stages[0].alternatives, ['explain']);
  const why = fn => { try { fn(); return ''; } catch (error) { return String(error.message); } };
  assert.match(why(() => checkedMethod({ stages: [] })), /1–12 个阶段/);
  assert.match(why(() => checkedMethod({ stages: [stage({ activity: 'nap' })] })), /主活动需为/);
  assert.match(why(() => checkedMethod({ stages: [stage({ level: 'hard' })] })), /过关宽严需为/);
  assert.match(why(() => checkedMethod({ stages: [stage({ alternatives: ['explain', 'check', 'review'] })] })), /最多 2 个/);
  assert.match(why(() => checkedMethod({ stages: [stage({ alternatives: ['practice'] })] })), /不能与主活动相同/);
  assert.match(why(() => checkedMethod({ stages: [stage({ name: '  ' })] })), /名称需为/);
  assert.match(why(() => checkedMethod({ targetDate: '20-01-2027', stages: [stage()] })), /目标日期/);
  assert.equal(checkedMethod({ stages: [stage()] }).name, '课堂跟学', 'a method without a name is the default one named');
});

test('course.save keeps the method on that course alone and course.save {null} detaches it', async t => {
  const service = await library(t);
  const mine = { name: '期末冲刺', targetDate: '2027-01-20', stages: [stage({ name: '只练错题', activity: 'review' })] };
  await service.call('course.save', { name: 'Net', method: mine });
  const read = async name => { const got = await service.call('course.get', { name }); return got?.course ?? got; };
  const one = await read('Net');
  assert.equal(one.method.name, '期末冲刺');
  assert.deepEqual(one.method.stages.map(entry => entry.name), ['只练错题']);
  assert.ok(one.method.updatedAt, 'a stored method is stamped');
  await service.call('course.save', { name: 'Other' });
  const other = await read('Other');
  assert.equal(other.method, undefined, 'another course is untouched, and has no method of its own');
  assert.equal(courseMethod(other).name, '课堂跟学', 'which means the default package');
  await service.call('course.save', { name: 'Net', method: null });
  assert.equal((await read('Net')).method, undefined, 'null detaches it');
  await assert.rejects(service.call('course.save', { name: 'Net', method: { stages: [stage({ activity: 'nap' })] } }), /主活动需为/);
});


/* The card on the course settings (#775 S1): the default package is drawn as it is, a course's own method with its stages, and the English carries no Han. */
const m = await loadUi(`
  export { default as CourseMethodCard, MethodForm, checkLine, shownMethod } from './ui/CourseMethodCard.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const draw = (course, language = 'zh') => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(m, h(m.CourseMethodCard, { course }), { call: async () => ({}) })); } finally { m.setUiLanguage('zh'); }
};

test('the card reads first: the default package is its name and three short stages, no form, and the change is behind 改学法', () => {
  const html = draw({ id: 'course-net', name: 'Net' }), plain = text(html);
  assert.match(plain, /学法 课堂跟学 默认/);
  for (const stage of CLASSROOM_METHOD.stages) assert.ok(plain.includes(stage.name), `${stage.name} is a stage of the card`);
  assert.doesNotMatch(html, /<input/, 'a course nobody customised is a few lines to read, not a form to fill in');
  assert.match(plain, /改学法/);
  assert.doesNotMatch(plain, /保存学法|恢复默认学法/, 'saving and going back are in the form');
  assert.doesNotMatch(plain, /想改就说一声/, 'the card says how to change it: the button, or the main chat');
  assert.match(html, /aria-label="学法是什么"/, 'what a method is: a 「?」, not a paragraph');
  const ownHtml = draw({ id: 'course-net', name: 'Net', method: { ...CLASSROOM_METHOD, name: '我的学法', targetDate: '2027-01-20', stages: [{ ...CLASSROOM_METHOD.stages[0], name: '只练错题' }] } }), own = text(ownHtml);
  assert.match(own, /学法 我的学法/);
  assert.doesNotMatch(own, /默认 /, 'a course\'s own method is not called the default');
  assert.match(own, /只练错题/);
  assert.match(own, /目标日期：2027-01-20/);
  const english = text(draw({ id: 'course-net', name: 'Net' }, 'en'));
  assert.match(english, /Learning method/);
  assert.doesNotMatch(english, /[㐀-鿿]/, 'the card is translated too');
});

test('a draft started from the default package is in the learner\'s language, and the form offers the way back only for a course\'s own method', () => {
  m.setUiLanguage('en');
  let english;
  try { english = m.shownMethod({ id: 'course-net', name: 'Net' }); } finally { m.setUiLanguage('zh'); }
  assert.doesNotMatch(JSON.stringify(english.stages.map(stage => stage.name)), /[㐀-鿿]/, 'editing one stage in English keeps the others English');
  const own = { id: 'course-net', name: 'Net', method: { ...CLASSROOM_METHOD, name: 'Mine', stages: [{ ...CLASSROOM_METHOD.stages[0], name: '只练错题' }] } };
  assert.equal(m.shownMethod(own).stages[0].name, '只练错题', 'a learner\'s own words are kept as typed');
  const form = (draft, isOwn, language = 'zh') => {
    m.setUiLanguage(language);
    try { return renderToStaticMarkup(inApp(m, h(m.MethodForm, { draft, own: isOwn, disabled: false, working: false, onChange() {}, onStage() {}, onSave() {}, onCancel() {}, onReset() {} }), { call: async () => ({}) })); }
    finally { m.setUiLanguage('zh'); }
  };
  const fresh = text(form(m.shownMethod({ name: 'Net' }), false));
  assert.match(fresh, /学法名称/);
  assert.match(fresh, /第 3 个阶段/);
  assert.match(fresh, /保存学法 取消/);
  assert.doesNotMatch(fresh, /恢复默认学法/, 'nothing to go back to: the default package');
  assert.match(text(form(m.shownMethod(own), true)), /恢复默认学法/);
  assert.equal((form(m.shownMethod({ name: 'Net' }), false).match(/aria-label="过关宽严是什么"/g) || []).length, 1, 'what the gates mean is said once');
  assert.doesNotMatch(text(form(m.shownMethod({ name: 'Net' }), false, 'en')), /[㐀-鿿]/, 'the form is translated too');
});


/* Where the learner is in the method (#775 S1b): read from what the library holds, no model call — publish while there is no material, practise while a
   question has never been answered, review once every one has. */
test('the current stage is read from the library: publish, then practise, then review', () => {
  const COURSE = 'Net';
  const base = { courses: [{ id: 'course-net', name: COURSE }], sources: [], decks: [], attempts: [] };
  const at = state => methodProgress(state, COURSE);
  assert.equal(at(base).index, 0, 'nothing published yet');
  assert.equal(at(base).total, 3);
  const material = { ...base, sources: [{ id: 's1', courses: [COURSE], text: 'A material with text. '.repeat(20) }] };
  assert.equal(at(material).index, 1, 'a material but nothing to practise yet');
  const cards = { ...material, decks: [{ id: 'd1', course: COURSE, cards: [{ id: 'k1', prompt: 'What is it?', answer: 'x' }, { id: 'k2', prompt: 'And?', answer: 'y' }] }] };
  assert.equal(at(cards).index, 1, 'questions nobody answered yet');
  const first = { ...cards, attempts: [{ deckId: 'd1', quiz_id: 'k1', grade: 4, at: '2026-11-01T10:00:00.000Z' }] };
  assert.equal(at(first).index, 1, 'one of the two answered: still practising');
  const all = { ...cards, attempts: [{ deckId: 'd1', quiz_id: 'k1', grade: 4, at: '2026-11-01T10:00:00.000Z' }, { deckId: 'd1', quiz_id: 'k2', grade: 3, at: '2026-11-01T10:01:00.000Z' }] };
  assert.equal(at(all).index, 2, 'every question practised at least once: review is where it rests');
  assert.equal(at(all).stage.activity, 'review');
  assert.match(at(all).stage.name, /考前/);
  // A course with its own method is measured by its own stages, in its own order.
  const own = { ...material, courses: [{ id: 'course-net', name: COURSE, method: { name: '我的', stages: [{ name: '先讲一遍', activity: 'explain' }, { name: '再练', activity: 'practice' }] } }] };
  assert.equal(at(own).index, 0, 'an activity nothing measures is never skipped over');
});

test('a wrong answer graded 0 is still an answer: the stage moves on once every question has one', () => {
  const COURSE = 'Net';
  const state = { courses: [{ id: 'course-net', name: COURSE }], sources: [{ id: 's1', courses: [COURSE], text: 'Text.' }],
    decks: [{ id: 'd1', course: COURSE, cards: [{ id: 'k1', prompt: 'p', answer: 'a' }] }], attempts: [{ deckId: 'd1', quiz_id: 'k1', grade: 0 }] };
  assert.equal(methodProgress(state, COURSE).counts.answered, 1);
  assert.equal(methodProgress(state, COURSE).index, 2);
});

test('the home snapshot carries the current course\'s stage, and no new operation is listed for it', async t => {
  const service = await library(t);
  await service.call('course.save', { name: 'Net' });
  await service.store.update(state => {
    state.decks.push({ id: 'd1', title: 'Net basics', course: 'Net', createdAt: '2026-11-01T00:00:00Z', cards: [{ id: 'k1', kind: 'flashcard', prompt: 'p', answer: 'a' }] });
    state.focus = { mode: 'class', course: 'Net', role: '', jd: '', targetTopics: [] };
  });
  const snapshot = await service.call('snapshot', { compact: true });
  assert.equal(snapshot.focus.method.course, 'Net');
  assert.equal(snapshot.focus.method.index, 0, 'nothing imported yet');
  assert.equal(snapshot.focus.method.total, 3);
  assert.equal(snapshot.focus.method.own, false, 'the default package: its words come from the catalogue');
  assert.deepEqual(snapshot.focus.method.counts, { materials: 0, cards: 1, answered: 0 });
  // The library listing the host shows the chat is capped (tests/course-book-structure.test.mjs): the stage rides on the snapshot, not on an operation of its own.
  assert.equal(service.runtime.hasAction('course.method.progress'), false);
});

test('the card marks the stage the learner is on, only when the readout is about these stages', () => {
  const marked = (readout, course = { id: 'course-net', name: 'Net' }) => {
    try { return renderToStaticMarkup(inApp(m, h(m.CourseMethodCard, { course, readout }), { call: async () => ({}) })); } finally { m.setUiLanguage('zh'); }
  };
  const html = marked({ index: 1, total: 3, own: false });
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  assert.match(text(html), /课后：出题，按批练习 适中 现在/);
  assert.doesNotMatch(marked(null), /aria-current/, 'another course\'s card: no readout, no mark');
  assert.doesNotMatch(marked({ index: 1, total: 5 }), /aria-current/, 'a readout of other stages is not drawn on these');
});


/* 阶段检验 (#777 S3a): the stage's check rests on the course's existing questions and the learner's answers — at the default gate (适中) about two thirds
   passes the check and four fifths suggests going on; 松一点 counts answers, 严格一点 asks for all. Nothing is generated to test with. */
test('the stage check counts what the learner answered: two thirds passes it, four fifths suggests the next stage', () => {
  const COURSE = 'Net';
  const cards = n => Array.from({ length: n }, (_, i) => ({ id: 'k' + i, prompt: 'p' + i, answer: 'a' }));
  const state = (total, right) => ({
    // A method whose first stage nothing measures, at the default gate 适中: the course stays on it, and its check is what is read.
    courses: [{ id: 'course-net', name: COURSE, method: { name: 'Mine', stages: [{ name: 'A', activity: 'explain', level: 'medium' }, { name: 'B', activity: 'review' }] } }],
    sources: [],
    decks: total ? [{ id: 'd1', course: COURSE, cards: cards(total) }] : [],
    attempts: cards(right).map(card => ({ deckId: 'd1', quiz_id: card.id, grade: 4 })),
  });
  const none = stageGate(state(0, 0), COURSE);
  assert.equal(none.total, 0);
  assert.equal(none.ready, false);
  assert.equal(none.checkPassed, false, 'no questions: nothing is called passed');
  const half = stageGate(state(12, 6), COURSE);
  assert.equal(half.checkPassed, false, 'half is not the two thirds the check asks for');
  const twoThirds = stageGate(state(12, 8), COURSE);
  assert.equal(twoThirds.checkPassed, true);
  assert.equal(twoThirds.ready, false, 'two thirds passes the check, it does not suggest going on');
  assert.equal(twoThirds.basis, 'cards');
  const ready = stageGate(state(10, 8), COURSE);
  assert.equal(ready.ready, true, 'four fifths suggests the next stage');
  // A weak last answer is not a pass, and an unanswered question still counts as one to do.
  const weak = { ...state(4, 0), attempts: [{ deckId: 'd1', quiz_id: 'k0', grade: 2 }, { deckId: 'd1', quiz_id: 'k1', grade: 4 }] };
  assert.deepEqual([stageGate(weak, COURSE).total, stageGate(weak, COURSE).passed], [4, 1]);
});

test('the gate is the stage\'s own: 松 counts answers, 中 counts right answers, 严 asks for all of them; the last stage suggests nothing further', () => {
  const COURSE = 'Net';
  const cards = n => Array.from({ length: n }, (_, i) => ({ id: 'k' + i, prompt: 'p' + i, answer: 'a' }));
  const withLevel = level => ({
    courses: [{ id: 'course-net', name: COURSE, method: { name: 'Mine', stages: [{ name: 'A', activity: 'explain', level }, { name: 'B', activity: 'review', level }] } }],
    sources: [], decks: [{ id: 'd1', course: COURSE, cards: cards(10) }],
    // eight answered: six right (grade 4), two wrong (grade 1)
    attempts: cards(8).map((card, i) => ({ deckId: 'd1', quiz_id: card.id, grade: i < 6 ? 4 : 1 })),
  });
  const loose = stageGate(withLevel('loose'), COURSE);
  assert.deepEqual([loose.level, loose.counts, loose.passed, loose.ready], ['loose', 'answered', 8, true], '松一点: eight of ten answered is enough');
  const medium = stageGate(withLevel('medium'), COURSE);
  assert.deepEqual([medium.counts, medium.passed, medium.checkPassed, medium.ready, medium.toReady], ['right', 6, false, false, 2], '适中: six right of ten, two more for four fifths');
  const strict = stageGate({ ...withLevel('strict'), attempts: cards(10).map(card => ({ deckId: 'd1', quiz_id: card.id, grade: card.id === 'k9' ? 2 : 4 })) }, COURSE);
  assert.deepEqual([strict.passed, strict.checkPassed, strict.ready, strict.toReady], [9, false, false, 1], '严格一点: nine of ten is not all');
  // The last stage has no next one to suggest, however well it is answered.
  const last = stageGate(withLevel('loose'), COURSE, { index: 1, total: 2, stage: { name: 'B', activity: 'review', level: 'loose' } });
  assert.equal(last.last, true);
  assert.equal(last.ready, false, 'no next stage, no suggestion');
});

test('the home snapshot carries the stage\'s check with the stage, and no operation is listed for it', async t => {
  const service = await library(t);
  await service.call('course.save', { name: 'Net' });
  await service.store.update(state => {
    state.decks.push({ id: 'd1', title: 'Net basics', course: 'Net', createdAt: '2026-11-01T00:00:00Z', cards: [{ id: 'k1', kind: 'flashcard', prompt: 'p', answer: 'a' }] });
    state.focus = { mode: 'class', course: 'Net', role: '', jd: '', targetTopics: [] };
  });
  const { focus } = await service.call('snapshot', { compact: true });
  assert.deepEqual([focus.method.gate.total, focus.method.gate.passed, focus.method.gate.ready, focus.method.gate.basis], [1, 0, false, 'cards']);
  assert.equal(focus.method.gate.stage.activity, 'publish', 'the check is of the stage the learner is on');
  assert.equal(service.runtime.hasAction('course.method.gate'), false);
});

test('the card says how the stage\'s check stands in one sentence with the gate\'s own count, and nothing about a next stage on the last one', () => {
  const gate = over => ({ stage: { activity: 'explain' }, counts: 'right', total: 10, passed: 6, toReady: 2, ready: false, last: false, ...over });
  assert.equal(m.checkLine(gate()), '这一阶段：10 道里答对 6 道，再答对 2 道就够进下一阶段。');
  assert.equal(m.checkLine(gate({ passed: 8, toReady: 0, ready: true })), '这一阶段：10 道里答对 8 道，够进下一阶段了。');
  assert.equal(m.checkLine(gate({ counts: 'answered', passed: 7, toReady: 1 })), '这一阶段：10 道里答过 7 道，再答 1 道就够进下一阶段。', '松一点 counts answers');
  assert.equal(m.checkLine(gate({ last: true, passed: 10 })), '这一阶段：10 道里答对 10 道。', 'the last stage: no next stage');
  assert.equal(m.checkLine(gate({ total: 0, passed: 0 })), '这一阶段还没有题，出了题才有检验。');
  assert.equal(m.checkLine(gate({ stage: { activity: 'publish' } })), '', 'importing material is not checked by questions');
  assert.doesNotMatch(m.checkLine(gate()), /四分之三|三分之二/, 'one number: the count, not a share that disagrees with the gate');
  m.setUiLanguage('en');
  try { assert.equal(m.checkLine(gate()), 'This stage: 6 of 10 right; 2 more right and it is enough for the next stage.'); } finally { m.setUiLanguage('zh'); }
  const html = renderToStaticMarkup(inApp(m, h(m.CourseMethodCard, { course: { id: 'course-net', name: 'Net' }, readout: { index: 1, total: 3, gate: gate() } }), { call: async () => ({}) }));
  assert.match(text(html), /再答对 2 道就够进下一阶段/);
});
