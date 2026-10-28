/* Where the ZCode edition keeps things: the StudyHub home (host-level state such as the task board, audio and update
   settings), the study library, and the ZCode config file with the library choice and the learner's model endpoint.
   Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

   - Home: DSH_HOME when it is set; else ~/.dsh when DeepSeek Harness is installed (so the board and settings stay shared
     with it); else ~/.zcode/studyhub. lib/ reads DSH_HOME at call time, so applyHome() sets it before anything runs.
   - Library: STUDYHUB_LIBRARY when it is set; else the folder the learner chose in the panel (saved here); else
     <Documents>/StudyHub, with the Documents folder Windows really uses (it may be moved, e.g. to OneDrive or D:).
   - Model: any OpenAI-compatible endpoint the learner fills in; the key may come from STUDYHUB_API_KEY instead. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zcodeError } from './messages.mjs';

/** { home, source: 'env' | 'dsh' | 'zcode' } for these environment variables. */
export function resolveHome(env = process.env, { homedir = osHomedir(), exists = existsSync } = {}) {
  const set = env.DSH_HOME?.trim();
  if (set) return { home: resolve(set), source: 'env' };
  const dsh = join(homedir, '.dsh');
  return exists(dsh) ? { home: dsh, source: 'dsh' } : { home: join(homedir, '.zcode', 'studyhub'), source: 'zcode' };
}

/** Resolve the home once and give it to lib/ (which reads DSH_HOME on every call). */
export function applyHome(env = process.env, options) {
  const resolved = resolveHome(env, options);
  env.DSH_HOME = resolved.home;
  return resolved;
}

export const configPath = (home) => join(home, 'study', 'zcode.json');

/* Windows keeps the real Documents path in the registry (Shell Folders › Personal); a redirected or moved Documents
   folder is only found there. One `reg query` of at most 3 s; any failure falls back to ~/Documents. */
function windowsDocuments({ run = execFileSync } = {}) {
  try {
    const out = String(run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', '/v', 'Personal'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
    const found = out.match(/Personal\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m)?.[1];
    return found && isAbsolute(found) ? found : null;
  } catch { return null; }
}

/** The learner's Documents folder. */
export function documentsFolder({ platform = process.platform, homedir = osHomedir(), run } = {}) {
  return (platform === 'win32' && windowsDocuments({ run })) || join(homedir, 'Documents');
}

/** A new learner's library: <Documents>/StudyHub. */
export const defaultLibrary = (options) => join(documentsFolder(options), 'StudyHub');

function readSaved(home) {
  try {
    const raw = readFileSync(configPath(home), 'utf8');
    const value = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** Write the config atomically; the file holds an API key, so it is the learner's alone where the system allows that. */
export function writeSaved(home, value) {
  const file = configPath(home), temporary = `${file}.${randomUUID()}.tmp`;
  mkdirSync(join(home, 'study'), { recursive: true });
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** The saved endpoint as the model call uses it: { baseUrl, id, label, apiKey, keySource } or null when nothing is saved. */
export function modelOf(saved = {}, env = process.env) {
  const model = saved.model && typeof saved.model === 'object' ? saved.model : null;
  const envKey = text(env.STUDYHUB_API_KEY);
  const baseUrl = text(model?.baseUrl).replace(/\/+$/, ''), id = text(model?.id);
  const fileKey = text(model?.apiKey);
  if (!baseUrl && !id && !fileKey && !envKey) return null;
  return { baseUrl, id, label: text(model?.label), apiKey: envKey || fileKey, keySource: envKey ? 'env' : fileKey ? 'file' : '' };
}

/** A model the background work can call: address, model id and key all present. */
export const modelReady = (model) => !!(model?.baseUrl && model.id && model.apiKey);

/**
 * The whole ZCode configuration: { home, homeSource, libraryRoot, rootSource: 'env' | 'custom' | 'default', defaultRoot, model }.
 * `documents` overrides how the default library is found (tests).
 */
export function readConfig({ env = process.env, home = resolveHome(env).home, documents } = {}) {
  const saved = readSaved(home);
  const defaultRoot = documents ? join(documents, 'StudyHub') : defaultLibrary();
  const fromEnv = text(env.STUDYHUB_LIBRARY), chosen = text(saved.libraryRoot);
  const libraryRoot = resolve(fromEnv || chosen || defaultRoot);
  return { home, libraryRoot, rootSource: fromEnv ? 'env' : chosen ? 'custom' : 'default', defaultRoot: resolve(defaultRoot),
    model: modelOf(saved, env) };
}

/** Save the library folder ('' = back to the default). */
export function saveLibraryRoot(home, root) {
  const saved = readSaved(home), clean = text(root);
  if (clean && !isAbsolute(clean)) throw zcodeError('library-not-absolute');
  if (clean) saved.libraryRoot = resolve(clean); else delete saved.libraryRoot;
  writeSaved(home, saved);
}

/** Save the endpoint. `apiKey` undefined keeps the saved key, '' clears it. Answers the stored model. */
export function saveModel(home, { baseUrl, model, label, apiKey } = {}, env = process.env) {
  const saved = readSaved(home), current = saved.model && typeof saved.model === 'object' ? saved.model : {};
  const next = { ...current };
  if (baseUrl !== undefined) {
    const url = text(baseUrl).replace(/\/+$/, '');
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw zcodeError('model-url-invalid'); }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw zcodeError('model-url-invalid');
    }
    next.baseUrl = url;
  }
  if (model !== undefined) next.id = text(model);
  if (label !== undefined) next.label = text(label);
  if (apiKey !== undefined) { const key = text(apiKey); if (key) next.apiKey = key; else delete next.apiKey; }
  saved.model = next;
  writeSaved(home, saved);
  return modelOf(saved, env);
}

/** The key as the panel may see it: whether one is saved and its last four characters, never the key. */
export const keyHint = (key) => (key ? `••••${key.slice(-4)}` : '');
