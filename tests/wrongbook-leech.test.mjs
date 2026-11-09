/* 顽固题 in the wrong book (#884 S2): a small 顽固 state mark on the row of a question that keeps being failed, in both views; the rescue actions that already exist
   in the opened detail only (a collapsed row gains no control, #675); a filter that shows just those; every word in both languages. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';

const m = await loadUi(`export { WrongBookView } from './ui/WrongBook.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { setUiLanguage } from './ui/i18n.js';
  export { NO_FILTER, filterActive, filterRows, leechCount, leechWords, rescueCall, rescueNote } from './ui/wrongbook-model.js';`);
const { WrongBookView, setUiLanguage, NO_FILTER, filterActive, filterRows, leechCount, leechWords, rescueCall, rescueNote } = m;
const noop = () => {};
const han = /\p{Script=Han}/u;
const decks = [{ id: 'd4', course: 'PE', title: 'Platform Engineering｜期末综合卷04｜90题' }];
const row = (cardId, leech, extra = {}) => ({ deckId: 'd4', deckTitle: decks[0].title, cardId, topic: `主题${cardId}`, prompt: `第 ${cardId} 题？`, assessment: 'graded', lastGrade: 1,
  lastAt: '2026-10-01T10:00:00Z', kind: 'quiz', leech, ...extra });
const coach = { enabled: true, consent: true, ready: 0, preparing: false, preparingCards: [], readyCards: [], failedCards: [], tasks: [] };
const countsOf = (items) => ({ total: items.length, graded: items.length, self: 0, oral: 0, rubric: 0 });
const base = { data: { root: 'r', decks, focus: { course: 'PE', courses: [{ name: 'PE' }] }, model: { ready: true }, settings: {} }, course: 'PE', onCourse: noop,
  loading: false, err: '', page: 0, pageSize: 100, hasMore: false, onReload: noop, onPage: noop, recs: null, coach, details: {}, onLoadDetail: noop, onPractice: noop,
  onPracticePrepared: noop, onGenerate: async () => ({}), onOpenSettings: noop, onRescue: noop };
const render = (items, extra = {}) => renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(WrongBookView, { ...base, items, counts: countsOf(items), ...extra }), {}));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const controls = (html) => (html.replace(/<div role="group"[\s\S]*?<\/div>/g, '<button></button>').match(/<(button|select|input|textarea)\b/g) || []).length;
const detail = { c1: { deckId: 'd4', cardId: 'c1', correctAnswer: 'A', explanation: '因为…', yourAnswer: 'B', missedAt: '2026-10-01T10:00:00Z' } };

test('the model: a filter for 顽固题, off by default, and the count the chip shows', () => {
  const rows = [row('c1', true), row('c2', false), row('c3', true), row('c4')];
  assert.equal(NO_FILTER.leech, false);
  assert.equal(filterActive(NO_FILTER), false);
  assert.equal(filterActive({ ...NO_FILTER, leech: true }), true);
  assert.deepEqual(filterRows(rows, { ...NO_FILTER, leech: true }).map((r) => r.cardId), ['c1', 'c3']);
  assert.equal(filterRows(rows, NO_FILTER), rows);
  assert.equal(leechCount(rows), 2);
  assert.equal(leechCount([]), 0);
  assert.equal(leechCount(undefined), 0);
});

test('the mark\'s words give the thresholds from the settings, in plain words', () => {
  setUiLanguage('zh');
  const words = leechWords({ failures: 4, window: 5, rate: 60 });
  assert.match(words.sentence, /答错 4 次/);
  assert.match(words.sentence, /最近 5 次/);
  assert.match(words.sentence, /60%/);
  assert.match(leechWords({ failures: 7, window: 8, rate: 75 }).sentence, /答错 7 次.*最近 8 次.*75%/);
  assert.ok(words.consequence);
  setUiLanguage('en');
  try {
    const english = leechWords({ failures: 4, window: 5, rate: 60 });
    assert.doesNotMatch(english.sentence + english.consequence, han);
    assert.match(english.sentence, /4 times/);
  } finally { setUiLanguage('zh'); }
});

test('both views mark a leech row with 顽固 and leave the others alone', () => {
  setUiLanguage('zh');
  const items = [row('c1', true), row('c2', false)];
  const weak = text(render(items));
  assert.equal((weak.match(/顽固/g) || []).length, 1);
  const history = text(render([row('c1', true, { wrongCount: 4, lastWrongAt: '2026-10-01T10:00:00Z' }), row('c2', false, { wrongCount: 1, lastWrongAt: '2026-10-01T10:00:00Z' })],
    { view: 'history', onView: noop, viewCounts: { weak: 0, history: 2 } }));
  assert.equal((history.match(/顽固/g) || []).length, 1);
  assert.equal((text(render([row('c2', false)])).match(/顽固/g) || []).length, 0, 'no leech, no mark and no word about it');
});

test('a collapsed row gains no control: the page has exactly as many controls with a leech as without (#675)', () => {
  setUiLanguage('zh');
  const plain = [row('c1', false), row('c2', false)];
  const stubborn = [row('c1', true), row('c2', true)];
  assert.equal(controls(render(stubborn)), controls(render(plain)));
  assert.doesNotMatch(text(render(stubborn)), /交给后台修|补一张前置|暂停此题/, 'the actions are not on the page until a row is opened');
});

test('an opened leech row shows its four existing actions as one short group with a one-line explanation', () => {
  setUiLanguage('zh');
  const html = render([row('c1', true), row('c2', false)], { initial: { expanded: ['c1'] }, details: detail });
  const t = text(html);
  assert.match(t, /这道题总是答错/);
  for (const label of ['这题有问题，交给后台修', '太难了，补一张前置小卡', '发给主会话', '暂停此题']) assert.ok(t.includes(label), label);
  const group = html.match(/<div class="wb-sub wb-leech"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? html.match(/<div class="wb-sub wb-leech"[\s\S]*/)?.[0] ?? '';
  assert.ok(group, 'one group');
  assert.equal((group.match(/<button\b/g) || []).length, 4, 'four buttons in the group');
  assert.equal((group.match(/<p\b/g) || []).length, 1, 'one explanation line');
  // an opened row that is no leech has none of it
  assert.doesNotMatch(text(render([row('c2', false)], { initial: { expanded: ['c2'] }, details: { c2: detail.c1 } })), /这道题总是答错|暂停此题/);
});

test('the actions of the group call the page\'s handler with the kind and the row; nothing is called by drawing the page', async () => {
  setUiLanguage('zh');
  const calls = [];
  const html = render([row('c1', true)], { initial: { expanded: ['c1'] }, details: detail, onRescue: (...args) => calls.push(args) });
  assert.equal(calls.length, 0);
  assert.match(html, /data-rescue="fix"/);
  assert.match(html, /data-rescue="easier"/);
  assert.match(html, /data-rescue="pause"/);
  assert.match(html, /data-hand-off="method\.missed"/);
});

test('the filter chip: shown with the count when there are leeches, and a filter on leaves only them', () => {
  setUiLanguage('zh');
  const items = Array.from({ length: 12 }, (_, n) => row(`c${n}`, n % 4 === 0));
  const html = render(items);
  assert.match(text(html), /顽固 3/, 'a chip in the filter bar');
  const filtered = text(render(items, { initial: { filter: { leech: true } } }));
  assert.match(filtered, /显示 3 \/ 共 12 题/);
  assert.match(filtered, /清除筛选/);
  assert.doesNotMatch(text(render(items.map((r) => ({ ...r, leech: false })))), /顽固/, 'no leech, no chip');
});

test('English: the mark, the group, the chip and the actions are translated', () => {
  setUiLanguage('en');
  try {
    const items = Array.from({ length: 12 }, (_, n) => row(`c${n}`, n % 4 === 0, { topic: `T${n}`, prompt: `Q${n}?`, deckTitle: 'Deck' }));
    const html = render(items, { initial: { expanded: ['c0'], groups: 'all' }, details: { c0: { deckId: 'd4', cardId: 'c0', correctAnswer: 'A', explanation: 'because', yourAnswer: 'B' } } });
    assert.doesNotMatch(text(html).replace(/期末综合卷04|主题\d+/g, ''), han);
    assert.match(text(html), /Stubborn 3/);
    assert.match(text(html), /keeps being missed/i);
    assert.match(text(html), /Suspend question/);
  } finally { setUiLanguage('zh'); }
});

test('the rescue actions call what already exists: the thumbs-down record (no assist flag, so the background repair starts), the same with "too hard", and the suspend of the manage page', () => {
  const ref = { deckId: 'd4', cardId: 'c1' };
  assert.deepEqual(rescueCall('fix', ref), { action: 'coach.feedback', args: { ...ref, vote: 'down', tags: ['general-quality'] } });
  assert.deepEqual(rescueCall('easier', ref), { action: 'coach.feedback', args: { ...ref, vote: 'down', tags: ['too-hard'] } });
  assert.deepEqual(rescueCall('pause', ref), { action: 'card.suspend', args: { ...ref, suspended: true } });
  assert.equal('rewriteVia' in rescueCall('fix', ref).args, false, 'the silent repair is the point here: there is no 修题 box on this page');
});

test('the note after a rescue click says what really happened, never more', () => {
  setUiLanguage('zh');
  assert.equal(rescueNote('fix', { tags: ['general-quality'], scheduled: ['rewrite'] }).tone, 'success');
  assert.match(rescueNote('fix', { tags: ['general-quality'], scheduled: ['rewrite'] }).text, /交给后台修/);
  const noModel = rescueNote('fix', { tags: ['general-quality'], scheduled: [] });
  assert.equal(noModel.tone, 'info');
  assert.match(noModel.text, /没有可用的模型.*没有开始修题/);
  assert.match(rescueNote('fix', { tags: [], scheduled: [] }).text, /不会重复修题/, 'the same feedback again within the window changes nothing');
  assert.match(rescueNote('easier', { tags: ['too-hard'], scheduled: ['prep'] }).text, /前置小卡/);
  assert.equal(rescueNote('easier', { tags: ['too-hard'], scheduled: ['prep'] }).tone, 'success');
  assert.match(rescueNote('easier', { tags: ['too-hard'], scheduled: [] }).text, /同意后台准备/, 'without consent nothing is prepared, and it says how to');
  assert.equal(rescueNote('easier', { tags: ['too-hard'], scheduled: [] }).tone, 'info');
  assert.equal(rescueNote('pause', {}).tone, 'success');
  assert.equal(rescueNote('fix', undefined).tone, 'info', 'an empty answer is no success');
  setUiLanguage('en');
  try {
    for (const [kind, result] of [['fix', { tags: ['x'], scheduled: ['rewrite'] }], ['fix', { tags: ['x'], scheduled: [] }], ['fix', { tags: [], scheduled: [] }], ['easier', { tags: ['x'], scheduled: ['prep'] }],
      ['easier', { tags: ['x'], scheduled: [] }], ['easier', { tags: [], scheduled: [] }], ['pause', {}]]) assert.doesNotMatch(rescueNote(kind, result).text, han, `${kind} ${JSON.stringify(result)}`);
  } finally { setUiLanguage('zh'); }
});
