import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* #551: the main chat hands a round that already exists to the right panel (panel.open {runId}), opens several named questions as one round
   (panel.open {scope}), and adds or removes questions of an open round without restarting it (review.queue.edit). */

const text = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
const card = (n) => ({ id: `c${n}`, kind: 'flashcard', topic: `Bridge ${n}`, objective: `Explain Bridge aspect ${n}`,
  prompt: `What does Bridge separate in aspect ${n}?`, answer: `Abstraction and implementation, aspect ${n}.`, hint: 'Two dimensions.',
  explanation: 'They vary independently.', misconception: 'It adapts interfaces.', citations: [{ sourceId: 's1', quote: 'separates an abstraction' }] });

async function plugin(t) {
  let index;
  try { index = await import('../lib/index.js'); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('@deepseek-ai')) { t.skip('Host SDK absent'); return null; }
    throw error;
  }
  const tools = [], disposers = [];
  const ctx = { tools: { register: (x) => tools.push(x) }, commands: { register: () => {} }, llm: {}, systemPrompt: { section: () => {} },
    sessions: { get: () => undefined }, get: (name) => name === 'connection' ? { fetch: { register: () => () => {} } } : undefined,
    inject: (_deps, fn) => fn(ctx), effect: (fn) => disposers.push(fn()) };
  index.apply(ctx, {});
  const cwd = await mkdtemp(join(tmpdir(), 'study-panel-run-')), home = await mkdtemp(join(tmpdir(), 'study-panel-home-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const agent = { id: 'agent-551', session: { header: { cwd } } };
  t.after(async () => {
    for (const dispose of disposers) await dispose?.();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await rm(cwd, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
  });
  const tool = (action, payload) => tools[0].execute({ action, ...(payload ? { payload_json: JSON.stringify(payload) } : {}) }, { agent });
  const { createHostHandler } = await import('../lib/host.js');
  const panel = createHostHandler({ sessions: { get: () => agent.session } }, {}, undefined, { owner: ctx });
  const nextIntent = async () => (await panel('call', { sessionId: agent.id, action: 'panel.intent.next' })).value.intent;
  await tool('source.add', { id: 's1', title: 'notes', text });
  await tool('draft.save', { deck: { id: 'd1', title: 'Patterns', cards: Array.from({ length: 12 }, (_, i) => card(i + 1)) } });
  await tool('draft.publish', { id: 'd1' });
  // What the learner does on the card goes through the panel's own door (HB-1: the main chat never answers).
  const learner = async (action, args) => { const reply = await panel('call', { sessionId: agent.id, action, args }); if (!reply.ok) throw new Error(reply.error?.message); return reply.value; };
  return { tool, nextIntent, learner };
}
const ids = (run) => run.navigation.map((item) => item.cardId);

test('panel.open {runId} hands the existing 9-question round to the panel: one intent, same order, not a new round of one', async t => {
  const world = await plugin(t); if (!world) return;
  const { tool, nextIntent } = world;
  const scope = Array.from({ length: 9 }, (_, i) => ({ deckId: 'd1', cardId: `c${i + 1}` }));
  const built = await tool('review.start', { mode: 'path', scope, fresh: true });
  const opened = await tool('panel.open', { runId: built.id, ackTimeoutMs: 0 });
  assert.equal(opened.status, 'queued_for_sidebar', 'no confirmation from a panel that is not there: queued, never claimed visible');
  assert.equal(opened.confirmed, false);
  assert.equal(opened.runId, built.id);
  assert.equal(opened.total, 9);
  const intent = await nextIntent();
  assert.deepEqual([intent.type, intent.runId], ['run', built.id]);
  assert.equal(await nextIntent(), null, 'one message, not nine');
  const after = await tool('review.get', { runId: built.id });
  assert.deepEqual(ids(after), ids(built), 'the order is the round\'s own');
  await tool('review.end', { runId: built.id });
  await assert.rejects(tool('panel.open', { runId: built.id }), /ended/);
  await assert.rejects(tool('panel.open', { runId: 'no-such-run' }));
});

test('panel.open {scope} opens those questions as one round and resumes an open round over the same questions', async t => {
  const world = await plugin(t); if (!world) return;
  const { tool, nextIntent } = world;
  const scope = [{ deckId: 'd1', cardId: 'c3' }, { deckId: 'd1', cardId: 'c1' }, { cardId: 'c2' }];
  const first = await tool('panel.open', { scope, ackTimeoutMs: 0 });
  assert.equal(first.total, 3);
  assert.equal((await nextIntent()).runId, first.runId);
  const again = await tool('panel.open', { scope, ackTimeoutMs: 0 });
  assert.equal(again.runId, first.runId, 'the same open round, not another one');
  await assert.rejects(tool('panel.open', { scope: [] }), /1–200/);
  const query = await tool('panel.open', { query: 'Bridge' });
  assert.equal(query.status, 'candidates_queued', 'a query that matches several questions still asks the learner to choose');
});

test('review.queue.edit adds after the current question and removes later ones, keeping the position, answers and the library', async t => {
  const world = await plugin(t); if (!world) return;
  const { tool, nextIntent, learner } = world;
  const scope = Array.from({ length: 9 }, (_, i) => ({ deckId: 'd1', cardId: `c${i + 1}` }));
  let run = await tool('review.start', { mode: 'path', scope, fresh: true });
  const order = ids(run);
  for (let i = 0; i < 3; i++) {
    run = await learner('review.reveal', { runId: run.id, cardId: order[i] });
    run = await learner('review.answer', { runId: run.id, cardId: order[i], grade: 4 });
    run = await learner('review.move', { runId: run.id, direction: 1 });
  }
  assert.equal(run.index, 3);
  const onScreen = run.card.id;
  await learner('review.draft.save', { runId: run.id, cardId: onScreen, draft: { text: 'half an answer' } });
  const edited = await tool('review.queue.edit', { runId: run.id, queueVersion: run.queueVersion || 0, position: 'next',
    add: [{ deckId: 'd1', cardId: 'c10' }, { deckId: 'd1', cardId: 'c11' }], remove: [{ cardId: order[8] }, { cardId: order[0] }, { cardId: onScreen }] });
  assert.equal(edited.total, 10, '9 + 2 − 1');
  assert.equal(edited.index, 3, 'the question on screen stays on screen');
  assert.equal(edited.card.id, onScreen);
  assert.deepEqual(ids(edited).slice(4, 6), ['c10', 'c11'], 'added right after the current question');
  assert.deepEqual(edited.removed, [{ deckId: 'd1', cardId: order[8] }]);
  assert.deepEqual(edited.kept.map((item) => item.cardId).sort(), [order[0], onScreen].sort(), 'an answered question and the one on screen are not removed');
  assert.equal(edited.navigation.slice(0, 3).every((item) => item.answered), true, 'answers stay');
  assert.equal(edited.panel, 'queued_for_sidebar');
  assert.equal((await nextIntent()).runId, run.id);
  const read = await tool('review.get', { runId: run.id });
  assert.equal(read.total, 10);
  assert.equal(read.draft?.text, 'half an answer', 'the draft on screen is kept');
  await assert.rejects(tool('review.queue.edit', { runId: run.id, queueVersion: 0, add: [{ deckId: 'd1', cardId: 'c12' }] }), /changed since/,
    'an edit made on an older view of the round is refused');
  const deck = (await tool('deck.get', { id: 'd1' }));
  assert.equal((deck.cards || deck.deck?.cards).length, 12, 'nothing left the library');
});

test('the panel area spells out whole rounds and queue edits, and learning points to it', async () => {
  const { libraryContracts, studyToolDescription } = await import('../lib/study-contracts.js');
  assert.match(libraryContracts.panel, /panel\.open \{runId\}/);
  assert.match(libraryContracts.panel, /panel\.open \{scope:\[\{deckId\?,cardId\}\]\}/);
  assert.match(libraryContracts.panel, /review\.queue\.edit \{runId,add\?/);
  assert.match(libraryContracts.learning, /more: area panel/);
  assert.match(studyToolDescription, /review\.start\/get\/reveal\/answer\/move\/end\/queue\.edit/);
});
