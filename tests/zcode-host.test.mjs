import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applyHome, checkLibrary, decodeBase64Output, documentsFolder, powershellText, readConfig, resolveHome, resolveLibrary,
  saveLibraryRoot } from '../packages/studyhub-zcode/host/workspace.mjs';
import { chatUrl, openaiComplete, redactKey, usageOf } from '../packages/studyhub-zcode/host/openai-complete.mjs';
import { openExternal, openableUrl, opener } from '../packages/studyhub-zcode/host/app-open.mjs';
import { inProcessExecutor } from '../packages/studyhub-zcode/host/job-executor.mjs';
import { dueLine } from '../packages/studyhub-zcode/host/due.mjs';
import { ZCODE_MESSAGE_CODES, zcodeText } from '../packages/studyhub-zcode/host/messages.mjs';
import { localizeAppMessage } from '../lib/application-messages.js';
import { StudyService } from '../lib/service.js';

/* The ZCode host adapter's own decisions: where the home and the library are (also for paths in any script, and for a
   folder that cannot be used), the model endpoint (never handed back in full, never sent to another provider), the
   assistant's door (exactly DSH's), the update answer, the link guard, and the in-process executor's honesty. */
const run = promisify(execFile);
const windows = process.platform === 'win32';
const hookScript = fileURLToPath(new URL('../packages/studyhub-zcode/hooks/session-start.mjs', import.meta.url));

const scratch = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
/** A host over a temporary home and library; the environment is a private copy, so nothing leaks between tests. */
async function host(t, { env: extra = {}, fetch, dir: given } = {}) {
  const dir = given || await scratch(t);
  const env = { DSH_HOME: join(dir, 'home'), ...extra };
  const { createZcodeHost } = await import('../packages/studyhub-zcode/host/study-host.mjs');
  const previous = process.env.DSH_HOME;
  const made = await createZcodeHost({ env, documents: join(dir, 'Documents'), ...(fetch ? { fetch } : {}), log: () => {} });
  t.after(async () => { await made.dispose(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; });
  return { host: made, dir, env };
}
const value = (answer) => { assert.equal(answer.ok, true, answer.error); return answer.value; };
const panel = (zcode, action, args = {}) => zcode.call(action, args, { from: 'panel' });
/** A drive letter with no drive behind it (Windows), for "the drive is gone". */
const missingDrive = () => [...'ZYXWVUTSRQPONMLKJIHGFED'].map((letter) => `${letter}:\\`).find((drive) => !existsSync(drive));

test('the home is DSH_HOME (a relative one from the user folder, never the chat folder), else ~/.dsh, else ~/.zcode/studyhub', () => {
  assert.equal(resolveHome({ DSH_HOME: join(tmpdir(), 'x-home') }, { homedir: '/u', exists: () => true }).source, 'env');
  assert.deepEqual(resolveHome({ DSH_HOME: 'my-home' }, { homedir: join(tmpdir(), 'u') }), { home: join(tmpdir(), 'u', 'my-home'), source: 'env', relative: true });
  assert.deepEqual(resolveHome({}, { homedir: '/u', exists: () => true }), { home: join('/u', '.dsh'), source: 'dsh' });
  assert.deepEqual(resolveHome({}, { homedir: '/u', exists: () => false }), { home: join('/u', '.zcode', 'studyhub'), source: 'zcode' });
  const env = {};
  applyHome(env, { homedir: '/u', exists: () => false });
  assert.equal(env.DSH_HOME, join('/u', '.zcode', 'studyhub'), 'lib/ reads DSH_HOME, so the host sets it');
});

test('PowerShell answers in base64 of UTF-8: real bytes decode, and console-code-page bytes are never taken for a path', () => {
  const path = 'C:\\Users\\张三\\Documents';
  const utf8Base64 = Buffer.from(Buffer.from(path, 'utf8').toString('base64') + '\r\n', 'latin1');
  assert.equal(decodeBase64Output(utf8Base64), path);
  // What `reg query` printed on a Chinese Windows (code page 936): 张三 is D5 C5 C8 FD.
  const gbk = Buffer.from([...Buffer.from('C:\\Users\\', 'latin1'), 0xd5, 0xc5, 0xc8, 0xfd, ...Buffer.from('\\Documents\r\n', 'latin1')]);
  assert.equal(decodeBase64Output(gbk), null, 'raw console bytes are not base64');
  assert.equal(decodeBase64Output(Buffer.from(Buffer.from(gbk).toString('base64'))), null, 'GBK bytes are not valid UTF-8 (U+FFFD)');
  const home = join(tmpdir(), 'someone');
  assert.equal(documentsFolder({ platform: 'win32', homedir: home, run: () => utf8Base64 }), path);
  assert.equal(documentsFolder({ platform: 'win32', homedir: home, run: () => gbk }), join(home, 'Documents'), 'a garbled answer falls back');
  assert.equal(documentsFolder({ platform: 'win32', homedir: home, run: () => Buffer.from(Buffer.from('relative\\Docs').toString('base64')) }), join(home, 'Documents'));
  assert.equal(documentsFolder({ platform: 'win32', homedir: home, run: () => { throw new Error('no powershell'); } }), join(home, 'Documents'));
  assert.equal(documentsFolder({ platform: 'linux', homedir: '/home/me' }), join('/home/me', 'Documents'));
});

test('the real PowerShell round trip keeps Chinese, & and % intact, and finds the real Documents folder', { skip: !windows && 'Windows only' }, () => {
  assert.equal(powershellText("'C:\\Users\\张三 & 50%\\文档'"), 'C:\\Users\\张三 & 50%\\文档');
  const documents = documentsFolder({ fresh: true });
  assert.ok(!documents.includes('\uFFFD') && existsSync(documents), documents);
});

test('a folder that cannot hold a library is reported, never used', async (t) => {
  const dir = await scratch(t);
  assert.deepEqual(checkLibrary(join(dir, 'new', 'library')), { ok: true }, 'a missing folder is created');
  await writeFile(join(dir, 'a-file'), 'x');
  assert.deepEqual(checkLibrary(join(dir, 'a-file')), { ok: false, reason: 'not-folder' });
  assert.equal(checkLibrary(join(dir, 'a-file', 'below')).ok, false);
  assert.deepEqual(checkLibrary('relative\\library'), { ok: false, reason: 'not-absolute' });
  if (windows) assert.deepEqual(checkLibrary(join(missingDrive(), 'StudyHub')), { ok: false, reason: 'missing' });
});

test('a read-only folder is refused', { skip: (windows || process.getuid?.() === 0) && 'needs POSIX permissions as a normal user' }, async (t) => {
  const dir = await scratch(t), locked = join(dir, 'locked');
  await mkdir(locked);
  await chmod(locked, 0o500);
  try {
    assert.deepEqual(checkLibrary(locked), { ok: false, reason: 'denied' });
  } finally {
    await chmod(locked, 0o700).catch(() => {});
  }
});

test('the library: STUDYHUB_LIBRARY, else the chosen folder, else the default; one that cannot be used is skipped and reported', async (t) => {
  const dir = await scratch(t), home = join(dir, 'home'), documents = join(dir, 'Docs');
  const at = (env, saved = {}) => resolveLibrary({ env, home, saved, documents });
  assert.deepEqual(at({}), { libraryRoot: join(documents, 'StudyHub'), rootSource: 'default', defaultRoot: join(documents, 'StudyHub'), problem: null });
  assert.equal(at({}, { libraryRoot: join(dir, 'chosen') }).rootSource, 'custom');
  assert.equal(at({ STUDYHUB_LIBRARY: join(dir, 'env') }).rootSource, 'env');
  await writeFile(join(dir, 'blocked'), 'x');
  const blocked = at({ STUDYHUB_LIBRARY: join(dir, 'blocked') });
  assert.deepEqual([blocked.libraryRoot, blocked.problem], [join(documents, 'StudyHub'), { root: join(dir, 'blocked'), source: 'env', reason: 'not-folder' }]);
  assert.equal(at({ STUDYHUB_LIBRARY: 'relative/library' }).problem.reason, 'not-absolute', 'a relative STUDYHUB_LIBRARY is refused, not taken from the chat folder');
  const neither = resolveLibrary({ env: {}, home, saved: { libraryRoot: join(dir, 'blocked') }, documents: join(dir, 'blocked') });
  assert.deepEqual([neither.libraryRoot, neither.rootSource], [join(home, 'StudyHub'), 'fallback'], 'the home keeps one more place');
});

test('binding.set refuses a folder that cannot hold a library, changes nothing, and says why in the panel\'s language', async (t) => {
  const { host: zcode, dir, env } = await host(t);
  const before = value(await panel(zcode, 'binding.get'));
  await writeFile(join(dir, 'a-file'), 'x');
  const refused = await panel(zcode, 'binding.set', { root: join(dir, 'a-file'), uiLanguage: 'en' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'This location cannot be used as a library: a file with that name is already there');
  assert.equal((await panel(zcode, 'binding.set', { root: join(dir, 'a-file') })).error, '这个位置不能用作学习库：这里已经有一个同名的文件');
  if (windows) assert.match((await panel(zcode, 'binding.set', { root: join(missingDrive(), 'StudyHub') })).error, /找不到这个盘或上级文件夹/);
  assert.equal(existsSync(join(env.DSH_HOME, 'study', 'zcode.json')), false, 'nothing was saved');
  assert.deepEqual(value(await panel(zcode, 'binding.get')).root, before.root);
});

test('binding.set moves the library the panel uses, and an empty root goes back to the default', async (t) => {
  const { host: zcode, dir } = await host(t);
  const first = value(await panel(zcode, 'binding.get'));
  assert.deepEqual([first.rootSource, first.root, first.host.edition, first.libraryProblem], ['default', join(dir, 'Documents', 'StudyHub'), 'zcode', null]);
  const moved = value(await panel(zcode, 'binding.set', { root: join(dir, 'Other library'), provider: '', model: '' }));
  assert.deepEqual([moved.root, moved.rootSource], [join(dir, 'Other library'), 'custom']);
  assert.equal(zcode.libraryStatus().root, join(dir, 'Other library'));
  const back = value(await panel(zcode, 'binding.set', { root: '' }));
  assert.deepEqual([back.root, back.rootSource], [join(dir, 'Documents', 'StudyHub'), 'default']);
  assert.match((await panel(zcode, 'binding.set', { root: 'not/absolute', uiLanguage: 'en' })).error, /full path/);
});

test('a configured library that cannot be opened does not stop the server: the default is used, and the panel, the tools and the SessionStart line say the same', async (t) => {
  const dir = await scratch(t);
  // A deck in the default library, so the SessionStart line has something to count.
  const fallback = join(dir, 'Documents', 'StudyHub');
  const service = new StudyService(fallback, {});
  const card = (index) => ({ kind: 'flashcard', topic: 't', objective: `o${index}`, prompt: `Question ${index}?`, answer: `Answer ${index}`, explanation: 'because' });
  await service.call('deck.import', { text: JSON.stringify({ title: 'Deck A', cards: [card(1), card(2)] }) });
  await service.dispose();
  await writeFile(join(dir, 'a-file'), 'x');
  const broken = windows ? join(missingDrive(), 'StudyHub') : join(dir, 'a-file', 'StudyHub');
  const { host: zcode } = await host(t, { dir, env: { STUDYHUB_LIBRARY: broken } });
  const binding = value(await panel(zcode, 'binding.get', { uiLanguage: 'en' }));
  assert.equal(binding.root, fallback);
  assert.equal(binding.libraryProblem.root, broken);
  assert.match(binding.libraryProblem.message, new RegExp(`could not be opened .*"${fallback.replaceAll('\\', '\\\\')}" is used for now`));
  assert.equal(zcode.libraryStatus().root, fallback);
  assert.equal(value(await panel(zcode, 'snapshot')).decks.length, 1, 'the panel reads the library in use');
  // The hook resolves the library the same way (Documents comes from the real system there, so it is pointed at the same folder).
  const { stdout } = await run(process.execPath, [hookScript], { env: { ...process.env, DSH_HOME: join(dir, 'home'), STUDYHUB_LIBRARY: broken,
    STUDYHUB_TEST_DOCUMENTS: join(dir, 'Documents') }, windowsHide: true });
  assert.match(stdout, /学习库：1 个题组，2 题/);
});

test('the model endpoint is saved in the home config, the key never comes back in full, and it never goes to another provider', async (t) => {
  const { host: zcode, env } = await host(t);
  const saved = value(await panel(zcode, 'model.config.set', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', model: 'glm-4-flash', label: '智谱 GLM', apiKey: 'sk-secret-abcd' }));
  assert.deepEqual(saved, { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', label: '智谱 GLM', ready: true,
    key: { set: true, hint: '••••abcd', source: 'file' }, keyDropped: false });
  assert.ok(!JSON.stringify(value(await panel(zcode, 'model.config.get'))).includes('sk-secret'), 'the key is masked');
  const file = JSON.parse(await readFile(join(env.DSH_HOME, 'study', 'zcode.json'), 'utf8'));
  assert.equal(file.model.apiKey, 'sk-secret-abcd');
  const snapshot = value(await panel(zcode, 'snapshot'));
  assert.deepEqual([snapshot.model.ready, snapshot.model.reason], [true, 'ok']);
  assert.match(snapshot.model.label, /智谱 GLM · glm-4-flash/);
  // Another path on the same origin keeps the key; another origin drops it (it must be pasted again for that provider).
  assert.equal(value(await panel(zcode, 'model.config.set', { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' })).key.set, true);
  const moved = value(await panel(zcode, 'model.config.set', { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }));
  assert.deepEqual([moved.key.set, moved.keyDropped, moved.ready], [false, true, false]);
  assert.equal(JSON.parse(await readFile(join(env.DSH_HOME, 'study', 'zcode.json'), 'utf8')).model.apiKey, undefined);
  assert.equal(value(await panel(zcode, 'model.config.set', { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-new-key-9999' })).key.set, true,
    'a key that comes with the new address is kept');
  for (const bad of ['sk-with space', 'sk-中文', 'x'.repeat(513)]) {
    const refused = await panel(zcode, 'model.config.set', { apiKey: bad, uiLanguage: 'en' });
    assert.equal(refused.ok, false, bad.slice(0, 20));
    assert.match(refused.error, /letters, digits and symbols without spaces/);
  }
  assert.match((await panel(zcode, 'model.config.set', { baseUrl: 'ftp://example.com', uiLanguage: 'en' })).error, /start it with https/);
  assert.equal(value(await panel(zcode, 'model.config.set', { apiKey: '' })).key.set, false, 'an empty key clears it');
});

test('STUDYHUB_API_KEY wins over a saved key and is reported as the environment\'s', async (t) => {
  const { host: zcode } = await host(t, { env: { STUDYHUB_API_KEY: 'sk-from-env-9876' } });
  value(await panel(zcode, 'model.config.set', { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-file-1111' }));
  assert.deepEqual(value(await panel(zcode, 'model.config.get')).key, { set: true, hint: '••••9876', source: 'env' });
});

test('测试 sends one small request and reports the answer honestly, with the key taken out of anything it repeats', async (t) => {
  const key = 'sk-test-ABCDEFGHIJKLMNOP-0000';
  const calls = [];
  const answers = [
    () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 }),
    () => new Response(`{"error":{"message":"invalid api key ${key}"}}`, { status: 401 }),
    () => { throw Object.assign(new TypeError(`fetch failed: header authorization: Bearer ${key}`), {}); },
  ];
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization }); return answers[calls.length - 1](); };
  const { host: zcode } = await host(t, { fetch });
  assert.equal(value(await panel(zcode, 'model.config.test', { uiLanguage: 'en' })).message, zcodeText('model-incomplete', 'en'));
  value(await panel(zcode, 'model.config.set', { baseUrl: 'https://api.example.test/v1', model: 'm-1', apiKey: key }));
  assert.equal(value(await panel(zcode, 'model.config.test', {})).ok, true);
  assert.deepEqual([calls[0].url, calls[0].auth, calls[0].body.model], ['https://api.example.test/v1/chat/completions', `Bearer ${key}`, 'm-1']);
  const rejected = value(await panel(zcode, 'model.config.test', { uiLanguage: 'en' }));
  assert.match(rejected.message, /HTTP 401 \(the key is wrong or has no access\): .*invalid api key ••••/);
  const offline = value(await panel(zcode, 'model.config.test', { uiLanguage: 'en' }));
  assert.match(offline.message, /Cannot reach the model service: .*Bearer ••••/);
  for (const message of [rejected.message, offline.message]) assert.ok(!message.includes('ABCDEFGHIJKL'), message);
});

test('the OpenAI-compatible call: deadline, honest errors in both languages, the billed tokens, no key in any error', async () => {
  assert.equal(openaiComplete({ baseUrl: 'https://x', id: 'm' }), undefined, 'no key, no model');
  assert.equal(chatUrl('https://x/v1/'), 'https://x/v1/chat/completions');
  assert.equal(chatUrl('https://x/v1/chat/completions'), 'https://x/v1/chat/completions');
  assert.equal(redactKey('a sk-0123456789abcdef-xyz b sk-0123456789ab… Bearer abc', 'sk-0123456789abcdef-xyz'), 'a •••• b ••••9ab… Bearer ••••');
  const model = { baseUrl: 'https://x/v1', id: 'm', apiKey: 'k-0123456789abcdefgh' };
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
  const html = openaiComplete(model, { fetch: async () => new Response('<html>portal k-0123456789abcdefgh</html>', { status: 200 }) });
  await assert.rejects(html('s', 'p'), /^Error: 模型服务的回复不是 JSON：<html>portal ••••<\/html>$/);
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

test('update.check points the guided upgrade at the ZCode package of the same release; update.install refuses', async (t) => {
  const { zcodeUpdateView, zcodeAsset } = await import('../packages/studyhub-zcode/host/study-host.mjs');
  const view = zcodeUpdateView({ current: '3.7.2', latest: '3.8.0', newer: true, upgradeAvailable: true, assetName: 'ericwang1358-dsh-daily-flashcard-3.8.0.tgz', assetUrl: 'x' });
  assert.equal(view.assetName, 'StudyHub-ZCode-3.8.0.zip');
  assert.equal(view.assetUrl, 'https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v3.8.0/StudyHub-ZCode-3.8.0.zip');
  assert.equal(view.sha256Url, 'https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v3.8.0/SHA256SUMS-ZCode-3.8.0.txt');
  assert.deepEqual(view.install, { available: false, desktop: false, host: 'zcode' }, 'no one-click install in ZCode');
  assert.deepEqual(zcodeAsset(null), { assetName: null, assetUrl: null, sha256Url: null });
  const { host: zcode } = await host(t);
  assert.deepEqual(value(await panel(zcode, 'update.install', { version: '9.9.9' })), { status: 'failed', code: 'UPDATE_NO_INSTALLER' });
});

test('app.open opens only a plain http(s) address, as the URL parser writes it, by the opener\'s full path and never through a shell', () => {
  for (const url of ['https://github.com/EricWang1358/dsh-web-studyhub/blob/zcode/docs/zcode.zh-CN.md', 'https://a.example/x?y=1&z=2', 'https://a.example/#%E9%85%8D%E7%BD%AE'])
    assert.equal(openableUrl(url), url, url);
  assert.equal(openableUrl('HTTPS://A.Example:443/x/../y'), 'https://a.example/y', 'the parser\'s spelling, not the raw string');
  for (const url of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'https://a.example/"&calc.exe', 'https://a.example/ x', 'https://u:p@a.example/',
    'https://a.example/|x', 'https://a.example/^x', 'https://a.example\\..\\x', `https://a.example/${'x'.repeat(2000)}`, '', null, 'ms-settings:privacy',
    'https://a.example/\nx', 'https://a.example/\u202Egnp.exe', 'https://a.example/\u200Bx', 'https://a.example/\u0000x'])
    assert.equal(openableUrl(url), null, JSON.stringify(url).slice(0, 40));
  const spawned = [];
  const spawn = (command, args, options) => { spawned.push({ command, args, shell: options.shell }); return { on() {}, unref() {} }; };
  openExternal('https://a.example/x?y=1&z=2', { platform: 'win32', spawn });
  openExternal('https://a.example/', { platform: 'darwin', spawn });
  assert.match(spawned[0].command, /[\\/]System32[\\/]rundll32\.exe$/i);
  assert.deepEqual(spawned.map(({ args, shell }) => ({ args, shell })), [{ args: ['url.dll,FileProtocolHandler', 'https://a.example/x?y=1&z=2'], shell: undefined },
    { args: ['https://a.example/'], shell: undefined }]);
  assert.equal(opener('darwin')[0], '/usr/bin/open');
  assert.equal(opener('linux')[0], '/usr/bin/xdg-open');
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
  // Another chat's server (another live process) or a later start: unknown while that process lives, lost once it is gone.
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

test('every message of the host has both languages, reasons included', () => {
  for (const code of ZCODE_MESSAGE_CODES) {
    assert.match(zcodeText(code, 'zh', ['X', 'missing', 'Y']), /[\u4e00-\u9fff]/, code);
    assert.doesNotMatch(zcodeText(code, 'en', ['X', 'missing', 'Y']), /[\u4e00-\u9fff]/, code);
  }
  assert.equal(zcodeText('library-unusable', 'en', ['error:EBUSY']), 'This location cannot be used as a library: the system reported EBUSY');
});

test('readConfig is the one place the hook and the server learn the library from', async (t) => {
  const dir = await scratch(t), home = join(dir, 'home');
  await saveLibraryRoot(home, join(dir, 'Chosen'));
  assert.equal(readConfig({ env: {}, home, documents: join(dir, 'Docs') }).libraryRoot, join(dir, 'Chosen'));
});

test('dispose is idempotent', async (t) => {
  const { host: zcode } = await host(t);
  const first = zcode.dispose(), second = zcode.dispose();
  assert.equal(first, second);
  await first;
});
