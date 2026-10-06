import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { recordAudioUsage, validateAudioUsageLedger } from './audio-dashboard.js';

/* What every audio job kind on the runtime shares in its persistence port: error codes, digests, checkpoint file
   names and containment, the settings and console controls a checkpoint may carry, and the legacy card projection. */

/** The `type` every audio card of the manifest family carries for readers that predate the runtime. */
export const LEGACY_AUDIO_TYPE = 'audio-import';
export const fail = code => Object.assign(new Error(code), { code });
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const bytesDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export const artifactName = stepKey => `checkpoints/${digest(stepKey)}.json`;

export const SETTING_KEYS = Object.freeze(['transcribeModel', 'textModel', 'textProvider', 'mode', 'languageCodes', 'partMinutes',
  'proofreadReasoning', 'translateReasoning', 'transcribeConcurrency', 'textConcurrency']);
export const CONTROL_KEYS = Object.freeze(['textConcurrency', 'transcribeConcurrency', 'proofreadReasoning', 'translateReasoning', 'autoBackoff']);
const SCALARS = ['number', 'string', 'boolean'];

/** The console control values a checkpoint may carry: known keys, scalar values. */
export function safeControls(value) {
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : null;
  if (!entries || entries.some(([key, item]) => !CONTROL_KEYS.includes(key) || !SCALARS.includes(typeof item))) throw fail('checkpoint-invalid');
  return structuredClone(value);
}
/** The settings a resumed attempt keeps (never keys or credentials). */
export const safeSettings = settings => Object.fromEntries(SETTING_KEYS.filter(key => settings[key] !== undefined).map(key => [key, structuredClone(settings[key])]));
export const validSettings = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => SETTING_KEYS.includes(key));

/** Whether `actual` lies inside `base` (both already real paths). */
export function within(base, actual) {
  const tail = relative(base, actual);
  return !!tail && !isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`);
}
/** A checkpoint file of a job folder, by its stored reference; anything outside the folder is refused. */
export async function checkpointFile(directory, ref) {
  if (typeof ref !== 'string' || !/^checkpoints\/[a-f0-9]{64}\.json$/.test(ref)) throw fail('checkpoint-invalid');
  const file = resolve(directory, ref), [base, actual] = await Promise.all([realpath(directory), realpath(file)]);
  if (!within(base, actual)) throw fail('checkpoint-invalid');
  return file;
}

/** The ledger half of a persistence port: validate it before recovery, and replay a call whose usage was not yet recorded. */
export const ledgerPort = Object.freeze({
  validateAccounting: validateAudioUsageLedger,
  replayCall: call => call.ledgerEvent ? recordAudioUsage({ ...call.ledgerEvent, callId: call.callId }) : Promise.reject(fail('ledger-invalid')),
});

/** The legacy card the manifest keeps beside the runtime record: what an older reader (and a rolled-back build) shows.
 * `extra(contract)` adds the kind's own identity fields. */
export const legacyProjection = extra => (contract, previous) => {
  const { finishedAt: _finishedAt, ...retained } = previous || {};
  const status = contract.status === 'interrupted' ? 'failed' : ['paused', 'pausing'].includes(contract.status) ? 'running' : contract.status;
  return { ...retained, id: contract.runtime.legacyId, type: LEGACY_AUDIO_TYPE, ...extra(contract), status,
    stage: contract.stage.text || contract.stage.code, startedAt: contract.startedAt, ...(contract.finishedAt ? { finishedAt: contract.finishedAt } : {}),
    sourceIds: contract.result.refs.filter(ref => ref.kind === 'source').map(ref => ref.id),
    retryable: contract.capabilities.retry && contract.status !== 'complete' };
};
