import { LEGACY_AUDIO_TYPE } from '../../../audio-runtime-common.js';
import { batchUsage, batchWarnings } from '../../../audio-batch-members.js';
import { MEMBER_STEP } from '../../../audio-batch-runtime-store.js';
import { addUsage } from '../../../token-usage.js';
import { presentAudio } from './view.js';

/** Card fields existing readers (tools, inbox, audio page, console) keep reading from a batch. */
export const BATCH_FIELDS = Object.freeze(['filename', 'batchId', 'phase', 'done', 'total', 'members', 'warnings', 'sourceIds', 'usage', 'usageRun',
  'retryable', 'language', 'parallel', 'courses', 'textProvider', 'corrected', 'uncertain', 'blocked']);

/** The working card of one attempt: the batch as the audio page knows it, with one progress row per member (the files the pipeline fills in). */
export function batchView(record, { language, settings }) {
  const members = record.members.map(member => ({ ...member.progress, index: member.index, filename: member.filename,
    status: member.skipped ? 'skipped' : member.status, phase: member.status === 'complete' ? 'done' : 'queued' }));
  return { ...record.job, type: LEGACY_AUDIO_TYPE, batchId: record.id, filename: record.title, courses: record.args.courses, language,
    textProvider: settings.textProvider, warnings: [...(record.job?.warnings || [])], members };
}

/** The tokens the model calls of one file spent, from the gateway's calls (a file's steps are named after it). */
const tokensOf = (calls, index) => calls.filter(call => call.modelRequest && call.tokenUsage && call.stepKey.startsWith(`${MEMBER_STEP}${index}:`))
  .reduce((sum, call) => addUsage(sum, { ...call.tokenUsage, calls: 1 }), null);

/** What the batch has done so far, derived from its members: files finished, what it spent (each recording once) and the warnings of every file. */
const tally = (view, record, own, calls) => {
  view.members.forEach((member, index) => { const tokenUsage = tokensOf(calls, index); if (tokenUsage) member.tokenUsage = tokenUsage; });
  const counted = view.members.filter(member => member.status !== 'skipped');
  return { done: counted.filter(member => member.status === 'complete').length, total: counted.length,
    warnings: batchWarnings(own, view.members), ...batchUsage(record, view.members) };
};

/** Presentation reader of a batch attempt; the tallies are read from the members each time, never kept twice. */
export const presentBatch = (view, record) => {
  const own = [...view.warnings];
  return presentAudio(view, { fields: BATCH_FIELDS, refresh: (card, observed) => Object.assign(card, tally(card, record, own, observed.calls)) });
};
