import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runConversion } from '../lib/contexts/audio/pdf/convert-run.js';
import { readManifest, saveManifest } from '../lib/mineru-job.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { CONVERT_TEXT } from '../lib/contexts/audio/convert-support.js';
import { inboxKind } from '../lib/inbox-kinds.js';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* Issue #54, what a learner reads: a conversion that waits before the import never reads as a failure, the one way on is 修改并导入, the switch is off the main path and off by
   default, and nothing offers to edit a document already imported. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as CompactJobCard, cardLine } from './ui/tasks/CompactJobCard.jsx';
  export { PdfConvertJobs, PdfDetail, PdfConvertHistory } from './ui/PdfConvertJob.jsx';
  export { default as PdfConversion } from './ui/PdfConversion.jsx';
  export { blocksInOrder } from './ui/ConvertEdit.jsx';
  export { taskState, taskLine, stateLabel } from './ui/tasks/task-summary.js';
  export { taskFilters, filterTasks, isHeldTask } from './ui/tasks/task-model.js';
  export { failedHandOffInput } from './ui/tasks/failed-hand-off.js';
  export { headerActions, endedNote } from './ui/tasks/task-control.js';
  export { convertEventText } from './ui/tasks/convert-log.js';
  export { logLines } from './ui/tasks/call-model.js';
  export { deleteNoticeText } from './ui/tasks/delete-notice.js';
  export { archiveAllWithUndo } from './ui/tasks/archive-all.js';
  export { jobContract as logContract } from './lib/job-contract.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const HAN = /[㐀-鿿]/;
const draw = (element, { data = {}, language = 'zh' } = {}) => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(m, element, { data })); } finally { m.setUiLanguage('zh'); }
};
const held = (extra = {}) => ({ id: 'pdf-held-1', type: 'pdf-convert', converter: 'mineru', route: 'local', filename: 'Book.pdf', status: 'failed', retryable: true, phase: 'held', done: 5, total: 5,
  stage: CONVERT_TEXT.held, chunks: [], warnings: [], note: '', startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:10:00.000Z', held: { blocks: 12 }, ...extra });
const failed = () => held({ id: 'pdf-failed-1', held: undefined, phase: 'local', stage: 'MinerU 没能转换这一段' });
const complete = () => held({ id: 'pdf-done-1', held: undefined, status: 'complete', retryable: false, phase: 'done', sourceIds: ['s1'] });

test('a waiting conversion reads as waiting wherever it is shown, and never as a failure', () => {
  m.setUiLanguage('zh');
  const job = held();
  assert.equal(m.taskState(job), 'held');
  assert.equal(m.stateLabel('held'), '等你导入');
  assert.equal(m.taskLine(job), CONVERT_TEXT.held);
  assert.equal(m.cardLine(job), CONVERT_TEXT.held);
  assert.equal(m.taskState(failed()), 'fail', 'a real failure stays one');
  const tasks = [job, failed()];
  assert.equal(m.taskFilters(tasks).find(filter => filter.id === 'failed').count, 1);
  assert.deepEqual(m.filterTasks(tasks, 'failed').map(task => task.id), ['pdf-failed-1']);
  assert.equal(m.failedHandOffInput(job), null, 'nothing to hand to the main chat');
  assert.ok(m.failedHandOffInput(failed()));
  assert.equal(m.headerActions(job).retry, false, 'its way on is 导入, not 接着做');
  assert.equal(m.headerActions(failed()).retry, true);
  assert.match(m.endedNote(job), /修改并导入/);
});

test('the log never calls a waiting conversion a failure, even when no line of this attempt said it waits (a restart, a failed import)', () => {
  m.setUiLanguage('zh');
  const statusLine = { id: 'e1', at: '2026-10-01T00:10:00.000Z', level: 'error', code: 'status', args: { status: 'failed' }, text: CONVERT_TEXT.held };
  const lines = job => m.logLines({ ...m.logContract(job), events: [statusLine] }).map(line => line.text).join(' | ');
  assert.doesNotMatch(lines(held()), /任务失败/);
  assert.match(lines(failed()), /任务失败/, 'a real failure says so');
});

test('deleting a waiting conversion says what is lost: the edited text, and in a batch too', () => {
  m.setUiLanguage('zh');
  const one = m.deleteNoticeText([held()]);
  assert.match(one, /转换好的文字和你改过的地方也会丢掉/);
  assert.doesNotMatch(one, /中间文件/);
  assert.match(m.deleteNoticeText([held(), held({ id: 'pdf-held-2' }), failed()]), /其中 2 个任务转换好的文字和你改过的地方也会丢掉/);
  assert.match(m.deleteNoticeText([failed()]), /中间文件/, 'the rest as before');
  assert.match(m.deleteNoticeText([held({ archived: { at: '2026-10-02T00:00:00.000Z' } })]), /也会丢掉/, 'an archived one too');
});

test('全部归档 says how many waiting conversions it left alone', async () => {
  m.setUiLanguage('zh');
  const said = [];
  await m.archiveAllWithUndo({ archive: async () => ({ ok: true, result: { archived: ['a'], skipped: [{ id: 'w', reason: 'waiting' }, { id: 'r', reason: 'running' }] } }), toast: { show: notice => said.push(notice), success: notice => said.push(notice), info: notice => said.push(notice) }, quick: null, core: null });
  assert.match(JSON.stringify(said), /1 个等你导入的任务留在原处/);
});

test('the card offers one way on, says it waits, and no failure words; a stopped import that goes back says why', () => {
  const html = draw(React.createElement(m.PdfConvertJobs, { jobs: [held()], call: async () => ({}) }));
  assert.match(html, /修改并导入/);
  assert.match(html, /等你导入/);
  assert.doesNotMatch(html, /接着做|发给主会话|看原因|失败|role="alert"/);
  assert.match(html, /data-state="held"/);
  const english = draw(React.createElement(m.PdfConvertJobs, { jobs: [held()], call: async () => ({}) }), { language: 'en' });
  assert.match(english, /Edit and import/);
  assert.doesNotMatch(english.replace(/Book\.pdf/g, ''), HAN);

  const detail = draw(React.createElement(m.PdfDetail, { job: held({ held: { blocks: 12, problem: '资料组件没有启用' } }) }));
  assert.match(detail, /data-held-entry/);
  assert.match(detail, /上次没能导入/);
  assert.match(draw(React.createElement(m.PdfDetail, { job: held() })), /还没有存为资料/);
});

test('an archived record is read-only: it offers no editor', () => {
  assert.doesNotMatch(draw(React.createElement(m.PdfDetail, { job: held({ archived: { at: '2026-10-02T00:00:00.000Z' } }) })), /data-held-entry/);
});

test('editing what is already imported is never offered: a finished job only says how to do it next time', () => {
  const html = draw(React.createElement(m.PdfDetail, { job: complete() }));
  assert.doesNotMatch(html, /data-held-entry|修改并导入/);
  assert.match(html, /data-reconvert-hint/);
  assert.match(html, /已经导入的这份不会变/);
  assert.doesNotMatch(draw(React.createElement(m.PdfConvertJobs, { jobs: [complete()], call: async () => ({}) })), /修改并导入/);
});

test('the switch sits folded under 更多设置: the main path has no extra control, and both tools have it (opened and off by default: the browser test)', () => {
  const ready = { state: 'ready', tier: 'basic', estimates: { basic: 3 } }, plan = { pages: 3, bytes: 100, windows: [{ index: 1, startPage: 1, endPage: 3, pages: 3 }] };
  const props = { file: { name: 'Book.pdf', size: 100 }, call: async () => ({}), initialLocal: ready, initialMarker: { state: 'ready' }, initialPlan: plan, initialHistory: [] };
  for (const initialConverter of ['mineru', 'marker']) {
    const html = draw(React.createElement(m.PdfConversion, { ...props, initialConverter }));
    assert.match(html, /更多设置/, initialConverter);
    assert.doesNotMatch(html, /data-review-before-import/, 'drawn only when it is opened');
    assert.ok(html.indexOf('更多设置') < html.indexOf('mineru-start'), 'above the one start button, not in its way');
  }
});

test('the history says it waits and leads to it', () => {
  const row = { id: 'pdf-held-1', version: 1, filename: 'Book.pdf', status: 'held', route: 'local', converter: 'mineru', pages: 5, pagesDone: 5, attempts: 1, startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:10:00.000Z', canRetry: false, live: false };
  const html = draw(React.createElement(m.PdfConvertHistory, { call: async () => ({}), initialRecords: [row], now: Date.parse('2026-10-01T01:00:00.000Z') }));
  assert.match(html, /等你导入/);
  assert.match(html, /修改并导入/);
  assert.doesNotMatch(html, /接着做|没有完成/);
});

test('the longest block can come first, and the book order is the book order', () => {
  const blocks = [{ index: 0, text: 'a' }, { index: 1, text: 'long long' }, { index: 2, text: 'bb' }];
  assert.deepEqual(m.blocksInOrder(blocks, 'book').map(block => block.index), [0, 1, 2]);
  assert.deepEqual(m.blocksInOrder(blocks, 'longest').map(block => block.index), [1, 2, 0]);
  assert.deepEqual(blocks.map(block => block.index), [0, 1, 2], 'the book is not reordered in place');
});

test('its log lines and every server sentence have an English form', () => {
  m.setUiLanguage('zh');
  assert.equal(m.convertEventText({ code: 'convert-held', text: CONVERT_TEXT.held, args: {} }), CONVERT_TEXT.held);
  assert.match(m.convertEventText({ code: 'held-import-failed', text: 'x' }), /文字和你的修改都还在/);
  assert.equal(inboxKind('pdf-held').tone, 'info');
  for (const text of [CONVERT_TEXT.held, CONVERT_TEXT.notHeld, CONVERT_TEXT.archivedHeld, 'PDF 转换好了，等你导入', CONVERT_TEXT.started({ converter: 'marker', held: true }), CONVERT_TEXT.started({ converter: 'mineru', held: true }),
    CONVERT_TEXT.editPending({ edited: 3, archived: false }), CONVERT_TEXT.editPending({ edited: 3, archived: true })])
    assert.doesNotMatch(localizeAppMessage(text, 'en'), HAN, text);
  assert.match(localizeAppMessage(CONVERT_TEXT.editPending({ edited: 3, archived: false }), 'en'), /3/);
});

test('an import that fails leaves the job waiting, with the reason and every edit; nothing is deleted', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'convert-edit-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'held.json'), JSON.stringify({ content: [{ type: 'text', text: 'page one', page_idx: 0 }] }));
  const manifest = { version: 1, kind: 'pdf-convert', id: 'job-import-fails', route: 'local', converter: 'mineru', filename: 'Book.pdf', sourceHash: 'abc', totalPages: 1, chunks: [], plan: { kind: 'fixed', windowPages: 50 },
    held: { at: '2026-10-01T00:00:00.000Z', blocks: 1, edits: { 0: 'my words' }, approved: true } };
  await saveManifest(dir, manifest);
  const job = { id: manifest.id, type: 'pdf-convert', status: 'running', done: 0, total: 1, warnings: [], chunks: [], events: [] };
  let closed;
  const service = { documents: { import: async () => { throw new Error('资料组件没有启用'); } } };
  const { outcome } = await runConversion({ service, root: join(dir, 'lib'), dir, manifest, job, signal: new AbortController().signal, cancelled: () => false,
    history: { opened: Promise.resolve(), progress() {}, close: async what => { closed = what.outcome; } } });
  assert.equal(outcome, 'held');
  assert.equal(closed, 'held');
  assert.deepEqual([job.phase, job.status, job.retryable, job.held.problem], ['held', 'failed', true, '资料组件没有启用']);
  const kept = await readManifest(dir);
  assert.equal(kept.held.approved, false, 'the press does not outlive the attempt');
  assert.deepEqual(kept.held.edits, { 0: 'my words' });
});
