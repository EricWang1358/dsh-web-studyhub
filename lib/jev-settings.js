import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseStoredJson } from './util.js';
import { JEV } from './jev.js';

/* EXPERIMENTAL. The learner's Jev key and the switches of the experimental decision layer.

   Same rules as the audio keys (lib/audio-settings.js) and the MinerU token (lib/mineru-settings.js): the file lives in the DSH
   home (DSH_HOME when it is set), next to the shared board, never in the study library, which is exported, backed up and shown
   to the panel. JEV_API_KEY fills in a key the file lacks. The panel only ever gets whether a key is set and its last four
   characters.

   Nothing is ever sent to Jev unless ALL of these hold (jevGate): the master switch is on, the feature's own switch is on, a key
   is set, and the learner has confirmed the privacy note (a confirmation belongs to one version of the note). Everything is off
   until the learner turns it on. */

export const jevSettingsPath = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'jev.json');

/** The experiments, in the order the settings list them. Each has its own switch. */
export const JEV_FEATURES = Object.freeze(['courseSuggest', 'preReview', 'outlineNoise', 'levelCheck']);
/** Raised whenever the text of the privacy note changes in substance, so an old confirmation stops counting. */
export const JEV_NOTICE_VERSION = 1;
export const JEV_THRESHOLD = Object.freeze({ default: 0.8, min: 0.5, max: 0.99 });

const KEY = /^[\w.+/=-]{16,4096}$/;

async function readFileSettings() {
  try {
    const value = parseStoredJson(await readFile(jevSettingsPath(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** Effective settings, the key included. Never send this object to a panel, a model or a log. */
export async function readJevSettings() {
  const file = await readFileSettings();
  const fromFile = String(file.key || '').trim(), fromEnv = String(process.env.JEV_API_KEY || '').trim();
  const features = Object.fromEntries(JEV_FEATURES.map(feature => [feature, file.features?.[feature] === true]));
  const threshold = typeof file.threshold === 'number' && file.threshold >= JEV_THRESHOLD.min && file.threshold <= JEV_THRESHOLD.max ? file.threshold : JEV_THRESHOLD.default;
  const confirmed = typeof file.confirmedAt === 'string' && file.confirmedAt && file.noticeVersion === JEV_NOTICE_VERSION;
  return { key: fromFile || fromEnv, keySource: fromFile ? 'file' : fromEnv ? 'env' : '', enabled: file.enabled === true, features, threshold,
    confirmedAt: confirmed ? file.confirmedAt : '' };
}

const hint = key => (key ? `••••${key.slice(-4)}` : '');

/** What the panel may see: whether a key is set and its last four characters, the confirmation, the switches. */
export function publicJevSettings(settings) {
  return { key: { set: !!settings.key, hint: hint(settings.key), source: settings.keySource || '' },
    confirmed: !!settings.confirmedAt, confirmedAt: settings.confirmedAt || '', noticeVersion: JEV_NOTICE_VERSION,
    enabled: settings.enabled, features: { ...settings.features }, threshold: settings.threshold,
    docsUrl: JEV.docsUrl, privacyUrl: JEV.privacyUrl, settingsFile: jevSettingsPath() };
}

/**
 * Whether a call may be made now. `feature` is one of JEV_FEATURES, or null for the key test (which needs only a key and the
 * confirmation). Resolves { ok: true } or { ok: false, reason } with a code from lib/jev-messages.js, checked in this order:
 * off (master switch), feature-off, no-key, not-confirmed.
 */
export function jevGate(settings, feature) {
  if (feature !== null && !JEV_FEATURES.includes(feature)) throw new Error('Unknown Jev feature');
  if (feature !== null) {
    if (!settings.enabled) return { ok: false, reason: 'off' };
    if (!settings.features[feature]) return { ok: false, reason: 'feature-off' };
  }
  if (!settings.key) return { ok: false, reason: 'no-key' };
  if (!settings.confirmedAt) return { ok: false, reason: 'not-confirmed' };
  return { ok: true };
}

const bool = (value, name) => { if (typeof value !== 'boolean') throw new Error(`${name} 必须是 true 或 false`); return value; };

/**
 * Change settings. A key left out stays as it is, an empty string clears it, anything else replaces it. `confirm: true`
 * records (once) that the learner accepted the privacy note, `false` withdraws it. `enabled` is the master (kill) switch,
 * `features` a partial map of the individual switches, `threshold` the confidence needed to fill a suggestion in.
 */
export async function saveJevSettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置必须是对象');
  const file = await readFileSettings(), next = { ...file };
  if (patch.key !== undefined) {
    const value = String(patch.key).trim();
    if (value && !KEY.test(value)) throw new Error('Jev 密钥格式不对，请重新复制 TypeSafe 控制台里的完整密钥');
    if (value) next.key = value; else delete next.key;
  }
  if (patch.confirm !== undefined) {
    if (bool(patch.confirm, 'confirm')) {
      const current = file.noticeVersion === JEV_NOTICE_VERSION && file.confirmedAt;
      next.confirmedAt = current || new Date().toISOString(); next.noticeVersion = JEV_NOTICE_VERSION;
    } else { delete next.confirmedAt; delete next.noticeVersion; }
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
