import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DEFAULT_WAIT_SECONDS,
  readWebGeminiSettings,
  saveWebGeminiSettings,
  webGeminiSettingsPath,
} from '../lib/runtime/web-gemini-settings.js';
import {
  PREFERRED_WEB_GEMINI_TOOL,
  WEB_GEMINI_NOT_READY_MESSAGE,
  WEB_GEMINI_TEST_TOKEN,
  createWebGeminiPort,
  detectWebGeminiTools,
  extractWebGeminiText,
  isWebGeminiEligibleJob,
} from '../lib/runtime/web-gemini.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { createModelGateway } from '../lib/jobs/gateway.js';
import { createHostHandler } from '../lib/host.js';
import { createAssistService } from '../lib/assist.js';
import { StudyService } from '../lib/service.js';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

const geminiTool = {
  name: PREFERRED_WEB_GEMINI_TOOL,
  description: 'Ask Gemini web via browser extension',
  parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
};

const customTool = {
  name: 'mcp__custom__ask_anything',
  description: 'Custom prompt tool',
  parameters: { type: 'object', properties: { question: { type: 'string' } } },
};

async function withTempHome(t, fn) {
  const home = await mkdtemp(join(tmpdir(), 'web-gemini-home-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });
  return await fn(home);
}

test('web-gemini settings persist under DSH_HOME and validate waitSeconds and toolName', async t => {
  await withTempHome(t, async home => {
    const initial = await readWebGeminiSettings();
    assert.deepEqual(initial, { enabled: false, toolName: '', waitSeconds: DEFAULT_WAIT_SECONDS });
    assert.equal(webGeminiSettingsPath(), join(home, 'study', 'web-gemini.json'));

    const saved = await saveWebGeminiSettings({ enabled: true, toolName: PREFERRED_WEB_GEMINI_TOOL, waitSeconds: 420 });
    assert.deepEqual(saved, { enabled: true, toolName: PREFERRED_WEB_GEMINI_TOOL, waitSeconds: 420 });
    assert.deepEqual(await readWebGeminiSettings(), saved);

    await assert.rejects(saveWebGeminiSettings({ waitSeconds: 10 }), /30–1800/);
    await assert.rejects(saveWebGeminiSettings({ waitSeconds: 2400 }), /30–1800/);
    await assert.rejects(saveWebGeminiSettings({ toolName: 'not_an_mcp_tool' }), /格式无效/);
  });
});

test('detectWebGeminiTools prioritizes ask_gemini_web and extractWebGeminiText strips Chrome Copy banners', () => {
  const tools = detectWebGeminiTools([
    customTool,
    { name: 'mcp__audio__noop', parameters: { type: 'object', properties: { count: { type: 'integer' } } } },
    geminiTool,
  ]);
  assert.deepEqual(tools.map(item => [item.name, item.matched, item.argKey]), [
    [PREFERRED_WEB_GEMINI_TOOL, true, 'prompt'],
    ['mcp__custom__ask_anything', false, 'question'],
  ]);

  assert.equal(
    extractWebGeminiText({ content: [{ type: 'text', text: 'JSON\nCopy code\n{"ok":true}' }] }),
    '{"ok":true}',
  );
  assert.equal(
    extractWebGeminiText({ content: [{ type: 'text', text: 'json\n复制代码\n{"answer":"pong"}' }] }),
    '{"answer":"pong"}',
  );
  assert.throws(() => extractWebGeminiText({ isError: true, content: [{ type: 'text', text: 'browser disconnected' }] }), /browser disconnected/);
});

test('web-gemini serializes overlapping calls through one FIFO queue', async t => {
  await withTempHome(t, async () => {
    await saveWebGeminiSettings({ enabled: true, waitSeconds: 120 });
    let active = 0;
    let maxActive = 0;
    const order = [];
    const ctx = {
      tools: {
        schemas: () => [geminiTool],
        execute: async input => {
          active++;
          maxActive = Math.max(maxActive, active);
          const args = JSON.parse(input.calls[0].arguments);
          order.push(`start:${args.prompt}`);
          await new Promise(resolve => setTimeout(resolve, 25));
          order.push(`end:${args.prompt}`);
          active--;
          return { isError: false, value: { content: [{ type: 'text', text: `reply:${args.prompt}` }] } };
        },
      },
    };
    const port = createWebGeminiPort(ctx);
    const prepared = await port.prepareForAssist();
    const [a, b] = await Promise.all([
      prepared.ask('', 'first'),
      prepared.ask('', 'second'),
    ]);
    assert.equal(a, 'reply:first');
    assert.equal(b, 'reply:second');
    assert.equal(maxActive, 1, 'browser tab receives only one prompt at a time');
    assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
  });
});

test('gateway routes only non-concurrent single-shot tool-less tasks to web Gemini and keeps batched/light tasks normal', async t => {
  await withTempHome(t, async () => {
    await saveWebGeminiSettings({ enabled: true, waitSeconds: 300 });
    const webCalls = [];
    const directCalls = [];
    const ctx = {
      get: () => undefined,
      tools: {
        schemas: () => [geminiTool],
        execute: async input => {
          const args = JSON.parse(input.calls[0].arguments);
          webCalls.push(args.prompt);
          return { isError: false, value: { content: [{ type: 'text', text: 'WEB_OK' }] } };
        },
      },
    };
    const webGemini = createWebGeminiPort(ctx);

    const makeRecord = (kind, executionModes, detail = {}) => ({
      jobId: `job-${kind}`,
      kind,
      status: 'running',
      capabilities: { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: true, set: false, executionModes },
      calls: [],
      events: [],
      detail,
      execution: { mode: null },
      usage: { calls: 0, tokens: null, tokenUsage: null },
      runtime: { schemaVersion: 1, definitionVersion: 1, scopeId: 's1', activeAttemptId: 'att-1', attempts: [], steps: [] },
    });

    const makeGateway = (record, withDirectModel = true) => createModelGateway({
      context: { jobId: record.jobId, attemptId: 'att-1', signal: new AbortController().signal, assertCurrent() {} },
      record,
      host: {
        ctx,
        route: withDirectModel ? () => ({ provider: 'deepseek', model: 'deepseek-chat' }) : undefined,
        complete: withDirectModel ? async (_sys, prompt) => { directCalls.push(prompt); return 'DIRECT_OK'; } : undefined,
        light: withDirectModel ? async (_sys, prompt) => { directCalls.push(`light:${prompt}`); return 'LIGHT_OK'; } : undefined,
        webGemini,
      },
    });

    // Eligible tasks route via web Gemini even without a direct API route/key.
    for (const [kind, modes, detail] of [
      ['workflow-skeleton', ['direct', 'subagent'], {}],
      ['workflow-teaching', ['direct', 'subagent'], {}],
      ['daily-recap', ['direct', 'subagent'], {}],
      ['note-generate', ['direct'], {}],
      ['course-book-ai', ['direct'], {}],
      ['case-answer-card', ['direct'], {}],
      ['companion-lesson-build', ['direct'], {}],
      ['assist', ['direct', 'subagent'], {}],
      ['generation', ['direct', 'subagent'], { legacy: { kind: 'case' } }],
    ]) {
      const record = makeRecord(kind, modes, detail);
      const out = await makeGateway(record, false)
        .step('s1', { purpose: 'other', feature: 'study', requestedEffort: 'default', executionMode: modes.includes('subagent') ? 'agent-preferred' : 'direct', budget: { timeoutMs: 60_000 } })
        .complete('sys', `prompt-${kind}`);
      assert.equal(out, 'WEB_OK', `${kind} returns web response`);
      assert.equal(record.calls[0].model, PREFERRED_WEB_GEMINI_TOOL);
      assert.equal(record.calls[0].runner, modes.includes('subagent') ? 'subagent' : 'direct');
    }
    assert.equal(webCalls.length, 9);
    assert.equal(directCalls.length, 0);

    // Concurrent batched / light tasks stay on the direct/native model path.
    for (const [kind, detail, model] of [
      ['generation', { legacy: { kind: 'mcq' } }, undefined],
      ['supplement', {}, undefined],
      ['translation', {}, undefined],
      ['course-book-build', {}, undefined],
      ['coach-prep', {}, 'light'],
    ]) {
      const record = makeRecord(kind, ['direct', 'subagent'], detail);
      const out = await makeGateway(record, true)
        .step('s1', { purpose: 'other', feature: 'study', requestedEffort: 'default', executionMode: 'direct', budget: { timeoutMs: 60_000 } }, model ? { model } : {})
        .complete('sys', `prompt-${kind}`);
      assert.equal(out, model ? 'LIGHT_OK' : 'DIRECT_OK', `${kind} stays off web Gemini`);
    }
    assert.equal(webCalls.length, 9);
    assert.equal(directCalls.length, 5);
    assert.equal(isWebGeminiEligibleJob({ record: makeRecord('generation', ['direct'], { legacy: { kind: 'case' } }), options: { model: 'light' } }), false);
  });
});

test('host actions webGemini.status, webGemini.set, webGemini.test and assist.js integrate end to end', async t => {
  await withTempHome(t, async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-gemini-lib-'));
    const disposers = [];
    const seen = [];
    let childCalled = false;
    t.after(async () => {
      for (const dispose of disposers.reverse()) dispose?.();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });
    const ctx = {
      sessions: { get: () => ({ header: { cwd: root } }) },
      get: () => undefined,
      effect: setup => disposers.push(setup()),
      tools: {
        schemas: () => [geminiTool, customTool],
        execute: async input => {
          const args = JSON.parse(input.calls[0].arguments);
          seen.push({ name: input.name, prompt: args.prompt });
          return {
            isError: false,
            value: {
              content: [{
                type: 'text',
                text: args.prompt.includes(WEB_GEMINI_TEST_TOKEN)
                  ? WEB_GEMINI_TEST_TOKEN
                  : JSON.stringify({ title: '测试标题', answer: '来自网页 Gemini 的解答' }),
              }],
            },
          };
        },
      },
    };
    const handle = createHostHandler(ctx, { libraryRoot: root }, undefined, { owner: ctx });
    const call = (action, args = {}) => handle('call', { sessionId: 's1', action, args });

    const before = await call('webGemini.status');
    assert.equal(before.ok, true);
    assert.equal(before.value.enabled, false);
    assert.equal(before.value.available, true);
    assert.equal(before.value.effectiveTool, PREFERRED_WEB_GEMINI_TOOL);
    assert.equal(before.value.active, false);

    // Manual connectivity test works even before enabling globally.
    const probe = await call('webGemini.test', { waitSeconds: 90 });
    assert.equal(probe.ok, true);
    assert.equal(probe.value.ok, true);
    assert.equal(probe.value.toolName, PREFERRED_WEB_GEMINI_TOOL);
    assert.equal(probe.value.matchedToken, true);
    assert.equal(probe.value.waitSeconds, 90);
    assert.ok(seen[0].prompt.includes(WEB_GEMINI_TEST_TOKEN));

    const enabled = await call('webGemini.set', { enabled: true, waitSeconds: 720 });
    assert.equal(enabled.ok, true);
    assert.equal(enabled.value.active, true);
    assert.equal(enabled.value.waitSeconds, 720);

    // Verify assist.js routes through webGemini even without service.complete and does not invoke native child.
    const service = new StudyService(root, { webGemini: createWebGeminiPort(ctx) });
    const saved = [];
    service.saveAssistResult = async payload => {
      saved.push(payload);
      return { message: '已收到网页助教解答', cardId: payload.ref.cardId };
    };
    await service.store.update(state => {
      state.decks.push({
        id: 'd1',
        title: 'OS',
        cards: [{ id: 'c1', kind: 'qa', prompt: '什么是分页？', answer: '按页映射', topic: '内存管理' }],
      });
    });
    const assist = createAssistService({
      children: {
        clearAssistChildren() {},
        disposeAssistChildren() {},
        async withAssistChild() { childCalled = true; throw new Error('should not call native child'); },
      },
    });
    const started = await assist.startAssist(
      { get: name => (name === 'agents' ? { get: () => ({ id: 'parent' }) } : name === 'subagents' ? { getProvider: () => ({ id: 'spawn', capabilities: {} }) } : undefined) },
      {
        root,
        service,
        sessionId: 's1',
        mode: 'ask',
        ref: { deckId: 'd1', cardId: 'c1' },
        text: '为什么用分页？',
        helpChoices: [],
        card: { id: 'c1', kind: 'qa', prompt: '什么是分页？', answer: '按页映射', topic: '内存管理' },
        deckTitle: 'OS',
      },
    );
    assert.equal(started.runtime, 'subagent');
    for (const pollUntil = Date.now() + 10_000; Date.now() < pollUntil && assist.assistView(root).tasks[0]?.status === 'running';) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const task = assist.assistView(root).tasks[0];
    assert.equal(task.status, 'done');
    assert.equal(childCalled, false);
    assert.equal(saved.length, 1);
  });
});

test('WebGeminiSection and ModelPane render controls in zh and en without untranslated Han text', async () => {
  const m = await loadUi(`
    export { default as WebGeminiSection } from './ui/settings/WebGeminiSection.jsx';
    export { default as ModelPane } from './ui/settings/ModelPane.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const h = React.createElement;
  const han = /[㐀-鿿]/;
  const status = {
    enabled: true,
    toolName: PREFERRED_WEB_GEMINI_TOOL,
    waitSeconds: 600,
    minWaitSeconds: 30,
    maxWaitSeconds: 1800,
    effectiveTool: PREFERRED_WEB_GEMINI_TOOL,
    missing: null,
    available: true,
    hasToolRegistry: true,
    tools: [{ name: PREFERRED_WEB_GEMINI_TOOL, server: 'gemini-browser', label: 'ask_gemini_web', matched: true }],
    active: true,
  };
  const render = (el, language) => {
    m.setUiLanguage(language);
    try { return renderToStaticMarkup(inApp(m, el, { language })); } finally { m.setUiLanguage('zh'); }
  };

  const zh = render(h(m.WebGeminiSection, { initialStatus: status }), 'zh');
  assert.match(zh, /网页 Gemini 代理/);
  assert.match(zh, /手动测试连通与回答/);
  assert.match(zh, /name="webGeminiWaitSeconds"[^>]*value="600"/);
  assert.match(zh, /role="switch"/);

  const en = render(h(m.WebGeminiSection, { initialStatus: status }), 'en');
  assert.match(en, /Web Gemini bridge/);
  assert.match(en, /Test connection &amp; answer/);
  assert.doesNotMatch(en.replace(/<[^>]+>/g, ' '), han, 'English rendering has zero Han characters');

  const paneEn = render(h(m.ModelPane, {
    data: { root: 'r', model: { ready: true, reason: 'ok', label: 'DeepSeek · V4 Flash' }, modelReady: true, sources: [], decks: [] },
    host: {},
  }), 'en');
  assert.doesNotMatch(paneEn.replace(/<[^>]+>/g, ' '), han, 'ModelPane with WebGeminiSection has zero Han characters in English');

  const notReadyProbe = {
    ok: false,
    reason: 'not-ready',
    toolName: PREFERRED_WEB_GEMINI_TOOL,
    message: '请确认已在 DSH 启动 ask-gemini-mcp，并在浏览器打开已加载扩展的 Gemini 网页。',
  };
  const notReadyZh = render(h(m.WebGeminiSection, { initialStatus: status, initialProbe: notReadyProbe }), 'zh');
  assert.match(notReadyZh, /测试未通过：网页 Gemini 配置未启动/);
  assert.doesNotMatch(notReadyZh, /网页 Gemini 代理已就绪/, 'Failed probe hides contradictory green ready banner');
  const notReadyEn = render(h(m.WebGeminiSection, { initialStatus: status, initialProbe: notReadyProbe }), 'en');
  assert.match(notReadyEn, /Test failed: Web Gemini is not started/);
  assert.doesNotMatch(notReadyEn.replace(/<[^>]+>/g, ' '), han, 'Not-ready probe renders cleanly in English');

  const timeoutProbe = {
    ok: false,
    reason: 'timeout',
    toolName: PREFERRED_WEB_GEMINI_TOOL,
    message: '网页 Gemini 等待回答超时（600 秒内未完成响应）',
  };
  const timeoutZh = render(h(m.WebGeminiSection, { initialStatus: status, initialProbe: timeoutProbe }), 'zh');
  assert.match(timeoutZh, /测试未通过：等待回答超时/);
  const timeoutEn = render(h(m.WebGeminiSection, { initialStatus: status, initialProbe: timeoutProbe }), 'en');
  assert.match(timeoutEn, /Test failed: response timed out/);
  assert.doesNotMatch(timeoutEn.replace(/<[^>]+>/g, ' '), han, 'Timeout probe renders cleanly in English');

  const okProbe = { ok: true, latencyMs: 1200, toolName: PREFERRED_WEB_GEMINI_TOOL, matchedToken: true };
  const okZh = render(h(m.WebGeminiSection, { initialStatus: status, initialProbe: okProbe }), 'zh');
  assert.match(okZh, /网页端已正常响应测试指令/);
  const okEn = render(h(m.WebGeminiSection, { initialStatus: status, initialProbe: okProbe }), 'en');
  assert.match(okEn, /Web Gemini responded to the verification prompt/);
  assert.doesNotMatch(okEn.replace(/<[^>]+>/g, ' '), han, 'OK probe renders cleanly in English');
});

test('web-gemini rejects plain-text bridge errors and unverified replies as not-ready instead of passing', async t => {
  await withTempHome(t, async () => {
    await saveWebGeminiSettings({ enabled: true, waitSeconds: 120 });

    const extErrorText = 'Error: Chrome extension not connected. Open a Gemini page with the extension loaded.';
    assert.throws(() => extractWebGeminiText({ content: [{ type: 'text', text: extErrorText }] }), /Chrome extension not connected/);
    assert.throws(() => extractWebGeminiText({ status: 'error', content: [{ type: 'text', text: 'bridge down' }] }), /bridge down/);

    const makePort = replyOrReject => createWebGeminiPort({
      tools: {
        schemas: () => [geminiTool],
        execute: async () => (typeof replyOrReject === 'function' ? replyOrReject() : replyOrReject),
      },
    });

    // Plain-text extension error returned without isError: true must fail connectivity test cleanly.
    const extProbe = await makePort({ isError: false, value: { content: [{ type: 'text', text: extErrorText }] } }).test();
    assert.equal(extProbe.ok, false);
    assert.equal(extProbe.reason, 'not-ready');
    assert.doesNotMatch(extProbe.message, /Chrome extension/i);
    assert.match(extProbe.message, /ask-gemini-mcp/);

    // Replies that do not include the verification token must also fail instead of showing green pass.
    const unexpectedReplyProbe = await makePort({ isError: false, value: { content: [{ type: 'text', text: 'Something unrelated' }] } }).test();
    assert.equal(unexpectedReplyProbe.ok, false);
    assert.equal(unexpectedReplyProbe.matchedToken, false);
    assert.equal(unexpectedReplyProbe.reason, 'not-ready');

    // Timeouts report reason='timeout' and translate cleanly to English.
    const timeoutProbe = await makePort(() => { throw new Error('Request timed out after 120s'); }).test({ waitSeconds: 120 });
    assert.equal(timeoutProbe.ok, false);
    assert.equal(timeoutProbe.reason, 'timeout');
    assert.match(timeoutProbe.message, /120 秒内未完成响应/);
    assert.match(localizeAppMessage(timeoutProbe.message, 'en'), /120 seconds/);

    // Task execution surfaces the user-facing "not started" message in both zh and en.
    const taskPort = makePort({ isError: false, value: { content: [{ type: 'text', text: extErrorText }] } });
    const prepared = await taskPort.prepareForAssist();
    await assert.rejects(prepared.ask('', 'hello'), error => {
      assert.equal(error.message, WEB_GEMINI_NOT_READY_MESSAGE);
      assert.match(localizeAppMessage(error.message, 'en'), /Web Gemini is not started/);
      return true;
    });
  });
});

test('companion.ask routes through active webGemini port and falls back cleanly when disabled', async t => {
  await withTempHome(t, async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-gemini-comp-'));
    t.after(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });

    const webPrompts = [];
    const lightPrompts = [];
    const ctx = {
      tools: {
        schemas: () => [geminiTool],
        execute: async input => {
          const args = JSON.parse(input.calls[0].arguments);
          webPrompts.push(args.prompt);
          return {
            isError: false,
            value: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  answerMarkdown: 'Web Gemini tutor explanation for slide 2.',
                  suggestedCard: {
                    prompt: 'What breaks pointwise convergence?',
                    answer: 'Area escape without uniform sup-norm bound.',
                    misconception: 'Assuming pointwise limit equals integral limit.',
                  },
                }),
              }],
            },
          };
        },
      },
    };
    const webGemini = createWebGeminiPort(ctx);

    // 1. Active webGemini works even when no API complete/light model is configured
    await saveWebGeminiSettings({ enabled: true, waitSeconds: 180 });
    const webOnlySvc = new StudyService(root, { webGemini });
    t.after(() => webOnlySvc.dispose());
    const webReply = await webOnlySvc.call('companion.ask', {
      language: 'en',
      question: 'Why does pointwise convergence fail here?',
      context: { lessonTitle: 'Uniform Convergence', slide: 2, slideTitle: 'Moving Bump' },
    });
    assert.equal(webPrompts.length, 1);
    assert.match(webReply.answerMarkdown, /Web Gemini tutor explanation/);
    assert.equal(webReply.suggestedCard?.prompt, 'What breaks pointwise convergence?');

    // 2. Disabling webGemini falls back cleanly to providedLight / providedComplete
    await saveWebGeminiSettings({ enabled: false, waitSeconds: 180 });
    const fallbackSvc = new StudyService(root, {
      webGemini,
      light: async (_sys, prompt) => {
        lightPrompts.push(prompt);
        return JSON.stringify({ answerMarkdown: 'Fallback light model answer.', suggestedCard: null });
      },
    });
    t.after(() => fallbackSvc.dispose());
    const fallbackReply = await fallbackSvc.call('companion.ask', {
      language: 'en',
      question: 'Second question?',
      context: { lessonTitle: 'Uniform Convergence', slide: 3 },
    });
    assert.equal(webPrompts.length, 1, 'Disabled webGemini must not be invoked');
    assert.equal(lightPrompts.length, 1, 'Fallback light model must handle the ask');
    assert.equal(fallbackReply.answerMarkdown, 'Fallback light model answer.');
    assert.equal(fallbackReply.suggestedCard, null);
  });
});
