import { createReadStream } from 'node:fs';
import { AUDIO_TEXT } from './audio-messages.js';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, join } from 'node:path';
import { AUDIO_EXTENSIONS, MAX_AUDIO_BYTES } from './audio-file.js';
import { claimUpload, discardUpload, keptUploadDir, releaseUpload } from './audio-upload.js';
import { executeAudioJob, poolHooks, storeDocuments } from './audio-job.js';
import { audioControl } from './job-control.js';
import { TEXT_CONCURRENCY, clampCount, createPool } from './audio-pool.js';
import { addUsage } from './audio-usage.js';
import { probeAudioFile } from './audio-preflight.js';
import { id, parseStoredJson } from './util.js';
import { atomicJson, readJsonFile, serializeJsonFile } from './atomic-json.js';
import { validateStoredJob } from './jobs/store.js';

// Manifests contain only submitted context and checkpoints, never model settings or credentials.
const directory = (root, batchId) => {
  if (!/^[\w-]{8,64}$/.test(batchId)) throw new Error('无效的音频批次');
  return join(root, 'audio-batches', batchId);
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const memberContext = batch => digest({ title: batch.title, args: batch.args });
function checkpointResult(batch, member, result, progress) {
  const checkpoint = { version: 1, batchId: batch.id, index: member.index, filename: member.filename,
    inputHash: member.hash, inputSize: member.size, context: memberContext(batch),
    progress: JSON.parse(JSON.stringify({ ...progress, status: 'complete', phase: 'done', finishedAt: new Date().toISOString() })) };
  return { ...result, checkpoint: { ...checkpoint, digest: digest({ result, checkpoint }) } };
}
async function readOrphanResult(file, batch, member) {
  let saved;
  try { saved = parseStoredJson(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
  if (!saved || typeof saved !== 'object' || !saved.checkpoint) return;
  const { checkpoint, ...result } = saved, { digest: checksum, ...metadata } = checkpoint;
  if (metadata.version !== 1 || metadata.batchId !== batch.id || metadata.index !== member.index ||
      metadata.filename !== member.filename || metadata.inputHash !== member.hash || metadata.inputSize !== member.size ||
      metadata.context !== memberContext(batch) || checksum !== digest({ result, checkpoint: metadata })) return;
  if (!Array.isArray(result.documents) || !result.documents.length || !result.documents.every(text => typeof text === 'string' && text.trim()) ||
      result.meta?.hash !== member.hash || typeof result.titleEn !== 'string' || !Number.isInteger(result.parts) || result.parts < 1 ||
      !['applied', 'skipped'].every(key => Array.isArray(result.corrections?.[key]) &&
        result.corrections[key].every(value => value && typeof value === 'object')) ||
      metadata.progress?.status !== 'complete' || metadata.progress.phase !== 'done' || !Array.isArray(metadata.progress.warnings) ||
      !metadata.progress.warnings.every(warning => typeof warning === 'string') ||
      digest(metadata.progress.usage ?? null) !== digest(result.meta.usage ?? null)) return;
  return { result, progress: metadata.progress };
}
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
      status: 'queued', phase: 'queued', stage: '排队中', startedAt: record.createdAt, warnings: [], retryable: true };
    await saveAudioBatch(root, record);
    return record;
  } catch (error) { await removeAudioBatch(root, record.id); throw error; }
}
export async function verifySingleAudioInput(record) {
  const current = await identity(record.args.path).catch(() => { throw new Error(AUDIO_TEXT.inputUnavailable); });
  if (record.input && (current.hash !== record.input.hash || current.size !== record.input.size))
    throw new Error(AUDIO_TEXT.inputChanged);
}
async function identity(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('音频文件路径必须是绝对路径');
  if (!AUDIO_EXTENSIONS.includes(extname(path).toLowerCase())) throw new Error(`不支持的音频格式；支持 ${AUDIO_EXTENSIONS.join('、')}`);
  const info = await stat(path);
  if (!info.isFile() || !info.size) throw new Error('音频文件是空的或不是文件');
  if (info.size > MAX_AUDIO_BYTES) throw new Error('音频超过 512 MB，请先压缩成 MP3 或按章节拆分');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return { hash: hash.digest('hex'), size: info.size };
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
    batch.job = { id: id(), type: 'audio-import', batchId: batch.id, filename: batch.title, status: 'queued', phase: 'queued', stage: '排队中',
      startedAt: batch.createdAt, warnings: [], retryable: true, courses: batch.args.courses };
    const hashes = new Set();
    for (const member of batch.members) {
      if (hashes.has(member.hash)) batch.job.warnings.push(`重复内容：${member.filename}；保留顺序并复用已完成的处理，不重复请求模型`);
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

/** Compose only complete members; every volume repeats the original filename at its boundary. */
export function batchDocuments(title, members, results) {
  const limit = 400_000, header = `# ${title}\n\n`, documents = [];
  let document = header;
  const flush = () => { if (document.length > header.length) documents.push(document.trimEnd()); document = header; };
  members.forEach((member, index) => {
    const boundary = `## ${index + 1}. ${member.filename}\n\n`;
    let text = results[index].documents.join('\n\n');
    while (text.length) {
      let room = limit - document.length - boundary.length - 2;
      if (room < 1000) { flush(); room = limit - header.length - boundary.length - 2; }
      let end = Math.min(text.length, room);
      if (end < text.length) {
        const paragraph = text.lastIndexOf('\n\n', end);
        if (paragraph > end / 2) end = paragraph;
      }
      document += boundary + text.slice(0, end) + '\n\n';
      text = text.slice(end).trimStart();
      if (text.length) flush();
    }
  });
  flush();
  return documents;
}

/**
 * Pre-flight every member that still has work, before any request. A member that cannot be imported holds the others:
 * it is marked `blocked` with its reason, each sibling `waiting` for it (never silently cancelled), and the job fails
 * retryably so the learner can fix it and continue, or skip that file and continue.
 */
async function holdForBlockedMember({ root, batch, job, settings }) {
  const blocked = [];
  for (const member of batch.members) {
    if (member.skipped || member.status === 'complete') continue;
    const probe = await probeAudioFile(member.path, { partSeconds: (settings.partMinutes || 59) * 60, name: member.filename });
    if (probe.blocked) blocked.push({ member, issue: probe.issue });
  }
  if (!blocked.length) return;
  const first = blocked[0].member;
  batch.members.forEach((member, index) => {
    if (member.skipped || member.status === 'complete') return;
    const own = blocked.find(item => item.member === member), progress = job.members[index];
    if (own) Object.assign(progress, { status: 'blocked', stage: own.issue.message, issue: own.issue });
    else Object.assign(progress, { status: 'waiting', waitingFor: first.filename });
  });
  job.blocked = { index: first.index, filename: first.filename };
  await saveAudioBatch(root, batch, job);
  throw new Error(`「${first.filename}」未通过预检，其余文件尚未开始；可以跳过它继续`);
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
  if (!included.length) throw new Error('没有可以导入的文件：这一批的文件都被跳过了');
  // Validate even completed path inputs on retry: changed bytes cannot silently become part of an older batch.
  for (const member of included) {
    const facts = await identity(member.path);
    if (facts.hash !== member.hash) throw new Error(`音频文件已改变：${member.filename}。请作为新批次重新提交`);
  }
  await holdForBlockedMember({ root, batch, job, settings });
  // One text pool for the whole batch: the files overlap (file N+1 is transcribed while file N is proofread), but the DSH
  // model is asked for no more than the learner's text concurrency at any moment, lowered automatically when it pushes back.
  const pools = { text: createPool({ limit: clampCount(settings.textConcurrency, TEXT_CONCURRENCY), ...poolHooks(job) }) };
  job.parallel = { ...job.parallel, text: pools.text.state, transcribe: { limit: settings.transcribeConcurrency } };
  // The batch is adjusted as one: the text pool every file shares, the transcription gate, the reasoning of the steps still to come, pause.
  const control = controls ? audioControl({ job, settings, pools, setTranscribeLimit: controls.setTranscribeLimit, onPaused: controls.onPaused }) : null;
  if (control) controls.register(job, control);
  const pauseGate = control ? (stop) => control.waitIfPaused(stop) : undefined;
  const outcomes = await Promise.allSettled(batch.members.map(async (member, index) => {
    const progress = job.members[index], resultPath = join(dir, `result-${index}.json`);
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
        const recovered = await readOrphanResult(resultPath, batch, member);
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
      progress.stage = String(error.message || error).slice(0, 400);
      throw error;
    } finally {
      member.progress = progress;
      progress.finishedAt = new Date().toISOString();
      await saveAudioBatch(root, batch, job);
    }
  }));
  job.done = job.members.filter(member => member.status === 'complete').length;
  job.total = included.length;
  job.warnings = [...new Set([...job.warnings, ...job.members.flatMap(member => (member.warnings || []).map(warning => `${member.filename}：${warning}`))])];
  const unique = [...new Map(job.members.map((member, index) => [batch.members[index].hash, member])).values()];
  job.usage = unique.reduce((sum, member) => addUsage(sum, member.usage), {});
  job.usageRun = job.members.reduce((sum, member) => addUsage(sum, member.reused ? {} : member.usageRun), {});
  signal.throwIfAborted();
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed) throw failed.reason;
  job.phase = 'assemble';
  await saveAudioBatch(root, batch, job);
  const documents = batchDocuments(batch.title, included, batch.members.map((member, index) => member.skipped ? null : results[index]).filter(Boolean));
  const ids = documents.map((_, index) => `audio-batch-${batch.id}${index ? `-p${index + 1}` : ''}`);
  const corrections = { applied: results.flatMap(result => result.corrections.applied), skipped: results.flatMap(result => result.corrections.skipped) };
  await storeDocuments({ store, ids, documents, title: batch.title, corrections, courses: batch.args.courses, language: job.language,
    meta: { course: batch.args.course, usage: job.usage, batch: { id: batch.id, title: batch.title,
      members: included.map(member => ({ order: member.index + 1, filename: member.filename, hash: member.hash })) } } });
  Object.assign(job, { sourceIds: ids, corrected: corrections.applied.length, uncertain: corrections.skipped.filter(c => c.skipped === 'low-confidence').length });
}
