import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicJson } from './atomic-json.js';
import { readAudioBatch, saveAudioBatch } from './audio-batch.js';
import { checkpointResult, findChangedMember, memberContext, memberResultName, readMemberResult } from './audio-batch-members.js';
import { createManifestJobStore } from './jobs/store.js';
import { createPreparedArtifacts } from './audio-runtime-artifacts.js';
import { artifactName, bytesDigest, checkpointFile, digest, fail, ledgerPort, legacyProjection, safeControls, safeSettings, validSettings } from './audio-runtime-common.js';

/** A finished member is committed under this step key (`member:<index>`); its result file is the commit's artifact. */
export const MEMBER_STEP = 'member:';
/** The one step that publishes the assembled batch. */
export const ASSEMBLE_STEP = 'assemble:1';
const PHASES = ['queued', 'members', 'assemble'];

/** What identifies a batch to the runtime: its title, submitted context and the bytes of each member (not what was skipped or finished). */
const identityOf = batch => ({ title: batch.title, args: batch.args,
  members: batch.members.map(({ index, filename, hash, size }) => ({ index, filename, hash, size })) });

/** A refusal to bring a batch back, with the file that changed named (the kernel keeps only the code of a failed check). */
export async function explainBatchRefusal(root, batchId, error) {
  const changed = error?.code === 'input-changed' ? await findChangedMember(await readAudioBatch(root, batchId)).catch(() => null) : null;
  return changed ? Object.assign(error, { member: changed.member.filename }) : error;
}

/** Audio-batch domain adapter: member result files are the member commits, the assembled sources the one publish step.
 * Only createManifestJobStore writes runtimeJob and the legacy card; members keep their own state in the same manifest. */
export function createBatchAudioPersistence(root, { library, notifications = [] } = {}) {
  return Object.freeze({ async open({ batchId }) {
    if (!/^[\w-]{8,64}$/.test(batchId || '')) throw fail('input-unavailable');
    const record = await readAudioBatch(root, batchId);
    if (record.kind === 'single' || record.id !== batchId || !Array.isArray(record.members) || !record.members.length) throw fail('input-unavailable');
    const directory = join(root, 'audio-batches', batchId);
    const inputRef = { id: batchId, hash: digest(identityOf(record)), size: record.members.reduce((sum, member) => sum + member.size, 0) };
    const context = memberContext(record), artifacts = createPreparedArtifacts({ directory, identity: { inputHash: inputRef.hash, context }, library });
    const resultFile = index => join(directory, memberResultName(index));
    const memberOf = (batch, index) => batch.members.find(member => member.index === index);

    const readCheckpoint = async checkpoint => {
      try {
        if (checkpoint?.version !== 1 || checkpoint.ref !== artifactName(checkpoint.stepKey)) throw fail('checkpoint-invalid');
        const bytes = await readFile(await checkpointFile(directory, checkpoint.ref));
        if (bytesDigest(bytes) !== checkpoint.digest) throw fail('checkpoint-invalid');
        const value = JSON.parse(bytes.toString('utf8'));
        if (value.kind === 'batch') {
          if (value.version !== 2 || value.stepKey !== checkpoint.stepKey || value.inputHash !== inputRef.hash || value.context !== context ||
              !PHASES.includes(value.phase) || !validSettings(value.settings)) throw fail('checkpoint-invalid');
          safeControls(value.controls || {});
        } else await artifacts.validate(checkpoint.stepKey);
        return value;
      } catch { throw fail('checkpoint-invalid'); }
    };
    const validateCheckpoint = async checkpoint => { await readCheckpoint(checkpoint); };

    const reconcileMember = async commit => {
      const batch = await readAudioBatch(root, batchId), member = memberOf(batch, Number(commit.stepKey.slice(MEMBER_STEP.length)));
      return member && await readMemberResult(resultFile(member.index), batch, member) ? { refs: [] } : { notPublished: true };
    };
    const validateMembers = async latest => {
      const changed = await findChangedMember(latest);
      if (changed) throw Object.assign(fail(changed.code), { member: changed.member.filename });
    };

    return Object.freeze({ input: { ...structuredClone(record.args), batchId, title: record.title }, inputRef, notifications, ...ledgerPort,
      store: createManifestJobStore(join(directory, 'manifest.json'), { projectLegacy: legacyProjection(() => ({ batchId })) }),
      async validateInput(expected) {
        const latest = await readAudioBatch(root, batchId);
        if (expected.id !== batchId || expected.hash !== digest(identityOf(latest))) throw fail('input-changed');
        // A finished batch has nothing left to read; every other one must still find the exact bytes it was given.
        if (latest.job?.status !== 'complete') await validateMembers(latest);
      },
      validateCheckpoint,
      reconcileCommit: commit => commit.stepKey.startsWith(MEMBER_STEP) ? reconcileMember(commit) : artifacts.reconcile(commit),
      /** The batch's manifest as the pipeline needs it (the runtime record in it belongs to the kernel). */
      async loadBatch() { const { runtimeJob: _kernelOwned, ...batch } = await readAudioBatch(root, batchId); return batch; },
      saveMembers: batch => saveAudioBatch(root, batch),
      readMember: (batch, member) => readMemberResult(resultFile(member.index), batch, member),
      /** The publish half of a member's commit: the result file, written only while the attempt is still current. */
      memberPublisher: { async publish({ batch, member, result, progress }, { assertCurrent }) {
        assertCurrent();
        await atomicJson(resultFile(member.index), checkpointResult(batch, member, result, progress));
        return { refs: [] };
      } },
      /** The settings and console controls a paused batch resumes with (those of the checkpoint it paused at, else the ones given). */
      async createCheckpointer(settings, checkpoint = null) {
        const prior = checkpoint ? await readCheckpoint(checkpoint) : null;
        if (prior && prior.kind !== 'batch') throw fail('checkpoint-invalid');
        const effective = safeSettings(prior?.settings || settings);
        return Object.freeze({ settings: structuredClone(effective), controls: safeControls(prior?.controls || {}),
          async save(phase, values = {}) {
            const controls = safeControls(values), stepKey = `batch:${digest({ phase, settings: effective, controls })}`, ref = artifactName(stepKey);
            const value = { version: 2, kind: 'batch', stepKey, inputHash: inputRef.hash, context, phase, settings: effective, controls };
            const file = join(directory, ref);
            await mkdir(dirname(file), { recursive: true }); await atomicJson(file, value);
            const saved = { version: 1, ref, digest: digest(value), stepKey };
            await validateCheckpoint(saved); return saved;
          } });
      },
      prepareArtifacts: artifacts.prepare, readPreparedArtifacts: artifacts.readPrepared, publishArtifacts: artifacts.publish,
    });
  } });
}
