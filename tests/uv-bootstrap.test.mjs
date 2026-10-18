import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadResumable, extractUv, findWheel, wheelTagFor } from '../lib/uv-bootstrap.js';
import { UV_TEST_VERSION, startFakeIndex } from './helpers/fake-index-server.mjs';

/* uv without GitHub and without Python: the uv wheel from a PEP 503 index, sha256-checked, resumable, unzipped. A local index server; no network. */

async function harness(t) {
  const index = await startFakeIndex(), dir = await mkdtemp(join(tmpdir(), 'uv-bootstrap-'));
  t.after(async () => { await index.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { index, dir };
}
const exists = file => stat(file).then(() => true, () => false);

test('the wheel tag per platform', () => {
  assert.equal(wheelTagFor('win32', 'x64'), 'win_amd64');
  assert.equal(wheelTagFor('win32', 'arm64'), 'win_arm64');
  assert.equal(wheelTagFor('darwin', 'arm64'), 'macosx_11_0_arm64');
  assert.equal(wheelTagFor('linux', 'x64'), 'manylinux_2_17_x86_64.manylinux2014_x86_64');
});

test('findWheel picks the pinned wheel of this platform, with its sha256, from a relative link', async t => {
  const { index } = await harness(t);
  const wheel = await findWheel(index.indexUrl, UV_TEST_VERSION, 'win_amd64');
  assert.equal(wheel.filename, `uv-${UV_TEST_VERSION}-py3-none-win_amd64.whl`);
  assert.equal(wheel.url, `${index.base}/packages/ab/cd/${wheel.filename}`);
  assert.equal(wheel.sha256, index.wheels.get(wheel.filename).sha256);
  await assert.rejects(findWheel(index.indexUrl, '9.9.9', 'win_amd64'), error => error.code === 'network');
  index.set({ noSha: true });
  await assert.rejects(findWheel(index.indexUrl, UV_TEST_VERSION, 'win_amd64'), error => error.code === 'checksum');
  index.reset(); index.set({ status: 503 });
  await assert.rejects(findWheel(index.indexUrl, UV_TEST_VERSION, 'win_amd64'), error => error.code === 'network');
});

test('a download cut off continues with a Range request and passes the sha256; progress is reported', async t => {
  const { index, dir } = await harness(t);
  const wheel = await findWheel(index.indexUrl, UV_TEST_VERSION, 'win_amd64'), part = join(dir, 'tools', 'uv.whl.part');
  index.set({ cutAfter: 50_000 });
  await assert.rejects(downloadResumable(wheel.url, part, { sha256: wheel.sha256 }), error => ['network', 'checksum'].includes(error.code));
  const kept = (await stat(part).catch(() => ({ size: 0 }))).size;
  // A cut is either noticed while reading (the part stays) or arrives as a short file whose sha256 fails (the part is deleted): both are retried from what is left.
  const seen = [];
  const done = await downloadResumable(wheel.url, part, { sha256: wheel.sha256, onProgress: progress => seen.push(progress) });
  assert.equal(done.bytes, index.wheels.get(wheel.filename).bytes.length);
  if (kept > 0) {
    assert.equal(done.resumedFrom, kept);
    assert.ok(index.requests.some(request => request.range === `bytes=${kept}-`), 'the second request asked for the rest');
  }
  assert.ok(seen.length > 0 && seen.at(-1).done === seen.at(-1).total);
});

test('a sha256 mismatch deletes the file; an abort stops the download', async t => {
  const { index, dir } = await harness(t);
  const wheel = await findWheel(index.indexUrl, UV_TEST_VERSION, 'win_amd64'), part = join(dir, 'uv.whl.part');
  await assert.rejects(downloadResumable(wheel.url, part, { sha256: '0'.repeat(64) }), error => error.code === 'checksum');
  assert.equal(await exists(part), false);
  const controller = new AbortController(); controller.abort(new Error('stop'));
  await assert.rejects(downloadResumable(wheel.url, part, { sha256: wheel.sha256, signal: controller.signal }), /stop/);
  // A part already whole on disk: the server answers 416 and the file is checked as it is.
  await writeFile(part, index.wheels.get(wheel.filename).bytes);
  assert.equal((await downloadResumable(wheel.url, part, { sha256: wheel.sha256 })).bytes, index.wheels.get(wheel.filename).bytes.length);
});

test('the uv program is taken out of the wheel with raised zip limits', async t => {
  const { index, dir } = await harness(t);
  for (const [tag, platform, name] of [['win_amd64', 'win32', 'uv.exe'], ['manylinux_2_17_x86_64.manylinux2014_x86_64', 'linux', 'uv']]) {
    const wheel = await findWheel(index.indexUrl, UV_TEST_VERSION, tag), part = join(dir, `${tag}.part`);
    await downloadResumable(wheel.url, part, { sha256: wheel.sha256 });
    const program = await extractUv(part, join(dir, tag), platform);
    assert.ok(program.endsWith(name));
    assert.match((await readFile(program, 'utf8')).slice(0, 100), new RegExp(`fake uv ${UV_TEST_VERSION} ${tag.replace(/\./g, '\\.')}`));
  }
  await writeFile(join(dir, 'empty.whl'), Buffer.from('PK\u0005\u0006' + '\0'.repeat(18), 'binary'));
  await assert.rejects(extractUv(join(dir, 'empty.whl'), join(dir, 'x'), 'win32'), error => error.code === 'checksum');
});
