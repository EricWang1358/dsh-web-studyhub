import { parseStoredJson } from './util.js';
import { constants } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { atomicJson } from './atomic-json.js';
import { canonicalPathKey } from './store-lock.js';
import { studyHomePath } from './runtime/dsh-home.js';

/* Which retrieval provider StudyHub uses (WP28). Like the audio settings this
   lives in the user's DSH home, not in the study library: the library is
   exported and backed up, and the choice belongs to this DSH installation (the
   MCP tools it names are configured there). Nothing secret is stored: a tool
   name and, optionally, the names of its query and limit arguments; `explicit`
   marks a choice the learner made (so an automatic one never overrides it) and
   `hfEndpoint` an https address to download the search extension's embedding
   model from (WP28b; read by the extension when DSH starts it). */

/** Where the choice is kept: the DSH user directory (DSH_HOME when it is set). */
export const retrievalSettingsPath = () => studyHomePath('retrieval.json');
/** Privacy-preserving identifier for a study library root (same 16-hex hash as retrieval manifests). */
export const retrievalRootId = root => createHash('sha256').update(canonicalPathKey(String(root))).digest('hex').slice(0, 16);

const PROVIDER = /^(?:builtin|service|mcp:[A-Za-z0-9_-]{1,100})$/;
const ARGUMENT = /^[A-Za-z0-9_.-]{1,40}$/;
const ENDPOINT = /^https:\/\/[^\s]{1,300}$/;
const ROOT_ID = /^[0-9a-f]{16}$/;
const cleanRoots = list => (Array.isArray(list) ? [...new Set(list.filter(item => ROOT_ID.test(String(item))))].slice(-32) : []);

const SUPPORTED_RETRIEVAL_VERSION = 1;

function normalizeRetrievalSettings(value) {
  const provider = PROVIDER.test(String(value.provider)) ? value.provider : 'builtin';
  const roots = provider !== 'builtin' ? cleanRoots(value.roots) : [];
  return {
    provider,
    ...(ARGUMENT.test(String(value.queryArg ?? '')) ? { queryArg: value.queryArg } : {}),
    ...(ARGUMENT.test(String(value.limitArg ?? '')) ? { limitArg: value.limitArg } : {}),
    ...(value.explicit === true ? { explicit: true } : {}),
    ...(ENDPOINT.test(String(value.hfEndpoint ?? '')) ? { hfEndpoint: value.hfEndpoint } : {}),
    ...(roots.length ? { roots } : {}),
  };
}

/**
 * Inspect `retrieval.json` with explicit status (#1354 D11):
 * distinguishes `ok`, `missing`, `corrupt`, `unreadable`, and `unsupported-version` ([C38])
 * so callers never mistake a read/parse error for a fresh install.
 */
export async function readRetrievalSettingsSafe() {
  const filePath = retrievalSettingsPath();
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 'missing', settings: { provider: 'builtin' } };
    }
    return {
      status: 'unreadable',
      settings: { provider: 'builtin' },
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const value = parseStoredJson(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { status: 'corrupt', settings: { provider: 'builtin' }, error: 'retrieval.json root must be a JSON object' };
    }
    if (Object.hasOwn(value, 'version') && value.version !== undefined && value.version !== SUPPORTED_RETRIEVAL_VERSION) {
      return {
        status: 'unsupported-version',
        settings: { provider: 'builtin' },
        error: `Unsupported retrieval.json version ${String(value.version)} (supported: ${SUPPORTED_RETRIEVAL_VERSION})`,
      };
    }
    return { status: 'ok', settings: normalizeRetrievalSettings(value) };
  } catch (error) {
    return {
      status: 'corrupt',
      settings: { provider: 'builtin' },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** { provider: 'builtin' | 'service' | 'mcp:<tool>', queryArg?, limitArg?, explicit?, hfEndpoint?, roots? }; 'builtin' (no retrieval) until chosen. */
export async function readRetrievalSettings() {
  return (await readRetrievalSettingsSafe()).settings;
}

async function backupCorruptRetrievalFile(filePath, copyImpl = copyFile) {
  const backupPath = `${filePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.bak`;
  try {
    await copyImpl(filePath, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    throw Object.assign(
      new Error(`retrieval.json could not be backed up (${error?.message || error}); refusing to overwrite`),
      { code: 'retrieval-settings-backup-failed', cause: error },
    );
  }
  return backupPath;
}

const saveQueues = new Map();

function serializeRetrievalSave(filePath, work) {
  const key = canonicalPathKey(filePath);
  const prev = saveQueues.get(key) ?? Promise.resolve();
  const next = prev.then(work, work);
  const tail = next.catch(() => {});
  saveQueues.set(key, tail);
  void tail.finally(() => {
    if (saveQueues.get(key) === tail) saveQueues.delete(key);
  });
  return next;
}

/** Replace the settings. Refuses to silently overwrite corrupt, unreadable, or newer-version files (#1354 D11). Returns what was saved. */
export async function saveRetrievalSettings(patch, opts = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('检索设置必须是对象');
  const provider = patch.provider === undefined ? 'builtin' : patch.provider;
  if (!PROVIDER.test(String(provider))) throw new Error('检索设置里的提供方无效：请选择已检测到的工具、检索服务，或不使用检索');
  const next = { provider };
  for (const key of ['queryArg', 'limitArg']) {
    if (patch[key] === undefined || patch[key] === '') continue;
    if (!ARGUMENT.test(String(patch[key]))) throw new Error('检索设置里的参数名无效：只能用字母、数字、下划线、点和连字符');
    next[key] = patch[key];
  }
  if (patch.explicit === true) next.explicit = true;
  if (patch.hfEndpoint !== undefined && patch.hfEndpoint !== '') {
    if (!ENDPOINT.test(String(patch.hfEndpoint))) throw new Error('模型下载地址必须是 https 开头的网址');
    next.hfEndpoint = patch.hfEndpoint;
  }
  if (provider !== 'builtin' && Array.isArray(patch.roots)) {
    const roots = cleanRoots(patch.roots);
    if (roots.length) next.roots = roots;
  }
  const filePath = retrievalSettingsPath();
  return serializeRetrievalSave(filePath, async () => {
    const existing = await readRetrievalSettingsSafe();
    if (existing.status === 'unreadable') {
      throw Object.assign(
        new Error(`retrieval.json could not be read (${existing.error}); refusing to overwrite`),
        { code: 'retrieval-settings-unreadable' },
      );
    }
    if (existing.status === 'unsupported-version') {
      throw Object.assign(
        new Error(`${existing.error}; refusing to overwrite`),
        { code: 'retrieval-settings-unsupported-version' },
      );
    }
    if (existing.status === 'corrupt') {
      if (opts?.recover !== true) {
        throw Object.assign(
          new Error(`retrieval.json is corrupt (${existing.error}); refusing to overwrite without explicit recovery`),
          { code: 'retrieval-settings-corrupt' },
        );
      }
      await backupCorruptRetrievalFile(filePath, opts?.copyFile);
    }
    await atomicJson(filePath, next, { space: 2, trailingNewline: true, ensureDir: true, sync: true });
    return next;
  });
}
