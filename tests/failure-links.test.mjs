import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* A failed run says on its card what to do next, in the fewest presses: a run that hit its time limit links straight to the setting (设置 › 出题偏好, the field of the limit) instead of "in the
   details of the 任务 page"; a failed run the contract can retry is one press (再试一次, the contract's own retry, which carries the whole request), with 按原资料重新设置 as the quiet way
   to change something first. A run that cannot be retried keeps what it had. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as JobCard } from './ui/study-map/JobCard.jsx';
  export { LIMIT_ANCHOR } from './ui/tasks/time-limit.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const noop = () => {};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };

const BUDGET = 'Generation reached its 20-minute total budget; approved questions were retained';
const failed = (extra = {}) => ({ id: 'j1', type: 'generate', status: 'failed', stage: BUDGET, deckTitle: '期中复习', kind: 'quiz', count: 10, requestedTotal: 10, savedCount: 0, parts: 1, steps: [],
  sourceIds: ['s'], startedAt: '2026-10-06T10:00:00.000Z', finishedAt: '2026-10-06T10:20:00.000Z', ...extra });
const draw = (job, { drafts = [], modelReady = true, language = 'zh', services } = {}) => inLanguage(language, () => {
  const data = { jobs: [job], drafts, decks: [], sources: [], model: { ready: modelReady } };
  return renderToStaticMarkup(inApp(m, React.createElement(m.JobCard, { job, jobs: [job], drafts, data, busy: false, openDraft: noop, cancelJob: noop, dismissJob: noop, retryGeneration: noop, openModelSettings: noop, modelReady }), { data, services }));
});
const primary = html => text(/<button[^>]*class="[^"]*cjc__go[^"]*"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] || '').replace(/\s*→$/, '');
const linksOf = html => text(/<div class="cjc__links"[\s\S]*?<\/div>/.exec(html)?.[0] || '');

test('a run that hit its time limit links to the setting of the limit on its card', () => {
  const html = draw(failed());
  assert.match(linksOf(html), /调整时限/);
  assert.doesNotMatch(linksOf(draw(failed({ stage: 'fetch failed: ECONNRESET' }))), /调整时限/, 'another failure has no such link');
  assert.doesNotMatch(linksOf(draw(failed({ status: 'complete', stage: 'Draft ready for review' }))), /调整时限/);
  assert.equal(m.LIMIT_ANCHOR, 'settings-generation-time', 'the field of 设置 › 出题偏好 that holds the limit');
  inLanguage('en', () => assert.match(linksOf(draw(failed(), { language: 'en' })), /Adjust time budget/));
});

test('a failed run the contract can retry is one press: 再试一次, and 按原资料重新设置 is the quiet other way', () => {
  const html = draw(failed({ retryable: true }));
  assert.equal(primary(html), '再试一次');
  assert.match(linksOf(html), /按原资料重新设置/);
  assert.match(linksOf(html), /调整时限/, 'and the limit, since the limit is why it failed');
  // without a ready model the retry is not pressable (it would fail again at once)
  assert.match(/<button[^>]*class="[^"]*cjc__go[^"]*"[^>]*>/.exec(draw(failed({ retryable: true }), { modelReady: false }))[0], /disabled/);
  // a refused key goes to the model settings first: retrying is no use before that
  assert.equal(primary(draw(failed({ retryable: true, stage: 'Incorrect API key provided' }))), '去配置模型', 'but only where the host can open them');
});

test('a run the contract cannot retry keeps what it had: the form again, with the sources, the types and the count', () => {
  const html = draw(failed());
  assert.equal(primary(html), '按原资料重新设置');
  assert.doesNotMatch(text(html), /再试一次/);
  assert.doesNotMatch(linksOf(html), /按原资料重新设置/, 'once, not twice');
});

test('a failed run that kept a draft is continued from the draft, as before; the limit link is there too', () => {
  const draft = { id: 'd1', title: '期中复习', draftVersion: 2, cards: [{ id: 'c1', kind: 'quiz' }], editorial: { requested: 10, generation: { sourceIds: ['s'], kind: 'quiz' } } };
  const html = draw(failed({ draftId: 'd1', retryable: true, savedCount: 1 }), { drafts: [draft] });
  assert.notEqual(primary(html), '再试一次');
  assert.match(linksOf(html), /调整时限/);
});
