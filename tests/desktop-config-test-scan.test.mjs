import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDesktopHost } from '../packages/studyhub-desktop/application/desktop-host.js';
import { createProviderDiscovery } from '../packages/studyhub-desktop/application/provider-discovery.js';
import { createInProcessJobExecutor } from '../packages/studyhub-desktop/adapters/runtime/job-executor.mjs';
import { createConfigStore } from '../packages/studyhub-desktop/adapters/storage/config-store.mjs';
import { registerHostConcurrencyCap } from '../lib/generation-settings.js';

// 「测试连通」 on the local agy took 39 s, and the provider scan it ran first added more on top: a full scan runs every CLI's
// `--version`, `agy models`, `codex login status` and `codex debug models` (measured 5.9 s on the owner's machine). The scan
// cache lives 30 s and one agy test takes about 40 s, so every test after the first paid that scan again before the model was asked.
// The test only needs a scan to find a ready CLI's path when it has none; the last scan answers that however old it is.

async function hostWithCountingScan(t, { warm, installed = () => true }) {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-desktop-test-scan-'));
  t.after(async () => {
    registerHostConcurrencyCap(null);
    await rm(work, { recursive: true, force: true });
  });
  const env = { ...process.env, DSH_HOME: join(work, 'dsh-home') };
  const configStore = createConfigStore({ env, home: join(work, 'home'), documentsDir: join(work, 'Documents') });
  let clock = 1_000_000;
  const probes = { version: 0, agyModels: 0 };
  const providerDiscovery = createProviderDiscovery({
    listCandidates: async (id) => (id === 'agy' && installed() ? ['C:\\fake\\agy.exe'] : []),
    probeVersion: async () => { probes.version += 1; return { ok: true, version: '1.5.18', reason: '' }; },
    listAgyModels: async () => { probes.agyModels += 1; return { ok: true, unauthenticated: false, models: [], reason: '' }; },
    now: () => clock,
  });
  const asked = [];
  const host = await createDesktopHost({
    configStore,
    providerDiscovery,
    openaiComplete: () => undefined,
    agyComplete: () => undefined,
    jobExecutor: createInProcessJobExecutor(),
    openExternal: async () => ({ ok: true }),
    ensureDir: (p) => mkdir(p, { recursive: true }),
    injectedComplete: async (system, prompt) => { asked.push({ system, prompt }); return 'OK'; },
  });
  t.after(() => host.dispose());
  if (warm) {
    const settings = await host.call('desktop.config.get', {});
    assert.equal(settings.ok, true);
  }
  return { host, probes, asked, advance: (ms) => { clock += ms; } };
}

test('desktop.config.test does not run the CLI scan again when an earlier scan is only older than its 30 s cache', async (t) => {
  const { host, probes, asked, advance } = await hostWithCountingScan(t, { warm: true });
  const before = { ...probes };
  assert.equal(before.agyModels, 1, 'opening Settings scanned once');

  advance(45_000); // a first agy test took ~40 s: the scan cache is stale by the time of the next click
  const tested = await host.call('desktop.config.test', { mode: 'agy', agy: { executablePath: 'C:\\fake\\agy.exe', model: '', effort: '' } });

  assert.equal(tested.ok, true);
  assert.equal(tested.value.ok, true);
  assert.equal(asked.length, 1, 'the model was asked once');
  assert.deepEqual(probes, before, 'no `--version` / `agy models` probe ran before the test');
});

test('desktop.config.test still scans once when nothing was scanned yet, so a draft with no path can find the ready CLI', async (t) => {
  const { host, probes, asked } = await hostWithCountingScan(t, { warm: false });

  const tested = await host.call('desktop.config.test', { mode: 'agy' });

  assert.equal(tested.ok, true);
  assert.equal(tested.value.ok, true);
  assert.equal(asked.length, 1);
  assert.equal(probes.agyModels, 1, 'exactly one scan, before the test');
});

test('desktop.config.test looks again when the earlier scan found no ready CLI: one installed since is picked up', async (t) => {
  let there = false;
  const { host, probes, asked, advance } = await hostWithCountingScan(t, { warm: true, installed: () => there });
  assert.equal(probes.agyModels, 0, 'nothing to probe while it was not installed');

  there = true;
  advance(45_000);
  const tested = await host.call('desktop.config.test', { mode: 'agy' });

  assert.equal(tested.value.ok, true);
  assert.equal(asked.length, 1);
  assert.equal(probes.agyModels, 1, 'the CLI installed after the first scan was found');
});
