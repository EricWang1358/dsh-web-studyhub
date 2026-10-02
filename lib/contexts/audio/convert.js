import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownWork } from '../../runtime/work-ownership.js';
import { NO_MINERU_ACK, NO_MINERU_TOKEN, hasMineruToken, publicMineruSettings, readMineruSettings, saveMineruSettings } from '../../mineru-settings.js';
import { MINERU, MineruError, createMineruClient } from '../../mineru-api.js';
import { convertPdf, discardJob, jobDir, listManifests, planFile, prepareJob, readManifest, saveManifest, sweepStale } from '../../mineru-job.js';
import { PdfChunkError } from '../../pdf-chunker.js';
import { LOCAL, LOCAL_MESSAGES, LocalMineruError, detectLocal, locateMineru, readLocalEnvironment, runCli, startServer } from '../../mineru-local.js';
import { MineruResultError } from '../../mineru-merge.js';
import { HISTORY, clearRecords, closeRecord, interruptRecords, listRecords, openRecord, plainReason, removeRecord, updateRecord } from '../../mineru-history.js';
import { importCourses } from '../../source-courses.js';
import { currentCourse } from '../../focus.js';
import { notify } from '../../inbox.js';

/* (MinerU's files are binary, so the client uses the platform's own fetch, not the text-only long-deadline client the Gemini calls use.)
   Cloud PDF conversion with the learner's own MinerU token: the same background-job model as the audio imports
   (one job in the shared job list, cancel / dismiss / retry, a letter in the inbox when it ends), with its own
   operations, `mineru.*`. The PDF is cut into pieces MinerU accepts, converted one piece at a time, merged, and handed to
   the ordinary document import as a converted document (lib/converted-document.js), so everything after the import is
   what a MinerU file dragged in by hand would have been. Nothing is uploaded until a token is set and the learner has
   confirmed that the document goes to MinerU's cloud. */

export const NO_MATERIALS = '资料组件没有启用，转换结果没地方保存。请先启用资料组件再用云端解析。';
const TYPE = 'pdf-convert';

const finishedPages = manifest => manifest.chunks.reduce((sum, chunk) => sum + (chunk.state === 'done' ? chunk.pages : 0), 0);
const publicChunks = manifest => manifest.chunks.map(chunk => ({ index: chunk.index + 1, startPage: chunk.startPage, endPage: chunk.endPage, pages: chunk.pages, state: chunk.state }));

/** What runs a cloud conversion: MinerU's model version and language (the settings the API is called with), the limits a piece is cut to, the size of the book. The token is never part of it. */
const cloudEnvironment = manifest => ({ kind: 'cloud', modelVersion: MINERU.modelVersion, language: MINERU.language, maxPages: manifest.plan?.maxPages ?? manifest.limits?.maxPages,
  maxBytes: manifest.plan?.maxBytes ?? manifest.limits?.maxBytes, bookBytes: manifest.sourceBytes });
/** The window size of a local run, read from the plan the manifest carries (where a different plan changes it). */
const windowsOfPlan = plan => (plan?.kind === 'fixed' ? { kind: 'fixed', pages: plan.windowPages } : undefined);

/** The pieces of the book as the history keeps them: pages and state (the one that failed, the one running, the rest). `current` is the 1-based piece being worked on. */
function recordWindows(chunks = [], { current = 0, finished = false } = {}) {
  return chunks.map(chunk => ({ start: chunk.startPage, end: chunk.endPage, pages: chunk.pages,
    state: chunk.state === 'done' || (finished && chunk.state === 'done') ? 'done' : chunk.error ? 'failed' : chunk.index === current && !finished ? 'running' : 'planned' }));
}

/** The plain-language stage of a phase, e.g. "第 2/3 段 · 正在解析". */
export function stageText(phase, { index = 0, count = 1 } = {}) {
  const piece = count > 1 && index > 0 ? `第 ${index}/${count} 段 · ` : '';
  switch (phase) {
    case 'split': return '正在切分 PDF';
    case 'upload': return `${piece}正在上传`;
    case 'parse': return `${piece}正在解析`;
    case 'local': return `${piece}正在本地解析`;
    case 'download': return `${piece}正在下载结果`;
    case 'merge': return '正在合并各段结果';
    case 'save': return '正在保存为资料';
    case 'queued': return '排队中';
    default: return '正在处理';
  }
}

const gates = new WeakMap();
const gateFor = jobs => { let gate = gates.get(jobs); if (!gate) { gate = { active: 0, tail: Promise.resolve() }; gates.set(jobs, gate); } return gate; };

/** The background side: starting, resuming and recovering conversion jobs. Shares the audio context's job maps. */
export function createConvertWorker(worker, work, jobServices) {
  const { jobs, settled, retryable, generationControllers } = work;
  const { activeJob, pruneJobs } = jobServices;
  const quiet = work => Promise.resolve(work).catch(() => null);
  /** The ids of this library's conversions that are alive right now (the rest of the "running" records are leftovers of a closed app). */
  const liveIds = root => [...jobs.values()].filter(job => job.root === root && job.type === TYPE && activeJob(job)).map(job => job.id);

  async function startConvertJob(service, { dir, manifest, serviceState }) {
    const root = service.store.root;
    if ([...jobs.values()].some(job => job.root === root && job.type === TYPE && activeJob(job) && job.fingerprint === manifest.sourceHash))
      throw new Error('这本书已经在转换，请等它完成');
    pruneJobs();
    const gate = gateFor(jobs), waits = gate.active > 0;
    const local = manifest.route === 'local', now0 = new Date().toISOString();
    const job = { id: manifest.id, root, type: TYPE, route: manifest.route || 'cloud', ...(manifest.tier ? { tier: manifest.tier } : {}), filename: manifest.filename, status: waits ? 'queued' : 'running',
      ...(manifest.env ? { env: manifest.env } : {}), ...(local ? { service: serviceState || { state: 'unknown', basis: 'none', at: now0 } } : {}),
      stage: stageText(waits ? 'queued' : 'split'), phase: waits ? 'queued' : 'split', done: finishedPages(manifest), total: manifest.totalPages,
      chunk: { index: 0, count: manifest.chunks.length }, chunks: publicChunks(manifest), warnings: [], note: '', fingerprint: manifest.sourceHash,
      courses: manifest.courses, startedAt: new Date().toISOString(), language: service.language };
    ownWork(job, service.workOwner);
    jobs.set(job.id, job);
    retryable.set(job.id, { convert: true, filename: job.filename, cleanup: () => discardJob(root, job.id, { sourceHash: manifest.sourceHash }) });
    const controller = new AbortController();
    generationControllers.set(job.id, controller);
    const signal = controller.signal;

    /* The conversion history (lib/mineru-history.js): a durable record opened now and kept up to date. It is best effort: a record that
       cannot be written never stops or fails the conversion. Writes are queued per library, so the end always lands after the progress. */
    const clock = () => (service.mineru?.clock ?? Date.now)();
    const opened = quiet(openRecord(root, { id: job.id, filename: job.filename, bytes: manifest.sourceBytes, pages: manifest.totalPages, pieces: manifest.chunks.length, route: job.route,
      tier: job.tier, pagesDone: job.done, phase: job.phase, title: manifest.title,
      env: manifest.env && { ...manifest.env, ...(manifest.env.kind === 'local' ? { windows: windowsOfPlan(manifest.plan) } : {}) }, plan: manifest.plan, windows: recordWindows(publicChunks(manifest)) }, { now: clock }));
    let seen = '', secret = '', reached = false;

    const onProgress = patch => {
      const { phase, done, total, chunk, chunks, note } = patch;
      Object.assign(job, { phase, done, total, chunk, chunks, note: note || '' });
      job.stage = stageText(phase, chunk);
      if (patch.service) job.service = patch.service;
      const key = `${phase}|${chunk?.index || 0}|${done}`;
      if (key !== seen) { seen = key; void quiet(updateRecord(root, job.id, { phase, piece: chunk?.index || undefined, pagesDone: done, windows: recordWindows(chunks, { current: chunk?.index }) }, { now: clock })); }
    };
    const importMerged = async ({ bytes, filename, title, courses }) => {
      if (!service.documents) throw new Error(NO_MATERIALS);
      return service.documents.import({ dataBase64: bytes.toString('base64'), filename, format: 'json', ...(title ? { title } : {}), ...(courses ? { courses } : {}) });
    };
    const letter = kind => service.store.update(s => {
      for (const item of s.inbox || []) if (item.jobId === job.id) item.sourceIds = job.sourceIds || [];
      notify(s, { kind, jobId: job.id, filename: job.filename, sourceIds: job.sourceIds,
        detail: job.status === 'failed' && job.retryable ? `${job.stage.length > 90 ? `${job.stage.slice(0, 89)}…` : job.stage} 已完成的部分已保存，可在资料页点「接着做」` : job.stage });
    });

    let importedTitle;
    const run = async () => {
      gate.active++;
      try {
        await opened;
        if (signal.aborted) throw signal.reason ?? new Error('aborted');
        job.status = 'running'; job.phase = 'split'; job.stage = stageText('split'); job.startedAt = new Date().toISOString();
        const seam = service.mineru || {};
        let client, local;
        if (manifest.route === 'local') {
          // Free and offline: no token, nothing uploaded. The CLI is looked for again now, in case it moved since the job was made.
          local = { cli: seam.local && 'cli' in seam.local ? seam.local.cli : locateMineru(), timeoutMs: seam.local?.timeoutMs };
        } else {
          const settings = await readMineruSettings();
          if (!hasMineruToken(settings)) throw new Error(NO_MINERU_TOKEN);
          secret = settings.token;
          client = createMineruClient({ token: settings.token, ...(seam.baseUrl ? { baseUrl: seam.baseUrl } : {}) });
        }
        reached = true;
        const outcome = await convertPdf({ dir, manifest, root, client, local, signal, onProgress, importMerged, sleep: seam.sleep, now: seam.now, limits: seam.limits });
        const imported = outcome.imported || {};
        importedTitle = imported.document?.title;
        Object.assign(job, { status: 'complete', phase: 'done', done: job.total, note: '', sourceIds: imported.sourceIds || [], documentId: imported.documentId,
          skippedPages: imported.skippedPages || [], stage: `已存为 ${imported.sourceIds?.length ?? 0} 页资料` });
        for (const text of [...(imported.warnings || []), ...(outcome.notes || [])]) if (!job.warnings.includes(text)) job.warnings.push(text);
        retryable.delete(job.id);
        try { await discardJob(root, job.id, { sourceHash: manifest.sourceHash }); } catch { job.warnings.push('临时文件没能全部清理；它们在 DSH 主目录里，之后会自动清除。'); }
      } catch (error) {
        const cancelled = signal.aborted && !!job.cancelRequestedAt;
        job.note = '';
        if (error instanceof LocalMineruError && error.code === 'server-stopped') job.service = { state: 'stopped', basis: 'window', at: new Date().toISOString() };
        if (cancelled) {
          Object.assign(job, { status: 'cancelled', retryable: false, stage: '已取消；已解析好的段落会保留，再导入同一个文件不会重复解析' });
          retryable.delete(job.id);
          await discardJob(root, job.id, { keepResults: true, sourceHash: manifest.sourceHash }).catch(() => {});
        } else {
          const permanent = error instanceof PdfChunkError;
          Object.assign(job, { status: 'failed', retryable: !permanent, stage: String(error?.message || error).slice(0, 400) });
          if (error instanceof MineruError || error instanceof MineruResultError || error instanceof LocalMineruError) job.errorCode = error.code;
          if (permanent) { retryable.delete(job.id); await discardJob(root, job.id, { keepResults: true, sourceHash: manifest.sourceHash }).catch(() => {}); }
        }
      } finally {
        gate.active--;
        generationControllers.delete(job.id);
        job.finishedAt = new Date().toISOString();
        // What happened, for the history: complete only when the document was really imported; the stage is where it stopped.
        const shutdown = job.status === 'failed' && signal.aborted && !job.cancelRequestedAt;
        await quiet(closeRecord(root, job.id, job.status === 'complete'
          ? { status: 'complete', documentId: job.documentId, title: importedTitle, importedPages: job.sourceIds?.length ?? 0, skippedPages: job.skippedPages?.length ?? 0, pagesDone: job.total, pieces: job.chunks?.length, windows: recordWindows(job.chunks, { finished: true }) }
          : job.status === 'cancelled' ? { status: 'cancelled', pagesDone: job.done, pieces: job.chunks?.length, windows: recordWindows(job.chunks) }
            : shutdown ? { status: 'interrupted', pagesDone: job.done }
              : { status: 'failed', pagesDone: job.done, pieces: job.chunks?.length, windows: recordWindows(job.chunks), failure: { stage: reached ? job.phase : 'start', piece: job.chunk?.index || undefined,
                reason: plainReason(job.stage, { secrets: [secret] }), code: job.errorCode } }, { now: clock }));
        // A conversion the learner stopped themselves needs no letter and no notice.
        if (job.status !== 'cancelled') {
          try { await letter(job.status === 'complete' ? 'pdf-result' : 'pdf-failed'); }
          catch { job.warnings.push('信箱通知未能保存，请在资料页查看任务结果。'); }
          service.announceJob?.(job);
        }
      }
    };
    const done = gate.tail.catch(() => {}).then(run);
    gate.tail = done;
    settled.set(job.id, done);
    void done.finally(() => { settled.delete(job.id); });
    await opened;
    return { jobId: job.id, status: job.status, queuedBehind: waits ? 1 : 0, pages: manifest.totalPages, chunks: manifest.chunks.map(chunk => ({ index: chunk.index + 1, startPage: chunk.startPage, endPage: chunk.endPage, pages: chunk.pages })),
      next: 'PDF 在后台逐段上传到 MinerU 解析，几分钟到几十分钟；告诉学习者已开始，进度在资料页。不要轮询或重复提交；完成后是一份可按页引用的资料，不会自动出题。' };
  }

  /** Conversions a restart interrupted come back as failed, retryable jobs; what they finished is still on disk. */
  async function recoverConvertJobs(service) {
    const root = service.store.root;
    void sweepStale(root).catch(() => {});
    const known = new Set((await quiet(listRecords(root)) || []).map(record => record.id));
    for (const { manifest } of await listManifests(root)) {
      if (jobs.has(manifest.id)) continue;
      const job = { id: manifest.id, root, type: TYPE, filename: manifest.filename, status: 'failed', phase: 'interrupted', stage: '上次转换已中断；已完成的部分已保存，点「接着做」继续',
        done: finishedPages(manifest), total: manifest.totalPages, chunk: { index: manifest.chunks.filter(chunk => chunk.state === 'done').length, count: manifest.chunks.length },
        chunks: publicChunks(manifest), warnings: [], note: '', fingerprint: manifest.sourceHash, courses: manifest.courses, retryable: true,
        route: manifest.route || 'cloud', ...(manifest.tier ? { tier: manifest.tier } : {}), ...(manifest.env ? { env: manifest.env } : {}),
        ...(manifest.route === 'local' ? { service: { state: 'unknown', basis: 'none', at: new Date().toISOString() } } : {}),
        startedAt: manifest.createdAt, finishedAt: new Date().toISOString(), language: service.language };
      ownWork(job, service.workOwner);
      jobs.set(job.id, job);
      retryable.set(job.id, { convert: true, filename: job.filename, cleanup: () => discardJob(root, job.id, { sourceHash: manifest.sourceHash }) });
      // A conversion that began before the history existed still gets its row (as interrupted: nobody knows how far it got).
      if (!known.has(manifest.id)) await quiet(openRecord(root, { id: manifest.id, filename: manifest.filename, bytes: manifest.sourceBytes, pages: manifest.totalPages, pieces: manifest.chunks.length,
        route: manifest.route || 'cloud', tier: manifest.tier, pagesDone: finishedPages(manifest), title: manifest.title, startedAt: manifest.createdAt,
        env: manifest.env && { ...manifest.env, ...(manifest.env.kind === 'local' ? { windows: windowsOfPlan(manifest.plan) } : {}) }, plan: manifest.plan, windows: recordWindows(publicChunks(manifest)) }));
    }
    await quiet(interruptRecords(root, liveIds(root)));
  }
  return { startConvertJob, recoverConvertJobs, liveIds };
}

/** One history record as the panel draws it: the stored facts, plus what only the live library can say (is it running, can it resume, does the document still exist). */
function describeRecord(record, { key, jobs, retryable, activeJob, live, state }) {
  const job = jobs.get(record.id), mine = !!job && job.root === key && job.type === TYPE;
  const canRetry = ['failed', 'interrupted'].includes(record.status) && mine && !live.has(record.id) && !!retryable.get(record.id)?.convert
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

/* Setting up the local mineru (model download, switching it on) is a background run per library, polled by the panel (like the
   search index build). It only ever starts after the learner confirmed the download, and says what it is doing in plain words. */
const setups = new Map();
const publicSetup = run => (run ? Object.fromEntries(Object.entries(run).filter(([key]) => !['controller', 'promise'].includes(key))) : { status: 'idle' });
const downloaderOf = cli => {
  const name = process.platform === 'win32' ? 'mineru-models-download.exe' : 'mineru-models-download';
  const file = cli?.file ? join(dirname(cli.file), name) : '';
  return file && existsSync(file) ? { file, prefix: [], env: cli.env || {} } : null;
};
const SPACES = new RegExp(String.fromCharCode(92) + 's+', 'g');
const tidy = text => String(text).replace(SPACES, ' ').trim().slice(0, 240);

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
  const cliOf = () => ('cli' in seamLocal() ? seamLocal().cli : locateMineru());
  const homeOf = () => seamLocal().home;
  const extras = () => ({ estimates: { ...LOCAL.secondsPerPage }, modelsMbByTier: { ...LOCAL.modelsMb }, windowPages: LOCAL.windowPages, setup: publicSetup(setups.get(root())) });
  const localStatus = async () => {
    try { return { ...await detectLocal({ cli: cliOf(), home: homeOf() }), ...extras() }; }
    catch (error) { if (error instanceof LocalMineruError && error.code === 'not-installed') return { state: 'not-installed', next: 'install', ...extras() }; throw error; }
  };

  return {
    ...historyOps,
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
    'mineru.local.start': async a => ({ ...await startServer({ cli: cliOf(), home: homeOf(), restart: a?.restart === true }), ...extras() }),
    /** Download the models of a tier and switch the local mode on: only after `confirm: true`, in the background, polled by mineru.local.setup.status. */
    'mineru.local.setup': async a => {
      const tier = a?.tier ?? 'basic';
      if (!['basic', 'standard'].includes(tier)) throw new LocalMineruError('bad-tier', LOCAL_MESSAGES.badTier);
      if (a?.confirm !== true) throw new Error(`下载本地模型前需要先确认：约 ${LOCAL.modelsMb[tier]} MB，会占用网络和磁盘。`);
      const key = root(), current = setups.get(key);
      if (current?.status === 'running') throw new LocalMineruError('setup-busy', LOCAL_MESSAGES.setupBusy);
      const cli = cliOf();
      if (!cli) throw new LocalMineruError('not-installed', LOCAL_MESSAGES.notInstalled);
      let before = await detectLocal({ cli, home: homeOf() });
      // The CLI answers `config` only through its running service, so a stopped one is started first (the learner just confirmed the setup).
      const mustStart = before.state === 'server-stopped';
      const downloaderFor = () => ((before.modelsDownloaded && before.tier === tier) ? null : (seamLocal().modelsCli ?? downloaderOf(cli)));
      if (!mustStart && !downloaderFor() && !(before.modelsDownloaded && before.tier === tier)) throw new LocalMineruError('no-downloader', LOCAL_MESSAGES.noDownloader);
      const run = { id: randomUUID(), status: 'running', tier, step: mustStart ? 'start' : downloaderFor() ? 'download' : 'configure', startedAt: new Date().toISOString(), lastLine: '', modelsMb: LOCAL.modelsMb[tier], controller: new AbortController() };
      setups.set(key, run);
      run.promise = (async () => {
        try {
          const signal = run.controller.signal;
          const step = async (name, program, args, timeoutMs = 60_000) => {
            run.step = name;
            const result = await runCli(program, args, { signal, timeoutMs, onLine: line => { run.lastLine = line.slice(0, 160); } });
            if (result.code !== 0) throw new Error(`${name === 'download' ? '模型没能下载' : name === 'start' ? '本地服务没能启动' : '本地设置没能完成'}：${tidy(result.stderr || result.stdout) || '没有返回原因'}`);
          };
          if (mustStart) {
            await step('start', cli, ['server', 'start'], 90_000);
            before = await detectLocal({ cli, home: homeOf(), signal });
            if (before.state !== 'ready' && before.state !== 'needs-models') throw new Error(before.state === 'unknown' ? LOCAL_MESSAGES.unreadable : LOCAL_MESSAGES.serverStopped);
          }
          const downloader = downloaderFor();
          if (!downloader && !(before.modelsDownloaded && before.tier === tier)) throw new LocalMineruError('no-downloader', LOCAL_MESSAGES.noDownloader);
          if (downloader) await step('download', downloader, ['--tier', tier], 90 * 60_000);
          await step('configure', cli, ['config', 'set', 'parse_server.local.managed_tier', tier]);
          await step('configure', cli, ['config', 'set', 'parse_server.local.mode', 'managed']);
          await step('start', cli, ['server', 'restart'], 90_000);
          run.state = await detectLocal({ cli, home: homeOf(), signal });
          Object.assign(run, { status: 'complete', step: 'done' });
        } catch (error) {
          if (run.controller.signal.aborted) Object.assign(run, { status: 'cancelled', step: 'cancelled' });
          else Object.assign(run, { status: 'failed', error: String(error?.message || error).slice(0, 400) });
        } finally { run.finishedAt = new Date().toISOString(); }
      })();
      return publicSetup(run);
    },
    'mineru.local.setup.status': async () => publicSetup(setups.get(root())),
    'mineru.local.setup.cancel': async () => {
      const run = setups.get(root());
      if (run?.status === 'running') run.controller.abort(new Error('cancelled'));
      return publicSetup(run);
    },
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
        if (prepared) await discardJob(root(), prepared.manifest.id, { keepResults: true, sourceHash: prepared.manifest.sourceHash }).catch(() => {});
        if (upload) registry().releaseUpload(upload);
        throw error;
      }
    },
    'mineru.retry': async a => {
      const { jobs, retryable } = ports.work;
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
      if (manifest.route === 'local') {
        const checked = await localStatus().catch(() => null), at = new Date().toISOString();
        serviceState = { state: !checked ? 'unknown' : ['ready', 'needs-models'].includes(checked.state) ? 'running' : checked.state === 'server-stopped' ? 'stopped' : 'unknown', basis: 'check', at };
      }
      try { started = await service().startConvertJob(ports.worker, { dir: jobDir(root(), old.id), manifest, ...(serviceState ? { serviceState } : {}) }); }
      catch (error) { jobs.set(old.id, old); retryable.set(old.id, entry); throw error; }
      // The letter about the failure is superseded by the retry; if that fails too, it brings its own.
      await ports.state.update(s => { if (Array.isArray(s.inbox)) s.inbox = s.inbox.filter(item => !(item.kind === 'pdf-failed' && item.jobId === old.id)); });
      return started;
    },
  };
}
