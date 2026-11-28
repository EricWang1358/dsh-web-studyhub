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
import { MINERU, MineruError, createMineruClient } from '../../mineru-api.js';
import { NO_MINERU_ACK, NO_MINERU_TOKEN, hasMineruToken, publicMineruSettings, readMineruSettings, saveMineruSettings } from '../../mineru-settings.js';
import { discardJob, discardUnlessHeld, jobDir, listManifests, mergedBody, planFile, prepareJob, readHeldContent, readManifest, saveManifest, sweepStale, switchManifestToLocal } from '../../mineru-job.js';
import { parseConvertedDocument } from '../../converted-document.js';
import { applyEdits, editableBlocks, mergeEdits, savedBy } from '../../converted-edit.js';
import { LOCAL, LOCAL_MESSAGES, LocalMineruError, OTHER_HOME_TEXT, SERVICE_START_TEXT, detectLocal, explainStartFailure, readLocalEnvironment, startServer, stopServer } from '../../mineru-local.js';
import { HISTORY, clearRecords, closeRecord, interruptRecords, listRecords, openRecord, removeRecord } from '../../mineru-history.js';
import { importCourses } from '../../source-courses.js';
import { currentCourse } from '../../focus.js';
import { CONVERT_TEXT, NO_MATERIALS, TYPE, adaptiveOf, cloudEnvironment, finishedPages, publicChunks, recordWindows, stageText, windowsOfPlan } from './convert-support.js';
import { announceEnd, holdCard, newConvertCard, withdrawFailureLetter } from './convert-card.js';
import { jobArchive } from '../../job-archive.js';
import { retryJob } from './pdf/retry-pdf-convert.js';
import { startPdfConvert } from './pdf/submit-pdf-convert.js';
import { openHistory, runConversion } from './pdf/convert-run.js';

/* PDF conversion with MinerU (local by default, or optional cloud / third-party compatible endpoint with custom baseUrl + Key)
   or Marker (local): the same background-job model as the audio imports (one job in the shared job list, cancel / dismiss / retry,
   a letter in the inbox when it ends), with its own operations, `mineru.*` and `marker.*`.
   Default is always local (zero upload). Cloud conversion requires explicit user opt-in (Key + first-use upload confirmation).
   When a cloud job fails, the user can retry in the cloud or switch it directly to local (`mineru.retry { jobId, route: 'local' }`). */

export { NO_MATERIALS, stageText };

/** One read-change-write at a time per job folder: two windows saving, or pressing 导入 almost together, take turns. */
const turns = new Map();
const inTurn = (key, work) => {
  const mine = (turns.get(key) || Promise.resolve()).catch(() => {}).then(work);
  turns.set(key, mine);
  void mine.catch(() => {}).finally(() => { if (turns.get(key) === mine) turns.delete(key); });
  return mine;
};

const gates = new WeakMap();
const gateFor = jobs => { let gate = gates.get(jobs); if (!gate) { gate = { active: 0, waiting: 0, tail: Promise.resolve() }; gates.set(jobs, gate); } return gate; };
const memos = new WeakMap(), sharedMemo = { lastError: null, cached: null };
const memoOf = key => { if (!key || typeof key !== 'object') return sharedMemo; let memo = memos.get(key); if (!memo) { memo = { lastError: null, cached: null }; memos.set(key, memo); } return memo; };

/** The background side: starting, resuming and recovering conversion jobs. Shares the audio context's job maps. */
export function createConvertWorker(worker, work, jobServices) {
  const { jobs, settled, retryable, generationControllers } = work;
  const { activeJob, pruneJobs } = jobServices;
  const quiet = work => Promise.resolve(work).catch(() => null);
  /** What a retry's hold lets go of. Never a conversion waiting for the learner: their edits leave only when they let them go (job.delete, lib/contexts/jobs/operations.js). */
  const cleanupOf = (root, id, manifest) => () => discardUnlessHeld(root, id, { sourceHash: manifest.sourceHash, converter: manifest.converter });
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
    if (service.runtimePilot?.pdfConvert === true && service.runtimeJobs) return startPdfConvert(service, { manifest, serviceState });
    const gate = gateFor(jobs), queuedBehind = gate.active + gate.waiting, waits = queuedBehind > 0;
    const aheadJob = waits
      ? [...jobs.values()].find(other => other.root === root && other.type === TYPE && activeJob(other) && other.status === 'running')
        || [...jobs.values()].find(other => other.root === root && other.type === TYPE && activeJob(other))
      : null;
    const job = newConvertCard({ manifest, root, language: service.language, serviceState, queued: waits });
    ownWork(job, service.workOwner);
    jobs.set(job.id, job);
    retryable.set(job.id, { convert: true, filename: job.filename, cleanup: cleanupOf(root, job.id, manifest) });
    const controller = new AbortController();
    generationControllers.set(job.id, controller);
    const signal = controller.signal;

    const history = openHistory({ root, job, manifest, service });
    if (waits) gate.waiting++;
    const run = async () => {
      if (waits) gate.waiting--;
      gate.active++;
      try { await runConversion({ service, root, dir, manifest, job, signal, history, cancelled: () => signal.aborted && !!job.cancelRequestedAt }); }
      finally {
        gate.active--;
        generationControllers.delete(job.id);
        memoOf(jobs).cached = null;
        if (job.status === 'complete' || (job.retryable === false && job.route === 'local')) retryable.delete(job.id);
        if (job.status !== 'cancelled') await announceEnd(service, job);
      }
    };
    const done = gate.tail.catch(() => {}).then(run);
    gate.tail = done;
    settled.set(job.id, done);
    void done.finally(() => { settled.delete(job.id); });
    await history.opened;
    return { jobId: job.id, status: job.status, queuedBehind, pages: manifest.totalPages, chunks: manifest.chunks.map(chunk => ({ index: chunk.index + 1, startPage: chunk.startPage, endPage: chunk.endPage, pages: chunk.pages })),
      converter: job.converter, route: job.route, next: CONVERT_TEXT.started({ converter: job.converter, route: job.route, held: manifest.holdForEdit === true, queuedBehind, aheadTitle: aheadJob?.filename || '' }) };
  }

  /** Conversions a restart interrupted come back as failed, retryable jobs (both local and cloud); what they finished is still on disk. */
  async function recoverConvertJobs(service, { archived = new Set() } = {}) {
    const root = service.store.root;
    void sweepStale(root).catch(() => {});
    const known = new Set((await quiet(listRecords(root)) || []).map(record => record.id));
    for (const { dir, manifest } of await listManifests(root)) {
      if (jobs.has(manifest.id) || archived.has(manifest.id)) continue;
      await comeBack(service, { dir, manifest });
      if (!known.has(manifest.id)) await quiet(openRecord(root, { id: manifest.id, filename: manifest.filename, bytes: manifest.sourceBytes, pages: manifest.totalPages, pieces: manifest.chunks.length,
        converter: manifest.converter || 'mineru', route: manifest.route || 'cloud', tier: manifest.tier, pagesDone: finishedPages(manifest), title: manifest.title, startedAt: manifest.createdAt,
        env: manifest.env && { ...manifest.env, ...(manifest.env.kind === 'local' ? { windows: windowsOfPlan(manifest.plan) } : {}) }, plan: manifest.plan, windows: recordWindows(publicChunks(manifest)) }));
      if (manifest.held && known.has(manifest.id)) await quiet(closeRecord(root, manifest.id, { status: 'held', pagesDone: manifest.totalPages }));
    }
    await quiet(interruptRecords(root, liveIds(root)));
  }

  /** A conversion on disk as a job of the list that can go on (resume or switch to local). */
  async function comeBack(service, { dir, manifest }) {
    const root = service.store.root, local = manifest.route === 'local';
    const job = { id: manifest.id, root, type: TYPE, converter: manifest.converter || 'mineru', filename: manifest.filename, status: 'failed', phase: 'interrupted',
      stage: '上次转换已中断；已完成的部分已保存，点「接着做」继续',
      done: finishedPages(manifest), total: manifest.totalPages, chunk: { index: manifest.chunks.filter(chunk => chunk.state === 'done').length, count: adaptiveOf(manifest) ? 0 : manifest.chunks.length },
      chunks: publicChunks(manifest), warnings: [], note: '', fingerprint: manifest.sourceHash, courses: manifest.courses, retryable: true, ...(adaptiveOf(manifest) ? { local: { adaptive: true } } : {}),
      route: manifest.route || 'cloud', ...(manifest.tier ? { tier: manifest.tier } : {}), ...(manifest.env ? { env: manifest.env } : {}),
      ...(local ? { service: { state: 'unknown', basis: 'none', at: new Date().toISOString() } } : {}),
      startedAt: manifest.createdAt, finishedAt: new Date().toISOString(), language: service.language };
    if (manifest.held) {
      holdCard(job, manifest);
      if (manifest.held.approved) { manifest.held.approved = false; await quiet(saveManifest(dir, manifest)); }
    }
    ownWork(job, service.workOwner);
    jobs.set(job.id, job);
    retryable.set(job.id, { convert: true, filename: job.filename, cleanup: cleanupOf(root, job.id, manifest) });
    return job;
  }
  return { startConvertJob, recoverConvertJobs, comeBack, liveIds };
}

/** One history record as the panel draws it: the stored facts, plus what only the live library can say (is it running, can it resume, does the document still exist). */
function describeRecord(record, { key, jobs, retryable, activeJob, live, state }) {
  const job = jobs.get(record.id), mine = !!job && job.root === key && job.type === TYPE;
  const retryAble = !!retryable.get(record.id)?.convert || job?.contract?.actions.retry.available === true;
  const canRetry = ['failed', 'interrupted'].includes(record.status) && mine && !live.has(record.id) && retryAble
    && existsSync(join(jobDir(key, record.id), 'manifest.json')) && !activeJob(job);
  const { sourcePath: _path, sourceHash: _hash, ...shown } = record;
  const view = { ...shown, canRetry, live: live.has(record.id) };
  if (record.status === 'complete') {
    const found = state?.documents?.find(document => document.id === record.documentId);
    const version = found?.versions?.find(item => item.revision === found.currentRevision) || found?.versions?.at(-1);
    const present = new Set((state?.sources || []).map(source => source.id));
    const sourceIds = (version?.sourceIds || []).filter(id => present.has(id));
    view.document = { exists: sourceIds.length > 0, title: found?.title ?? record.title, pages: sourceIds.length, sourceIds: sourceIds.slice(0, 1),
      ...(version?.repeated && sourceIds.length ? { repeated: version.repeated } : {}) };
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
  const sourcePathOf = file => (file.upload ? undefined : file.path);
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
    return { id, dir, row, manifest, content: await readHeldContent(dir).catch(() => { throw new Error(CONVERT_TEXT.folderGone); }) };
  };
  const heldTurn = (a, work) => inTurn(String(a?.jobId ?? ''), () => heldOf(a?.jobId).then(work));
  const editOps = {
    'mineru.edit.read': async a => {
      const held = await heldOf(a?.jobId).catch(error => { if (error?.code === 'archived') return null; throw error; });
      if (!held) return { archived: true };
      const { manifest, content } = held, edits = manifest.held.edits || {};
      return { filename: manifest.filename, converter: manifest.converter || 'mineru', pages: manifest.totalPages, blocks: editableBlocks(content), edits, saved: savedBy(content, edits) };
    },
    'mineru.edit.save': a => heldTurn(a, async ({ dir, manifest, content }) => {
      manifest.held.edits = mergeEdits(content, manifest.held.edits, a?.edits, a?.restore);
      await saveManifest(dir, manifest);
      return { edited: Object.keys(manifest.held.edits).length, edits: manifest.held.edits, saved: savedBy(content, manifest.held.edits) };
    }),
    'mineru.edit.import': a => heldTurn(a, async ({ id, dir, row, manifest, content }) => {
      const edits = mergeEdits(content, manifest.held.edits, a?.edits, a?.restore);
      const { bytes } = mergedBody(manifest, applyEdits(content, edits));
      parseConvertedDocument(bytes.toString('utf8'), { filename: manifest.filename });
      manifest.held.edits = edits; manifest.held.approved = true;
      await saveManifest(dir, manifest);
      try {
        if (row.restoredContract) await service().comeBack(ports.worker, { dir, manifest: { ...manifest, held: { ...manifest.held, approved: false } } });
        return await retry({ jobId: id });
      } catch (error) { manifest.held.approved = false; await saveManifest(dir, manifest).catch(() => {}); throw error; }
    }),
  };

  const historyOps = {
    'mineru.history.list': async () => {
      await ports.audioServices.recoverAudioBatches?.(ports.worker);
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
    'mineru.history.remove': async a => {
      if (typeof a?.id !== 'string' || !a.id) throw new Error('需要给出要删除的记录 id');
      if (service().liveIds(root()).includes(a.id)) throw new Error('这个转换还在进行，没法删除它的记录；请先停止它');
      return { removed: await removeRecord(root(), a.id) };
    },
    'mineru.history.clear': async a => {
      if (a?.confirm !== true) throw new Error('清空解析历史前需要先确认：请传 confirm: true。已导入的资料不会被删除。');
      return clearRecords(root(), { keep: service().liveIds(root()) });
    },
  };

  /* ---------- the local MinerU: which program, its install, its service ---------- */
  const seamLocal = () => ports.worker.mineru?.local || {};
  const installSeams = () => ports.worker.mineru?.install || {};
  const mineruOf = async () => ('cli' in seamLocal() ? { cli: seamLocal().cli, home: seamLocal().home, origin: seamLocal().origin ?? 'search' } : effectiveMineru({ seams: installSeams() }));
  const conversionRunning = () => service().liveIds(root()).some(id => { const j = ports.work.jobs.get(id); return j?.converter !== 'marker' && j?.route === 'local'; });
  const installer = mineruInstallerFor(ports, seams => createMineruInstaller({ ...installSeams(), conversionRunning, ...seams }));
  const memo = memoOf(ports.work?.jobs);
  const forget = () => { memo.cached = null; };
  const extras = () => ({ estimates: { ...LOCAL.secondsPerPage }, modelsMbByTier: { ...LOCAL.modelsMb }, windowPages: LOCAL.windowPages });
  const startedSince = at => [...ports.work.jobs.values()].some(job => job.type === TYPE && typeof job.serviceStartedAt === 'string' && job.serviceStartedAt > at);
  const settleLastError = (install, state) => {
    const last = memo.lastError;
    if (last && (state === 'ready' || (install.status === 'complete' && install.finishedAt > last.at) || startedSince(last.at))) memo.lastError = null;
    return memo.lastError;
  };
  const STATUS_STALE_MS = 30_000;
  const detectNow = async found => {
    try { return await detectLocal({ cli: found.cli, home: found.home }); }
    catch (error) { if (error instanceof LocalMineruError && error.code === 'not-installed') return { state: 'not-installed', next: 'install' }; throw error; }
  };
  const settled = (entry, value) => { Object.assign(entry, { value, at: Date.now(), checkedAt: new Date().toISOString(), pending: false }); if (value.state === 'unknown' && memo.cached === entry) memo.cached = null; };
  const detected = ({ found, install, fresh }) => {
    const seen = [...ports.work.jobs.values()].filter(job => job.type === TYPE).map(job => `${job.id}:${job.status}:${job.service?.state || ''}`).join('|');
    const key = JSON.stringify([found.cli?.file ?? null, found.cli?.prefix ?? [], found.origin ?? null, found.folder ?? '', found.home ?? '', install.status, install.installedFolder, install.finishedAt, seen]);
    const cached = memo.cached;
    if (!fresh && cached?.key === key) {
      if (cached.pending) return cached.promise;
      if (cached.value) {
        if (Date.now() - cached.at >= (seamLocal().staleMs ?? STATUS_STALE_MS) && !cached.renewing) {
          cached.renewing = detectNow(found).then(value => { if (memo.cached === cached) settled(cached, value); }, () => {}).finally(() => { cached.renewing = null; });
        }
        return cached;
      }
    }
    const entry = { key, pending: true, at: Date.now(), value: null, checkedAt: '', renewing: null };
    entry.promise = detectNow(found).then(value => { settled(entry, value); return entry; });
    entry.promise.catch(() => { if (memo.cached === entry) memo.cached = null; });
    memo.cached = entry;
    return entry.promise;
  };
  const localStatus = async ({ fresh = false } = {}) => {
    const install = await installer.status();
    const found = await mineruOf();
    const ourFolder = found.origin === 'installed' ? found.folder : install.folder || '';
    const other = !ourFolder ? null : installSeams().external !== undefined ? installSeams().external : externalMineru({ folder: ourFolder });
    const where = { origin: found.origin || null, folder: found.folder || '', install, external: other ? { exe: other.exe, state: 'found' } : null };
    if (install.status === 'running') return { state: 'installing', next: null, ...where, checkedAt: new Date().toISOString(), lastError: memo.lastError, ...extras() };
    const read = await detected({ found, install, fresh });
    return { ...read.value, ...where, checkedAt: read.checkedAt, lastError: settleLastError(install, read.value.state), ...extras() };
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
      let failure = explainStartFailure(error);
      if (failure.code === 'models-missing' && found.origin !== 'installed') failure = { ...failure, code: 'service-failed', message: SERVICE_START_TEXT['service-failed'] };
      if (failure.code === 'home-permissions' && found.origin !== 'installed') failure = { ...failure, message: OTHER_HOME_TEXT };
      memo.lastError = { ...failure, at: new Date().toISOString() };
      throw Object.assign(new LocalMineruError('server-start-failed', failure.message, { retryable: true }), { detail: failure.detail, reason: failure.code });
    }
  };

  /** Check that local MinerU is usable (ready, server-stopped, or busy peer running) and return its tier, env & service state. */
  const requireLocalReady = async () => {
    forget();
    const local = await localStatus({ fresh: true }), found = await mineruOf();
    const busyPeer = local.state === 'unknown'
      ? [...ports.work.jobs.values()].find(job => job.type === TYPE && job.converter !== 'marker' && job.route === 'local' && ports.jobServices.activeJob(job))
      : null;
    if (!['ready', 'server-stopped'].includes(local.state) && !busyPeer) {
      const message = local.state === 'installing' ? MINERU_INSTALL_MESSAGES.installing : local.state === 'unknown' ? LOCAL_MESSAGES.unreadable
        : local.state === 'needs-models' && found.origin === 'installed' ? LOCAL_MESSAGES.setupNeedsModels : MINERU_INSTALL_MESSAGES.notInstalled;
      throw new LocalMineruError(local.state, message, { retryable: true });
    }
    const stopped = local.state === 'server-stopped';
    const tier = local.tier || busyPeer?.tier || local.install?.installedTier || (found.origin === 'installed' ? found.tier : '') || local.install?.tier || 'basic';
    return { local, found, busyPeer, stopped, tier };
  };

  const markerCli = async () => ports.worker.marker?.local && 'cli' in ports.worker.marker.local ? ports.worker.marker.local.cli : locateMarker(await effectiveMarkerSettings());
  const markerStatus = async (a = {}) => detectMarker({ cli: typeof a.command === 'string' && a.command.trim() ? locateMarker({ command: a.command.trim() }) : await markerCli(),
    ...(ports.worker.marker?.docker ? { docker: ports.worker.marker.docker } : {}) });
  const markerInstaller = markerInstallerOf(ports, seams => createMarkerInstaller({ ...(ports.worker.marker?.install || {}), ...seams }));

  const retry = async a => {
    if (a?.route !== undefined && a.route !== 'local') throw new Error('重试切换路线目前仅支持 route: "local"');
    const id = String(a.jobId);
    const { jobs, retryable } = ports.work;
    const old = jobs.get(id), entry = retryable.get(id);
    const switchingToLocal = a?.route === 'local';

    // When switching a failed cloud job to local ("改用本机"), re-plan its manifest on disk before retrying (works for both runtime & legacy jobs!).
    if (switchingToLocal) {
      if (old && (old.root !== root() || old.type !== TYPE)) throw new Error('这个任务不能重试：它已经完成，或已被清除');
      if (old && ports.jobServices.activeJob(old)) throw new Error('任务还在进行，请等它结束');
      const dir = jobDir(root(), id);
      let manifest;
      try { manifest = await readManifest(dir); }
      catch (error) { throw error?.code === 'unsupported-store-version' ? error : new Error('这个任务的临时文件已被清理，没法改用本机；请重新选择这份 PDF 用本机解析。'); }
      const { local, found, busyPeer, stopped, tier } = await requireLocalReady();
      if (manifest.route !== 'local') {
        await switchManifestToLocal({ dir, manifest, tier, limits: ports.worker.mineru?.limits });
        const baseEnv = busyPeer?.env?.kind === 'local'
          ? { ...busyPeer.env, tier }
          : await readLocalEnvironment({ cli: found.cli, home: found.home, status: stopped ? { ...local, tier } : local }).catch(() => ({ kind: 'local', tier }));
        manifest.env = { ...baseEnv, windows: windowsOfPlan(manifest.plan) };
        if (stopped) {
          manifest.autoStart = true;
          if (local.needsRestart || local.unhealthy) manifest.restartService = true;
        }
        await saveManifest(dir, manifest);
      }
      const running = await retryJob(ports, id);
      if (running) return { ...running, route: 'local' };
      if (!old) throw new Error('这个任务不能重试：它已经完成，或已被清除');
      jobs.delete(old.id); retryable.delete(old.id);
      const serviceState = { state: stopped ? 'stopped' : 'running', basis: 'check', at: new Date().toISOString() };
      let started;
      try { started = await service().startConvertJob(ports.worker, { dir, manifest, serviceState }); }
      catch (error) { jobs.set(old.id, old); if (entry) retryable.set(old.id, entry); throw error; }
      await withdrawFailureLetter(ports, old.id);
      return started;
    }

    // Normal retry (keeps the job's own route: local or cloud).
    const running = await retryJob(ports, id);
    if (running) return running;
    if (!old || old.root !== root() || old.type !== TYPE || !entry?.convert) throw new Error('这个任务不能重试：它已经完成，或已被清除');
    if (ports.jobServices.activeJob(old)) throw new Error('任务还在进行，请等它结束');
    let manifest;
    try { manifest = await readManifest(jobDir(root(), old.id)); }
    catch (error) { throw error?.code === 'unsupported-store-version' ? error : new Error('这个任务的临时文件已被清理，没法接着做；请重新导入这份 PDF（已解析好的段落会被复用）'); }
    jobs.delete(old.id); retryable.delete(old.id);
    let started;
    let serviceState;
    if (manifest.route === 'local' && manifest.converter !== 'marker' && !manifest.held) {
      forget();
      const checked = await localStatus({ fresh: true }).catch(() => null), at = new Date().toISOString();
      serviceState = { state: !checked ? 'unknown' : ['ready', 'needs-models'].includes(checked.state) ? 'running' : checked.state === 'server-stopped' ? 'stopped' : 'unknown', basis: 'check', at };
      if (checked?.needsRestart || checked?.unhealthy) {
        manifest.autoStart = true;
        manifest.restartService = true;
        await saveManifest(jobDir(root(), old.id), manifest).catch(() => {});
      }
    }
    try { started = await service().startConvertJob(ports.worker, { dir: jobDir(root(), old.id), manifest, ...(serviceState ? { serviceState } : {}) }); }
    catch (error) { jobs.set(old.id, old); retryable.set(old.id, entry); throw error; }
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
        prepared = await prepareJob({ root: root(), source: file.path, filename: file.name, title: a.title?.trim() || undefined, courses: importCourses(a, currentCourse(await ports.state.read())), language: ports.worker.language, limits: ports.worker.marker?.limits, route: 'local', converter: 'marker', sourcePath: sourcePathOf(file) });
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
    /** Read MinerU parsing mode (default: local), cloud baseUrl, masked Key hint, and upload acknowledgement. */
    'mineru.settings.get': async () => publicMineruSettings(await readMineruSettings()),
    /** Update MinerU parsing mode, custom cloud baseUrl, Key, or upload acknowledgement. */
    'mineru.settings.set': async (a = {}) => {
      const patch = {};
      if (a.mode !== undefined) patch.mode = a.mode;
      if (a.baseUrl !== undefined) patch.baseUrl = a.baseUrl;
      if (a.token !== undefined) patch.token = a.token;
      if (a.acknowledge !== undefined) patch.acknowledge = a.acknowledge;
      return publicMineruSettings(await saveMineruSettings(patch));
    },
    /** One harmless authenticated request against the configured cloud baseUrl + Key. Nothing is uploaded. */
    'mineru.test': async () => {
      const settings = await readMineruSettings();
      if (!hasMineruToken(settings)) return { ok: false, state: 'missing', configured: false, message: '未配置', baseUrl: settings.effectiveBaseUrl };
      const seam = ports.worker.mineru || {};
      const baseUrl = seam.baseUrl || settings.effectiveBaseUrl;
      try {
        await createMineruClient({ token: settings.token, baseUrl, ...(seam.fetch ? { fetch: seam.fetch } : {}) }).check();
        return { ok: true, state: 'valid', configured: true, message: '密钥有效，云端接口连得上', baseUrl };
      } catch (error) {
        if (!(error instanceof MineruError)) throw error;
        const state = error.code === 'invalid-token' ? 'invalid' : error.code === 'expired' ? 'expired' : error.code === 'invalid-base-url' ? 'invalid-url' : error.code === 'network' ? 'unreachable' : 'unavailable';
        return { ok: false, state, configured: true, message: error.message, baseUrl };
      }
    },
    'mineru.local.status': a => localStatus({ fresh: a?.fresh === true }),
    'mineru.local.start': acting(async a => {
      if (a?.stopExternal === true) {
        const found = await mineruOf(), other = found.origin === 'installed' ? externalMineru({ folder: found.folder }) : null;
        if (other) await stopServer({ cli: { file: other.exe, prefix: [], env: {} } }).catch(() => {});
      }
      return { ...await start({ restart: a?.restart === true || a?.stopExternal === true }), ...extras() };
    }),
    'mineru.local.stop': acting(async () => {
      if (conversionRunning()) throw Object.assign(new Error(MINERU_INSTALL_MESSAGES.conversionRunning), { code: 'conversion-running' });
      const found = await mineruOf();
      if (!found.cli) throw new LocalMineruError('not-installed', LOCAL_MESSAGES.notInstalled);
      const stopped = await stopServer({ cli: found.cli, home: found.home });
      memo.lastError = null;
      return { ...stopped, ...extras() };
    }),
    'mineru.install.plan': a => installer.plan(a || {}),
    'mineru.install.start': acting(a => installer.start(a || {})),
    'mineru.install.status': () => installer.status(),
    'mineru.install.cancel': acting(() => installer.cancel()),
    'mineru.install.uninstall': acting(a => installer.uninstall(a || {})),
    'mineru.upload.start': a => registry().startUpload(root(), { name: a.name, size: a.size, kind: 'pdf' }),
    'mineru.upload.chunk': a => registry().appendUpload(root(), { uploadId: a.uploadId, offset: a.offset, data: a.data }),
    'mineru.upload.finish': a => registry().finishUpload(root(), a.uploadId),
    'mineru.upload.cancel': a => registry().cancelUpload(root(), String(a.uploadId)),
    /** What would happen to this PDF: pages, local windows, cloud pieces, and cloud readiness. Reads locally; sends nothing. */
    'mineru.plan': async a => {
      const file = await sourceOf(a);
      const [plan, settings] = await Promise.all([
        planFile({ source: file.path, limits: ports.worker.mineru?.limits }),
        readMineruSettings().catch(() => ({ mode: 'local', baseUrl: '', effectiveBaseUrl: MINERU.baseUrl, token: '', acknowledgedAt: '' })),
      ]);
      return { name: file.name, pages: plan.pages, bytes: plan.bytes,
        pieces: plan.plan.map(piece => ({ index: piece.index + 1, startPage: piece.startPage, endPage: piece.endPage, pages: piece.pages, estimatedBytes: piece.estimatedBytes, cut: piece.cut })),
        maySplitFurther: plan.maySplitFurther,
        byChapters: plan.plan.length > 1 && plan.plan.every(piece => piece.cut === 'chapter' || piece.cut === 'whole'),
        windows: plan.windows.map(piece => ({ index: piece.index + 1, startPage: piece.startPage, endPage: piece.endPage, pages: piece.pages })),
        ...(plan.adaptive ? { adaptive: { firstPages: plan.adaptive.firstPages, rampPages: plan.adaptive.rampPages, targetSeconds: plan.adaptive.targetSeconds, minPages: plan.adaptive.minPages, maxPages: plan.adaptive.maxPages } } : {}),
        localEstimateSeconds: Object.fromEntries(Object.entries(LOCAL.secondsPerPage).map(([tier, seconds]) => [tier, Math.round(plan.pages * seconds)])),
        limits: { maxPages: MINERU.maxPages, maxBytes: MINERU.maxBytes },
        mode: settings.mode, tokenSet: hasMineruToken(settings), acknowledged: !!settings.acknowledgedAt, effectiveBaseUrl: settings.effectiveBaseUrl };
    },
    'mineru.import': async a => {
      lengthLimit(a.title, 200, 'title'); lengthLimit(a.course, 200, 'course');
      if (a.courses !== undefined && (!Array.isArray(a.courses) || a.courses.some(item => typeof item !== 'string'))) throw new Error('courses 必须是字符串数组');
      if (a.route !== undefined && !['local', 'cloud', 'auto'].includes(a.route)) throw new Error('route 只能是 local、cloud 或 auto');
      if (!ports.worker.documents) throw new Error(NO_MATERIALS);
      const settings = await readMineruSettings();
      let route = a.route ?? settings.mode ?? 'local';
      let localInfo = null;
      if (route === 'auto') {
        forget();
        const checked = await localStatus({ fresh: true });
        if (['ready', 'server-stopped'].includes(checked.state)) route = 'local';
        else if (hasMineruToken(settings) && settings.acknowledgedAt) route = 'cloud';
        else route = 'local';
      }
      if (route === 'local') {
        localInfo = await requireLocalReady();
      } else {
        if (!hasMineruToken(settings)) throw Object.assign(new Error(NO_MINERU_TOKEN), { code: 'no-token' });
        if (!settings.acknowledgedAt) throw Object.assign(new Error(NO_MINERU_ACK), { code: 'no-ack' });
      }
      const file = await sourceOf(a);
      const upload = file.upload ? registry().claimUpload(root(), String(a.uploadId)) : null;
      let prepared;
      try {
        const courses = importCourses(a, currentCourse(await ports.state.read()));
        if (route === 'local') {
          const { local, found, busyPeer, stopped, tier } = localInfo;
          prepared = await prepareJob({ root: root(), source: file.path, filename: file.name, title: a.title?.trim() || undefined, courses, language: ports.worker.language, limits: ports.worker.mineru?.limits, route: 'local', tier, sourcePath: sourcePathOf(file) });
          const baseEnv = busyPeer?.env?.kind === 'local'
            ? { ...busyPeer.env, tier }
            : await readLocalEnvironment({ cli: found.cli, home: found.home, status: stopped ? { ...local, tier } : local }).catch(() => ({ kind: 'local', tier }));
          prepared.manifest.env = { ...baseEnv, windows: windowsOfPlan(prepared.manifest.plan) };
          if (stopped) {
            prepared.manifest.autoStart = true;
            if (local.needsRestart || local.unhealthy) prepared.manifest.restartService = true;
          }
          if (a.reviewBeforeImport === true) prepared.manifest.holdForEdit = true;
          await saveManifest(prepared.dir, prepared.manifest).catch(() => {});
          const serviceState = { state: stopped ? 'stopped' : 'running', basis: 'check', at: new Date().toISOString() };
          const started = await service().startConvertJob(ports.worker, { ...prepared, serviceState });
          if (upload) void registry().discardUpload(upload).catch(() => {});
          return started;
        }
        const effectiveBaseUrl = ports.worker.mineru?.baseUrl || settings.effectiveBaseUrl;
        prepared = await prepareJob({ root: root(), source: file.path, filename: file.name, title: a.title?.trim() || undefined, courses, language: ports.worker.language, limits: ports.worker.mineru?.limits, route: 'cloud', sourcePath: sourcePathOf(file), baseUrl: effectiveBaseUrl });
        prepared.manifest.env = cloudEnvironment(prepared.manifest, { baseUrl: effectiveBaseUrl });
        if (a.reviewBeforeImport === true) prepared.manifest.holdForEdit = true;
        await saveManifest(prepared.dir, prepared.manifest).catch(() => {});
        const started = await service().startConvertJob(ports.worker, prepared);
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
