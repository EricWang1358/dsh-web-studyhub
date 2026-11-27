import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 3.0.2: the mistakes page opens grouped by deck with every group folded, and has a filter bar (deck, status, text). The pure functions behind
   it (ui/wrongbook-model.js) and the rendered page are tested here; the real browser at 1280 and 420 px is tests/wrongbook-filters-browser.test.mjs. */

const m = await loadUi(`export { WrongBookView } from './ui/WrongBook.jsx';
  export * from './ui/wrongbook-model.js';
  export { setUiLanguage, uiCatalogue } from './ui/i18n.js';`);
Object.assign(m.uiCatalogue(), JSON.parse(readFileSync(new URL('../ui/locales/en.polish-results.json', import.meta.url), 'utf8')));
const { WrongBookView, groupRows, filterRows, filterActive, NO_FILTER, statusOf, groupSummary, groupSummaryText, deckChoices, scopedFilter, readGroupBy, saveGroupBy,
  readOpenGroups, saveOpenGroups, SORT_KINDS, sortGroupRows, readSortBy, saveSortBy, sameVariantState, variantState, VARIANT_BATCH_CAP, setUiLanguage } = m;
const noop = () => {};
const han = /\p{Script=Han}/u;

const decks = [{ id: 'd4', course: 'PE', title: 'Platform Engineering｜期末综合卷04｜90题' }, { id: 'd2', course: 'PE', title: 'Platform Engineering｜期末综合卷02｜90题' }];
const row = (cardId, deckId, topic, prompt, assessment = 'graded', lastAt = '2026-10-01T10:00:00Z') => ({ deckId, deckTitle: decks.find((d) => d.id === deckId).title,
  cardId, topic, prompt, assessment, lastGrade: 1, lastAt, kind: 'quiz' });
const items = [row('c1', 'd4', '保护状态', '熔断器处于哪种保护状态会拒绝请求？', 'graded', '2026-10-01T12:00:00Z'),
  row('c2', 'd4', '集成收益', '集成带来的主要收益是什么？'), row('c3', 'd4', '组织与架构', '平台团队如何划分职责？', 'self'),
  row('c4', 'd2', '保护 状态', '半开状态下允许多少探测请求？', 'graded', '2026-10-01T11:00:00Z'), row('c5', 'd2', '恢复探测', '为什么要探测依赖恢复？')];
const coach = { enabled: true, consent: true, ready: 1, preparing: false, preparingCards: [],
  readyCards: [{ id: 'p3', originDeckId: 'd2', originCardId: 'c4', prompt: '变式三', reason: 'wrong' }], failedCards: [], tasks: [] };
const base = { data: { root: 'r', decks, focus: { course: 'PE', courses: [{ name: 'PE' }] }, model: { ready: true } }, course: 'PE', onCourse: noop,
  items, counts: { total: 5, graded: 4, self: 1, oral: 0, rubric: 0 }, loading: false, err: '', page: 0, pageSize: 100, hasMore: false,
  onReload: noop, onPage: noop, recs: null, coach, details: {}, onLoadDetail: noop, onPractice: noop, onPracticePrepared: noop,
  onGenerate: async () => ({}), onOpenSettings: noop, busy: false, filterMin: 1 };
const render = (extra = {}) => renderToStaticMarkup(React.createElement(WrongBookView, { ...base, ...extra }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const count = (html, pattern) => (html.match(pattern) || []).length;
/** The markup of the first button whose label (the text inside it) is `label`. */
const buttonWith = (html, label) => (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []).find((tag) => text(tag).trim() === label);
const memoryStorage = (initial = {}) => { const map = new Map(Object.entries(initial)); return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(key, String(value)); }, map }; };

test('the status of a row is the one the row already shows: 答错 for auto-graded, 未掌握 for self-rated, plus oral and rubric', () => {
  assert.equal(statusOf({ assessment: 'graded' }), 'graded');
  assert.equal(statusOf({ assessment: 'self' }), 'self');
  assert.equal(statusOf({ assessment: 'oral' }), 'oral');
  assert.equal(statusOf({ assessment: 'rubric' }), 'rubric');
  assert.equal(statusOf({}), 'self', 'a row without an assessment reads as 未掌握, as its label always did');
});

test('filters combine: deck AND status AND every word of the text', () => {
  assert.equal(filterActive(NO_FILTER), false);
  assert.equal(filterActive({ ...NO_FILTER, query: '  ' }), false, 'blank text is no filter');
  assert.equal(filterRows(items, NO_FILTER).length, 5);
  assert.deepEqual(filterRows(items, { ...NO_FILTER, deck: 'd4' }).map((r) => r.cardId), ['c1', 'c2', 'c3']);
  assert.deepEqual(filterRows(items, { ...NO_FILTER, status: 'self' }).map((r) => r.cardId), ['c3']);
  assert.deepEqual(filterRows(items, { ...NO_FILTER, status: 'graded', deck: 'd2' }).map((r) => r.cardId), ['c4', 'c5']);
  assert.deepEqual(filterRows(items, { ...NO_FILTER, query: '状态' }).map((r) => r.cardId), ['c1', 'c4'], 'matches the question text and the topic');
  assert.deepEqual(filterRows(items, { ...NO_FILTER, query: '集成' }).map((r) => r.cardId), ['c2'], 'matches the topic');
  assert.deepEqual(filterRows(items, { ...NO_FILTER, query: '探测 请求' }).map((r) => r.cardId), ['c4'], 'every word must match');
  assert.deepEqual(filterRows(items, { deck: 'd4', status: 'graded', query: '收益' }).map((r) => r.cardId), ['c2']);
  assert.deepEqual(filterRows(items, { ...NO_FILTER, deck: 'nope' }), []);
  assert.deepEqual(filterRows([row('x', 'd4', 'Circuit Breaker', 'Which STATE rejects?')], { ...NO_FILTER, query: 'state breaker' }).map((r) => r.cardId), ['x'], 'case does not matter');
  assert.deepEqual(filterRows([row('y', 'd4', '填空', '补全 {{c1}} 的定义')], { ...NO_FILTER, query: 'c1' }), [], 'cloze markers are not question text');
});

test('both groupings still group correctly after a filter, and a group counts only what is left', () => {
  const filtered = filterRows(items, { ...NO_FILTER, status: 'graded' });
  const byDeck = groupRows(filtered, 'deck', decks);
  assert.deepEqual(byDeck.map((g) => [g.title, g.rows.length]), [['期末综合卷04', 2], ['期末综合卷02', 2]]);
  assert.deepEqual(byDeck.map((g) => g.deckIds), [['d4'], ['d2']]);
  const byTopic = groupRows(filtered, 'topic', decks);
  assert.equal(byTopic[0].title, '保护状态');
  assert.deepEqual(byTopic[0].rows.map((r) => r.cardId), ['c1', 'c4']);
  assert.deepEqual(byTopic[0].deckIds, ['d4', 'd2']);
});

test('a group summary counts each status, leaves out the zeros, and reads 答错 N · 未掌握 N', () => {
  assert.deepEqual(groupSummary(items.slice(0, 3)), [{ kind: 'graded', count: 2 }, { kind: 'self', count: 1 }]);
  assert.deepEqual(groupSummary(items.slice(3)), [{ kind: 'graded', count: 2 }]);
  assert.equal(groupSummaryText(items.slice(0, 3)), '答错 2 · 未掌握 1');
  assert.equal(groupSummaryText(items.slice(3)), '答错 2');
  assert.equal(groupSummaryText([{ assessment: 'oral' }, { assessment: 'rubric' }, { assessment: 'rubric' }]), '口头评估 1 · 批改未达标 2');
  assert.equal(groupSummaryText([]), '');
});

test('the deck picker lists the decks that have mistakes, with a short name and a count, newest first', () => {
  const choices = deckChoices(items, decks);
  assert.deepEqual(choices.map((c) => [c.value, c.label, c.count]), [['d4', '期末综合卷04', 3], ['d2', '期末综合卷02', 2]]);
  assert.deepEqual(deckChoices([], decks), []);
});

test('the filter belongs to the course scope: another scope starts clean, the same scope keeps it across refreshes', () => {
  const state = { scope: '["PE"]', filter: { deck: 'd4', status: 'self', query: 'x' } };
  assert.deepEqual(scopedFilter(state, '["PE"]'), state.filter);
  assert.equal(scopedFilter(state, '["OS"]'), NO_FILTER);
  assert.equal(scopedFilter(undefined, '["PE"]'), NO_FILTER);
});

test('the grouping the learner chose is remembered per viewer; a missing, blocked or corrupt store falls back to by deck', () => {
  assert.equal(readGroupBy(memoryStorage()), 'deck');
  assert.equal(readGroupBy(memoryStorage({ 'study-wrongbook-groupby': 'topic' })), 'topic');
  assert.equal(readGroupBy(memoryStorage({ 'study-wrongbook-groupby': '"nonsense"' })), 'deck');
  assert.equal(readGroupBy(null), 'deck');
  assert.equal(readGroupBy({ getItem() { throw new Error('blocked'); } }), 'deck');
  const store = memoryStorage();
  saveGroupBy('topic', store);
  assert.equal(readGroupBy(store), 'topic');
  assert.doesNotThrow(() => saveGroupBy('topic', { setItem() { throw new Error('blocked'); } }));
  assert.doesNotThrow(() => saveGroupBy('topic', null));
});

test('the open groups live for the session, keyed by group id', () => {
  const store = memoryStorage();
  assert.deepEqual([...readOpenGroups('k', store)], []);
  saveOpenGroups('k', new Set(['deck:d4', 'topic:a']), store);
  assert.deepEqual([...readOpenGroups('k', store)].sort(), ['deck:d4', 'topic:a']);
  assert.deepEqual([...readOpenGroups('other', store)], []);
  assert.deepEqual([...readOpenGroups('k', memoryStorage({ k: 'not json' }))], []);
  assert.deepEqual([...readOpenGroups('k', null)], []);
  assert.doesNotThrow(() => saveOpenGroups('k', new Set(['a']), null));
});

test('two variant states that say the same thing are the same, so a poll does not redraw every row', () => {
  assert.equal(sameVariantState(variantState(coach, 'c4'), variantState(coach, 'c4')), true);
  assert.equal(sameVariantState(variantState(coach, 'c5'), variantState(coach, 'c5')), true);
  assert.equal(sameVariantState(variantState(coach, 'c4'), variantState(coach, 'c5')), false);
  assert.equal(sameVariantState(variantState(coach, 'c5'), variantState(coach, 'c5', new Set(['c5']))), false);
});

/* ---- the rendered page ---- */

test('the page opens grouped by deck with every group folded: one header row per group, no question rows', () => {
  const html = render();
  assert.match(html, /aria-pressed="true"[^>]*>按题组/);
  assert.doesNotMatch(html, /aria-pressed="true"[^>]*>按主题/);
  const t = text(html);
  assert.match(t, /期末综合卷04 3 题 答错 2 · 未掌握 1/);
  assert.match(t, /期末综合卷02 2 题 答错 2/);
  assert.equal(count(html, /class="wb-row[ "]/g), 0, 'no question row is drawn while its group is folded');
  assert.doesNotMatch(t, /熔断器处于哪种保护状态/);
  const heads = html.match(/<button[^>]*class="[^"]*wb-group-toggle[^"]*"[^>]*>/g) || [];
  assert.equal(heads.length, 2);
  for (const head of heads) assert.match(head, /aria-expanded="false"/);
  assert.match(html, /data-tour="wrongbook-list"/, 'the tour still finds the list');
});

test('the header keeps the group action visible while folded, and counts only the questions that can still get variants', () => {
  const t = text(render());
  assert.match(t, /为本组生成变式 \(3\)/);
  assert.match(t, /为本组生成变式 \(1\)/);
  assert.equal(count(t, /为本组生成变式/g), 2);
});

test('opening a group draws its rows; the open state is keyed by group id', () => {
  const html = render({ initial: { groups: ['deck:d4'] } });
  assert.equal(count(html, /class="wb-row[ "]/g), 3);
  assert.match(text(html), /熔断器处于哪种保护状态/);
  assert.doesNotMatch(text(html), /半开状态下允许/);
  const heads = html.match(/<button[^>]*class="[^"]*wb-group-toggle[^"]*"[^>]*>/g);
  assert.match(heads[0], /aria-expanded="true"/);
  assert.match(heads[1], /aria-expanded="false"/);
  assert.equal(count(render({ initial: { groups: 'all' } }), /class="wb-row[ "]/g), 5);
});

test('全部展开 / 全部收起: each is disabled when it would change nothing', () => {
  const folded = render();
  assert.match(buttonWith(folded, '全部收起'), /disabled=""/);
  assert.doesNotMatch(buttonWith(folded, '全部展开'), /disabled/);
  const open = render({ initial: { groups: 'all' } });
  assert.match(buttonWith(open, '全部展开'), /disabled=""/);
  assert.doesNotMatch(buttonWith(open, '全部收起'), /disabled/);
});

test('by topic is still there, remembered per viewer, and folded too', () => {
  const html = render({ initial: { groupBy: 'topic' } });
  assert.match(html, /aria-pressed="true"[^>]*>按主题/);
  assert.match(text(html), /保护状态 2 题/);
  assert.match(text(html), /来自 期末综合卷04、期末综合卷02/);
  assert.equal(count(html, /class="wb-row[ "]/g), 0);
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage({ 'study-wrongbook-groupby': 'topic' }) });
    assert.match(render(), /aria-pressed="true"[^>]*>按主题/, 'the learner\'s earlier choice wins over the default');
    assert.match(render({ initial: { groupBy: 'deck' } }), /aria-pressed="true"[^>]*>按题组/, 'an explicit initial wins over the stored one');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved); else delete globalThis.localStorage;
  }
});

test('the filter bar: deck picker, status chips, text search, and a result line', () => {
  const html = render();
  assert.match(html, /role="search"/);
  assert.match(html, /<select[^>]*aria-label="题组"/, 'the deck picker (a Combobox) is named');
  const picker = html.match(/<select[^>]*aria-label="题组"[\s\S]*?<\/select>/)[0];
  assert.match(picker, /全部题组/);
  assert.match(picker, /期末综合卷04 · 3 题/);
  assert.match(picker, /期末综合卷02 · 2 题/);
  assert.match(html, /<input[^>]*type="search"[^>]*aria-label="搜索题目或主题"/);
  assert.match(buttonWith(html, '全部 5'), /aria-pressed="true"/, 'all is on by default');
  assert.match(buttonWith(html, '答错 4'), /aria-pressed="false"/);
  assert.match(buttonWith(html, '未掌握 1'), /aria-pressed="false"/);
  assert.match(text(html), /显示 5 \/ 共 5 题/);
  assert.equal(buttonWith(html, '清除筛选'), undefined, 'nothing to clear while nothing is filtered');
});

test('口头评估 and 批改未达标 get a chip only when the library has such rows', () => {
  assert.ok(!(render().match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []).some((tag) => /口头评估|批改未达标/.test(tag)), 'no such chip while there are no such rows');
  const withOral = [...items, row('o1', 'd4', '口头', '口头题', 'oral')];
  const html = render({ items: withOral, counts: { ...base.counts, total: 6, oral: 1 } });
  assert.match(buttonWith(html, '口头评估 1'), /aria-pressed="false"/);
});

test('a status filter narrows the list, the result line, the chips and every button that costs a model call', () => {
  const html = render({ initial: { filter: { status: 'graded' }, groups: 'all' } });
  const t = text(html);
  assert.match(t, /显示 4 \/ 共 5 题/);
  assert.match(t, /清除筛选/);
  assert.equal(count(html, /class="wb-row[ "]/g), 4);
  assert.doesNotMatch(t, /为全部错题生成变式/);
  assert.match(t, /为当前筛选的 4 题生成变式/);
  assert.equal(count(t, /为本组生成变式/g), 2, 'both groups still have rows, so each keeps its button');
  assert.match(t, /一次最多 8 题/);
  assert.match(buttonWith(html, '答错 4'), /aria-pressed="true"/);
  // A filter that leaves one question has the question's own generate button: the batch and the group's would say the same (#675).
  const one = text(render({ initial: { filter: { status: 'self' }, groups: 'all' } }));
  assert.match(one, /显示 1 \/ 共 5 题/);
  assert.doesNotMatch(one, /为当前筛选的|为本组生成变式/);
  assert.match(one, /生成变式/);
});

test('without a filter the batch button keeps its old words', () => {
  const t = text(render());
  assert.match(t, /为全部错题生成变式/);
  assert.doesNotMatch(t, /为当前筛选/);
  assert.match(t, /每道题约 1 次轻量模型调用，一次最多 8 题/, 'the cost and the cap are in its tooltip (#577)');
});

test('the batch acts on what the filter shows, never on hidden rows, and keeps the cap', () => {
  const many = Array.from({ length: 20 }, (_, i) => row(`m${i}`, i < 12 ? 'd4' : 'd2', `主题${i % 3}`, `第 ${i} 题`));
  // The selection is the model's job: the rows the button acts on are the filtered rows (not the loaded ones), in server order, capped at the batch size.
  const shown = filterRows(many, { ...NO_FILTER, deck: 'd2' });
  assert.deepEqual(shown.map((r) => r.cardId), many.slice(12).map((r) => r.cardId));
  assert.ok(shown.slice(0, VARIANT_BATCH_CAP).every((r) => r.deckId === 'd2'));
  const t = text(render({ items: many, counts: { ...base.counts, total: 20, graded: 20 }, coach: { ...coach, readyCards: [] }, initial: { filter: { deck: 'd2' } } }));
  assert.match(t, /显示 8 \/ 共 20 题/);
  assert.match(t, /为当前筛选的 8 题生成变式/);
  const all = text(render({ items: many, counts: { ...base.counts, total: 20, graded: 20 }, coach: { ...coach, readyCards: [] }, initial: { filter: { query: '第' } } }));
  assert.match(all, /显示 20 \/ 共 20 题/);
  assert.match(all, /为当前筛选的 20 题生成变式/);
  assert.match(all, /一次最多 8 题/, 'the cap is still said next to the button');
});

test('the deck filter hides the other decks everywhere, and a group in the filtered view can drop the filter button', () => {
  const html = render({ initial: { filter: { deck: 'd2' } } });
  const t = text(html);
  assert.match(t, /期末综合卷02 2 题/);
  assert.doesNotMatch(t, /期末综合卷04 3 题/);
  assert.doesNotMatch(t, /只看这个题组/, 'the one visible group is already the filter');
  assert.match(render(), /只看这个题组/);
  assert.equal(count(text(render()), /只看这个题组/g), 2, 'on every group header');
});

test('an empty result says so in plain words and offers to clear the filter', () => {
  const html = render({ initial: { filter: { query: '不存在的词' } } });
  const t = text(html);
  assert.match(t, /没有符合筛选的错题/);
  assert.match(t, /显示 0 \/ 共 5 题/);
  assert.match(t, /清除筛选/);
  assert.equal(count(t, /清除筛选/g), 2, 'in the bar and under the sentence');
  assert.doesNotMatch(t, /为当前筛选的/, 'nothing to generate for');
  assert.equal(count(html, /class="wb-group[ "]/g), 0);
});

test('hover words: 答错 vs 未掌握, 生成变式, 只看这个题组, the grouping and the cap, all in the project Tooltip with a focusable anchor', () => {
  const html = render({ initial: { groups: 'all' } });
  assert.doesNotMatch(html, /<span[^>]*class="wb-grade[^"]*"[^>]*\stitle=/, 'the 答错 / 未掌握 mark explains itself in a Tooltip, not a title attribute');
  assert.doesNotMatch(html, /<(?:span|div|small|strong)\b[^>]*class="[^"]*wb-(?:group|filter|summary|status-group)[^"]*"[^>]*\stitle=/);
  const tips = html.match(/<span[^>]*role="tooltip"[^>]*>[\s\S]*?<\/span>/g) || [];
  const said = (pattern) => tips.filter((tip) => pattern.test(tip));
  assert.ok(said(/答错：/).length >= 2, 'the chip and the row badge explain 答错');
  assert.ok(said(/未掌握：/).length >= 2, 'the chip and the row badge explain 未掌握');
  assert.ok(said(/轻量模型调用[\s\S]*最多 8 题|最多 8 题[\s\S]*轻量模型调用/).length >= 1, '生成变式 says it uses a light model call and the cap');
  assert.ok(said(/先备好等你/).length >= 1, 'and that the variants are kept ready, not called a draft (草稿 is a deck waiting to be published)');
  assert.ok(said(/只显示这个题组/).length >= 1);
  assert.ok(said(/按题组[\s\S]*按主题|按主题[\s\S]*按题组/).length >= 1, 'the grouping toggle says what each shows');
  // Every tooltip is tied to something a keyboard can reach: a button, or a span with tabindex.
  const described = html.match(/<(?:button|span|div)\b[^>]*aria-describedby="[^"]+"[^>]*>/g) || [];
  assert.ok(described.length >= tips.length, 'every tooltip has an anchor that points at it');
  for (const tag of described) assert.ok(/^<button\b/.test(tag) || /\btabindex="0"/.test(tag) || /role="group"/.test(tag), `anchor is focusable: ${tag.slice(0, 80)}`);
});

test('when the cap applies, the result line says so on hover', () => {
  const many = Array.from({ length: 20 }, (_, i) => row(`m${i}`, 'd4', 'T', `第 ${i} 题`));
  const html = render({ items: many, counts: { ...base.counts, total: 20, graded: 20 }, coach: { ...coach, readyCards: [] }, initial: { filter: { query: '第' } } });
  const tips = (html.match(/<span[^>]*role="tooltip"[^>]*>[\s\S]*?<\/span>/g) || []).join(' ');
  assert.match(tips, /一次最多 8 题/);
  assert.match(html, /<span[^>]*tabindex="0"[^>]*aria-describedby="[^"]+"[^>]*>显示 20/);
  const few = render({ initial: { filter: { status: 'self' } } });
  assert.doesNotMatch(few, /<span[^>]*tabindex="0"[^>]*>显示/, 'no tooltip on the line while the cap does not matter');
});

test('300+ mistakes stay cheap: folded groups draw only their headers', () => {
  const bigDecks = Array.from({ length: 12 }, (_, i) => ({ id: `D${i}`, course: 'PE', title: `PE｜卷${i}｜90题` }));
  const big = Array.from({ length: 360 }, (_, i) => ({ deckId: `D${i % 12}`, deckTitle: bigDecks[i % 12].title, cardId: `k${i}`, topic: `T${i % 7}`, prompt: `Question ${i}`,
    assessment: i % 3 ? 'graded' : 'self', lastGrade: 1, lastAt: `2026-10-01T10:${String(i % 60).padStart(2, '0')}:00Z`, kind: 'quiz' }));
  const html = render({ data: { ...base.data, decks: bigDecks }, items: big, counts: { total: 360, graded: 240, self: 120, oral: 0, rubric: 0 }, coach: null });
  assert.equal(count(html, /class="wb-row[ "]/g), 0);
  assert.equal(count(html, /wb-group-toggle/g), 12);
  assert.match(text(html), /显示 360 \/ 共 360 题/);
  assert.ok(html.length < 150_000, `folded page is ${html.length} bytes`);
  const open = render({ data: { ...base.data, decks: bigDecks }, items: big, counts: { total: 360, graded: 240, self: 120, oral: 0, rubric: 0 }, coach: null, initial: { groups: ['deck:D0'] } });
  assert.equal(count(open, /class="wb-row[ "]/g), 30, 'one open group draws its own 30 rows');
});

test('English: the whole new surface is translated while question text stays as written', () => {
  const english = { ...base, items: [
    { ...row('c1', 'd4', 'Circuit breaker', 'Which state rejects every request?'), deckTitle: 'Platform Engineering | Final 04 | 90 questions' },
    { ...row('c3', 'd4', 'Org design', 'How do platform teams split duties?', 'self'), deckTitle: 'Platform Engineering | Final 04 | 90 questions' },
    { ...row('c4', 'd2', 'circuit  breaker', 'How many probes are allowed?'), deckTitle: 'Platform Engineering | Final 02 | 90 questions' }],
  counts: { total: 3, graded: 2, self: 1, oral: 0, rubric: 0 }, coach: { ...coach, readyCards: [] } };
  try {
    setUiLanguage('en');
    const view = (extra = {}) => renderToStaticMarkup(React.createElement(WrongBookView, { ...english, ...extra }));
    const folded = view();
    assert.doesNotMatch(folded, han);
    assert.match(text(folded), /By deck/);
    assert.match(text(folded), /Showing 3 of 3 questions/);
    assert.match(text(folded), /Incorrect 1 · Not mastered 1/);
    assert.match(text(folded), /Generate variants for all mistakes/);
    assert.match(text(folded), /Expand all/);
    assert.match(text(folded), /Collapse all/);
    assert.match(text(folded), /Only this deck/);
    const filtered = view({ initial: { filter: { status: 'graded' }, groups: 'all' } });
    assert.doesNotMatch(filtered, han);
    assert.match(text(filtered), /Showing 2 of 3 questions/);
    assert.match(text(filtered), /Clear filters/);
    assert.match(text(filtered), /Generate variants for the filtered questions \(2\)/);
    const none = view({ initial: { filter: { query: 'zzz' } } });
    assert.doesNotMatch(none, han);
    assert.match(text(none), /No mistakes match the filters/);
  } finally { setUiLanguage('zh'); }
});

function mountSync(Component, initialProps) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  const cleanups = [];
  let cursor = 0;
  let pending = [];
  let currentProps = initialProps;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const renderTree = (nextProps = currentProps) => {
    currentProps = nextProps;
    cursor = 0;
    pending = [];
    const prev = internals.H;
    internals.H = {
      useContext: (ctx) => ctx._currentValue,
      useState: (init) => {
        const i = cursor++;
        if (!(i in hooks)) hooks[i] = [typeof init === 'function' ? init() : init, (val) => {
          hooks[i][0] = typeof val === 'function' ? val(hooks[i][0]) : val;
        }];
        return hooks[i];
      },
      useRef: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
      useMemo: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
      useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
      useEffect: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) pending.push({ i, fn, deps }); },
      useLayoutEffect: (fn, deps) => internals.H.useEffect(fn, deps),
      useInsertionEffect: (fn, deps) => internals.H.useEffect(fn, deps),
      useId: () => { const i = cursor++; if (!(i in hooks)) hooks[i] = `:wf${i}:`; return hooks[i]; },
      useDeferredValue: (v) => v,
    };
    let tree;
    try { tree = Component(currentProps); } finally { internals.H = prev; }
    for (const eff of pending) {
      cleanups[eff.i]?.();
      cleanups[eff.i] = undefined;
      const done = eff.fn();
      hooks[eff.i] = { deps: eff.deps };
      if (typeof done === 'function') cleanups[eff.i] = done;
    }
    return tree;
  };
  return { render: renderTree, unmount: () => { for (const c of cleanups) c?.(); } };
}

function walkEls(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) walkEls(c, visit); return; }
  if (node.props) {
    visit(node);
    walkEls(node.props.children, visit);
    walkEls(node.props.description, visit);
  }
}

const elText = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(elText).join('');
  return typeof node === 'object' && node.props ? elText(node.props.children) : '';
};

test('#8: RowDetail places your answer and correct answer side-by-side in .wb-compare only when both are non-empty', () => {
  setUiLanguage('zh');
  const bothHtml = render({
    initial: { groups: ['deck:d4'], expanded: ['c1', 'c2'] },
    details: {
      c1: { deckId: 'd4', cardId: 'c1', yourAnswer: '半开状态', correctAnswer: '熔断状态', explanation: '解析', misconception: '' },
      c2: { deckId: 'd4', cardId: 'c2', yourAnswer: '', correctAnswer: '减少耦合', explanation: '', misconception: '' },
    },
  });
  assert.equal(count(bothHtml, /class="wb-compare"/g), 1, 'only row with both answers renders .wb-compare');
  const compareSlice = bothHtml.split('class="wb-compare"')[1].split('</div></div>')[0];
  assert.match(compareSlice, /<dt>你的答案<\/dt>/);
  assert.match(compareSlice, /<dt>正确答案<\/dt>/);
  assert.match(bothHtml, /<dl class="wb-facts">[\s\S]*<div class="wb-compare">[\s\S]*<\/dl>/);

  const selfRatedHtml = render({
    initial: { groups: ['deck:d4'], expanded: ['c3'] },
    details: { c3: { deckId: 'd4', cardId: 'c3', selfGrade: 2, yourAnswer: '', correctAnswer: '平台团队负责共享能力', explanation: '', misconception: '' } },
  });
  assert.equal(count(selfRatedHtml, /class="wb-compare"/g), 1, 'selfGrade + correctAnswer also pairs in .wb-compare');
});

test('#9: PageHeader status counts are interactive filter toggles even when total < filterMin', () => {
  setUiLanguage('zh');
  const shortItems = [
    row('s1', 'd4', 'T1', 'Q1', 'graded'),
    row('s2', 'd4', 'T2', 'Q2', 'self'),
  ];
  const app = mountSync(WrongBookView, {
    ...base,
    items: shortItems,
    counts: { total: 2, graded: 1, self: 1, oral: 0, rubric: 1 },
    filterMin: 8,
  });
  let tree = app.render();
  const findToggle = (needle) => {
    let found = null;
    walkEls(tree, (n) => { if (!found && typeof n.type !== 'string' && n.props.className === 'wb-count-toggle' && elText(n).includes(needle)) found = n; });
    return found;
  };
  const gradedBtn = findToggle('客观答错 1 题');
  const selfBtn = findToggle('未掌握 1 题');
  const rubricBtn = findToggle('按评分标准批改未达标 1 题');
  assert.ok(gradedBtn && selfBtn && rubricBtn, 'non-zero counts render as toggle buttons even below filterMin');
  assert.equal(findToggle('口头评估待巩固 0 题'), null, 'zero counts remain plain text');
  assert.equal(gradedBtn.props['aria-pressed'], false);

  gradedBtn.props.onClick();
  tree = app.render();
  assert.equal(findToggle('客观答错 1 题').props['aria-pressed'], true);
  // Only graded row s1 remains in the rendered group
  const htmlFiltered = render({ items: shortItems, counts: { total: 2, graded: 1, self: 1, oral: 0, rubric: 1 }, filterMin: 8, initial: { filter: { status: 'graded' } } });
  assert.match(text(htmlFiltered), /客观答错 1 题/);
  assert.match(htmlFiltered, /aria-pressed="true"[^>]*>客观答错 1 题</);
  findToggle('客观答错 1 题').props.onClick();
  tree = app.render();
  assert.equal(findToggle('客观答错 1 题').props['aria-pressed'], false);
  app.unmount();
});

test('#10: Escape on .wb-search-input clears query first while keeping focus, then blurs on second Escape; filter-result is polite', () => {
  setUiLanguage('zh');
  const html = render();
  assert.match(html, /class="wb-filter-result" role="status" aria-live="polite"/);

  const app = mountSync(WrongBookView, { ...base, initial: { filter: { query: '熔断' } } });
  let tree = app.render();
  const findInput = () => {
    let found = null;
    walkEls(tree, (n) => { if (!found && n.props?.className === 'wb-search-input') found = n; });
    return found;
  };
  let prevented = false, stopped = false, blurred = false;
  findInput().props.onKeyDown({
    key: 'Escape',
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
    currentTarget: { blur: () => { blurred = true; } },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(blurred, false, 'first Escape keeps focus in search input');

  tree = app.render();
  assert.equal(findInput().props.value, '', 'first Escape cleared search query');

  let secondPrevented = false, secondStopped = false;
  findInput().props.onKeyDown({
    key: 'Escape',
    preventDefault: () => { secondPrevented = true; },
    stopPropagation: () => { secondStopped = true; },
    currentTarget: { blur: () => { blurred = true; } },
  });
  assert.equal(blurred, true, 'second Escape when empty blurs search input');
  assert.equal(secondPrevented, false);
  assert.equal(secondStopped, false);
  app.unmount();
});

test('#46: sortGroupRows sorts by recent, most missed, and original deck order and persists preference', () => {
  assert.deepEqual(SORT_KINDS, ['recent', 'most', 'order']);
  const storage = memoryStorage();
  assert.equal(readSortBy(storage), 'recent');
  saveSortBy('most', storage);
  assert.equal(readSortBy(storage), 'most');
  storage.setItem('study-wrongbook-sort', 'invalid');
  assert.equal(readSortBy(storage), 'recent');
  assert.equal(readSortBy({ getItem() { throw new Error('blocked'); } }), 'recent');

  const decksWithOrder = [{ id: 'd4', title: decks[0].title, cards: [{ id: 'c2' }, { id: 'c3' }, { id: 'c1' }] }];
  const mixed = [
    row('c1', 'd4', 'T', 'Q1', 'graded', '2026-10-01T08:00:00Z'),
    row('c2', 'd4', 'T', 'Q2', 'graded', '2026-10-01T12:00:00Z'),
    row('c3', 'd4', 'T', 'Q3', 'graded', '2026-10-01T10:00:00Z'),
  ];
  const groups = groupRows(mixed, 'deck', decksWithOrder);
  assert.deepEqual(sortGroupRows(groups, 'recent')[0].rows.map((r) => r.cardId), ['c2', 'c3', 'c1']);
  const wrongCounts = new Map([['d4\0c1', 5], ['d4\0c2', 2], ['d4\0c3', 2]]);
  assert.deepEqual(sortGroupRows(groups, 'most', { wrongCounts })[0].rows.map((r) => r.cardId), ['c1', 'c2', 'c3']);
  assert.deepEqual(sortGroupRows(groups, 'order', { decks: decksWithOrder })[0].rows.map((r) => r.cardId), ['c2', 'c3', 'c1']);

  const distinct = [
    row('c1', 'd4', 'T', 'Q1', 'graded', '2026-10-01T10:00:00Z'),
    row('c2', 'd4', 'T', 'Q2', 'graded', '2026-10-01T08:00:00Z'),
    row('c3', 'd4', 'T', 'Q3', 'graded', '2026-10-01T12:00:00Z'),
  ];
  const distinctGroups = groupRows(distinct, 'deck', decksWithOrder);
  const distinctCounts = new Map([['d4\0c1', 5], ['d4\0c2', 3], ['d4\0c3', 1]]);
  assert.deepEqual(sortGroupRows(distinctGroups, 'recent', { wrongCounts: distinctCounts, decks: decksWithOrder })[0].rows.map((r) => r.cardId), ['c3', 'c1', 'c2']);
  assert.deepEqual(sortGroupRows(distinctGroups, 'most', { wrongCounts: distinctCounts, decks: decksWithOrder })[0].rows.map((r) => r.cardId), ['c1', 'c2', 'c3']);
  assert.deepEqual(sortGroupRows(distinctGroups, 'order', { wrongCounts: distinctCounts, decks: decksWithOrder })[0].rows.map((r) => r.cardId), ['c2', 'c3', 'c1']);
  assert.deepEqual(sortGroupRows(distinctGroups, undefined, { wrongCounts: distinctCounts, decks: decksWithOrder })[0].rows.map((r) => r.cardId), ['c3', 'c1', 'c2']);

  setUiLanguage('zh');
  const htmlZh = render();
  assert.match(htmlZh, /aria-label="排序方式"/);
  assert.match(text(htmlZh), /最近 错次 原序/);

  setUiLanguage('en');
  try {
    const enDecks = [{ id: 'd4', course: 'PE', title: 'Platform Engineering | Final 04' }, { id: 'd2', course: 'PE', title: 'Platform Engineering | Final 02' }];
    const enItems = [
      { ...row('e1', 'd4', 'Breaker', 'Which state rejects?'), deckTitle: enDecks[0].title },
      { ...row('e2', 'd2', 'Probe', 'How many probes?'), deckTitle: enDecks[1].title },
    ];
    const htmlEn = render({ data: { ...base.data, decks: enDecks }, items: enItems, counts: { total: 2, graded: 2, self: 0, oral: 0, rubric: 0 }, coach: null });
    assert.doesNotMatch(htmlEn, han);
    assert.match(htmlEn, /aria-label="Sort order"/);
    assert.match(text(htmlEn), /Recent Most missed Deck order/);
  } finally { setUiLanguage('zh'); }
});

test('#50: search query highlights matches with .wb-hit in meta and plain text without breaking math', () => {
  setUiLanguage('zh');
  const mathItems = [
    ...items,
    row('cm', 'd4', '公式', '状态转移满足 $x^2 + y^2 = r^2$，何时拒绝？', 'graded', '2026-10-01T13:00:00Z'),
  ];
  const html = render({
    items: mathItems,
    counts: { total: 6, graded: 5, self: 1, oral: 0, rubric: 0 },
    initial: { groups: ['deck:d4'], filter: { query: '状态' } },
  });
  assert.match(html, /<span class="wb-meta"><span class="wb-hit">状态<\/span>|<span class="wb-meta">[^<]*<span class="wb-hit">状态<\/span>/);
  assert.match(html, /<span class="wb-prompt"><span class="wb-hit">状态<\/span>转移满足 /);
  assert.match(html, /katex|x\^2/, 'inline math stays rendered cleanly alongside highlighted prose');
});

