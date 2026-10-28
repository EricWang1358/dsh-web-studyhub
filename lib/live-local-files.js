import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, rename as fsRename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/* The files of the local live engine's install (lib/live-local-install.js) after they are in place: what each unpacked engine file was when it was
   installed (its size, and the sha256 of every file), whether it still is (so an engine an antivirus quarantined or altered reads "needs repair",
   not "ready"), the room the unfinished steps still need, and a rename that waits out a scanner holding a fresh folder for a moment. */

/** The native files of an engine package (the addon and onnxruntime): their content is checked, not only their size. */
export const NATIVE_FILE = /\.(node|dll|dylib|so)(\.\d+)*$/i;

const sha256OfFile = async file => {
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
};
/* A file's hash is read again only when its size or modification time changed: status is asked often, the engine's libraries are about 25 MB. */
const remembered = new Map();
export async function hashOf(file) {
  const info = await stat(file);
  const seen = remembered.get(file);
  if (seen && seen.size === info.size && seen.mtimeMs === info.mtimeMs) return seen.sha256;
  const sha256 = await sha256OfFile(file);
  remembered.set(file, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
  return sha256;
}

async function walk(folder, prefix = '') {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(path.join(folder, entry.name), relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

export const readJson = async file => { try { const value = JSON.parse(await readFile(file, 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };

/** Record what one unpacked package holds into the engine stamp (`<F>/engine/.verified.json`): { version, packages: { <name>: { <file>: { size, sha256 } } } }. */
export async function recordPackage(stampFile, modules, name, version) {
  const stamp = await readJson(stampFile), files = {};
  for (const relative of await walk(path.join(modules, name))) {
    const file = path.join(modules, name, ...relative.split('/'));
    files[relative] = { size: (await stat(file)).size, sha256: await hashOf(file) };
  }
  const next = { version, packages: { ...(stamp.version === version ? stamp.packages || {} : {}), [name]: files } };
  await writeFile(stampFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * Is one package still what was installed? Every recorded file exists with its recorded size, and the native files (or, with `deep`, every file)
 * still have their recorded sha256. A package with no record is not intact.
 */
export async function packageIntact(stamp, modules, name, version, { deep = false, hashes = true } = {}) {
  const files = stamp?.version === version ? stamp.packages?.[name] : null;
  if (!files || !Object.keys(files).length) return false;
  for (const [relative, want] of Object.entries(files)) {
    const file = path.join(modules, name, ...relative.split('/'));
    let size;
    try { size = (await stat(file)).size; } catch { return false; }
    if (size !== want.size) return false;
    if (hashes && (deep || NATIVE_FILE.test(relative)) && (await hashOf(file).catch(() => '')) !== want.sha256) return false;
  }
  return true;
}

/** Bytes still free to want for one file still to come: its full size, less what a resumable `.part` already holds. */
export async function partLeft(part, bytes) {
  const have = await stat(part).then(info => info.size, () => 0);
  return Math.max(0, bytes - Math.min(have, bytes));
}

/** Retry a rename that a virus scanner (or the indexer) blocks for a moment, as npm does: EPERM, EACCES and EBUSY, with a short growing pause. */
export async function renameWithRetry(from, to, { rename = fsRename, tries = 6, delayMs = 100 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await rename(from, to); }
    catch (error) {
      if (attempt >= tries || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}
