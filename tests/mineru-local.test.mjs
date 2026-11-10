import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEventListeners } from 'node:events';
import { LOCAL, LocalMineruError, detectLocal, homeNote, homePermissionFailure, locateMineru, markServerLogs, parseLocalMarkdown, parseWindow, readMineruServerLogs, secureMineruHome, serverErrorsSince,
  startServer, windowPlan, explainStartFailure } from '../lib/mineru-local.js';
import { mergeChunkResults } from '../lib/mineru-merge.js';
import { parseConvertedDocument } from '../lib/converted-document.js';
import { patientCli, readJsonFile, until, writeJsonFile } from './helpers/wait.mjs';

/* The local `mineru` command line (free, nothing uploaded): detection, one honest state, page-window parsing. Everything here runs
   against tests/helpers/fake-mineru-cli.mjs; no real mineru is ever started, installed or configured. */

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));
const han = /[㐀-鿿]/;
/** Whether a process has ended, waiting for the (asynchronous) kill to land. */
const gone = pid => until(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }, `process ${pid} to end`, { intervalMs: 50 }).catch(() => false);

/** Every command line the fake has been run with. `patient: false` keeps the library's own time limits as they are (for a test of a limit). */
async function fakeCli(t, state = {}, { patient = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'study-fake-mineru-'));
  const statePath = join(dir, 'state.json'), logPath = join(dir, 'log.jsonl');
  const base = { version: '4.0.10', mode: 'disabled', tier: 'basic', running: false, total: 120, modelsReady: false };
  await writeFile(statePath, JSON.stringify({ ...base, ...state })); await writeFile(logPath, '');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = { file: process.execPath, prefix: [FAKE], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } };
  return { dir, cli: patient ? patientCli(cli) : cli, state: () => readJsonFile(statePath), set: async patch => writeJsonFile(statePath, { ...await readJsonFile(statePath), ...patch }),
    log: async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) };
}

/* ---------- finding it ---------- */

test('mineru is looked for on PATH and in ~/.local/bin (where uv puts tools), with .exe on Windows', () => {
  const present = new Set(['C:\\Users\\a\\.local\\bin\\mineru.exe']);
  const found = locateMineru({ env: { PATH: 'C:\\Windows;C:\\tools', USERPROFILE: 'C:\\Users\\a' }, platform: 'win32', homedir: 'C:\\Users\\a', exists: path => present.has(path) });
  assert.equal(found.file, 'C:\\Users\\a\\.local\\bin\\mineru.exe');
  const onPath = locateMineru({ env: { PATH: '/usr/bin:/opt/bin' }, platform: 'linux', homedir: '/home/a', exists: path => path === '/opt/bin/mineru' });
  assert.equal(onPath.file, '/opt/bin/mineru');
  assert.equal(locateMineru({ env: { PATH: '/usr/bin' }, platform: 'linux', homedir: '/home/a', exists: () => false }), null);
});

/* ---------- one honest state ---------- */

test('not installed: nothing is run, and the next step is to install it', async () => {
  const detected = await detectLocal({ cli: null });
  assert.equal(detected.state, 'not-installed');
  assert.equal(detected.next, 'install');
});

test('installed, service running, never set up: models are needed, and the next step is to download them', async t => {
  const fake = await fakeCli(t, { mode: 'disabled', tier: 'flash', running: true });
  const detected = await detectLocal({ cli: fake.cli, home: join(fake.dir, 'nohome') });
  assert.equal(detected.state, 'needs-models');
  assert.equal(detected.next, 'download-models');
  assert.equal(detected.version, '4.0.10');
  assert.equal(detected.modelsDownloaded, false);
});

test('only read-only commands are run to find out: --version and server status first (together, either order), then config get', async t => {
  const fake = await fakeCli(t, { mode: 'managed', tier: 'basic', running: true });
  await detectLocal({ cli: fake.cli, home: fake.dir });
  const calls = (await fake.log()).map(entry => entry.argv.slice(0, 3).join(' '));
  // The two probes run at the same time (#683), so which one the fake CLI logs first is up to the scheduler; both come before any settings read.
  assert.deepEqual(calls.slice(0, 2).sort(), ['--version', 'server status'], 'whether the service runs is asked before its settings are');
  assert.deepEqual([...calls].sort(), ['--version', 'config get parse_server.local.managed_tier', 'config get parse_server.local.mode', 'server status'].sort());
  assert.deepEqual((await fake.state()).running, true, 'nothing was started or changed');
});

/* The real CLI answers `config get` only through its running service: with the service stopped it exits non-zero with just
   "错误: 本地 mineru 服务未运行。…" and `server status` says "服务未在运行。". A failed read is UNKNOWN, never "not set up". */

test('service stopped, set up before (managed, models on disk): server-stopped, not "models missing"', async t => {
  const fake = await fakeCli(t, { mode: 'managed', tier: 'standard', running: false });
  const home = join(fake.dir, 'home'), elsewhere = join(fake.dir, 'F-drive-models');
  await mkdir(join(elsewhere, 'standard'), { recursive: true }); await writeFile(join(elsewhere, 'standard', 'model.onnx'), 'x');
  await mkdir(home, { recursive: true }); await symlink(elsewhere, join(home, 'models'), 'junction');
  const detected = await detectLocal({ cli: fake.cli, home });
  assert.deepEqual([detected.state, detected.next, detected.running, detected.version], ['server-stopped', 'start-server', false, '4.0.10']);
  assert.notEqual(detected.modelsDownloaded, false, 'the models are not claimed missing: the settings could not be read');
  const calls = (await fake.log()).map(entry => entry.argv.slice(0, 2).join(' '));
  assert.ok(!calls.some(call => call.startsWith('config') || call === 'server start'), `nothing is read from or changed in a stopped service: ${calls}`);
  assert.equal((await fake.state()).running, false, 'detection did not start it');
});

test('the models folder is recognised by the names the real tool gives its model folders, not by the tier word', async t => {
  const fake = await fakeCli(t, { mode: 'disabled', tier: 'standard', running: true });
  const home = join(fake.dir, 'home');
  await mkdir(join(home, 'models', 'MinerU2.5-Pro-2605-1.2B-GGUF'), { recursive: true });
  await writeFile(join(home, 'models', 'MinerU2.5-Pro-2605-1.2B-GGUF', '.mineru_complete'), '');
  const standard = await detectLocal({ cli: fake.cli, home });
  assert.deepEqual([standard.state, standard.next, standard.modelsDownloaded], ['needs-models', 'enable', true], 'the standard models are there: only enabling is left');
  await fake.set({ tier: 'basic' });
  const basic = await detectLocal({ cli: fake.cli, home });
  assert.deepEqual([basic.next, basic.modelsDownloaded], ['download-models', false], 'the standard models do not stand in for the basic ones');
  await mkdir(join(home, 'models', 'MinerU-4_models_onnx'), { recursive: true });
  assert.equal((await detectLocal({ cli: fake.cli, home })).next, 'enable');
});

test('service stopped, never configured and no models: also server-stopped; after the start it says needs-models / download', async t => {
  const fake = await fakeCli(t, { mode: 'disabled', tier: 'flash', running: false });
  const before = await detectLocal({ cli: fake.cli, home: join(fake.dir, 'nohome') });
  assert.deepEqual([before.state, before.next], ['server-stopped', 'start-server']);
  const after = await startServer({ cli: fake.cli, home: join(fake.dir, 'nohome') });
  assert.deepEqual([after.state, after.next, after.running], ['needs-models', 'download-models', true]);
});

test('service stopped, never configured, models already on disk: after the start the next step is only to enable', async t => {
  const fake = await fakeCli(t, { mode: 'disabled', tier: 'basic', running: false });
  const home = join(fake.dir, 'home');
  await mkdir(join(home, 'models', 'basic'), { recursive: true }); await writeFile(join(home, 'models', 'basic', 'model.onnx'), 'x');
  assert.equal((await detectLocal({ cli: fake.cli, home })).state, 'server-stopped');
  const after = await startServer({ cli: fake.cli, home });
  assert.deepEqual([after.state, after.next, after.modelsDownloaded], ['needs-models', 'enable', true]);
});

test('running and configured as managed: ready; running but switched off: needs-models', async t => {
  const on = await fakeCli(t, { mode: 'managed', tier: 'standard', running: true });
  assert.deepEqual(await detectLocal({ cli: on.cli, home: on.dir }).then(d => [d.state, d.next, d.running, d.tier, d.mode]), ['ready', null, true, 'standard', 'managed']);
  const off = await fakeCli(t, { mode: 'disabled', tier: 'basic', running: true });
  assert.deepEqual(await detectLocal({ cli: off.cli, home: off.dir }).then(d => [d.state, d.next, d.running]), ['needs-models', 'download-models', true]);
});

test('the stopped service is recognised however the CLI says it: on stdout or stderr, exit code 0 or 1', async t => {
  for (const patch of [{}, { statusExitsZero: true }, { errorOnStdout: true }, { statusExitsZero: true, errorOnStdout: true }]) {
    const fake = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false, ...patch });
    const detected = await detectLocal({ cli: fake.cli, home: fake.dir });
    assert.deepEqual([detected.state, detected.next], ['server-stopped', 'start-server'], JSON.stringify(patch));
  }
});

test('if the status call looks fine but the settings call reports the service is not running, it is still server-stopped', async t => {
  const fake = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false, statusStuck: true });
  assert.equal((await detectLocal({ cli: fake.cli, home: fake.dir })).state, 'server-stopped');
});

test('an unreadable config of a running service is UNKNOWN: never "needs models", never ready', async t => {
  const fake = await fakeCli(t, { mode: 'managed', tier: 'basic', running: true, configFails: true });
  const detected = await detectLocal({ cli: fake.cli, home: fake.dir });
  assert.equal(detected.state, 'unknown');
  assert.equal(detected.next, 'recheck');
  assert.notEqual(detected.state, 'needs-models');
});

test('models on disk but the local mode is off: the next step is only to switch it on (the models folder may be a junction)', async t => {
  const fake = await fakeCli(t, { mode: 'disabled', tier: 'basic', running: true });
  const home = join(fake.dir, 'home'), elsewhere = join(fake.dir, 'D-drive-models');
  await mkdir(join(elsewhere, 'basic'), { recursive: true });
  await writeFile(join(elsewhere, 'basic', 'model.onnx'), 'x');
  await mkdir(home, { recursive: true });
  await symlink(elsewhere, join(home, 'models'), 'junction');
  const detected = await detectLocal({ cli: fake.cli, home });
  assert.equal(detected.state, 'needs-models');
  assert.equal(detected.modelsDownloaded, true, 'the junction is followed');
  assert.equal(detected.next, 'enable');
});

test('set up, but the service is stopped: the next step is to start it', async t => {
  const fake = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false });
  const detected = await detectLocal({ cli: fake.cli, home: fake.dir });
  assert.equal(detected.state, 'server-stopped');
  assert.equal(detected.next, 'start-server');
  assert.equal(detected.tier, '', 'the tier lives in the stopped service, so it is not known yet');
});

test('set up and running: ready, with the tier and the version', async t => {
  const fake = await fakeCli(t, { mode: 'managed', tier: 'standard', running: true });
  const detected = await detectLocal({ cli: fake.cli, home: fake.dir });
  assert.deepEqual([detected.state, detected.tier, detected.version, detected.next], ['ready', 'standard', '4.0.10', null]);
});

test('the base package\'s text-only preview tier is not a usable setup', async t => {
  const fake = await fakeCli(t, { mode: 'managed', tier: 'flash', running: true });
  assert.equal((await detectLocal({ cli: fake.cli, home: fake.dir })).state, 'needs-models');
});

test('starting the service is its own explicit step, and the state is read again afterwards', async t => {
  const fake = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false });
  const after = await startServer({ cli: fake.cli, home: fake.dir });
  assert.equal(after.state, 'ready');
  assert.ok((await fake.log()).some(entry => entry.argv[0] === 'server' && entry.argv[1] === 'start'));
  const broken = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false, startFails: true });
  await assert.rejects(startServer({ cli: broken.cli, home: broken.dir }), error => error instanceof LocalMineruError && error.code === 'server-start-failed' && /端口/.test(error.message));
});

/* ---------- reading the Markdown ---------- */

const marker = (page, total = 120) => `<!-- page ${page} of ${total} -->`;

test('windows of consecutive pages: 50 at a time, the last one shorter', () => {
  assert.equal(LOCAL.windowPages, 50);
  assert.deepEqual(windowPlan(422, 50).map(item => [item.startPage, item.endPage]), [[1, 50], [51, 100], [101, 150], [151, 200], [201, 250], [251, 300], [301, 350], [351, 400], [401, 422]]);
  assert.deepEqual(windowPlan(7, 50).map(item => [item.startPage, item.endPage]), [[1, 7]]);
});

test('page markers become pages of the book: numbers, headings, lists, blank pages, Chinese text, and CRLF all work', () => {
  const markdown = [marker(11), '## 第一章 绪论', '本章介绍数据库。', '![Image block](doc:1/tier:basic/page:11/block:1)', '• 要点一', '• 要点二',
    marker(12), marker(13), '普通段落。', '', '| a | b |', '| - | - |', '| 1 | 2 |', ''].join('\r\n');
  const parsed = parseLocalMarkdown(markdown, { startPage: 11, endPage: 13, totalPages: 120 });
  assert.equal(parsed.markers, 3);
  const items = parsed.content;
  assert.ok(items.every(item => item.page_idx >= 0 && item.page_idx <= 2), 'pages are counted from 0 inside the window, like the cloud pieces');
  assert.deepEqual(items.find(item => item.text_level === 1), { type: 'text', text: '第一章 绪论', text_level: 1, page_idx: 0 });
  assert.ok(items.some(item => item.type === 'list' && item.page_idx === 0 && item.list_items.join('|') === '要点一|要点二'));
  assert.ok(!items.some(item => item.page_idx === 1), 'the blank page has no content, but still counts');
  assert.ok(items.some(item => item.page_idx === 2 && /\| a \| b \|/.test(item.text)), 'tables stay as Markdown');
  assert.ok(items.every(item => !JSON.stringify(item).includes('doc:1/tier')), 'no broken image link');
  assert.ok(items.some(item => item.page_idx === 0 && /\[Figure\]/.test(item.text)), 'a figure-here marker stays where the picture was');
});

test('local windows merge into the book exactly like cloud pieces, and the importer reads the result', () => {
  const first = parseLocalMarkdown([marker(1, 4), 'one', marker(2, 4), 'two'].join('\n'), { startPage: 1, endPage: 2, totalPages: 4 });
  const second = parseLocalMarkdown([marker(3, 4), 'three', marker(4, 4), 'four'].join('\n'), { startPage: 3, endPage: 4, totalPages: 4 });
  const merged = mergeChunkResults({ totalPages: 4, chunks: [{ index: 0, startPage: 1, endPage: 2, format: 'v1', content: first.content }, { index: 1, startPage: 3, endPage: 4, format: 'v1', content: second.content }] });
  const book = parseConvertedDocument(JSON.stringify(merged.content));
  assert.deepEqual(book.pages.map(page => [page.page, page.text]), [[1, 'one'], [2, 'two'], [3, 'three'], [4, 'four']]);
  assert.equal(book.converter, 'mineru');
});

test('the number of markers must equal the window size, in range, and TOTAL must be the PDF\'s page count', () => {
  assert.throws(() => parseLocalMarkdown([marker(1), 'a', marker(2), 'b'].join('\n'), { startPage: 1, endPage: 3, totalPages: 120 }),
    error => error instanceof LocalMineruError && error.code === 'marker-count' && /3/.test(error.message) && /2/.test(error.message));
  assert.throws(() => parseLocalMarkdown([marker(1), 'a', marker(2), 'b'].join('\n'), { startPage: 11, endPage: 12, totalPages: 120 }), error => error.code === 'marker-range');
  assert.throws(() => parseLocalMarkdown([marker(1, 99), 'a'].join('\n'), { startPage: 1, endPage: 1, totalPages: 120 }), error => error.code === 'total-mismatch' && /99/.test(error.message) && /120/.test(error.message));
  assert.throws(() => parseLocalMarkdown('no markers at all', { startPage: 1, endPage: 1, totalPages: 1 }), error => error.code === 'marker-count');
});

test('page headers and footers MinerU leaves in the text are kept, not silently dropped', () => {
  const parsed = parseLocalMarkdown([marker(1, 2), 'Chapter 1: Introduction', 'body', '1', marker(2, 2), 'Chapter 1: Introduction', 'more', '2'].join('\n'), { startPage: 1, endPage: 2, totalPages: 2 });
  assert.ok(parsed.content.some(item => /Chapter 1: Introduction/.test(item.text || '')));
  assert.equal(parsed.warnings.length, 0, 'the job adds one note for the whole book, not one per window');
});

/* ---------- running a window ---------- */

test('a window is parsed with --pages always given (the CLI\'s default is only the first 10 pages), the tier, a bounded wait, and locally', async t => {
  const fake = await fakeCli(t, { mode: 'managed', running: true, total: 120 });
  const out = join(fake.dir, 'out.md');
  const result = await parseWindow({ cli: fake.cli, pdf: join(fake.dir, 'book.pdf'), tier: 'standard', startPage: 11, endPage: 20, totalPages: 120, outFile: out });
  assert.equal(result.markers, 10);
  const call = (await fake.log()).find(entry => entry.argv[0] === 'parse');
  assert.equal(call.argv[call.argv.indexOf('--pages') + 1], '11-20');
  assert.equal(call.argv[call.argv.indexOf('--tier') + 1], 'standard');
  assert.ok(Number(call.argv[call.argv.indexOf('--wait') + 1]) >= LOCAL.waitFloorSec);
  assert.ok(call.argv.includes('--force') && call.argv.includes('--json') && call.argv.includes('-o'));
  assert.ok(!call.argv.includes('--remote'), 'the local route never goes to the cloud');
  const book = parseConvertedDocument(JSON.stringify(result.content.map(item => ({ ...item, page_idx: item.page_idx + 10 }))));
  assert.deepEqual(book.pages.map(page => page.page).slice(0, 3), [11, 12, 13]);
  assert.match(book.pages[0].text, /第 11 页的正文/);
});

test('a CLI that ignored --pages (pages 1-10 for window 11-20) is caught, not silently merged into the wrong pages', async t => {
  const fake = await fakeCli(t, { mode: 'managed', running: true, total: 120, ignorePages: true });
  await assert.rejects(parseWindow({ cli: fake.cli, pdf: 'book.pdf', tier: 'basic', startPage: 11, endPage: 20, totalPages: 120, outFile: join(fake.dir, 'o.md') }),
    error => error.code === 'marker-range');
});

test('a stopped service becomes a plain message with the way out, not a stack trace', async t => {
  const fake = await fakeCli(t, { mode: 'managed', running: false });
  await assert.rejects(parseWindow({ cli: fake.cli, pdf: 'book.pdf', tier: 'basic', startPage: 1, endPage: 5, totalPages: 120, outFile: join(fake.dir, 'o.md') }),
    error => error instanceof LocalMineruError && error.code === 'server-stopped' && error.retryable === true && /本机 MinerU 服务/.test(error.message) && /接着做/.test(error.message));
});

test('the service dying in the middle of a window is told apart from an ordinary failure', async t => {
  const fake = await fakeCli(t, { mode: 'managed', running: true, dieOnFirst: 1 });
  await assert.rejects(parseWindow({ cli: fake.cli, pdf: 'book.pdf', tier: 'basic', startPage: 1, endPage: 5, totalPages: 120, outFile: join(fake.dir, 'o.md') }), error => error.code === 'server-stopped');
});

test('an ordinary parse failure is retryable and carries the CLI\'s own words, clipped', async t => {
  const fake = await fakeCli(t, { mode: 'managed', running: true, failWindowsOnce: [1] });
  await assert.rejects(parseWindow({ cli: fake.cli, pdf: 'book.pdf', tier: 'basic', startPage: 1, endPage: 5, totalPages: 120, outFile: join(fake.dir, 'o.md') }),
    error => error.code === 'failed' && error.retryable === true && /model crashed/.test(error.message));
  const retried = await parseWindow({ cli: fake.cli, pdf: 'book.pdf', tier: 'basic', startPage: 1, endPage: 5, totalPages: 120, outFile: join(fake.dir, 'o.md') });
  assert.equal(retried.markers, 5);
});

test('cancel kills the running process promptly', async t => {
  const fake = await fakeCli(t, { mode: 'managed', running: true, delayMs: 60_000 });
  const controller = new AbortController();
  const parsing = parseWindow({ cli: fake.cli, pdf: 'book.pdf', tier: 'basic', startPage: 1, endPage: 5, totalPages: 120, outFile: join(fake.dir, 'o.md'), signal: controller.signal });
  await until(async () => (await fake.log()).some(entry => entry.argv[0] === 'parse'), 'the parse process to start', { intervalMs: 20 });
  const cancelled = Date.now();
  controller.abort(new Error('cancelled by learner'));
  await assert.rejects(parsing, /cancelled by learner/);
  assert.ok(Date.now() - cancelled < 45_000, 'stopped promptly, not after the 60 s the window would have taken');
  const pid = (await fake.log()).find(entry => entry.argv[0] === 'parse').pid;
  assert.equal(await gone(pid), true, 'the child is gone');
});

test('a window that takes longer than its bounded wait is stopped and reported as a timeout', async t => {
  const fake = await fakeCli(t, { mode: 'managed', running: true, delayMs: 60_000 }, { patient: false }); // the limit under test is the real one, so it is not stretched
  // The limit runs from the moment the process is spawned, and starting a Node process takes seconds on a machine busy with other work: the test only
  // means something once the fake has started (and logged itself) inside the limit, so it asks again with a longer one until it has.
  let pid;
  for (let timeoutMs = 2000; !pid; timeoutMs *= 2) {
    await assert.rejects(parseWindow({ cli: fake.cli, pdf: 'book.pdf', tier: 'basic', startPage: 1, endPage: 5, totalPages: 120, outFile: join(fake.dir, 'o.md'), timeoutMs }),
      error => error.code === 'timeout' && error.retryable === true && /太久/.test(error.message));
    pid = (await fake.log()).find(entry => entry.argv[0] === 'parse')?.pid;
    assert.ok(timeoutMs < 60_000, 'the fake CLI never started');
  }
  assert.equal(await gone(pid), true);
});

test('every message of the local route has an English form', async () => {
  const { localizeAppMessage } = await import('../lib/application-messages.js');
  const { LOCAL_MESSAGES, SERVICE_START_TEXT } = await import('../lib/mineru-local.js');
  const samples = [...Object.values(LOCAL_MESSAGES), ...Object.values(SERVICE_START_TEXT),
    ...[() => parseLocalMarkdown(marker(1), { startPage: 1, endPage: 3, totalPages: 9 }), () => parseLocalMarkdown(marker(1), { startPage: 5, endPage: 5, totalPages: 9 }), () => parseLocalMarkdown(marker(1, 7), { startPage: 1, endPage: 1, totalPages: 9 }), () => parseLocalMarkdown(`${marker(1)}
${marker(1)}`, { startPage: 1, endPage: 2, totalPages: 120 })]
      .map(run => { try { run(); return ''; } catch (error) { return error.message; } })];
  assert.ok(samples.filter(Boolean).length >= 9);
  for (const text of samples.filter(Boolean)) assert.doesNotMatch(localizeAppMessage(text, 'en'), han, text);
});

test('a service that prints "still starting (PID ...)" is server-stopped with starting: true, and startServer waits out a brief cold boot', async t => {
  const warming = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false, stillStartingOnce: 'Server is still starting (PID 12345).' });
  const detected = await detectLocal({ cli: warming.cli, home: warming.dir });
  assert.deepEqual([detected.state, detected.next, detected.running, detected.starting], ['server-stopped', 'start-server', false, true]);
  const cold = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false, startStillStarting: '服务仍在启动中(PID 12345)。', stillStartingOnce: true });
  const controller = new AbortController();
  const after = await startServer({ cli: cold.cli, home: cold.dir, pollPauseMs: 20, signal: controller.signal });
  assert.deepEqual([after.state, after.running], ['ready', true]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'a pause that ended leaves no listener on the signal');
});

test('startServer attaches <home>/logs/doclib.stderr.log on daemon crash and classifies private credential ACL errors as home-permissions (the settings folder, not the location: #936)', async t => {
  const acl = "PermissionError: Credential configuration directory 'D:\\\\StudyHub\\\\MinerU\\\\home' has insecure permissions (cannot enforce private credential)";
  const fake = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false, startSilentFail: true, serverLogError: acl });
  const home = join(fake.dir, 'home');
  await assert.rejects(startServer({ cli: fake.cli, home }), error =>
    error instanceof LocalMineruError
    && error.code === 'server-start-failed'
    && error.reason === 'home-permissions'
    && /配置文件夹/.test(error.message) && /不用换位置/.test(error.message)
    && /\[doclib\.stderr\.log\]/.test(error.detail)
    && /Credential configuration directory/.test(error.detail));
});

/** A folder as StudyHub's install leaves it: its sentinel, so secureMineruHome may change the permissions of the `home` inside it (#942 L2). */
const ourFolder = async dir => { await writeFile(join(dir, LOCAL.studyhubSentinel), JSON.stringify({ createdBy: 'studyhub', version: 1 })); return join(dir, 'home'); };

test('secureMineruHome says when the permission change failed instead of swallowing it (a stand-in Python, a temp folder: no real permission is changed)', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-secure-home-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await ourFolder(dir);
  const refusing = join(dir, 'refusing-python.mjs');
  await writeFile(refusing, 'process.stderr.write("PermissionError: [WinError 5] Access is denied\\n"); process.exit(1);\n');
  const failed = await secureMineruHome(join(dir, 'home'), { platform: 'win32', pythonCli: { file: process.execPath, prefix: [refusing], env: {} } });
  assert.deepEqual(failed, { ok: false, error: 'PermissionError: [WinError 5] Access is denied' });
  const agreeing = join(dir, 'agreeing-python.mjs');
  await writeFile(agreeing, 'process.exit(0);\n');
  assert.deepEqual(await secureMineruHome(join(dir, 'home'), { platform: 'win32', pythonCli: { file: process.execPath, prefix: [agreeing], env: {} } }), { ok: true });
});

/* ---------- #936: the settings folder's permissions on Windows ---------- */

/** A real Python of this computer (the way the install's 更多 › Python finds one), or null. */
const realPython = () => (process.platform === 'win32' ? import('../lib/mineru-install.js').then(module => module.systemPythons()).then(list => list[0] || null, () => null) : Promise.resolve(null));
/** The DACL of a file or folder, read back with `icacls /save` (SDDL, so no localized account names): { protectedDacl, aces: [{ flags, rights, sid }] }. */
async function aclOf(target, scratch) {
  const { execFileSync } = await import('node:child_process');
  const saved = join(scratch, `acl-${Math.random().toString(36).slice(2)}.txt`);
  execFileSync('icacls', [target, '/save', saved], { stdio: 'ignore' });
  const sddl = (await readFile(saved, 'utf16le')).replace(/^﻿/, '').split(/\r?\n/)[1] || '';
  await rm(saved, { force: true });
  const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl) || ['', '', ''];
  return { protectedDacl: dacl[1].includes('P'), aces: [...dacl[2].matchAll(/\(([^)]*)\)/g)].map(match => { const [, flags, rights, , , sid] = match[1].split(';'); return { flags, rights, sid }; }) };
}

test('secureMineruHome makes the settings folder private AND heals what is already inside it: an empty access list (D:PAI, the learner\'s case) and old inherited entries go back to the three the folder gives (a real Python and icacls, a temp folder)', { skip: process.platform !== 'win32' }, async t => {
  const python = await realPython();
  if (!python) { t.skip('no Python 3.11-3.14 on this computer: the permission change needs one'); return; }
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'study-secure-home-real-'));
  // A file whose access list is empty cannot even be deleted by its owner until its permissions are reset: the cleanup resets the whole tree first.
  t.after(async () => { try { execFileSync('icacls', [dir, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore' }); } catch { /* best effort */ } await rm(dir, { recursive: true, force: true }); });
  const home = await ourFolder(dir);
  const files = ['config.yaml', join('logs', 'doclib.stderr.log'), join('logs', 'broken.log'), join('models', 'MinerU-4_models_onnx', 'layout.onnx'), join('models', 'MinerU-4_models_onnx', 'broken.onnx')];
  for (const file of files) { await mkdir(join(home, file, '..'), { recursive: true }); await writeFile(join(home, file), 'x'); }
  // What the learner's machine had: files with no access entry at all, which not even their own account could read.
  for (const file of [join('logs', 'broken.log'), join('models', 'MinerU-4_models_onnx', 'broken.onnx')]) execFileSync('icacls', [join(home, file), '/inheritance:r'], { stdio: 'ignore' });
  assert.deepEqual((await aclOf(join(home, 'logs', 'broken.log'), dir)).aces, [], 'the broken file has an empty access list');
  await assert.rejects(readFile(join(home, 'logs', 'broken.log')), error => error.code === 'EPERM' || error.code === 'EACCES');

  const result = await secureMineruHome(home, { platform: 'win32', pythonCli: { file: python.path, prefix: [], env: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  // `healed` counts what was changed (#942 L4): at least the two broken files; entries that already inherit exactly what the home gives are only read.
  assert.ok(result.healed >= 2 && result.healed <= files.length + 3, `the broken entries were repaired (${result.healed})`);

  const folder = await aclOf(home, dir);
  assert.equal(folder.protectedDacl, true, 'the home itself stays private (never reset)');
  const user = folder.aces.map(ace => ace.sid).find(sid => !['SY', 'BA'].includes(sid));
  const three = ['BA', 'SY', user].sort();
  assert.deepEqual(folder.aces.map(ace => ace.sid).sort(), three);
  for (const entry of [...files, 'logs', 'models', join('models', 'MinerU-4_models_onnx')]) {
    const acl = await aclOf(join(home, entry), dir);
    assert.equal(acl.protectedDacl, false, `${entry}: inherits from the home again`);
    assert.deepEqual(acl.aces.map(ace => ace.sid).sort(), three, `${entry}: exactly the three entries the home gives`);
    assert.ok(acl.aces.every(ace => ace.flags.includes('ID') && ace.rights === 'FA'), `${entry}: inherited, full control (${JSON.stringify(acl.aces)})`);
  }
  for (const file of files) assert.equal(await readFile(join(home, file), 'utf8'), 'x', `${file} is readable again`);
  // Twice is the same as once (it runs before every start of the service and in several install steps), and a healthy home is only read: nothing is changed.
  assert.deepEqual(await secureMineruHome(home, { platform: 'win32', pythonCli: { file: python.path, prefix: [], env: {} } }), { ok: true });
  assert.deepEqual((await aclOf(join(home, 'config.yaml'), dir)).aces.map(ace => ace.sid).sort(), three);
  // An entry with an extra explicit allow, or a deny, is not healthy: it is written again (and only it).
  execFileSync('icacls', [join(home, 'config.yaml'), '/grant', '*S-1-5-11:(R)'], { stdio: 'ignore' });
  execFileSync('icacls', [join(home, 'logs', 'doclib.stderr.log'), '/deny', '*S-1-5-11:(W)'], { stdio: 'ignore' });
  assert.deepEqual(await secureMineruHome(home, { platform: 'win32', pythonCli: { file: python.path, prefix: [], env: {} } }), { ok: true, healed: 2 });
  for (const entry of ['config.yaml', join('logs', 'doclib.stderr.log')]) assert.deepEqual((await aclOf(join(home, entry), dir)).aces.map(ace => ace.sid).sort(), three, entry);
});

test('secureMineruHome repairs at most LOCAL.homeHealMaxEntries entries below the home and says when it stopped there (a real Python, a temp folder)', { skip: process.platform !== 'win32' }, async t => {
  const python = await realPython();
  if (!python) { t.skip('no Python 3.11-3.14 on this computer: the permission change needs one'); return; }
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'study-secure-home-bound-'));
  t.after(async () => { try { execFileSync('icacls', [dir, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore' }); } catch { /* best effort */ } await rm(dir, { recursive: true, force: true }); });
  const home = await ourFolder(dir);
  await mkdir(join(home, 'logs'), { recursive: true });
  // Six files that each need a repair (an empty access list) in a folder made before the home was private (it still carries what the temp folder gave):
  // the walk visits the folder and two of the files, writes all three, then stops.
  for (let i = 0; i < 6; i++) { await writeFile(join(home, 'logs', `${i}.log`), 'x'); execFileSync('icacls', [join(home, 'logs', `${i}.log`), '/inheritance:r'], { stdio: 'ignore' }); }
  const bounded = await secureMineruHome(home, { platform: 'win32', pythonCli: { file: python.path, prefix: [], env: {} }, maxEntries: 3 });
  assert.deepEqual(bounded, { ok: true, healed: 3, partial: true });
  assert.ok(LOCAL.homeHealMaxEntries >= 1000, 'the real bound leaves room for a home with models (about a hundred files)');
});

test('secureMineruHome with no Python to change the permissions with is "not done", not "ok" (Windows)', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-secure-home-none-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await secureMineruHome(await ourFolder(dir), { platform: 'win32', cli: { file: join(dir, 'not-mineru.exe'), prefix: [], env: {} } });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'no-python');
  assert.match(result.error, /no Python/);
});

test('#942 L4: a repair that ran too long, or a Python that cannot be run, says so in its own words (never a sentence about parsing or about MinerU missing)', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-secure-home-words-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const home = await ourFolder(dir);
  const slow = join(dir, 'slow-python.mjs');
  await writeFile(slow, 'setTimeout(() => {}, 20000);\n');
  const late = await secureMineruHome(home, { platform: 'win32', pythonCli: { file: process.execPath, prefix: [slow], env: {} }, timeoutMs: 300 });
  assert.equal(late.ok, false);
  assert.match(homeNote(late, home), /permission repair took longer than/);
  const missing = await secureMineruHome(home, { platform: 'win32', pythonCli: { file: join(dir, 'no-such-python.exe'), prefix: [], env: {} } });
  assert.equal(missing.ok, false);
  assert.match(homeNote(missing, home), /Python .*could not be run/);
  for (const note of [homeNote(late, home), homeNote(missing, home)]) {
    assert.doesNotMatch(note, han, 'a line of the install log and of the detail, in the program\'s words');
    assert.ok(!/MinerU|pars/i.test(note.replace(home, '')), note);
  }
});

test('#942 L2: the permissions are changed only in the settings folder of a StudyHub install: never a folder named otherwise, one without the sentinel next to it, a drive root, the user\'s own folder, or a link', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-secure-home-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const { homedir } = await import('node:os');
  const { parse } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const refused = async (home, why) => {
    const result = await secureMineruHome(home, { platform: process.platform, pythonCli: { file: join(dir, 'never-run.exe'), prefix: [], env: {} } });
    assert.equal(result.ok, false, why);
    assert.equal(result.skipped, 'not-ours', why);
    assert.match(homeNote(result, home), /left the permissions of .* as they are/, why);
  };
  await refused(join(dir, 'home'), 'no sentinel beside it (another MinerU\'s folder, or MINERU_HOME pointing anywhere)');
  assert.equal(existsSync(join(dir, 'home')), false, 'nothing is even created');
  await ourFolder(dir);
  await refused(join(dir, 'settings'), 'not named home');
  await refused(parse(dir).root, 'a drive root');
  await refused(homedir(), 'the user\'s own folder');
  await refused(join(dir, 'home', '..', 'home', '..'), 'a path that only looks like it at first');
});

test('#942 L2: a home that is a junction to another folder is refused, and a file hard-linked from outside is never changed (a real Python and icacls, temp folders)', { skip: process.platform !== 'win32' }, async t => {
  const python = await realPython();
  if (!python) { t.skip('no Python 3.11-3.14 on this computer: the permission change needs one'); return; }
  const { execFileSync } = await import('node:child_process');
  const { link } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'study-secure-home-links-'));
  t.after(async () => { try { execFileSync('icacls', [dir, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore' }); } catch { /* best effort */ } await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const pythonCli = { file: python.path, prefix: [], env: {} };
  // 1. <ours>\home is a junction to a folder elsewhere, whose file has its own protected list: it stays exactly as it was.
  const elsewhere = join(dir, 'elsewhere'), ours = join(dir, 'ours');
  await mkdir(elsewhere, { recursive: true }); await mkdir(ours, { recursive: true });
  await writeFile(join(elsewhere, 'kept.txt'), 'x');
  execFileSync('icacls', [join(elsewhere, 'kept.txt'), '/inheritance:d'], { stdio: 'ignore' });
  const before = await aclOf(join(elsewhere, 'kept.txt'), dir), folderBefore = await aclOf(elsewhere, dir);
  await ourFolder(ours);
  await symlink(elsewhere, join(ours, 'home'), 'junction');
  const junction = await secureMineruHome(join(ours, 'home'), { platform: 'win32', pythonCli });
  assert.deepEqual([junction.ok, junction.skipped], [false, 'not-ours']);
  assert.deepEqual(await aclOf(join(elsewhere, 'kept.txt'), dir), before, 'the target\'s file is untouched');
  assert.deepEqual(await aclOf(elsewhere, dir), folderBefore, 'the target folder is untouched');
  // 2. A real home with a hard link to a file outside it: the walk leaves that file (and so its other name outside) alone.
  const real = join(dir, 'real');
  await mkdir(real, { recursive: true });
  const home = await ourFolder(real);
  await mkdir(home, { recursive: true });
  await writeFile(join(dir, 'outside.txt'), 'x');
  execFileSync('icacls', [join(dir, 'outside.txt'), '/inheritance:d'], { stdio: 'ignore' });
  const outside = await aclOf(join(dir, 'outside.txt'), dir);
  await link(join(dir, 'outside.txt'), join(home, 'linked.txt'));
  const result = await secureMineruHome(home, { platform: 'win32', pythonCli });
  assert.deepEqual(await aclOf(join(dir, 'outside.txt'), dir), outside, 'a file with another name outside the home keeps its list');
  // #942 N1: that file's list is not what the home gives, and it was left as it is: the repair is not complete, and the result says so with the count.
  assert.deepEqual([result.ok, result.linked], [false, 1], JSON.stringify(result));
  assert.match(homeNote(result, home), /1 file\(s\) below it .*left alone because .*linked from elsewhere.*not complete/, homeNote(result, home));
  // A healthy hard-linked file (its list is what the home gives) is not counted: nothing broken was skipped.
  const clean = join(dir, 'clean');
  await mkdir(clean, { recursive: true });
  const cleanHome = await ourFolder(clean);
  await mkdir(cleanHome, { recursive: true });
  assert.equal((await secureMineruHome(cleanHome, { platform: 'win32', pythonCli })).ok, true);
  await writeFile(join(cleanHome, 'a.txt'), 'x');
  await link(join(cleanHome, 'a.txt'), join(cleanHome, 'b.txt'));
  assert.deepEqual(await secureMineruHome(cleanHome, { platform: 'win32', pythonCli }), { ok: true });
});

test('#942 N1: a start that fails after the permission step left linked files alone carries their count, for the card to say', () => {
  const failure = explainStartFailure({ code: 'server-start-failed', reason: 'home-permissions', file: 'config.yaml', detail: 'x', linked: 2 });
  assert.deepEqual([failure.code, failure.file, failure.linked], ['home-permissions', 'config.yaml', 2]);
  assert.equal(Object.hasOwn(explainStartFailure({ code: 'server-start-failed', reason: 'home-permissions', file: '', detail: 'x' }), 'linked'), false, 'no count, no field');
  assert.match(homeNote({ ok: false, linked: 3, error: 'ignored' }, 'D:\\x\\home'), /3 file\(s\) below it/);
});

test('POSIX: the home is 0700 and the files directly in it (config.yaml, credentials) 0600; logs keep theirs', { skip: process.platform === 'win32' }, async t => {
  const { chmod, stat: statOf } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'study-secure-home-posix-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = await ourFolder(dir);
  await mkdir(join(home, 'logs'), { recursive: true });
  for (const file of ['config.yaml', 'credentials.yaml', join('logs', 'a.log')]) { await writeFile(join(home, file), 'x'); await chmod(join(home, file), 0o664); }
  await chmod(home, 0o775);
  assert.deepEqual(await secureMineruHome(home, { platform: process.platform }), { ok: true });
  const mode = async file => (await statOf(join(home, file))).mode & 0o777;
  assert.deepEqual([await mode(''), await mode('config.yaml'), await mode('credentials.yaml'), await mode(join('logs', 'a.log'))], [0o700, 0o600, 0o600, 0o664]);
});

test('a start that failed carries what the permission step did not do in its detail (no Python found here: the fake is not a mineru.exe)', { skip: process.platform !== 'win32' }, async t => {
  const fake = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false, startSilentFail: true, serverLogError: 'RuntimeError: worker exited with code 3' });
  const home = await ourFolder(fake.dir);
  await assert.rejects(startServer({ cli: fake.cli, home }), error => error.reason === 'service-failed'
    && /could not restrict permissions on .*home: no Python/.test(error.detail) && /worker exited/.test(error.detail));
});

test('#942 N2: a denied path with the long-path prefix (\\\\?\\ and \\\\?\\UNC\\) is compared without it', () => {
  const home = 'D:\\StudyHub\\MinerU\\home';
  const py = path => path.replace(/\\/g, '\\\\');
  const cases = [
    [`PermissionError: [WinError 5] Access is denied: '${py(`\\\\?\\${home}\\config.yaml`)}'`, home, 'config.yaml'],
    [`System.UnauthorizedAccessException: Access to the path '\\\\?\\${home}\\models\\a.onnx' is denied.`, home, 'models\\a.onnx'],
    [`PermissionError: [WinError 5] Access is denied: '${py('\\\\?\\UNC\\server\\share\\MinerU\\home\\config.yaml')}'`, '\\\\server\\share\\MinerU\\home', 'config.yaml'],
    [`PermissionError: [WinError 5] Access is denied: '${py('\\\\?\\D:\\StudyHub\\MinerU\\venv\\x.pyd')}'`, home, null],
  ];
  for (const [said, where, file] of cases) assert.deepEqual(homePermissionFailure(said, where), file === null ? null : { file }, said);
});

test('#942 M2: a denial is about the settings folder only when the path IN the denial is inside it; a home path printed elsewhere in the text decides nothing', () => {
  const home = 'D:\\StudyHub\\MinerU\\home';
  const py = path => path.replace(/\\/g, '\\\\');
  const cases = [
    // The two cases the review reproduced: the home is mentioned, the denied file is in the venv.
    [`see ${home}\\logs\\doclib.stderr.log\n[WinError 5] Access is denied: '${py('D:\\StudyHub\\MinerU\\venv\\Lib\\site-packages\\torch\\lib\\c10.dll')}'`, home, null],
    [`Loading config from ${home}\\config.yaml\nPermissionError: [Errno 13] Permission denied: '${py('D:\\StudyHub\\MinerU\\venv\\Lib\\x.pyd')}'`, home, null],
    // Inside: Python's doubled backslashes, mixed slashes and case, a trailing separator on the home, the Chinese form, .NET, Node, Rust (uv).
    [`PermissionError: [Errno 13] Permission denied: '${py(`${home}\\config.yaml`)}'`, home, 'config.yaml'],
    ["PermissionError: [Errno 13] Permission denied: 'd:/studyhub/MinerU\\\\HOME/logs/a.log'", home, 'logs/a.log'],
    [`PermissionError: [Errno 13] Permission denied: '${py(`${home}\\config.yaml`)}'`, `${home}\\`, 'config.yaml'],
    [`PermissionError: [WinError 5] 拒绝访问。: '${py(`${home}\\config.yaml`)}'`, home, 'config.yaml'],
    [`System.UnauthorizedAccessException: Access to the path '${home}\\models\\a.onnx' is denied.`, home, 'models\\a.onnx'],
    [`Error: EACCES: permission denied, open '${home}\\config.yaml'`, home, 'config.yaml'],
    [`error: failed to open file \`${home}\\config.yaml\`: Access is denied. (os error 5)`, home, 'config.yaml'],
    ["PermissionError: [Errno 13] Permission denied: '/home/lee/StudyHub/MinerU/home/config.yaml'", '/home/lee/StudyHub/MinerU/home', 'config.yaml'],
    [`PermissionError: [Errno 13] Permission denied: '${py('D:\\My Files\\MinerU\\home\\config.yaml')}'`, 'D:\\My Files\\MinerU\\home', 'config.yaml'],
    // Not inside: a sibling that starts with the same name, a relative path, no folder to compare with, no path at all.
    [`PermissionError: [Errno 13] Permission denied: '${py('D:\\StudyHub\\MinerU\\home2\\config.yaml')}'`, home, null],
    ["PermissionError: [Errno 13] Permission denied: 'config.yaml'", home, null],
    [`PermissionError: [Errno 13] Permission denied: '${py(`${home}\\config.yaml`)}'`, '', null],
    ['PermissionError: [WinError 5] Access is denied', home, null],
    // MinerU's privacy complaint is about the settings folder whatever else is printed; a log path elsewhere never becomes its file.
    [`see ${home}\\logs\\doclib.stderr.log\nPermissionError: Credential configuration directory '${py(home)}' has insecure permissions`, home, ''],
    [`PermissionError: Credential configuration file '${py(`${home}\\credentials.json`)}' is not private (cannot enforce private credential)`, home, 'credentials.json'],
  ];
  for (const [said, where, file] of cases) assert.deepEqual(homePermissionFailure(said, where), file === null ? null : { file }, said);
});

test('a permission failure on a file inside the settings folder is home-permissions (which file, nothing to move); one outside it, or naming no path, stays not-writable', async t => {
  const fake = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false, startSilentFail: true });
  const home = join(fake.dir, 'home');
  // What Python prints: the path inside quotes with its backslashes doubled.
  const python = path => `PermissionError: [Errno 13] Permission denied: '${path.replace(/\\/g, '\\\\')}'`;
  await fake.set({ serverLogError: python(join(home, 'config.yaml')) });
  await assert.rejects(startServer({ cli: fake.cli, home }), error => error.reason === 'home-permissions' && error.file === 'config.yaml' && /不用换位置/.test(error.message));
  await fake.set({ serverLogError: python(join(home, 'logs', 'doclib.log')) });
  await assert.rejects(startServer({ cli: fake.cli, home }), error => error.reason === 'home-permissions' && error.file === join('logs', 'doclib.log'));
  await fake.set({ serverLogError: python(join(fake.dir, 'venv', 'Lib', 'site-packages', 'x.pyd')) });
  await assert.rejects(startServer({ cli: fake.cli, home }), error => error.reason === 'not-writable');
  await fake.set({ serverLogError: 'PermissionError: [WinError 5] Access is denied' });
  await assert.rejects(startServer({ cli: fake.cli, home }), error => error.reason === 'not-writable');
});

/** <home>/logs/<name> written before a start: what an earlier run left behind. */
const oldLog = async (home, name, text) => { await mkdir(join(home, 'logs'), { recursive: true }); await writeFile(join(home, 'logs', name), `${text}\n`, 'utf8'); };

test('startServer decides why a start failed from what THIS start wrote to the error logs, never from an old traceback or the general log', async t => {
  // An earlier run's permission traceback is still in doclib.stderr.log; this start crashes because the models are missing.
  const stale = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false, startSilentFail: true, serverLogError: 'RuntimeError: requires model files that are not ready' });
  const staleHome = join(stale.dir, 'home');
  await oldLog(staleHome, 'doclib.stderr.log', 'PermissionError: [WinError 5] Access is denied: old run');
  await assert.rejects(startServer({ cli: stale.cli, home: staleHome }), error => error.reason === 'models-missing' && /Access is denied: old run/.test(error.detail));
  // The other way round: an old failure that is not about permissions, and a fresh access-denied line.
  const fresh = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false, startSilentFail: true, serverLogError: 'PermissionError: [WinError 5] Access is denied' });
  const freshHome = join(fresh.dir, 'home');
  await oldLog(freshHome, 'doclib.stderr.log', 'requests.exceptions.ConnectionError: Max retries exceeded (old run)');
  await assert.rejects(startServer({ cli: fresh.cli, home: freshHome }), error => error.reason === 'not-writable');
  // The general log is shown, never read for the reason: an ordinary line there that mentions permissions decides nothing.
  const general = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false, startSilentFail: true });
  const generalHome = join(general.dir, 'home');
  await oldLog(generalHome, 'doclib.log', 'INFO checked folder permissions: Permission denied entries are ignored');
  await assert.rejects(startServer({ cli: general.cli, home: generalHome }), error => error.reason === 'service-failed' && /\[doclib\.log\]/.test(error.detail));
});

test('the daemon logs are read from their end, at most 64 KB of each, and a log now shorter than its mark (replaced since) is read whole', async t => {
  const home = await mkdtemp(join(tmpdir(), 'study-mineru-logs-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // 4000 numbered lines of 50 bytes (200 000 bytes): only the last 64 KB (~1310 lines) is read, and it holds the last line.
  const lines = Array.from({ length: 4000 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'x'.repeat(38)}`);
  await oldLog(home, 'doclib.stderr.log', lines.join('\n'));
  const shown = await readMineruServerLogs(home, { maxLines: 1e6, maxChars: 1e7 });
  const numbers = [...shown.matchAll(/line (\d{5})/g)].map(match => Number(match[1]));
  assert.equal(numbers.at(-1), 3999, 'the end of the log is read');
  assert.ok(numbers[0] >= 4000 - Math.ceil(64 * 1024 / 50) - 1 && numbers.length <= Math.ceil(64 * 1024 / 50) + 1, `read from line ${numbers[0]}: no more than 64 KB`);
  // A mark past the end of the file: the file was replaced, so all of it is new (bounded the same way), and its last line decides.
  const mark = await markServerLogs(home);
  assert.equal(mark['doclib.stderr.log'], 200_000);
  await writeFile(join(home, 'logs', 'doclib.stderr.log'), 'PermissionError: [WinError 5] Access is denied (after a restart)\n', 'utf8');
  assert.match(await serverErrorsSince(home, mark), /Access is denied \(after a restart\)/);
  // A mark at the end of an unchanged file: nothing new.
  assert.equal(await serverErrorsSince(home, await markServerLogs(home)), '');
});

test('startServer reads a missing VC++ runtime in its English Windows forms as vc-runtime, as the installer does', async t => {
  for (const said of ['OSError: [WinError 126] The specified module could not be found. Error loading "torch\\lib\\c10.dll"', "Error: ... code: 'ERR_DLOPEN_FAILED'"]) {
    const fake = await fakeCli(t, { mode: 'managed', tier: 'basic', running: false, startSilentFail: true, serverLogError: said });
    await assert.rejects(startServer({ cli: fake.cli, home: join(fake.dir, 'home') }), error => error.reason === 'vc-runtime' && /VC\+\+/.test(error.message), said);
  }
});

