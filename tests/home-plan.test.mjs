/* The home card is the daily path of the CURRENT course (due, weak, new): one button, one number, the breakdown over the same cards. The other ways to
   start are links, the other courses' work is said once, and sample decks never hide a newcomer's next step. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi("export * from './ui/study-map/home-plan.js'; export { setUiLanguage } from './ui/i18n.js';");
const deck = (id, extra = {}) => ({ id, title: id, course: 'A', ...extra });
const today = (extra = {}) => ({ due: 3, weak: 2, new: 10, size: 15, ahead: false, more: 0, course: 'A', scope: [{ deckId: 'd1' }], elsewhere: 0, ...extra });
function plan({ data = {}, todayPatch = {}, runs = [], route = null, fresh = 14, started = [], resumed = [], generated = [] } = {}) {
  const full = { decks: [deck('d1')], sources: [{ id: 's' }], drafts: [], jobs: [], runs,
    focus: { mode: 'class', course: 'A', fresh: Array(fresh).fill({}), route }, ...data };
  const t = today(todayPatch);
  const home = m.buildHomePlan({ data: full, today: t, runs, runFor: (scope) => runs.find((run) => run.mode === 'path' && JSON.stringify(run.scope) === JSON.stringify(scope)),
    activeJobs: [], inFocus: () => true, canChat: false, revealActivity() {},
    actions: { start: (args) => started.push(args), resume: (id) => resumed.push(id), openDraft() {}, addSource() {}, importLibrary() {}, askInChat() {},
      generateFromSources: (ids) => generated.push(ids), startCourseFlow() {}, onCoachPractice: undefined, onWeakPoints: undefined } });
  return { home, started, resumed };
}
const labels = (home) => home.alternatives.map(([label]) => label);

test('the card is the daily path of the current course, even when the course still has unlearned cards and a route', () => {
  m.setUiLanguage('zh');
  const route = { course: 'A', current: 0, chapters: [{}, {}], next: { label: '第一章', fresh: 5, reviews: 2 } };
  const { home, started } = plan({ route });
  assert.equal(home.plan.kind, 'path');
  assert.equal(home.plan.count, 15);
  assert.equal(home.plan.unit, '题待学');
  assert.equal(home.plan.action.label, '开始今日学习');
  home.plan.action.run();
  assert.deepEqual(started, [{ mode: 'path', course: 'A', daily: true }], 'the round the number counted, not the whole course and not every course');
});

test('one fact, one number: the breakdown is over the cards of the round, and the cards left for later are said as such', () => {
  m.setUiLanguage('zh');
  const { home } = plan({ todayPatch: { more: 12 } });
  assert.equal(home.plan.count, 15);
  assert.equal(home.plan.detail, '3 题到期 · 2 题薄弱 · 10 题未学 · 另有 12 题留到下一轮');
  assert.equal(plan().home.plan.detail, '3 题到期 · 2 题薄弱 · 10 题未学', 'nothing is left over: nothing is said');
  m.setUiLanguage('en');
  try { assert.equal(plan({ todayPatch: { more: 12 } }).home.plan.detail, '3 due · 2 weak · 10 not started · 12 more for the next round'); } finally { m.setUiLanguage('zh'); }
});

test('the other ways to start are links: the course batch, new questions only, the work in other courses', () => {
  m.setUiLanguage('zh');
  const route = { course: 'A', current: 0, chapters: [{}, {}], next: { label: '第一章', fresh: 5, reviews: 2 } };
  const { home, started } = plan({ route, todayPatch: { elsewhere: 6 } });
  assert.deepEqual(labels(home), ['课程下一批 · 7 题', '只学当前课程新题 · 10 题', '先讲后练 · 学习流', '其他课程另有 6 题到期或薄弱 · 一起学']);
  home.alternatives.at(-1)[1]();
  assert.deepEqual(started, [{ mode: 'path' }], 'together with every active course');
  assert.deepEqual(labels(plan().home).filter((label) => /其他课程/.test(label)), [], 'nothing elsewhere: no link');
});

test('without a current course, or in 笔试 / 面试 mode, the path is every active course', () => {
  const { home, started } = plan({ todayPatch: { course: null, scope: [] } });
  home.plan.action.run();
  assert.deepEqual(started, [{ mode: 'path' }]);
  assert.deepEqual(m.dailyPathArgs({ course: null }), { mode: 'path' });
  assert.deepEqual(m.dailyPathArgs(undefined), { mode: 'path' });
  assert.deepEqual(m.dailyPathArgs({ course: '' }), { mode: 'path', course: '', daily: true }, 'decks without a course are a course of their own');
  assert.deepEqual(m.dailyPathArgs({ course: '网络' }), { mode: 'path', course: '网络', daily: true });
});

test('the round already begun is resumed, found by the scope the server counted', () => {
  m.setUiLanguage('zh');
  const run = { id: 'r1', mode: 'path', scope: [{ deckId: 'd1' }], index: 4, total: 15, title: '今日学习' };
  const { home, resumed } = plan({ runs: [run] });
  assert.equal(home.plan.kind, 'resume');
  assert.equal(home.plan.count, 11);
  home.plan.action.run();
  assert.deepEqual(resumed, ['r1']);
  const other = plan({ runs: [{ ...run, scope: [{ deckId: 'd9' }] }] });
  assert.equal(other.home.plan.kind, 'path', 'a round on other decks is not this course\'s round');
});

test('a day with nothing to do, and an ahead-of-time round', () => {
  m.setUiLanguage('zh');
  const clear = plan({ todayPatch: { due: 0, weak: 0, new: 0, size: 0 } }).home;
  assert.equal(clear.plan.kind, 'clear');
  assert.equal(clear.plan.detail, '今天已经清空');
  assert.equal(clear.plan.action.disabled, true);
  const ahead = plan({ todayPatch: { due: 0, weak: 0, new: 0, size: 20, ahead: true } }).home;
  assert.equal(ahead.plan.eyebrow, '提前巩固');
  assert.equal(ahead.plan.action.label, '提前巩固');
});

test('a newcomer keeps the next step in front while only the sample course is there', () => {
  m.setUiLanguage('zh');
  const sample = { loaded: true, deckId: 'sample-deck-patterns', caseDeckId: 'sample-deck-case' };
  const onlySample = plan({ data: { decks: [deck('sample-deck-patterns', { sample: true }), deck('sample-deck-case')], sample, sources: [], drafts: [] } }).home;
  assert.equal(onlySample.starter?.kind, 'empty', 'the sample course does not count as the learner\'s own library');
  assert.equal(onlySample.plan.kind, 'empty');
  assert.equal(onlySample.plan.step, 0);
  const own = plan({ data: { decks: [deck('sample-deck-patterns'), deck('mine')], sample } }).home;
  assert.equal(own.starter, null, 'one deck of their own is a library');
  assert.equal(plan({ data: { decks: [deck('mine')] } }).home.starter, null);
  assert.equal(plan({ data: { decks: [] , sources: [], drafts: [] } }).home.starter?.kind, 'empty');
});

test('the sample course never ticks a step of the first deck: its material and its draft are not the newcomer\'s', () => {
  m.setUiLanguage('zh');
  const sample = { loaded: true, deckId: 'sample-deck-patterns', draftId: 'sample-draft-patterns', sourceId: 'sample-lecture' };
  const bare = (extra, generated) => plan({ data: { decks: [], sources: [], drafts: [], sample, ...extra }, generated }).home;
  const sampleOnly = bare({ sources: [{ id: 'sample-lecture', sample: true }], drafts: [{ id: 'sample-draft-patterns', sample: true }] });
  assert.equal(sampleOnly.plan.step, 0, 'no material of their own: still the first step');
  assert.equal(sampleOnly.plan.action.label, '添加资料', 'the one name of adding material');
  assert.equal(bare({ sources: [{ id: 'sample-lecture' }], drafts: [{ id: 'sample-draft-patterns' }] }).plan.step, 0, 'the sample is known by its ids too');
  const generated = [];
  const material = bare({ sources: [{ id: 'sample-lecture', sample: true }, { id: 'mine', title: '我的讲义', text: 'y' }], drafts: [{ id: 'sample-draft-patterns', sample: true }] }, generated);
  assert.equal(material.plan.step, 1, 'one material of their own, the sample draft is not theirs');
  assert.equal(material.plan.action.label, '用这 1 份资料出题');
  material.plan.action.run();
  assert.deepEqual(generated, [['mine']], 'and only their own material is what the run is asked to use');
  const drafted = bare({ sources: [{ id: 'mine', title: '我的讲义', text: 'y' }], drafts: [{ id: 'sample-draft-patterns', sample: true }, { id: 'mine-draft' }] });
  assert.equal(drafted.plan.step, 2);
  assert.equal(drafted.plan.action.label, '检查草稿', 'opening a draft is 检查草稿; the publishing button of the draft page is 发布并开始练');
  assert.match(drafted.plan.next, /出题时已审阅过/, 'what really happens: the review ran while the questions were made');
  assert.match(drafted.plan.next, /发布时再检查一遍题目的结构/, 'and what publishing adds');
  m.setUiLanguage('en');
  try {
    const english = bare({ sources: [{ id: 'mine', title: 'Notes', text: 'y' }], drafts: [{ id: 'mine-draft' }] }).plan;
    assert.doesNotMatch(`${english.action.label} ${english.next}`, /[\u3400-\u9fff]/);
    assert.equal(english.action.label, 'Check the draft');
  } finally { m.setUiLanguage('zh'); }
});

test('an own deck is one the learner published: not the sample\'s, not one the app made, archived or not', () => {
  assert.equal(m.hasOwnDeck(undefined), false);
  assert.equal(m.hasOwnDeck({ decks: [] }), false);
  assert.equal(m.hasOwnDeck({ decks: [deck('s', { sample: true })] }), false);
  assert.equal(m.hasOwnDeck({ decks: [deck('sample-deck-patterns')], sample: { deckId: 'sample-deck-patterns' } }), false);
  assert.equal(m.hasOwnDeck({ decks: [deck('x', { systemKind: 'coach' })] }), false);
  assert.equal(m.hasOwnDeck({ decks: [deck('sample-deck-patterns', { sample: true }), deck('mine')] }), true);
  assert.equal(m.hasOwnDeck({ decks: [deck('mine', { archived: true })] }), true);
});

test('课程准备 and 今天先做什么 wait for the first deck of their own, on the library home', async () => {
  const { readFile } = await import('node:fs/promises');
  assert.match(await readFile('ui/StudyMap.jsx', 'utf8'), /\{hasOwnDeck\(data\) && <SetupChecklist /);
  assert.match(await readFile('ui/app/page-views.jsx', 'utf8'), /pageAvailable\(data, 'review'\) && hasOwnDeck\(data\) && <DailyPlan /);
});
