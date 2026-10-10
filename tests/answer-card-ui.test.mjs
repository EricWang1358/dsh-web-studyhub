/* 复习全书 M5 on the page (static zh and en): the feedback of a graded case question shows its 分析题答案卡 in its parts instead of the plain reference
   answer, each unfound quote marked 未核实, the marks map, the state (已核对 / 部分未核对 / 被改过) with 「已核对 ≠ 答案正确」; without a card the
   reference answer as before and 「生成答题卡」, or the shared model gate (its own feature key) without a model. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { loadUi } from './helpers/ui-module.mjs';
import { CASE_TYPES } from '../lib/case-types.js';
import { answerCardBasis, answerCardState, checkAnswerCard, finishAnswerCard, normalizeAnswerCard } from '../lib/answer-card.js';
import { MATERIAL, SCENARIO, caseCard, criteria, goodCard } from './helpers/answer-card-library.mjs';

const ui = await loadUi(`
  export { default as AnswerCardSection, AnswerCardView } from './ui/AnswerCard.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({ followupIds: [], answerCardIds: [], courses: [] }), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {},
  openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

const made = raw => {
  const card = caseCard();
  const answerCard = finishAnswerCard(checkAnswerCard(normalizeAnswerCard(raw, { types: CASE_TYPES, language: 'en' }), { stem: [{ id: 'prompt', text: card.prompt }, { id: 'case', text: SCENARIO }],
    materials: [{ id: 'mat1', ref: 'M1', title: 'Lecture 4 · Availability', text: MATERIAL }], criteria: criteria(), numbers: ['yearly downtime = (1 - A) x 8760 h'] }), { review: { ran: true, issues: [], repaired: false }, basis: answerCardBasis(card) });
  return { ...answerCard, state: answerCardState({ ...card, answerCard }) };
};
const ready = { model: { ready: true } };
const runWith = (solution, data = ready) => render(h(ui.AnswerCardSection, { run: { id: 'r1', deckId: 'case1', card: { id: 'q1' }, solution }, data, onSetupModel: noop }));

test('a question with an answer card: every part in order, the state and the notice, 未核实 where a quote was not found, the marks map', () => {
  const card = made({ ...goodCard(), facts: [...goodCard().facts, { text: 'Bookings stop', quote: 'A sentence that is in neither the question nor the case.' }] });
  const html = runWith({ answer: 'The reference answer.', answerCard: card }), text = textOf(html);
  assert.match(html, /data-answer-card="partial"/);
  assert.match(text, /答题卡 Availability 部分未核对/);
  assert.match(text, /已核对 ≠ 答案正确/);
  assert.match(text, /引文 4\/5 已在原文找到 · 评分点 3\/3/);
  const labels = [...html.matchAll(/<h4 class="answer-card__label">([^<]+)<\/h4>/g)].map(match => match[1]);
  assert.deepEqual(labels, ['识别信号', '题干事实', '概念', '假设', '推理链', '结论', '为什么满足目标', '代价与失败处理', '如何验证', '易错检查', '评分点对照'], 'the parts in the answer order');
  assert.equal((html.match(/answer-card__unverified/g) || []).length, 1, 'one 未核实');
  assert.match(text, /A sentence that is in neither the question nor the case\. 未核实/);
  assert.match(text, /（资料：Lecture 4 · Availability） Availability is the proportion of time/);
  assert.match(text, /Calculation · c1\.k1 2 One server/);
  assert.match(text, /原来的参考答案 The reference answer\./, 'the old answer stays, folded');
  assert.doesNotMatch(html, /data-answer-card-generate/, 'no 生成 button for a card that is there');
  const verified = textOf(runWith({ answer: 'x', answerCard: made(goodCard()) }));
  assert.match(verified, /答题卡 Availability 已核对/);
  const edited = runWith({ answer: 'x', answerCard: { ...made(goodCard()), state: 'edited' } });
  assert.match(textOf(edited), /被改过.*在答题卡生成后改过/);
  assert.match(edited, /data-answer-card-generate="again"/, '重新生成 for a changed question');
});

test('a question without one: the reference answer as before and 「生成答题卡」; without a model the gate with its own words', () => {
  const html = runWith({ answer: 'The reference answer.' }), text = textOf(html);
  assert.match(text, /参考答案（批改后揭晓） The reference answer\./);
  assert.match(html, /data-answer-card-generate="new"[^>]*>[\s\S]*生成答题卡/);
  assert.doesNotMatch(html, /data-answer-card=/);
  const off = textOf(runWith({ answer: 'x' }, { model: { ready: false, reason: 'no-route' } }));
  assert.match(off, /生成答题卡需要先配置模型|参考答案照常能看/);
});

test('English: the page\'s own words', () => english(() => {
  const html = runWith({ answer: 'The reference answer.', answerCard: made(goodCard()) }) + runWith({ answer: 'x' });
  const own = textOf(html).replace(/可用性/g, '');
  assert.equal(han.test(own), false, own);
  assert.match(textOf(html), /Answer card Availability Checked/);
  assert.match(textOf(html), /Checked ≠ correct/);
  assert.match(textOf(html), /Generate answer card/);
}));

test('the gate\'s feature key is the answer card\'s own; the case feedback uses the section', async () => {
  const gate = await readFile(new URL('../ui/ModelSetupGate.jsx', import.meta.url), 'utf8');
  assert.equal((gate.match(/^\s+answerCard: \(\) => \(\{/gm) || []).length, 1);
  const workspace = await readFile(new URL('../ui/CaseWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(workspace, /<AnswerCardSection run=\{run\} data=\{data\} onSetupModel=\{onSetupModel\} \/>/);
});
