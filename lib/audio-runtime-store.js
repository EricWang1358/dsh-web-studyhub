import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createReadStream } from 'node:fs';
import { atomicJson } from './atomic-json.js';
import { readAudioBatch } from './audio-batch.js';
import { createManifestJobStore } from './jobs/store.js';
import { recordAudioUsage, validateAudioUsageLedger } from './audio-dashboard.js';

const fail = code => Object.assign(new Error(code), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const artifactName = stepKey => `checkpoints/${digest(stepKey)}.json`;
/** Single-audio domain adapter. It keeps input/checkpoint/source knowledge out of
 * the kernel; only createManifestJobStore writes runtimeJob and its facade. */
export function createSingleAudioPersistence(root, { library, notifications = [] } = {}) {
  return Object.freeze({ async open({ singleId }) {
    if (!/^[\w-]{8,64}$/.test(singleId || '')) throw fail('input-unavailable');
    const record = await readAudioBatch(root, singleId);
    if (record.kind !== 'single' || record.id !== singleId || !record.input?.hash) throw fail('input-unavailable');
    const directory = join(root, 'audio-batches', singleId), inputRef = { id: singleId, hash: digest({ input: record.input, args: record.args }), size: record.input.size };
    const pathFor = async ref => {
      if (typeof ref !== 'string' || !/^checkpoints\/[a-f0-9]{64}\.json$/.test(ref)) throw fail('checkpoint-invalid');
      const file = resolve(directory, ref), [base, actual] = await Promise.all([realpath(directory), realpath(file)]);
      const tail = relative(base, actual);
      if (!tail || tail === '..' || tail.startsWith(`..${sep}`)) throw fail('checkpoint-invalid');
      return file;
    };
    const readPrepared = async stepKey => {
      try {
        const file = await pathFor(artifactName(stepKey)), bytes = await readFile(file), value = JSON.parse(bytes.toString('utf8'));
        if (value.version !== 1 || value.stepKey !== stepKey || value.inputHash !== record.input.hash || value.context !== digest(record.args) ||
            !Array.isArray(value.sources) || !value.sources.length || value.sources.some(source => typeof source.id !== 'string' || typeof source.text !== 'string')) throw fail('checkpoint-invalid');
        return { value, checkpoint: { version: 1, ref: artifactName(stepKey), digest: bytesDigest(bytes), stepKey } };
      } catch (error) { throw error.code === 'checkpoint-invalid' ? error : fail('checkpoint-invalid'); }
    };
    const validateCheckpoint = async checkpoint => {
      if (checkpoint?.version !== 1 || checkpoint.ref !== artifactName(checkpoint.stepKey)) throw fail('checkpoint-invalid');
      const prepared = await readPrepared(checkpoint.stepKey);
      if (prepared.checkpoint.digest !== checkpoint.digest) throw fail('checkpoint-invalid');
    };
    const reconcileCommit = async commit => {
      const { value, checkpoint } = await readPrepared(commit.stepKey), state = await library.read();
      const present = value.sources.map(expected => {
        const actual = state.sources?.find(source => source.id === expected.id);
        if (actual && actual.text !== expected.text) throw fail('artifact-conflict');
        return !!actual;
      });
      if (present.every(Boolean)) return { refs: value.sources.map(source => ({ kind: 'source', id: source.id })), checkpoint };
      if (present.every(value => !value)) return { notPublished: true };
      throw fail('artifact-conflict');
    };
    return Object.freeze({ input: { ...structuredClone(record.args), singleId, inputHash: record.input.hash }, inputRef, notifications,
      store: createManifestJobStore(join(directory, 'manifest.json'), { projectLegacy: (contract, previous) => { const { finishedAt: _finishedAt, ...retained } = previous || {}; return ({ ...retained,
        id: contract.runtime.legacyId, type: contract.kind, singleId, status: contract.status === 'interrupted' ? 'failed' : ['paused', 'pausing'].includes(contract.status) ? 'running' : contract.status,
        stage: contract.stage.text || contract.stage.code, startedAt: contract.startedAt, ...(contract.finishedAt ? { finishedAt: contract.finishedAt } : {}),
        sourceIds: contract.result.refs.filter(ref => ref.kind === 'source').map(ref => ref.id), retryable: contract.capabilities.retry && contract.status !== 'complete' }); } }),
      async validateInput(expected) {
        const latest = await readAudioBatch(root, singleId);
        if (expected.id !== singleId || expected.hash !== digest({ input: latest.input, args: latest.args }) || expected.size !== latest.input?.size) throw fail('input-changed');
        let info, hash;
        try {
          info = await stat(latest.args.path); if (!info.isFile()) throw fail('input-unavailable');
          hash = createHash('sha256'); for await (const bytes of createReadStream(latest.args.path)) hash.update(bytes);
        } catch { throw fail('input-unavailable'); }
        if (info.size !== expected.size || hash.digest('hex') !== latest.input.hash) throw fail('input-changed');
      },
      validateCheckpoint, reconcileCommit, validateAccounting: validateAudioUsageLedger,
      replayCall: call => call.ledgerEvent ? recordAudioUsage({ ...call.ledgerEvent, callId: call.callId }) : Promise.reject(fail('ledger-invalid')),
      async prepareArtifacts(stepKey, sources) {
        if (!Array.isArray(sources) || !sources.length || new Set(sources.map(source => source.id)).size !== sources.length) throw fail('artifact-conflict');
        const file = join(directory, artifactName(stepKey)); await mkdir(dirname(file), { recursive: true });
        const value = { version: 1, stepKey, inputHash: record.input.hash, context: digest(record.args), sources: structuredClone(sources) };
        await atomicJson(file, value);
        return { sources: structuredClone(sources), checkpoint: { version: 1, ref: artifactName(stepKey), digest: digest(value), stepKey } };
      },
      async readPreparedArtifacts(stepKey) { const { value, checkpoint } = await readPrepared(stepKey); return { sources: value.sources, checkpoint }; },
      async publishArtifacts(prepared, { assertCurrent }) {
        // The existing serialized library transaction checks authority at the
        // actual mutation boundary, after any wait for its lock.
        assertCurrent();
        if (library.publishSources) {
          if (library.publishSources.supportsAttemptGuard !== true) throw fail('artifact-guard-unsupported');
          await library.publishSources(prepared.sources, { assertCurrent });
        }
        else await library.update(state => {
          assertCurrent();
          for (const source of prepared.sources) {
            const existing = state.sources.find(item => item.id === source.id);
            if (existing && existing.text !== source.text) throw fail('artifact-conflict');
            if (!existing) state.sources.push(structuredClone(source));
          }
        });
        return { refs: prepared.sources.map(source => ({ kind: 'source', id: source.id })), checkpoint: prepared.checkpoint };
      },
    });
  } });
}
