import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
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

export const sourceKey = id => `${SOURCE_PREFIX}${id}`;
export const sourceIdFromKey = value => typeof value === 'string' && value.startsWith(SOURCE_PREFIX) && value.length > SOURCE_PREFIX.length ? value.slice(SOURCE_PREFIX.length) : undefined;
export const contentHash = text => createHash('sha256').update(String(text ?? '')).digest('hex');

/** The markdown a page is indexed as: its title, then its text. */
export const pageDocument = source => `# ${String(source.title ?? '').trim() || source.id}\n\n${source.text}`;

/** Where the search server keeps its data and where StudyHub keeps what it indexed. */
export const retrievalHome = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'retrieval');
const manifestPath = root => join(retrievalHome(), 'manifests', `${createHash('sha256').update(String(root)).digest('hex').slice(0, 16)}.json`);

export async function readManifest(root) {
  try {
    const value = parseStoredJson(await readFile(manifestPath(root), 'utf8'));
    if (value && typeof value === 'object' && value.sources && typeof value.sources === 'object') return { sources: value.sources };
  } catch { /* nothing indexed yet */ }
  return { sources: {} };
}

export async function writeManifest(root, manifest) {
  const target = manifestPath(root), temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(join(retrievalHome(), 'manifests'), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ sources: manifest.sources })}\n`, 'utf8');
  await rename(temporary, target);
}

/** Whether the embedding model has been downloaded already (the search server's cache folder holds files). */
export async function modelCached() {
  try { return (await readdir(join(retrievalHome(), 'models'))).length > 0; } catch { return false; }
}

/**
 * What a build would do. `sources` are the course's pages, `library` the ids of every page in the library.
 * { add: pages new or changed since they were indexed, unchanged: count, remove: indexed ids that left the library }.
 */
export function planIndex({ sources, library, manifest }) {
  const indexed = manifest?.sources || {}, present = new Set(library);
  const add = sources.filter(source => indexed[source.id]?.hash !== contentHash(source.text));
  return { add, unchanged: sources.length - add.length, remove: Object.keys(indexed).filter(id => !present.has(id)) };
}

const NETWORK = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|download|huggingface|certificate|proxy|getaddrinfo/i;
const modelFailure = () => new RetrievalError('retrieval-model-download', `没能下载检索模型（首次建立索引需要联网，约 ${MODEL_DOWNLOAD_MB} MB）。请检查网络后重试；如果所在网络访问不了默认的下载地址，可以在「设置 › 扩展」的高级选项里换一个模型下载地址。`);
const text = error => String(error?.message || error).slice(0, 300);

/**
 * Index the pages: one ingest call each, sequentially, under the page's source id.
 * `manifest` is updated in place (and handed to `save` every few pages and at the end);
 * `onProgress({ stage: 'model' | 'indexing', done, total })`; `signal` stops between pages.
 * Resolves { added, removed, unchanged, failed: [{ id, message }] }.
 * Rejects with a RetrievalError: retrieval-index-unavailable (the extension is not running),
 * retrieval-model-download (nothing could be indexed because the model could not be fetched),
 * retrieval-index-failed (several pages in a row failed).
 */
export async function buildIndex({ port, sources, library, manifest, firstRun = false, signal, onProgress = () => {}, save = async () => {} }) {
  const names = new Set((port?.tools?.() ?? []).map(tool => tool.name));
  if (!names.has(INDEX_TOOLS.ingest)) throw new RetrievalError('retrieval-index-unavailable', '检索扩展还没有运行。请先在「设置 › 扩展」安装检索扩展；刚安装完请稍等几秒再试。');
  manifest.sources ||= {};
  const { add, unchanged, remove } = planIndex({ sources, library, manifest });
  const total = add.length + remove.length;
  const summary = { added: 0, removed: 0, unchanged, failed: [] };
  let done = 0, consecutive = 0, sinceSave = 0;
  const emit = stage => onProgress({ stage, done, total });
  const flush = async () => { sinceSave = 0; await save(manifest); };
  emit(firstRun && add.length ? 'model' : 'indexing');
  try {
    for (const source of add) {
      signal?.throwIfAborted();
      try {
        await port.call(INDEX_TOOLS.ingest, { content: pageDocument(source), metadata: { source: sourceKey(source.id), format: 'markdown' } }, { signal, timeoutMs: INGEST_TIMEOUT_MS });
        manifest.sources[source.id] = { hash: contentHash(source.text), at: new Date().toISOString() };
        summary.added++; consecutive = 0;
        if (++sinceSave >= SAVE_EVERY) await flush();
      } catch (error) {
        if (signal?.aborted) throw error;
        if (summary.added === 0 && summary.failed.length === 0 && NETWORK.test(text(error))) throw modelFailure();
        summary.failed.push({ id: source.id, message: text(error) });
        if (++consecutive >= MAX_CONSECUTIVE_FAILURES)
          throw new RetrievalError('retrieval-index-failed', `连续 ${consecutive} 页没能写入索引，已停止：${text(error)}`);
      }
      done++;
      emit('indexing');
    }
    for (const id of remove) {
      signal?.throwIfAborted();
      try { await port.call(INDEX_TOOLS.delete, { source: sourceKey(id) }, { signal }); } catch (error) { if (signal?.aborted) throw error; }
      delete manifest.sources[id];
      summary.removed++; done++;
      emit('indexing');
    }
  } finally { await flush().catch(() => {}); }
  return summary;
}
