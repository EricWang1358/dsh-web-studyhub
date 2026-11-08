import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { localizedAppError } from '../lib/application-messages.js';
import { CLASSROOM_METHOD, STAGES_MAX } from '../lib/course-method.js';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

const ui = await loadUi(`
  export {
    ACTIVITY_LABELS,
    METHOD_USAGE_KEYS,
    markAlternativeUsed,
    matchesCourseSession,
    courseCounts,
    isAlternativeUsed,
    currentMethodStage,
    resolveRoundCourse,
    stageAlternatives,
    roundEndAlternative,
    openAlternative,
  } from './ui/method-alternatives.js';
  export {
    default as CourseMethodCard,
    MethodForm,
    shownMethod,
    moveStage,
    addStage,
    removeStage,
    toggleStageAlternative,
    patchStage,
  } from './ui/CourseMethodCard.jsx';
  export { buildHomePlan } from './ui/study-map/home-plan.js';
  export { default as TodayCard } from './ui/study-map/TodayCard.jsx';
  export { default as MethodLine } from './ui/study-map/MethodLine.jsx';
  export { default as Review } from './ui/Review.jsx';
  export { FINDER_ENTRIES } from './ui/finder/entries.js';
  export { USAGE_REGISTRY_BY_KEY } from './ui/usage/registry.js';
  export { readPageScope } from './ui/PageScope.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const plainText = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
}

async function createLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-method-s1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage: { roundLimit: 8 } });
  t.after(() => service.dispose());
  return service;
}

test('course.method.get, course.method.save and course.merge read, update, preserve and reset a course method cleanly', async t => {
  const service = await createLibrary(t);
  await service.call('course.save', {
    name: 'Organic Chemistry',
    exam: { format: 'closed-book', date: '2027-05-10', totalMarks: 100 },
    focusTopics: ['Stereochemistry', 'Substitution'],
  });
  await service.store.update(state => {
    const record = state.courses.find(item => item.name === 'Organic Chemistry');
    record.aliases = ['CHEM201'];
    record.plan = { summary: 'Weekly synthesis drills' };
    record.custom = { document: 'doc-chem' };
    state.focus = { mode: 'class', course: 'Organic Chemistry', role: '', jd: '', targetTopics: [] };
  });

  // Default course.method.get uses current focused course and reports own: false on default package
  const initial = await service.call('course.method.get', {});
  assert.equal(initial.course, 'Organic Chemistry');
  assert.equal(initial.own, false);
  assert.equal(initial.method.name, '课堂跟学');
  assert.equal(initial.progress.index, 0);
  assert.equal(initial.gate.stage.activity, 'publish');

  // Save custom flexible stages via course.method.save
  const customMethod = {
    name: '反应机理三步走',
    targetDate: '2027-05-01',
    stages: [
      { name: '先自己画机理草图', activity: 'project', alternatives: ['explain', 'publish'], level: 'loose' },
      { name: '口述条件与反例', activity: 'check', alternatives: ['practice'], level: 'strict' },
    ],
  };
  const saved = await service.call('course.method.save', { course: 'Organic Chemistry', method: customMethod });
  assert.equal(saved.own, true);
  assert.equal(saved.method.name, '反应机理三步走');
  assert.deepEqual(saved.method.stages.map(item => item.activity), ['project', 'check']);
  assert.deepEqual(saved.method.stages[0].alternatives, ['explain', 'publish']);

  // Verify sibling fields on the course record were preserved untouched
  const fullCourse = await service.call('course.get', { name: 'Organic Chemistry' });
  assert.equal(fullCourse.exam.date, '2027-05-10');
  assert.deepEqual(fullCourse.focusTopics, ['Stereochemistry', 'Substitution']);
  assert.deepEqual(fullCourse.aliases, ['CHEM201']);
  assert.deepEqual(fullCourse.plan, { summary: 'Weekly synthesis drills' });
  assert.deepEqual(fullCourse.custom, { document: 'doc-chem' });

  // Merging a course with a custom method into a target course without one preserves the method
  const chem2 = await service.call('course.save', { name: 'Chem II' });
  await service.call('course.merge', { into: chem2.id, from: [initial.courseId] });
  const mergedMethod = await service.call('course.method.get', { name: 'Chem II' });
  assert.equal(mergedMethod.own, true);
  assert.equal(mergedMethod.method.name, '反应机理三步走');

  // Resetting method: null detaches back to default classroom method while keeping sibling fields
  const reset = await service.call('course.method.save', { id: mergedMethod.courseId, method: null });
  assert.equal(reset.own, false);
  assert.equal(reset.method.name, '课堂跟学');
  const afterReset = await service.call('course.get', { id: mergedMethod.courseId });
  assert.equal(afterReset.method, undefined);
  assert.deepEqual(afterReset.focusTopics, ['Stereochemistry', 'Substitution']);

  // Validation errors localize cleanly into English without Han characters
  const checkEnError = async promise => {
    let caught = null;
    try { await promise; } catch (error) { caught = error; }
    assert.ok(caught, 'expected rejection');
    const en = localizedAppError(caught, 'en').message;
    assert.doesNotMatch(en, /[㐀-鿿]/, `untranslated Han in: ${en}`);
    return en;
  };
  await checkEnError(service.call('course.method.get', { name: 'Missing Course' }));
  await checkEnError(service.call('course.method.save', { course: 'Chem II' }));
  await checkEnError(service.call('course.method.save', { course: 'Chem II', method: { stages: [] } }));
  await checkEnError(service.call('course.method.save', {
    course: 'Chem II',
    method: { stages: [{ name: 'Bad', activity: 'practice', alternatives: ['practice'], level: 'medium' }] },
  }));
});

test('CourseMethodCard lightweight direct editing: reorder handle, add (<=12), remove (>=1), activity and alternatives (<=2) helpers and UI', () => {
  const base = CLASSROOM_METHOD.stages.map(item => ({ ...item, alternatives: [...item.alternatives] }));
  const moved = ui.moveStage(base, 0, 2);
  assert.deepEqual(moved.map(item => item.activity), ['practice', 'review', 'publish']);
  assert.equal(ui.moveStage(base, 0, 9), base, 'out-of-range move is a no-op');

  // Cannot remove last remaining stage
  const single = ui.removeStage(ui.removeStage(base, 2), 1);
  assert.equal(single.length, 1);
  assert.equal(ui.removeStage(single, 0).length, 1, 'keeps at least 1 stage');

  // Can add stages up to STAGES_MAX = 12
  let many = single;
  for (let i = 0; i < 15; i += 1) many = ui.addStage(many);
  assert.equal(many.length, STAGES_MAX);

  // Alternatives toggle: max 2, never equal to stage.activity, and stripped if main activity changes to match
  let st = { name: 'Custom', activity: 'practice', alternatives: [], level: 'medium' };
  st = ui.toggleStageAlternative(st, 'practice');
  assert.deepEqual(st.alternatives, [], 'cannot add main activity as alternative');
  st = ui.toggleStageAlternative(st, 'explain');
  st = ui.toggleStageAlternative(st, 'check');
  st = ui.toggleStageAlternative(st, 'project');
  assert.deepEqual(st.alternatives, ['explain', 'check'], 'capped at 2 alternatives');
  st = ui.toggleStageAlternative(st, 'explain');
  assert.deepEqual(st.alternatives, ['check'], 'toggling again removes it');

  const patched = ui.patchStage([st], 0, { activity: 'check' });
  assert.equal(patched[0].activity, 'check');
  assert.deepEqual(patched[0].alternatives, [], 'changing main activity removes colliding alternative automatically');

  // Read mode renders data-tour="course-method", Adapt in the main chat hand-off, Add a note button, and zero <input>
  const readHtml = renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, { course: { id: 'c1', name: 'Law' } }), { call: async () => ({}) }));
  assert.match(readHtml, /data-tour="course-method"/);
  assert.match(readHtml, /data-hand-off="method\.edit"/);
  assert.doesNotMatch(readHtml, /<input/, 'read mode stays input-free until the learner opens note or edit');
  assert.match(plainText(readHtml), /和主会话改学法/);
  assert.match(plainText(readHtml), /补充想法/);

  // MethodForm puts draggable="true" ONLY on .course-method__drag (never on <li class="course-method__stage-edit">, so text selection inside inputs works),
  // disables Add stage at STAGES_MAX, and translates cleanly in English
  ui.setUiLanguage('en');
  try {
    const formHtml = renderToStaticMarkup(inApp(ui, h(ui.MethodForm, {
      draft: { name: 'Seminar', targetDate: null, stages: many.map((item, idx) => ({ ...item, name: `Stage ${idx + 1}` })) },
      own: true,
      disabled: false,
      working: false,
      onChange() {},
      onStage() {},
      onSave() {},
      onCancel() {},
      onReset() {},
    }), { call: async () => ({}) }));
    assert.doesNotMatch(plainText(formHtml), /[㐀-鿿（）]/);
    assert.doesNotMatch(formHtml, /<li[^>]*draggable=/, '<li> itself is never draggable so TextInput mouse drag selects text cleanly');
    assert.match(formHtml, /class="course-method__drag" draggable="true"/, 'drag handle owns draggable="true"');
    assert.match(plainText(formHtml), /12 of 12 stages/);
    assert.match(formHtml, /disabled="" aria-label="Move stage 1 up"/);
    assert.match(formHtml, /disabled="" aria-label="Move stage 12 down"/);
  } finally {
    ui.setUiLanguage('zh');
  }
});

test('method-alternatives reuses single-source finder & usage registries, matches entity courseId & note.courses accurately, and translates cleanly in English', () => {
  // Every usage key in METHOD_USAGE_KEYS is registered in USAGE_REGISTRY_BY_KEY
  for (const keys of Object.values(ui.METHOD_USAGE_KEYS)) {
    assert.ok(keys.length > 0);
    for (const key of keys) assert.ok(Object.hasOwn(ui.USAGE_REGISTRY_BY_KEY, key), `unknown usage key: ${key}`);
  }
  const finderIds = new Set(ui.FINDER_ENTRIES.map(item => item.id));
  for (const id of ['course-method', 'guided-study', 'oral-exam']) assert.ok(finderIds.has(id), `finder has ${id}`);

  const stage = { name: '巩固阶段', activity: 'review', alternatives: ['check', 'project'], level: 'medium' };
  const course = { id: 'c-bio', name: 'Biochemistry', aliases: ['BIOC101'], method: { name: '实验课', stages: [stage] } };

  // 1) Without model ready: oral check ('check', needs model) is hidden; notes ('project', no model needed) still shows!
  const noModelData = {
    root: '/lib-1',
    modelReady: false,
    courses: [course],
    sources: [{ id: 's1', courses: ['Biochemistry'], text: 'Enzyme kinetics notes' }],
    decks: [{ id: 'd1', course: 'Biochemistry', cards: [{ id: 'k1', prompt: 'Km?', answer: 'Michaelis constant' }] }],
    attempts: [],
  };
  const noModelAlts = ui.stageAlternatives(noModelData, course, stage, { storage: memoryStorage() });
  assert.deepEqual(noModelAlts.map(item => item.activity), ['project'], 'oral exam hidden when model is not connected');

  // 2) With model ready, but 0 materials & 0 cards: shown on card as blocked with plain reason, omitted at round end
  const emptyCourseData = { root: '/lib-2', modelReady: true, courses: [course], sources: [], decks: [], attempts: [] };
  const blockedNoMaterial = ui.stageAlternatives(emptyCourseData, course, stage, { storage: memoryStorage() });
  assert.deepEqual(blockedNoMaterial.map(item => [item.activity, item.blocked]), [
    ['check', '导入讲义后可用'],
    ['project', '导入讲义后可用'],
  ]);
  assert.equal(ui.roundEndAlternative(emptyCourseData, course, { storage: memoryStorage() }), null);

  // 3) Materials imported, 0 published decks: check & project say 发布题组后可用, while explain is ready!
  const materialOnlyData = {
    root: '/lib-3',
    modelReady: true,
    courses: [course],
    sources: [{ id: 's1', courses: ['Biochemistry'], text: 'Lecture 1' }],
    decks: [],
    attempts: [],
  };
  const blockedNoDeck = ui.stageAlternatives(materialOnlyData, course, { ...stage, alternatives: ['explain', 'check'] }, { storage: memoryStorage() });
  assert.equal(blockedNoDeck[0].activity, 'explain');
  assert.equal(blockedNoDeck[0].blocked, '');
  assert.equal(blockedNoDeck[1].activity, 'check');
  assert.equal(blockedNoDeck[1].blocked, '发布题组后可用');

  // Render on CourseMethodCard in Chinese and English (with both a used item and a blocked item -> zero Han or full-width parens in English!)
  const cardWithAlts = renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
    course: { ...course, method: { name: '实验课', stages: [{ ...stage, alternatives: ['explain', 'check'] }] } },
    data: materialOnlyData,
    readout: { index: 0, total: 1 },
  }), { data: materialOnlyData, call: async () => ({}) }));
  assert.match(plainText(cardWithAlts), /也可以： AI 带学 .* 口头面试 （发布题组后可用）/);

  ui.setUiLanguage('en');
  try {
    const enMethodCourse = {
      id: 'c-en',
      name: 'Physiology',
      method: { name: 'Lab prep', stages: [{ name: 'Read handout', activity: 'review', alternatives: ['explain', 'check'], level: 'medium' }] },
    };
    const enData = {
      root: '/lib-en',
      modelReady: true,
      courses: [enMethodCourse],
      sources: [{ id: 's-en', courses: ['Physiology'], text: 'Cardiac cycle' }],
      decks: [],
      attempts: [],
      guidedSessions: [{ id: 'gs-en', courseId: 'c-en' }],
    };
    const enCardHtml = renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
      course: enMethodCourse,
      data: enData,
      readout: { index: 0, total: 1 },
    }), { data: enData, call: async () => ({}) }));
    const enText = plainText(enCardHtml);
    assert.doesNotMatch(enText, /[㐀-鿿（）]/, `unexpected Han or full-width parens in English card: ${enText}`);
    assert.match(enText, /Used/);
    assert.match(enText, /\(Available after publishing a deck\)/);
  } finally {
    ui.setUiLanguage('zh');
  }

  // 4) Ready & unused -> clicking openAlternative navigates with course scope and marks used -> demoted to 已用过 on card, omitted at round end
  const readyData = { ...noModelData, modelReady: true };
  const store = memoryStorage(), session = memoryStorage();
  const readyAlts = ui.stageAlternatives(readyData, course, stage, { storage: store });
  assert.equal(readyAlts[0].activity, 'check');
  assert.equal(readyAlts[0].used, false);

  const visited = [];
  let examKind = null, closedReason = null;
  ui.openAlternative(readyAlts[0], {
    data: readyData,
    course,
    stage,
    navigate: page => visited.push(page),
    appSet: { setExamKind: kind => { examKind = kind; }, setExamRunId: () => {} },
    onClose: why => { closedReason = why; },
    storage: store,
    scopeStorage: session,
  });
  assert.deepEqual(visited, ['exam']);
  assert.equal(examKind, 'oral');
  assert.equal(closedReason, 'method-alternative');
  assert.equal(ui.readPageScope(readyData.root, 'exam', session), 'Biochemistry');
  assert.equal(ui.readPageScope(readyData.root, 'exam-format', session), 'oral');

  // After clicking 'check', 'check' is now used:true on card and roundEndAlternative moves on to 'project'!
  const afterClick = ui.stageAlternatives(readyData, course, stage, { storage: store });
  assert.equal(afterClick[0].used, true);
  assert.equal(afterClick[1].used, false);
  const nextRoundAlt = ui.roundEndAlternative(readyData, course, { storage: store });
  assert.equal(nextRoundAlt.activity, 'project');

  // 5) 'explain' course session matching: unscoped (courseId: null) or other-course sessions do NOT falsely match; entity id (course.id) & live guidedSession DO match
  assert.equal(ui.matchesCourseSession(materialOnlyData, 'Biochemistry', null), false);
  assert.equal(ui.matchesCourseSession(materialOnlyData, 'Biochemistry', 'course-other'), false);
  assert.equal(ui.matchesCourseSession(materialOnlyData, 'Biochemistry', 'c-bio'), true);
  assert.equal(ui.matchesCourseSession(materialOnlyData, 'Biochemistry', 'BIOC101'), true);

  const unscopedSessionData = {
    ...materialOnlyData,
    guidedSessions: [{ id: 'gs-null', courseId: null }, { id: 'gs-other', courseId: 'c-other' }],
  };
  assert.equal(ui.isAlternativeUsed(unscopedSessionData, 'Biochemistry', 'explain', undefined, memoryStorage()), false);

  const entityIdSessionData = {
    ...materialOnlyData,
    guidedSessions: [{ id: 'gs-bio', courseId: 'c-bio' }],
  };
  assert.equal(ui.isAlternativeUsed(entityIdSessionData, 'Biochemistry', 'explain', undefined, memoryStorage()), true);

  // Live guidedSession (status !== 'ended') marks explain used and skips sending method.explain hand-off when opened
  assert.equal(
    ui.isAlternativeUsed(materialOnlyData, 'Biochemistry', 'explain', undefined, memoryStorage(), {
      guidedSession: { id: 'gs-live', courseId: 'c-bio', status: 'active' },
    }),
    true,
  );
  assert.equal(
    ui.isAlternativeUsed(materialOnlyData, 'Biochemistry', 'explain', undefined, memoryStorage(), {
      guidedSession: { id: 'gs-ended', courseId: 'c-bio', status: 'ended' },
    }),
    false,
  );

  const sentHandOffs = [];
  const explainItem = blockedNoDeck[0];
  // With live active guidedSession for this course (by entity id): navigates to 'guided' without sending a duplicate hand-off
  ui.openAlternative(explainItem, {
    data: materialOnlyData,
    course,
    stage,
    guidedSession: { id: 'gs-live', courseId: 'c-bio', status: 'active' },
    navigate: page => visited.push(page),
    handOff: { send: (id, payload) => sentHandOffs.push([id, payload]) },
    storage: memoryStorage(),
    scopeStorage: session,
  });
  assert.equal(visited.at(-1), 'guided');
  assert.equal(sentHandOffs.length, 0);

  // With ended guidedSession (or none): navigates to 'guided' AND triggers 'method.explain' hand-off with course + stage name
  ui.openAlternative(explainItem, {
    data: materialOnlyData,
    course,
    stage,
    guidedSession: { id: 'gs-ended', courseId: 'c-bio', status: 'ended' },
    navigate: page => visited.push(page),
    handOff: { send: (id, payload) => sentHandOffs.push([id, payload]) },
    storage: store,
    scopeStorage: session,
  });
  assert.equal(visited.at(-1), 'guided');
  assert.deepEqual(sentHandOffs, [['method.explain', { course: 'Biochemistry', stage: '巩固阶段' }]]);
});

test('round-end surfaces (TodayCard and Review) show at most one unused 「也可以」 only after a round finishes, and note.courses array scopes project accurately', () => {
  const customCourse = {
    id: 'c-algo',
    name: 'Algorithms',
    aliases: ['CS2040'],
    method: {
      name: '刷题加口述',
      stages: [{ name: '刷动态规划', activity: 'practice', alternatives: ['check', 'project'], level: 'medium' }],
    },
  };
  const baseData = {
    root: '/lib-algo',
    modelReady: true,
    courses: [customCourse],
    sources: [{ id: 's1', courses: ['Algorithms'], text: 'DP notes' }],
    decks: [{ id: 'd1', course: 'Algorithms', cards: [{ id: 'k1', prompt: 'Bellman?', answer: 'Optimal substructure' }] }],
    attempts: [{ deckId: 'd1', quiz_id: 'k1', grade: 4 }],
    focus: { mode: 'class', course: 'Algorithms', courseId: 'c-algo', courses: ['Algorithms', 'Algorithms/DP'] },
  };
  const actions = {
    start() {}, resume() {}, openDraft() {}, addSource() {}, importLibrary() {}, generateFromSources() {},
  };

  // Notes in other courses or unscoped notes (courses: []) do NOT falsely mark 'project' used for Algorithms!
  const otherNotesData = {
    ...baseData,
    notes: [
      { id: 'note-other', courses: ['Biology'], title: 'Cell division' },
      { id: 'note-unscoped', courses: [], title: 'Scratch' },
    ],
  };
  assert.equal(ui.isAlternativeUsed(otherNotesData, 'Algorithms', 'project', undefined, memoryStorage()), false);
  // Real snapshot note with plural courses: ['Algorithms'] (or sub-course 'Algorithms/DP') marks 'project' used for Algorithms
  assert.equal(
    ui.isAlternativeUsed({ ...baseData, notes: [{ id: 'note-1', courses: ['Algorithms'], title: 'DP summary' }] }, 'Algorithms', 'project', undefined, memoryStorage()),
    true,
  );
  assert.equal(
    ui.isAlternativeUsed({ ...baseData, notes: [{ id: 'note-sub', courses: ['Algorithms/DP'], title: 'Subcourse note' }] }, 'Algorithms', 'project', undefined, memoryStorage()),
    true,
  );

  // 1) Before finishing today's round (today.ahead = false): TodayCard shows NO 也可以
  const beforePlan = ui.buildHomePlan({
    data: baseData,
    today: { course: 'Algorithms', size: 4, due: 4, weak: 0, new: 0, ahead: false, scope: [{ deckId: 'd1' }] },
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === 'Algorithms',
    actions,
    revealActivity() {},
  });
  assert.equal(beforePlan.plan.methodAlt, null);

  // 2) Mid-round (open run present, even if ahead is true): TodayCard shows NO 也可以
  const openRun = { id: 'r1', deckId: 'd1', title: 'DP', index: 1, total: 4, scope: [{ deckId: 'd1' }] };
  const midPlan = ui.buildHomePlan({
    data: { ...baseData, lastRun: { id: 'r1' } },
    today: { course: 'Algorithms', size: 2, due: 0, weak: 0, new: 2, ahead: true, scope: [{ deckId: 'd1' }] },
    runs: [openRun],
    runFor: () => openRun,
    activeJobs: [],
    inFocus: c => c === 'Algorithms',
    actions,
    revealActivity() {},
  });
  assert.equal(midPlan.plan.methodAlt, null);

  // 3) Round finished on home (today.ahead = true, no open run): TodayCard shows exactly ONE quiet 也可以 line (and translates in English)
  const donePlan = ui.buildHomePlan({
    data: baseData,
    today: { course: 'Algorithms', size: 2, due: 0, weak: 0, new: 2, ahead: true, scope: [{ deckId: 'd1' }] },
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === 'Algorithms',
    actions,
    revealActivity() {},
  });
  assert.equal(donePlan.plan.methodAlt?.activity, 'check');
  const todayZh = plainText(renderToStaticMarkup(inApp(ui, h(ui.TodayCard, { plan: donePlan.plan, todayLabel: '11月8日' }), { data: baseData, call: async () => ({}) })));
  assert.match(todayZh, /也可以： 口头面试/);
  ui.setUiLanguage('en');
  try {
    const doneEn = ui.buildHomePlan({
      data: baseData,
      today: { course: 'Algorithms', size: 2, due: 0, weak: 0, new: 2, ahead: true, scope: [{ deckId: 'd1' }] },
      runs: [],
      runFor: () => null,
      activeJobs: [],
      inFocus: c => c === 'Algorithms',
      actions,
      revealActivity() {},
    });
    const todayEn = plainText(renderToStaticMarkup(inApp(ui, h(ui.TodayCard, { plan: doneEn.plan, todayLabel: 'Nov 8' }), { data: baseData, call: async () => ({}) })));
    assert.match(todayEn, /You can also: Oral interview/);
    assert.doesNotMatch(todayEn, /[㐀-鿿（）]/);
  } finally {
    ui.setUiLanguage('zh');
  }

  // 4) Review result page shows 也可以 at run.complete, and omits it in exam mode or once oralExams + course notes already exist
  const reviewSession = completeRun => ({
    run: completeRun,
    choice: true,
    actions: { reviewAct() {} },
    enterRun() {},
  });
  const summaryHtml = renderToStaticMarkup(inApp(ui, h(ui.Review, {
    session: reviewSession({
      id: 'run-done',
      complete: true,
      mode: 'course',
      deckId: 'd1',
      total: 5,
      questions: 5,
      answered: 5,
      correct: 4,
      course: { name: 'Algorithms', learned: 5, cards: 5, chapters: 1 },
    }),
    data: baseData,
    shellTitle: 'Algorithms',
  }), { data: baseData, call: async () => ({}) }));
  assert.match(plainText(summaryHtml), /也可以： 口头面试/);

  // Once oralExams has a record, 'check' is used; notes in Biology do NOT suppress 'project' for Algorithms, so Review offers 'project' (学习笔记)!
  const usedOralAndOtherNoteData = {
    ...baseData,
    oralExams: [{ id: 'oral-1' }],
    notes: [{ id: 'note-bio', courses: ['Biology'], title: 'Cell notes' }],
  };
  const secondAltSummaryHtml = renderToStaticMarkup(inApp(ui, h(ui.Review, {
    session: reviewSession({
      id: 'run-done-second',
      complete: true,
      mode: 'course',
      deckId: 'd1',
      total: 5,
      questions: 5,
      answered: 5,
      correct: 5,
      course: { name: 'Algorithms', learned: 5, cards: 5, chapters: 1 },
    }),
    data: usedOralAndOtherNoteData,
    shellTitle: 'Algorithms',
  }), { data: usedOralAndOtherNoteData, call: async () => ({}) }));
  assert.match(plainText(secondAltSummaryHtml), /也可以： 学习笔记/);

  // Once a real Algorithms note (courses: ['Algorithms']) also exists, Review stays completely quiet!
  const usedBothData = {
    ...baseData,
    oralExams: [{ id: 'oral-1' }],
    notes: [{ id: 'note-1', courses: ['Algorithms'], title: 'DP summary' }],
  };
  const quietSummaryHtml = renderToStaticMarkup(inApp(ui, h(ui.Review, {
    session: reviewSession({
      id: 'run-done-2',
      complete: true,
      mode: 'course',
      deckId: 'd1',
      total: 5,
      questions: 5,
      answered: 5,
      correct: 5,
      course: { name: 'Algorithms', learned: 5, cards: 5, chapters: 1 },
    }),
    data: usedBothData,
    shellTitle: 'Algorithms',
  }), { data: usedBothData, call: async () => ({}) }));
  assert.doesNotMatch(plainText(quietSummaryHtml), /也可以：/);

  // 5) Default classroom method invariant: MethodLine renders nothing when own is false
  const defaultLine = renderToStaticMarkup(inApp(ui, h(ui.MethodLine, {
    method: { course: 'DefaultCourse', index: 1, total: 3, own: false, stage: CLASSROOM_METHOD.stages[1] },
    onOpen() {},
  }), { call: async () => ({}) }));
  assert.equal(defaultLine, '');
});
