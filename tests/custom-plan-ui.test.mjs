/* 「你的定制」 on the course settings (深度定制, 4.4 S0): a compact card when the course has a 定制方案 (a sentence that says it, the rough cost in calls and tokens, never a
   price, and one toggle for each part of the book, for the questions, the variants and the plan, each saved through course.save {custom}); no card when the
   course has none. The sentence and the toggles' effects are pure (ui/custom-plan-model.js); the card draws them. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { checkedCustom, customDefaults } from '../lib/custom-plan.js';

const m = await loadUi(`
  export { default as CourseSettings } from './ui/CourseSettings.jsx';
  export { default as CustomPlanCard } from './ui/CustomPlanCard.jsx';
  export * as model from './ui/custom-plan-model.js';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const visible = markup => text(markup.replace(/<span id="[^"]*" role="tooltip"[^>]*>[^<]*<\/span>/g, ''));
const say = (custom, language = 'zh') => { m.setUiLanguage(language); try { return m.model.customSummary(custom); } finally { m.setUiLanguage('zh'); } };
const mine = (purpose, over = {}) => checkedCustom({ ...customDefaults(purpose), scope: { kind: 'all' }, ...over });
const chapters = (...numbers) => ({ kind: 'chapters', chapters: numbers.map(n => `pdf:abc#${n - 1}`) });

test('the sentence says the purpose, the chapters, the book, the questions and the plan, in the words of the rest of the app', () => {
  const custom = mine('review', { scope: chapters(3, 4, 5, 6, 7, 8, 9), book: { make: true, coverage: 'standard', parts: ['explain', 'terms', 'cheatSheet'] },
    questions: { make: true, kinds: ['quiz', 'cloze'], strength: 'standard', variants: false } });
  assert.equal(say(custom), '期末复习 · 第 3–9 章 · 讲解标准 + 术语卡 + 速查表 · 选择和填空 · 按考试日期排计划');
  assert.equal(say(mine('preview', { scope: chapters(2) })), '课前预习 · 第 2 章 · 讲解精简 + 术语卡 · 选择和填空 · 每周 1 章排计划');
  assert.equal(say(mine('follow', { scope: chapters(1, 3, 7) })).split(' · ')[1], '第 1、3、7 章');
  assert.equal(say(mine('follow', { scope: chapters(1, 2, 3, 4, 5, 6, 8) })).split(' · ')[1], '7 章', 'many scattered chapters are counted, not listed');
  assert.equal(say(mine('openbook')).split(' · ')[1], '全部章节');
  assert.equal(say(mine('review', { scope: { kind: 'exam' } })).split(' · ')[1], '考试范围');
  assert.equal(say(mine('review', { scope: { kind: 'chapters', chapters: ['pdf:a#1', 'pdf:b#2'] } })).split(' · ')[1], '2 章', 'chapters of two materials are counted');
  assert.equal(say(mine('review', { scope: { kind: 'chapters', chapters: ['doc:note'] } })).split(' · ')[1], '1 章');
});

test('what is off is said as off; every kind is said as "各种题型"; the kinds are joined in words', () => {
  const off = mine('review', { book: { make: false }, questions: { make: false }, plan: { make: false } });
  assert.equal(say(off), '期末复习 · 全部章节 · 不做复习全书 · 不出题 · 不排计划');
  const custom = mine('review');
  assert.match(say(custom), /各种题型/);
  assert.match(say({ ...custom, questions: { ...custom.questions, kinds: ['quiz', 'multi', 'cloze'] } }), / · 选择和填空 · /);
  assert.match(say({ ...custom, questions: { ...custom.questions, kinds: ['quiz', 'flashcard', 'open'] } }), / · 选择、闪卡和开放问答 · /);
  assert.match(say({ ...custom, questions: { ...custom.questions, kinds: ['open'] } }), / · 开放问答 · /);
  assert.match(say(mine('openbook', { book: { make: true, coverage: 'brief', parts: ['answerKit'] } })), / · 答题模板 · /, 'no explanation, no 讲解 word');
});

test('in English the same sentence is built from the catalogue', () => {
  const english = say(mine('review', { scope: chapters(3, 4, 5, 6, 7, 8, 9), book: { make: true, coverage: 'standard', parts: ['explain', 'terms', 'cheatSheet'] },
    questions: { make: true, kinds: ['quiz', 'cloze'], strength: 'standard', variants: false } }), 'en');
  assert.doesNotMatch(english, /[一-鿿]/, english);
  assert.match(english, /^Final review · Chapters 3–9 · Explanations: Standard \+ Term cards \+ Cheat sheet · /);
});

test('toggling a part keeps the rules of the parts: what it rests on comes with it, what rests on it goes with it, the last one off turns the book off', () => {
  const base = mine('review', { book: { make: true, coverage: 'standard', parts: ['explain', 'terms'] } });
  const withPairs = m.model.togglePart(base, 'confusables');
  assert.deepEqual(withPairs.book.parts, ['explain', 'terms', 'confusables']);
  assert.deepEqual(m.model.togglePart(withPairs, 'confusables').book.parts, ['explain', 'terms']);
  assert.deepEqual(m.model.togglePart(base, 'cheatSheet').book.parts, ['explain', 'terms', 'cheatSheet']);
  const kitOnly = mine('review', { book: { make: true, coverage: 'standard', parts: ['answerKit'] } });
  const none = m.model.togglePart(kitOnly, 'answerKit');
  assert.deepEqual(none.book, { make: false, coverage: 'standard', parts: [] });
  assert.equal(m.model.togglePart(none, 'terms').book.make, true, 'ticking a part makes the book again');
  for (const custom of [withPairs, none, m.model.togglePart(none, 'terms')]) assert.doesNotThrow(() => checkedCustom(custom));
  assert.deepEqual([...m.model.lockedPartIds(withPairs)].sort(), ['explain', 'terms'], 'a part something ticked rests on cannot be turned off');
});

test('the other toggles change only their own switch, and a question switch turned on again has its kinds back', () => {
  const base = mine('review');
  assert.equal(m.model.setQuestions(base, false).questions.make, false);
  assert.deepEqual(m.model.setQuestions(base, false).questions.kinds, base.questions.kinds, 'the ticks survive the off switch');
  const empty = checkedCustom({ ...base, questions: { make: false } });
  assert.deepEqual(m.model.setQuestions(empty, true).questions.kinds, customDefaults('review').questions.kinds, 'but a record that has none gets the purpose\'s own');
  assert.equal(m.model.setVariants(base, false).questions.variants, false);
  assert.equal(m.model.setPlan(base, false).plan.make, false);
  assert.equal(m.model.setPlan(m.model.setPlan(base, false), true).plan.make, true);
  assert.deepEqual(m.model.setPlan(base, false).book, base.book);
});

test('the estimate line is calls and tokens, roughly, with no price', () => {
  m.setUiLanguage('zh');
  const line = m.model.estimateLine({ total: { calls: 368, readTokens: 182306 }, rough: true });
  assert.equal(line, '粗估：约 368 次模型调用，读取约 182K tok');
  assert.equal(m.model.estimateLine({ total: { calls: 0, readTokens: 0 }, rough: false }), '不需要模型调用');
  assert.equal(m.model.estimateLine(null), '');
  assert.doesNotMatch(line, /价|费|元|\$|¥/);
});

const course = custom => ({ id: 'course-net', name: 'Net', aliases: [], guidanceSourceIds: [], focusTopics: [], decks: 0, sources: 0, ...(custom ? { custom } : {}) });
const estimate = { status: 'ok', estimate: { book: { points: 10, calls: 30, readTokens: 1000 }, questions: { count: 20, calls: 16, readTokens: 500 }, total: { calls: 46, readTokens: 1500 }, rough: true } };
const draw = (element, language = 'zh', services = {}) => { m.setUiLanguage(language); try { return renderToStaticMarkup(inApp(m, element, { call: async () => estimate, ...services })); } finally { m.setUiLanguage('zh'); } };

test('the card shows the sentence and one toggle per part, for the questions, the variants and the plan; the parts something rests on are locked', () => {
  const html = draw(h(m.CustomPlanCard, { course: course(mine('review', { book: { make: true, coverage: 'standard', parts: ['explain', 'terms', 'confusables'] } })) }));
  const words = visible(html);
  assert.match(words, /你的定制/);
  assert.match(words, /期末复习 · 全部章节 · 讲解标准 \+ 术语卡 \+ 易混对照 · 各种题型 · 按考试日期排计划/);
  for (const part of ['讲解', '术语卡', '公式页', '索引', '易混对照', '答题模板', '速查表']) assert.ok(words.includes(part), part);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 3, 'three parts are on');
  assert.equal((html.match(/aria-pressed="false"/g) || []).length, 4);
  assert.equal((html.match(/role="switch"/g) || []).length, 3, '出题, 变式题, 学习计划');
  assert.match(html, /role="switch"[^>]*checked/, 'switches that are on are checked');
  assert.doesNotMatch(html, /\btitle="/, 'hover words are Tooltips, not title attributes');
  assert.match(html, /disabled=""[^>]*>[^<]*<\/button>|<button[^>]*disabled=""/, 'the locked parts are disabled');
});

test('no card without a 定制方案; the variants switch is off when the questions are off', () => {
  assert.equal(draw(h(m.CustomPlanCard, { course: course(null) })), '');
  const html = draw(h(m.CustomPlanCard, { course: course(mine('review', { questions: { make: false } })) }));
  assert.match(visible(html), /不出题/);
  assert.match(html, /<input[^>]*role="switch"[^>]*disabled=""[^>]*>|<input[^>]*disabled=""[^>]*role="switch"/, 'a switch that cannot apply is disabled');
});

test('the course settings carry the card only for a course that has one, above the fold of the rest', () => {
  const source = readFileSync('ui/CourseSettings.jsx', 'utf8');
  assert.match(source, /<CustomPlanCard course=\{course\} \/>/);
  assert.ok(source.indexOf('<CustomPlanCard') < source.indexOf('<Disclosure className="course-settings__more"'), 'in the open, not in the fold');
  const withCustom = course(mine('review')), data = { root: '/lib', sources: [], focus: { course: 'Net', courses: [{ name: 'Net' }] } };
  const shown = draw(h(m.CourseSettings, { data: { ...data, courses: [withCustom] }, courseId: 'course-net', onClose() {} }));
  assert.match(text(shown), /你的定制/);
  const plain = draw(h(m.CourseSettings, { data: { ...data, courses: [course(null)] }, courseId: 'course-net', onClose() {} }));
  assert.doesNotMatch(text(plain), /你的定制/);
});

test('a toggle is saved as the whole record through course.save, by id, the way the course settings save', () => {
  const base = mine('review'), next = m.model.setPlan(base, false);
  assert.deepEqual(m.model.saveArgs(course(base), next), { id: 'course-net', name: 'Net', custom: next });
  assert.doesNotThrow(() => checkedCustom(m.model.saveArgs(course(base), next).custom));
});
