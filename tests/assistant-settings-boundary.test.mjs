import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { markerSettingsPath } from '../lib/marker-settings.js';
import { mineruSettingsPath } from '../lib/mineru-settings.js';
import { assistantDoors } from './helpers/assistant-door.mjs';
import { until } from './helpers/wait.mjs';

/* The Settings-only boundary of the assistant's study_workspace tool (S5-0 defect D-10, docs/plans/unified-job-runtime/s5-0-nonmodel-baseline.md).
   Choosing which program StudyHub runs, installing or removing software, downloading models into the local MinerU and switching it on, and storing
   the MinerU token or the consent to upload PDFs are the learner's own clicks in Settings. Before this boundary the assistant could do all of them:
   save any absolute program path that the next marker.import ran, store a token with the upload consent, and set up local MinerU with its own
   confirm: true. Status, plan and history reads, and the imports that use what the learner configured, stay with the assistant. */

const exists = file => stat(file).then(() => true, () => false);
const finished = async (h, jobId) => until(async () => {
  const job = await h.assistant('job.wait', { jobId, timeoutSeconds: 30 });
  return !['queued', 'running', 'cancelling'].includes(job.status) && job;
}, `job ${jobId} to end`, { timeoutMs: 240_000, intervalMs: 0 });

const SETTINGS_ONLY = {
  'marker.settings.set': [{ command: process.execPath }],
  'marker.install.start': [{ confirm: true }],
  'marker.install.uninstall': [{ confirm: true }],
  'mineru.settings.set': [{ token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcm9iZSJ9.not-a-real-token', acknowledge: true }, { acknowledge: true }],
  'mineru.local.setup': [{ tier: 'basic', confirm: true }, { tier: 'standard', confirm: true }],
};

test('the assistant cannot choose the program StudyHub runs, install software, set up local MinerU or store the MinerU token and consent; nothing is written and nothing runs', async t => {
  const h = await assistantDoors(t);
  for (const [action, payloads] of Object.entries(SETTINGS_ONLY))
    for (const args of [...payloads, undefined])
      await assert.rejects(h.assistant(action, args), /is not available to the assistant: .*the learner does (it|that) in Settings/, `${action} ${JSON.stringify(args)}`);
  // A payload that is not even JSON is refused the same way: the action name alone decides.
  for (const action of Object.keys(SETTINGS_ONLY))
    await assert.rejects(h.assistantRaw(action, '{not json'), /not available to the assistant/, action);
  assert.equal(await exists(markerSettingsPath()), false, 'no Marker program path was saved');
  assert.equal(await exists(mineruSettingsPath()), false, 'no MinerU token or consent was saved');
  assert.equal((await h.mineruState()).mode, 'disabled', 'local MinerU was not switched on');
  assert.deepEqual(await h.spawns(), [], 'no program was started');
  // 检测并保存 asks marker.local.status about a path before it is saved: that start-a-program-of-my-choice form is the panel's, not the assistant's.
  for (const args of [{ command: process.execPath }, { command: '' }, { command: 42 }])
    await assert.rejects(h.assistant('marker.local.status', args), /marker\.local\.status with a command is not available to the assistant/, JSON.stringify(args));
  assert.deepEqual(await h.spawns(), [], 'asking about a path started nothing');
  // With no program chosen, Marker is simply not found: nothing the assistant sent was kept.
  assert.equal((await h.assistant('marker.local.status')).state, 'not-installed');
  await assert.rejects(h.assistant('marker.import', { path: h.files.pdf }), /Marker/);
  assert.ok((await h.spawns()).every(spawn => spawn.role !== 'marker'), 'no Marker program ran');
});

test('status, plan and history reads stay with the assistant, and they only read', async t => {
  const h = await assistantDoors(t);
  assert.deepEqual(await h.assistant('marker.settings.get'), { command: '' });
  assert.equal((await h.assistant('marker.local.status')).state, 'not-installed');
  assert.equal((await h.assistant('marker.install.status')).status, 'idle');
  assert.equal((await h.assistant('mineru.settings.get')).acknowledged, false);
  const local = await h.assistant('mineru.local.status');
  assert.equal(local.state, 'needs-models', 'the local MinerU answered its read-only status');
  assert.equal(local.next, 'enable');
  assert.equal((await h.assistant('mineru.local.setup.status')).status, 'idle');
  assert.equal((await h.assistant('mineru.plan', { path: h.files.pdf })).pages, 3);
  assert.ok(Array.isArray((await h.assistant('mineru.history.list')).records));
  const commands = (await h.spawns()).map(spawn => spawn.args.join(' '));
  assert.ok(commands.length > 0, 'the local status really asked the program');
  assert.deepEqual(commands.filter(command => !/^(--version|server status|config get )/.test(command)), [], 'only read-only MinerU commands ran');
  assert.equal((await h.mineruState()).mode, 'disabled');
  assert.equal(await exists(markerSettingsPath()), false);
  assert.equal(await exists(mineruSettingsPath()), false);
});

test('what the learner sets in Settings is what the assistant\'s imports use: the chosen Marker program converts, and the confirmed local MinerU parses', async t => {
  const h = await assistantDoors(t);
  await h.panel('marker.settings.set', { command: h.program });
  assert.equal((await h.assistant('marker.local.status')).state, 'ready');
  const marker = await h.assistant('marker.import', { path: h.files.pdf, course: 'Probe' });
  assert.equal((await finished(h, marker.jobId)).status, 'complete');
  const conversions = (await h.spawns()).filter(spawn => spawn.role === 'marker' && spawn.args.includes('--page_range'));
  assert.equal(conversions.length, 1);
  assert.equal(conversions[0].program, h.program, 'the program the learner chose in Settings did the conversion');

  await assert.rejects(h.panel('mineru.local.setup', { tier: 'basic' }), /确认/, 'Settings still asks the learner to confirm the download');
  assert.equal((await h.panel('mineru.local.setup', { tier: 'basic', confirm: true })).status, 'running');
  await until(async () => (await h.panel('mineru.local.setup.status')).status !== 'running', 'the local setup', { timeoutMs: 120_000 });
  assert.equal((await h.mineruState()).mode, 'managed');
  const mineru = await h.assistant('mineru.import', { path: h.files.pdf, route: 'local', course: 'Probe' });
  assert.equal((await finished(h, mineru.jobId)).status, 'complete');
});
