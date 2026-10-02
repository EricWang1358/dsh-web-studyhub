import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MINERU, MineruError, mapMineruFailure } from './mineru-api.js';
import { MineruResultError, mergeChunkResults, readResultZip } from './mineru-merge.js';
import { MAX_CHUNK_BYTES, MAX_PAGES_PER_CHUNK, PdfChunkError, inspectPdf, planChunks, readOutline, splitPdf } from './pdf-chunker.js';
import { LOCAL, LOCAL_MESSAGES, LocalMineruError, parseWindow as parseLocalWindow, windowPlan } from './mineru-local.js';
import { convertHome, jobDir, resultsDir } from './mineru-paths.js';
import { maxBytesFor } from './office/limits.js';
import { id as newId, parseStoredJson } from './util.js';

/* One cloud conversion of one PDF (the work of a `pdf-convert` job). Plan the pieces, then for each piece in turn:
   cut -> ask for an upload address -> upload -> poll -> download -> keep its content list. Then merge the pieces into one
   converted document and hand it to the ordinary document import. Pure of host concerns: the MinerU client, the clock,
   the sleep, the import and the persistence are all injected, so the whole flow runs against a fake server in tests.

   Everything it keeps lives in the DSH home (study/tmp/pdf-convert/<library>/<job>/), never in the study library:
   the source copy, the cut pieces, a manifest with each piece's state, and each finished piece's content list.
   A restart or a retry reads the manifest and does only what is left: a finished piece is never uploaded again. */

/** One place for the job's own timings and budgets (the API's limits are in MINERU). */
export const CONVERT = Object.freeze({
  /** A piece still waiting in MinerU's queue after this long gets an honest "slow, not failed" note. */
  slowPendingMs: 4 * 60_000,
  /** A piece MinerU has not finished after this long stops the job (retryable: the same task is polled again). */
  pieceTimeoutMs: 2 * 60 * 60_000,
  /** Total time one job waits out rate limits before it stops (retryable). */
  rateLimitBudgetMs: 15 * 60_000,
  rateLimitWaitMs: 30_000,
  /** Consecutive transient failures tolerated per request kind. */
  pollFailures: 6, transferFailures: 3,
  /** Unfinished work and finished pieces are forgotten after this long. */
  staleMs: 7 * 24 * 60 * 60_000,
});

export const PHASES = Object.freeze(['split', 'upload', 'parse', 'download', 'merge', 'save']);

/** The sentences this module can show a learner (each has an English form in lib/application-messages-en.js). */
export const JOB_TEXT = Object.freeze({
  rateLimited: 'MinerU 请求太频繁，正在等一会儿再继续（不是失败）。',
  slow: 'MinerU 云端正在排队，比平时慢（可能是今天的高优先额度用完了）。这不是失败，会自动继续。',
  timeout: 'MinerU 解析这一段用了太久，已先停下。稍后点「接着做」会继续查这一段的结果，不会重复上传。',
  pageCountMismatch: '这个 PDF 的页数前后读得不一致，请重新导出后再试。',
});

const MB = 1024 * 1024;
export { convertHome, jobDir };

/* ---------- persistence ---------- */

export async function atomicWrite(file, text) {
  const temporary = `${file}.${newId()}.tmp`;
  try {
    await writeFile(temporary, text, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); return; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(25 * 2 ** attempt, 500)));
      }
    }
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

export const saveManifest = (dir, manifest) => atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest));
export async function readManifest(dir) { return parseStoredJson(await readFile(join(dir, 'manifest.json'), 'utf8')); }

/** Every unfinished conversion left in the DSH home for a library, newest data first. */
export async function listManifests(root) {
  const base = join(convertHome(root), 'jobs'), found = [];
  for (const name of await readdir(base).catch(() => [])) {
    try { const manifest = await readManifest(join(base, name)); if (manifest.id === name && manifest.kind === 'pdf-convert') found.push({ dir: join(base, name), manifest }); }
    catch { /* an unfinished preparation has no manifest */ }
  }
  return found;
}

/** Remove a job's files. `keepResults: true` (cancel, failure) leaves each finished piece's content list, so converting the same file again costs nothing. */
export async function discardJob(root, jobId, { keepResults = false, sourceHash } = {}) {
  await rm(jobDir(root, jobId), { recursive: true, force: true });
  if (!keepResults && sourceHash) await rm(resultsDir(root, sourceHash), { recursive: true, force: true });
}

/** Forget unfinished conversions and cached pieces older than CONVERT.staleMs (called when jobs are recovered). */
export async function sweepStale(root, { now = Date.now() } = {}) {
  const base = convertHome(root);
  for (const folder of ['jobs', 'results'])
    for (const name of await readdir(join(base, folder)).catch(() => [])) {
      try { if (now - (await stat(join(base, folder, name))).mtimeMs > CONVERT.staleMs) await rm(join(base, folder, name), { recursive: true, force: true }); }
      catch { /* another process got there first */ }
    }
}

/* ---------- preparing a job ---------- */

/** SHA-256 and size of a file, read as a stream. */
async function fingerprint(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const part of createReadStream(file)) { hash.update(part); bytes += part.length; }
  return { sha256: hash.digest('hex'), bytes };
}

const stemOf = filename => basename(String(filename || 'document.pdf')).replace(/\.[^.]+$/, '') || 'document';
/** MinerU sees a plain ASCII name; the learner's own file name stays in the job. */
const asciiName = (stem, start, end) => `${stem.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'book'}-p${start}-${end}.pdf`;

/**
 * Take a PDF into a job folder and plan it: pages, bookmarks, the pieces. Nothing is sent anywhere. `source` is the file
 * (an upload the panel finished, or an absolute path). Resolves { dir, manifest, plan }. A PDF that cannot be read (not a
 * PDF, damaged, password-protected) throws PdfChunkError with a plain message and leaves no folder behind.
 */
export async function prepareJob({ root, source, filename, title, courses = [], language, jobId = newId(), limits = {}, route = 'cloud', tier }) {
  const maxPages = limits.maxPages ?? MAX_PAGES_PER_CHUNK;
  const dir = jobDir(root, jobId);
  await mkdir(dir, { recursive: true });
  try {
    await copyFile(source, join(dir, 'source.pdf'));
    const bytes = await readFile(join(dir, 'source.pdf'));
    const info = await inspectPdf(bytes);
    const finger = await fingerprint(join(dir, 'source.pdf'));
    // The cloud route cuts the PDF into pieces MinerU accepts; the local route needs no cutting (the CLI takes page ranges).
    const local = route === 'local';
    const outline = !local && info.pages > maxPages ? (await readOutline(bytes)).slice(0, 4000) : [];
    const plan = local ? windowPlan(info.pages, limits.windowPages ?? LOCAL.windowPages).map(piece => ({ ...piece, cut: 'window' })) : planChunks({ totalPages: info.pages, outline, maxPages });
    const manifest = { version: 1, kind: 'pdf-convert', id: jobId, route, ...(local ? { tier } : {}), filename: basename(filename || source), ...(title ? { title } : {}), courses, language,
      sourceHash: finger.sha256, sourceBytes: finger.bytes, totalPages: info.pages, createdAt: new Date().toISOString(), outline,
      limits: { maxPages, ...(limits.maxBytes ? { maxBytes: limits.maxBytes } : {}) },
      chunks: plan.map(piece => ({ index: piece.index, startPage: piece.startPage, endPage: piece.endPage, pages: piece.endPage - piece.startPage + 1, cut: piece.cut, state: 'planned', extracted: 0 })),
      splitDone: local };
    await saveManifest(dir, manifest);
    return { dir, manifest, plan };
  } catch (error) { await rm(dir, { recursive: true, force: true }).catch(() => {}); throw error; }
}

/** The plan of a PDF without keeping anything: { pages, bytes, plan (the cloud pieces), windows (the local page windows), outlineEntries }. For the "this book will be processed in N pieces" preview. */
export async function planFile({ source, limits = {} }) {
  const bytes = await readFile(source);
  const info = await inspectPdf(bytes);
  const windows = windowPlan(info.pages, limits.windowPages ?? LOCAL.windowPages).map(piece => ({ ...piece, pages: piece.endPage - piece.startPage + 1, cut: 'window' }));
  const maxPages = limits.maxPages ?? MAX_PAGES_PER_CHUNK, maxBytes = limits.maxBytes ?? MAX_CHUNK_BYTES;
  const outline = info.pages > maxPages ? (await readOutline(bytes)).slice(0, 4000) : [];
  const plan = planChunks({ totalPages: info.pages, outline, maxPages });
  // Sizes are only known once the pieces are cut; this is an estimate by page share, and says when it may be cut finer.
  const estimated = plan.map(piece => ({ ...piece, pages: piece.endPage - piece.startPage + 1, estimatedBytes: Math.round(bytes.length * (piece.endPage - piece.startPage + 1) / info.pages) }));
  return { pages: info.pages, bytes: bytes.length, plan: estimated, windows, outlineEntries: outline.length, maySplitFurther: estimated.some(piece => piece.estimatedBytes > maxBytes * 0.8) };
}

/* ---------- running ---------- */

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

const chunkFile = chunk => `chunk-${String(chunk.index + 1).padStart(3, '0')}.pdf`;
const resultFile = chunk => `chunk-${String(chunk.index + 1).padStart(3, '0')}.result.json`;
/** Finished pieces are remembered by the file's hash and the pages they cover; a local window also by its tier, so the two routes never mix. */
const cacheName = (manifest, chunk) => `${manifest.route === 'local' ? `local-${manifest.tier}-` : ''}${chunk.startPage}-${chunk.endPage}.json`;
const publicChunk = chunk => ({ index: chunk.index + 1, startPage: chunk.startPage, endPage: chunk.endPage, pages: chunk.pages, state: chunk.state,
  ...(chunk.error ? { error: chunk.error } : {}) });

/**
 * Convert the job in `dir` (see prepareJob). Resumes from the manifest. Options: client (a MinerU client), signal,
 * onProgress(patch) (phase, done, total, chunk: { index, count }, chunks, note), importMerged({ bytes, filename, title, courses, totalPages })
 * -> the import's result, root (the library, for the piece cache), sleep(ms, signal), now(). Resolves { imported, chunks, mergedBytes }.
 * Rejects with the failure, a MineruError / PdfChunkError / MineruResultError (plain message, `code`), or the abort reason.
 */
export async function convertPdf({ dir, manifest, root, client, local, signal, onProgress = () => {}, importMerged, sleep = defaultSleep, now = Date.now, limits = {} }) {
  const total = manifest.totalPages;
  const maxBytes = limits.maxBytes ?? manifest.limits?.maxBytes ?? MAX_CHUNK_BYTES, maxPages = limits.maxPages ?? manifest.limits?.maxPages ?? MAX_PAGES_PER_CHUNK;
  const save = () => saveManifest(dir, manifest);
  let high = 0, rateWaited = 0, note = '';
  const count = () => manifest.chunks.length;
  const emit = (phase, current, patch = {}) => {
    const finished = manifest.chunks.reduce((sum, chunk) => sum + (chunk.state === 'done' ? chunk.pages : 0), 0);
    high = Math.max(high, finished + (current && current.state !== 'done' ? Math.min(current.extracted || 0, current.pages) : 0));
    onProgress({ phase, done: Math.min(high, total), total, chunk: { index: current ? current.index + 1 : manifest.chunks.filter(chunk => chunk.state === 'done').length, count: count() },
      chunks: manifest.chunks.map(publicChunk), note, ...patch });
  };

  async function guarded(fn, { tries }) {
    let failures = 0;
    for (;;) {
      signal?.throwIfAborted();
      try { return await fn(); }
      catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (!(error instanceof MineruError) || !error.retryable || ['task-not-found', 'conversion-failed'].includes(error.code)) throw error;
        if (error.code === 'rate-limited') {
          const wait = error.retryAfterMs ?? CONVERT.rateLimitWaitMs;
          rateWaited += wait;
          if (rateWaited > CONVERT.rateLimitBudgetMs) throw error;
          note = JOB_TEXT.rateLimited;
          await sleep(wait, signal); continue;
        }
        if (++failures >= tries) throw error;
        await sleep(Math.min(MINERU.pollMs * 2 ** failures, MINERU.pollMaxMs), signal);
      }
    }
  }

  /* ----- split ----- */
  async function split() {
    emit('split', undefined);
    const bytes = await readFile(join(dir, 'source.pdf'));
    const written = [];
    const chunks = await splitPdf({ bytes, maxPages, maxBytes, outline: manifest.outline?.length ? manifest.outline : undefined, signal,
      writeChunk: async piece => {
        const file = piece.original ? 'source.pdf' : `chunk-${String(piece.index + 1).padStart(3, '0')}.pdf`;
        if (!piece.original) await writeFile(join(dir, file), piece.data);
        written.push({ index: piece.index, startPage: piece.startPage, endPage: piece.endPage, pages: piece.pages, bytes: piece.bytes, cut: piece.cut, file, state: 'cut', extracted: 0 });
        emit('split', undefined, { cutPieces: written.length });
      } });
    if (chunks.at(-1)?.endPage !== total) throw new PdfChunkError('damaged', JOB_TEXT.pageCountMismatch);
    manifest.chunks = written;
    manifest.splitDone = true;
    await restoreFromCache();
    await save();
  }

  /** Finished pieces left by an earlier attempt at this same file (cancelled or failed) are reused, never converted twice. */
  async function restoreFromCache() {
    for (const chunk of manifest.chunks) {
      if (chunk.state === 'done') continue;
      const cached = join(resultsDir(root, manifest.sourceHash), cacheName(manifest, chunk));
      try { await copyFile(cached, join(dir, resultFile(chunk))); chunk.state = 'done'; chunk.resultFile = resultFile(chunk); chunk.extracted = chunk.pages; }
      catch { /* not converted before */ }
    }
  }

  /** A finished piece whose saved result is gone (temporary files cleaned) is converted again, not trusted. */
  async function verifyFinished() {
    for (const chunk of manifest.chunks) {
      if (chunk.state !== 'done') continue;
      if (await stat(join(dir, chunk.resultFile || resultFile(chunk))).then(() => true, () => false)) continue;
      Object.assign(chunk, { state: 'ready', extracted: 0, batchId: undefined, resultFile: undefined });
    }
    await restoreFromCache();
  }

  /* ----- one piece ----- */
  async function upload(chunk) {
    emit('upload', chunk);
    chunk.dataId = `sh-${manifest.id.slice(0, 8)}-${chunk.index + 1}-${newId().slice(0, 6)}`;
    const bytes = await readFile(join(dir, chunk.file));
    const { batchId, urls } = await guarded(() => client.requestUploads([{ name: asciiName(stemOf(manifest.filename), chunk.startPage, chunk.endPage), dataId: chunk.dataId }], { signal }), { tries: CONVERT.transferFailures });
    chunk.batchId = batchId; chunk.state = 'requested';
    await save();
    await guarded(() => client.upload(urls[0], bytes, { signal }), { tries: CONVERT.transferFailures });
    chunk.state = 'uploaded';
    await save();
  }

  async function parse(chunk) {
    const started = now();
    let pendingSince = null;
    for (;;) {
      signal?.throwIfAborted();
      emit('parse', chunk);
      const items = await guarded(() => client.status(chunk.batchId, { signal }), { tries: CONVERT.pollFailures });
      const item = items.find(entry => entry.dataId === chunk.dataId) ?? items[0];
      if (!item) throw new MineruError('bad-response', 'MinerU 返回的内容无法识别，请稍后再试。', { retryable: true });
      if (item.state === 'failed') throw mapMineruFailure({ code: -60015, msg: item.errMsg });
      if (item.state === 'done') {
        if (!item.zipUrl) throw new MineruError('bad-response', 'MinerU 返回的内容无法识别，请稍后再试。', { retryable: true });
        chunk.extracted = chunk.pages; note = '';
        return item.zipUrl;
      }
      if (item.state === 'running') {
        pendingSince = null; note = '';
        chunk.extracted = Math.min(chunk.pages, Math.max(chunk.extracted || 0, item.extractedPages ?? 0));
        chunk.state = 'parsing';
      } else {
        pendingSince ??= now();
        if (now() - pendingSince > CONVERT.slowPendingMs) note = JOB_TEXT.slow;
      }
      if (now() - started > CONVERT.pieceTimeoutMs) throw new MineruError('timeout', JOB_TEXT.timeout, { retryable: true });
      await sleep(MINERU.pollMs, signal);
    }
  }

  async function download(chunk, zipUrl) {
    emit('download', chunk);
    const zip = await guarded(() => client.download(zipUrl, { signal }), { tries: CONVERT.transferFailures });
    const result = readResultZip(zip);
    const body = JSON.stringify({ format: result.format, content: result.content });
    await writeFile(join(dir, resultFile(chunk)), body, 'utf8');
    await mkdir(resultsDir(root, manifest.sourceHash), { recursive: true });
    await writeFile(join(resultsDir(root, manifest.sourceHash), cacheName(manifest, chunk)), body, 'utf8');
    chunk.state = 'done'; chunk.resultFile = resultFile(chunk); chunk.extracted = chunk.pages; delete chunk.error; delete chunk.batchId;
    if (chunk.file !== 'source.pdf') await rm(join(dir, chunk.file), { force: true });
    await save();
  }

  async function convertChunk(chunk) {
    let reuploaded = false;
    for (;;) {
      try {
        if (!chunk.batchId || ['planned', 'cut', 'ready', 'requested'].includes(chunk.state)) {
          if (!(await stat(join(dir, chunk.file)).then(() => true, () => false))) await cutAgain(chunk);
          await upload(chunk);
        }
        const zipUrl = await parse(chunk);
        await download(chunk, zipUrl);
        return;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        // A task MinerU no longer knows (an old batch after a restart) is asked for again, once.
        if (error instanceof MineruError && error.code === 'task-not-found' && !reuploaded) { reuploaded = true; chunk.batchId = undefined; chunk.state = 'ready'; chunk.extracted = 0; continue; }
        // A piece MinerU failed (or whose result was unusable) starts over from a new upload on the next try.
        if ((error instanceof MineruError && error.code === 'conversion-failed') || error instanceof MineruResultError) { chunk.batchId = undefined; chunk.state = 'ready'; }
        chunk.error = String(error?.message || error).slice(0, 300);
        await save().catch(() => {});
        throw error;
      }
    }
  }

  async function cutAgain(chunk) {
    const { PDFDocument } = await import('pdf-lib');
    const source = await PDFDocument.load(await readFile(join(dir, 'source.pdf')), { updateMetadata: false });
    const target = await PDFDocument.create();
    for (const page of await target.copyPages(source, Array.from({ length: chunk.pages }, (_, offset) => chunk.startPage - 1 + offset))) target.addPage(page);
    chunk.file = chunkFile(chunk);
    await writeFile(join(dir, chunk.file), await target.save({ updateFieldAppearances: false }));
  }

  /* ----- one window of the local route ----- */
  async function localChunk(chunk) {
    if (!local?.cli) throw new LocalMineruError('not-installed', LOCAL_MESSAGES.notInstalled);
    emit('local', chunk);
    try {
      const result = await (local.parseWindow || parseLocalWindow)({ cli: local.cli, pdf: join(dir, 'source.pdf'), tier: manifest.tier, startPage: chunk.startPage, endPage: chunk.endPage,
        totalPages: total, outFile: join(dir, `window-${String(chunk.index + 1).padStart(3, '0')}.md`), signal, timeoutMs: local.timeoutMs });
      const body = JSON.stringify({ format: 'v1', content: result.content });
      await writeFile(join(dir, resultFile(chunk)), body, 'utf8');
      await mkdir(resultsDir(root, manifest.sourceHash), { recursive: true });
      await writeFile(join(resultsDir(root, manifest.sourceHash), cacheName(manifest, chunk)), body, 'utf8');
      Object.assign(chunk, { state: 'done', resultFile: resultFile(chunk), extracted: chunk.pages });
      delete chunk.error;
      await save();
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      chunk.error = String(error?.message || error).slice(0, 300);
      await save().catch(() => {});
      throw error;
    }
  }

  /* ----- the whole flow ----- */
  if (!manifest.splitDone) await split();
  else await verifyFinished();
  for (const chunk of manifest.chunks) {
    if (chunk.state === 'done') continue;
    await (manifest.route === 'local' ? localChunk(chunk) : convertChunk(chunk));
    emit(manifest.route === 'local' ? 'local' : 'parse', chunk);
  }
  note = '';
  emit('merge', undefined);
  const parts = [];
  for (const chunk of manifest.chunks) {
    const saved = parseStoredJson(await readFile(join(dir, chunk.resultFile), 'utf8'));
    parts.push({ index: chunk.index, startPage: chunk.startPage, endPage: chunk.endPage, format: saved.format, content: saved.content });
  }
  const merged = mergeChunkResults({ totalPages: total, chunks: parts });
  const bytes = Buffer.from(JSON.stringify(merged.content), 'utf8');
  if (bytes.length > maxBytesFor('json')) throw new MineruResultError('too-big', `解析结果合起来有 ${Math.ceil(bytes.length / MB)} MB，超过了 ${Math.round(maxBytesFor('json') / MB)} MB 的导入上限。请把这本书分成两份 PDF 再导入。`);
  signal?.throwIfAborted();
  emit('save', undefined);
  const imported = await importMerged({ bytes, filename: manifest.filename, title: manifest.title, courses: manifest.courses, totalPages: total });
  return { imported, chunks: manifest.chunks.length, mergedBytes: bytes.length, notes: manifest.route === 'local' ? [LOCAL_MESSAGES.headerFooter] : [] };
}
