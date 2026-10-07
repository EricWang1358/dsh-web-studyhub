import Schema from 'schemastery';
import { atomicJson, readJsonFile, serializeJsonFile } from '../atomic-json.js';
import { validateRuntimeContract } from './contract.js';

const failure = code => Object.assign(new Error(code), { code });
const word = () => Schema.string().min(1).required();
const integer = minimum => Schema.number().min(minimum).step(1).required();
const nullable = schema => Schema.union([Schema.const(null), schema]);
const closed = fields => Schema.transform(Schema.any().required(), value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(fields, key))) throw failure('invalid-store-shape');
  return Schema.object(fields)(value);
}, true);
const Input = closed({ id: word(), hash: word(), size: integer(0) });
const Checkpoint = closed({ version: Schema.const(1).required(), ref: word(), digest: word(), stepKey: word() });
const Witness = closed({ pid: integer(1), host: word(), instance: word() });
// The persisted shapes stay exactly what the previous release (v2.7.1) reads, so turning the switches off and going back to it keeps every library
// readable (tests/unified-runtime-rollback-shape.test.mjs checks the written manifests against that release's own validators).
const Intent = closed({ callId: word(), attemptId: word(), stepKey: word(), stepRunId: word(),
  status: Schema.union(['pending', 'completed', 'not-dispatched']).required(), remoteOperationId: Schema.string().min(1) });
const Commit = closed({ stepKey: word(), attemptId: word(), status: Schema.union(['pending', 'complete']).required(), receipt: Schema.any() });
const Delivery = closed({ eventId: word(), channel: word(), status: Schema.union(['claimed', 'delivered', 'failed']).required() });
const Envelope = closed({ schemaVersion: Schema.const(1).required(), revision: integer(0), contract: Schema.any().required(), inputRef: Input.required(),
  checkpoint: nullable(Checkpoint), executorWitness: nullable(Witness), requestIntents: Schema.array(Intent).required(),
  commits: Schema.array(Commit).required(), deliveries: Schema.array(Delivery).required() });
function assertPlain(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw failure('invalid-store-shape');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) throw failure('invalid-store-shape');
    assertPlain(descriptor.value);
  }
}
export function validateStoredJob(value) {
  if (value?.schemaVersion !== 1) throw failure('unsupported-store-version');
  let stored;
  try {
    assertPlain(value);
    // Canonical validation also rejects non-JSON values carried by the contract.
    const contract = validateRuntimeContract(value.contract);
    for (const key of ['checkpoint', 'executorWitness']) if (!Object.hasOwn(value, key) || value[key] === undefined) throw failure('invalid-store-shape');
    JSON.stringify(value, function (key, entry) {
      const raw = this[key];
      if (raw === undefined || ['function', 'symbol', 'bigint'].includes(typeof raw) || (typeof raw === 'number' && !Number.isFinite(raw))) throw failure('invalid-store-shape');
      return entry;
    });
    stored = Envelope(structuredClone(value)); stored.contract = contract;
    if (!Number.isSafeInteger(stored.revision) || !Number.isSafeInteger(stored.inputRef.size)) throw failure('invalid-store-shape');
  } catch (error) { throw Object.assign(failure('invalid-store-shape'), { cause: error }); }
  const unique = (items, key) => { const keys = items.map(key); if (new Set(keys).size !== keys.length) throw failure('invalid-store-reference'); };
  for (const commit of stored.commits) if (!Object.hasOwn(commit, 'receipt')) throw failure('invalid-store-shape');
  unique(stored.requestIntents, item => item.callId); unique(stored.commits, item => `${item.attemptId}:${item.stepKey}`);
  unique(stored.deliveries, item => `${item.eventId}:${item.channel}`);
  const { attempts, steps } = stored.contract.runtime;
  for (const item of [...stored.requestIntents, ...stored.commits]) if (!attempts.some(attempt => attempt.attemptId === item.attemptId)) throw failure('invalid-store-reference');
  const stepMatches = item => step => step.stepRunId === item.stepRunId && step.stepKey === item.stepKey && step.attemptId === item.attemptId;
  for (const item of stored.requestIntents) if (!steps.some(stepMatches(item))) throw failure('invalid-store-reference');
  for (const item of stored.deliveries) if (!stored.contract.events.some(event => event.eventId === item.eventId)) throw failure('invalid-store-reference');
  return stored;
}

/** Trusted domain code chooses the existing manifest path and legacy projection.
 * No new Job index/file; revision conflicts never overwrite another writer. */
export function createManifestJobStore(file, { projectLegacy } = {}) {
  return Object.freeze({
    load: () => serializeJsonFile(file, async () => {
      const manifest = await readJsonFile(file);
      return Object.hasOwn(manifest, 'runtimeJob') ? validateStoredJob(manifest.runtimeJob) : null;
    }),
    save(value, { expectedRevision } = {}) {
      const next = validateStoredJob(value);
      return serializeJsonFile(file, async () => {
        const manifest = await readJsonFile(file);
        const current = Object.hasOwn(manifest, 'runtimeJob') ? validateStoredJob(manifest.runtimeJob) : null;
        if ((current?.revision ?? null) !== expectedRevision) {
          console.error(`[study] revision-conflict in save: manifest at ${current?.revision ?? 'none'}, the writer expected ${expectedRevision ?? 'none'}`);
          throw failure('revision-conflict');
        }
        if (current && current.contract.jobId !== next.contract.jobId) throw failure('job-identity-conflict');
        next.revision = (current?.revision || 0) + 1;
        manifest.runtimeJob = next;
        if (projectLegacy) manifest.job = structuredClone(projectLegacy(next.contract, manifest.job));
        await atomicJson(file, manifest);
        return structuredClone(next);
      });
    },
  });
}
