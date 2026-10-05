import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// 任务 归档 and 批量删除 in the console, drawn from the snapshot: a checkbox on finished rows, the bar of the selection, the 已归档 filter, a read-only detail for
// an archived task, and the confirmation that says what is and is not removed. Static markup in both languages; the clicks are in tests/task-console-browser.test.mjs.
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { default as SelectBar } from './ui/tasks/SelectBar.jsx';
  export { default as DeleteTasksDialog } from './ui/tasks/DeleteTasksDialog.jsx';
  export { jobContract, archivedContract } from './lib/job-contract.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const iso = (minutes) => new Date(Date.UTC(2026, 9, 5, 10, minutes)).toISOString();
const live = () => [
  { id: 'audio-1', type: 'audio-import', filename: '录音一', status: 'running', phase: 'proofread', startedAt: iso(2), members: [{ filename: 'a.mp3', status: 'running', steps: {} }] },
  { id: 'gen-1', status: 'complete', deckTitle: '架构的语境性', requestedTotal: 15, savedCount: 15, startedAt: iso(40), finishedAt: iso(50) },
  { id: 'pdf-1', type: 'pdf-convert', filename: 'Software Architecture.pdf', status: 'failed', phase: 'parse', done: 120, total: 412, stage: '密钥被拒（403）', startedAt: iso(20) },
];
const archivedRecord = (id, title, status, minutes, extra = {}) => {
  const job = { id, deckTitle: title, status, startedAt: iso(minutes), finishedAt: iso(minutes + 5), requestedTotal: 10, savedCount: 10, ...extra };
  const contract = m.archivedContract(m.jobContract(job), iso(minutes + 6));
  return { id, status, startedAt: iso(minutes), archived: { at: iso(minutes + 6) }, contract };
};
const render = ({ data = {}, props = {}, language = 'zh' } = {}) => {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: { jobs: live(), archivedJobs: [], drafts: [], decks: [], ...data }, openers: { resultOf: () => null }, ...props }),
      { data: { jobs: live() }, app: { lib: { taskFocus: null } } }));
  } finally { m.setUiLanguage('zh'); }
};

test('the filters are 全部, 进行中, 失败 and 已归档, each with its count, in both languages; 已归档 counts the archived ones only', () => {
  const data = { archivedJobs: [archivedRecord('o1', '旧题组', 'complete', 1), archivedRecord('o2', '另一个', 'failed', 3)] };
  const zh = render({ data });
  for (const text of ['全部 3', '进行中 1', '失败/中断 1', '已归档 2']) assert.match(zh, new RegExp(text), text);
  const en = render({ data, language: 'en' });
  for (const text of ['All 3', 'In progress 1', 'Failed / interrupted 1', 'Archived 2']) assert.match(en, new RegExp(text), text);
  assert.match(render(), /已归档 0/, 'the filter is there with nothing archived');
});

test('a checkbox on every FINISHED row and none on a running one; each is named by its task', () => {
  const html = render();
  const checks = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0]).filter((tag) => /选择任务/.test(tag));
  assert.equal(checks.length, 2, 'gen-1 (complete) and pdf-1 (failed)');
  assert.ok(checks.some((tag) => /选择任务：架构的语境性/.test(tag)));
  assert.ok(checks.some((tag) => /选择任务：Software Architecture\.pdf/.test(tag)));
  assert.doesNotMatch(html, /选择任务：录音一/);
  const running = html.slice(html.indexOf('data-task-id="audio-1"') - 200, html.indexOf('data-task-id="audio-1"') + 50);
  assert.doesNotMatch(running, /type="checkbox"/);
  assert.equal((html.match(/class="tc-item"/g) || []).length, 3, 'a row wrapper per task, selectable or not, so the rows line up');
  assert.match(render({ language: 'en' }), /aria-label="Select job: 架构的语境性"|aria-label="Select job: /);
});

test('the bar of the selection has one fixed place: 全选当前筛选 with nothing selected, the count and the three actions with some', () => {
  m.setUiLanguage('zh');
  const idle = renderToStaticMarkup(inApp(m, React.createElement(m.SelectBar, { filter: 'all', summary: { count: 0, selectable: 2, all: false }, onToggleAll() {}, onArchive() {}, onUnarchive() {}, onDelete() {}, onClear() {} }), { data: {} }));
  assert.match(idle, /全选当前筛选/);
  assert.doesNotMatch(idle, /<button[^>]*>(归档|删除|取消选择)</, 'no action buttons without a selection');
  const picked = renderToStaticMarkup(inApp(m, React.createElement(m.SelectBar, { filter: 'all', summary: { count: 2, selectable: 4, all: false }, onToggleAll() {}, onArchive() {}, onUnarchive() {}, onDelete() {}, onClear() {} }), { data: {} }));
  assert.match(picked, /已选 2/);
  for (const label of ['归档', '删除', '取消选择']) assert.match(picked, new RegExp(`>${label}<`), label);
  assert.doesNotMatch(picked, />取消归档</, 'on the live list the first action is 归档');
  const archived = renderToStaticMarkup(inApp(m, React.createElement(m.SelectBar, { filter: 'archived', summary: { count: 1, selectable: 1, all: true }, onToggleAll() {}, onArchive() {}, onUnarchive() {}, onDelete() {}, onClear() {} }), { data: {} }));
  assert.match(archived, />取消归档</);
  assert.doesNotMatch(archived, />归档</);
  assert.match(archived, /<input[^>]*checked=""/, 'everything selected: the box is checked');
  const none = renderToStaticMarkup(inApp(m, React.createElement(m.SelectBar, { filter: 'running', summary: { count: 0, selectable: 0, all: false }, onToggleAll() {}, onArchive() {}, onUnarchive() {}, onDelete() {}, onClear() {} }), { data: {} }));
  assert.match(none.match(/<input[^>]*>/)[0], /disabled=""/, 'nothing to select in 进行中');
  m.setUiLanguage('en');
  try {
    const en = renderToStaticMarkup(inApp(m, React.createElement(m.SelectBar, { filter: 'all', summary: { count: 2, selectable: 4, all: false }, onToggleAll() {}, onArchive() {}, onUnarchive() {}, onDelete() {}, onClear() {} }), { data: {} }));
    assert.match(en, /2 selected/);
    for (const label of ['Archive', 'Delete', 'Clear']) assert.match(en, new RegExp(`>${label}<`), label);
    assert.doesNotMatch(en, /[一-鿿]/, 'English has no Chinese in it');
  } finally { m.setUiLanguage('zh'); }
});

test('a finished task keeps 知道了, which now says where the task goes, and offers 删除; a running one offers neither', () => {
  const finished = render({ data: { jobs: [live()[2]] } });
  const detail = finished.slice(finished.indexOf('class="tc-detail"'));
  assert.match(detail, />知道了</);
  assert.match(detail, /已归档/, 'the words next to the button say it goes to 已归档, it is not deleted');
  assert.match(detail, />删除</);
  const running = render({ data: { jobs: [live()[0]] } });
  const runningDetail = running.slice(running.indexOf('class="tc-detail"'));
  assert.doesNotMatch(runningDetail, />知道了</);
  assert.doesNotMatch(runningDetail, />删除</);
  const en = render({ data: { jobs: [live()[2]] }, language: 'en' });
  assert.match(en.slice(en.indexOf('class="tc-detail"')), />Got it</);
  assert.match(en, /Archived/);
});

test('the archived list shows archived tasks read-only: 取消归档 and 删除, no 暂停, 继续, 接着做 or 停止, a note that says what archived means', () => {
  const data = { archivedJobs: [archivedRecord('o1', '旧题组', 'failed', 1, { retryable: true }), archivedRecord('o2', '另一个', 'complete', 3)] };
  const html = render({ data, props: { initialFilter: 'archived' } });
  const list = html.slice(html.indexOf('aria-label="任务列表"'), html.indexOf('class="tc-detail"'));
  assert.match(list, /data-task-id="o2"/);
  assert.match(list, /data-task-id="o1"/);
  assert.doesNotMatch(list, /data-task-id="gen-1"/, 'the live tasks are not in this list');
  assert.ok(list.indexOf('data-task-id="o2"') < list.indexOf('data-task-id="o1"'), 'the one archived last is first');
  const detail = html.slice(html.indexOf('class="tc-detail"'));
  assert.match(detail, /data-archived="true"/);
  assert.match(detail, />取消归档</);
  assert.match(detail, />删除</);
  for (const gone of ['>暂停<', '>继续<', '>接着做<', '>停止<', '>知道了<']) assert.ok(!detail.includes(gone), gone);
  assert.match(detail, /只读/);
  const en = render({ data, props: { initialFilter: 'archived' }, language: 'en' });
  assert.match(en.slice(en.indexOf('class="tc-detail"')), />Unarchive</);
  assert.match(en, /read-only/i);
});

test('an archived task renders like a finished one: its title, kind, state and progress come from the stored contract', () => {
  const data = { archivedJobs: [archivedRecord('o1', '旧题组', 'complete', 1)] };
  const html = render({ data, props: { initialFilter: 'archived' } });
  assert.match(html, /<h2>旧题组<\/h2>/);
  assert.match(html, /出题/);
  assert.match(html, /data-status="complete"/);
});

test('the confirmation says what is removed (the task record; for audio the working copy) and what is NOT (sources, drafts, decks)', () => {
  m.setUiLanguage('zh');
  const out = renderToStaticMarkup(React.createElement(m.DeleteTasksDialog, { count: 3, archived: 1, audio: 2, onConfirm() {}, onClose() {} }));
  assert.match(out, /删除 3 个任务？/);
  assert.match(out, /任务记录/);
  assert.match(out, /其中 1 个在「已归档」里/);
  assert.match(out, /2 个音频任务/);
  assert.match(out, /工作副本/);
  assert.match(out, /不会删除/);
  for (const kept of ['已导入的资料', '草稿', '题组']) assert.match(out, new RegExp(kept), kept);
  assert.match(out, /不能撤销|无法恢复/);
  const footer = out.match(/<footer[^>]*>(.*)<\/footer>/s)[1];
  const buttons = [...footer.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
  assert.equal(buttons.length, 2);
  assert.match(buttons[0], /sh-btn--quiet/);
  assert.match(buttons[1], /sh-btn--danger/);
  assert.ok(footer.indexOf('取消') < footer.indexOf('确认删除'));
  const plain = renderToStaticMarkup(React.createElement(m.DeleteTasksDialog, { count: 1, archived: 0, audio: 0, onConfirm() {}, onClose() {} }));
  assert.doesNotMatch(plain, /工作副本/, 'no audio, no working copy to talk about');
  assert.doesNotMatch(plain, /在「已归档」里/);
  m.setUiLanguage('en');
  try {
    const en = renderToStaticMarkup(React.createElement(m.DeleteTasksDialog, { count: 3, archived: 1, audio: 2, onConfirm() {}, onClose() {} }));
    assert.match(en, /Delete 3 jobs\?/);
    assert.match(en, /working copy/);
    assert.match(en, /Not deleted/i);
    assert.doesNotMatch(en, /[一-鿿]/);
    assert.match(renderToStaticMarkup(React.createElement(m.DeleteTasksDialog, { count: 1, archived: 0, audio: 0, onConfirm() {}, onClose() {} })), /Delete this job\?/);
  } finally { m.setUiLanguage('zh'); }
});

test('a past day of 为你定制 has no box and no 删除: 知道了 removes it as before (its file keeps fourteen days), it is not archived', () => {
  const day = { id: 'coach:2026-10-01', type: 'coach-daily', date: '2026-10-01', status: 'complete', today: false, startedAt: iso(0),
    coachDaily: { date: '2026-10-01', batches: [], metrics: {}, tokens: { input: 0, output: 0, cache: 0 }, paused: false, limits: null } };
  const html = render({ data: { jobs: [day] } });
  assert.equal([...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].filter((match) => /选择任务/.test(match[0])).length, 0, 'no box on a day');
  const detail = html.slice(html.indexOf('class="tc-detail"'));
  assert.match(detail, />知道了</);
  assert.match(detail, /只保留最近 14 天/);
  assert.doesNotMatch(detail, />删除</);
});
