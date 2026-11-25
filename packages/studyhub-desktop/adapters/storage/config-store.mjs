import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { workspaceLibrary } from '../../../../lib/host.js';
import { defaultDesktopConfig, normalizeDesktopConfig } from '../../domain/config-policy.js';

function resolveStudyHubHome(env, home) {
  const override = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (override) {
    return isAbsolute(override) ? resolve(override) : resolve(home, override);
  }
  return join(home, '.dsh');
}

function isInsidePath(childPath, parentPath) {
  const child = resolve(childPath);
  const parent = resolve(parentPath);
  const normalizeCase = process.platform === 'win32' ? (v) => v.toLowerCase() : (v) => v;
  const c = normalizeCase(child);
  const p = normalizeCase(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

async function verifyWritableDirectory(dirPath) {
  const target = resolve(dirPath);
  await mkdir(target, { recursive: true });
  const probe = join(target, `.studyhub-write-check-${randomUUID()}.tmp`);
  await writeFile(probe, 'ok', 'utf8');
  await rm(probe, { force: true });
  return target;
}

const RENAME_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 6;

async function renameWithRetry(fromPath, toPath) {
  let lastError = null;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(fromPath, toPath);
      return;
    } catch (error) {
      lastError = error;
      if (!RENAME_RETRY_CODES.has(error?.code) || attempt + 1 >= RENAME_MAX_ATTEMPTS) throw error;
      await new Promise((done) => setTimeout(done, 40 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function atomicWriteJson(filePath, data) {
  const target = resolve(filePath);
  await mkdir(resolve(target, '..'), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await renameWithRetry(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

const reasonOf = (error) => (error instanceof Error ? error.message : String(error));

function corruptConfigError(configPath, cause) {
  const detail = reasonOf(cause);
  return Object.assign(
    new Error(`Existing desktop.json could not be read (${detail}); refusing to overwrite`),
    { code: 'config-corrupt', details: { configPath, reason: detail } },
  );
}

function unreadableConfigError(configPath, cause) {
  const detail = reasonOf(cause);
  return Object.assign(
    new Error(`desktop.json could not be read right now (${detail}); it was not changed`),
    { code: 'config-unreadable', details: { configPath, reason: detail } },
  );
}

function backupFailedError(configPath, cause) {
  const detail = reasonOf(cause);
  return Object.assign(
    new Error(`desktop.json could not be backed up (${detail}); it was not reset`),
    { code: 'config-backup-failed', details: { configPath, reason: detail } },
  );
}

/**
 * What desktop.json is right now, from one fresh read. Only a parse failure (or a root that is not an object) is `corrupt`:
 * any other read error (a locked file, a permission error) says nothing about its contents and is `unreadable`.
 */
async function inspectStoredConfig(configPath) {
  let raw;
  try { raw = await readFile(configPath, 'utf8'); } catch (error) {
    return error?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('desktop.json root must be a JSON object');
    return { kind: 'ok', config: normalizeDesktopConfig(parsed) };
  } catch (error) {
    return { kind: 'corrupt', error };
  }
}

async function readStoredConfigWithStatus(configPath) {
  const found = await inspectStoredConfig(configPath);
  if (found.kind === 'ok') return { config: found.config, configProblem: null };
  const configProblem = found.kind === 'corrupt' ? { code: 'config-corrupt', path: configPath, reason: reasonOf(found.error) } : null;
  return { config: defaultDesktopConfig(), configProblem };
}

async function readStoredConfig(configPath, { strictIo = false } = {}) {
  const found = await inspectStoredConfig(configPath);
  if (found.kind === 'ok') return found.config;
  if (strictIo && found.kind === 'corrupt') throw corruptConfigError(configPath, found.error);
  if (strictIo && found.kind === 'unreadable') throw unreadableConfigError(configPath, found.error);
  return defaultDesktopConfig();
}

/**
 * The library a folder holds. The DSH plugin keeps a workspace's library in the `.dsh-study` folder inside it (lib/host.js workspaceLibrary is
 * its rule), so a learner who picks that workspace here means the library in it, not a new empty one beside it. A folder with a library of its
 * own, or with none anywhere, is the library itself.
 */
async function libraryHeldBy(folder) {
  const inner = await workspaceLibrary(folder);
  if (inner === folder) return folder;
  return (await workspaceLibrary(inner)) === inner ? inner : folder;
}

async function resolveLibraryCandidate({ candidate, source, defaultRoot, fallbackRoot, configPath }) {
  if (isInsidePath(configPath, candidate)) {
    return { ok: false, reason: '学习库目录不能包含配置文件所在目录' };
  }
  try {
    const pickedRoot = await verifyWritableDirectory(candidate);
    const held = await libraryHeldBy(pickedRoot);
    const root = held === pickedRoot ? pickedRoot : await verifyWritableDirectory(held);
    return { ok: true, root, pickedRoot, rootSource: source, defaultRoot, problem: null };
  } catch (error) {
    return { ok: false, reason: error?.message || '目录不可写', fallbackRoot };
  }
}

function formatProblemMessage(problem, fallbackRoot) {
  return `无法打开学习库目录「${problem.root}」（${problem.reason}），已暂时改用「${fallbackRoot}」`;
}

async function resolveLibraryRoot({ config, env, defaultRoot, fallbackRoot, configPath }) {
  const envLibrary = typeof env.STUDYHUB_LIBRARY === 'string' ? env.STUDYHUB_LIBRARY.trim() : '';
  const candidates = [];
  if (envLibrary) candidates.push({ path: resolve(envLibrary), source: 'config' });
  if (config.libraryRoot) candidates.push({ path: resolve(config.libraryRoot), source: 'custom' });
  candidates.push({ path: defaultRoot, source: 'default' });
  candidates.push({ path: fallbackRoot, source: 'default' });

  let firstProblem = null;
  for (const item of candidates) {
    const checked = await resolveLibraryCandidate({
      candidate: item.path, source: item.source, defaultRoot, fallbackRoot, configPath,
    });
    if (checked.ok) {
      const problem = firstProblem ? { ...firstProblem, message: formatProblemMessage(firstProblem, checked.root) } : null;
      return { root: checked.root, pickedRoot: checked.pickedRoot, rootSource: checked.rootSource, defaultRoot, problem };
    }
    firstProblem ||= { root: item.path, source: item.source, reason: checked.reason };
  }
  throw new Error('无法创建或写入默认学习库目录');
}

/** Copy the corrupt file aside. A copy that fails stops the caller: the original is the only record of the learner's folder and model settings. */
async function backupCorruptConfig(configPath) {
  const backupPath = `${configPath}.corrupt-${Date.now()}.bak`;
  try { await copyFile(configPath, backupPath, constants.COPYFILE_EXCL); } catch (error) { throw backupFailedError(configPath, error); }
  return backupPath;
}

/**
 * Back up a corrupted desktop.json and reset it to clean defaults. The file is read again first: one that reads fine (or is absent) is left
 * alone, a read error is no proof of corruption and stops here, and a backup that fails stops the reset.
 */
async function recoverStoredConfig(configPath) {
  const found = await inspectStoredConfig(configPath);
  if (found.kind === 'unreadable') throw unreadableConfigError(configPath, found.error);
  if (found.kind !== 'corrupt') return { recovered: false, reason: found.kind === 'ok' ? 'readable' : 'missing', backupPath: '' };
  const backupPath = await backupCorruptConfig(configPath);
  const clean = defaultDesktopConfig();
  await atomicWriteJson(configPath, clean);
  return { recovered: true, backupPath, config: clean };
}

/**
 * Create atomic JSON config persistence for StudyHub Desktop.
 * Persists `desktop.json` strictly under StudyHub home (`<DSH_HOME || ~/.dsh>/study/desktop.json`),
 * never inside the study library root.
 */
export function createConfigStore({
  env = process.env,
  home = osHomedir(),
  documentsDir = join(home, 'Documents'),
} = {}) {
  const dshHome = resolveStudyHubHome(env, home);
  process.env.DSH_HOME = dshHome;

  const studyHome = join(dshHome, 'study');
  const configPath = join(studyHome, 'desktop.json');
  const defaultRoot = resolve(documentsDir, 'StudyHub');
  const fallbackRoot = join(studyHome, 'library');

  let writeQueue = Promise.resolve();
  const serializeWrite = (work) => {
    const next = writeQueue.then(work);
    writeQueue = next.catch(() => {});
    return next;
  };

  async function load() {
    const { config, configProblem } = await readStoredConfigWithStatus(configPath);
    const library = await resolveLibraryRoot({ config, env, defaultRoot, fallbackRoot, configPath });
    return { config, library, configProblem };
  }

  function save(nextConfig, opts) {
    return serializeWrite(async () => {
      try { await readStoredConfig(configPath, { strictIo: true }); } catch (error) {
        // `force` resets a corrupt file (after its backup); a file that is only unreadable right now is never overwritten.
        if (!opts?.force || error?.code !== 'config-corrupt') throw error;
        await backupCorruptConfig(configPath);
      }
      const normalized = normalizeDesktopConfig(nextConfig);
      await atomicWriteJson(configPath, normalized);
      return normalized;
    });
  }

  /** Explicitly back up a corrupted desktop.json and reset it to clean defaults (#1436 Item 8); see recoverStoredConfig. */
  const recover = () => serializeWrite(() => recoverStoredConfig(configPath));

  function saveLibraryRoot(rawRoot) {
    return serializeWrite(async () => {
      const trimmed = String(rawRoot ?? '').trim();
      const current = await readStoredConfig(configPath, { strictIo: true });
      // Saving a folder, the default one included, is the learner settling where the library lives.
      if (!trimmed) {
        await atomicWriteJson(configPath, { ...current, libraryRoot: '', libraryPlaceConfirmed: true });
        return '';
      }
      if (!isAbsolute(trimmed)) {
        throw Object.assign(new Error('请选择绝对路径的学习库目录'), { code: 'invalid-library-root' });
      }
      const target = resolve(trimmed);
      if (isInsidePath(configPath, target)) {
        throw Object.assign(new Error('学习库目录不能包含配置文件目录'), { code: 'invalid-library-root' });
      }
      await verifyWritableDirectory(target);
      await atomicWriteJson(configPath, { ...current, libraryRoot: target, libraryPlaceConfirmed: true });
      return target;
    });
  }

  /** The learner accepts the library where it is. Written on a fresh read of the file, so a folder saved a moment ago is not put back. */
  function confirmLibraryPlace() {
    return serializeWrite(async () => {
      const current = await readStoredConfig(configPath, { strictIo: true });
      await atomicWriteJson(configPath, { ...current, libraryPlaceConfirmed: true });
    });
  }

  return Object.freeze({
    dshHome,
    configPath,
    defaultRoot,
    load,
    save,
    recover,
    saveLibraryRoot,
    confirmLibraryPlace,
  });
}
