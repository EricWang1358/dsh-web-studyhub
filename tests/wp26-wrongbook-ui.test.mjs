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
  export {formatDateTime} from './ui/format.js';
  export {setUiLanguage} from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' } });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { WrongBookView, groupRows, retrainOptions, variantState, variantFailureText, reasonText, formatDateTime, setUiLanguage } = module.exports;
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
  const html = text(render({ initial: { groupBy: 'topic' } }));
  assert.match(html, /保护状态 2 题 答错 2 来自 期末综合卷04、期末综合卷02/);
  assert.doesNotMatch(html, /Platform Engineering｜/, 'the repeated course prefix is shortened');
});

test('the segmented control opens on by deck (3.0.2) and switches to topic grouping', () => {
  assert.match(render(), /aria-pressed="true"[^>]*>按题组/);
  const html = render();
  assert.match(text(html), /期末综合卷04 3 题/);
  assert.doesNotMatch(text(html), /来自 期末综合卷/);
  assert.match(render({ initial: { groupBy: 'topic' } }), /aria-pressed="true"[^>]*>按主题/);
});

test('为你推荐 lists similar bank questions with why, a cap and a practise-these action', () => {
  // One folded line until opened (#206); the list is behind its toggle.
  assert.doesNotMatch(text(render()), /推荐题 0/);
  assert.match(text(render()), /练这 8 道/);
  const html = text(render({ initial: { recsOpen: true } }));
  assert.match(html, /为你推荐/);
  assert.match(html, /不消耗模型/);
  assert.match(html, /练这 8 道/);
  assert.match(html, /同主题：保护状态/);
  assert.match(html, /引用同一页：05 Platform Management 第 21 页/);
  assert.match(html, /推荐题 0/);
  assert.doesNotMatch(html, /推荐题 3/, 'only the first three show until expanded');
  assert.match(html, /再显示 5 道/);
  assert.match(text(render({ initial: { recsAll: true } })), /推荐题 7/);
  assert.match(text(render({ recs: { items: [] } })), /暂时没有合适的同类题/, 'an empty answer keeps the bar (#206)');
  assert.doesNotMatch(render({ recs: null }), /为你推荐/);
});

test('variant states per row: none, generating, ready with a way to practise, failed with a retry', () => {
  assert.deepEqual(variantState(coach, 'c1'), { kind: 'ready', count: 2, prompts: ['变式一', '变式二'] });
  assert.equal(variantState(coach, 'c2').kind, 'preparing');
  assert.equal(variantState(coach, 'c5').kind, 'none');
  assert.equal(variantState(coach, 'c5', new Set(['c5'])).kind, 'preparing', 'a just-requested card shows progress at once');
  const html = text(render({ initial: { groups: 'all' } }));
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
  assert.match(text(html), /开始重练 · 全部 8 题/);
  assert.match(text(render({ hasMore: true, counts: { total: 150, graded: 3, self: 1, oral: 0 } })), /只练本页错题 \(5\)/);
});

test('an opened row shows your answer, the correct answer, the explanation and its variants', () => {
  const details = { c1: { yourAnswer: 'Memento', correctAnswer: 'Caretaker', explanation: '它只保管历史。', misconception: '', selfGrade: null } };
  const html = text(render({ initial: { expanded: ['c1'], groups: 'all' }, details }));
  assert.match(html, /你的答案 Memento/);
  assert.match(html, /正确答案 Caretaker/);
  assert.match(html, /解析 它只保管历史。/);
  assert.match(html, /变式一/);
  assert.match(html, /变式二/);
  assert.match(text(render({ initial: { expanded: ['c1'], groups: 'all' }, details: { c1: 'loading' } })), /正在读取详情/);
  const self = text(render({ initial: { expanded: ['c3'], groups: 'all' }, details: { c3: { yourAnswer: null, selfGrade: 2, correctAnswer: '答案', explanation: '' } } }));
  assert.match(self, /自评 2 分/);
});

test('formulas in an opened row, its prompt line and its variants are formulas, and the facts cannot push the panel wider', async () => {
  const math = String.raw`逐年转存：$20220\times1.1\%=222.42$元，$ F = ma $，质量为5$kg$。`;
  const hard = { ...row('c1', 'd4', '保护状态', String.raw`年利率为$1.1\%$，存$20000$元`) };
  const html = render({ items: [hard], initial: { expanded: ['c1'], groups: 'all' },
    details: { c1: { yourAnswer: math, correctAnswer: math, explanation: math, misconception: math, selfGrade: null } } });
  const drawn = (html.match(/class="md-math"/g) || []).length;
  assert.equal(drawn >= 10, true, `the prompt line and every fact draw their formulas through the one formula unit (${drawn})`);
  assert.match(html, /<span class="wb-prompt"[^>]*>[^<]*<span class="md-math"/, 'the prompt line keeps one line, its formulas inline');
  // An auto grid track takes the longest unbroken line as its minimum width: the panel must use minmax(0, 1fr).
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../ui/wrongbook.css', import.meta.url), 'utf8');
  assert.match(css, /\.wb-detail \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.wb-facts \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
});

test('an opened row lists similar questions with the reason that fits that row', () => {
  const rec = { deckId: 'd2', deckTitle: decks[1].title, cardId: 'x1', topic: '其它', kind: 'quiz', prompt: '同页的另一题', score: 6, forCardIds: ['c1', 'c2'],
    reasons: [{ type: 'topic', topic: '集成收益' }],
    matches: [{ cardId: 'c2', score: 6, reasons: [{ type: 'topic', topic: '集成收益' }] }, { cardId: 'c1', score: 4, reasons: [{ type: 'page', sourceTitle: '05 Platform Management', page: 21 }] }] };
  const html = text(render({ recs: { items: [rec] }, initial: { expanded: ['c1'], groups: 'all' }, details: { c1: { yourAnswer: 'A', correctAnswer: 'B', explanation: '', misconception: '' } } }));
  assert.match(html, /同类题 同页的另一题 引用同一页：05 Platform Management 第 21 页/);
});

test('no model: one SetupRequired gate replaces every generate button; recommendations still work', () => {
  const html = render({ coach: { ...coach, enabled: false, ready: 0, readyCards: [], preparingCards: [], failedCards: [] } });
  assert.match(text(html), /先配置一个 AI 模型/);
  assert.match(text(html), /前往设置/);
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
    const html = renderToStaticMarkup(React.createElement(WrongBookView, { ...english, initial: { recsOpen: true } }));
    assert.doesNotMatch(html.replace(/aria-label="[^"]*"/g, '$&'), han, 'no Chinese UI left');
    assert.match(text(html), /By topic/);
    assert.match(text(html), /Recommended for you/);
    assert.match(text(html), /Same topic: Circuit breaker/);
    assert.match(text(html), /Generate variants/);
    assert.match(text(html), /Start retraining · all \d+/);
    const gate = renderToStaticMarkup(React.createElement(WrongBookView, { ...english, coach: { ...english.coach, enabled: false } }));
    assert.doesNotMatch(gate, han);
    const consent = renderToStaticMarkup(React.createElement(WrongBookView, { ...english, coach: { ...english.coach, consent: null }, initial: { askConsent: true } }));
    assert.doesNotMatch(consent, han);
    assert.match(text(consent), /Agree and generate/);
    const failed = renderToStaticMarkup(React.createElement(WrongBookView, { ...english, coach: { ...english.coach, failedCards: [{ cardId: 'c4', message: '模型服务暂时不可用，稍后重试' }], preparingCards: [] } }));
    assert.doesNotMatch(failed, han);
  } finally { setUiLanguage('zh'); }
});


/* ---- 已订正: the history view beside 待巩固 (v0.4) ---- */

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A corrected mistake: the weak row's fields plus how often, when and how it was missed, as the service sends it. */
const fixed = (cardId, deckId, topic, prompt, assessment = 'graded', { wrongCount = 2,
  lastWrongAt = '2026-10-03T10:30:00Z', recoveredAt = '2026-10-05T09:00:00Z' } = {}) => ({
  deckId, deckTitle: decks.find((deck) => deck.id === deckId).title, cardId, topic, prompt, assessment, kind: 'quiz',
  lastGrade: 4, lastAt: recoveredAt, wrongCount, firstWrongAt: '2026-10-01T08:00:00Z', lastWrongAt, recoveredAt });
const historyItems = [
  fixed('h1', 'd4', '保护状态', '熔断器修好了吗？', 'graded', { wrongCount: 3, lastWrongAt: '2026-10-03T10:30:00Z', recoveredAt: '2026-10-05T09:00:00Z' }),
  fixed('h2', 'd2', '集成收益', '集成收益记住了吗？', 'self', { wrongCount: 1, lastWrongAt: '2026-10-02T09:15:00Z', recoveredAt: '2026-10-04T09:00:00Z' })];
const historyBase = { ...base, view: 'history', onView: noop, viewCounts: { weak: 5, history: 2 }, items: historyItems,
  counts: { total: 2, graded: 1, self: 1, oral: 0, rubric: 0 } };

test('待巩固 / 已订正 is one switch with both counts, opening on 待巩固', () => {
  setUiLanguage('zh');
  const html = render({ viewCounts: { weak: 5, history: 2 }, onView: noop });
  assert.match(html, /aria-label="错题视图"/);
  assert.match(html, /aria-pressed="true"[^>]*>待巩固 5</);
  assert.match(html, /aria-pressed="false"[^>]*>已订正 2</);
  const history = render(historyBase);
  assert.match(history, /aria-pressed="false"[^>]*>待巩固 5</);
  assert.match(history, /aria-pressed="true"[^>]*>已订正 2</);
});

test('no 已订正 switch while there is no history to show', () => {
  setUiLanguage('zh');
  assert.doesNotMatch(render({ viewCounts: { weak: 5, history: 0 }, onView: noop }), /aria-label="错题视图"/);
  assert.doesNotMatch(render({ viewCounts: { weak: 5, history: 0 }, onView: noop }), />已订正 0</);
  assert.doesNotMatch(render({ onView: noop }), /aria-label="错题视图"/, 'a host that sends no viewCounts offers no history');
});

test('the header counts the open view and points at the kept history only from 待巩固', () => {
  setUiLanguage('zh');
  const weak = text(render({ viewCounts: { weak: 5, history: 2 }, onView: noop }));
  assert.match(weak, /客观答错 3 题 · 自评未掌握 1 题 · 口头评估待巩固 0 题。 · 已订正 2 题，记录保留/);
  const cleared = text(render({ items: [], counts: { total: 0, graded: 0, self: 0, oral: 0, rubric: 0 }, viewCounts: { weak: 0, history: 2 }, onView: noop }));
  assert.match(cleared, /客观答错、自评未掌握或口头评估待巩固的题会收在这里。 · 已订正 2 题，记录保留/);
  const history = text(render(historyBase));
  assert.match(history, /已订正的错题：答错 1 题 · 自评未掌握 1 题 · 口头评估 0 题。/);
  assert.doesNotMatch(history, /题，记录保留/, 'the history page does not repeat its own count');
});

test('a history row keeps its 答错 / 未掌握 mark and adds 已订正 with how often and when it was missed', () => {
  setUiLanguage('zh');
  const html = render({ ...historyBase, initial: { groups: 'all' } });
  const t = text(html);
  assert.match(t, new RegExp('已订正 答错 3 次 · 最近答错 ' + escapeRe(formatDateTime('2026-10-03T10:30:00Z', 'stamp'))));
  assert.match(t, new RegExp('已订正 答错 1 次 · 最近答错 ' + escapeRe(formatDateTime('2026-10-02T09:15:00Z', 'stamp'))));
  const rowText = html.split('<li class="wb-row">').slice(1).map((row) => text(row).trim());
  assert.match(rowText[0], /^保护状态 熔断器修好了吗？ 答错 .*已订正 答错 3 次 · 最近答错 /, 'the miss kind stays next to the 已订正 mark');
  assert.match(rowText[1], /^集成收益 集成收益记住了吗？ 未掌握 .*已订正 答错 1 次 · 最近答错 /);
  assert.equal((html.match(/class="[^"]*wb-fixed-mark/g) || []).length, 2, 'one mark per corrected row');
  assert.equal((html.match(/>练<\/button>/g) || []).length, 2, '练 still practises that card');
  const details = { h1: { yourAnswer: 'A', correctAnswer: 'B', explanation: '', misconception: '', selfGrade: null, lastGrade: 4, missedGrade: 1, missedAt: '2026-10-03T10:30:00Z' } };
  const opened = text(render({ ...historyBase, details, initial: { groups: 'all', expanded: ['h1'] } }));
  assert.match(opened, new RegExp('上次答错 ' + escapeRe(formatDateTime('2026-10-03T10:30:00Z', 'stamp'))));
  assert.match(opened, /你的答案 A/, 'the detail opens on the answer that was wrong');
});

test('an empty 已订正 view says there is no history yet and keeps the way back', () => {
  setUiLanguage('zh');
  const html = render({ ...historyBase, items: [], counts: { total: 0, graded: 0, self: 0, oral: 0, rubric: 0 }, viewCounts: { weak: 5, history: 0 } });
  const t = text(html);
  assert.match(t, /还没有已订正的错题/);
  assert.match(t, /答对一次后，错题会移到这里，作为历史保留，随时可以再练。/);
  assert.doesNotMatch(t, /目前没有待巩固的题|还没有练习记录/);
  assert.match(html, /aria-pressed="true"[^>]*>已订正 0</, 'the open view keeps its switch, so 待巩固 is always one click away');
});

test('the history view keeps the grouping, the filter and the paging, and leaves the weak-only work out', () => {
  setUiLanguage('zh');
  const weakData = { ...base.data, attempts: [{ assessment: 'rubric', timestamp: '2026-10-01T10:00:00Z',
    rubric: { criteria: [{ label: '案例联系', score: 2, max: 5 }, { label: '假设说明', score: 4, max: 5 }] } }] };
  const weak = text(render({ data: weakData, initial: { groups: 'all' } }));
  for (const block of ['案例分析能力', '重练', '为你推荐', '生成变式']) assert.ok(weak.includes(block), `the 待巩固 page has ${block}`);
  const html = render({ ...historyBase, data: weakData, initial: { groups: 'all' } });
  const t = text(html);
  for (const block of ['案例分析能力', '重练', '为你推荐', '生成变式', '不消耗模型']) assert.ok(!t.includes(block), `the 已订正 page still shows ${block}`);
  assert.match(html, /aria-pressed="true"[^>]*>按题组/, 'grouping stays');
  assert.match(html, /role="search"/, 'the deck / status / text filter stays');
  assert.match(t, /显示 2 \/ 共 2 题/);
  assert.match(t, /练这一组/, 'a group of corrected mistakes is still practised together');
  const gated = { coach: { enabled: false, consent: null, ready: 0, readyCards: [], preparingCards: [], failedCards: [], tasks: [] } };
  assert.match(text(render(gated)), /先配置一个 AI 模型/);
  assert.doesNotMatch(text(render({ ...historyBase, ...gated })), /先配置一个 AI 模型/, 'no variant gate where there is no variant work');
});

test('English: the history view is translated while the question text stays as written', () => {
  try {
    setUiLanguage('en');
    const englishDecks = [{ id: 'd4', course: 'PE', title: 'Final 04' }, { id: 'd2', course: 'PE', title: 'Final 02' }];
    const items = [
      { ...fixed('h1', 'd4', 'Circuit breaker', 'Which state rejects every request?', 'graded', { wrongCount: 3, lastWrongAt: '2026-10-03T10:30:00Z' }), deckTitle: 'Final 04' },
      { ...fixed('h2', 'd2', 'Integration gains', 'What is the main gain?', 'self', { wrongCount: 1, lastWrongAt: '2026-10-02T09:15:00Z' }), deckTitle: 'Final 02' }];
    const html = render({ ...historyBase, data: { ...base.data, decks: englishDecks }, items, initial: { groups: 'all' } });
    assert.doesNotMatch(html.replace(/aria-label="[^"]*"/g, '$&'), han, 'no Chinese UI left');
    const t = text(html);
    assert.match(t, /To review 5/);
    assert.match(t, /Corrected 2/);
    assert.match(t, /Corrected mistakes: incorrect 1 · low self-ratings 1 · oral assessments 0\./);
    assert.match(t, new RegExp('Corrected Missed 3 time\\(s\\) · Last missed ' + escapeRe(formatDateTime('2026-10-03T10:30:00Z', 'stamp'))));
    const empty = render({ ...historyBase, data: { ...base.data, decks: englishDecks }, items: [],
      counts: { total: 0, graded: 0, self: 0, oral: 0, rubric: 0 }, viewCounts: { weak: 5, history: 0 } });
    assert.doesNotMatch(empty, han);
    assert.match(text(empty), /No corrected mistakes yet/);
  } finally { setUiLanguage('zh'); }
});
