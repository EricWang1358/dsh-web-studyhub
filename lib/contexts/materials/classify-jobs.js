// @ts-check
import { id } from '../../util.js';
import { lightModelOf } from '../../job-model.js';
import { compactEstimate } from '../../token-estimate.js';
import { normalizeGenerationSettings } from '../../generation-settings.js';
import { ownWork } from '../../runtime/work-ownership.js';
import { withJobUsage } from '../../usage-scope.js';
import { readMaterialFolders } from './material-folders.js';
import {
  FOLDER_SUGGEST_BATCH,
  estimateMaterialClassify,
  selectTargetMaterials,
  suggestMaterialFolders,
} from './folder-suggest.js';
import {
  MAX_ORGANIZE_SOURCES,
  prepareCourseSuggestSources,
  suggestSourceCourses,
} from './course-suggest.js';

export const MATERIAL_CLASSIFY_TYPE = 'material-classify';
export const MATERIAL_ORGANIZE_TYPE = 'material-organize';
const STEP_KEEP_LIMIT = 240;

const iso = () => new Date().toISOString();

/**
 * Normalize optional `course` filter for job / pending proposal metadata (`''` means all courses / unassigned scope).
 * @param {unknown} rawCourse
 * @returns {string}
 */
function normalizeCourseScope(rawCourse) {
  if (typeof rawCourse !== 'string') return '';
  const trimmed = rawCourse.trim();
  if (!trimmed || trimmed === '*') return '';
  return trimmed;
}

/**
 * Deterministic digest of an optional list of material keys / source IDs for job deduplication.
 * @param {unknown} values
 * @returns {string}
 */
function hashKeys(values) {
  if (!Array.isArray(values) || !values.length) return '';
  const text = JSON.stringify([...new Set(values.map(v => String(v)))].sort());
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (ch + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Pick the most recently created entry from a per-course pending map, or null when empty.
 * @param {Record<string, any>} byCourse
 * @returns {Record<string, any> | null}
 */
function latestPendingEntry(byCourse) {
  /** @type {Record<string, any> | null} */
  let best = null;
  for (const value of Object.values(byCourse)) {
    if (!value || typeof value !== 'object') continue;
    if (!best || String(value.createdAt || '') >= String(best.createdAt || '')) best = value;
  }
  return best;
}

/**
 * Resolve per-call timeout budget from generation settings (`0` = unlimited per #1179).
 * @param {Record<string, any> | null | undefined} state
 * @returns {number}
 */
function stepTimeoutMsOf(state) {
  /** @type {Record<string, any>} */
  const gen = normalizeGenerationSettings(state?.settings?.generation);
  const minutes = Number(gen.bookCallTimeoutMinutes);
  return minutes > 0 ? minutes * 60_000 : 0;
}

/**
 * Schedule an async task on a per-library, per-kind lane in `work.queues` while tracking settlement in `work.settled` (`job.wait`).
 * @param {{ queues: Map<string, Promise<any>>, settled: Map<string, Promise<any>> }} work
 * @param {string} lane
 * @param {string} jobId
 * @param {() => Promise<void>} task
 */
function scheduleOnLane(work, lane, jobId, task) {
  const previous = work.queues.get(lane) || Promise.resolve();
  const done = previous.catch(() => {}).then(task);
  work.queues.set(lane, done);
  work.settled.set(jobId, done);
  void done.finally(() => {
    if (work.queues.get(lane) === done) work.queues.delete(lane);
    work.settled.delete(jobId);
  });
  return done;
}

/**
 * Create background job & durable-proposal handlers for `materials`:
 * - `source.folder.classify`
 * - `source.folder.dismiss`
 * - `source.organize.start`
 * - `source.organize.dismiss`
 *
 * @param {Record<string, any>} ports
 */
export function createMaterialClassifyJobs(ports = {}) {
  const {
    state: storagePort,
    complete,
    language,
    work,
    jobServices,
    workOwner,
    announceJob,
    failStep,
    jevOrganizeHook,
    readFullState,
  } = ports;

  const jobs = work?.jobs;
  const queues = work?.queues;
  const settled = work?.settled;
  const generationControllers = work?.generationControllers;
  const jobOutputs = work?.jobOutputs;
  const activeJob = jobServices?.activeJob;
  const pruneJobs = jobServices?.pruneJobs;
  const publicJob = jobServices?.publicJob;

  const readState = async () => (typeof readFullState === 'function' ? readFullState() : storagePort.read());

  /**
   * Find an already `queued` or `running` job of `type` and matching scope `dedupeKey` in this library root for deduplication.
   * @param {string} type
   * @param {string} dedupeKey
   */
  const findReusableJob = (type, dedupeKey) => {
    if (!jobs || !storagePort?.root) return null;
    for (const candidate of jobs.values()) {
      if (
        candidate.root === storagePort.root &&
        candidate.type === type &&
        candidate.dedupeKey === dedupeKey &&
        ['queued', 'running'].includes(candidate.status)
      ) {
        return candidate;
      }
    }
    return null;
  };

  /**
   * Execute one LLM step via `complete(..., { jobId, stage, task, resultOwner: 'plugin', reasoningEffort: 'lowest', timeoutMs, ... })` -> direct host model call with job-scoped cache session.
   * @param {Record<string, any>} job
   * @param {AbortController} controller
   * @param {{ stage: string, label: string, part?: number, parts?: number, slot?: number, retry?: number, system: string, prompt: string }} spec
   * @param {{ provider: string, model: string } | null} [lightRoute]
   * @param {number} [timeoutMs]
   * @returns {Promise<string>}
   */
  const runJobStep = async (job, controller, spec, lightRoute = null, timeoutMs = 0) => {
    controller.signal.throwIfAborted();
    /** @type {Record<string, any>} */
    const step = {
      id: id(),
      stage: spec.stage,
      label: spec.label,
      ...(spec.part != null ? { part: spec.part, parts: spec.parts } : {}),
      ...(spec.slot != null ? { slot: spec.slot } : {}),
      ...(spec.retry && spec.retry > 0 ? { retry: spec.retry } : {}),
      status: 'running',
      startedAt: iso(),
    };
    job.steps.push(step);
    if (job.steps.length > STEP_KEEP_LIMIT) {
      job.steps.splice(0, job.steps.length - STEP_KEEP_LIMIT);
    }
    jobOutputs?.open?.(job.id, step.id);

    try {
      const taskName = job.type === MATERIAL_ORGANIZE_TYPE ? 'materials.organize' : 'materials.classify';
      const reply = await withJobUsage(job, step, () => complete(spec.system, spec.prompt, {
        jobId: job.id,
        cacheSessionId: job.id ? `study-job:${job.id}` : undefined,
        task: taskName,
        stage: step.stage,
        ...(spec.part != null ? { part: spec.part, parts: spec.parts } : {}),
        ...(spec.slot != null ? { slot: spec.slot } : {}),
        signal: controller.signal,
        resultOwner: 'plugin',
        reasoningEffort: 'lowest',
        timeoutMs,
        ...(lightRoute ? { lightRoute } : {}),
        onEvent: (/** @type {any} */ event) => {
          if (!event || typeof event !== 'object') return;
          const { label: agentLabel, ...rest } = event;
          Object.assign(step, rest);
          if (agentLabel) step.agentLabel = agentLabel;
        },
        onOutput: (/** @type {string} */ text) => {
          step.firstOutputAt ??= iso();
          jobOutputs?.append?.(job.id, step.id, text);
        },
        onReasoning: (/** @type {number} */ count) => {
          jobOutputs?.reasoning?.(job.id, step.id, count);
        },
      }), { feature: 'other' });
      controller.signal.throwIfAborted();
      step.runtime ||= 'direct';
      step.status = 'complete';
      return reply;
    } catch (error) {
      if (controller.signal.aborted || job.cancelRequestedAt || /** @type {any} */ (error)?.name === 'AbortError') {
        step.status = 'cancelled';
      } else if (typeof failStep === 'function') {
        failStep(step, error);
      } else {
        step.status = 'failed';
        step.error = String(/** @type {any} */ (error)?.message || error).slice(0, 200);
      }
      throw error;
    } finally {
      jobOutputs?.close?.(job.id, step.id);
      const endedAt = iso();
      step.finishedAt = endedAt;
      step.completedAt = endedAt;
      if (step.tokenUsage) step.usage = step.tokenUsage;
    }
  };

  /**
   * `source.folder.classify` — background AI folder classification job (`type: 'material-classify'`).
   * @param {Record<string, any>} [rawArgs]
   */
  async function startClassify(rawArgs = {}) {
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    if (args.keys !== undefined && args.keys !== null && (!Array.isArray(args.keys) || args.keys.length > 5000)) {
      throw new Error('一次最多选择 5000 份资料进行分类');
    }
    if (typeof complete !== 'function') {
      throw new Error('请先选择生成模型');
    }

    const course = normalizeCourseScope(args.course);
    const keysHash = hashKeys(args.keys);
    const onlyUnfiled = Boolean(args.onlyUnfiled);
    const dedupeKey = `${MATERIAL_CLASSIFY_TYPE}\0${course}\0${onlyUnfiled ? '1' : '0'}\0${keysHash}`;

    const existing = findReusableJob(MATERIAL_CLASSIFY_TYPE, dedupeKey);
    if (existing) {
      return { job: publicJob(existing), reused: true };
    }

    const initialState = await readState();
    const { items: assignedItems } = readMaterialFolders(initialState?.settings);
    const { selected } = selectTargetMaterials(
      initialState || {},
      args,
      /** @type {Record<string, string>} */ (assignedItems),
    );
    if (!selected.length) {
      throw new Error('当前范围没有可分类的资料');
    }

    pruneJobs?.();
    const root = storagePort.root;
    const lane = `${root}:${MATERIAL_CLASSIFY_TYPE}`;
    const ahead = [...jobs.values()].some(j => j.root === root && j.type === MATERIAL_CLASSIFY_TYPE && activeJob(j));
    const controller = new AbortController();
    const startedAt = iso();
    const initialPhase = selected.length > FOLDER_SUGGEST_BATCH ? 'taxonomy' : 'batch';
    const rawEstimate = estimateMaterialClassify(initialState, {
      keys: args.keys,
      course: args.course,
      onlyUnfiled: args.onlyUnfiled,
      maxFolders: args.maxFolders,
      language,
    }, { language });
    const jobEstimate = rawEstimate?.calls?.high > 0 ? compactEstimate(rawEstimate) : null;

    /** @type {Record<string, any>} */
    const job = {
      id: id(),
      root,
      type: MATERIAL_CLASSIFY_TYPE,
      origin: 'materials',
      course,
      keysHash,
      dedupeKey,
      phase: initialPhase,
      done: 0,
      total: selected.length,
      steps: [],
      status: ahead ? 'queued' : 'running',
      stage: ahead
        ? '排队中'
        : initialPhase === 'taxonomy'
          ? '正在归纳主题目录'
          : `正在按内容整理分类 0/${selected.length}`,
      startedAt,
      ...(ahead ? {} : { runStartedAt: startedAt }),
      ...(jobEstimate ? { estimate: jobEstimate } : {}),
      language,
    };

    ownWork(job, workOwner);
    jobs.set(job.id, job);
    generationControllers.set(job.id, controller);

    scheduleOnLane({ queues, settled }, lane, job.id, async () => {
      try {
        if (controller.signal.aborted || job.cancelRequestedAt) {
          job.status = 'cancelled';
          job.outcome = 'cancelled';
          job.stage = '资料智能分类已取消';
          return;
        }
        job.status = 'running';
        job.runStartedAt ||= iso();

        const runState = ahead ? await readState() : initialState;
        const lightRoute = lightModelOf(runState?.settings?.generation?.lightModel);
        const stepTimeoutMs = stepTimeoutMsOf(runState);
        const result = await suggestMaterialFolders(runState, {
          keys: args.keys,
          course: args.course,
          onlyUnfiled: args.onlyUnfiled,
          maxFolders: args.maxFolders,
          mode: 'auto',
          language,
        }, {
          language,
          signal: controller.signal,
          runStep: spec => runJobStep(job, controller, spec, lightRoute, stepTimeoutMs),
          onPhase: (phase, info) => {
            if (controller.signal.aborted || job.cancelRequestedAt) return;
            job.phase = phase;
            job.total = info.total;
            job.stage = phase === 'taxonomy'
              ? '正在归纳主题目录'
              : `正在按内容整理分类 ${job.done}/${info.total}`;
          },
          onBatchDone: info => {
            if (controller.signal.aborted || job.cancelRequestedAt) return;
            job.phase = 'batch';
            job.done = info.done;
            job.total = info.total;
            job.stage = `正在按内容整理分类 ${info.done}/${info.total}`;
          },
        });

        controller.signal.throwIfAborted();
        const createdAt = iso();
        await storagePort.update((/** @type {any} */ s) => {
          controller.signal.throwIfAborted();
          s.settings ||= {};
          const entry = {
            jobId: job.id,
            createdAt,
            course,
            folders: result.folders,
            suggestions: result.suggestions,
            unmatchedKeys: result.unmatchedKeys,
          };
          const byCourse = s.settings.materialClassifyPendingByCourse && typeof s.settings.materialClassifyPendingByCourse === 'object'
            ? { ...s.settings.materialClassifyPendingByCourse }
            : {};
          const legacy = s.settings.materialClassifyPending;
          if (legacy && typeof legacy === 'object') {
            const legacySlot = normalizeCourseScope(legacy.course) || '*';
            if (!byCourse[legacySlot]) byCourse[legacySlot] = legacy;
          }
          byCourse[course || '*'] = entry;
          s.settings.materialClassifyPendingByCourse = byCourse;
          s.settings.materialClassifyPending = entry;
        });

        job.phase = 'done';
        job.done = job.total;
        job.folderCount = result.folders.length;
        job.suggestedCount = result.suggestions.length;
        job.unmatchedCount = result.unmatchedKeys.length;
        job.status = 'complete';
        job.stage = '已完成';
      } catch (error) {
        if (controller.signal.aborted || job.cancelRequestedAt || /** @type {any} */ (error)?.name === 'AbortError') {
          job.status = 'cancelled';
          job.outcome = 'cancelled';
          job.stage = '资料智能分类已取消';
        } else {
          job.status = 'failed';
          job.stage = String(/** @type {any} */ (error)?.message || '资料分类未完成');
        }
      } finally {
        job.finishedAt = iso();
        generationControllers.delete(job.id);
        jobOutputs?.endJob?.(job.id);
        announceJob?.(job);
      }
    });

    return { job: publicJob(job), reused: false };
  }

  /**
   * `source.folder.dismiss` — clear pending classification proposals (optionally guarded by `jobId` or scoped by `course`).
   * @param {{ jobId?: string | null, course?: string | null }} [rawArgs]
   */
  async function dismissClassify(rawArgs = {}) {
    const wantedJobId = typeof rawArgs?.jobId === 'string' && rawArgs.jobId.trim() ? rawArgs.jobId.trim() : null;
    const hasCourse = typeof rawArgs?.course === 'string';
    const wantedSlot = hasCourse ? (normalizeCourseScope(rawArgs.course) || '*') : null;
    const current = await storagePort.read(['settings']);
    const pending = current?.settings?.materialClassifyPending;
    const byCourse = current?.settings?.materialClassifyPendingByCourse;
    const hasMapMatch = Boolean(
      byCourse && typeof byCourse === 'object' && Object.entries(byCourse).some(([slot, entry]) =>
        entry && typeof entry === 'object' &&
        (wantedJobId ? entry.jobId === wantedJobId : wantedSlot ? slot === wantedSlot : true)),
    );
    const hasLegacyMatch = Boolean(
      pending && typeof pending === 'object' &&
      (wantedJobId ? pending.jobId === wantedJobId : wantedSlot ? (normalizeCourseScope(pending.course) || '*') === wantedSlot : true),
    );
    if (!hasMapMatch && !hasLegacyMatch) {
      return { dismissed: false };
    }
    return storagePort.update((/** @type {any} */ s) => {
      let changed = false;
      const liveMap = s.settings?.materialClassifyPendingByCourse;
      if (liveMap && typeof liveMap === 'object') {
        for (const [slot, entry] of Object.entries(liveMap)) {
          if (!entry || typeof entry !== 'object') continue;
          const match = wantedJobId ? entry.jobId === wantedJobId : wantedSlot ? slot === wantedSlot : true;
          if (match) {
            delete liveMap[slot];
            changed = true;
          }
        }
        if (!Object.keys(liveMap).length) delete s.settings.materialClassifyPendingByCourse;
      }
      const live = s.settings?.materialClassifyPending;
      const legacyMatch = Boolean(
        live && typeof live === 'object' &&
        (wantedJobId ? live.jobId === wantedJobId : wantedSlot ? (normalizeCourseScope(live.course) || '*') === wantedSlot : true),
      );
      if (legacyMatch) {
        changed = true;
        const remaining = s.settings?.materialClassifyPendingByCourse
          ? latestPendingEntry(s.settings.materialClassifyPendingByCourse)
          : null;
        if (remaining) s.settings.materialClassifyPending = remaining;
        else delete s.settings.materialClassifyPending;
      }
      if (!changed) {
        throw { noWrite: { dismissed: false } };
      }
      return { dismissed: true };
    }).catch((/** @type {any} */ err) => {
      if (err?.noWrite) return err.noWrite;
      throw err;
    });
  }

  /**
   * `source.organize.start` — background course-attribution job (`type: 'material-organize'`, `1..5000` sources).
   * @param {{ sourceIds?: string[] }} [rawArgs]
   */
  async function startOrganize(rawArgs = {}) {
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    if (!Array.isArray(args.sourceIds) || args.sourceIds.length < 1 || args.sourceIds.length > MAX_ORGANIZE_SOURCES) {
      throw new Error('请选择 1–5000 份资料进行 AI 整理');
    }
    if (typeof complete !== 'function') {
      throw new Error('请先选择生成模型');
    }

    const keysHash = hashKeys(args.sourceIds);
    const dedupeKey = `${MATERIAL_ORGANIZE_TYPE}\0${keysHash}`;
    const existing = findReusableJob(MATERIAL_ORGANIZE_TYPE, dedupeKey);
    if (existing) {
      return { job: publicJob(existing), reused: true };
    }

    const initialState = await readState();
    const { sources } = prepareCourseSuggestSources(initialState, args);

    pruneJobs?.();
    const root = storagePort.root;
    const lane = `${root}:${MATERIAL_ORGANIZE_TYPE}`;
    const ahead = [...jobs.values()].some(j => j.root === root && j.type === MATERIAL_ORGANIZE_TYPE && activeJob(j));
    const controller = new AbortController();
    const startedAt = iso();

    /** @type {Record<string, any>} */
    const job = {
      id: id(),
      root,
      type: MATERIAL_ORGANIZE_TYPE,
      origin: 'materials',
      keysHash,
      dedupeKey,
      phase: 'batch',
      done: 0,
      total: sources.length,
      steps: [],
      status: ahead ? 'queued' : 'running',
      stage: ahead ? '排队中' : `正在整理课程归属 0/${sources.length}`,
      startedAt,
      ...(ahead ? {} : { runStartedAt: startedAt }),
      language,
    };

    ownWork(job, workOwner);
    jobs.set(job.id, job);
    generationControllers.set(job.id, controller);

    scheduleOnLane({ queues, settled }, lane, job.id, async () => {
      try {
        if (controller.signal.aborted || job.cancelRequestedAt) {
          job.status = 'cancelled';
          job.outcome = 'cancelled';
          job.stage = '整理课程归属已取消';
          return;
        }
        job.status = 'running';
        job.runStartedAt ||= iso();

        const runState = ahead ? await readState() : initialState;
        const lightRoute = lightModelOf(runState?.settings?.generation?.lightModel);
        const stepTimeoutMs = stepTimeoutMsOf(runState);
        const jevHook = typeof jevOrganizeHook === 'function'
          ? await jevOrganizeHook({ language })
          : undefined;

        const result = await suggestSourceCourses(runState, args, {
          language,
          signal: controller.signal,
          jevHook,
          runStep: spec => runJobStep(job, controller, spec, lightRoute, stepTimeoutMs),
          onBatchDone: info => {
            if (controller.signal.aborted || job.cancelRequestedAt) return;
            job.phase = 'batch';
            job.done = info.done;
            job.total = info.total;
            job.stage = `正在整理课程归属 ${info.done}/${info.total}`;
          },
        });

        controller.signal.throwIfAborted();
        const createdAt = iso();
        await storagePort.update((/** @type {any} */ s) => {
          controller.signal.throwIfAborted();
          s.settings ||= {};
          s.settings.materialOrganizePending = {
            jobId: job.id,
            createdAt,
            proposals: result.proposals,
            ...(result.jev !== undefined ? { jev: result.jev } : {}),
          };
        });

        job.phase = 'done';
        job.done = job.total;
        job.proposalCount = result.proposals.length;
        job.status = 'complete';
        job.stage = '已完成';
      } catch (error) {
        if (controller.signal.aborted || job.cancelRequestedAt || /** @type {any} */ (error)?.name === 'AbortError') {
          job.status = 'cancelled';
          job.outcome = 'cancelled';
          job.stage = '整理课程归属已取消';
        } else {
          job.status = 'failed';
          job.stage = String(/** @type {any} */ (error)?.message || '整理课程归属未完成');
        }
      } finally {
        job.finishedAt = iso();
        generationControllers.delete(job.id);
        jobOutputs?.endJob?.(job.id);
        announceJob?.(job);
      }
    });

    return { job: publicJob(job), reused: false };
  }

  /**
   * `source.organize.dismiss` — clear `settings.materialOrganizePending` (optionally guarded by `jobId`).
   * @param {{ jobId?: string | null }} [rawArgs]
   */
  async function dismissOrganize(rawArgs = {}) {
    const wantedJobId = typeof rawArgs?.jobId === 'string' && rawArgs.jobId.trim() ? rawArgs.jobId.trim() : null;
    const current = await storagePort.read(['settings']);
    const pending = current?.settings?.materialOrganizePending;
    if (!pending || (wantedJobId && pending.jobId !== wantedJobId)) {
      return { dismissed: false };
    }
    return storagePort.update((/** @type {any} */ s) => {
      const live = s.settings?.materialOrganizePending;
      if (!live || (wantedJobId && live.jobId !== wantedJobId)) {
        throw { noWrite: { dismissed: false } };
      }
      delete s.settings.materialOrganizePending;
      return { dismissed: true };
    }).catch((/** @type {any} */ err) => {
      if (err?.noWrite) return err.noWrite;
      throw err;
    });
  }

  return {
    'source.organize.start': startOrganize,
    'source.organize.dismiss': dismissOrganize,
    'source.folder.classify': startClassify,
    'source.folder.dismiss': dismissClassify,
  };
}
