import { detectMarker, locateMarker, markerUsable } from '../../marker-local.js';
import { readMarkerSettings, saveMarkerSettings } from '../../marker-settings.js';
import { createMarkerInstaller, effectiveMarkerSettings } from '../../marker-install.js';
import { createMineruInstaller, effectiveMineru, externalMineru } from '../../mineru-install.js';
import { MINERU_INSTALL_MESSAGES } from '../../mineru-install-text.js';
import { markerInstallerOf } from './install/marker-install-runs.js';
import { mineruInstallerFor } from './install/mineru-install-runs.js';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { ownWork } from '../../runtime/work-ownership.js';
import { discardJob, jobDir, listManifests, mergedBody, planFile, prepareJob, readHeldContent, readManifest, saveManifest, sweepStale } from '../../mineru-job.js';
import { parseConvertedDocument } from '../../converted-document.js';
import { applyEdits, cleanEdits, editableBlocks, savedBy } from '../../converted-edit.js';
import { LOCAL, LOCAL_MESSAGES, LocalMineruError, SERVICE_START_TEXT, detectLocal, explainStartFailure, readLocalEnvironment, startServer, stopServer } from '../../mineru-local.js';
import { HISTORY, clearRecords, closeRecord, interruptRecords, listRecords, openRecord, removeRecord } from '../../mineru-history.js';
import { importCourses } from '../../source-courses.js';
import { currentCourse } from '../../focus.js';
import { CONVERT_TEXT, NO_MATERIALS, TYPE, adaptiveOf, finishedPages, publicChunks, recordWindows, stageText, windowsOfPlan } from './convert-support.js';
import { announceEnd, holdCard, newConvertCard, withdrawFailureLetter } from './convert-card.js';
import { jobArchive } from '../../job-archive.js';
import { retryJob } from './pdf/retry-pdf-convert.js';
import { startPdfConvert } from './pdf/submit-pdf-convert.js';
import { openHistory, runConversion } from './pdf/convert-run.js';

/* PDF conversion on this computer, with MinerU or Marker: the same background-job model as the audio imports (one job in the shared job list,
   cancel / dismiss / retry, a letter in the inbox when it ends), with its own operations, `mineru.*` and `marker.*`. The PDF is converted in
   windows of pages by the local program, merged, and handed to the ordinary document import as a converted document (lib/converted-document.js),
   so everything after the import is what a MinerU file dragged in by hand would have been. Nothing is uploaded and no token is needed.
   MinerU is installed by StudyHub itself in one click (lib/mineru-install.js, `mineru.install.*`); a conversion that finds its service stopped
   starts it first. The cloud route (a MinerU token) was removed in 3.5.5: old cloud rows still show in the history, and a cloud job cannot resume. */

export { NO_MATERIALS, stageText };

const gates = new WeakMap();
const gateFor = jobs => { let gate = gates.get(jobs); if (!gate) { gate = { active: 0, tail: Promise.resolve() }; gates.set(jobs, gate); } return gate; };
const memos = new WeakMap(), sharedMemo = { lastError: null, cached: null };
const memoOf = key => { if (!key || typeof key !== 'object') return sharedMemo; let memo = memos.get(key); if (!memo) { memo = { lastError: null, cached: null }; memos.set(key, memo); } return memo; };

/** The background side: starting, resuming and recovering conversion jobs. Shares the audio context's job maps. */
export function createConvertWorker(worker, work, jobServices) {
  const { jobs, settled, retryable, generationControllers } = work;
  const { activeJob, pruneJobs } = jobServices;
  const quiet = work => Promise.resolve(work).catch(() => null);
  /** What a retry's hold lets go of. Never a conversion waiting for the learner: their edits leave only when they let them go (job.delete, lib/contexts/jobs/operations.js). */
  const cleanupOf = (root, id, manifest) => async () => {
    if ((await readManifest(jobDir(root, id)).catch(() => null))?.held) return;
    await discardJob(root, id, { sourceHash: manifest.sourceHash, converter: manifest.converter });
  };
  /** A converted text waiting for the learner is theirs: converting the same PDF again says so and starts nothing, whichever tool it is asked of. */
  async function assertNothingHeld(root, manifest) {
    const waiting = (await listManifests(root)).find(item => item.manifest.held && item.manifest.id !== manifest.id && item.manifest.sourceHash === manifest.sourceHash);
    if (!waiting) return;
    const archived = await jobArchive(root).has(waiting.manifest.id).catch(() => false);
    throw Object.assign(new Error(CONVERT_TEXT.editPending({ edited: Object.keys(waiting.manifest.held.edits || {}).length, archived })), { code: 'edit-pending', jobId: waiting.manifest.id });
  }
  /** The ids of this library's conversions that are alive right now (the rest of the "running" records are leftovers of a closed app). */
  const liveIds = root => [...jobs.values()].filter(job => job.root === root && job.type === TYPE && activeJob(job)).map(job => job.id);

  async function startConvertJob(service, { dir, manifest, serviceState }) {
    const root = service.store.root;
    if ([...jobs.values()].some(job => job.root === root && job.type === TYPE && activeJob(job) && job.fingerprint === manifest.sourceHash))
      throw new Error('这本书已经在转换，请等它完成');
    await assertNothingHeld(root, manifest);
    pruneJobs();
    // runtime.pilot.pdfConvert: the conversion is a Job of the unified runtime (./pdf), else the original background run below.
    if (service.runtimePilot?.pdfConvert === true && service.runtimeJobs) return startPdfConvert(service, { manifest, serviceState });
    const gate = gateFor(jobs), waits = gate.active > 0;
    const job = newConvertCard({ manifest, root, language: service.language, serviceState, queued: waits });
    ownWork(job, service.workOwner);
    jobs.set(job.id, job);
    retryable.set(job.id, { convert: true, filename: job.filename, cleanup: cleanupOf(root, job.id, manifest) });
    const controller = new AbortController();
    generationControllers.set(job.id, controller);
    const signal = controller.signal;

    const history = openHistory({ root, job, manifest, service });
    const run = async () => {
      gate.active++;
      try { await runConversion({ service, root, dir, manifest, job, signal, history, cancelled: () => signal.aborted && !!job.cancelRequestedAt }); }
      finally {
        gate.active--;
        generationControllers.delete(job.id);
        // A run may have started the service, or found it stopped: the next status read asks again.
        memoOf(jobs).cached = null;
        if (job.status === 'complete' || job.retryable === false) retryable.delete(job.id);
        // A conversion the learner stopped themselves needs no letter and no notice.
        if (job.status !== 'cancelled') await announceEnd(service, job);
      }
    };
    const done = gate.tail.catch(() => {}).then(run);
    gate.tail = done;
    settled.set(job.id, done);
    void done.finally(() => { settled.delete(job.id); });
    await history.opened;
    return { jobId: job.id, status: job.status, queuedBehind: waits ? 1 : 0, pages: manifest.totalPages, chunks: manifest.chunks.map(chunk => ({ index: chunk.index + 1, startPage: chunk.startPage, endPage: chunk.endPage, pages: chunk.pages })),
      converter: job.converter, next: CONVERT_TEXT.started({ converter: job.converter, held: manifest.holdForEdit === true }) };
  }

  /** Conversions a restart interrupted come back as failed, retryable jobs; what they finished is still on disk. A cloud conversion (removed in 3.5.5, or a
   *  manifest from before routes existed) comes back failed for good, with what to do instead. */
  async function recoverConvertJobs(service, { archived = new Set() } = {}) {
    const root = service.store.root;
    void sweepStale(root).catch(() => {});
    const known = new Set((await quiet(listRecords(root)) || []).map(record => record.id));
    for (const { dir, manifest } of await listManifests(root)) {
      if (jobs.has(manifest.id) || archived.has(manifest.id)) continue;
      const local = manifest.route === 'local';
      const job = { id: manifest.id, root, type: TYPE, converter: manifest.converter || 'mineru', filename: manifest.filename, status: 'failed', phase: 'interrupted',
        stage: local ? '上次转换已中断；已完成的部分已保存，点「接着做」继续' : CONVERT_TEXT.cloudGone,
        done: finishedPages(manifest), total: manifest.totalPages, chunk: { index: manifest.chunks.filter(chunk => chunk.state === 'done').length, count: adaptiveOf(manifest) ? 0 : manifest.chunks.length },
        chunks: publicChunks(manifest), warnings: [], note: '', fingerprint: manifest.sourceHash, courses: manifest.courses, retryable: local, ...(adaptiveOf(manifest) ? { local: { adaptive: true } } : {}),
        route: manifest.route || 'cloud', ...(manifest.tier ? { tier: manifest.tier } : {}), ...(manifest.env ? { env: manifest.env } : {}),
        ...(local ? { service: { state: 'unknown', basis: 'none', at: new Date().toISOString() } } : { errorCode: 'cloud-removed' }),
        startedAt: manifest.createdAt, finishedAt: new Date().toISOString(), language: service.language };
      // A conversion that waits for the learner comes back waiting, whatever the last run was doing: their press of 导入 does not outlive the run it started.
      if (local && manifest.held) {
        holdCard(job, manifest);
        if (manifest.held.approved) { manifest.held.approved = false; await quiet(saveManifest(dir, manifest)); }
      }
      ownWork(job, service.workOwner);
      jobs.set(job.id, job);
      if (local) retryable.set(job.id, { convert: true, filename: job.filename, cleanup: cleanupOf(root, job.id, manifest) });
      if (local && manifest.held && known.has(manifest.id)) await quiet(closeRecord(root, manifest.id, { status: 'held', pagesDone: manifest.totalPages }));
      // A conversion that began before the history existed still gets its row (as interrupted: nobody knows how far it got).
      if (!known.has(manifest.id)) await quiet(openRecord(root, { id: manifest.id, filename: manifest.filename, bytes: manifest.sourceBytes, pages: manifest.totalPages, pieces: manifest.chunks.length,
        converter: manifest.converter || 'mineru', route: manifest.route || 'cloud', tier: manifest.tier, pagesDone: finishedPages(manifest), title: manifest.title, startedAt: manifest.createdAt,
        env: manifest.env && { ...manifest.env, ...(manifest.env.kind === 'local' ? { windows: windowsOfPlan(manifest.plan) } : {}) }, plan: manifest.plan, windows: recordWindows(publicChunks(manifest)) }));
    }
    await quiet(interruptRecords(root, liveIds(root)));
  }
  return { startConvertJob, recoverConvertJobs, liveIds };
}

/** One history record as the panel draws it: the stored facts, plus what only the live library can say (is it running, can it resume, does the document still exist).
 *  A cloud row (removed in 3.5.5) never resumes. */
function describeRecord(record, { key, jobs, retryable, activeJob, live, state }) {
  const job = jobs.get(record.id), mine = !!job && job.root === key && job.type === TYPE;
  const retryAble = !!retryable.get(record.id)?.convert || job?.contract?.actions.retry.available === true;
  const canRetry = record.route === 'local' && ['failed', 'interrupted'].includes(record.status) && mine && !live.has(record.id) && retryAble
    && existsSync(join(jobDir(key, record.id), 'manifest.json')) && !activeJob(job);
  const view = { ...record, canRetry, live: live.has(record.id) };
  if (record.status === 'complete') {
    // The pages the conversion imported, as the library has them now. One page id is enough to open the document; the count says how many.
    const found = state?.documents?.find(document => document.id === record.documentId);
    const version = found?.versions?.find(item => item.revision === found.currentRevision) || found?.versions?.at(-1);
    const present = new Set((state?.sources || []).map(source => source.id));
    const sourceIds = (version?.sourceIds || []).filter(id => present.has(id));
    view.document = { exists: sourceIds.length > 0, title: found?.title ?? record.title, pages: sourceIds.length, sourceIds: sourceIds.slice(0, 1) };
  }
  return view;
}

const lengthLimit = (value, limit, name) => {
  if (value !== undefined && (typeof value !== 'string' || value.length > limit)) throw new Error(`${name} 必须是不超过 ${limit} 字的字符串`);
};

/** The `mineru.*` and `marker.*` operations. Close over the audio context's ports; nothing is read or run until an operation runs. */
export function createConvertHandlers(ports) {
  const root = () => ports.state.root;
  const registry = () => ports.worker.uploads;
  const service = () => ports.audioServices.convert;
  const sourceOf = async a => {
    if (a.uploadId !== undefined && a.path !== undefined) throw new Error('path 和 uploadId 只能给一个');
    if (a.uploadId !== undefined) return { upload: true, ...registry().inspectUpload(root(), String(a.uploadId)) };
    if (typeof a.path !== 'string' || !isAbsolute(a.path)) throw new Error('PDF 文件路径必须是绝对路径');
    return { upload: false, path: a.path, name: basename(a.path) };
  };

  /* ---------- 导入前先让我改: the text of a conversion that waits for the learner (lib/converted-edit.js) ---------- */
  const heldOf = async jobId => {
    const id = String(jobId ?? ''), { jobs } = ports.work, row = jobs.get(id);
    if (!row || row.root !== root() || row.type !== TYPE) {
      if (id && await jobArchive(root()).has(id).catch(() => false)) throw Object.assign(new Error(CONVERT_TEXT.archivedHeld), { code: 'archived' });
      throw Object.assign(new Error(CONVERT_TEXT.notHeld), { code: 'not-held' });
    }
    if (ports.jobServices.activeJob(row)) throw new Error('任务还在进行，请等它结束');
    const dir = jobDir(root(), id), manifest = await readManifest(dir).catch(error => { if (error?.code === 'unsupported-store-version') throw error; return null; });
    if (!manifest?.held) throw Object.assign(new Error(CONVERT_TEXT.notHeld), { code: 'not-held' });
    return { id, dir, manifest, content: await readHeldContent(dir).catch(() => { throw new Error(CONVERT_TEXT.folderGone); }) };
  };
  const editOps = {
    /** What the learner edits: every block that would reach a model, with its page; what they changed so far; what that takes out of what a model would read. */
    'mineru.edit.read': async a => {
      const { manifest, content } = await heldOf(a?.jobId), edits = manifest.held.edits || {};
      return { filename: manifest.filename, converter: manifest.converter || 'mineru', pages: manifest.totalPages, blocks: editableBlocks(content), edits, saved: savedBy(content, edits) };
    },
    /** Keep the edits (all of them, each time): on disk, so they survive a restart. */
    'mineru.edit.save': async a => {
      const { dir, manifest, content } = await heldOf(a?.jobId);
      manifest.held.edits = cleanEdits(content, a?.edits);
      await saveManifest(dir, manifest);
      return { edited: Object.keys(manifest.held.edits).length, saved: savedBy(content, manifest.held.edits) };
    },
    /** 导入: the one press that lets this text into the library, through the ordinary continuation of the job. Text the import could not read is refused here, and the job stays as it was. */
    'mineru.edit.import': async a => {
      const { id, dir, manifest, content } = await heldOf(a?.jobId);
      const edits = a?.edits === undefined ? manifest.held.edits || {} : cleanEdits(content, a.edits);
      const { bytes } = mergedBody(manifest, applyEdits(content, edits));
      parseConvertedDocument(bytes.toString('utf8'), { filename: manifest.filename });
      manifest.held.edits = edits; manifest.held.approved = true;
      await saveManifest(dir, manifest);
      try { return await retry({ jobId: id }); }
      catch (error) { manifest.held.approved = false; await saveManifest(dir, manifest).catch(() => {}); throw error; }
    },
  };

  const historyOps = {
    /** The conversion history of this library, newest first: every conversion (old cloud ones too), running or ended, with what can be done next. */
    'mineru.history.list': async () => {
      await ports.audioServices.recoverAudioBatches?.(ports.worker); // a restart's leftovers become "interrupted" rows first
      const key = root(), live = new Set(service().liveIds(key));
      let records = await listRecords(key);
      if (records.some(record => record.status === 'running' && !live.has(record.id))) {
        await interruptRecords(key, [...live]).catch(() => {});
        records = await listRecords(key);
      }
      const state = records.some(record => record.status === 'complete') ? await ports.state.read() : null;
      const context = { key, jobs: ports.work.jobs, retryable: ports.work.retryable, activeJob: ports.jobServices.activeJob, live, state };
      return { records: records.map(record => describeRecord(record, context)), total: records.length, keepLatest: HISTORY.keepLatest, keepDays: Math.round(HISTORY.keepMs / 86_400_000) };
    },
    /** Forget one record. The imported document is not touched; a conversion that is still running keeps its record. */
    'mineru.history.remove': async a => {
      if (typeof a?.id !== 'string' || !a.id) throw new Error('需要给出要删除的记录 id');
      if (service().liveIds(root()).includes(a.id)) throw new Error('这个转换还在进行，没法删除它的记录；请先停止它');
      return { removed: await removeRecord(root(), a.id) };
    },
    /** Forget every record except running ones. Needs `confirm: true`; imported documents are not touched. */
    'mineru.history.clear': async a => {
      if (a?.confirm !== true) throw new Error('清空解析历史前需要先确认：请传 confirm: true。已导入的资料不会被删除。');
      return clearRecords(root(), { keep: service().liveIds(root()) });
    },
  };

  /* ---------- the local MinerU: which program, its install, its service ---------- */
  const seamLocal = () => ports.worker.mineru?.local || {};
  const installSeams = () => ports.worker.mineru?.install || {};
  // A test or preview can stand in for the program (`local.cli`, or null for "not installed"); otherwise StudyHub's own install, MINERU_BIN, the PATH.
  const mineruOf = async () => ('cli' in seamLocal() ? { cli: seamLocal().cli, home: seamLocal().home, origin: seamLocal().origin ?? 'search' } : effectiveMineru({ seams: installSeams() }));
  // A MinerU conversion is live (an uninstall or a stop would pull the service from under it).
  const conversionRunning = () => service().liveIds(root()).some(id => ports.work.jobs.get(id)?.converter !== 'marker');
  const installer = mineruInstallerFor(ports, seams => createMineruInstaller({ ...installSeams(), conversionRunning, ...seams }));
  // What outlives one call (the operations are made per call): the last start failure and the shared status read, per library job list.
  const memo = memoOf(ports.work?.jobs);
  const forget = () => { memo.cached = null; };
  const extras = () => ({ estimates: { ...LOCAL.secondsPerPage }, modelsMbByTier: { ...LOCAL.modelsMb }, windowPages: LOCAL.windowPages });
  /** What the local MinerU is, from read-only calls: the detect fields, where the program comes from, the install, another mineru, the last start failure.
   *  While StudyHub installs it, nothing is asked of the CLI. */
  // The last start failure holds until something proves the service can start: a later start that worked (a conversion's own start too), a repair that
  // completed after it, a read that finds it running, or 停止服务.
  const startedSince = at => [...ports.work.jobs.values()].some(job => job.type === TYPE && typeof job.serviceStartedAt === 'string' && job.serviceStartedAt > at);
  const settleLastError = (install, state) => {
    const last = memo.lastError;
    if (last && (state === 'ready' || (install.status === 'complete' && install.finishedAt > last.at) || startedSince(last.at))) memo.lastError = null;
    return memo.lastError;
  };
  const readLocal = async () => {
    const install = await installer.status();
    const found = await mineruOf(), checkedAt = new Date().toISOString();
    // Another mineru matters next to a StudyHub install, finished or not: its service may hold the port ours needs (「停止另一份 MinerU 并重试」).
    const ourFolder = found.origin === 'installed' ? found.folder : install.folder || '';
    const other = !ourFolder ? null : installSeams().external !== undefined ? installSeams().external : externalMineru({ folder: ourFolder });
    const where = { origin: found.origin || null, folder: found.folder || '', install, checkedAt, external: other ? { exe: other.exe, state: 'found' } : null };
    if (install.status === 'running') return { state: 'installing', next: null, ...where, lastError: memo.lastError, ...extras() };
    let detected;
    try { detected = await detectLocal({ cli: found.cli, home: found.home }); }
    catch (error) { if (error instanceof LocalMineruError && error.code === 'not-installed') detected = { state: 'not-installed', next: 'install' }; else throw error; }
    return { ...detected, ...where, lastError: settleLastError(install, detected.state), ...extras() };
  };
  /** mineru.local.status: concurrent calls share one read, and a read younger than 5 s is reused (`fresh: true` reads again; every action forgets it). */
  const localStatus = ({ fresh = false } = {}) => {
    // A conversion that ended, or found the service stopped, since the last read makes that read old at once.
    const seen = [...ports.work.jobs.values()].filter(job => job.type === TYPE).map(job => `${job.id}:${job.status}:${job.service?.state || ''}`).join('|');
    const cached = memo.cached;
    if (!fresh && cached && cached.seen === seen && (cached.pending || Date.now() - cached.at < 5000)) return cached.promise;
    const entry = { pending: true, at: Date.now(), seen };
    entry.promise = readLocal().finally(() => { entry.pending = false; entry.at = Date.now(); });
    entry.promise.catch(() => { if (memo.cached === entry) memo.cached = null; });
    memo.cached = entry;
    return entry.promise;
  };
  const acting = work => async a => { forget(); try { return await work(a); } finally { forget(); } };
  const start = async ({ restart = false } = {}) => {
    const found = await mineruOf();
    try {
      const state = await startServer({ cli: found.cli, home: found.home, restart });
      memo.lastError = null;
      return state;
    } catch (error) {
      if (!(error instanceof LocalMineruError) || !['server-start-failed', 'timeout'].includes(error.code)) throw error;
      // A plain reason by its code (the status line, the thrown message); what the program printed only in `detail` (更多 › 详细信息). Models that are
      // missing are StudyHub's to repair only in its own install; another mineru's start failure is a failed start.
      let failure = explainStartFailure(error);
      if (failure.code === 'models-missing' && found.origin !== 'installed') failure = { ...failure, code: 'service-failed', message: SERVICE_START_TEXT['service-failed'] };
      memo.lastError = { ...failure, at: new Date().toISOString() };
      throw Object.assign(new LocalMineruError('server-start-failed', failure.message, { retryable: true }), { detail: failure.detail, reason: failure.code });
    }
  };

  const markerCli = async () => ports.worker.marker?.local && 'cli' in ports.worker.marker.local ? ports.worker.marker.local.cli : locateMarker(await effectiveMarkerSettings());
  // `command`: the path of the box that is about to be saved, checked without saving it (检测并保存); without it, what the app would run now.
  // `docker`: the program asked whether Docker runs, for a Marker 2.x (a seam of a test; the real `docker` otherwise).
  const markerStatus = async (a = {}) => detectMarker({ cli: typeof a.command === 'string' && a.command.trim() ? locateMarker({ command: a.command.trim() }) : await markerCli(),
    ...(ports.worker.marker?.docker ? { docker: ports.worker.marker.docker } : {}) });
  // One-click Marker setup (lib/marker-install.js): a private Python environment, only when the learner asks; progress is polled like the MinerU install.
  const markerInstaller = markerInstallerOf(ports, seams => createMarkerInstaller({ ...(ports.worker.marker?.install || {}), ...seams }));

  const retry = async a => {
    const { jobs, retryable } = ports.work;
    // A conversion that is a Job is retried by the Job (the same action the console has): it continues from its manifest.
    const running = await retryJob(ports, String(a.jobId));
    if (running) return running;
    const old = jobs.get(String(a.jobId)), entry = retryable.get(String(a.jobId));
    if (old && old.root === root() && old.type === TYPE && old.route !== 'local') throw Object.assign(new Error(CONVERT_TEXT.cloudGone), { code: 'cloud-removed' });
    if (!old || old.root !== root() || old.type !== TYPE || !entry?.convert) throw new Error('这个任务不能重试：它已经完成，或已被清除');
    if (ports.jobServices.activeJob(old)) throw new Error('任务还在进行，请等它结束');
    let manifest;
    try { manifest = await readManifest(jobDir(root(), old.id)); }
    catch (error) { throw error?.code === 'unsupported-store-version' ? error : new Error('这个任务的临时文件已被清理，没法接着做；请重新导入这份 PDF（已解析好的段落会被复用）'); }
    if (manifest.route !== 'local') throw Object.assign(new Error(CONVERT_TEXT.cloudGone), { code: 'cloud-removed' });
    jobs.delete(old.id); retryable.delete(old.id);
    let started;
    // A MinerU run asks the service once more, read-only, before anything starts; a stopped one is started by the run itself. A conversion past its windows needs no service.
    let serviceState;
    if (manifest.converter !== 'marker' && !manifest.held) {
      forget();
      const checked = await localStatus({ fresh: true }).catch(() => null), at = new Date().toISOString();
      serviceState = { state: !checked ? 'unknown' : ['ready', 'needs-models'].includes(checked.state) ? 'running' : checked.state === 'server-stopped' ? 'stopped' : 'unknown', basis: 'check', at };
    }
    try { started = await service().startConvertJob(ports.worker, { dir: jobDir(root(), old.id), manifest, ...(serviceState ? { serviceState } : {}) }); }
    catch (error) { jobs.set(old.id, old); retryable.set(old.id, entry); throw error; }
    // The letter about the failure is superseded by the retry; if that fails too, it brings its own.
    await withdrawFailureLetter(ports, old.id);
    return started;
  };

  return {
    ...historyOps,
    ...editOps,
    'marker.settings.get': () => readMarkerSettings(),
    'marker.settings.set': a => saveMarkerSettings(a),
    'marker.local.status': a => markerStatus(a),
    'marker.install.plan': a => markerInstaller.plan(a),
    'marker.install.start': a => markerInstaller.start(a),
    'marker.install.status': () => markerInstaller.status(),
    'marker.install.cancel': () => markerInstaller.cancel(),
    'marker.install.uninstall': a => markerInstaller.uninstall(a),
    'marker.import': async a => {
      lengthLimit(a.title, 200, 'title'); lengthLimit(a.course, 200, 'course');
      if (a.courses !== undefined && (!Array.isArray(a.courses) || a.courses.some(item => typeof item !== 'string'))) throw new Error('courses 必须是字符串数组');
      if (!ports.worker.documents) throw new Error(NO_MATERIALS);
      const status = await markerStatus();
      if (!markerUsable(status)) throw new Error(status.message || '请先在设置中配置 Marker');
      const file = await sourceOf(a);
      const upload = file.upload ? registry().claimUpload(root(), String(a.uploadId)) : null;
      let prepared;
      try {
        prepared = await prepareJob({ root: root(), source: file.path, filename: file.name, title: a.title?.trim() || undefined, courses: importCourses(a, currentCourse(await ports.state.read())), language: ports.worker.language, limits: ports.worker.marker?.limits, route: 'local', converter: 'marker' });
        prepared.manifest.env = { kind: 'local', windows: windowsOfPlan(prepared.manifest.plan) };
        if (a.reviewBeforeImport === true) prepared.manifest.holdForEdit = true;
        await saveManifest(prepared.dir, prepared.manifest);
        const started = await service().startConvertJob(ports.worker, prepared);
        if (upload) void registry().discardUpload(upload).catch(() => {});
        return started;
      } catch (error) {
        if (prepared) await discardJob(root(), prepared.manifest.id, { keepResults: true, sourceHash: prepared.manifest.sourceHash, converter: prepared.manifest.converter }).catch(() => {});
        if (upload) registry().releaseUpload(upload);
        throw error;
      }
    },
    /** The local MinerU, from read-only calls: installing, not installed, needs models, service stopped, ready or unknown; with the next step, where it comes from,
     *  StudyHub's install, another mineru, the last start failure and the measured speed estimates. */
    'mineru.local.status': a => localStatus({ fresh: a?.fresh === true }),
    /** Start the local service (`restart`: stop, then start; `stopExternal`: first stop another mineru's service that holds the port). */
    'mineru.local.start': acting(async a => {
      if (a?.stopExternal === true) {
        const found = await mineruOf(), other = found.origin === 'installed' ? externalMineru({ folder: found.folder }) : null;
        if (other) await stopServer({ cli: { file: other.exe, prefix: [], env: {} } }).catch(() => {});
      }
      return { ...await start({ restart: a?.restart === true || a?.stopExternal === true }), ...extras() };
    }),
    /** Stop the local service (更多 › 停止服务): never while a MinerU conversion uses it. */
    'mineru.local.stop': acting(async () => {
      if (conversionRunning()) throw Object.assign(new Error(MINERU_INSTALL_MESSAGES.conversionRunning), { code: 'conversion-running' });
      const found = await mineruOf();
      if (!found.cli) throw new LocalMineruError('not-installed', LOCAL_MESSAGES.notInstalled);
      const stopped = await stopServer({ cli: found.cli, home: found.home });
      // Stopped on purpose: an earlier failed start is not what the card should show any more.
      memo.lastError = null;
      return { ...stopped, ...extras() };
    }),
    /** The one-click install (lib/mineru-install.js): what it would do here (read-only), start it (after the learner's click: `confirm: true`), its progress, cancel, uninstall. */
    'mineru.install.plan': a => installer.plan(a || {}),
    'mineru.install.start': acting(a => installer.start(a || {})),
    'mineru.install.status': () => installer.status(),
    'mineru.install.cancel': acting(() => installer.cancel()),
    'mineru.install.uninstall': acting(a => installer.uninstall(a || {})),
    'mineru.upload.start': a => registry().startUpload(root(), { name: a.name, size: a.size, kind: 'pdf' }),
    'mineru.upload.chunk': a => registry().appendUpload(root(), { uploadId: a.uploadId, offset: a.offset, data: a.data }),
    'mineru.upload.finish': a => registry().finishUpload(root(), a.uploadId),
    'mineru.upload.cancel': a => registry().cancelUpload(root(), String(a.uploadId)),
    /** What would happen to this PDF: pages, the windows the local route starts with, and the time it may take. Reads the file locally; sends nothing. */
    'mineru.plan': async a => {
      const file = await sourceOf(a);
      const plan = await planFile({ source: file.path, limits: ports.worker.mineru?.limits });
      return { name: file.name, pages: plan.pages, bytes: plan.bytes,
        windows: plan.windows.map(piece => ({ index: piece.index + 1, startPage: piece.startPage, endPage: piece.endPage, pages: piece.pages })),
        ...(plan.adaptive ? { adaptive: { firstPages: plan.adaptive.firstPages, rampPages: plan.adaptive.rampPages, targetSeconds: plan.adaptive.targetSeconds, minPages: plan.adaptive.minPages, maxPages: plan.adaptive.maxPages } } : {}),
        localEstimateSeconds: Object.fromEntries(Object.entries(LOCAL.secondsPerPage).map(([tier, seconds]) => [tier, Math.round(plan.pages * seconds)])) };
    },
    'mineru.import': async a => {
      lengthLimit(a.title, 200, 'title'); lengthLimit(a.course, 200, 'course');
      if (a.courses !== undefined && (!Array.isArray(a.courses) || a.courses.some(item => typeof item !== 'string'))) throw new Error('courses 必须是字符串数组');
      if (a.route === 'cloud') throw Object.assign(new Error(MINERU_INSTALL_MESSAGES.cloudRemoved), { code: 'cloud-removed' });
      if (a.route !== undefined && !['local', 'auto'].includes(a.route)) throw new Error('route 只能是 local 或 auto');
      if (!ports.worker.documents) throw new Error(NO_MATERIALS);
      // Everything is local; what is checked before anything is read: the program is there, set up, and either running or able to be started by the run.
      forget();
      const local = await localStatus({ fresh: true }), found = await mineruOf();
      if (!['ready', 'server-stopped'].includes(local.state)) {
        const message = local.state === 'installing' ? MINERU_INSTALL_MESSAGES.installing : local.state === 'unknown' ? LOCAL_MESSAGES.unreadable
          : local.state === 'needs-models' && found.origin === 'installed' ? LOCAL_MESSAGES.setupNeedsModels : MINERU_INSTALL_MESSAGES.notInstalled;
        throw new LocalMineruError(local.state, message, { retryable: true });
      }
      const stopped = local.state === 'server-stopped';
      // A stopped service says nothing about its tier: StudyHub's install knows it, another mineru is asked once it runs (the run starts it first).
      const tier = local.tier || local.install?.installedTier || (found.origin === 'installed' ? found.tier : '') || local.install?.tier || 'basic';
      const file = await sourceOf(a);
      const upload = file.upload ? registry().claimUpload(root(), String(a.uploadId)) : null;
      let prepared;
      try {
        const courses = importCourses(a, currentCourse(await ports.state.read()));
        prepared = await prepareJob({ root: root(), source: file.path, filename: file.name, title: a.title?.trim() || undefined, courses, language: ports.worker.language, limits: ports.worker.mineru?.limits, route: 'local', tier });
        // What will do the work, captured now (read-only) and kept with the job and its history record: the model, the tier, the service, the window plan.
        prepared.manifest.env = { ...await readLocalEnvironment({ cli: found.cli, home: found.home, status: stopped ? { ...local, tier } : local }).catch(() => ({ kind: 'local', tier })), windows: windowsOfPlan(prepared.manifest.plan) };
        if (stopped) prepared.manifest.autoStart = true;
        if (a.reviewBeforeImport === true) prepared.manifest.holdForEdit = true;
        await saveManifest(prepared.dir, prepared.manifest).catch(() => {});
        const serviceState = { state: stopped ? 'stopped' : 'running', basis: 'check', at: new Date().toISOString() };
        const started = await service().startConvertJob(ports.worker, { ...prepared, serviceState });
        if (upload) void registry().discardUpload(upload).catch(() => {});
        return started;
      } catch (error) {
        if (prepared) await discardJob(root(), prepared.manifest.id, { keepResults: true, sourceHash: prepared.manifest.sourceHash, converter: prepared.manifest.converter }).catch(() => {});
        if (upload) registry().releaseUpload(upload);
        throw error;
      }
    },
    'mineru.retry': a => retry(a),
  };
}
