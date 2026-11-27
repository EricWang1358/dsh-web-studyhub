import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { selectedSources as backendSelectedSources } from '../lib/contexts/generation/generate/materials.js';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi, textOf, withBrowserGlobals } from './helpers/react-harness.mjs';

const h = React.createElement;
const noop = () => {};

const m = await loadUi(`
  export { setUiLanguage } from './ui/i18n.js';
  export { default as Manage } from './ui/Manage.jsx';
  export { WrongBookView, resolveArrivalScope } from './ui/WrongBook.jsx';
  export { scopedAttemptsOf } from './ui/PageScope.jsx';
  export { default as ExamCoachPage } from './ui/ExamCoachPage.jsx';
  export { default as SourcePicker } from './ui/SourcePicker.jsx';
  export { default as Generate } from './ui/Generate.jsx';
  export { performBindingUpdate } from './ui/app/use-library-connection.js';
  export { StudyServicesContext, StudyBusyProvider } from './ui/study-context.jsx';
  export { AppContext } from './ui/app/app-context.js';
`);

const withServices = (node, services = {}) => h(m.StudyServicesContext.Provider, {
  value: {
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
    ...services,
  },
}, node);

/* ---------- W1-15: library switch clears old snapshot & avoids premature epoch bump ---------- */

test('W1-15: performBindingUpdate does not bump epoch on failure/noop, clears old data on move, and prevents split-brain on refresh error', async () => {
  assert.equal(typeof m.performBindingUpdate, 'function', 'performBindingUpdate helper exported');

  // 1. Failed binding.set leaves epoch & navigation untouched
  {
    const refs = {
      epoch: { current: 3 },
      navigation: { current: 5 },
      requestSequence: { current: 10 },
      leaveTimer: { current: 0 },
      dataRef: { current: { root: '/old', decks: [{ id: 'd1' }] } },
      snapshotKey: { current: { decks: 'x' } },
    };
    const errors = [];
    const ok = await m.performBindingUpdate({
      patch: { root: '/bad-dir' },
      bindingRef: { current: { root: '/old', rootSource: 'custom' } },
      refs,
      host: { warmKey: 'k' },
      language: 'zh',
      call: async () => { throw new Error('Directory not found'); },
      refresh: async () => {},
      resetLibraryState: () => { throw new Error('must not reset on failed binding.set'); },
      setBinding: noop,
      setData: noop,
      setLoading: noop,
      setBusy: noop,
      setError: (e) => errors.push(e),
      notify: noop,
      flushUndoable: async () => {},
      writeWarmBinding: noop,
      clearWarmSession: noop,
      customBinding: (p) => p,
    });
    assert.equal(ok, false);
    assert.equal(refs.epoch.current, 3, 'epoch must not advance when binding.set fails');
    assert.equal(refs.navigation.current, 5, 'navigation must not advance when binding.set fails');
    assert.equal(refs.dataRef.current.root, '/old', 'old library data stays intact on failed binding.set');
    assert.match(errors.at(-1) || '', /Directory not found/);
  }

  // 2. Successful move resets BEFORE writeWarmBinding, clears old dataRef/serverData immediately, and leaves null on refresh failure (no split-brain)
  {
    const events = [];
    let currentData = { root: '/old', decks: [{ id: 'd-old' }] };
    const refs = {
      epoch: { current: 1 },
      navigation: { current: 1 },
      requestSequence: { current: 1 },
      leaveTimer: { current: 0 },
      dataRef: { current: currentData },
      snapshotKey: { current: { decks: 'old' } },
    };
    const bindingRef = { current: { root: '/old', rootSource: 'custom' } };
    const ok = await m.performBindingUpdate({
      patch: { root: '/new' },
      bindingRef,
      refs,
      host: { warmKey: 'k' },
      language: 'zh',
      call: async () => ({ root: '/new', rootSource: 'custom' }),
      refresh: async () => {
        events.push(['refresh', refs.dataRef.current]);
        throw new Error('New library unreadable');
      },
      resetLibraryState: (reason) => {
        events.push(['reset', reason]);
        refs.epoch.current += 1;
      },
      setBinding: (b) => events.push(['setBinding', b.root]),
      setData: (d) => { currentData = d; events.push(['setData', d]); },
      setLoading: (v) => events.push(['setLoading', v]),
      setBusy: noop,
      setError: (e) => events.push(['setError', e]),
      notify: noop,
      flushUndoable: async () => events.push(['flush']),
      writeWarmBinding: (_k, b) => events.push(['warm', b.root]),
      clearWarmSession: () => events.push(['clearWarm']),
      customBinding: (p) => p,
    });
    assert.equal(ok, false);
    assert.equal(refs.dataRef.current, null, 'old library dataRef cleared before refresh so failure never causes split-brain');
    assert.equal(currentData, null, 'serverData cleared on move');
    assert.deepEqual(refs.snapshotKey.current, {});
    const resetIdx = events.findIndex(([e]) => e === 'reset');
    const warmIdx = events.findIndex(([e]) => e === 'warm');
    assert.ok(resetIdx >= 0 && warmIdx > resetIdx, 'writeWarmBinding runs AFTER resetLibraryState so reset does not wipe it');
    assert.equal(events.find(([e]) => e === 'refresh')?.[1], null, 'refresh sees null dataRef so it will not trigger a second switch reset');
    assert.deepEqual(events.filter(([e]) => e === 'setLoading'), [['setLoading', true], ['setLoading', false]]);
  }
});

/* ---------- W1-04: Manage.jsx deck reorder scopes to active same-course decks ---------- */

test('W1-04: Manage scopes deck reorder siblings to non-archived non-system decks of the same course', () => {
  m.setUiLanguage('zh');
  const deckA1 = { id: 'a1', title: 'OS Ch1', course: 'OS', folder: '', cards: [{ id: 'c1', topic: 'T1' }] };
  const deckB1 = { id: 'b1', title: 'DB Ch1', course: 'DB', folder: '', cards: [{ id: 'c2', topic: 'T2' }] };
  const deckAArchived = { id: 'a2', title: 'OS Old', course: 'OS', folder: '', archived: true, cards: [] };
  const deckSlain = { id: 'slain', title: '已斩', course: 'OS', folder: '', systemKind: 'slain', cards: [] };

  // Only 1 active deck in OS (other decks are in DB, archived, or slain) -> reorder section hidden!
  const singleCourseHtml = renderToStaticMarkup(withServices(h(m.Manage, {
    managedDeck: deckA1,
    setManagedDeck: noop,
    decks: [deckB1, deckA1, deckAArchived, deckSlain],
    sources: [],
    folderDraft: '',
    setFolderDraft: noop,
    setPage: noop,
    openDraft: noop,
    onRemoveDeck: noop,
    runs: [],
  })));
  assert.doesNotMatch(singleCourseHtml, />上移题组</, 'must not offer cross-course/archived reorder when current course has only 1 active deck');

  // 2 active decks in OS -> reorder section shown with position 1 / 2 and honest scope explanation
  const deckA2 = { id: 'a3', title: 'OS Ch2', course: 'OS', folder: '', cards: [{ id: 'c3', topic: 'T3' }] };
  const twoInCourseHtml = renderToStaticMarkup(withServices(h(m.Manage, {
    managedDeck: deckA1,
    setManagedDeck: noop,
    decks: [deckB1, deckA1, deckA2, deckAArchived],
    sources: [],
    folderDraft: '',
    setFolderDraft: noop,
    setPage: noop,
    openDraft: noop,
    onRemoveDeck: noop,
    runs: [],
  })));
  assert.match(twoInCourseHtml, />上移题组</);
  assert.match(twoInCourseHtml, /第 1 \/ 2 个/);
  // Up button must be disabled even though deckB1 (another course) is earlier in decks!
  const upBtn = twoInCourseHtml.match(/<button[^>]*>[^<]*上移题组[^<]*<\/button>/)?.[0] || '';
  assert.match(upBtn, /\bdisabled\b/, 'up button disabled when deck is already first in its own course');
});

/* ---------- W1-01 & W1-27: WrongBook arrival scope/primary button & RubricSkills course scope ---------- */

test('W1-01: resolveArrivalScope preserves single active course and WrongBookView promotes filtered subset button to sole primary', () => {
  assert.equal(typeof m.resolveArrivalScope, 'function');
  const data = {
    decks: [
      { id: 'd-os', course: 'OS', inactive: false },
      { id: 'd-db', course: 'DB', inactive: false },
      { id: 'd-parked', course: 'Old', inactive: true },
    ],
    focus: { course: 'OS', courses: [{ name: 'OS' }, { name: 'DB' }, { name: 'Old', status: 'inactive' }] },
  };
  assert.deepEqual(
    m.resolveArrivalScope([{ deckId: 'd-os', cardId: 'c1' }], data, 'OS', false),
    { course: 'OS', showInactive: false },
    'single active course arrival stays inside that course without enabling showInactive',
  );
  assert.deepEqual(
    m.resolveArrivalScope([{ deckId: 'd-db', cardId: 'c2' }], data, 'OS', false),
    { course: 'DB', showInactive: false },
    'arrival for another single active course narrows to that course instead of all courses',
  );
  assert.deepEqual(
    m.resolveArrivalScope([{ deckId: 'd-os', cardId: 'c1' }, { deckId: 'd-db', cardId: 'c2' }], data, 'OS', false),
    { course: '*', showInactive: false },
    'multi-course active arrival widens to all active courses without exposing inactive courses',
  );
  assert.deepEqual(
    m.resolveArrivalScope([{ deckId: 'd-parked', cardId: 'c3' }], data, 'OS', false),
    { course: 'Old', showInactive: true },
    'inactive course arrival enables showInactive',
  );

  m.setUiLanguage('zh');
  const items = [
    { deckId: 'd-os', cardId: 'c1', deckTitle: 'OS', topic: 'T1', prompt: 'Q1', status: 'weak', wrongCount: 2, level: 'weak' },
    { deckId: 'd-os', cardId: 'c2', deckTitle: 'OS', topic: 'T1', prompt: 'Q2', status: 'weak', wrongCount: 1, level: 'weak' },
    { deckId: 'd-os', cardId: 'c3', deckTitle: 'OS', topic: 'T1', prompt: 'Q3', status: 'weak', wrongCount: 1, level: 'weak' },
  ];
  const html = renderToStaticMarkup(withServices(h(m.WrongBookView, {
    data: { ...data, attempts: [] },
    course: 'OS',
    onCourseChange: noop,
    items,
    counts: { total: 3, weak: 3, learning: 0, due: 0 },
    totalCount: 3,
    page: 0,
    hasMore: false,
    result: { items, total: 3, hasMore: false },
    loading: false,
    onPractice: noop,
    initial: { filter: { status: 'all', deck: '', query: '', leech: false, only: [{ deckId: 'd-os', cardId: 'c1' }] } },
  })));
  const primaryBtns = [...html.matchAll(/<button[^>]*sh-btn--primary[^>]*>([\s\S]*?)<\/button>/g)].map((hit) => hit[1].replace(/<[^>]+>/g, ''));
  assert.equal(primaryBtns.length, 1, `expected exactly one primary button, got: ${JSON.stringify(primaryBtns)}`);
  assert.match(primaryBtns[0], /练.*1.*道/, `focused arrival must promote the focused 1-card button to primary, got: ${primaryBtns[0]}`);
});

test('W1-27: WrongBookView scopes RubricSkills attempts and case-study practice to localDecks of current course', () => {
  assert.equal(typeof m.scopedAttemptsOf, 'function');
  m.setUiLanguage('zh');
  const data = {
    decks: [
      { id: 'd-a', title: 'Course A Case', course: 'CourseA', format: 'case-study', available: 2, inactive: false },
      { id: 'd-b', title: 'Course B Quiz', course: 'CourseB', format: 'quiz', available: 5, inactive: false },
    ],
    focus: { course: 'CourseB', courses: [{ name: 'CourseA' }, { name: 'CourseB' }] },
    attempts: [
      { deckId: 'd-a', quiz_id: 'ca1', grade: 1, rubric: { items: [{ criterion: '证据引用', status: 'missing' }] }, timestamp: '2026-11-20T00:00:00Z' },
      { deckId: 'd-a', quiz_id: 'ca2', grade: 1, rubric: { items: [{ criterion: '证据引用', status: 'missing' }] }, timestamp: '2026-11-21T00:00:00Z' },
    ],
  };
  const bItems = [{ deckId: 'd-b', cardId: 'cb1', deckTitle: 'Course B Quiz', topic: 'T', prompt: 'Q', status: 'weak', wrongCount: 1, level: 'weak' }];
  const html = renderToStaticMarkup(withServices(h(m.WrongBookView, {
    data,
    course: 'CourseB',
    onCourseChange: noop,
    items: bItems,
    counts: { total: 1, weak: 1, learning: 0, due: 0 },
    totalCount: 1,
    page: 0,
    hasMore: false,
    result: { items: bItems, total: 1, hasMore: false },
    loading: false,
    onPractice: noop,
  })));
  assert.doesNotMatch(html, /证据引用/, 'Course B wrongbook must not display Course A rubric skills');
  assert.doesNotMatch(html, />练案例题</, 'Course B without case-study decks must not offer practicing Course A case decks');
});

/* ---------- W1-28: ExamCoachPage course switch isolation & single primary button ---------- */

test('W1-28: ExamCoachPage avoids dual primary buttons on step 1 without sources and guards course switch + save error', async () => {
  m.setUiLanguage('zh');
  const emptyHtml = renderToStaticMarkup(withServices(h(m.ExamCoachPage, {
    data: { sources: [], decks: [], courses: [{ name: 'OS' }, { name: 'DB' }], focus: { course: 'OS' }, model: { ready: true } },
    onGoGenerate: noop,
  })));
  const primaryBtns = [...emptyHtml.matchAll(/<button[^>]*sh-btn--primary[^>]*>([\s\S]*?)<\/button>/g)].map((hit) => hit[1].replace(/<[^>]+>/g, ''));
  assert.equal(primaryBtns.length, 1, `step 1 with no sources must have only one primary CTA, got: ${JSON.stringify(primaryBtns)}`);

  // Interactive verification: save failure keeps rule editor open with error feedback,
  // save success closes & commits cleanly, and switching course resets cross-course state.
  await withBrowserGlobals(async () => {
    const ui = await loadInteractiveUi(`
      export { setUiLanguage } from './ui/i18n.js';
      export { default as ExamCoachPage } from './ui/ExamCoachPage.jsx';
      export { Select } from './ui/components/index.js';
      export { StudyServicesContext } from './ui/study-context.jsx';
    `);
    ui.exports.setUiLanguage('zh');

    const osSpec = {
      specVersion: 1,
      stage: 'confirm',
      templateName: 'OS Exam',
      taskFamilies: [
        {
          id: 'fam-os',
          title: 'OS Scheduling Proof',
          origin: 'source-fact',
          primaryFormat: 'open',
          allowedFormats: ['open'],
          reasoningSteps: ['Identify process states'],
          sample: { stem: 'Analyze round-robin turnaround', rubric: 'Original OS rubric', redacted: false },
          confirmations: {},
          calibrated: false,
        },
      ],
    };

    const calls = [];
    const notices = [];
    let failSave = true;
    let resolveDbGet;
    const dbGetPromise = new Promise((res) => { resolveDbGet = res; });

    const call = async (action, args) => {
      calls.push({ action, args });
      if (action === 'coach.calibration.get') {
        if (args.course === 'OS') return { spec: osSpec, evidence: null };
        if (args.course === 'DB') return dbGetPromise;
        return { spec: null, evidence: null };
      }
      if (action === 'coach.calibration.save') {
        if (failSave) throw new Error('Calibration store write failed');
        return {
          spec: { ...osSpec, specVersion: 2, taskFamilies: args.taskFamilies },
          evidence: null,
        };
      }
      return {};
    };

    const pageData = {
      sources: [{ id: 's-os', title: 'OS Notes', course: 'OS' }],
      decks: [],
      courses: [{ name: 'OS' }, { name: 'DB' }],
      focus: { course: 'OS' },
      model: { ready: true },
    };

    const mounted = ui.mount(() => ui.React.createElement(
      ui.exports.StudyServicesContext.Provider,
      {
        value: {
          call,
          act: async () => undefined,
          busy: false,
          notify: (note) => notices.push(note),
          askInChat: noop,
          host: {},
          openSettings: noop,
          navigate: noop,
          openModal: noop,
        },
      },
      ui.React.createElement(ui.exports.ExamCoachPage, { data: pageData, onGoGenerate: noop }),
    ));

    try {
      await mounted.flush(5);
      assert.match(mounted.text(), /OS Scheduling Proof/, 'OS spec loads into confirm stage');
      assert.match(mounted.text(), /规格版本 1/);

      // Open the rule editor for fam-os
      const editBtn = mounted.find((n) => n.type === 'button' && textOf(n).includes('编辑推理步骤与评分规则'));
      assert.ok(editBtn, 'rule editor trigger button renders');
      await mounted.act(() => click(editBtn));
      assert.ok(mounted.find((n) => n.type === 'button' && textOf(n).includes('保存规则修改')), 'rule editor opens');

      // Modify reasoning steps draft
      const textareas = mounted.findAll((n) => n.type === 'textarea');
      assert.equal(textareas.length, 2, 'rule editor renders reasoning and rubric textareas');
      await mounted.act(() => textareas[0].props.onChange({ target: { value: 'Identify process states\nVerify quantum bound' } }));

      // 1. Failed coach.calibration.save keeps rule editor open with error feedback
      const saveBtnFail = mounted.find((n) => n.type === 'button' && textOf(n).includes('保存规则修改'));
      await mounted.act(() => click(saveBtnFail));
      await mounted.flush(5);
      assert.match(mounted.text(), /Calibration store write failed/, 'save error feedback is shown');
      assert.ok(mounted.find((n) => n.type === 'button' && textOf(n).includes('保存规则修改')), 'rule editor stays open after failed save');
      assert.equal(mounted.findAll((n) => n.type === 'textarea')[0].props.value, 'Identify process states\nVerify quantum bound', 'edited draft is preserved after failed save');

      // 2. Successful coach.calibration.save closes editor, clears error, and commits updated spec
      failSave = false;
      const saveBtnOk = mounted.find((n) => n.type === 'button' && textOf(n).includes('保存规则修改'));
      await mounted.act(() => click(saveBtnOk));
      await mounted.flush(5);
      assert.equal(mounted.find((n) => n.type === 'button' && textOf(n).includes('保存规则修改')), null, 'rule editor closes after successful save');
      assert.doesNotMatch(mounted.text(), /Calibration store write failed/, 'error feedback clears after successful save');
      assert.match(mounted.text(), /规格版本 2/, 'committed spec version updates');
      assert.match(mounted.text(), /Verify quantum bound/, 'committed reasoning step renders');
      assert.ok(notices.some((n) => n?.tone === 'success'), 'success toast emitted');

      // Re-open editor before switching course to verify course switch clears editor + spec + stage immediately
      const reopenBtn = mounted.find((n) => n.type === 'button' && textOf(n).includes('编辑推理步骤与评分规则'));
      await mounted.act(() => click(reopenBtn));
      assert.ok(mounted.find((n) => n.type === 'button' && textOf(n).includes('保存规则修改')));

      // 3. Switching course resets cross-course state before the new course request even settles
      const courseSelect = mounted.find((n) => n.type === ui.exports.Select);
      assert.ok(courseSelect, 'course selector renders');
      await mounted.act(() => courseSelect.props.onChange('DB'));
      assert.doesNotMatch(mounted.text(), /OS Scheduling Proof/, 'prior course task family is cleared on course switch');
      assert.equal(mounted.find((n) => n.type === 'button' && textOf(n).includes('保存规则修改')), null, 'open rule editor is cleared on course switch');
      assert.match(mounted.text(), /第 1 步：分析考察方式与范围边界/, 'stage resets to analyze on course switch');
      assert.ok(calls.some((c) => c.action === 'coach.calibration.get' && c.args.course === 'DB'), 'fetches calibration for new course');

      resolveDbGet({ spec: null, evidence: null });
      await mounted.flush(5);
      assert.doesNotMatch(mounted.text(), /OS Scheduling Proof/, 'new course remains isolated after calibration get resolves');
    } finally {
      resolveDbGet({ spec: null, evidence: null });
      mounted.unmount();
    }
  });
});

/* ---------- W1-26: Archived/deleted sources excluded from selection & generation ---------- */

test('W1-26: SourcePicker ignores stale archived/deleted IDs, shows filter label on facets, and backend excludes archived sources on new generation', () => {
  m.setUiLanguage('zh');
  const activeSrc = { id: 's-active', title: '讲义 A.md', text: '内容 A', course: 'OS' };
  const archivedSrc = { id: 's-archived', title: '旧讲义.md', text: '旧内容', course: 'OS', archived: true };

  // SourcePicker given stale archived + deleted IDs must NOT claim "其他范围" or offer "清空选择"
  const pickerHtml = renderToStaticMarkup(h(m.SourcePicker, {
    sources: [activeSrc, archivedSrc],
    selected: ['s-archived', 's-deleted'],
    onChange: noop,
    courses: [{ name: 'OS' }],
    scope: '*',
    onScopeChange: noop,
  }));
  assert.match(pickerHtml, /已选择 0 \/ 1 份资料/);
  assert.doesNotMatch(pickerHtml, /已选资料包含其他范围/, 'deleted/archived IDs must not trigger outside-scope warning');
  assert.doesNotMatch(pickerHtml, />清空选择</, 'clear-selection button hidden when 0 active materials are selected');

  // Backend selectedSources excludes archived sources for new generations
  const picked = backendSelectedSources({
    s: { sources: [activeSrc, archivedSrc] },
    previous: null,
    extraIds: null,
    covering: null,
    request: { sourceIds: ['s-active', 's-archived'] },
  });
  assert.deepEqual(picked.map((s) => s.id), ['s-active'], 'backend generation must not silently feed archived sources to the LLM');
});
