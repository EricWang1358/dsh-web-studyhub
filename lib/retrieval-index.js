import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicJson } from './atomic-json.js';
import { canonicalPathKey } from './store-lock.js';
import { retrievalRootId } from './retrieval-settings.js';
import { studyHomePath } from './runtime/dsh-home.js';
import { parseStoredJson } from './util.js';
import {
  INDEX_KEY_VERSION,
  RetrievalError,
  SCOPED_SOURCE_PREFIX,
  SOURCE_PREFIX,
  normalizeLibraryId,
  parseSourceKey,
  scopedSourcePrefix,
  sourceIdFromKey,
  sourceKey,
} from './retrieval.js';
import { ingestPages } from './retrieval-index-ingest.js';

/* Building the search index of a course (WP28b). The companion extension
   (packages/studyhub-retrieval) runs a local search server whose tools appear as
   mcp__studyhub__<tool>. StudyHub hands it each page of the course under a
   library-isolated source URI (`studyhub://lib/<libraryId>/source/<id>`, upgraded
   from legacy `studyhub://source/<id>`), so colliding source ids across libraries
   never overwrite or delete each other's chunks and hits resolve deterministically.
   Only new, changed, or legacy-unmigrated pages are sent; pages that left the
   library are removed. What was indexed is remembered per library in the DSH home. */

export const INDEX_SERVER = 'studyhub';
export const INDEX_TOOLS = Object.freeze({ ingest: `mcp__${INDEX_SERVER}__ingest_data`, delete: `mcp__${INDEX_SERVER}__delete_file`, query: `mcp__${INDEX_SERVER}__query_documents` });
export {
  INDEX_KEY_VERSION,
  SCOPED_SOURCE_PREFIX,
  SOURCE_PREFIX,
  normalizeLibraryId,
  parseSourceKey,
  scopedSourcePrefix,
  sourceIdFromKey,
  sourceKey,
};
/** The embedding model the search server downloads on first use (its documentation: "about 90 MB"). */
export const MODEL_DOWNLOAD_MB = 90;
const INGEST_TIMEOUT_MS = 15 * 60 * 1000;
const SAVE_EVERY = 10;
const MAX_CONSECUTIVE_FAILURES = 5;
/** What the search server answers (MCP error -32602) when none of a page's lines is long enough to become a passage: the page has no searchable text, which is not a write failure. */
export const NO_CHUNKS_ANSWER = /No chunks generated/i;
/** The mark a manifest entry carries for such a page: { hash, at, skipped }. */
export const NO_CHUNKS_MARK = 'no-chunks';

export const contentHash = text => createHash('sha256').update(String(text ?? '')).digest('hex');

/** Effective key namespace version of a manifest entry (`1` = legacy unscoped, `2` = library-isolated). */
export function entryKeyVersion(entry, manifestVersion = 1) {
  const explicit = Number(entry?.v);
  if (Number.isInteger(explicit) && explicit >= 1) return explicit;
  const fallback = Number(manifestVersion);
  return Number.isInteger(fallback) && fallback >= 1 ? fallback : 1;
}

/** Whether a manifest still contains non-skipped legacy entries that need migration to library-isolated keys. */
export function manifestNeedsMigration(manifest) {
  const entries = manifest?.sources || {};
  const manifestVersion = Number(manifest?.keyVersion) || 1;
  return Object.values(entries).some(entry => entry && !entry.skipped && entryKeyVersion(entry, manifestVersion) < INDEX_KEY_VERSION);
}

/** The markdown a page is indexed as: its title, then its text. */
export const pageDocument = source => `# ${String(source.title ?? '').trim() || source.id}\n\n${source.text}`;

/** Where the search server keeps its data and where StudyHub keeps what it indexed. */
export const retrievalHome = () => studyHomePath('retrieval');
export const manifestPath = root => join(retrievalHome(), 'manifests', `${retrievalRootId(root)}.json`);
const legacyManifestPath = root => join(retrievalHome(), 'manifests', `${createHash('sha256').update(String(root)).digest('hex').slice(0, 16)}.json`);

/**
 * Symmetric cross-process lock settings for `<studyHome>/retrieval/.index.lock`, matching StudyHub Desktop
 * (`packages/studyhub-desktop/adapters/retrieval/index-lock.mjs`) with generous long-write retry backoff.
 */
export const INDEX_LOCK_DEFAULTS = Object.freeze({
  stale: 30_000,
  update: 10_000,
  retries: Object.freeze({
    retries: 60,
    factor: 1.3,
    minTimeout: 200,
    maxTimeout: 5000,
    randomize: true,
  }),
});
export const indexLockPath = (retrievalDir = retrievalHome()) => join(resolve(retrievalDir), '.index.lock');

const indexLockTails = new Map();
const indexLockHolding = new AsyncLocalStorage();

function createAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error('Retrieval index operation aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

/**
 * Execute `work()` while holding `<studyHome>/retrieval/.index.lock` via `proper-lockfile`,
 * coordinating concurrent index writes/updates/deletes between DSH and StudyHub Desktop.
 */
export function withIndexLock(work, {
  retrievalDir = retrievalHome(),
  signal,
  stale = INDEX_LOCK_DEFAULTS.stale,
  update = INDEX_LOCK_DEFAULTS.update,
  retries = INDEX_LOCK_DEFAULTS.retries,
} = {}) {
  if (signal?.aborted) return Promise.reject(createAbortError(signal));
  const rootDir = resolve(retrievalDir);
  const key = canonicalPathKey(rootDir);
  if (indexLockHolding.getStore()?.has(key)) return Promise.resolve().then(work);
  const lockfilePath = join(rootDir, '.index.lock');
  const turn = (indexLockTails.get(key) ?? Promise.resolve()).then(async () => {
    if (signal?.aborted) throw createAbortError(signal);
    await mkdir(rootDir, { recursive: true });
    let release;
    try {
      release = await lockfile.lock(rootDir, { lockfilePath, realpath: false, stale, update, retries });
    } catch (error) {
      if (error?.code === 'ELOCKED') {
        throw new RetrievalError('retrieval-index-locked', '检索索引正被另一处写入占用（可能是桌面端或其他任务正在更新索引），请稍后重试。');
      }
      throw error;
    }
    try {
      if (signal?.aborted) throw createAbortError(signal);
      return await indexLockHolding.run(new Set([...(indexLockHolding.getStore() ?? []), key]), work);
    } finally {
      await release().catch(() => {});
    }
  });
  const tail = turn.then(() => {}, () => {});
  indexLockTails.set(key, tail);
  void tail.then(() => { if (indexLockTails.get(key) === tail) indexLockTails.delete(key); });
  return turn;
}

/* When the index itself was reset (the search extension moved a broken one aside before its server started, or the learner chose 修复), the extension or
   StudyHub writes <retrieval home>/reset.json { at, reason, movedTo }. The index is shared by every library, so from then on a page counts as indexed
   only when it was written after `at`; the pages indexed before are listed as `reset` until they are indexed again. */
export const RESET_MARKER = 'reset.json';

/** The last reset of the index: { at, reason, movedTo } or null. */
export async function readResetMarker() {
  try {
    const value = parseStoredJson(await readFile(join(retrievalHome(), RESET_MARKER), 'utf8'));
    if (value && typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)))
      return { at: value.at, reason: typeof value.reason === 'string' ? value.reason : 'unknown', movedTo: typeof value.movedTo === 'string' ? value.movedTo : null };
  } catch { /* never reset */ }
  return null;
}

/** What this library has in the index: { sources: { [id]: { hash, at, skipped?, v? } }, libraryId, keyVersion, legacyMigration?, legacyCount?, reset?: [...] }. */
export async function readManifest(root) {
  const libraryId = retrievalRootId(root);
  let sources = {}, carried = [], storedVersion = null;
  const primary = manifestPath(root), fallback = legacyManifestPath(root);
  let raw = null;
  try { raw = await readFile(primary, 'utf8'); }
  catch { if (fallback !== primary) { try { raw = await readFile(fallback, 'utf8'); } catch { /* nothing indexed yet */ } } }
  if (raw !== null) {
    try {
      const value = parseStoredJson(raw);
      if (value && typeof value === 'object' && value.sources && typeof value.sources === 'object') sources = value.sources;
      if (Array.isArray(value?.reset)) carried = value.reset.filter(id => typeof id === 'string');
      if (Number.isInteger(Number(value?.keyVersion)) && Number(value.keyVersion) >= 1) storedVersion = Number(value.keyVersion);
    } catch { /* unreadable manifest */ }
  }
  const effectiveStoredVersion = storedVersion ?? (Object.keys(sources).length > 0 ? 1 : INDEX_KEY_VERSION);
  const marker = await readResetMarker(), since = marker ? Date.parse(marker.at) : -Infinity, kept = {}, dropped = [];
  let legacyCount = 0;
  for (const [id, entry] of Object.entries(sources)) {
    if (!marker || Date.parse(entry?.at) > since) {
      kept[id] = entry;
      if (!entry?.skipped && entryKeyVersion(entry, effectiveStoredVersion) < INDEX_KEY_VERSION) legacyCount++;
    } else dropped.push(id);
  }
  const reset = [...new Set([...carried, ...dropped])].filter(id => !kept[id]);
  return {
    sources: kept,
    libraryId,
    keyVersion: legacyCount > 0 ? 1 : INDEX_KEY_VERSION,
    ...(legacyCount > 0 ? { legacyMigration: true, legacyCount } : {}),
    ...(reset.length ? { reset } : {}),
  };
}

/** Write the manifest whole to disk before it replaces the old one: a crash must not leave an empty file in its place. */
export async function writeManifest(root, manifest, { lockOptions } = {}) {
  const target = manifestPath(root);
  const libraryId = normalizeLibraryId(manifest.libraryId) || retrievalRootId(root);
  const reset = (manifest.reset || []).filter(id => !manifest.sources?.[id]);
  const keyVersion = manifestNeedsMigration(manifest) ? 1 : INDEX_KEY_VERSION;
  await withIndexLock(
    () => atomicJson(target, { libraryId, keyVersion, sources: manifest.sources, ...(reset.length ? { reset } : {}) }, { trailingNewline: true, ensureDir: true, sync: true }),
    lockOptions,
  );
}

/** Whether the embedding model has been downloaded already (the search server's cache folder holds files). */
export async function modelCached() {
  try { return (await readdir(join(retrievalHome(), 'models'))).length > 0; } catch { return false; }
}

/**
 * What a build would do. `sources` are the course's pages, `library` the ids of every page in the library.
 * { add: pages new, changed, or needing namespace migration since they were indexed, unchanged: count,
 * skipped: count of pages recorded as having no searchable text (done until their text changes),
 * remove: indexed ids that left the library }.
 */
export function planIndex({ sources, library, manifest, libraryId }) {
  const indexed = manifest?.sources || {}, present = new Set(library);
  const lib = normalizeLibraryId(libraryId) || normalizeLibraryId(manifest?.libraryId);
  const manifestVersion = Number(manifest?.keyVersion) || (lib ? 1 : INDEX_KEY_VERSION);
  const add = [];
  let skipped = 0;
  for (const source of sources) {
    const entry = indexed[source.id];
    const needsMigration = Boolean(lib && entry && !entry.skipped && entryKeyVersion(entry, manifestVersion) < INDEX_KEY_VERSION);
    if (entry?.hash !== contentHash(source.text) || needsMigration) add.push(source);
    else if (entry.skipped) skipped++;
  }
  return { add, unchanged: sources.length - add.length - skipped, skipped, remove: Object.keys(indexed).filter(id => !present.has(id)) };
}

/** Whether the search extension is running and offers the write tool: the one condition every build starts from. */
export const canIngest = port => (port?.tools?.() ?? []).some(tool => tool.name === INDEX_TOOLS.ingest);
export const indexUnavailable = () => new RetrievalError('retrieval-index-unavailable', '检索扩展还没有运行。请先在「设置 › 检索扩展」安装检索扩展；刚安装完请稍等几秒再试。');

const NETWORK = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|download|huggingface|certificate|proxy|getaddrinfo/i;
const modelFailure = () => new RetrievalError('retrieval-model-download', `没能下载检索模型（首次建立索引需要联网，约 ${MODEL_DOWNLOAD_MB} MB）。请检查网络后重试；如果所在网络访问不了默认的下载地址，可以在「设置 › 检索扩展」的高级选项里换一个模型下载地址。`);
const text = error => String(error?.message || error).slice(0, 300);

function syncManifestVersion(manifest, lib) {
  if (!lib) return;
  manifest.libraryId = lib;
  if (manifestNeedsMigration(manifest)) {
    manifest.keyVersion = 1;
  } else {
    manifest.keyVersion = INDEX_KEY_VERSION;
    delete manifest.legacyMigration;
    delete manifest.legacyCount;
  }
}

/**
 * Index each page under its library-isolated source key, using bounded batches when the extension offers them.
 * `manifest` is updated in place (and handed to `save` every few pages and at the end);
 * `onProgress({ stage: 'model' | 'indexing', done, total })`; `onItem({ kind: 'ingest' | 'remove', id })` just before each write; `signal` stops between pages.
 * Resolves { added, removed, unchanged, skipped (pages with no searchable text, those recorded earlier included), failed: [{ id, message }] }.
 * A page the search server cannot cut into passages (NO_CHUNKS_ANSWER) is recorded in the manifest as `skipped` and counts neither as a failure nor towards the limit.
 * Rejects with a RetrievalError: retrieval-index-unavailable (the extension is not running),
 * retrieval-model-download (nothing could be indexed because the model could not be fetched),
 * retrieval-index-failed (several pages in a row failed; `error.summary` is what was done and what failed until then).
 */
export async function buildIndex({ port, sources, library, manifest, libraryId, firstRun = false, signal, onProgress = () => {}, onItem = () => {}, save = async () => {}, lockOptions }) {
  if (!canIngest(port)) throw indexUnavailable();
  return withIndexLock(async () => {
    manifest.sources ||= {};
    const lib = normalizeLibraryId(libraryId) || normalizeLibraryId(manifest?.libraryId);
    const priorManifestVersion = Number(manifest?.keyVersion) || (lib ? 1 : INDEX_KEY_VERSION);
    const keyOf = id => sourceKey(id, lib);
    const { add, unchanged, skipped, remove } = planIndex({ sources, library, manifest, libraryId: lib });
    const total = add.length + remove.length;
    const summary = { added: 0, removed: 0, unchanged, skipped, failed: [] };
    let done = 0, consecutive = 0, sinceSave = 0;
    const emit = stage => onProgress({ stage, done, total });
    const flush = async () => {
      sinceSave = 0;
      syncManifestVersion(manifest, lib);
      await save(manifest);
    };
    emit(firstRun && add.length ? 'model' : 'indexing');
    try {
      for await (const { source, error: ingestError, batchEnd } of ingestPages({ port, add, document: pageDocument, sourceKey: keyOf, ingestTool: INDEX_TOOLS.ingest,
        timeoutMs: INGEST_TIMEOUT_MS, signal, onItem })) {
        try {
          if (ingestError) throw ingestError;
          const writtenKey = keyOf(source.id);
          const plainKey = `${scopedSourcePrefix(lib)}${source.id}`;
          manifest.sources[source.id] = {
            hash: contentHash(source.text),
            at: new Date().toISOString(),
            ...(lib ? { v: INDEX_KEY_VERSION } : {}),
            ...(writtenKey !== plainKey ? { key: writtenKey } : {}),
          };
          summary.added++; consecutive = 0;
          if (++sinceSave >= SAVE_EVERY) await flush();
        } catch (error) {
          if (signal?.aborted) throw error;
          if (NO_CHUNKS_ANSWER.test(text(error))) {
            // The server keeps what it had under the key when it writes nothing: a page that was indexed with other text is taken out, as writing the changed page would have replaced it.
            // Never delete a legacy unscoped key when library isolation is active, as another library may share that legacy sourceId.
            const earlier = manifest.sources[source.id];
            const canDeleteEarlier = earlier && !earlier.skipped && (!lib || entryKeyVersion(earlier, priorManifestVersion) >= INDEX_KEY_VERSION);
            if (canDeleteEarlier) await port.call(INDEX_TOOLS.delete, { source: earlier?.key || keyOf(source.id) }, { signal }).catch(failure => { if (signal?.aborted) throw failure; });
            manifest.sources[source.id] = { hash: contentHash(source.text), at: new Date().toISOString(), skipped: NO_CHUNKS_MARK, ...(lib ? { v: INDEX_KEY_VERSION } : {}) };
            summary.skipped++;
            if (++sinceSave >= SAVE_EVERY) await flush();
          } else {
            if (summary.added === 0 && summary.failed.length === 0 && NETWORK.test(text(error))) throw modelFailure();
            summary.failed.push({ id: source.id, message: text(error) });
            if (++consecutive >= MAX_CONSECUTIVE_FAILURES)
              throw Object.assign(new RetrievalError('retrieval-index-failed', `连续 ${consecutive} 页没能写入索引，已停止：${text(error)}`), { summary });
          }
        }
        done++;
        emit('indexing');
        if (batchEnd) await flush();
      }
      for (const id of remove) {
        signal?.throwIfAborted();
        onItem({ kind: 'remove', id });
        const earlier = manifest.sources[id];
        const canDeleteRemote = !lib || entryKeyVersion(earlier, priorManifestVersion) >= INDEX_KEY_VERSION;
        if (canDeleteRemote) {
          try { await port.call(INDEX_TOOLS.delete, { source: earlier?.key || keyOf(id) }, { signal }); } catch (error) { if (signal?.aborted) throw error; }
        }
        delete manifest.sources[id];
        summary.removed++; done++;
        emit('indexing');
      }
    } catch (error) {
      if (!signal?.aborted && summary.added === 0 && summary.failed.length === 0 && NETWORK.test(text(error))) throw modelFailure();
      throw error;
    } finally { await flush().catch(() => {}); }
    return summary;
  }, { signal, ...lockOptions });
}
