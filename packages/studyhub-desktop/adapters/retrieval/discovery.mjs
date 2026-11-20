import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSemver, selectRetrievalCandidate } from '../../domain/retrieval-policy.js';

const RETRIEVAL_PKG_SEGMENTS = ['@ericwang1358', 'studyhub-retrieval'];
const DSH_PROFILES = Object.freeze(['desktop', 'web']);
const DEFAULT_FALLBACK_HEAL = fileURLToPath(
  new URL('../../../studyhub-retrieval/heal.js', import.meta.url)
);

async function fileExists(targetPath) {
  if (!targetPath) return false;
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the DSH home directory (`DSH_HOME` when set, otherwise `~/.dsh`).
 */
export function resolveDshHome({ env = process.env, home = osHomedir() } = {}) {
  const override = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (override) {
    return isAbsolute(override) ? resolve(override) : resolve(home, override);
  }
  return join(home, '.dsh');
}

/**
 * Resolve the Desktop-managed standalone retrieval directory (B).
 */
export function resolveDesktopRetrievalDir({
  env = process.env,
  platform = process.platform,
  home = osHomedir(),
} = {}) {
  const override = typeof env.STUDYHUB_DESKTOP_RETRIEVAL_DIR === 'string'
    ? env.STUDYHUB_DESKTOP_RETRIEVAL_DIR.trim()
    : '';
  if (override) return resolve(override);
  if (platform === 'win32') {
    const localAppData = typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim()
      ? env.LOCALAPPDATA.trim()
      : join(home, 'AppData', 'Local');
    return join(resolve(localAppData), 'StudyHub', 'tools', 'retrieval');
  }
  const xdgData = typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim()
    ? env.XDG_DATA_HOME.trim()
    : join(home, '.local', 'share');
  return join(resolve(xdgData), 'studyhub', 'tools', 'retrieval');
}

/**
 * List read-only DSH retrieval extension directories (D).
 */
export function listDshRetrievalDirs({ env = process.env, home = osHomedir(), dshHome = '' } = {}) {
  const baseDshHome = dshHome ? resolve(dshHome) : resolveDshHome({ env, home });
  return DSH_PROFILES.map((profile) => ({
    profile,
    dir: join(baseDshHome, 'profiles', profile, 'node_modules', ...RETRIEVAL_PKG_SEGMENTS),
  }));
}

function resolveRagEntry(pkgJsonPath) {
  try {
    return createRequire(pkgJsonPath).resolve('mcp-local-rag');
  } catch {
    return null;
  }
}

/**
 * Validate a candidate retrieval directory without mutating anything on disk.
 */
export async function validateRetrievalDir(
  dirPath,
  { source = 'desktop', profile = null, fallbackHealPath = DEFAULT_FALLBACK_HEAL } = {}
) {
  const dir = resolve(dirPath);
  const invalid = (reason) => ({ valid: false, source, profile, dir, reason });
  const pkgJsonPath = join(dir, 'package.json');
  const serverPath = join(dir, 'server.mjs');

  let pkg;
  try {
    pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8'));
  } catch {
    return invalid('missing-package-json');
  }

  const parsedVersion = parseSemver(pkg?.version);
  if (!parsedVersion) return invalid('invalid-version');
  if (!(await fileExists(serverPath))) return invalid('missing-server');

  const ragEntry = resolveRagEntry(pkgJsonPath);
  if (!ragEntry) return invalid('missing-mcp-local-rag');

  const localHeal = join(dir, 'heal.js');
  let healPath = null;
  if (await fileExists(localHeal)) {
    healPath = localHeal;
  } else if (await fileExists(fallbackHealPath)) {
    healPath = resolve(fallbackHealPath);
  }

  return {
    valid: true,
    source,
    profile,
    dir,
    version: parsedVersion.text,
    serverPath,
    ragEntry,
    healPath,
  };
}

/**
 * Probe B (desktop standalone) and D (read-only DSH) retrieval installations,
 * selecting B > D > none via domain policy. Never mutates DSH directories.
 */
export async function discoverRetrieval({
  env = process.env,
  platform = process.platform,
  home = osHomedir(),
  dshHome = '',
  fallbackHealPath = DEFAULT_FALLBACK_HEAL,
} = {}) {
  const desktopDir = resolveDesktopRetrievalDir({ env, platform, home });
  const dshDirs = listDshRetrievalDirs({ env, home, dshHome });

  const probes = [
    validateRetrievalDir(desktopDir, { source: 'desktop', profile: 'desktop', fallbackHealPath }),
    ...dshDirs.map((item) => validateRetrievalDir(item.dir, {
      source: 'dsh',
      profile: item.profile,
      fallbackHealPath,
    })),
  ];
  const candidates = await Promise.all(probes);
  const selected = selectRetrievalCandidate(candidates);
  return { selected, desktopDir, candidates };
}
