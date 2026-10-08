import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIO_DEFAULTS, publicAudioSettings, readAudioSettings, saveAudioSettings } from '../lib/audio-settings.js';

/* 「只用付费密钥」 on the audio form starts from the learner's default (Settings > 音频转写). The default is a personal preference kept with the other
   audio settings, off until chosen; the import itself still receives the explicit paidOnly of the form, so nothing else reads this value. */

async function inTemporaryHome(run) {
  const dir = await mkdtemp(join(tmpdir(), 'audio-paid-default-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try { await run(); } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('the paid-key default is off, can be turned on and off, and only a boolean is accepted', () => inTemporaryHome(async () => {
  assert.equal(AUDIO_DEFAULTS.paidOnlyByDefault, false);
  assert.equal((await readAudioSettings()).paidOnlyByDefault, false);
  assert.equal(publicAudioSettings(await saveAudioSettings({ paidOnlyByDefault: true })).paidOnlyByDefault, true);
  assert.equal((await readAudioSettings()).paidOnlyByDefault, true, 'kept in the audio settings file');
  assert.equal((await saveAudioSettings({ partMinutes: 45 })).paidOnlyByDefault, true, 'another setting changing leaves it alone');
  assert.equal((await saveAudioSettings({ paidOnlyByDefault: false })).paidOnlyByDefault, false);
  await assert.rejects(saveAudioSettings({ paidOnlyByDefault: 'yes' }), /true 或 false/);
}));
