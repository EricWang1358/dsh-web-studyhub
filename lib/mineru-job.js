import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MineruResultError, mergeChunkResults } from './mineru-merge.js';
import { PdfChunkError, inspectPdf } from './pdf-chunker.js';
import { createOutputLog } from './marker-output.js';
import { LOCAL, LOCAL_MESSAGES, LocalMineruError, halveWindow, localEtaRange, localPace, nextWindow, parseWindow as parseLocalWindow, waitSeconds, watchWindow, windowPlan } from './mineru-local.js';
import { convertHome, jobDir, resultsDir } from './mineru-paths.js';
import { maxBytesFor } from './office/limits.js';
import { id as newId, parseStoredJson } from './util.js';
import { assertKnownVersion } from './stored-version.js';

/* One conversion of one PDF on this computer (the work of a `pdf-convert` job), by the local MinerU or Marker: the book is converted in windows of
   pages (`--pages a-b` is native, so the PDF is never cut), each window's content list is kept, then the windows are merged into one converted document
   and handed to the ordinary document import. Pure of host concerns: the local runner, the clock, the import and the persistence are all injected, so
   the whole flow runs against a fake command line in tests.

   Everything it keeps lives in the DSH home (study/tmp/pdf-convert/<library>/<job>/), never in the study library: the source copy, a manifest with each
   window's state, and each finished window's content list. A restart or a retry reads the manifest and does only what is left: a finished window is never
   converted again. (The cloud route, a MinerU token and uploads, was removed in 3.6.) */

/** One place for the job's own timings. */
export const CONVERT = Object.freeze({
  /** Unfinished work and finished windows are forgotten after this long. */
  staleMs: 7 * 24 * 60 * 60_000,
});

/** The sentences this module can show a learner (each has an English form in lib/application-messages-en.js). */
export const JOB_TEXT = Object.freeze({
  inputChanged: '这个任务保存的 PDF 和当初计划转换的那份不一样了，不能接着做；请重新导入这份 PDF（已解析好的段落会被复用）。',
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

/**
 * Take a PDF into a job folder and plan it: pages and the first windows. Nothing is sent anywhere. `source` is the file
 * (an upload the panel finished, or an absolute path). Resolves { dir, manifest, plan }. A PDF that cannot be read (not a
 * PDF, damaged, password-protected) throws PdfChunkError with a plain message and leaves no folder behind.
 */
export async function prepareJob({ root, source, filename, title, courses = [], language, jobId = newId(), limits = {}, route = 'local', tier, converter = 'mineru' }) {
  const dir = jobDir(root, jobId);
  await mkdir(dir, { recursive: true });
  try {
    await copyFile(source, join(dir, 'source.pdf'));
    const bytes = await readFile(join(dir, 'source.pdf'));
    const info = await inspectPdf(bytes);
    const finger = await fingerprint(join(dir, 'source.pdf'));
    const adaptive = !usesFixedWindows(limits);
    /* How the book is cut, as data (the history record and the card read it from here): `adaptive` (a first small window, the next ones sized from the measured
       speed: the manifest holds only the windows decided so far and grows as they finish) unless the seam asks for `fixed` windows of a set size. */
    const windowPages = limits.windowPages ?? LOCAL.windowPages;
    const planned = adaptive ? adaptivePlan(limits) : { kind: 'fixed', windowPages };
    const plan = adaptive ? [{ index: 0, ...nextWindow({ total: info.pages, tier, limits: plannerLimits(planned) }), cut: 'window' }]
      : windowPlan(info.pages, windowPages).map(piece => ({ ...piece, cut: 'window' }));
    const manifest = { version: 1, kind: 'pdf-convert', id: jobId, route, converter, tier, filename: basename(filename || source), ...(title ? { title } : {}), courses, language,
      sourceHash: finger.sha256, sourceBytes: finger.bytes, totalPages: info.pages, createdAt: new Date().toISOString(), outline: [], plan: planned,
      chunks: plan.map(piece => ({ index: piece.index, startPage: piece.startPage, endPage: piece.endPage, pages: piece.endPage - piece.startPage + 1, cut: piece.cut, state: 'planned', extracted: 0 })),
      splitDone: true };
    await saveManifest(dir, manifest);
    return { dir, manifest, plan };
  } catch (error) { await rm(dir, { recursive: true, force: true }).catch(() => {}); throw error; }
}

/** The plan of a PDF without keeping anything: { pages, bytes, windows (the first page windows), adaptive? }. For the "this book will be processed in N pieces" preview. */
export async function planFile({ source, limits = {} }) {
  const bytes = await readFile(source);
  const info = await inspectPdf(bytes);
  // Fixed windows when the seam asks for them; otherwise the adaptive plan, of which only the first window can be known before anything runs.
  const adaptive = usesFixedWindows(limits) ? null : adaptivePlan(limits);
  const windows = (adaptive ? [{ index: 0, ...nextWindow({ total: info.pages, limits: plannerLimits(adaptive) }) }] : windowPlan(info.pages, limits.windowPages ?? LOCAL.windowPages))
    .map(piece => ({ ...piece, pages: piece.endPage - piece.startPage + 1, cut: 'window' }));
  return { pages: info.pages, bytes: bytes.length, windows, ...(adaptive ? { adaptive } : {}) };
}

/* ---------- running ---------- */

/** Finished windows are remembered by the file's hash and the pages they cover, and by the tier (MinerU) or the converter (Marker), so they never mix. */
const cachePrefix = manifest => manifest.converter === 'marker' ? 'marker-' : `local-${manifest.tier}-`;
const cacheName = (manifest, chunk) => `${cachePrefix(manifest)}${chunk.startPage}-${chunk.endPage}.json`;
const publicChunk = chunk => ({ index: chunk.index + 1, startPage: chunk.startPage, endPage: chunk.endPage, pages: chunk.pages, state: chunk.state,
  ...(chunk.seconds > 0 ? { seconds: chunk.seconds } : {}), ...(chunk.error ? { error: chunk.error } : {}) });
const roundTo = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * Convert the job in `dir` (see prepareJob). Resumes from the manifest. Options: local (the runner: { cli, parseWindow?, timeoutMs?, now?, liveness? }), signal,
 * onProgress(patch) (phase, done, total, chunk: { index, count }, chunks, note), importMerged({ bytes, filename, title, courses, totalPages }),
 * onLog(entry) a line of the job's log about a window ({ level, code: 'window-start' | 'window-end' | 'window-failed' | 'tool-output', args, text? }:
 * what the converter printed comes as 'tool-output', plain and bounded by lib/marker-output.js), onLive(bar) the progress bar the converter is drawing now (or null)
 * -> the import's result, root (the library, for the window cache), limits (the liveness seams). Resolves { imported, chunks, mergedBytes }.
 * Rejects with the failure, a LocalMineruError / PdfChunkError / MineruResultError (plain message, `code`), or the abort reason.
 */
export async function convertPdf({ dir, manifest, root, local, signal, onProgress = () => {}, onLog = () => {}, onLive = () => {}, importMerged, limits = {} }) {
  const total = manifest.totalPages;
  const save = () => saveManifest(dir, manifest);
  const adaptive = manifest.plan?.kind === 'adaptive';
  const clock = () => (local?.now ?? Date.now)();
  const resultFile = windowResultFile;
  let high = 0, note = '', serviceNote, liveness = null;
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
      chunks: manifest.chunks.map(publicChunk), note, ...(serviceNote ? { service: serviceNote } : {}), local: localView(current), liveness, ...patch });
  };

  /** A resume continues the file that was planned: a saved copy that is not it is refused before anything is sent. */
  async function assertSameInput() {
    if (!manifest.splitDone) return;
    const copy = await fingerprint(join(dir, 'source.pdf')).catch(() => null);
    if (copy && copy.sha256 !== manifest.sourceHash) throw new PdfChunkError('input-changed', JOB_TEXT.inputChanged);
  }

  /** Finished windows left by an earlier attempt at this same file (cancelled or failed) are reused, never converted twice (a fixed plan). */
  async function restoreFromCache() {
    for (const chunk of manifest.chunks) {
      if (chunk.state === 'done') continue;
      const cached = join(resultsDir(root, manifest.sourceHash), cacheName(manifest, chunk));
      try { await copyFile(cached, join(dir, resultFile(chunk))); chunk.state = 'done'; chunk.resultFile = resultFile(chunk); chunk.extracted = chunk.pages; }
      catch { /* not converted before */ }
    }
  }

  /** A finished window whose saved result is gone (temporary files cleaned) is converted again, not trusted (a fixed plan). */
  async function verifyFinished() {
    for (const chunk of manifest.chunks) {
      if (chunk.state !== 'done') continue;
      if (await stat(join(dir, chunk.resultFile || resultFile(chunk))).then(() => true, () => false)) continue;
      Object.assign(chunk, { state: 'planned', extracted: 0, resultFile: undefined });
    }
    await restoreFromCache();
  }

  /* ----- one window of the local route ----- */
  let ranOne = false;
  async function localChunk(chunk) {
    if (!local?.cli) throw new LocalMineruError('not-installed', LOCAL_MESSAGES.notInstalled);
    delete chunk.error; chunk.state = 'running';
    const began = clock();
    running.set(chunk, began);
    const asking = limits.livenessMs ?? LOCAL.livenessMs;
    /* While the window runs, the service is asked (read-only, one question at a time, only now) what it is doing with it; between windows nothing is asked. Whether the
       real CLI tolerates these reads while it parses is unverified: `limits.livenessMs: 0` turns them off. */
    const watch = watchWindow({ cli: local.cli, tier: manifest.tier, startPage: chunk.startPage, endPage: chunk.endPage, signal, intervalMs: local.liveness === false ? 0 : asking, firstMs: limits.livenessFirstMs ?? LOCAL.livenessFirstMs,
      silentMs: limits.silentMs, idleProbes: limits.idleProbes, now: () => Date.now(), onState: state => { liveness = state; emit('local', chunk); } });
    if (!watch.enabled) liveness = null;
    emit('local', chunk);
    // The job's log: the window, what the converter printed (bounded, plain: never the book's path or the program's), how it ended.
    const where = { index: chunk.index + 1, start: chunk.startPage, end: chunk.endPage, pages: chunk.pages };
    const said = createOutputLog({ secrets: [dir, root, local.cli?.file].filter(Boolean), emit: entry => onLog(entry.omitted ? { level: 'info', code: 'tool-omitted', args: { count: entry.omitted } }
      : { level: 'info', code: 'tool-output', text: entry.text }), live: bar => onLive(bar) });
    onLog({ level: 'step', code: 'window-start', args: where });
    try {
      const pace = localPace(finishedWindows());
      let result;
      try {
        result = await (local.parseWindow || parseLocalWindow)({ cli: local.cli, pdf: join(dir, 'source.pdf'), tier: manifest.tier, startPage: chunk.startPage, endPage: chunk.endPage,
          totalPages: total, outFile: join(dir, `local-${chunk.startPage}-${chunk.endPage}.md`), signal, timeoutMs: local.timeoutMs, waitSec: waitSeconds({ pages: chunk.pages, pace, first: !ranOne }),
          onOutput: () => watch.touch(), onText: text => said.write(text) });
        // The window's process has ended: nothing more is asked about it while its result is written (stop is idempotent; the outer finally stops it too).
      } finally { watch.stop(); said.end(); onLive(null); }
      const took = Math.max(0, clock() - began) / 1000;
      // The seconds it took are kept with the result, so a window restored later still tells the pace of this computer.
      const body = JSON.stringify({ format: 'v1', content: result.content, seconds: roundTo(took, 1) });
      await writeFile(join(dir, resultFile(chunk)), body, 'utf8');
      await mkdir(resultsDir(root, manifest.sourceHash), { recursive: true });
      await writeFile(join(resultsDir(root, manifest.sourceHash), cacheName(manifest, chunk)), body, 'utf8');
      Object.assign(chunk, { state: 'done', resultFile: resultFile(chunk), extracted: chunk.pages, seconds: roundTo(took, 1), doneAt: new Date().toISOString() });
      delete chunk.error; ranOne = true;
      // The evidence the service is up: a window it just finished.
      serviceNote = { state: 'running', basis: 'window', at: new Date().toISOString() };
      await save();
      // What is done so far and, from the pace measured on this computer, about how long the rest takes.
      const doneSoFar = doneChunks().reduce((sum, piece) => sum + piece.pages, 0), left = total - doneSoFar;
      const eta = left > 0 ? localEtaRange({ remainingPages: left, windows: finishedWindows(), tier: manifest.tier }).etaSeconds : null;
      onLog({ level: 'step', code: 'window-end', args: { ...where, seconds: roundTo(took, 1), done: doneSoFar, total, ...(Number.isFinite(eta) ? { etaSeconds: Math.round(eta) } : {}) } });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      onLog({ level: 'warn', code: 'window-failed', args: { ...where, seconds: roundTo(Math.max(0, clock() - began) / 1000, 1), ...(Number.isInteger(error?.detail?.exitCode) ? { exitCode: error.detail.exitCode } : {}) },
        text: String(error?.message || error).slice(0, 300) });
      chunk.state = 'planned';
      if (error instanceof LocalMineruError && error.code === 'server-stopped') { serviceNote = { state: 'stopped', basis: 'window', at: new Date().toISOString() }; emit('local', chunk); }
      chunk.error = String(error?.message || error).slice(0, 300);
      await save().catch(() => {});
      // The card's windows say which one failed and why (the 转换详情 lists them), not only the manifest.
      running.delete(chunk); emit('local', undefined);
      throw error;
    } finally { watch.stop(); liveness = null; running.delete(chunk); }
  }

  /* ----- the adaptive local plan: windows decided one at a time ----- */
  const reindex = () => { manifest.chunks.sort((a, b) => a.startPage - b.startPage); manifest.chunks.forEach((chunk, index) => { chunk.index = index; }); };
  const newWindow = piece => ({ index: 0, startPage: piece.startPage, endPage: piece.endPage, pages: piece.endPage - piece.startPage + 1, cut: 'window', state: 'planned', extracted: 0 });
  const overlaps = (a, b) => a.startPage <= b.endPage && b.startPage <= a.endPage;

  /** The windows of an earlier attempt at this same file and tier, whatever window plan cut them: read from the cache by the pages they cover. A range that no longer
   *  reads (damaged, or longer than the book) is ignored, and so is one that overlaps a longer finished range. */
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

  /** What an earlier attempt left: finished windows whose saved result is gone are forgotten (a window's boundaries are not fixed, so it is planned afresh), and the cache is read. */
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
        // A window that did not work is tried again as two halves, down to the minimum; a stopped service, a missing command or the learner's cancel is not a reason to cut it up.
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

  /* ----- the whole flow ----- */
  await assertSameInput();
  if (adaptive) await reconcileWindows();
  else await verifyFinished();
  // Pages an earlier attempt (or an earlier import of the same file) already converted are reused, and the log says so.
  const reused = doneChunks().reduce((sum, chunk) => sum + chunk.pages, 0);
  if (reused > 0) onLog({ level: 'info', code: 'reused', args: { pages: reused, total, windows: doneChunks().length } });
  if (adaptive) await adaptiveWindows();
  else for (const chunk of manifest.chunks) {
    if (chunk.state === 'done') continue;
    await localChunk(chunk);
    emit('local', chunk);
  }
  note = '';
  emit('merge', undefined);
  onLog({ level: 'step', code: 'merge', args: { windows: manifest.chunks.length, pages: total } });
  const parts = [];
  for (const chunk of manifest.chunks) {
    const saved = parseStoredJson(await readFile(join(dir, chunk.resultFile), 'utf8'));
    parts.push({ index: chunk.index, startPage: chunk.startPage, endPage: chunk.endPage, format: saved.format, content: saved.content });
  }
  const merged = mergeChunkResults({ totalPages: total, chunks: parts });
  const marker = manifest.converter === 'marker';
  const format = marker ? 'markdown' : 'json';
  const markerPages = marker ? Array.from({ length: total }, () => []) : null;
  if (marker) for (const item of merged.content) if (item.type === 'text') markerPages[item.page_idx].push(item.text);
  const body = marker ? markerPages.map((texts, index) => `{${index}}${'-'.repeat(48)}\n\n${texts.join('\n\n')}`).join('\n\n') : JSON.stringify(merged.content);
  const bytes = Buffer.from(body, 'utf8');
  if (bytes.length > maxBytesFor(format)) throw new MineruResultError('too-big', `解析结果合起来有 ${Math.ceil(bytes.length / MB)} MB，超过了 ${Math.round(maxBytesFor(format) / MB)} MB 的导入上限。请把这本书分成两份 PDF 再导入。`);
  signal?.throwIfAborted();
  emit('save', undefined);
  const chars = merged.content.reduce((sum, item) => sum + (typeof item.text === 'string' ? item.text.length : 0), 0);
  onLog({ level: 'step', code: 'save', args: { pages: total, chars, bytes: bytes.length } });
  const imported = await importMerged({ bytes, filename: manifest.filename, title: manifest.title, courses: manifest.courses, totalPages: total, format });
  return { imported, chunks: manifest.chunks.length, mergedBytes: bytes.length, chars, halved: manifest.halved || 0, notes: marker ? [] : [LOCAL_MESSAGES.headerFooter] };
}
