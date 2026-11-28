import { readFile } from 'node:fs/promises';
import { atomicUpdateJson, backupThenRecover, parseJsonObject } from '../../atomic-json.js';
import { MINERU, normalizeBaseUrl } from './mineru-api.js';
import { studyHomePath } from '../../runtime/dsh-home.js';
import { UnsupportedVersionError } from '../../stored-version.js';
import { parseStoredJson } from '../../util.js';

/* The learner's MinerU PDF conversion settings: parsing mode (local by default — never uploads without explicit opt-in),
   optional cloud / third-party baseUrl + Key, and first-use upload acknowledgement.
   Same rules as the audio keys (lib/audio-settings.js): stored in the DSH home (DSH_HOME when set), mode 0o600,
   never in the study library (which is exported, backed up and shown to the panel). MINERU_API_KEY fills in a key
   the file lacks. The panel only ever gets whether a key is set and its last four characters. */

/** Where the learner creates a MinerU official token and reads the API docs. */
export const MINERU_DOCS_URL = MINERU.docsUrl;
export const MINERU_MODES = Object.freeze(['local', 'cloud']);

export const mineruSettingsPath = () => studyHomePath('mineru.json');

// Official MinerU tokens are JWT-shaped; compatible third-party API keys may use any printable non-whitespace ASCII token.
const TOKEN = /^[\x21-\x7e]{6,4096}$/;

/** Plain-language reason shown whenever a cloud conversion is attempted without a key. */
export const NO_MINERU_TOKEN = '还没有设置云端解析密钥：请在「设置 › PDF 转换（MinerU）」里填写密钥（Key），或改用本机解析。不要把密钥贴到对话里';
/** Plain-language reason shown until the learner has confirmed that the PDF will be uploaded to the cloud endpoint. */
export const NO_MINERU_ACK = '还没有确认上传说明：云端解析会把 PDF 文件上传到所选接口。请先在导入页或「设置 › PDF 转换（MinerU）」里确认';

function checkVersion(value) {
  if (value && typeof value === 'object' && value.version !== undefined && value.version !== 1) {
    throw new UnsupportedVersionError('MinerU settings', value.version);
  }
  return value;
}

async function readFileSettings() {
  let raw;
  try { raw = await readFile(mineruSettingsPath(), 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
  let parsed;
  try { parsed = parseStoredJson(raw); } catch { return {}; }
  const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return checkVersion(obj);
}

const effectiveUrlOf = baseUrl => {
  try { return normalizeBaseUrl(baseUrl) || MINERU.baseUrl; }
  catch { return MINERU.baseUrl; }
};

function resolvedFromFile(file) {
  const mode = file.mode === 'cloud' ? 'cloud' : 'local';
  let baseUrl = '';
  try { baseUrl = normalizeBaseUrl(typeof file.baseUrl === 'string' ? file.baseUrl : ''); } catch { baseUrl = ''; }
  const effectiveBaseUrl = baseUrl || MINERU.baseUrl;
  const fromFile = typeof file.token === 'string' ? file.token.trim() : '';
  const fromEnv = String(process.env.MINERU_API_KEY || '').trim();
  const rawAck = typeof file.acknowledgedAt === 'string' ? file.acknowledgedAt : '';
  // Legacy 3.5.4 files have `acknowledgedAt` without `acknowledgedBaseUrl` (they consented to MinerU's official endpoint).
  const ackUrl = typeof file.acknowledgedBaseUrl === 'string' && file.acknowledgedBaseUrl ? effectiveUrlOf(file.acknowledgedBaseUrl) : MINERU.baseUrl;
  const acknowledgedAt = rawAck && ackUrl === effectiveBaseUrl ? rawAck : '';
  return {
    mode,
    baseUrl,
    effectiveBaseUrl,
    token: fromFile || fromEnv,
    tokenSource: fromFile ? 'file' : fromEnv ? 'env' : '',
    acknowledgedAt,
  };
}

/** Effective settings, the raw key included. Never send this object to a panel, a model or a log. */
export async function readMineruSettings() {
  return resolvedFromFile(await readFileSettings());
}

export const hasMineruToken = settings => !!settings?.token;

const hint = token => (token ? `••••${token.slice(-4)}` : '');

/** What the panel may see: mode, baseUrl, whether a key is set and its last four characters, upload acknowledgement. */
export function publicMineruSettings(settings) {
  return {
    mode: settings.mode === 'cloud' ? 'cloud' : 'local',
    baseUrl: settings.baseUrl || '',
    effectiveBaseUrl: settings.effectiveBaseUrl || MINERU.baseUrl,
    defaultBaseUrl: MINERU.baseUrl,
    token: { set: !!settings.token, hint: hint(settings.token), source: settings.tokenSource || '' },
    acknowledged: !!settings.acknowledgedAt,
    acknowledgedAt: settings.acknowledgedAt || '',
    docsUrl: MINERU_DOCS_URL,
    settingsFile: mineruSettingsPath(),
  };
}

/**
 * Change settings. Unspecified fields stay as they are; empty baseUrl restores MinerU official default; empty token clears it.
 * `acknowledge: true` records (for the current effectiveBaseUrl) that the learner confirmed upload; `false` withdraws it.
 * Changing baseUrl to a different effective endpoint resets any prior upload acknowledgement unless `acknowledge: true` is passed alongside.
 */
export async function saveMineruSettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置必须是对象');
  if (patch.mode !== undefined && !MINERU_MODES.includes(patch.mode)) throw new Error('mode 只能是 local 或 cloud');
  if (patch.acknowledge !== undefined && typeof patch.acknowledge !== 'boolean') throw new Error('acknowledge 必须是 true 或 false');

  let normalizedBaseUrl;
  if (patch.baseUrl !== undefined) normalizedBaseUrl = normalizeBaseUrl(patch.baseUrl);
  let cleanedToken;
  if (patch.token !== undefined) {
    cleanedToken = String(patch.token).trim();
    if (cleanedToken && !TOKEN.test(cleanedToken)) throw new Error('云端密钥格式不对，请重新复制完整的密钥（Key）');
  }

  // Refuse to touch a file written by a newer unknown version.
  await readFileSettings();

  const target = mineruSettingsPath();
  let savedFile = {};
  await atomicUpdateJson(target, (prev) => {
    const file = checkVersion(prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {});
    const next = { ...file };
    const beforeEffective = effectiveUrlOf(typeof file.baseUrl === 'string' ? file.baseUrl : '');

    if (patch.mode !== undefined) next.mode = patch.mode;
    if (patch.baseUrl !== undefined) {
      if (normalizedBaseUrl) next.baseUrl = normalizedBaseUrl;
      else delete next.baseUrl;
    }
    const afterEffective = effectiveUrlOf(typeof next.baseUrl === 'string' ? next.baseUrl : '');
    if (patch.baseUrl !== undefined && afterEffective !== beforeEffective && patch.acknowledge !== true) {
      delete next.acknowledgedAt;
      delete next.acknowledgedBaseUrl;
    }
    if (patch.token !== undefined) {
      if (cleanedToken) next.token = cleanedToken;
      else delete next.token;
    }
    if (patch.acknowledge !== undefined) {
      if (patch.acknowledge) {
        next.acknowledgedAt = (afterEffective === beforeEffective && file.acknowledgedAt) || new Date().toISOString();
        next.acknowledgedBaseUrl = afterEffective;
      } else {
        delete next.acknowledgedAt;
        delete next.acknowledgedBaseUrl;
      }
    }
    savedFile = { version: 1, ...next };
    return savedFile;
  }, {
    parse: parseJsonObject,
    onCorrupt: backupThenRecover(target, {}, { mode: 0o600 }),
    space: 2,
    trailingNewline: true,
    mode: 0o600,
    sync: true,
  });
  return resolvedFromFile(savedFile);
}
