import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHostHandler, serviceFor, servicesForHost } from '../lib/host.js';
import { createAssistService } from '../lib/assist.js';

const host = root => {
  const disposers = [];
  return { sessions: { get: () => ({ header: { cwd: root } }) }, get: () => undefined,
    effect: setup => disposers.push(setup()), dispose: () => { for (const dispose of disposers.reverse()) dispose?.(); } };
};

test('one host reuses library work while concurrent request facades retain their own model routes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-host-owner-'));
  const firstHost = host(root), secondHost = host(root);
  t.after(async () => { firstHost.dispose(); secondHost.dispose(); await rm(root, { recursive: true, force: true }); });
  const complete = route => async () => route().model;
  const first = await serviceFor(firstHost, { model: 'one', provider: 'p' }, root, undefined, complete, 'session');
  const second = await serviceFor(firstHost, { model: 'two', provider: 'p' }, root, undefined, complete, 'session');
  const foreign = await serviceFor(secondHost, { model: 'three', provider: 'p' }, root, undefined, complete, 'session');
  assert.notEqual(first, second);
  assert.equal(first.runtime, second.runtime, 'background tasks must remain visible on the next panel request');
  assert.notEqual(first.runtime, foreign.runtime);
  assert.equal(first.modelOptions.audioGate, second.modelOptions.audioGate, 'requests from one host share its audio budget');
  assert.notEqual(first.modelOptions.audioGate, foreign.modelOptions.audioGate, 'different hosts have independent audio budgets');
  assert.equal(first.modelOptions.providerResources, second.modelOptions.providerResources);
  assert.notEqual(first.modelOptions.providerResources, foreign.modelOptions.providerResources);
  assert.equal(first.modelOptions.providerResources.enabled, false, 'provider quota has an independent off default');
  assert.equal(await first.complete('system', 'prompt'), 'one');
  assert.equal(await second.complete('system', 'prompt'), 'two');
});

test('a panel sees only its host intents and shutdown cannot clear a sibling host', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-panel-owner-'));
  const first = host(root), second = host(root);
  t.after(async () => { first.dispose(); second.dispose(); await rm(root, { recursive: true, force: true }); });
  const own = servicesForHost(first), sibling = servicesForHost(second);
  own.bridge.queuePanelIntent('session', { type: 'run', runId: 'first' });
  sibling.bridge.queuePanelIntent('session', { type: 'run', runId: 'second' });
  const handle = createHostHandler(first);
  assert.equal((await handle('call', { sessionId: 'session', action: 'panel.intent.next' })).value.intent.runId, 'first');
  first.dispose();
  assert.equal(sibling.bridge.takePanelIntent('session').runId, 'second');
});

test('assist service cancellation cannot observe or cancel another owner at the same library and session', async () => {
  const first = createAssistService(), second = createAssistService();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const card = { id: 'card', kind: 'flashcard', prompt: 'Question?', answer: 'Answer', citations: [] };
  const service = { store: { read: async () => ({ decks: [{ id: 'deck', title: 'Deck', cards: [card] }], sources: [] }) },
    complete: async () => { await pending; return '{"answer":"Explanation"}'; }, saveAssistResult: async () => ({ message: 'Saved' }) };
  const args = { root: 'same-root', sessionId: 'same-session', service, mode: 'ask', ref: { deckId: 'deck', cardId: 'card' },
    text: 'Explain', card, deckTitle: 'Deck' };
  try {
    await first.startAssist({}, args);
    assert.deepEqual(second.assistView(args.root).tasks, []);
    await second.startAssist({}, args);
    first.clearAssist(args.root);
    assert.equal(second.assistView(args.root).tasks[0].status, 'running');
    release();
    // Drain task continuations; saving is a promise continuation without filesystem work.
    for (let i = 0; i < 10 && second.assistView(args.root).tasks[0].status === 'running'; i++)
      await new Promise(resolve => setImmediate(resolve));
    assert.equal(second.assistView(args.root).tasks[0].status, 'done');
  } finally { release(); first.dispose(); second.dispose(); }
});
