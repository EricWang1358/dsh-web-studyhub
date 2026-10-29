import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseStoredJson } from './util.js';
import { RetrievalError } from './retrieval.js';

/* Building the search index of a course (WP28b). The companion extension
   (packages/studyhub-retrieval) runs a local search server whose tools appear as
   mcp__studyhub__<tool>. StudyHub hands it each page of the course under the page's
   own source id (`studyhub://source/<id>`), so a search hit names the page exactly
   and needs no guessing. Only new or changed pages are sent; pages that left the
   library are removed. What was indexed is remembered per library in the DSH home. */

export const INDEX_SERVER = 'studyhub';
export const INDEX_TOOLS = Object.freeze({ ingest: `mcp__${INDEX_SERVER}__ingest_data`, delete: `mcp__${INDEX_SERVER}__delete_file`, query: `mcp__${INDEX_SERVER}__query_documents` });
export const SOURCE_PREFIX = 'studyhub://source/';
/** The embedding model the search server downloads on first use (its documentation: "about 90 MB"). */
export const MODEL_DOWNLOAD_MB = 90;
const INGEST_TIMEOUT_MS = 15 * 60 * 1000;
const SAVE_EVERY = 10;
const MAX_CONSECUTIVE_FAILURES = 5;
/** What the search server answers (MCP error -32602) when none of a page's lines is long enough to become a passage: the page has no searchable text, which is not a write failure. */
export const NO_CHUNKS_ANSWER = /No chunks generated/i;
/** The mark a manifest entry carries for such a page: { hash, at, skipped }. */
export const NO_CHUNKS_MARK = 'no-chunks';

export const sourceKey = id => `${SOURCE_PREFIX}${id}`;
export const sourceIdFromKey = value => typeof value === 'string' && value.startsWith(SOURCE_PREFIX) && value.length > SOURCE_PREFIX.length ? value.slice(SOURCE_PREFIX.length) : undefined;
export const contentHash = text => createHash('sha256').update(String(text ?? '')).digest('hex');

/** The markdown a page is indexed as: its title, then its text. */
export const pageDocument = source => `# ${String(source.title ?? '').trim() || source.id}\n\n${source.text}`;

/** Where the search server keeps its data and where StudyHub keeps what it indexed. */
export const retrievalHome = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'retrieval');
export const manifestPath = root => join(retrievalHome(), 'manifests', `${createHash('sha256').update(String(root)).digest('hex').slice(0, 16)}.json`);

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

/** What this library has in the index: { sources: { [id]: { hash, at, skipped? } }, reset?: [ids that were indexed before the index was reset] }. */
export async function readManifest(root) {
  let sources = {}, carried = [];
  try {
    const value = parseStoredJson(await readFile(manifestPath(root), 'utf8'));
    if (value && typeof value === 'object' && value.sources && typeof value.sources === 'object') sources = value.sources;
    if (Array.isArray(value?.reset)) carried = value.reset.filter(id => typeof id === 'string');
  } catch { /* nothing indexed yet */ }
  const marker = await readResetMarker(), since = marker ? Date.parse(marker.at) : -Infinity, kept = {}, dropped = [];
  for (const [id, entry] of Object.entries(sources)) {
    if (!marker || Date.parse(entry?.at) > since) kept[id] = entry; else dropped.push(id);
  }
  const reset = [...new Set([...carried, ...dropped])].filter(id => !kept[id]);
  return { sources: kept, ...(reset.length ? { reset } : {}) };
}

/** Write the manifest whole to disk before it replaces the old one: a crash must not leave an empty file in its place. */
export async function writeManifest(root, manifest) {
  const target = manifestPath(root), temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const reset = (manifest.reset || []).filter(id => !manifest.sources?.[id]);
  await mkdir(join(retrievalHome(), 'manifests'), { recursive: true });
  const file = await open(temporary, 'w');
  try {
    await file.writeFile(`${JSON.stringify({ sources: manifest.sources, ...(reset.length ? { reset } : {}) })}\n`, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, target);
}

/** Whether the embedding model has been downloaded already (the search server's cache folder holds files). */
export async function modelCached() {
  try { return (await readdir(join(retrievalHome(), 'models'))).length > 0; } catch { return false; }
}

/**
 * What a build would do. `sources` are the course's pages, `library` the ids of every page in the library.
 * { add: pages new or changed since they were indexed, unchanged: count, skipped: count of pages recorded as having no searchable text (done until their text changes),
 * remove: indexed ids that left the library }.
 */
export function planIndex({ sources, library, manifest }) {
  const indexed = manifest?.sources || {}, present = new Set(library);
  const add = [];
  let skipped = 0;
  for (const source of sources) {
    const entry = indexed[source.id];
    if (entry?.hash !== contentHash(source.text)) add.push(source); else if (entry.skipped) skipped++;
  }
  return { add, unchanged: sources.length - add.length - skipped, skipped, remove: Object.keys(indexed).filter(id => !present.has(id)) };
}

/** Whether the search extension is running and offers the write tool: the one condition every build starts from. */
export const canIngest = port => (port?.tools?.() ?? []).some(tool => tool.name === INDEX_TOOLS.ingest);
export const indexUnavailable = () => new RetrievalError('retrieval-index-unavailable', '检索扩展还没有运行。请先在「设置 › 检索扩展」安装检索扩展；刚安装完请稍等几秒再试。');

const NETWORK = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|download|huggingface|certificate|proxy|getaddrinfo/i;
const modelFailure = () => new RetrievalError('retrieval-model-download', `没能下载检索模型（首次建立索引需要联网，约 ${MODEL_DOWNLOAD_MB} MB）。请检查网络后重试；如果所在网络访问不了默认的下载地址，可以在「设置 › 检索扩展」的高级选项里换一个模型下载地址。`);
const text = error => String(error?.message || error).slice(0, 300);

/**
 * Index the pages: one ingest call each, sequentially, under the page's source id.
 * `manifest` is updated in place (and handed to `save` every few pages and at the end);
 * `onProgress({ stage: 'model' | 'indexing', done, total })`; `onItem({ kind: 'ingest' | 'remove', id })` just before each write; `signal` stops between pages.
 * Resolves { added, removed, unchanged, skipped (pages with no searchable text, those recorded earlier included), failed: [{ id, message }] }.
 * A page the search server cannot cut into passages (NO_CHUNKS_ANSWER) is recorded in the manifest as `skipped` and counts neither as a failure nor towards the limit.
 * Rejects with a RetrievalError: retrieval-index-unavailable (the extension is not running),
 * retrieval-model-download (nothing could be indexed because the model could not be fetched),
 * retrieval-index-failed (several pages in a row failed; `error.summary` is what was done and what failed until then).
 */
export async function buildIndex({ port, sources, library, manifest, firstRun = false, signal, onProgress = () => {}, onItem = () => {}, save = async () => {} }) {
  if (!canIngest(port)) throw indexUnavailable();
  manifest.sources ||= {};
  const { add, unchanged, skipped, remove } = planIndex({ sources, library, manifest });
  const total = add.length + remove.length;
  const summary = { added: 0, removed: 0, unchanged, skipped, failed: [] };
  let done = 0, consecutive = 0, sinceSave = 0;
  const emit = stage => onProgress({ stage, done, total });
  const flush = async () => { sinceSave = 0; await save(manifest); };
  emit(firstRun && add.length ? 'model' : 'indexing');
  try {
    for (const source of add) {
      signal?.throwIfAborted();
      onItem({ kind: 'ingest', id: source.id });
      try {
        await port.call(INDEX_TOOLS.ingest, { content: pageDocument(source), metadata: { source: sourceKey(source.id), format: 'markdown' } }, { signal, timeoutMs: INGEST_TIMEOUT_MS });
        manifest.sources[source.id] = { hash: contentHash(source.text), at: new Date().toISOString() };
        summary.added++; consecutive = 0;
        if (++sinceSave >= SAVE_EVERY) await flush();
      } catch (error) {
        if (signal?.aborted) throw error;
        if (NO_CHUNKS_ANSWER.test(text(error))) {
          // The server keeps what it had under the key when it writes nothing: a page that was indexed with other text is taken out, as writing the changed page would have replaced it.
          const earlier = manifest.sources[source.id];
          if (earlier && !earlier.skipped) await port.call(INDEX_TOOLS.delete, { source: sourceKey(source.id) }, { signal }).catch(failure => { if (signal?.aborted) throw failure; });
          manifest.sources[source.id] = { hash: contentHash(source.text), at: new Date().toISOString(), skipped: NO_CHUNKS_MARK };
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
    }
    for (const id of remove) {
      signal?.throwIfAborted();
      onItem({ kind: 'remove', id });
      try { await port.call(INDEX_TOOLS.delete, { source: sourceKey(id) }, { signal }); } catch (error) { if (signal?.aborted) throw error; }
      delete manifest.sources[id];
      summary.removed++; done++;
      emit('indexing');
    }
  } finally { await flush().catch(() => {}); }
  return summary;
}
