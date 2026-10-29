import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSaved, readSaved } from '../lib/live.js';
import { StudyService } from '../lib/service.js';
import { assistantArgsRefusal } from '../lib/assistant-boundary.js';
import { LIVE_PROVIDER_TEXT, LIVE_RESUME_TEXT } from '../lib/live-local-install-text.js';
import { assistantDoors } from './helpers/assistant-door.mjs';

/* The guards around the local engine after the security gate review: removing it is refused while a class anywhere in this process uses it (one engine
   per DSH home, many libraries); the assistant cannot move a learner off the local engine (neither the saved choice nor one class); and a resumed
   class keeps the engine it was recorded with, or says why it cannot, instead of switching. */

const FREE = 'AIzaLiveFreeKey_00000000000000001';
const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/live-local/fake-sherpa.cjs', import.meta.url));
const loud = seconds => { const buffer = Buffer.alloc(Math.round(seconds * 16000) * 2); for (let i = 0; i < buffer.length / 2; i++) buffer.writeInt16LE(i % 32 < 16 ? 8000 : -8000, i * 2); return buffer; };

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'live-local-guards-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  const modelDir = join(dir, 'model');
  await mkdir(modelDir, { recursive: true });
  for (const name of ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']) await writeFile(join(modelDir, name), 'fake');
  const services = [];
  t.after(async () => {
    for (const service of services) {
      for (const item of await listSaved(service.store.root)) {
        const session = service.runtime.liveSessions.registered(service.store.root, item.id);
        if (session?.active) await session.stop();
        await session?.retirePersistence(); service.runtime.liveSessions.unregister(service.store.root, item.id);
      }
      await service.dispose?.();
    }
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const library = (name, { engine = true } = {}) => {
    const service = new StudyService(join(dir, name), { WebSocket: class { constructor() { throw new Error('the Gemini socket must not be opened'); } },
      liveLocal: { engine: engine ? { enginePath: FAKE_ENGINE, modelDir } : null } });
    services.push(service);
    return (action, args) => service.call(action, args);
  };
  return { dir, library };
}

test('removing the engine is refused while a class in another library of this process uses it', async t => {
  const h = await home(t);
  const first = h.library('first'), second = h.library('second');
  const started = await first('live.start', { title: 'Local class' });
  assert.equal(started.tier, 'local');
  await assert.rejects(second('live.local.uninstall', { confirm: true }), { code: 'live-running' });
  await first('live.stop', { id: started.id });
  await assert.rejects(second('live.local.uninstall', { confirm: true }), { code: 'not-ours' }, 'once the class ends only "nothing installed" is left');
});

test('a resumed class keeps its engine: local by default even when a Gemini key is set; if that engine is gone it says so instead of switching', async t => {
  const h = await home(t);
  const call = h.library('lib');
  const started = await call('live.start', { title: 'Local class' });
  assert.equal(started.engine, 'local');
  await call('live.audio', { id: started.id, data: loud(0.8).toString('base64') });
  const stopped = await call('live.stop', { id: started.id });
  assert.equal(stopped.engine, 'local');
  assert.equal((await readSaved(join(h.dir, 'lib'), started.id)).engine, 'local', 'the engine is saved with the class');
  await call('audio.settings.set', { freeKey: FREE });
  const resumed = await call('live.start', { resumeId: started.id });
  assert.equal(resumed.tier, 'local', 'auto would pick Gemini for a new class; a resumed class stays local');
  await call('live.stop', { id: started.id });
  const gone = h.library('lib', { engine: false });
  await assert.rejects(gone('live.start', { resumeId: started.id }), { message: LIVE_RESUME_TEXT.local });
});

test('the assistant boundary: no liveProvider in audio settings, and no live.start engine other than the learner\'s saved choice', () => {
  assert.match(assistantArgsRefusal('audio.settings.set', { liveProvider: 'gemini' }), /liveProvider.*not available to the assistant/);
  assert.equal(assistantArgsRefusal('audio.settings.set', { mode: 'VERBATIM' }), null);
  assert.match(assistantArgsRefusal('live.start', { provider: 'gemini' }, { liveProvider: 'local' }), /provider.*not available to the assistant/);
  assert.match(assistantArgsRefusal('live.start', { provider: 'local' }, { liveProvider: 'auto' }), /provider.*not available to the assistant/);
  assert.equal(assistantArgsRefusal('live.start', { provider: 'local' }, { liveProvider: 'local' }), null);
  assert.equal(assistantArgsRefusal('live.start', { title: 'x' }, { liveProvider: 'local' }), null);
});

test('through both doors: the assistant cannot switch local to Gemini; the learner\'s panel can', async t => {
  const h = await assistantDoors(t);
  await assert.rejects(h.assistant('audio.settings.set', { liveProvider: 'gemini' }), /not available to the assistant/);
  assert.equal((await h.panel('audio.settings.set', { liveProvider: 'local' })).liveProvider, 'local');
  await assert.rejects(h.assistant('live.start', { provider: 'gemini' }), /not available to the assistant/);
  // Without a provider the learner's own choice decides (here: local, not installed, so it says so).
  await assert.rejects(h.assistant('live.start', {}), { message: LIVE_PROVIDER_TEXT['local-not-ready'] });
  await assert.rejects(h.panel('live.start', { provider: 'gemini' }), new RegExp(LIVE_PROVIDER_TEXT['no-gemini-key'].slice(0, 20)));
});
