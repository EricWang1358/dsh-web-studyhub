import { AUDIO_TEXT, duplicateMember, memberChanged, stageText } from './audio-messages.js';
import { copyFile, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { identity } from './audio-input.js';
import { claimUpload, discardUpload, keptUploadDir, releaseUpload } from './audio-upload.js';
import { executeAudioJob, poolHooks, storeDocuments } from './audio-job.js';
import { audioControl } from './job-control.js';
import { TEXT_CONCURRENCY, clampCount, createPool } from './audio-pool.js';
import { assembleBatch, batchUsage, batchWarnings, checkpointResult, holdForBlockedMember, memberResultName, readMemberResult } from './audio-batch-members.js';
import { id, parseStoredJson } from './util.js';
import { atomicJson, readJsonFile, serializeJsonFile } from './atomic-json.js';
import { validateStoredJob } from './jobs/store.js';

// Manifests contain only submitted context and checkpoints, never model settings or credentials.
const directory = (root, batchId) => {
  if (!/^[\w-]{8,64}$/.test(batchId)) throw new Error('无效的音频批次');
  return join(root, 'audio-batches', batchId);
};
export { batchDocuments } from './audio-batch-members.js';
export function saveAudioBatch(root, batch, job) {
  if (job) batch.job = JSON.parse(JSON.stringify(job, (key, value) => key === 'root' ? undefined : value));
  const file = join(directory(root, batch.id), 'manifest.json'), value = JSON.parse(JSON.stringify(batch));
  return serializeJsonFile(file, async () => {
    let current;
    try { current = await readJsonFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current && Object.hasOwn(current, 'runtimeJob')) {
      value.runtimeJob = validateStoredJob(current.runtimeJob);
      value.job = current.job;
    } else if (Object.hasOwn(value, 'runtimeJob')) throw Object.assign(new Error('Runtime metadata requires the lifecycle writer'), { code: 'runtime-metadata-owner' });
    await atomicJson(file, value);
  });
}
export async function readAudioBatch(root, batchId) {
  const file = join(directory(root, batchId), 'manifest.json');
  return serializeJsonFile(file, () => readJsonFile(file));
}
export async function listAudioBatches(root) {
  const names = await readdir(join(root, 'audio-batches')).catch(() => []), batches = [];
  for (const name of names) {
    try { const batch = await readAudioBatch(root, name); if (batch.id === name && batch.job) batches.push(batch); }
    catch { /* Uncommitted preparation has no resumable job. */ }
  }
  return batches;
}
export async function removeAudioBatch(root, batchId, { inputsOnly = false } = {}) {
  const dir = directory(root, batchId);
  return serializeJsonFile(join(dir, 'manifest.json'), async () => {
    if (!inputsOnly) { const kept = await keptUploadOf(root, dir); if (kept) await rm(kept, { recursive: true, force: true }); }
    await rm(inputsOnly ? join(dir, 'inputs') : dir, { recursive: true, force: true });
  });
}
/** A single import keeps its uploaded original until it is done; the job's files and that copy leave together. */
async function keptUploadOf(root, dir) {
  const record = await readJsonFile(join(dir, 'manifest.json')).catch(() => null);
  return keptUploadDir(root, record?.upload);
}
/* Dismissing a finished job must reply fast, but deleting a batch (it can hold a copy of a 500 MB recording)
   is slow. So the folder is first renamed to "<id>.retired-<n>": one cheap, atomic step after which listAudioBatches()
   no longer sees the job (the dot fails the batch-id check), so a restart can never resurrect it. The actual removal
   then runs in the background, and sweepRetiredAudioBatches() finishes any leftover on the next start. */
const RETIRED = '.retired-';
export async function retireAudioBatch(root, batchId) {
  const dir = directory(root, batchId);
  return serializeJsonFile(join(dir, 'manifest.json'), async () => {
    const target = join(root, 'audio-batches', `${batchId}${RETIRED}${id()}`);
    for (let attempt = 0; ; attempt++) {
      try {
        const kept = await keptUploadOf(root, dir);
        await rename(dir, target);
        // Moved into the retired folder (one cheap rename) so the background purge removes it with the job's files.
        if (kept) await rename(kept, join(target, 'kept-upload')).catch(error => { if (error.code !== 'ENOENT') throw error; });
        return target;
      }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt));
      }
    }
  });
}

export async function sweepRetiredAudioBatches(root) {
  const base = join(root, 'audio-batches');
  for (const name of (await readdir(base).catch(() => [])).filter(name => name.includes(RETIRED)))
    await rm(join(base, name), { recursive: true, force: true });
}
/** A one-file import keeps its existing transcript pipeline; this small manifest
    only restores the job card and submitted context after a host restart. */
export async function prepareSingleAudioRecord(root, args, upload) {
  const record = { id: id(), kind: 'single', createdAt: new Date().toISOString(),
    args: Object.fromEntries(['path', 'title', 'subject', 'terms', 'course', 'courses', 'vocabulary', 'paidOnly']
      .filter(key => args[key] !== undefined).map(key => [key, args[key]])),
    upload: upload ? { id: upload.id, dir: upload.dir, path: upload.path, name: upload.name } : null };
  const dir = directory(root, record.id);
  await mkdir(dir, { recursive: true });
  try {
    if (upload) {
      await mkdir(join(dir, 'inputs'), { recursive: true });
      record.args.path = join(dir, 'inputs', upload.name);
      await copyFile(upload.path, record.args.path);
    }
    record.input = await identity(record.args.path);
    record.job = { id: id(), type: 'audio-import', singleId: record.id, filename: basename(args.path),
      status: 'queued', phase: 'queued', stage: AUDIO_TEXT.queued, startedAt: record.createdAt, warnings: [], retryable: true };
    await saveAudioBatch(root, record);
    return record;
  } catch (error) { await removeAudioBatch(root, record.id); throw error; }
}
export async function verifySingleAudioInput(record) {
  const current = await identity(record.args.path).catch(() => { throw new Error(AUDIO_TEXT.inputUnavailable); });
  if (record.input && (current.hash !== record.input.hash || current.size !== record.input.size))
    throw new Error(AUDIO_TEXT.inputChanged);
}
export async function prepareAudioBatch(root, args, uploadRegistry = { claimUpload, discardUpload, releaseUpload }) {
  const { claimUpload, discardUpload, releaseUpload } = uploadRegistry;
  if (!Array.isArray(args.files) || !args.files.length) throw new Error('files 必须是非空音频文件列表');
  if (args.path !== undefined || args.uploadId !== undefined) throw new Error('files 与 path/uploadId 不能同时提交');
  const batch = { id: id(), title: String(args.title || '').trim(), createdAt: new Date().toISOString(),
    args: Object.fromEntries(['title', 'subject', 'terms', 'course', 'courses', 'vocabulary', 'paidOnly'].filter(key => args[key] !== undefined).map(key => [key, args[key]])),
    members: [] };
  const dir = directory(root, batch.id), uploads = new Map();
  await mkdir(join(dir, 'inputs'), { recursive: true });
  try {
    for (const [index, input] of args.files.entries()) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || (input.path === undefined) === (input.uploadId === undefined))
        throw new Error('每段音频必须提供 path 或 uploadId，且只能给一个');
      let path = input.path;
      if (input.uploadId !== undefined) {
        if (!uploads.has(input.uploadId)) uploads.set(input.uploadId, claimUpload(root, input.uploadId));
        const upload = uploads.get(input.uploadId);
        const inputDir = join(dir, 'inputs', String(index + 1));
        await mkdir(inputDir, { recursive: true });
        path = join(inputDir, upload.name);
        await copyFile(upload.path, path);
      }
      const facts = await identity(path);
      batch.members.push({ index, filename: basename(path), path, ...facts, status: 'queued' });
    }
    batch.title ||= batch.members.length === 1 ? batch.members[0].filename : `${batch.members[0].filename} + ${batch.members.length - 1}`;
    batch.job = { id: id(), type: 'audio-import', batchId: batch.id, filename: batch.title, status: 'queued', phase: 'queued', stage: AUDIO_TEXT.queued,
      startedAt: batch.createdAt, warnings: [], retryable: true, courses: batch.args.courses };
    const hashes = new Set();
    for (const member of batch.members) {
      if (hashes.has(member.hash)) batch.job.warnings.push(duplicateMember(member.filename));
      hashes.add(member.hash);
    }
    await saveAudioBatch(root, batch);
    for (const upload of uploads.values()) await discardUpload(upload).catch(() => {});
    return batch;
  } catch (error) {
    for (const upload of uploads.values()) releaseUpload(upload);
    await removeAudioBatch(root, batch.id);
    throw error;
  }
}

export async function executeAudioBatch({ root, batch, job, signal, settings, store, complete, fetch, admit, controls }) {
  const dir = directory(root, batch.id);
  const results = Array(batch.members.length);
  job.members = batch.members.map(member => ({ ...member.progress, index: member.index, filename: member.filename,
    status: member.skipped ? 'skipped' : member.status, phase: member.status === 'complete' ? 'done' : 'queued' }));
  job.courses = batch.args.courses;
  job.textProvider = settings.textProvider;
  job.phase = 'batch';
  const included = batch.members.filter(member => !member.skipped);
  if (!included.length) throw new Error(AUDIO_TEXT.allSkipped);
  // Validate even completed path inputs on retry: changed bytes cannot silently become part of an older batch.
  for (const member of included) {
    const facts = await identity(member.path);
    if (facts.hash !== member.hash) throw new Error(memberChanged(member.filename));
  }
  await holdForBlockedMember({ batch, view: job, settings, save: () => saveAudioBatch(root, batch, job) });
  // One text pool for the whole batch: the files overlap (file N+1 is transcribed while file N is proofread), but the DSH
  // model is asked for no more than the learner's text concurrency at any moment, lowered automatically when it pushes back.
  const pools = { text: createPool({ limit: clampCount(settings.textConcurrency, TEXT_CONCURRENCY), ...poolHooks(job) }) };
  job.parallel = { ...job.parallel, text: pools.text.state, transcribe: { limit: settings.transcribeConcurrency } };
  // The batch is adjusted as one: the text pool every file shares, the transcription gate, the reasoning of the steps still to come, pause.
  const control = controls ? audioControl({ job, settings, pools, setTranscribeLimit: controls.setTranscribeLimit, onPaused: controls.onPaused }) : null;
  if (control) controls.register(job, control);
  const pauseGate = control ? (stop) => control.waitIfPaused(stop) : undefined;
  const outcomes = await Promise.allSettled(batch.members.map(async (member, index) => {
    const progress = job.members[index], resultPath = join(dir, memberResultName(index));
    if (member.skipped) return;
    if (member.status === 'complete') {
      results[index] = parseStoredJson(await readFile(resultPath, 'utf8'));
      progress.reused = true;
      return;
    }
    try {
      await admit(`${job.id}-${index}`, signal, async release => {
        signal.throwIfAborted();
        // Check after admission so asynchronous disk reads cannot reorder members.
        // A result may be complete even when its manifest replacement failed.
        const recovered = await readMemberResult(resultPath, batch, member);
        if (recovered) {
          signal.throwIfAborted();
          results[index] = recovered.result;
          Object.assign(progress, recovered.progress, { id: job.id, index: member.index, filename: member.filename, reused: true });
          member.status = progress.status = 'complete';
          return;
        }
        job.status = 'running';
        Object.assign(progress, { id: job.id, language: job.language, status: 'running', phase: 'read', warnings: [], startedAt: new Date().toISOString() });
        results[index] = await executeAudioJob({ job: progress, args: { ...batch.args, path: member.path, inputHash: member.hash }, settings, store, complete, fetch, signal, publish: false, pools, releaseSlot: release, pauseGate, outputs: controls?.outputs });
        await atomicJson(resultPath, checkpointResult(batch, member, results[index], progress));
        member.status = progress.status = 'complete';
        progress.phase = 'done';
      });
    } catch (error) {
      member.status = progress.status = signal.aborted ? 'cancelled' : 'failed';
      progress.stage = stageText(error);
      throw error;
    } finally {
      member.progress = progress;
      progress.finishedAt = new Date().toISOString();
      await saveAudioBatch(root, batch, job);
    }
  }));
  job.done = job.members.filter(member => member.status === 'complete').length;
  job.total = included.length;
  job.warnings = batchWarnings(job.warnings, job.members);
  Object.assign(job, batchUsage(batch, job.members));
  signal.throwIfAborted();
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed) throw failed.reason;
  job.phase = 'assemble';
  await saveAudioBatch(root, batch, job);
  const assembly = assembleBatch(batch, included, results.filter(Boolean));
  await storeDocuments({ store, ids: assembly.ids, documents: assembly.documents, title: batch.title, corrections: assembly.corrections, courses: batch.args.courses,
    language: job.language, meta: { course: batch.args.course, usage: job.usage, batch: { id: batch.id, title: batch.title, members: assembly.members } } });
  Object.assign(job, { sourceIds: assembly.ids, corrected: assembly.corrections.applied.length, uncertain: assembly.uncertain });
}
