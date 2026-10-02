import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_KEY, FAKE_PATHS, startFakeJev } from './helpers/fake-jev.mjs';
import { oracleAnswer } from './helpers/jev-oracle.mjs';

/* scripts/jev-live-check.mjs and scripts/eval-jev.mjs take --provider. With an OpenCode preset the key comes from the variable the
   preset names (OPENCODE_GO_API_KEY_2 by default, --key-env to change it), never from a file or the DSH home, and the scripts only
   ever meet the fake server here. */

const live = fileURLToPath(new URL('../scripts/jev-live-check.mjs', import.meta.url));
const evaluation = fileURLToPath(new URL('../scripts/eval-jev.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/jev-eval/dataset.json', import.meta.url));
const dataset = JSON.parse(await readFile(fixture, 'utf8'));
function run(script, args, env = {}) {
  return new Promise(resolve => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/JEV|API_KEY|BASE_URL|OPENCODE|MY_ZEN/.test(key)));
    const child = spawn(process.execPath, [script, ...args], { env: { ...clean, ...env } });
    let out = ''; child.stdout.on('data', part => { out += part; }); child.stderr.on('data', part => { out += part; });
    child.on('close', code => resolve({ code, out }));
  });
}

test('live check with an OpenCode preset: reads OPENCODE_GO_API_KEY_2, asks the Zen path with the preset model, prints neither key nor body', async t => {
  const fake = await startFakeJev();
  t.after(() => fake.close());
  const result = await run(live, ['--provider', 'opencode-zen-free'], { OPENCODE_GO_API_KEY_2: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /OK\s+key check: the key is valid/);
  assert.match(result.out, /OK\s+Chinese text accepted/);
  assert.match(result.out, /jev-1\.13-free/);
  assert.ok(!result.out.includes(FAKE_KEY));
  assert.equal(fake.requests.length, 3);
  for (const request of fake.requests) {
    assert.equal(request.path, FAKE_PATHS.opencode);
    assert.equal(request.payload.model, 'jev-1.13-free');
    assert.equal(request.headers.authorization, `Bearer ${FAKE_KEY}`);
  }
});

test('live check: the paid preset asks for jev-1.13; --key-env names another variable; a bad key stops after one request', async t => {
  const fake = await startFakeJev();
  t.after(() => fake.close());
  const paid = await run(live, ['--provider', 'opencode-zen', '--key-env', 'MY_ZEN_KEY', '--check-only'], { MY_ZEN_KEY: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(paid.code, 0, paid.out);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].payload.model, 'jev-1.13');
  fake.requests.length = 0;
  const bad = await run(live, ['--provider', 'opencode-zen'], { OPENCODE_GO_API_KEY_2: 'a_wrong_zen_key_0000000000000000WRNG', JEV_BASE_URL: fake.baseUrl });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /FAIL\s+key check: invalid-key \(HTTP 401\)/);
  assert.equal(fake.requests.length, 1);
});

test('live check without the variable does nothing and names the variable it looked for; TypeSafe still says JEV_API_KEY; an unknown provider is refused', async t => {
  const fake = await startFakeJev();
  t.after(() => fake.close());
  const none = await run(live, ['--provider', 'opencode-zen-free'], { JEV_BASE_URL: fake.baseUrl, JEV_API_KEY: FAKE_KEY });
  assert.equal(none.code, 0);
  assert.match(none.out, /OPENCODE_GO_API_KEY_2 is not set: nothing was done/);
  assert.equal(fake.requests.length, 0, 'JEV_API_KEY is a TypeSafe key and is not sent to OpenCode');
  const typesafe = await run(live, [], {});
  assert.match(typesafe.out, /JEV_API_KEY is not set: nothing was done/);
  const unknown = await run(live, ['--provider', 'nope'], { JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(unknown.code, 2);
  assert.match(unknown.out, /typesafe, opencode-zen-free, opencode-zen/);
  assert.equal(fake.requests.length, 0);
});

test('the default provider of the live check is unchanged: TypeSafe path, model alias, JEV_API_KEY', async t => {
  const fake = await startFakeJev();
  t.after(() => fake.close());
  const result = await run(live, ['--check-only'], { JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(result.code, 0, result.out);
  assert.equal(fake.requests[0].path, FAKE_PATHS.typesafe);
  assert.equal(fake.requests[0].payload.model, 'jev-latest');
});

test('the evaluation script takes --provider: Zen path and model, key from the preset variable, nothing printed but the report', async t => {
  const fake = await startFakeJev({ answer: oracleAnswer(dataset) });
  t.after(() => fake.close());
  const result = await run(evaluation, [fixture, '--provider', 'opencode-zen-free', '--features', 'levelCheck'], { OPENCODE_GO_API_KEY_2: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /levelCheck/);
  assert.ok(!result.out.includes(FAKE_KEY));
  assert.ok(fake.requests.length > 5);
  assert.ok(fake.requests.every(request => request.path === FAKE_PATHS.opencode && request.payload.model === 'jev-1.13-free' && request.headers.authorization === `Bearer ${FAKE_KEY}`));
});

test('the evaluation script: without the preset variable it does nothing; an unknown provider is refused; a dataset of your own needs --yes and the refusal names OpenCode', async t => {
  const fake = await startFakeJev({ answer: oracleAnswer(dataset) });
  const dir = await mkdtemp(join(tmpdir(), 'jev-eval-provider-'));
  t.after(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });
  const none = await run(evaluation, [fixture, '--provider', 'opencode-zen'], { JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(none.code, 0);
  assert.match(none.out, /OPENCODE_GO_API_KEY_2 is not set: nothing was done/);
  const unknown = await run(evaluation, [fixture, '--provider', 'nope'], { OPENCODE_GO_API_KEY_2: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(unknown.code, 2);
  assert.equal(fake.requests.length, 0);
  const own = join(dir, 'mine.json');
  await writeFile(own, JSON.stringify(dataset));
  const refused = await run(evaluation, [own, '--provider', 'opencode-zen-free'], { OPENCODE_GO_API_KEY_2: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(refused.code, 2);
  assert.match(refused.out, /OpenCode/);
  assert.match(refused.out, /--yes/);
  assert.equal(fake.requests.length, 0, 'nothing was sent before the confirmation');
});
