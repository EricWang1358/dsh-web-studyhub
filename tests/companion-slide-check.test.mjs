import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  PRACTICE_DEFAULTS,
  companionSlideCheck,
  mergePracticeSettings,
  resolvePracticeSettings,
  validatePracticePatch,
} from '../lib/practice-settings.js';
import { StudyService } from '../lib/service.js';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const ssr = await loadUi(`
  export { default as PracticePane } from './ui/settings/PracticePane.jsx';
  export { default as CompanionViewer } from './ui/companions/CompanionViewer.jsx';
  export { default as CourseCompanionsBar } from './ui/companions/CourseCompanionsBar.jsx';
  export { default as InlineRun } from './ui/review/InlineRun.jsx';
  export { selectCompanionPracticeCards, companionDeckRefsMap } from './ui/companions/companion-cards.js';
  export { FINDER_ENTRIES } from './ui/finder/entries.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { setUiLanguage, ui, uiFormat } from './ui/i18n.js';
`);

const h = React.createElement;
const noop = () => {};
const han = /\p{Script=Han}/u;
const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const english = (fn) => {
  ssr.setUiLanguage('en');
  try { return fn(); } finally { ssr.setUiLanguage('zh'); }
};

test('lib/practice-settings keeps PRACTICE_DEFAULTS intact and manages optional companionSlideCheck', () => {
  const baselineKeys = ['autopilot', 'roundSize', 'newCardOrder', 'debrief', 'rereadMarks', 'leechFailures', 'leechWindow', 'leechRate'];
  assert.deepEqual(Object.keys(PRACTICE_DEFAULTS), baselineKeys);
  assert.deepEqual(Object.keys(resolvePracticeSettings(undefined)), baselineKeys);
  assert.equal(companionSlideCheck(undefined), false);
  assert.equal(companionSlideCheck({}), false);
  assert.equal(companionSlideCheck({ companionSlideCheck: true }), true);

  const enabled = mergePracticeSettings(undefined, { companionSlideCheck: true });
  assert.equal(enabled.companionSlideCheck, true);
  assert.equal(companionSlideCheck(enabled), true);

  const cleared = mergePracticeSettings(enabled, { companionSlideCheck: null });
  assert.equal('companionSlideCheck' in cleared, false);
  assert.equal(companionSlideCheck(cleared), false);

  assert.deepEqual(validatePracticePatch({ companionSlideCheck: true }), { companionSlideCheck: true });
  assert.throws(() => mergePracticeSettings(undefined, { companionSlideCheck: 'yes' }), /companionSlideCheck/);
});

test('PracticePane and Finder expose companionSlideCheck opt-in switch (off by default) with full English copy', async () => {
  ssr.setUiLanguage('zh');
  const offHtml = renderToStaticMarkup(h(ssr.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
  const input = (html, name) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';
  assert.doesNotMatch(input(offHtml, 'companionSlideCheck'), /checked/);

  const onHtml = renderToStaticMarkup(h(ssr.PracticePane, {
    data: { settings: { practice: { companionSlideCheck: true } } },
    busy: false,
    act: noop,
  }));
  assert.match(input(onHtml, 'companionSlideCheck'), /checked/);

  const finderEntry = ssr.FINDER_ENTRIES.find((entry) => entry.id === 'companion-slide-check');
  assert.ok(finderEntry);
  assert.equal(finderEntry.area, 'practice');

  const interactive = await loadInteractiveUi(`
    export { default as PracticePane } from './ui/settings/PracticePane.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  const actions = [];
  const recordAct = async (action, args) => {
    actions.push({ action, args });
    return { ok: true };
  };
  const paneProps = { data: { settings: {} }, busy: false, act: recordAct };
  const mounted = interactive.mount(() => interactive.React.createElement(
    interactive.exports.StudyServicesContext.Provider,
    { value: { openSettings: noop, host: {} } },
    interactive.React.createElement(interactive.exports.PracticePane, paneProps),
  ));
  try {
    const toggleInput = () => mounted.find((n) => n.type === 'input' && n.props?.name === 'companionSlideCheck');
    assert.equal(toggleInput()?.props?.checked, false);
    await mounted.act(() => toggleInput().props.onChange({ target: { checked: true } }));
    assert.deepEqual(actions[0], { action: 'settings.practice.set', args: { patch: { companionSlideCheck: true } } });

    paneProps.data = { settings: { practice: { companionSlideCheck: true } } };
    mounted.rerender();
    assert.equal(toggleInput()?.props?.checked, true);
    await mounted.act(() => toggleInput().props.onChange({ target: { checked: false } }));
    assert.deepEqual(actions[1], { action: 'settings.practice.set', args: { patch: { companionSlideCheck: null } } });
  } finally {
    mounted.unmount();
  }

  english(() => {
    const enHtml = renderToStaticMarkup(h(ssr.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
    assert.doesNotMatch(textOf(enHtml), han);
    assert.match(enHtml, /Turn on slide inline self-check in Interactive Companions/);
    assert.doesNotMatch(textOf(ssr.ui(finderEntry.title)), han);
    assert.doesNotMatch(textOf(ssr.ui(finderEntry.what)), han);
  });
});

test('selectCompanionPracticeCards and companionDeckRefsMap rank weak/new slide cards first and index decks safely', () => {
  const { slideCards, lessonCards } = ssr.selectCompanionPracticeCards([
    { deckId: 'd1', cardId: 'm1', linkedToCompanion: true, slide: 2, level: 'mastered' },
    { deckId: 'd1', cardId: 'n1', linkedToCompanion: true, slide: 2, level: 'new' },
    { deckId: 'd1', cardId: 'w1', linkedToCompanion: true, slide: 2, level: 'weak' },
    { deckId: 'd1', cardId: 'other-slide', companionRef: { companionId: 'c1', slide: 5 }, level: 'weak' },
    { deckId: 'd1', cardId: 'unrelated', linkedToCompanion: false, slide: 2, level: 'weak' },
  ], { companionId: 'c1', slide: 2 });

  assert.deepEqual(slideCards.map((c) => c.cardId), ['w1', 'n1', 'm1']);
  assert.deepEqual(lessonCards.map((c) => c.cardId), ['w1', 'other-slide', 'n1', 'm1']);

  const refsMap = ssr.companionDeckRefsMap([
    {
      id: 'd-main',
      course: 'OS',
      cards: [
        { id: 'c-explicit', companionRef: { companionId: 'comp-1', slide: 3 } },
        { id: 'c-cite', citations: [{ sourceId: 'src-companion-comp-1', quote: '[Slide 1] Kernel mode' }] },
        { id: 'c-suspended', suspended: true, companionRef: { companionId: 'comp-1', slide: 2 } },
        { id: 'c-plain', citations: [{ sourceId: 'src-doc-1', quote: 'text' }] },
      ],
    },
    { id: 'd-arch', archived: true, course: 'OS', cards: [{ id: 'c-skip', companionRef: { companionId: 'comp-1', slide: 1 } }] },
    { id: 'd-sys', systemKind: 'slain', course: 'OS', cards: [{ id: 'c-skip2', companionRef: { companionId: 'comp-1', slide: 1 } }] },
  ], [], [{ id: 'course-os', name: 'OS', companions: [{ id: 'comp-1', title: 'Traps' }] }]);

  assert.deepEqual(refsMap.get('comp-1'), [
    { deckId: 'd-main', cardId: 'c-explicit' },
    { deckId: 'd-main', cardId: 'c-cite' },
  ]);
  assert.equal(refsMap.size, 1);
});

test('companion.get enriches courseCards with mastery level & slide metadata and sorts linked cards before the 120-card cap', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'sh-comp-slide-check-'));
  try {
    const storeDir = join(tmp, 'lib');
    const htmlDir = join(tmp, 'html');
    await mkdir(htmlDir, { recursive: true });
    const htmlFile = join(htmlDir, 'deadlock.html');
    await writeFile(htmlFile, '<!doctype html><html><head><title>Deadlock</title></head><body><main>Slides</main></body></html>', 'utf8');

    const svc = new StudyService(storeDir, {});
    const attached = await svc.call('companion.attach', { path: htmlFile, course: 'OS', workspace: htmlDir, allowRememberTrusted: true });
    const companionId = attached.companion.id;

    const fillerCards = Array.from({ length: 130 }, (_, idx) => ({
      id: `filler-${idx + 1}`,
      kind: 'choice',
      prompt: `Filler question ${idx + 1}`,
      options: ['A', 'B'],
      answer: 0,
    }));

    await svc.store.update((state) => {
      state.decks.push(
        { id: 'd-filler', title: 'Filler Deck', course: 'OS', cards: fillerCards },
        {
          id: 'd-linked',
          title: 'Deadlock Checks',
          course: 'OS',
          cards: [
            {
              id: 'card-s4',
              kind: 'open',
              topic: 'Circular Wait',
              prompt: 'Why break circular wait?',
              companionRef: { companionId, slide: 4 },
            },
            {
              id: 'card-s2',
              kind: 'quiz',
              topic: 'Hold and Wait',
              prompt: 'Hold and wait condition?',
              citations: [{ sourceId: `src-companion-${companionId}`, quote: '[Slide 2] Resources held' }],
            },
          ],
        },
      );
      state.attempts.push({
        id: 'att-1',
        deckId: 'd-linked',
        quiz_id: 'card-s4',
        grade: 1,
        at: '2026-11-17T08:00:00Z',
      });
    });

    const fetched = await svc.call('companion.get', { id: companionId, course: 'OS' });
    assert.equal(fetched.relatedCards.length, 120);
    assert.equal(fetched.relatedCards[0].cardId, 'card-s2');
    assert.equal(fetched.relatedCards[0].linkedToCompanion, true);
    assert.equal(fetched.relatedCards[0].slide, 2);
    assert.equal(fetched.relatedCards[0].kind, 'quiz');
    assert.equal(fetched.relatedCards[0].level, 'new');
    assert.equal(fetched.relatedCards[0].companionRef, null);

    assert.equal(fetched.relatedCards[1].cardId, 'card-s4');
    assert.equal(fetched.relatedCards[1].linkedToCompanion, true);
    assert.equal(fetched.relatedCards[1].slide, 4);
    assert.equal(fetched.relatedCards[1].companionRef.slide, 4);
    assert.equal(fetched.relatedCards[1].level, 'weak');

    svc.dispose();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('CourseCompanionsBar, CompanionViewer, and CompanionInlineRun keep default-off parity and localize English cleanly when enabled', async () => {
  const readyState = {
    status: 'ready',
    companion: { id: 'comp-os', lessonId: 'os-1', title: 'Deadlock', course: 'OS', slideCount: 4, linkedRoot: '/lab' },
    html: '<!doctype html><html><head><title>Deadlock</title></head><body><main>Slide</main></body></html>',
    file: '/lab/pages/deadlock.html',
    changedOnDisk: false,
    lesson: {
      id: 'os-1',
      title: 'Deadlock',
      slideCount: 4,
      slides: [
        { title: 'Overview', beat: 'open' },
        { title: 'Conditions', beat: 'core' },
        { title: 'Prevention', beat: 'check' },
        { title: 'Recovery', beat: 'take' },
      ],
      terms: {},
    },
    bootConfig: { channelToken: 'tok-os', theme: 'light', initialAnchor: '#1', initialSlide: 1, memory: {} },
    relatedCards: [
      { deckId: 'd-os', cardId: 'q-s1', deckTitle: 'OS', topic: 'Coffman 1', prompt: 'Slide 1 card?', kind: 'open', linkedToCompanion: true, slide: 1, level: 'weak' },
      { deckId: 'd-os', cardId: 'q-s3', deckTitle: 'OS', topic: 'Ordering', prompt: 'Slide 3 card?', kind: 'open', linkedToCompanion: true, slide: 3, level: 'new' },
    ],
  };
  const sharedDecks = [
    {
      id: 'd-os',
      course: 'OS',
      title: 'OS',
      cards: [
        { id: 'q-s1', companionRef: { companionId: 'comp-os', slide: 1 }, prompt: 'Slide 1 card?' },
        { id: 'q-s3', companionRef: { companionId: 'comp-os', slide: 3 }, prompt: 'Slide 3 card?' },
      ],
    },
  ];
  const fakeStudy = { busy: false, call: () => new Promise(() => {}), act: async () => ({}), notify: noop, openModal: noop };
  const fakeInline = { Run: () => h('div', null, 'Inline'), load: noop };

  const renderBar = (practiceSettings) => {
    const barData = {
      settings: { practice: practiceSettings },
      courses: [{ id: 'course-os', name: 'OS', companions: [{ id: 'comp-os', title: 'Deadlock', slideCount: 4 }] }],
      sources: [],
      decks: sharedDecks,
    };
    return renderToStaticMarkup(
      h(ssr.StudyServicesContext.Provider, { value: fakeStudy },
        h(ssr.AppContext.Provider, {
          value: {
            data: barData,
            core: { refresh: noop },
            intents: { practice: noop },
            session: { enterRun: noop },
          },
        }, h(ssr.CourseCompanionsBar, { course: 'OS', data: barData })),
      ),
    );
  };

  const renderViewer = (practiceSettings, slide = 1) => renderToStaticMarkup(
    h(ssr.StudyServicesContext.Provider, { value: fakeStudy },
      h(ssr.AppContext.Provider, {
        value: {
          data: { settings: { practice: practiceSettings }, courses: [], sources: [], decks: sharedDecks },
          core: { refresh: noop },
        },
      }, h(ssr.CompanionViewer, {
        modal: {
          id: 'comp-os',
          course: 'OS',
          openDrawer: true,
          slide,
          initialSlide: slide,
          initialState: { ...readyState, bootConfig: { ...readyState.bootConfig, initialSlide: slide, initialAnchor: `#${slide}` } },
        },
        onClose: noop,
        inlinePractice: fakeInline,
      })),
    ),
  );

  ssr.setUiLanguage('zh');
  const barOff = renderBar(undefined);
  assert.doesNotMatch(barOff, /练配套题/);
  const viewerOff = renderViewer(undefined, 1);
  assert.doesNotMatch(viewerOff, /当页自测|本课自测|data-companion-drill/);

  const barOn = renderBar({ companionSlideCheck: true });
  assert.match(textOf(barOn), /练配套题 \(2\)/);

  const viewerSlide1 = renderViewer({ companionSlideCheck: true }, 1);
  assert.match(textOf(viewerSlide1), /当页自测 \(1\)/);
  assert.match(textOf(viewerSlide1), /当页配套自测/);
  assert.match(textOf(viewerSlide1), /抽屉自测 \(1\)/);
  assert.match(textOf(viewerSlide1), /随堂自测/);

  // Slide 2 has no direct card, so footer/drawer cleanly fall back to 本课自测 (2) / 本课配套自测
  const viewerSlide2 = renderViewer({ companionSlideCheck: true }, 2);
  assert.match(textOf(viewerSlide2), /本课自测 \(2\)/);
  assert.match(textOf(viewerSlide2), /本课配套自测/);
  assert.match(textOf(viewerSlide2), /抽屉自测 \(2\)/);

  english(() => {
    const enBar = renderBar({ companionSlideCheck: true });
    assert.doesNotMatch(textOf(enBar), han);
    assert.match(textOf(enBar), /Practise linked \(2\)/);

    const enViewer1 = renderViewer({ companionSlideCheck: true }, 1);
    assert.doesNotMatch(textOf(enViewer1), han);
    assert.match(textOf(enViewer1), /Quiz slide \(1\)/);
    assert.match(textOf(enViewer1), /Slide self-check/);
    assert.match(textOf(enViewer1), /Check in drawer \(1\)/);

    const enInline = renderToStaticMarkup(h(ssr.StudyServicesContext.Provider, { value: { busy: false } }, h(ssr.InlineRun, {
      session: { run: null, entry: {}, actions: {} },
      label: ssr.uiFormat('第 {0} 页 · {1} 道题', [1, 1]),
      rootRef: { current: null },
      onClose: noop,
      backLabel: ssr.ui('回到解惑栏'),
    })));
    assert.doesNotMatch(textOf(enInline), han);
    assert.match(textOf(enInline), /Back to doubts/);
    assert.match(textOf(enInline), /Slide 1 · 1 question/);
  });

  const inlineMod = await loadInteractiveUi(`
    export { default as CompanionInlineRun, useCompanionInlinePractice } from './ui/app/modals/CompanionInlineRun.jsx';
    export { default as InlineRun } from './ui/review/InlineRun.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const { CompanionInlineRun, useCompanionInlinePractice, InlineRun, AppContext, StudyServicesContext } = inlineMod.exports;

  // 1. useCompanionInlinePractice builds { Run, load } and delegates load(scope, then) with fresh: true
  const practiceCalls = [];
  const hookWrap = (el) => inlineMod.React.createElement(
    AppContext.Provider,
    { value: { intents: { practice: (scope, opts) => { practiceCalls.push({ scope, opts }); } } } },
    el,
  );
  const hook = inlineMod.mountHook(() => useCompanionInlinePractice(), undefined, hookWrap);
  try {
    assert.equal(hook.current.Run, CompanionInlineRun);
    const cb = () => {};
    hook.current.load([{ deckId: 'd-os', cardId: 'q-s1' }], cb);
    assert.equal(practiceCalls.length, 1);
    assert.deepEqual(practiceCalls[0].scope, [{ deckId: 'd-os', cardId: 'q-s1' }]);
    assert.equal(practiceCalls[0].opts.fresh, true);
    assert.equal(practiceCalls[0].opts.then, cb);
  } finally {
    hook.unmount();
  }

  // 2. CompanionInlineRun blurs focused iframe on mount, intercepts Escape, passes localized backLabel, and gates modal close on host.openModelSettings
  const keyListeners = [];
  let iframeBlurred = 0;
  let closedCount = 0;
  const modalChanges = [];
  let openedModelSettings = 0;
  class StubElement {
    constructor(tag, selectorMatches = []) {
      this.tagName = tag;
      this._matches = new Set(selectorMatches);
    }
    closest(sel) {
      return sel.split(',').some((part) => this._matches.has(part.trim())) ? this : null;
    }
  }
  const prevElement = globalThis.Element;
  globalThis.Element = StubElement;
  try {
    await withBrowserGlobals(async () => {
      const startedRun = {
        id: 'run-inline-1',
        mode: 'path',
        index: 0,
        total: 1,
        complete: false,
        card: { id: 'q-s1', deckId: 'd-os', kind: 'open', prompt: 'Slide 1 card?' },
      };
      const studyValue = {
        busy: false,
        call: async () => ({}),
        act: async () => ({}),
        notify: noop,
        openModal: noop,
        host: {},
      };
      const inlineData = { root: 'r', settings: {}, decks: sharedDecks, courses: [], sources: [] };
      const appValue = {
        core: { call: async () => ({}), act: async () => ({}), refresh: noop, notify: noop, refs: { dataRef: { current: inlineData } } },
        nav: { show: { page: noop, source: noop, task: noop, note: noop } },
        intents: { openRun: async () => true, practice: noop },
        set: { setModal: (m) => modalChanges.push(m) },
        data: inlineData,
        settingsEntry: { openModelSettings: () => { openedModelSettings += 1; } },
        learn: { openLearningTarget: noop },
      };
      inlineMod.exports.setUiLanguage('zh');
      const mounted = inlineMod.mount(() => inlineMod.React.createElement(
        StudyServicesContext.Provider,
        { value: studyValue },
        inlineMod.React.createElement(
          AppContext.Provider,
          { value: appValue },
          inlineMod.React.createElement(CompanionInlineRun, {
            started: startedRun,
            label: '第 1 页 · 1 道题',
            companionId: 'comp-os',
            onJumpSlide: noop,
            onClose: () => { closedCount += 1; },
            shown: true,
          }),
        ),
      ));
      try {
        assert.equal(iframeBlurred, 1, 'mounting CompanionInlineRun must blur a focused stage IFRAME');

        const inlineNode = mounted.find((n) => n.type === InlineRun);
        assert.ok(inlineNode, 'CompanionInlineRun must render InlineRun');
        assert.equal(inlineNode.props.backLabel, '回到解惑栏');

        // Verify Escape handling: non-Escape ignored, Escape in an input inside rootRef keeps round open, Escape on body closes round
        const bodyTarget = new StubElement('BODY');
        globalThis.document.body = bodyTarget;
        const inputTarget = new StubElement('INPUT', ['input']);
        inlineNode.props.rootRef.current = { contains: (node) => node === inputTarget };

        const dispatchKey = (key, target) => {
          const ev = {
            key,
            target,
            defaultPrevented: false,
            stopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.stopped = true; },
          };
          for (const listener of [...keyListeners]) listener(ev);
          return ev;
        };

        const enterEv = dispatchKey('Enter', bodyTarget);
        assert.equal(enterEv.defaultPrevented, false);
        assert.equal(closedCount, 0);

        const inputEsc = dispatchKey('Escape', inputTarget);
        assert.equal(inputEsc.defaultPrevented, true, 'Escape inside inline input calls preventDefault to keep outer dialog open');
        assert.equal(closedCount, 0, 'Escape inside inline input must not close the inline round');

        const bodyEsc = dispatchKey('Escape', bodyTarget);
        assert.equal(bodyEsc.defaultPrevented, true);
        assert.equal(bodyEsc.stopped, true);
        assert.equal(closedCount, 1, 'Escape outside inputs closes the inline round instead of outer companion dialog');

        // Verify onModelSettings closes companion modal only when host has no native openModelSettings
        inlineNode.props.links.onModelSettings();
        assert.deepEqual(modalChanges, [null]);
        assert.equal(openedModelSettings, 1);

        studyValue.host = { openModelSettings: noop };
        mounted.rerender();
        const inlineNodeWithHost = mounted.find((n) => n.type === InlineRun);
        inlineNodeWithHost.props.links.onModelSettings();
        assert.deepEqual(modalChanges, [null], 'must keep companion modal open when host provides native openModelSettings');
        assert.equal(openedModelSettings, 2);
      } finally {
        mounted.unmount();
      }
    }, {
      document: {
        activeElement: { tagName: 'IFRAME', blur: () => { iframeBlurred += 1; } },
      },
      window: {
        addEventListener: (type, fn) => { if (type === 'keydown') keyListeners.push(fn); },
        removeEventListener: (type, fn) => {
          const idx = keyListeners.indexOf(fn);
          if (idx >= 0) keyListeners.splice(idx, 1);
        },
      },
    });
  } finally {
    if (prevElement === undefined) delete globalThis.Element;
    else globalThis.Element = prevElement;
  }
});
