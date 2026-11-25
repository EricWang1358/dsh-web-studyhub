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

const uiMod = await loadUi(`
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

test('#1436 Item 9c: TeachingPanel uses variant="quiet", renders Markdown + reference answer in skipped summary, and has CSS rules', () => {
  const panelSrc = readFileSync(new URL('../ui/review/TeachingPanel.jsx', import.meta.url), 'utf8');
  const cssSrc = readFileSync(new URL('../ui/review/question.css', import.meta.url), 'utf8');

  assert.doesNotMatch(panelSrc, /variant=["']ghost["']/, 'TeachingPanel must not pass invalid variant="ghost" to Button');
  assert.match(panelSrc, /teaching-panel__skip[\s\S]{0,120}variant=["']quiet["']/, 'skip button must use variant="quiet"');
  assert.match(panelSrc, /teaching-panel__skip-all[\s\S]{0,120}variant=["']quiet["']/, 'skip-all button must use variant="quiet"');

  assert.match(cssSrc, /\.teaching-panel__actions\s*\{/, 'question.css must style .teaching-panel__actions');
  assert.match(cssSrc, /\.teaching-skipped-summary\s*\{/, 'question.css must style .teaching-skipped-summary');
  assert.match(cssSrc, /\.teaching-wrong-nudge\s*\{/, 'question.css must style .teaching-wrong-nudge');

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
