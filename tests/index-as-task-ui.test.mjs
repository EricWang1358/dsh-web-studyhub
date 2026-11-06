import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* The search-index build in the 任务 console and in the extension panel: the console's tile says it runs locally without a model,
   and the panel's progress links to the build's task when it is one (a build of the original background run has no task). */

const m = await loadUi(`
  export { default as ExtensionPanel } from './ui/ExtensionPanel.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { taskFacts } from './ui/tasks/task-facts.js';
  export { taskSummary } from './ui/tasks/task-summary.js';
  export { default as TaskBody } from './ui/tasks/TaskBody.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
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

const indexJob = () => ({ id: 'job-1', type: 'retrieval-index', contract: { jobId: 'job-1', kind: 'retrieval-index', status: 'running', title: '建立检索索引 · OS',
    progress: { done: 3, total: 513, unit: 'pages', percent: 0, segments: [] }, usage: { tokens: null, tokenUsage: null, calls: 0 },
    calls: [{ id: 'c1', kind: 'index', status: 'running', observation: { boundary: 'local-process', requestCount: null } }], detail: { index: {} },
    stage: { code: 'retrieval.indexing', args: { done: 3, total: 513 }, text: '正在建立索引 3 / 513 页' }, startedAt: new Date().toISOString() } });

test('the console names the build and its pages in the learner\'s language', () => {
  const zh = m.taskSummary(indexJob());
  assert.deepEqual([zh.title, zh.line, zh.state], ['建立检索索引 · OS', '正在建立索引 3 / 513 页', 'run']);
  m.setUiLanguage('en');
  try {
    const en = m.taskSummary(indexJob());
    assert.deepEqual([en.title, en.line], ['Search index · OS', 'Indexing 3 / 513 pages']);
  } finally { m.setUiLanguage('zh'); }
});

test('the console says a search-index build runs on this computer and asks no model, in both languages', () => {
  const job = indexJob();
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

const failedJob = () => {
  const job = indexJob();
  Object.assign(job.contract, { status: 'failed', progress: { done: 5, total: 513, unit: 'pages', percent: 0, segments: [] },
    stage: { code: 'retrieval.failed', args: { done: 5, total: 513 }, text: '连续 5 页没能写入索引，已停止：embedding server refused the page' },
    error: { code: 'retrieval-index-failed', message: '连续 5 页没能写入索引，已停止：embedding server refused the page' },
    detail: { index: { course: 'OS', phase: 'failed', unchanged: 2, skipped: 1, added: 0, removed: 0, failedCount: 5,
      failed: [{ id: 'p-1', message: 'embedding server refused the page' }, { id: 'p-2', message: 'embedding server refused the page' }], unconfirmed: [] } } });
  job.contract.calls[0].status = 'failed';
  return job;
};
const draw = (element, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(inApp(m, element, {})); } finally { m.setUiLanguage('zh'); } };

test('a failed build says its real cause in the list, in the learner\'s language', () => {
  assert.equal(m.taskSummary(failedJob()).line, '连续 5 页没能写入索引，已停止：embedding server refused the page');
  m.setUiLanguage('en');
  try { assert.equal(m.taskSummary(failedJob()).line, '5 pages in a row could not be written to the index; stopped: embedding server refused the page'); }
  finally { m.setUiLanguage('zh'); }
});

test('the detail of a build has no model-call panels, and an index section with what was written and which pages failed', () => {
  const running = draw(h(m.TaskBody, { task: indexJob() }));
  assert.doesNotMatch(running, /实时输出|正在进行 \d|直接模型调用/, 'a local build makes no model calls');
  assert.match(running, />索引详情</);
  const failed = draw(h(m.TaskBody, { task: failedJob() }));
  assert.match(failed, /没能写入 5 页/);
  assert.match(failed, /p-1/);
  assert.match(failed, /embedding server refused the page/);
  assert.match(failed, /无需更新 2 页/);
  const en = draw(h(m.TaskBody, { task: failedJob() }), 'en');
  assert.match(en, />Index details</);
  assert.match(en, /5 pages not written/);
});
