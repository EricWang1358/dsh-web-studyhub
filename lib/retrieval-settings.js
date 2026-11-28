import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { atomicUpdateJson, backupThenRecover, inspectJsonFile, parseJsonObject } from './atomic-json.js';
import { canonicalPathKey, withStoreLock } from './store-lock.js';
import { studyHomePath } from './runtime/dsh-home.js';
import { preserveUnknownKeys } from './contexts/system/preserve-unknown-keys.js';

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
const RETRIEVAL_KNOWN_KEYS = new Set(['provider', 'queryArg', 'limitArg', 'explicit', 'hfEndpoint', 'roots']);

function normalizeRetrievalSettings(value) {
  const provider = PROVIDER.test(String(value.provider)) ? value.provider : 'builtin';
  const roots = provider !== 'builtin' ? cleanRoots(value.roots) : [];
  const normalized = {
    provider,
    ...(ARGUMENT.test(String(value.queryArg ?? '')) ? { queryArg: value.queryArg } : {}),
    ...(ARGUMENT.test(String(value.limitArg ?? '')) ? { limitArg: value.limitArg } : {}),
    ...(value.explicit === true ? { explicit: true } : {}),
    ...(ENDPOINT.test(String(value.hfEndpoint ?? '')) ? { hfEndpoint: value.hfEndpoint } : {}),
    ...(roots.length ? { roots } : {}),
  };
  return preserveUnknownKeys(value, normalized, RETRIEVAL_KNOWN_KEYS);
}

/**
 * Inspect `retrieval.json` with explicit status (#1354 D11):
 * distinguishes `ok`, `missing`, `corrupt`, `unreadable`, and `unsupported-version` ([C38])
 * so callers never mistake a read/parse error for a fresh install.
 */
export async function readRetrievalSettingsSafe() {
  const found = await inspectJsonFile(retrievalSettingsPath(), { supported: SUPPORTED_RETRIEVAL_VERSION });
  if (found.status === 'ok') return { status: 'ok', settings: normalizeRetrievalSettings(found.value) };
  return { status: found.status, settings: { provider: 'builtin' }, ...(found.error ? { error: found.error.message } : {}) };
}

/** { provider: 'builtin' | 'service' | 'mcp:<tool>', queryArg?, limitArg?, explicit?, hfEndpoint?, roots? }; 'builtin' (no retrieval) until chosen. */
export async function readRetrievalSettings() {
  return (await readRetrievalSettingsSafe()).settings;
}

/** Replace the settings. Returns what was saved. */
export async function saveRetrievalSettings(patch) {
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
  /* #1354 D11: a save is the learner's choice (the automatic ones, status() and adoptIndexProvider, first check readRetrievalSettingsSafe and leave an
     unusable file alone), so a damaged file is backed up, then replaced; one that cannot be read or that a newer release wrote is never replaced.
     Serialized with the other writers of the study folder, across processes too ([C02]). */
  return withStoreLock(dirname(filePath), async () => {
    const { value } = await atomicUpdateJson(
      filePath,
      (prev) => preserveUnknownKeys(prev, next, RETRIEVAL_KNOWN_KEYS),
      { parse: parseJsonObject, supported: SUPPORTED_RETRIEVAL_VERSION, space: 2, onCorrupt: backupThenRecover(filePath, null) },
    );
    return value;
  });
}
