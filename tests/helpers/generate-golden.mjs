import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { StudyService } from '../../lib/service.js';
import { clusteringModel } from './clustering-model.mjs';
import { corpusWorld, CORPUS_ROUND_LIMIT, weighing } from './record-run-corpus.mjs';
import { settleJob, until } from './wait.mjs';

/* What tests/generation-generate-golden.test.mjs stands on (issue #608): a library with a recording model and what may differ between two runs of the same thing taken out, so that what is
   left is what the code decided. One fixture per side of the runtime switch, because a card of the runtime says more than a card of the legacy path; the prompts are the same on both, and the test checks that. */

const family = process.env.STUDY_RUNTIME_MATRIX;
const FIXTURE = new URL(`../fixtures/generation-generate-golden${family ? `.${family}` : ''}.json`, import.meta.url);
const recording = process.env.STUDY_RECORD_GOLDEN === '1';
const golden = recording ? {} : JSON.parse(await readFile(FIXTURE, 'utf8'));
const legacy = family ? JSON.parse(await readFile(new URL('../fixtures/generation-generate-golden.json', import.meta.url), 'utf8')) : null;
const oneLineEach = entries => `{\n${entries.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n')}\n}\n`;
if (recording) after(() => writeFile(FIXTURE, oneLineEach(Object.entries(golden).sort(([a], [b]) => a.localeCompare(b)))));

/** A call as what was asked (stage, part, round, the digests, the length), not how the host labels it: which model served it and the stage it says differ on the runtime. */
const asked = call => call.split(' | ').slice(1, 7).join(' | ');
export function pinned(name, actual) {
  const value = JSON.parse(JSON.stringify(actual));
  // The runtime asks the model what the legacy path asks, in the same order; only what it says about the job differs.
  if (legacy && value?.calls) assert.deepEqual(value.calls.map(asked), legacy[name].calls.map(asked), `${name}: the same model calls as the legacy path`);
  if (recording) { golden[name] = value; return; }
  assert.ok(Object.hasOwn(golden, name), `no recording for "${name}"`);
  assert.deepEqual(value, golden[name], name);
  assert.equal(JSON.stringify(value), JSON.stringify(golden[name]), `${name}: same keys in the same order`);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const CONTROLLED = /controlled-\d+/g;
/** Keys whose value is a measure of the clock or of the machine: their presence stays pinned, their value does not. */
const CLOCK = /^ms$|Ms$/;

/** Ids by the order they are first seen, times and clock readings as a mark, the folder of the library as a mark. One normalizer per library, so an id keeps its name across a scenario. */
export function normalizer(root) {
  const seen = new Map();
  const roots = [root, root.replaceAll('\\', '/'), root.replaceAll('\\', '\\\\')];
  const text = value => {
    let out = value;
    for (const form of roots) out = out.replaceAll(form, '<root>');
    return out.replace(UUID, id => { if (!seen.has(id)) seen.set(id, `<id${seen.size + 1}>`); return seen.get(id); }).replace(TIME, '<time>').replace(CONTROLLED, '<controlled>');
  };
  const walk = value => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), CLOCK.test(key) && typeof item === 'number' ? '<clock>' : walk(item)]));
  };
  return { walk, text };
}

const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
export const stageOf = system => system.startsWith('Plan a source-grounded') ? 'plan' : system.startsWith('Prepare supported answers') ? 'blueprint' : system.startsWith('Act as a strict') ? 'review'
  : system.startsWith('You author') ? 'author' : system.startsWith('You rate how much') ? 'weigh' : system.slice(0, 24);

/** A library over the corpus world, one by one so the order of the prompts is the code's. `model`: what answers; a press holds its first call so the card can be read as it was seeded. */
export async function goldenLibrary(t, { model = clusteringModel().complete, language, roundLimit = CORPUS_ROUND_LIMIT, light = weighing, seed = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-generate-golden-'));
  const service = new StudyService(root, { coverage: { roundLimit }, ...(language ? { language } : {}) });
  const clean = normalizer(root), calls = [], gate = { armed: false, entered: false, open: null };
  const held = async () => {
    if (!gate.armed || gate.entered) return;
    gate.entered = true;
    await new Promise(resolve => { gate.open = resolve; });
  };
  // In a prompt an id is only a mark: which one was seen first differs between the two sides of the switch, and a prompt says nothing about that.
  const sealed = text => clean.text(text.replace(UUID, '<id>'));
  const record = (kind, system, prompt, context = {}) => calls.push([kind, stageOf(system), context.part ?? '', context.round ?? '', digest(sealed(system)), digest(sealed(prompt)), prompt.length, clean.text(String(context.stage ?? ''))].join(' | '));
  service.complete = async (system, prompt, context = {}) => { record('main', system, prompt, context); await held(); return model(system, prompt, context); };
  if (light) service.light = async (system, prompt, context = {}) => { record('light', system, prompt, context); await held(); return light(system, prompt, context); };
  t.after(async () => { gate.open?.(); await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const world = corpusWorld(), ids = [];
  if (seed) {
    for (const source of world.sources) ids.push((await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio })).id);
    // A second material, outside `ids`, for what is about more than one: an added source, a reference, a raised count.
    await service.call('source.add', { id: 'spare', title: 'Spare notes', text: world.sources[0].text.slice(world.sources[0].text.length >> 1).slice(0, 4000) });
  }
  const cardOf = async jobId => clean.walk((await service.call('snapshot')).jobs.find(job => job.id === jobId) ?? null);
  // What the pipeline wrote down call by call and the contract the console reads are long, and made elsewhere (lib/batch.js, lib/job-contract.js): their digest is enough to say they did not move.
  const short = card => card && { ...card, steps: digest(JSON.stringify(card.steps)), planTargets: digest(JSON.stringify(card.planTargets ?? null)), contract: digest(JSON.stringify(card.contract ?? null)) };
  /** What one call of the operation does, seen from outside: the answer, the card as it was seeded (held at the first model call), the card at the end, the calls in order and the draft it left. */
  const press = async (action, args, { quietModel = false, draftId } = {}) => {
    calls.length = 0;
    Object.assign(gate, { armed: !quietModel, entered: false, open: null });
    const reply = await service.call(action, args);
    let seeded = null;
    if (!quietModel) { await until(() => gate.entered, 'the first model call'); seeded = short(await cardOf(reply.jobId)); gate.armed = false; gate.open(); }
    const settled = await settleJob(service, reply.jobId);
    const state = await service.call('export'), left = state.drafts.find(draft => draft.id === (settled.draftId ?? draftId)) ?? state.drafts.at(-1);
    return clean.walk({ reply, seeded, finished: short(await cardOf(reply.jobId)), calls: [...calls], draft: left ? draftFacts(left) : null,
      decks: state.decks.map(deck => ({ title: deck.title, course: deck.course, cards: deck.cards.length, parts: deck.cards.filter(card => card.part).length })), sources: state.sources.length });
  };
  /** Refused: the message and the code. */
  const refused = (action, args) => service.call(action, args).then(reply => ({ accepted: Object.keys(reply) }), error => ({ message: clean.text(error.message), ...(error.code ? { code: error.code } : {}) }));
  return { root, service, ids, world, calls, clean, gate, press, refused, cardOf };
}

/** What a draft says of how it was made: what the next run reads. */
export const draftFacts = draft => ({ id: draft.id, title: draft.title, course: draft.course, folder: draft.folder, mergeTargetId: draft.mergeTargetId, cards: draft.cards.length, version: draft.draftVersion,
  requested: draft.editorial?.requested, part: draft.editorial?.part, generation: draft.editorial?.generation, coverageSpec: draft.editorial?.coverageSpec, coverageRun: draft.editorial?.coverageRun, partReport: draft.editorial?.partReport, failures: draft.editorial?.failures });
