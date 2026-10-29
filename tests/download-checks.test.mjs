import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadResumable } from '../lib/uv-bootstrap.js';
import { fakeFetch } from './helpers/live-local-fakes.mjs';
import { integrityOf } from './helpers/make-tgz.mjs';

/* The shared resumable download (lib/uv-bootstrap.js) used by the MinerU and local live engine installs: an npm integrity that is malformed, of
   another algorithm or wrong deletes the file; a pinned size caps the download; a full disk is 'no-space', not a network failure. */

const URL_ = 'https://files.test/pkg.tgz', BODY = Buffer.alloc(40_000, 4);
const exists = file => stat(file).then(() => true, () => false);
async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'download-checks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const net = fakeFetch(new Map([[URL_, BODY]]));
  return { dir, net, part: join(dir, 'pkg.tgz.part') };
}

test('a matching sha512 integrity passes; a malformed, other-algorithm or wrong one deletes the file', async t => {
  const h = await harness(t);
  assert.equal((await downloadResumable(URL_, h.part, { integrity: integrityOf(BODY), fetch: h.net.fetch })).bytes, BODY.length);
  await rm(h.part);
  const wrong = integrityOf(Buffer.from('something else'));
  for (const integrity of ['sha512-!!!not base64', `sha256-${wrong.slice(7)}`, wrong, 'sha512-', 'md5-abc']) {
    await assert.rejects(downloadResumable(URL_, h.part, { integrity, fetch: h.net.fetch }), { code: 'checksum' }, integrity);
    assert.equal(await exists(h.part), false, integrity);
  }
});

test('maxBytes caps the download: a body longer than its pinned size is stopped and deleted', async t => {
  const h = await harness(t);
  h.net.rules.set(URL_, { oversize: 10_000 });
  await assert.rejects(downloadResumable(URL_, h.part, { maxBytes: BODY.length, fetch: h.net.fetch }), { code: 'checksum' });
  assert.equal(await exists(h.part), false);
  h.net.rules.delete(URL_);
  assert.equal((await downloadResumable(URL_, h.part, { maxBytes: BODY.length, integrity: integrityOf(BODY), fetch: h.net.fetch })).bytes, BODY.length);
});

test('a full disk during the download is no-space (ENOSPC, EDQUOT); the part stays for a later try', async t => {
  const h = await harness(t);
  for (const failCode of ['ENOSPC', 'EDQUOT']) {
    h.net.rules.set(URL_, { failCode });
    await assert.rejects(downloadResumable(URL_, h.part, { fetch: h.net.fetch }), { code: 'no-space' }, failCode);
  }
  h.net.rules.set(URL_, { cutAfter: 1000 });
  await assert.rejects(downloadResumable(URL_, h.part, { fetch: h.net.fetch }), { code: 'network' });
});
