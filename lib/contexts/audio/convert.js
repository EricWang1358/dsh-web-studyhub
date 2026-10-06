import { detectMarker, locateMarker } from '../../marker-local.js';
import { readMarkerSettings, saveMarkerSettings } from '../../marker-settings.js';
import { createMarkerInstaller } from '../../marker-install.js';
import { mineruSetupFor } from './setup/mineru-setup-runs.js';
import { markerInstallerFor } from './install/marker-install-runs.js';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { ownWork } from '../../runtime/work-ownership.js';
import { NO_MINERU_ACK, NO_MINERU_TOKEN, hasMineruToken, publicMineruSettings, readMineruSettings, saveMineruSettings } from '../../mineru-settings.js';
import { MINERU, MineruError, createMineruClient } from '../../mineru-api.js';
import { discardJob, jobDir, listManifests, planFile, prepareJob, readManifest, saveManifest, sweepStale } from '../../mineru-job.js';
import { LOCAL, LOCAL_MESSAGES, LocalMineruError, detectLocal, locateMineru, readLocalEnvironment, startServer } from '../../mineru-local.js';
import { HISTORY, clearRecords, interruptRecords, listRecords, openRecord, removeRecord } from '../../mineru-history.js';
import { importCourses } from '../../source-courses.js';
import { currentCourse } from '../../focus.js';
import { CONVERT_TEXT, NO_MATERIALS, TYPE, adaptiveOf, cloudEnvironment, finishedPages, publicChunks, recordWindows, stageText, windowsOfPlan } from './convert-support.js';
import { announceEnd, newConvertCard, withdrawFailureLetter } from './convert-card.js';
import { retryJob } from './pdf/retry-pdf-convert.js';
import { startPdfConvert } from './pdf/submit-pdf-convert.js';
import { openHistory, runConversion } from './pdf/convert-run.js';

/* (MinerU's files are binary, so the client uses the platform's own fetch, not the text-only long-deadline client the Gemini calls use.)
   Cloud PDF conversion with the learner's own MinerU token: the same background-job model as the audio imports
   (one job in the shared job list, cancel / dismiss / retry, a letter in the inbox when it ends), with its own
   operations, `mineru.*`. The PDF is cut into pieces MinerU accepts, converted one piece at a time, merged, and handed to
   the ordinary document import as a converted document (lib/converted-document.js), so everything after the import is
   what a MinerU file dragged in by hand would have been. Nothing is uploaded until a token is set and the learner has
   confirmed that the document goes to MinerU's cloud. */

export { NO_MATERIALS, stageText };

const gates = new WeakMap();
const gateFor = jobs => { let gate = gates.get(jobs); if (!gate) { gate = { active: 0, tail: Promise.resolve() }; gates.set(jobs, gate); } return gate; };

/** The background side: starting, resuming and recovering conversion jobs. Shares the audio context's job maps. */
export function createConvertWorker(worker, work, jobServices) {
  const { jobs, settled, retryable, generationControllers } = work;
  const { activeJob, pruneJobs } = jobServices;
  const quiet = work => Promise.resolve(work).catch(() => null);
  /** The ids of this library's conversions that are alive right now (the rest of the "running" records are leftovers of a closed app). */
  const liveIds = root => [...jobs.values()].filter(job => job.root === root && job.type === TYPE && activeJob(job)).map(job => job.convertId ?? job.id);

  async function startConvertJob(service, { dir, manifest, serviceState }) {
    const root = service.store.root;
    if ([...jobs.values()].some(job => job.root === root && job.type === TYPE && activeJob(job) && job.fingerprint === manifest.sourceHash))
      throw new Error('这本书已经在转换，请等它完成');
    pruneJobs();
    // runtime.pilot.pdfConvert: the conversion is a Job of the unified runtime (./pdf), else the original background run below.
    if (service.runtimePilot?.pdfConvert === true && service.runtimeJobs) return startPdfConvert(service, { manifest, serviceState });
    const gate = gateFor(jobs), waits = gate.active > 0;
    const job = newConvertCard({ manifest, root, language: service.language, serviceState, queued: waits });
    ownWork(job, service.workOwner);
    jobs.set(job.id, job);
    retryable.set(job.id, { convert: true, filename: job.filename, cleanup: () => discardJob(root, job.id, { sourceHash: manifest.sourceHash, converter: manifest.converter }) });
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
      converter: job.converter, next: CONVERT_TEXT.started({ converter: job.converter, route: job.route }) };
  }

  /** Conversions a restart interrupted come back as failed, retryable jobs; what they finished is still on disk. */
  async function recoverConvertJobs(service, { archived = new Set() } = {}) {
    const root = service.store.root;
    void sweepStale(root).catch(() => {});
    const known = new Set((await quiet(listRecords(root)) || []).map(record => record.id));
    for (const { manifest } of await listManifests(root)) {
      if (jobs.has(manifest.id) || archived.has(manifest.id) || liveIds(root).includes(manifest.id) || [...jobs.values()].some(job => job.convertId === manifest.id)) continue;
      const job = { id: manifest.id, root, type: TYPE, converter: manifest.converter || 'mineru', filename: manifest.filename, status: 'failed', phase: 'interrupted', stage: '上次转换已中断；已完成的部分已保存，点「接着做」继续',
        done: finishedPages(manifest), total: manifest.totalPages, chunk: { index: manifest.chunks.filter(chunk => chunk.state === 'done').length, count: adaptiveOf(manifest) ? 0 : manifest.chunks.length },
        chunks: publicChunks(manifest), warnings: [], note: '', fingerprint: manifest.sourceHash, courses: manifest.courses, retryable: true, ...(adaptiveOf(manifest) ? { local: { adaptive: true } } : {}),
        route: manifest.route || 'cloud', ...(manifest.tier ? { tier: manifest.tier } : {}), ...(manifest.env ? { env: manifest.env } : {}),
        ...(manifest.route === 'local' ? { service: { state: 'unknown', basis: 'none', at: new Date().toISOString() } } : {}),
        startedAt: manifest.createdAt, finishedAt: new Date().toISOString(), language: service.language };
      ownWork(job, service.workOwner);
      jobs.set(job.id, job);
      retryable.set(job.id, { convert: true, filename: job.filename, cleanup: () => discardJob(root, job.id, { sourceHash: manifest.sourceHash, converter: manifest.converter }) });
      // A conversion that began before the history existed still gets its row (as interrupted: nobody knows how far it got).
      if (!known.has(manifest.id)) await quiet(openRecord(root, { id: manifest.id, filename: manifest.filename, bytes: manifest.sourceBytes, pages: manifest.totalPages, pieces: manifest.chunks.length,
        converter: manifest.converter || 'mineru', route: manifest.route || 'cloud', tier: manifest.tier, pagesDone: finishedPages(manifest), title: manifest.title, startedAt: manifest.createdAt,
        env: manifest.env && { ...manifest.env, ...(manifest.env.kind === 'local' ? { windows: windowsOfPlan(manifest.plan) } : {}) }, plan: manifest.plan, windows: recordWindows(publicChunks(manifest)) }));
    }
    await quiet(interruptRecords(root, liveIds(root)));
  }
  return { startConvertJob, recoverConvertJobs, liveIds };
}

/** One history record as the panel draws it: the stored facts, plus what only the live library can say (is it running, can it resume, does the document still exist). */
function describeRecord(record, { key, jobs, retryable, activeJob, live, state }) {
  const job = jobs.get(record.id) ?? [...jobs.values()].find(item => item.type === TYPE && item.convertId === record.id), mine = !!job && job.root === key && job.type === TYPE;
  const retryAble = !!retryable.get(record.id)?.convert || job?.contract?.actions.retry.available === true;
  const canRetry = ['failed', 'interrupted'].includes(record.status) && mine && !live.has(record.id) && retryAble
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

/** The `mineru.*` operations. Close over the audio context's ports; nothing is read or sent until an operation runs. */
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

  const historyOps = {
    /** The conversion history of this library, newest first: every cloud and local conversion, running or ended, with what can be done next. */
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

  const seamLocal = () => ports.worker.mineru?.local || {};
  // A test or preview can stand in for the CLI (or for "not installed" with null); otherwise it is looked for on this computer.
  // The local MinerU setup (lib/mineru-setup.js): a background run per library, or a Job when runtime.pilot.mineruSetup is on.
  const setup = mineruSetupFor(ports, () => ({ cli: cliOf(), home: homeOf(), modelsCli: seamLocal().modelsCli }));
  const cliOf = () => ('cli' in seamLocal() ? seamLocal().cli : locateMineru());
  const homeOf = () => seamLocal().home;
  const extras = async () => ({ estimates: { ...LOCAL.secondsPerPage }, modelsMbByTier: { ...LOCAL.modelsMb }, windowPages: LOCAL.windowPages, setup: await setup.status() });
  const localStatus = async () => {
    try { return { ...await detectLocal({ cli: cliOf(), home: homeOf() }), ...await extras() }; }
    catch (error) { if (error instanceof LocalMineruError && error.code === 'not-installed') return { state: 'not-installed', next: 'install', ...await extras() }; throw error; }
  };

  const markerCli = async () => ports.worker.marker?.local && 'cli' in ports.worker.marker.local ? ports.worker.marker.local.cli : locateMarker(await readMarkerSettings());
  const markerStatus = async () => detectMarker({ cli: await markerCli() });
  // One-click Marker setup (lib/marker-install.js): a private Python environment, only when the learner asks; progress is polled like the MinerU setup.
  const installer = markerInstallerFor(ports, createMarkerInstaller(ports.worker.marker?.install || {}));

  return {
    ...historyOps,
    'marker.settings.get': () => readMarkerSettings(),
    'marker.settings.set': a => saveMarkerSettings(a),
    'marker.local.status': () => markerStatus(),
    'marker.install.plan': a => installer.plan(a),
    'marker.install.start': a => installer.start(a),
    'marker.install.status': () => installer.status(),
    'marker.install.cancel': () => installer.cancel(),
    'marker.install.uninstall': a => installer.uninstall(a),
    'marker.import': async a => {
      lengthLimit(a.title, 200, 'title'); lengthLimit(a.course, 200, 'course');
      if (a.courses !== undefined && (!Array.isArray(a.courses) || a.courses.some(item => typeof item !== 'string'))) throw new Error('courses 必须是字符串数组');
      if (!ports.worker.documents) throw new Error(NO_MATERIALS);
      const status = await markerStatus();
      if (status.state !== 'ready') throw new Error(status.message || '请先在设置中配置 Marker');
      const file = await sourceOf(a);
      const upload = file.upload ? registry().claimUpload(root(), String(a.uploadId)) : null;
      let prepared;
      try {
        prepared = await prepareJob({ root: root(), source: file.path, filename: file.name, title: a.title?.trim() || undefined, courses: importCourses(a, currentCourse(await ports.state.read())), language: ports.worker.language, limits: ports.worker.marker?.limits, route: 'local', converter: 'marker' });
        prepared.manifest.env = { kind: 'local', windows: windowsOfPlan(prepared.manifest.plan) };
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
    'mineru.settings.get': async () => publicMineruSettings(await readMineruSettings()),
    'mineru.settings.set': async (a = {}) => {
      const patch = {};
      if (a.token !== undefined) patch.token = a.token;
      if (a.acknowledge !== undefined) patch.acknowledge = a.acknowledge;
      return publicMineruSettings(await saveMineruSettings(patch));
    },
    /** One harmless authenticated request: the token is valid, invalid, expired, or MinerU cannot be reached. Nothing is uploaded. */
    'mineru.test': async () => {
      const settings = await readMineruSettings();
      if (!hasMineruToken(settings)) return { ok: false, state: 'missing', configured: false, message: '未配置' };
      try {
        const seam = ports.worker.mineru || {};
        await createMineruClient({ token: settings.token, ...(seam.baseUrl ? { baseUrl: seam.baseUrl } : {}) }).check();
        return { ok: true, state: 'valid', configured: true, message: '令牌有效，MinerU 连得上' };
      } catch (error) {
        if (!(error instanceof MineruError)) throw error;
        const state = error.code === 'invalid-token' ? 'invalid' : error.code === 'expired' ? 'expired' : error.code === 'network' ? 'unreachable' : 'unavailable';
        return { ok: false, state, configured: true, message: error.message };
      }
    },
    /** The local mineru, from read-only calls: not installed, needs models, service stopped, or ready; with the next step and measured speed estimates. */
    'mineru.local.status': async () => localStatus(),
    /** Start (or restart) the local service: an explicit step the learner asked for. */
    'mineru.local.start': async a => ({ ...await startServer({ cli: cliOf(), home: homeOf(), restart: a?.restart === true }), ...await extras() }),
    /** Download the models of a tier and switch the local mode on: only after `confirm: true`, in the background, polled by mineru.local.setup.status. */
    'mineru.local.setup': a => setup.start(a),
    'mineru.local.setup.status': () => setup.status(),
    'mineru.local.setup.cancel': () => setup.cancel(),
    'mineru.upload.start': a => registry().startUpload(root(), { name: a.name, size: a.size, kind: 'pdf' }),
    'mineru.upload.chunk': a => registry().appendUpload(root(), { uploadId: a.uploadId, offset: a.offset, data: a.data }),
    'mineru.upload.finish': a => registry().finishUpload(root(), a.uploadId),
    'mineru.upload.cancel': a => registry().cancelUpload(root(), String(a.uploadId)),
    /** What would happen to this PDF: pages, the pieces, and what is still missing. Reads the file locally; sends nothing. */
    'mineru.plan': async a => {
      const file = await sourceOf(a);
      const [plan, settings] = [await planFile({ source: file.path, limits: ports.worker.mineru?.limits }), await readMineruSettings()];
      return { name: file.name, pages: plan.pages, bytes: plan.bytes, pieces: plan.plan.map(piece => ({ index: piece.index + 1, startPage: piece.startPage, endPage: piece.endPage, pages: piece.pages, estimatedBytes: piece.estimatedBytes, cut: piece.cut })),
        maySplitFurther: plan.maySplitFurther, byChapters: plan.plan.length > 1 && plan.plan.every(piece => piece.cut === 'chapter' || piece.cut === 'whole'),
        windows: plan.windows.map(piece => ({ index: piece.index + 1, startPage: piece.startPage, endPage: piece.endPage, pages: piece.pages })),
        ...(plan.adaptive ? { adaptive: { firstPages: plan.adaptive.firstPages, rampPages: plan.adaptive.rampPages, targetSeconds: plan.adaptive.targetSeconds, minPages: plan.adaptive.minPages, maxPages: plan.adaptive.maxPages } } : {}),
        localEstimateSeconds: Object.fromEntries(Object.entries(LOCAL.secondsPerPage).map(([tier, seconds]) => [tier, Math.round(plan.pages * seconds)])),
        limits: { maxPages: MINERU.maxPages, maxBytes: MINERU.maxBytes }, tokenSet: hasMineruToken(settings), acknowledged: !!settings.acknowledgedAt };
    },
    'mineru.import': async a => {
      lengthLimit(a.title, 200, 'title'); lengthLimit(a.course, 200, 'course');
      if (a.courses !== undefined && (!Array.isArray(a.courses) || a.courses.some(item => typeof item !== 'string'))) throw new Error('courses 必须是字符串数组');
      if (a.route !== undefined && !['cloud', 'local', 'auto'].includes(a.route)) throw new Error('route 只能是 cloud、local 或 auto');
      if (!ports.worker.documents) throw new Error(NO_MATERIALS);
      // The route is decided before anything is read or sent: local when asked (and ready), or "auto": local when ready, otherwise cloud.
      let route = a.route ?? 'cloud', tier, localState;
      if (route !== 'cloud') {
        const local = await localStatus();
        if (route === 'auto') route = local.state === 'ready' ? 'local' : 'cloud';
        if (route === 'local') {
          if (local.state !== 'ready') throw new LocalMineruError(local.state, { 'not-installed': LOCAL_MESSAGES.notInstalled, 'server-stopped': LOCAL_MESSAGES.serverStopped, unknown: LOCAL_MESSAGES.unreadable }[local.state] ?? LOCAL_MESSAGES.setupNeedsModels, { retryable: true });
          tier = local.tier; localState = local;
        }
      }
      if (route === 'cloud') {
        const settings = await readMineruSettings();
        if (!hasMineruToken(settings)) throw new Error(NO_MINERU_TOKEN);
        if (!settings.acknowledgedAt) throw new Error(NO_MINERU_ACK);
      }
      const file = await sourceOf(a);
      const upload = file.upload ? registry().claimUpload(root(), String(a.uploadId)) : null;
      let prepared;
      try {
        const courses = importCourses(a, currentCourse(await ports.state.read()));
        prepared = await prepareJob({ root: root(), source: file.path, filename: file.name, title: a.title?.trim() || undefined, courses, language: ports.worker.language, limits: ports.worker.mineru?.limits, route, tier });
        // What will do the work, captured now (read-only) and kept with the job and its history record: the model, the tier, the service, the limits.
        prepared.manifest.env = route === 'local'
          ? { ...await readLocalEnvironment({ cli: cliOf(), home: homeOf(), status: localState }).catch(() => ({ kind: 'local', tier })), windows: windowsOfPlan(prepared.manifest.plan) }
          : cloudEnvironment(prepared.manifest);
        await saveManifest(prepared.dir, prepared.manifest).catch(() => {});
        const started = await service().startConvertJob(ports.worker, { ...prepared, ...(route === 'local' ? { serviceState: { state: 'running', basis: 'check', at: new Date().toISOString() } } : {}) });
        if (upload) void registry().discardUpload(upload).catch(() => {});
        return started;
      } catch (error) {
        if (prepared) await discardJob(root(), prepared.manifest.id, { keepResults: true, sourceHash: prepared.manifest.sourceHash, converter: prepared.manifest.converter }).catch(() => {});
        if (upload) registry().releaseUpload(upload);
        throw error;
      }
    },
    'mineru.retry': async a => {
      const { jobs, retryable } = ports.work;
      // A conversion that is a Job is retried by the Job (the same action the console has): it continues from its manifest.
      const running = await retryJob(ports, String(a.jobId));
      if (running) return running;
      const old = jobs.get(String(a.jobId)), entry = retryable.get(String(a.jobId));
      if (!old || old.root !== root() || old.type !== TYPE || !entry?.convert) throw new Error('这个任务不能重试：它已经完成，或已被清除');
      if (ports.jobServices.activeJob(old)) throw new Error('任务还在进行，请等它结束');
      let manifest;
      try { manifest = await readManifest(jobDir(root(), old.id)); }
      catch { throw new Error('这个任务的临时文件已被清理，没法接着做；请重新导入这份 PDF（已解析好的段落会被复用）'); }
      jobs.delete(old.id); retryable.delete(old.id);
      let started;
      // A local run asks the service once more, read-only, before anything starts; that answer is the evidence until a window finishes.
      let serviceState;
      if (manifest.route === 'local' && manifest.converter !== 'marker') {
        const checked = await localStatus().catch(() => null), at = new Date().toISOString();
        serviceState = { state: !checked ? 'unknown' : ['ready', 'needs-models'].includes(checked.state) ? 'running' : checked.state === 'server-stopped' ? 'stopped' : 'unknown', basis: 'check', at };
      }
      try { started = await service().startConvertJob(ports.worker, { dir: jobDir(root(), old.id), manifest, ...(serviceState ? { serviceState } : {}) }); }
      catch (error) { jobs.set(old.id, old); retryable.set(old.id, entry); throw error; }
      // The letter about the failure is superseded by the retry; if that fails too, it brings its own.
      await withdrawFailureLetter(ports, old.id);
      return started;
    },
  };
}
