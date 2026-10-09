import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOutputLog, failureOf, MARKER_LOG, progressOf } from '../lib/marker-output.js';
import { detectMarker, dockerState, markerExitError, markerUsable, markerVersion, MARKER_TEXT } from '../lib/marker-local.js';

/* What a Marker run leaves in the job's log and in its failure (lib/marker-output.js, lib/marker-local.js): the END of a traceback (its cause), no path, no token,
   progress bars collapsed to their last state, bounded; and the check of an installed marker-pdf 2.x, which needs Docker. */

// The owner's real failure (2026-10-09), its paths kept as they were printed: the last line is the cause, everything above is the way there.
const spawnTraceback = [
  'Traceback (most recent call last):',
  '  File "<frozen runpy>", line 198, in _run_module_as_main',
  ...Array.from({ length: 25 }, (_, index) => `  File "F:\\StudyHub-Marker\\venv\\Lib\\site-packages\\click\\core.py", line ${1600 + index}, in __call__\n    return self.main(*args, **kwargs)\n           ^^^^^^^^^^^^^^^^^^^^^^^^^^`),
  '  File "F:\\StudyHub-Marker\\venv\\Lib\\site-packages\\marker\\converters\\pdf.py", line 207, in build_document',
  '    processor(document)',
  '  File "F:\\StudyHub-Marker\\venv\\Lib\\site-packages\\surya\\inference\\backends\\vllm.py", line 195, in spawn_fn',
  '    raise SpawnError(f"docker run failed: {result.stderr or result.stdout}")',
  'surya.inference.backends.spawn.SpawnError: docker run failed: failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.',
].join('\r\n');

const cudaTraceback = ['Traceback (most recent call last):', '  File "/home/learner/marker-env/lib/python3.12/site-packages/torch/nn/modules/module.py", line 1751, in _call_impl',
  '    return forward_call(*args, **kwargs)', '           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^', `${'x'.repeat(3000)}`,
  'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB (Bearer sk-private-token-123456) in /home/learner/models/cache.bin'].join('\n');

test('a traceback keeps its END: the exception is the summary, the last lines are kept plain, with no folder, token or caret line', () => {
  const failure = failureOf(spawnTraceback);
  assert.match(failure.summary, /^surya\.inference\.backends\.spawn\.SpawnError: docker run failed/);
  assert.ok(failure.summary.length <= MARKER_LOG.summaryChars);
  assert.ok(failure.lines.length <= MARKER_LOG.failureLines && failure.lines.length > 3);
  assert.match(failure.lines.at(-1), /SpawnError: docker run failed/, 'the cause is the last line kept');
  assert.ok(failure.lines.some(line => line.includes('File "vllm.py", line 195, in spawn_fn')), 'a frame keeps its file name, not its folders');
  const all = [failure.summary, ...failure.lines].join('\n');
  assert.doesNotMatch(all, /StudyHub-Marker|site-packages|\\venv\\/);
  assert.ok(!failure.lines.some(line => /^\s*\^+\s*$/.test(line)), 'the ^^^^ markers are dropped');

  const cuda = failureOf(cudaTraceback, { secrets: ['/home/learner/models'] });
  assert.match(cuda.summary, /^torch\.OutOfMemoryError: CUDA out of memory\. Tried to allocate 2\.00 GiB/);
  assert.match(cuda.lines.at(-1), /torch\.OutOfMemoryError/);
  assert.ok(cuda.lines.join('\n').length <= MARKER_LOG.failureChars);
  const text = [cuda.summary, ...cuda.lines].join('\n');
  assert.doesNotMatch(text, /sk-private-token|\/home\/learner/);
});

test('a failure is told by its cause: Docker for marker-pdf 2.x (both ways out, leading to the settings), a broken install, any other exception with the exit code', () => {
  const docker = markerExitError({ code: 1, text: spawnTraceback });
  assert.equal(docker.code, 'marker-needs-docker');
  assert.equal(docker.fix, 'settings');
  assert.equal(docker.retryable, true, '接着做 helps once Docker runs');
  assert.equal(docker.message, MARKER_TEXT.needsDocker(2));
  assert.match(docker.message, /启动 Docker Desktop/); assert.match(docker.message, /修复安装（改装 1\.x）/);
  assert.equal(docker.detail.exitCode, 1); assert.match(docker.detail.lines.at(-1), /SpawnError/);

  const missing = markerExitError({ code: 1, text: 'Traceback (most recent call last):\n  File "x.py", line 1\nModuleNotFoundError: No module named \'surya\'' });
  assert.equal(missing.code, 'marker-failed'); assert.equal(missing.fix, 'settings');
  assert.equal(missing.message, "Marker 退出码 1：ModuleNotFoundError: No module named 'surya'");

  const cuda = markerExitError({ code: 3221225477, text: cudaTraceback });
  assert.equal(cuda.fix, undefined, 'a model that does not fit may fit in a smaller window: no settings to change');
  assert.match(cuda.message, /^Marker 退出码 3221225477：torch\.OutOfMemoryError: CUDA out of memory/);
  assert.ok(cuda.message.length < 300, 'short enough for a window error (300) and a list row');
  assert.equal(markerExitError({ code: 2, text: '' }).message, 'Marker 退出码 2，没有输出原因。');
});

test('progress bars collapse to their last state, the first and last lines are kept, the rest counted; a line split across pieces is one line', () => {
  let clock = 0;
  const lines = [], live = [];
  const log = createOutputLog({ emit: entry => lines.push(entry), live: bar => live.push(bar), now: () => clock, secrets: ['C:\\book\\job'] });
  log.write('2026-10-09 [INFO] marker: Loading models from C:\\book\\job\\models\\lay');
  log.write('out\n');
  for (let done = 0; done <= 5; done++) { clock += 300; log.write(`\rRecognizing layout: ${done * 20}%|##        | ${done}/5 [00:01<00:01]`); }
  // No new line between the two bars: the second one (another label) closes the first; tqdm ends a bar with one.
  for (let done = 0; done <= 2; done++) log.write(`\rRecognizing text: ${done * 50}%|#####     | ${done}/2 [00:01<00:01]`);
  log.write('\n');
  for (let index = 0; index < 40; index++) log.write(`warning ${index}\n`);
  const ended = log.end();
  const texts = lines.filter(entry => entry.text).map(entry => entry.text);
  assert.equal(texts[0], '2026-10-09 [INFO] marker: Loading models from layout', 'one line though it came in two pieces; the folder is gone');
  assert.equal(texts.filter(text => text.startsWith('Recognizing layout')).length, 1, 'six redraws of one bar are one line');
  assert.equal(texts.find(text => text.startsWith('Recognizing layout')), 'Recognizing layout: 100% (5/5)');
  assert.equal(texts.find(text => text.startsWith('Recognizing text')), 'Recognizing text: 100% (2/2)');
  assert.equal(ended.lines, 41);
  assert.deepEqual(lines.find(entry => entry.omitted), { omitted: 41 - MARKER_LOG.headLines - MARKER_LOG.tailLines });
  assert.equal(texts.at(-1), 'warning 39', 'the last lines are kept');
  assert.ok(texts.length <= MARKER_LOG.headLines + MARKER_LOG.tailLines + 2);
  assert.ok(live.length >= 2 && live.length < 9, 'the live bar is throttled');
  assert.deepEqual(progressOf('Recognizing layout:  40%|####      | 2/5 [00:03<00:04, 1.2s/it]'), { label: 'Recognizing layout', percent: 40, done: 2, total: 5 });
  assert.equal(progressOf('[INFO] marker: Saved markdown'), null);
});

test('the installed marker-pdf version is read from the environment without starting anything', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'marker-version-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const windows = path.join(dir, 'win', 'venv'), posix = path.join(dir, 'posix', 'venv');
  await mkdir(path.join(windows, 'Scripts'), { recursive: true }); await mkdir(path.join(windows, 'Lib', 'site-packages', 'marker_pdf-2.0.0.dist-info'), { recursive: true });
  await mkdir(path.join(posix, 'bin'), { recursive: true }); await mkdir(path.join(posix, 'lib', 'python3.12', 'site-packages', 'marker_pdf-1.10.2.dist-info'), { recursive: true });
  assert.equal(await markerVersion(path.join(windows, 'Scripts', 'marker_single.exe')), '2.0.0');
  assert.equal(await markerVersion(path.join(posix, 'bin', 'marker_single')), '1.10.2');
  assert.equal(await markerVersion(path.join(dir, 'nowhere', 'bin', 'marker_single')), '');
  assert.equal(await markerVersion(''), '');
});

async function fakeDocker(t, mode) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-docker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'docker.mjs');
  await writeFile(file, mode === 'running' ? "console.log('27.3.1');\n"
    : mode === 'slow' ? 'setTimeout(() => {}, 10_000);\n'
      : "console.log('');\nconsole.error('failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine');\nprocess.exitCode = 1;\n");
  return { file: process.execPath, prefix: [file], env: {} };
}
const helpOk = async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-marker-help-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'marker.mjs');
  await writeFile(file, "console.log('--output_dir --page_range --paginate_output --output_format --disable_image_extraction');\n");
  return { file: process.execPath, prefix: [file], env: {} };
};

test('Docker is asked only for a marker-pdf 2.x: running, not running, not installed, no answer in time', async t => {
  assert.equal(await dockerState({ docker: await fakeDocker(t, 'running') }), 'running');
  assert.equal(await dockerState({ docker: await fakeDocker(t, 'stopped') }), 'stopped');
  assert.equal(await dockerState({ docker: { file: path.join(tmpdir(), 'no-such-docker-here.exe'), prefix: [], env: {} } }), 'missing');
  assert.equal(await dockerState({ docker: await fakeDocker(t, 'slow'), timeoutMs: 300 }), 'unknown');

  const cli = await helpOk(t);
  const two = async docker => detectMarker({ cli, docker, readVersion: async () => '2.0.0' });
  const running = await two(await fakeDocker(t, 'running'));
  assert.equal(running.state, 'ready', 'a 2.x with Docker running is a legitimate way to run it'); assert.equal(running.version, '2.0.0'); assert.equal(running.message, undefined);
  const stopped = await two(await fakeDocker(t, 'stopped'));
  assert.equal(stopped.state, 'needs-docker'); assert.equal(stopped.docker, 'stopped');
  assert.match(stopped.message, /Docker 没有运行/); assert.match(stopped.message, /修复安装（改装 1\.x）/);
  const missing = await two({ file: path.join(tmpdir(), 'no-such-docker-here.exe'), prefix: [], env: {} });
  assert.equal(missing.docker, 'missing'); assert.match(missing.message, /没有找到 Docker/); assert.match(missing.message, /修复安装（改装 1\.x）/);
  assert.equal(markerUsable(stopped), false); assert.equal(markerUsable(missing), false);
  assert.equal(markerUsable({ state: 'needs-docker', docker: 'unknown' }), true, 'no answer in time never blocks: the conversion itself will say');
  let asked = false;
  const one = await detectMarker({ cli, docker: { file: 'never', prefix: [], env: {} }, readVersion: async () => { asked = true; return '1.10.2'; } });
  assert.ok(asked); assert.equal(one.state, 'ready'); assert.equal(one.version, '1.10.2'); assert.equal(one.docker, undefined, 'a 1.x never asks Docker');
});
