import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { applyEdits, editableBlocks, emptiedPages } from './converted-edit.js';
import { MINERU, MineruError, mapMineruFailure } from './mineru-api.js';
import { MineruResultError, mergeChunkResults, readResultZip } from './mineru-merge.js';
import { MAX_CHUNK_BYTES, MAX_PAGES_PER_CHUNK, PdfChunkError, inspectPdf, planChunks, readOutline, splitPdf } from './pdf-chunker.js';
import { createOutputLog } from './marker-output.js';
import { LOCAL, LOCAL_MESSAGES, LocalMineruError, halveWindow, localEtaRange, localPace, nextWindow, parseWindow as parseLocalWindow, probeService as probeLocalService, startServer as startLocalServer, waitSeconds, watchWindow, windowPlan } from './mineru-local.js';
import { convertHome, jobDir, resultsDir } from './mineru-paths.js';
import { maxBytesFor } from './office/limits.js';
import { id as newId, parseStoredJson } from './util.js';
import { assertKnownVersion } from './stored-version.js';

/* One conversion of one PDF (the work of a `pdf-convert` job):
   - Default route (`local`, MinerU or Marker): converted in windows of pages (`--pages a-b` is native, so the PDF is never cut),
     each window's content list is kept, then merged into one converted document and handed to the ordinary document import.
   - Optional route (`cloud`, MinerU official or compatible third-party endpoint): cut into pieces the API accepts, then for each
     piece: ask for upload address -> upload -> poll -> download -> keep its content list -> merge -> import.
   Pure of host concerns: the local runner, the cloud client, the clock, sleep, import and persistence are all injected.

   Everything it keeps lives in the DSH home (study/tmp/pdf-convert/<library>/<job>/), never in the study library: the source copy,
   a manifest with each piece/window's state, and each finished content list. A restart or retry reads the manifest and does only
   what is left: a finished piece or window is never converted again. */

/** One place for the job's own timings and budgets (the cloud API's limits are in MINERU). */
export const CONVERT = Object.freeze({
  /** A piece still waiting in the cloud queue after this long gets an honest "slow, not failed" note. */
  slowPendingMs: 4 * 60_000,
  /** A piece the cloud has not finished after this long stops the job (retryable: the same task is polled again). */
  pieceTimeoutMs: 2 * 60 * 60_000,
  /** Total time one job waits out rate limits before it stops (retryable). */
  rateLimitBudgetMs: 15 * 60_000,
  rateLimitWaitMs: 30_000,
  /** Consecutive transient failures tolerated per request kind. */
  pollFailures: 6, transferFailures: 3,
  /** Unfinished work and finished pieces/windows are forgotten after this long. */
  staleMs: 7 * 24 * 60 * 60_000,
});

/** The sentences this module can show a learner (each has an English form in lib/application-messages-en.js). */
export const JOB_TEXT = Object.freeze({
  rateLimited: 'MinerU 请求太频繁，正在等一会儿再继续（不是失败）。',
  slow: 'MinerU 云端正在排队，比平时慢（可能是今天的高优先额度用完了）。这不是失败，会自动继续。',
  timeout: 'MinerU 解析这一段用了太久，已先停下。稍后点「接着做」会继续查这一段的结果，不会重复上传。',
  pageCountMismatch: '这个 PDF 的页数前后读得不一致，请重新导出后再试。',
  inputChanged: '这个任务保存的 PDF 和当初计划转换的那份不一样了，不能接着做；请重新导入这份 PDF（已解析好的段落会被复用）。',
  createUnknown: '向 MinerU 创建解析任务时没有收到回复，不知道它有没有建成，所以没有自动再建一次。点「接着做」会重新创建这一段（MinerU 那边可能留下一个没用的空批次，不占用额度）。',
  cannotVerify: '这一段在 MinerU 那边已有一个任务，但现在查不到它的状态，所以没有再创建新的。请稍后点「接着做」。',
  orphanBatch: '上一次向 MinerU 创建任务的结果不明，重新创建后，MinerU 那边可能留下一个没用的空批次；它不会被使用。',
});

const MB = 1024 * 1024;
export { convertHome, jobDir };

/* ---------- the adaptive plan of the local route ---------- */

/** The numbers an adaptive local plan follows, from the LOCAL defaults and what the seam (`limits`) overrides: what the manifest keeps as `plan`. */
export const adaptivePlan = (limits = {}) => ({ kind: 'adaptive', firstPages: limits.firstPages ?? LOCAL.firstWindowPages, rampPages: [...(limits.rampPages ?? LOCAL.rampPages)],
  targetSeconds: limits.targetSeconds ?? LOCAL.targetWindowSeconds, minPages: limits.minPages ?? LOCAL.minWindowPages, maxPages: limits.maxPages ?? LOCAL.maxWindowPages });
/** The same numbers in the shape `nextWindow` takes; a window that had to be halved lowers the largest size for the rest of the job (`sizeCap`). */
const plannerLimits = (plan, sizeCap) => ({ firstPages: plan.firstPages, rampPages: plan.rampPages, targetSeconds: plan.targetSeconds, minPages: plan.minPages,
  maxPages: sizeCap ? Math.max(plan.minPages, Math.min(plan.maxPages, sizeCap)) : plan.maxPages });
/** Fixed windows (the old behaviour) when a window size is given through the seam; adaptive otherwise. */
const usesFixedWindows = limits => limits.windowPages > 0;
/** The result of a local window, named by the pages it covers (a window is a range of the book, whatever plan cut it). */
const windowResultFile = chunk => `local-${chunk.startPage}-${chunk.endPage}.result.json`;
const HALVABLE = ['failed', 'timeout', 'empty-output', 'marker-count', 'marker-range', 'total-mismatch'];

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
/** The merged text a conversion waiting for the learner keeps (`manifest.held`, 导入前先让我改): the content list as converted; the learner's edits stay beside it in the manifest. */
export const readHeldContent = async dir => parseStoredJson(await readFile(join(dir, 'held.json'), 'utf8')).content;
export async function readManifest(dir) { return assertKnownVersion('pdfConvertManifest', parseStoredJson(await readFile(join(dir, 'manifest.json'), 'utf8'))); }

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
export async function discardJob(root, jobId, { keepResults = false, sourceHash, converter = 'mineru' } = {}) {
  await rm(jobDir(root, jobId), { recursive: true, force: true });
  if (!keepResults && sourceHash) {
    const folder = resultsDir(root, sourceHash);
    for (const name of await readdir(folder).catch(() => []))
      if (name.startsWith('marker-') === (converter === 'marker')) await rm(join(folder, name), { force: true });
    if (!(await readdir(folder).catch(() => [])).length) await rm(folder, { recursive: true, force: true });
  }
}

/** Whether a job folder may hold what a learner edited. A manifest that cannot be read counts as yes: only a folder known to hold nothing of theirs is ever deleted. */
const holdsEdits = dir => readManifest(dir).then(manifest => !!manifest.held, error => error?.code !== 'ENOENT');

/** The clean-up of a job that lets go of its retry: everything as discardJob, except a conversion that waits for the learner. False when it was left alone. */
export async function discardUnlessHeld(root, jobId, options) {
  if (await holdsEdits(jobDir(root, jobId))) return false;
  await discardJob(root, jobId, options);
  return true;
}

/** Let go of a conversion that waits for the learner, with what they edited; the windows stay until the sweep, so converting the file again costs nothing. False when `jobId` is no such conversion. */
export async function discardHeld(root, jobId) {
  const manifest = await readManifest(jobDir(root, jobId)).catch(() => null);
  if (!manifest?.held) return false;
  await discardJob(root, jobId, { keepResults: true });
  return true;
}

/** Forget unfinished conversions and cached pieces older than CONVERT.staleMs (called when jobs are recovered). A conversion waiting for the learner is never forgotten: it holds their edits. */
export async function sweepStale(root, { now = Date.now() } = {}) {
  const base = convertHome(root);
  for (const folder of ['jobs', 'results'])
    for (const name of await readdir(join(base, folder)).catch(() => [])) {
      try {
        if (now - (await stat(join(base, folder, name))).mtimeMs <= CONVERT.staleMs) continue;
        if (folder === 'jobs' && await holdsEdits(join(base, folder, name))) continue;
        await rm(join(base, folder, name), { recursive: true, force: true });
      }
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
/** Cloud endpoints see a plain ASCII name; the learner's own file name stays in the job. */
const asciiName = (stem, start, end) => `${stem.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'book'}-p${start}-${end}.pdf`;

/** Build a local plan + initial chunk list for a book of `totalPages`. */
function buildLocalPlan({ totalPages, tier, limits = {} }) {
  const adaptive = !usesFixedWindows(limits);
  const windowPages = limits.windowPages ?? LOCAL.windowPages;
  const planned = adaptive ? adaptivePlan(limits) : { kind: 'fixed', windowPages };
  const plan = adaptive
    ? [{ index: 0, ...nextWindow({ total: totalPages, tier, limits: plannerLimits(planned) }), cut: 'window' }]
    : windowPlan(totalPages, windowPages).map(piece => ({ ...piece, cut: 'window' }));
  const chunks = plan.map(piece => ({ index: piece.index, startPage: piece.startPage, endPage: piece.endPage, pages: piece.endPage - piece.startPage + 1, cut: piece.cut, state: 'planned', extracted: 0 }));
  return { planned, plan, chunks };
}

/**
 * Re-plan a failed cloud job folder to run locally ("改用本机"). Verifies `source.pdf` is still present and matches `sourceHash`,
 * drops leftover cloud piece files, and updates the manifest in place for local conversion.
 */
/** Delete cloud-split chunk PDFs / chunk results after a job has switched to local and started retrying. */
export async function cleanupCloudChunkFiles(dir) {
  for (const name of await readdir(dir).catch(() => [])) {
    if (/^chunk-\d+\.(?:pdf|result\.json)$/i.test(name)) await rm(join(dir, name), { force: true }).catch(() => {});
  }
}

export async function switchManifestToLocal({ dir, manifest, tier, limits = {} }) {
  const sourceFile = join(dir, 'source.pdf');
  const copy = await fingerprint(sourceFile).catch(() => null);
  if (!copy) throw Object.assign(new Error('这个任务的临时文件已被清理，没法改用本机；请重新选择这份 PDF 用本机解析。'), { code: 'source-gone' });
  if (manifest.sourceHash && copy.sha256 !== manifest.sourceHash) throw new PdfChunkError('input-changed', JOB_TEXT.inputChanged);
  const { planned, chunks } = buildLocalPlan({ totalPages: manifest.totalPages, tier, limits });
  manifest.route = 'local';
  manifest.tier = tier;
  manifest.plan = planned;
  manifest.chunks = chunks;
  manifest.splitDone = true;
  delete manifest.baseUrl;
  delete manifest.halved;
  delete manifest.sizeCap;
  return manifest;
}

/**
 * Take a PDF into a job folder and plan it: pages and the first windows (local, default) or cloud pieces. Nothing is sent anywhere.
 * `source` is the file (an upload the panel finished, or an absolute path). `sourcePath`: the learner's own file when they gave a path
 * (kept in the manifest and the history, to attach it as the original). Resolves { dir, manifest, plan }.
 * A PDF that cannot be read (not a PDF, damaged, password-protected) throws PdfChunkError with a plain message and leaves no folder behind.
 */
export async function prepareJob({ root, source, filename, title, courses = [], language, jobId = newId(), limits = {}, route = 'local', tier, converter = 'mineru', sourcePath, baseUrl }) {
  const maxPages = limits.maxPages ?? MAX_PAGES_PER_CHUNK;
  const dir = jobDir(root, jobId);
  await mkdir(dir, { recursive: true });
  try {
    await copyFile(source, join(dir, 'source.pdf'));
    const bytes = await readFile(join(dir, 'source.pdf'));
    const info = await inspectPdf(bytes);
    const finger = await fingerprint(join(dir, 'source.pdf'));
    const local = route === 'local';
    const outline = !local && info.pages > maxPages ? (await readOutline(bytes)).slice(0, 4000) : [];
    let planned, plan, chunks;
    if (local) {
      ({ planned, plan, chunks } = buildLocalPlan({ totalPages: info.pages, tier, limits }));
    } else {
      planned = { kind: 'chunks', maxPages, maxBytes: limits.maxBytes ?? MAX_CHUNK_BYTES };
      plan = planChunks({ totalPages: info.pages, outline, maxPages });
      chunks = plan.map(piece => ({ index: piece.index, startPage: piece.startPage, endPage: piece.endPage, pages: piece.endPage - piece.startPage + 1, cut: piece.cut, state: 'planned', extracted: 0 }));
    }
    const manifest = { version: 1, kind: 'pdf-convert', id: jobId, route, converter, ...(local ? { tier } : {}), ...(!local && baseUrl ? { baseUrl } : {}),
      filename: basename(filename || source), ...(title ? { title } : {}), courses, language,
      sourceHash: finger.sha256, sourceBytes: finger.bytes, ...(sourcePath ? { sourcePath } : {}), totalPages: info.pages, createdAt: new Date().toISOString(), outline, plan: planned,
      ...(!local ? { limits: { maxPages, ...(limits.maxBytes ? { maxBytes: limits.maxBytes } : {}) } } : {}),
      chunks, splitDone: local };
    await saveManifest(dir, manifest);
    return { dir, manifest, plan };
  } catch (error) { await rm(dir, { recursive: true, force: true }).catch(() => {}); throw error; }
}

/** The plan of a PDF without keeping anything: { pages, bytes, plan (cloud pieces), windows (local windows), adaptive?, outlineEntries, maySplitFurther }. */
export async function planFile({ source, limits = {} }) {
  const bytes = await readFile(source);
  const info = await inspectPdf(bytes);
  // Fixed windows when the seam asks for them; otherwise the adaptive plan, of which only the first window can be known before anything runs.
  const adaptive = usesFixedWindows(limits) ? null : adaptivePlan(limits);
  const windows = (adaptive ? [{ index: 0, ...nextWindow({ total: info.pages, limits: plannerLimits(adaptive) }) }] : windowPlan(info.pages, limits.windowPages ?? LOCAL.windowPages))
    .map(piece => ({ ...piece, pages: piece.endPage - piece.startPage + 1, cut: 'window' }));
  const maxPages = limits.maxPages ?? MAX_PAGES_PER_CHUNK, maxBytes = limits.maxBytes ?? MAX_CHUNK_BYTES;
  const outline = info.pages > maxPages ? (await readOutline(bytes)).slice(0, 4000) : [];
  const plan = planChunks({ totalPages: info.pages, outline, maxPages });
  const estimated = plan.map(piece => ({ ...piece, pages: piece.endPage - piece.startPage + 1, estimatedBytes: Math.round(bytes.length * (piece.endPage - piece.startPage + 1) / info.pages) }));
  return { pages: info.pages, bytes: bytes.length, plan: estimated, windows, ...(adaptive ? { adaptive } : {}), outlineEntries: outline.length, maySplitFurther: estimated.some(piece => piece.estimatedBytes > maxBytes * 0.8) };
}

/* ---------- running ---------- */

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

const chunkFile = chunk => `chunk-${String(chunk.index + 1).padStart(3, '0')}.pdf`;
const pieceResultFile = chunk => `chunk-${String(chunk.index + 1).padStart(3, '0')}.result.json`;

/** The bytes the document import gets for a merged content list: Marker's paginated Markdown, or MinerU's JSON. One place, for a conversion and for the check before an edited one is imported. */
export function mergedBody(manifest, content) {
  const marker = manifest.converter === 'marker', format = marker ? 'markdown' : 'json', total = manifest.totalPages;
  const pages = marker ? Array.from({ length: total }, () => []) : null;
  if (marker) for (const item of content) if (item.type === 'text') pages[item.page_idx].push(item.text);
  const body = marker ? pages.map((texts, index) => `{${index}}${'-'.repeat(48)}\n\n${texts.join('\n\n')}`).join('\n\n') : JSON.stringify(content);
  const bytes = Buffer.from(body, 'utf8');
  if (bytes.length > maxBytesFor(format)) throw new MineruResultError('too-big', `解析结果合起来有 ${Math.ceil(bytes.length / MB)} MB，超过了 ${Math.round(maxBytesFor(format) / MB)} MB 的导入上限。请把这本书分成两份 PDF 再导入。`);
  return { bytes, format };
}

/** Finished pieces/windows are remembered by the file's hash and the pages they cover, and by route/tier/converter, so they never mix. */
const cachePrefix = manifest => manifest.converter === 'marker' ? 'marker-' : manifest.route === 'local' ? `local-${manifest.tier}-` : '';
const cacheName = (manifest, chunk) => `${cachePrefix(manifest)}${chunk.startPage}-${chunk.endPage}.json`;
const publicChunk = chunk => ({ index: chunk.index + 1, startPage: chunk.startPage, endPage: chunk.endPage, pages: chunk.pages, state: chunk.state,
  ...(chunk.seconds > 0 ? { seconds: chunk.seconds } : {}), ...(chunk.error ? { error: chunk.error } : {}) });
const roundTo = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * Convert the job in `dir` (see prepareJob). Resumes from the manifest. Options: client (a cloud MinerU client),
 * local (the local runner: { cli, parseWindow?, timeoutMs?, now?, liveness? }), signal, onProgress(patch), importMerged,
 * onLog(entry), onLive(bar), root, sleep, now, limits, verifyCreates.
 * Resolves { imported, chunks, mergedBytes, ... }; or { held: true } when `manifest.holdForEdit` stops before import.
 */
export async function convertPdf({ dir, manifest, root, client, local, signal, onProgress = () => {}, onLog = () => {}, onLive = () => {}, importMerged, sleep, now = Date.now, limits = {}, verifyCreates = false }) {
  const total = manifest.totalPages;
  const maxBytes = limits.maxBytes ?? manifest.limits?.maxBytes ?? MAX_CHUNK_BYTES, maxPages = limits.maxPages ?? manifest.limits?.maxPages ?? MAX_PAGES_PER_CHUNK;
  const save = () => saveManifest(dir, manifest);
  const isLocal = manifest.route === 'local';
  const adaptive = isLocal && manifest.plan?.kind === 'adaptive';
  const clock = () => (local?.now ?? Date.now)();
  const waitMs = (ms, sig = signal) => (sleep ? sleep(ms, sig) : defaultSleep(ms, sig));
  const resultFile = chunk => (isLocal ? windowResultFile(chunk) : pieceResultFile(chunk));
  let high = 0, rateWaited = 0, note = '', serviceNote, liveness = null, unknownCreates = 0;
  const running = new Map(); // the window being converted -> when it started (this attempt's clock)
  const count = () => manifest.chunks.length;
  const doneChunks = () => manifest.chunks.filter(chunk => chunk.state === 'done');
  /** The finished windows as the planner reads them, in the order they finished: a restored one carries no measurement. */
  const finishedWindows = () => doneChunks().sort((a, b) => (Date.parse(a.doneAt) || 0) - (Date.parse(b.doneAt) || 0)).map(chunk => ({ pages: chunk.pages, ms: (chunk.seconds || 0) * 1000 }));
  const limitsNow = () => plannerLimits(manifest.plan, manifest.sizeCap);
  /** What the local card is told besides the pieces: the window in hand, the measured pace, what is left as a range, the size of the next window, how often one had to be halved. */
  const localView = current => {
    const measured = finishedWindows(), pace = localPace(measured), left = total - doneChunks().reduce((sum, chunk) => sum + chunk.pages, 0);
    const view = { adaptive };
    if (manifest.halved) view.halved = manifest.halved;
    if (current && running.has(current)) {
      const per = pace?.secondsPerPage ?? LOCAL.secondsPerPage[manifest.tier];
      view.window = { index: current.index + 1, startPage: current.startPage, endPage: current.endPage, pages: current.pages, startedAt: new Date(running.get(current)).toISOString(), ...(per ? { expectedSeconds: Math.round(current.pages * per) } : {}) };
    }
    if (pace) {
      view.pace = { secondsPerPage: pace.secondsPerPage, windows: pace.windows };
      if (left > 0) { const range = localEtaRange({ remainingPages: left, windows: measured, tier: manifest.tier }); view.eta = { basis: range.basis, seconds: range.etaSeconds, lowSeconds: range.lowSeconds, highSeconds: range.highSeconds, stable: range.stable }; }
    }
    if (adaptive) {
      const later = manifest.chunks.find(chunk => chunk.state !== 'done' && chunk !== current && (!current || chunk.startPage > current.startPage));
      const upcoming = later ? { pages: later.pages } : nextWindow({ total, covered: [...doneChunks(), ...(current ? [current] : [])].map(chunk => [chunk.startPage, chunk.endPage]), from: (current?.endPage ?? 0) + 1, windows: measured, tier: manifest.tier, limits: limitsNow() });
      if (upcoming && left > (current && current.state !== 'done' ? current.pages : 0)) view.next = upcoming.pages;
    }
    return view;
  };
  const emit = (phase, current, patch = {}) => {
    const finished = manifest.chunks.reduce((sum, chunk) => sum + (chunk.state === 'done' ? chunk.pages : 0), 0);
    high = Math.max(high, finished + (current && current.state !== 'done' ? Math.min(current.extracted || 0, current.pages) : 0));
    onProgress({ phase, done: Math.min(high, total), total, chunk: { index: current ? current.index + 1 : manifest.chunks.filter(chunk => chunk.state === 'done').length, count: adaptive ? 0 : count() },
      chunks: manifest.chunks.map(publicChunk), note, ...(serviceNote ? { service: serviceNote } : {}), ...(isLocal ? { local: localView(current), liveness } : {}), ...patch });
  };

  async function guarded(fn, { tries, ambiguous = false }) {
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
          await waitMs(wait, signal); continue;
        }
        // An answer that never came leaves a create unknown: it is not sent again here (the learner's resume decides).
        if (ambiguous && error.code === 'network') throw new MineruError('create-unknown', JOB_TEXT.createUnknown, { retryable: true });
        if (++failures >= tries) throw error;
        await waitMs(Math.min(MINERU.pollMs * 2 ** failures, MINERU.pollMaxMs), signal);
      }
    }
  }

  /** A resume continues the file that was planned: a saved copy that is not it is refused before anything is sent. */
  async function assertSameInput() {
    if (!manifest.splitDone) return;
    const copy = await fingerprint(join(dir, 'source.pdf')).catch(() => null);
    if (copy && copy.sha256 !== manifest.sourceHash) throw new PdfChunkError('input-changed', JOB_TEXT.inputChanged);
  }

  /* ----- cloud split ----- */
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

  /** Finished windows/pieces left by an earlier attempt at this same file (cancelled or failed) are reused, never converted twice (a fixed plan). */
  async function restoreFromCache() {
    for (const chunk of manifest.chunks) {
      if (chunk.state === 'done') continue;
      const cached = join(resultsDir(root, manifest.sourceHash), cacheName(manifest, chunk));
      try { await copyFile(cached, join(dir, resultFile(chunk))); chunk.state = 'done'; chunk.resultFile = resultFile(chunk); chunk.extracted = chunk.pages; }
      catch { /* not converted before */ }
    }
  }

  /** A finished window/piece whose saved result is gone (temporary files cleaned) is converted again, not trusted (a fixed plan). */
  async function verifyFinished() {
    for (const chunk of manifest.chunks) {
      if (chunk.state !== 'done') continue;
      if (await stat(join(dir, chunk.resultFile || resultFile(chunk))).then(() => true, () => false)) continue;
      Object.assign(chunk, isLocal ? { state: 'planned', extracted: 0, resultFile: undefined } : { state: 'ready', extracted: 0, batchId: undefined, resultFile: undefined });
    }
    await restoreFromCache();
  }

  /* ----- one piece of the cloud route ----- */
  async function landed(chunk) {
    try {
      const items = await guarded(() => client.status(chunk.batchId, { signal, purpose: 'verify' }), { tries: CONVERT.pollFailures });
      const item = items.find(entry => entry.dataId === chunk.dataId) ?? items[0];
      return !!item && item.state !== 'waiting';
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof MineruError && error.code === 'task-not-found') return false;
      throw new MineruError('create-unverified', JOB_TEXT.cannotVerify, { retryable: true });
    }
  }

  async function upload(chunk) {
    emit('upload', chunk);
    if (verifyCreates && chunk.state === 'requested' && chunk.batchId && await landed(chunk)) { chunk.state = 'uploaded'; await save(); return; }
    if (verifyCreates) {
      if (chunk.state === 'creating') unknownCreates++;
      Object.assign(chunk, { state: 'creating', batchId: undefined });
    }
    chunk.dataId = `sh-${manifest.id.slice(0, 8)}-${chunk.index + 1}-${newId().slice(0, 6)}`;
    const bytes = await readFile(join(dir, chunk.file));
    if (verifyCreates) await save();
    const { batchId, urls } = await guarded(() => client.requestUploads([{ name: asciiName(stemOf(manifest.filename), chunk.startPage, chunk.endPage), dataId: chunk.dataId }], { signal }),
      { tries: CONVERT.transferFailures, ambiguous: verifyCreates });
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
      await waitMs(MINERU.pollMs, signal);
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

  async function cutAgain(chunk) {
    const { PDFDocument } = await import('pdf-lib');
    const source = await PDFDocument.load(await readFile(join(dir, 'source.pdf')), { updateMetadata: false });
    const target = await PDFDocument.create();
    for (const page of await target.copyPages(source, Array.from({ length: chunk.pages }, (_, offset) => chunk.startPage - 1 + offset))) target.addPage(page);
    chunk.file = chunkFile(chunk);
    await writeFile(join(dir, chunk.file), await target.save({ updateFieldAppearances: false }));
  }

  async function convertChunk(chunk) {
    let reuploaded = false;
    for (;;) {
      try {
        if (!chunk.batchId || ['planned', 'cut', 'ready', 'requested', 'creating'].includes(chunk.state)) {
          if (!chunk.file || !(await stat(join(dir, chunk.file)).then(() => true, () => false))) await cutAgain(chunk);
          await upload(chunk);
        }
        const zipUrl = await parse(chunk);
        await download(chunk, zipUrl);
        return;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (error instanceof MineruError && error.code === 'task-not-found' && !reuploaded) { reuploaded = true; chunk.batchId = undefined; chunk.state = 'ready'; chunk.extracted = 0; continue; }
        if ((error instanceof MineruError && error.code === 'conversion-failed') || error instanceof MineruResultError) { chunk.batchId = undefined; chunk.state = 'ready'; }
        chunk.error = String(error?.message || error).slice(0, 300);
        await save().catch(() => {});
        throw error;
      }
    }
  }

  /* ----- one window of the local route ----- */
  let ranOne = false, autoRestarted = false;
  async function localChunk(chunk) {
    if (!local?.cli) throw new LocalMineruError('not-installed', LOCAL_MESSAGES.notInstalled);
    delete chunk.error; chunk.state = 'running';
    let began = clock();
    running.set(chunk, began);
    const asking = limits.livenessMs ?? LOCAL.livenessMs;
    const watch = watchWindow({ cli: local.cli, tier: manifest.tier, startPage: chunk.startPage, endPage: chunk.endPage, signal, intervalMs: local.liveness === false ? 0 : asking, firstMs: limits.livenessFirstMs ?? LOCAL.livenessFirstMs,
      silentMs: limits.silentMs, idleProbes: limits.idleProbes, now: () => Date.now(), onState: state => { liveness = state; emit('local', chunk); } });
    if (!watch.enabled) liveness = null;
    emit('local', chunk);
    const where = { index: chunk.index + 1, start: chunk.startPage, end: chunk.endPage, pages: chunk.pages };
    const said = createOutputLog({ secrets: [dir, root, local.cli?.file].filter(Boolean), emit: entry => onLog(entry.omitted ? { level: 'info', code: 'tool-omitted', args: { count: entry.omitted } }
      : { level: 'info', code: 'tool-output', text: entry.text }), live: bar => onLive(bar) });
    onLog({ level: 'step', code: 'window-start', args: where });
    try {
      const pace = localPace(finishedWindows());
      const maxBusyRetries = limits.engineBusyRetries ?? LOCAL.engineBusyRetries;
      const maxStartingRetries = limits.engineStartingRetries ?? Math.max(maxBusyRetries, limits.engineBusyRetries !== undefined ? maxBusyRetries * 3 : LOCAL.engineStartingRetries);
      const busyWaitMs = limits.engineBusyWaitMs ?? LOCAL.engineBusyWaitMs;
      const probe = local.probeService || probeLocalService;
      const restartServer = local.startServer || startLocalServer;
      let result, busyAttempt = 0, lastBusyProbe = null;
      try {
        for (;;) {
          try {
            result = await (local.parseWindow || parseLocalWindow)({ cli: local.cli, pdf: join(dir, 'source.pdf'), tier: manifest.tier, startPage: chunk.startPage, endPage: chunk.endPage,
              totalPages: total, outFile: join(dir, `local-${chunk.startPage}-${chunk.endPage}.md`), signal, timeoutMs: local.timeoutMs, waitSec: waitSeconds({ pages: chunk.pages, pace, first: !ranOne }),
              onOutput: () => watch.touch(), onText: text => said.write(text) });
            if (note === LOCAL_MESSAGES.waitingEngine || note === LOCAL_MESSAGES.restartingService) note = '';
            break;
          } catch (error) {
            if (signal?.aborted || !(error instanceof LocalMineruError) || error.code !== 'engine-busy') {
              if (note === LOCAL_MESSAGES.waitingEngine || note === LOCAL_MESSAGES.restartingService) note = '';
              throw error;
            }
            const status = local.liveness === false ? null : await probe({ cli: local.cli, tier: manifest.tier, startPage: chunk.startPage, endPage: chunk.endPage, signal, statusOnly: true }).catch(() => null);
            signal?.throwIfAborted();
            if (status) lastBusyProbe = status;
            const idleUnhealthy = !!status && (status.server === 'stopped' || (status.server === 'running' && status.parseRunning === 0 && status.queued === 0 && status.healthy === false && !status.starting));
            const warmingUp = status?.server === 'running' && status.starting === true;
            if (idleUnhealthy && !autoRestarted) {
              autoRestarted = true;
              serviceNote = { state: 'starting', basis: 'restart', at: new Date().toISOString() };
              note = LOCAL_MESSAGES.restartingService;
              emit('local', chunk);
              onLog({ level: 'step', code: 'service-restart', args: { ...where, reason: 'unhealthy' } });
              let restarted;
              try {
                restarted = await restartServer({ cli: local.cli, home: local.home, restart: true, signal });
              } catch (restartError) {
                if (signal?.aborted) throw signal.reason ?? restartError;
                serviceNote = { state: 'stopped', basis: 'restart', at: new Date().toISOString() };
                note = '';
                onLog({ level: 'warn', code: 'service-restart-failed', args: { ...where }, text: String(restartError?.message || LOCAL_MESSAGES.serverStopped).slice(0, 300) });
                throw Object.assign(error, { serviceUnhealthy: true, restartFailed: true });
              }
              if (restarted?.state === 'ready') {
                serviceNote = { state: 'running', basis: 'restart', at: new Date().toISOString() };
                note = '';
                onLog({ level: 'step', code: 'service-restarted', args: { ...where, tier: restarted.tier || null } });
                began = clock();
                running.set(chunk, began);
                emit('local', chunk);
                continue;
              }
              serviceNote = { state: 'stopped', basis: 'restart', at: new Date().toISOString() };
              note = '';
              onLog({ level: 'warn', code: 'service-restart-failed', args: { ...where }, text: LOCAL_MESSAGES.serverStopped });
              throw Object.assign(error, { serviceUnhealthy: true, restartFailed: true });
            }
            const retryBudget = warmingUp ? maxStartingRetries : maxBusyRetries;
            if (busyAttempt >= retryBudget) {
              if (note === LOCAL_MESSAGES.waitingEngine || note === LOCAL_MESSAGES.restartingService) note = '';
              const notReady = !!lastBusyProbe && (lastBusyProbe.server === 'stopped' || (lastBusyProbe.server === 'running' && lastBusyProbe.parseRunning === 0 && lastBusyProbe.queued === 0 && (lastBusyProbe.healthy === false || lastBusyProbe.starting === true)));
              if (notReady) {
                serviceNote = { state: 'stopped', basis: 'probe', at: new Date().toISOString() };
                throw Object.assign(error, { serviceUnhealthy: true });
              }
              throw error;
            }
            busyAttempt += 1;
            if (warmingUp) serviceNote = { state: 'starting', basis: 'probe', at: new Date().toISOString() };
            note = LOCAL_MESSAGES.waitingEngine;
            emit('local', chunk);
            onLog({ level: 'info', code: 'engine-busy-wait', args: { ...where, attempt: busyAttempt, maxAttempts: retryBudget, ...(warmingUp ? { starting: true } : {}) } });
            await waitMs(busyWaitMs);
            signal?.throwIfAborted();
            began = clock();
            running.set(chunk, began);
            emit('local', chunk);
          }
        }
      } finally { watch.stop(); said.end(); onLive(null); }
      const took = Math.max(0, clock() - began) / 1000;
      const body = JSON.stringify({ format: 'v1', content: result.content, seconds: roundTo(took, 1) });
      await writeFile(join(dir, resultFile(chunk)), body, 'utf8');
      await mkdir(resultsDir(root, manifest.sourceHash), { recursive: true });
      await writeFile(join(resultsDir(root, manifest.sourceHash), cacheName(manifest, chunk)), body, 'utf8');
      Object.assign(chunk, { state: 'done', resultFile: resultFile(chunk), extracted: chunk.pages, seconds: roundTo(took, 1), doneAt: new Date().toISOString() });
      delete chunk.error; ranOne = true;
      serviceNote = { state: 'running', basis: 'window', at: new Date().toISOString() };
      await save();
      const doneSoFar = doneChunks().reduce((sum, piece) => sum + piece.pages, 0), left = total - doneSoFar;
      const eta = left > 0 ? localEtaRange({ remainingPages: left, windows: finishedWindows(), tier: manifest.tier }).etaSeconds : null;
      onLog({ level: 'step', code: 'window-end', args: { ...where, seconds: roundTo(took, 1), done: doneSoFar, total, ...(Number.isFinite(eta) ? { etaSeconds: Math.round(eta) } : {}) } });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      onLog({ level: 'warn', code: 'window-failed', args: { ...where, seconds: roundTo(Math.max(0, clock() - began) / 1000, 1), ...(Number.isInteger(error?.detail?.exitCode) ? { exitCode: error.detail.exitCode } : {}) },
        text: String(error?.message || error).slice(0, 300) });
      chunk.state = 'planned';
      if (error instanceof LocalMineruError && (error.code === 'server-stopped' || (error.code === 'engine-busy' && error.serviceUnhealthy))) {
        serviceNote = { state: 'stopped', basis: 'window', at: new Date().toISOString() };
        emit('local', chunk);
      }
      chunk.error = String(error?.message || error).slice(0, 300);
      await save().catch(() => {});
      running.delete(chunk); emit('local', undefined);
      throw error;
    } finally { watch.stop(); liveness = null; running.delete(chunk); }
  }

  /* ----- the adaptive local plan: windows decided one at a time ----- */
  const reindex = () => { manifest.chunks.sort((a, b) => a.startPage - b.startPage); manifest.chunks.forEach((chunk, index) => { chunk.index = index; }); };
  const newWindow = piece => ({ index: 0, startPage: piece.startPage, endPage: piece.endPage, pages: piece.endPage - piece.startPage + 1, cut: 'window', state: 'planned', extracted: 0 });
  const overlaps = (a, b) => a.startPage <= b.endPage && b.startPage <= a.endPage;

  async function restoreRanges() {
    const folder = resultsDir(root, manifest.sourceHash), prefix = cachePrefix(manifest);
    const found = [];
    for (const name of await readdir(folder).catch(() => [])) {
      const match = name.startsWith(prefix) ? /^(\d+)-(\d+)\.json$/.exec(name.slice(prefix.length)) : null;
      if (!match) continue;
      const startPage = Number(match[1]), endPage = Number(match[2]);
      if (startPage < 1 || endPage < startPage || endPage > total) continue;
      found.push({ startPage, endPage, name });
    }
    found.sort((a, b) => (b.endPage - b.startPage) - (a.endPage - a.startPage) || a.startPage - b.startPage);
    for (const piece of found) {
      if (manifest.chunks.some(chunk => chunk.state === 'done' && overlaps(chunk, piece))) continue;
      try {
        const saved = parseStoredJson(await readFile(join(folder, piece.name), 'utf8'));
        if (!Array.isArray(saved?.content) || saved.format !== 'v1') continue;
        const window = newWindow(piece);
        await copyFile(join(folder, piece.name), join(dir, windowResultFile(window)));
        Object.assign(window, { state: 'done', resultFile: windowResultFile(window), extracted: window.pages, restored: true, ...(saved.seconds > 0 ? { seconds: saved.seconds } : {}) });
        manifest.chunks = manifest.chunks.filter(chunk => !(chunk.state !== 'done' && overlaps(chunk, window)));
        manifest.chunks.push(window);
      } catch { /* a range that no longer reads is converted again */ }
    }
  }

  async function reconcileWindows() {
    const kept = [];
    for (const chunk of manifest.chunks) {
      if (chunk.state !== 'done' || await stat(join(dir, chunk.resultFile || windowResultFile(chunk))).then(() => true, () => false)) kept.push(chunk);
    }
    manifest.chunks = kept;
    await restoreRanges();
    reindex();
    await save();
  }

  async function adaptiveWindows() {
    for (;;) {
      signal?.throwIfAborted();
      let chunk = manifest.chunks.find(piece => piece.state !== 'done');
      if (!chunk) {
        const next = nextWindow({ total, covered: doneChunks().map(piece => [piece.startPage, piece.endPage]), windows: finishedWindows(), tier: manifest.tier, limits: limitsNow() });
        if (!next) return;
        chunk = newWindow(next);
        manifest.chunks.push(chunk); reindex();
        await save();
      }
      try { await localChunk(chunk); }
      catch (error) {
        const parts = error instanceof LocalMineruError && error.retryable && HALVABLE.includes(error.code) && Math.floor(chunk.pages / 2) >= manifest.plan.minPages ? halveWindow(chunk) : null;
        if (!parts) throw error;
        manifest.chunks = manifest.chunks.filter(piece => piece !== chunk);
        manifest.chunks.push(...parts.map(newWindow)); reindex();
        manifest.halved = (manifest.halved || 0) + 1;
        manifest.sizeCap = Math.floor(chunk.pages / 2);
        await save();
        onLog({ level: 'warn', code: 'window-retry', args: { start: chunk.startPage, end: chunk.endPage, pages: chunk.pages, halves: parts.map(part => [part.startPage, part.endPage]), attempt: manifest.halved },
          text: String(error?.message || error).slice(0, 300) });
        emit('local', undefined);
        continue;
      }
      emit('local', chunk);
    }
  }

  /** Convert what is left and merge it. */
  async function convertAndMerge() {
    await assertSameInput();
    if (!manifest.splitDone) await split();
    else if (adaptive) await reconcileWindows();
    else await verifyFinished();
    const reused = doneChunks().reduce((sum, chunk) => sum + chunk.pages, 0);
    if (reused > 0) onLog({ level: 'info', code: 'reused', args: { pages: reused, total, windows: doneChunks().length } });
    if (adaptive) await adaptiveWindows();
    else for (const chunk of manifest.chunks) {
      if (chunk.state === 'done') continue;
      await (isLocal ? localChunk(chunk) : convertChunk(chunk));
      emit(isLocal ? 'local' : 'parse', chunk);
    }
    note = '';
    emit('merge', undefined);
    onLog({ level: 'step', code: 'merge', args: { windows: manifest.chunks.length, pages: total } });
    const parts = [];
    for (const chunk of manifest.chunks) {
      const saved = parseStoredJson(await readFile(join(dir, chunk.resultFile), 'utf8'));
      parts.push({ index: chunk.index, startPage: chunk.startPage, endPage: chunk.endPage, format: saved.format, content: saved.content });
    }
    return mergeChunkResults({ totalPages: total, chunks: parts });
  }

  /** Stop before the import: the merged text is kept, and the PDF copy is not needed any more (nothing is converted again from here). */
  async function holdForLearner(content) {
    await atomicWrite(join(dir, 'held.json'), JSON.stringify({ content }));
    manifest.held = { at: new Date().toISOString(), blocks: editableBlocks(content).length, edits: {}, approved: false };
    await save();
    await rm(join(dir, 'source.pdf'), { force: true }).catch(() => {});
    return { held: true, chunks: manifest.chunks.length };
  }

  /* ----- the whole flow ----- */
  let content, emptied = [];
  if (manifest.held) {
    if (!manifest.held.approved) return { held: true, chunks: manifest.chunks.length };
    const converted = await readHeldContent(dir);
    content = applyEdits(converted, manifest.held.edits);
    emptied = emptiedPages(converted, manifest.held.edits);
  } else {
    const merged = await convertAndMerge();
    if (manifest.holdForEdit && merged.format === 'v1') return holdForLearner(merged.content);
    content = merged.content;
  }
  const { bytes, format } = mergedBody(manifest, content);
  signal?.throwIfAborted();
  emit('save', undefined);
  const chars = content.reduce((sum, item) => sum + (typeof item.text === 'string' ? item.text.length : 0), 0);
  onLog({ level: 'step', code: 'save', args: { pages: total, chars, bytes: bytes.length } });
  const imported = await importMerged({ bytes, filename: manifest.filename, title: manifest.title, courses: manifest.courses, totalPages: total, format });
  const caveat = isLocal && manifest.converter !== 'marker' && !imported?.repeated?.count;
  return { imported, emptied, chunks: manifest.chunks.length, mergedBytes: bytes.length, chars, halved: manifest.halved || 0,
    notes: [...(unknownCreates ? [JOB_TEXT.orphanBatch] : []), ...(caveat ? [LOCAL_MESSAGES.headerFooter] : [])] };
}
