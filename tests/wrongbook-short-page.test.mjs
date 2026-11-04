/* 错题与待巩固 (#674, #675): one start button, and a page that is short when the list is short. With one mistake the page keeps what a learner needs
   (the course, the scope of the round, one start, the recommendations line, the question); the filter bar, the batch and the group-level repeats appear
   when the list is long enough to need them, and nothing asks the learner to refresh. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';

const m = await loadUi(`export { WrongBookView } from './ui/WrongBook.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { setUiLanguage } from './ui/i18n.js';
  export { FILTER_MIN, readSignature } from './ui/wrongbook-model.js';`);
const { WrongBookView, setUiLanguage, FILTER_MIN, readSignature } = m;
const noop = () => {};
const decks = [{ id: 'd4', course: 'PE', title: 'Platform Engineering｜期末综合卷04｜90题' }, { id: 'd2', course: 'PE', title: 'Platform Engineering｜期末综合卷02｜90题' }];
const row = (cardId, deckId, topic, prompt, assessment = 'graded') => ({ deckId, deckTitle: decks.find((d) => d.id === deckId).title, cardId, topic, prompt, assessment, lastGrade: 1,
  lastAt: '2026-10-01T10:00:00Z', kind: 'quiz' });
/** `n` mistakes over `deckIds` (round robin). */
const many = (n, deckIds = ['d4']) => Array.from({ length: n }, (_, index) => row(`c${index}`, deckIds[index % deckIds.length], `主题${index % 3}`, `第 ${index} 题？`, index % 4 === 3 ? 'self' : 'graded'));
const recs = { items: [0, 1].map((i) => ({ deckId: 'd2', deckTitle: decks[1].title, cardId: `r${i}`, topic: '保护状态', kind: 'quiz', prompt: `推荐题 ${i}`, score: 5, forCardIds: ['c0'],
  reasons: [{ type: 'topic', topic: '保护状态' }] })) };
const coach = { enabled: true, consent: true, ready: 0, preparing: false, preparingCards: [], readyCards: [], failedCards: [], tasks: [] };
const countsOf = (items) => ({ total: items.length, graded: items.filter((i) => i.assessment === 'graded').length, self: items.filter((i) => i.assessment === 'self').length, oral: 0, rubric: 0 });
const base = { data: { root: 'r', decks, focus: { course: 'PE', courses: [{ name: 'PE' }] }, model: { ready: true } }, course: 'PE', onCourse: noop,
  loading: false, err: '', page: 0, pageSize: 100, hasMore: false, onReload: noop, onPage: noop, recs, coach, details: {}, onLoadDetail: noop, onPractice: noop,
  onPracticePrepared: noop, onGenerate: async () => ({}), onOpenSettings: noop };
const render = (items, extra = {}) => renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(WrongBookView, { ...base, items, counts: countsOf(items), ...extra }), {}));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const buttons = (html) => (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []);
/** What a learner sees as controls: a segmented group counts once, every other button, select and input once. */
const controls = (html) => (html.replace(/<div role="group"[\s\S]*?<\/div>/g, '<button></button>').match(/<(button|select|input|textarea)\b/g) || []).length;
const primaries = (html) => buttons(html).filter((tag) => /sh-btn--primary/.test(tag));

test('one mistake: no refresh button, one primary start, at most six controls on the page (#674 #675)', () => {
  setUiLanguage('zh');
  const html = render(many(1));
  assert.doesNotMatch(text(html), /刷新/, 'the page keeps itself up to date');
  assert.equal(primaries(html).length, 1, 'one primary action on the page');
  assert.match(text(primaries(html)[0]), /开始重练/);
  assert.ok(controls(html) <= 6, `${controls(html)} controls`);
  assert.doesNotMatch(text(html), /为全部错题生成变式|全部展开|全部收起|搜索题目或主题|按状态筛选|分组方式|练这一组|只看这个题组|为本组生成变式/);
  assert.match(text(html), /生成变式/, 'the question keeps its own generate button');
});

test('the recommendations explain, they do not start: the one start takes them with the scope control (#674)', () => {
  setUiLanguage('zh');
  const html = render(many(1), { initial: { retrain: 'wrong' } });
  assert.doesNotMatch(text(html), /练这 \d+ 道/);
  assert.equal(buttons(html).filter((tag) => /开始|练这/.test(text(tag)) && !/aria-label="练习/.test(tag)).length, 1, 'exactly one start button');
  const recsBlock = html.match(/<section class="wb-recs[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(text(recsBlock), /为你推荐/);
  assert.match(text(recsBlock), /共 2 道/);
  assert.match(text(recsBlock), /选「错题 \+ 同类题」/, 'it says how to practise them');
  assert.match(text(render(many(1))), /共 2 道，已在这一轮重练里/, 'and that they are in the round when the round takes them (the default)');
  assert.equal(buttons(recsBlock).filter((tag) => /练/.test(text(tag))).length, 0, 'no start in the recommendations bar');
  // The scope control still reaches them in one start: mistakes + similar.
  assert.match(text(html), /错题 \+ 同类题 \(1\+2\)/);
});

test('one fact, one number: the start button counts what it will practise, in the scope control\'s numbers (#674)', () => {
  setUiLanguage('zh');
  const plain = text(render(many(1), { recs: { items: [] } }));
  assert.match(plain, /开始重练 · 1 题/);
  assert.doesNotMatch(plain, /全部 1 题/);
  const richer = render(many(5), { initial: { retrain: 'similar' } });
  assert.match(text(richer), /错题 \+ 同类题 \(5\+2\)/);
  assert.match(text(richer), /开始重练 · 7 题/);
  assert.match(text(richer), /已在这一轮重练里/, 'the recommendations say they are in the round when the scope takes them');
});

test('with a filter on, the primary start stays the only primary; the filtered round is a second, quieter button', () => {
  setUiLanguage('zh');
  const html = render(many(12, ['d4', 'd2']), { initial: { filter: { deck: 'd4' } } });
  assert.equal(primaries(html).length, 1);
  assert.match(text(primaries(html)[0]), /开始重练 · \d+ 题/);
  const subset = buttons(html).filter((tag) => /练筛选的 6 道/.test(text(tag)));
  assert.equal(subset.length, 1);
  assert.doesNotMatch(subset[0], /sh-btn--primary/);
});

test('a short list has no filter bar, no fold-all, no grouping switch and no batch; the group is open without a toggle (#675)', () => {
  setUiLanguage('zh');
  for (const n of [1, 3, FILTER_MIN - 1]) {
    const html = render(many(n));
    const t = text(html);
    assert.doesNotMatch(t, /搜索题目或主题|按状态筛选|全部展开|按主题|显示 \d+ \/ 共/, `${n} mistakes: no toolbar`);
    assert.doesNotMatch(html, /class="wb-toolbar"/);
    assert.match(html, new RegExp(`class="wb-row`), `${n} mistakes: the rows are there without opening a group`);
    assert.doesNotMatch(html, /class="wb-group-toggle"/, `${n} mistakes in one group: nothing to fold`);
  }
});

test('the batch generate button appears only when more than one question could use it, and the group-level repeats only with more than one group', () => {
  setUiLanguage('zh');
  assert.doesNotMatch(text(render(many(1))), /为全部错题生成变式/);
  assert.match(text(render(many(3))), /为全部错题生成变式/);
  const one = render(many(12));
  assert.doesNotMatch(text(one), /练这一组|只看这个题组|为本组生成变式/, 'one group: the page-level buttons already say it');
  assert.match(text(one), /为全部错题生成变式/);
  const two = text(render(many(12, ['d4', 'd2'])));
  assert.match(two, /练这一组/);
  assert.match(two, /只看这个题组/);
  assert.match(two, /为本组生成变式/);
});

test('from FILTER_MIN mistakes on, and always while a filter is on, the whole toolbar is there; 50 mistakes stay filterable (#675)', () => {
  setUiLanguage('zh');
  for (const n of [FILTER_MIN, 50]) {
    const html = render(many(n, ['d4', 'd2']));
    const t = text(html);
    for (const part of ['搜索题目或主题', '按状态筛选', '全部展开', '全部收起', '按主题', '按题组', '全部题组', `显示 ${n} / 共 ${n} 题`, '为全部错题生成变式'])
      assert.ok(t.includes(part) || html.includes(part), `${n} mistakes: ${part}`);
    assert.match(html, /data-tour="wrongbook-filter"/, 'the finder can light the bar');
  }
  const few = render(many(3, ['d4', 'd2']), { initial: { filter: { query: '第 1' } } });
  assert.ok(few.includes('搜索题目或主题'), 'a filter that is on keeps its bar, so it can be cleared');
  assert.match(text(few), /清除筛选/);
});

test('a single mistake is practised from the one start; its own 练 button would be a second start', () => {
  setUiLanguage('zh');
  const labelled = (html) => buttons(html).filter((tag) => /aria-label="练习/.test(tag)).length;
  assert.equal(labelled(render(many(1))), 0);
  assert.equal(labelled(render(many(2))), 2, 'with more than one question, each keeps its 练');
  assert.equal(labelled(render(many(1), { view: 'history', onView: noop, viewCounts: { weak: 0, history: 1 } })), 1, 'the history has no start, so its row keeps 练');
});

test('the failed detail no longer sends the learner to a refresh button', () => {
  setUiLanguage('zh');
  const html = text(render(many(1), { initial: { expanded: ['c0'] }, details: { c0: { error: 'x' } } }));
  assert.match(html, /没能读取这道题的详情/);
  assert.doesNotMatch(html, /刷新/);
});

test('English: the new words are translated', () => {
  setUiLanguage('en');
  try {
    const html = render(many(1));
    assert.doesNotMatch(text(html).replace(/期末综合卷0\d|主题\d 第 \d+ 题？/g, ''), /\p{Script=Han}/u);
    assert.doesNotMatch(text(html), /Refresh/);
    assert.match(text(html), /Start retraining · 3/);
    assert.match(text(html), /2 found, in this round/);
    assert.match(text(render(many(1), { initial: { retrain: 'wrong' } })), /2 found\. Choose “Mistakes \+ similar”/);
  } finally { setUiLanguage('zh'); }
});

test('the page watches its list with usePolling (never setInterval) and has no refresh button of its own (#675)', () => {
  const source = readFileSync(new URL('../ui/WrongBook.jsx', import.meta.url), 'utf8');
  assert.match(source, /usePolling\(\s*watch/);
  assert.doesNotMatch(source, /setInterval/);
  assert.doesNotMatch(source, /ui\("刷新"\)|icon="refresh"/);
});

test('readSignature: the same list reads the same; a new mistake, a corrected one or a changed count reads differently', () => {
  const page = (over = {}) => ({ view: 'weak', total: 2, counts: { weak: 2, history: 0 }, gradedTotal: 2, selfTotal: 0, oralTotal: 0, rubricTotal: 0,
    items: [{ cardId: 'a', lastAt: '2026-10-02T00:00:00Z' }, { cardId: 'b', lastAt: '2026-10-01T00:00:00Z' }], ...over });
  assert.equal(readSignature(page()), readSignature(page()));
  assert.equal(readSignature(page()), readSignature(page({ items: page().items.slice(0, 1) })), 'a probe of one row reads like the full page: only the newest row counts');
  assert.notEqual(readSignature(page()), readSignature(page({ total: 3, counts: { weak: 3, history: 0 } })), 'a new mistake');
  assert.notEqual(readSignature(page()), readSignature(page({ items: [{ cardId: 'a', lastAt: '2026-10-03T00:00:00Z' }] })), 'the newest mistake was missed again');
  assert.notEqual(readSignature(page()), readSignature(page({ counts: { weak: 2, history: 1 } })), 'one was corrected in the other view');
  assert.notEqual(readSignature(page()), readSignature(page({ gradedTotal: 1, selfTotal: 1 })), 'the kinds changed');
  assert.equal(readSignature(null), '', 'nothing read yet');
});

test('what the page folded away stays findable: the filter bar and the old refresh button have entries, and the retrain entry says how the similar questions are practised', async () => {
  const { FINDER_ENTRIES } = await import('../ui/finder/entries.js');
  const byId = new Map(FINDER_ENTRIES.map((entry) => [entry.id, entry]));
  const filter = byId.get('wrongbook-filter');
  assert.equal(filter.page, 'wrongbook');
  assert.ok(filter.anchors.includes('wrongbook-filter'), '带我去 lights the bar when it is there');
  for (const word of ['筛选', '按主题', '全部展开', '只看这个题组', '搜索错题']) assert.ok(filter.aliases.includes(word), word);
  assert.match(filter.what, /10 道/, 'it says from how many mistakes the bar appears');
  const refresh = byId.get('wrongbook-refresh');
  assert.equal(refresh.page, 'wrongbook');
  assert.ok(refresh.aliases.includes('刷新'), 'a learner who looks for the old button finds where it went');
  assert.match(refresh.what, /自己/);
  assert.match(byId.get('recommend').what, /错题 \+ 同类题/, 'the recommendations say how they are practised');
  assert.ok(byId.get('recommend').aliases.includes('练这几道'), 'the old button name still finds it');
  assert.ok(byId.get('retrain').aliases.includes('练这一组'));
});
