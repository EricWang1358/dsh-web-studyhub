import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLiveProvider } from '../lib/live-local.js';
import { providerStatus } from '../lib/audio-preflight.js';
import { saveAudioSettings, readAudioSettings } from '../lib/audio-settings.js';
import { LIVE_PROVIDER_TEXT } from '../lib/live-local-install-text.js';
import { listSaved } from '../lib/live.js';
import { StudyService } from '../lib/service.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';

/* Which engine a live class runs on (lib/live-local.js resolveLiveProvider), what the pre-flight says before the microphone is asked for, and live.start
   through the real service: the default stays Gemini for a learner with a key, the local engine is used where a learner without a key would be
   stuck, and an explicit choice is never silently replaced by the other engine. */

const FREE = 'AIzaLiveFreeKey_00000000000000001';
const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/live-local/fake-sherpa.cjs', import.meta.url));

test('the rules: auto keeps Gemini when there is a key, uses local only without a key; an explicit choice is kept or refused, never swapped', () => {
  const key = { freeKey: FREE }, none = {};
  const rows = [
    [none, false, undefined, { provider: null, reason: 'no-provider' }],
    [none, true, undefined, { provider: 'local' }],
    [key, false, undefined, { provider: 'gemini' }],
    [key, true, undefined, { provider: 'gemini' }],
    [{ ...key, liveProvider: 'local' }, true, undefined, { provider: 'local' }],
    [{ ...key, liveProvider: 'local' }, false, undefined, { provider: null, reason: 'local-not-ready' }],
    [{ liveProvider: 'gemini' }, true, undefined, { provider: null, reason: 'no-gemini-key' }],
    [key, true, 'local', { provider: 'local' }],
    [none, true, 'gemini', { provider: null, reason: 'no-gemini-key' }],
    [{ paidKey: FREE }, false, 'auto', { provider: 'gemini' }],
    [none, true, 'bogus', { provider: 'local' }],
  ];
  for (const [settings, localReady, asked, expected] of rows) {
    const got = resolveLiveProvider(settings, { localReady, asked });
    assert.equal(got.provider, expected.provider, JSON.stringify([settings, localReady, asked]));
    assert.equal(got.reason, expected.reason);
  }
  for (const reason of ['no-provider', 'local-not-ready', 'no-gemini-key']) assert.ok(LIVE_PROVIDER_TEXT[reason]);
});

test('the pre-flight: a learner without a key is offered the local engine; with it installed the live class is ready and says which engine', () => {
  const none = providerStatus({ textProvider: 'gemini' }, { liveLocal: { supported: true, ready: false } });
  assert.equal(none.live, false);
  assert.equal(none.liveProvider, null);
  assert.deepEqual(none.liveLocal, { supported: true, ready: false });
  const local = providerStatus({ textProvider: 'gemini' }, { liveLocal: { supported: true, ready: true } });
  assert.equal(local.live, true);
  assert.equal(local.liveProvider, 'local');
  const gemini = providerStatus({ freeKey: FREE, textProvider: 'gemini' }, { liveLocal: { supported: true, ready: true } });
  assert.equal(gemini.liveProvider, 'gemini');
  assert.equal(gemini.live, true);
  // Without any information about the local engine, the old answer stands.
  assert.equal(providerStatus({ freeKey: FREE, textProvider: 'gemini' }).live, true);
  assert.equal(providerStatus({ textProvider: 'gemini' }).live, false);
});

async function fixture(t, { engine = null, key = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'live-local-provider-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  const modelDir = join(dir, 'model');
  await import('node:fs/promises').then(fs => fs.mkdir(modelDir, { recursive: true }));
  for (const name of ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']) await writeFile(join(modelDir, name), 'fake');
  const service = new StudyService(join(dir, 'library'), {
    WebSocket: class { constructor() { throw new Error('the Gemini socket must not be opened'); } },
    liveLocal: { engine: engine === 'fake' ? { enginePath: FAKE_ENGINE, modelDir } : null } });
  t.after(async () => {
    for (const item of await listSaved(service.store.root)) {
      const session = service.runtime.liveSessions.registered(service.store.root, item.id);
      if (session?.active) await session.stop();
      await session?.retirePersistence(); service.runtime.liveSessions.unregister(service.store.root, item.id);
    }
    await service.dispose?.();
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  if (key) await service.call('audio.settings.set', { freeKey: FREE });
  return { service, call: (name, args) => service.call(name, args) };
}

test('liveProvider is a saved setting: auto, local or gemini', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'live-local-settings-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  assert.equal((await readAudioSettings()).liveProvider, 'auto');
  assert.equal((await saveAudioSettings({ liveProvider: 'local' })).liveProvider, 'local');
  await assert.rejects(saveAudioSettings({ liveProvider: 'cloud' }), /liveProvider/);
});

test('live.start without a key and without the local engine refuses in plain words before any socket or microphone', async t => {
  const h = await fixture(t);
  const preflight = await h.call('audio.preflight', {});
  assert.equal(preflight.live, false);
  assert.equal(preflight.liveLocal.ready, false);
  await assert.rejects(h.call('live.start', { title: 'No engine' }), { message: LIVE_PROVIDER_TEXT['no-provider'] });
});

test('live.start without a key uses the installed local engine: tier local, sentences arrive, no Gemini socket, nothing billed', async t => {
  const h = await fixture(t, { engine: 'fake' });
  const preflight = await h.call('audio.preflight', {});
  assert.equal(preflight.live, true);
  assert.equal(preflight.liveProvider, 'local');
  const started = await h.call('live.start', { title: 'Local class' });
  assert.equal(started.status, 'live');
  assert.equal(started.tier, 'local');
  const loud = Buffer.alloc(32_000 * 2);
  for (let i = 0; i < loud.length / 2; i++) loud.writeInt16LE(i % 32 < 16 ? 8000 : -8000, i * 2);
  await h.call('live.audio', { id: started.id, data: loud.subarray(0, 32_000).toString('base64') });
  await h.call('live.audio', { id: started.id, data: Buffer.alloc(19_200).toString('base64') });
  const ended = await h.call('live.stop', { id: started.id });
  assert.equal(ended.status, 'ended');
  assert.ok(ended.segments.length >= 1, 'the local engine wrote sentences');
  assert.equal(ended.usage.paidSeconds, 0);
});

test('a learner who chose local is never moved to Gemini, and one who chose Gemini is never moved to local', async t => {
  const h = await fixture(t, { key: true });
  await h.call('audio.settings.set', { liveProvider: 'local' });
  await assert.rejects(h.call('live.start', { title: 'Chose local' }), { message: LIVE_PROVIDER_TEXT['local-not-ready'] });
  const g = await fixture(t, { engine: 'fake' });
  await assert.rejects(g.call('live.start', { title: 'Chose Gemini', provider: 'gemini' }), { message: LIVE_PROVIDER_TEXT['no-gemini-key'] });
});

test('the install actions write no library field, and installing or removing the engine is the learner\'s own click', () => {
  for (const action of ['live.local.status', 'live.local.plan', 'live.local.install', 'live.local.cancel', 'live.local.uninstall']) assert.deepEqual(writesFor('audio', action), [], action);
  assert.match(assistantRefusal('live.local.install'), /installs or removes software/);
  assert.match(assistantRefusal('live.local.uninstall'), /installs or removes software/);
  assert.equal(assistantRefusal('live.local.status'), null);
});
