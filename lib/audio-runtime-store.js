import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicJson } from './atomic-json.js';
import { readAudioBatch } from './audio-batch.js';
import { createManifestJobStore } from './jobs/store.js';
import { createPreparedArtifacts } from './audio-runtime-artifacts.js';
import { artifactName, bytesDigest, checkpointFile, digest, fail, ledgerPort, legacyProjection, safeControls, safeSettings, validSettings, within } from './audio-runtime-common.js';

const cacheName = name => typeof name === 'string' &&
  /^(?:raw-[a-f0-9]{8}-\d+|proof-[a-f0-9]{8}-[a-f0-9]{8}-\d+-[a-f0-9]{8}|part-[a-f0-9]{8}-[a-f0-9]{8}-\d+-[a-f0-9]{8}|title-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{8}|usage)\.json$/.test(name);
const PHASES = ['queued', 'transcribe', 'proofread', 'translate', 'title', 'publish'];

/** Single-audio domain adapter. It keeps input/checkpoint/source knowledge out of
 * the kernel; only createManifestJobStore writes runtimeJob and its facade. */
export function createSingleAudioPersistence(root, { library, notifications = [] } = {}) {
  return Object.freeze({ async open({ singleId }) {
    if (!/^[\w-]{8,64}$/.test(singleId || '')) throw fail('input-unavailable');
    const record = await readAudioBatch(root, singleId);
    if (record.kind !== 'single' || record.id !== singleId || !record.input?.hash) throw fail('input-unavailable');
    const directory = join(root, 'audio-batches', singleId), inputRef = { id: singleId, hash: digest({ input: record.input, args: record.args }), size: record.input.size };
    const context = digest(record.args), artifacts = createPreparedArtifacts({ directory, identity: { inputHash: record.input.hash, context }, library });
    const cacheDirectory = join(root, 'audio-cache', record.input.hash.slice(0, 16));
    const cacheFile = async (name, existing = true) => {
      if (!cacheName(name)) throw fail('checkpoint-invalid');
      await mkdir(cacheDirectory, { recursive: true });
      const base = await realpath(root), directoryReal = await realpath(cacheDirectory);
      const file = join(directoryReal, name), actual = existing ? await realpath(file) : file;
      if (!within(base, actual)) throw fail('checkpoint-invalid');
      return file;
    };
    const validPipeline = value => value.stepKey && value.inputHash === record.input.hash && value.context === context && PHASES.includes(value.phase) &&
      validSettings(value.settings) && Array.isArray(value.files) && new Set(value.files.map(item => item.name)).size === value.files.length;
    const readCheckpoint = async checkpoint => {
      try {
        if (checkpoint?.version !== 1 || checkpoint.ref !== artifactName(checkpoint.stepKey)) throw fail('checkpoint-invalid');
        const bytes = await readFile(await checkpointFile(directory, checkpoint.ref));
        if (bytesDigest(bytes) !== checkpoint.digest) throw fail('checkpoint-invalid');
        const value = JSON.parse(bytes.toString('utf8'));
        if (value.version === 2 && value.kind === 'pipeline') {
          if (value.stepKey !== checkpoint.stepKey || !validPipeline(value)) throw fail('checkpoint-invalid');
          safeControls(value.controls || {});
          for (const item of value.files) {
            const cached = await readFile(await cacheFile(item.name));
            if (bytesDigest(cached) !== item.digest) throw fail('checkpoint-invalid');
            JSON.parse(cached.toString('utf8'));
          }
        } else await artifacts.validate(checkpoint.stepKey);
        return value;
      } catch { throw fail('checkpoint-invalid'); }
    };
    const validateCheckpoint = async checkpoint => { await readCheckpoint(checkpoint); };
    return Object.freeze({ input: { ...structuredClone(record.args), singleId, inputHash: record.input.hash }, inputRef, notifications,
      store: createManifestJobStore(join(directory, 'manifest.json'), { projectLegacy: legacyProjection(() => ({ singleId })) }),
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
      async createPipelineCache(settings, checkpoint = null) {
        const prior = checkpoint ? await readCheckpoint(checkpoint) : null;
        if (prior && prior.kind !== 'pipeline') throw fail('checkpoint-invalid');
        const effective = safeSettings(prior?.settings || settings), files = new Map((prior?.files || []).map(item => [item.name, item.digest]));
        const cache = Object.freeze({
          async get(name) {
            if (!cacheName(name)) throw fail('checkpoint-invalid');
            try {
              const bytes = await readFile(await cacheFile(name)), value = JSON.parse(bytes.toString('utf8'));
              if (name !== 'usage.json') files.set(name, bytesDigest(bytes)); return value;
            } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
          },
          async set(name, value) {
            const file = await cacheFile(name, false); await atomicJson(file, value);
            if (name !== 'usage.json') files.set(name, bytesDigest(await readFile(file)));
          },
        });
        return Object.freeze({ settings: structuredClone(effective), controls: safeControls(prior?.controls || {}), cache,
          async checkpoint(phase, values = {}) {
            const controls = safeControls(values), completed = [...files].map(([name, fileDigest]) => ({ name, digest: fileDigest }));
            const stepKey = `pipeline:${digest({ phase, settings: effective, controls, files: completed })}`, ref = artifactName(stepKey), file = join(directory, ref);
            const value = { version: 2, kind: 'pipeline', stepKey, inputHash: record.input.hash, context, phase, settings: effective, controls, files: completed };
            await mkdir(dirname(file), { recursive: true }); await atomicJson(file, value);
            const saved = { version: 1, ref, digest: digest(value), stepKey };
            await validateCheckpoint(saved); return saved;
          },
        });
      },
      validateCheckpoint, reconcileCommit: artifacts.reconcile, ...ledgerPort,
      prepareArtifacts: artifacts.prepare, readPreparedArtifacts: artifacts.readPrepared, publishArtifacts: artifacts.publish,
    });
  } });
}
