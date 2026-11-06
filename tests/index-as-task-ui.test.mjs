import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* The search-index build in the 任务 console and in the extension panel: the console's tile says it runs locally without a model,
   and the panel's progress links to the build's task when it is one (a build of the original background run has no task). */

const m = await loadUi(`
  export { default as ExtensionPanel } from './ui/ExtensionPanel.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { taskFacts } from './ui/tasks/task-facts.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const render = (element, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { m.setUiLanguage('zh'); } };

const installed = { selected: 'builtin', effective: 'builtin', providers: [], otherTools: [], hostCanSearch: true,
  extension: { canInstall: true, installed: true, enabled: true, version: '2.1.1', desktop: false }, companion: { id: 'mcp:mcp__studyhub__query_documents', running: true } };
const plan = { course: 'OS', pages: 513, toIndex: 513, unchanged: 0, toRemove: 0, chars: 24000, firstRun: false, modelMb: 90, canIndex: true };
const running = { status: 'running', stage: 'indexing', done: 3, total: 513, course: 'OS' };
const app = { nav: { show: { task: () => {} } } };
const panel = (run, { inApp = true, language } = {}) => {
  const element = h(m.ExtensionPanel, { status: installed, courses: ['OS'], defaultCourse: 'OS', initialPlan: plan, initialRun: run });
  return render(inApp ? h(m.AppContext.Provider, { value: app }, element) : element, language);
};

test('a running build that is a task links to it from the panel, beside the progress and the stop', () => {
  const html = panel({ ...running, taskId: 'job-1' });
  assert.match(html, /正在建立索引 3 \/ 513 页/);
  assert.match(html, /停止/);
  assert.match(html, /在任务里查看/);
  assert.match(panel({ ...running, taskId: 'job-1' }, { language: 'en' }), /View in Jobs/);
});

test('a failed build that is a task links to it for the whole reason', () => {
  const html = panel({ status: 'failed', taskId: 'job-1', error: '连续 5 页没能写入索引，已停止：refused', errorCode: 'retrieval-index-failed' });
  assert.match(html, /连续 5 页没能写入索引/);
  assert.match(html, /在任务里查看/);
});

test('no link for a build of the original background run, nor outside the app (a preview, a test)', () => {
  assert.doesNotMatch(panel(running), /在任务里查看/);
  assert.doesNotMatch(panel({ ...running, taskId: 'job-1' }, { inApp: false }), /在任务里查看/);
});

test('the console says a search-index build runs on this computer and asks no model, in both languages', () => {
  const job = { id: 'job-1', type: 'retrieval-index', contract: { jobId: 'job-1', kind: 'retrieval-index', status: 'running', title: '建立检索索引 · OS',
    progress: { done: 3, total: 513, unit: 'pages', percent: 0, segments: [] }, usage: { tokens: null, tokenUsage: null, calls: 0 },
    calls: [{ id: 'c1', kind: 'index', status: 'running', observation: { boundary: 'local-process', requestCount: null } }], detail: { index: {} },
    stage: { code: 'retrieval.indexing', args: { done: 3, total: 513 }, text: '正在建立索引 3 / 513 页' }, startedAt: new Date().toISOString() } };
  const facts = m.taskFacts(job);
  assert.equal(facts.find(fact => fact.key === 'primary').value, '3 / 513');
  const calls = facts.find(fact => fact.key === 'calls');
  assert.deepEqual([calls.label, calls.value], ['运行方式', '本机 · 不调用 AI，不花 token']);
  m.setUiLanguage('en');
  try {
    const en = m.taskFacts(job).find(fact => fact.key === 'calls');
    assert.deepEqual([en.label, en.value], ['How it runs', 'On this computer · no AI, no tokens']);
  } finally { m.setUiLanguage('zh'); }
});
