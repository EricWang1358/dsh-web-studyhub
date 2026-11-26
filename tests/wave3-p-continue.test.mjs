import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

// #175 / #177: where 继续学习 on the results page goes is one decision with four answers, never "the same scope again, forever".
const m = await loadUi(`export * from './ui/review/session-logic.js'; export * from './ui/review/continue-labels.js';
  export { default as CoachDebrief } from './ui/CoachDebrief.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const noop = () => {};

const oneCard = { id: 'r1', mode: 'path', scope: [{ deckId: 'd1', cardId: 'c1' }], questions: 1, total: 1, answered: 1, correct: 1, complete: true };
const progress = { d1: { counts: { new: 0, mastered: 5 }, due: 0, topics: [{ name: 'CAP', counts: { new: 0 }, due: 0 }] } };
const tasks = [
  { id: 't1', title: '巩固 PDF02', kind: 'practice', status: 'doing', runId: 'r1', available: true },
  { id: 't2', title: '阅读 CAP 讲义', kind: 'reading', status: 'todo', available: true },
];

test('a prerequisite round goes back to the original question (#177)', () => {
  const run = { ...oneCard, id: 'pre', returnTo: 'orig' };
  assert.deepEqual(m.continueDestination({ run, runs: [{ id: 'orig', mode: 'path' }], progress, tasks }), { kind: 'original', runId: 'orig' });
  assert.equal(m.continueDestination({ run, runs: undefined, progress, tasks }).kind, 'original', 'when the open runs are not known the way back is still offered');
});

test('the original run is gone or finished: say so and go to the path', () => {
  const run = { ...oneCard, id: 'pre', returnTo: 'orig' };
  for (const runs of [[], [{ id: 'other' }], [{ id: 'orig', complete: true }]]) {
    assert.deepEqual(m.continueDestination({ run, runs, progress, tasks }), { kind: 'path', reason: 'original-gone' });
  }
});

test('a scope with questions left carries on with that scope', () => {
  const deckRun = { id: 'r2', mode: 'path', scope: [{ deckId: 'd1' }], questions: 10, answered: 10, complete: true };
  const more = { d1: { counts: { new: 7 }, due: 0, topics: [] } };
  assert.deepEqual(m.continueDestination({ run: deckRun, progress: more, tasks }), { kind: 'scope', scope: [{ deckId: 'd1' }] });
  const due = { d1: { counts: { new: 0 }, due: 3, topics: [] } };
  assert.equal(m.continueDestination({ run: deckRun, progress: due, tasks }).kind, 'scope', 'due questions count as work left');
  const topicRun = { ...deckRun, scope: [{ deckId: 'd1', topic: 'CAP' }] };
  assert.equal(m.continueDestination({ run: topicRun, progress: { d1: { counts: { new: 9 }, due: 9, topics: [{ name: 'CAP', counts: { new: 0 }, due: 0 }] } }, tasks }).kind, 'plan', 'a topic scope looks at its own topic');
  const ended = { ...oneCard, scope: [{ deckId: 'd1', cardId: 'c1' }], questions: 5, answered: 2, closed: true };
  assert.equal(m.continueDestination({ run: ended, progress, tasks }).kind, 'scope', 'a round ended early still has unanswered questions');
});

test('a finished scope moves on to the next unfinished action of today’s plan (#175)', () => {
  assert.deepEqual(m.continueDestination({ run: oneCard, progress, tasks }), { kind: 'plan', taskId: 't2', title: '阅读 CAP 讲义' });
  const unlinked = tasks.map(task => ({ ...task, runId: undefined }));
  assert.equal(m.continueDestination({ run: oneCard, progress, tasks: unlinked }).taskId, 't1', 'the one in progress comes first');
  const none = [{ id: 't3', title: 'done', status: 'done' }, { id: 't4', title: 'gone', status: 'todo', available: false }];
  assert.equal(m.continueDestination({ run: oneCard, progress, tasks: none }).kind, 'path');
});

test('no plan: the normal path with an empty scope, never the same question again', () => {
  const destination = m.continueDestination({ run: oneCard, progress, tasks: [] });
  assert.deepEqual(destination, { kind: 'path', reason: 'scope-done' });
  assert.deepEqual(m.continueDestination({ run: { id: 'r3', mode: 'path', scope: [], questions: 10, answered: 10, complete: true }, progress, tasks: [] }), { kind: 'path', reason: 'continuing' });
  assert.deepEqual(m.continueDestination({ run: null }), { kind: 'path', reason: 'continuing' });
});

test('how many questions a scope has left', () => {
  assert.equal(m.scopeRemaining({ scope: [{ deckId: 'd1', cardId: 'c1' }], questions: 1, answered: 1 }, progress), 0);
  assert.equal(m.scopeRemaining({ scope: [{ deckId: 'd1' }, { deckId: 'd2' }], questions: 4, answered: 4 }, { d1: { counts: { new: 2 }, due: 1 }, d2: { counts: { new: 1 }, due: 0 } }), 4);
  assert.equal(m.scopeRemaining({ scope: [], questions: 3, answered: 3 }, progress), Infinity, 'the whole path never runs out');
  assert.equal(m.scopeRemaining({ scope: [{ deckId: 'gone' }], questions: 1, answered: 1 }, progress), 0, 'a deck no longer in the snapshot has nothing left');
});

test('the button names its destination, in both languages', () => {
  const label = (destination, language = 'zh') => { m.setUiLanguage(language); try { return m.continueLabel(destination); } finally { m.setUiLanguage('zh'); } };
  assert.equal(label({ kind: 'original' }), '回到原题');
  assert.equal(label({ kind: 'scope' }), '继续这个范围');
  assert.equal(label({ kind: 'plan', title: '巩固 PDF02' }), '下一步：巩固 PDF02');
  assert.equal(label({ kind: 'path', reason: 'scope-done' }), '回到学习路径');
  assert.equal(label({ kind: 'path', reason: 'original-gone' }), '回到学习路径');
  assert.equal(label({ kind: 'path', reason: 'continuing' }), '继续学习');
  assert.equal(label({ kind: 'original' }, 'en'), 'Return to original question');
  assert.equal(label({ kind: 'plan', title: 'Review PDF02' }, 'en'), 'Next: Review PDF02');
  assert.equal(label({ kind: 'path', reason: 'scope-done' }, 'en'), 'Back to the learning path');
  assert.match(m.continueNote({ kind: 'path', reason: 'original-gone' }), /已经结束或不存在/);
  assert.equal(m.continueNote({ kind: 'plan' }), '');
});

const debrief = { next: 'continue_path', headline: '状态不错', why: '接着学下一批', metrics: { answered: 1 }, insights: [] };
const strip = (props, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(h(m.CoachDebrief, { run: oneCard, call: async () => debrief, initial: debrief, busy: false,
  onPractice: noop, onReviewWeak: noop, ...props })); } finally { m.setUiLanguage('zh'); } };

test('the coach card’s button is the decided destination; a way back to the original leaves no competing 继续学习', () => {
  const plan = { kind: 'plan', taskId: 't2', title: '阅读 CAP 讲义', label: '下一步：阅读 CAP 讲义', go: noop };
  const html = strip({ destination: plan });
  assert.match(html, /<button[^>]*sh-btn--primary[^>]*>[^<]*下一步：阅读 CAP 讲义/);
  assert.doesNotMatch(html, /继续学习/);
  const original = { kind: 'original', runId: 'orig', label: '回到原题', go: noop };
  const back = strip({ destination: original });
  assert.doesNotMatch(back, /继续学习|回到原题/, 'the page’s own 回到原题 is the one primary action');
  assert.doesNotMatch(back, /<button[^>]*primary/, 'no button of the card competes with it');
  const prepared = strip({ destination: original, initial: { ...debrief, next: 'practice_prepared' } });
  assert.doesNotMatch(prepared, /为你定制的题/, 'nothing else is offered while a prerequisite round waits to return');
  assert.match(strip({ onContinue: noop }), /继续学习/, 'without a decision the card keeps its old button (no library, tests)');
});

test('the session hands the decision to the page and keeps the typed answer for the way back', async () => {
  const { exports: ui, mountHook } = await loadInteractiveUi(`
    export { useReviewSession, useLiveSession } from './ui/review/useReviewSession.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);

  await withBrowserGlobals(async () => {
    ui.setUiLanguage('zh');
    const origRun = {
      id: 'orig',
      mode: 'path',
      index: 0,
      queueVersion: 0,
      scope: [{ deckId: 'd1', cardId: 'c-orig' }],
      card: { id: 'c-orig', kind: 'open', prompt: 'Explain CAP theorem', answer: 'Consistency, availability, partition tolerance' },
      revealed: false,
      feedback: null,
    };
    const prereqDone = { ...oneCard, id: 'pre', returnTo: 'orig', complete: true };
    const dataObj = {
      root: 'lib-continue',
      settings: {},
      runs: [{ id: 'orig', mode: 'path' }],
      progress,
    };
    const actCalls = [];
    const core = {
      busy: false,
      call: async () => ({ ok: true }),
      act: async (action, args, after) => {
        actCalls.push({ action, args });
        if (action === 'review.start' && args.returnTo === 'orig') {
          after?.(prereqDone);
          return prereqDone;
        }
        if (action === 'review.get' && args.runId === 'orig') {
          after?.(origRun);
          return origRun;
        }
        return null;
      },
      notify: () => {},
      setError: () => {},
      refresh: async () => {},
      refs: { dataRef: { current: dataObj }, bindingRoot: { current: 'lib-continue' } },
    };
    const nav = { page: 'review', setPage: () => {}, show: { exam: () => {} } };
    const hook = mountHook(() => {
      const session = ui.useReviewSession({ core, nav, modalOpen: false, host: {}, rootRef: { current: null }, late: { current: {} } });
      const live = ui.useLiveSession(session);
      return { session, live };
    }, {});

    try {
      // 1. Open original question and type a draft response before jumping to prerequisites.
      await hook.act(() => {
        hook.current.session.enterRun(origRun);
      });
      await hook.act(() => {
        hook.current.session.actions.setResponse('partition tolerance draft');
      });
      assert.equal(hook.current.live.entry.response, 'partition tolerance draft');

      // 2. Start prerequisites: records returnInput and enters the prerequisite round with returnTo: 'orig'.
      await hook.act(async () => {
        await hook.current.session.actions.studyPrerequisites([{ deckId: 'd1', cardId: 'c1' }]);
      });
      assert.equal(hook.current.session.run.id, 'pre');
      assert.equal(actCalls.at(-1).action, 'review.start');
      assert.equal(actCalls.at(-1).args.returnTo, 'orig');

      // 3. continueTo decides to return to the original run and restores the typed answer on go().
      const backDest = hook.current.session.continueTo(null);
      assert.equal(backDest.kind, 'original');
      assert.equal(backDest.runId, 'orig');
      assert.equal(backDest.label, '回到原题');

      await hook.act(async () => {
        await backDest.go();
      });
      assert.equal(actCalls.at(-1).action, 'review.get');
      assert.deepEqual(actCalls.at(-1).args, { runId: 'orig' });
      assert.equal(hook.current.session.run.id, 'orig');
      assert.equal(hook.current.live.entry.response, 'partition tolerance draft', 'typed answer is restored when returning from prerequisites');

      // 4. Finished single-card scope: delegates to next daily plan task when present, or empty-scope path otherwise (never blind-restarts same scope).
      await hook.act(() => {
        hook.current.session.enterRun(oneCard);
      });
      const startedPlans = [];
      const planDest = hook.current.session.continueTo({ state: { tasks }, start: (taskId) => startedPlans.push(taskId) });
      assert.equal(planDest.kind, 'plan');
      assert.equal(planDest.taskId, 't2');
      planDest.go();
      assert.deepEqual(startedPlans, ['t2']);

      actCalls.length = 0;
      const pathDest = hook.current.session.continueTo(null);
      assert.equal(pathDest.kind, 'path');
      assert.equal(pathDest.reason, 'scope-done');
      await hook.act(async () => {
        await pathDest.go();
      });
      assert.equal(actCalls.length, 1);
      assert.equal(actCalls[0].action, 'review.start');
      assert.deepEqual(actCalls[0].args.scope, [], 'finished scope starts the general path instead of blindly restarting the finished scope');
    } finally {
      hook.unmount();
    }
  });
});
