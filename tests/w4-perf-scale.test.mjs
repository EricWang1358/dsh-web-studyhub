import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = path.resolve(import.meta.dirname, '..');
const compiled = await build({
  stdin: {
    contents: `
      export { CoverageTopUp } from './ui/coverage/CoverageTopUp.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: ROOT,
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  loader: { '.css': 'text' },
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  createRequire(import.meta.url),
  mod,
  mod.exports,
);
const { CoverageTopUp, StudyServicesContext, setUiLanguage } = mod.exports;

const services = {
  act: async () => ({}),
  busy: false,
  call: async () => ({}),
  openSettings: () => {},
  notify: () => {},
};

const renderTopUp = (props) => renderToStaticMarkup(
  React.createElement(
    StudyServicesContext.Provider,
    { value: services },
    React.createElement(CoverageTopUp, props),
  ),
);

test('W4-01: CoverageTopUp demotes primary CTA and uses sm size in compact home draft rows while keeping primary on block draft view', () => {
  setUiLanguage('zh');
  const draft = {
    id: 'draft-1',
    title: 'Recovered questions',
    draftVersion: 3,
    cards: Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, kind: 'quiz' })),
    editorial: { requested: 15, generation: { sourceIds: ['s'], kind: 'quiz' } },
  };
  const failedJob = {
    id: 'j1',
    type: 'generate',
    status: 'failed',
    stage: 'Generation reached its 20-minute total budget; approved questions were retained',
    deckTitle: 'Recovered questions',
    draftId: 'draft-1',
    kind: 'quiz',
    count: 15,
    requestedTotal: 15,
    savedCount: 13,
    parts: 2,
    steps: [],
    retryable: true,
    startedAt: '2026-10-06T10:00:00.000Z',
    finishedAt: '2026-10-06T10:01:40.000Z',
  };

  const compactHtml = renderTopUp({ draft, jobs: [failedJob], modelReady: true, variant: 'compact' });
  assert.match(compactHtml, /data-shortfall-act="continue"/, 'renders continue action in compact home row');
  assert.doesNotMatch(compactHtml, /sh-btn--primary/, 'compact home row must not render a competing red primary button');
  assert.match(compactHtml, /sh-btn--sm/, 'compact home row uses compact sm button size');

  const blockHtml = renderTopUp({ draft, jobs: [failedJob], modelReady: true, variant: 'block' });
  assert.match(blockHtml, /data-shortfall-act="continue"/);
  assert.match(blockHtml, /sh-btn--primary/, 'block draft view retains primary button styling');

  const keyFailedJob = {
    ...failedJob,
    id: 'j2',
    error: 'Missing API key for provider',
    errorCode: 'NO_MODEL',
    stage: 'Missing API key',
    retryable: false,
  };
  const compactModelHtml = renderTopUp({ draft, jobs: [keyFailedJob], modelReady: false, variant: 'compact' });
  assert.doesNotMatch(compactModelHtml, /sh-btn--primary/, 'compact home row with missing key also avoids competing primary button');
});
