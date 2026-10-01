import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// WP26: the wrong-book page groups by topic, recommends similar questions, offers
// variants per topic/row, and splits "重练" into three scopes.
const compiled = await build({ stdin: { contents: `export {WrongBookView} from './ui/WrongBook.jsx';
  export {groupRows, retrainOptions, variantState, variantFailureText, reasonText} from './ui/wrongbook-model.js';
  export {setUiLanguage} from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' } });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { WrongBookView, groupRows, retrainOptions, variantState, variantFailureText, reasonText, setUiLanguage } = module.exports;
const noop = () => {};
const han = /\p{Script=Han}/u;

const decks = [{ id: 'd4', course: 'PE', title: 'Platform Engineering｜期末综合卷04｜90题' }, { id: 'd2', course: 'PE', title: 'Platform Engineering｜期末综合卷02｜90题' }];
const row = (cardId, deckId, topic, prompt, assessment = 'graded', lastAt = '2026-10-01T10:00:00Z') => ({ deckId, deckTitle: decks.find((d) => d.id === deckId).title,
  cardId, topic, prompt, assessment, lastGrade: 1, lastAt, kind: 'quiz' });
const items = [row('c1', 'd4', '保护状态', '熔断器处于哪种保护状态会拒绝请求？', 'graded', '2026-10-01T12:00:00Z'),
  row('c2', 'd4', '集成收益', '集成带来的主要收益是什么？'), row('c3', 'd4', '组织与架构', '平台团队如何划分职责？', 'self'),
  row('c4', 'd2', '保护 状态', '半开状态下允许多少探测请求？', 'graded', '2026-10-01T11:00:00Z'), row('c5', 'd2', '恢复探测', '为什么要探测依赖恢复？')];
const recs = { items: Array.from({ length: 8 }, (_, i) => ({ deckId: 'd2', deckTitle: decks[1].title, cardId: `r${i}`, topic: '保护状态', kind: 'quiz',
  prompt: `推荐题 ${i}`, score: 8 - i, forCardIds: ['c1'],
  reasons: [i === 0 ? { type: 'topic', topic: '保护状态' } : { type: 'page', sourceTitle: '05 Platform Management', page: 21 }] })) };
const coach = { enabled: true, consent: true, ready: 3, preparing: true, preparingCards: ['c2'],
  readyCards: [{ id: 'p1', originDeckId: 'd4', originCardId: 'c1', prompt: '变式一', reason: 'wrong' }, { id: 'p2', originDeckId: 'd4', originCardId: 'c1', prompt: '变式二', reason: 'wrong' },
    { id: 'p3', originDeckId: 'd2', originCardId: 'c4', prompt: '变式三', reason: 'wrong' }],
  failedCards: [{ cardId: 'c3', message: '这批变式没有通过校验，已跳过' }], tasks: [] };
const base = { data: { root: 'r', decks, focus: { course: 'PE', courses: [{ name: 'PE' }] }, model: { ready: true } }, course: 'PE', onCourse: noop,
  items, counts: { total: 5, graded: 3, self: 1, oral: 0, rubric: 0 }, loading: false, err: '', page: 0, pageSize: 100, hasMore: false,
  onReload: noop, onPage: noop, recs, coach, details: {}, onLoadDetail: noop, onPractice: noop, onPracticePrepared: noop,
  onGenerate: async () => ({}), onOpenSettings: noop, busy: false };
const render = (extra = {}) => renderToStaticMarkup(React.createElement(WrongBookView, { ...base, ...extra }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('topic grouping merges the same topic across decks and names where each question came from', () => {
  const groups = groupRows(items, 'topic', decks);
  assert.equal(groups.length, 4, '保护状态 and 保护 状态 are one topic');
  assert.equal(groups[0].title, '保护状态');
  assert.deepEqual(groups[0].rows.map((r) => r.cardId), ['c1', 'c4']);
  assert.deepEqual(groups[0].deckTitles, ['期末综合卷04', '期末综合卷02']);
  const byDeck = groupRows(items, 'deck', decks);
  assert.deepEqual(byDeck.map((g) => [g.title, g.rows.length]), [['期末综合卷04', 3], ['期末综合卷02', 2]]);
  const html = text(render());
  assert.match(html, /保护状态 2 题 来自 期末综合卷04、期末综合卷02/);
  assert.doesNotMatch(html, /Platform Engineering｜/, 'the repeated course prefix is shortened');
});

test('the segmented control switches to deck grouping', () => {
  assert.match(render(), /aria-pressed="true"[^>]*>按主题/);
  const html = render({ initial: { groupBy: 'deck' } });
  assert.match(html, /aria-pressed="true"[^>]*>按题组/);
  assert.match(text(html), /期末综合卷04 3 题/);
  assert.doesNotMatch(text(html), /来自 期末综合卷/);
});

test('为你推荐 lists similar bank questions with why, a cap and a practise-these action', () => {
  const html = text(render());
  assert.match(html, /为你推荐/);
  assert.match(html, /不消耗模型/);
  assert.match(html, /练这 8 道/);
  assert.match(html, /同主题：保护状态/);
  assert.match(html, /引用同一页：05 Platform Management 第 21 页/);
  assert.match(html, /推荐题 0/);
  assert.doesNotMatch(html, /推荐题 7/, 'only the first few show until expanded');
  assert.match(html, /再显示 3 道/);
  assert.match(text(render({ initial: { recsAll: true } })), /推荐题 7/);
  assert.doesNotMatch(render({ recs: { items: [] } }), /为你推荐/);
  assert.doesNotMatch(render({ recs: null }), /为你推荐/);
});

test('variant states per row: none, generating, ready with a way to practise, failed with a retry', () => {
  assert.deepEqual(variantState(coach, 'c1'), { kind: 'ready', count: 2, prompts: ['变式一', '变式二'] });
  assert.equal(variantState(coach, 'c2').kind, 'preparing');
  assert.equal(variantState(coach, 'c5').kind, 'none');
  assert.equal(variantState(coach, 'c5', new Set(['c5'])).kind, 'preparing', 'a just-requested card shows progress at once');
  const html = text(render());
  assert.match(html, /已备好 2 道/);
  assert.match(html, /生成中…/);
  assert.match(html, /这批变式没有通过质量校验/);
  assert.match(html, /重试/);
  assert.match(html, /生成变式/);
  assert.doesNotMatch(html, /已跳过/, 'raw backend wording is mapped to plain words');
  assert.match(variantFailureText('模型长时间没有响应（请求超时），可以稍后重试'), /长时间没有响应/);
  assert.match(variantFailureText('connect ECONNREFUSED'), /可以重试/);
});

test('a banner offers the prepared variants and reuses the coach practice', () => {
  const html = text(render());
  assert.match(html, /已为你备好 3 道变式题/);
  assert.match(html, /去练 →/);
  assert.doesNotMatch(text(render({ coach: { ...coach, ready: 0, readyCards: [] } })), /已为你备好/);
});

test('重练 is a three-way choice and defaults to the richest available', () => {
  const rich = retrainOptions({ mistakes: 5, similar: 8, variants: 3, paged: false });
  assert.deepEqual(rich.options.map((o) => o.label), ['只练错题 (5)', '错题 + 同类题 (5+8)', '错题 + 变式 (5+3)']);
  assert.equal(rich.fallback, 'variants');
  assert.equal(retrainOptions({ mistakes: 5, similar: 8, variants: 0 }).fallback, 'similar');
  const plain = retrainOptions({ mistakes: 5, similar: 0, variants: 0 });
  assert.equal(plain.fallback, 'wrong');
  assert.ok(plain.options[1].disabled && plain.options[2].disabled);
  const html = render();
  assert.match(text(html), /只练错题 \(5\)/);
  assert.match(text(html), /错题 \+ 同类题 \(5\+8\)/);
  assert.match(text(html), /错题 \+ 变式 \(5\+3\)/);
  assert.match(html, /aria-pressed="true"[^>]*>错题 \+ 变式/);
  assert.match(text(html), /开始重练 \(8\)/);
  assert.match(text(render({ hasMore: true, counts: { total: 150, graded: 3, self: 1, oral: 0 } })), /只练本页错题 \(5\)/);
});

test('an opened row shows your answer, the correct answer, the explanation and its variants', () => {
  const details = { c1: { yourAnswer: 'Memento', correctAnswer: 'Caretaker', explanation: '它只保管历史。', misconception: '', selfGrade: null } };
  const html = text(render({ initial: { expanded: ['c1'] }, details }));
  assert.match(html, /你的答案 Memento/);
  assert.match(html, /正确答案 Caretaker/);
  assert.match(html, /解析 它只保管历史。/);
  assert.match(html, /变式一/);
  assert.match(html, /变式二/);
  assert.match(text(render({ initial: { expanded: ['c1'] }, details: { c1: 'loading' } })), /正在读取详情/);
  const self = text(render({ initial: { expanded: ['c3'] }, details: { c3: { yourAnswer: null, selfGrade: 2, correctAnswer: '答案', explanation: '' } } }));
  assert.match(self, /自评 2 分/);
});

test('no model: one SetupRequired gate replaces every generate button; recommendations still work', () => {
  const html = render({ coach: { ...coach, enabled: false, ready: 0, readyCards: [], preparingCards: [], failedCards: [] } });
  assert.match(text(html), /先配置一个 AI 模型/);
  assert.match(text(html), /打开模型设置/);
  assert.doesNotMatch(text(html), /为全部错题生成变式/);
  assert.doesNotMatch(text(html), /生成变式 /);
  assert.match(text(html), /为你推荐/);
});

test('consent is explained inline once, with 同意并生成, before any model call', () => {
  const html = text(render({ coach: { ...coach, consent: null }, initial: { askConsent: true } }));
  assert.match(html, /同意并生成/);
  assert.match(html, /暂不/);
  assert.match(html, /后台少量调用模型/);
  assert.doesNotMatch(text(render()), /同意并生成/);
});

test('the batch button is capped and states the cost', () => {
  const html = text(render());
  assert.match(html, /为全部错题生成变式/);
  assert.match(html, /一次最多 8 题/);
  assert.match(html, /约 1 次轻量模型调用\/题/);
});

test('recommendation reasons read naturally', () => {
  assert.equal(reasonText({ type: 'topic', topic: '保护状态' }), '同主题：保护状态');
  assert.equal(reasonText({ type: 'near', sourceTitle: 'Doc', page: 7 }), '引用相邻页：Doc 第 7 页');
  assert.equal(reasonText({ type: 'terms', terms: ['熔断', '请求'] }), '关键词相近：熔断、请求');
});

test('English: every UI string is translated while question content stays as written', () => {
  const english = { ...base, items: [
    { ...row('c1', 'd4', 'Circuit breaker', 'Which state rejects every request?'), deckTitle: 'Platform Engineering | Final 04 | 90 questions' },
    { ...row('c4', 'd2', 'circuit  breaker', 'How many probes are allowed?'), deckTitle: 'Platform Engineering | Final 02 | 90 questions' }],
  counts: { total: 2, graded: 2, self: 0, oral: 0, rubric: 0 },
  recs: { items: [{ deckId: 'd2', deckTitle: 'Final 02', cardId: 'r0', topic: 'Circuit breaker', kind: 'quiz', prompt: 'Name the half-open rule', score: 6, forCardIds: ['c1'],
    reasons: [{ type: 'topic', topic: 'Circuit breaker' }] }] },
  coach: { ...coach, preparingCards: ['c4'], readyCards: [{ id: 'p', originDeckId: 'd4', originCardId: 'c1', prompt: 'Variant one', reason: 'wrong' }], failedCards: [], ready: 1 } };
  try {
    setUiLanguage('en');
    const html = renderToStaticMarkup(React.createElement(WrongBookView, english));
    assert.doesNotMatch(html.replace(/aria-label="[^"]*"/g, '$&'), han, 'no Chinese UI left');
    assert.match(text(html), /By topic/);
    assert.match(text(html), /Recommended for you/);
    assert.match(text(html), /Same topic: Circuit breaker/);
    assert.match(text(html), /Generate variants/);
    assert.match(text(html), /Start retraining \(\d+\)/);
    const gate = renderToStaticMarkup(React.createElement(WrongBookView, { ...english, coach: { ...english.coach, enabled: false } }));
    assert.doesNotMatch(gate, han);
    const consent = renderToStaticMarkup(React.createElement(WrongBookView, { ...english, coach: { ...english.coach, consent: null }, initial: { askConsent: true } }));
    assert.doesNotMatch(consent, han);
    assert.match(text(consent), /Agree and generate/);
    const failed = renderToStaticMarkup(React.createElement(WrongBookView, { ...english, coach: { ...english.coach, failedCards: [{ cardId: 'c4', message: '模型服务暂时不可用，稍后重试' }], preparingCards: [] } }));
    assert.doesNotMatch(failed, han);
  } finally { setUiLanguage('zh'); }
});
