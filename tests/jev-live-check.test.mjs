import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FAKE_KEY, startFakeJev } from './helpers/fake-jev.mjs';

/* scripts/jev-live-check.mjs: the owner's few real, tiny round trips. Here it only ever meets the fake server. */

const script = fileURLToPath(new URL('../scripts/jev-live-check.mjs', import.meta.url));
function run(env, args = []) {
  return new Promise(resolve => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/JEV/.test(key)));
    const child = spawn(process.execPath, [script, ...args], { env: { ...clean, ...env } });
    let out = '';
    child.stdout.on('data', part => { out += part; }); child.stderr.on('data', part => { out += part; });
    child.on('close', code => resolve({ code, out }));
  });
}

test('without JEV_API_KEY it does nothing and says so', async () => {
  const result = await run({});
  assert.equal(result.code, 0);
  assert.match(result.out, /JEV_API_KEY is not set: nothing was done/);
});

test('with a key it checks it, sends the three question types and Chinese text, and reports each assumption without printing the key', async t => {
  const fake = await startFakeJev();
  t.after(() => fake.close());
  const result = await run({ JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /OK\s+key check: the key is valid/);
  assert.match(result.out, /OK\s+one request with a noul, a choice and a score question was accepted/);
  assert.match(result.out, /OK\s+choice: "/);
  assert.match(result.out, /OK\s+usage reported/);
  assert.match(result.out, /OK\s+Chinese text accepted/);
  assert.ok(!result.out.includes(FAKE_KEY));
  assert.equal(fake.requests.length, 3);
  assert.ok(fake.requests.every(request => request.headers.authorization === `Bearer ${FAKE_KEY}`));
  const sent = fake.requests.map(request => request.body).join(' ');
  assert.ok(!/study|library|lecture/i.test(sent.replace(/running shoes/g, '')), 'only made-up sentences');
});

test('--check-only makes one request; a bad key is reported and stops', async t => {
  const fake = await startFakeJev();
  t.after(() => fake.close());
  const only = await run({ JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: fake.baseUrl }, ['--check-only']);
  assert.equal(only.code, 0, only.out);
  assert.equal(fake.requests.length, 1);
  fake.requests.length = 0;
  const bad = await run({ JEV_API_KEY: 'a_wrong_key_00000000000000000', JEV_BASE_URL: fake.baseUrl });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /FAIL\s+key check: invalid-key \(HTTP 401\)/);
  assert.equal(fake.requests.length, 1, 'nothing further is sent after a bad key');
});
