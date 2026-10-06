import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, readJsonFile } from './atomic-json.js';
import { createManifestJobStore } from './jobs/store.js';
import { checkpointHolds } from './contexts/generation/jobs/checkpoint-ref.js';
import { INPUT_VERSION, checkpointStatus, hashSources } from './contexts/generation/jobs/input-ref.js';

/* The durable side of a generation run: one small manifest per run in <library>/generation-runs/, written only by the runtime's store
   (createManifestJobStore). It holds the request as it was asked (`args`) and the runtime's record of the job; everything else about the run is
   the draft, which stays the one checkpoint. A run that is done leaves nothing behind (`forget`), one that was cut short is found again by `scan`. */

const fail = code => Object.assign(new Error(code), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const RECORD = 'generation-run';

export function createRunStore({ root, read, definitionRef }) {
  const directory = join(root, 'generation-runs'), fileOf = id => join(directory, `${id}.json`);
  const load = id => readJsonFile(fileOf(id)).catch(() => { throw fail('input-unavailable'); });

  /** What the library must still hold for this run to go on: the things the request names, and what the run's draft was written from. */
  async function inputHolds(record) {
    const state = await read(), { args } = record, wanted = [...(args.sourceIds || []), ...(args.extraSourceIds || [])];
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
          const draftId = String(checkpoint?.stepKey || '').replace(/^draft:/, ''), draft = (await read()).drafts.find(item => item.id === draftId);
          if (!checkpointHolds(checkpoint, draft)) throw fail('checkpoint-invalid');
        },
        // A generation run commits through the draft's own saves; it declares no artifact commits of its own yet (S3-6 for publication).
        reconcileCommit: async () => null,
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
    forget: id => rm(fileOf(id), { force: true }),
  });
}
