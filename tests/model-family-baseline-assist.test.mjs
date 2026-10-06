/* S4-0 baseline of the learner's assistant (lib/assist.js, lib/assist-child.js, lib/host-capabilities.js). Describes what origin/main does today. The
   child lifecycle, reuse, timeouts, validation, repair and saving are in assist-host / assist-request / assist-compat tests; this file pins the task
   record the panel reads, the memory-only task list, the refusal without a model or child, and the two entries. Fake host and models, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { StudyService } from '../lib/service.js';
import { createAssistService } from '../lib/assist.js';
import { createAssistChildren } from '../lib/assist-child.js';
import { usageLedger } from '../lib/model-usage.js';
import { reportUsage } from '../lib/usage-scope.js';
import { until } from './helpers/wait.mjs';
import { gate, privateRoot, panelDoor } from './helpers/model-family-baseline.mjs';

const evidence = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
const card = { id: 'c', kind: 'flashcard', topic: 'Bridge', objective: 'Explain Bridge', prompt: 'What does Bridge separate?', answer: 'Abstraction and implementation.', hint: 'Two dimensions.',
  explanation: 'Both vary independently.', misconception: 'It adapts interfaces.', citations: [{ sourceId: 's', quote: evidence }] };
const reply = '{"answer":"Two independent dimensions."}';

async function library(t, options = {}) {
  const root = await privateRoot(t, 'model-baseline-assist-');
  const service = new StudyService(root, options);
  t.after(() => service.dispose());
  await service.store.update(state => { state.sources.push({ id: 's', title: 'Lecture', text: evidence }); state.decks.push({ id: 'd', title: 'Patterns', course: 'Software', cards: [structuredClone(card)] }); });
  return { root, service };
}
/** A host with a running parent session whose sub-agent service answers with `output` once released. */
function nativeHost(output = reply, release = Promise.resolve()) {
  const calls = { started: [], disposed: [] };
  const subagents = { getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }), start: async (_kind, request) => {
    calls.started.push(request);
    return { id: `child-${calls.started.length}`, result: release.then(() => ({ stopReason: 'completed', output: [{ type: 'text', text: output }] })), dispose: async () => calls.disposed.push(`child-${calls.started.length}`) };
  } };
  return { calls, ctx: { sessions: { get: () => undefined }, get: key => (key === 'agents' ? { get: () => ({ id: 'parent' }) } : key === 'subagents' ? subagents : undefined) } };
}
const request = (service, root, extra = {}) => ({ root, service, sessionId: 'parent', mode: 'ask', ref: { deckId: 'd', cardId: 'c' }, text: 'Explain it', helpChoices: ['example'], card, deckTitle: 'Patterns', route: { provider: 'p', model: 'm' }, ...extra });
const ended = (assist, root) => until(() => assist.assistView(root).tasks.every(task => task.status !== 'running'), 'the assist task to end');

test('the task record the panel reads: what was asked and which runtime ran it, never the root, the abort controller, the session, the route or the input digest', async t => {
  const f = await library(t, { complete: async () => reply }), assist = createAssistService({ children: createAssistChildren() });
  t.after(() => assist.dispose());
  const held = gate();
  const native = nativeHost(reply, held.promise);
  const started = await assist.startAssist(native.ctx, request(f.service, f.root));
  assert.deepEqual(Object.keys(started).sort(), ['cardId', 'choices', 'deckId', 'id', 'label', 'mode', 'prompt', 'question', 'runtime', 'startedAt', 'status', 'text'], 'the answer to the start is the record, as it is when it starts');
  assert.deepEqual([started.runtime, started.status, started.choices, started.text], ['subagent', 'running', ['example'], '给一个贴近该题的具体例子；Explain it']);
  await until(() => native.calls.started.length === 1, 'the child to be admitted');
  held.release();
  await ended(assist, f.root);
  const [task] = assist.assistView(f.root).tasks;
  assert.deepEqual([task.status, task.childId, task.reused, task.message === undefined], ['done', 'child-1', false, false]);
  assert.deepEqual(Object.keys(task).filter(key => /root|controller|session|route|digest|token|usage/i.test(key)), [], 'no usage, no call count, no route: nothing for the console to show beyond status and message');
  const direct = await assist.startAssist({}, request(f.service, f.root, { text: 'Direct', helpChoices: [] }));
  assert.equal(direct.runtime, 'direct');
});

test('the task list lives in memory only: it keeps the last twenty of a library, and a new service (a restart) starts with none', async t => {
  const f = await library(t, { complete: async () => reply }), assist = createAssistService({ children: createAssistChildren() });
  t.after(() => assist.dispose());
  for (let i = 0; i < 22; i++) { await assist.startAssist({}, request(f.service, f.root, { text: `Question ${i}`, helpChoices: [] })); await ended(assist, f.root); }
  const kept = assist.assistView(f.root).tasks;
  assert.equal(kept.length, 20);
  assert.equal(kept[0].question, 'Question 2');
  assert.equal(createAssistService({ children: createAssistChildren() }).assistView(f.root).tasks.length, 0);
  assert.equal(assist.clearAssist(f.root), true);
  assert.deepEqual(assist.assistView(f.root).tasks, []);
});

test('with neither a host child nor a model the assistant refuses plainly and records nothing; without a saving service it refuses too', async t => {
  const f = await library(t), assist = createAssistService({ children: createAssistChildren() });
  t.after(() => assist.dispose());
  await assert.rejects(assist.startAssist({}, request(f.service, f.root)), /当前没有可用的助教模型/);
  assert.deepEqual(assist.assistView(f.root).tasks, []);
  await assert.rejects(assist.startAssist({}, request({ complete: async () => reply }, f.root)), /助教保存服务不可用/);
});

test('assist.start belongs to the panel only: the runtime has no such action, and the panel door answers with the same task record a direct start gives', async t => {
  const runtime = createStudyRuntime(await privateRoot(t, 'model-baseline-assist-runtime-'), { complete: async () => reply });
  t.after(() => runtime.dispose());
  await assert.rejects(runtime.call('assist.start', { mode: 'ask', deckId: 'd', cardId: 'c' }), /unknown|unavailable|not/i);
  const panelLibrary = await library(t), viaPanel = panelDoor(t, panelLibrary.root, { complete: async () => reply });
  const directLibrary = await library(t, { complete: async () => reply }), assist = createAssistService({ children: createAssistChildren() });
  t.after(() => assist.dispose());
  const shown = await viaPanel('assist.start', { mode: 'ask', deckId: 'd', cardId: 'c', text: 'Explain it', helpChoices: ['example'] });
  const direct = await assist.startAssist({}, request(directLibrary.service, directLibrary.root, { route: undefined }));
  const shape = ({ mode, deckId, cardId, choices, question, text, prompt, label, runtime, status }) => [mode, deckId, cardId, choices, question, text, prompt, label, runtime, status];
  assert.deepEqual(shape(shown), shape(direct));
  await until(async () => (await viaPanel('snapshot', {})).assist.every(task => task.status !== 'running'), 'the panel task to end');
  assert.equal((await viaPanel('snapshot', {})).assist[0].status, 'done', 'the panel reads it from the snapshot');
  await ended(assist, directLibrary.root); // the direct task writes its follow-up on its own schedule
  assert.deepEqual((await panelLibrary.service.store.read()).decks[0].cards[0].followups?.length, (await directLibrary.service.store.read()).decks[0].cards[0].followups?.length);
});

test('an assistant call is not in the usage ledger: it goes straight to the host model, so what the model reports has no sink and the task carries no usage', async t => {
  const f = await library(t, { complete: async () => { reportUsage({ uncachedInputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }); return reply; } });
  const assist = createAssistService({ children: createAssistChildren() });
  t.after(() => assist.dispose());
  await assist.startAssist({}, request(f.service, f.root, { helpChoices: [] }));
  await ended(assist, f.root);
  assert.equal(assist.assistView(f.root).tasks[0].status, 'done');
  assert.deepEqual((await usageLedger(f.root).summary({ days: 1 })).byFeature, {}, 'unrecorded: the other families all appear here');
});
