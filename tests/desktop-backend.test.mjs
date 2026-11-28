import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  buildCodexExecArgs,
  buildCodexWrappedPrompt,
  mapCodexUsageToBuckets,
  parseCodexJsonlOutput,
  parseCodexLoginMethod,
  parseCodexModelsOutput,
  parseCodexStreamLine,
} from '../packages/studyhub-desktop/domain/codex-protocol.js';
import {
  OPENAI_PRESETS,
  applyConfigPatch,
  concurrencyHookForMode,
  concurrencyPolicyForMode,
  defaultDesktopConfig,
  modelViaOf,
  normalizeDesktopConfig,
  redactDesktopConfig,
  resolveEffectiveModel,
} from '../packages/studyhub-desktop/domain/config-policy.js';
import { isOnSystemDrive, libraryPlaceOf } from '../packages/studyhub-desktop/domain/library-place.js';
import { DESKTOP_CAPABILITIES } from '../packages/studyhub-desktop/domain/contracts.js';
import { clipDetail, keyLast4, redactSecret } from '../packages/studyhub-desktop/domain/redact.js';
import { openableExternalUrl, parseCliVersion, parseCmdShimTarget } from '../packages/studyhub-desktop/domain/shim-parser.js';
import { buildStartCommandLine, cliLaunchRequest } from '../packages/studyhub-desktop/domain/terminal-command.js';
import { openCliTerminal } from '../packages/studyhub-desktop/adapters/os/open-terminal.mjs';
import { createDesktopHost } from '../packages/studyhub-desktop/application/desktop-host.js';
import { createProviderDiscovery, localizeProviders } from '../packages/studyhub-desktop/application/provider-discovery.js';
import { desktopUpdateView } from '../packages/studyhub-desktop/application/update-view.js';
import { buildUpdaterManifest, packPortableZip } from '../packages/studyhub-desktop/scripts/pack-zip.mjs';
import { stageRuntime } from '../packages/studyhub-desktop/scripts/stage-runtime.mjs';
import { createAgyCompleteAdapter } from '../packages/studyhub-desktop/adapters/cli/agy-adapter.mjs';
import { listCandidatePaths } from '../packages/studyhub-desktop/adapters/cli/candidate-paths.mjs';
import { createCodexCompleteAdapter, probeCodex, probeCodexAuth, probeCodexModels } from '../packages/studyhub-desktop/adapters/cli/codex-adapter.mjs';
import { createProcessRunner, runProcess } from '../packages/studyhub-desktop/adapters/cli/process-runner.mjs';
import { startLocalServer } from '../packages/studyhub-desktop/adapters/http/local-server.mjs';
import { createOpenAiCompleteAdapter } from '../packages/studyhub-desktop/adapters/http/openai-adapter.mjs';
import { createInProcessJobExecutor } from '../packages/studyhub-desktop/adapters/runtime/job-executor.mjs';
import { createConfigStore } from '../packages/studyhub-desktop/adapters/storage/config-store.mjs';
import { effectiveConcurrencyLimit, registerHostConcurrencyCap } from '../lib/generation-settings.js';
import { callOutcomeOf } from '../lib/jobs/gateway-policy.js';
import { StudyService } from '../lib/service.js';
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
  assert.deepEqual(concurrencyPolicyForMode('codex'), { defaultConcurrency: 1, maxConcurrency: 2 });
  assert.deepEqual(concurrencyPolicyForMode('openai'), { defaultConcurrency: null, maxConcurrency: null });
  assert.deepEqual(concurrencyHookForMode('agy'), { max: 2, default: 1 });
  assert.deepEqual(concurrencyHookForMode('codex'), { max: 2, default: 1 });
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

  // Real npm .cmd shim containing IF EXIST "%dp0%\node.exe" MUST unwrap to codex.js, never node.exe
  const realNpmCodexCmd = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ].join('\r\n');
  assert.deepEqual(parseCmdShimTarget(realNpmCodexCmd, 'D:\\Program Files\\nodejs\\node_global'), {
    kind: 'node-script',
    targetPath: 'D:\\Program Files\\nodejs\\node_global\\node_modules\\@openai\\codex\\bin\\codex.js',
  });

  // A shim referencing ONLY node.exe must never be treated as a CLI target
  assert.equal(parseCmdShimTarget('IF EXIST "%dp0%\\node.exe" SET "_prog=%dp0%\\node.exe"', 'D:\\node_global'), null);

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

/* The shape of `codex debug models` (codex-cli 0.170.0), cut to the fields that matter: the catalog also lists models the picker hides. */
const CODEX_CATALOG = JSON.stringify({
  models: [
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 5 },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 3 },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 1 },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', priority: 2 },
    { slug: 'gpt-5.6-luna', visibility: 'list', priority: 4 },
    { display_name: 'No slug', visibility: 'list', priority: 0 },
  ],
});

test('domain/codex-protocol reads the model catalog: the models codex lists, in its order, and nothing from an unreadable answer', () => {
  assert.deepEqual(parseCodexModelsOutput(CODEX_CATALOG), [
    { id: 'gpt-6-luna', name: 'GPT-6-Luna' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
    { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna' },
  ]);
  // A notice printed before the JSON does not hide it.
  assert.equal(parseCodexModelsOutput(`Refreshing models…\n${CODEX_CATALOG}\n`).length, 3);
  for (const unreadable of ['', 'not json', '{"models": "none"}', '[]', '{"models": [null, 3, {"visibility": "list"}]}']) {
    assert.deepEqual(parseCodexModelsOutput(unreadable), [], unreadable);
  }
});

test('adapters/cli/codex-adapter lists models with `codex debug models`, and falls back on the catalog shipped with the CLI', async () => {
  const calls = [];
  const runnerOf = (answers) => ({ run: async (request) => { calls.push(request.args.join(' ')); return answers(request.args); } });
  const ok = { code: 0, stdout: CODEX_CATALOG, stderr: '' }, failed = { code: 1, stdout: '', stderr: 'network unreachable' };

  const fresh = await probeCodexModels(runnerOf(() => ok), 'C:\\codex.exe');
  assert.equal(fresh.ok, true);
  assert.deepEqual(fresh.models.map((model) => model.id), ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  assert.deepEqual(calls, ['debug models'], 'one call when the catalog answers');

  calls.length = 0;
  const offline = await probeCodexModels(runnerOf((args) => (args.includes('--bundled') ? ok : failed)), 'C:\\codex.exe');
  assert.equal(offline.ok, true);
  assert.equal(offline.models.length, 3);
  assert.deepEqual(calls, ['debug models', 'debug models --bundled']);

  // An older codex with no such command: no list, and the reason is kept short.
  const none = await probeCodexModels(runnerOf(() => ({ code: 2, stdout: '', stderr: "error: unrecognized subcommand 'models'" })), 'C:\\codex.exe');
  assert.deepEqual({ ok: none.ok, models: none.models }, { ok: false, models: [] });
  assert.match(none.reason, /unrecognized subcommand/);
  // An answer that exits 0 but lists nothing readable is no list either.
  const empty = await probeCodexModels(runnerOf(() => ({ code: 0, stdout: '{}', stderr: '' })), 'C:\\codex.exe');
  assert.deepEqual({ ok: empty.ok, models: empty.models }, { ok: false, models: [] });
});

test('domain/codex-protocol parses fixtures/codex-real-output.jsonl, ignores non-fatal errors, maps usage cleanly, and builds read-only args', async () => {
  const realJsonl = await readFile(join(FIXTURES_DIR, 'codex-real-output.jsonl'), 'utf8');
  const parsed = parseCodexJsonlOutput(realJsonl);
  assert.equal(parsed.text, 'PONG');
  assert.equal(parsed.threadId, '00000000-0000-4000-8000-000000000003');
  assert.equal(parsed.usage.inputTokens, 19560);
  assert.equal(parsed.usage.outputTokens, 6);
  assert.equal(parsed.usage.cacheReadTokens, 0);
  assert.equal(parsed.usage.cacheWriteTokens, 0);

  const studyBuckets = usageFromTokenUsage(parsed.usage);
  assert.deepEqual(studyBuckets, {
    uncachedInputTokens: 19560,
    outputTokens: 6,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(totalTokens(studyBuckets), 19566);

  // Cached + cache-write + reasoning tokens must not be double counted
  const cached = mapCodexUsageToBuckets({
    input_tokens: 10_000,
    cached_input_tokens: 6_000,
    cache_write_input_tokens: 1_500,
    output_tokens: 200,
    reasoning_output_tokens: 80,
  });
  assert.equal(cached.inputTokens, 2_500);
  assert.equal(cached.cacheReadTokens, 6_000);
  assert.equal(cached.cacheWriteTokens, 1_500);
  assert.equal(cached.outputTokens, 200);
  assert.equal(cached.reasoningTokens, 80);
  assert.equal(totalTokens(usageFromTokenUsage(cached)), 10_200);

  // Stream line parser extracts agent_message text and non-fatal item error
  const lines = realJsonl.trim().split(/\r?\n/);
  assert.equal(parseCodexStreamLine(lines[1])?.fatal, false);
  assert.equal(parseCodexStreamLine(lines[4])?.text, 'PONG');

  // Fatal turn.failed throws cleanly in both ZH and EN (zero CJK in EN)
  const failedJsonl = JSON.stringify({ type: 'turn.failed', error: { message: 'rate limit exceeded' } });
  assert.throws(
    () => parseCodexJsonlOutput(failedJsonl, { language: 'en' }),
    (err) => err.modelFailure === true && /rate limit exceeded/.test(err.message) && !/[\u4e00-\u9fff]/.test(err.message),
  );

  // Verified read-only args & wrapped prompt
  const args = buildCodexExecArgs({ model: 'gpt-5.4', effort: 'high' });
  assert.deepEqual(args, [
    'exec',
    '--json',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '-m', 'gpt-5.4',
    '-c', 'model_reasoning_effort="high"',
    '-',
  ]);
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  const wrapped = buildCodexWrappedPrompt('Be concise.', 'Explain Dijkstra.');
  assert.match(wrapped, /\[System Instruction\]/);
  assert.match(wrapped, /Do not run shell commands/);
  assert.match(wrapped, /\[User\]\nExplain Dijkstra\./);
});

test('adapters/cli/candidate-paths omits extensionless POSIX shims on win32 and includes npm_config_prefix', async () => {
  const seen = [];
  const prefixDir = 'D:\\CustomNpm\\global';
  const existing = new Set([
    `${prefixDir}\\codex.cmd`.toLowerCase(),
    `${prefixDir}\\codex`.toLowerCase(),
  ]);
  const found = await listCandidatePaths('codex', {
    platform: 'win32',
    home: 'C:\\Users\\demo',
    env: { PATH: '', npm_config_prefix: prefixDir },
    checkFile: async (candidate) => {
      seen.push(candidate);
      return existing.has(candidate.toLowerCase());
    },
  });
  assert.deepEqual(found, [`${prefixDir}\\codex.cmd`]);
  assert.equal(seen.some((p) => p.toLowerCase().endsWith('\\codex')), false);
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
  // Windows taskkill reports when the tree is stopped. Unix may still be reaping a signalled process.
  let stillAlive = pidExists(grandchildPid);
  for (let i = 0; process.platform !== 'win32' && i < 20 && stillAlive; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    stillAlive = pidExists(grandchildPid);
  }
  assert.equal(stillAlive, false, `grandchild PID ${grandchildPid} should be terminated`);

  // 2e. .cmd shim unwrapping (valid + broken). An npm .cmd shim exists only on Windows and names its target with backslashes,
  // so the round trip through the file system runs there; the parsing itself is covered on every system by the shim-parser test.
  if (process.platform !== 'win32') return;
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

test('adapters/cli/process-runner settles a killed run and terminate() even when an escaped grandchild keeps stdout open', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-runner-escape-'));
  const escaped = [];
  t.after(async () => {
    for (const pid of escaped) { try { process.kill(pid); } catch { /* already gone */ } }
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  // The killed child's stdout pipe stays open while a process outside its tree holds it, so 'close' never arrives.
  // The middle process starts the holder detached (outside the child's process group / job object) and exits, which also
  // takes the holder out of the tree that `taskkill /T` walks. Only a backstop timer can then settle the caller.
  const holder = join(work, 'holder.mjs');
  await writeFile(holder, 'setTimeout(() => {}, 60000);\n', 'utf8');
  const middle = join(work, 'middle.mjs');
  await writeFile(middle, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    `const held = spawn(process.execPath, [${JSON.stringify(holder)}], { stdio: ["ignore", "inherit", "inherit"], detached: true, windowsHide: true });`,
    'writeFileSync(process.argv[2], String(held.pid), "utf8");',
    'held.unref();',
  ].join('\n'), 'utf8');
  const parent = join(work, 'parent.mjs');
  await writeFile(parent, [
    'import { spawnSync } from "node:child_process";',
    `spawnSync(process.execPath, [${JSON.stringify(middle)}, process.argv[2]], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });`,
    'console.log("READY");',
    'setTimeout(() => {}, 60000);',
  ].join('\n'), 'utf8');
  const settleWithin = (promise, ms) => Promise.race([
    promise.then(value => ({ settled: true, value })),
    new Promise(resolve => { setTimeout(() => resolve({ settled: false }), ms).unref(); }),
  ]);
  const holderPid = async file => {
    const pid = Number((await readFile(file, 'utf8')).trim());
    escaped.push(pid);
    return pid;
  };

  const runPidFile = join(work, 'run-holder.pid');
  const controller = new AbortController();
  const run = runProcess({
    command: parent,
    args: [runPidFile],
    signal: controller.signal,
    timeoutMs: 30_000,
    onStdoutLine: line => { if (line.trim() === 'READY') controller.abort(new Error('cancel')); },
  });
  const ran = await settleWithin(run, 10_000);
  assert.equal(ran.settled, true, 'runProcess must settle after a kill even though stdout never closes');
  assert.equal(ran.value.aborted, true);
  assert.ok(pidExists(await holderPid(runPidFile)), 'the holder really outlived the kill and kept the pipe');

  const persistentPidFile = join(work, 'persistent-holder.pid');
  const persistent = createProcessRunner().spawnPersistent({ command: process.execPath, args: [parent, persistentPidFile], cwd: work });
  await new Promise(resolve => persistent.stdout.on('data', chunk => { if (String(chunk).includes('READY')) resolve(); }));
  const stopped = await settleWithin(persistent.terminate(), 10_000);
  assert.equal(stopped.settled, true, 'terminate() must settle even though the exit event never arrives');
  assert.ok(pidExists(await holderPid(persistentPidFile)));
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

test('domain/codex-protocol reads how codex is signed in (an account or an API key) from `codex login status`, and never returns the key', () => {
  assert.equal(parseCodexLoginMethod('Logged in using ChatGPT'), 'account');
  assert.equal(parseCodexLoginMethod('\nLogged in using ChatGPT\n'), 'account');
  assert.equal(parseCodexLoginMethod('Logged in using an API key - sk-proj-***abcd'), 'api-key');
  assert.equal(parseCodexLoginMethod('logged in using an api key'), 'api-key', 'the case of the words does not matter');
  assert.equal(parseCodexLoginMethod('Not logged in'), 'unknown');
  assert.equal(parseCodexLoginMethod('Logged in'), 'unknown', 'a login with no method named is not guessed at');
  assert.equal(parseCodexLoginMethod(''), 'unknown');
  assert.equal(parseCodexLoginMethod(undefined), 'unknown');
  // Whatever the text holds, the answer is one of three words: no part of the key goes on.
  for (const text of ['Logged in using an API key - sk-proj-SECRET1234', 'sk-live-SECRET1234 Logged in using ChatGPT']) {
    assert.match(parseCodexLoginMethod(text), /^(account|api-key|unknown)$/);
  }
});

test('adapters/cli/codex-adapter probes stderr auth, runs in cleaned temp cwd, reports usage, and handles non-fatal error items', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-codex-adapter-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const fakeCodex = join(work, 'fake-codex.mjs');
  const cwdFile = join(work, 'codex-cwd.txt');
  await writeFile(fakeCodex, [
    'import { writeFileSync } from "node:fs";',
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") { console.log("codex-cli 0.170.0"); process.exit(0); }',
    'if (args[0] === "login" && args[1] === "status") {',
    '  if (process.env.FAKE_CODEX_UNAUTH === "1") { process.stderr.write("Not logged in\\n"); process.exit(1); }',
    '  if (process.env.FAKE_CODEX_APIKEY === "1") { process.stderr.write("Logged in using an API key - sk-proj-***abcd\\n"); process.exit(0); }',
    '  process.stderr.write("Logged in using ChatGPT\\n");',
    '  process.exit(0);',
    '}',
    `writeFileSync(${JSON.stringify(cwdFile)}, process.cwd(), "utf8");`,
    'const chunks = [];',
    'for await (const c of process.stdin) chunks.push(c);',
    'const stdinStr = Buffer.concat(chunks).toString("utf8");',
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "t-codex-1" }));',
    'console.log(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "minor warning" } }));',
    'console.log(JSON.stringify({ type: "turn.started" }));',
    'console.log(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: `CODEX_OK:${stdinStr.length}` } }));',
    'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 300, cache_write_input_tokens: 100, output_tokens: 40, reasoning_output_tokens: 10 } }));',
  ].join('\n'), 'utf8');

  const runner = createProcessRunner();
  // Ready probe (auth status printed to stderr, stdout empty)
  const readyProbe = await probeCodex(runner, fakeCodex);
  assert.equal(readyProbe.ok, true);
  assert.equal(readyProbe.status, 'ready');
  assert.equal(readyProbe.version, '0.170.0');
  assert.match(readyProbe.detail, /Logged in using ChatGPT/);
  assert.equal((await probeCodexAuth(runner, fakeCodex)).authMethod, 'account', 'the probe says how codex is signed in');
  const keyRunner = { run: (req) => runner.run({ ...req, env: { ...process.env, FAKE_CODEX_APIKEY: '1' } }) };
  const keyAuth = await probeCodexAuth(keyRunner, fakeCodex);
  assert.equal(keyAuth.authenticated, true);
  assert.equal(keyAuth.authMethod, 'api-key', 'a codex signed in with an API key is told apart from an account');
  assert.equal(Object.hasOwn(await probeCodexAuth({ run: (req) => runner.run({ ...req, env: { ...process.env, FAKE_CODEX_UNAUTH: '1' } }) }, fakeCodex), 'authMethod'), false, 'not signed in: no method');

  // Unauthenticated probe (non-zero exit with stderr)
  const unauthRunner = {
    run: (req) => runner.run({ ...req, env: { ...process.env, FAKE_CODEX_UNAUTH: '1' } }),
  };
  const unauthAuth = await probeCodexAuth(unauthRunner, fakeCodex);
  assert.equal(unauthAuth.ok, false);
  assert.equal(unauthAuth.authenticated, false);
  const unauthProbe = await probeCodex(unauthRunner, fakeCodex);
  assert.equal(unauthProbe.status, 'unauthenticated');
  assert.equal(unauthProbe.version, '0.170.0');

  // Complete execution: temp cwd cleanup, streaming callback, usage reporting without double counting
  const streamed = [];
  const recordedUsage = [];
  const complete = createCodexCompleteAdapter(
    { executablePath: fakeCodex, model: 'gpt-5.4', effort: 'medium' },
    { runner, timeoutMs: 10_000 },
  );
  const reply = await withUsageSink(
    { key: 'test-codex', sink: (u) => recordedUsage.push(u) },
    () => complete('System', 'Prompt', { onOutput: (chunk) => streamed.push(chunk) }),
  );
  assert.match(reply, /^CODEX_OK:\d+$/);
  assert.deepEqual(streamed, [reply]);
  assert.equal(recordedUsage.length, 1);
  assert.deepEqual(recordedUsage[0], {
    uncachedInputTokens: 600,
    outputTokens: 40,
    cacheReadTokens: 300,
    cacheWriteTokens: 100,
  });
  assert.equal(totalTokens(recordedUsage[0]), 1040);

  const usedCwd = (await readFile(cwdFile, 'utf8')).trim();
  assert.ok(usedCwd.includes('studyhub-codex-'));
  await assert.rejects(() => access(usedCwd));
});

/* ============================================================================
 * 3. Provider Discovery Tests
 * ============================================================================ */

test('application/provider-discovery distinguishes ready, unauthenticated, broken-shim, not-installed, coming-soon, and caches with TTL', async () => {
  let clock = 1000;
  let probeCalls = 0;
  let agyMode = 'ready';
  let codexMode = 'ready';
  let codexModels = 'listed', codexModelCalls = 0;

  const discovery = createProviderDiscovery({
    now: () => clock,
    ttlMs: 10_000,
    listCandidates: async (id) => {
      if (id === 'agy') return agyMode === 'missing' ? [] : ['C:\\Users\\demo\\.gemini\\bin\\agy.exe'];
      if (id === 'claude') return ['C:\\node_global\\claude.cmd'];
      if (id === 'codex') return codexMode === 'missing' ? [] : ['C:\\node_global\\codex.cmd'];
      return [];
    },
    probeVersion: async (id) => {
      probeCalls += 1;
      if (id === 'agy') {
        if (agyMode === 'broken') return { ok: false, version: null, reason: '启动脚本损坏' };
        return { ok: true, version: '1.5.5', reason: '' };
      }
      if (id === 'codex') {
        if (codexMode === 'broken') return { ok: false, version: null, reasonCode: 'broken-shim', reason: '启动脚本损坏' };
        return { ok: true, version: '0.170.0', reason: '' };
      }
      return { ok: true, version: '2.1.327', reason: '' };
    },
    listAgyModels: async () => {
      if (agyMode === 'unauth') return { ok: false, unauthenticated: true, models: [], reason: 'not logged in' };
      return { ok: true, unauthenticated: false, models: [{ id: 'gemini-4', name: 'Gemini 4' }], reason: '' };
    },
    checkCodexAuth: async () => {
      if (codexMode === 'unauth') return { ok: false, authenticated: false, detail: 'Not logged in' };
      return { ok: true, authenticated: true, authMethod: 'account', detail: 'Logged in using ChatGPT' };
    },
    listCodexModels: async () => {
      codexModelCalls += 1;
      if (codexModels === 'throws') throw new Error('spawn failed');
      if (codexModels === 'none') return { ok: false, models: [], reason: 'unrecognized subcommand' };
      return { ok: true, models: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna' }], reason: '' };
    },
  });

  const first = await discovery.scan();
  assert.deepEqual(first.find((p) => p.id === 'codex').models, [{ id: 'gpt-6-luna', name: 'GPT-6-Luna' }], 'a ready codex carries the models it lists');
  // A codex that cannot list its models is still ready: the page then offers the model as free text.
  for (const mode of ['none', 'throws']) {
    codexModels = mode;
    const unlisted = (await discovery.scan({ force: true })).find((p) => p.id === 'codex');
    assert.deepEqual({ status: unlisted.status, models: unlisted.models }, { status: 'ready', models: [] }, mode);
  }
  codexModels = 'listed';
  await discovery.scan({ force: true });
  assert.equal(first.find((p) => p.id === 'agy').status, 'ready');
  assert.equal(first.find((p) => p.id === 'agy').models.length, 1);
  assert.equal(first.find((p) => p.id === 'claude').status, 'coming-soon');
  assert.equal(first.find((p) => p.id === 'claude').supported, false);
  assert.equal(first.find((p) => p.id === 'claude').version, '2.1.327');
  assert.equal(first.find((p) => p.id === 'codex').supported, true);
  assert.equal(first.find((p) => p.id === 'codex').status, 'ready');
  assert.equal(first.find((p) => p.id === 'codex').version, '0.170.0');
  assert.equal(first.find((p) => p.id === 'codex').authMethod, 'account', 'the ready codex carries how it is signed in');
  assert.equal(Object.hasOwn(first.find((p) => p.id === 'agy'), 'authMethod'), false, 'no other provider has one');
  assert.equal(discovery.findReadyCodexPath(), 'C:\\node_global\\codex.cmd');
  const countAfterFirst = probeCalls;

  // EN localization has zero CJK characters across all providers
  for (const prov of localizeProviders(first, 'en')) {
    assert.ok(!/[\u4e00-\u9fff]/.test(prov.reason), `EN provider ${prov.id} leaked CJK: ${prov.reason}`);
  }

  // Cached within TTL
  clock += 5000;
  await discovery.scan();
  assert.equal(probeCalls, countAfterFirst);

  // Forced refresh detects unauthenticated for both agy and codex
  agyMode = 'unauth';
  codexMode = 'unauth';
  const modelCallsBefore = codexModelCalls;
  const unauth = await discovery.scan({ force: true });
  assert.equal(unauth.find((p) => p.id === 'agy').status, 'unauthenticated');
  assert.equal(unauth.find((p) => p.id === 'codex').status, 'unauthenticated');
  assert.equal(codexModelCalls, modelCallsBefore, 'a codex that is not signed in is not asked for its models');
  for (const prov of localizeProviders(unauth, 'en')) {
    assert.ok(!/[\u4e00-\u9fff]/.test(prov.reason), `EN unauth ${prov.id} leaked CJK: ${prov.reason}`);
  }

  // After TTL expires, detects broken-shim
  clock += 20_000;
  agyMode = 'broken';
  codexMode = 'broken';
  const broken = await discovery.scan();
  assert.equal(broken.find((p) => p.id === 'agy').status, 'broken-shim');
  assert.equal(broken.find((p) => p.id === 'codex').status, 'broken-shim');

  // Detects not-installed
  agyMode = 'missing';
  codexMode = 'missing';
  const missing = await discovery.scan({ force: true });
  assert.equal(missing.find((p) => p.id === 'agy').status, 'not-installed');
  assert.equal(missing.find((p) => p.id === 'codex').status, 'not-installed');
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

const codeOf = (work) => { try { work(); return ''; } catch (error) { return error.code; } };
const codeOfAsync = async (work) => { try { await work(); return ''; } catch (error) { return error.code; } };

test('domain/terminal-command picks only a ready local CLI and the library folder, and builds one quoted start line or refuses', () => {
  const providers = [
    { id: 'agy', supported: true, status: 'ready', executablePath: 'E:\\agy\\bin\\agy.exe' },
    { id: 'codex', supported: true, status: 'unauthenticated', executablePath: 'D:\\npm\\codex.cmd' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: 'C:\\claude.exe' },
  ];
  assert.deepEqual(cliLaunchRequest(providers, 'agy', 'D:\\Study'), { executablePath: 'E:\\agy\\bin\\agy.exe', cwd: 'D:\\Study' });
  assert.equal(codeOf(() => cliLaunchRequest(providers, 'codex', 'D:\\Study')), 'cli-not-ready', 'a CLI that is not signed in is not opened');
  assert.equal(codeOf(() => cliLaunchRequest(providers, 'claude', 'D:\\Study')), 'invalid-cli', 'an unsupported CLI is never opened, even when found');
  assert.equal(codeOf(() => cliLaunchRequest(providers, 'C:\\evil.exe', 'D:\\Study')), 'invalid-cli');
  assert.equal(codeOf(() => cliLaunchRequest(providers, undefined, 'D:\\Study')), 'invalid-cli');

  assert.equal(
    buildStartCommandLine({ cwd: 'D:\\My Docs\\学习库', command: 'C:\\App\\node.exe', args: ['D:\\npm\\node_modules\\codex\\bin\\codex.js'] }),
    '/d /s /c "start "" /d "D:\\My Docs\\学习库" "C:\\App\\node.exe" "D:\\npm\\node_modules\\codex\\bin\\codex.js""',
  );
  assert.equal(buildStartCommandLine({ cwd: 'D:\\', command: 'E:\\agy\\bin\\agy.exe' }), '/d /s /c "start "" /d "D:\\" "E:\\agy\\bin\\agy.exe""');
  const refused = (parts) => codeOf(() => buildStartCommandLine({ cwd: 'D:\\Study', command: 'E:\\agy.exe', args: [], ...parts }));
  for (const bad of ['D:\\a"b', 'D:\\100%', 'D:\\R&D', 'D:\\a^b', 'D:\\a!b', 'D:\\a|b', 'D:\\a<b', 'D:\\a>b', 'D:\\a\nb', 'D:\\a\u202eb']) {
    assert.equal(refused({ cwd: bad }), 'terminal-path-unsafe', `refuses the folder ${JSON.stringify(bad)}`);
    assert.equal(refused({ command: `${bad}\\agy.exe` }), 'terminal-path-unsafe', `refuses the program under ${JSON.stringify(bad)}`);
  }
  assert.equal(refused({ cwd: 'Study' }), 'terminal-path-unsafe', 'a relative folder is refused');
  assert.equal(refused({ cwd: '\\\\server\\share' }), 'terminal-path-unsafe', 'a network folder is refused: start cannot use it as the current folder');
  assert.equal(refused({ command: 'agy' }), 'terminal-path-unsafe', 'a bare program name is refused: no PATH lookup');
  assert.equal(refused({ args: ['--dangerously-skip'] }), 'terminal-path-unsafe', 'an argument must be an absolute script path, never a flag');
  assert.equal(refused({ args: ['D:\\dir\\'] }), 'terminal-path-unsafe', 'an argument ending in a backslash would swallow its closing quote');
});

test('adapters/os/open-terminal starts cmd.exe once with the verbatim line, unwraps npm shims, and is Windows-only', async () => {
  const launched = [];
  const launch = async (command, line, options) => { launched.push({ command, line, options }); };
  const env = { SystemRoot: 'C:\\Windows' };
  const plain = async (path) => ({ ok: true, command: path, prefixArgs: [] });

  const opened = await openCliTerminal({ executablePath: 'E:\\agy\\bin\\agy.exe', cwd: 'D:\\Study Hub' }, { platform: 'win32', launch, unwrap: plain, env });
  assert.deepEqual(opened, { ok: true });
  assert.deepEqual(launched, [{
    command: 'C:\\Windows\\System32\\cmd.exe',
    line: '/d /s /c "start "" /d "D:\\Study Hub" "E:\\agy\\bin\\agy.exe""',
    options: { cwd: 'D:\\Study Hub' },
  }]);

  launched.length = 0;
  const shim = async () => ({ ok: true, command: 'C:\\App\\node.exe', prefixArgs: ['D:\\npm\\codex.js'] });
  await openCliTerminal({ executablePath: 'D:\\npm\\codex.cmd', cwd: 'D:\\Study' }, { platform: 'win32', launch, unwrap: shim, env });
  assert.equal(launched[0].line, '/d /s /c "start "" /d "D:\\Study" "C:\\App\\node.exe" "D:\\npm\\codex.js""');

  launched.length = 0;
  const broken = async () => ({ ok: false, errorCode: 'BROKEN_SHIM', reason: '启动脚本指向的目标文件不存在' });
  assert.equal(await codeOfAsync(() => openCliTerminal({ executablePath: 'D:\\npm\\codex.cmd', cwd: 'D:\\Study' }, { platform: 'win32', launch, unwrap: broken, env })), 'BROKEN_SHIM');
  assert.equal(await codeOfAsync(() => openCliTerminal({ executablePath: 'E:\\agy.exe', cwd: 'D:\\R&D' }, { platform: 'win32', launch, unwrap: plain, env })), 'terminal-path-unsafe');
  assert.equal(await codeOfAsync(() => openCliTerminal({ executablePath: '/usr/bin/agy', cwd: '/home/me' }, { platform: 'linux', launch, unwrap: plain, env })), 'terminal-unsupported');
  assert.deepEqual(launched, [], 'nothing is started when a request is refused');

  const failing = async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); };
  assert.equal(await codeOfAsync(() => openCliTerminal({ executablePath: 'E:\\agy.exe', cwd: 'D:\\Study' }, { platform: 'win32', launch: failing, unwrap: plain, env })), 'terminal-launch-failed');
});

test('adapters/storage/config-store uses the DSH library inside a picked workspace folder, and the folder itself otherwise', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-config-library-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const home = join(work, 'home'), docs = join(work, 'docs');
  const store = createConfigStore({ env: {}, home, documentsDir: docs });
  const libraryFile = (folder) => join(folder, 'study-workspace.json');
  const holdLibrary = async (folder) => { await mkdir(folder, { recursive: true }); await writeFile(libraryFile(folder), '{}', 'utf8'); };

  // A DSH workspace: the plugin keeps its library in .dsh-study, and the folder itself has none.
  const workspace = join(work, '八股项目');
  await holdLibrary(join(workspace, '.dsh-study'));
  assert.equal(await store.saveLibraryRoot(workspace), resolve(workspace), 'what was picked is what is saved');
  const inWorkspace = (await store.load()).library;
  assert.equal(inWorkspace.root, resolve(workspace, '.dsh-study'), 'the library is the one the plugin already keeps there');
  assert.equal(inWorkspace.pickedRoot, resolve(workspace));
  assert.equal(inWorkspace.rootSource, 'custom');

  // A folder that is a library itself stays the library, whatever else is inside it.
  await holdLibrary(workspace);
  const itself = (await store.load()).library;
  assert.equal(itself.root, resolve(workspace));
  assert.equal(itself.pickedRoot, resolve(workspace));

  // A folder with no library anywhere becomes one itself: no .dsh-study is made for it.
  const fresh = join(work, 'Fresh');
  await store.saveLibraryRoot(fresh);
  const empty = (await store.load()).library;
  assert.equal(empty.root, resolve(fresh));
  assert.equal(empty.pickedRoot, resolve(fresh));
  assert.deepEqual(await readdir(fresh), []);

  // An empty .dsh-study is not a library: nothing was ever saved in it.
  await mkdir(join(fresh, '.dsh-study'));
  assert.equal((await store.load()).library.root, resolve(fresh));

  // The variable and the default folder follow the same rule.
  const pinned = createConfigStore({ env: { STUDYHUB_LIBRARY: join(work, 'Pinned') }, home, documentsDir: docs });
  await holdLibrary(join(work, 'Pinned', '.dsh-study'));
  const byEnv = (await pinned.load()).library;
  assert.equal(byEnv.root, resolve(work, 'Pinned', '.dsh-study'));
  assert.equal(byEnv.rootSource, 'config');
  await store.saveLibraryRoot('');
  await holdLibrary(join(docs, 'StudyHub', '.dsh-study'));
  const byDefault = (await store.load()).library;
  assert.equal(byDefault.root, resolve(docs, 'StudyHub', '.dsh-study'));
  assert.equal(byDefault.rootSource, 'default');
});

test('domain/library-place tells a system-drive library from another drive, and a confirmed place from one still to confirm', () => {
  assert.equal(isOnSystemDrive('C:\\Users\\me\\Documents\\StudyHub', 'C:'), true);
  assert.equal(isOnSystemDrive('c:/Users/me/StudyHub', 'C:'), true, 'the drive letter is compared without case');
  assert.equal(isOnSystemDrive('C:\\Users\\me', 'c:\\'), true, 'the system drive may be written with a slash or in lower case');
  assert.equal(isOnSystemDrive('D:\\StudyHub', 'C:'), false);
  assert.equal(isOnSystemDrive('\\\\server\\share\\StudyHub', 'C:'), false, 'a network path is not on the drive');
  assert.equal(isOnSystemDrive('/home/me/StudyHub', 'C:'), false, 'a path with no drive letter is not on the drive');
  assert.equal(isOnSystemDrive('C:relative', 'C:'), false);
  assert.equal(isOnSystemDrive('', 'C:'), false);
  assert.equal(isOnSystemDrive('C:\\StudyHub', ''), false, 'with no system drive named nothing is on it');
  assert.equal(isOnSystemDrive('E:\\StudyHub', 'E:'), true, 'the system drive is the one given, not a fixed letter');

  const system = { root: 'C:\\StudyHub', systemDrive: 'C:' };
  assert.deepEqual(libraryPlaceOf({ ...system, confirmed: false, rootSource: 'default' }), { confirmed: false, onSystemDrive: true });
  assert.deepEqual(libraryPlaceOf({ ...system, confirmed: true, rootSource: 'custom' }), { confirmed: true, onSystemDrive: true });
  assert.deepEqual(libraryPlaceOf({ root: 'D:\\StudyHub', systemDrive: 'C:', confirmed: false, rootSource: 'custom' }), { confirmed: false, onSystemDrive: false });
  assert.equal(libraryPlaceOf({ ...system, confirmed: false, rootSource: 'config' }).confirmed, true, 'the variable decides: there is nothing to choose');
});

test('domain/config-policy keeps libraryPlaceConfirmed through every save and names how the model is reached', () => {
  assert.equal(defaultDesktopConfig().libraryPlaceConfirmed, false);
  assert.equal(normalizeDesktopConfig({ libraryPlaceConfirmed: true }).libraryPlaceConfirmed, true);
  assert.equal(normalizeDesktopConfig({ libraryPlaceConfirmed: 'yes' }).libraryPlaceConfirmed, false, 'only a real true counts');
  assert.equal(normalizeDesktopConfig({}).libraryPlaceConfirmed, false, 'a config written before this field existed is not confirmed');
  const confirmed = { ...defaultDesktopConfig(), libraryPlaceConfirmed: true };
  const saved = applyConfigPatch(confirmed, { mode: 'agy', agy: { model: 'gemini-4' } });
  assert.equal(saved.config.libraryPlaceConfirmed, true, 'a model save does not take the confirmation back');

  assert.deepEqual(modelViaOf(defaultDesktopConfig()), { kind: 'api', name: 'DeepSeek', billing: 'per-use' });
  assert.deepEqual(modelViaOf({ ...defaultDesktopConfig(), mode: 'agy' }), { kind: 'cli', name: 'Antigravity CLI', billing: 'account' });
  const codex = { ...defaultDesktopConfig(), mode: 'codex' };
  const probe = (status, authMethod) => [{ id: 'codex', status, ...(authMethod ? { authMethod } : {}) }];
  assert.equal(modelViaOf(codex).billing, 'unknown', 'no probe yet: not guessed');
  assert.equal(modelViaOf(codex, probe('ready', 'account')).billing, 'account');
  assert.equal(modelViaOf(codex, probe('ready', 'api-key')).billing, 'per-use', 'a codex signed in with an API key is billed per use');
  assert.equal(modelViaOf(codex, probe('ready', 'unknown')).billing, 'unknown');
  assert.equal(modelViaOf(codex, probe('ready')).billing, 'unknown');
  assert.equal(modelViaOf(codex, probe('unauthenticated', 'account')).billing, 'unknown', 'only a ready codex says how it is signed in');
  assert.deepEqual(modelViaOf(codex, probe('ready', 'api-key')), { kind: 'cli', name: 'Codex CLI', billing: 'per-use' });
});

test('adapters/storage/config-store confirms the library place when a folder is saved, and a refused folder confirms nothing', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-config-place-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const store = createConfigStore({ env: {}, home: join(work, 'home'), documentsDir: join(work, 'docs') });
  assert.equal((await store.load()).config.libraryPlaceConfirmed, false);
  await assert.rejects(store.saveLibraryRoot('not-absolute'), { code: 'invalid-library-root' });
  assert.equal((await store.load()).config.libraryPlaceConfirmed, false, 'a refused folder changes nothing');
  await store.saveLibraryRoot(join(work, 'Picked'));
  assert.equal((await store.load()).config.libraryPlaceConfirmed, true);
  await store.save({ ...(await store.load()).config, mode: 'codex' });
  assert.equal((await store.load()).config.libraryPlaceConfirmed, true, 'a later save keeps it');
  await store.saveLibraryRoot('');
  assert.equal((await store.load()).config.libraryPlaceConfirmed, true, 'going back to the default folder is a choice too');
});

test('application/desktop-host exposes libraryPlace and modelVia in the binding, and desktop.library.confirm confirms once', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-desktop-place-'));
  const prevDshHome = process.env.DSH_HOME;
  t.after(async () => {
    registerHostConcurrencyCap(null);
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    await rm(work, { recursive: true, force: true });
  });
  const env = { DSH_HOME: join(work, 'dsh-home') };
  const documentsDir = join(work, 'Documents');
  const configStore = createConfigStore({ env, home: join(work, 'home'), documentsDir });
  const providerDiscovery = createProviderDiscovery({
    listCandidates: async () => [],
    probeVersion: async () => ({ ok: false, version: '', reason: '' }),
    listAgyModels: async () => ({ ok: true, unauthenticated: false, models: [], reason: '' }),
    checkCodexAuth: async () => ({ ok: true, authenticated: true, detail: '' }),
  });
  const stub = async () => 'OK';
  const start = async (store, systemDrive) => {
    const started = await createDesktopHost({
      configStore: store, providerDiscovery, openaiComplete: createOpenAiCompleteAdapter, agyComplete: () => stub, codexComplete: () => stub,
      jobExecutor: createInProcessJobExecutor(), openExternal: async () => ({ ok: true }), ensureDir: (p) => mkdir(p, { recursive: true }),
      injectedComplete: stub, systemDrive,
    });
    t.after(() => started.dispose());
    return started;
  };
  // The drive the work folder sits on stands in for the system drive: the host is told which drive that is.
  const host = await start(configStore, resolve(documentsDir).slice(0, 2));

  const first = (await host.call('binding.get')).value;
  assert.deepEqual(first.libraryPlace, { confirmed: false, onSystemDrive: process.platform === 'win32' }, 'a library nobody confirmed yet');
  assert.deepEqual(first.modelVia, { kind: 'api', name: 'DeepSeek', billing: 'per-use' });

  const confirmed = await host.call('desktop.library.confirm', {});
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.value.libraryPlace.confirmed, true);
  assert.equal(confirmed.value.root, first.root, 'confirming moves nothing');
  assert.equal(JSON.parse(await readFile(configStore.configPath, 'utf8')).libraryPlaceConfirmed, true);
  assert.equal((await host.call('desktop.library.confirm', {})).value.libraryPlace.confirmed, true, 'asking again ends in the same state');

  // The flag survives a model save, and the model is named by how it is reached.
  await host.call('desktop.config.save', { mode: 'codex', codex: { model: 'gpt-5.4' } });
  const viaCli = (await host.call('binding.get')).value;
  assert.equal(viaCli.libraryPlace.confirmed, true);
  assert.deepEqual(viaCli.modelVia, { kind: 'cli', name: 'Codex CLI', billing: 'unknown' }, 'no CLI detected here: how it is billed is not guessed');
  await host.call('desktop.config.save', { mode: 'agy' });
  assert.deepEqual((await host.call('binding.get')).value.modelVia, { kind: 'cli', name: 'Antigravity CLI', billing: 'account' });
  await host.call('desktop.config.save', { mode: 'openai' });
  assert.equal((await host.call('binding.get')).value.modelVia.kind, 'api');

  // Picking a folder confirms, a refused folder and a change of effort alone do not (a new learner: nothing confirmed yet).
  const freshStore = createConfigStore({ env: { DSH_HOME: join(work, 'dsh-home-2') }, home: join(work, 'home2'), documentsDir });
  const fresh = await start(freshStore, 'C:');
  await fresh.call('binding.set', { reasoningEffort: 'low' });
  assert.equal((await fresh.call('binding.get')).value.libraryPlace.confirmed, false, 'an effort-only change confirms nothing');
  const refused = await fresh.call('binding.set', { root: 'not-absolute' });
  assert.equal(refused.ok, false);
  assert.equal((await fresh.call('binding.get')).value.libraryPlace.confirmed, false, 'a refused folder changes nothing');
  const elsewhere = join(work, 'Elsewhere');
  const picked = await fresh.call('binding.set', { root: elsewhere, provider: '', model: '', reasoningEffort: 'high' });
  assert.equal(picked.value.libraryPlace.confirmed, true);
  assert.equal(picked.value.reasoningEffort, 'high', 'the effort sent with the folder is kept');
  assert.equal(picked.value.root, resolve(elsewhere));
  assert.equal(JSON.parse(await readFile(freshStore.configPath, 'utf8')).libraryPlaceConfirmed, true, 'the second write of one call keeps the confirmation');

  // The variable decides the folder: there is nothing to choose, so the place counts as confirmed with no flag.
  const pinnedStore = createConfigStore({ env: { DSH_HOME: join(work, 'dsh-home-3'), STUDYHUB_LIBRARY: join(work, 'Pinned') }, home: join(work, 'home3'), documentsDir });
  const pinned = await start(pinnedStore, 'C:');
  const byEnv = (await pinned.call('binding.get')).value;
  assert.equal(byEnv.rootSource, 'config');
  assert.equal(byEnv.libraryPlace.confirmed, true);
});

test('application/desktop-host: an existing install is still to confirm, confirming writes on a fresh read of the file, and codex says how it is billed', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-desktop-place2-'));
  const prevDshHome = process.env.DSH_HOME;
  t.after(async () => {
    registerHostConcurrencyCap(null);
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    await rm(work, { recursive: true, force: true });
  });
  const stub = async () => 'OK';
  let codexAuth = { ok: true, authenticated: true, authMethod: 'account', detail: 'Logged in using ChatGPT' };
  let codexAuthCalls = 0;
  const providerDiscovery = createProviderDiscovery({
    listCandidates: async (id) => (id === 'codex' ? ['C:\\fake\\codex.cmd'] : []),
    probeVersion: async () => ({ ok: true, version: '0.170.0', reason: '' }),
    listAgyModels: async () => ({ ok: true, unauthenticated: false, models: [], reason: '' }),
    checkCodexAuth: async () => { codexAuthCalls += 1; return codexAuth; },
    ttlMs: 0,
  });
  const start = async (store) => {
    const started = await createDesktopHost({
      configStore: store, providerDiscovery, openaiComplete: createOpenAiCompleteAdapter, agyComplete: () => stub, codexComplete: () => stub,
      jobExecutor: createInProcessJobExecutor(), openExternal: async () => ({ ok: true }), ensureDir: (p) => mkdir(p, { recursive: true }),
      injectedComplete: stub, systemDrive: 'C:',
    });
    t.after(() => started.dispose());
    return started;
  };

  // An install from before this field: desktop.json holds a folder and no flag, so the learner is still to confirm it (and sees the card once).
  const env = { DSH_HOME: join(work, 'dsh-home') };
  const home = join(work, 'home'), documentsDir = join(work, 'Documents');
  const existing = join(work, 'Existing');
  await mkdir(join(env.DSH_HOME, 'study'), { recursive: true });
  await writeFile(join(env.DSH_HOME, 'study', 'desktop.json'), JSON.stringify({ mode: 'openai', libraryRoot: existing }), 'utf8');
  const store = createConfigStore({ env, home, documentsDir });
  const host = await start(store);
  const before = (await host.call('binding.get')).value;
  assert.equal(before.rootSource, 'custom');
  assert.equal(before.root, resolve(existing));
  assert.equal(before.libraryPlace.confirmed, false, 'a saved folder alone is not a confirmed place');

  // The host's state is read once; the file then changes under it (a folder saved by another call). Confirming must not put the old folder back.
  const moved = join(work, 'Moved');
  await store.saveLibraryRoot(moved);
  const confirmed = await host.call('desktop.library.confirm', {});
  assert.equal(confirmed.ok, true);
  const onDisk = JSON.parse(await readFile(store.configPath, 'utf8'));
  assert.equal(onDisk.libraryRoot, resolve(moved), 'the folder saved after the host read its state is kept');
  assert.equal(onDisk.libraryPlaceConfirmed, true);
  assert.equal(confirmed.value.root, resolve(moved), 'and the binding that comes back shows it');

  // codex: how it is signed in decides what the note may say.
  await host.call('desktop.config.save', { mode: 'codex', codex: { model: 'gpt-5.4' } });
  assert.deepEqual((await host.call('binding.get')).value.modelVia, { kind: 'cli', name: 'Codex CLI', billing: 'account' });
  // The binding is read at every start and after every folder change: it uses the last scan and does not ask the CLI again.
  const asked = codexAuthCalls;
  await host.call('binding.get');
  await host.call('desktop.library.confirm', {});
  assert.equal(codexAuthCalls, asked, 'reading the binding does not probe codex again');
  // A new scan (Settings does one; 重新扫描 forces one) is what notices a changed login.
  codexAuth = { ok: true, authenticated: true, authMethod: 'api-key', detail: 'Logged in using an API key' };
  await host.call('desktop.providers.scan', { force: true });
  assert.deepEqual((await host.call('binding.get')).value.modelVia, { kind: 'cli', name: 'Codex CLI', billing: 'per-use' }, 'a codex signed in with an API key is billed per use');
  codexAuth = { ok: true, authenticated: true, detail: 'Logged in' };
  await host.call('desktop.providers.scan', { force: true });
  assert.equal((await host.call('binding.get')).value.modelVia.billing, 'unknown', 'a login that names no method promises nothing');
  assert.equal(JSON.stringify((await host.call('binding.get')).value).includes('sk-'), false, 'no key text in the binding');
});

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
    listCandidates: async (id) => {
      if (id === 'agy') return ['C:\\fake\\agy.exe'];
      if (id === 'codex') return ['C:\\fake\\codex.cmd'];
      return [];
    },
    probeVersion: async (id) => ({ ok: true, version: id === 'codex' ? '0.170.0' : '1.5.5', reason: '' }),
    listAgyModels: async () => ({ ok: true, unauthenticated: false, models: [{ id: 'gemini-4', name: 'Gemini 4' }], reason: '' }),
    checkCodexAuth: async () => ({ ok: true, authenticated: true, detail: 'Logged in using ChatGPT' }),
  });

  const terminalRequests = [];
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
    codexComplete: () => stubComplete,
    jobExecutor,
    openExternal: async () => ({ ok: true }),
    openCliTerminal: async (request) => { terminalRequests.push(request); return { ok: true }; },
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

  // Switching to codex persists codex config and applies CLI concurrency cap 1..2
  const savedCodex = await host.call('desktop.config.save', {
    mode: 'codex',
    codex: { model: 'gpt-5.4', effort: 'high' },
    uiLanguage: 'en',
  });
  assert.equal(savedCodex.ok, true);
  assert.equal(savedCodex.value.mode, 'codex');
  assert.deepEqual(savedCodex.value.codex, { executablePath: '', model: 'gpt-5.4', effort: 'high' });
  assert.equal(savedCodex.value.effective.ready, true);
  assert.equal(savedCodex.value.effective.maxConcurrency, 2);
  assert.equal(savedCodex.value.effective.defaultConcurrency, 1);
  assert.equal(effectiveConcurrencyLimit().max, 2);
  assert.ok(!/[\u4e00-\u9fff]/.test(savedCodex.value.effective.label), `EN codex label leaked CJK: ${savedCodex.value.effective.label}`);

  // desktop.json is stored inside DSH_HOME/study, never inside library root
  const persisted = JSON.parse(await readFile(configStore.configPath, 'utf8'));
  assert.equal(persisted.mode, 'codex');
  assert.equal(persisted.codex.model, 'gpt-5.4');
  assert.ok(!configStore.configPath.startsWith(host.library.root));

  // 5b. Config test, EN localization (zero CJK leaks), & update view
  const tested = await host.call('desktop.config.test', { mode: 'codex' });
  assert.equal(tested.ok, true);
  assert.equal(tested.value.ok, true);
  assert.equal(typeof tested.value.latencyMs, 'number');

  const testedEn = await host.call('desktop.config.test', { mode: 'codex', uiLanguage: 'en' });
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
  assert.match(updateView.setupUrl, /StudyHub-Desktop-4\.15\.0-win-x64-setup\.exe$/);
  assert.equal(updateView.assetUrl, updateView.setupUrl);
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

  // The settings page always sends the folder and the reasoning effort together (ui/app/use-library-connection.js customBinding):
  // the folder must still move, and a later effort-only change must keep it.
  const movedLibrary = join(work, 'MovedLibrary');
  const bindAsUi = await host.call('binding.set', { root: movedLibrary, provider: '', model: '', reasoningEffort: '' });
  assert.equal(bindAsUi.ok, true);
  assert.equal(bindAsUi.value.root, resolve(movedLibrary), 'a folder picked in Settings becomes the library');
  const effortOnly = await host.call('binding.set', { root: movedLibrary, provider: '', model: '', reasoningEffort: 'high' });
  assert.equal(effortOnly.value.root, resolve(movedLibrary));
  assert.equal(effortOnly.value.reasoningEffort, 'high');
  const effortAlone = await host.call('binding.set', { reasoningEffort: 'low' });
  assert.equal(effortAlone.value.root, resolve(movedLibrary), 'a change of effort with no folder in it keeps the folder');
  assert.equal(effortAlone.value.reasoningEffort, 'low');
  const badRoot = await host.call('binding.set', { root: 'not-absolute', reasoningEffort: 'high' });
  assert.equal(badRoot.ok, false);
  assert.equal(badRoot.code, 'invalid-library-root');
  const afterBadRoot = await host.call('binding.get');
  assert.equal(afterBadRoot.value.root, resolve(movedLibrary), 'a refused folder changes nothing');
  assert.equal(afterBadRoot.value.reasoningEffort, 'low', 'nor does the effort sent with it');
  const backToDefault = await host.call('binding.set', { root: '', provider: '', model: '', reasoningEffort: '' });
  assert.equal(backToDefault.value.rootSource, 'default', 'an empty folder goes back to the default library');
  assert.equal(backToDefault.value.root, backToDefault.value.defaultRoot);
  const bindBack = await host.call('binding.set', { root: altLibrary, provider: '', model: '', reasoningEffort: '' });
  assert.equal(bindBack.value.root, resolve(altLibrary));
  assert.equal(bindBack.value.pickedRoot, resolve(altLibrary), 'a plain folder is both what was picked and the library');
  assert.equal(bindBack.value.reasoningEffort, '');

  // 「在学习库里打开 CLI」: the page names a CLI and nothing else; the program comes from discovery and the folder is the library.
  const openedCli = await host.call('desktop.cli.open', { provider: 'agy', executablePath: 'C:\\evil.exe', cwd: 'C:\\Windows', args: ['--yolo'] });
  assert.equal(openedCli.ok, true);
  assert.deepEqual(openedCli.value, { ok: true, provider: 'agy', cwd: resolve(altLibrary) });
  assert.deepEqual(terminalRequests, [{ executablePath: 'C:\\fake\\agy.exe', cwd: resolve(altLibrary) }]);
  const refusedCli = await host.call('desktop.cli.open', { provider: 'claude', uiLanguage: 'en' });
  assert.equal(refusedCli.ok, false);
  assert.equal(refusedCli.code, 'invalid-cli');
  assert.doesNotMatch(refusedCli.error, /[㐀-鿿]/, 'the refusal reads in English when the interface is English');
  assert.equal(terminalRequests.length, 1, 'a refused request starts nothing');

  // A DSH workspace picked as the library folder: the library is the .dsh-study the plugin keeps in it, and the CLI opens in the workspace.
  const dshWorkspace = join(work, 'DshWorkspace');
  await mkdir(join(dshWorkspace, '.dsh-study'), { recursive: true });
  await writeFile(join(dshWorkspace, '.dsh-study', 'study-workspace.json'), '{}', 'utf8');
  const inWorkspace = await host.call('binding.set', { root: dshWorkspace, provider: '', model: '', reasoningEffort: '' });
  assert.equal(inWorkspace.value.root, resolve(dshWorkspace, '.dsh-study'));
  assert.equal(inWorkspace.value.pickedRoot, resolve(dshWorkspace));
  const samePick = await host.call('binding.set', { root: dshWorkspace, provider: '', model: '', reasoningEffort: '' });
  assert.equal(samePick.value.root, inWorkspace.value.root, 'picking the workspace again changes nothing');
  await host.call('desktop.cli.open', { provider: 'agy' });
  assert.equal(terminalRequests.at(-1).cwd, resolve(dshWorkspace), 'the CLI opens in the folder the learner picked');
  await host.call('binding.set', { root: altLibrary, provider: '', model: '', reasoningEffort: '' });

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
  t.after(() => {
    if (child.exitCode === null && !child.killed) child.kill();
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const portPromise = new Promise((resolvePort, rejectPort) => {
    let buf = '';
    const timer = setTimeout(() => rejectPort(new Error(`Handshake timeout. stderr=${stderr}`)), 45_000);
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
  assert.equal(parsed.value.studyCliPath, join(REPO_ROOT, 'scripts', 'study-cli.mjs'));

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

test('desktop completion adapters (openai, agy, codex) honor execution.timeoutMs (0 = unlimited, >0 = override, undefined = default) and stamp TimeoutError', async (t) => {
  const timeouts = [];
  const origTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return origTimeout(ms); };
  t.after(() => { AbortSignal.timeout = origTimeout; });

  const okOpenAiResponse = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: 'OPENAI_OK' } }] }),
  });

  // 1. OpenAI adapter: 0 -> no timer, >0 -> override, undefined -> default, timeout -> name === 'TimeoutError'
  const seenOpenAiSignals = [];
  const openai = createOpenAiCompleteAdapter(
    { baseUrl: 'https://api.example.invalid/v1', model: 'm', apiKey: 'sk-test' },
    {
      timeoutMs: 12_345,
      fetch: async (_url, init) => { seenOpenAiSignals.push(init.signal); return okOpenAiResponse(); },
    },
  );
  const callerCtl = new AbortController();
  assert.equal(await openai('s', 'p', { timeoutMs: 0, signal: callerCtl.signal }), 'OPENAI_OK');
  assert.deepEqual(timeouts, [], 'openai timeoutMs=0 arms no AbortSignal.timeout');
  assert.equal(seenOpenAiSignals[0], callerCtl.signal, 'openai timeoutMs=0 relies directly on execution.signal');

  assert.equal(await openai('s', 'p', { timeoutMs: 77_000 }), 'OPENAI_OK');
  assert.deepEqual(timeouts, [77_000], 'openai execution.timeoutMs overrides default');

  assert.equal(await openai('s', 'p', {}), 'OPENAI_OK');
  assert.deepEqual(timeouts, [77_000, 12_345], 'openai undefined execution.timeoutMs uses adapter default');

  const slowOpenAi = createOpenAiCompleteAdapter(
    { baseUrl: 'https://api.example.invalid/v1', model: 'm', apiKey: 'sk-test' },
    {
      timeoutMs: 5_000,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 5_000);
        init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); }, { once: true });
      }),
    },
  );
  const openaiErr = await slowOpenAi('s', 'p', { timeoutMs: 25 }).catch((e) => e);
  assert.equal(openaiErr?.name, 'TimeoutError', 'openai timeout error is stamped TimeoutError');
  assert.equal(openaiErr?.modelFailure, true);
  assert.equal(callOutcomeOf(openaiErr, { signal: new AbortController().signal, stepTimeout: null, budgetMs: 0 }).reason, 'timeout');

  // 2. Agy adapter: honors 0 / >0 / undefined in both runner.run and --print-timeout, stamps TimeoutError
  const agyRuns = [];
  const agyOkStdout = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'AGY_OK' } });
  const agy = createAgyCompleteAdapter(
    { executablePath: 'fake-agy', model: 'gemini-test', effort: 'low' },
    {
      timeoutMs: 15_000,
      runner: {
        run: async (req) => {
          agyRuns.push(req);
          if (req.timeoutMs === 30) return { code: null, stdout: '', stderr: '', timedOut: true, aborted: false };
          return { code: 0, stdout: agyOkStdout, stderr: '', timedOut: false, aborted: false };
        },
      },
    },
  );
  assert.equal(await agy('s', 'p', { timeoutMs: 0 }), 'AGY_OK');
  assert.equal(agyRuns[0].timeoutMs, 0);
  assert.equal(agyRuns[0].args[agyRuns[0].args.indexOf('--print-timeout') + 1], '0s');

  assert.equal(await agy('s', 'p', { timeoutMs: 1_200_000 }), 'AGY_OK');
  assert.equal(agyRuns[1].timeoutMs, 1_200_000);
  assert.equal(agyRuns[1].args[agyRuns[1].args.indexOf('--print-timeout') + 1], '1200s');

  assert.equal(await agy('s', 'p', {}), 'AGY_OK');
  assert.equal(agyRuns[2].timeoutMs, 15_000);
  assert.equal(agyRuns[2].args[agyRuns[2].args.indexOf('--print-timeout') + 1], '15s');

  const agyErr = await agy('s', 'p', { timeoutMs: 30 }).catch((e) => e);
  assert.equal(agyErr?.name, 'TimeoutError', 'agy timeout error is stamped TimeoutError');
  assert.equal(agyErr?.modelFailure, true);
  assert.equal(callOutcomeOf(agyErr, { signal: new AbortController().signal, stepTimeout: null, budgetMs: 0 }).reason, 'timeout');

  // 3. Codex adapter: honors 0 / >0 / undefined in runner.run, stamps TimeoutError
  const codexRuns = [];
  const codexOkStdout = JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'CODEX_OK' } });
  const codex = createCodexCompleteAdapter(
    { executablePath: 'fake-codex', model: 'gpt-5.4', effort: 'medium' },
    {
      timeoutMs: 25_000,
      language: 'en',
      runner: {
        run: async (req) => {
          codexRuns.push(req);
          if (req.timeoutMs === 35) return { code: null, stdout: '', stderr: '', timedOut: true, aborted: false };
          return { code: 0, stdout: codexOkStdout, stderr: '', timedOut: false, aborted: false };
        },
      },
    },
  );
  assert.equal(await codex('s', 'p', { timeoutMs: 0 }), 'CODEX_OK');
  assert.equal(codexRuns[0].timeoutMs, 0);

  assert.equal(await codex('s', 'p', { timeoutMs: 900_000 }), 'CODEX_OK');
  assert.equal(codexRuns[1].timeoutMs, 900_000);

  assert.equal(await codex('s', 'p', {}), 'CODEX_OK');
  assert.equal(codexRuns[2].timeoutMs, 25_000);

  const codexErr = await codex('s', 'p', { timeoutMs: 35 }).catch((e) => e);
  assert.equal(codexErr?.name, 'TimeoutError', 'codex timeout error is stamped TimeoutError');
  assert.equal(codexErr?.modelFailure, true);
  assert.equal(callOutcomeOf(codexErr, { signal: new AbortController().signal, stepTimeout: null, budgetMs: 0 }).reason, 'timeout');
});

test('pack-zip packages NSIS setup.exe, .sig, latest.json updater manifest, .msi, portable .zip, and SHA256SUMS', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-pack-zip-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const runtimeDir = join(work, 'runtime');
  const msiDir = join(work, 'bundle', 'msi');
  const nsisDir = join(work, 'bundle', 'nsis');
  const outdir = join(work, 'out');
  const exePath = join(work, 'StudyHub.exe');

  await mkdir(join(runtimeDir, 'lib'), { recursive: true });
  await mkdir(msiDir, { recursive: true });
  await mkdir(nsisDir, { recursive: true });
  await writeFile(join(runtimeDir, 'lib', 'stub.js'), 'export const ok = true;\n', 'utf8');
  await writeFile(exePath, 'FAKE_EXE_BYTES', 'utf8');
  await writeFile(join(msiDir, 'StudyHub_5.2.0_x64_en-US.msi'), 'FAKE_MSI_BYTES', 'utf8');
  await writeFile(join(nsisDir, 'StudyHub_5.2.0_x64-setup.exe'), 'FAKE_NSIS_SETUP_BYTES', 'utf8');
  await writeFile(join(nsisDir, 'StudyHub_5.2.0_x64-setup.exe.sig'), 'dW50cnVzdGVkLXNpZw==\n', 'utf8');

  const packed = await packPortableZip({
    outdir,
    runtimeDir,
    exePath,
    version: '5.2.0',
    msiDir,
    nsisDir,
    repo: 'EricWang1358/dsh-web-studyhub',
    pubDate: '2026-11-21T00:00:00Z',
  });

  assert.equal(packed.version, '5.2.0');
  assert.equal(packed.updaterManifest, 'latest.json');
  assert.deepEqual(
    packed.artifacts.map((item) => item.name),
    [
      'StudyHub-Desktop-5.2.0-win-x64-setup.exe',
      'StudyHub-Desktop-5.2.0-win-x64.msi',
      'StudyHub-Desktop-5.2.0-win-x64.zip',
    ],
  );

  const sums = await readFile(join(outdir, 'SHA256SUMS-Desktop-5.2.0.txt'), 'utf8');
  assert.match(sums, /StudyHub-Desktop-5\.2\.0-win-x64-setup\.exe/);
  assert.match(sums, /StudyHub-Desktop-5\.2\.0-win-x64\.msi/);
  assert.match(sums, /StudyHub-Desktop-5\.2\.0-win-x64\.zip/);

  const sigCopy = (await readFile(join(outdir, 'StudyHub-Desktop-5.2.0-win-x64-setup.exe.sig'), 'utf8')).trim();
  assert.equal(sigCopy, 'dW50cnVzdGVkLXNpZw==');

  const manifest = JSON.parse(await readFile(join(outdir, 'latest.json'), 'utf8'));
  assert.deepEqual(
    manifest,
    buildUpdaterManifest({
      version: '5.2.0',
      signature: 'dW50cnVzdGVkLXNpZw==',
      downloadUrl: 'https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v5.2.0/StudyHub-Desktop-5.2.0-win-x64-setup.exe',
      pubDate: '2026-11-21T00:00:00Z',
    }),
  );
  assert.equal(manifest.platforms['windows-x86_64'].signature, 'dW50cnVzdGVkLXNpZw==');
  assert.equal(manifest.platforms['windows-x86_64-nsis'].url, manifest.platforms['windows-x86_64'].url);
});

test('stage-runtime bundles runnable scripts/study-cli.mjs, staged sidecar exposes real studyCliPath, and staged CLI executes skeleton.topics / topic.groups.save / snapshot via --file and --root', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-staged-cli-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const runtimeDir = join(work, 'runtime');
  const libraryDir = join(work, 'library');
  const dshHome = join(work, 'dsh-home');
  await mkdir(libraryDir, { recursive: true });
  await mkdir(dshHome, { recursive: true });

  // Seed a real temporary library with two ungrouped topics before launching staged runtime tools.
  const seedService = new StudyService(libraryDir);
  try {
    const seeded = await seedService.call('deck.import', {
      text: JSON.stringify({
        title: 'Algorithms Quiz',
        course: 'Algorithms',
        cards: [
          { kind: 'flashcard', topic: 'Binary Search', prompt: 'What is the time complexity of binary search?', answer: 'O(log n)' },
          { kind: 'flashcard', topic: 'Two Pointers', prompt: 'When does the two-pointer technique apply?', answer: 'Monotonic sorted ranges' },
        ],
      }),
    });
    assert.equal(seeded.added, 2);
  } finally {
    await seedService.dispose();
  }

  const staged = await stageRuntime({ outdir: runtimeDir });
  assert.ok(staged.cliScripts.includes('study-cli.mjs'));
  const expectedCliPath = join(runtimeDir, 'scripts', 'study-cli.mjs');
  await access(expectedCliPath);

  const stagedNode = join(runtimeDir, staged.node.binaryName);
  const stagedSidecar = join(runtimeDir, 'packages', 'studyhub-desktop', 'entry', 'sidecar.mjs');
  const token = randomBytes(32).toString('hex');
  const child = spawn(stagedNode, [stagedSidecar], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      NODE_PATH: '',
      DSH_HOME: dshHome,
      STUDYHUB_LIBRARY: libraryDir,
      STUDYHUB_DESKTOP_RUNTIME_ROOT: runtimeDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && !child.killed) child.kill();
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const portPromise = new Promise((resolvePort, rejectPort) => {
    let buf = '';
    const timer = setTimeout(() => rejectPort(new Error(`Staged sidecar handshake timeout. stderr=${stderr}`)), 30_000);
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        resolvePort(JSON.parse(buf.slice(0, nl)).port);
      } catch (err) {
        rejectPort(err);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectPort(new Error(`Staged sidecar exited early (${code}). stderr=${stderr}`));
    });
  });

  child.stdin.write(`${JSON.stringify({ token })}\n`);
  const port = await portPromise;
  const authHeaders = {
    host: `127.0.0.1:${port}`,
    origin: 'tauri://localhost',
    'content-type': 'application/json',
    'x-study-token': token,
  };

  const cfgRes = await rawHttpRequest({
    port,
    headers: authHeaders,
    body: JSON.stringify({ action: 'desktop.config.get', args: {} }),
  });
  assert.equal(cfgRes.status, 200);
  const cfgPayload = JSON.parse(cfgRes.text);
  assert.equal(cfgPayload.ok, true);
  assert.equal(cfgPayload.value.studyCliPath, expectedCliPath);

  const bindRes = await rawHttpRequest({
    port,
    headers: authHeaders,
    body: JSON.stringify({ action: 'binding.get', args: {} }),
  });
  assert.equal(bindRes.status, 200);
  const bindPayload = JSON.parse(bindRes.text);
  assert.equal(bindPayload.ok, true);
  assert.deepEqual(bindPayload.value.host, DESKTOP_CAPABILITIES);
  assert.equal(bindPayload.value.studyCliPath, expectedCliPath);

  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectExit(new Error(`Staged sidecar did not exit on stdin EOF. stderr=${stderr}`));
    }, 10_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
    child.stdin.end();
  });
  assert.equal(exitCode, 0);

  // Execute the staged study-cli.mjs from outside the repo with NODE_PATH cleared.
  const runCli = (args) => runProcess({
    command: stagedNode,
    args: [bindPayload.value.studyCliPath, ...args],
    cwd: work,
    env: { ...process.env, NODE_PATH: '', DSH_HOME: dshHome },
    timeoutMs: 90_000,
  });
  const formatRunFailure = (label, res) => `${label} failed: ${JSON.stringify({
    code: res.code, signal: res.signal, timedOut: res.timedOut,
    errorCode: res.errorCode, errorMessage: res.errorMessage,
    stdout: res.stdout?.slice(0, 300), stderr: res.stderr?.slice(0, 300),
  })}`;

  const topicsFile = join(work, 'topics-query.json');
  await writeFile(topicsFile, JSON.stringify({ ungrouped: true, compact: true }), 'utf8');
  const topicsRun = await runCli(['call', 'skeleton.topics', '--file', topicsFile, '--root', libraryDir]);
  assert.equal(topicsRun.code, 0, formatRunFailure('skeleton.topics', topicsRun));
  const topicsOut = JSON.parse(topicsRun.stdout);
  assert.equal(topicsOut.total, 2);
  assert.deepEqual(topicsOut.topics.map((item) => item.key).sort(), ['binarysearch', 'twopointers']);

  const groupsFile = join(work, 'groups-save.json');
  await writeFile(groupsFile, JSON.stringify({
    mode: 'replace',
    groups: [{ title: 'Algorithms Core', topics: ['binarysearch', 'twopointers'] }],
  }), 'utf8');
  const groupsRun = await runCli(['call', 'topic.groups.save', '--file', groupsFile, '--root', libraryDir]);
  assert.equal(groupsRun.code, 0, formatRunFailure('topic.groups.save', groupsRun));
  const groupsOut = JSON.parse(groupsRun.stdout);
  assert.equal(groupsOut.groups.length, 1);
  assert.equal(groupsOut.groups[0].title, 'Algorithms Core');
  assert.equal(groupsOut.groups[0].count, 2);
  assert.deepEqual(groupsOut.ungrouped, []);

  const snapRun = await runCli(['call', 'snapshot', '--root', libraryDir]);
  assert.equal(snapRun.code, 0, formatRunFailure('snapshot', snapRun));
  const snapOut = JSON.parse(snapRun.stdout);
  assert.equal(snapOut.decks.length, 1);
  assert.equal(snapOut.decks[0].title, 'Algorithms Quiz');
  assert.deepEqual(snapOut.topicGrouping, { topics: 2, groups: 1, ungrouped: 0 });
});
