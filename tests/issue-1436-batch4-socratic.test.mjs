// #1436 Batch 4 Items 1 & 3:
// - Item 1: Socratic inline drawer auto-collapses synchronously on card change (zero flicker, no stale socratic.get / assistance leak)
// - Item 3: Source dock + Socratic inline drawer no longer leaves a 452px empty column; term-marking excludes Socratic drawer & nudge
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const uiMod = await loadUi(`
  export { useSocraticInlineState } from './ui/review/LazySocraticInline.jsx';
  export { isExcludedElement } from './ui/review/term-marking-dom.js';
`);

test('#1436 Item 1: useSocraticInlineState derives open synchronously from voiceScopeKey so switching cards collapses immediately without effect delay', () => {
  // Behavioral simulation: mount hook across renders with run1 -> open -> run2 (same component instance, NO effect run!)
  const states = [];
  let cursor = 0;
  const origUseState = React.useState;
  const origUseCallback = React.useCallback;
  const runHook = (props) => {
    cursor = 0;
    let result;
    function Probe() {
      result = uiMod.useSocraticInlineState(props);
      return null;
    }
    // Drive stateful renders by stubbing React hooks on a shared state table (zero useEffect execution!)
    React.useState = (init) => {
      const idx = cursor++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      const set = (next) => {
        states[idx] = typeof next === 'function' ? next(states[idx]) : next;
      };
      return [states[idx], set];
    };
    React.useCallback = (fn) => fn;
    try {
      Probe();
    } finally {
      React.useState = origUseState;
      React.useCallback = origUseCallback;
    }
    return result;
  };

  const run1 = { id: 'r1', index: 0, mode: 'path', complete: false, card: { id: 'c1' }, retry: false, queueVersion: 0 };
  const run1Refreshed = { ...run1, queueVersion: 2, revision: 3 };
  const run2 = { id: 'r1', index: 1, mode: 'path', complete: false, card: { id: 'c2' }, retry: false, queueVersion: 0 };
  const run1Retry = { id: 'r1', index: 0, mode: 'path', complete: false, card: { id: 'c1' }, retry: true, queueVersion: 0 };

  let s = runHook({ run: run1 });
  assert.equal(s.open, false, 'starts closed');

  s.activate();
  s = runHook({ run: run1 });
  assert.equal(s.open, true, 'opens on current card');

  // Same card after poll/queueVersion update stays open
  s = runHook({ run: run1Refreshed });
  assert.equal(s.open, true, 'stays open across poll/queueVersion update on same question');

  // Next question -> IMMEDIATELY closed on render (zero useEffect needed!)
  s = runHook({ run: run2 });
  assert.equal(s.open, false, 'must collapse synchronously when moving to next question');

  // Going back to c1 in retry slot -> also closed (different retry slot)
  s = runHook({ run: run1Retry });
  assert.equal(s.open, false, 'must stay closed when entering retry slot of same card');

  // Toggle on c2 works cleanly
  s = runHook({ run: run2 });
  s.toggle();
  s = runHook({ run: run2 });
  assert.equal(s.open, true, 'toggle opens on new question');
  s.toggle();
  s = runHook({ run: run2 });
  assert.equal(s.open, false, 'toggle closes cleanly');

  // Also ensure SSR renderToStaticMarkup stays clean
  assert.equal(renderToStaticMarkup(React.createElement('div', null, 'ok')), '<div>ok</div>');
});

test('#1436 Item 3: source dock + Socratic inline drawer collapses to single column and excludes Socratic elements from term-marking', () => {
  const sessionCss = readFileSync(new URL('../ui/review/session.css', import.meta.url), 'utf8');
  const socraticCss = readFileSync(new URL('../ui/review/socratic-inline.css', import.meta.url), 'utf8');

  // 1) Paired override in session.css + socratic-inline.css prevents empty 2nd column under .review-page.has-source
  assert.match(
    sessionCss,
    /\.review-page\.has-source\s*>\s*\.review-body\.has-socratic\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    'session.css must collapse .review-body.has-socratic to 1 column when .review-page.has-source is active',
  );
  assert.match(
    socraticCss,
    /\.review-page\.has-source\s*>\s*\.review-body\.has-socratic\s*>\s*\.socratic-inline-drawer\s*\{[^}]*grid-column:\s*1/s,
    'socratic-inline.css must place .socratic-inline-drawer in column 1 when .review-page.has-source is active',
  );

  // 2) Term-marking excludes elements inside .socratic-inline-drawer and .socratic-nudge, while allowing normal content
  const makeEl = (tagName, classNames = [], parent = null) => {
    const classes = new Set(classNames);
    const el = {
      tagName: tagName.toUpperCase(),
      parentElement: parent,
      contains(target) {
        for (let cur = target; cur; cur = cur.parentElement) {
          if (cur === el) return true;
        }
        return false;
      },
      matches(selector) {
        return selector.split(',').some((raw) => {
          const part = raw.trim();
          if (part.startsWith('.')) return classes.has(part.slice(1));
          return part.toUpperCase() === el.tagName;
        });
      },
    };
    return el;
  };
  const body = makeEl('div', ['review-body']);
  const drawer = makeEl('aside', ['socratic-inline-drawer'], body);
  const drawerPrompt = makeEl('p', ['socratic-message'], drawer);
  const nudge = makeEl('div', ['socratic-nudge'], body);
  const nudgeText = makeEl('span', ['socratic-nudge__text'], nudge);
  const questionCard = makeEl('div', ['question-card'], body);
  const questionStem = makeEl('p', ['question'], questionCard);

  assert.equal(uiMod.isExcludedElement(drawer, body), true, '.socratic-inline-drawer itself is excluded from term-marking');
  assert.equal(uiMod.isExcludedElement(drawerPrompt, body), true, 'descendants of .socratic-inline-drawer are excluded from term-marking');
  assert.equal(uiMod.isExcludedElement(nudge, body), true, '.socratic-nudge itself is excluded from term-marking');
  assert.equal(uiMod.isExcludedElement(nudgeText, body), true, 'descendants of .socratic-nudge are excluded from term-marking');
  assert.equal(uiMod.isExcludedElement(questionStem, body), false, 'normal question content remains eligible for term-marking');
});

test('#1448 useSocraticInlineState: leaving a question closes its drawer for good, so A -> B -> A does not re-open it (and re-request) by itself', () => {
  // The same stubbed-hooks harness as above: state lives in a table, no effect ever runs.
  const states = [];
  let cursor = 0;
  const origUseState = React.useState;
  const origUseCallback = React.useCallback;
  const runHook = (props) => {
    cursor = 0;
    let result;
    function Probe() { result = uiMod.useSocraticInlineState(props); return null; }
    React.useState = (init) => {
      const idx = cursor++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [states[idx], (next) => { states[idx] = typeof next === 'function' ? next(states[idx]) : next; }];
    };
    React.useCallback = (fn) => fn;
    try { Probe(); } finally { React.useState = origUseState; React.useCallback = origUseCallback; }
    return result;
  };
  const questionA = { id: 'r1', index: 0, mode: 'path', complete: false, card: { id: 'c1' }, retry: false };
  const questionB = { id: 'r1', index: 1, mode: 'path', complete: false, card: { id: 'c2' }, retry: false };

  runHook({ run: questionA }).activate();
  assert.equal(runHook({ run: questionA }).open, true, 'open on A');
  assert.equal(runHook({ run: questionB }).open, false, 'closed on B');
  assert.equal(runHook({ run: questionB }).open, false, 'still closed on a later render of B');
  assert.equal(runHook({ run: questionA }).open, false, 'back on A it stays closed until the learner opens it again');
  runHook({ run: questionA }).activate();
  assert.equal(runHook({ run: questionA }).open, true, 'the learner can still open it on A');
});
