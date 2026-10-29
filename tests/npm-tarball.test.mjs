import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPackage } from '../lib/npm-tarball.js';
import { makeTgz, paxRecord } from './helpers/make-tgz.mjs';

/* The npm tarball reader of the local live engine's install (lib/npm-tarball.js): regular files only, nothing outside the target folder, whatever
   form the name takes (absolute, a drive letter, backslashes, UNC, PAX or GNU long names), no links or devices, no odd size encodings, and bounded
   in what it unpacks. Every refusal is InstallError 'checksum' and writes nothing outside the target. */

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'npm-tarball-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const exists = file => stat(file).then(() => true, () => false);
async function unpack(dir, entries, limits) {
  const file = join(dir, `t-${Math.random().toString(36).slice(2)}.tgz`), out = join(dir, 'out', Math.random().toString(36).slice(2));
  await writeFile(file, Buffer.isBuffer(entries) ? entries : makeTgz(entries));
  return { out, run: () => extractPackage(file, out, limits) };
}

test('a plain package unpacks without its package/ folder; PAX and GNU long names inside the folder work', async t => {
  const dir = await scratch(t);
  const long = `package/${'deep/'.repeat(30)}file.js`;
  const { out, run } = await unpack(dir, [{ name: 'package/package.json', data: '{"name":"x"}' }, { name: 'ignored', type: 'x', data: paxRecord('path', long) },
    { name: 'short-name-in-header', data: 'pax' }, { name: '././@LongLink', type: 'L', data: 'package/gnu/long/name.js' }, { name: 'whatever', data: 'gnu' }]);
  const written = await run();
  assert.ok(written.includes('package.json'));
  assert.equal(await readFile(join(out, ...`${'deep/'.repeat(30)}file.js`.split('/')), 'utf8'), 'pax');
  assert.equal(await readFile(join(out, 'gnu', 'long', 'name.js'), 'utf8'), 'gnu');
});

const REFUSED = {
  'a parent folder': [{ name: 'package/../../evil.js', data: 'x' }],
  'an absolute name': [{ name: '/etc/evil.js', data: 'x' }],
  'an absolute name inside the folder name': [{ name: 'package//etc/evil.js', data: 'x' }],
  'a drive letter': [{ name: 'package/C:/evil.js', data: 'x' }],
  'a drive letter first': [{ name: 'C:/evil.js', data: 'x' }],
  'backslashes': [{ name: 'package\\..\\..\\evil.js', data: 'x' }],
  'a UNC path': [{ name: '\\\\server\\share\\evil.js', data: 'x' }],
  'a PAX path that climbs out': [{ name: 'x', type: 'x', data: paxRecord('path', 'package/../../evil.js') }, { name: 'package/fine.js', data: 'x' }],
  'a GNU long name that climbs out': [{ name: '././@LongLink', type: 'L', data: 'package/../../evil.js' }, { name: 'package/fine.js', data: 'x' }],
  'a symbolic link': [{ name: 'package/link', type: '2' }],
  'a hard link': [{ name: 'package/hard', type: '1' }],
  'a character device': [{ name: 'package/dev', type: '3' }],
  'a FIFO': [{ name: 'package/fifo', type: '6' }],
  'a base-256 size': [{ name: 'package/big.js', data: 'x', base256: true }],
};
for (const [what, entries] of Object.entries(REFUSED)) {
  test(`refused: ${what}`, async t => {
    const dir = await scratch(t);
    const { run } = await unpack(dir, entries);
    await assert.rejects(run(), { code: 'checksum' });
    assert.equal(await exists(join(dir, 'evil.js')), false);
    assert.equal(await exists(join(dir, 'out', 'evil.js')), false);
    assert.equal(await exists('/etc/evil.js'), false);
  });
}

test('bounded: a gzip bomb, too many entries, too many bytes and a cut archive are refused', async t => {
  const dir = await scratch(t);
  const bomb = await unpack(dir, gzipSync(Buffer.alloc(8 * 1_048_576)), { maxUnpackedBytes: 1_048_576, maxEntries: 10 });
  await assert.rejects(bomb.run(), { code: 'checksum' });
  const many = await unpack(dir, Array.from({ length: 12 }, (_, i) => ({ name: `package/f${i}.js`, data: 'x' })), { maxUnpackedBytes: 1_048_576, maxEntries: 10 });
  await assert.rejects(many.run(), { code: 'checksum' });
  const big = await unpack(dir, [{ name: 'package/a.bin', data: Buffer.alloc(600_000) }, { name: 'package/b.bin', data: Buffer.alloc(600_000) }], { maxUnpackedBytes: 1_048_576, maxEntries: 10 });
  await assert.rejects(big.run(), { code: 'checksum' });
  const whole = makeTgz([{ name: 'package/a.js', data: Buffer.alloc(5000, 1) }]);
  const { gunzipSync } = await import('node:zlib');
  const cut = await unpack(dir, gzipSync(gunzipSync(whole).subarray(0, 2000)));
  await assert.rejects(cut.run(), { code: 'checksum' });
  // Every refusal above comes before the first file is written.
  for (const run of [bomb, many, big, cut]) assert.deepEqual(await readdir(run.out).catch(() => []), []);
});
