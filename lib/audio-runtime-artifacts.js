import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicJson } from './atomic-json.js';
import { artifactName, bytesDigest, checkpointFile, digest, fail } from './audio-runtime-common.js';

/* The prepared sources of an audio job (what its one publish step will write into the library) and their publication.
   `identity` ties a prepared file to the job it was made for: { inputHash, context }. Shared by every audio job kind that
   publishes sources, so single imports and batches reconcile and publish the same way. */

const sourcesValid = sources => Array.isArray(sources) && sources.length > 0 && sources.every(source => typeof source.id === 'string' && typeof source.text === 'string');

export function createPreparedArtifacts({ directory, identity, library }) {
  const read = async stepKey => {
    try {
      const bytes = await readFile(await checkpointFile(directory, artifactName(stepKey))), value = JSON.parse(bytes.toString('utf8'));
      if (value.version !== 1 || value.stepKey !== stepKey || value.inputHash !== identity.inputHash || value.context !== identity.context || !sourcesValid(value.sources)) throw fail('checkpoint-invalid');
      return { value, checkpoint: { version: 1, ref: artifactName(stepKey), digest: bytesDigest(bytes), stepKey } };
    } catch (error) { throw error.code === 'checkpoint-invalid' ? error : fail('checkpoint-invalid'); }
  };
  return Object.freeze({
    validate: async stepKey => { await read(stepKey); },
    async reconcile(commit) {
      const { value, checkpoint } = await read(commit.stepKey), state = await library.read();
      const present = value.sources.map(expected => {
        const actual = state.sources?.find(source => source.id === expected.id);
        if (actual && actual.text !== expected.text) throw fail('artifact-conflict');
        return !!actual;
      });
      if (present.every(Boolean)) return { refs: value.sources.map(source => ({ kind: 'source', id: source.id })), checkpoint };
      if (present.every(item => !item)) return { notPublished: true };
      throw fail('artifact-conflict');
    },
    async prepare(stepKey, sources) {
      if (!Array.isArray(sources) || !sources.length || new Set(sources.map(source => source.id)).size !== sources.length) throw fail('artifact-conflict');
      const file = join(directory, artifactName(stepKey));
      await mkdir(dirname(file), { recursive: true });
      const value = { version: 1, stepKey, ...identity, sources: structuredClone(sources) };
      await atomicJson(file, value);
      return { sources: structuredClone(sources), checkpoint: { version: 1, ref: artifactName(stepKey), digest: digest(value), stepKey } };
    },
    async readPrepared(stepKey) { const { value, checkpoint } = await read(stepKey); return { sources: value.sources, checkpoint }; },
    async publish(prepared, { assertCurrent }) {
      // The existing serialized library transaction checks authority at the actual mutation boundary, after any wait for its lock.
      assertCurrent();
      if (library.publishSources) {
        if (library.publishSources.supportsAttemptGuard !== true) throw fail('artifact-guard-unsupported');
        await library.publishSources(prepared.sources, { assertCurrent });
      } else await library.update(state => {
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
}
