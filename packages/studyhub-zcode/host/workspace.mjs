/* Where the ZCode edition keeps things: the StudyHub home (host-level state such as the task board, audio and update
   settings), the study library, and the ZCode config file with the library choice and the learner's model endpoint.
   Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

   - Home: DSH_HOME when it is set (a relative one is taken from the user folder, never from the folder ZCode starts the
     server in); else ~/.dsh when DeepSeek Harness is installed (so the board and settings stay shared with it); else
     ~/.zcode/studyhub. lib/ reads DSH_HOME at call time, so applyHome() sets it before anything runs.
   - Library: STUDYHUB_LIBRARY when it is set; else the folder the learner chose in the panel (saved here); else
     <Documents>/StudyHub, with the Documents folder Windows really uses (it may be moved, e.g. to OneDrive or D:, and
     its path may hold any characters). A folder that cannot be created and written is never used: the next one in that
     order is, and the problem is reported (resolveLibrary), so the server always starts.
   - Model: any OpenAI-compatible endpoint the learner fills in; the key may come from STUDYHUB_API_KEY instead.
   Text from Windows programs never goes through the console code page: PowerShell answers in base64 of UTF-8. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zcodeError } from './messages.mjs';
import { importLib } from './lib-root.mjs';

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** A Windows system program by its full path (never a bare name: ZCode starts the server in the chat's folder). */
export const systemProgram = (...parts) => win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', ...parts);
export const powershellPath = () => systemProgram('WindowsPowerShell', 'v1.0', 'powershell.exe');

/** PowerShell's answer: the script (statements allowed) must leave one string; it comes back as base64 of its UTF-8 bytes,
 *  so no console code page touches it. */
export const base64Script = (script) =>
  `$v = $(${script}); if ($null -eq $v) { $v = '' }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$v))`;

/** Decode what PowerShell printed for base64Script: null for anything that is not clean base64 of valid UTF-8. */
export function decodeBase64Output(output) {
  const raw = Buffer.isBuffer(output) ? output.toString('latin1') : String(output ?? '');
  const ascii = raw.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(ascii)) return null;
  const decoded = Buffer.from(ascii, 'base64').toString('utf8');
  return decoded.includes('\uFFFD') ? null : decoded;
}

/** Run one PowerShell expression and answer its string, or null. `run(file, args)` returns stdout bytes (injected in tests). */
export function powershellText(expression, { run = defaultRun } = {}) {
  try {
    return decodeBase64Output(run(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', base64Script(expression)]));
  } catch { return null; }
}

function defaultRun(file, args) {
  return execFileSync(file, args, { timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'buffer' });
}

/** A path read from a program is usable only when it is absolute and decoded cleanly. */
export const cleanPath = (value) => {
  const path = text(value);
  return path && !path.includes('\uFFFD') && win32.isAbsolute(path) ? path : null;
};

const documentsCache = new Map();
/** The learner's Documents folder (Windows: the shell's own answer, wherever it was moved; once per process). */
export function documentsFolder({ platform = process.platform, homedir = osHomedir(), run, fresh = false } = {}) {
  if (platform !== 'win32') return join(homedir, 'Documents');
  const key = homedir;
  if (!fresh && !run && documentsCache.has(key)) return documentsCache.get(key);
  const found = cleanPath(powershellText("[Environment]::GetFolderPath('MyDocuments')", { ...(run ? { run } : {}) }));
  const folder = found || join(homedir, 'Documents');
  if (!run) documentsCache.set(key, folder);
  return folder;
}

/** A new learner's library: <Documents>/StudyHub. */
export const defaultLibrary = (options) => join(documentsFolder(options), 'StudyHub');

/** { home, source: 'env' | 'dsh' | 'zcode', relative? } for these environment variables. */
export function resolveHome(env = process.env, { homedir = osHomedir(), exists = existsSync } = {}) {
  const set = text(env.DSH_HOME);
  if (set) return isAbsolute(set) ? { home: resolve(set), source: 'env' } : { home: resolve(homedir, set), source: 'env', relative: true };
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

/** Why a folder cannot hold a library, as a reason code. */
export function failureReason(error) {
  switch (error?.code) {
    case 'ENOENT': return 'missing';
    case 'EPERM': case 'EACCES': return 'denied';
    case 'EROFS': return 'read-only';
    case 'ENOTDIR': case 'EEXIST': return 'not-folder';
    case 'not-absolute': return 'not-absolute';
    default: return `error:${error?.code || 'unknown'}`;
  }
}

/** Can `root` hold a library? It is created if missing and a probe file is written and removed. { ok } or { ok: false, reason }. */
export function checkLibrary(root) {
  if (!text(root) || !isAbsolute(text(root))) return { ok: false, reason: 'not-absolute' };
  const folder = resolve(text(root));
  try {
    mkdirSync(folder, { recursive: true });
    if (!statSync(folder).isDirectory()) return { ok: false, reason: 'not-folder' };
    const probe = join(folder, `.studyhub-write-check-${randomUUID()}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
    return { ok: true };
  } catch (error) { return { ok: false, reason: failureReason(error) }; }
}

/** The library a DSH binding file in the folder points at (lib/host.js binding: its saved root wins), else the folder itself. */
export function boundRoot(root) {
  try {
    const raw = readFileSync(join(root, '.dsh-study-binding.json'), 'utf8');
    const saved = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return typeof saved?.root === 'string' && isAbsolute(saved.root.trim()) ? saved.root.trim() : root;
  } catch { return root; }
}

export function readSaved(home) {
  try {
    const raw = readFileSync(configPath(home), 'utf8');
    const value = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/**
 * Change the config: one writer at a time across processes (lib/store-lock.js, the lock lib/update-check.js uses for the
 * same folder), read-modify-write inside the lock, written to a temporary file and moved into place with the retries
 * lib/atomic-json.js uses on Windows; a failed write leaves no temporary file behind. The key file is protected by the
 * user profile's own permissions (mode 600 where the system has modes).
 */
export async function updateSaved(home, change) {
  const [{ withStoreLock }, { renameWithRetry }] = await Promise.all([importLib('store-lock.js'), importLib('atomic-json.js')]);
  const folder = join(home, 'study');
  await mkdir(folder, { recursive: true });
  return withStoreLock(folder, async () => {
    const saved = readSaved(home);
    const answer = await change(saved);
    const file = configPath(home), temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(saved, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      await renameWithRetry(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return answer;
  });
}

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
 * The library in use: the first of STUDYHUB_LIBRARY, the chosen folder, the default and <home>/StudyHub that can be
 * created and written. { libraryRoot, rootSource: 'env' | 'custom' | 'default' | 'fallback', defaultRoot, problem }, where
 * `problem` ({ root, source, reason }) names the configured folder that could not be used. `check` is checkLibrary (tests).
 */
export function resolveLibrary({ env = process.env, home, saved = {}, documents, check = checkLibrary } = {}) {
  // STUDYHUB_TEST_DOCUMENTS: tests that start the server or the hook as a process point the Documents folder at a
  // temporary one, so no test ever creates a folder in the real Documents.
  const docs = documents || text(env.STUDYHUB_TEST_DOCUMENTS);
  const defaultRoot = resolve(docs ? join(docs, 'StudyHub') : defaultLibrary());
  const fromEnv = text(env.STUDYHUB_LIBRARY), chosen = text(saved.libraryRoot);
  const candidates = [
    ...(fromEnv ? [{ root: fromEnv, source: 'env' }] : []),
    ...(chosen ? [{ root: chosen, source: 'custom' }] : []),
    { root: defaultRoot, source: 'default' },
    { root: join(home, 'StudyHub'), source: 'fallback' },
  ];
  let problem = null;
  for (const candidate of candidates) {
    const verdict = check(candidate.root);
    if (verdict.ok) return { libraryRoot: boundRoot(resolve(candidate.root)), rootSource: candidate.source, defaultRoot, problem };
    problem ||= { root: candidate.root, source: candidate.source, reason: verdict.reason };
  }
  // Nothing at all can be written (a full or locked profile): keep the default; the panel says why.
  return { libraryRoot: defaultRoot, rootSource: 'default', defaultRoot, problem };
}

/** The whole ZCode configuration: the home, the library in use (resolveLibrary) and the model. */
export function readConfig({ env = process.env, home = resolveHome(env).home, documents, check } = {}) {
  const saved = readSaved(home);
  return { home, ...resolveLibrary({ env, home, saved, documents, check }), model: modelOf(saved, env) };
}

/** Save the library folder ('' = back to the default). A folder that cannot hold a library is refused and nothing changes. */
export async function saveLibraryRoot(home, root, { check = checkLibrary } = {}) {
  const clean = text(root);
  if (clean && !isAbsolute(clean)) throw zcodeError('library-not-absolute');
  if (clean) {
    const verdict = check(clean);
    if (!verdict.ok) throw zcodeError('library-unusable', [verdict.reason]);
  }
  await updateSaved(home, (saved) => { if (clean) saved.libraryRoot = resolve(clean); else delete saved.libraryRoot; });
}

/** An API key as providers issue them: printable ASCII without spaces, at most 512 characters. */
export const validKey = (key) => /^[\x21-\x7e]{1,512}$/.test(key);

const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };

/**
 * Save the endpoint. `apiKey` undefined keeps the saved key, '' clears it. A new address on another origin drops the saved
 * key (a key is for one provider: it is never sent to another), unless a key comes with it. Answers { model, keyDropped }.
 */
export async function saveModel(home, { baseUrl, model, label, apiKey } = {}, env = process.env) {
  let url;
  if (baseUrl !== undefined) {
    url = text(baseUrl).replace(/\/+$/, '');
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw zcodeError('model-url-invalid'); }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw zcodeError('model-url-invalid');
    }
  }
  const key = apiKey === undefined ? undefined : text(apiKey);
  if (key && !validKey(key)) throw zcodeError('model-key-invalid');
  return updateSaved(home, (saved) => {
    const current = saved.model && typeof saved.model === 'object' ? saved.model : {};
    const next = { ...current };
    let keyDropped = false;
    if (url !== undefined) {
      if (current.apiKey && key === undefined && originOf(url) !== originOf(current.baseUrl)) { delete next.apiKey; keyDropped = true; }
      next.baseUrl = url;
    }
    if (model !== undefined) next.id = text(model);
    if (label !== undefined) next.label = text(label);
    if (key !== undefined) { if (key) next.apiKey = key; else delete next.apiKey; }
    saved.model = next;
    return { model: modelOf(saved, env), keyDropped };
  });
}

/** The key as the panel may see it: whether one is saved and its last four characters, never the key. */
export const keyHint = (key) => (key ? `••••${key.slice(-4)}` : '');
