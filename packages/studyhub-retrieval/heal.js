/* The search index's self-check before the server starts.
   A table whose newest files were cut short (a crash or power loss while it was being written leaves files of
   the right size full of zeros) opens with an empty schema, and the server then stops at every start because it
   cannot index the missing `text` field: the learner only sees that the search tools are gone. So before the
   server is mounted the table is checked, and a table the server could not use is moved aside (never deleted)
   to chunks.lance.broken-<time>, with <DSH home>/study/retrieval/reset.json saying when, why and where; the
   server then starts on an empty index and StudyHub asks for the index to be built again.

   Two checks, the cheap one first: (1) the files: the newest version manifest must be whole (Lance ends every
   manifest with the bytes "LANC"); (2) LanceDB itself, in a child process on the same Node the server runs on:
   the table must open and have a `text` field. (2) is skipped when the newest manifest is the one that passed
   last time (index-check.json). Anything uncertain (no LanceDB, a crash or timeout of the check) leaves the
   table where it is. Nothing here throws. */
import { spawn } from 'node:child_process';
import { open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TABLE = 'chunks';
/** What StudyHub reads to tell the learner the index was reset (lib/retrieval-index.js reads the same file). */
export const RESET_MARKER = 'reset.json';
const CHECKED = 'index-check.json';
const CHECK_TIMEOUT_MS = 20_000;
const U64_MAX = 18446744073709551615n;
const MAGIC = 'LANC';
/** The verdicts that move a table aside; anything else ('ok', 'absent', 'unknown') leaves it. */
export const BROKEN = new Set(['no-versions', 'torn-manifest', 'no-text-field', 'cannot-open']);

/** The version a manifest file name stands for: newer Lance names count down from 2^64-1, older ones count up. */
export function manifestVersion(name) {
  const match = /^(\d+)\.manifest$/.exec(name);
  if (!match) return null;
  const value = BigInt(match[1]);
  return value > (1n << 63n) ? U64_MAX - value : value;
}

/** <time> of chunks.lance.broken-<time>: the moment in UTC, safe in a Windows file name (20261023T101530Z). */
export const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

async function whole(path, size) {
  if (size < MAGIC.length * 2) return false;
  const handle = await open(path, 'r');
  try {
    const tail = Buffer.alloc(MAGIC.length);
    await handle.read(tail, 0, MAGIC.length, size - MAGIC.length);
    return tail.toString('latin1') === MAGIC;
  } finally { await handle.close(); }
}

/** The files of a table folder: { verdict: 'absent' | 'no-versions' | 'torn-manifest' | 'ok', newest?: { name, size, mtimeMs } }. */
export async function inspectFiles(tableDir) {
  try { if (!(await stat(tableDir)).isDirectory()) return { verdict: 'absent' }; } catch { return { verdict: 'absent' }; }
  const versions = join(tableDir, '_versions');
  let names = [];
  try { names = await readdir(versions); } catch { /* no versions folder at all */ }
  const manifests = names.map(name => ({ name, version: manifestVersion(name) })).filter(item => item.version !== null)
    .sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : 0));
  if (!manifests.length) return { verdict: 'no-versions' };
  const path = join(versions, manifests[0].name), info = await stat(path);
  const newest = { name: manifests[0].name, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
  return { verdict: await whole(path, info.size) ? 'ok' : 'torn-manifest', newest };
}

/**
 * Open the table with LanceDB (`lancedb`: the module's file URL) in a child process on `execPath`:
 * resolves { verdict: 'ok' | 'no-text-field' | 'cannot-open' | 'absent' | 'unknown', detail? }.
 */
export function inspectWithLanceDB({ dbPath, lancedb, execPath = process.execPath, electron = false, timeoutMs = CHECK_TIMEOUT_MS }) {
  return new Promise(resolve => {
    let settled = false, out = '';
    const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    let child;
    try {
      child = spawn(execPath, [fileURLToPath(new URL('./check-index.mjs', import.meta.url)), lancedb, dbPath, TABLE], {
        env: { ...process.env, ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (error) { resolve({ verdict: 'unknown', detail: String(error?.message || error) }); return; }
    const timer = setTimeout(() => { child.kill(); done({ verdict: 'unknown', detail: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', error => done({ verdict: 'unknown', detail: String(error?.message || error) }));
    child.on('close', () => {
      try { done(JSON.parse(out.trim().split(/\r?\n/).pop())); } catch { done({ verdict: 'unknown', detail: 'no answer' }); }
    });
  });
}

const sameAsChecked = async (data, newest) => {
  try {
    const last = JSON.parse(await readFile(join(data, CHECKED), 'utf8'));
    return last?.name === newest.name && last.size === newest.size && last.mtimeMs === newest.mtimeMs;
  } catch { return false; }
};

async function moveAside(tableDir, date) {
  const base = `${tableDir}.broken-${stamp(date)}`;
  for (let n = 1; ; n++) {
    const target = n === 1 ? base : `${base}-${n}`;
    try { await stat(target); } catch { await rename(tableDir, target); return target; }
  }
}

/**
 * Check the index under <home>/study/retrieval/lancedb and move it aside when the server could not use it.
 * `lancedb()` gives the LanceDB module's file URL (or throws when it cannot be found: the check is then skipped).
 * Resolves { reset?: { at, reason, movedTo } }; never rejects.
 */
export async function healIndex({ home, execPath = process.execPath, electron = false, lancedb = () => { throw new Error('no LanceDB'); },
  check = inspectWithLanceDB, now = () => new Date(), warn = () => {} }) {
  const data = join(home, 'study', 'retrieval'), dbPath = join(data, 'lancedb'), tableDir = join(dbPath, `${TABLE}.lance`);
  try {
    const files = await inspectFiles(tableDir);
    let verdict = files.verdict, detail = '';
    if (verdict === 'absent') return {};
    if (verdict === 'ok') {
      if (await sameAsChecked(data, files.newest)) return {};
      let module;
      try { module = lancedb(); } catch { return {}; }
      ({ verdict, detail = '' } = await check({ dbPath, lancedb: module, execPath, electron }));
      if (verdict === 'ok') { await writeFile(join(data, CHECKED), `${JSON.stringify(files.newest)}\n`).catch(() => {}); return {}; }
      if (!BROKEN.has(verdict)) return {};
    }
    const date = now(), movedTo = await moveAside(tableDir, date);
    const reset = { at: date.toISOString(), reason: verdict, movedTo };
    await writeFile(join(data, RESET_MARKER), `${JSON.stringify(reset)}\n`);
    warn(`The search index could not be used (${verdict}${detail ? `: ${String(detail).slice(0, 160)}` : ''}); it was moved to ${movedTo} and the server starts on an empty index.`);
    return { reset };
  } catch (error) {
    warn(`The search index could not be checked (${String(error?.message || error).slice(0, 160)}); the server starts as it is.`);
    return {};
  }
}
