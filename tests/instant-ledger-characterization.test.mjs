/* S6-5a characterization: what each INSTANT model request (no Job, no card) writes to the usage ledger today. Every case runs one request through the service with the
   deterministic fake model (which reports usage like a provider) and pins the ledger rows the request added: the feature, the calls and the four token buckets. The table was
   taken on main before the instant entry (lib/runtime/instant.js) existed and must stay the same after it: shared quota off means byte-identical rows. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { usageLedger } from '../lib/model-usage.js';
import { seed } from './helpers/coach-library.mjs';
import { caseLibrary, caseRef, caseAnswer } from './helpers/instant-case-library.mjs';

const PRINT = process.env.PRINT_INSTANT_TABLE === '1';
const FIELDS = ['calls', 'uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
/* request -> { feature: [calls, uncached input, output, cache read, cache write] }, taken on main (PRINT_INSTANT_TABLE=1 prints it). Calls and features are exact; tokens may differ by a
   few because a prompt carries a generated id whose length varies. `materials.selection.ask` added NO row on main (it preferred the request's own, unwrapped model, so the usage the learner spent was invisible): that was a bug,
   fixed on purpose in S6-5b; its row below is the one the fix adds (before: `{}`, after: one `coach` call). */
const PINNED = {
  "capture": {"generate":[1,767,158,0,0]},
  "card.followup.suggest": {"coach":[1,230,19,0,0]},
  "card.followup": {"coach":[1,304,34,0,0]},
  "card.translate": {"coach":[1,285,108,0,0]},
  "generate.suggest": {"generate":[2,532,2,387,0]},
  "ingest": {"generate":[1,572,194,0,0]},
  "focus.suggest": {"coach":[1,88,1,0,0]},
  "oral.followup": {"coach":[1,88,9,0,0]},
  "coach.nudge": {"coach":[1,235,43,0,0]},
  "teach.start": {"coach":[1,424,52,0,0]},
  "materials.outline.suggest": {"other":[1,438,14,0,0]},
  "materials.translation.translate (immediate passage)": {"other":[2,728,2,0,0]},
  "materials.selection.ask": {"coach":[1,254,21,0,0]},
  "card.grade": {"case":[1,901,191,0,0]},
};

const rows = async root => (await usageLedger(root).summary({ days: 1 })).byFeature;
const near = (actual, pinned) => Object.keys({ ...actual, ...pinned }).every(feature => actual[feature] && pinned[feature]
  && actual[feature][0] === pinned[feature][0] && actual[feature].every((cell, at) => Math.abs(cell - pinned[feature][at]) <= 3));
const deltaOf = (before, after) => {
  const out = {};
  for (const feature of Object.keys(after)) {
    const cells = FIELDS.map(field => (after[feature][field] || 0) - (before[feature]?.[field] || 0));
    if (cells.some(Boolean)) out[feature] = cells;
  }
  return out;
};

async function opened(t) {
  const root = await mkdtemp(join(tmpdir(), 'instant-ledger-'));
  const model = createFakeModel({ usage: true }), service = new StudyService(root, { complete: model, completeLight: model, coach: true });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const call = service.call.bind(service);
  await seed(call);
  await call('source.add', { id: 'queue', title: 'Queue', text: 'Methods come in pairs: the first throws on failure, the second returns a special value. A queue is first in, first out.', courses: ['Data structures'] });
  await call('source.add', { id: 'stack', title: 'Stack', text: 'A stack is last in, first out and is used to match brackets.', courses: ['Data structures'] });
  const imported = await call('materials.document.import', { filename: 'n.md', dataBase64: Buffer.from('# Notes\n\nFirst paragraph explains the queue in some detail here.\n\nSecond paragraph explains the stack in detail too.\n').toString('base64') });
  return { root, call, imported };
}

/** The instant requests and how to ask each one. Each is one request; the ledger delta of that request alone is what is pinned. */
const CASES = {
  'capture': ({ call }) => call('capture', { deckId: 'd', question: 'What is the difference between poll and remove on a queue?', answer: 'poll returns null' }),
  'card.followup.suggest': ({ call }) => call('card.followup.suggest', { deckId: 'd', cardId: 'q1' }),
  'card.followup': ({ call }) => call('card.followup', { deckId: 'd', cardId: 'q1', question: 'Why does the Caretaker not look inside?' }),
  'card.translate': ({ call }) => call('card.translate', { deckId: 'd', cardId: 'q1' }),
  'generate.suggest': ({ call }) => call('generate.suggest', { sourceIds: ['queue', 'stack'], goal: 'learn' }),
  'ingest': async ({ call }) => { await call('ingest.start', { deckTitle: 'Mistakes', folder: 'A', mistakes: 'auto' }); return call('ingest', { text: '1. What is a queue?\nAnswer: first in, first out.' }); },
  'focus.suggest': ({ call }) => call('focus.suggest', { role: 'Engineer', jd: 'Capacity planning' }),
  'oral.followup': async ({ call }) => { const run = await call('oral.start', { count: 1 }); await call('oral.answer', { runId: run.id, cardId: run.entry.cardId, answer: 'x' }); return call('oral.followup', { runId: run.id, cardId: run.entry.cardId }); },
  'coach.nudge': async ({ call }) => { const run = await call('review.start', { deckId: 'd', mode: 'quiz' }); await call('review.answer', { runId: run.id, cardId: run.card.id, selected: ['b'] }); return call('coach.nudge', { runId: run.id, index: run.index }); },
  'teach.start': async ({ call }) => { const run = await call('review.start', { deckId: 'd', mode: 'quiz' }); await call('review.answer', { runId: run.id, cardId: run.card.id, selected: ['b'] }); return call('teach.start', { runId: run.id, cardId: run.card.id }); },
  'materials.outline.suggest': ({ call, imported }) => call('materials.outline.suggest', { documentId: imported.documentId }),
  'materials.translation.translate (immediate passage)': ({ call, imported }) => call('materials.translation.translate', { documentId: imported.documentId,
    passages: [{ sourceId: imported.document.sources[0].id, text: 'First paragraph explains the queue in some detail here.' }] }),
  'materials.selection.ask': async ({ call, imported }) => {
    const selection = await call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: 'First paragraph explains the queue' });
    return call('materials.selection.ask', { selection: selection.selection, question: 'Why?' });
  },
};

for (const [name, ask] of Object.entries(CASES)) {
  test(`instant request ${name}: the ledger rows it adds are the pinned ones`, async t => {
    const world = await opened(t), before = await rows(world.root);
    await ask(world);
    const added = deltaOf(before, await rows(world.root));
    if (PRINT) console.log(`PIN ${JSON.stringify(name)}: ${JSON.stringify(added)},`);
    else assert.ok(near(added, PINNED[name]), `${name}: ${JSON.stringify(added)} is not ${JSON.stringify(PINNED[name])}`);
  });
}

test('instant request card.grade (rubric): the ledger rows it adds are the pinned ones', async t => {
  const world = await caseLibrary(t), before = await rows(world.root), name = 'card.grade';
  const run = await world.service.call('review.start', { mode: 'path', scope: [caseRef], fresh: true });
  await world.service.call('card.grade', { ...caseRef, runId: run.id, answer: caseAnswer });
  const added = deltaOf(before, await rows(world.root));
  if (PRINT) console.log(`PIN ${JSON.stringify(name)}: ${JSON.stringify(added)},`);
  else assert.ok(near(added, PINNED[name]), `${name}: ${JSON.stringify(added)} is not ${JSON.stringify(PINNED[name])}`);
});
