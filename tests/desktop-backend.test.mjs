import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAgyStreamArgs,
  buildAgyUserMessageLine,
  buildAgyWrappedPrompt,
  mapAgyUsageToBuckets,
  parseAgyJsonResult,
  parseAgyModelsOutput,
  parseAgyStreamLine,
  parseAgyStreamOutput,
} from '../packages/studyhub-desktop/domain/agy-protocol.js';
import {
  OPENAI_PRESETS,
  applyConfigPatch,
  concurrencyHookForMode,
  concurrencyPolicyForMode,
  defaultDesktopConfig,
  redactDesktopConfig,
  resolveEffectiveModel,
} from '../packages/studyhub-desktop/domain/config-policy.js';
import { DESKTOP_CAPABILITIES } from '../packages/studyhub-desktop/domain/contracts.js';
import { clipDetail, keyLast4, redactSecret } from '../packages/studyhub-desktop/domain/redact.js';
import { openableExternalUrl, parseCliVersion, parseCmdShimTarget } from '../packages/studyhub-desktop/domain/shim-parser.js';
import { createDesktopHost } from '../packages/studyhub-desktop/application/desktop-host.js';
import { createProviderDiscovery } from '../packages/studyhub-desktop/application/provider-discovery.js';
import { desktopUpdateView } from '../packages/studyhub-desktop/application/update-view.js';
import { createAgyCompleteAdapter } from '../packages/studyhub-desktop/adapters/cli/agy-adapter.mjs';
import { createProcessRunner, runProcess } from '../packages/studyhub-desktop/adapters/cli/process-runner.mjs';
import { startLocalServer } from '../packages/studyhub-desktop/adapters/http/local-server.mjs';
import { createOpenAiCompleteAdapter } from '../packages/studyhub-desktop/adapters/http/openai-adapter.mjs';
import { createInProcessJobExecutor } from '../packages/studyhub-desktop/adapters/runtime/job-executor.mjs';
import { createConfigStore } from '../packages/studyhub-desktop/adapters/storage/config-store.mjs';
import { effectiveConcurrencyLimit, registerHostConcurrencyCap } from '../lib/generation-settings.js';
import { totalTokens, usageFromTokenUsage } from '../lib/token-usage.js';
import { withUsageSink } from '../lib/usage-scope.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES_DIR = join(REPO_ROOT, 'packages', 'studyhub-desktop', 'fixtures');
const SIDECAR_ENTRY = join(REPO_ROOT, 'packages', 'studyhub-desktop', 'entry', 'sidecar.mjs');

function rawHttpRequest({ port, method = 'POST', path = '/api/call', headers = {}, body = '' }) {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveReq({ status: res.statusCode, headers: res.headers, text });
      });
    });
    req.on('error', rejectReq);
    if (body) req.write(body);
    req.end();
  });
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/* ============================================================================
 * 1. Domain Pure Tests
 * ============================================================================ */

test('domain/agy-protocol parses real agy JSON and stream-json fixtures without double-counting thinking_tokens', async () => {
  const realJson = JSON.parse(await readFile(join(FIXTURES_DIR, 'agy-real-output.json'), 'utf8'));
  const parsedJson = parseAgyJsonResult(realJson);
  assert.equal(parsedJson.text, 'PONG\n');
  assert.equal(parsedJson.usage.inputTokens, 8306);
  assert.equal(parsedJson.usage.outputTokens, 45);
  assert.equal(parsedJson.usage.cacheReadTokens, 0);
  assert.equal(parsedJson.usage.reasoningTokens, 42);

  // Verify StudyHub token-usage.js compatibility (thinking_tokens is NOT added again)
  const studyBuckets = usageFromTokenUsage(parsedJson.usage);
  assert.deepEqual(studyBuckets, {
    uncachedInputTokens: 8306,
    outputTokens: 45,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(totalTokens(studyBuckets), 8351);

  // Also parse single JSON directly via unified stream parser
  const viaUnified = parseAgyStreamOutput(JSON.stringify(realJson));
  assert.equal(viaUnified.text, 'PONG\n');

  // Parse real stream-json fixture
  const streamText = await readFile(join(FIXTURES_DIR, 'agy-stream-output.jsonl'), 'utf8');
  const lines = streamText.trim().split(/\r?\n/);
  const deltaLine = parseAgyStreamLine(lines[2]);
  assert.equal(deltaLine?.textDelta, 'STREAM_OK_37KB\n');

  const parsedStream = parseAgyStreamOutput(streamText);
  assert.equal(parsedStream.text, 'STREAM_OK_37KB\n');
  assert.equal(parsedStream.usage.inputTokens, 17806);
  assert.equal(parsedStream.usage.outputTokens, 80);
  assert.equal(totalTokens(usageFromTokenUsage(parsedStream.usage)), 17886);

  // Cached input tokens are subtracted from uncached when total === input + output
  const cachedBuckets = mapAgyUsageToBuckets({
    input_tokens: 1000,
    output_tokens: 100,
    thinking_tokens: 20,
    cache_read_tokens: 400,
    total_tokens: 1100,
  });
  assert.equal(cachedBuckets.inputTokens, 600);
  assert.equal(cachedBuckets.cacheReadTokens, 400);
  assert.equal(totalTokens(usageFromTokenUsage(cachedBuckets)), 1100);
});

test('domain/agy-protocol builds safe stream-json args, wrapped prompt, NDJSON message, and parses models TSV', () => {
  const args = buildAgyStreamArgs({ timeoutMs: 120_000, model: 'gemini-3.8-flash-medium', effort: 'high' });
  assert.deepEqual(args, [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--print-timeout', '120s',
    '--model', 'gemini-3.8-flash-medium',
    '--effort', 'high',
  ]);
  assert.ok(!args.includes('--dangerously-skip-permissions'));

  const wrapped = buildAgyWrappedPrompt('Be concise.', 'Explain TCP.');
  assert.match(wrapped, /\[System Instruction\]/);
  assert.match(wrapped, /Do not call any tools/);
  assert.match(wrapped, /\[User\]\nExplain TCP\./);

  const ndjson = buildAgyUserMessageLine(wrapped);
  assert.ok(ndjson.endsWith('\n'));
  assert.equal(JSON.parse(ndjson).event, 'user');
  assert.equal(JSON.parse(ndjson).message.content, wrapped);

  const models = parseAgyModelsOutput('gemini-4-neon-high\tGemini 4 Neon High\ngpt-oss-120b-medium\tGPT OSS\n');
  assert.deepEqual(models, [
    { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon High' },
    { id: 'gpt-oss-120b-medium', name: 'GPT OSS' },
  ]);
});

test('domain/redact strips secret, 12-char prefix, and Bearer tokens', () => {
  const secret = 'sk-live-secret1234567890abcdef';
  const raw = `Authorization: Bearer ${secret} failed for key ${secret.slice(0, 12)} and ?api_key=xyz123`;
  const redacted = redactSecret(raw, secret);
  assert.ok(!redacted.includes(secret));
  assert.ok(!redacted.includes(secret.slice(0, 12)));
  assert.ok(!redacted.includes('xyz123'));
  assert.equal(keyLast4(secret), 'cdef');
  assert.equal(clipDetail('  a \n  b  ', 5), 'a b');
});

test('domain/config-policy enforces credential isolation on baseUrl change, domestic presets, and CLI concurrency cap', () => {
  assert.deepEqual(OPENAI_PRESETS.map((p) => p.id), ['zhipu', 'siliconflow', 'deepseek', 'custom']);
  assert.equal(OPENAI_PRESETS.find((p) => p.id === 'deepseek').baseUrl, 'https://api.deepseek.com');
  assert.equal(OPENAI_PRESETS.find((p) => p.id === 'siliconflow').defaultModel, 'deepseek-ai/DeepSeek-V3');
  assert.deepEqual(concurrencyPolicyForMode('agy'), { defaultConcurrency: 1, maxConcurrency: 2 });
  assert.deepEqual(concurrencyPolicyForMode('openai'), { defaultConcurrency: null, maxConcurrency: null });
  assert.deepEqual(concurrencyHookForMode('agy'), { max: 2, default: 1 });
  assert.equal(concurrencyHookForMode('openai'), null);

  const initial = applyConfigPatch(defaultDesktopConfig(), {
    mode: 'openai',
    openai: {
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1/',
      model: 'deepseek-chat',
      apiKey: 'sk-deepseek-1234567890abcdef',
    },
  });
  assert.equal(initial.keyDropped, false);
  assert.equal(initial.config.openai.baseUrl, 'https://api.deepseek.com/v1');

  // Same normalized baseUrl with trailing slash does NOT drop key
  const sameUrl = applyConfigPatch(initial.config, {
    openai: { baseUrl: 'https://api.deepseek.com/v1///', model: 'deepseek-reasoner' },
  });
  assert.equal(sameUrl.keyDropped, false);
  assert.equal(sameUrl.config.openai.apiKey, 'sk-deepseek-1234567890abcdef');

  // Changing baseUrl without new key MUST drop stored apiKey
  const changedUrl = applyConfigPatch(initial.config, {
    openai: { providerId: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  });
  assert.equal(changedUrl.keyDropped, true);
  assert.equal(changedUrl.config.openai.apiKey, '');
  assert.equal(redactDesktopConfig(changedUrl.config).openai.hasKey, false);

  // Changing baseUrl WITH a new key stores the new key
  const replaced = applyConfigPatch(initial.config, {
    openai: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-zhipu-9999999999999999' },
  });
  assert.equal(replaced.keyDropped, false);
  assert.equal(replaced.config.openai.apiKey, 'sk-zhipu-9999999999999999');

  // Effective model status never returns 'unknown'
  const missingKeyStatus = resolveEffectiveModel(changedUrl.config, []);
  assert.equal(missingKeyStatus.ready, false);
  assert.equal(missingKeyStatus.reason, 'no-credential');
});

test('domain/shim-parser validates external URLs and unwraps npm .cmd shims', () => {
  assert.equal(openableExternalUrl('https://github.com/EricWang1358/dsh-web-studyhub/releases'), 'https://github.com/EricWang1358/dsh-web-studyhub/releases');
  assert.equal(openableExternalUrl('javascript:alert(1)'), null);
  assert.equal(openableExternalUrl('file:///C:/Windows/win.ini'), null);
  assert.equal(openableExternalUrl('https://user:pass@example.com'), null);

  const claudeCmd = '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n';
  assert.deepEqual(parseCmdShimTarget(claudeCmd, 'C:\\node_global'), {
    kind: 'exe',
    targetPath: 'C:\\node_global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
  });

  const codexCmd = '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  assert.deepEqual(parseCmdShimTarget(codexCmd, 'C:\\node_global'), {
    kind: 'node-script',
    targetPath: 'C:\\node_global\\node_modules\\@openai\\codex\\bin\\codex.js',
  });

  // Standard Windows %~dp0 batch shims (no trailing %)
  const stdExeBatch = '@echo off\r\n"%~dp0\\bin\\agy.exe" %*\r\n';
  assert.deepEqual(parseCmdShimTarget(stdExeBatch, 'C:\\tools\\agy'), {
    kind: 'exe',
    targetPath: 'C:\\tools\\agy\\bin\\agy.exe',
  });
  const stdJsBatch = '@echo off\r\nnode "%~dp0cli.mjs" %*\r\n';
  assert.deepEqual(parseCmdShimTarget(stdJsBatch, 'C:\\tools\\cli'), {
    kind: 'node-script',
    targetPath: 'C:\\tools\\cli\\cli.mjs',
  });
  assert.equal(parseCliVersion('codex-cli 0.170.0\n'), '0.170.0');
});

/* ============================================================================
 * 2. Process Runner + Agy Adapter Tests
 * ============================================================================ */

test('adapters/cli/process-runner handles >40KB stdin, output cap, timeout, AbortSignal tree kill, and .cmd unwrapping', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-runner-test-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  // 2a. >40KB stdin round-trip
  const echoScript = join(work, 'echo-stdin.mjs');
  await writeFile(echoScript, [
    'const chunks = [];',
    'for await (const c of process.stdin) chunks.push(c);',
    'const all = Buffer.concat(chunks).toString("utf8");',
    'process.stdout.write(JSON.stringify({ len: all.length, tail: all.slice(-16) }));',
  ].join('\n'), 'utf8');

  const bigPayload = `${'A'.repeat(45_000)}END_MARKER_45KB\n`;
  const bigRes = await runProcess({ command: echoScript, stdinText: bigPayload, timeoutMs: 10_000 });
  assert.equal(bigRes.code, 0);
  const bigJson = JSON.parse(bigRes.stdout);
  assert.equal(bigJson.len, bigPayload.length);
  assert.equal(bigJson.tail, 'END_MARKER_45KB\n');

  // 2b. Output cap
  const floodScript = join(work, 'flood.mjs');
  await writeFile(floodScript, 'process.stdout.write("X".repeat(20000));\n', 'utf8');
  const capRes = await runProcess({ command: floodScript, maxOutputBytes: 1024, timeoutMs: 10_000 });
  assert.equal(capRes.code, 0);
  assert.equal(capRes.truncated, true);
  assert.equal(Buffer.byteLength(capRes.stdout, 'utf8'), 1024);

  // 2c. Timeout kill
  const hangScript = join(work, 'hang.mjs');
  await writeFile(hangScript, 'setTimeout(() => {}, 60000);\n', 'utf8');
  const timeRes = await runProcess({ command: hangScript, timeoutMs: 250 });
  assert.equal(timeRes.timedOut, true);

  // 2d. AbortSignal kills child AND grandchild process tree
  const pidFile = join(work, 'grandchild.pid');
  const treeScript = join(work, 'tree.mjs');
  await writeFile(treeScript, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });',
    `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid), "utf8");`,
    'console.log("READY");',
    'setTimeout(() => {}, 60000);',
  ].join('\n'), 'utf8');

  const controller = new AbortController();
  const treeRes = await runProcess({
    command: treeScript,
    signal: controller.signal,
    timeoutMs: 10_000,
    onStdoutLine: (line) => {
      if (line.trim() === 'READY') controller.abort(new Error('cancel-tree'));
    },
  });
  assert.equal(treeRes.aborted, true);
  const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
  assert.ok(grandchildPid > 0);
  // Give OS a brief moment to reap the killed grandchild
  let stillAlive = pidExists(grandchildPid);
  for (let i = 0; i < 20 && stillAlive; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    stillAlive = pidExists(grandchildPid);
  }
  assert.equal(stillAlive, false, `grandchild PID ${grandchildPid} should be terminated`);

  // 2e. .cmd shim unwrapping (valid + broken)
  const targetJs = join(work, 'tool.js');
  await writeFile(targetJs, 'console.log("fake-tool 2.3.4");\n', 'utf8');
  const validCmd = join(work, 'tool.cmd');
  await writeFile(validCmd, '@ECHO off\r\n"%_prog%" "%dp0%\\tool.js" %*\r\n', 'utf8');
  const shimRes = await runProcess({ command: validCmd, args: ['--version'], timeoutMs: 10_000 });
  assert.equal(shimRes.code, 0);
  assert.match(shimRes.stdout, /2\.3\.4/);

  const brokenCmd = join(work, 'broken.cmd');
  await writeFile(brokenCmd, '@ECHO off\r\n"%_prog%" "%dp0%\\missing-target.js" %*\r\n', 'utf8');
  const brokenRes = await runProcess({ command: brokenCmd, args: ['--version'], timeoutMs: 10_000 });
  assert.equal(brokenRes.errorCode, 'BROKEN_SHIM');
});

test('adapters/cli/agy-adapter runs stream-json in fresh temp cwd, streams chunks, reports usage, and cleans up cwd', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-agy-adapter-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const fakeAgy = join(work, 'fake-agy.mjs');
  const cwdFile = join(work, 'recorded-cwd.txt');
  await writeFile(fakeAgy, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(cwdFile)}, process.cwd(), "utf8");`,
    'const chunks = [];',
    'for await (const c of process.stdin) chunks.push(c);',
    'const msg = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());',
    'console.log(JSON.stringify({ event: "init", conversation_id: "c1" }));',
    'console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "HELLO " } }));',
    'console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "WORLD" } }));',
    'console.log(JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: `HELLO WORLD (${msg.message.content.length})`, usage: { input_tokens: 500, output_tokens: 20, thinking_tokens: 10, cache_read_tokens: 0, total_tokens: 520 } } }));',
  ].join('\n'), 'utf8');

  const streamed = [];
  const recordedUsage = [];
  const complete = createAgyCompleteAdapter(
    { executablePath: fakeAgy, model: 'gemini-test', effort: 'medium' },
    { runner: createProcessRunner(), timeoutMs: 10_000 },
  );

  const answer = await withUsageSink(
    { key: 'test-agy', sink: (u) => recordedUsage.push(u) },
    () => complete('System rule', 'User question', { onOutput: (chunk) => streamed.push(chunk) }),
  );
  assert.match(answer, /^HELLO WORLD \(\d+\)$/);
  assert.deepEqual(streamed, ['HELLO ', 'WORLD']);
  assert.equal(recordedUsage.length, 1);
  assert.equal(recordedUsage[0].uncachedInputTokens, 500);
  assert.equal(recordedUsage[0].outputTokens, 20);

  // Verify the fresh temp cwd was cleaned up in finally
  const usedCwd = (await readFile(cwdFile, 'utf8')).trim();
  assert.ok(usedCwd.includes('studyhub-agy-'));
  await assert.rejects(() => access(usedCwd));
});

/* ============================================================================
 * 3. Provider Discovery Tests
 * ============================================================================ */

test('application/provider-discovery distinguishes ready, unauthenticated, broken-shim, not-installed, coming-soon, and caches with TTL', async () => {
  let clock = 1000;
  let probeCalls = 0;
  let agyMode = 'ready';

  const discovery = createProviderDiscovery({
    now: () => clock,
    ttlMs: 10_000,
    listCandidates: async (id) => {
      if (id === 'agy') return agyMode === 'missing' ? [] : ['C:\\Users\\demo\\.gemini\\bin\\agy.exe'];
      if (id === 'claude') return ['C:\\node_global\\claude.cmd'];
      return [];
    },
    probeVersion: async (id) => {
      probeCalls += 1;
      if (id === 'agy') {
        if (agyMode === 'broken') return { ok: false, version: null, reason: '启动脚本损坏' };
        return { ok: true, version: '1.5.5', reason: '' };
      }
      return { ok: true, version: '2.1.327', reason: '' };
    },
    listAgyModels: async () => {
      if (agyMode === 'unauth') return { ok: false, unauthenticated: true, models: [], reason: 'not logged in' };
      return { ok: true, unauthenticated: false, models: [{ id: 'gemini-4', name: 'Gemini 4' }], reason: '' };
    },
  });

  const first = await discovery.scan();
  assert.equal(first.find((p) => p.id === 'agy').status, 'ready');
  assert.equal(first.find((p) => p.id === 'agy').models.length, 1);
  assert.equal(first.find((p) => p.id === 'claude').status, 'coming-soon');
  assert.equal(first.find((p) => p.id === 'claude').version, '2.1.327');
  assert.equal(first.find((p) => p.id === 'codex').status, 'coming-soon');
  assert.equal(first.find((p) => p.id === 'codex').executablePath, null);
  const countAfterFirst = probeCalls;

  // Cached within TTL
  clock += 5000;
  await discovery.scan();
  assert.equal(probeCalls, countAfterFirst);

  // Forced refresh detects unauthenticated
  agyMode = 'unauth';
  const unauth = await discovery.scan({ force: true });
  assert.equal(unauth.find((p) => p.id === 'agy').status, 'unauthenticated');

  // After TTL expires, detects broken-shim
  clock += 20_000;
  agyMode = 'broken';
  const broken = await discovery.scan();
  assert.equal(broken.find((p) => p.id === 'agy').status, 'broken-shim');

  // Detects not-installed
  agyMode = 'missing';
  const missing = await discovery.scan({ force: true });
  assert.equal(missing.find((p) => p.id === 'agy').status, 'not-installed');
});

/* ============================================================================
 * 4. Local Server Security Tests
 * ============================================================================ */

test('adapters/http/local-server enforces Host, Origin, X-Study-Token, CORS preflight, and body size limits', async (t) => {
  const token = randomBytes(32).toString('hex');
  const server = await startLocalServer({
    token,
    maxRequestBytes: 512,
    maxRestoreBytes: 2048,
    onCall: async (action, args) => ({ ok: true, value: { action, size: JSON.stringify(args).length } }),
  });
  t.after(() => server.close());

  // 4a. Bad Host -> 403
  const badHost = await rawHttpRequest({
    port: server.port,
    headers: { host: 'evil.example.com:80', 'content-type': 'application/json', 'x-study-token': token },
    body: JSON.stringify({ action: 'ping', args: {} }),
  });
  assert.equal(badHost.status, 403);

  // 4b. Bad Origin -> 403
  const badOrigin = await rawHttpRequest({
    port: server.port,
    headers: {
      host: `127.0.0.1:${server.port}`,
      origin: 'https://evil.example.com',
      'content-type': 'application/json',
      'x-study-token': token,
    },
    body: JSON.stringify({ action: 'ping', args: {} }),
  });
  assert.equal(badOrigin.status, 403);

  // 4c. Missing/wrong token -> 403
  const missingToken = await rawHttpRequest({
    port: server.port,
    headers: { host: `127.0.0.1:${server.port}`, origin: 'tauri://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'ping', args: {} }),
  });
  assert.equal(missingToken.status, 403);

  const wrongToken = await rawHttpRequest({
    port: server.port,
    headers: {
      host: `127.0.0.1:${server.port}`,
      origin: 'http://tauri.localhost',
      'content-type': 'application/json',
      'x-study-token': '0'.repeat(64),
    },
    body: JSON.stringify({ action: 'ping', args: {} }),
  });
  assert.equal(wrongToken.status, 403);

  // 4d. Valid token + Tauri Origin -> 200
  const valid = await rawHttpRequest({
    port: server.port,
    headers: {
      host: `127.0.0.1:${server.port}`,
      origin: 'tauri://localhost',
      'content-type': 'application/json',
      'x-study-token': token,
    },
    body: JSON.stringify({ action: 'ping', args: { hello: 'world' } }),
  });
  assert.equal(valid.status, 200);
  assert.equal(valid.headers['access-control-allow-origin'], 'tauri://localhost');
  assert.equal(JSON.parse(valid.text).ok, true);

  // 4e. Preflight OPTIONS for allowed origin -> 204
  const preflight = await rawHttpRequest({
    port: server.port,
    method: 'OPTIONS',
    headers: { host: `127.0.0.1:${server.port}`, origin: 'http://tauri.localhost' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://tauri.localhost');

  // 4f. Oversized normal body -> 413; restore within restore limit -> 200; > restore limit -> 413
  const tooBigNormal = await rawHttpRequest({
    port: server.port,
    headers: { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', 'x-study-token': token },
    body: JSON.stringify({ action: 'ping', args: { data: 'X'.repeat(700) } }),
  });
  assert.equal(tooBigNormal.status, 413);

  const okRestore = await rawHttpRequest({
    port: server.port,
    headers: { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', 'x-study-token': token },
    body: JSON.stringify({ action: 'restore', args: { data: 'X'.repeat(700) } }),
  });
  assert.equal(okRestore.status, 200);

  const tooBigRestore = await rawHttpRequest({
    port: server.port,
    headers: { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', 'x-study-token': token },
    body: JSON.stringify({ action: 'restore', args: { data: 'X'.repeat(2500) } }),
  });
  assert.equal(tooBigRestore.status, 413);
});

/* ============================================================================
 * 5. Desktop Host + Real StudyRuntime + In-Process Job Executor Integration
 * ============================================================================ */

test('application/desktop-host integrates with v4.14.0 StudyRuntime, config, concurrency cap, background generation, and job recovery', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-desktop-host-'));
  const prevDshHome = process.env.DSH_HOME;
  t.after(async () => {
    registerHostConcurrencyCap(null);
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    await rm(work, { recursive: true, force: true });
  });

  const fakeHome = join(work, 'home');
  const fakeDocs = join(work, 'Documents');
  const altLibrary = join(work, 'AltLibrary');
  const env = { ...process.env, DSH_HOME: join(work, 'dsh-home') };
  const configStore = createConfigStore({ env, home: fakeHome, documentsDir: fakeDocs });

  const providerDiscovery = createProviderDiscovery({
    listCandidates: async (id) => (id === 'agy' ? ['C:\\fake\\agy.exe'] : []),
    probeVersion: async () => ({ ok: true, version: '1.5.5', reason: '' }),
    listAgyModels: async () => ({ ok: true, unauthenticated: false, models: [{ id: 'gemini-4', name: 'Gemini 4' }], reason: '' }),
  });

  const jobExecutor = createInProcessJobExecutor();
  const stubComplete = async (_system, prompt) => {
    if (prompt.includes('OK?')) return 'OK';
    return JSON.stringify({
      title: 'Binary Search Basics',
      cards: [
        {
          kind: 'quiz',
          prompt: 'What is the time complexity of binary search on a sorted array of n elements?',
          choices: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'],
          answer: 1,
          explanation: 'Binary search halves the remaining search interval at each comparison.',
          topic: 'Binary Search',
        },
      ],
    });
  };

  const host = await createDesktopHost({
    configStore,
    providerDiscovery,
    openaiComplete: createOpenAiCompleteAdapter,
    agyComplete: () => stubComplete,
    jobExecutor,
    openExternal: async () => ({ ok: true }),
    ensureDir: (p) => mkdir(p, { recursive: true }),
    injectedComplete: stubComplete,
  });
  t.after(() => host.dispose());

  // 5a. Config save/get redacts apiKey & updates concurrency cap dynamically
  const savedOpenAi = await host.call('desktop.config.save', {
    mode: 'openai',
    openai: {
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'sk-test-secret-00001234',
    },
  });
  assert.equal(savedOpenAi.ok, true);
  assert.equal(savedOpenAi.value.openai.hasKey, true);
  assert.equal(savedOpenAi.value.openai.keyLast4, '1234');
  assert.equal('apiKey' in savedOpenAi.value.openai, false);
  assert.equal(effectiveConcurrencyLimit().max, 8);

  const savedAgy = await host.call('desktop.config.save', { mode: 'agy', agy: { model: 'gemini-4' } });
  assert.equal(savedAgy.ok, true);
  assert.equal(savedAgy.value.effective.maxConcurrency, 2);
  assert.equal(savedAgy.value.effective.defaultConcurrency, 1);
  assert.equal(effectiveConcurrencyLimit().max, 2);

  // desktop.json is stored inside DSH_HOME/study, never inside library root
  const persisted = JSON.parse(await readFile(configStore.configPath, 'utf8'));
  assert.equal(persisted.mode, 'agy');
  assert.ok(!configStore.configPath.startsWith(host.library.root));

  // 5b. Config test, EN localization (zero CJK leaks), & update view
  const tested = await host.call('desktop.config.test', {});
  assert.equal(tested.ok, true);
  assert.equal(tested.value.ok, true);
  assert.equal(typeof tested.value.latencyMs, 'number');

  const testedEn = await host.call('desktop.config.test', { uiLanguage: 'en' });
  assert.equal(testedEn.ok, true);
  assert.equal(testedEn.value.ok, true);
  assert.ok(!/[\u4e00-\u9fff]/.test(testedEn.value.message), `EN test message leaked CJK: ${testedEn.value.message}`);

  const cfgEn = await host.call('desktop.config.get', { uiLanguage: 'en' });
  assert.equal(cfgEn.ok, true);
  for (const prov of cfgEn.value.providers) {
    assert.ok(prov.reasonCode, `provider ${prov.id} should include reasonCode`);
    assert.ok(!/[\u4e00-\u9fff]/.test(prov.reason), `EN provider ${prov.id} reason leaked CJK: ${prov.reason}`);
  }
  const scanEn = await host.call('desktop.providers.scan', { force: true, uiLanguage: 'en' });
  assert.equal(scanEn.ok, true);
  for (const prov of scanEn.value.providers) {
    assert.ok(!/[\u4e00-\u9fff]/.test(prov.reason), `EN scan ${prov.id} reason leaked CJK: ${prov.reason}`);
  }

  const installRes = await host.call('update.install', {});
  assert.equal(installRes.ok, true);
  assert.equal(installRes.value.code, 'UPDATE_NO_INSTALLER');

  const updateView = desktopUpdateView({ latest: '4.15.0', upgradeAvailable: true, pendingRestart: true });
  assert.equal(updateView.install.available, false);
  assert.equal(updateView.install.host, 'desktop');
  assert.equal('pendingRestart' in updateView, false);
  assert.match(updateView.installerUrl, /StudyHub-Desktop-4\.15\.0-win-x64\.msi$/);
  assert.match(updateView.zipUrl, /StudyHub-Desktop-4\.15\.0-win-x64\.zip$/);

  // Verify config-store problem carries human-readable message when configured library falls back
  const blockedEnv = { ...env, STUDYHUB_LIBRARY: join(work, 'dsh-home') };
  const problemStore = createConfigStore({ env: blockedEnv, home: fakeHome, documentsDir: fakeDocs });
  const loadedWithProblem = await problemStore.load();
  assert.ok(loadedWithProblem.library.problem, 'expected library problem when STUDYHUB_LIBRARY encloses desktop.json');
  assert.ok(loadedWithProblem.library.problem.message.includes(loadedWithProblem.library.root));

  // 5c. Binding get/set
  const bindInitial = await host.call('binding.get', {});
  assert.equal(bindInitial.ok, true);
  assert.deepEqual(bindInitial.value.host, DESKTOP_CAPABILITIES);
  assert.equal(bindInitial.value.rootSource, 'default');

  const bindCustom = await host.call('binding.set', { root: altLibrary });
  assert.equal(bindCustom.ok, true);
  assert.equal(bindCustom.value.root, resolve(altLibrary));
  assert.equal(bindCustom.value.rootSource, 'custom');

  // 5d. Real StudyRuntime flow: import material (source.add) -> start background generation job (generate)
  const imported = await host.call('source.add', {
    title: 'Algorithms Lecture 1',
    text: 'Binary search operates on a sorted array and halves the search space each step, running in O(log n) time. Compare the target with the middle element and discard half the array.',
  });
  assert.equal(imported.ok, true, `source.add failed: ${imported.error}`);
  const sourceId = imported.value.id;
  assert.ok(sourceId);

  const startedJob = await host.call('generate', {
    sourceIds: [sourceId],
    title: 'Algorithms Quiz',
    kind: 'quiz',
    count: 1,
  });
  assert.equal(startedJob.ok, true, `generate failed: ${startedJob.error}`);
  const jobId = startedJob.value.jobId || startedJob.value.job?.id || startedJob.value.id;
  assert.ok(jobId);

  // Poll snapshot until the background job settles — proves inProcessExecutor admitted & executed a model-backed job
  let finalJob = null;
  for (let i = 0; i < 60; i += 1) {
    const snap = await host.call('snapshot', {});
    if (snap.ok) {
      finalJob = (snap.value.jobs || []).find((item) => item.id === jobId) || null;
      if (finalJob && ['completed', 'failed', 'cancelled', 'interrupted', 'done', 'error'].includes(finalJob.status)) break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(finalJob, 'expected job in snapshot');
  assert.notEqual(finalJob.status, 'queued', 'job should have been admitted and executed');

  // 5e. In-process executor cancel + dead-PID restart `lost` recovery
  let cancelledReason = null;
  const handle = jobExecutor.start({
    kind: 'test-cancel',
    title: 'Cancelable Job',
    run: () => new Promise((resolveRun) => {
      setTimeout(() => resolveRun({ status: 'killed' }), 5000);
    }),
    cancel: (reason) => { cancelledReason = reason; },
  });
  assert.equal(jobExecutor.inspect({ handleId: handle.id }, jobExecutor.witness()).state, 'alive');
  handle.append('line 1\n');
  assert.equal(handle.output(0).text, 'line 1\n');
  handle.stop('user-cancelled');
  assert.equal(cancelledReason, 'user-cancelled');

  // Inspecting a witness from a previous dead process reports `lost` so StudyHub offers 接着做
  const restartedExecutor = createInProcessJobExecutor({ alive: () => false });
  const recovered = restartedExecutor.inspect(
    { handleId: 'old-handle' },
    { pid: 999999, host: restartedExecutor.witness().host, instance: 'previous-instance' },
  );
  assert.equal(recovered.state, 'lost');
  assert.equal(recovered.reason, 'executor-process-exited');
});

/* ============================================================================
 * 6. Sidecar Stdin/Stdout Handshake Integration Test
 * ============================================================================ */

test('entry/sidecar.mjs performs Tauri stdin/stdout handshake, serves authenticated RPC, and exits 0 on stdin EOF', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-sidecar-e2e-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const token = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [SIDECAR_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DSH_HOME: join(work, 'dsh-home'),
      STUDYHUB_LIBRARY: join(work, 'library'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const portPromise = new Promise((resolvePort, rejectPort) => {
    let buf = '';
    const timer = setTimeout(() => rejectPort(new Error(`Handshake timeout. stderr=${stderr}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        try {
          resolvePort(JSON.parse(buf.slice(0, nl)).port);
        } catch (err) {
          rejectPort(err);
        }
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectPort(new Error(`Sidecar exited early with code ${code}. stderr=${stderr}`));
    });
  });

  // Send token on stdin and KEEP stdin open (exact Tauri contract)
  child.stdin.write(`${JSON.stringify({ token })}\n`);
  const port = await portPromise;
  assert.ok(Number.isInteger(port) && port > 0);

  // Unauthenticated call -> 403
  const unauth = await rawHttpRequest({
    port,
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'binding.get', args: {} }),
  });
  assert.equal(unauth.status, 403);

  // Authenticated call with Tauri Origin -> 200
  const auth = await rawHttpRequest({
    port,
    headers: {
      host: `127.0.0.1:${port}`,
      origin: 'tauri://localhost',
      'content-type': 'application/json',
      'x-study-token': token,
    },
    body: JSON.stringify({ action: 'binding.get', args: {} }),
  });
  assert.equal(auth.status, 200);
  const parsed = JSON.parse(auth.text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value.host, DESKTOP_CAPABILITIES);

  // Closing stdin triggers graceful shutdown with exit code 0
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectExit(new Error(`Sidecar did not exit on stdin EOF. stderr=${stderr}`));
    }, 10_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
    child.stdin.end();
  });
  assert.equal(exitCode, 0, `Expected clean exit 0, got ${exitCode}. stderr=${stderr}`);
});
