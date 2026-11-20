import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXTENSION_BUILD } from '../../../../lib/retrieval-extension.js';
import { readRetrievalSettings, saveRetrievalSettings } from '../../../../lib/retrieval-settings.js';
import { currentVersion } from '../../../../lib/update-check.js';
import { discoverRetrieval, resolveDshHome } from './discovery.mjs';
import { createIndexLock } from './index-lock.mjs';
import { createRetrievalInstaller } from './installer.mjs';
import { createMcpStdioClient } from './mcp-stdio-client.mjs';

function buildChildEnv(baseEnv, retrievalDir, hfEndpoint) {
  const childEnv = {
    ...baseEnv,
    DB_PATH: join(retrievalDir, 'lancedb'),
    CACHE_DIR: join(retrievalDir, 'models'),
    BASE_DIR: join(retrievalDir, 'documents'),
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (hfEndpoint) {
    childEnv.HF_ENDPOINT = hfEndpoint;
  } else {
    delete childEnv.HF_ENDPOINT;
  }
  return childEnv;
}

function lancedbUrlOf(ragEntry) {
  return pathToFileURL(createRequire(ragEntry).resolve('@lancedb/lancedb')).href;
}

function resolveCanInstallFlag({ canInstallPlatform, platform, arch, downloadPrefix, env }) {
  if (typeof canInstallPlatform === 'boolean') return canInstallPlatform;
  if (platform === 'win32' && arch === 'x64') return true;
  if (downloadPrefix) return true;
  const envPrefix = typeof env.STUDYHUB_DESKTOP_RETRIEVAL_DOWNLOAD_PREFIX === 'string'
    ? env.STUDYHUB_DESKTOP_RETRIEVAL_DOWNLOAD_PREFIX.trim()
    : '';
  return Boolean(envPrefix);
}

async function runCandidateHeal(candidate, resolvedDshHome) {
  if (!candidate?.healPath) return {};
  try {
    const mod = await import(pathToFileURL(candidate.healPath).href);
    if (typeof mod?.healIndex !== 'function') return {};
    return await mod.healIndex({
      home: resolvedDshHome,
      execPath: process.execPath,
      electron: false,
      lancedb: () => lancedbUrlOf(candidate.ragEntry),
      warn: (message) => process.stderr.write(`[studyhub-desktop:retrieval] ${message}\n`),
    });
  } catch {
    return {};
  }
}

/**
 * Create the concrete Node IO ports for `application/retrieval-runtime.js`.
 */
export function createRetrievalRuntimePorts({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  home,
  dshHome,
  runner,
  httpFetch,
  downloadPrefix = '',
  canInstallPlatform,
} = {}) {
  const resolvedDshHome = dshHome || resolveDshHome({ env, home });
  const retrievalDir = join(resolvedDshHome, 'study', 'retrieval');
  const indexLock = createIndexLock({ retrievalDir });
  const installer = createRetrievalInstaller({
    env,
    platform,
    home,
    dshHome: resolvedDshHome,
    ...(httpFetch ? { httpFetch } : {}),
    ...(downloadPrefix ? { downloadPrefix } : {}),
  });
  const resolvedCanInstall = resolveCanInstallFlag({
    canInstallPlatform, platform, arch, downloadPrefix, env,
  });

  async function startClient(candidate, { hfEndpoint = '', onExit } = {}) {
    const client = createMcpStdioClient({
      command: process.execPath,
      args: [candidate.serverPath, candidate.ragEntry],
      cwd: candidate.dir,
      env: buildChildEnv(env, retrievalDir, hfEndpoint),
      ...(runner?.spawnPersistent ? { spawnPersistent: runner.spawnPersistent } : {}),
      onExit,
    });
    await client.start();
    return client;
  }

  return Object.freeze({
    canInstallPlatform: resolvedCanInstall,
    installer,
    discover: () => discoverRetrieval({ env, platform, home, dshHome: resolvedDshHome }),
    ensureRetrievalDirs: () => mkdir(join(retrievalDir, 'documents'), { recursive: true }),
    readSettings: () => readRetrievalSettings(),
    saveSettings: (patch) => saveRetrievalSettings(patch),
    withIndexLock: (work, opts) => indexLock.withLock(work, opts),
    runHeal: (candidate) => runCandidateHeal(candidate, resolvedDshHome),
    startClient,
    getCurrentVersion: () => currentVersion(),
    getSinceVersion: () => EXTENSION_BUILD.since,
  });
}
