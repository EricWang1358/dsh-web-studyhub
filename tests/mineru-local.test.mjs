import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL, LocalMineruError, detectLocal, locateMineru, parseLocalMarkdown, parseWindow, startServer, windowPlan } from '../lib/mineru-local.js';
import { mergeChunkResults } from '../lib/mineru-merge.js';
import { parseConvertedDocument } from '../lib/converted-document.js';

/* The local `mineru` command line (free, nothing uploaded): detection, one honest state, page-window parsing. Everything here runs
   against tests/helpers/fake-mineru-cli.mjs; no real mineru is ever started, installed or configured. */

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));
const han = /[㐀-鿿]/;
/** Whether a process has ended, waiting a few seconds for the (asynchronous) kill to land. */
async function gone(pid) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

async function fakeCli(t, state = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'study-fake-mineru-'));
  const statePath = join(dir, 'state.json'), logPath = join(dir, 'log.jsonl');
  const base = { version: '4.0.10', mode: 'disabled', tier: 'basic', running: false, total: 120, modelsReady: false };
  await writeFile(statePath, JSON.stringify({ ...base, ...state })); await writeFile(logPath, '');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = { file: process.execPath, prefix: [FAKE], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } };
  return { dir, cli, state: async () => JSON.parse(await readFile(statePath, 'utf8')), set: async patch => writeFile(statePath, JSON.stringify({ ...JSON.parse(await readFile(statePath, 'utf8')), ...patch })),
    log: async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) };
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

test('installed but never set up: models are needed, and the next step is to download them', async t => {
  const fake = await fakeCli(t, { mode: 'disabled', tier: 'flash' });
  const detected = await detectLocal({ cli: fake.cli, home: join(fake.dir, 'nohome') });
  assert.equal(detected.state, 'needs-models');
  assert.equal(detected.next, 'download-models');
  assert.equal(detected.version, '4.0.10');
  assert.equal(detected.modelsDownloaded, false);
});

test('only read-only commands are run to find out: --version, config get, server status', async t => {
  const fake = await fakeCli(t, { mode: 'managed', tier: 'basic', running: true });
  await detectLocal({ cli: fake.cli, home: fake.dir });
  const calls = (await fake.log()).map(entry => entry.argv.slice(0, 3).join(' '));
  assert.deepEqual(calls.sort(), ['--version', 'config get parse_server.local.managed_tier', 'config get parse_server.local.mode', 'server status'].sort());
  assert.deepEqual((await fake.state()).running, true, 'nothing was started or changed');
});

test('models on disk but the local mode is off: the next step is only to switch it on (the models folder may be a junction)', async t => {
  const fake = await fakeCli(t, { mode: 'disabled', tier: 'basic' });
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
  assert.equal(detected.tier, 'basic');
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
    error => error instanceof LocalMineruError && error.code === 'server-stopped' && error.retryable === true && /本地服务/.test(error.message) && /重新启动/.test(error.message));
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
  const started = Date.now();
  const parsing = parseWindow({ cli: fake.cli, pdf: 'book.pdf', tier: 'basic', startPage: 1, endPage: 5, totalPages: 120, outFile: join(fake.dir, 'o.md'), signal: controller.signal });
  for (let i = 0; i < 100 && !(await fake.log()).some(entry => entry.argv[0] === 'parse'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort(new Error('cancelled by learner'));
  await assert.rejects(parsing, /cancelled by learner/);
  assert.ok(Date.now() - started < 10_000, 'stopped promptly, not after the 60 s the window would have taken');
  const pid = (await fake.log()).find(entry => entry.argv[0] === 'parse').pid;
  assert.equal(await gone(pid), true, 'the child is gone');
});

test('a window that takes longer than its bounded wait is stopped and reported as a timeout', async t => {
  const fake = await fakeCli(t, { mode: 'managed', running: true, delayMs: 60_000 });
  await assert.rejects(parseWindow({ cli: fake.cli, pdf: 'book.pdf', tier: 'basic', startPage: 1, endPage: 5, totalPages: 120, outFile: join(fake.dir, 'o.md'), timeoutMs: 300 }),
    error => error.code === 'timeout' && error.retryable === true && /太久/.test(error.message));
  const pid = (await fake.log()).find(entry => entry.argv[0] === 'parse').pid;
  assert.equal(await gone(pid), true);
});

test('every message of the local route has an English form', async () => {
  const { localizeAppMessage } = await import('../lib/application-messages.js');
  const { LOCAL_MESSAGES } = await import('../lib/mineru-local.js');
  const samples = [...Object.values(LOCAL_MESSAGES),
    ...[() => parseLocalMarkdown(marker(1), { startPage: 1, endPage: 3, totalPages: 9 }), () => parseLocalMarkdown(marker(1), { startPage: 5, endPage: 5, totalPages: 9 }), () => parseLocalMarkdown(marker(1, 7), { startPage: 1, endPage: 1, totalPages: 9 }), () => parseLocalMarkdown(`${marker(1)}
${marker(1)}`, { startPage: 1, endPage: 2, totalPages: 120 })]
      .map(run => { try { run(); return ''; } catch (error) { return error.message; } })];
  assert.ok(samples.filter(Boolean).length >= 9);
  for (const text of samples.filter(Boolean)) assert.doesNotMatch(localizeAppMessage(text, 'en'), han, text);
});
