import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelGateway } from '../lib/jobs/gateway.js';
import { validateRuntimeContract } from '../lib/jobs/contract.js';
import { SILENT_CUT } from '../lib/jobs/gateway-policy.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { logLines } from './ui/tasks/call-model.js';
  export { callLimitHit } from './ui/tasks/time-limit.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const ctxHost = { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } }) } };

function makeGateway(answer, lightAnswer = answer) {
  const record = structuredClone(goldenRuntimeContracts.running);
  record.calls = [];
  record.runtime.steps = [];
  const controller = new AbortController();
  const host = {
    ctx: ctxHost,
    sessionId: 'fixture',
    route: () => ({ provider: 'p', model: 'm' }),
    complete: (system, prompt, request) => answer(request, system, prompt),
    light: (system, prompt, request) => lightAnswer(request, system, prompt),
  };
  const context = {
    jobId: record.jobId,
    attemptId: record.attemptId,
    signal: controller.signal,
    assertCurrent() { controller.signal.throwIfAborted(); },
  };
  const gateway = createModelGateway({ context, record, host });
  return { record, controller, gateway };
}

test('direct gateway steps decouple from assist 8-minute cap and pass budgetMs explicitly', async t => {
  const requests = [];
  const { gateway } = makeGateway(async request => {
    requests.push(request);
    return '{"items":[]}';
  });
  await gateway.step('inv:1', { purpose: 'inventory', feature: 'book', requestedEffort: 'default', executionMode: 'direct', budget: null }).complete('s', 'p');
  assert.notEqual(requests[0].task, 'assist', 'direct gateway calls must not impersonate card assist with its 8-min cap');
  assert.equal(requests[0].timeoutMs, 0, 'unlimited budget passes timeoutMs = 0 (no wall-clock cap)');

  await gateway.step('inv:2', { purpose: 'inventory', feature: 'book', requestedEffort: 'default', executionMode: 'direct', budget: { timeoutMs: 900_000 } }).complete('s', 'p');
  assert.equal(requests[1].timeoutMs, 900_000, 'explicit step budget passes its timeoutMs');

  let plugin;
  try { plugin = await import('../lib/index.js'); } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes('@deepseek-ai')) return;
    throw e;
  }
  if (!plugin?.modelCompletion) return;
  const timeouts = [];
  const origTimeout = AbortSignal.timeout;
  AbortSignal.timeout = ms => { timeouts.push(ms); return origTimeout(ms); };
  t.after(() => { AbortSignal.timeout = origTimeout; });

  const complete = plugin.modelCompletion({
    llm: {
      resolveModelInfo: async () => ({}),
      resolveCallConfig: async c => c,
      stream: async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '{"items":[]}' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"items":[]}' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  }, () => ({ provider: 'p', model: 'm' }), 's');

  const out = await complete('sys', 'prompt', { task: 'gateway', feature: 'book', timeoutMs: 0, route: { provider: 'p', model: 'm' } });
  assert.equal(out, '{"items":[]}');
  assert.deepEqual(timeouts, [], 'unlimited gateway call arms no hidden 8-minute AbortSignal.timeout');
});

test('a step that reaches its single-call timeout is recorded as failed (not cancelled) with call-timeout and a clear log reason', async () => {
  const { gateway, record } = makeGateway(request => new Promise((_resolve, reject) => {
    const hold = setTimeout(() => {}, 1000);
    request.signal.addEventListener('abort', () => { clearTimeout(hold); reject(Object.assign(new Error('Model stream aborted'), { name: 'AbortError', modelFailure: true })); }, { once: true });
  }));
  await assert.rejects(
    gateway.step('inv:slow', { purpose: 'inventory', feature: 'book', requestedEffort: 'default', executionMode: 'direct', budget: { timeoutMs: 60 } },
      { labels: { stage: 'inventory', part: 12, parts: 341, file: '计算机网络常见面试题总结' } }).complete('s', 'p'),
  );
  validateRuntimeContract(record);
  assert.equal(record.runtime.steps[0].status, 'failed');
  const [call] = record.calls;
  assert.equal(call.status, 'failed', 'a step timeout is a failure, not a user cancellation');
  assert.equal(call.reason, 'call-timeout');
  assert.ok(call.error, 'call.error is populated');
  assert.equal(ui.callLimitHit(call, 0.06, Date.now()), true, 'callLimitHit recognises call-timeout');

  const [zhLine] = ui.logLines({ status: 'running', calls: [call], events: [] });
  assert.match(zhLine.text, /清点资料 12\/341/);
  assert.match(zhLine.text, /原因：.*单次.*调用时限.*设置 › 出题偏好/);

  ui.setUiLanguage('en');
  try {
    const [enLine] = ui.logLines({ status: 'running', calls: [call], events: [] });
    assert.match(enLine.text, /Reason:.*single-call time limit.*Settings › Question defaults/i);
    assert.doesNotMatch(enLine.text.replace('计算机网络常见面试题总结', ''), /[㐀-鿿]/);
  } finally { ui.setUiLanguage('zh'); }
});

test('failed gateway calls record safe, input-free reasons (silent cut, host timeout, provider code, max-tokens) and render them in logLines', async () => {
  // 1. Silent cut (3 minutes with no output)
  const s1 = makeGateway(request => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }));
  const silentCtl = new AbortController();
  setTimeout(() => silentCtl.abort(Object.assign(new Error('no output'), { code: SILENT_CUT, ms: 180_000 })), 20);
  await assert.rejects(s1.gateway.step('inv:silent', { purpose: 'inventory', feature: 'book', requestedEffort: 'default', executionMode: 'direct', budget: null },
    { labels: { stage: 'inventory', part: 2, parts: 10 }, signal: silentCtl.signal }).complete('s', 'p'));
  assert.equal(s1.record.calls[0].status, 'failed');
  assert.equal(s1.record.calls[0].reason, 'no-output');
  assert.match(ui.logLines({ status: 'running', calls: s1.record.calls, events: [] })[0].text, /原因：连续 3 分钟没有任何输出/);

  // 2. Provider error with status + code, plus secret user text in body that must NEVER leak into call.error
  const s2 = makeGateway(async () => {
    throw Object.assign(new Error('503: {"code":"no_healthy_account","message":"echo SECRET_STUDENT_NOTE_XYZ"}'), { code: 'SERVER', modelFailure: true });
  });
  await assert.rejects(s2.gateway.step('inv:503', { purpose: 'inventory', feature: 'book', requestedEffort: 'default', executionMode: 'direct', budget: null },
    { labels: { stage: 'inventory', part: 3, parts: 10 } }).complete('s', 'p'));
  assert.doesNotMatch(s2.record.calls[0].error || '', /SECRET_STUDENT_NOTE_XYZ/, 'never retains free-text provider body');
  assert.match(s2.record.calls[0].error || '', /503.*no_healthy_account/);
  assert.match(ui.logLines({ status: 'running', calls: s2.record.calls, events: [] })[0].text, /原因：.*503 no_healthy_account/);

  // 3. Direct host TimeoutError (e.g. 480s)
  const s3 = makeGateway(async () => {
    throw Object.assign(new Error('Model timed out after 480s'), { name: 'TimeoutError', modelFailure: true });
  });
  await assert.rejects(s3.gateway.step('inv:t', { purpose: 'inventory', feature: 'book', requestedEffort: 'default', executionMode: 'direct', budget: null },
    { labels: { stage: 'inventory', part: 4, parts: 10 } }).complete('s', 'p'));
  assert.match(ui.logLines({ status: 'running', calls: s3.record.calls, events: [] })[0].text, /原因：.*超时.*8 分钟/);
});

test('light-lane gateway steps without an explicit budget omit timeoutMs so host.light keeps its default 90s timeout, while heavy unlimited steps pass 0', async t => {
  const heavyRequests = [];
  const lightRequests = [];
  const { gateway } = makeGateway(
    async (request) => { heavyRequests.push(request); return '{"ok":true}'; },
    async (request) => { lightRequests.push(request); return '{"ok":true}'; },
  );

  // Light-lane step with budget: null (e.g. coach lightStep) must NOT send timeoutMs: 0.
  await gateway.step('coach:light-default', { purpose: 'coach', feature: 'coach', requestedEffort: 'low', executionMode: 'direct', budget: null }, { model: 'light' }).complete('s', 'p');
  assert.equal('timeoutMs' in lightRequests[0], false, 'light step with no explicit budget omits timeoutMs so host.light default applies');

  // Light-lane step with explicit positive budget passes it through.
  await gateway.step('coach:light-explicit', { purpose: 'coach', feature: 'coach', requestedEffort: 'low', executionMode: 'direct', budget: { timeoutMs: 45_000 } }, { model: 'light' }).complete('s', 'p');
  assert.equal(lightRequests[1].timeoutMs, 45_000, 'light step with explicit timeoutMs passes it through');

  // Heavy/outline/book step with budget: null still passes timeoutMs: 0 (unlimited).
  await gateway.step('book:heavy-unlimited', { purpose: 'inventory', feature: 'book', requestedEffort: 'default', executionMode: 'direct', budget: null }).complete('s', 'p');
  assert.equal(heavyRequests[0].timeoutMs, 0, 'heavy unlimited step keeps timeoutMs: 0');

  // Verify end-to-end with modelCompletion({ light: true }): omitted timeoutMs arms the 90s light timeout.
  let plugin;
  try { plugin = await import('../lib/index.js'); } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes('@deepseek-ai')) return;
    throw e;
  }
  if (!plugin?.modelCompletion) return;
  const timeouts = [];
  const origTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return origTimeout(ms); };
  t.after(() => { AbortSignal.timeout = origTimeout; });

  const lightComplete = plugin.modelCompletion({
    llm: {
      resolveModelInfo: async () => ({}),
      resolveCallConfig: async (c) => c,
      stream: async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '{"ok":true}' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"ok":true}' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  }, () => ({ provider: 'p', model: 'm' }), 's', { light: true });

  await lightComplete('sys', 'prompt', { ...lightRequests[0], hedge: false });
  assert.deepEqual(timeouts, [90_000], 'light lane keeps its 90s default timeout when gateway omits timeoutMs');
});
