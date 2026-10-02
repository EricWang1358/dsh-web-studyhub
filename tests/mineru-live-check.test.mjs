import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FAKE_TOKEN, startFakeMineru } from './helpers/fake-mineru.mjs';

/* scripts/mineru-live-check.mjs: the owner's one real round trip. Here it only ever meets the fake server. */

const script = fileURLToPath(new URL('../scripts/mineru-live-check.mjs', import.meta.url));
function run(env, args = []) {
  return new Promise(resolve => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/MINERU/.test(key)));
    const child = spawn(process.execPath, [script, ...args], { env: { ...clean, ...env } });
    let out = '';
    child.stdout.on('data', part => { out += part; }); child.stderr.on('data', part => { out += part; });
    child.on('close', code => resolve({ code, out }));
  });
}

test('without MINERU_API_KEY it does nothing and says so', async () => {
  const result = await run({});
  assert.equal(result.code, 0);
  assert.match(result.out, /MINERU_API_KEY is not set: nothing was done/);
});

test('with a token it checks it, converts a tiny synthetic PDF, and reports each assumption without printing the token', async t => {
  const fake = await startFakeMineru({ steps: 1 });
  t.after(() => fake.close());
  const result = await run({ MINERU_API_KEY: FAKE_TOKEN, MINERU_BASE_URL: fake.baseUrl, MINERU_LIVE_POLL_MS: '5' });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /OK\s+token check/);
  assert.match(result.out, /OK\s+raw PUT/);
  assert.match(result.out, /OK\s+poll states seen: pending -> running -> done/);
  assert.match(result.out, /OK\s+pages in the result: 2/);
  assert.match(result.out, /reads it as 2 pages/);
  assert.ok(!result.out.includes(FAKE_TOKEN));
  assert.equal(fake.uploads.length, 1);
  assert.equal(fake.uploads[0].headers.authorization, undefined);
});

test('--check-only makes one request and uploads nothing; a bad token fails clearly', async t => {
  const fake = await startFakeMineru();
  t.after(() => fake.close());
  const good = await run({ MINERU_API_KEY: FAKE_TOKEN, MINERU_BASE_URL: fake.baseUrl }, ['--check-only']);
  assert.equal(good.code, 0, good.out);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.batches.size, 0);
  const bad = await run({ MINERU_API_KEY: 'eyJ0eXBlIjoiSldUIn0.WRONG_wrong_wrong_0000000000000.sig', MINERU_BASE_URL: fake.baseUrl }, ['--check-only']);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /FAIL\s+token check: invalid-token/);
});
