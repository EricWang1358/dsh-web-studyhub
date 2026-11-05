/* 「章节准备度」 in the 「你的定制」 card (深度定制 S5): the words and numbers of a chapter's row and of the 补齐 question are pure (ui/custom-readiness-model.js), in zh and in
   English; the card carries the list and nothing else carries it. The picture is tests/custom-readiness-browser.test.mjs. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`
  export * as model from './ui/custom-readiness-model.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const said = (language, work) => { m.setUiLanguage(language); try { return work(m.model); } finally { m.setUiLanguage('zh'); } };
const counted = { explained: true, questions: true };
const chapter = (over = {}) => ({ id: 'c1', title: 'Introduction', built: true, points: 4, explained: 4, asked: 3, drafted: 0, practised: 2, solid: 1, weak: 1, readiness: 0.25,
  quality: { sentBack: 0 }, todo: { explain: 0, questions: 1, weak: 1 }, ...over });

test('the bar is the readiness; with no questions in the plan it is how much is explained; 未生成 only when the plan asks for explanations', () => {
  assert.equal(m.model.chapterShare(chapter(), counted), 0.25);
  assert.equal(m.model.shareText(chapter(), counted), '25%');
  assert.equal(m.model.chapterShare(chapter({ readiness: null, explained: 1 }), { explained: true, questions: false }), 0.25);
  assert.equal(m.model.chapterShare(chapter({ readiness: null, points: 0, explained: 0 }), { explained: true, questions: false }), 0, 'no point, no division by zero');
  assert.equal(m.model.isUnbuilt(chapter({ built: false }), counted), true);
  assert.equal(m.model.isUnbuilt(chapter({ built: false }), { explained: false, questions: true }), false, 'the plan did not ask for a book');
  assert.equal(m.model.isUnbuilt(chapter(), counted), false);
});

test('the four counts are said in the words of the app, only the parts the plan ticked', () => {
  assert.equal(said('zh', model => model.countsLine(chapter(), counted)), '讲解 4/4 · 有题 3/4 · 练过 2/4 · 扎实 1/4');
  assert.equal(said('zh', model => model.countsLine(chapter(), { explained: false, questions: true })), '有题 3/4 · 练过 2/4 · 扎实 1/4');
  assert.equal(said('zh', model => model.countsLine(chapter(), { explained: true, questions: false })), '讲解 4/4');
  assert.equal(said('en', model => model.countsLine(chapter(), counted)), 'Explained 4/4 · With questions 3/4 · Practised 2/4 · Solid 1/4');
  assert.equal(said('zh', model => model.qualityLine(chapter({ quality: { sentBack: 2 } }))), '有 2 道题被审核退回，等着修');
  assert.equal(said('zh', model => model.qualityLine(chapter())), '');
  assert.match(said('en', model => model.solidMeaning()), /^Solid: at least half/);
});

test('补齐 is offered only where something is missing, and the question says what it would start and the rough calls, never a price', () => {
  assert.equal(m.model.hasTodo(chapter()), true);
  assert.equal(m.model.hasTodo(chapter({ todo: { explain: 0, questions: 0, weak: 0 } })), false);
  const answer = { status: 'ok', book: { points: 1 }, questions: { points: 3 }, variants: { cards: 1 }, calls: { low: 9, high: 23 } };
  assert.equal(said('zh', model => model.fillParts(answer)), '讲解 1 个知识点、出题 3 个知识点、变式 1 道错题');
  assert.equal(said('zh', model => model.fillCalls(answer)), '粗估约 9–23 次模型调用');
  assert.equal(said('zh', model => model.fillCalls({ calls: { low: 1, high: 1 } })), '粗估约 1 次模型调用');
  assert.equal(said('zh', model => model.fillParts({ questions: { points: 3 } })), '出题 3 个知识点');
  assert.match(said('zh', model => model.fillCalls({ calls: null })), /没法估/);
  assert.equal(said('en', model => model.fillParts(answer)), 'explain 1 points, write questions for 3 points, prepare variants for 1 wrong questions');
  assert.equal(said('en', model => model.fillCalls(answer)), 'Roughly 9–23 model calls');
  assert.doesNotMatch(said('zh', model => `${model.fillParts(answer)} ${model.fillCalls(answer)}`), /价|费|元|\$|¥/);
});

test('what is said after 补齐 started: a refused step first, the consent the coach asks for, that it is already running, else that it started', () => {
  assert.deepEqual(m.model.startedNotice({ started: { book: { jobId: 'b' }, questions: { error: 'No model' } } }), { text: 'No model', tone: 'error' });
  assert.equal(m.model.startedNotice({ started: { variants: { needsConsent: true } } }).tone, 'warning');
  assert.match(m.model.startedNotice({ started: { questions: { jobId: 'q' }, variants: { needsConsent: true } } }).text, /其余的已经开始/);
  assert.match(m.model.startedNotice({ started: { questions: { alreadyRunning: true } } }).text, /已经在补了/);
  assert.match(m.model.startedNotice({ started: { questions: { jobId: 'q' } } }).text, /已开始补齐/);
  assert.equal(said('en', model => model.startedNotice({ started: { questions: { jobId: 'q' } } }).text), 'Started; follow it in Jobs.');
});

test('the list lives in the 「你的定制」 card only, with Tooltips for the hover words and the finder anchor', () => {
  const card = readFileSync('ui/CustomPlanCard.jsx', 'utf8'), list = readFileSync('ui/CustomReadiness.jsx', 'utf8');
  assert.match(card, /<CustomReadiness course=\{course\} \/>/);
  assert.doesNotMatch(readFileSync('ui/CourseSettings.jsx', 'utf8'), /CustomReadiness/);
  assert.doesNotMatch(list, /\stitle=["']/, 'hover words are Tooltips, never title attributes');
  assert.match(list, /data-tour="custom-readiness"/);
  assert.match(list, /course\.custom\.fill', \{ course: course\.name, \.\.\.\(ids \? \{ chapters: ids \} : \{\}\), estimate: true \}/, 'the question is asked with an estimate that starts nothing');
});
