import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* #748: the mistakes page has no overview, so with dozens of mistakes a learner opens groups one by one. 薄弱点分布 is one bar over the groups the list
   already shows: a segment per group, its count drawn in it (the second cue beside the width), a tooltip whose words are the button's aria-label, an
   empty line when the filter leaves nothing, and the same threshold as the toolbar (#675). Hovering and clicking it are walked in
   tests/wrongbook-distribution-browser.test.mjs. */

const m = await loadUi(`export { WrongBookView, WeaknessBar, weaknessFacts } from './ui/WrongBook.jsx';
  export { groupRows } from './ui/wrongbook-model.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const { WrongBookView, WeaknessBar, weaknessFacts, groupRows, setUiLanguage } = m;
const noop = () => {};

const decks = [{ id: 'd4', course: 'PE', title: '期末综合卷04｜90题' }, { id: 'd2', course: 'PE', title: '期末综合卷02｜90题' }];
const row = (cardId, deckId, topic) => ({ deckId, deckTitle: decks.find((deck) => deck.id === deckId).title, cardId, topic, prompt: `${topic} 的题目 ${cardId}`,
  assessment: 'graded', lastGrade: 1, lastAt: '2026-10-01T10:00:00Z', kind: 'quiz' });
// Twelve mistakes over two decks and three topics: enough for the bar (#675 asks for ten).
const items = [];
for (const [deck, topic, count] of [['d4', '保护状态', 5], ['d4', '集成收益', 2], ['d2', '恢复探测', 5]])
  for (let at = 0; at < count; at++) items.push(row(`${deck}-${topic}-${at}`, deck, topic));
const base = { data: { root: 'r', decks, focus: { course: 'PE', courses: [{ name: 'PE' }] }, model: { ready: true } }, course: 'PE', onCourse: noop,
  items, counts: { total: items.length, graded: items.length, self: 0, oral: 0, rubric: 0 }, loading: false, err: '', page: 0, pageSize: 100, hasMore: false,
  onReload: noop, onPage: noop, recs: null, coach: { enabled: false, consent: false, ready: 0, preparing: false, readyCards: [], failedCards: [], tasks: [] },
  details: {}, onLoadDetail: noop, onPractice: noop, onPracticePrepared: noop, onGenerate: async () => ({}), onOpenSettings: noop, busy: false };
const render = (extra = {}) => renderToStaticMarkup(React.createElement(WrongBookView, { ...base, ...extra }));
const groupsOf = (list, mode = 'deck') => groupRows(list, mode, decks);

test('a segment says its title, count, share and what a press does, and 0 分 is not lost (#748)', () => {
  setUiLanguage('zh');
  const one = groupsOf(items, 'deck')[0];
  assert.deepEqual(weaknessFacts(one, 12), ['期末综合卷04', '7 题', '占 58%', '只看这个题组']);
  const shared = groupsOf([row('s1', 'd4', '共同主题'), row('s2', 'd2', '共同主题')], 'topic').find((group) => group.deckIds.length > 1);
  assert.deepEqual(weaknessFacts(shared, 12).slice(3), ['展开这一组'], 'a topic that spans decks has no single-deck filter to apply');
  assert.deepEqual(weaknessFacts({ title: 'x', rows: [{}, {}, {}], deckIds: ['d'] }, 30).slice(2), ['占 10%', '只看这个题组']);
});

test('the page draws the bar from ten mistakes on, one segment per group, in the page\'s own grouping (#675 #748)', () => {
  setUiLanguage('zh');
  assert.doesNotMatch(render({ filterMin: 10, items: items.slice(0, 9), counts: { ...base.counts, total: 9 } }), /wb-dist/, 'a short list has nothing to survey');
  const html = render({ filterMin: 10 });
  assert.match(html, /class="wb-dist"/);
  assert.match(html, /薄弱点分布/);
  assert.match(html, /2 组 · 共 12 题/, 'the page groups by deck, so the bar has one segment per deck');
  const segments = html.match(/<button[^>]*wb-dist-seg[\s\S]*?<\/button>/g) || [];
  assert.equal(segments.length, 2, 'one segment per group');
  assert.match(segments[0], /aria-label="期末综合卷04 · 7 题 · 占 58% · 只看这个题组"/);
  assert.match(segments[0], /style="flex-grow:7"/, 'the width is the count');
  assert.match(segments[0], /<span aria-hidden="true">7<\/span>/, 'the number is the second, non-colour cue');
  assert.match(segments[0], /class="[^"]*\bsh-btn\b/, 'the shared Button, not a raw button');
  assert.equal((html.match(/wb-dist-legend"[\s\S]*?<\/ul>/)[0].match(/wb-num/g) || []).length, 2, 'the legend names every group');
});

test('the bar follows the filter and the grouping, and says so when nothing is left (#748)', () => {
  setUiLanguage('zh');
  const byTopic = render({ filterMin: 10, initial: { groupBy: 'topic' } });
  assert.match(byTopic, /3 组 · 共 12 题/, 'the bar follows 按主题: one segment per topic');
  assert.match(byTopic, /只看这个题组/, 'each topic here lives in one deck');
  // A filter that hides everything leaves the empty line, not a zero-width bar.
  const empty = render({ filterMin: 10, initial: { filter: { deck: '', status: 'all', query: '没有这个' } } });
  assert.match(empty, /wb-dist-empty/);
  assert.match(empty, /当前筛选下没有错题/);
  assert.doesNotMatch(empty, /wb-dist-seg/);
  // The history view is a record, not a picture of weakness.
  assert.doesNotMatch(render({ filterMin: 10, view: 'history' }), /wb-dist/);
});

test('a bar with more groups than the legend fits still draws every segment (#748)', () => {
  setUiLanguage('zh');
  const many = [];
  for (let index = 0; index < 12; index++) for (let at = 0; at < 2; at++) many.push(row(`m${index}-${at}`, 'd4', `主题 ${index}`));
  const html = render({ filterMin: 10, items: many, counts: { ...base.counts, total: many.length }, initial: { groupBy: 'topic' } });
  assert.equal((html.match(/wb-dist-seg/g) || []).length, 12, 'every group is on the bar');
  assert.match(html, /另有 4 组，按数量排在后面/);
});

test('WeaknessBar alone draws the tooltip surface only when it is given a point (#748)', () => {
  setUiLanguage('zh');
  const groups = groupsOf(items, 'deck');
  const html = renderToStaticMarkup(React.createElement(WeaknessBar, { groups, onPick: noop }));
  assert.match(html, /class="wb-dist-bar"/);
  assert.doesNotMatch(html, /sh-tooltip--point/, 'nothing is under the pointer or the focus at rest');
});
