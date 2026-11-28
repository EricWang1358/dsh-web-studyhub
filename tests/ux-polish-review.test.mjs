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
  export { default as DocumentViewer } from './ui/document-preview/DocumentViewer.jsx';
  export { WrongBookView } from './ui/WrongBook.jsx';
  export { default as CompanionViewer } from './ui/companions/CompanionViewer.jsx';
  export { default as GuidedStudyWorkbench } from './ui/guided-study/GuidedStudyWorkbench.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AppContext } from './ui/app/app-context.js';
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

  // Mount real useReviewSession and dispatch a real KeyT keydown: it opens 帮我弄懂 pre-selected on 通俗详解 and fires 0 paid model calls
  const interactive = await loadInteractiveUi(`
    export { useReviewSession } from './ui/review/useReviewSession.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  interactive.exports.setUiLanguage('zh');
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
  const root = {
    contains: () => true,
    querySelector: (sel) => {
      if (sel === '.assist-form') return formMounted ? formEl : null;
      if (sel === '[data-tour="review-help"]') return helpBtn;
      return null;
    },
  };
  const calls = [];
  const keyListeners = [];
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  globalThis.cancelAnimationFrame = noop;
  try {
    await withBrowserGlobals(async () => {
      const dataRef = { current: { root: '/lib-t-key', settings: {}, focus: { course: null }, sources: [], runs: [], progress: {} } };
      const core = {
        call: async (action, args) => { calls.push(['call', action, args]); return {}; },
        act: async (action, args) => { calls.push(['act', action, args]); return {}; },
        notify: noop,
        setError: noop,
        refresh: async () => dataRef.current,
        refs: { dataRef, bindingRoot: { current: null } },
      };
      const hook = interactive.mountHook(() => interactive.exports.useReviewSession({
        core,
        nav: { page: 'review', setPage: noop, show: { exam: noop } },
        modalOpen: false,
        host: {},
        rootRef: { current: root },
        late: {},
      }));
      try {
        await hook.act(() => hook.current.enterRun({
          id: 'r1', mode: 'path', deckId: 'd1', index: 0, total: 1,
          card: { id: 'c1', kind: 'quiz', prompt: 'Q1', options: [{ id: 'a', text: 'A' }] },
        }));
        assert.ok(keyListeners.length > 0, 'useReviewSession registers a window keydown handler');
        const pressT = () => {
          const evt = {
            key: 't', code: 'KeyT', shiftKey: false, repeat: false, defaultPrevented: false,
            ctrlKey: false, metaKey: false, altKey: false, target: root,
            preventDefault() { this.defaultPrevented = true; },
          };
          for (const fn of [...keyListeners]) fn(evt);
          return evt;
        };
        // Fallback path (no registered assist-open handler): useReviewSession itself clicks 帮我弄懂, picks 通俗详解 and focuses the input
        let evt;
        await hook.act(() => { evt = pressT(); });
        assert.equal(evt.defaultPrevented, true, 'KeyT prevents the browser default');
        assert.equal(helpClicked, 1, 'KeyT opens 帮我弄懂 panel through useReviewSession');
        assert.equal(chipClicked, 1, 'KeyT pre-selects 通俗详解 chip');
        assert.equal(inputFocused, 1, 'KeyT focuses assist input for explicit submission');
        assert.deepEqual(calls, [], 'pressing T must never auto-fire assistCard / paid model RPCs');

        // Question view registered its own assist-open handler: KeyT is delegated to it with the plain choice, and still fires no RPC
        const openedChoices = [];
        hook.current.questionKeys.current['assist-open'] = (choice) => { openedChoices.push(choice); };
        await hook.act(() => { pressT(); });
        assert.deepEqual(openedChoices, ['plain'], 'KeyT delegates to the registered assist-open handler with the plain choice');
        assert.equal(helpClicked, 1, 'the fallback panel opener is not run a second time when a handler is registered');
        assert.deepEqual(calls, [], 'the delegated path never auto-fires a paid model RPC either');
      } finally {
        hook.unmount();
      }
    }, {
      window: {
        addEventListener: (type, fn) => { if (type === 'keydown') keyListeners.push(fn); },
        removeEventListener: (type, fn) => {
          const idx = keyListeners.indexOf(fn);
          if (type === 'keydown' && idx >= 0) keyListeners.splice(idx, 1);
        },
      },
    });
  } finally {
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancel;
  }
});

test('3. SourceColumn shows Alt+` focus hint and DocumentViewer hides heavy authoring controls when docked', async () => {
  ssr.setUiLanguage('zh');
  const source = { id: 's1', title: 'Ch1', text: 'Sample text', format: 'md' };
  const columnSource = { id: 's1', title: 'Ch1', text: '', format: 'txt' };

  // Mount real SourceColumn (resolving deferredView DocumentViewer) to verify Alt+` focus hint and docked reader toolbar
  const interactive = await loadInteractiveUi(`
    export { default as SourceColumn } from './ui/review/SourceColumn.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  interactive.exports.setUiLanguage('zh');
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCompStyle = globalThis.getComputedStyle;
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  globalThis.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0', columnGap: '0' });
  try {
    await withBrowserGlobals(async () => {
      const studyValue = { busy: false, call: async (action) => (action === 'runtime.capabilities' ? [] : {}), act: async () => undefined, host: {}, notify: noop, askInChat: noop, openSettings: noop, navigate: noop, openModal: noop };
      const appValue = {
        language: 'zh',
        host: {},
        data: { root: '/lib', decks: [], sources: [columnSource] },
        core: { call: studyValue.call, act: studyValue.act, busy: false, notify: noop, setError: noop, refresh: async () => ({}) },
        settingsEntry: { setCourseSettings: noop, openSettings: noop, openModelSettings: noop },
        nav: { navigate: noop },
        learn: { openLearningTarget: noop },
        intents: { practiceFromReading: noop },
        drafts: { openDraft: noop },
        set: { setModal: noop },
        selectionNotices: {},
        session: {},
      };
      const mountColumn = () => interactive.mount(() => interactive.React.createElement(
        interactive.exports.StudyServicesContext.Provider,
        { value: studyValue },
        interactive.React.createElement(
          interactive.exports.AppContext.Provider,
          { value: appValue },
          interactive.React.createElement(interactive.exports.SourceColumn, {
            request: { modal: { kind: 'source', source: columnSource }, nonce: 1 },
            followKey: 'k1',
            place: null,
            pageRef: { current: null },
            shownRef: { current: null },
            onWidth: noop,
            onClose: noop,
          }),
        ),
      ));
      const mounted = mountColumn();
      try {
        await mounted.flush(6);
        const keyHint = mounted.find((node) => node.type === 'kbd' && node.props?.className === 'source-column__key');
        assert.ok(keyHint, 'SourceColumn renders .source-column__key focus hint');
        assert.equal(mounted.text(keyHint).trim(), 'Alt+`');
        assert.match(keyHint.props['aria-label'], /Alt\+`/, 'the hint carries an accessible name that names the shortcut');
        const dockedViewer = mounted.find((node) => node.props?.['data-docked'] === true);
        assert.ok(dockedViewer, 'SourceColumn mounts DocumentViewer with data-docked={true}');
        const toolbar = mounted.find((node) => node.props?.className === 'reader-toolbar', dockedViewer);
        assert.ok(toolbar, 'docked reader toolbar is rendered inside SourceColumn');
        const toolbarText = mounted.text(toolbar);
        assert.doesNotMatch(toolbarText, /AI 出题/);
        assert.doesNotMatch(toolbarText, /打开交互伴学页/);
        const primaryInToolbar = mounted.find((node) => String(node.props?.className || '').includes('sh-btn--primary'), toolbar);
        assert.equal(primaryInToolbar, null, 'no competing primary button inside SourceColumn');
      } finally {
        mounted.unmount();
      }

      // English: same hint, an English accessible name, and no untranslated Han text anywhere in the docked column
      interactive.exports.setUiLanguage('en');
      const mountedEn = mountColumn();
      try {
        await mountedEn.flush(6);
        const keyHintEn = mountedEn.find((node) => node.type === 'kbd' && node.props?.className === 'source-column__key');
        assert.ok(keyHintEn, 'English SourceColumn renders the focus hint');
        assert.equal(mountedEn.text(keyHintEn).trim(), 'Alt+`');
        assert.match(keyHintEn.props['aria-label'], /Alt\+`/);
        assert.doesNotMatch(keyHintEn.props['aria-label'], han, 'English focus hint has an English accessible name');
        const dockedEn = mountedEn.find((node) => node.props?.['data-docked'] === true);
        assert.ok(dockedEn, 'English SourceColumn still mounts the docked DocumentViewer');
        const toolbarEn = mountedEn.find((node) => node.props?.className === 'reader-toolbar', dockedEn);
        assert.ok(toolbarEn, 'English docked reader toolbar is rendered');
        assert.doesNotMatch(mountedEn.text(), han, 'English SourceColumn (docked reader included) has zero Han characters');
      } finally {
        mountedEn.unmount();
        interactive.exports.setUiLanguage('zh');
      }
    });
  } finally {
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.getComputedStyle = prevCompStyle;
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
