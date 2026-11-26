import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { click, loadInteractiveUi, textOf, withBrowserGlobals } from './helpers/react-harness.mjs';

// 任务 归档 and 批量删除 in the console, drawn from the snapshot: a checkbox on finished rows, the bar of the selection, the 已归档 filter, a read-only detail for
// an archived task, and the confirmation that says what is and is not removed. Static markup in both languages; the clicks are in tests/task-console-browser.test.mjs.
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { default as SelectBar } from './ui/tasks/SelectBar.jsx';
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

test('a finished task has 归档 (it was 知道了), which now says where the task goes, and offers 删除; a running one offers neither', () => {
  const finished = render({ data: { jobs: [live()[2]] } });
  const detail = finished.slice(finished.indexOf('class="tc-detail"'));
  assert.match(detail, />归档</);
  assert.match(detail, /已归档/, 'the words next to the button say it goes to 已归档, it is not deleted');
  assert.doesNotMatch(detail, />删除</, '删除 is not a button of the row: it is the item of the ⋯ menu (#668, tests/danger-menu.test.mjs)');
  assert.match(detail, /aria-haspopup="menu"[^>]*aria-label="更多操作"|aria-label="更多操作"[^>]*aria-haspopup="menu"/, 'one step away');
  const running = render({ data: { jobs: [live()[0]] } });
  const runningDetail = running.slice(running.indexOf('class="tc-detail"'));
  assert.doesNotMatch(runningDetail, />归档</);
  assert.doesNotMatch(runningDetail, />删除</);
  const en = render({ data: { jobs: [live()[2]] }, language: 'en' });
  assert.match(en.slice(en.indexOf('class="tc-detail"')), />Archive</);
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
  assert.doesNotMatch(detail, />删除</, '删除 is behind the ⋯ of the header (#668), not beside 取消归档');
  assert.match(detail, /aria-label="更多操作"/);
  for (const gone of ['>暂停<', '>继续<', '>接着做<', '>停止<', '>归档<']) assert.ok(!detail.includes(gone), gone);
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

test('删除 of task records asks nothing: hides finished rows with a 撤销 notice, restores on undo, commits only finished keys, and never deletes a running task', async () => {
  assert.equal(existsSync('ui/tasks/DeleteTasksDialog.jsx'), false, 'the old confirm dialog file is gone');

  const ui = await loadInteractiveUi(`
    export { AppContext } from './ui/app/app-context.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { ToastContext, createToastApi } from './ui/components/Feedback.jsx';
    export { QuickActionsContext, createQuickActions } from './ui/quick-actions.js';
    export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const { AppContext, StudyServicesContext, ToastContext, createToastApi, QuickActionsContext, createQuickActions, TaskConsole, setUiLanguage } = ui.exports;
  const h = ui.React.createElement;

  const prevCss = globalThis.CSS;
  globalThis.CSS = { escape: (value) => String(value) };
  const focusedSelectors = [];

  await withBrowserGlobals(async () => {
    setUiLanguage('zh');
    const hostCalls = [];
    const notices = [];
    const errors = [];

    const call = async (action, args) => {
      hostCalls.push({ action, args });
      if (action === 'job.delete') return { deleted: args.jobIds, skipped: [] };
      return { ok: true };
    };
    const quickController = createQuickActions({ call, timers: false });
    const toast = createToastApi({
      setNotice: (entry) => { if (entry) notices.push(entry); },
      setError: (entry) => { if (entry) errors.push(entry); },
    });

    const snapshot = { root: '/tmp/study-tasks', jobs: live(), archivedJobs: [], drafts: [], decks: [] };
    const appValue = {
      language: 'zh',
      host: {},
      data: snapshot,
      connection: { binding: { root: snapshot.root } },
      core: { call, act: async () => undefined, busy: false, notify: (text) => notices.push({ text }), setError: (text) => errors.push({ text }), refresh: async () => {} },
      lib: { taskFocus: null },
      settingsEntry: {},
      learn: {},
    };
    const studyValue = { call, act: async () => undefined, busy: false, notify: () => {}, host: {} };

    const mounted = ui.mount(() => h(
      StudyServicesContext.Provider,
      { value: studyValue },
      h(
        AppContext.Provider,
        { value: appValue },
        h(
          ToastContext.Provider,
          { value: toast },
          h(
            QuickActionsContext.Provider,
            { value: quickController.snapshot() },
            h(TaskConsole, { data: snapshot, openers: { resultOf: () => null } }),
          ),
        ),
      ),
    ));

    const visibleTaskIds = () => mounted.findAll((node) => node.type === 'button' && typeof node.props?.['data-task-id'] === 'string').map((node) => node.props['data-task-id']);
    const findSelectAllCheckbox = () => {
      const pickbar = mounted.find((node) => typeof node.props?.className === 'string' && node.props.className.includes('tc-pickbar'));
      assert.ok(pickbar, 'SelectBar (.tc-pickbar) is rendered');
      const box = mounted.find((node) => node.type === 'input' && node.props?.type === 'checkbox', pickbar);
      assert.ok(box, 'SelectBar select-all checkbox is rendered');
      return box;
    };
    const findDeleteButton = () => mounted.find((node) => node.type === 'button' && textOf(node).trim() === '删除');

    try {
      assert.deepEqual(visibleTaskIds().sort(), ['audio-1', 'gen-1', 'pdf-1']);

      // Select all selectable rows (only finished gen-1 and pdf-1; running audio-1 stays unselected)
      await mounted.act(() => findSelectAllCheckbox().props.onChange({ target: { checked: true } }));
      const deleteBtn = findDeleteButton();
      assert.ok(deleteBtn, 'SelectBar exposes 删除 once finished tasks are selected');

      // Click 删除 -> no modal dialog, finished tasks hide immediately, running task stays, undo toast appears, host not called yet
      await mounted.act(() => click(deleteBtn));
      assert.equal(mounted.find((node) => node.type === 'dialog' || node.props?.role === 'dialog'), null, 'no confirmation modal dialog is opened');
      assert.deepEqual(visibleTaskIds(), ['audio-1'], 'finished tasks hide immediately while running task stays visible');
      assert.equal(hostCalls.length, 0, 'job.delete is deferred until the undo notice leaves');

      const undoNotice = notices.at(-1);
      assert.equal(undoNotice?.undo, true);
      assert.equal(undoNotice?.action?.label, '撤销');
      assert.equal(typeof undoNotice?.action?.run, 'function');

      // Click 撤销 before commit -> finished tasks return immediately, focus returns to restored row, and host is never called
      await mounted.act(() => undoNotice.action.run());
      assert.deepEqual(visibleTaskIds().sort(), ['audio-1', 'gen-1', 'pdf-1'], '撤销 restores hidden finished tasks');
      assert.equal(hostCalls.length, 0, '撤销 prevents job.delete from being sent');
      // Let ui/undoable.js's 30ms post-undo refocus settle before tearing down browser globals.
      const focusDeadline = Date.now() + 500;
      while (focusedSelectors.length === 0 && Date.now() < focusDeadline) {
        await new Promise((done) => setTimeout(done, 15));
      }
      assert.equal(focusedSelectors.length, 1, 'focus returns to the restored task row after 撤销');

      // Delete again and let the undo notice leave -> commits job.delete for finished keys only (never audio-1)
      await mounted.act(() => findSelectAllCheckbox().props.onChange({ target: { checked: true } }));
      await mounted.act(() => click(findDeleteButton()));
      assert.deepEqual(visibleTaskIds(), ['audio-1']);

      const secondNotice = notices.at(-1);
      assert.equal(typeof secondNotice?.onLeave, 'function');
      await mounted.act(async () => {
        secondNotice.onLeave();
        await Promise.resolve();
      });
      await mounted.flush(5);

      const deleteCalls = hostCalls.filter((entry) => entry.action === 'job.delete');
      assert.equal(deleteCalls.length, 1, 'commits job.delete once when the undo notice leaves');
      assert.deepEqual([...deleteCalls[0].args.jobIds].sort(), ['gen-1', 'pdf-1'], 'only finished task ids are sent to job.delete');
      assert.ok(!deleteCalls[0].args.jobIds.includes('audio-1'), 'running task is never sent to job.delete');
      assert.deepEqual(visibleTaskIds(), ['audio-1'], 'running task stays visible after commit');
      assert.deepEqual(errors, []);
    } finally {
      mounted.unmount();
      setUiLanguage('zh');
      if (prevCss === undefined) delete globalThis.CSS;
      else globalThis.CSS = prevCss;
    }
  }, {
    document: {
      querySelector: (selector) => ({ focus: () => { focusedSelectors.push(selector); } }),
    },
  });
});

test('a past day of 为你定制 has no box and no 删除 button: the item of its ⋯ menu says it deletes the day (its file keeps fourteen days), it is not archived', () => {
  const day = { id: 'coach:2026-10-01', type: 'coach-daily', date: '2026-10-01', status: 'complete', today: false, startedAt: iso(0),
    coachDaily: { date: '2026-10-01', batches: [], metrics: {}, tokens: { input: 0, output: 0, cache: 0 }, paused: false, limits: null } };
  const html = render({ data: { jobs: [day] } });
  assert.equal([...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].filter((match) => /选择任务/.test(match[0])).length, 0, 'no box on a day');
  const detail = html.slice(html.indexOf('class="tc-detail"'));
  assert.doesNotMatch(detail, />删除这一天</, 'the item is in the menu (tests/danger-menu.test.mjs), not a button of the row');
  assert.match(detail, /aria-label="更多操作"/);
  assert.doesNotMatch(detail, />归档</, '归档 archives, and a day is not archived');
  assert.doesNotMatch(detail, />删除</);
});

// 2.6.2: what a keyboard or a screen reader gets from the bar and the header (the measurements are in tests/task-console-browser.test.mjs).
test('the bar of the selection announces its count, takes the focus when the selection ends, opens its words in the top layer, and 删除 has the one destructive look (bar and header)', () => {
  m.setUiLanguage('zh');
  const bar = (summary, filter = 'all') => renderToStaticMarkup(inApp(m, React.createElement(m.SelectBar, { filter, summary, onToggleAll() {}, onArchive() {}, onUnarchive() {}, onDelete() {}, onClear() {} }), { data: {} }));
  const picked = bar({ count: 2, selectable: 4, all: false });
  assert.match(picked, /<div class="tc-pickbar"[^>]*tabindex="-1"/, 'the bar can take the focus when the buttons that had it go away');
  assert.match(picked, /role="group"[^>]*aria-label="批量操作"/);
  assert.match(picked, /<span class="sh-visually-hidden" role="status">已选 2<\/span>/, 'the count is a polite status');
  assert.match(bar({ count: 0, selectable: 2, all: false }), /<span class="sh-visually-hidden" role="status"><\/span>/, 'nothing selected, nothing announced');
  assert.match(picked, /<span[^>]*role="tooltip"[^>]*popover="manual"/, 'the words of the box are in the top layer: the list column cannot clip them');
  assert.match(picked, /aria-describedby=/, 'and the box is described by them');
  const remove = picked.match(/<button[^>]*>删除<\/button>/)[0];
  assert.match(remove, /sh-btn--danger/);
  assert.doesNotMatch(picked.match(/<button[^>]*>归档<\/button>/)[0], /sh-btn--danger/, '归档 is not the destructive one');
  assert.match(picked.match(/<button[^>]*>取消选择<\/button>/)[0], /sh-btn--quiet/);
  const data = { archivedJobs: [archivedRecord('o1', '旧题组', 'complete', 1)] };
  const archived = render({ data, props: { initialFilter: 'archived' } });
  const head = archived.slice(archived.indexOf('class="tc-head__actions"'), archived.indexOf('aria-label="概览"'));
  assert.doesNotMatch(head, /<button[^>]*>删除<\/button>/, '删除 in the header is the item of the ⋯ menu, in the danger colour (tests/danger-menu.test.mjs)');
  assert.doesNotMatch(head.match(/<button[^>]*>取消归档<\/button>/)[0], /sh-btn--danger/);
  // each box of a row is named by its task; the row that is open says so (aria-pressed)
  const list = render();
  assert.match(list, /aria-pressed="true"[^>]*data-task-id=/);
});
