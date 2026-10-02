import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseStoredJson } from './util.js';

/* The learner's MinerU token (cloud PDF conversion). Same rules as the audio keys
   (lib/audio-settings.js): it lives in the DSH home (DSH_HOME when set), next to the
   shared board, never in the study library, which is exported, backed up and shown to
   the panel. MINERU_API_KEY fills in a token the file lacks. The panel only ever gets
   whether a token is set and its last four characters. The privacy acknowledgement
   (the document is uploaded to MinerU's cloud) is stored beside it. */

/** Where the learner creates a token and where MinerU documents the service. */
export const MINERU_DOCS_URL = 'https://mineru.net/apiManage/docs';

export const mineruSettingsPath = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'mineru.json');

// MinerU tokens are JWT-shaped (dots, dashes, underscores); check only the shape, MinerU decides validity.
const TOKEN = /^[\w.+/=-]{20,4096}$/;

/** Plain-language reason shown whenever a cloud conversion is attempted without a token. */
export const NO_MINERU_TOKEN = '还没有设置 MinerU 令牌：请在「设置 › MinerU 云端解析」里粘贴令牌（在 mineru.net 的 API 管理页免费创建）。不要把令牌贴到对话里';
/** Plain-language reason shown until the learner has accepted that the document goes to MinerU's cloud. */
export const NO_MINERU_ACK = '还没有确认隐私说明：MinerU 云端解析会把文档上传到 MinerU 的服务器。请先在导入页或「设置 › MinerU 云端解析」里确认';

async function readFileSettings() {
  try {
    const value = parseStoredJson(await readFile(mineruSettingsPath(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** Effective settings, the token included. Never send this object to a panel, a model or a log. */
export async function readMineruSettings() {
  const file = await readFileSettings();
  const fromFile = String(file.token || '').trim(), fromEnv = String(process.env.MINERU_API_KEY || '').trim();
  return { token: fromFile || fromEnv, tokenSource: fromFile ? 'file' : fromEnv ? 'env' : '',
    acknowledgedAt: typeof file.acknowledgedAt === 'string' ? file.acknowledgedAt : '' };
}

export const hasMineruToken = settings => !!settings?.token;

const hint = token => (token ? `••••${token.slice(-4)}` : '');

/** What the panel may see: whether a token is set, its last four characters, where it comes from, the acknowledgement. */
export function publicMineruSettings(settings) {
  return { token: { set: !!settings.token, hint: hint(settings.token), source: settings.tokenSource || '' },
    acknowledged: !!settings.acknowledgedAt, acknowledgedAt: settings.acknowledgedAt || '',
    docsUrl: MINERU_DOCS_URL, settingsFile: mineruSettingsPath() };
}

/**
 * Change settings. A token left out stays as it is, an empty string clears it, anything else replaces it.
 * `acknowledge: true` records (once) that the learner accepted the privacy note, `false` withdraws it.
 */
export async function saveMineruSettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置必须是对象');
  const file = await readFileSettings(), next = { ...file };
  if (patch.token !== undefined) {
    const value = String(patch.token).trim();
    if (value && !TOKEN.test(value)) throw new Error('MinerU 令牌格式不对，请重新复制 mineru.net 页面里的完整令牌');
    if (value) next.token = value; else delete next.token;
  }
  if (patch.acknowledge !== undefined) {
    if (typeof patch.acknowledge !== 'boolean') throw new Error('acknowledge 必须是 true 或 false');
    if (patch.acknowledge) next.acknowledgedAt = file.acknowledgedAt || new Date().toISOString(); else delete next.acknowledgedAt;
  }
  const target = mineruSettingsPath(), temp = `${target}.${randomUUID()}.tmp`;
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(temp, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
  return readMineruSettings();
}
