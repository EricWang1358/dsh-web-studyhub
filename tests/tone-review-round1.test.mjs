import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadUi } from './helpers/ui-module.mjs';

/* The tone pass (step 1), review round 1: sentences that must say only what the code does. Each test pins one finding of the review. */

const m = await loadUi(`
  export { describeFailure, describeModelError } from './ui/generation-status.js';
  export { variantFailureText } from './ui/wrongbook-model.js';
  export { batchRun } from './ui/tasks/task-batch.js';
  export { runRecheck, recheckSentence } from './ui/first-run/recheck.js';
  export { deleteFailureText } from './ui/book/book-structure.js';
  export { createSnapshotPoll } from './ui/app/snapshot-poll.js';
  export { createStudyCall } from './ui/transport.js';
  export { rowsAwaitingDetail } from './ui/wrongbook-model.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const EXECUTOR = '后台执行器暂时不可用，请稍后再试';

test('StudyHub\'s own background service failing is not blamed on the model service, and no model is offered as the cure', () => {
  const found = m.describeFailure(EXECUTOR);
  assert.equal(found.kind, 'executor');
  assert.equal(found.title, '后台服务这次没有回应');
  assert.equal(found.hint, '等一两分钟再试一次。', 'the hint does not repeat the title');
  assert.doesNotMatch(`${found.title}${found.hint}`, /模型/);
  for (const english of ['The background executor is unavailable; try again later', 'Background task service is not available', 'executor unavailable']) assert.equal(m.describeFailure(english).kind, 'executor', english);
  // A removed source or deck is not the model service.
  for (const stage of ['Selection source is unavailable', 'Destination deck is unavailable']) assert.equal(m.describeFailure(stage).kind, 'sources', stage);
  const note = m.describeModelError(EXECUTOR);
  assert.equal(note.kind, 'executor');
  assert.equal(note.action, 'retry');
  assert.equal(m.variantFailureText(EXECUTOR), '后台服务这次没有回应。等一两分钟再试一次。');
  // The model service's own "unavailable" keeps its way out, without saying whose fault it is.
  const model = m.describeFailure('Model service unavailable: 503');
  assert.equal(model.kind, 'unavailable');
  assert.doesNotMatch(model.hint, /那边的问题/);
  assert.match(model.hint, /换一个模型/);
  assert.match(m.variantFailureText('模型服务暂时不可用'), /^服务这次不可用。/);
});

test('a partly done batch says how many went through, and never claims the click did nothing', async () => {
  const ids = Array.from({ length: 150 }, (_, index) => `job-${index}`);
  let calls = 0;
  const core = { act: async () => (++calls === 1 ? { archived: ids.slice(0, 100), skipped: [] } : undefined) };
  const partly = await m.batchRun('archive', ids, { core });
  assert.equal(partly.ok, false);
  assert.equal(partly.archived, 100);
  assert.equal(partly.message, '上一个操作还没结束，已处理 100 个，剩下的没有开始。等它结束后再点一次。');
  const none = await m.batchRun('archive', ids, { core: { act: async () => undefined } });
  assert.equal(none.message, '上一个操作还没结束，这次没有开始。等它结束后再点一次。');
  for (const result of [partly, none]) assert.doesNotMatch(result.message, /没有生效/);
});

test('the re-check says what came of it: still no model, or the library could not be read at all', async () => {
  assert.equal(await m.runRecheck(async () => {}), 'still');
  assert.equal(await m.runRecheck(async () => { throw new Error('boom'); }), 'failed');
  assert.match(m.recheckSentence('still'), /^已重新检查，还没有读到可用的模型。/);
  assert.equal(m.recheckSentence('failed'), '没能重新检查。再点一次「重新检查」试试。');
  m.setUiLanguage('en');
  try { assert.doesNotMatch(m.recheckSentence('failed'), han); assert.match(m.recheckSentence('failed'), /Could not check again/); } finally { m.setUiLanguage('zh'); }
});

test('the delete dialog of a knowledge point shows the reason that came back, and the generic line only when none did', () => {
  assert.match(m.deleteFailureText({ code: 'course-book-conflict' }), /这本书的结构刚被改过/);
  assert.equal(m.deleteFailureText({ message: '这个知识点已被删除' }), '这个知识点已被删除');
  assert.equal(m.deleteFailureText({}), '这次没有成功，也没有拿到具体原因。可以再试一次。');
  assert.equal(m.deleteFailureText(undefined), '这次没有成功，也没有拿到具体原因。可以再试一次。');
});

test('one verb for "no reason": 拿到 everywhere, never 返回, in the sentences of the generic fallbacks', async () => {
  const sources = ['ui/components/ErrorState.jsx', 'ui/components/Feedback.jsx', 'ui/book/book-structure.js', 'ui/exam-prep/words.js', 'ui/UsageSettings.jsx', 'ui/tasks/TaskConsole.jsx',
    'ui/components/ConfirmDialog.jsx', 'ui/review/useReviewSession.js', 'ui/transport.js', 'ui/skeleton-groups.js'];
  for (const file of sources) assert.doesNotMatch(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), /也没有返回具体原因/, file);
});

test('the transport says what is true: a button action is not retried by itself, only the start-up loop and the poll are', async () => {
  const source = await readFile(new URL('../ui/transport.js', import.meta.url), 'utf8');
  assert.match(source, /StudyHub 还没有启动好（DSH 可能刚重启）。等几秒再点一次。/);
  assert.doesNotMatch(source, /正在重试/);
});

test('the poll tells the bar by the error code that a restarting DSH is transient (the 404/404 of createStudyCall), and a real failure is not', async () => {
  const seen = [];
  const run = async (rpc) => {
    const call = m.createStudyCall({ rpc: { call: rpc } }, 's');
    await m.createSnapshotPoll({ refresh: () => call('snapshot'), readData: () => null, readToken: () => 1, setSyncIssue: (text, transient) => seen.push([text, transient]),
      same: () => false, isWorking: () => false }).run();
    return seen.at(-1);
  };
  const [text, transient] = await run(async () => { throw new Error('transport failure: HTTP 404'); });
  assert.equal(text, 'StudyHub 还没有启动好（DSH 可能刚重启）。等几秒再点一次。');
  assert.equal(transient, true, 'by STUDY_UNAVAILABLE, not by the Chinese words');
  assert.equal((await run(async () => { throw new Error('HTTP 500'); }))[1], false);
  assert.deepEqual(await run(async () => ({ ok: true, value: {} })), ['', undefined]);
});

test('a wrong-book row that stays open across 刷新 asks for its detail again, once, and never while it loads or after it failed', () => {
  const items = [{ deckId: 'd1', cardId: 'a', extra: 1 }, { deckId: 'd1', cardId: 'b' }];
  const open = new Set(['a']);
  assert.deepEqual(m.rowsAwaitingDetail(items, open, {}), [{ deckId: 'd1', cardId: 'a' }], '刷新 emptied details: the open row asks');
  assert.deepEqual(m.rowsAwaitingDetail(items, open, { a: 'loading' }), [], 'not a second time while it loads');
  assert.deepEqual(m.rowsAwaitingDetail(items, open, { a: { error: 'x' } }), [], 'and not in a loop after it failed');
  assert.deepEqual(m.rowsAwaitingDetail(items, open, { a: { prompt: 'p' } }), []);
  assert.deepEqual(m.rowsAwaitingDetail(items, new Set(), {}), [], 'closed rows ask nothing');
});
