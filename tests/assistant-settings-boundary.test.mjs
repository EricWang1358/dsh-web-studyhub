import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { markerSettingsPath } from '../lib/marker-settings.js';
import { mineruInstallStatePath } from '../lib/mineru-install.js';
import { assistantDoors } from './helpers/assistant-door.mjs';
import { until } from './helpers/wait.mjs';

/* The Settings-only boundary of the assistant's study_workspace tool (S5-0 defect D-10, docs/plans/unified-job-runtime/s5-0-nonmodel-baseline.md).
   Choosing which program StudyHub runs, installing or removing software (Marker, the one-click local MinerU) and stopping the local MinerU service
   are the learner's own clicks in Settings. Status, plan and history reads, and the imports that use what the learner set up, stay with the
   assistant. The MinerU cloud route (its token and upload consent) was removed in 3.6: its operations no longer exist for either door. */

const exists = file => stat(file).then(() => true, () => false);
const finished = async (h, jobId) => until(async () => {
  const job = await h.assistant('job.wait', { jobId, timeoutSeconds: 30 });
  return !['queued', 'running', 'cancelling'].includes(job.status) && job;
}, `job ${jobId} to end`, { timeoutMs: 240_000, intervalMs: 0 });

const SETTINGS_ONLY = {
  'marker.settings.set': [{ command: process.execPath }],
  'marker.install.start': [{ confirm: true }],
  'marker.install.uninstall': [{ confirm: true }],
  'mineru.install.start': [{ confirm: true }, { confirm: true, location: 'D:\\StudyHub\\MinerU', tier: 'standard' }],
  'mineru.install.uninstall': [{ confirm: true }],
  'mineru.local.stop': [{}],
};

test('the assistant cannot choose the program StudyHub runs, install or uninstall software, or stop the local MinerU; nothing is written and nothing runs', async t => {
  const h = await assistantDoors(t, { mineru: { version: '4.0.10', total: 3, running: true, mode: 'managed', tier: 'basic', modelsReady: true } });
  for (const [action, payloads] of Object.entries(SETTINGS_ONLY))
    for (const args of [...payloads, undefined])
      await assert.rejects(h.assistant(action, args), /is not available to the assistant: .*the learner does (it|that) in Settings/, `${action} ${JSON.stringify(args)}`);
  // A payload that is not even JSON is refused the same way: the action name alone decides.
  for (const action of Object.keys(SETTINGS_ONLY))
    await assert.rejects(h.assistantRaw(action, '{not json'), /not available to the assistant/, action);
  assert.equal(await exists(markerSettingsPath()), false, 'no Marker program path was saved');
  assert.equal(await exists(mineruInstallStatePath()), false, 'no MinerU install was started');
  assert.equal(await exists(join(h.dirs.dshHome, 'studyhub', 'mineru')), false, 'no install folder was made');
  assert.equal((await h.mineruState()).running, true, 'the local MinerU service was not stopped');
  assert.deepEqual(await h.spawns(), [], 'no program was started');
  // The removed cloud route and the old setup flow are gone for the assistant too.
  for (const action of ['mineru.settings.set', 'mineru.settings.get', 'mineru.test', 'mineru.local.setup', 'mineru.local.setup.status'])
    await assert.rejects(h.assistant(action, {}), /Unknown|not available/i, action);
  // 检测并保存 asks marker.local.status about a path before it is saved: that start-a-program-of-my-choice form is the panel's, not the assistant's.
  for (const args of [{ command: process.execPath }, { command: '' }, { command: 42 }])
    await assert.rejects(h.assistant('marker.local.status', args), /marker\.local\.status with a command is not available to the assistant/, JSON.stringify(args));
  assert.deepEqual(await h.spawns(), [], 'asking about a path started nothing');
  // Stopping another MinerU on the way to a start is the learner's too (like mineru.local.stop); a plain start stays the assistant's (a conversion starts it anyway).
  for (const args of [{ stopExternal: true }, { restart: true, stopExternal: true }])
    await assert.rejects(h.assistant('mineru.local.start', args), /mineru\.local\.start with stopExternal is not available to the assistant: .*the learner does that in Settings/, JSON.stringify(args));
  assert.deepEqual(await h.spawns(), [], 'nothing was stopped or started');
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
  assert.equal((await h.assistant('mineru.install.status')).status, 'idle');
  const local = await h.assistant('mineru.local.status');
  assert.equal(local.state, 'needs-models', 'the local MinerU answered its read-only status');
  assert.equal(local.origin, 'env', 'the MinerU of MINERU_BIN, not an install of StudyHub');
  assert.equal((await h.assistant('mineru.plan', { path: h.files.pdf })).pages, 3);
  assert.ok(Array.isArray((await h.assistant('mineru.history.list')).records));
  const commands = (await h.spawns()).map(spawn => spawn.args.join(' '));
  assert.ok(commands.length > 0, 'the local status really asked the program');
  assert.deepEqual(commands.filter(command => !/^(--version|server status|config get )/.test(command)), [], 'only read-only MinerU commands ran');
  assert.equal((await h.mineruState()).mode, 'disabled');
  assert.equal(await exists(markerSettingsPath()), false);
  assert.equal(await exists(mineruInstallStatePath()), false);
  // A MinerU that is not set up is refused before anything is read, with the one place to fix it.
  await assert.rejects(h.assistant('mineru.import', { path: h.files.pdf }), /一键安装/);
  await assert.rejects(h.assistant('mineru.import', { path: h.files.pdf, route: 'cloud' }), /云端解析已停用/);
});

test('what the learner sets in Settings is what the assistant\'s imports use: the chosen Marker program converts, and the ready local MinerU parses', async t => {
  const h = await assistantDoors(t, { mineru: { version: '4.0.10', total: 3, running: true, mode: 'managed', tier: 'basic', modelsReady: true } });
  await h.panel('marker.settings.set', { command: h.program });
  assert.equal((await h.assistant('marker.local.status')).state, 'ready');
  const marker = await h.assistant('marker.import', { path: h.files.pdf, course: 'Probe' });
  assert.equal((await finished(h, marker.jobId)).status, 'complete');
  const conversions = (await h.spawns()).filter(spawn => spawn.role === 'marker' && spawn.args.includes('--page_range'));
  assert.equal(conversions.length, 1);
  assert.equal(conversions[0].program, h.program, 'the program the learner chose in Settings did the conversion');

  assert.equal((await h.assistant('mineru.local.status')).state, 'ready');
  // Without a route the import is local: the default that used to send a PDF to the cloud.
  const mineru = await h.assistant('mineru.import', { path: h.files.pdf, course: 'Probe' });
  assert.equal((await finished(h, mineru.jobId)).status, 'complete');
});
