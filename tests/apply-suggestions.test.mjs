import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { StudyService } from '../lib/service.js';
import { generationControl } from '../lib/job-control.js';
import { GENERATION_SETTINGS_DEFAULTS, normalizeGenerationSettings, resolveGenerationRequest } from '../lib/generation-settings.js';

// "Apply the review's suggestions" (applySuggestions): off by default, one more rewrite and one more review when on. Settings, live control, the console's row and the draft's note.
// What the generation does with it is tests/generation-review-severity.test.mjs.
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export * from './ui/tasks/task-control.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const EFFORTS = ['effortPlanning', 'effortReview', 'effortWriting', 'effortRepair'];
const generation = (applySuggestions) => ({ id: 'g1', status: 'running', deckTitle: 'Deck', requestedTotal: 10, savedCount: 2, startedAt: '2026-10-05T10:00:00.000Z', paused: false,
  control: { values: { concurrency: 4, applySuggestions, ...Object.fromEntries(EFFORTS.map((key) => [key, 'follow'])) },
    limits: { concurrency: { type: 'int', min: 1, max: 8 }, applySuggestions: { type: 'bool' }, ...Object.fromEntries(EFFORTS.map((key) => [key, { type: 'enum', values: ['follow', 'low', 'high'] }])) } } });
const render = (job, language = 'zh') => {
  m.setUiLanguage(language);
  const html = renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: { jobs: [job], drafts: [], decks: [] }, openers: { resultOf: () => null } }),
    { data: { jobs: [job] }, app: { lib: { taskFocus: null } } }));
  m.setUiLanguage('zh');
  return html;
};

test('the setting is a boolean that is off by default and refuses anything else', () => {
  assert.equal(GENERATION_SETTINGS_DEFAULTS.applySuggestions, false);
  assert.equal(normalizeGenerationSettings({ applySuggestions: true }).applySuggestions, true);
  assert.equal(normalizeGenerationSettings({ applySuggestions: 'yes' }).applySuggestions, false, 'a corrupt saved value falls back');
  assert.equal(normalizeGenerationSettings({ applySuggestions: 1 }).applySuggestions, false);
});

test('a continued draft follows the setting as it is now, like the time limit; a one-off choice wins', () => {
  const continuation = { kind: 'quiz', performance: { concurrency: 1, batchSize: 3 } };
  assert.equal(resolveGenerationRequest({ ...GENERATION_SETTINGS_DEFAULTS, applySuggestions: true }, {}, { continuation }).performance.applySuggestions, true);
  assert.equal(resolveGenerationRequest({ ...GENERATION_SETTINGS_DEFAULTS, applySuggestions: false }, {}, { continuation: { ...continuation, performance: { applySuggestions: true } } }).performance.applySuggestions, false);
  assert.equal(resolveGenerationRequest({ ...GENERATION_SETTINGS_DEFAULTS }, { performance: { applySuggestions: true } }, { continuation }).performance.applySuggestions, true);
  assert.equal(resolveGenerationRequest({ ...GENERATION_SETTINGS_DEFAULTS, applySuggestions: true }, {}).performance.applySuggestions, true, 'new work takes the saved setting');
});

test('a running generation job can switch it live, from the value it started with', () => {
  assert.equal(generationControl({ job: {}, request: { performance: {} } }).values.applySuggestions, false);
  const control = generationControl({ job: {}, request: { performance: { applySuggestions: true } } });
  assert.equal(control.values.applySuggestions, true);
  assert.deepEqual(control.spec.applySuggestions, { type: 'bool' });
  assert.equal(control.patch({ applySuggestions: false }).applied.applySuggestions, false);
  assert.equal(control.values.applySuggestions, false);
  assert.throws(() => control.patch({ applySuggestions: 'on' }), /applySuggestions/);
});

test('settings saves and returns it, and rejects a non-boolean before anything changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-apply-suggestions-'));
  const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = join(root, 'home');
  const service = new StudyService(root, { complete: async () => '{}', coach: false, language: 'zh' });
  t.after(async () => { await service.dispose(); if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  assert.equal((await service.call('snapshot')).settings.generation.applySuggestions, false);
  await service.call('settings', { generation: { applySuggestions: true } });
  assert.equal((await service.call('snapshot')).settings.generation.applySuggestions, true);
  await assert.rejects(service.call('settings', { generation: { applySuggestions: 'yes' } }), /applySuggestions/);
  assert.equal((await service.call('snapshot')).settings.generation.applySuggestions, true, 'a refused patch changes nothing');
});

test('the console row draws a checkbox for it, in both languages, and 存为默认 writes it with the others', () => {
  const html = render(generation(false));
  assert.match(html, /data-control="applySuggestions"/);
  assert.match(html, /采纳审阅建议/);
  assert.doesNotMatch(html.slice(html.indexOf('data-control="applySuggestions"'), html.indexOf('data-control="applySuggestions"') + 400), /checked/);
  assert.match(render(generation(true)).slice(render(generation(true)).indexOf('data-control="applySuggestions"')), /checked/);
  assert.match(render(generation(false), 'en'), /Apply review suggestions/);
  const patch = m.defaultsPatch(generation(true));
  assert.equal(patch.action, 'settings');
  assert.equal(patch.args.generation.applySuggestions, true);
  assert.equal(m.appliedText({ applySuggestions: true }), '✓ 已生效 · 采纳审阅建议：开');
});
