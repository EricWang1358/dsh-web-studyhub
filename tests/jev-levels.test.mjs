import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { cognitiveLevel } from '../lib/coach.js';
import { saveJevSettings } from '../lib/jev-settings.js';
import { createJevRuntime } from '../lib/jev-runtime.js';
import { createJevUsage } from '../lib/jev-usage.js';
import { LEVEL_LABELS, buildLevelRequest, checkLevels, sampleCards, summarize } from '../lib/jev-levels.js';
import { startFakeJev } from './helpers/fake-jev.mjs';

/* 题目认知层次: Jev's reading of a question (recall / concept discrimination / application) next to the code's keyword heuristic that the
   本轮小结 uses. A CROSS-CHECK only: agreement and disagreement counts in the developer panel; nothing replaces the heuristic and nothing is stored. */

const han = /[㐀-鿿]/;
const card = (id, prompt, extra = {}) => ({ id, kind: 'flashcard', topic: 'T', objective: `O${id}`, prompt, answer: 'A', ...extra });
const cards = [
  card('r1', 'Memento 是什么？'),                                   // heuristic: recall
  card('c1', 'Caretaker 和 Memento 的区别？'),                      // concept
  card('a1', '某团队在设计撤销功能时应该怎么划分职责？'),           // apply
  card('a2', 'Given a payment service, which would you choose?'),    // apply
  card('c2', 'Why does the cache need invalidation?'),               // concept (why)
];
/** Jev's view, by id: agrees on r1, c1, a1; disagrees on a2 (says concept) and is unsure on c2. */
const jevSays = { r1: ['recall', 0.93], c1: ['concept', 0.9], a1: ['apply', 0.88], a2: ['concept', 0.85], c2: ['apply', 0.5] };
const answerFor = (name, question, state) => {
  const [pick, top] = jevSays[Object.entries({ c1: 'Caretaker', r1: '是什么', a1: '某团队', a2: 'payment', c2: 'cache' }).find(([, word]) => state.question.includes(word))[0]];
  const keys = Object.keys(question.criteria), rest = (1 - top) / (keys.length - 1);
  return { type: 'choice', choice: pick, confidence: 0.5, probabilities: Object.fromEntries(keys.map(key => [key, key === pick ? top : rest])) };
};

async function harness(t, serverOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-levels-'));
  const before = { DSH_HOME: process.env.DSH_HOME, JEV_API_KEY: process.env.JEV_API_KEY, JEV_BASE_URL: process.env.JEV_BASE_URL };
  process.env.DSH_HOME = home; delete process.env.JEV_API_KEY; delete process.env.JEV_BASE_URL;
  const fake = await startFakeJev({ answer: answerFor, ...serverOptions });
  const runtime = createJevRuntime({ baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0, usage: createJevUsage() });
  t.after(async () => { await fake.close(); for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; await rm(home, { recursive: true, force: true }); });
  return { fake, runtime, open: () => saveJevSettings({ key: fake.key, confirm: true, enabled: true, features: { levelCheck: true } }) };
}

test('the heuristic of the 本轮小结 is what the fixture says it is', () => {
  assert.deepEqual(cards.map(item => cognitiveLevel(item)), ['recall', 'concept', 'apply', 'apply', 'concept']);
});

test('one choice question per card with the three levels described; the question, options and answer are what is sent', () => {
  assert.deepEqual(Object.keys(LEVEL_LABELS), ['recall', 'concept', 'apply']);
  const request = buildLevelRequest(card('x', 'Which?', { kind: 'quiz', options: [{ id: 'a', text: 'First', correct: true }, { id: 'b', text: 'Second', correct: false }], answer: 'First' }));
  assert.deepEqual(Object.keys(request.questions), ['level']);
  assert.deepEqual(Object.keys(request.questions.level.criteria), ['recall', 'concept', 'apply']);
  assert.deepEqual(request.state, { question: 'Which?', kind: 'quiz', options: ['First', 'Second'], answer: 'First' });
});

test('the cards to ask about: all of them, or an even spread when there are more than the limit', () => {
  assert.equal(sampleCards(cards, 10).length, 5);
  const many = Array.from({ length: 100 }, (_, index) => card(`m${index}`, `Q${index}`));
  const picked = sampleCards(many, 10);
  assert.equal(picked.length, 10);
  assert.equal(picked[0].id, 'm0');
  assert.ok(picked.at(-1).id !== 'm9', 'spread over the whole list, not just the first ten');
});

test('checkLevels: rows with both readings, and counts of agreement, disagreement and "Jev is not sure"', async t => {
  const h = await harness(t);
  await h.open();
  const result = await checkLevels({ runtime: h.runtime, cards, threshold: 0.8, language: 'en' });
  assert.equal(h.fake.requests.length, 5);
  const row = id => result.rows.find(item => item.id === id);
  assert.deepEqual([row('r1').heuristic, row('r1').jev, row('r1').agree], ['recall', 'recall', true]);
  assert.deepEqual([row('a2').heuristic, row('a2').jev, row('a2').agree], ['apply', 'concept', false]);
  assert.equal(row('c2').confident, false);
  assert.deepEqual(result.counts, { total: 5, agree: 3, disagree: 1, unsure: 1 });
  assert.equal(result.matrix.apply.concept, 1);
  assert.equal(result.matrix.recall.recall, 1);
  assert.ok(result.usage.calls === 5);
  assert.equal(summarize(result.rows, 0.8).agree, 3);
});

test('off or failing: no rows and a note, nothing thrown, nothing sent while off', async t => {
  const h = await harness(t);
  let result = await checkLevels({ runtime: h.runtime, cards, threshold: 0.8, language: 'en' });
  assert.equal(result.unavailable.reason, 'off');
  assert.deepEqual(result.rows, []);
  assert.equal(h.fake.requests.length, 0);
  await h.open(); h.fake.fail(401);
  result = await checkLevels({ runtime: h.runtime, cards, threshold: 0.8, language: 'en', concurrency: 1 });
  assert.equal(result.unavailable.reason, 'invalid-key');
});

test('jev.levels.check through a service: reads the library, changes nothing in it, and stays off by default', async t => {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-levels-svc-home-')), root = await mkdtemp(join(tmpdir(), 'study-jev-levels-svc-'));
  const before = { DSH_HOME: process.env.DSH_HOME, JEV_BASE_URL: process.env.JEV_BASE_URL }; process.env.DSH_HOME = home; delete process.env.JEV_BASE_URL;
  const fake = await startFakeJev({ answer: answerFor });
  const service = new StudyService(root, { jev: { baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0 } });
  t.after(async () => { service.dispose(); await fake.close(); for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  await service.store.update(state => { state.sources.push({ id: 's', title: 'S', text: 'x'.repeat(50) }); state.decks.push({ id: 'd', title: 'Deck', course: '', cards: cards.map(item => ({ ...item, citations: [{ sourceId: 's', quote: 'x'.repeat(20) }] })) }); });
  let result = await service.call('jev.levels.check', {});
  assert.equal(result.unavailable.reason, 'off');
  assert.equal(fake.requests.length, 0);
  await service.call('jev.settings.set', { key: fake.key, confirm: true, enabled: true, features: { levelCheck: true } });
  const snapshotBefore = JSON.stringify((await service.store.read()).decks);
  result = await service.call('jev.levels.check', {});
  assert.deepEqual(result.counts, { total: 5, agree: 3, disagree: 1, unsure: 1 });
  assert.equal(JSON.stringify((await service.store.read()).decks), snapshotBefore, 'nothing was written');
  assert.deepEqual((await service.store.read()).learner?.levels ?? {}, {}, 'the stored level overrides are untouched');
  result = await service.call('jev.levels.check', { deckId: 'd', limit: 2 });
  assert.equal(result.rows.length, 2);
  await assert.rejects(service.call('jev.levels.check', { deckId: 'nope' }), /not found|不存在/i);
});

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { JevLevelCheckView } from './ui/JevLevelCheck.jsx'; export { setUiLanguage, ENGLISH_SOURCES } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const { JevLevelCheckView, setUiLanguage } = mod.exports;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };

test('the developer panel: counts, the matrix and the disagreements; both languages', () => {
  const rows = [{ id: 'a2', prompt: 'Given a payment service, which would you choose?', heuristic: 'apply', jev: 'concept', probability: 0.85, agree: false, confident: true },
    { id: 'r1', prompt: 'Memento?', heuristic: 'recall', jev: 'recall', probability: 0.93, agree: true, confident: true }];
  const result = { rows, counts: { total: 5, agree: 3, disagree: 1, unsure: 1 }, matrix: { recall: { recall: 1 }, concept: { concept: 1 }, apply: { apply: 1, concept: 1 } }, usage: { calls: 5, inputTokens: 1800, outputTokens: 40 } };
  const zh = render(React.createElement(JevLevelCheckView, { result, busy: false, onRun: () => {} }));
  assert.match(zh, /一致 3/);
  assert.match(zh, /不一致 1/);
  assert.match(zh, /把握不足 1/);
  assert.match(zh, /应用分析/);
  assert.match(zh, /Given a payment service/);
  assert.match(zh, /只是对照/);
  const en = render(React.createElement(JevLevelCheckView, { result, busy: false, onRun: () => {} }), 'en');
  assert.match(en, /Agree 3/);
  assert.match(en, /Disagree 1/);
  assert.ok(!han.test(en.replace(/Given a payment service[^<]*/g, '')), en.match(/.{0,20}[㐀-鿿]+.{0,20}/)?.[0]);
  assert.match(render(React.createElement(JevLevelCheckView, { result: { rows: [], unavailable: { reason: 'off', message: 'Jev 判断服务已关闭' } }, busy: false, onRun: () => {} })), /已关闭/);
});
