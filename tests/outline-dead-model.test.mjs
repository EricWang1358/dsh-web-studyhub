/* A model that never answers stops the 整理总纲 early (2026-11-11, 「整理总纲 · Java 八股」): the learner's session ran on a local account-pool proxy that
   answered every call with `503 no_healthy_account` or held it open until the 8-minute limit, and the 清点 went on for 1 h 31 min, 464 of 467 calls
   failed, 0 tokens. A call that sends no output for a while is cut; calls that keep failing the same way, or one refusal that asking again cannot mend,
   stop the task with ONE reason and the way on, instead of failing every part alone. Fake models only: no real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelGateway } from '../lib/jobs/gateway.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';
import { createParallel } from '../lib/contexts/generation/inventory/parallel.js';
import { policyOf } from '../lib/contexts/generation/inventory/policy.js';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';
import { isCourseInventorySource } from '../lib/exam-point-list.js';
import { loadUi } from './helpers/ui-module.mjs';

const ctxHost = { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } }) } };
/** The owner's provider answer, as lib/index.js throws it after DSH's own retries (streamFailure of the `error` finish). */
const noHealthyAccount = () => Object.assign(new Error('503: {"code":"no_healthy_account","message":"all accounts are temporarily unavailable, please retry later","type":"api_error"}'),
  { code: 'SERVER', modelFailure: true });
/** What lib/index.js throws when the caller's signal ends a call that sent nothing. */
const aborted = () => Object.assign(new Error('Model stream aborted'), { name: 'AbortError', modelFailure: true });

/** A parallel stage on the real gateway: `answer(request, n)` is the host's model. */
function stage(answer, options = {}) {
  const record = structuredClone(goldenRuntimeContracts.running); record.calls = []; record.runtime.steps = [];
  const controller = new AbortController();
  let calls = 0;
  const host = { ctx: ctxHost, sessionId: 'fixture', route: () => ({ provider: 'local-workbuddy', model: 'cn:hy4free' }),
    complete: (_system, _prompt, request) => answer(request, ++calls) };
  const context = { jobId: record.jobId, attemptId: record.attemptId, signal: controller.signal, pauseRequested: false, assertCurrent() { controller.signal.throwIfAborted(); } };
  context.gateway = createModelGateway({ context, record, host });
  const ctx = { context, kept: { results: new Map() }, state: { reused: 0 }, show: () => {}, boundary: () => false, plan: { language: options.language ?? 'zh' } };
  const parallel = createParallel(ctx, { limit: 3, ...options });
  const run = count => parallel.each(Array.from({ length: count }, (_, at) => at), at => parallel.ask(`inv:${at}`, { stage: 'inventory', part: at + 1, parts: count },
    policyOf('inventory', {}), { system: 's', prompt: 'p' }, text => JSON.parse(text)), 'inventory');
  return { run, record, calls: () => calls, state: ctx.state };
}

const hang = request => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(aborted()), { once: true }));

test('a call that sends nothing at all is cut after the silence limit, and calls that all go silent stop the stage with one reason', async () => {
  const s = stage(hang, { silentMs: 40 });
  const started = Date.now();
  await assert.rejects(s.run(40), error => {
    assert.equal(error.code, 'model-failing');
    assert.match(error.message, /没有任何输出/);
    assert.match(error.message, /接着做/, 'the way on is named, as the button says');
    return true;
  });
  assert.ok(Date.now() - started < 3000, `cut early (${Date.now() - started} ms), not at the host's 8-minute limit`);
  assert.ok(s.calls() <= 9, `stopped after a few calls, not 2 x 40 (${s.calls()})`);
  const cut = s.record.calls.filter(call => call.reason === 'no-output');
  assert.ok(cut.length >= 6, 'the silent calls are recorded as cut for silence');
  assert.ok(cut.every(call => call.status === 'failed'), 'a call cut for silence failed; it was not cancelled by the learner');
});

test('a slow stream that keeps sending is never cut', async () => {
  const s = stage(async request => {
    for (let at = 0; at < 6; at++) { await new Promise(resolve => setTimeout(resolve, 20)); request.onOutput?.('x'); }
    return '{"ok":true}';
  }, { silentMs: 60 });
  const answers = await s.run(4);
  assert.equal(answers.filter(Boolean).length, 4);
});

test('every call refused the same way (the owner\'s 503 no_healthy_account) stops after a few calls, naming the provider\'s reason', async () => {
  const s = stage(async () => { throw noHealthyAccount(); });
  await assert.rejects(s.run(249), error => {
    assert.equal(error.code, 'model-failing');
    assert.match(error.message, /503/);
    assert.match(error.message, /no_healthy_account/);
    assert.doesNotMatch(error.message, /all accounts/, 'only the code of the provider body, never its free text');
    return true;
  });
  assert.ok(s.calls() <= 9, `stopped after a few calls, not 2 x 249 (${s.calls()})`);
  const en = stage(async () => { throw noHealthyAccount(); }, { language: 'en' });
  await assert.rejects(en.run(20), error => /Continue/.test(error.message) && /no_healthy_account/.test(error.message));
});

test('a refusal that asking again cannot mend (a missing key) stops at the first call', async () => {
  const s = stage(async () => { throw Object.assign(new Error('No API key for provider'), { code: 'MISSING_CREDENTIAL', modelFailure: true }); });
  await assert.rejects(s.run(30), error => error.code === 'model-failing' && /密钥|额度|模型设置/.test(error.message));
  assert.ok(s.calls() <= 3, `no call asked again (${s.calls()})`);
});

test('failures between answers never stop the stage: a part fails alone, as before', async () => {
  const s = stage(async (_request, n) => { if (n % 2) throw noHealthyAccount(); return '{"ok":true}'; });
  const answers = await s.run(30);
  assert.ok(answers.some(Boolean), 'answered parts are kept');
});

test('整理总纲 on a model that refuses every call fails early with one reason; what was read is kept as unread for the retry', async t => {
  const fake = outlineModel({ fail: () => false });
  let inventoryCalls = 0;
  const complete = async (system, prompt, request) => {
    if (prompt.includes('"stage":"inventory"')) { inventoryCalls++; throw noHealthyAccount(); }
    return fake.complete(system, prompt, request);
  };
  const root = await privateRoot(t, 'outline-dead-model-');
  const service = new StudyService(root, { complete, ...switchOptions('runtime', { complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary({});
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); state.focus = { mode: 'class', course: COURSE }; });
  const job = await settleJob(service, (await service.call('generation.courseOutline.build', { course: COURSE, language: 'zh' })).jobId);
  assert.equal(job.status, 'failed', `the task stops (${job.status})`);
  const text = JSON.stringify(job.error ?? job);
  assert.match(text, /no_healthy_account/, 'the reason is said once, in the task');
  assert.ok(inventoryCalls <= 9, `a few calls, not every part twice (${inventoryCalls})`);
  const inventory = (await service.store.read()).sources.find(isCourseInventorySource);
  assert.ok(!inventory || inventory.courseInventory.items.length === 0, 'nothing invented');
});

test('the console says how a failed 清点 call goes on: read again on 接着做, not 补题 in a draft', async () => {
  const m = await loadUi(`export { retryNote } from './ui/tasks/call-model.js';
  export { setUiLanguage } from './ui/i18n.js';`);
  const call = { kind: 'inventory', status: 'failed', part: 217, file: 'Java架构师指南（王波编著）', startedAt: '2026-11-11T03:29:35.000Z' };
  assert.match(m.retryNote(call, [call]), /点「接着做」或下次整理时会再读/);
  assert.doesNotMatch(m.retryNote(call, [call]), /补题/);
  m.setUiLanguage('en');
  try { assert.match(m.retryNote(call, [call]), /reads it again/); } finally { m.setUiLanguage('zh'); }
});

test('the log of a task the runtime ended says how it ended, with the reason, instead of a blank line', async () => {
  const m = await loadUi(`export { logLines } from './ui/tasks/call-model.js';
  export { setUiLanguage } from './ui/i18n.js';`);
  const reason = '已停下：模型连续 6 次调用都失败了，原因相同：模型服务暂时不可用（503 no_healthy_account）。';
  const failed = { status: 'failed', error: { code: 'model-failing', message: reason }, calls: [], events: [{ eventId: 'e1:settled', type: 'settled', at: '2026-11-11T04:04:01.058Z', status: 'failed' }] };
  const [line] = m.logLines(failed);
  assert.equal(line.text, `任务失败：${reason}`);
  assert.equal(line.level, 'warn', 'listed under 提醒 too');
  assert.deepEqual(m.logLines(failed, 'warn').map(each => each.text), [`任务失败：${reason}`]);
  const done = m.logLines({ status: 'complete', calls: [], events: [{ eventId: 'e2:settled', type: 'settled', at: '2026-11-11T04:04:01.058Z', status: 'complete' }] });
  assert.ok(done[0].text.length > 0 && !/失败/.test(done[0].text), `a finished task says so (${done[0].text})`);
  // A producer that already wrote its own status line is not repeated.
  const told = m.logLines({ ...failed, events: [...failed.events, { id: 'x', code: 'status', args: { status: 'failed' }, text: reason, level: 'error', at: '2026-11-11T04:04:01.000Z' }] });
  assert.equal(told.filter(each => each.text.includes(reason)).length, 1);
});
