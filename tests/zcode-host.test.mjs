import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHome, documentsFolder, readConfig, resolveHome, saveLibraryRoot } from '../packages/studyhub-zcode/host/workspace.mjs';
import { chatUrl, openaiComplete, usageOf } from '../packages/studyhub-zcode/host/openai-complete.mjs';
import { openExternal, openableUrl } from '../packages/studyhub-zcode/host/app-open.mjs';
import { inProcessExecutor } from '../packages/studyhub-zcode/host/job-executor.mjs';
import { dueLine } from '../packages/studyhub-zcode/host/due.mjs';
import { ZCODE_MESSAGE_CODES, zcodeText } from '../packages/studyhub-zcode/host/messages.mjs';
import { localizeAppMessage } from '../lib/application-messages.js';

/* The ZCode host adapter's own decisions: where the home and the library are, the model endpoint (never handed back in
   full), the update answer pointing at the ZCode package, the link guard, and the in-process executor's honesty about
   a job whose process is gone. */

const scratch = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
/** A host over a temporary home and library; the environment is a private copy, so nothing leaks between tests. */
async function host(t, { env: extra = {}, fetch } = {}) {
  const dir = await scratch(t);
  const env = { DSH_HOME: join(dir, 'home'), ...extra };
  const { createZcodeHost } = await import('../packages/studyhub-zcode/host/study-host.mjs');
  const previous = process.env.DSH_HOME;
  const made = await createZcodeHost({ env, documents: join(dir, 'Documents'), ...(fetch ? { fetch } : {}), log: () => {} });
  t.after(async () => { await made.dispose(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; });
  return { host: made, dir, env };
}
const value = (answer) => { assert.equal(answer.ok, true, answer.error); return answer.value; };

test('the home is DSH_HOME, else an existing ~/.dsh (shared with DSH), else ~/.zcode/studyhub', () => {
  assert.deepEqual(resolveHome({ DSH_HOME: ' /x/home ' }, { homedir: '/u', exists: () => true }).source, 'env');
  assert.deepEqual(resolveHome({}, { homedir: '/u', exists: () => true }), { home: join('/u', '.dsh'), source: 'dsh' });
  assert.deepEqual(resolveHome({}, { homedir: '/u', exists: () => false }), { home: join('/u', '.zcode', 'studyhub'), source: 'zcode' });
  const env = {};
  applyHome(env, { homedir: '/u', exists: () => false });
  assert.equal(env.DSH_HOME, join('/u', '.zcode', 'studyhub'), 'lib/ reads DSH_HOME, so the host sets it');
});

test('the default library is <Documents>/StudyHub with the Documents folder Windows really uses', () => {
  const registry = 'HKEY_CURRENT_USER\\...\\Shell Folders\r\n    Personal    REG_SZ    E:\\Users\\me\\OneDrive\\文档\r\n';
  assert.equal(documentsFolder({ platform: 'win32', homedir: 'C:\\Users\\me', run: () => registry }), 'E:\\Users\\me\\OneDrive\\文档');
  assert.equal(documentsFolder({ platform: 'win32', homedir: 'C:\\Users\\me', run: () => { throw new Error('no reg'); } }), join('C:\\Users\\me', 'Documents'));
  assert.equal(documentsFolder({ platform: 'linux', homedir: '/home/me' }), join('/home/me', 'Documents'));
});

test('the library: STUDYHUB_LIBRARY, else the folder chosen in the panel, else the default', async (t) => {
  const dir = await scratch(t), home = join(dir, 'home'), documents = join(dir, 'Docs');
  assert.deepEqual([readConfig({ env: {}, home, documents }).libraryRoot, readConfig({ env: {}, home, documents }).rootSource], [join(documents, 'StudyHub'), 'default']);
  saveLibraryRoot(home, join(dir, 'chosen'));
  assert.deepEqual([readConfig({ env: {}, home, documents }).libraryRoot, readConfig({ env: {}, home, documents }).rootSource], [join(dir, 'chosen'), 'custom']);
  assert.equal(readConfig({ env: { STUDYHUB_LIBRARY: join(dir, 'env') }, home, documents }).rootSource, 'env');
  assert.throws(() => saveLibraryRoot(home, 'relative/path'), { code: 'zcode-library-not-absolute' });
  saveLibraryRoot(home, '');
  assert.equal(readConfig({ env: {}, home, documents }).rootSource, 'default');
});

test('binding.set moves the library the panel uses, and an empty root goes back to the default', async (t) => {
  const { host: zcode, dir } = await host(t);
  const first = value(await zcode.call('binding.get'));
  assert.equal(first.rootSource, 'default');
  assert.equal(first.root, join(dir, 'Documents', 'StudyHub'));
  assert.equal(first.host.edition, 'zcode');
  const moved = value(await zcode.call('binding.set', { root: join(dir, 'Other library'), provider: '', model: '' }));
  assert.deepEqual([moved.root, moved.rootSource], [join(dir, 'Other library'), 'custom']);
  assert.equal(value(await zcode.call('snapshot')).root ?? join(dir, 'Other library'), join(dir, 'Other library'));
  const back = value(await zcode.call('binding.set', { root: '' }));
  assert.deepEqual([back.root, back.rootSource], [join(dir, 'Documents', 'StudyHub'), 'default']);
  const refused = await zcode.call('binding.set', { root: 'not/absolute', uiLanguage: 'en' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /full path/);
});

test('the model endpoint is saved in the home config, and the key never comes back in full', async (t) => {
  const { host: zcode, env } = await host(t);
  const saved = value(await zcode.call('model.config.set', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', model: 'glm-4-flash', label: '智谱 GLM', apiKey: 'sk-secret-abcd' }));
  assert.deepEqual(saved, { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', label: '智谱 GLM', ready: true, key: { set: true, hint: '••••abcd', source: 'file' } });
  const read = value(await zcode.call('model.config.get'));
  assert.ok(!JSON.stringify(read).includes('sk-secret'), 'the key is masked');
  const file = JSON.parse(await readFile(join(env.DSH_HOME, 'study', 'zcode.json'), 'utf8'));
  assert.equal(file.model.apiKey, 'sk-secret-abcd');
  // The readiness the panel's gates read: the saved endpoint, named by its label.
  const snapshot = value(await zcode.call('snapshot'));
  assert.equal(snapshot.model.ready, true);
  assert.equal(snapshot.model.reason, 'ok');
  assert.match(snapshot.model.label, /智谱 GLM · glm-4-flash/);
  // Changing the address keeps the key; an empty key clears it.
  value(await zcode.call('model.config.set', { baseUrl: 'https://api.siliconflow.cn/v1' }));
  assert.equal(value(await zcode.call('model.config.get')).key.set, true);
  assert.equal(value(await zcode.call('model.config.set', { apiKey: '' })).key.set, false);
  const bad = await zcode.call('model.config.set', { baseUrl: 'ftp://example.com', uiLanguage: 'en' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /start it with https/);
  // The model's tools never reach the endpoint or the key.
  for (const action of ['model.config.get', 'model.config.set', 'model.config.test']) {
    const refused = await zcode.call(action, {}, { from: 'agent' });
    assert.equal(refused.ok, false, action);
    assert.equal(refused.code, 'assistant-refused');
  }
});

test('STUDYHUB_API_KEY wins over a saved key and is reported as the environment\'s', async (t) => {
  const { host: zcode } = await host(t, { env: { STUDYHUB_API_KEY: 'sk-from-env-9876' } });
  value(await zcode.call('model.config.set', { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-file-1111' }));
  const read = value(await zcode.call('model.config.get'));
  assert.deepEqual(read.key, { set: true, hint: '••••9876', source: 'env' });
});

test('测试 sends one small request and reports the answer honestly, in the panel\'s language', async (t) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return calls.length === 1 ? new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 })
      : new Response('{"error":{"message":"invalid api key"}}', { status: 401 });
  };
  const { host: zcode } = await host(t, { fetch });
  assert.equal(value(await zcode.call('model.config.test', { uiLanguage: 'en' })).message, zcodeText('model-incomplete', 'en'));
  value(await zcode.call('model.config.set', { baseUrl: 'https://api.example.test/v1', model: 'm-1', apiKey: 'sk-test-0000' }));
  const ok = value(await zcode.call('model.config.test', {}));
  assert.equal(ok.ok, true);
  assert.equal(calls[0].url, 'https://api.example.test/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer sk-test-0000');
  assert.equal(calls[0].body.model, 'm-1');
  const failed = value(await zcode.call('model.config.test', { uiLanguage: 'en' }));
  assert.equal(failed.ok, false);
  assert.match(failed.message, /HTTP 401 \(the key is wrong or has no access\): .*invalid api key/);
});

test('the OpenAI-compatible call: deadline, honest errors in both languages, and the billed tokens', async () => {
  assert.equal(openaiComplete({ baseUrl: 'https://x', id: 'm' }), undefined, 'no key, no model');
  assert.equal(chatUrl('https://x/v1/'), 'https://x/v1/chat/completions');
  assert.equal(chatUrl('https://x/v1/chat/completions'), 'https://x/v1/chat/completions');
  const model = { baseUrl: 'https://x/v1', id: 'm', apiKey: 'k' };
  const reported = [];
  const ok = openaiComplete(model, { report: (usage) => reported.push(usage),
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } })) });
  assert.equal(await ok('s', 'p'), '{"a":1}');
  assert.deepEqual(reported, [{ inputTokens: 40, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 0 }]);
  assert.equal(usageOf({ prompt_tokens: -1, completion_tokens: 2 }), null);

  // AbortSignal.timeout does not hold the event loop open (the MCP server's stdin does); this test holds it.
  const holder = setInterval(() => {}, 1000);
  const hang = openaiComplete(model, { timeoutMs: 50, fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
  await assert.rejects(hang('s', 'p'), (error) => error.message === '模型服务 0 秒内没有回复' && localizeAppMessage(error.message, 'en') === 'The model service did not answer within 0 seconds');
  clearInterval(holder);
  const html = openaiComplete(model, { fetch: async () => new Response('<html>portal</html>', { status: 200 }) });
  await assert.rejects(html('s', 'p'), /^Error: 模型服务的回复不是 JSON：<html>portal<\/html>$/);
  const offline = openaiComplete(model, { fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(offline('s', 'p'), (error) => localizeAppMessage(error.message, 'en') === 'Cannot reach the model service: ENOTFOUND. Check the address and the network');
  const empty = openaiComplete(model, { fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: ' ' } }] })) });
  await assert.rejects(empty('s', 'p'), (error) => localizeAppMessage(error.message, 'en') === 'The model returned no text');
  for (const [status, hint] of [[403, 'the key is wrong or has no access'], [404, 'the address or the model name is wrong'], [429, 'too many requests'], [503, 'the service had an error']]) {
    const refused = openaiComplete(model, { fetch: async () => new Response('nope', { status }) });
    await assert.rejects(refused('s', 'p'), (error) => localizeAppMessage(error.message, 'en').includes(hint));
  }
  const stopped = new AbortController();
  const cancellable = openaiComplete(model, { fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted by caller')))) });
  const pending = cancellable('s', 'p', { signal: stopped.signal });
  stopped.abort();
  await assert.rejects(pending, /aborted by caller/, 'a stop from the job is not reported as the service failing');
});

test('update.check points the guided upgrade at the ZCode package of the same release', async () => {
  const { zcodeUpdateView, zcodeAsset } = await import('../packages/studyhub-zcode/host/study-host.mjs');
  const view = zcodeUpdateView({ current: '3.7.2', latest: '3.8.0', newer: true, upgradeAvailable: true, assetName: 'ericwang1358-dsh-daily-flashcard-3.8.0.tgz', assetUrl: 'x' });
  assert.equal(view.assetName, 'StudyHub-ZCode-3.8.0.zip');
  assert.equal(view.assetUrl, 'https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v3.8.0/StudyHub-ZCode-3.8.0.zip');
  assert.equal(view.sha256Url, 'https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v3.8.0/SHA256SUMS-ZCode-3.8.0.txt');
  assert.deepEqual(view.install, { available: false, desktop: false, host: 'zcode' }, 'no one-click install in ZCode');
  assert.equal(view.upgradeAvailable, true);
  assert.deepEqual(zcodeAsset(null), { assetName: null, assetUrl: null, sha256Url: null });
});

test('update.install answers the refusal the dialog already explains', async (t) => {
  const { host: zcode } = await host(t);
  assert.deepEqual(value(await zcode.call('update.install', { version: '9.9.9' })), { status: 'failed', code: 'UPDATE_NO_INSTALLER' });
});

test('app.open opens only a plain http(s) address, and never through a shell', () => {
  for (const url of ['https://github.com/EricWang1358/dsh-web-studyhub/blob/zcode/docs/zcode.zh-CN.md', 'https://a.example/x?y=1&z=2', 'https://a.example/#%E9%85%8D%E7%BD%AE'])
    assert.equal(openableUrl(url), url, url);
  for (const url of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'https://a.example/"&calc.exe', 'https://a.example/ x', 'https://u:p@a.example/',
    'https://a.example/|x', 'https://a.example/^x', `https://a.example/${'x'.repeat(2000)}`, '', null, 'ms-settings:privacy', 'https://a.example/\nx'])
    assert.equal(openableUrl(url), null, String(url).slice(0, 40));
  const spawned = [];
  const spawn = (command, args, options) => { spawned.push({ command, args, shell: options.shell }); return { on() {}, unref() {} }; };
  openExternal('https://a.example/x?y=1&z=2', { platform: 'win32', spawn });
  openExternal('https://a.example/', { platform: 'darwin', spawn });
  assert.deepEqual(spawned, [{ command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'https://a.example/x?y=1&z=2'], shell: undefined },
    { command: 'open', args: ['https://a.example/'], shell: undefined }]);
  assert.throws(() => openExternal('file:///etc/passwd', { spawn }), { code: 'zcode-link-refused' });
  assert.equal(spawned.length, 2, 'a refused address starts nothing');
});

test('the in-process executor: alive while it runs here, lost once its process is gone (so 接着做 can continue it)', async () => {
  let finish;
  const executor = inProcessExecutor({ pid: 4242, host: 'win32:pc', alive: (pid) => pid === 7777, log: () => {} });
  const witness = executor.witness();
  const handle = executor.start({ run: () => new Promise((resolve) => { finish = resolve; }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.inspect({ handleId: handle.id }, witness).state, 'alive');
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.inspect({ handleId: handle.id }, witness).state, 'lost');
  // After ZCode quit and started again: another instance; the old process is gone, or (another live process) unknown.
  assert.deepEqual(executor.inspect({ handleId: 'old' }, { pid: 1234, host: 'win32:pc', instance: 'earlier' }), { state: 'lost', reason: 'executor-process-exited' });
  assert.equal(executor.inspect({ handleId: 'old' }, { pid: 7777, host: 'win32:pc', instance: 'earlier' }).state, 'unknown');
  assert.equal(executor.inspect({ handleId: 'old' }, { pid: 1234, host: 'linux:other', instance: 'earlier' }).state, 'unknown');
  let rejected;
  const failing = inProcessExecutor({ log: (...args) => { rejected = args.join(' '); } });
  failing.start({ run: async () => { throw new Error('boom'); } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(rejected, /boom/, 'a failing attempt reaches the log');
});

test('the SessionStart line counts like the dashboard and stays silent without a library', () => {
  assert.equal(dueLine({ due: 0, cards: 0, decks: 0 }), '');
  assert.match(dueLine({ due: 3, cards: 40, decks: 2 }), /今天有 3 题到期待复习。.*3 due for review today/);
  assert.match(dueLine({ due: 0, cards: 40, decks: 2 }), /今天没有到期待复习的题.*nothing due for review today/);
});

test('every message of the host has both languages', () => {
  for (const code of ZCODE_MESSAGE_CODES) {
    assert.match(zcodeText(code, 'zh'), /[\u4e00-\u9fff]/, code);
    assert.doesNotMatch(zcodeText(code, 'en'), /[\u4e00-\u9fff]/, code);
  }
});

test('a fresh library folder is created at start, so the first run boots', async (t) => {
  const { host: zcode, dir } = await host(t);
  await mkdir(join(dir, 'Documents'), { recursive: true });
  assert.ok((await readFile(join(dir, 'home', 'study', 'zcode.json'), 'utf8').catch(() => '')) === '', 'nothing is written before the learner saves');
  assert.equal(value(await zcode.call('snapshot')).decks.length, 0);
});
