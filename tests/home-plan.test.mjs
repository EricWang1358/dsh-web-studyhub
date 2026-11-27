/* The home card is the daily path of the CURRENT course (due, weak, new): one button, one number, the breakdown over the same cards. The other ways to
   start are links, the other courses' work is said once, and sample decks never hide a newcomer's next step. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`
  export * from './ui/study-map/home-plan.js';
  export { NEXT_STEP_IDS, nextStep, nextStepFacts } from './ui/study-map/next-step.js';
  export { nextCardView } from './ui/study-map/next-card-view.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
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
  // 只学当前课程新题 is one round of new questions: the new-question limit of 设置 › 练习's round size (10 of the default 20, #1009).
  assert.deepEqual(labels(home), ['课程下一批 · 7 题', '只学当前课程新题 · 10 题', '其他课程另有 6 题到期或薄弱 · 一起学']);
  for (const [size, fresh] of [[5, 3], [10, 5], [30, 14]]) {
    const sized = plan({ data: { settings: { practice: { roundSize: size } } } });
    assert.ok(labels(sized.home).includes(`只学当前课程新题 · ${fresh} 题`), `round size ${size}: ${labels(sized.home)}`);
    sized.home.alternatives.find(([label]) => /只学当前课程新题/.test(label))[1]();
    assert.equal(sized.started.at(-1).count, Math.ceil(size / 2), 'the button asks for one round of new questions (the label says what waits when fewer do)');
  }
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

test("todayAction is always today's own round, whatever else the card resumes (the 下一步 card presses it for the day's due questions)", () => {
  m.setUiLanguage('zh');
  const none = plan();
  assert.equal(none.home.todayAction.label, '开始今日学习');
  none.home.todayAction.run();
  assert.deepEqual(none.started, [{ mode: 'path', course: 'A', daily: true }]);
  const run = { id: 'r1', mode: 'path', scope: [{ deckId: 'd1' }], index: 4, total: 15, title: '今日学习' };
  const begun = plan({ runs: [run] });
  assert.equal(begun.home.todayAction.label, '继续学习');
  begun.home.todayAction.run();
  assert.deepEqual(begun.resumed, ['r1']);
  // Another round was left open last (接着做 on the card): the card resumes that one, today's own button still starts today's round.
  const left = { id: 'r9', mode: 'practice', scope: [{ deckId: 'd9' }], index: 1, total: 8, title: '别的练习' };
  const other = plan({ runs: [left], data: { lastRun: { id: 'r9' } } });
  assert.equal(other.home.plan.action.label, '接着做');
  assert.equal(other.home.todayAction.label, '开始今日学习');
  other.home.todayAction.run();
  assert.deepEqual(other.started, [{ mode: 'path', course: 'A', daily: true }]);
  assert.deepEqual(other.resumed, []);
  assert.equal(plan({ todayPatch: { size: 0, due: 0, weak: 0, new: 0 } }).home.todayAction.disabled, true, 'nothing to learn: nothing to press');
});

test('a day with nothing to do, and an ahead-of-time round never says 题待学 beside 今天的任务都完成了', () => {
  m.setUiLanguage('zh');
  const clear = plan({ todayPatch: { due: 0, weak: 0, new: 0, size: 0 } }).home;
  assert.equal(clear.plan.kind, 'clear');
  assert.equal(clear.plan.detail, '这里还没有可以学的题');
  assert.equal(clear.plan.action.disabled, true);
  const ahead = plan({ todayPatch: { due: 0, weak: 0, new: 0, size: 10, ahead: true } }).home;
  assert.equal(ahead.plan.eyebrow, '提前巩固');
  assert.equal(ahead.plan.count, 10);
  assert.equal(ahead.plan.unit, '题可提前练', 'optional ahead review never calls extra practice 题待学');
  assert.doesNotMatch(`${ahead.plan.unit} ${ahead.plan.detail} ${ahead.headline}`, /题待学/);
  assert.equal(ahead.plan.detail, '今日已完成，可提前巩固');
  assert.equal(ahead.headline, '今天的任务都完成了 · 可提前巩固');
  assert.equal(ahead.plan.action.label, '提前巩固');
  assert.equal(ahead.todayAction.label, '提前巩固');
  const aheadEmpty = plan({ todayPatch: { due: 0, weak: 0, new: 0, size: 0, ahead: true } }).home;
  assert.equal(aheadEmpty.plan.unit, '题可提前练');
  assert.equal(aheadEmpty.plan.detail, '今天的任务都完成了');
  assert.equal(aheadEmpty.headline, '今天的任务都完成了');
  assert.equal(aheadEmpty.plan.action.disabled, true);
  m.setUiLanguage('en');
  try {
    const enAhead = plan({ todayPatch: { due: 0, weak: 0, new: 0, size: 10, ahead: true } }).home;
    for (const s of [enAhead.plan.eyebrow, enAhead.plan.unit, enAhead.plan.detail, enAhead.headline, enAhead.plan.action.label, enAhead.todayAction.label]) {
      assert.doesNotMatch(s, /[\u3400-\u9fff]/, `English ahead copy leaves zero Han: ${s}`);
    }
  } finally {
    m.setUiLanguage('zh');
  }
});

test('NextStepCard and TodayCard share one priority truth: open runs (resume) outrank due reviews across both surfaces', () => {
  m.setUiLanguage('zh');
  const openRun = { id: 'r-open', mode: 'quiz', scope: [{ deckId: 'd1' }], index: 2, total: 8, title: '并发控制' };
  const snapshot = {
    root: '/lib',
    model: { ready: true, reason: 'ok', label: 'DeepSeek' },
    decks: [deck('d1')],
    sources: [{ id: 's' }],
    drafts: [],
    jobs: [],
    runs: [openRun],
    lastRun: { id: 'r-open' },
    today: today({ due: 5, weak: 2, new: 3, size: 10, ahead: false }),
    focus: { mode: 'class', course: 'A', fresh: [], route: null },
  };
  const { home } = plan({ data: snapshot, runs: [openRun], todayPatch: { due: 5, weak: 2, new: 3, size: 10, ahead: false } });
  const facts = m.nextStepFacts(snapshot, { resumeOpen: home.plan.kind === 'resume' });
  const step = m.nextStep(facts);
  assert.equal(home.plan.kind, 'resume');
  assert.equal(step.id, 'resume');
  assert.equal(home.headline, '有一组练习没做完');
  const topView = m.nextCardView(step.id, facts, { plan: home.plan, today: home.todayAction });
  assert.equal(topView.action.label, home.plan.action.label, 'top NextStepCard and TodayCard offer the same primary resume action');
  assert.ok(m.NEXT_STEP_IDS.indexOf('resume') < m.NEXT_STEP_IDS.indexOf('due'));
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
  assert.match(await readFile('ui/StudyMap.jsx', 'utf8'), /hasOwnDeck\(data\) && <SetupChecklist /);
  assert.match(await readFile('ui/app/page-views.jsx', 'utf8'), /pageAvailable\(data, 'review'\) && hasOwnDeck\(data\) && <DailyPlan /);
});

test('S3 catch-up hint (#881) uses full roundSize when dueTotal >= roundSize * 3 and not ahead', () => {
  m.setUiLanguage('zh');
  try {
    const below = plan({ todayPatch: { due: 15, weak: 2, new: 3, size: 20, more: 44, dueTotal: 59 } }).home;
    assert.doesNotMatch(below.plan.detail, /天清完/);

    const atThreshold = plan({ todayPatch: { due: 18, weak: 2, new: 0, size: 20, more: 40, dueTotal: 60 } }).home;
    assert.ok(atThreshold.plan.detail.includes('到期 60 题，按每天 20 题约 3 天清完；先练还记得住的'), atThreshold.plan.detail);

    const ahead = plan({ todayPatch: { due: 0, weak: 0, new: 0, size: 20, ahead: true, dueTotal: 80 } }).home;
    assert.doesNotMatch(ahead.plan.detail, /天清完/);

    // Custom roundSize 10 (freshRoundCount would be 5 -> 5*3=15, but catch-up uses full roundSize 10 -> 10*3=30).
    const customBelow = plan({ data: { settings: { practice: { roundSize: 10 } } }, todayPatch: { due: 10, weak: 0, new: 0, size: 10, more: 15, dueTotal: 25 } }).home;
    assert.doesNotMatch(customBelow.plan.detail, /天清完/);
    const customHit = plan({ data: { settings: { practice: { roundSize: 10 } } }, todayPatch: { due: 10, weak: 0, new: 0, size: 10, more: 20, dueTotal: 30 } }).home;
    assert.ok(customHit.plan.detail.includes('到期 30 题，按每天 10 题约 3 天清完；先练还记得住的'), customHit.plan.detail);

    m.setUiLanguage('en');
    const english = plan({ todayPatch: { due: 20, weak: 0, new: 0, size: 20, more: 41, dueTotal: 61 } }).home;
    assert.doesNotMatch(english.plan.detail, /[\u3400-\u9fff]/);
    assert.ok(english.plan.detail.includes('61 due — about 4 days at 20 a day; starting with the ones you still remember'), english.plan.detail);
  } finally {
    m.setUiLanguage('zh');
  }
});
