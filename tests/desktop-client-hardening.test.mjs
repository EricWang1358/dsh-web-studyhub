import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpenAiCompleteAdapter } from '../packages/studyhub-desktop/adapters/http/openai-adapter.mjs';
import { longStreamFetch, resolveChatCompletionsUrl } from '../packages/studyhub-desktop/adapters/http/openai-stream.mjs';
import { createAgyCompleteAdapter } from '../packages/studyhub-desktop/adapters/cli/agy-adapter.mjs';
import { createCodexCompleteAdapter } from '../packages/studyhub-desktop/adapters/cli/codex-adapter.mjs';
import { runProcess } from '../packages/studyhub-desktop/adapters/cli/process-runner.mjs';
import { createDesktopCompletePort } from '../packages/studyhub-desktop/application/complete-port.js';
import { createDesktopHost } from '../packages/studyhub-desktop/application/desktop-host.js';
import { formatCallError, formatForwardAnswer } from '../packages/studyhub-desktop/application/desktop-errors.js';
import { createProviderDiscovery } from '../packages/studyhub-desktop/application/provider-discovery.js';
import { createRetrievalRuntime } from '../packages/studyhub-desktop/application/retrieval-runtime.js';
import { prepareRetrievalForAction } from '../packages/studyhub-desktop/application/retrieval-actions.js';
import { resolveEffectiveModel, defaultDesktopConfig } from '../packages/studyhub-desktop/domain/config-policy.js';
import { createConfigStore } from '../packages/studyhub-desktop/adapters/storage/config-store.mjs';
import { startLocalServer } from '../packages/studyhub-desktop/adapters/http/local-server.mjs';
import { createInProcessJobExecutor } from '../packages/studyhub-desktop/adapters/runtime/job-executor.mjs';

function makeSseResponse(chunks, status = 200) {
  const encoded = chunks.map((item) => (typeof item === 'string' ? Buffer.from(item, 'utf8') : item));
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'text/event-stream; charset=utf-8' }),
    body: {
      getReader() {
        return {
          async read() {
            if (index >= encoded.length) return { value: undefined, done: true };
            const value = encoded[index];
            index += 1;
            return { value, done: false };
          },
          releaseLock() {},
        };
      },
    },
    async text() {
      return Buffer.concat(encoded).toString('utf8');
    },
  };
}

function makeJsonResponse(body, status = 200) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    async text() {
      return raw;
    },
  };
}

test('OpenAI adapter streams SSE chunks, emits onOutput/onReasoning/usage, handles reasoning models and Azure URLs', async () => {
  assert.equal(
    resolveChatCompletionsUrl('https://my.openai.azure.com/openai/deployments/gpt4?api-version=2024-10-21'),
    'https://my.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-10-21',
  );

  const requests = [];
  const reported = [];
  const outputs = [];
  const reasoningCounts = [];

  const adapter = createOpenAiCompleteAdapter({
    baseUrl: 'https://api.example.com/v1',
    model: 'o3-mini',
    apiKey: 'sk-secret-key-1234567890',
    reasoningEffort: 'high',
  }, {
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return makeSseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"先分析问题"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":[{"type":"text","text":"是42"}]},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":20}}}\n\n',
        'data: [DONE]\n\n',
      ]);
    },
    report: (usage) => reported.push(usage),
  });

  const text = await adapter('system', 'prompt', {
    maxTokens: 500,
    onOutput: (chunk) => outputs.push(chunk),
    onReasoning: (count) => reasoningCounts.push(count),
  });

  assert.equal(text, '答案是42');
  assert.deepEqual(outputs, ['答案', '是42']);
  assert.deepEqual(reasoningCounts, [5]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
  assert.equal(requests[0].body.max_completion_tokens, 500);
  assert.equal(requests[0].body.max_tokens, undefined);
  assert.equal(requests[0].body.reasoning_effort, 'high');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].inputTokens, 100);
  assert.equal(reported[0].cacheReadTokens, 20);
  assert.equal(reported[0].outputTokens, 30);
});

test('OpenAI adapter classifies HTTP/MAX_TOKENS/EMPTY errors, retries stream_options 400, and handles body timeouts', async () => {
  // 1. 400 mentioning stream_options retries once without stream_options
  const calls = [];
  const retryAdapter = createOpenAiCompleteAdapter({
    baseUrl: 'https://api.example.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-test-retry-123456',
  }, {
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (calls.length === 1) {
        return makeJsonResponse({ error: { message: 'Unknown parameter: stream_options' } }, 400);
      }
      return makeJsonResponse({
        choices: [{ message: { content: [{ type: 'text', text: 'Recovered' }] }, finish_reason: 'stop' }],
      });
    },
    report: () => {},
  });
  assert.equal(await retryAdapter('sys', 'prompt'), 'Recovered');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].stream_options);
  assert.equal(calls[1].stream_options, undefined);

  // 2. HTTP 401 -> AUTHENTICATION, 429 -> RATE_LIMIT, finish_reason: length empty -> MAX_TOKENS
  const errorCase = (resp) => createOpenAiCompleteAdapter({
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o',
    apiKey: 'sk-secret-key-xyz987654321',
  }, { fetch: async () => resp, report: () => {} });

  await assert.rejects(() => errorCase(makeJsonResponse('unauthorized sk-secret-key-xyz987654321', 401))('s', 'p'), (err) => {
    assert.equal(err.code, 'AUTHENTICATION');
    assert.doesNotMatch(err.message, /sk-secret-key-xyz987654321/);
    return true;
  });
  await assert.rejects(() => errorCase(makeJsonResponse('rate limited', 429))('s', 'p'), (err) => err.code === 'RATE_LIMIT');
  await assert.rejects(() => errorCase(makeJsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }))('s', 'p'), (err) => err.code === 'MAX_TOKENS');
  await assert.rejects(() => errorCase(makeJsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }))('s', 'p'), (err) => err.code === 'EMPTY_RESPONSE');

  // 3. Body read abort/timeout is caught and wrapped with timeout message
  const slowBodyAdapter = createOpenAiCompleteAdapter({
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o',
    apiKey: 'sk-slow-body-secret-1234',
  }, {
    timeoutMs: 60,
    fetch: async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader() {
          return {
            read() {
              return new Promise((_resolve, reject) => {
                const keepAlive = setTimeout(() => {}, 1000);
                init.signal.addEventListener('abort', () => {
                  clearTimeout(keepAlive);
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
              });
            },
            releaseLock() {},
          };
        },
      },
    }),
    report: () => {},
  });
  await assert.rejects(() => slowBodyAdapter('s', 'p'), (err) => {
    assert.equal(err.name, 'TimeoutError');
    assert.match(err.message, /没有回复/);
    return true;
  });
});

test('longStreamFetch streams real HTTP SSE response with split multi-byte Chinese UTF-8 cleanly', async (t) => {
  const payload = Buffer.from('data: {"choices":[{"delta":{"content":"你好世界，机器学习！"}}]}\n\ndata: [DONE]\n\n', 'utf8');
  const splitAt = payload.indexOf(Buffer.from('好', 'utf8')) + 1;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write(payload.subarray(0, splitAt));
    setTimeout(() => {
      res.write(payload.subarray(splitAt));
      res.end();
    }, 15);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address();

  const adapter = createOpenAiCompleteAdapter({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'deepseek-chat',
    apiKey: 'sk-local-sse-test-1234',
  }, { fetch: longStreamFetch, report: () => {} });
  const text = await adapter('system', 'prompt');
  assert.equal(text, '你好世界，机器学习！');
});

test('process-runner decodes split multi-byte Chinese UTF-8 stdout chunks without replacement characters', async () => {
  const script = [
    'const buf = Buffer.from("深度学习与概率图模型\\n", "utf8");',
    'process.stdout.write(buf.subarray(0, 4));',
    'setTimeout(() => { process.stdout.write(buf.subarray(4)); }, 15);',
  ].join(' ');
  const lines = [];
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', script],
    timeoutMs: 10_000,
    onStdoutLine: (line) => lines.push(line),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '深度学习与概率图模型');
  assert.deepEqual(lines, ['深度学习与概率图模型']);
  assert.ok(!result.stdout.includes('\uFFFD'));
});

test('agy-adapter rejects non-zero exit even after partial deltas, forwards reasoningEffort, and emits onReasoning', async () => {
  const failingRunner = {
    run: async (req) => {
      req.onStdoutLine?.(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'partial answer' } }));
      return { code: 1, stdout: '', stderr: 'connection reset by peer', timedOut: false, aborted: false, truncated: false };
    },
  };
  const failComplete = createAgyCompleteAdapter({ executablePath: 'agy' }, { runner: failingRunner, report: () => {} });
  await assert.rejects(() => failComplete('sys', 'prompt'), /connection reset by peer/);

  const seenArgs = [];
  const reasoning = [];
  const okRunner = {
    run: async (req) => {
      seenArgs.push(...req.args);
      const lines = [
        JSON.stringify({ event: 'step_update', step_update: { step_type: 'thinking', thinking_delta: '思考中' } }),
        JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'OK' } }),
        JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK' } }),
      ];
      for (const line of lines) req.onStdoutLine?.(line);
      return { code: 0, stdout: lines.join('\n'), stderr: '', timedOut: false, aborted: false, truncated: false };
    },
  };
  const okComplete = createAgyCompleteAdapter({ executablePath: 'agy' }, { runner: okRunner, report: () => {} });
  const text = await okComplete('sys', 'prompt', { reasoningEffort: 'high', onReasoning: (n) => reasoning.push(n) });
  assert.equal(text, 'OK');
  assert.ok(seenArgs.includes('--effort'));
  assert.ok(seenArgs.includes('high'));
  assert.deepEqual(reasoning, [3]);
});

test('codex-adapter forwards reasoningEffort and emits onReasoning for reasoning items', async () => {
  const seenArgs = [];
  const reasoning = [];
  const okRunner = {
    run: async (req) => {
      seenArgs.push(...req.args);
      const lines = [
        JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'chain of thought' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Final answer' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
      ];
      for (const line of lines) req.onStdoutLine?.(line);
      return { code: 0, stdout: lines.join('\n'), stderr: '', timedOut: false, aborted: false, truncated: false };
    },
  };
  const complete = createCodexCompleteAdapter({ executablePath: 'codex' }, { runner: okRunner, report: () => {} });
  const text = await complete('sys', 'prompt', { reasoningEffort: 'medium', onReasoning: (n) => reasoning.push(n) });
  assert.equal(text, 'Final answer');
  assert.ok(seenArgs.includes('model_reasoning_effort="medium"'));
  assert.deepEqual(reasoning, [16]);
});

test('complete-port wires stageRequest, onEvent lifecycle, transient retry, light effort downgrade, and reasoning testConnection', async () => {
  const seen = [];
  let attempts = 0;
  const config = {
    ...defaultDesktopConfig(),
    mode: 'openai',
    reasoningEffort: 'high',
    openai: { providerId: 'custom', baseUrl: 'https://api.example.com/v1', model: 'o3-mini', apiKey: 'sk-123456' },
  };
  const port = createDesktopCompletePort({
    getConfig: () => config,
    getAgyExecutablePath: () => '',
    openaiComplete: () => async (system, prompt, execution) => {
      seen.push({ system, prompt, execution });
      attempts += 1;
      if (execution.task === 'test') return 'OK';
      if (attempts === 1) {
        const err = new Error('transient 502');
        err.code = 'SERVER_ERROR';
        err.status = 502;
        throw err;
      }
      return 'done';
    },
    agyComplete: () => undefined,
  });

  // 1. Job execution: stageRequest + onEvent + transient retry + configured effort
  const events = [];
  const complete = port.makeComplete(null, '', {});
  const out = await complete('SYS', 'VARIABLE\n\n---\n\nSTABLE', {
    jobId: 'job-12345678',
    stage: 'generate',
    retryDelays: [1, 1],
    onEvent: (evt) => events.push(evt.status),
  });
  assert.equal(out, 'done');
  assert.equal(attempts, 2);
  assert.deepEqual(events, ['running', 'complete']);
  assert.equal(seen[0].execution.reasoningEffort, 'high');
  assert.match(seen[0].prompt, /STABLE/);

  // 2. Light mode downgrades configured reasoningEffort to low
  const lightComplete = port.makeComplete(null, '', { light: true });
  await lightComplete('SYS', 'PROMPT', { retryDelays: [1] });
  assert.equal(seen.at(-1).execution.reasoningEffort, 'low');

  // 3. testConnection omits maxTokens: 16 for reasoning models (o3-mini)
  const testRes = await port.testConnection();
  assert.equal(testRes.ok, true);
  assert.equal(seen.at(-1).execution.maxTokens, undefined);
});

test('desktop-host ignores stale .dsh-study-binding.json, preserves libraryPlace on reasoningEffort update, disables webGemini, and preserves error.details', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studyhub-hardening-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const env = { DSH_HOME: join(dir, 'dsh-home') };
  const store = createConfigStore({ env, home: dir });
  const loaded = await store.load();
  await mkdir(loaded.library.root, { recursive: true });
  // Plant a stale DSH binding file inside the library root pointing elsewhere with broken model
  await writeFile(join(loaded.library.root, '.dsh-study-binding.json'), JSON.stringify({
    root: join(dir, 'wrong-hijacked-root'),
    provider: 'broken-dsh-provider',
    model: 'broken-dsh-model',
  }), 'utf8');

  const discovery = createProviderDiscovery({
    listCandidates: async (id) => (id === 'agy' ? ['C:\\agy.exe'] : []),
    probeVersion: async () => ({ ok: true, version: '1.0.0' }),
    listAgyModels: async () => ({ ok: false, models: [], reason: 'Unauthorized: please login' }),
  });
  await discovery.scan({ force: true });

  // Verify resolveEffectiveModel reports ready: false when probe failed even with saved executablePath
  const effFailedCli = resolveEffectiveModel({
    ...defaultDesktopConfig(),
    mode: 'agy',
    agy: { executablePath: 'C:\\agy.exe', model: '', effort: '' },
  }, discovery.getCached());
  assert.equal(effFailedCli.ready, false);
  assert.equal(effFailedCli.reason, 'no-credential');

  const host = await createDesktopHost({
    configStore: store,
    providerDiscovery: discovery,
    openaiComplete: () => async () => 'OK',
    agyComplete: () => undefined,
    jobExecutor: createInProcessJobExecutor(),
    openExternal: async () => ({ ok: true }),
    ensureDir: (p) => mkdir(p, { recursive: true }),
  });
  t.after(() => host.dispose());

  // 1. Stale .dsh-study-binding.json must NOT hijack root
  const b0 = await host.call('binding.get', {});
  assert.equal(b0.ok, true);
  assert.equal(b0.value.root, loaded.library.root);
  assert.equal(b0.value.libraryPlace.confirmed, false);
  assert.equal(b0.value.modelStatus.ready, false);
  assert.equal(b0.value.modelStatus.reason, 'no-route');

  // 2. Updating reasoningEffort with root: '' on non-custom root must NOT confirm libraryPlace
  const b1 = await host.call('binding.set', { root: '', reasoningEffort: 'high' });
  assert.equal(b1.ok, true);
  assert.equal(b1.value.reasoningEffort, 'high');
  assert.equal(b1.value.libraryPlace.confirmed, false);

  // 3. webGemini actions return clean disabled desktop responses
  const wg = await host.call('webGemini.status', {});
  assert.equal(wg.ok, true);
  assert.equal(wg.value.available, false);
  assert.equal(wg.value.enabled, false);

  // 4. desktop-errors preserves structured details object
  const richErr = Object.assign(new Error('detail boom'), { code: 'CONFLICT', details: { conflictId: 'c-1' } });
  assert.deepEqual(formatCallError(richErr, 'zh').details, { conflictId: 'c-1' });
  assert.deepEqual(formatForwardAnswer({ ok: false, error: richErr }).details, { conflictId: 'c-1' });
});

test('config-store serializes concurrent writes without losing fields and local-server closes immediately with keep-alive', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studyhub-hardening-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = createConfigStore({ env: { DSH_HOME: join(dir, 'dsh') }, home: dir });
  const customLib = join(dir, 'my-library');
  await mkdir(customLib, { recursive: true });

  await Promise.all([
    store.save({ mode: 'openai', openai: { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-concurrent-123456' } }),
    store.saveLibraryRoot(customLib),
    store.confirmLibraryPlace(),
  ]);
  const saved = JSON.parse(await readFile(store.configPath, 'utf8'));
  assert.equal(saved.openai.apiKey, 'sk-concurrent-123456');
  assert.equal(saved.libraryRoot, customLib);
  assert.equal(saved.libraryPlaceConfirmed, true);

  // Local server fast close under active keep-alive connection
  const srv = await startLocalServer({
    token: '0123456789abcdef0123456789abcdef',
    onCall: async () => { throw new Error('boom'); },
  });
  const res = await fetch(`${srv.baseUrl}/api/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Study-Token': '0123456789abcdef0123456789abcdef',
      Origin: srv.baseUrl,
      Connection: 'keep-alive',
    },
    body: JSON.stringify({ action: 'x', args: {} }),
  });
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('access-control-allow-origin'), srv.baseUrl);
  const t0 = Date.now();
  await srv.close();
  assert.ok(Date.now() - t0 < 1000, 'server.close() must not stall on keep-alive sockets');
});

test('retrieval-runtime deduplicates concurrent starts, stops client on write-tool abort, and prepares on job.control', async () => {
  let spawnCount = 0;
  let stopCount = 0;
  let writeCallCount = 0;
  const runtime = createRetrievalRuntime({
    getLibraryRoot: () => 'D:\\fake-lib',
    readSettings: async () => ({ provider: 'builtin' }),
    discover: async () => ({
      selected: { source: 'desktop', valid: true, version: '1.0.0', dir: 'D:\\ext' },
      candidates: [],
      platformSupported: true,
    }),
    startClient: async () => {
      spawnCount += 1;
      await new Promise((r) => setTimeout(r, 20));
      let alive = true;
      return {
        isRunning: () => alive,
        listTools: () => [{ name: 'ingest_data' }, { name: 'query_documents' }],
        async callTool(name) {
          if (name === 'ingest_data') {
            writeCallCount += 1;
            throw Object.assign(new Error('aborted during write'), { code: 'ABORT_ERR' });
          }
          return { content: [{ type: 'text', text: '{}' }] };
        },
        async close() { alive = false; stopCount += 1; },
      };
    },
    withIndexLock: async (fn) => fn(),
  });

  await Promise.all([
    runtime.ensureReady({ allowStart: true }),
    runtime.ensureReady({ allowStart: true }),
    runtime.ensureReady({ allowStart: true }),
  ]);
  assert.equal(spawnCount, 1, 'concurrent ensureReady must only spawn one retrieval client');

  const dshTools = runtime.asDshToolsService();
  await assert.rejects(() => dshTools.execute({ name: 'mcp__studyhub__ingest_data', arguments: {} }), /aborted during write/);
  assert.equal(writeCallCount, 1);
  assert.equal(stopCount, 1, 'write-tool failure must stop active client before releasing index lock');

  let preparedIfConfigured = 0;
  await prepareRetrievalForAction({ ensureReadyIfConfigured: async () => { preparedIfConfigured += 1; } }, 'job.control');
  assert.equal(preparedIfConfigured, 1);
});

test('job-executor marks synchronous run() throw as failed and provider-discovery deduplicates concurrent scans', async () => {
  const executor = createInProcessJobExecutor({ log: () => {} });
  const dshJobs = executor.asDshJobsService();
  const firstId = dshJobs.start({
    owner: 'desktop',
    kind: 'test',
    label: 'seed',
    run: () => ({ done: Promise.resolve() }),
  });
  const secondId = firstId.replace(/-1$/, '-2');
  assert.throws(() => {
    dshJobs.start({
      owner: 'desktop',
      kind: 'test',
      label: 'sync-boom',
      run: () => { throw new Error('sync boom'); },
    });
  }, /sync boom/);
  assert.equal(dshJobs.get(secondId, 'desktop')?.status, 'failed');

  let probeRuns = 0;
  const discovery = createProviderDiscovery({
    listCandidates: async (id) => {
      if (id === 'agy') {
        probeRuns += 1;
        await new Promise((r) => setTimeout(r, 25));
      }
      return [];
    },
    probeVersion: async () => ({ ok: false }),
    listAgyModels: async () => ({ ok: false, models: [], reason: '' }),
  });
  await Promise.all([discovery.scan(), discovery.scan(), discovery.scan()]);
  assert.equal(probeRuns, 1, 'concurrent scan({ force: false }) must deduplicate in-flight probe');
});
