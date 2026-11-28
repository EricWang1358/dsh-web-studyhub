import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const h = React.createElement;
const noop = () => {};

const m = await loadUi(`
  export { setUiLanguage } from './ui/i18n.js';
  export { default as MergeSuggestions, afterMergeConfirmed } from './ui/study-map/MergeSuggestions.jsx';
  export { notificationPermissionState, timerMinutesError } from './ui/board/TodayTimer.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
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

/* ---------- W1-02: ImportHub preserves 查看已导入的内容 after dropping failed items ---------- */

test('W1-02: ImportHub keeps summary and 查看已导入的内容 when failed drops to 0 with finished > 0', async () => {
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as ImportHub } from './ui/ImportHub.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;

  const makeFile = (name, body) => ({
    name,
    size: body.length,
    type: 'text/markdown',
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  });

  let completedSummary = null;
  const call = async (action, args) => {
    if (action === 'materials.document.import' || action === 'source.add') {
      const title = args?.title || args?.filename || '';
      if (title.includes('bad')) throw new Error('格式损坏');
      return { id: 'src-good', documentId: 'doc-good', title: title || 'good', format: 'md', pages: 1, sourceIds: ['src-good'] };
    }
    return {};
  };
  const services = { call, act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };

  await withBrowserGlobals(async () => {
    const view = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, { value: services },
      hI(ui.exports.ImportHub, {
        data: { focus: { course: 'OS', courses: ['OS'] }, sources: [], contexts: ['materials'] },
        onComplete: (summary) => { completedSummary = summary; },
      })));
    try {
      const fileDrop = view.find((n) => typeof n.props?.onFiles === 'function');
      assert.ok(fileDrop, 'FileDrop rendered in ImportHub');

      await view.act(() => fileDrop.props.onFiles([
        makeFile('good.md', '# Good notes\nSome valid content.'),
        makeFile('bad.unknown', 'cannot import'),
      ]));
      await view.flush(8);

      // With 1 done + 1 failed: warning summary shown with 查看已导入的内容
      const warnSummary = view.find((n) => n.props?.className?.includes('import-hub__summary'));
      assert.ok(warnSummary, 'summary bar rendered after partial import');
      assert.equal(warnSummary.props.tone, 'warning', 'uses warning tone while failures remain');
      assert.ok(view.text().includes('1 个文件已导入，1 个没有导入'), 'reports both done and failed counts');

      // Drop the failed item -> failed becomes 0 while finished stays 1
      const removeBtn = view.find((n) => n.type === 'button' && (ui.textOf(n).includes('移除') || n.props?.['aria-label']?.includes('移除')));
      assert.ok(removeBtn, 'failed file exposes remove button');
      await view.act(() => click(removeBtn));
      await view.flush(4);

      const okSummary = view.find((n) => n.props?.className?.includes('import-hub__summary'));
      assert.ok(okSummary, 'summary bar stays visible after dropping the last failed item when finished > 0');
      assert.equal(okSummary.props.tone, 'success', 'switches to success tone once failed hits 0');
      assert.ok(view.text().includes('1 个文件已导入'), 'shows finished summary text');

      const viewImportedBtn = view.find((n) => n.type === 'button' && ui.textOf(n).includes('查看已导入的内容'));
      assert.ok(viewImportedBtn, 'retains 查看已导入的内容 action button');
      await view.act(() => click(viewImportedBtn));
      assert.equal(completedSummary?.done, 1, 'clicking 查看已导入的内容 invokes onComplete with summary');
    } finally {
      view.unmount();
    }
  });
});

/* ---------- W1-07: CourseSettings -> CustomPlanCard -> CustomReadiness closes modal, switches course, keeps book target ---------- */

test('W1-07: CustomReadiness receives data & onClose, reads snapshotData ?? app?.data, switches course and closes dialog', async () => {
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as CourseSettings } from './ui/CourseSettings.jsx';
    export { default as CustomPlanCard } from './ui/CustomPlanCard.jsx';
    export { default as CustomReadiness } from './ui/CustomReadiness.jsx';
    export { keptBook } from './ui/book/model.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { AppContext } from './ui/app/app-context.js';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;

  const custom = {
    updatedAt: '2026-11-24T00:00:00Z',
    purpose: 'review',
    scope: { kind: 'all' },
    book: { parts: ['explain'], level: 'standard' },
    questions: { make: true, kinds: ['quiz'], variants: false },
    plan: { make: true, by: 'exam' },
  };
  const course = { id: 'course-os', name: 'OS', custom, focusTopics: [], guidanceSourceIds: [] };
  const root = '/tmp/w1-07-root';
  const snapshotData = { root, focus: { course: 'DB', courses: ['DB', 'OS'] }, courses: [course], sources: [], decks: [] };

  let resolveFocusSet;
  const actions = [];
  const closed = [];
  const navigated = [];
  const services = {
    call: async (action) => {
      if (action === 'course.custom.readiness') {
        return {
          status: 'ok',
          basis: 'outline',
          counted: { explained: true, questions: true },
          chapters: [
            {
              id: 'ch1',
              title: '虚拟内存',
              built: true,
              points: 2,
              explained: 1,
              asked: 0,
              practised: 0,
              solid: 0,
              readiness: 0.25,
              todo: { explain: 1, questions: 2, weak: 0 },
              gapHint: { kind: 'weak_cards', targetHid: 'H7' },
            },
          ],
        };
      }
      if (action === 'course.custom.preview') return null;
      return {};
    },
    act: (action, args) => {
      actions.push({ action, args });
      return new Promise((resolve) => { resolveFocusSet = resolve; });
    },
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: (page) => navigated.push(page),
    openModal: noop,
  };
  const onClose = (reason) => closed.push(reason);

  await withBrowserGlobals(async () => {
    // 1. CourseSettings -> CustomPlanCard -> CustomReadiness prop forwarding (data & onClose)
    const csView = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, { value: services },
      hI(ui.exports.AppContext.Provider, { value: { language: 'zh', data: snapshotData, host: {}, canChat: false, core: { call: services.call, act: services.act, busy: false, notify: noop } } },
        hI(ui.exports.CourseSettings, { courseId: course.id, data: snapshotData, onClose }))));
    try {
      const planNode = csView.find((n) => n.type === ui.exports.CustomPlanCard);
      assert.equal(planNode?.props?.data, snapshotData, 'CourseSettings forwards data to CustomPlanCard');
      assert.equal(typeof planNode?.props?.onClose, 'function', 'CourseSettings forwards onClose to CustomPlanCard');
      const readyNode = csView.find((n) => n.type === ui.exports.CustomReadiness);
      assert.equal(readyNode?.props?.data, snapshotData, 'CustomPlanCard forwards data to CustomReadiness');
      assert.equal(readyNode?.props?.onClose, planNode?.props?.onClose, 'CustomPlanCard forwards onClose to CustomReadiness');

      await csView.flush(6);
      const gapBtn = csView.find((n) => n.type === 'button' && n.props?.['data-gap-hint']);
      assert.ok(gapBtn, 'CustomReadiness renders gap jump button');

      // 2. Clicking gap button switches course via act(focus.set), locks against double clicks, keeps book target, closes dialog, and navigates to book
      const jumpPromise = csView.act(() => click(gapBtn));
      await csView.flush(2);
      const lockedGapBtn = csView.find((n) => n.type === 'button' && n.props?.['data-gap-hint']);
      assert.equal(lockedGapBtn?.props?.disabled || lockedGapBtn?.props?.['aria-disabled'] === 'true', true, 'locks gap jump button while focus.set is in flight');
      // Double-click while locked is ignored
      await csView.act(() => click(lockedGapBtn));
      assert.equal(actions.length, 1, 'locked gap button prevents duplicate focus.set');

      resolveFocusSet(true);
      await jumpPromise;
      await csView.flush(3);
      assert.deepEqual(actions, [{ action: 'focus.set', args: { course: 'OS' } }]);
      assert.deepEqual(closed, ['custom-readiness'], 'closes CourseSettings dialog on jump');
      assert.deepEqual(navigated, ['book'], 'navigates to book page for built chapter');
      const kept = ui.exports.keptBook(root, 'OS');
      assert.equal(kept?.target, 'H7', 'persists targetHid in keepBook');
      assert.equal(kept?.switched, true, 'marks switched flag when course changed');
    } finally {
      csView.unmount();
    }

    // 3. Fallback to AppContext.data (not nonexistent app.core.data) when snapshotData prop is omitted
    actions.length = 0; closed.length = 0; navigated.length = 0;
    const standaloneServices = { ...services, act: async (action, args) => { actions.push({ action, args }); return true; } };
    const appFallbackView = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, { value: standaloneServices },
      hI(ui.exports.AppContext.Provider, { value: { language: 'zh', data: snapshotData, host: {}, canChat: false } },
        hI(ui.exports.CustomReadiness, { course, onClose }))));
    try {
      await appFallbackView.flush(6);
      const gapBtn = appFallbackView.find((n) => n.type === 'button' && n.props?.['data-gap-hint']);
      await appFallbackView.act(() => click(gapBtn));
      await appFallbackView.flush(3);
      assert.deepEqual(actions, [{ action: 'focus.set', args: { course: 'OS' } }], 'reads app.data.focus.course when snapshotData is omitted');
      assert.equal(ui.exports.keptBook(root, 'OS')?.target, 'H7', 'reads app.data.root for keepBook');
    } finally {
      appFallbackView.unmount();
    }
  });
});

/* ---------- W1-18: CourseCompanionsBar clears hidden filter on course switch or <= 6 companions ---------- */

test('W1-18: CourseCompanionsBar resets filter on course change and disables/clears filters when companions <= 6', async () => {
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as CourseCompanionsBar } from './ui/companions/CourseCompanionsBar.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { AppContext } from './ui/app/app-context.js';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;

  const makeCompanions = (prefix, count) => Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i + 1}`,
    title: `${prefix} Lesson ${i + 1}`,
    relPath: `${prefix}/${i + 1}.html`,
    progress: i === 0 ? { completed: true, slide: 5 } : { completed: false, slide: 1 },
  }));

  const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
  let props = {
    course: 'OS',
    data: {
      courses: [
        { name: 'OS', companions: makeCompanions('OS', 7) },
        { name: 'DB', companions: makeCompanions('DB', 7) },
      ],
      decks: [],
      sources: [],
    },
  };

  await withBrowserGlobals(async () => {
    const view = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, { value: services },
      hI(ui.exports.AppContext.Provider, { value: { language: 'zh', data: props.data, host: {}, canChat: false, core: {} } },
        hI(ui.exports.CourseCompanionsBar, props))));
    try {
      // With 7 companions (> 6), toolbar is shown; apply search query and status filter
      const search = view.find((n) => n.type === 'input' && n.props?.type === 'search');
      assert.ok(search, 'search toolbar shown when companions > 6');
      await view.act(() => search.props.onChange({ target: { value: 'OS Lesson 1' } }));
      const doneBtn = view.find((n) => n.type === 'button' && ui.textOf(n) === '已学完');
      assert.ok(doneBtn, 'status filter shown');
      await view.act(() => click(doneBtn));
      assert.ok(view.text().includes('OS Lesson 1'));
      assert.equal(view.text().includes('OS Lesson 2'), false, 'filter hides non-matching items');

      // 1. Switching course in place resets query and statusFilter
      props = { ...props, course: 'DB' };
      view.rerender();
      assert.equal(view.find((n) => n.type === 'input' && n.props?.type === 'search').props.value, '', 'query resets on course switch');
      assert.ok(view.text().includes('DB Lesson 2'), 'all DB companions visible after course switch');

      // 2. Apply filter again, then shrink companions to <= 6 -> toolbar hides AND all items stay visible
      await view.act(() => view.find((n) => n.type === 'input' && n.props?.type === 'search').props.onChange({ target: { value: 'nonexistent-query' } }));
      assert.equal(view.text().includes('DB Lesson 1'), false, 'filter hides items when > 6');

      props = {
        ...props,
        data: {
          ...props.data,
          courses: [
            { name: 'OS', companions: makeCompanions('OS', 7) },
            { name: 'DB', companions: makeCompanions('DB', 5) },
          ],
        },
      };
      view.rerender();
      assert.equal(view.find((n) => n.type === 'input' && n.props?.type === 'search'), null, 'toolbar hides when companions <= 6');
      assert.ok(view.text().includes('DB Lesson 1') && view.text().includes('DB Lesson 5'), 'never hides companions behind an invisible filter when <= 6');
    } finally {
      view.unmount();
    }
  });
});

/* ---------- W1-25: Sources organize error close does not destroy proposals; stop button shows busy/cancelling ---------- */

test('W1-25: Sources decouples organize error close from dismissOrganizeProposals and locks/shows busy on stop', async () => {
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as Sources } from './ui/Sources.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { AppContext } from './ui/app/app-context.js';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;

  let resolveCancel;
  let cancelCalls = 0;
  const call = (action) => {
    if (action === 'job.control') {
      cancelCalls += 1;
      return new Promise((resolve) => { resolveCancel = resolve; });
    }
    if (action === 'source.organize.start') return Promise.reject(new Error('整理接口暂时失败'));
    return Promise.resolve({});
  };
  const act = async (action, _args, onOk) => {
    if (action === 'source.organize.jev') {
      onOk?.({ proposals: [{ id: 's1', title: 'OS Notes', courses: ['OS'], decidedBy: 'jev', confidence: 0.9 }] });
    }
    return true;
  };
  const services = { call, act, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };

  let data = {
    root: '/tmp/w1-25',
    sources: [{ id: 's1', title: 'OS Notes', chars: 500, courses: [] }],
    decks: [],
    courses: [{ name: 'OS' }],
    focus: { course: '', courses: ['OS'] },
    jobs: [],
    modelReady: true,
    settings: { experimental: { jev: true } },
  };

  await withBrowserGlobals(async () => {
    const view = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, { value: services },
      hI(ui.exports.AppContext.Provider, { value: { language: 'zh', data, host: {}, canChat: false, core: { call, act, busy: false, notify: noop } } },
        hI(ui.exports.Sources, { data, onOpenSource: noop }))));
    try {
      // The organizer is behind 「筛选与分组」.
      const toolsBtn = view.find((n) => n.type === 'button' && n.props?.['data-tour'] === 'sources-tools');
      assert.ok(toolsBtn, '筛选与分组 rendered');
      await view.act(() => click(toolsBtn));

      // Select current scope and load proposals via Jev suggest
      const selectAllBtn = view.find((n) => n.type === 'button' && ui.textOf(n).includes('选择当前范围'));
      assert.ok(selectAllBtn, 'select scope button rendered');
      await view.act(() => click(selectAllBtn));

      // Trigger AI organize error while proposals are present
      const aiBtn = view.find((n) => n.type === 'button' && n.props?.['data-organize-ai'] !== undefined);
      assert.ok(aiBtn, 'AI organize button rendered');

      // Populate proposals via Jev suggest button, then trigger AI organize error
      const jevBtn = view.find((n) => typeof n.type === 'function' && n.type.name === 'JevSuggestButton');
      assert.ok(jevBtn?.props?.onClick, 'JevSuggestButton rendered');
      await view.act(() => jevBtn.props.onClick());
      await view.flush(3);
      assert.ok(view.find((n) => n.props?.['data-organize-phase'] === 'review'), 'proposals review section shown');

      await view.act(() => click(aiBtn));
      await view.flush(4);
      assert.ok(view.text().includes('整理接口暂时失败'), 'organize error banner shown');

      // Clicking 关闭 on error banner clears ONLY organizeError and keeps proposals intact
      const errBanner = view.find((n) => n.props?.className?.includes('source-organize-error'));
      const closeErrBtn = view.find((n) => n.type === 'button' && ui.textOf(n) === '关闭', errBanner);
      assert.ok(closeErrBtn, 'error banner has 关闭 button');
      await view.act(() => click(closeErrBtn));
      assert.equal(view.text().includes('整理接口暂时失败'), false, 'error banner dismissed');
      assert.ok(view.find((n) => n.props?.['data-organize-phase'] === 'review'), 'closing error banner preserves proposals');

      // Explicit discard button still dismisses proposals
      const discardBtn = view.find((n) => n.type === 'button' && n.props?.['data-discard-organize'] !== undefined);
      assert.ok(discardBtn, 'explicit data-discard-organize button rendered');
      await view.act(() => click(discardBtn));
      await view.flush(3);
      assert.equal(view.find((n) => n.props?.['data-organize-phase'] === 'review'), null, 'explicit discard clears proposals');

      // Active organize job stop button reflects stopping & cancelling busy state
      data = {
        ...data,
        jobs: [{ id: 'org-run', type: 'material-organize', status: 'running', done: 1, total: 3, contract: { status: 'running', progress: { done: 1, total: 3 } } }],
      };
      view.rerender();
      const stopBtn = view.find((n) => n.type === 'button' && n.props?.['data-stop-organize'] !== undefined);
      assert.ok(stopBtn, 'stop organize button rendered while running');
      const stopPromise = view.act(() => click(stopBtn));
      await view.flush(2);
      assert.equal(cancelCalls, 1, 'stop invokes job.control cancel');
      assert.ok(view.text().includes('正在停止…'), 'stop button shows stopping busy label');
      resolveCancel({});
      await stopPromise;
      await view.flush(3);

      // Cancelling status from snapshot also shows busy 正在停止…
      data = {
        ...data,
        jobs: [{ id: 'org-run', type: 'material-organize', status: 'cancelling', done: 1, total: 3, contract: { status: 'cancelling', progress: { done: 1, total: 3 } } }],
      };
      view.rerender();
      assert.ok(view.text().includes('正在停止…'), 'cancelling status shows busy stopping label');
    } finally {
      view.unmount();
    }
  });
});

/* ---------- W1-30: MergeSuggestions handles last-proposal close, mid-flight close, dismissable error, and course switch ---------- */

test('W1-30: afterMergeConfirmed closes cleanly on last item and null mid-flight; MergeSuggestions has dismissable error and uncategorized fallback', async () => {
  m.setUiLanguage('zh');
  assert.equal(m.afterMergeConfirmed(null, 'd1'), null, 'does not throw when panel was closed mid-flight');
  assert.equal(
    m.afterMergeConfirmed({ course: 'OS', proposals: [{ targetId: 'd1' }] }, 'd1'),
    null,
    'closes panel cleanly after merging the last proposal instead of showing no-suggestions message',
  );
  const kept = m.afterMergeConfirmed({ course: 'OS', proposals: [{ targetId: 'd1' }, { targetId: 'd2' }] }, 'd1');
  assert.deepEqual(kept.proposals.map((p) => p.targetId), ['d2']);

  const html = renderToStaticMarkup(withServices(h(m.MergeSuggestions, {
    merge: {
      suggestions: { course: '', proposals: [] },
      error: '合并失败',
      busy: false,
      clearError: noop,
      close: noop,
      confirm: noop,
    },
  })));
  assert.match(html, /未分类课程 · 合并建议/, 'falls back to 未分类课程 when course is empty');
  assert.match(html, /合并失败/, 'renders error message');
  assert.match(html, /sh-msg__close|关闭/, 'renders dismiss button on error banner');

  // Interactive StudyMap merge flow: confirms deck.merge shows success toast and resets on course/root switch
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as StudyMap } from './ui/StudyMap.jsx';
    export { default as MergeSuggestions } from './ui/study-map/MergeSuggestions.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { ToastContext } from './ui/components/index.js';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;

  const toasts = [];
  const toastApi = {
    show: (m) => toasts.push(String(m?.message || m || '')),
    success: (msg) => toasts.push(String(msg || '')),
    info: noop,
    warning: noop,
    error: noop,
    dismiss: noop,
  };
  const call = async (action) => {
    if (action === 'deck.merge.suggest') {
      return { course: 'OS', proposals: [{ targetId: 'd1', targetTitle: 'OS Ch1', sourceIds: ['d2'], sourceTitles: ['OS Ch1 dup'], reason: '同主题' }] };
    }
    return {};
  };
  const act = async (action, _args, onOk) => {
    if (action === 'deck.merge') {
      onOk?.({ moved: 5 });
      return { moved: 5 };
    }
    return true;
  };
  const services = { call, act, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
  let mapData = {
    root: '/lib-a',
    focus: { course: 'OS', courses: ['OS', 'DB'] },
    courses: [{ name: 'OS' }, { name: 'DB' }],
    decks: [
      { id: 'd1', title: 'OS Ch1', course: 'OS', count: 5, available: 5 },
      { id: 'd2', title: 'OS Ch1 dup', course: 'OS', count: 5, available: 5 },
    ],
    sources: [],
    attempts: [],
  };

  await withBrowserGlobals(async () => {
    const view = ui.mount(() => hI(ui.exports.ToastContext.Provider, { value: toastApi },
      hI(ui.exports.StudyServicesContext.Provider, { value: services },
        hI(ui.exports.AppContext.Provider, { value: { language: 'zh', data: mapData, host: {}, canChat: false, core: { call, act, busy: false, notify: noop } } },
          hI(ui.exports.StudyMap, { data: mapData, onPracticeDeck: noop, onOpenCourse: noop, onNewDeck: noop })))));
    try {
      const mergeNode0 = view.find((n) => n.type === ui.exports.MergeSuggestions);
      assert.ok(mergeNode0, 'StudyMap mounts MergeSuggestions');

      // Open merge suggestions and confirm a merge -> success toast fires
      await view.act(() => mergeNode0.props.merge.run());
      await view.flush(4);
      assert.equal(view.find((n) => n.type === ui.exports.MergeSuggestions).props.merge.suggestions?.proposals?.length, 1);

      await view.act(() => view.find((n) => n.type === ui.exports.MergeSuggestions).props.merge.confirm(
        { targetId: 'd1', sourceIds: ['d2'] },
      ));
      await view.flush(4);
      assert.ok(toasts.some((msg) => msg.includes('已合并 5 道题，全部保留')), 'shows success toast after deck.merge');

      // Re-open suggestions then switch course / root -> suggestions reset to null
      await view.act(() => view.find((n) => n.type === ui.exports.MergeSuggestions).props.merge.run());
      await view.flush(4);
      assert.ok(view.find((n) => n.type === ui.exports.MergeSuggestions).props.merge.suggestions, 'suggestions opened');

      mapData = { ...mapData, focus: { course: 'DB', courses: ['OS', 'DB'] } };
      view.rerender();
      assert.equal(view.find((n) => n.type === ui.exports.MergeSuggestions).props.merge.suggestions, null, 'resets suggestions when course changes');

      await view.act(() => view.find((n) => n.type === ui.exports.MergeSuggestions).props.merge.run());
      await view.flush(4);
      mapData = { ...mapData, root: '/lib-b' };
      view.rerender();
      assert.equal(view.find((n) => n.type === ui.exports.MergeSuggestions).props.merge.suggestions, null, 'resets suggestions when library root changes');
    } finally {
      view.unmount();
    }
  });
});

/* ---------- W1-05: TodayTimer guards denied/unsupported Notification and reports numeric validation errors ---------- */

test('W1-05: TodayTimer detects notification permission state and reports integer range errors', async () => {
  m.setUiLanguage('zh');
  assert.equal(m.timerMinutesError('25', 180), '');
  assert.equal(m.timerMinutesError('', 240), '');
  assert.match(m.timerMinutesError('300', 240), /1–240/);
  assert.match(m.timerMinutesError('12.5', 240), /1–240/);
  assert.match(m.timerMinutesError('0', 60), /1–60/);

  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as TodayTimer } from './ui/board/TodayTimer.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;

  const prevNotification = globalThis.Notification;
  try {
    delete globalThis.Notification;
    assert.equal(m.notificationPermissionState(), 'unsupported');
    globalThis.Notification = Object.assign(function Notification() {}, { permission: 'denied' });
    assert.equal(m.notificationPermissionState(), 'denied');

    const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
    await withBrowserGlobals(async () => {
      const view = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, { value: services },
        hI(ui.exports.TodayTimer, {
          board: { focus: { workMinutes: 25, breakMinutes: 5, sound: true, notify: false }, entries: [] },
          cards: [],
          readOnly: false,
        })));
      try {
        const prefsBtn = view.find((n) => n.type === 'button' && ui.textOf(n).includes('改时长'));
        assert.ok(prefsBtn, '改时长 button rendered');
        await view.act(() => click(prefsBtn));

        const numInputs = view.findAll((n) => n.type === 'input' && n.props?.inputMode === 'numeric');
        assert.ok(numInputs.length >= 2, 'duration fields set inputMode="numeric"');

        const notifySwitch = view.find((n) => n.type === 'input' && n.props?.type === 'checkbox' && n.props?.disabled === true);
        assert.ok(notifySwitch, 'disables enabling system notifications when Notification permission is denied');
      } finally {
        view.unmount();
      }
    });
  } finally {
    if (prevNotification === undefined) delete globalThis.Notification;
    else globalThis.Notification = prevNotification;
  }
});
