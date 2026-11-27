// #1436 Batch 4 Item 9:
// - `isTeachSkipPhrase` narrows to unambiguous skip commands (never misfiring on "不会" / "pass" / "next" / "先过" / "算了")
// - `skipTeaching` throws localized Chinese non-retryable errors
// - `TeachingPanel` uses valid `variant="quiet"` buttons, renders skipped steps with `<Markdown>` + reference answer,
//   and `ui/review/question.css` styles `.teaching-panel__actions`, `.teaching-skipped-summary`, and `.teaching-wrong-nudge`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isTeachSkipPhrase, skipTeaching } from '../lib/teaching.js';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, click } from './helpers/react-harness.mjs';

const uiMod = await loadUi(`
  export { default as TeachingPanel } from './ui/review/TeachingPanel.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const interactiveUi = await loadInteractiveUi(`
  export { default as TeachingPanel } from './ui/review/TeachingPanel.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

test('#1436 Item 9a: isTeachSkipPhrase rejects legitimate answers ("不会", "pass", "next", "先过", "算了") while keeping explicit skip phrases', () => {
  // Legitimate learner answers MUST NOT be hijacked as skip commands!
  for (const answer of ['不会', '我不会', '不知道', 'pass', 'Pass', 'next', 'Next', '先过', '算了', '不懂']) {
    assert.equal(isTeachSkipPhrase(answer), false, `"${answer}" must NOT trigger skip`);
  }
  // Explicit unambiguous skip commands still work (compatible with issue-1318-teach-skip.test.mjs)
  for (const cmd of ['跳过', '跳过这一步', '跳过，下一问', 'skip', 'skip step', 'skip this step', 'skip, next']) {
    assert.equal(isTeachSkipPhrase(cmd), true, `explicit skip command "${cmd}" must still work`);
  }
});

test('#1436 Item 9b: skipTeaching throws localized Chinese nonRetryableError on complete/stale step', async () => {
  const fakeStore = {
    read: async () => ({
      decks: [],
      teaching: [{ id: 't1', index: 1, rungs: [{ lesson: 'L1', check: 'C1', answer: 'A1' }], mastered_rungs: [] }],
    }),
    update: async () => {},
  };
  await assert.rejects(
    skipTeaching(fakeStore, { id: 't1' }),
    (err) => err?.retryable === false && /[\u4e00-\u9fff]/.test(err.message),
    'completed teaching error must be Chinese and non-retryable',
  );

  const staleStore = {
    read: async () => ({
      decks: [],
      teaching: [{ id: 't2', index: 1, rungs: [{ lesson: 'L1' }, { lesson: 'L2' }], mastered_rungs: [] }],
    }),
    update: async () => {},
  };
  await assert.rejects(
    skipTeaching(staleStore, { id: 't2', stepIndex: 0 }),
    (err) => err?.retryable === false && /[\u4e00-\u9fff]/.test(err.message),
    'step mismatch error must be Chinese and non-retryable',
  );
});

test('#1436 Item 9c: TeachingPanel uses variant="quiet", renders Markdown + reference answer in skipped summary, and has CSS rules', async () => {
  const cssSrc = readFileSync(new URL('../ui/review/question.css', import.meta.url), 'utf8');

  assert.match(cssSrc, /\.teaching-panel__actions\s*\{/, 'question.css must style .teaching-panel__actions');
  assert.match(cssSrc, /\.teaching-skipped-summary\s*\{/, 'question.css must style .teaching-skipped-summary');
  assert.match(cssSrc, /\.teaching-wrong-nudge\s*\{/, 'question.css must style .teaching-wrong-nudge');

  // Behavioral render + interaction of active TeachingPanel (complete: false)
  const actCalls = [];
  const h = interactiveUi.React.createElement;
  const makeActiveElement = ({ wrongTries = 1, teachingBusy = false } = {}) =>
    h(
      interactiveUi.exports.StudyServicesContext.Provider,
      { value: { call: async () => ({}), openModal: () => {} } },
      h(interactiveUi.exports.TeachingPanel, {
        session: {
          entry: {
            teachAnswer: '',
            teaching: {
              id: 't-active',
              mode: 'understand',
              index: 1,
              total: 3,
              complete: false,
              lesson: '先确认已知量。',
              check: '这里的关键关系是什么？',
              skippedSteps: [],
              masteredCount: 1,
              wrongTries,
            },
          },
          teachingBusy,
          teachingError: null,
          actions: {
            teachingAct: (action, payload) => actCalls.push([action, payload]),
            setTeachAnswer: () => {},
            cancelTeaching: () => {},
            retryTeaching: () => {},
          },
        },
        data: { sources: [] },
        model: { ready: true },
        onModelSettings: () => {},
      }),
    );

  const classTokens = (node) => String(node?.props?.className || '').split(/\s+/).filter(Boolean);
  interactiveUi.exports.setUiLanguage('zh');
  const mounted = interactiveUi.mount(() => makeActiveElement({ wrongTries: 1, teachingBusy: false }));
  try {
    const actionsRow = mounted.find(
      (node) => node.type === 'div' && classTokens(node).includes('teaching-panel__actions'),
    );
    assert.ok(actionsRow, 'active TeachingPanel must render .teaching-panel__actions');

    const skipBtn = mounted.find(
      (node) => node.type === 'button' && classTokens(node).includes('teaching-panel__skip'),
      actionsRow,
    );
    const skipAllBtn = mounted.find(
      (node) => node.type === 'button' && classTokens(node).includes('teaching-panel__skip-all'),
      actionsRow,
    );
    assert.ok(skipBtn, 'skip button must render inside .teaching-panel__actions');
    assert.ok(skipAllBtn, 'skip-all button must render inside .teaching-panel__actions');

    for (const [label, btn] of [['skip', skipBtn], ['skip-all', skipAllBtn]]) {
      const tokens = classTokens(btn);
      assert.ok(tokens.includes('sh-btn--quiet'), `${label} button must render with sh-btn--quiet`);
      assert.ok(!tokens.includes('sh-btn--secondary'), `${label} button must not fall back to sh-btn--secondary`);
      assert.ok(!tokens.includes('sh-btn--ghost'), `${label} button must not emit invalid sh-btn--ghost`);
      assert.equal(btn.props.type, 'button', `${label} button must have type="button"`);
      assert.equal(btn.props.disabled, false, `${label} button must be enabled when not busy`);
    }

    assert.equal(
      mounted.find((node) => classTokens(node).includes('teaching-wrong-nudge')),
      null,
      'wrongTries: 1 must hide .teaching-wrong-nudge',
    );

    await mounted.act(() => {
      click(skipBtn);
      click(skipAllBtn);
    });
    assert.deepEqual(actCalls, [
      ['teach.skip', { id: 't-active', stepIndex: 1 }],
      ['teach.skip', { id: 't-active', stepIndex: 1, all: true }],
    ]);

    mounted.rerender(() => makeActiveElement({ wrongTries: 2, teachingBusy: false }));
    const nudge = mounted.find((node) => classTokens(node).includes('teaching-wrong-nudge'));
    assert.ok(nudge, 'wrongTries: 2 must render .teaching-wrong-nudge');
    assert.match(mounted.text(nudge), /连续答错两次/);

    mounted.rerender(() => makeActiveElement({ wrongTries: 2, teachingBusy: true }));
    const busySkipBtn = mounted.find(
      (node) => node.type === 'button' && classTokens(node).includes('teaching-panel__skip'),
    );
    const busySkipAllBtn = mounted.find(
      (node) => node.type === 'button' && classTokens(node).includes('teaching-panel__skip-all'),
    );
    assert.equal(busySkipBtn.props.disabled, true, 'skip button must be disabled when teachingBusy is true');
    assert.equal(busySkipAllBtn.props.disabled, true, 'skip-all button must be disabled when teachingBusy is true');
    await mounted.act(() => {
      click(busySkipBtn);
      click(busySkipAllBtn);
    });
    assert.equal(actCalls.length, 2, 'busy state must block skip / skip-all actions');
  } finally {
    mounted.unmount();
    interactiveUi.exports.setUiLanguage('zh');
  }

  // Render completed TeachingPanel with skipped calculation step containing Markdown + distinct reference answer
  uiMod.setUiLanguage('zh');
  const html = renderToStaticMarkup(
    React.createElement(
      uiMod.StudyServicesContext.Provider,
      { value: { call: async () => ({}), openModal: () => {} } },
      React.createElement(uiMod.TeachingPanel, {
        session: {
          entry: {
            teachAnswer: '',
            teaching: {
              id: 't-calc',
              mode: 'calculation',
              index: 1,
              total: 1,
              complete: true,
              transfer: '把公式迁移到新题。',
              skippedSteps: [
                { index: 0, lesson: '使用**牛顿第二定律** `F = ma`', answer: 'F = 2 * 5 = 10 N' },
              ],
              masteredCount: 0,
              wrongTries: 0,
            },
          },
          teachingBusy: false,
          teachingError: null,
          actions: { teachingAct: () => {}, setTeachAnswer: () => {}, cancelTeaching: () => {}, retryTeaching: () => {} },
        },
        data: { sources: [] },
        model: { ready: true },
        onModelSettings: () => {},
      }),
    ),
  );

  assert.match(html, /<strong>牛顿第二定律<\/strong>/, 'skipped step lesson must render as Markdown, not raw **stars**');
  assert.match(html, /<code>F = ma<\/code>/, 'skipped step inline code must render as Markdown');
  assert.match(html, /F = 2 \* 5 = 10 N/, 'skipped step must display reference answer when distinct from lesson');
});
