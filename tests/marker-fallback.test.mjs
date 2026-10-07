import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { effectiveMarkerSettings, markerInstallStatePath, venvLayout, MARKER_INSTALL } from '../lib/marker-install.js';
import { markerSettingsPath, saveMarkerSettings } from '../lib/marker-settings.js';

// Found on the owner's machine (3.0.0): Marker installed by StudyHub (F:\StudyHub-Marker), its path field empty, 检测并保存 said "没有通过" because the empty path only looks in PATH.
// An empty saved path means "find it for me": that includes the environment StudyHub made itself, while it is still there. An explicit path never falls back.
async function home(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'study-marker-fallback-'));
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = path.join(root, 'home');
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return root;
}
let counter = 0;
async function install(root, { sentinel = true, program = true, state = {} } = {}) {
  const folder = path.join(root, `marker-env-${++counter}`), layout = venvLayout(folder);
  await mkdir(layout.bin, { recursive: true });
  if (sentinel) await writeFile(layout.sentinel, JSON.stringify({ createdBy: 'studyhub-marker-installer' }));
  if (program) await writeFile(layout.marker, '');
  await mkdir(path.dirname(markerInstallStatePath()), { recursive: true });
  await writeFile(markerInstallStatePath(), JSON.stringify({ version: 1, status: 'complete', stage: 'done', folder, installedFolder: folder, command: layout.marker, ...state }));
  return layout;
}

test('an empty saved path uses the Marker StudyHub installed, while it is still there', async (t) => {
  const root = await home(t), layout = await install(root);
  await saveMarkerSettings({ command: '' });
  assert.deepEqual(await effectiveMarkerSettings(), { command: layout.marker });
});

test('an explicit saved path always wins and never falls back, even to a path that does not exist', async (t) => {
  const root = await home(t); await install(root);
  const other = path.join(root, 'elsewhere', 'marker_single');
  await saveMarkerSettings({ command: other });
  assert.deepEqual(await effectiveMarkerSettings(), { command: other });
});

test('nothing is invented: no install, a removed program or a folder that is not ours leave the path empty', async (t) => {
  const root = await home(t);
  assert.deepEqual(await effectiveMarkerSettings(), { command: '' }, 'no install state at all');
  await install(root, { program: false });
  assert.deepEqual(await effectiveMarkerSettings(), { command: '' }, 'the program is gone');
  await install(root, { sentinel: false });
  assert.deepEqual(await effectiveMarkerSettings(), { command: '' }, 'the folder carries no StudyHub marker file');
  await writeFile(markerSettingsPath(), '{ not json');
  await install(root, { state: { installedFolder: '' } });
  assert.deepEqual(await effectiveMarkerSettings(), { command: '' }, 'nothing was installed');
  assert.ok(MARKER_INSTALL.sentinel);
});
