import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, readJsonFile } from './atomic-json.js';
import { createManifestJobStore } from './jobs/store.js';
import { checkpointHolds } from './contexts/generation/jobs/checkpoint-ref.js';
import { repairCheckpointHolds } from './contexts/generation/jobs/repair-checkpoint.js';
import { PUBLISH_STEP, reconcilePublication } from './contexts/generation/jobs/publish-reconcile.js';
import { INPUT_VERSION, checkpointStatus, hashSources } from './contexts/generation/jobs/input-ref.js';

/* The durable side of a generation run: one small manifest per run in <library>/generation-runs/, written only by the runtime's store
   (createManifestJobStore). It holds the request as it was asked (`args`) and the runtime's record of the job; everything else about the run is
   the draft, which stays the one checkpoint. A run that is done leaves nothing behind (`forget`), one that was cut short is found again by `scan`.
   A publication also keeps, beside its manifest, the plan its write follows (<id>.publish.json): what the check decided and what the write will leave in the library. It is the
   domain's own record, outside the runtime's envelope: it is written before the write, and it is what a later look compares the library with. */

const fail = code => Object.assign(new Error(code), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const RECORD = 'generation-run';

export function createRunStore({ root, read, definitionRef }) {
  const directory = join(root, 'generation-runs'), fileOf = id => join(directory, `${id}.json`), planFileOf = id => join(directory, `${id}.publish.json`);
  const load = id => readJsonFile(fileOf(id)).catch(() => { throw fail('input-unavailable'); });

  /** What the library must still hold for this run to go on: the things the request names, and what the run's draft was written from. */
  async function inputHolds(record) {
    const state = await read(), { args } = record;
    // A publication is judged when it is looked at again (reconcileCommit): the draft may well be gone because the write happened.
    if (record.definition === 'draft-publish') return;
    // A repair names its draft and nothing else: the draft as it is now is what it goes on from.
    if (record.definition === 'draft-repair') { if (!state.drafts.some(draft => draft.id === args.id)) throw fail('input-unavailable'); return; }
    const wanted = [...(args.sourceIds || []), ...(args.extraSourceIds || [])];
    if (wanted.some(id => !state.sources.some(source => source.id === id))) throw fail('input-unavailable');
    if (args.resumeDraftId && !state.drafts.some(draft => draft.id === args.resumeDraftId)) throw fail('input-unavailable');
    if (args.deckId && !state.decks.some(deck => deck.id === args.deckId && !deck.archived)) throw fail('input-unavailable');
    const jobId = record.runtimeJob?.contract?.jobId;
    const saved = jobId && state.drafts.find(item => item.editorial?.generation?.runId === jobId)?.editorial.generation.inputRef;
    if (!saved) return;
    const current = { version: INPUT_VERSION, definition: definitionRef(record.definition), sources: hashSources(saved.sources.map(({ id }) => state.sources.find(item => item.id === id) || { id, text: null })) };
    const status = checkpointStatus(saved, current);
    if (status.reason === 'definition') throw fail('definition-version-mismatch');
    if (status.reason === 'sources') throw fail('input-changed');
  }

  return Object.freeze({
    /** `{ kind, args }` for a new run, `{ run }` for one found on disk. Returns the persistence port the runtime's durability needs. */
    async open(input) {
      const id = input.run || randomUUID(), file = fileOf(id);
      const plan = Object.freeze({ save: value => atomicJson(planFileOf(id), { kind: 'publish-plan', id, plan: value }),
        load: () => readJsonFile(planFileOf(id)).then(saved => (saved?.kind === 'publish-plan' && saved.id === id ? saved.plan : null), () => null) });
      if (!input.run) { await mkdir(directory, { recursive: true }); await atomicJson(file, { kind: RECORD, id, definition: input.kind, args: input.args }); }
      const record = await load(id);
      if (record.kind !== RECORD || record.id !== id || !record.args || typeof record.definition !== 'string') throw fail('input-unavailable');
      return Object.freeze({ input: { kind: record.definition, args: structuredClone(record.args) }, inputRef: { id, hash: digest(record.args), size: JSON.stringify(record.args).length },
        store: createManifestJobStore(file),
        async validateInput(expected) {
          const latest = await load(id);
          if (expected.id !== id || expected.hash !== digest(latest.args) || expected.size !== JSON.stringify(latest.args).length) throw fail('input-changed');
          await inputHolds(latest);
        },
        // The checkpoint is the draft as the run last saved it: a draft the learner edited or deleted since is not continued automatically.
        async validateCheckpoint(checkpoint) {
          const repair = String(checkpoint?.stepKey || '').startsWith('repair:');
          const draftId = String(checkpoint?.stepKey || '').replace(/^(draft|repair):/, ''), draft = (await read()).drafts.find(item => item.id === draftId);
          if (!(repair ? repairCheckpointHolds : checkpointHolds)(checkpoint, draft)) throw fail('checkpoint-invalid');
        },
        // A generation run commits through the draft's own saves; the one artifact commit is a publication, found again by looking at what its plan said the write would leave.
        plan,
        reconcileCommit: async commit => {
          const planned = commit.stepKey === PUBLISH_STEP ? await plan.load() : null;
          return planned ? reconcilePublication(planned.expect, await read()) : null;
        },
      });
    },
    /** The runs on disk: { id, kind, status, at } with the status the runtime last recorded (absent before its first record) and when the record last changed. */
    async scan() {
      const names = await readdir(directory).catch(() => []), found = [];
      for (const name of names.filter(item => item.endsWith('.json'))) {
        const record = await readJsonFile(join(directory, name)).catch(() => null);
        if (record?.kind === RECORD) found.push({ id: record.id, kind: record.definition, status: record.runtimeJob?.contract?.status ?? null, at: (await stat(join(directory, name))).mtimeMs });
      }
      return found;
    },
    forget: async id => { await rm(planFileOf(id), { force: true }); await rm(fileOf(id), { force: true }); },
  });
}
