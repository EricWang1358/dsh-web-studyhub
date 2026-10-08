import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { viewOps } from '../lib/jobs/lifecycle/view.js';

/* Review items C-1 and C-2 of 3.1.0 (the console side). C-1: a result of kind exam-point-list is 「已保存考点清单」 and opens 备考补习, a source still reads 已存为 N 份资料.
   C-2: what retry and stop keep is read from the job's contract (actions.retry.keeps / actions.cancel.keeps: 'completed' | 'nothing'; absent = 'completed'), not assumed. */
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { default as CompactJobCard, cardLine } from './ui/tasks/CompactJobCard.jsx';
  export { resultOpener } from './ui/tasks/task-actions.js';
  export * from './ui/tasks/task-control.js';
  export { jobContract } from './lib/job-contract.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const at = '2026-10-08T10:00:00.000Z';
/** A job the console reads through a contract of its own: `keeps` goes onto retry and cancel the way the runtime view puts it there; undefined leaves them as an older job has them. */
const jobWith = (status, { keeps, refs = [], kind = 'exam-blueprint-build' } = {}) => {
  const base = m.jobContract({ id: 'j1', type: 'audio-import', filename: 'a.wav', status, phase: 'proofread', startedAt: at, retryable: true, paused: false, control: { values: {}, limits: {} } });
  const mark = (action) => (keeps === undefined ? action : { ...action, keeps });
  return { id: 'j1', contract: { ...base, kind, actions: { ...base.actions, retry: mark(base.actions.retry), cancel: mark(base.actions.cancel) }, result: { refs, completeness: status === 'complete' ? 'complete' : null } } };
};
const draw = (element, options = {}) => { m.setUiLanguage(options.language || 'zh'); try { return renderToStaticMarkup(inApp(m, element, options)); } finally { m.setUiLanguage('zh'); } };
const consoleOf = (job, language) => draw(React.createElement(m.TaskConsole, { data: { jobs: [job], drafts: [], decks: [] }, openers: { resultOf: () => null } }),
  { data: { jobs: [job] }, app: { lib: { taskFocus: null } }, language });
const retryTitle = (html) => /title="([^"]*)"[^>]*>接着做</.exec(html)?.[1];

const KEPT_TITLE = '已完成的部分会直接复用，不会重复付费';
const NOTHING_TITLE = '重新开始：会从头读取，已用的模型调用会再次计费';

test('C-2: the retry title follows what a retry keeps: completed and absent keep the wording, nothing says it starts over and is paid again', () => {
  assert.equal(retryTitle(consoleOf(jobWith('failed', { keeps: 'completed' }))), KEPT_TITLE);
  assert.equal(retryTitle(consoleOf(jobWith('failed'))), KEPT_TITLE, 'absent means completed');
  assert.equal(retryTitle(consoleOf(jobWith('failed', { keeps: 'nothing' }))), NOTHING_TITLE);
  assert.equal(retryTitle(consoleOf(jobWith('failed', { keeps: 'nothing', kind: 'audio-import' }))), NOTHING_TITLE, 'by the value, not by the kind of job');
});

test('C-2: the note of a failed, cancelled or interrupted job says nothing was saved when it kept nothing', () => {
  const NOTHING = '没有保存任何结果，点「接着做」会从头开始';
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    assert.ok(consoleOf(jobWith(status, { keeps: 'nothing' })).includes(NOTHING), `${status}: nothing kept`);
    assert.ok(!consoleOf(jobWith(status, { keeps: 'nothing' })).includes('都保留着'), `${status}: no claim of kept work`);
  }
  assert.ok(consoleOf(jobWith('failed', { keeps: 'completed' })).includes('任务没有做完，已出的题都保留着；点「接着做」继续。'));
  assert.ok(consoleOf(jobWith('failed')).includes('任务没有做完，已出的题都保留着；点「接着做」继续。'), 'absent keeps today\'s wording');
  assert.ok(consoleOf(jobWith('interrupted')).includes('任务被中断了，已完成的部分都保留着；点「接着做」继续。'));
});

test('C-2: the stop reply and the stopped card say nothing was saved when a stop keeps nothing', () => {
  assert.equal(m.actionText('cancel', jobWith('running', { keeps: 'nothing' })), '正在停止；这次不会保存任何结果');
  assert.equal(m.actionText('cancel', jobWith('running', { keeps: 'completed' })), '正在停止；已完成的部分会保留');
  assert.equal(m.actionText('cancel', jobWith('running')), '正在停止；已完成的部分会保留');
  assert.equal(m.actionText('cancel'), '正在停止；已完成的部分会保留', 'without a job, as before');
  assert.equal(m.actionText('retry', jobWith('failed', { keeps: 'nothing' })), '已接着做');
  assert.match(m.cardLine(jobWith('cancelled')), /已完成的部分已保留/);
  assert.match(m.cardLine(jobWith('cancelled', { keeps: 'nothing' })), /没有保存任何结果/);
  assert.doesNotMatch(m.cardLine(jobWith('cancelled', { keeps: 'nothing' })), /已保留/);
});

test('C-2: keepsOf reads retry and cancel apart, and only the word nothing changes anything', () => {
  const job = jobWith('failed', { keeps: 'nothing' });
  assert.equal(m.keepsOf(job, 'retry'), 'nothing');
  assert.equal(m.keepsOf(job, 'cancel'), 'nothing');
  assert.equal(m.keepsOf(jobWith('failed'), 'retry'), 'completed');
  assert.equal(m.keepsOf(jobWith('failed', { keeps: 'something else' }), 'retry'), 'completed');
});

test('C-2: the runtime view puts the declared keeps on retry and cancel, and leaves them off when a definition says nothing', () => {
  const { refresh } = viewOps({ live: () => true });
  const caps = { cancel: true, pauseMode: 'checkpoint', recoveryMode: 'none', retry: true, set: false, executionModes: ['direct'] };
  const view = (capabilities, status = 'failed') => { const contract = { status, capabilities, actions: {} }; refresh(contract, { controls: null }); return contract.actions; };
  const declared = view({ ...caps, retryKeeps: 'nothing', stopKeeps: 'nothing' });
  assert.equal(declared.retry.keeps, 'nothing');
  assert.equal(declared.cancel.keeps, 'nothing');
  assert.equal(declared.retry.available, true);
  const mixed = view({ ...caps, retryKeeps: 'completed', stopKeeps: 'nothing' });
  assert.equal(mixed.retry.keeps, 'completed');
  assert.equal(mixed.cancel.keeps, 'nothing');
  const plain = view(caps);
  assert.ok(!('keeps' in plain.retry) && !('keeps' in plain.cancel), 'absent stays absent');
  assert.equal(view({ ...caps, retryKeeps: 'bogus' }).retry.keeps, undefined, 'only the two known values are carried');
});

test('C-1: an exam-point-list result reads 已保存考点清单 and opens the 备考补习 page; a source still reads 已存为 N 份资料', () => {
  const list = jobWith('complete', { refs: [{ kind: 'exam-point-list', id: 'list-1' }] });
  assert.match(m.cardLine(list), /已保存考点清单/);
  assert.doesNotMatch(m.cardLine(list), /已存为|份资料/);
  const shown = [];
  const app = { nav: { show: { page: (id, ...rest) => shown.push([id, ...rest]) } } };
  const opener = m.resultOpener(list, app);
  assert.ok(opener, 'the finished build offers a way to its result');
  assert.match(opener.label, /考点清单/);
  assert.doesNotMatch(opener.label, /蓝图|blueprint/i);
  opener.run();
  assert.deepEqual(shown, [['examprep']], 'the page, no id: the page does not take one');
  assert.equal(m.resultOpener(list, {}), null, 'without navigation there is nothing to offer');
  assert.equal(m.resultOpener(jobWith('running', { refs: [{ kind: 'exam-point-list', id: 'list-1' }] }), app), null, 'nothing opens while it runs');

  const source = jobWith('complete', { refs: [{ kind: 'source', id: 's1' }, { kind: 'source', id: 's2' }] });
  assert.match(m.cardLine(source), /已存为 2 份资料/);
  assert.doesNotMatch(m.cardLine(source), /考点清单/);
});

test('C-1: the card of a finished list draws the words, and its English wording exists', () => {
  const list = jobWith('complete', { refs: [{ kind: 'exam-point-list', id: 'list-1' }] });
  const app = { nav: { show: { page: () => {} } } };
  assert.match(draw(React.createElement(m.CompactJobCard, { job: list }), { app }), /已保存考点清单/);
  assert.match(draw(React.createElement(m.CompactJobCard, { job: list }), { app, language: 'en' }), /Exam point list saved/);
  const nothing = draw(React.createElement(m.TaskConsole, { data: { jobs: [jobWith('failed', { keeps: 'nothing' })] }, openers: { resultOf: () => null } }), { data: { jobs: [jobWith('failed', { keeps: 'nothing' })] }, app: { lib: { taskFocus: null } }, language: 'en' });
  assert.match(nothing, /Starting over: it reads everything again, and the model calls already used are billed again/);
  assert.match(nothing, /Nothing was saved; press Continue to start again from the beginning/);
});
