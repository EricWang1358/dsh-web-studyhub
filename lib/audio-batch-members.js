import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { identity } from './audio-input.js';
import { parseStoredJson } from './util.js';
import { probeAudioFile } from './audio-preflight.js';
import { addUsage } from './audio-usage.js';
import { partSecondsOf } from './audio-settings.js';
import { memberBlocked } from './audio-messages.js';

/* What the members of an audio batch have in common whichever executor runs them: the result file of a finished member
   (written with an integrity digest, read back only when it still belongs to this member), the hold on a member that
   cannot be imported, the assembly of the members' text into volumes, and the batch-level tallies. */

/** Characters of one assembled volume: the existing source size limit. */
export const VOLUME_LIMIT = 400_000;
/** Room left in a volume below which the next file starts a new one. */
const MIN_ROOM = 1000;

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const memberContext = batch => digest({ title: batch.title, args: batch.args });
export const memberResultName = index => `result-${index}.json`;

/** A member's result with the identity it was made for, so a later read can tell whether it still belongs to the batch. */
export function checkpointResult(batch, member, result, progress) {
  const checkpoint = { version: 1, batchId: batch.id, index: member.index, filename: member.filename,
    inputHash: member.hash, inputSize: member.size, context: memberContext(batch),
    progress: JSON.parse(JSON.stringify({ ...progress, status: 'complete', phase: 'done', finishedAt: new Date().toISOString() })) };
  return { ...result, checkpoint: { ...checkpoint, digest: digest({ result, checkpoint }) } };
}

const resultShapeValid = (result, member) => Array.isArray(result.documents) && result.documents.length > 0
  && result.documents.every(text => typeof text === 'string' && text.trim()) && result.meta?.hash === member.hash && typeof result.titleEn === 'string'
  && Number.isInteger(result.parts) && result.parts >= 1
  && ['applied', 'skipped'].every(key => Array.isArray(result.corrections?.[key]) && result.corrections[key].every(value => value && typeof value === 'object'));
const progressValid = (progress, result) => progress?.status === 'complete' && progress.phase === 'done' && Array.isArray(progress.warnings)
  && progress.warnings.every(warning => typeof warning === 'string') && digest(progress.usage ?? null) === digest(result.meta.usage ?? null);

/** The finished result saved for a member, or undefined when there is none or it does not belong to this member (changed, corrupt, another batch). */
export async function readMemberResult(file, batch, member) {
  let saved;
  try { saved = parseStoredJson(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
  if (!saved || typeof saved !== 'object' || !saved.checkpoint) return;
  const { checkpoint, ...result } = saved, { digest: checksum, ...metadata } = checkpoint;
  if (metadata.version !== 1 || metadata.batchId !== batch.id || metadata.index !== member.index ||
      metadata.filename !== member.filename || metadata.inputHash !== member.hash || metadata.inputSize !== member.size ||
      metadata.context !== memberContext(batch) || checksum !== digest({ result, checkpoint: metadata })) return;
  if (!resultShapeValid(result, member) || !progressValid(metadata.progress, result)) return;
  return { result, progress: metadata.progress };
}

/**
 * Pre-flight every member that still has work, before any request. A member that cannot be imported holds the others:
 * it is marked `blocked` with its reason, each sibling `waiting` for it (never silently cancelled), and the batch fails
 * retryably so the learner can fix it and continue, or skip that file and continue. `save` persists the members' state.
 */
export async function holdForBlockedMember({ batch, view, settings, save }) {
  const blocked = [];
  for (const member of batch.members) {
    if (member.skipped || member.status === 'complete') continue;
    const probe = await probeAudioFile(member.path, { partSeconds: partSecondsOf(settings), name: member.filename });
    if (probe.blocked) blocked.push({ member, issue: probe.issue });
  }
  if (!blocked.length) return;
  const first = blocked[0].member;
  batch.members.forEach((member, index) => {
    if (member.skipped || member.status === 'complete') return;
    const own = blocked.find(item => item.member === member), progress = view.members[index];
    if (own) Object.assign(progress, { status: 'blocked', stage: own.issue.message, issue: own.issue });
    else Object.assign(progress, { status: 'waiting', waitingFor: first.filename });
  });
  view.blocked = { index: first.index, filename: first.filename };
  await save();
  throw new Error(memberBlocked(first.filename));
}

/** The first member to run whose bytes are no longer the ones submitted, as { member, code } ('input-changed' or 'input-unavailable'), or null when all are as submitted. */
export async function findChangedMember(batch) {
  for (const member of batch.members.filter(item => !item.skipped)) {
    try { if ((await identity(member.path)).hash !== member.hash) return { member, code: 'input-changed' }; }
    catch { return { member, code: 'input-unavailable' }; }
  }
  return null;
}

/** Compose only complete members; every volume repeats the original filename at its boundary. */
export function batchDocuments(title, members, results) {
  const header = `# ${title}\n\n`, documents = [];
  let document = header;
  const flush = () => { if (document.length > header.length) documents.push(document.trimEnd()); document = header; };
  members.forEach((member, index) => {
    const boundary = `## ${index + 1}. ${member.filename}\n\n`;
    let text = results[index].documents.join('\n\n');
    while (text.length) {
      let room = VOLUME_LIMIT - document.length - boundary.length - 2;
      if (room < MIN_ROOM) { flush(); room = VOLUME_LIMIT - header.length - boundary.length - 2; }
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

/** What the batch as a whole spent: each distinct recording counted once, and what this run alone paid for. */
export function batchUsage(batch, members) {
  const unique = [...new Map(members.map((member, index) => [batch.members[index].hash, member])).values()];
  return { usage: unique.reduce((sum, member) => addUsage(sum, member.usage), {}),
    usageRun: members.reduce((sum, member) => addUsage(sum, member.reused ? {} : member.usageRun), {}) };
}

/** The batch's warnings: its own, then each member's prefixed with the file. */
export const batchWarnings = (own, members) => [...new Set([...own, ...members.flatMap(member => (member.warnings || []).map(warning => `${member.filename}：${warning}`))])];

/** The published shape of an assembled batch: source ids, combined volumes and the corrections of every member. */
export function assembleBatch(batch, included, results) {
  const documents = batchDocuments(batch.title, included, results);
  const ids = documents.map((_, index) => `audio-batch-${batch.id}${index ? `-p${index + 1}` : ''}`);
  const corrections = { applied: results.flatMap(result => result.corrections.applied), skipped: results.flatMap(result => result.corrections.skipped) };
  const members = included.map(member => ({ order: member.index + 1, filename: member.filename, hash: member.hash }));
  return { documents, ids, corrections, members,
    uncertain: corrections.skipped.filter(correction => correction.skipped === 'low-confidence').length };
}
