import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectMarker, locateMarker, parseMarkerMarkdown, parseMarkerWindow } from '../lib/marker-local.js';
import { readMarkerSettings, saveMarkerSettings } from '../lib/marker-settings.js';

const divider = page => `{${page}}${'-'.repeat(48)}\n`;
async function fake(t, mode = '') {
  const dir = await mkdtemp(path.join(tmpdir(), 'study-marker-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(dir, 'fake.mjs');
  await writeFile(file, `
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
await writeFile(process.env.MARKER_TEST_LOG, JSON.stringify(args));
if (args[0] === '--help') {
  console.log(process.env.MARKER_TEST_MODE === 'old' ? '--output_dir' : '--output_dir --page_range --paginate_output --output_format --disable_image_extraction');
} else if (process.env.MARKER_TEST_MODE === 'hang') {
  setInterval(() => {}, 1000);
} else if (process.env.MARKER_TEST_MODE === 'fail') {
  console.error('Missing OCR backend /private/secret/model.bin Bearer private-token ' + 'x'.repeat(400));
  process.exitCode = 1;
} else if (process.env.MARKER_TEST_MODE !== 'empty') {
  const output = args[args.indexOf('--output_dir') + 1];
  const range = args[args.indexOf('--page_range') + 1].split('-').map(Number);
  const stem = path.basename(args[0], path.extname(args[0]));
  await mkdir(path.join(output, stem), { recursive: true });
  const markdown = Array.from({ length: range[1] - range[0] + 1 }, (_, i) => '{' + (range[0] + i) + '}' + '-'.repeat(48) + '\\n' + (i ? '# Chapter\\n**Body**\\n' : '')).join('');
  await writeFile(path.join(output, stem, stem + '.md'), process.env.MARKER_TEST_MODE === 'large' ? 'x'.repeat(8 * 1024 * 1024 + 1) : markdown);
}
`);
  const log = path.join(dir, 'args.json');
  return { dir, log, cli: { file: process.execPath, prefix: [file], env: { MARKER_TEST_MODE: mode, MARKER_TEST_LOG: log } } };
}

test('Marker discovery respects explicit paths and Windows executable names', () => {
  const options = { platform: 'win32', homedir: 'C:\\Users\\a', env: { Path: 'C:\\tools;C:\\other' }, exists: file => file === 'C:\\tools\\marker_single.exe' };
  assert.equal(locateMarker(options).file, 'C:\\tools\\marker_single.exe');
  assert.equal(locateMarker({ ...options, command: 'C:\\missing.exe' }), null);
  assert.equal(locateMarker({ platform: 'linux', homedir: '/home/a', env: {}, exists: file => file === '/home/a/.local/bin/marker_single' }).file, '/home/a/.local/bin/marker_single');
});

test('Marker detection checks the command flags without converting a document', async t => {
  assert.equal((await detectMarker({ cli: null })).state, 'not-installed');
  const available = await fake(t);
  const status = await detectMarker({ cli: available.cli });
  assert.equal(status.state, 'ready');
  assert.equal(status.command, available.cli.file);
  assert.equal(status.modelsReady, undefined);
  assert.deepEqual(JSON.parse(await readFile(available.log, 'utf8')), ['--help']);
  const old = await fake(t, 'old');
  assert.equal((await detectMarker({ cli: old.cli })).state, 'unavailable');
});

test('Marker output retains empty pages and converts original page numbers to window-relative indices', () => {
  assert.deepEqual(parseMarkerMarkdown(`${divider(4)}\n${divider(5)}# Heading\n$$x$$`, 5, 6), [
    { type: 'text', page_idx: 0, text: '' }, { type: 'text', page_idx: 1, text: '# Heading\n$$x$$' },
  ]);
  for (const markdown of [divider(4), `${divider(4)}${divider(4)}`, `${divider(5)}${divider(6)}`, 'no page labels']) {
    assert.throws(() => parseMarkerMarkdown(markdown, 5, 6), { code: 'invalid-output' });
  }
});

test('Marker runs the requested original range and reads only its expected output', async t => {
  const { dir, cli, log } = await fake(t);
  const outFile = path.join(dir, 'window.md');
  const result = await parseMarkerWindow({ cli, pdf: path.join(dir, 'source.pdf'), startPage: 5, endPage: 6, totalPages: 8, outFile, timeoutMs: 5000 });
  assert.deepEqual(result.content, [{ type: 'text', page_idx: 0, text: '' }, { type: 'text', page_idx: 1, text: '# Chapter\n**Body**' }]);
  const args = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(args[args.indexOf('--page_range') + 1], '4-5');
  assert.ok(args.includes('--disable_image_extraction'));
  assert.ok(!args.includes('--use_llm'));
  assert.equal((await readdir(dir)).some(name => name.startsWith('marker-output-')), false);
});

test('Marker missing output cannot accidentally import an old result', async t => {
  const { dir, cli } = await fake(t, 'empty');
  const outFile = path.join(dir, 'window.md');
  await writeFile(outFile, `${divider(0)}old result`);
  await assert.rejects(parseMarkerWindow({ cli, pdf: path.join(dir, 'source.pdf'), startPage: 1, endPage: 1, totalPages: 1, outFile }), { code: 'empty-output' });
});

test('Marker failures and timeouts expose Marker-specific retryable errors', async t => {
  for (const [mode, code] of [['fail', 'marker-failed'], ['hang', 'timeout']]) {
    const { dir, cli } = await fake(t, mode);
    await assert.rejects(parseMarkerWindow({ cli, pdf: path.join(dir, 'source.pdf'), startPage: 1, endPage: 1, totalPages: 1,
      outFile: path.join(dir, 'window.md'), timeoutMs: mode === 'hang' ? 200 : 5000 }), error => {
      assert.equal(error.name, 'MarkerError');
      assert.equal(error.code, code);
      assert.equal(error.retryable, true);
      assert.match(error.message, /Marker/);
      if (mode === 'fail') {
        assert.match(error.message, /Missing OCR backend/);
        assert.ok(!error.message.includes('/private/secret'));
        assert.ok(!error.message.includes('private-token'));
        assert.ok(error.message.length < 350);
      }
      return true;
    });
    assert.equal((await readdir(dir)).some(name => name.startsWith('marker-output-')), false);
  }
});

test('Marker rejects an oversized generated file before importing its text', async t => {
  const { dir, cli } = await fake(t, 'large');
  const outFile = path.join(dir, 'window.md');
  await assert.rejects(parseMarkerWindow({ cli, pdf: path.join(dir, 'source.pdf'), startPage: 1, endPage: 1, totalPages: 1,
    outFile, timeoutMs: 5000 }), { code: 'too-big' });
  assert.ok(!(await readdir(dir)).includes('window.md'));
});

test('Marker cancellation propagates and removes the attempt output directory', async t => {
  const { dir, cli } = await fake(t, 'hang');
  const controller = new AbortController();
  const conversion = parseMarkerWindow({ cli, pdf: path.join(dir, 'source.pdf'), startPage: 1, endPage: 1, totalPages: 1,
    outFile: path.join(dir, 'window.md'), signal: controller.signal });
  const reason = new Error('cancelled');
  const timer = setTimeout(() => controller.abort(reason), 300);
  t.after(() => clearTimeout(timer));
  await assert.rejects(conversion, error => error === reason);
  assert.equal((await readdir(dir)).some(name => name.startsWith('marker-output-')), false);
});

test('Marker settings store only an executable path and support resetting discovery', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'marker-settings-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(await readMarkerSettings(), { command: '' });
  await assert.rejects(saveMarkerSettings({ command: 'marker_single --use_llm' }));
  await assert.rejects(saveMarkerSettings({ command: `${path.join(dir, 'marker')}\nargument` }));
  const command = path.join(dir, 'marker_single');
  assert.deepEqual(await saveMarkerSettings({ command }), { command });
  assert.deepEqual(await readMarkerSettings(), { command });
  assert.deepEqual(await saveMarkerSettings({ command: '' }), { command: '' });
});
