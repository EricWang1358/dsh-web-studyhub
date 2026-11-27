import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* #1691: a finished task shows its result first. The timeline, the live output, the requests and the log are behind one closed 「运行记录」, and no panel
   that only says the task has ended is drawn (a finished run said it three times over four near-empty panels). A running task is as it was. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const at = (seconds) => new Date(2026, 9, 5, 10, 0, seconds).toISOString();
const run = (extra = {}) => ({ id: 'g1', status: 'complete', deckTitle: 'Deck', requestedTotal: 10, savedCount: 10, parts: 1, startedAt: at(0), finishedAt: at(50), draftId: 'd1',
  steps: [{ id: 'a', stage: 'Writing and self-checking questions', part: 1, status: 'complete', startedAt: at(1), finishedAt: at(20) },
    { id: 'r', stage: 'Reviewing ambiguity and source support', part: 1, status: 'complete', startedAt: at(21), finishedAt: at(40) }], ...extra });
const render = (job, language = 'zh') => {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: { jobs: [job], drafts: [], decks: [] }, openers: { resultOf: () => ({ label: '检查草稿', run() {} }) } }),
      { data: { jobs: [job] }, app: { lib: { taskFocus: null } } }));
  } finally { m.setUiLanguage('zh'); }
};
const detailOf = (html) => html.slice(html.indexOf('class="tc-detail"'));
const tabs = (html) => [...detailOf(html).matchAll(/role="tab"[^>]*>(?:<[^>]+>)*([^<]*)/g)].map((match) => match[1].trim());
const ENDED = /任务已经结束|The job has ended/g;

test('a finished run: result and next step first, the run record closed, nothing that only says it ended', () => {
  const html = detailOf(render(run()));
  assert.equal((html.match(ENDED) || []).length, 0, 'no sentence that only says it ended');
  assert.doesNotMatch(html, /aria-label="即时控制"/, 'nothing to adjust, so no row about adjusting');
  const record = /<details class="sh-disclosure[^"]*tc-record[^"]*"(?![^>]*\sopen=)[^>]*>(.*?)<\/details>/s.exec(html);
  assert.ok(record, 'one closed fold');
  assert.match(record[1], />运行记录</);
  assert.doesNotMatch(html, /tc-timeline|tc-output|tc-log|实时输出|实际请求|正在进行/, 'timeline, output, requests, calls in flight and log are not drawn by default');
  assert.deepEqual(tabs(render(run())).map((label) => label.replace(/\s*\d+.*$/, '')), ['轮次与批次', '目标与知识点'], 'what the run made stays in sight');
  assert.ok(html.indexOf('检查草稿') >= 0 && html.indexOf('检查草稿') < html.indexOf('运行记录'), 'the next step comes before the record');
});

test('a failed run keeps its cause in sight and the row that says how to go on', () => {
  const html = detailOf(render(run({ status: 'failed', savedCount: 3, error: 'fetch failed', stage: 'fetch failed', retryable: true })));
  const cause = /<p class="tc-result" data-state="fail"[^>]*>([^<]+)<\/p>/.exec(html);
  assert.ok(cause, 'the cause is on the page, not only inside the closed record');
  assert.ok(html.indexOf('tc-result') < html.indexOf('tc-record'));
  assert.match(html, /aria-label="即时控制"/);
  assert.match(html, /已出的题都保留着/);
});

test('a running run is as it was: the controls, the timeline, the calls in flight and the output, with no fold', () => {
  const html = detailOf(render(run({ status: 'running', finishedAt: undefined, savedCount: 2,
    steps: [{ id: 'a', stage: 'Writing and self-checking questions', part: 1, status: 'running', startedAt: at(1) }] })));
  assert.match(html, /aria-label="即时控制"/);
  assert.match(html, /tc-timeline/);
  assert.match(html, /tc-output/);
  assert.doesNotMatch(html, /tc-record|运行记录/);
  assert.match(tabs(`class="tc-detail"${html}`)[0], /^正在进行 1/);
});

test('English: the fold is Run record and nothing says the job ended', () => {
  const html = detailOf(render(run(), 'en'));
  assert.match(html, />Run record</);
  assert.equal((html.match(ENDED) || []).length, 0);
});
