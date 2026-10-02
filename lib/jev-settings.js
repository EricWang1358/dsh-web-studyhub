import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseStoredJson } from './util.js';
import { JEV_PROVIDER_IDS, JEV_PROVIDERS, isJevProvider, isKeyEnvName, jevProvider, keyFromEnvironment } from './jev-providers.js';
import { JEV_REPLACE_SITES } from './jev-sites.js';

/* EXPERIMENTAL. The learner's Jev provider, key and the switches of the experimental decision layer.

   Same rules as the audio keys (lib/audio-settings.js) and the MinerU token (lib/mineru-settings.js): the file lives in the DSH
   home (DSH_HOME when it is set), next to the shared board, never in the study library, which is exported, backed up and shown
   to the panel. The panel only ever gets whether a key is set and its last four characters (nothing at all of a key that comes
   from an environment variable).

   PROVIDERS (lib/jev-providers.js). `provider` is a preset id: TypeSafe's own API (the default, and what a file from before the
   presets means), or one of OpenCode Zen's two Jev models. The key is resolved in this order: a key pasted here (kept per service:
   `key` is TypeSafe's, as it always was, `opencodeKey` is OpenCode's) > the environment variable named by `keyEnv` (default per
   preset: JEV_API_KEY, or OPENCODE_GO_API_KEY_2 for the OpenCode ones) > JEV_API_KEY, for TypeSafe only (a TypeSafe key is never
   sent to OpenCode, and the other way round). A key that comes from a variable is read each time and NEVER written anywhere; only
   the variable's name is stored.

   Nothing is ever sent to Jev unless ALL of these hold (jevGate): the master switch is on, the feature's own switch is on, a key
   is set, and the learner has confirmed the privacy note for the CHOSEN provider (a confirmation belongs to one provider and one
   version of the note: TypeSafe's lives in `confirmedAt`/`noticeVersion` as before, the OpenCode presets' in `confirmations`).
   Everything is off until the learner turns it on. */

export const jevSettingsPath = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'jev.json');

/** The experiments, in the order the settings list them. Each has its own switch. */
export const JEV_FEATURES = Object.freeze(['courseSuggest', 'preReview', 'outlineNoise', 'levelCheck']);
/** Raised whenever the text of the privacy note changes in substance, so an old confirmation stops counting. */
export const JEV_NOTICE_VERSION = 1;
export const JEV_THRESHOLD = Object.freeze({ default: 0.8, min: 0.5, max: 0.99 });

const KEY = /^[\w.+/=-]{16,4096}$/;
/** Where a pasted key is kept, by the service it belongs to. TypeSafe's stays in the field the previous version wrote. */
const KEY_FIELD = { typesafe: 'key', opencode: 'opencodeKey' };
const keyField = provider => KEY_FIELD[provider.family];
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** The stored confirmation of one provider's note: { at, version }. */
function confirmationOf(file, provider) {
  if (provider.id === 'typesafe') return { at: file.confirmedAt, version: file.noticeVersion };
  const entry = plainObject(file.confirmations) ? file.confirmations[provider.id] : undefined;
  return plainObject(entry) ? { at: entry.confirmedAt, version: entry.noticeVersion } : { at: undefined, version: undefined };
}
const confirmationValid = ({ at, version }) => typeof at === 'string' && !!at && version === JEV_NOTICE_VERSION;

async function readFileSettings() {
  try {
    const value = parseStoredJson(await readFile(jevSettingsPath(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** Effective settings, the key included. Never send this object to a panel, a model or a log. */
export async function readJevSettings() {
  const file = await readFileSettings();
  const provider = jevProvider(file.provider), keyEnv = isKeyEnvName(file.keyEnv) ? file.keyEnv : '';
  const fromFile = String(file[keyField(provider)] || '').trim();
  const variable = keyFromEnvironment(provider.id, keyEnv);
  const fallback = !variable.key && provider.family === 'typesafe' ? String(process.env.JEV_API_KEY || '').trim() : '';
  const fromEnv = variable.key || fallback;
  const features = Object.fromEntries(JEV_FEATURES.map(feature => [feature, file.features?.[feature] === true]));
  const replace = Object.fromEntries(JEV_REPLACE_SITES.map(site => [site, file.replace?.[site] === true]));
  const threshold = typeof file.threshold === 'number' && file.threshold >= JEV_THRESHOLD.min && file.threshold <= JEV_THRESHOLD.max ? file.threshold : JEV_THRESHOLD.default;
  const confirmation = confirmationOf(file, provider), confirmed = confirmationValid(confirmation);
  return { provider: provider.id, keyEnv, keyEnvName: variable.name, keyEnvFound: variable.found,
    key: fromFile || fromEnv, keySource: fromFile ? 'file' : fromEnv ? 'env' : '', keyFromVariable: !fromFile && fromEnv ? (variable.key ? variable.name : 'JEV_API_KEY') : '',
    enabled: file.enabled === true, features, replace, threshold, confirmedAt: confirmed ? confirmation.at : '' };
}

const hint = key => (key ? `••••${key.slice(-4)}` : '');

/** What the panel may see: the provider, whether a key is set and (for a pasted one) its last four characters, where an environment key
    comes from (the variable's NAME and whether it was found, never a character of its value), the confirmation, the switches. */
export function publicJevSettings(settings) {
  const provider = jevProvider(settings.provider), fromEnv = settings.keySource === 'env';
  return { provider: provider.id,
    providers: JEV_PROVIDER_IDS.map(id => ({ id, family: JEV_PROVIDERS[id].family, model: JEV_PROVIDERS[id].model, host: JEV_PROVIDERS[id].host, defaultKeyEnv: JEV_PROVIDERS[id].defaultKeyEnv })),
    key: { set: !!settings.key, hint: fromEnv ? '' : hint(settings.key), source: settings.keySource || '',
      envName: settings.keyFromVariable || settings.keyEnvName || provider.defaultKeyEnv, envFound: fromEnv || !!settings.keyEnvFound },
    keyEnv: settings.keyEnv || '', keyEnvDefault: provider.defaultKeyEnv,
    confirmed: !!settings.confirmedAt, confirmedAt: settings.confirmedAt || '', noticeVersion: JEV_NOTICE_VERSION,
    enabled: settings.enabled, features: { ...settings.features }, replace: { ...settings.replace }, threshold: settings.threshold,
    docsUrl: provider.docsUrl, privacyUrl: provider.privacyUrl, settingsFile: jevSettingsPath() };
}

/**
 * Whether a call may be made now. `feature` is one of JEV_FEATURES (an extra-signal experiment), one of JEV_REPLACE_SITES (a model
 * decision the learner chose to have Jev answer instead; its switch is `settings.replace[site]`), or null for the key test (which needs
 * only a key and the confirmation). Resolves { ok: true } or { ok: false, reason } with a code from lib/jev-messages.js, checked in
 * this order: off (master switch), feature-off, no-key, not-confirmed.
 */
export function jevGate(settings, feature) {
  const site = JEV_REPLACE_SITES.includes(feature);
  if (feature !== null && !site && !JEV_FEATURES.includes(feature)) throw new Error('Unknown Jev feature');
  if (feature !== null) {
    if (!settings.enabled) return { ok: false, reason: 'off' };
    if (!(site ? settings.replace?.[feature] : settings.features[feature])) return { ok: false, reason: 'feature-off' };
  }
  if (!settings.key) return { ok: false, reason: 'no-key' };
  if (!settings.confirmedAt) return { ok: false, reason: 'not-confirmed' };
  return { ok: true };
}

const bool = (value, name) => { if (typeof value !== 'boolean') throw new Error(`${name} 必须是 true 或 false`); return value; };

/**
 * Change settings. `provider` is a preset id of lib/jev-providers.js; `keyEnv` the NAME of the environment variable that holds the key
 * ('' goes back to the preset's default). A key left out stays as it is, an empty string clears the pasted one, anything else
 * replaces it (for the service the chosen provider belongs to). `confirm: true` records (once) that the learner accepted the privacy
 * note of the chosen provider, `false` withdraws it. `enabled` is the master (kill) switch, `features` a partial map of the
 * individual switches, `threshold` the confidence needed to fill a suggestion in.
 */
export async function saveJevSettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置必须是对象');
  const file = await readFileSettings(), next = { ...file };
  if (patch.provider !== undefined) {
    if (!isJevProvider(patch.provider)) throw new Error('Jev 服务商不认识，请从列表里选择');
    next.provider = patch.provider;
  }
  const provider = jevProvider(next.provider);
  if (patch.keyEnv !== undefined) {
    if (patch.keyEnv === '' || patch.keyEnv === null) delete next.keyEnv;
    else if (isKeyEnvName(patch.keyEnv)) next.keyEnv = patch.keyEnv;
    else throw new Error('环境变量名只能包含字母、数字和下划线，且不能以数字开头');
  }
  if (patch.key !== undefined) {
    const value = String(patch.key).trim(), field = keyField(provider);
    if (value && !KEY.test(value)) throw new Error(provider.family === 'opencode' ? 'OpenCode 密钥格式不对，请重新复制 OpenCode 控制台里的完整密钥' : 'Jev 密钥格式不对，请重新复制 TypeSafe 控制台里的完整密钥');
    if (value) next[field] = value; else delete next[field];
  }
  if (patch.confirm !== undefined) {
    if (bool(patch.confirm, 'confirm')) {
      const current = confirmationOf(file, provider), at = (confirmationValid(current) && current.at) || new Date().toISOString();
      if (provider.id === 'typesafe') { next.confirmedAt = at; next.noticeVersion = JEV_NOTICE_VERSION; }
      else next.confirmations = { ...(plainObject(file.confirmations) ? file.confirmations : {}), [provider.id]: { confirmedAt: at, noticeVersion: JEV_NOTICE_VERSION } };
    } else if (provider.id === 'typesafe') { delete next.confirmedAt; delete next.noticeVersion; }
    else {
      const rest = { ...(plainObject(file.confirmations) ? file.confirmations : {}) };
      delete rest[provider.id];
      if (Object.keys(rest).length) next.confirmations = rest; else delete next.confirmations;
    }
  }
  if (patch.enabled !== undefined) next.enabled = bool(patch.enabled, 'enabled');
  if (patch.features !== undefined) {
    if (!patch.features || typeof patch.features !== 'object' || Array.isArray(patch.features)) throw new Error('features 必须是对象');
    const features = { ...(file.features && typeof file.features === 'object' ? file.features : {}) };
    for (const [name, value] of Object.entries(patch.features)) {
      if (!JEV_FEATURES.includes(name)) throw new Error('不认识的 Jev 实验功能');
      features[name] = bool(value, '功能开关');
    }
    next.features = features;
  }
  if (patch.replace !== undefined) {
    if (!patch.replace || typeof patch.replace !== 'object' || Array.isArray(patch.replace)) throw new Error('replace 必须是对象');
    const replace = { ...(file.replace && typeof file.replace === 'object' ? file.replace : {}) };
    for (const [name, value] of Object.entries(patch.replace)) {
      if (!JEV_REPLACE_SITES.includes(name)) throw new Error('不认识的 Jev 替换项');
      replace[name] = bool(value, '功能开关');
    }
    next.replace = replace;
  }
  if (patch.threshold !== undefined) {
    if (typeof patch.threshold !== 'number' || !(patch.threshold >= JEV_THRESHOLD.min && patch.threshold <= JEV_THRESHOLD.max)) throw new Error('Jev 置信度阈值应是 0.5 到 0.99 之间的数字');
    next.threshold = patch.threshold;
  }
  const target = jevSettingsPath(), temp = `${target}.${randomUUID()}.tmp`;
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(temp, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
  return readJevSettings();
}
