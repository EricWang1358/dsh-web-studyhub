import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const ssr = await loadUi(`
  export { default as TermChips } from './ui/review/TermChips.jsx';
  export { shortcutAction } from './ui/review/session-logic.js';
  export { openAssistPanel } from './ui/review/useReviewSession.js';
  export { default as SourceColumn } from './ui/review/SourceColumn.jsx';
  export { default as DocumentViewer } from './ui/document-preview/DocumentViewer.jsx';
  export { WrongBookView } from './ui/WrongBook.jsx';
  export { default as CompanionViewer } from './ui/companions/CompanionViewer.jsx';
  export { default as GuidedStudyWorkbench } from './ui/guided-study/GuidedStudyWorkbench.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { ToastContext } from './ui/components/index.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const noop = () => {};
const han = /\p{Script=Han}/u;
const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('1. TermChips renders calm 1-line mode bar when markingTerms is active with 0 terms, exits cleanly, and localizes to English', async () => {
  ssr.setUiLanguage('zh');
  assert.equal(renderToStaticMarkup(h(ssr.TermChips, { terms: [] })), '', 'still null when not marking and 0 terms');

  const modeHtml = renderToStaticMarkup(h(ssr.TermChips, { terms: [], markingTerms: true, onExit: noop }));
  assert.match(modeHtml, /data-term-marking-bar=""/);
  assert.match(modeHtml, /term-strip--mode/);
  assert.match(textOf(modeHtml), /标生词模式：点击题目里的词来标记，按 Esc 或点「退出」恢复作答/);
  assert.match(modeHtml, />退出<\/button>/);

  // Also works via AppContext session.markingTerms without requiring QuestionRun prop changes
  const viaContext = renderToStaticMarkup(
    h(ssr.AppContext.Provider, { value: { session: { markingTerms: true, actions: { exitMarkTerms: noop } } } },
      h(ssr.TermChips, { terms: [] })),
  );
  assert.match(viaContext, /data-term-marking-bar=""/);
  assert.match(viaContext, />退出<\/button>/);

  ssr.setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(h(ssr.TermChips, { terms: [], markingTerms: true, onExit: noop }));
    assert.doesNotMatch(textOf(enHtml), han);
    assert.match(textOf(enHtml), /Mark-words mode/);
    assert.match(enHtml, />Exit<\/button>/);
  } finally {
    ssr.setUiLanguage('zh');
  }

  // Interactive click on 退出 triggers session.actions.exitMarkTerms
  const interactive = await loadInteractiveUi(`
    export { default as TermChips } from './ui/review/TermChips.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  interactive.exports.setUiLanguage('zh');
  let exited = 0;
  const mounted = interactive.mount(() => interactive.React.createElement(
    interactive.exports.AppContext.Provider,
    { value: { session: { markingTerms: true, actions: { exitMarkTerms: () => { exited += 1; } } } } },
    interactive.React.createElement(interactive.exports.TermChips, { terms: [] }),
  ));
  try {
    const exitBtn = mounted.find((node) => node.type === 'button' && mounted.text(node).includes('退出'));
    assert.ok(exitBtn, 'exit button rendered');
    await mounted.act(() => exitBtn.props.onClick({}));
    assert.equal(exited, 1, 'clicking 退出 calls exitMarkTerms');
  } finally {
    mounted.unmount();
  }
});

test('2. Single-key T opens 帮我弄懂 pre-selected on 通俗详解 without auto-firing a paid model call', async () => {
  const ctx = {
    inside: true,
    modalOpen: false,
    page: 'review',
    run: { id: 'r1', mode: 'path', card: { id: 'c1', kind: 'quiz' }, revealed: false, feedback: null, complete: false },
    busy: false,
    shortcutHelp: false,
    endAsked: false,
    markingTerms: false,
    choice: true,
    isCloze: false,
    rubricCard: false,
    selected: [],
    clozeValues: {},
  };
  const keyT = { key: 't', code: 'KeyT', shiftKey: false, repeat: false, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, inEditable: false, onButton: false };
  const outcome = ssr.shortcutAction(keyT, ctx);
  assert.deepEqual(outcome?.action, { type: 'assist-open', choice: 'plain' });
  assert.equal(ssr.shortcutAction(keyT, { ...ctx, run: { ...ctx.run, mode: 'exam' } })?.action, null);

  // Mount real useReviewSession and dispatch KeyT: opens 帮我弄懂, selects 通俗详解, focuses input, and fires zero paid RPCs
  const interactive = await loadInteractiveUi(`
    export { useReviewSession } from './ui/review/useReviewSession.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  interactive.exports.setUiLanguage('zh');
  const rpcCalls = [];
  const windowListeners = new Map();
  let helpClicked = 0;
  let chipClicked = 0;
  let inputFocused = 0;
  let formMounted = false;
  const plainChip = {
    textContent: '通俗详解',
    getAttribute: (name) => (name === 'aria-pressed' ? (chipClicked ? 'true' : 'false') : null),
    click: () => { chipClicked += 1; },
  };
  const inputEl = { focus: () => { inputFocused += 1; } };
  const formEl = {
    querySelectorAll: (sel) => (sel === '.assist-quick-choices button' ? [plainChip] : []),
    querySelector: (sel) => (sel === '.assist-form__input' ? inputEl : null),
  };
  const helpBtn = {
    getAttribute: (name) => (name === 'aria-expanded' ? (formMounted ? 'true' : 'false') : null),
    click: () => { helpClicked += 1; formMounted = true; },
  };
  const targetNode = { closest: () => null };
  const root = {
    contains: () => true,
    querySelector: (sel) => {
      if (sel === '.assist-form') return formMounted ? formEl : null;
      if (sel === '[data-tour="review-help"]') return helpBtn;
      return null;
    },
  };
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  try {
    await withBrowserGlobals(async () => {
      const core = {
        busy: false,
        call: async (action, args) => { rpcCalls.push({ action, args }); return {}; },
        act: async (action, args) => { rpcCalls.push({ action, args }); return {}; },
        notify: noop,
        setError: noop,
        refresh: async () => {},
        refs: { dataRef: { current: { root: 'r', settings: {} } }, bindingRoot: { current: 'r' } },
      };
      const nav = { page: 'review', setPage: noop, show: { exam: noop } };
      const rootRef = { current: root };
      const late = { current: {} };
      const sessionHook = interactive.mountHook(() => interactive.exports.useReviewSession({
        core, nav, modalOpen: false, host: {}, rootRef, late,
      }), {});
      try {
        await sessionHook.act(() => {
          sessionHook.current.enterRun({
            id: 'r1',
            deckId: 'd1',
            index: 0,
            mode: 'path',
            card: { id: 'c1', kind: 'quiz', prompt: 'Q?' },
            revealed: false,
            feedback: null,
            complete: false,
          });
        });
        const keydownHandlers = [...(windowListeners.get('keydown') || [])];
        assert.ok(keydownHandlers.length > 0, 'useReviewSession registers window keydown listener');

        // Fallback path (no questionKeys['assist-open']): dispatches openAssistPanel without calling assistCard / assist.start
        let prevented = false;
        await sessionHook.act(() => {
          for (const listener of keydownHandlers) {
            listener({
              key: 't',
              code: 'KeyT',
              shiftKey: false,
              repeat: false,
              defaultPrevented: false,
              ctrlKey: false,
              metaKey: false,
              altKey: false,
              target: targetNode,
              preventDefault: () => { prevented = true; },
            });
          }
        });
        assert.equal(prevented, true, 'KeyT prevents default');
        assert.equal(helpClicked, 1, 'opens 帮我弄懂 panel');
        assert.equal(chipClicked, 1, 'pre-selects 通俗详解 chip');
        assert.equal(inputFocused, 1, 'focuses assist input for explicit submission');
        assert.deepEqual(rpcCalls.filter((c) => c.action === 'assist.start'), [], 'KeyT never auto-fires assist.start paid model call');

        // Direct QuestionRun handler path: invokes questionKeys['assist-open']('plain') without firing assist.start
        const openedChoices = [];
        sessionHook.current.questionKeys.current['assist-open'] = (choice) => { openedChoices.push(choice); };
        await sessionHook.act(() => {
          for (const listener of keydownHandlers) {
            listener({
              key: 't',
              code: 'KeyT',
              shiftKey: false,
              repeat: false,
              defaultPrevented: false,
              ctrlKey: false,
              metaKey: false,
              altKey: false,
              target: targetNode,
              preventDefault: noop,
            });
          }
        });
        assert.deepEqual(openedChoices, ['plain'], 'delegates KeyT to registered assist-open handler with plain choice');
        assert.deepEqual(rpcCalls.filter((c) => c.action === 'assist.start'), [], 'registered assist-open path never auto-fires assist.start');
      } finally {
        sessionHook.unmount();
      }
    }, {
      window: {
        addEventListener: (type, fn) => {
          if (!windowListeners.has(type)) windowListeners.set(type, new Set());
          windowListeners.get(type).add(fn);
        },
        removeEventListener: (type, fn) => {
          windowListeners.get(type)?.delete(fn);
        },
      },
      document: { activeElement: targetNode },
    });
  } finally {
    globalThis.requestAnimationFrame = prevRaf;
  }
});

test('3. SourceColumn shows Alt+` focus hint and DocumentViewer hides heavy authoring controls when docked', async () => {
  ssr.setUiLanguage('zh');
  const source = { id: 's1', title: 'Ch1', text: 'Sample text', format: 'md' };
  const sourceCall = async (action) => (action === 'runtime.capabilities' ? [] : {});
  const appValue = {
    data: { root: 'r', decks: [], drafts: [], courses: [], sources: [source] },
    host: {},
    core: { call: sourceCall, act: async () => undefined, refresh: async () => {}, busy: false },
    nav: { navigate: noop },
    learn: { openLearningTarget: noop },
    intents: { goGenerate: noop, practiceFromReading: noop },
    drafts: { openDraft: noop },
    dailyPlan: null,
    selectionNotices: { track: noop },
    settingsEntry: { openSettings: noop, openModelSettings: noop },
    set: { setModal: noop },
    session: { run: null },
  };
  const studyValue = { busy: false, call: sourceCall, act: async () => undefined, host: {}, notify: noop };
  const toastValue = { success: noop, error: noop, info: noop, warning: noop, show: noop, dismiss: noop };

  // Mount SourceColumn interactively so ColumnReader renders the real DocumentViewer with docked prop
  const sourceColumnPlugins = [{
    name: 'source-column-direct-viewer',
    setup(builder) {
      builder.onResolve({ filter: /^dompurify$/ }, () => ({ path: 'dompurify', namespace: 'test-dp' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-dp' }, () => ({
        contents: 'export default { sanitize: (html) => String(html || "") };',
        loader: 'js',
      }));
      builder.onResolve({ filter: /workspace-views\.jsx$/ }, () => ({ path: 'workspace-views', namespace: 'test-wv' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-wv' }, () => ({
        contents: 'export { default as DocumentViewer } from "./ui/document-preview/DocumentViewer.jsx";',
        resolveDir: process.cwd(),
        loader: 'js',
      }));
    },
  }];
  const interactive = await loadInteractiveUi(`
    export { default as SourceColumn } from './ui/review/SourceColumn.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { ToastContext } from './ui/components/index.js';
    export { setUiLanguage } from './ui/i18n.js';
  `, { plugins: sourceColumnPlugins });
  interactive.exports.setUiLanguage('zh');
  const hi = interactive.React.createElement;
  await withBrowserGlobals(async () => {
    const mounted = interactive.mount(() => hi(
      interactive.exports.ToastContext.Provider,
      { value: toastValue },
      hi(
        interactive.exports.StudyServicesContext.Provider,
        { value: studyValue },
        hi(
          interactive.exports.AppContext.Provider,
          { value: appValue },
          hi(interactive.exports.SourceColumn, {
            request: { modal: { type: 'source', source, back: true }, nonce: 1 },
            followKey: 'k1',
            place: null,
            pageRef: { current: null },
            shownRef: { current: null },
            onWidth: noop,
            onClose: noop,
          }),
        ),
      ),
    ));
    try {
      await mounted.flush(6);
      const keyHint = mounted.find((node) => node.type === 'kbd' && String(node.props?.className || '').includes('source-column__key'));
      assert.ok(keyHint, 'SourceColumn renders <kbd class="source-column__key">');
      assert.equal(mounted.text(keyHint), 'Alt+`', 'SourceColumn renders Alt+` focus shortcut hint');
      assert.equal(keyHint.props['aria-label'], '快捷键 Alt+`：在题目与对照资料间切换焦点', 'Alt+` hint carries accessible aria-label');

      const dockedViewer = mounted.find((node) => node.props?.['data-docked'] === true);
      assert.ok(dockedViewer, 'SourceColumn passes docked to its ColumnReader (DocumentViewer)');
      const toolbar = mounted.find((node) => String(node.props?.className || '').split(/\s+/).includes('reader-toolbar'), dockedViewer);
      assert.ok(toolbar, 'docked reader toolbar is rendered inside SourceColumn');
      assert.doesNotMatch(mounted.text(toolbar), /AI 出题/, 'SourceColumn docked reader hides AI 出题');
      assert.doesNotMatch(mounted.text(toolbar), /打开交互伴学页/, 'SourceColumn docked reader hides 打开交互伴学页');
      assert.equal(
        mounted.find((node) => String(node.props?.className || '').includes('sh-btn--primary'), toolbar),
        null,
        'SourceColumn docked reader renders no competing primary CTA',
      );
    } finally {
      mounted.unmount();
    }
  });

  ssr.setUiLanguage('en');
  try {
    const enSourceColHtml = renderToStaticMarkup(
      h(ssr.ToastContext.Provider, { value: toastValue },
        h(ssr.StudyServicesContext.Provider, { value: studyValue },
          h(ssr.AppContext.Provider, { value: appValue },
            h(ssr.SourceColumn, {
              request: { modal: { type: 'source', source, back: true }, nonce: 1 },
              followKey: 'k1',
              place: null,
              pageRef: { current: null },
              shownRef: { current: null },
              onWidth: noop,
              onClose: noop,
            })))),
    );
    assert.match(enSourceColHtml, /<kbd[^>]*class="source-column__key"[^>]*>Alt\+`<\/kbd>/);
    assert.doesNotMatch(textOf(enSourceColHtml), han, 'English SourceColumn has zero Han characters');
  } finally {
    ssr.setUiLanguage('zh');
  }

  const commonProps = {
    source,
    call: async () => ({}),
    data: { decks: [], sources: [source] },
    onGenerate: noop,
    onPracticePages: noop,
    onOpenCompanion: noop,
  };

  // Full-window mode keeps AI 出题 & 打开交互伴学页 on the toolbar
  const fullHtml = renderToStaticMarkup(h(ssr.DocumentViewer, { ...commonProps, docked: false }));
  const fullToolbar = fullHtml.match(/<div class="reader-toolbar">([\s\S]*?)<div class="reader-progress"/)?.[1] || '';
  assert.match(fullToolbar, /AI 出题/);
  assert.match(fullToolbar, /打开交互伴学页/);

  // Docked split-pane mode removes AI 出题 & 打开交互伴学页 from the toolbar so there is no stacked toolbar or competing primary CTA
  const dockedHtml = renderToStaticMarkup(h(ssr.DocumentViewer, { ...commonProps, docked: true }));
  assert.match(dockedHtml, /data-docked="true"/);
  const dockedToolbar = dockedHtml.match(/<div class="reader-toolbar">([\s\S]*?)<div class="reader-progress"/)?.[1] || '';
  assert.doesNotMatch(dockedToolbar, /AI 出题/);
  assert.doesNotMatch(dockedToolbar, /打开交互伴学页/);
  assert.doesNotMatch(dockedToolbar, /sh-btn--primary/, 'no competing primary button inside the docked split pane');
});

test('4. WrongBook folds secondary diagnostics into one collapsed <details> while keeping prepared variants Banner and tour anchors intact', () => {
  const decks = [{ id: 'd1', course: 'OS', title: 'OS｜Quiz 1' }, { id: 'd2', course: 'OS', title: 'OS｜Quiz 2' }];
  const items = Array.from({ length: 10 }, (_, idx) => ({
    deckId: idx < 5 ? 'd1' : 'd2',
    deckTitle: idx < 5 ? 'OS｜Quiz 1' : 'OS｜Quiz 2',
    cardId: `c${idx}`,
    topic: `Topic ${idx % 2}`,
    kind: 'quiz',
    assessment: 'graded',
    prompt: `Question ${idx}?`,
    lastGrade: 1,
    wrongCount: 1,
    lastAt: '2026-10-03T01:00:00Z',
    leech: idx === 0,
  }));
  const props = {
    data: {
      root: 'r',
      decks,
      sources: [],
      focus: { course: 'OS', courses: [{ name: 'OS' }] },
      model: { ready: true },
      settings: { practice: { wrongbookClinic: true } },
    },
    course: 'OS',
    onCourse: noop,
    items,
    counts: { total: items.length, graded: items.length, self: 0, oral: 0, rubric: 0 },
    view: 'weak',
    onView: noop,
    viewCounts: { weak: items.length, history: 0 },
    loading: false,
    err: '',
    page: 0,
    pageSize: 100,
    hasMore: false,
    onReload: noop,
    onPage: noop,
    recs: { items: [{ deckId: 'd2', deckTitle: 'OS｜Quiz 2', cardId: 'rec-1', topic: 'Topic 0', kind: 'quiz', prompt: 'Similar Q?', score: 5, forCardIds: ['c0'], reasons: [{ type: 'topic', topic: 'Topic 0' }] }] },
    coach: { enabled: true, consent: true, ready: 3, preparing: false, preparingCards: [], readyCards: [], failedCards: [], tasks: [] },
    details: {},
    onLoadDetail: noop,
    onPractice: noop,
    onPracticePrepared: noop,
    onGenerate: async () => ({}),
    onOpenSettings: noop,
    busy: false,
    filterMin: 10,
  };

  ssr.setUiLanguage('zh');
  const html = renderToStaticMarkup(h(ssr.StudyServicesContext.Provider, { value: { busy: false, openModal: noop } }, h(ssr.WrongBookView, props)));
  assert.match(html, /<details class="wb-diagnostics-fold">/, 'diagnostics fold exists and is collapsed by default (no open attr)');
  assert.match(html, /错题诊断与推荐/);
  const foldStart = html.indexOf('<details class="wb-diagnostics-fold">');
  const bannerAt = html.indexOf('已为你备好 3 道变式题');
  assert.ok(bannerAt >= 0 && bannerAt < foldStart, 'prepared variants banner stays visible above the diagnostics fold');
  assert.match(html, /data-tour="wrongbook-clinic"/);
  assert.match(html, /data-tour="wrongbook-recs"/);
  assert.match(html, /data-tour="wrongbook-dist"/);
  assert.match(html, /data-tour="wrongbook-list"/);

  ssr.setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(h(ssr.StudyServicesContext.Provider, { value: { busy: false, openModal: noop } }, h(ssr.WrongBookView, props)));
    assert.doesNotMatch(textOf(enHtml), han, 'English WrongBook diagnostics fold has zero Han characters');
    assert.match(textOf(enHtml), /Diagnostics &amp; recommendations|Diagnostics & recommendations/);
  } finally {
    ssr.setUiLanguage('zh');
  }
});

test('5. CompanionViewer removes sandbox jargon, folds export/dev actions into 更多 menu, and runs 闪回练一下这道题 inline when available', async () => {
  const readyState = {
    status: 'ready',
    companion: { id: 'comp-1', lessonId: 'l1', title: 'Deadlock', course: 'OS', slideCount: 3, linkedRoot: '/lab' },
    html: '<!doctype html><html><body>Slide</body></html>',
    file: '/lab/deadlock.html',
    changedOnDisk: false,
    lesson: {
      id: 'l1',
      title: 'Deadlock',
      slideCount: 3,
      slides: [{ title: 'Intro', beat: 'open' }, { title: 'Core', beat: 'core' }, { title: 'End', beat: 'take' }],
      terms: { Mutex: 'Mutual exclusion lock' },
    },
    bootConfig: { channelToken: 'tok-1', theme: 'light', initialAnchor: '#1', initialSlide: 1, memory: {} },
    relatedCards: [
      { deckId: 'd1', cardId: 'c-pre', deckTitle: 'OS', topic: 'Intro', prompt: 'What is deadlock?', kind: 'open', slide: 1 },
    ],
  };

  ssr.setUiLanguage('zh');
  const html = renderToStaticMarkup(
    h(ssr.StudyServicesContext.Provider, { value: { busy: false, call: () => new Promise(() => {}), host: { openFile: noop }, notify: noop } },
      h(ssr.AppContext.Provider, { value: { data: { settings: {} }, core: { refresh: noop } } },
        h(ssr.CompanionViewer, {
          modal: { id: 'comp-1', course: 'OS', openDrawer: true, initialState: readyState },
          onClose: noop,
          inlinePractice: { Run: () => h('div', null, 'Inline'), load: noop },
        }))),
  );
  assert.doesNotMatch(html, /隔离沙箱|伴学舞台/, 'no developer sandbox/stage jargon');
  assert.match(textOf(html), /交互伴学页 · 划选文字或打开解惑栏/);
  const footHtml = html.match(/class="sh-comp-foot"[\s\S]*?<\/footer>/)?.[0] || html;
  assert.match(footHtml, /aria-label="更多"/, 'low-frequency actions fold into 更多 menu');
  assert.doesNotMatch(footHtml, /aria-label="导出 HTML"/, 'export HTML is no longer a standalone footer icon button');
  assert.doesNotMatch(footHtml, />复制文件路径<\/button>/, 'copy path is no longer a standalone footer button');
  assert.doesNotMatch(footHtml, />在外部浏览器打开<\/button>/, 'open external is no longer a standalone footer button');

  ssr.setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(
      h(ssr.StudyServicesContext.Provider, { value: { busy: false, call: () => new Promise(() => {}), host: { openFile: noop }, notify: noop } },
        h(ssr.AppContext.Provider, { value: { data: { settings: {} }, core: { refresh: noop } } },
          h(ssr.CompanionViewer, {
            modal: { id: 'comp-1', course: 'OS', openDrawer: true, initialState: readyState },
            onClose: noop,
            inlinePractice: { Run: () => h('div', null, 'Inline'), load: noop },
          }))),
    );
    assert.doesNotMatch(textOf(enHtml), han, 'English CompanionViewer has zero Han characters');
  } finally {
    ssr.setUiLanguage('zh');
  }

  // Interactive: clicking 闪回练一下这道题 runs inline without closing the viewer
  const interactive = await loadInteractiveUi(`
    export { default as CompanionViewer } from './ui/companions/CompanionViewer.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  interactive.exports.setUiLanguage('zh');
  let closed = 0;
  const reviewStartCalls = [];
  const inlineLoads = [];
  const stableCall = async (action, args) => {
    if (action === 'companion.get') return readyState;
    if (action === 'review.start') reviewStartCalls.push(args);
    return { items: [], total: 0, open: 0 };
  };
  const studyValue = { busy: false, call: stableCall, host: {}, notify: noop };
  const appValue = { data: { settings: {} }, core: { refresh: noop } };
  const modalValue = { id: 'comp-1', course: 'OS', openDrawer: true, initialState: readyState };
  const inlineValue = {
    Run: (props) => interactive.React.createElement('div', { 'data-inline-practice-run': props.started?.id }),
    load: (scope, then) => { inlineLoads.push(scope); then({ id: 'run-inline-prereq' }); },
  };
  const handleClose = () => { closed += 1; };
  await withBrowserGlobals(async () => {
    const mounted = interactive.mount(() => interactive.React.createElement(
      interactive.exports.StudyServicesContext.Provider,
      { value: studyValue },
      interactive.React.createElement(
        interactive.exports.AppContext.Provider,
        { value: appValue },
        interactive.React.createElement(interactive.exports.CompanionViewer, {
          modal: modalValue,
          onClose: handleClose,
          inlinePractice: inlineValue,
        }),
      ),
    ));
    try {
      await mounted.flush(4);
      const flashBtn = mounted.find((node) => node.type === 'button' && mounted.text(node).includes('闪回练一下这道题'));
      assert.ok(flashBtn, '闪回练一下这道题 button found in drawer');
      await mounted.act(() => flashBtn.props.onClick({}));
      assert.equal(closed, 0, 'does not close companion viewer when inline runner is available');
      assert.equal(reviewStartCalls.length, 0, 'does not start full-page review.start when inline runner is available');
      assert.deepEqual(inlineLoads, [[{ deckId: 'd1', cardId: 'c-pre' }]]);
      assert.ok(mounted.find((node) => node.props?.['data-inline-practice-run'] === 'run-inline-prereq'), 'renders InlineRunView inside drawer');
    } finally {
      mounted.unmount();
    }
  });
});

test('6. GuidedStudyWorkbench deduplicates 请教主会话 and 带着错题回主会话 into one context-aware button', () => {
  const session = { id: 's1', courseId: 'CS101', status: 'active', goal: { title: 'Master Trees' } };
  const card = { id: 'c1', deckId: 'd1', kind: 'quiz', topic: 'AVL', prompt: 'Height of AVL?', options: [{ id: 'a', text: 'O(log n)' }, { id: 'b', text: 'O(n)' }] };

  ssr.setUiLanguage('zh');
  // Unanswered: shows 请教主会话 only
  const unanswered = renderToStaticMarkup(h(ssr.GuidedStudyWorkbench, { session, run: { id: 'r1', card, revealed: false }, onAnswer: noop }));
  assert.match(textOf(unanswered), /请教主会话/);
  assert.doesNotMatch(textOf(unanswered), /带着错题回主会话/);

  // Answered right: shows 请教主会话 only
  const right = renderToStaticMarkup(h(ssr.GuidedStudyWorkbench, { session, run: { id: 'r1', card, feedback: { grade: 4, correct: true } }, onNext: noop }));
  assert.match(textOf(right), /请教主会话/);
  assert.doesNotMatch(textOf(right), /带着错题回主会话/);

  // Answered wrong: shows ONLY 带着错题回主会话 (never side-by-side with 请教主会话)
  const missed = renderToStaticMarkup(h(ssr.GuidedStudyWorkbench, { session, run: { id: 'r1', card, feedback: { grade: 1, correct: false } }, onNext: noop }));
  assert.match(textOf(missed), /带着错题回主会话/);
  assert.doesNotMatch(textOf(missed), /请教主会话/, '请教主会话 is replaced by context-aware 带着错题回主会话 after a wrong answer');

  // English localization check for both states
  ssr.setUiLanguage('en');
  try {
    const enUnanswered = renderToStaticMarkup(h(ssr.GuidedStudyWorkbench, { session, run: { id: 'r1', card, revealed: false }, onAnswer: noop }));
    assert.doesNotMatch(textOf(enUnanswered), han);
    assert.match(textOf(enUnanswered), /Ask the main chat/);

    const enMissed = renderToStaticMarkup(h(ssr.GuidedStudyWorkbench, { session, run: { id: 'r1', card, feedback: { grade: 1, correct: false } }, onNext: noop }));
    assert.doesNotMatch(textOf(enMissed), han);
    assert.match(textOf(enMissed), /Take missed questions to main chat/);
    assert.doesNotMatch(textOf(enMissed), /Ask the main chat/);
  } finally {
    ssr.setUiLanguage('zh');
  }
});
