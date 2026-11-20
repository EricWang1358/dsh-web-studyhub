import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  GENERATION_SETTINGS_DEFAULTS,
  normalizeGenerationSettings,
  resolveGenerationRequest,
  validateGenerationPatch,
} from '../lib/generation-settings.js';
import { jobContract } from '../lib/job-contract.js';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

const ui = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export * from './ui/tasks/time-limit.js';
  export { default as TimeLimit } from './ui/tasks/TimeLimit.jsx';
  export { logLines } from './ui/tasks/call-model.js';
  export { default as GenerationSettings, generationFormErrors } from './ui/GenerationSettings.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

function renderInApp(element, language = 'zh') {
  ui.setUiLanguage(language);
  try {
    return renderToStaticMarkup(inApp(ui, element, {
      data: {},
      app: { settingsEntry: { openSettings: () => {}, openModelSettings: () => {} } },
    }));
  } finally {
    ui.setUiLanguage('zh');
  }
}

test('jobTimeoutMinutes and bookCallTimeoutMinutes both accept 0 (unlimited) and enforce bounded positive ranges', () => {
  assert.equal(GENERATION_SETTINGS_DEFAULTS.jobTimeoutMinutes, 20);
  assert.equal(GENERATION_SETTINGS_DEFAULTS.bookCallTimeoutMinutes, 0);

  assert.deepEqual(validateGenerationPatch({ jobTimeoutMinutes: 0 }), { jobTimeoutMinutes: 0 });
  assert.deepEqual(validateGenerationPatch({ jobTimeoutMinutes: 180 }), { jobTimeoutMinutes: 180 });
  assert.deepEqual(validateGenerationPatch({ bookCallTimeoutMinutes: 0 }), { bookCallTimeoutMinutes: 0 });
  assert.deepEqual(validateGenerationPatch({ bookCallTimeoutMinutes: 3 }), { bookCallTimeoutMinutes: 3 });
  assert.deepEqual(validateGenerationPatch({ bookCallTimeoutMinutes: 180 }), { bookCallTimeoutMinutes: 180 });

  for (const bad of [1, 2, 3, 4, -1, 181]) {
    assert.throws(() => validateGenerationPatch({ jobTimeoutMinutes: bad }), /jobTimeoutMinutes/);
  }
  for (const bad of [1, 2, -1, 181]) {
    assert.throws(() => validateGenerationPatch({ bookCallTimeoutMinutes: bad }), /bookCallTimeoutMinutes/);
  }

  assert.equal(normalizeGenerationSettings({ jobTimeoutMinutes: 0 }).jobTimeoutMinutes, 0);
  assert.equal(normalizeGenerationSettings({ bookCallTimeoutMinutes: 15 }).bookCallTimeoutMinutes, 15);
  assert.equal(resolveGenerationRequest({ jobTimeoutMinutes: 0 }).performance.jobTimeoutMinutes, 0);
  assert.equal('bookCallTimeoutMinutes' in resolveGenerationRequest({ bookCallTimeoutMinutes: 15 }), false,
    'bookCallTimeoutMinutes stays off question-generation request payloads');
});

test('GenerationSettings renders both timeout fields, explains 0 = unlimited, and translates cleanly', () => {
  for (const language of ['zh', 'en']) {
    ui.setUiLanguage(language);
    const html = renderToStaticMarkup(React.createElement(ui.GenerationSettings, { root: '/tmp/lib', act: () => {} }));
    assert.match(html, /name="jobTimeoutMinutes"/);
    assert.match(html, /name="bookCallTimeoutMinutes"/);
    if (language === 'zh') {
      assert.match(html, /总纲与全书单次调用时限（分钟）/);
      assert.match(html, /无上限/);
    } else {
      assert.doesNotMatch(html.replace(/\bvalue="(?:中文|中英双语)"/g, '').replaceAll('>中文<', '><'), /[㐀-鿿]/);
    }
  }
  ui.setUiLanguage('zh');
  const errs = ui.generationFormErrors({ ...GENERATION_SETTINGS_DEFAULTS, jobTimeoutMinutes: 2, bookCallTimeoutMinutes: 1 });
  assert.match(errs.jobTimeoutMinutes, /0.*无上限/);
  assert.match(errs.bookCallTimeoutMinutes, /0.*无上限/);
  const validZero = ui.generationFormErrors({ ...GENERATION_SETTINGS_DEFAULTS, jobTimeoutMinutes: 0, bookCallTimeoutMinutes: 0 });
  assert.deepEqual(validZero, {});
});

test('TimeLimit strip renders unlimited and configured states for both generation and outline/book tasks in zh and en', () => {
  const t0 = Date.UTC(2026, 10, 18, 2, 0, 0);
  const startedAt = new Date(t0).toISOString();

  // 1. Generation with jobTimeoutMinutes = 0 (unlimited)
  const unlimitedGenJob = {
    id: 'g-unlim',
    status: 'running',
    stage: 'Writing',
    startedAt,
    totalTimeoutSeconds: 0,
    generationTimeoutSeconds: 0,
    coverageRun: { state: 'running', autoComplete: true, list: [{ round: 1, status: 'running', questions: 20, sections: 4 }], running: 1, percent: 0 },
    steps: [],
  };
  const unlimitedGen = jobContract(unlimitedGenJob);
  assert.deepEqual(unlimitedGen.detail.timeLimit, { seconds: 0, scope: 'round', callSeconds: 0, keeps: 'questions' });
  const genZh = renderInApp(React.createElement(ui.TimeLimit, { task: unlimitedGenJob, now: t0 + 60_000, steps: [] }), 'zh');
  assert.match(genZh, /每轮运行时限 无上限/);
  assert.match(genZh, /单次模型调用 无上限/);
  assert.match(genZh, /调整时限/);
  const genEn = renderInApp(React.createElement(ui.TimeLimit, { task: unlimitedGenJob, now: t0 + 60_000, steps: [] }), 'en');
  assert.doesNotMatch(genEn.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/);

  // 2. Outline / book task with default unlimited call timeout and with 15-min call timeout
  const outlineUnlim = {
    contractVersion: 2,
    jobId: 'co-1',
    kind: 'course-outline-build',
    title: '整理总纲 · CS',
    status: 'running',
    stage: { code: 'course-outline.inventory', text: '正在清点资料' },
    progress: { done: 1, total: 10, unit: 'steps', percent: null, segments: [] },
    actions: { cancel: { available: true }, pause: { available: true, mode: 'checkpoint' }, resume: { available: false, reason: { code: 'not-paused' } }, retry: { available: false, reason: { code: 'not-ended' } }, set: { available: false, reason: { code: 'capability-unsupported' } } },
    result: { refs: [], completeness: null },
    error: null,
    usage: { tokens: null, tokenUsage: null, calls: 0 },
    execution: { mode: 'direct' },
    detail: { course: 'CS', timeLimit: { scope: 'call', seconds: 0, callSeconds: 0, silentSeconds: 180, keeps: 'inventory' } },
    startedAt,
    calls: [],
    events: [],
  };
  const outZh = renderInApp(React.createElement(ui.TimeLimit, { task: { id: 'co-1', contract: outlineUnlim }, now: t0 + 120_000, steps: [] }), 'zh');
  assert.match(outZh, /单次模型调用时限 无上限/);
  assert.match(outZh, /连续 3 分钟无输出自动截断/);
  assert.match(outZh, /调整时限/);
  const outEn = renderInApp(React.createElement(ui.TimeLimit, { task: { id: 'co-1', contract: outlineUnlim }, now: t0 + 120_000, steps: [] }), 'en');
  assert.doesNotMatch(outEn.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/);

  const outlineCapped = { ...outlineUnlim, detail: { ...outlineUnlim.detail, timeLimit: { scope: 'call', seconds: 0, callSeconds: 900, silentSeconds: 180, keeps: 'inventory' } } };
  const capZh = renderInApp(React.createElement(ui.TimeLimit, { task: { id: 'co-1', contract: outlineCapped }, now: t0 + 120_000, steps: [] }), 'zh');
  assert.match(capZh, /单次模型调用最长 15 分钟/);
  assert.match(capZh, /调整时限/);
});

test('整理总纲 carries detail.timeLimit from settings.generation.bookCallTimeoutMinutes (0 by default, configurable)', async t => {
  const fake = outlineModel({ inventory: 'none' });
  const root = await privateRoot(t, 'outline-time-limit-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary({});
  await service.store.update(state => {
    state.sources.push(...structuredClone(sources));
    state.decks.push(...structuredClone(decks));
    state.focus = { mode: 'class', course: COURSE };
  });

  const firstId = (await service.call('generation.courseOutline.build', { course: COURSE, language: 'zh' })).jobId;
  const first = await settleJob(service, firstId);
  assert.equal(first.status, 'complete');
  const contractOfId = async id => (await service.call('snapshot')).jobs.find(j => j.id === id)?.contract;
  assert.deepEqual((await contractOfId(firstId)).detail.timeLimit, { scope: 'call', seconds: 0, callSeconds: 0, silentSeconds: 180, keeps: 'inventory' });

  await service.call('settings', { generation: { bookCallTimeoutMinutes: 12 } });
  const secondId = (await service.call('generation.courseOutline.build', { course: COURSE, language: 'zh' })).jobId;
  const second = await settleJob(service, secondId);
  assert.equal(second.status, 'complete');
  assert.deepEqual((await contractOfId(secondId)).detail.timeLimit, { scope: 'call', seconds: 0, callSeconds: 720, silentSeconds: 180, keeps: 'inventory' });
});

test('a single call exceeding callTimeoutSeconds in parallel inventory fails alone without retry, while 6 in a row trip the breaker', async () => {
  const { createModelGateway } = await import('../lib/jobs/gateway.js');
  const { createParallel } = await import('../lib/contexts/generation/inventory/parallel.js');
  const { policyOf } = await import('../lib/contexts/generation/inventory/policy.js');
  const { goldenRuntimeContracts } = await import('./fixtures/unified-runtime-contract.mjs');

  const runStage = async (shouldHang) => {
    const record = structuredClone(goldenRuntimeContracts.running);
    record.calls = [];
    record.runtime.steps = [];
    const controller = new AbortController();
    let calls = 0;
    const host = {
      ctx: { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } }) } },
      sessionId: 'fixture',
      route: () => ({ provider: 'p', model: 'm' }),
      complete: (_s, _p, req) => {
        const n = ++calls;
        if (!shouldHang(n)) return Promise.resolve('{"ok":true}');
        return new Promise((_resolve, reject) => {
          const hold = setTimeout(() => {}, 1000);
          req.signal.addEventListener('abort', () => {
            clearTimeout(hold);
            reject(Object.assign(new Error('Model stream aborted'), { name: 'AbortError', modelFailure: true }));
          }, { once: true });
        });
      },
    };
    const context = { jobId: record.jobId, attemptId: record.attemptId, signal: controller.signal, pauseRequested: false, assertCurrent() { controller.signal.throwIfAborted(); } };
    context.gateway = createModelGateway({ context, record, host });
    const ctx = { context, kept: { results: new Map() }, state: { reused: 0 }, show: () => {}, boundary: () => false, plan: { language: 'zh', callTimeoutSeconds: 0.05 } };
    const parallel = createParallel(ctx, { limit: 3, silentMs: 60_000 });
    const run = count => parallel.each(Array.from({ length: count }, (_, at) => at),
      at => parallel.ask(`inv:${at}`, { stage: 'inventory', part: at + 1, parts: count }, policyOf('inventory', {}), { system: 's', prompt: 'p' }, text => JSON.parse(text)),
      'inventory');
    return { run, record, calls: () => calls };
  };

  // One slow call among fast ones: fails alone without a second 15-min retry, rest succeed
  const mixed = await runStage(n => n === 2);
  const results = await mixed.run(4);
  assert.deepEqual(results.map(Boolean), [true, false, true, true]);
  assert.equal(mixed.calls(), 4, 'timed-out call was not retried a second time');
  const timedOutCall = mixed.record.calls.find(c => c.part === 2);
  assert.equal(timedOutCall.status, 'failed');
  assert.equal(timedOutCall.reason, 'call-timeout');

  // 6 consecutive call-timeouts: breaker stops the stage naming Settings › Question defaults
  const allSlow = await runStage(() => true);
  await assert.rejects(allSlow.run(20), error => {
    assert.equal(error.code, 'model-failing');
    assert.match(error.message, /单次模型调用时限.*设置 › 出题偏好/);
    return true;
  });
});
