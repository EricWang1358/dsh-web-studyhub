import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinEnvironment, createStudyRuntime } from '../lib/runtime/builtins.js';
import { StudyRuntime } from '../lib/runtime.js';
import { LiveSession, register, unregister } from '../lib/live.js';
import { Store } from '../lib/store.js';

test('audio-only saves and reads transcripts without writing absent material or question contexts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-audio-v2-'));
  const session = new LiveSession({ id: 'standalone-audio', title: 'Independent class', saved: {
    segments: [{ id: 1, t: 0, en: 'Bridge separates independent dimensions.', zh: '桥接模式分离独立维度。', zhState: 'done' }],
  } });
  register(root, session);
  t.after(async () => { unregister(root, session.id); await rm(root, { recursive: true, force: true }); });
  const runtime = createStudyRuntime(root, { contexts: ['audio'] });
  const receipt = await runtime.call('live.save', { id: session.id });
  assert.equal(receipt.sourceIds.length, 1);
  const results = await runtime.call('audio.results');
  assert.equal(results.results.length, 1);
  assert.match(results.results[0].text, /Bridge separates/);
  const persisted = await new Store(root).read();
  assert.equal(persisted.sources.length, 0);
  assert.equal(persisted.decks.length, 0);
  assert.equal(persisted.audioResults.length, 1);
});

test('audio publication uses the material capability present when its locked save completes', async t => {
  for (const initiallyInstalled of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'study-audio-capability-'));
    const runtime = new StudyRuntime(root), environment = createBuiltinEnvironment(root, runtime);
    environment.install('audio');
    let disposeMaterials = initiallyInstalled ? environment.install('materials') : null;
    const session = new LiveSession({ id: `dynamic-${initiallyInstalled}`, title: 'Dynamic class', saved: {
      segments: [{ id: 1, t: 0, en: 'Public APIs preserve ownership.', zh: '公开 API 保持能力归属。', zhState: 'done' }],
    } });
    register(root, session);
    t.after(async () => { runtime.dispose(); unregister(root, session.id); await rm(root, { recursive: true, force: true }); });
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const locked = new Promise(resolve => { entered = resolve; });
    const lock = new Store(root).update(async () => { entered(); await held; });
    await locked;
    const pending = runtime.call('live.save', { id: session.id });
    await new Promise(resolve => setTimeout(resolve, 40));
    if (disposeMaterials) disposeMaterials();
    else disposeMaterials = environment.install('materials');
    release(); await lock;
    await pending;
    const state = await new Store(root).read();
    assert.equal(state.audioResults.length, 1);
    assert.equal(state.sources.length, initiallyInstalled ? 0 : 1);
  }
});
