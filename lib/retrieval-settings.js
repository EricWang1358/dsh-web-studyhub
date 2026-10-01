import { parseStoredJson } from './util.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/* Which retrieval provider StudyHub uses (WP28). Like the audio settings this
   lives in the user's DSH home, not in the study library: the library is
   exported and backed up, and the choice belongs to this DSH installation (the
   MCP tools it names are configured there). Nothing secret is stored: a tool
   name and, optionally, the names of its query and limit arguments; `explicit`
   marks a choice the learner made (so an automatic one never overrides it) and
   `hfEndpoint` an https address to download the search extension's embedding
   model from (WP28b; read by the extension when DSH starts it). */

/** Where the choice is kept: the DSH user directory (DSH_HOME when it is set). */
export const retrievalSettingsPath = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'retrieval.json');

const PROVIDER = /^(?:builtin|service|mcp:[A-Za-z0-9_-]{1,100})$/;
const ARGUMENT = /^[A-Za-z0-9_.-]{1,40}$/;
const ENDPOINT = /^https:\/\/[^\s]{1,300}$/;

/** { provider: 'builtin' | 'service' | 'mcp:<tool>', queryArg?, limitArg?, explicit?, hfEndpoint? }; 'builtin' (no retrieval) until chosen. */
export async function readRetrievalSettings() {
  try {
    const value = parseStoredJson(await readFile(retrievalSettingsPath(), 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const provider = PROVIDER.test(String(value.provider)) ? value.provider : 'builtin';
      return { provider, ...(ARGUMENT.test(String(value.queryArg ?? '')) ? { queryArg: value.queryArg } : {}),
        ...(ARGUMENT.test(String(value.limitArg ?? '')) ? { limitArg: value.limitArg } : {}),
        ...(value.explicit === true ? { explicit: true } : {}), ...(ENDPOINT.test(String(value.hfEndpoint ?? '')) ? { hfEndpoint: value.hfEndpoint } : {}) };
    }
  } catch { /* no file yet, or unreadable: nothing chosen */ }
  return { provider: 'builtin' };
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
  const target = retrievalSettingsPath(), tmp = `${target}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
  return next;
}
