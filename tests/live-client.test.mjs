import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PCM_WORKLET_SOURCE } from '../ui/live-audio.js';
import { LiveClient, mergeLiveSnapshot } from '../ui/live-client.js';
import { LiveAudioHealth, audioInputStatus } from '../ui/live-audio-health.js';

test('input diagnostics distinguish silence, audio loss, pause, mute and upload acknowledgment', () => {
  let now = 0;
  const health = new LiveAudioHealth(() => now);
  health.reset('microphone', 'running');
  const silent = new ArrayBuffer(3200);
  now = 100; health.frame(silent);
  assert.equal(health.state.capturedMs, 100);
  assert.equal(health.state.acceptedMs, 0, 'capturing is not proof of upload');
  now = 3200; health.frame(silent);
  assert.equal(audioInputStatus(health.state, now), 'quiet');
  const sound = new ArrayBuffer(3200), view = new DataView(sound);
  for (let offset = 0; offset < sound.byteLength; offset += 2) view.setInt16(offset, -8192, true);
  health.frame(sound);
  assert.ok(health.state.level > 60);
  assert.equal(audioInputStatus(health.state, now), 'sound');
  health.acknowledge(3200);
  assert.equal(health.state.acceptedMs, 100);
  now += 1600;
  assert.equal(audioInputStatus(health.state, now), 'missing');
  health.update({ muted: true });
  assert.equal(audioInputStatus(health.state, now), 'muted');
  health.phase('paused'); health.frame(sound);
  assert.equal(health.state.level, 0);
  assert.equal(health.state.capturedMs, 300);
  health.update({ muted: false, context: 'suspended' }); health.phase('running');
  assert.equal(audioInputStatus(health.state, now), 'suspended');
  health.phase('stopped');
  assert.equal(audioInputStatus(health.state, now), 'stopped');
});

test('streaming PCM is 16 kHz little endian, independent of capture block boundaries', () => {
  for (const rate of [16000, 44100, 48000]) {
    const chunks = [];
    let Processor;
    runInNewContext(PCM_WORKLET_SOURCE, {
      sampleRate: rate,
      AudioWorkletProcessor: class { port = { postMessage: (bytes) => { if (typeof bytes !== 'string') chunks.push(bytes); } }; },
      registerProcessor: (_name, constructor) => { Processor = constructor; },
    });
    const processor = new Processor();
    const input = new Float32Array(rate).fill(-1);
    for (let i = 0; i < input.length; i += 128) processor.process([[input.subarray(i, i + 128)]]);
    processor.port.onmessage({ data: 'flush' });
    assert.equal(chunks.reduce((n, bytes) => n + bytes.byteLength, 0), 32000);
    assert.equal(new DataView(chunks[0]).getInt16(0, true), -32768);
    assert.ok(chunks.every((bytes) => bytes.byteLength <= 3200));
  }
});

test('poll patches replace translations while retaining earlier sentences and selection identity', () => {
  const before = { id: 'class', segments: [{ id: 1, en: 'One', zh: '' }, { id: 2, en: 'Two' }], revision: 2 };
  const after = mergeLiveSnapshot(before, { id: 'class', segments: [{ id: 1, en: 'One', zh: '一' }], revision: 3 });
  assert.equal(after.segments.length, 2);
  assert.equal(after.segments[0].zh, '一');
  assert.equal(mergeLiveSnapshot(after, { id: 'other', segments: [], revision: 0 }).segments.length, 0);
});

test('permission failure never opens a billable session; backend failure releases microphone', async () => {
  let calls = 0, stops = 0;
  const denied = new LiveClient(async () => { calls++; }, { capture: async () => { throw new Error('Permission denied'); } });
  await assert.rejects(denied.start('microphone', {}), /Permission denied/);
  assert.equal(calls, 0);
  const refused = new LiveClient(async () => { throw new Error('No key'); }, { capture: async () => ({ stop: async () => { stops++; } }) });
  await assert.rejects(refused.start('microphone', {}), /No key/);
  assert.equal(stops, 1);
});

test('audio delivery is ordered and ending drains audio before ending the server session', async () => {
  const actions = []; let emit;
  const client = new LiveClient(async (action) => {
    actions.push(action);
    if (action === 'live.start') return { id: 'test-session', status: 'live', segments: [], revision: 0 };
    if (action === 'live.stop') return { id: 'test-session', status: 'ended', segments: [], revision: 0 };
    return { status: 'live' };
  }, { capture: async (_kind, onAudio) => { emit = onAudio; return { stop: async () => {}, pause() {} }; } });
  await client.start('microphone', {});
  emit(new ArrayBuffer(3200)); emit(new ArrayBuffer(3200));
  await client.stop();
  assert.deepEqual(actions, ['live.start', 'live.audio', 'live.audio', 'live.stop']);
  assert.equal(client.getSnapshot().capturing, false);
  client.dispose();
});

test('a delayed poll cannot revive an ended session', async () => {
  let release;
  const client = new LiveClient(async (action) => action === 'live.poll' ? new Promise(resolve => { release = resolve; }) :
    { id: 'same', status: 'ended', revision: 2, segments: [{ id: 1, en: 'Final' }] });
  client.update({ session: { id: 'same', status: 'live', revision: 1, segments: [] } });
  const poll = client.poll(); await client.stop();
  release({ id: 'same', status: 'live', revision: 1, segments: [] }); await poll;
  assert.equal(client.getSnapshot().session.status, 'ended');
  assert.equal(client.getSnapshot().session.revision, 2);
});

test('ending browser sharing during connection cancels the eventual session', async () => {
  let release, ended, stopped = 0, serverStopped = 0;
  const client = new LiveClient(async (action) => {
    if (action === 'live.start') return new Promise(resolve => { release = resolve; });
    if (action === 'live.stop') { serverStopped++; return { id: 'pending', status: 'ended', segments: [] }; }
  }, { capture: async (_kind, _send, onEnded) => { ended = onEnded; return { stop: async () => { stopped++; } }; } });
  const starting = client.start('tab', {});
  await new Promise(resolve => setTimeout(resolve, 0));
  ended();
  release({ id: 'pending', status: 'live', segments: [] }); await starting;
  assert.equal(client.getSnapshot().capturing, false);
  assert.ok(stopped > 0); assert.equal(serverStopped, 1);
});

test('polling waits while pause or stop is changing session state', async () => {
  for (const operation of ['pause', 'stop']) {
    let release, polls = 0;
    const client = new LiveClient(async action => {
      if (action === 'live.poll') { polls++; return { id: 'same', status: 'paused', revision: 2, segments: [] }; }
      return new Promise(resolve => { release = resolve; });
    });
    client.update({ session: { id: 'same', status: 'live', revision: 1, segments: [] } });
    const changing = client[operation]();
    await new Promise(resolve => setTimeout(resolve, 0));
    await client.poll();
    assert.equal(polls, 0);
    release({ id: 'same', status: operation === 'stop' ? 'ended' : 'paused', revision: 2, segments: [] });
    await changing;
    assert.equal(client.getSnapshot().session.status, operation === 'stop' ? 'ended' : 'paused');
    assert.equal(client.getSnapshot().busy, false);
  }
});
